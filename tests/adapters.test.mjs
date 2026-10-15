import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import '../src/core/codec.js';
globalThis.location = { origin: 'https://source.test' };
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { const timer = originalTimeout(...args); timer.unref(); return timer; };
class MemoryStorage {
  constructor(items = []) { this.items = new Map(items); this.failOnce = false; }
  get length() { return this.items.size; }
  key(index) { return [...this.items.keys()][index] ?? null; }
  getItem(key) { return this.items.get(key) ?? null; }
  removeItem(key) { this.items.delete(key); }
  setItem(key, value) { if (this.failOnce) { this.failOnce = false; throw new DOMException('test', 'QuotaExceededError'); } this.items.set(key, String(value)); }
  clear() { this.items.clear(); }
}
globalThis.localStorage = new MemoryStorage(); globalThis.sessionStorage = new MemoryStorage();
await import('../src/adapters/page.js');
const call = async (command, args = {}) => {
  const result = await globalThis.__envBridgePageV1(command, { origin: location.origin, ...args });
  if (!result.ok) throw new Error(result.error); return result.data;
};
const open = (name, version, upgrade) => new Promise((resolve, reject) => {
  const request = indexedDB.open(name, version); request.onupgradeneeded = () => upgrade?.(request.result, request.transaction); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const transactionDone = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
test('storage merge, confirmed clear, rollback on quota failure and origin guard', async () => {
  globalThis.localStorage = new MemoryStorage([['extra','keep'],['same','old']]);
  await call('storageWrite', { type: 'localStorage', items: [{ key:'same', value:'new' }], mode:'merge' });
  assert.equal(localStorage.getItem('extra'), 'keep'); assert.equal(localStorage.getItem('same'), 'new');
  await assert.rejects(call('storageWrite', { type:'localStorage', items:[], mode:'clear' }), /CONFIRMATION_REQUIRED/);
  localStorage.failOnce = true;
  await assert.rejects(call('storageWrite', { type:'localStorage', items:[{key:'same',value:'x'}], mode:'clear', confirmed:true }), /已恢复原存储/);
  assert.equal(localStorage.getItem('extra'), 'keep'); assert.equal(localStorage.getItem('same'), 'new');
  await call('storageWrite', { type:'localStorage', items:[], mode:'clear', confirmed:true }); assert.equal(localStorage.length, 0);
  const guard = await __envBridgePageV1('storageRead', { type:'localStorage', origin:'https://wrong.test' }); assert.equal(guard.ok, false);
});
test('undo patches affected storage keys while preserving unrelated keys and restores cleared storage', async () => {
  globalThis.localStorage=new MemoryStorage([['same','new'],['added','new'],['unrelated','keep']]);
  await call('storageRestore',{type:'localStorage',mode:'patch',keys:['same','added'],items:[{key:'same',value:'old'}]});
  assert.equal(localStorage.getItem('same'),'old');assert.equal(localStorage.getItem('added'),null);assert.equal(localStorage.getItem('unrelated'),'keep');
  localStorage.failOnce=true;
  await assert.rejects(call('storageRestore',{type:'localStorage',mode:'patch',keys:['same'],items:[{key:'same',value:'changed'}]}));
  assert.equal(localStorage.getItem('same'),'old');assert.equal(localStorage.getItem('unrelated'),'keep');
  await call('storageRestore',{type:'localStorage',mode:'clear',confirmed:true,keys:[],items:[{key:'original',value:'before-clear'}]});
  assert.equal(localStorage.length,1);assert.equal(localStorage.getItem('original'),'before-clear');
});
test('auto-increment backup probe aborts and restoration retains a generator beyond surviving keys', async () => {
  const name='generator-history';let db=await open(name,1,database=>database.createObjectStore('items',{keyPath:'nested.id',autoIncrement:true}));
  let tx=db.transaction('items','readwrite'),done=transactionDone(tx);tx.objectStore('items').put({nested:{id:100},keep:'old'});tx.objectStore('items').delete(100);await done;db.close();
  assert.equal(await call('idbGeneratorRead',{database:name,version:1,store:'items'}),101);
  assert.equal(await call('idbGeneratorRead',{database:name,version:1,store:'items'}),101);
  await call('idbDrop',{database:name,confirmed:true});
  await call('idbEnsure',{meta:{name,version:1,stores:[{name:'items',keyPath:'nested.id',autoIncrement:true,indexes:[]}]},mode:'merge'});
  await call('idbGeneratorRestore',{database:name,version:1,store:'items',nextKey:101});
  const meta=(await call('idbList')).find(item=>item.name===name);assert.equal(meta.records,0);
  db=await open(name,1);tx=db.transaction('items','readwrite');done=transactionDone(tx);
  const request=tx.objectStore('items').add({restored:true});const key=await new Promise(resolve=>request.onsuccess=()=>resolve(request.result));await done;db.close();
  assert.equal(key,101);
});
test('IndexedDB complete schema, binary keys, 1201 records, typed values and exact replacement', async () => {
  const sourceFactory = new IDBFactory(); globalThis.indexedDB = sourceFactory;
  let db = await open('app', 4, database => {
    const users = database.createObjectStore('users', { keyPath:'id', autoIncrement:true }); users.createIndex('email', 'email', { unique:true }); users.createIndex('tags', 'tags', { multiEntry:true });
    database.createObjectStore('binary', { keyPath:null });
  });
  const tx = db.transaction(['users','binary'],'readwrite'); const done = transactionDone(tx);
  for(let id=1;id<=1201;id++)tx.objectStore('users').put({id,email:`test-${id}@example.test`,tags:['a','b'],when:new Date(1000*id),big:BigInt(id),bytes:new Uint8Array([id%256]),map:new Map([['a',new Set([id])]])});
  tx.objectStore('binary').put(new Blob(['hello'],{type:'text/plain'}),new Uint8Array([1,2]).buffer); await done; db.close();
  const [meta] = await call('idbList'); assert.equal(meta.version,4); assert.equal(meta.records,1202); assert.equal(meta.stores[0].keyPath,null);
  const targetFactory = new IDBFactory(); globalThis.indexedDB = targetFactory;
  await call('idbEnsure',{meta,mode:'merge'});
  for(const store of meta.stores){
    let after=null;
    while(true){
      globalThis.indexedDB=sourceFactory; const batch=await call('idbRead',{database:'app',version:4,store:store.name,after,limit:500});
      if(!batch.count){await call('transferDrop',{token:batch.token});break;}
      const token=crypto.randomUUID();
      for(let index=0;index<batch.chunks;index++){
        globalThis.indexedDB=sourceFactory;const chunk=await call('transferRead',{token:batch.token,index});
        globalThis.indexedDB=targetFactory;await call('transferAppend',{token,chunk});
      }
      const result=await call('idbWrite',{token,database:'app',version:4,store:store.name});assert.equal(result.count,batch.count);assert(result.verified);
      await call('transferDrop',{token:batch.token});after=batch.after;if(batch.count<500)break;
    }
  }
  globalThis.indexedDB=targetFactory;
  const [actual]=await call('idbList'); assert.equal(actual.records,1202);assert.equal(actual.version,4);assert.deepEqual(actual.stores.map(s=>s.indexes),meta.stores.map(s=>s.indexes));
  const incompatible=structuredClone(meta);incompatible.stores.find(s=>s.name==='users').keyPath=null;
  await assert.rejects(call('idbEnsure',{meta:incompatible,mode:'merge'}),/结构不兼容/);
  await assert.rejects(call('idbEnsure',{meta,mode:'cancel'}),/Cancel/);
  await assert.rejects(call('idbEnsure',{meta,mode:'replace'}),/CONFIRMATION_REQUIRED/);
  const versioned=structuredClone(meta);versioned.version=2;
  await call('idbEnsure',{meta:versioned,mode:'replace',confirmed:true});
  const [replaced]=await call('idbList');assert.equal(replaced.version,2);assert.equal(replaced.records,0);
});
test('unique-index write failures roll back an entire IndexedDB batch', async () => {
  globalThis.indexedDB=new IDBFactory();
  const meta={name:'unique',version:1,stores:[{name:'users',keyPath:'id',autoIncrement:false,indexes:[{name:'email',keyPath:'email',unique:true,multiEntry:false}]}]};
  await call('idbEnsure',{meta,mode:'merge'});
  const records=[{key:1,value:{id:1,email:'same'}},{key:2,value:{id:2,email:'same'}}];
  const wire=JSON.stringify(await EnvBridgeCodec().encode(records));
  await call('transferAppend',{token:'constraint',chunk:wire});
  await assert.rejects(call('idbWrite',{token:'constraint',database:'unique',version:1,store:'users'}));
  const [database]=await call('idbList');assert.equal(database.records,0);
});
test('large Unicode records cross transport boundaries without splitting surrogate pairs', async () => {
  globalThis.indexedDB=new IDBFactory();
  const codec=EnvBridgeCodec();let value='🙂'.repeat(300000);
  const initial=JSON.stringify(await codec.encode([{key:'unicode',value}]));
  if(initial.indexOf('🙂')%2===0)value='x'+value; // Force an emoji across a naive 512Ki boundary.
  const db=await open('unicode',1,database=>database.createObjectStore('records'));
  const tx=db.transaction('records','readwrite'),done=transactionDone(tx);tx.objectStore('records').put(value,'unicode');await done;db.close();
  const batch=await call('idbRead',{database:'unicode',version:1,store:'records'});assert(batch.chunks>1);
  const parts=[];
  for(let index=0;index<batch.chunks;index++){
    const chunk=await call('transferRead',{token:batch.token,index});
    const first=chunk.charCodeAt(0),last=chunk.charCodeAt(chunk.length-1);
    assert(!(first>=0xdc00&&first<=0xdfff));assert(!(last>=0xd800&&last<=0xdbff));parts.push(chunk);
  }
  assert.equal(codec.decode(JSON.parse(parts.join('')))[0].value,value);
  await call('transferDrop',{token:batch.token});
});
