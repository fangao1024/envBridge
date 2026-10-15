const role = new URLSearchParams(location.search).get('role') || 'source';
document.querySelector('#origin').textContent = `${role.toUpperCase()} · ${location.origin}`;
const request = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const completed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
let held;
window.seed = async (which = role, count = 1201) => {
  held?.close();
  for (const db of await indexedDB.databases()) await request(indexedDB.deleteDatabase(db.name));
  localStorage.clear(); sessionStorage.clear();
  if (which === 'source') {
    localStorage.setItem('token', 'fixture-local-token'); localStorage.setItem('theme', 'forest'); localStorage.setItem('userInfo', JSON.stringify({ id: 42, name: 'Test User' }));
    sessionStorage.setItem('draft', 'fixture-session-draft'); sessionStorage.setItem('tabName', 'source-tab');
    await fetch('/seed-cookies');
  } else {
    localStorage.setItem('token', 'target-old-token'); localStorage.setItem('targetOnly', 'keep-on-merge'); sessionStorage.setItem('targetOnlySession', 'keep-on-merge');
    document.cookie = 'target_only_cookie=keep; Path=/';
  }
  const opening = indexedDB.open('fixture_app', which === 'source' ? 4 : 2);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    const users = db.createObjectStore('users', { keyPath: 'id', autoIncrement: true }); users.createIndex('email', 'email', { unique: true }); users.createIndex('tags', 'tags', { multiEntry: true });
    db.createObjectStore('binary');
    db.createObjectStore('compound', { keyPath: ['project', 'id'] });
    if (which !== 'source') db.createObjectStore('targetOnly');
  };
  const db = await request(opening);
  const tx = db.transaction([...db.objectStoreNames], 'readwrite'); const done = completed(tx);
  if (which === 'source') {
    for (let id = 1; id <= count; id++) {
      const shared = { id }; const value = { id, email: `fixture-${id}@example.test`, tags:['test', 'envbridge'], when:new Date(id * 1000), bytes:new Uint8Array([id%256,42]), big:BigInt(id), map:new Map([['tag', new Set([id])]]), sharedA:shared, sharedB:shared };
      value.self = value; tx.objectStore('users').put(value);
    }
    tx.objectStore('binary').put(new Blob(['fixture-blob'], { type: 'text/plain' }), new Uint8Array([1,2,3]).buffer);
    tx.objectStore('binary').put(new File(['fixture-file'], 'fixture.txt', { lastModified:1234 }), 'file');
    tx.objectStore('compound').put({ project:'envbridge',id:1,title:'🙂'.repeat(300000) });
  } else {
    tx.objectStore('users').put({ id:99999,email:'target-only@example.test' }); tx.objectStore('targetOnly').put('target-only-record', 'keep');
  }
  await done; db.close(); return window.inspect();
};
window.inspect = async () => {
  const databases=[];
  for(const info of await indexedDB.databases()) {
    const db=await request(indexedDB.open(info.name)); const stores=[];
    for(const name of db.objectStoreNames) { const tx=db.transaction(name); const store=tx.objectStore(name); const count=await request(store.count()); stores.push({name,count,keyPath:store.keyPath,indexes:[...store.indexNames]}); }
    databases.push({name:info.name,version:info.version,stores});db.close();
  }
  const data={origin:location.origin,localKeys:Object.keys(localStorage),sessionKeys:Object.keys(sessionStorage),databases};
  document.querySelector('#output').textContent=JSON.stringify(data,null,2);return data;
};
document.querySelector('#seed').onclick = () => window.seed().catch(error => document.querySelector('#output').textContent = error.message);
document.querySelector('#inspect').onclick = () => window.inspect();
document.querySelector('#hold').onclick = async () => { held=await request(indexedDB.open('fixture_app')); document.querySelector('#output').textContent='数据库连接已占用。释放后可继续替换。'; };
document.querySelector('#release').onclick = () => { held?.close();held=undefined;window.inspect(); };
