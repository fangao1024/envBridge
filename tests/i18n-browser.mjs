import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startDemo } from '../tools/demo-server.mjs';
import { EN } from '../src/ui/translations-en.js';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= resolve('.playwright');
const { chromium } = await import('playwright');
const channel = process.argv.includes('--edge') ? 'msedge' : 'chromium';
const profile = await mkdtemp(join(tmpdir(), 'envbridge-i18n-test-'));
const extensionRoot = join(profile, 'extension');
const demo = await startDemo();
const errors = [];
let context;

try {
  await mkdir(extensionRoot);
  for (const file of ['src', 'assets', 'popup.html', 'privacy.html']) {
    await cp(resolve(file), join(extensionRoot, file), { recursive: true });
  }
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  // Only the disposable test copy grants loopback hosts for headless testing.
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://127.0.0.1/*', 'http://localhost/*', 'https://localhost/*'];
  await writeFile(join(extensionRoot, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(profile, 'browser'), {
    headless: true, channel, viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const source = await context.newPage();
  await source.goto(`${demo.sourceOrigin}/?role=source`);
  await source.evaluate(async () => { await window.seed('source', 3); localStorage.setItem('设置', '中文内容保持原样'); });
  const target = await context.newPage();
  await target.goto(`${demo.targetOrigin}/?role=target`);
  await target.evaluate(() => window.seed('target'));
  const openUI = async (workspace = true) => {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/popup.html${workspace ? '?workspace=1' : ''}`);
    await page.waitForSelector('#source-tab option', { state: 'attached' });
    return page;
  };
  const ui = await openUI();
  const rpc = (kind, args = {}) => ui.evaluate(async ({ kind, args }) => {
    const response = await chrome.runtime.sendMessage({ kind, ...args });
    if (!response?.ok) throw new Error(response?.error);
    return response.data;
  }, { kind, args });
  const nav = view => ui.locator(`.nav [data-view="${view}"]`);
  const snapshot = () => ui.evaluate(() => ({
    source: document.querySelector('#source-tab').value,
    target: document.querySelector('#target-tab').value,
    config: [...document.querySelectorAll('.strategy-fields input, .strategy-fields select')].map(node => [node.id, node.type === 'checkbox' ? node.checked : node.value]),
    types: [...document.querySelectorAll('#type-list input')].map(node => [node.id, node.checked]),
    choices: [...document.querySelectorAll('#preview-groups input')].map(node => [node.value, node.checked, node.disabled]),
    details: [...document.querySelectorAll('#preview-groups details')].map(node => node.open)
  }));
  const auditStatic = async page => assert.deepEqual(await page.evaluate(catalog => {
    const failures = [];
    for (const node of document.querySelectorAll('[data-i18n]')) {
      if (!Object.hasOwn(catalog, node.dataset.i18n)) { failures.push(`Missing key: ${node.dataset.i18n}`); continue; }
      // Job and confirmation headings are intentionally overwritten with live content.
      if (['result-title', 'result-subtitle', 'confirm-title'].includes(node.id)) continue;
      const text = [...node.childNodes].find(child => child.nodeType === 3 && child.textContent.trim());
      if (text?.textContent !== catalog[node.dataset.i18n]) failures.push(`Text: ${node.dataset.i18n}`);
    }
    for (const attribute of ['title', 'aria-label', 'placeholder']) {
      for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        const key = node.getAttribute(`data-i18n-${attribute}`);
        if (!Object.hasOwn(catalog, key) || node.getAttribute(attribute) !== catalog[key]) failures.push(`${attribute}: ${key}`);
      }
    }
    return failures;
  }, EN), []);

  assert.equal(await ui.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await nav('settings').innerText(), '设置');
  const tabs = await rpc('TABS');
  await ui.selectOption('#source-tab', String(tabs.find(tab => tab.origin === demo.sourceOrigin).id));
  await ui.selectOption('#target-tab', String(tabs.find(tab => tab.origin === demo.targetOrigin).id));
  await ui.locator('.strategy summary').click();
  await ui.selectOption('#storage-mode', 'clear');
  await ui.click('#preview');
  await ui.waitForSelector('#preview-view:not([hidden])');
  await ui.locator('.preview-group[data-type="localStorage"] .item-line').filter({ hasText: 'theme' }).locator('input').uncheck();
  // Keep item choices even when an entire category is temporarily disabled.
  await ui.locator('.preview-group[data-type="sessionStorage"] .group-enabled').uncheck();
  await ui.locator('.preview-group[data-type="cookies"] details').first().evaluate(node => node.open = true);
  await ui.click('#save-preset');
  await ui.fill('#preset-name', '环境迁移');
  await ui.click('#preset-form button[type="submit"]');
  await ui.waitForSelector('#preset-dialog:not([open])', { state: 'attached' });
  const beforeSwitch = await snapshot();
  const savedBefore = await worker.evaluate(() => chrome.storage.local.get(null));
  await nav('settings').click();
  await ui.selectOption('#settings-form [name="storageMode"]', 'overwrite');
  await ui.locator('#settings-form [name="reload"]').check();
  await ui.selectOption('#language', 'en');
  await ui.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await nav('settings').innerText(), 'Settings');
  assert.equal(await ui.locator('#notice').innerText(), 'Interface language saved.');
  assert.equal(await ui.locator('#settings-form [name="storageMode"]').inputValue(), 'overwrite');
  assert.equal(await ui.locator('#settings-form [name="reload"]').isChecked(), true);
  assert.deepEqual(await snapshot(), beforeSwitch, 'Language switching must retain all preview, environment, and transfer choices.');
  const savedAfter = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(savedAfter.uiLanguage, 'en');
  delete savedAfter.uiLanguage;
  assert.deepEqual(savedAfter, savedBefore, 'Language preference must not change migration defaults or presets.');
  assert.equal(await ui.locator('#presets-list h2').innerText(), '环境迁移');
  assert.equal(await ui.locator('.preview-group[data-type="localStorage"] .item-name').filter({ hasText: '设置' }).innerText(), '设置');
  assert.match(await ui.locator('#preview-total').innerText(), /items selected/);
  assert.match(await ui.locator('.preview-group[data-type="indexedDB"] .group-summary').innerText(), /databases.*records.*Approx\./);
  assert.match(await ui.locator('#preview-warnings').innerText(), /Clear & Clone clears/);
  await auditStatic(ui);
  await mkdir('artifacts', { recursive: true });
  await ui.screenshot({ path: `artifacts/${channel}-settings-en.png`, fullPage: true });

  const second = await openUI(false);
  await second.setViewportSize({ width: 460, height: 600 });
  assert.equal(await second.locator('html').getAttribute('lang'), 'en');
  await auditStatic(second);
  await second.screenshot({ path: `artifacts/${channel}-popup-en.png` });
  assert.equal(await second.evaluate(() => document.documentElement.scrollWidth), 460);
  const action = await second.locator('#clone-all').boundingBox();
  assert(action.y + action.height <= 600);
  const privacy = await context.newPage();
  privacy.on('pageerror', error => errors.push(error.message));
  await privacy.goto(`chrome-extension://${extensionId}/privacy.html`);
  await privacy.waitForFunction(() => document.documentElement.lang === 'en');
  await auditStatic(privacy);
  await ui.selectOption('#language', 'zh-CN');
  await second.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  await privacy.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  assert.deepEqual(await snapshot(), beforeSwitch);
  await ui.selectOption('#language', 'en');
  await second.waitForFunction(() => document.documentElement.lang === 'en');
  await privacy.waitForFunction(() => document.documentElement.lang === 'en');
  await second.close();
  const reopened = await openUI(false);
  assert.equal(await reopened.locator('#language').inputValue(), 'en');
  await reopened.click('#use-current');
  await reopened.waitForFunction(() => document.querySelector('#notice').textContent === 'This page cannot be used. Select an open HTTP / HTTPS tab.');

  // Use the existing preview after switching twice: it must still be valid.
  await ui.locator('#confirm-clone').evaluate(node => node.click());
  await ui.waitForSelector('#confirm-dialog[open]');
  assert.equal(await ui.locator('#confirm-title').innerText(), 'Continue this transfer?');
  assert.match(await ui.locator('#confirm-body').innerText(), /All existing keys/);
  // A live language change also updates an already open confirmation dialog.
  await reopened.locator('.nav [data-view="settings"]').click();
  await reopened.selectOption('#language', 'zh-CN');
  await ui.waitForFunction(() => document.querySelector('#confirm-title').textContent === '确认继续此迁移？');
  await reopened.selectOption('#language', 'en');
  await ui.waitForFunction(() => document.querySelector('#confirm-title').textContent === 'Continue this transfer?');
  await ui.click('#confirm-dialog button[value="confirm"]');
  await ui.waitForFunction(() => document.querySelector('#result-title').textContent === 'Environments connected. Keep coding.');
  const job = await rpc('JOB');
  assert.equal(job.status, 'success');
  assert.equal(job.steps.find(step => step.type === 'localStorage').count, 3);
  assert.equal(job.steps.find(step => step.type === 'sessionStorage').status, 'disabled');
  assert.equal(await target.evaluate(() => localStorage.getItem('设置')), '中文内容保持原样');
  assert.equal(await target.evaluate(() => localStorage.getItem('theme')), null);
  await ui.locator('.logs summary').click();
  assert.match(await ui.locator('#logs').innerText(), /Transfer completed\. Written data verified/);
  assert.match(await ui.locator('#result-steps').innerText(), /Verified/);
  await ui.screenshot({ path: `artifacts/${channel}-result-en.png`, fullPage: true });
  await nav('history').click();
  await ui.waitForSelector('.undo-history');
  assert.match(await ui.locator('#history-list').innerText(), /Transfer successful.*Undo changes/s);
  await ui.click('.undo-history');
  await ui.waitForSelector('#confirm-dialog[open]');
  assert.equal(await ui.locator('#confirm-title').innerText(), 'Undo this transfer?');
  await ui.click('#confirm-dialog button[value="confirm"]');
  await ui.waitForFunction(() => document.querySelector('#result-title').textContent === 'Previous data restored.');
  assert.equal((await rpc('JOB')).status, 'success');
  assert.equal(await target.evaluate(() => localStorage.getItem('token')), 'target-old-token');
  assert.equal(await target.evaluate(() => localStorage.getItem('设置')), null);
  assert.deepEqual(errors, []);
  await writeFile(`artifacts/${channel}-i18n-report.json`, JSON.stringify({
    browser: context.browser()?.version(), channel, pageErrors: errors,
    checks: ['default Chinese', 'immediate English switch', 'static text and accessibility attributes', 'preview choices and unsaved settings retained', 'persistent language', 'popup/workspace/privacy live sync', 'user names and data unchanged', 'English validation, confirmation, results, logs and history', 'real transfer and undo', 'popup layout']
  }, null, 2));
  console.log(`${channel}: bilingual UI passed; language persisted and synchronized, selections retained, English transfer/undo completed, and user data unchanged.`);
} finally {
  await context?.close();
  await demo.close();
  if (dirname(profile) !== resolve(tmpdir()) || !basename(profile).startsWith('envbridge-i18n-test-')) throw new Error('Unexpected test profile path.');
  await rm(profile, { recursive: true, force: true });
}
