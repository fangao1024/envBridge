import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDemo } from '../tools/demo-server.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
const { chromium } = await import('playwright');
const root = resolve('.');
const browserChannel = process.argv.includes('--edge') ? 'msedge' : 'chromium';
await mkdir('artifacts', { recursive:true });
const profile = await mkdtemp(join(tmpdir(),'envbridge-test-'));
const demo = await startDemo();
const extensionRoot = join(profile,'extension');
await mkdir(extensionRoot);
for(const file of ['src','assets','popup.html','privacy.html'])await cp(join(root,file),join(extensionRoot,file),{recursive:true});
// Headless Chromium cannot accept the native optional-host permission dialog.
// Only this disposable fixture manifest pre-grants the two loopback test hosts.
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
manifest.host_permissions=['http://127.0.0.1/*','https://127.0.0.1/*','http://localhost/*','https://localhost/*'];
await writeFile(join(extensionRoot,'manifest.json'),JSON.stringify(manifest));
const errors=[];
let context;
const reports=[];
try {
  context = await chromium.launchPersistentContext(join(profile,'browser'), { headless:true, channel:browserChannel, args:[`--disable-extensions-except=${extensionRoot}`,`--load-extension=${extensionRoot}`], viewport:{width:1200,height:900} });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const source = await context.newPage(); await source.goto(`${demo.sourceOrigin}/?role=source`); await source.evaluate(() => window.seed('source',1201));
  const target = await context.newPage(); await target.goto(`${demo.targetOrigin}/?role=target`); await target.evaluate(() => window.seed('target'));
  const sourceSecond = await context.newPage(); await sourceSecond.goto(`${demo.sourceOrigin}/?role=source`); await sourceSecond.evaluate(() => sessionStorage.setItem('tabName','second-source-tab'));
  let ui = await context.newPage(); ui.on('pageerror',error=>errors.push(error.message));
  await ui.goto(`chrome-extension://${extensionId}/popup.html?workspace=1`);
  await ui.waitForSelector('#source-tab option', { state:'attached' });
  const rpc = (kind,args={}) => ui.evaluate(async ({kind,args})=>{const response=await chrome.runtime.sendMessage({kind,...args});if(!response?.ok)throw new Error(response?.error);return response.data;},{kind,args});
  const tabs = await rpc('TABS'); const sourceTab = tabs.find(tab=>tab.url.includes('role=source')&&tab.origin===demo.sourceOrigin); const targetTab=tabs.find(tab=>tab.origin===demo.targetOrigin);
  await ui.selectOption('#source-tab',String(sourceTab.id));await ui.selectOption('#target-tab',String(targetTab.id));
  await ui.screenshot({path:'artifacts/workspace.png',fullPage:true});
  await ui.click('#preview');await ui.waitForSelector('#preview-view:not([hidden])');
  assert.equal(await ui.locator('.preview-group').count(),4);
  assert.equal(await ui.locator('.item-name').filter({hasText:'fixture_http_only'}).count(),1);
  await ui.screenshot({path:'artifacts/preview.png',fullPage:true});
  const schemaMetadata=await worker.evaluate(async envs=>{
    const output=[];
    for(const env of envs){const result=await chrome.scripting.executeScript({target:{tabId:env.id,frameIds:[0]},func:origin=>globalThis.__envBridgePageV1('idbList',{origin}),args:[env.origin]});output.push(result[0].result);}
    return output;
  },[sourceTab,targetTab]);
  await writeFile('artifacts/schema-metadata.json',JSON.stringify(schemaMetadata,null,2));
  await ui.click('#save-preset');await ui.fill('#preset-name','Fixture Production → Local');await ui.click('#preset-form button[type=submit]');await ui.waitForSelector('#preset-dialog:not([open])', { state:'attached' });
  await ui.click('#confirm-clone');
  const waitJob = async () => {for(let i=0;i<300;i++){const job=await rpc('JOB');if(job&&job.status!=='running')return job;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Clone timed out.');};
  const merged=await waitJob();assert.equal(merged.status,'success',JSON.stringify(merged));reports.push({test:'clone-all-merge',status:merged.status,steps:merged.steps});
  const summary=await target.evaluate(()=>window.inspect());
  assert(summary.localKeys.includes('targetOnly'));assert(summary.sessionKeys.includes('targetOnlySession'));
  assert.equal(await target.evaluate(()=>sessionStorage.getItem('tabName')),'source-tab');
  const app=summary.databases.find(db=>db.name==='fixture_app');assert.equal(app.version,4);assert(app.stores.some(store=>store.name==='targetOnly'));assert.equal(app.stores.find(s=>s.name==='users').count,1202);
  const rich=await target.evaluate(async()=>{
    const opening=indexedDB.open('fixture_app');const db=await new Promise(resolve=>opening.onsuccess=()=>resolve(opening.result));
    const request=db.transaction('users').objectStore('users').get(42);const value=await new Promise(resolve=>request.onsuccess=()=>resolve(request.result));
    const binary=db.transaction('binary').objectStore('binary').get(new Uint8Array([1,2,3]).buffer);const blob=await new Promise(resolve=>binary.onsuccess=()=>resolve(binary.result));db.close();
    return {date:value.when instanceof Date,big:value.big===42n,bytes:value.bytes instanceof Uint8Array,cycles:value.self===value,shared:value.sharedA===value.sharedB,collections:value.map.get('tag') instanceof Set,blob:await blob.text()};
  });assert.deepEqual(rich,{date:true,big:true,bytes:true,cycles:true,shared:true,collections:true,blob:'fixture-blob'});
  const cookies=await worker.evaluate(()=>chrome.cookies.getAll({}));const httpOnly=cookies.find(cookie=>cookie.domain==='localhost'&&cookie.name==='fixture_http_only');assert(httpOnly.httpOnly);assert.equal(httpOnly.path,'/api');assert.equal(httpOnly.value,'source-http-only');
  await ui.screenshot({path:'artifacts/result.png',fullPage:true});
  // Per-item selection, clear diff, explicit cancel, and exact database replacement.
  await ui.click('#new-clone');await ui.click('.strategy summary');await ui.selectOption('#storage-mode','clear');await ui.selectOption('#idb-mode','replace');
  await ui.click('#preview');await ui.waitForSelector('#preview-view:not([hidden])');
  const theme=ui.locator('.preview-group[data-type=localStorage] .item-line').filter({hasText:'theme'}).locator('input');await theme.uncheck();
  assert((await ui.locator('.preview-group[data-type=localStorage] .remove-zone').innerText()).includes('theme'));
  await ui.click('#confirm-clone');await ui.waitForSelector('#confirm-dialog[open]');await ui.click('#confirm-dialog button[value=cancel]');
  assert.equal(await target.evaluate(()=>localStorage.getItem('targetOnly')),'keep-on-merge');
  // Hold a target connection: replacement must visibly wait, never claim completion.
  await target.click('#hold');
  await ui.click('#confirm-clone');await ui.click('#confirm-dialog button[value=confirm]');
  for(let tries=0;tries<100;tries++){const job=await rpc('JOB');if(job.logs.some(log=>log.message.includes('INDEXED_DB_BLOCKED')))break;await new Promise(resolve=>setTimeout(resolve,100));}
  const blocked=await rpc('JOB');assert.equal(blocked.status,'running');assert(blocked.logs.some(log=>log.message.includes('INDEXED_DB_BLOCKED')));
  // Closing the extension UI cannot abandon an in-flight worker task.
  await ui.close();ui=await context.newPage();ui.on('pageerror',error=>errors.push(error.message));
  await ui.goto(`chrome-extension://${extensionId}/popup.html?workspace=1`);await ui.waitForSelector('#result-view:not([hidden])');
  assert.equal((await rpc('JOB')).id,blocked.id);
  await target.click('#release');const replaced=await waitJob();assert.equal(replaced.status,'success',JSON.stringify(replaced));reports.push({test:'clear-selected-and-replace-blocked',status:replaced.status,steps:replaced.steps});
  const exact=await target.evaluate(()=>window.inspect());const exactDB=exact.databases.find(db=>db.name==='fixture_app');assert.equal(exactDB.version,4);assert.equal(exactDB.stores.length,3);assert.equal(exactDB.stores.find(s=>s.name==='users').count,1201);
  assert.deepEqual(exact.localKeys.sort(),['token','userInfo']);assert.deepEqual(exact.sessionKeys.sort(),['draft','tabName']);
  // Settings and presets survive reopening. Undo snapshots are session-only;
  // public progress and persistent settings never contain website values.
  const saved=await rpc('INIT');assert.equal(saved.presets[0].name,'Fixture Production → Local');
  const persisted=await worker.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
  for(const secret of ['fixture-local-token','source-http-only','fixture-session-draft'])assert(!JSON.stringify(persisted.local).includes(secret));
  assert(persisted.session.migrationHistory.length);assert(!JSON.stringify(persisted.session.lastJob).includes('fixture-local-token'));
  assert(!JSON.stringify(await rpc('HISTORY')).includes('fixture-local-token'));
  // Preview documentId must not target a newly navigated/reloaded document.
  const config={cookieMode:'rewrite',storageMode:'merge',indexedDBMode:'merge',reload:false,preview:true};
  const sourceEnv={origin:demo.sourceOrigin,tabId:sourceTab.id},targetEnv={origin:demo.targetOrigin,tabId:targetTab.id};
  const secondTab=(await rpc('TABS')).find(tab=>tab.origin===demo.sourceOrigin&&tab.id!==sourceTab.id);
  const sessionPreview=await rpc('PREVIEW',{source:{origin:demo.sourceOrigin,tabId:secondTab.id},target:targetEnv,types:{sessionStorage:true},config:{...config,reload:true}});
  let reloadCount=0;target.on('framenavigated',frame=>{if(frame===target.mainFrame())reloadCount++;});
  await rpc('CLONE',{previewId:sessionPreview.id,selections:{sessionStorage:sessionPreview.rows.sessionStorage.map(row=>row.id)}});
  const sessionJob=await waitJob();assert.equal(sessionJob.status,'success');await target.waitForLoadState();
  assert.equal(await target.evaluate(()=>sessionStorage.getItem('tabName')),'second-source-tab');assert.equal(await source.evaluate(()=>sessionStorage.getItem('tabName')),'source-tab');assert(reloadCount>0);
  reports.push({test:'tab-specific-session-and-auto-reload',status:'passed'});
  const stale=await rpc('PREVIEW',{source:sourceEnv,target:targetEnv,types:{localStorage:true},config});await target.reload();
  await rpc('CLONE',{previewId:stale.id,selections:{localStorage:stale.rows.localStorage.map(row=>row.id)}});const guarded=await waitJob();assert.equal(guarded.status,'error');assert.equal(guarded.steps[0].count,0);reports.push({test:'navigation-document-guard',status:'passed'});
  // The popup layout must fit the Chromium popup width and remain scrollable.
  await ui.goto(`chrome-extension://${extensionId}/popup.html`);await ui.setViewportSize({width:460,height:600});await ui.waitForSelector('#result-view:not([hidden])');await ui.click('#new-clone');
  await ui.screenshot({path:'artifacts/popup.png',fullPage:true});
  assert.equal(await ui.evaluate(()=>document.documentElement.scrollWidth),460);
  const actionBounds=await ui.locator('#clone-all').boundingBox();assert(actionBounds.y+actionBounds.height<=600,'Popup primary action should remain visible.');
  assert.deepEqual(errors,[]);
  await writeFile(`artifacts/${browserChannel}-report.json`,JSON.stringify({browser:context.browser()?.version(),channel:browserChannel,reports,pageErrors:errors},null,2));
  await rm('artifacts/browser-failure.txt',{force:true});
  console.log(`Browser E2E passed: cross-origin cookies, both Storage types, 1204 rich IndexedDB records, merge, selection, destructive confirmation, blocked replacement, persistence and navigation guards. Screenshots: artifacts/.`);
} catch(error) {
  await writeFile('artifacts/browser-failure.txt',error.stack||String(error));
  console.error(error);process.exitCode=1;
} finally {
  await context?.close();await demo.close();
  const resolvedProfile=resolve(profile);
  if(resolvedProfile.startsWith(resolve(tmpdir())+'\\')||resolvedProfile.startsWith(resolve(tmpdir())+'/'))await rm(resolvedProfile,{recursive:true,force:true});
}
