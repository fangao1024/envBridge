import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './icons.mjs';
const sourceManifest=JSON.parse(await readFile('manifest.json','utf8'));
const zip=await readFile(`dist/envbridge-${sourceManifest.version}.zip`);
const files=new Map();let offset=0;
while(zip.readUInt32LE(offset)===0x04034b50){
  assert.equal(zip.readUInt16LE(offset+8),8);
  const compressed=zip.readUInt32LE(offset+18),size=zip.readUInt32LE(offset+22),nameLength=zip.readUInt16LE(offset+26),extraLength=zip.readUInt16LE(offset+28);
  const name=zip.subarray(offset+30,offset+30+nameLength).toString('utf8');
  const start=offset+30+nameLength+extraLength;
  const data=inflateRawSync(zip.subarray(start,start+compressed));
  assert.equal(data.length,size);assert.equal(crc32(data),zip.readUInt32LE(offset+14));assert(!name.includes('..'));assert(!name.startsWith('/'));
  assert.deepEqual(data,await readFile(name));files.set(name,data);offset=start+compressed;
}
const manifest=JSON.parse(files.get('manifest.json'));
assert.equal(manifest.manifest_version,3);assert(!manifest.host_permissions);
for(const file of [manifest.background.service_worker,manifest.action.default_popup,...Object.values(manifest.icons)])assert(files.has(file));
for(const name of files.keys())assert(!/node_modules|tests\/|\.playwright|artifacts\//.test(name));
console.log(`ZIP verified: ${files.size} files, CRCs, source parity, entry points and optional-only website grants.`);
