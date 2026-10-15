import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { crc32, makeIcons } from './icons.mjs';
import { buildBackground } from './build-background.mjs';
await makeIcons();
await buildBackground();
const files=['manifest.json','popup.html','privacy.html','PRIVACY.md','README.md'];
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
const archive=`dist/envbridge-${manifest.version}.zip`;
async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const name=`${dir}/${item.name}`;if(item.isDirectory())await walk(name);else files.push(name);}}
await walk('src');await walk('assets');await walk('docs');
const parts=[],directory=[];let offset=0;
for(const file of files){
  const data=await readFile(file),compressed=deflateRawSync(data),name=Buffer.from(file),crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  parts.push(local,name,compressed);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(0x21,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);directory.push(central,name);
  offset+=local.length+name.length+compressed.length;
}
const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
await mkdir('dist',{recursive:true});await writeFile(archive,Buffer.concat([...parts,central,end]));
console.log(`Created ${archive} (${files.length} files, self-contained runtime).`);
