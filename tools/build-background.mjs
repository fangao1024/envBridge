import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, 'src/background.bundle.js');

export async function backgroundBundle() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/background.js'],
    outfile: output,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    charset: 'utf8',
    legalComments: 'inline',
    banner: { js: '// Generated from src/background.js by tools/build-background.mjs. Do not edit.' },
    metafile: true,
    write: false
  });
  if (result.outputFiles.length !== 1) throw new Error('Expected one background bundle.');
  if (Object.values(result.metafile.outputs).some(file => file.imports.length)) throw new Error('Background bundle still contains imports.');
  return result.outputFiles[0].contents;
}

export async function buildBackground() {
  const bytes = await backgroundBundle();
  await writeFile(output, bytes);
  return bytes.length;
}

export async function checkBackground() {
  const expected = await backgroundBundle();
  const actual = await readFile(output);
  if (!actual.equals(Buffer.from(expected))) throw new Error('Background bundle is stale. Run npm run build:background.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built src/background.bundle.js (${await buildBackground()} bytes).`);
}
