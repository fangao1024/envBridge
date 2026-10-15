import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionHistory, HISTORY_KEY, historyBytes } from '../src/core/history.js';
import { undoCookie } from '../src/core/history-operations.js';

const storage = () => {
  let data = {}; return { get:async key=>({[key]:structuredClone(data[key])}),
    set:async patch=>{data={...data,...structuredClone(patch)};}, remove:async key=>{delete data[key];} };
};
const record = id => ({id,createdAt:Date.now(),source:'https://source.test',target:{origin:'https://target.test',tabId:2},
  types:['cookies'],status:'success',undoStatus:'available',touched:['cookie'],restored:[],before:{secret:'before-value'}});

test('history survives manager recreation, returns metadata only, and enforces reverse undo order', async () => {
  const memory=storage(), first=new SessionHistory(memory);
  await first.add(record('a'));await first.add(record('b'));
  const reopened=new SessionHistory(memory), list=await reopened.list();
  assert.deepEqual(list.map(item=>[item.id,item.canUndo]),[['b',true],['a',false]]);
  assert(!JSON.stringify(list).includes('before-value'));assert(!JSON.stringify(list).includes('secret'));
  await assert.rejects(reopened.latest('a'),/UNDO_ORDER_REQUIRED/);
  await reopened.update('b',{undoStatus:'undone',before:null});assert.equal((await reopened.latest('a')).id,'a');
  await reopened.clear();assert.deepEqual(await reopened.list(),[]);assert.equal((await memory.get(HISTORY_KEY))[HISTORY_KEY],undefined);
});
test('oversized backups fail before replacing history, while old entries are evicted within bounds', async () => {
  const memory=storage(), store=new SessionHistory(memory,{maxEntries:2,maxBytes:3000});
  await store.add(record('a'));await store.add(record('b'));await store.add(record('c'));
  assert.deepEqual((await store.list()).map(item=>item.id),['c','b']);
  const large=record('too-large');large.before.secret='x'.repeat(3000);
  await assert.rejects(store.add(large),/HISTORY_QUOTA/);assert.deepEqual((await store.list()).map(item=>item.id),['c','b']);
  assert(historyBytes(await store.records())<=3000);
  const limited=new SessionHistory(storage(),{maxBytes:historyBytes([record('a')])+100});
  await limited.add(record('a'));await limited.add(record('b'));assert.equal((await limited.list()).length,1);
});
test('unfinished and no-change records cannot be undone; interrupted changes retain their backup', async () => {
  const store=new SessionHistory(storage());
  const empty=record('empty');empty.touched=[];await store.add(empty);assert.equal((await store.list())[0].canUndo,false);
  const running=record('running');running.status='running';await store.add(running);assert.equal((await store.list())[0].canUndo,false);
  await store.update('running',{status:'interrupted'});assert.equal((await store.list())[0].canUndo,true);
  assert.equal((await store.get('running')).before.secret,'before-value');
  await store.update('running',{undoStatus:'undoing'});assert.equal((await store.list())[0].canUndo,false);
});
test('undo refuses an ambiguous added-cookie deletion without touching another scope', async () => {
  const expected={name:'token',value:'new',domain:'.dev.com',hostOnly:false,path:'/',secure:false,httpOnly:true,sameSite:'lax'};
  let removed=false;
  const api={permissions:{contains:async()=>true},cookies:{getAll:async()=>[expected],
    get:async()=>({...expected,domain:'dev.com',hostOnly:true,value:'unrelated'}),remove:async()=>{removed=true;}}};
  await assert.rejects(undoCookie({next:expected,original:null},{origin:'https://www.dev.com',storeId:'0'},api),/COOKIE_REMOVE_AMBIGUOUS/);
  assert.equal(removed,false);
});
