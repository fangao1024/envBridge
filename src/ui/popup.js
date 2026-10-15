import { normalizeOrigin } from '../core/origin.js';
import { migrationPermissionPatterns } from '../core/cookie-permissions.js';
import { TYPES, LABELS, DEFAULTS, LARGE_BYTES, LARGE_RECORD_COUNT } from '../core/config.js';
import { icon } from './icons.js';
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, getLanguage, normalizeLanguage, setLanguage, t, translateDocument, translateMessage as tr } from './i18n.js';

const $ = selector => document.querySelector(selector);
const state = { tabs: [], currentTabId: null, settings: { ...DEFAULTS }, presets: [], history: [], preview: null, job: null, busy: false, view: 'transfer' };
const descriptions = { cookies: '包含 HttpOnly · 自动兼容目标环境', localStorage: '持久存储 · 按 Key 选择', sessionStorage: '会话存储 · 绑定所选标签页', indexedDB: '数据库 · 结构、索引与记录' };
const statuses = { add: '+ 新增', modify: '~ 修改', same: '= 相同', remove: '− 移除', replace: '↻ 替换' };
const stepStatuses = { pending: '等待中', running: '迁移中', disabled: '未选择', success: '已校验', partial: '部分失败', warning: '有跳过项', error: '失败' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
const bytes = value => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value || 0} B`;
async function rpc(kind, args = {}) {
  const response = await chrome.runtime.sendMessage({ kind, ...args });
  if (!response?.ok) throw new Error(response?.error || '后台连接失效，请重新打开扩展。');
  return response.data;
}
function notice(message, error = false) {
  state.notice = { message, error };
  const node = $('#notice');
  node.textContent = tr(message); node.classList.toggle('error', error); node.hidden = !message;
}
function show(view) {
  state.view = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `${view}-view`;
  for (const button of document.querySelectorAll('.nav button')) button.classList.toggle('active', button.dataset.view === (['preview', 'result'].includes(view) ? 'transfer' : view));
  $(`#${view}-view .view-content`).scrollTop = 0;
  window.scrollTo(0, 0);
}
function setBusy(value) {
  state.busy = value;
  for (const button of document.querySelectorAll('#preview, #clone-all, .clone-one, #confirm-clone')) button.disabled = value;
  $('#preview').textContent = t(value ? '正在读取…' : '预览变更');
}
async function guarded(task) {
  try { return await task(); } catch (error) { notice(error.message, true); }
}
function types() { return Object.fromEntries(TYPES.map(type => [type, $(`#type-${type}`).checked])); }
function config() { return { cookieMode: $('#cookie-mode').value, storageMode: $('#storage-mode').value, indexedDBMode: $('#idb-mode').value, reload: $('#reload').checked, preview: state.settings.preview }; }
function setConfig(value) {
  $('#cookie-mode').value = value.cookieMode; $('#storage-mode').value = value.storageMode; $('#idb-mode').value = value.indexedDBMode; $('#reload').checked = value.reload;
  updateStrategy();
}
function updateStrategy() {
  const modes = config();
  $('#strategy-label').textContent = `${modes.cookieMode === 'rewrite' ? 'Rewrite' : 'Preserve'} · ${modes.storageMode === 'clear' ? 'Clear & Clone' : modes.storageMode === 'overwrite' ? 'Overwrite' : 'Merge'}`;
  state.preview = null;
}
function renderTypes() {
  for (const type of TYPES) {
    const row = el('div', 'type-row');
    const label = el('label'); label.htmlFor = `type-${type}`;
    const check = el('input'); check.type = 'checkbox'; check.id = `type-${type}`; check.checked = true;
    const text = el('span', 'type-copy'); text.append(el('strong', '', LABELS[type]), el('small', '', t(descriptions[type])));
    const typeIcon = el('span', 'type-icon'); typeIcon.append(icon(type));
    label.append(check, typeIcon, text);
    const count = el('span', 'type-count', '—'); count.id = `count-${type}`;
    const button = el('button', 'clone-one', t('迁移')); button.title = t('仅迁移 {type}', { type: LABELS[type] });
    button.addEventListener('click', () => guarded(() => prepare(true, [type])));
    row.append(label, count, button); $('#type-list').append(row);
  }
}
function fillTabs(side, desiredId, origin) {
  const select = $(`#${side}-tab`);
  const previous = select.value;
  select.replaceChildren();
  for (const tab of state.tabs) {
    const option = el('option', '', `${tab.origin} · ${tab.title || t('未命名页面')} [Tab ${tab.id}]`); option.value = String(tab.id); select.append(option);
  }
  const manual = el('option', '', t('手动输入网站地址…')); manual.value = 'manual'; select.append(manual);
  if (desiredId && state.tabs.some(tab => tab.id === Number(desiredId))) select.value = String(desiredId);
  else if (origin && state.tabs.some(tab => tab.origin === origin)) select.value = String(state.tabs.find(tab => tab.origin === origin).id);
  else if (origin) { select.value = 'manual'; $(`#${side}-origin`).value = origin; }
  else if ([...select.options].some(option => option.value === previous)) select.value = previous;
  else select.value = state.tabs.length ? String(state.tabs[0].id) : 'manual';
  syncOriginInput(side);
}
function syncOriginInput(side) {
  $(`#${side}-origin`).hidden = $(`#${side}-tab`).value !== 'manual';
  state.preview = null;
}
function environment(side) {
  const select = $(`#${side}-tab`);
  if (select.value === 'manual') return { origin: normalizeOrigin($(`#${side}-origin`).value.trim()) };
  const tab = state.tabs.find(item => item.id === Number(select.value));
  if (!tab) throw new Error('请先选择可操作的 HTTP / HTTPS 页面。');
  return { origin: tab.origin, tabId: tab.id };
}
function request(overrides) {
  const source = environment('source'); const target = environment('target');
  if (source.origin === target.origin) throw new Error('源与目标必须是不同 Origin。');
  const selected = overrides ? Object.fromEntries(TYPES.map(type => [type, overrides.includes(type)])) : types();
  if (!Object.values(selected).some(Boolean)) throw new Error('请至少选择一类数据。');
  return { source, target, types: selected, config: config() };
}
async function prepare(cloneRequested = false, overrides) {
  if (state.busy) return;
  // permissions.request is invoked directly from a click, before any other await.
  const options = request(overrides);
  const permission = chrome.permissions.request({ origins: migrationPermissionPatterns(options.source.origin, options.target.origin, options.types) });
  setBusy(true); notice('正在读取所选环境。IndexedDB 大库的统计可能需要一些时间。');
  try {
    if (!await permission) throw new Error('PERMISSION_DENIED: 网站授权被拒绝，未读取或迁移数据。');
    state.preview = await rpc('PREVIEW', options);
    notice(''); renderPreview(); show('preview');
    for (const type of state.preview.types) $(`#count-${type}`).textContent = state.preview.readErrors[type] ? '!' : String(state.preview.rows[type].filter(row => row.status !== 'remove').length);
    const hasWarnings = Object.keys(state.preview.readErrors).length || state.preview.types.some(type => state.preview.rows[type].some(row => row.warnings?.length || row.errors?.length));
    if (cloneRequested && !state.settings.preview && !hasWarnings) await beginClone();
  } finally { setBusy(false); }
}
function originSummary(node, source, target) {
  const arrow = el('span', 'arrow'); arrow.append(icon('arrow-down'));
  node.replaceChildren(el('small', '', 'SOURCE'), el('span', '', source), arrow, el('small', '', 'TARGET'), el('span', '', target));
}
function warningBox(messages, error = false) {
  const box = el('div', error ? 'error-box' : 'warning-box');
  for (const message of messages) box.append(el('p', '', tr(message)));
  return box;
}
function checkbox(className, value, checked = true) {
  const input = el('input', className); input.type = 'checkbox'; input.value = value; input.checked = checked; return input;
}
function renderPreview() {
  const data = state.preview;
  originSummary($('#preview-origins'), data.source.origin, data.target.origin);
  $('#preview-warnings').replaceChildren();
  if (new URL(data.source.origin).hostname === new URL(data.target.origin).hostname && data.types.includes('cookies')) $('#preview-warnings').append(warningBox(['Cookie 不按端口隔离：这两个 Origin 共用主机，Cookie 写入会影响该主机下的其他页面，包括源页面。']));
  if (data.config.storageMode === 'clear') $('#preview-warnings').append(warningBox(['Clear & Clone：将清空目标的对应 Storage，仅写入下方选中的源 Key。取消选中的 Key 也会从目标移除。']));
  if (data.config.indexedDBMode === 'replace') $('#preview-warnings').append(warningBox(['Replace Database：将删除目标同名数据库后重新创建。请先自行备份，并让目标页面关闭数据库连接。迁移中不要刷新源或目标页面。']));
  $('#preview-groups').replaceChildren();
  for (const type of data.types) {
    const group = el('section', 'preview-group'); group.dataset.type = type;
    const head = el('div', 'group-head');
    const enabled = checkbox('group-enabled', type); enabled.setAttribute('aria-label', t('迁移 {type}', { type: LABELS[type] }));
    const all = el('button', 'text-button', t('全选')); const none = el('button', 'text-button', t('全不选'));
    all.addEventListener('click', () => { for (const input of group.querySelectorAll('.item-check')) input.checked = true; enabled.checked = true; updateSelection(); });
    none.addEventListener('click', () => { for (const input of group.querySelectorAll('.item-check')) input.checked = false; updateSelection(); });
    enabled.addEventListener('change', updateSelection);
    head.append(enabled, el('strong', '', LABELS[type]), all, none); group.append(head);
    if (data.readErrors[type]) { group.append(warningBox([data.readErrors[type]], true)); enabled.checked = false; enabled.disabled = true; }
    else {
      const rows = data.rows[type].filter(row => row.status !== 'remove');
      const totalBytes = rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
      const summary = type === 'indexedDB'
        ? t('{count} 个数据库 · {records} 条记录 · 估算 {bytes}', { count: rows.length, records: rows.reduce((sum, row) => sum + row.records, 0).toLocaleString(getLanguage()), bytes: bytes(totalBytes) })
        : t('{count} 个项目{size}', { count: rows.length, size: totalBytes ? ` · ${bytes(totalBytes)}` : '' });
      group.append(el('div', 'group-summary', summary));
      if (!rows.length) group.append(el('p', 'empty', t(type === 'cookies' ? '当前 Cookie 存储与授权范围内未读到该主机的普通 Cookie。请确认标签页与扩展在同一浏览器配置中；其他域或分区 Cookie 不属于本次读取范围。' : '源环境中没有此类数据。')));
      for (const row of rows) {
        const item = el('div', 'item-row');
        const line = el('div', 'item-line'); const label = el('label');
        const input = checkbox('item-check', row.id, row.writable !== false); input.addEventListener('change', updateSelection);
        label.append(input, el('span', 'item-name', row.name));
        line.append(label, el('span', `status-badge ${row.errors?.length ? 'warning' : row.status}`, t(row.errors?.length ? '! 将跳过' : statuses[row.status]))); item.append(line);
        if (type === 'cookies') renderCookieDetails(item, row);
        if (type === 'indexedDB') {
          const details = el('details'); const summary = el('summary', '', `v${row.version}${row.targetVersion ? ` → ${t('目标')} v${row.targetVersion}` : ''} · ${row.stores.length} ${t('个表')} · ${row.records.toLocaleString(getLanguage())} ${t('条记录')} · ${t('估算')} ${bytes(row.bytes)}`);
          details.append(summary);
          for (const store of row.stores) { const storeLine = el('div', 'store-line'); storeLine.append(el('span', '', store.name), el('span', '', t('{count} 条 · {indexes} 个索引', { count: store.count.toLocaleString(getLanguage()), indexes: store.indexes.length }))); details.append(storeLine); }
          item.append(details);
        }
        if (row.warnings?.length) item.append(warningBox(row.warnings));
        if (row.errors?.length) item.append(warningBox(row.errors, true));
        group.append(item);
      }
      if (['localStorage', 'sessionStorage'].includes(type) && data.config.storageMode === 'clear') group.append(el('div', 'remove-zone'));
    }
    $('#preview-groups').append(group);
  }
  updateSelection();
}
function renderCookieDetails(item, row) {
  const details = el('details'); details.append(el('summary', '', t('{special}{count} 项属性变更 · 查看详情', { special: row.special ? t('特殊 Cookie · ') : '', count: row.changes.length })));
  const table = el('table', 'cookie-diff');
  const header = el('tr'); for (const label of ['属性', '源', '目标']) header.append(el('th', '', t(label))); table.append(header);
  for (const key of ['domain', 'hostOnly', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate']) {
    const line = el('tr', row.changes.some(change => change.field === key) ? 'changed' : '');
    const display = value => value === null ? 'Session' : typeof value === 'boolean' ? String(value) : value;
    line.append(el('td', '', key), el('td', '', display(row.source[key])), el('td', '', display(row.target[key]))); table.append(line);
  }
  details.append(table); item.append(details);
}
function selections() {
  const selected = {};
  for (const group of document.querySelectorAll('.preview-group')) {
    if (!group.querySelector('.group-enabled').checked) continue;
    selected[group.dataset.type] = [...group.querySelectorAll('.item-check:checked')].map(input => input.value);
  }
  return selected;
}
function updateSelection() {
  const selected = selections();
  let count = 0; for (const values of Object.values(selected)) count += values.length;
  $('#preview-total').textContent = t('{count} 项已选择', { count });
  for (const type of ['localStorage', 'sessionStorage']) {
    const zone = $(`.preview-group[data-type="${type}"] .remove-zone`);
    if (!zone) continue;
    zone.replaceChildren();
    if (!selected[type]) continue;
    const targetKeys = state.preview.targetKeys?.[type] || [];
    for (const key of targetKeys.filter(key => !selected[type].includes(key))) {
      const line = el('div', 'item-row remove'); line.append(el('span', 'item-name', key), el('span', 'status-badge remove', t(' − 将移除'))); zone.append(line);
    }
  }
}
function confirmAction(title, messages) {
  const dialog = $('#confirm-dialog');
  state.confirmation = { title, messages };
  $('#confirm-title').textContent = tr(title); $('#confirm-body').replaceChildren(...messages.map(message => el('p', '', tr(message))));
  dialog.returnValue = 'cancel'; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function beginClone() {
  const data = state.preview;
  if (!data) throw new Error('预览已失效，请重新读取。');
  const selected = selections();
  const selectedCount = Object.values(selected).reduce((sum, value) => sum + value.length, 0);
  const clear = data.config.storageMode === 'clear' && ['localStorage', 'sessionStorage'].some(type => selected[type]);
  if (!selectedCount && !clear) throw new Error('请选择至少一个数据项。');
  const replace = data.config.indexedDBMode === 'replace' && selected.indexedDB?.length;
  const large = data.rows.indexedDB?.some(db => selected.indexedDB?.includes(db.name) && (db.bytes >= LARGE_BYTES || db.records >= LARGE_RECORD_COUNT));
  let confirmed = false;
  if (clear || replace || large) {
    const messages = [`目标环境：${data.target.origin}`];
    if (clear) messages.push('将清空所选 Storage 中的所有已有 Key，再写入选中的源 Key。');
    if (replace) messages.push('将删除目标同名数据库并重建；中途失败可能留下部分数据。请先自行备份。数据库若被占用，任务将等待其连接关闭。');
    if (large) messages.push('检测到较大的 IndexedDB。采用分批传输，但单条大记录仍可能占用较多内存。请保持源与目标页面打开。');
    confirmed = await confirmAction('确认继续此迁移？', messages);
    if (!confirmed) return;
  }
  setBusy(true);
  try {
    await rpc('CLONE', { previewId: data.id, selections: selected, confirmed });
    notice(''); state.job = await rpc('JOB'); renderJob(); show('result');
  } finally { setBusy(false); }
}
function renderJob() {
  const job = state.job; if (!job) return;
  const running = job.status === 'running';
  const success = job.status === 'success';
  const undo = job.kind === 'undo';
  $('#result-title').textContent = t(running ? undo ? '正在撤销迁移' : '正在迁移浏览器状态' : success ? undo ? '已恢复迁移前的数据。' : '环境已连接，继续开发。' : job.status === 'interrupted' ? '任务已中断' : undo ? '撤销结束，请检查结果' : '迁移结束，请检查结果');
  $('#result-icon').replaceChildren(icon(running ? 'transfer' : success ? 'check' : 'warning'));
  $('#result-icon').dataset.state = running ? 'running' : success ? 'success' : 'warning';
  $('#result-subtitle').textContent = t(running ? '关闭弹窗后，任务仍会在后台继续。请不要刷新相关页面。' : success ? undo ? '目标数据已恢复，并通过内容校验。' : '所选数据已写入，并通过内容校验。可在历史记录中撤销。' : undo ? '已恢复的项目会保留，可以在历史记录中重试剩余项目。' : '已写入的项目会保留，可以在历史记录中撤销。错误和跳过项见下方。');
  originSummary($('#result-origins'), job.source, job.target);
  $('#result-steps').replaceChildren(); $('#result-errors').replaceChildren();
  for (const step of job.steps) {
    const card = el('div', 'result-step'); const text = el('div');
    text.append(el('strong', '', LABELS[step.type]), el('small', '', `${step.count.toLocaleString(getLanguage())} ${t(step.type === 'indexedDB' ? '条记录' : '项')}${step.databases ? t(' · {count} 个数据库', { count: step.databases }) : ''}${step.skipped ? t(' · {count} 跳过', { count: step.skipped }) : ''}${step.failed ? t(' · {count} 失败', { count: step.failed }) : ''}`));
    const status = el('span', `step-state ${step.status === 'success' ? 'add' : ['partial', 'error'].includes(step.status) ? 'remove' : 'same'}`, t(stepStatuses[step.status]));
    if (step.status === 'running') status.prepend(el('span', 'spinner'), document.createTextNode(' '));
    if (step.status === 'success') status.prepend(icon('check'));
    card.append(text, status); $('#result-steps').append(card);
    for (const error of step.errors) $('#result-errors').append(warningBox([`${LABELS[step.type]}${error.item ? ` / ${error.item}` : ''}`, error.message], true));
    if (step.warnings?.length) $('#result-errors').append(warningBox(step.warnings));
  }
  if (job.error) $('#result-errors').append(warningBox([job.error], true));
  $('#logs').replaceChildren();
  for (const log of job.logs) { const line = el('li'); const time = el('time', '', new Date(log.time).toLocaleTimeString(getLanguage(), { hour12: false })); line.append(time, document.createTextNode(tr(log.message))); $('#logs').append(line); }
  $('#new-clone').disabled = running; $('#reload-target').disabled = running;
}
async function refreshHistory() { state.history = await rpc('HISTORY'); renderHistory(); }
async function undoHistory(record) {
  if (state.busy || state.job?.status === 'running') throw new Error('BUSY: 请等待当前任务结束。');
  const messages = [`目标：${record.target}`, `恢复类型：${record.types.map(type => LABELS[type]).join('、')}`,
    '撤销会恢复本次迁移影响的数据。清空 Storage 或数据库迁移的撤销会覆盖其迁移后新增的内容。'];
  if (!await confirmAction('撤销这次迁移？', messages)) return;
  // Restore user activation after the confirmation dialog, before the first await.
  const types = Object.fromEntries(record.types.map(type => [type, true]));
  const permission = chrome.permissions.request({ origins: migrationPermissionPatterns(record.target, record.target, types) });
  setBusy(true);
  try {
    if (!await permission) throw new Error('PERMISSION_DENIED: 未授权目标网站，未撤销数据。');
    await rpc('UNDO', { id: record.id, confirmed: true });
    state.job = await rpc('JOB'); state.preview = null; renderJob(); show('result');
  } finally { setBusy(false); }
}
function renderHistory() {
  const list = $('#history-list'); list.replaceChildren();
  $('#clear-history').disabled = state.job?.status === 'running';
  if (!state.history.length) list.append(el('div', 'empty', t('当前会话还没有迁移历史。迁移前会自动保存目标数据，用于撤销。')));
  for (const record of state.history) {
    const card = el('article', 'preset-card history-card'); card.dataset.historyId = record.id;
    const head = el('div', 'section-heading');
    const label = record.undoStatus === 'undone' ? '已撤销' : record.undoStatus === 'undoing' ? '撤销中' : record.undoStatus === 'failed' ? '撤销待重试' : ({ running: '迁移中', success: '迁移成功', partial: '部分完成', error: '迁移失败', interrupted: '任务中断' }[record.status] || record.status);
    head.append(el('strong', '', new Date(record.createdAt).toLocaleString(getLanguage(), { hour12: false })), el('span', 'pill', t(label)));
    const origins = el('div', 'origin-summary'); originSummary(origins, record.source, record.target);
    const summary = el('p', 'help', t('{types} · {count} 项写入', { types: record.types.map(type => LABELS[type]).join(' · '), count: record.count }));
    const button = el('button', 'button secondary undo-history', t(record.undoStatus === 'failed' ? '重试撤销' : '撤销修改'));
    button.disabled = !record.canUndo || state.job?.status === 'running';
    button.addEventListener('click', () => guarded(() => undoHistory(record)));
    card.append(head, origins, summary, button);
    if (!record.canUndo && record.undoStatus !== 'undone' && record.status !== 'running') card.append(el('p', 'help', t('请先撤销最近一条有修改的记录；未产生修改的任务无需撤销。')));
    if (record.undoError) card.append(warningBox([record.undoError], true));
    list.append(card);
  }
}
function applyPreset(preset) {
  fillTabs('source', null, preset.sourceOrigin); fillTabs('target', null, preset.targetOrigin);
  for (const type of TYPES) $(`#type-${type}`).checked = preset.types[type];
  setConfig({ ...state.settings, ...preset.config }); state.preview = null; show('transfer'); notice(`已应用预设：${preset.name}`);
}
function renderPresets() {
  const list = $('#presets-list'); list.replaceChildren();
  if (!state.presets.length) list.append(el('div', 'empty', t('还没有环境预设。\n预览迁移后，可以保存常用的源与目标映射。')));
  for (const preset of state.presets) {
    const card = el('article', 'preset-card');
    const head = el('div', 'section-heading'); head.append(el('h2', '', preset.name), el('span', 'pill', t('{count} 类数据', { count: Object.values(preset.types).filter(Boolean).length })));
    const origins = el('div', 'origin-summary'); originSummary(origins, preset.sourceOrigin, preset.targetOrigin);
    const actions = el('div', 'preset-actions');
    const use = el('button', 'button secondary', t('应用预设')); use.addEventListener('click', () => applyPreset(preset));
    const clone = el('button', 'button primary', t('迁移')); clone.append(icon('arrow-right')); clone.addEventListener('click', () => guarded(async () => { applyPreset(preset); await prepare(true); }));
    const remove = el('button', 'text-button', t('删除')); remove.addEventListener('click', () => guarded(async () => { state.presets = await rpc('DELETE_PRESET', { id: preset.id }); renderPresets(); }));
    actions.append(use, clone, remove); card.append(head, origins, actions); list.append(card);
  }
}
function renderSettings() {
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(state.settings)) { const field = form.elements.namedItem(key); if (field) { if (field.type === 'checkbox') field.checked = Boolean(value); else field.value = value; } }
}

function applyLanguage(value) {
  setLanguage(value);
  translateDocument();
  $('#language').value = getLanguage();
  for (const type of TYPES) {
    const row = $(`#type-${type}`)?.closest('.type-row');
    if (!row) continue;
    row.querySelector('.type-copy small').textContent = t(descriptions[type]);
    row.querySelector('.clone-one').textContent = t('迁移');
    row.querySelector('.clone-one').title = t('仅迁移 {type}', { type: LABELS[type] });
  }
  for (const side of ['source', 'target']) {
    for (const option of $(`#${side}-tab`).options) {
      const tab = state.tabs.find(tab => String(tab.id) === option.value);
      if (option.value === 'manual') option.textContent = t('手动输入网站地址…');
      else if (tab) option.textContent = `${tab.origin} · ${tab.title || t('未命名页面')} [Tab ${tab.id}]`;
    }
  }
  if (state.preview) {
    const choices = Object.fromEntries([...document.querySelectorAll('.preview-group')].map(group => [group.dataset.type, {
      enabled: group.querySelector('.group-enabled').checked,
      items: [...group.querySelectorAll('.item-check:checked')].map(input => input.value)
    }]));
    const openDetails = [...document.querySelectorAll('#preview-groups details')].map(node => node.open);
    renderPreview();
    for (const group of document.querySelectorAll('.preview-group')) {
      const choice = choices[group.dataset.type];
      group.querySelector('.group-enabled').checked = choice.enabled;
      for (const input of group.querySelectorAll('.item-check')) input.checked = choice.items.includes(input.value);
    }
    [...document.querySelectorAll('#preview-groups details')].forEach((node, index) => node.open = openDetails[index]);
    updateSelection();
  }
  renderPresets(); renderHistory(); renderJob(); setBusy(state.busy);
  if ($('#confirm-dialog').open && state.confirmation) {
    $('#confirm-title').textContent = tr(state.confirmation.title);
    $('#confirm-body').replaceChildren(...state.confirmation.messages.map(message => el('p', '', tr(message))));
  }
  if (state.notice) notice(state.notice.message, state.notice.error);
}

async function init() {
  const savedLanguage = await chrome.storage.local.get({ [LANGUAGE_STORAGE_KEY]: DEFAULT_LANGUAGE });
  setLanguage(savedLanguage[LANGUAGE_STORAGE_KEY]);
  translateDocument();
  $('#language').value = getLanguage();
  $('#language').addEventListener('change', () => guarded(async () => {
    const next = normalizeLanguage($('#language').value);
    try { await chrome.storage.local.set({ [LANGUAGE_STORAGE_KEY]: next }); }
    catch (error) { $('#language').value = getLanguage(); throw error; }
    if (getLanguage() !== next) applyLanguage(next);
    notice('界面语言已保存。');
  }));
  if (new URLSearchParams(location.search).has('workspace')) { document.body.classList.add('workspace'); $('#workspace').hidden = true; }
  renderTypes();
  for (const button of document.querySelectorAll('.nav button')) button.addEventListener('click', () => { notice(''); show(button.dataset.view); if (button.dataset.view === 'history') guarded(refreshHistory); if (button.dataset.view === 'transfer' && state.job?.status === 'running') show('result'); });
  $('#clear-history').addEventListener('click', () => guarded(async () => {
    if (!await confirmAction('清空历史记录？', ['这只会删除会话内存中的撤销快照，不会修改网站数据。清空后无法撤销之前的迁移。'])) return;
    state.history = await rpc('CLEAR_HISTORY'); renderHistory(); notice('历史记录已清空。');
  }));
  for (const side of ['source', 'target']) $(`#${side}-tab`).addEventListener('change', () => syncOriginInput(side));
  for (const selector of ['#cookie-mode', '#storage-mode', '#idb-mode', '#reload']) $(selector).addEventListener('change', updateStrategy);
  $('#select-types').addEventListener('click', () => { const all = TYPES.every(type => $(`#type-${type}`).checked); for (const type of TYPES) $(`#type-${type}`).checked = !all; });
  $('#preview').addEventListener('click', () => guarded(() => prepare()));
  $('#clone-all').addEventListener('click', () => guarded(() => prepare(true)));
  $('#confirm-clone').addEventListener('click', () => guarded(beginClone));
  $('#back').addEventListener('click', () => show('transfer'));
  $('#new-clone').addEventListener('click', () => { state.preview = null; show('transfer'); });
  $('#reload-target').addEventListener('click', () => guarded(async () => { await rpc('RELOAD'); notice('目标页面已刷新。'); }));
  $('#workspace').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?workspace=1') }));
  $('#refresh-tabs').addEventListener('click', () => guarded(async () => { state.tabs = await rpc('TABS'); fillTabs('source'); fillTabs('target'); notice('页面列表已更新。'); }));
  $('#use-current').addEventListener('click', () => guarded(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!state.tabs.some(item => item.id === tab?.id)) throw new Error('当前页面无法操作，请选择已打开的 HTTP / HTTPS 标签页。'); fillTabs('source', tab.id); }));
  $('#swap').addEventListener('click', () => guarded(() => { const source = environment('source'), target = environment('target'); fillTabs('source', target.tabId, target.origin); fillTabs('target', source.tabId, source.origin); }));
  $('#save-preset').addEventListener('click', () => { $('#preset-name').value = ''; $('#preset-dialog').showModal(); $('#preset-name').focus(); });
  $('#cancel-preset').addEventListener('click', () => $('#preset-dialog').close());
  $('#preset-form').addEventListener('submit', event => {
    event.preventDefault(); guarded(async () => {
      if (!state.preview) throw new Error('预览已失效，请重新预览后保存。');
      const selected = selections();
      state.presets = await rpc('SAVE_PRESET', { preset: { name: $('#preset-name').value, sourceOrigin: state.preview.source.origin, targetOrigin: state.preview.target.origin, types: Object.fromEntries(TYPES.map(type => [type, Boolean(selected[type])])), config: state.preview.config } });
      $('#preset-dialog').close(); renderPresets(); notice('环境预设已保存。');
    });
  });
  $('#settings-form').addEventListener('submit', event => {
    event.preventDefault(); guarded(async () => {
      const form = event.currentTarget; const settings = {};
      for (const key of Object.keys(DEFAULTS)) { const field = form.elements.namedItem(key); settings[key] = field.type === 'checkbox' ? field.checked : field.value; }
      state.settings = await rpc('SAVE_SETTINGS', { settings }); setConfig(state.settings); notice('默认设置已保存。');
    });
  });
  chrome.runtime.onMessage.addListener(message => { if (message.kind === 'PROGRESS') { state.job = message.job; renderJob(); } });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.migrationHistory) guarded(refreshHistory);
    if (area === 'local' && changes[LANGUAGE_STORAGE_KEY]) applyLanguage(changes[LANGUAGE_STORAGE_KEY].newValue);
  });
  const data = await rpc('INIT');
  state.tabs = data.tabs; state.settings = { ...DEFAULTS, ...data.settings }; state.presets = data.presets; state.job = data.job; state.history = data.history || [];
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const source = state.tabs.find(tab => tab.id === active?.id) || state.tabs[0];
  state.currentTabId = source?.id;
  fillTabs('source', source?.id);
  fillTabs('target', state.tabs.find(tab => tab.origin !== source?.origin)?.id);
  setConfig(state.settings); renderPresets(); renderSettings(); renderHistory();
  if (state.job) { renderJob(); show('result'); }
  // Pull once on visibility restoration in case progress arrived while the popup was closed.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) guarded(async () => { const current = await rpc('JOB'); if (current) { state.job = current; renderJob(); } }); });
}
guarded(init);
