import { readFile, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { checkBackground } from './build-background.mjs';
await checkBackground();
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (manifest.manifest_version !== 3 || manifest.host_permissions?.length) throw new Error('Expected MV3 with optional-only host grants.');
if (manifest.permissions.join(',') !== 'cookies,storage,tabs,scripting') throw new Error('Unexpected extension permissions.');
const entries=[manifest.background.service_worker,manifest.action.default_popup,...Object.values(manifest.icons)];
for(const file of entries)await access(file);
async function check(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=`${directory}/${entry.name}`;
    if(entry.isDirectory())await check(path);
    else if(path.endsWith('.js')||path.endsWith('.mjs')){
      const result=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});
      if(result.status)throw new Error(result.stderr);
    }
  }
}
await check('src');await check('tools');await check('tests');
for(const file of ['popup.html','privacy.html']){
  const html=await readFile(file,'utf8');
  if(/<script[^>]*>\s*[^<\s]/i.test(html)||/\son\w+=/i.test(html))throw new Error(`${file} has an inline script or handler.`);
  for(const match of html.matchAll(/(?:src|href)="([^"?#]+)"/g))if(!match[1].startsWith('http'))await access(match[1]);
}
console.log('Background bundle, manifest, packaged assets, JavaScript syntax and CSP-compatible HTML checked.');
