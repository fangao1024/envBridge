import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cookiePermissionPatterns } from '../src/core/cookie-permissions.js';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
const { chromium } = await import('playwright');
const channel=process.argv.includes('--edge')?'msedge':'chromium';
const sourceOrigin='https://www.51miz.com',targetOrigin='https://www.dev.com',localOrigin='http://localhost:39997';
const taskRoot=await mkdtemp(join(tmpdir(),'envbridge-history-'));
let context;
const reports=[];
try {
  const extensionRoot=join(taskRoot,'extension');await mkdir(extensionRoot,{recursive:true});
  for(const name of ['src','assets','popup.html','privacy.html'])await cp(resolve(name),join(extensionRoot,name),{recursive:true});
  const manifest=JSON.parse(await readFile('manifest.json','utf8'));
  manifest.host_permissions=[...new Set([sourceOrigin,targetOrigin,localOrigin].flatMap(cookiePermissionPatterns))];
  await writeFile(join(extensionRoot,'manifest.json'),JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(join(taskRoot,'profile'),{headless:true,channel,args:[`--disable-extensions-except=${extensionRoot}`,`--load-extension=${extensionRoot}`]});
  for(const origin of [sourceOrigin,targetOrigin,localOrigin])await context.route(`${origin}/**`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated undo fixture</title>'}));
  const source=await context.newPage();await source.goto(sourceOrigin);
  const target=await context.newPage();await target.goto(targetOrigin);
  const local=await context.newPage();await local.goto(localOrigin);
  const cdp=await context.newCDPSession(source);
  await cdp.send('Network.setCookies',{cookies:[
    {name:'parent_token',value:'source-cookie',domain:'.51miz.com',path:'/api',secure:true,httpOnly:true,sameSite:'Lax'},
    {name:'host_token',value:'source-host-cookie',url:sourceOrigin,secure:true,sameSite:'Lax'},
    {name:'added_cookie',value:'source-new-cookie',domain:'.51miz.com',path:'/',secure:true,sameSite:'Lax'},
    {name:'parent_token',value:'original-cookie',domain:'.dev.com',path:'/api',secure:true,httpOnly:true,sameSite:'Strict'},
    {name:'unrelated_cookie',value:'keep-cookie',domain:'.dev.com',path:'/',secure:true,sameSite:'Lax'}
  ]});
  const seed=async(page,isSource)=>page.evaluate(async isSource=>{
    localStorage.setItem('token',isSource?'source-storage':'original-storage');
    sessionStorage.setItem('token',isSource?'source-session':'original-session');
    localStorage.setItem(isSource?'added':'keep',isSource?'source-added':'keep-original');
    sessionStorage.setItem(isSource?'added':'keepSession',isSource?'source-added':'keep-session');
    const open=(name,version,upgrade)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,version);r.onupgradeneeded=()=>upgrade(r.result);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const db=await open('undo_app',isSource?5:3,database=>{
      const items=database.createObjectStore('items',{keyPath:'id',autoIncrement:true});items.createIndex('email','email',{unique:true});
      database.createObjectStore(isSource?'newStore':'originalStore',{keyPath:null});
    });
    let tx=db.transaction([...db.objectStoreNames],'readwrite');const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    const rich={id:1,email:'old@example.test',name:isSource?'source-record':'original-record',when:new Date('2026-01-02'),bytes:new Uint8Array([7,8]),blob:new Blob(['original-blob']),map:new Map([['key',new Set([3])]])};rich.self=rich;
    tx.objectStore('items').put(rich);
    if(!isSource){tx.objectStore('items').put({id:200,email:'deleted@example.test'});tx.objectStore('items').delete(200);tx.objectStore('originalStore').put('keep-original-store','key');}
    else for(let id=2;id<=503;id++)tx.objectStore('items').put({id,email:`fixture-${id}@example.test`,name:'source-record'});
    await done;db.close();
    if(isSource){const extra=await open('source_only',2,database=>database.createObjectStore('items'));tx=extra.transaction('items','readwrite');const finished=new Promise(resolve=>tx.oncomplete=resolve);tx.objectStore('items').put('new-database','key');await finished;extra.close();}
    globalThis.inspectUndo=async()=>{
      const databases=[];
      for(const meta of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){
        const opening=indexedDB.open(meta.name);const db=await new Promise(resolve=>opening.onsuccess=()=>resolve(opening.result));
        const stores=[];
        for(const name of db.objectStoreNames){const store=db.transaction(name).objectStore(name);const count=store.count();stores.push({name,keyPath:store.keyPath,autoIncrement:store.autoIncrement,indexes:[...store.indexNames],count:await new Promise(resolve=>count.onsuccess=()=>resolve(count.result))});}
        let record=null;
        if(db.objectStoreNames.contains('items')){const r=db.transaction('items').objectStore('items').get(1);const item=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result));if(item?.name)record={name:item.name,date:item.when.toISOString(),bytes:[...item.bytes],blob:await item.blob.text(),map:[...item.map.get('key')],cycle:item.self===item};}
        databases.push({name:db.name,version:db.version,stores,record});db.close();
      }
      const pairs=store=>Object.keys(store).sort().map(key=>[key,store.getItem(key)]);
      return {local:pairs(localStorage),session:pairs(sessionStorage),databases};
    };
  },isSource);
  await seed(source,true);await seed(target,false);
  const original=await target.evaluate(()=>inspectUndo());
  const originalCookies=(await cdp.send('Network.getCookies',{urls:[`${targetOrigin}/api/test`]})).cookies;
  let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const extensionId=new URL(worker.url()).host;
  let ui=await context.newPage();const errors=[];ui.on('pageerror',error=>errors.push(error.message));
  await ui.goto(`chrome-extension://${extensionId}/popup.html?workspace=1`);
  const rpc=(kind,args={})=>ui.evaluate(async({kind,args})=>{const r=await chrome.runtime.sendMessage({kind,...args});if(!r?.ok)throw new Error(r?.error);return r.data;},{kind,args});
  const tabs=await rpc('TABS'),sourceTab=tabs.find(tab=>tab.origin===sourceOrigin),targetTab=tabs.find(tab=>tab.origin===targetOrigin),localTab=tabs.find(tab=>tab.origin===localOrigin);
  const config={cookieMode:'rewrite',storageMode:'merge',indexedDBMode:'merge',reload:false,preview:true};
  const env={source:{origin:sourceOrigin,tabId:sourceTab.id},target:{origin:targetOrigin,tabId:targetTab.id}};
  const waitJob=async()=>{for(let i=0;i<400;i++){const job=await rpc('JOB');if(job?.status!=='running'){for(let j=0;j<100;j++){const h=await rpc('HISTORY');if(!h.some(r=>r.status==='running'||r.undoStatus==='undoing'))return job;await new Promise(resolve=>setTimeout(resolve,30));}return job;}await new Promise(resolve=>setTimeout(resolve,60));}throw new Error('Job timed out.');};
  const clone=async(types,cfg=config)=>{const p=await rpc('PREVIEW',{...env,types,config:cfg});assert.deepEqual(p.readErrors,{});const selections=Object.fromEntries(p.types.map(type=>[type,p.rows[type].filter(row=>row.status!=='remove').map(row=>row.id)]));await rpc('CLONE',{previewId:p.id,selections,confirmed:true});return waitJob();};
  const migrated=await clone({cookies:true,localStorage:true,sessionStorage:true,indexedDB:true});assert.equal(migrated.status,'success',JSON.stringify(migrated));
  const after=(await cdp.send('Network.getCookies',{urls:[`${targetOrigin}/api/test`]})).cookies;
  assert.equal(after.find(c=>c.name==='parent_token').domain,'.dev.com');assert.equal(after.find(c=>c.name==='host_token').domain,'www.dev.com');
  assert.equal(after.find(c=>c.name==='parent_token').value,'source-cookie');
  let history=await rpc('HISTORY');assert.equal(history.length,1);assert(history[0].canUndo);assert(!JSON.stringify(history).includes('original-cookie'));assert(!JSON.stringify(history).includes('original-storage'));
  assert(!JSON.stringify(await worker.evaluate(()=>chrome.storage.local.get(null))).includes('original-storage'));
  // Closing the UI and terminating the isolated extension worker must retain session snapshots.
  await ui.close();await cdp.send('ServiceWorker.enable');await cdp.send('ServiceWorker.stopAllWorkers');
  ui=await context.newPage();ui.on('pageerror',error=>errors.push(error.message));await ui.goto(`chrome-extension://${extensionId}/popup.html?workspace=1`);
  await ui.click('.nav [data-view=history]');await ui.waitForSelector('.undo-history:not([disabled])');
  await ui.screenshot({path:`artifacts/${channel}-history.png`,fullPage:true});
  await ui.click('.undo-history');await ui.click('#confirm-dialog button[value=confirm]');
  for(let tries=0;tries<100;tries++) {
    if((await rpc('JOB'))?.kind==='undo')break;
    const notice=await ui.locator('#notice').evaluate(node=>node.classList.contains('error')&&!node.hidden?node.textContent:'');
    if(notice)throw new Error(`Undo button failed: ${notice}`);
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const undone=await waitJob();assert.equal(undone.kind,'undo');assert.equal(undone.status,'success',JSON.stringify(undone));
  assert.deepEqual(await target.evaluate(()=>inspectUndo()),original);
  const restored=(await cdp.send('Network.getCookies',{urls:[`${targetOrigin}/api/test`]})).cookies;
  const cookieView=c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,secure:c.secure,httpOnly:c.httpOnly,sameSite:c.sameSite});
  assert.deepEqual(restored.map(cookieView).sort((a,b)=>a.name.localeCompare(b.name)),originalCookies.map(cookieView).sort((a,b)=>a.name.localeCompare(b.name)));
  assert.equal((await rpc('HISTORY'))[0].undoStatus,'undone');
  const nextKey=await target.evaluate(async()=>{const open=indexedDB.open('undo_app');const db=await new Promise(resolve=>open.onsuccess=()=>resolve(open.result));const tx=db.transaction('items','readwrite');const done=new Promise(resolve=>tx.oncomplete=resolve);const r=tx.objectStore('items').add({email:'probe-after-undo@example.test'});const key=await new Promise(resolve=>r.onsuccess=()=>resolve(r.result));tx.objectStore('items').delete(key);await done;db.close();return key;});assert.equal(nextKey,201);
  reports.push({test:'parent-domain-and-all-types-undo-after-worker-restart',status:'passed',restoredDatabaseVersion:3,nextGeneratedKey:201});
  const beforeReplace=await target.evaluate(()=>inspectUndo());const replaced=await clone({localStorage:true,sessionStorage:true,indexedDB:true},{...config,storageMode:'clear',indexedDBMode:'replace'});assert.equal(replaced.status,'success');
  history=await rpc('HISTORY');await rpc('UNDO',{id:history[0].id,confirmed:true});assert.equal((await waitJob()).status,'success');assert.deepEqual(await target.evaluate(()=>inspectUndo()),beforeReplace);
  reports.push({test:'clear-storage-and-replace-database-undo',status:'passed'});
  const localPreview=await rpc('PREVIEW',{source:env.source,target:{origin:localOrigin,tabId:localTab.id},types:{cookies:true},config});
  assert(localPreview.rows.cookies.every(row=>row.target.hostOnly&&row.target.domain==='localhost'));
  await rpc('CLONE',{previewId:localPreview.id,selections:{cookies:localPreview.rows.cookies.map(row=>row.id)}});assert.equal((await waitJob()).status,'success');
  const localCookies=(await cdp.send('Network.getCookies',{urls:[`${localOrigin}/api/test`]})).cookies;assert.equal(localCookies.length,3);assert(localCookies.every(c=>c.domain==='localhost'&&!c.secure));
  await rpc('UNDO',{id:(await rpc('HISTORY'))[0].id,confirmed:true});assert.equal((await waitJob()).status,'success');assert.equal((await cdp.send('Network.getCookies',{urls:[`${localOrigin}/api/test`]})).cookies.length,0);
  reports.push({test:'localhost-host-only-migration-and-undo-added-cookies',status:'passed'});
  // Oversized IDB backup must stop the entire migration before the first Cookie write.
  await target.evaluate(async()=>{const open=indexedDB.open('undo_app');const db=await new Promise(resolve=>open.onsuccess=()=>resolve(open.result));const tx=db.transaction('items','readwrite');const done=new Promise(resolve=>tx.oncomplete=resolve);tx.objectStore('items').put({id:2,email:'large@example.test',blob:new Blob([new Uint8Array(3*1024*1024)])});await done;db.close();});
  const countBefore=(await rpc('HISTORY')).length;const oversized=await clone({cookies:true,indexedDB:true});assert.equal(oversized.status,'error');assert.match(oversized.error,/HISTORY_QUOTA/);assert.equal((await rpc('HISTORY')).length,countBefore);
  assert.equal((await cdp.send('Network.getCookies',{urls:[`${targetOrigin}/api/test`]})).cookies.find(c=>c.name==='parent_token').value,'original-cookie');
  reports.push({test:'backup-quota-prevents-all-mutations',status:'passed'});
  // A unique-index collision can fail a DB batch after Cookie/schema writes.
  // Undo must also restore these partial migrations, not only successful jobs.
  await target.evaluate(async()=>{const open=indexedDB.open('undo_app');const db=await new Promise(resolve=>open.onsuccess=()=>resolve(open.result));const tx=db.transaction('items','readwrite');const done=new Promise(resolve=>tx.oncomplete=resolve);tx.objectStore('items').delete(2);tx.objectStore('items').put({id:9999,email:'fixture-2@example.test',name:'conflict-record'});await done;db.close();});
  const beforePartial=await target.evaluate(()=>inspectUndo());
  worker=context.serviceWorkers().find(item=>new URL(item.url()).host===extensionId);
  await worker.evaluate(()=>{
    globalThis.__historyTestOriginalSet=chrome.storage.session.set.bind(chrome.storage.session);
    chrome.storage.session.set=items=>items.migrationHistory?Promise.reject(new Error('fixture quota failure')):globalThis.__historyTestOriginalSet(items);
  });
  try {
    const rejected=await clone({cookies:true,indexedDB:true});assert.equal(rejected.status,'error');assert.match(rejected.error,/HISTORY_QUOTA/);
    assert.deepEqual(await target.evaluate(()=>inspectUndo()),beforePartial);assert.equal((await rpc('HISTORY')).length,countBefore);
    assert.equal((await cdp.send('Network.getCookies',{urls:[`${targetOrigin}/api/test`]})).cookies.find(c=>c.name==='parent_token').value,'original-cookie');
  } finally {await worker.evaluate(()=>{chrome.storage.session.set=globalThis.__historyTestOriginalSet;delete globalThis.__historyTestOriginalSet;});}
  reports.push({test:'session-storage-rejection-prevents-all-mutations',status:'passed'});
  const partial=await clone({cookies:true,indexedDB:true});assert.equal(partial.status,'partial');assert.equal(partial.steps.find(step=>step.type==='cookies').count,3);
  await rpc('UNDO',{id:(await rpc('HISTORY'))[0].id,confirmed:true});assert.equal((await waitJob()).status,'success');assert.deepEqual(await target.evaluate(()=>inspectUndo()),beforePartial);
  reports.push({test:'partial-failure-cookie-and-schema-mutations-undo',status:'passed'});
  const first=await clone({cookies:true});assert.equal(first.status,'success');const firstId=(await rpc('HISTORY'))[0].id;
  const later=await rpc('PREVIEW',{source:env.source,target:{origin:localOrigin,tabId:localTab.id},types:{cookies:true},config});
  await rpc('CLONE',{previewId:later.id,selections:{cookies:later.rows.cookies.map(row=>row.id)}});assert.equal((await waitJob()).status,'success');
  await assert.rejects(rpc('UNDO',{id:firstId,confirmed:true}),/UNDO_ORDER_REQUIRED/);
  await rpc('UNDO',{id:(await rpc('HISTORY'))[0].id,confirmed:true});assert.equal((await waitJob()).status,'success');
  await rpc('UNDO',{id:firstId,confirmed:true});assert.equal((await waitJob()).status,'success');
  reports.push({test:'multiple-migrations-enforce-reverse-undo-order',status:'passed'});
  await rpc('CLEAR_HISTORY');assert.deepEqual(await rpc('HISTORY'),[]);
  assert.deepEqual(errors,[]);
  await mkdir('artifacts',{recursive:true});await writeFile(`artifacts/${channel}-history-report.json`,JSON.stringify({browser:context.browser().version(),reports,pageErrors:errors},null,2));
  console.log(`History E2E passed (${channel}): parent domain, localhost, all four storage types, worker restart, merge/replace undo, auto-increment and pre-write quota guard.`);
} catch(error){console.error(error);process.exitCode=1;}
finally{await context?.close();const finalRoot=resolve(taskRoot),temporaryBase=resolve(tmpdir());if(!finalRoot.startsWith(temporaryBase+'\\')&&!finalRoot.startsWith(temporaryBase+'/'))throw new Error('Temporary path escaped its intended directory.');await rm(finalRoot,{recursive:true,force:true});}
