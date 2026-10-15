/* Executes only in the extension's ISOLATED world, on the selected top document. */
(() => {
  if (globalThis.__envBridgePageV1 && globalThis.__envBridgeAdapterVersion === '1.1.0') return;
  const codec = globalThis.EnvBridgeCodec();
  const transfers = new Map();
  const CHUNK_SIZE = 512 * 1024;
  function trackTransfer(token, item) {
    transfers.set(token, item);
    const expire = () => {
      const current = transfers.get(token);
      if (!current) return;
      const remaining = 120000 - (Date.now() - current.createdAt);
      if (remaining <= 0) transfers.delete(token);
      else setTimeout(expire, remaining);
    };
    setTimeout(expire, 120000);
  }
  const requestValue = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transactionDone = transaction => new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('INDEXED_DB_WRITE_FAILED: 事务已回滚。'));
    transaction.onerror = () => {}; // onabort is the final transaction outcome.
  });
  const openDatabase = (name, version, upgrade) => new Promise((resolve, reject) => {
    const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; reject(new Error('INDEXED_DB_BLOCKED: 数据库被页面连接占用，请关闭相关页面连接后重试。')); }, 12000);
    request.onblocked = () => {}; // Give cooperating pages a chance to close on versionchange.
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onupgradeneeded = () => {
      if (timedOut) { request.transaction.abort(); return; }
      try { upgrade?.(request.result, request.transaction); } catch (error) { request.transaction.abort(); clearTimeout(timer); reject(error); }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (timedOut) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  function schema(db, transaction) {
    return { name: db.name, version: db.version, stores: [...db.objectStoreNames].map(name => {
      const store = transaction.objectStore(name);
      return { name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames].map(indexName => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      }) };
    }) };
  }
  async function listDatabases() {
    if (typeof indexedDB.databases !== 'function') throw new Error('INDEXED_DB_READ_FAILED: 当前浏览器不支持数据库枚举。');
    const databases = [];
    for (const info of await indexedDB.databases()) {
      if (info.name === undefined || !info.version) continue;
      const db = await openDatabase(info.name, info.version);
      try {
        if (!db.objectStoreNames.length) { databases.push({ name: db.name, version: db.version, stores: [], records: 0, bytes: 0, estimated: true }); continue; }
        const tx = db.transaction([...db.objectStoreNames], 'readonly');
        const done = transactionDone(tx);
        const meta = schema(db, tx);
        const reads = meta.stores.map(store => {
          const objectStore = tx.objectStore(store.name);
          return Promise.all([requestValue(objectStore.count()), requestValue(objectStore.getAll(undefined, 10))]);
        });
        const samples = await Promise.all(reads);
        await done;
        for (let i = 0; i < meta.stores.length; i++) {
          const [count, sample] = samples[i];
          const wire = JSON.stringify(await codec.encode(sample));
          meta.stores[i].count = count;
          meta.stores[i].bytes = sample.length ? Math.round(new TextEncoder().encode(wire).length / sample.length * count) : 0;
        }
        meta.records = meta.stores.reduce((sum, store) => sum + store.count, 0);
        meta.bytes = meta.stores.reduce((sum, store) => sum + store.bytes, 0);
        meta.estimated = true;
        databases.push(meta);
      } finally { db.close(); }
    }
    return databases;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function checkSchema(source, target) {
    for (const store of source.stores) {
      const existing = target.stores.find(item => item.name === store.name);
      if (!existing) continue;
      if (!same(store.keyPath, existing.keyPath)) throw new Error(`INDEXED_DB_WRITE_FAILED: 已有对象仓库结构不兼容：${store.name} keyPath (${JSON.stringify(store.keyPath)} / ${JSON.stringify(existing.keyPath)})。请选择 Replace Database。`);
      if (store.autoIncrement !== existing.autoIncrement) throw new Error('INDEXED_DB_WRITE_FAILED: 已有对象仓库 autoIncrement 不兼容，请选择 Replace Database。');
      for (const index of store.indexes) {
        const other = existing.indexes.find(item => item.name === index.name);
        if (other && (!same(index.keyPath, other.keyPath) || index.unique !== other.unique || index.multiEntry !== other.multiEntry)) throw new Error('INDEXED_DB_WRITE_FAILED: 已有索引结构不兼容，请选择 Replace Database。');
      }
    }
  }
  async function ensureDatabase(meta, mode, confirmed) {
    let existing = (await indexedDB.databases()).find(db => db.name === meta.name);
    if (mode === 'replace') {
      if (!confirmed) throw new Error('CONFIRMATION_REQUIRED: 替换数据库需要确认。');
      if (existing) {
        // A blocked deletion remains pending in the browser. Keep waiting, do not
        // report cancellation or retry deletion while it is still pending.
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(meta.name);
          request.onsuccess = resolve;
          request.onerror = () => reject(request.error);
          request.onblocked = () => {
            if (typeof chrome !== 'undefined') chrome.runtime.sendMessage({ kind: 'DB_BLOCKED' }).catch(() => {});
          };
        });
        existing = undefined;
      }
    } else if (existing && mode === 'cancel') throw new Error('INDEXED_DB_WRITE_FAILED: 目标已存在数据库，Cancel 策略已跳过。');

    let needsUpgrade = !existing;
    if (existing) {
      const db = await openDatabase(meta.name, existing.version);
      try {
        if (db.objectStoreNames.length) {
          const tx = db.transaction([...db.objectStoreNames], 'readonly');
          const current = schema(db, tx);
          checkSchema(meta, current);
          needsUpgrade = meta.stores.some(store => !current.stores.some(item => item.name === store.name) || store.indexes.some(index => !current.stores.find(item => item.name === store.name).indexes.some(item => item.name === index.name)));
        } else needsUpgrade = meta.stores.length > 0;
        needsUpgrade ||= existing.version < meta.version;
      } finally { db.close(); }
    }
    const version = !existing ? meta.version : needsUpgrade ? Math.max(meta.version, existing.version + 1) : existing.version;
    const db = await openDatabase(meta.name, version, (database, tx) => {
      for (const store of meta.stores) {
        const objectStore = database.objectStoreNames.contains(store.name) ? tx.objectStore(store.name) : database.createObjectStore(store.name, { keyPath: store.keyPath, autoIncrement: store.autoIncrement });
        for (const index of store.indexes) if (!objectStore.indexNames.contains(index.name)) objectStore.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      }
    });
    db.close();
    return { version };
  }
  async function readBatch(args) {
    const db = await openDatabase(args.database, args.version);
    let records;
    try {
      const tx = db.transaction(args.store, 'readonly');
      const done = transactionDone(tx);
      const range = args.after ? IDBKeyRange.lowerBound(codec.decode(args.after), true) : undefined;
      const store = tx.objectStore(args.store);
      const values = requestValue(store.getAll(range, args.limit || 500));
      const keys = requestValue(store.getAllKeys(range, args.limit || 500));
      const [items, primaryKeys] = await Promise.all([values, keys]);
      await done;
      records = items.map((value, index) => ({ key: primaryKeys[index], value }));
    } finally { db.close(); }
    const text = JSON.stringify(await codec.encode(records));
    const token = crypto.randomUUID();
    trackTransfer(token, { text, createdAt: Date.now() });
    return { token, chunks: Math.ceil(text.length / CHUNK_SIZE), bytes: new TextEncoder().encode(text).length, count: records.length, after: records.length ? await codec.encode(records.at(-1).key) : null };
  }
  async function writeBatch(args) {
    const transfer = transfers.get(args.token);
    if (!transfer?.parts) throw new Error('INVALID_PAYLOAD: 传输批次已失效。');
    transfers.delete(args.token);
    const original = transfer.parts.join('');
    const records = codec.decode(JSON.parse(original));
    const db = await openDatabase(args.database, args.version);
    try {
      const tx = db.transaction(args.store, 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore(args.store);
      try {
        for (const record of records) {
          if (store.keyPath === null) store.put(record.value, record.key);
          else store.put(record.value);
        }
      } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
      await done;
      const verifyTx = db.transaction(args.store, 'readonly');
      const verifyDone = transactionDone(verifyTx);
      const verification = records.map(record => requestValue(verifyTx.objectStore(args.store).get(record.key)));
      const values = await Promise.all(verification);
      await verifyDone;
      const verified = records.map((record, index) => ({ key: record.key, value: values[index] }));
      if (JSON.stringify(await codec.encode(verified)) !== original) throw new Error('VERIFY_FAILED: IndexedDB 写入后的记录内容与源数据不同。');
      return { count: records.length, verified: true };
    } finally { db.close(); }
  }
  async function execute(command, args) {
    if (location.origin !== args.origin) throw new Error('INVALID_ORIGIN: 标签页已导航，请重新预览。');
    for (const [token, item] of transfers) if (Date.now() - item.createdAt > 120000) transfers.delete(token);
    switch (command) {
      case 'ping': return true;
      case 'storageRead': {
        const store = args.type === 'localStorage' ? localStorage : sessionStorage;
        return Array.from({ length: store.length }, (_, index) => store.key(index)).filter(key => key !== null).map(key => ({ key, value: store.getItem(key) }));
      }
      case 'storageWrite': {
        const store = args.type === 'localStorage' ? localStorage : sessionStorage;
        if (args.mode === 'clear' && !args.confirmed) throw new Error('CONFIRMATION_REQUIRED: 清空存储需要确认。');
        // Web Storage has no transactions. Best-effort restore if quota/security fails.
        const before = Array.from({ length: store.length }, (_, index) => store.key(index)).map(key => ({ key, value: store.getItem(key) }));
        try {
          if (args.mode === 'clear') store.clear();
          for (const item of args.items) store.setItem(item.key, item.value);
          if (args.items.some(item => store.getItem(item.key) !== item.value)) throw new Error('VERIFY_FAILED: Storage 校验未通过。');
          if (args.mode === 'clear' && store.length !== args.items.length) throw new Error('VERIFY_FAILED: 清空后项目数不一致。');
        } catch (error) {
          try { store.clear(); for (const item of before) store.setItem(item.key, item.value); } catch { throw new Error('STORAGE_WRITE_FAILED: 写入失败且恢复未完成，请检查目标存储。'); }
          throw new Error(`STORAGE_WRITE_FAILED: 写入失败，已恢复原存储（${error.name}）。`);
        }
        return { count: args.items.length, verified: true };
      }
      case 'storageRestore': {
        const store = args.type === 'localStorage' ? localStorage : sessionStorage;
        const before = Array.from({ length: store.length }, (_, index) => store.key(index)).map(key => ({ key, value: store.getItem(key) }));
        try {
          if (args.mode === 'clear') {
            if (!args.confirmed) throw new Error('CONFIRMATION_REQUIRED: 恢复清空前的存储需要确认。');
            store.clear();
          } else for (const key of args.keys) store.removeItem(key);
          for (const item of args.items) store.setItem(item.key, item.value);
          if (args.items.some(item => store.getItem(item.key) !== item.value) ||
            args.mode === 'clear' && store.length !== args.items.length ||
            args.mode !== 'clear' && args.keys.some(key => !args.items.some(item => item.key === key) && store.getItem(key) !== null)) throw new Error('VERIFY_FAILED: Storage 恢复校验失败。');
        } catch (error) {
          try { store.clear(); for (const item of before) store.setItem(item.key, item.value); }
          catch { throw new Error('STORAGE_WRITE_FAILED: 撤销失败且恢复未完成，请检查目标存储。'); }
          throw error;
        }
        return { count: args.mode === 'clear' ? args.items.length : args.keys.length, verified: true };
      }
      case 'idbList': return listDatabases();
      case 'idbDrop': {
        if (!args.confirmed) throw new Error('CONFIRMATION_REQUIRED: 撤销新建数据库需要确认。');
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(args.database);
          request.onsuccess = resolve; request.onerror = () => reject(request.error);
          request.onblocked = () => { if (typeof chrome !== 'undefined') chrome.runtime.sendMessage({ kind: 'DB_BLOCKED' }).catch(() => {}); };
        });
        return true;
      }
      case 'idbGeneratorRead': {
        const db = await openDatabase(args.database, args.version);
        try {
          const tx = db.transaction(args.store, 'readwrite');
          const done = transactionDone(tx).catch(() => {});
          // Observe the next key in an aborted transaction; no probe record or
          // key-generator change is committed to the target database.
          try { const key = await requestValue(tx.objectStore(args.store).add({})); tx.abort(); await done; return key; }
          catch (error) { try { tx.abort(); } catch {} await done; if (error.name === 'ConstraintError') return 'exhausted'; throw error; }
        } finally { db.close(); }
      }
      case 'idbGeneratorRestore': {
        const db = await openDatabase(args.database, args.version);
        try {
          const tx = db.transaction(args.store, 'readwrite'), done = transactionDone(tx), store = tx.objectStore(args.store);
          const key = args.nextKey === 'exhausted' ? 2 ** 53 : args.nextKey - 1;
          if (key >= 1) {
            const exists = await requestValue(store.count(key));
            if (!exists) {
              const value = {};
              if (store.keyPath === null) store.put(value, key);
              else {
                const parts = store.keyPath.split('.'); let current = value;
                for (const part of parts.slice(0, -1)) { Object.defineProperty(current, part, { value: {}, enumerable: true }); current = current[part]; }
                Object.defineProperty(current, parts.at(-1), { value: key, enumerable: true }); store.put(value);
              }
              store.delete(key);
            }
          }
          await done; return true;
        } finally { db.close(); }
      }
      case 'idbEnsure': return ensureDatabase(args.meta, args.mode, args.confirmed);
      case 'idbRead': return readBatch(args);
      case 'transferRead': {
        const transfer = transfers.get(args.token);
        if (!transfer?.text) throw new Error('INVALID_PAYLOAD: 源批次已失效。');
        transfer.createdAt = Date.now();
        // A Chromium string result crosses UTF-8 serialization. Never split a
        // surrogate pair (e.g. an emoji), or that boundary could be replaced.
        const boundary = index => {
          let offset = Math.min(index * CHUNK_SIZE, transfer.text.length);
          const before = transfer.text.charCodeAt(offset - 1), after = transfer.text.charCodeAt(offset);
          if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) offset++;
          return offset;
        };
        return transfer.text.slice(boundary(args.index), boundary(args.index + 1));
      }
      case 'transferAppend': {
        let transfer = transfers.get(args.token);
        if (!transfer) { transfer = { parts: [], createdAt: Date.now() }; trackTransfer(args.token, transfer); }
        transfer.parts.push(args.chunk); transfer.createdAt = Date.now(); return true;
      }
      case 'transferDrop': transfers.delete(args.token); return true;
      case 'idbWrite': return writeBatch(args);
      default: throw new Error('UNKNOWN_ERROR: 不支持的页面操作。');
    }
  }
  globalThis.__envBridgeAdapterVersion = '1.1.0';
  globalThis.__envBridgePageV1 = async (command, args) => {
    try { return { ok: true, data: await execute(command, args) }; }
    catch (error) {
      // Never forward platform exception messages that may embed record values.
      const message = /^[A-Z_]+:/.test(error.message) ? error.message : `PAGE_OPERATION_FAILED: ${error.name || 'Error'}；请检查页面权限、数据库结构或存储配额。`;
      return { ok: false, error: message };
    }
  };
})();
