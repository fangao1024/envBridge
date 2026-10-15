import assert from 'node:assert/strict';
import test from 'node:test';
import { setLanguage, t, translateMessage, normalizeLanguage } from '../src/ui/i18n.js';

test('language defaults to Chinese and interpolated user data stays untouched', () => {
  assert.equal(normalizeLanguage('invalid'), 'zh-CN');
  setLanguage('zh-CN');
  assert.equal(t('预览变更'), '预览变更');
  setLanguage('en');
  assert.equal(t('预览变更'), 'Preview changes');
  assert.equal(t('仅迁移 {type}', { type: 'localStorage' }), 'Transfer only localStorage');
  assert.equal(t('已应用预设：{name}', { name: '环境迁移 <script>{count}</script>' }), 'Applied preset: 环境迁移 <script>{count}</script>');
  setLanguage('zh-CN');
});

test('diagnostics translate without losing error codes, schema names, or nested failures', () => {
  setLanguage('en');
  assert.equal(translateMessage('INVALID_ORIGIN: 请输入完整的 http:// 或 https:// 地址。'), 'INVALID_ORIGIN: Enter a complete http:// or https:// URL.');
  assert.equal(translateMessage('INVALID_ORIGIN: 源与目标必须是不同 Origin，避免覆盖源数据。'), 'INVALID_ORIGIN: Source and destination must have different origins to avoid overwriting source data.');
  assert.equal(translateMessage('设置 索引不兼容'), '设置: incompatible index');
  assert.equal(translateMessage('localStorage：3 已写入并校验，1 跳过，0 失败'), 'localStorage: 3 written and verified, 1 skipped, 0 failed');
  assert.equal(translateMessage('PREVIEW_FAILED: 所选数据全部读取失败。INVALID_ORIGIN: 标签页已导航，请重新预览。 VERIFY_FAILED: Storage 校验未通过。'), 'PREVIEW_FAILED: All selected data categories failed to read. INVALID_ORIGIN: The tab navigated away. Preview again. VERIFY_FAILED: Storage verification failed.');
  assert.equal(translateMessage('COOKIE_PERMISSION_REQUIRED: Cookie 读取需要当前主机及合法父域的 HTTP / HTTPS 权限（localhost）。请重新点击预览并允许新增的网站权限。'), 'COOKIE_PERMISSION_REQUIRED: Reading cookies requires HTTP / HTTPS access to the selected host and eligible parent domains (localhost). Preview again and grant the additional website access.');
  assert.equal(translateMessage('An unexpected browser error'), 'An unexpected browser error');
  setLanguage('zh-CN');
});
