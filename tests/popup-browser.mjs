import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
const { chromium } = await import('playwright');
const channel = process.argv.includes('--edge') ? 'msedge' : 'chromium';
const profile = await mkdtemp(join(tmpdir(), 'envbridge-popup-test-'));
const extensionRoot = join(profile, 'extension');
let context;

try {
  await mkdir(extensionRoot);
  for (const file of ['manifest.json', 'src', 'assets', 'popup.html', 'privacy.html']) {
    await cp(resolve(file), join(extensionRoot, file), { recursive: true });
  }
  context = await chromium.launchPersistentContext(join(profile, 'browser'), {
    headless: true, channel,
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const browserVersion = await worker.evaluate(() => navigator.userAgent);
  const windowId = await worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] }))[0].id);
  const start = Date.now();
  // Opening popup.html in a normal tab misses the hidden popup's load barrier.
  // Exercise Chrome's actual action popup before any extension page warms it up.
  const opened = await worker.evaluate(windowId => Promise.race([
    chrome.action.openPopup({ windowId }).then(() => ({ ok: true })).catch(error => ({ ok: false, error: error.message })),
    new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'Popup did not show within 5 seconds.' }), 5000))
  ]), windowId);
  assert.equal(opened.ok, true, opened.error);
  const openingMs = Date.now() - start;
  const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['POPUP'] }));
  assert.equal(contexts.length, 1, 'Chrome must create one actual POPUP context.');
  assert.equal(contexts[0].documentUrl, `chrome-extension://${extensionId}/popup.html`);

  const cdp = await context.newCDPSession(context.pages()[0]);
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(item => item.url === contexts[0].documentUrl);
  assert(target, 'Popup must have an inspectable document.');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let requestId = 0;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  async function send(method, params = {}) {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
      pending.set(id, { resolve, reject, timer });
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
  }
  const evaluated = await send('Runtime.evaluate', {
    expression: `(${async function () {
      const deadline = Date.now() + 5000;
      while (!document.querySelector('#source-tab option') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const visibleIcons = [...document.querySelectorAll('svg.icon')].filter(svg => svg.getClientRects().length);
      const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
      return {
        readyState: document.readyState,
        visibility: document.visibilityState,
        typeRows: document.querySelectorAll('.type-row').length,
        sourceOptions: document.querySelector('#source-tab').options.length,
        notice: document.querySelector('#notice').textContent,
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
        visibleIconCount: visibleIcons.length,
        emptyIcons: visibleIcons.filter(svg => svg.getBBox().width === 0 || svg.getBBox().height === 0).length,
        references: [...document.querySelectorAll('use')].map(use => use.getAttribute('href')),
        swapControl: document.querySelector('#swap').tagName
      };
    }.toString()})()`,
    awaitPromise: true, returnByValue: true
  });
  assert(!evaluated.exceptionDetails, JSON.stringify(evaluated.exceptionDetails));
  const state = evaluated.result.value;
  assert.equal(state.readyState, 'complete');
  assert.equal(state.visibility, 'visible');
  assert.equal(state.typeRows, 4);
  assert(state.sourceOptions > 0, 'Popup must finish its background initialization.');
  assert.equal(state.notice, '');
  assert.deepEqual(state.duplicateIds, []);
  assert.equal(state.swapControl, 'BUTTON');
  assert(state.visibleIconCount >= 8);
  assert.equal(state.emptyIcons, 0, 'Visible SVG icons must retain their geometry.');
  assert(state.references.every(href => href.startsWith('#')), 'Popup icons must not wait for an external SVG document.');

  await mkdir('artifacts', { recursive: true });
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(`artifacts/${channel}-toolbar-popup.png`, Buffer.from(screenshot.data, 'base64'));
  await writeFile(`artifacts/${channel}-popup-report.json`, JSON.stringify({ browserVersion, openingMs, state }, null, 2));
  console.log(`${channel}: real action popup opened in ${openingMs} ms; load completed, background connected, and icons rendered.`);
} finally {
  if (context) await context.close();
  if (dirname(profile) !== resolve(tmpdir()) || !basename(profile).startsWith('envbridge-popup-test-')) throw new Error('Unexpected test profile path.');
  await rm(profile, { recursive: true, force: true });
}
