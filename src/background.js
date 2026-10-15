import { normalizeOrigin, permissionPattern } from './core/origin.js';
import { readCookies } from './core/cookie-reader.js';
import { cookieId, cookieAttributes, rewriteCookie, sameCookie, sameCookieIdentity } from './core/cookie.js';
import { SessionHistory } from './core/history.js';
import { captureHistory, historyItemId, undoCookie, undoDatabase } from './core/history-operations.js';
import { storageDiff, schemaConflicts } from './core/diff.js';
import { TYPES, DEFAULTS, BATCH_SIZE, LARGE_RECORD_COUNT, LARGE_BYTES } from './core/config.js';

const previews = new Map();
const history = new SessionHistory(chrome.storage.session);
let job = null;
let preparing = false;
let executing = false;
const safeError = error => /^[A-Z_]+:/.test(error.message) ? error.message : `UNKNOWN_ERROR: ${error.name || 'Error'}；操作未完成，请重新预览后重试。`;
async function notify() {
  if (!job) return;
  // Progress messages contain only metadata. Undo snapshots have a separate,
  // trusted-context-only storage.session key and never enter these messages.
  const view = { ...job, steps: job.steps.map(step => ({ ...step })) };
  await chrome.storage.session.set({ lastJob: view });
  chrome.runtime.sendMessage({ kind: 'PROGRESS', job: view }).catch(() => {});
}
async function log(message) {
  job.logs.push({ time: Date.now(), message });
  if (job.logs.length > 120) job.logs.shift();
  await notify();
}
async function tabs() {
  return (await chrome.tabs.query({})).filter(tab => !tab.incognito && /^https?:\/\//.test(tab.url || '')).map(tab => ({ id: tab.id, url: tab.url, origin: normalizeOrigin(tab.url), title: tab.title || '', active: tab.active, windowId: tab.windowId }));
}
async function resolveEnvironment(environment, side) {
  const origin = normalizeOrigin(environment.origin);
  if (!await chrome.permissions.contains({ origins: [permissionPattern(origin)] })) throw new Error('PERMISSION_DENIED: 请先授权所选网站。');
  let tab;
  if (environment.tabId) {
    try { tab = await chrome.tabs.get(environment.tabId); } catch { throw new Error(`${side}_TAB_NOT_FOUND: 所选标签页已关闭，请重新选择。`); }
    if (normalizeOrigin(tab.url) !== origin) throw new Error(`${side}_TAB_NOT_FOUND: 所选标签页已导航到其他 Origin。`);
  } else {
    tab = (await chrome.tabs.query({})).find(item => !item.incognito && /^https?:\/\//.test(item.url || '') && normalizeOrigin(item.url) === origin);
    if (!tab) {
      tab = await chrome.tabs.create({ url: origin, active: false });
      for (let tries = 0; tries < 150; tries++) {
        tab = await chrome.tabs.get(tab.id);
        if (tab.status === 'complete') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (tab.status !== 'complete') throw new Error(`${side}_TAB_NOT_FOUND: 页面加载超时，请在浏览器中打开网站后重试。`);
      if (normalizeOrigin(tab.url) !== origin) throw new Error(`${side}_TAB_NOT_FOUND: 网站重定向到了其他 Origin，请选择实际页面。`);
    }
  }
  if (tab.incognito) throw new Error('PERMISSION_DENIED: 当前版本不支持无痕窗口。');
  const injection = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['src/core/codec.js', 'src/adapters/page.js'], world: 'ISOLATED' });
  if (!injection[0]?.documentId) throw new Error(`${side}_TAB_NOT_FOUND: 无法连接所选页面。`);
  const stores = await chrome.cookies.getAllCookieStores();
  const storeId = stores.find(store => store.tabIds.includes(tab.id))?.id;
  return { origin, tabId: tab.id, documentId: injection[0].documentId, storeId };
}
async function page(environment, command, args = {}) {
  const result = await chrome.scripting.executeScript({
    target: { tabId: environment.tabId, documentIds: [environment.documentId] }, world: 'ISOLATED',
    // Chromium's argument conversion can omit nested null-valued properties.
    // A JSON string preserves null keyPath (out-of-line keys) and tagged key data.
    func: (command, payload) => globalThis.__envBridgePageV1(command, JSON.parse(payload)),
    args: [command, JSON.stringify({ ...args, origin: environment.origin })]
  });
  if (!result[0]?.result) throw new Error('PAGE_OPERATION_FAILED: 页面已刷新或连接已失效，请重新预览。');
  if (!result[0].result.ok) throw new Error(result[0].result.error);
  return result[0].result.data;
}
async function read(environment, type) {
  if (type === 'cookies') return readCookies(environment);
  if (type === 'indexedDB') return page(environment, 'idbList');
  return page(environment, 'storageRead', { type });
}
function configuration(input) {
  const config = { ...DEFAULTS, ...input };
  if (!['rewrite', 'preserve'].includes(config.cookieMode) || !['merge', 'overwrite', 'clear'].includes(config.storageMode) || !['merge', 'replace', 'cancel'].includes(config.indexedDBMode)) throw new Error('INVALID_OPTIONS: 迁移策略无效。');
  return config;
}
async function preview(request) {
  if (executing || job?.status === 'running' || preparing) throw new Error('BUSY: 另一个迁移任务正在执行。');
  preparing = true;
  try {
    for (const [id, data] of previews) if (Date.now() - data.createdAt > 600000) previews.delete(id);
    const config = configuration(request.config);
    const selectedTypes = TYPES.filter(type => request.types?.[type]);
    if (!selectedTypes.length) throw new Error('INVALID_OPTIONS: 请至少选择一类数据。');
    const source = await resolveEnvironment(request.source, 'SOURCE');
    const target = await resolveEnvironment(request.target, 'TARGET');
    if (source.origin === target.origin) throw new Error('INVALID_ORIGIN: 源与目标必须是不同 Origin，避免覆盖源数据。');
    const snapshot = { id: crypto.randomUUID(), createdAt: Date.now(), source, target, config, types: selectedTypes, sourceData: {}, targetData: {}, rows: {}, readErrors: {} };
    for (const type of selectedTypes) {
      try {
        snapshot.sourceData[type] = await read(source, type);
        snapshot.targetData[type] = await read(target, type);
        if (type === 'cookies') {
          snapshot.rows[type] = snapshot.sourceData[type].map(cookie => {
            const rewritten = rewriteCookie(cookie, source.origin, target.origin, config.cookieMode);
            const existing = snapshot.targetData[type].find(item => sameCookieIdentity(rewritten.next, item));
            return { id: cookieId(cookie), name: cookie.name, status: !existing ? 'add' : sameCookie(rewritten.next, existing) ? 'same' : 'modify', source: cookieAttributes(cookie), target: cookieAttributes(rewritten.next), changes: rewritten.changes, warnings: rewritten.warnings, errors: rewritten.errors, writable: rewritten.writable, special: rewritten.special };
          });
          const identities = new Map();
          for (const row of snapshot.rows[type]) {
            const key = JSON.stringify([row.name, row.target.domain.replace(/^\./, ''), row.target.path, row.target.hostOnly]);
            if (identities.has(key)) {
              const other = identities.get(key);
              for (const collision of [other, row]) { collision.writable = false; collision.errors.push('多个源 Cookie 重写为同一个目标 Cookie，请避免名称 / 路径冲突。'); }
            } else identities.set(key, row);
          }
        } else if (type === 'indexedDB') {
          snapshot.rows[type] = snapshot.sourceData[type].map(database => {
            const existing = snapshot.targetData[type].find(item => item.name === database.name);
            const conflicts = schemaConflicts(database, existing);
            const errors = config.indexedDBMode === 'merge' ? conflicts : existing && config.indexedDBMode === 'cancel' ? ['目标存在同名数据库，Cancel 策略将跳过。'] : [];
            return { ...database, id: database.name, status: !existing ? 'add' : config.indexedDBMode === 'replace' ? 'replace' : 'modify', targetVersion: existing?.version, warnings: existing && config.indexedDBMode === 'replace' ? ['将删除目标同名数据库的所有表和记录；其他数据库不受影响。'] : [], errors, writable: !errors.length };
          });
        } else snapshot.rows[type] = storageDiff(snapshot.sourceData[type], snapshot.targetData[type], config.storageMode);
      } catch (error) { snapshot.readErrors[type] = safeError(error); snapshot.rows[type] = []; }
    }
    if (Object.keys(snapshot.readErrors).length === selectedTypes.length) throw new Error('PREVIEW_FAILED: 所选数据全部读取失败。' + Object.values(snapshot.readErrors).join(' '));
    // Drop stale secrets; at most one preview is kept in transient worker memory.
    previews.clear(); previews.set(snapshot.id, snapshot);
    setTimeout(() => previews.delete(snapshot.id), 600000);
    const targetKeys = Object.fromEntries(['localStorage', 'sessionStorage'].filter(type => snapshot.targetData[type]).map(type => [type, snapshot.targetData[type].map(item => item.key)]));
    return { id: snapshot.id, createdAt: snapshot.createdAt, source, target, config, types: selectedTypes, rows: snapshot.rows, targetKeys, readErrors: snapshot.readErrors };
  } finally { preparing = false; }
}
async function markHistory(record, type, id = '') {
  const key = historyItemId(type, id);
  if (!record.touched.includes(key)) {
    record.touched.push(key);
    // Persist intent before mutation, so worker interruption stays recoverable.
    await history.update(record.id, { touched: record.touched });
  }
}
async function cloneCookies(snapshot, selected, step, record) {
  const chosen = snapshot.sourceData.cookies.filter(item => selected.includes(cookieId(item)));
  const warnings = [];
  // Cookies are shared across ports on a host. Do not mutate the source jar accidentally.
  if (new URL(snapshot.source.origin).hostname === new URL(snapshot.target.origin).hostname) warnings.push('源与目标共用主机：Cookie 不按端口隔离，写入会影响该主机下的其他页面。');
  for (const cookie of chosen) {
    const row = snapshot.rows.cookies.find(item => item.id === cookieId(cookie));
    const rewrite = rewriteCookie(cookie, snapshot.source.origin, snapshot.target.origin, snapshot.config.cookieMode);
    if (!row.writable || !rewrite.writable) { step.skipped++; continue; }
    try {
      await markHistory(record, 'cookies', cookieId(cookie));
      if (snapshot.target.storeId) rewrite.details.storeId = snapshot.target.storeId;
      const written = await chrome.cookies.set(rewrite.details);
      if (!written) throw new Error('COOKIE_WRITE_FAILED: 浏览器未接受此 Cookie。');
      const actual = (await readCookies(snapshot.target)).find(item => sameCookieIdentity(rewrite.next, item));
      if (!sameCookie(rewrite.next, actual)) throw new Error('VERIFY_FAILED: Cookie 写入后的值或属性不一致。');
      step.count++;
    } catch (error) { step.failed++; step.errors.push({ item: cookie.name, message: /^[A-Z_]+:/.test(error.message) ? error.message : 'COOKIE_WRITE_FAILED: 浏览器拒绝写入，请检查 Cookie 属性和网站权限。' }); }
    await notify();
  }
  step.warnings = warnings;
}
async function cloneIndexedDB(snapshot, selected, step, confirmed, record) {
  for (const database of snapshot.sourceData.indexedDB.filter(item => selected.includes(item.name))) {
    const row = snapshot.rows.indexedDB.find(item => item.id === database.name);
    if (!row.writable) { step.skipped++; continue; }
    try {
      // Preflight schemas/counts before destructive writes. Source stays live during transfer.
      const current = (await page(snapshot.source, 'idbList')).find(item => item.name === database.name);
      if (!current || current.version !== database.version || JSON.stringify(current.stores) !== JSON.stringify(database.stores)) throw new Error('SOURCE_CHANGED: 数据库在预览后发生变化，请重新预览。');
      await markHistory(record, 'indexedDB', database.name);
      const ensured = await page(snapshot.target, 'idbEnsure', { meta: database, mode: snapshot.config.indexedDBMode, confirmed });
      for (const store of database.stores) {
        let after = null;
        let transferred = 0;
        while (true) {
          const batch = await page(snapshot.source, 'idbRead', { database: database.name, version: database.version, store: store.name, after, limit: BATCH_SIZE });
          const targetToken = crypto.randomUUID();
          try {
            if (!batch.count) break;
            for (let index = 0; index < batch.chunks; index++) {
              const chunk = await page(snapshot.source, 'transferRead', { token: batch.token, index });
              await page(snapshot.target, 'transferAppend', { token: targetToken, chunk });
            }
            const result = await page(snapshot.target, 'idbWrite', { token: targetToken, database: database.name, version: ensured.version, store: store.name });
            transferred += result.count; step.count += result.count; step.bytes += batch.bytes;
            after = batch.after;
            await notify();
            if (batch.count < BATCH_SIZE) break;
          } finally {
            await page(snapshot.source, 'transferDrop', { token: batch.token }).catch(() => {});
            await page(snapshot.target, 'transferDrop', { token: targetToken }).catch(() => {});
          }
        }
        if (transferred !== store.count) throw new Error('SOURCE_CHANGED: 迁移期间源记录数发生变化，目标可能仅完成部分写入。');
      }
      const targetMeta = (await page(snapshot.target, 'idbList')).find(item => item.name === database.name);
      if (!targetMeta || schemaConflicts(database, targetMeta).length || database.stores.some(store => !targetMeta.stores.some(other => other.name === store.name && store.indexes.every(index => other.indexes.some(item => item.name === index.name))))) throw new Error('VERIFY_FAILED: 目标数据库结构校验未通过。');
      if (snapshot.config.indexedDBMode === 'replace' && (targetMeta.version !== database.version || targetMeta.records !== database.records || targetMeta.stores.length !== database.stores.length)) throw new Error('VERIFY_FAILED: 替换后的数据库版本或记录数不一致。');
      step.databases++;
    } catch (error) { step.failed++; step.errors.push({ item: database.name, message: safeError(error) }); }
    await notify();
  }
}
async function run(snapshot, selections, confirmed) {
  // An extension API call every 20s prevents idle termination during a blocked DB operation.
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  let record = null;
  try {
    await log('保存目标数据的撤销快照');
    await page(snapshot.source, 'ping'); await page(snapshot.target, 'ping');
    const pendingHistory = await captureHistory(snapshot, selections, job.id, page);
    await history.add(pendingHistory); record = pendingHistory; job.historyId = record.id; await notify();
    await log('撤销快照已保存，开始迁移');
    for (const type of snapshot.types) {
      const step = job.steps.find(item => item.type === type);
      const selected = selections[type];
      if (!selected) { step.status = 'disabled'; continue; }
      step.status = 'running'; await notify();
      try {
        if (snapshot.readErrors[type]) throw new Error(snapshot.readErrors[type]);
        // Detect navigation/reload after preview before each category.
        await page(snapshot.source, 'ping');
        await page(snapshot.target, 'ping');
        if (type === 'cookies') await cloneCookies(snapshot, selected, step, record);
        else if (type === 'indexedDB') await cloneIndexedDB(snapshot, selected, step, confirmed, record);
        else {
          const items = snapshot.sourceData[type].filter(item => selected.includes(item.key));
          await markHistory(record, type);
          const result = await page(snapshot.target, 'storageWrite', { type, items, mode: snapshot.config.storageMode, confirmed });
          step.count = result.count;
        }
        step.status = step.failed ? 'partial' : step.skipped ? 'warning' : 'success';
        await log(`${type}：${step.count} 已写入并校验，${step.skipped} 跳过，${step.failed} 失败`);
      } catch (error) { step.status = 'error'; step.failed++; step.errors.push({ message: safeError(error) }); await log(`${type} 未完成`); }
    }
    let resultStatus = job.steps.some(step => step.failed || step.skipped) ? 'partial' : 'success';
    if (snapshot.config.reload && resultStatus === 'success') {
      try {
        const targetTab = await chrome.tabs.get(snapshot.target.tabId);
        if (normalizeOrigin(targetTab.url) === snapshot.target.origin) { await chrome.tabs.reload(targetTab.id); await log('目标页面已刷新'); }
        else { resultStatus = 'partial'; await log('目标页面已导航，未刷新'); }
      } catch {
        resultStatus = 'partial'; job.error = 'TARGET_TAB_NOT_FOUND: 数据写入完成，但目标页面无法刷新。';
      }
    }
    job.status = resultStatus;
    job.finishedAt = Date.now();
    await log(job.status === 'success' ? '迁移完成，写入数据已校验' : '迁移结束，请查看跳过项或错误详情');
  } catch (error) { job.status = 'error'; job.error = safeError(error); job.finishedAt = Date.now(); await notify(); }
  finally {
    if (record) {
      try { await history.update(record.id, { status: job.status, finishedAt: job.finishedAt, count: job.steps.reduce((sum, step) => sum + step.count, 0) }); }
      catch { job.error = 'HISTORY_WRITE_FAILED: 历史状态更新失败，请查看历史中的恢复记录。'; await notify(); }
    }
    clearInterval(heartbeat); previews.clear(); executing = false;
  }
}
async function startClone(request) {
  if (executing || job?.status === 'running' || preparing) throw new Error('BUSY: 另一个迁移任务正在执行。');
  const snapshot = previews.get(request.previewId);
  if (!snapshot || Date.now() - snapshot.createdAt > 600000) throw new Error('PREVIEW_EXPIRED: 预览已失效，请重新读取。');
  const selections = {};
  for (const type of snapshot.types) {
    if (!request.selections?.[type]) continue;
    const available = new Set(snapshot.rows[type].filter(row => row.status !== 'remove').map(row => row.id));
    const selected = request.selections[type].filter(id => available.has(id));
    if (selected.length || snapshot.config.storageMode === 'clear' && ['localStorage', 'sessionStorage'].includes(type)) selections[type] = selected;
  }
  if (!Object.keys(selections).length) throw new Error('INVALID_OPTIONS: 没有选择可迁移项目。');
  const destructive = snapshot.config.storageMode === 'clear' && ['localStorage', 'sessionStorage'].some(type => selections[type]) || snapshot.config.indexedDBMode === 'replace' && selections.indexedDB?.length;
  const large = snapshot.sourceData.indexedDB?.filter(db => selections.indexedDB?.includes(db.name)).some(db => db.records >= LARGE_RECORD_COUNT || db.bytes >= LARGE_BYTES);
  if ((destructive || large) && !request.confirmed) throw new Error('CONFIRMATION_REQUIRED: 此操作需要明确确认。');
  job = { id: crypto.randomUUID(), status: 'running', startedAt: Date.now(), source: snapshot.source.origin, target: snapshot.target.origin, targetTabId: snapshot.target.tabId, logs: [], steps: snapshot.types.map(type => ({ type, status: 'pending', count: 0, skipped: 0, failed: 0, databases: 0, bytes: 0, errors: [] })) };
  executing = true;
  await notify();
  // The job runs in the worker, so closing the popup does not cancel a batch.
  void run(snapshot, selections, Boolean(request.confirmed));
  return { jobId: job.id };
}

async function recoverInterrupted() {
  const stored = (await chrome.storage.session.get('lastJob')).lastJob;
  if (!job && stored?.status === 'running') {
    stored.status = 'interrupted'; stored.error = 'INTERRUPTED: 后台已重启，任务可能部分完成，可在历史记录中撤销已发生的修改。';
    await chrome.storage.session.set({ lastJob: stored });
  }
  if (!executing && job?.status !== 'running' && !preparing) for (const record of await history.records()) {
    if (record.status === 'running') await history.update(record.id, { status: 'interrupted' });
    if (record.undoStatus === 'undoing') await history.update(record.id, { undoStatus: 'failed', undoError: '撤销中断，可以重新撤销以恢复剩余项目。' });
  }
  return job || stored || null;
}

async function runUndo(record, target) {
  const heartbeat = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    await log('正在恢复迁移前的目标数据');
    for (const step of job.steps) {
      step.status = 'running'; await notify();
      const items = step.type === 'cookies' ? record.before.cookies.map(item => ({ id: item.id, data: item }))
        : step.type === 'indexedDB' ? record.before.indexedDB.map(item => ({ id: item.name, data: item }))
        : [{ id: '', data: record.before[step.type] }];
      for (const item of items) {
        const key = historyItemId(step.type, item.id);
        if (!record.touched.includes(key) || record.restored.includes(key)) continue;
        try {
          await page(target, 'ping');
          if (step.type === 'cookies') { await undoCookie(item.data, target); step.count++; }
          else if (step.type === 'indexedDB') { step.count += await undoDatabase(item.data, target, page); step.databases++; }
          else { const result = await page(target, 'storageRestore', { type: step.type, ...item.data, confirmed: true }); step.count += result.count; }
          record.restored.push(key); await history.update(record.id, { restored: record.restored });
        } catch (error) { step.failed++; step.errors.push({ item: item.id || step.type, message: safeError(error) }); }
        await notify();
      }
      step.status = step.failed ? 'partial' : 'success';
    }
    const failed = job.steps.some(step => step.failed);
    await history.update(record.id, failed ? { undoStatus: 'failed', undoError: '部分项目未恢复，请查看结果后重试撤销。' }
      : { undoStatus: 'undone', undoAt: Date.now(), before: null, undoError: null });
    job.status = failed ? 'partial' : 'success'; job.finishedAt = Date.now();
    await log(failed ? '撤销部分完成，可在历史记录中重试剩余项目' : '撤销完成，目标数据已恢复并校验');
  } catch (error) {
    job.status = 'error'; job.error = safeError(error); job.finishedAt = Date.now();
    await history.update(record.id, { undoStatus: 'failed', undoError: job.error }).catch(() => {}); await notify();
  } finally { clearInterval(heartbeat); previews.clear(); executing = false; }
}

async function startUndo(request) {
  if (executing || job?.status === 'running' || preparing) throw new Error('BUSY: 请等待当前迁移或撤销完成。');
  if (!request.confirmed) throw new Error('CONFIRMATION_REQUIRED: 撤销会恢复目标数据，请先确认。');
  preparing = true;
  try {
    const record = await history.latest(request.id);
    let environment = { origin: record.target.origin, tabId: record.target.tabId };
    try {
      const tab = await chrome.tabs.get(record.target.tabId);
      if (normalizeOrigin(tab.url) !== record.target.origin) throw new Error('TARGET_TAB_NOT_FOUND: 原目标标签页已导航。');
    } catch {
      if (record.touched.includes(historyItemId('sessionStorage'))) throw new Error('UNDO_TAB_NOT_FOUND: sessionStorage 属于原目标标签页，请先将该标签页恢复到原网站；已关闭的标签页无法撤销会话存储。');
      environment = { origin: record.target.origin };
    }
    const target = await resolveEnvironment(environment, 'TARGET');
    if (record.types.includes('cookies') && target.storeId !== record.target.storeId) throw new Error('COOKIE_STORE_NOT_FOUND: 当前目标与历史记录不在同一 Cookie 存储区。');
    await history.update(record.id, { undoStatus: 'undoing', undoError: null });
    job = { id: crypto.randomUUID(), kind: 'undo', historyId: record.id, status: 'running', startedAt: Date.now(),
      source: record.source, target: target.origin, targetTabId: target.tabId, logs: [],
      steps: record.types.slice().reverse().map(type => ({ type, status: 'pending', count: 0, skipped: 0, failed: 0, databases: 0, bytes: 0, errors: [] })) };
    executing = true;
    await notify(); void runUndo(record, target); return { jobId: job.id };
  } finally { preparing = false; }
}
async function handle(request) {
  switch (request.kind) {
    case 'INIT': {
      const settings = await chrome.storage.local.get({ settings: DEFAULTS, presets: [] });
      const current = await recoverInterrupted();
      return { tabs: await tabs(), ...settings, job: current, history: await history.list() };
    }
    case 'TABS': return tabs();
    case 'PREVIEW': return preview(request);
    case 'CLONE': return startClone(request);
    case 'JOB': return job || (await chrome.storage.session.get('lastJob')).lastJob || null;
    case 'HISTORY': await recoverInterrupted(); return history.list();
    case 'UNDO': return startUndo(request);
    case 'CLEAR_HISTORY': {
      if (executing || job?.status === 'running' || preparing) throw new Error('BUSY: 任务执行中不能清空撤销快照。');
      await history.clear(); return [];
    }
    case 'SAVE_SETTINGS': {
      const settings = configuration(request.settings);
      await chrome.storage.local.set({ settings }); return settings;
    }
    case 'SAVE_PRESET': {
      const name = String(request.preset.name || '').trim().slice(0, 80);
      if (!name) throw new Error('INVALID_OPTIONS: 请输入预设名称。');
      const { presets = [] } = await chrome.storage.local.get('presets');
      const existing = presets.find(item => item.id === request.preset.id);
      const preset = { id: existing?.id || crypto.randomUUID(), name, sourceOrigin: normalizeOrigin(request.preset.sourceOrigin), targetOrigin: normalizeOrigin(request.preset.targetOrigin), types: Object.fromEntries(TYPES.map(type => [type, Boolean(request.preset.types?.[type])])), config: configuration(request.preset.config), createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
      const next = [...presets.filter(item => item.id !== preset.id), preset];
      await chrome.storage.local.set({ presets: next }); return next;
    }
    case 'DELETE_PRESET': {
      const { presets = [] } = await chrome.storage.local.get('presets');
      const next = presets.filter(item => item.id !== request.id); await chrome.storage.local.set({ presets: next }); return next;
    }
    case 'RELOAD': {
      if (!job?.targetTabId || job.status === 'running') throw new Error('INVALID_OPTIONS: 尚无可刷新的已完成任务。');
      const target = await chrome.tabs.get(job.targetTabId);
      if (normalizeOrigin(target.url) !== job.target) throw new Error('TARGET_TAB_NOT_FOUND: 目标页面已导航，未刷新。');
      await chrome.tabs.reload(target.id); return true;
    }
    default: throw new Error('UNKNOWN_ERROR: 不支持的请求。');
  }
}
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request?.kind === 'DB_BLOCKED' && sender.id === chrome.runtime.id && sender.tab?.id === job?.targetTabId && job.status === 'running') {
    void log('INDEXED_DB_BLOCKED：目标数据库连接仍被占用，正在等待。请关闭页面中的数据库连接或其他同 Origin 标签页。');
    return false;
  }
  // Only local extension pages may initiate data operations; pages have no external API.
  if (sender.id !== chrome.runtime.id || sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (!['INIT', 'TABS', 'PREVIEW', 'CLONE', 'JOB', 'HISTORY', 'UNDO', 'CLEAR_HISTORY', 'SAVE_SETTINGS', 'SAVE_PRESET', 'DELETE_PRESET', 'RELOAD'].includes(request?.kind)) return false;
  handle(request).then(data => respond({ ok: true, data })).catch(error => respond({ ok: false, error: safeError(error) }));
  return true;
});
