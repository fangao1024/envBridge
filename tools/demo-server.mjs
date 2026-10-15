import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function startDemo(port = 0) {
  const html = await readFile(resolve(root, 'tests/fixtures/demo.html'));
  const script = await readFile(resolve(root, 'tests/fixtures/demo.js'));
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/seed-cookies')) {
      res.setHeader('Set-Cookie', ['fixture_session=source-session; Path=/; SameSite=Lax', 'fixture_http_only=source-http-only; Path=/api; HttpOnly; SameSite=Strict', 'fixture_persistent=source-persistent; Path=/; Max-Age=86400']);
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('Seeded test-only cookies.'); return;
    }
    if (req.url?.startsWith('/demo.js')) { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }); res.end(script); return; }
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  return { server, sourceOrigin: `http://127.0.0.1:${actualPort}`, targetOrigin: `http://localhost:${actualPort}`, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await startDemo(4173);
  console.log(`Source: ${demo.sourceOrigin}/?role=source\nTarget: ${demo.targetOrigin}/?role=target\nOpen both URLs, initialize test data, then use EnvBridge. Ctrl+C stops the local demo.`);
}
