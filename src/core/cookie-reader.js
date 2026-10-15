import { cookieHosts, cookiePermissionPatterns } from './cookie-permissions.js';
import { domainMatches, normalizeOrigin } from './origin.js';

export async function readCookies(environment, api = chrome) {
  const origin = normalizeOrigin(environment.origin);
  const host = new URL(origin).hostname;
  const origins = cookiePermissionPatterns(origin);
  if (!await api.permissions.contains({ origins })) {
    throw new Error(`COOKIE_PERMISSION_REQUIRED: Cookie 读取需要当前主机及合法父域的 HTTP / HTTPS 权限（${cookieHosts(origin).join('、')}）。请重新点击预览并允许新增的网站权限。`);
  }
  if (environment.storeId === undefined || environment.storeId === null) {
    throw new Error('COOKIE_STORE_NOT_FOUND: 未能定位所选标签页的 Cookie 存储，请重新选择标签页后预览。');
  }
  // domain includes cookies for the exact host, eligible parents and descendants;
  // the final hostOnly-aware filter excludes unrelated siblings and parent-only cookies.
  // Do not use url here: a root URL would omit cookies with non-root paths.
  const all = await api.cookies.getAll({ storeId: environment.storeId, domain: cookieHosts(origin).at(-1) });
  return all.filter(cookie => domainMatches(host, cookie.domain, cookie.hostOnly));
}
