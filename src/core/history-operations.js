import { cookieId, rewriteCookie, sameCookie, sameCookieIdentity, originalCookieDetails } from './cookie.js';
import { readCookies } from './cookie-reader.js';
import { HISTORY_MAX_BYTES, historyBytes } from './history.js';
import { BATCH_SIZE } from './config.js';

export const historyItemId = (type, id = '') => JSON.stringify([type, id]);

export async function captureHistory(snapshot, selections, id, page, cookies = chrome) {
  const record = { id, createdAt: Date.now(), source: snapshot.source.origin, target: snapshot.target,
    types: Object.keys(selections).filter(type => !snapshot.readErrors[type]), status: 'running',
    undoStatus: 'available', before: {}, touched: [], restored: [] };
  let used = 0;
  const account = value => {
    used += historyBytes(value);
    if (used > HISTORY_MAX_BYTES - 256 * 1024) throw new Error('HISTORY_QUOTA: 目标撤销快照超过会话内存上限，尚未修改目标。请减少迁移数据。');
  };
  for (const type of record.types) {
    if (type === 'cookies') {
      const current = await readCookies(snapshot.target, cookies);
      record.before.cookies = snapshot.sourceData.cookies.filter(cookie => selections.cookies.includes(cookieId(cookie)))
        .filter(cookie => snapshot.rows.cookies.find(row => row.id === cookieId(cookie))?.writable)
        .map(cookie => {
          const rewritten = rewriteCookie(cookie, snapshot.source.origin, snapshot.target.origin, snapshot.config.cookieMode);
          return { id: cookieId(cookie), next: rewritten.next, original: current.find(item => sameCookieIdentity(rewritten.next, item)) || null };
        });
      account(record.before.cookies);
    } else if (type !== 'indexedDB') {
      const current = await page(snapshot.target, 'storageRead', { type });
      const clear = snapshot.config.storageMode === 'clear';
      const keys = selections[type];
      record.before[type] = { mode: clear ? 'clear' : 'patch', keys,
        items: clear ? current : current.filter(item => keys.includes(item.key)) };
      account(record.before[type]);
    } else {
      record.before.indexedDB = [];
      const current = await page(snapshot.target, 'idbList');
      for (const name of selections.indexedDB) {
        if (!snapshot.rows.indexedDB.find(row => row.name === name)?.writable) continue;
        const meta = current.find(item => item.name === name) || null;
        const backup = { name, meta, stores: [] };
        account({ name, meta });
        for (const store of meta?.stores || []) {
          const saved = { name: store.name, batches: [], nextKey: store.autoIncrement
            ? await page(snapshot.target, 'idbGeneratorRead', { database: name, version: meta.version, store: store.name }) : null };
          let after = null, count = 0;
          while (true) {
            const batch = await page(snapshot.target, 'idbRead', { database: name, version: meta.version, store: store.name, after, limit: BATCH_SIZE });
            try {
              if (!batch.count) break;
              const chunks = [];
              for (let index = 0; index < batch.chunks; index++) {
                const chunk = await page(snapshot.target, 'transferRead', { token: batch.token, index });
                account(chunk); chunks.push(chunk);
              }
              saved.batches.push({ chunks, count: batch.count }); count += batch.count; after = batch.after;
              if (batch.count < BATCH_SIZE) break;
            } finally { await page(snapshot.target, 'transferDrop', { token: batch.token }).catch(() => {}); }
          }
          if (count !== store.count) throw new Error('TARGET_CHANGED: 备份期间目标数据库发生变化，请重新预览。');
          backup.stores.push(saved);
        }
        record.before.indexedDB.push(backup);
      }
    }
  }
  return record;
}

export async function undoCookie(item, target, api = chrome) {
  const original = item.original;
  if (original && (original.expirationDate === undefined || original.expirationDate > Date.now() / 1000)) {
    const written = await api.cookies.set(originalCookieDetails(original, target.storeId));
    if (!sameCookie(original, written)) throw new Error('VERIFY_FAILED: 原 Cookie 的值或属性未完整恢复。');
    const actual = (await readCookies(target, api)).find(cookie => sameCookieIdentity(original, cookie));
    if (!sameCookie(original, actual)) throw new Error('VERIFY_FAILED: 恢复后的 Cookie 校验失败。');
  } else {
    const current = (await readCookies(target, api)).find(cookie => sameCookieIdentity(item.next, cookie));
    if (!current) return;
    const details = originalCookieDetails(current, target.storeId);
    const selected = await api.cookies.get({ url: details.url, name: current.name, storeId: target.storeId });
    if (!sameCookieIdentity(current, selected)) throw new Error('COOKIE_REMOVE_AMBIGUOUS: 同名 Cookie 的作用域有冲突，未删除其他 Cookie。');
    await api.cookies.remove({ url: details.url, name: current.name, storeId: target.storeId });
    if ((await readCookies(target, api)).some(cookie => sameCookieIdentity(item.next, cookie))) throw new Error('VERIFY_FAILED: 新增 Cookie 未删除。');
  }
}

export async function undoDatabase(backup, target, page) {
  if (!backup.meta) {
    await page(target, 'idbDrop', { database: backup.name, confirmed: true });
    if ((await page(target, 'idbList')).some(db => db.name === backup.name)) throw new Error('VERIFY_FAILED: 新建数据库未移除。');
    return 0;
  }
  const ensured = await page(target, 'idbEnsure', { meta: backup.meta, mode: 'replace', confirmed: true });
  let count = 0;
  for (const store of backup.stores) {
    for (const batch of store.batches) {
      const token = crypto.randomUUID();
      try {
        for (const chunk of batch.chunks) await page(target, 'transferAppend', { token, chunk });
        const result = await page(target, 'idbWrite', { token, database: backup.name, version: ensured.version, store: store.name });
        count += result.count;
      } finally { await page(target, 'transferDrop', { token }).catch(() => {}); }
    }
    if (store.nextKey !== null) await page(target, 'idbGeneratorRestore', { database: backup.name, version: ensured.version, store: store.name, nextKey: store.nextKey });
  }
  const actual = (await page(target, 'idbList')).find(db => db.name === backup.name);
  const schema = meta => ({ version: meta.version, stores: meta.stores.map(store => ({ name: store.name, keyPath: store.keyPath,
    autoIncrement: store.autoIncrement, indexes: store.indexes, count: store.count })) });
  if (!actual || JSON.stringify(schema(actual)) !== JSON.stringify(schema(backup.meta))) throw new Error('VERIFY_FAILED: 原数据库版本、结构或记录数未完整恢复。');
  return count;
}
