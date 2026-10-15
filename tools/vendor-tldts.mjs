import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
const pkg=JSON.parse(await readFile('node_modules/tldts/package.json','utf8'));
const bundle=await readFile('node_modules/tldts/dist/index.esm.min.js','utf8');
await mkdir('src/vendor',{recursive:true});
await writeFile('src/vendor/tldts.js',`/* tldts ${pkg.version}, MIT; see tldts.LICENSE.txt. Bundled PSL; no runtime network access. */\n`+bundle.replace(/\n?\/\/# sourceMappingURL=.*$/m,''));
await copyFile('node_modules/tldts/LICENSE','src/vendor/tldts.LICENSE.txt');
await writeFile('src/vendor/README.md',`# Local public-suffix parser\n\nThis directory vendors tldts ${pkg.version} from its published npm ESM bundle.\n\nUpstream: https://github.com/remusao/tldts\nLicense: MIT (tldts.LICENSE.txt). The bundle includes its Public Suffix List data, including private suffixes.\n\nUsed solely to determine eligible cookie parent hosts and avoid requesting access to public suffixes such as co.uk or github.io. No code or data is fetched at runtime.\n\nUpdate explicitly with npm install --save-dev tldts followed by node tools/vendor-tldts.mjs, then run the permission regression tests.\n`);
console.log(`Vendored local tldts ${pkg.version}.`);
