import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cookiePermissionPatterns } from '../src/core/cookie-permissions.js';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
const { chromium } = await import('playwright');
const channel=process.argv.includes('--edge')?'msedge':'chromium';
const sourceOrigin='https://www.51miz.com',targetOrigin='http://localhost:39999';
const expected=['parent_api_http_only','parent_secure','www_plain'];
const workspace=resolve('.');
const taskRoot=await mkdtemp(join(tmpdir(),'envbridge-cookie-regression-'));
await mkdir('artifacts',{recursive:true});
const report={channel,scenarios:[]};
try {
  for(const scenario of ['legacy-grants','complete-cookie-grants']) {
    const base=join(taskRoot,scenario),extensionRoot=join(base,'extension');await mkdir(extensionRoot,{recursive:true});
    for(const file of ['src','assets','popup.html','privacy.html'])await cp(join(workspace,file),join(extensionRoot,file),{recursive:true});
    const manifest=JSON.parse(await readFile('manifest.json','utf8'));
    // Headless fixture grants only; production continues to request optional permissions.
    // Keep schemes separate, as in the production optional manifest. A *://
    // fixture grant would mask the exact manifest/request mismatch regression.
    manifest.host_permissions=scenario==='legacy-grants'?['https://www.51miz.com/*',...cookiePermissionPatterns(targetOrigin)]:[...cookiePermissionPatterns(sourceOrigin),...cookiePermissionPatterns(targetOrigin),...cookiePermissionPatterns('https://login.51miz.com')];
    await writeFile(join(extensionRoot,'manifest.json'),JSON.stringify(manifest));
    const context=await chromium.launchPersistentContext(join(base,'profile'),{headless:true,channel,args:[`--disable-extensions-except=${extensionRoot}`,`--load-extension=${extensionRoot}`]});
    try {
      // Both test URLs are intercepted locally; never connect to the real website.
      await context.route(`${sourceOrigin}/**`,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated 51miz cookie fixture</title>'}));
      await context.route(`${targetOrigin}/**`,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated target fixture</title>'}));
      const seedPage=await context.newPage();
      const cdp=await context.newCDPSession(seedPage);
      // CDP url-only cookies are genuinely host-only; Playwright's addCookies
      // convenience rewrites url to a domain field and can broaden the scope.
      await cdp.send('Network.setCookies',{cookies:[
        {name:'parent_secure',value:'fixture-only-1',domain:'.51miz.com',path:'/',secure:true,httpOnly:true,sameSite:'Lax'},
        {name:'parent_api_http_only',value:'fixture-only-2',domain:'.51miz.com',path:'/api',secure:false,httpOnly:true,sameSite:'Lax'},
        {name:'www_plain',value:'fixture-only-3',url:sourceOrigin,secure:false,sameSite:'Lax'},
        {name:'root_host_only',value:'excluded-root-fixture',url:'https://51miz.com',secure:false,sameSite:'Lax'},
        {name:'sibling_host_only',value:'excluded-sibling-fixture',url:'https://login.51miz.com',secure:false,sameSite:'Lax'}
      ]});
      // Ask the browser's cookie matcher, rather than Playwright's domain-only
      // convenience filter, which can include host-only parent cookies.
      const browserVisible=(await cdp.send('Network.getCookies',{urls:[`${sourceOrigin}/api/test`]})).cookies;
      await seedPage.close();
      assert.deepEqual(browserVisible.map(cookie=>cookie.name).sort(),expected);
      const source=await context.newPage();await source.goto(sourceOrigin);
      const target=await context.newPage();await target.goto(targetOrigin);
      const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');report.browser=await context.browser().version();
      const extensionId=new URL(worker.url()).host;
      const ui=await context.newPage();await ui.goto(`chrome-extension://${extensionId}/popup.html?workspace=1`);
      const rpc=(kind,args={})=>ui.evaluate(async({kind,args})=>{const response=await chrome.runtime.sendMessage({kind,...args});if(!response?.ok)throw new Error(response?.error);return response.data;},{kind,args});
      const tabs=await rpc('TABS');const sourceTab=tabs.find(tab=>tab.origin===sourceOrigin),targetTab=tabs.find(tab=>tab.origin===targetOrigin);
      const config={cookieMode:'rewrite',storageMode:'merge',indexedDBMode:'merge',reload:false,preview:true};
      const options={source:{origin:sourceOrigin,tabId:sourceTab.id},target:{origin:targetOrigin,tabId:targetTab.id},types:{cookies:true},config};
      const legacyCount=await worker.evaluate(async()=>{
        const all=await chrome.cookies.getAll({});
        return all.filter(cookie=>cookie.domain.replace(/^\./,'')==='www.51miz.com'||!cookie.hostOnly&&'www.51miz.com'.endsWith('.'+cookie.domain.replace(/^\./,''))).length;
      });
      if(scenario==='legacy-grants') {
        assert.equal(legacyCount,1,'Old exact-www grant cannot enumerate either parent-domain cookie.');
        await worker.evaluate(origin=>chrome.cookies.remove({url:origin,name:'www_plain'}),sourceOrigin);
        const remainingBrowser=(await(await context.newCDPSession(source)).send('Network.getCookies',{urls:[`${sourceOrigin}/api/test`]})).cookies;
        assert.equal(remainingBrowser.length,2);
        const parentOnlyApiCount=await worker.evaluate(async()=>{
          const all=await chrome.cookies.getAll({});
          return all.filter(cookie=>cookie.domain.replace(/^\./,'')==='www.51miz.com'||!cookie.hostOnly&&'www.51miz.com'.endsWith('.'+cookie.domain.replace(/^\./,''))).length;
        });
        assert.equal(parentOnlyApiCount,0,'Parent-domain cookies exist, but the old grant reads none.');
        await assert.rejects(rpc('PREVIEW',options),/COOKIE_PERMISSION_REQUIRED/);
        report.scenarios.push({scenario,browserVisible:3,legacyApiCount:1,parentOnlyBrowserVisible:2,parentOnlyLegacyApiCount:0,newReader:'explicit missing-permission error'});
      } else {
        // Reproduce 1.0.1's failing request using a real user gesture and the
        // browser's own manifest validation, without opening a permission dialog.
        await ui.evaluate(()=>{
          const probe=document.createElement('button');probe.id='legacy-permission-probe';probe.textContent='Legacy request regression';
          probe.addEventListener('click',()=>chrome.permissions.request({origins:['*://www.51miz.com/*','*://51miz.com/*']})
            .then(granted=>globalThis.__legacyPermissionProbe={granted})
            .catch(error=>globalThis.__legacyPermissionProbe={error:error.message}));
          document.body.append(probe);
        });
        await ui.click('#legacy-permission-probe');await ui.waitForFunction(()=>globalThis.__legacyPermissionProbe);
        const permissionProbe=await ui.evaluate(()=>globalThis.__legacyPermissionProbe);
        assert.match(permissionProbe.error,/Only permissions specified in the manifest may be requested/);
        await ui.evaluate(()=>document.querySelector('#legacy-permission-probe').remove());
        await ui.waitForSelector('#source-tab option',{state:'attached'});await ui.selectOption('#source-tab',String(sourceTab.id));await ui.selectOption('#target-tab',String(targetTab.id));
        await ui.click('#preview');await ui.waitForSelector('#preview-view:not([hidden])');
        assert.equal(await ui.locator('.preview-group[data-type=cookies] .item-row').count(),3);
        const preview=await rpc('PREVIEW',options);assert.deepEqual(preview.rows.cookies.map(row=>row.name).sort(),expected);
        assert(preview.rows.cookies.find(row=>row.name==='parent_api_http_only').source.httpOnly);assert.equal(preview.rows.cookies.find(row=>row.name==='parent_api_http_only').source.path,'/api');
        assert(!preview.readErrors.cookies);assert(!JSON.stringify(preview).includes('fixture-only'));
        await rpc('CLONE',{previewId:preview.id,selections:{cookies:preview.rows.cookies.map(row=>row.id)}});
        let job;for(let tries=0;tries<100;tries++){job=await rpc('JOB');if(job.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,100));}
        assert.equal(job.status,'success',JSON.stringify(job));assert.equal(job.steps[0].count,3);
        const copied=await context.cookies([`${targetOrigin}/api/test`]);assert.deepEqual(copied.map(cookie=>cookie.name).sort(),expected);
        assert(!JSON.stringify(await worker.evaluate(()=>chrome.storage.local.get(null))).includes('fixture-only'));
        report.scenarios.push({scenario,browserVisible:3,legacyWildcardRequest:permissionProbe.error,explicitSchemeRequest:'accepted',previewCount:3,verifiedCloneCount:3,siblingsExcluded:true});
      }
    } finally {await context.close();}
  }
  await writeFile(`artifacts/${channel}-cookie-regression.json`,JSON.stringify(report,null,2));
  console.log(`Cookie permission regression passed (${channel}): reproduced the legacy wildcard manifest error and parent-cookie omission; explicit HTTP/HTTPS host/parent grants read and clone all 3 fixture cookies. Real website was never contacted.`);
} finally {
  const finalRoot=resolve(taskRoot),temporaryBase=resolve(tmpdir());
  if(!finalRoot.startsWith(temporaryBase+'\\')&&!finalRoot.startsWith(temporaryBase+'/'))throw new Error('Temporary path escaped its intended directory.');
  await rm(finalRoot,{recursive:true,force:true});
}
