import { domainMatches, isLocalHost, normalizeOrigin } from './origin.js';
import { cookieHosts } from './cookie-permissions.js';

export function rewrittenCookieDomain(cookie, sourceOrigin, targetOrigin) {
  const targetHost = new URL(normalizeOrigin(targetOrigin)).hostname;
  if (cookie.hostOnly || isLocalHost(targetHost)) return { domain: targetHost, hostOnly: true };
  const sourceHosts = cookieHosts(sourceOrigin), targetHosts = cookieHosts(targetOrigin);
  const plain = cookie.domain.replace(/^\./, '').toLowerCase();
  const level = sourceHosts.indexOf(plain);
  if (level < 0) throw new Error('INVALID_COOKIE_DOMAIN: 源 Cookie 不适用于所选源主机。');
  const mapped = plain === sourceHosts.at(-1) ? targetHosts.at(-1) : targetHosts[Math.min(level, targetHosts.length - 1)];
  return { domain: `${cookie.domain.startsWith('.') ? '.' : ''}${mapped}`, hostOnly: false };
}

export function sameCookieIdentity(expected, actual) {
  return Boolean(actual) && expected.name === actual.name && expected.path === actual.path &&
    expected.domain.replace(/^\./, '') === actual.domain.replace(/^\./, '') && expected.hostOnly === actual.hostOnly &&
    JSON.stringify(expected.partitionKey || null) === JSON.stringify(actual.partitionKey || null);
}

export function originalCookieDetails(cookie, storeId) {
  const host = cookie.domain.replace(/^\./, '');
  const details = { url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`, name: cookie.name,
    value: cookie.value, path: cookie.path || '/', secure: cookie.secure, httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite || 'unspecified', storeId };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session && cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate;
  return details;
}

export function cookieId(cookie) {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey || null]);
}

export function cookieAttributes(cookie) {
  return {
    domain: cookie.domain, hostOnly: cookie.hostOnly, path: cookie.path,
    secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite || 'unspecified',
    expirationDate: cookie.expirationDate ?? null
  };
}

export function rewriteCookie(cookie, sourceOrigin, targetOrigin, mode = 'rewrite', now = Date.now() / 1000) {
  normalizeOrigin(sourceOrigin);
  const target = new URL(normalizeOrigin(targetOrigin));
  const warnings = [];
  const errors = [];
  const special = /^__(Host-|Secure-|Http-|Host-Http-)/.test(cookie.name);
  const hostPrefix = cookie.name.startsWith('__Host-');
  const securePrefix = special;
  const next = { ...cookie, partitionKey: undefined };
  if (cookie.partitionKey) errors.push('分区 Cookie 依赖顶层站点，当前版本跳过此项。');
  if (cookie.expirationDate !== undefined && cookie.expirationDate <= now) errors.push('Cookie 已过期。');

  if (mode === 'rewrite') {
    Object.assign(next, rewrittenCookieDomain(cookie, sourceOrigin, targetOrigin));
    if (next.secure && target.protocol === 'http:') {
      next.secure = false;
      warnings.push('HTTP 目标：Secure 将改为 false。');
    }
    if (next.sameSite === 'no_restriction' && !next.secure) {
      next.sameSite = 'lax';
      warnings.push('SameSite=None 需要 Secure，将改为 Lax。');
    }
    if (hostPrefix) { next.domain = target.hostname; next.hostOnly = true; next.path = '/'; }
  } else if (mode === 'preserve') {
    if (!domainMatches(target.hostname, cookie.domain, cookie.hostOnly)) errors.push('原 Domain 与目标不匹配，Preserve 无法写入。');
    if (cookie.secure && target.protocol !== 'https:') errors.push('Preserve 模式不能把 Secure Cookie 写入 HTTP 目标。');
    if (cookie.sameSite === 'no_restriction' && !cookie.secure) errors.push('SameSite=None 必须配合 Secure。');
  } else { throw new Error('UNSUPPORTED_COOKIE: 未知 Cookie 模式。'); }

  if (securePrefix && target.protocol !== 'https:') errors.push('特殊前缀 Cookie 必须使用 HTTPS，不能降级迁移。');
  if (special) warnings.push('特殊 Cookie：保留名称并校验前缀约束。');
  if (securePrefix && target.protocol === 'https:') next.secure = true;
  if ((cookie.name.startsWith('__Http-') || cookie.name.startsWith('__Host-Http-')) && !next.httpOnly) errors.push('__Http- 前缀需要 HttpOnly。');
  if (hostPrefix && (!next.hostOnly || next.path !== '/')) errors.push('__Host- 前缀必须是 host-only 且 Path=/。');
  const details = {
    url: `${target.origin}${next.path || '/'}`,
    name: next.name, value: next.value, path: next.path || '/', secure: next.secure,
    httpOnly: next.httpOnly, sameSite: next.sameSite || 'unspecified'
  };
  if (!next.hostOnly) details.domain = next.domain;
  if (!cookie.session && cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate;
  const before = cookieAttributes(cookie);
  const after = cookieAttributes(next);
  const changes = Object.keys(before).filter(key => before[key] !== after[key]).map(field => ({ field, before: before[field], after: after[field] }));
  return { next, details, warnings, errors, changes, special, writable: errors.length === 0 };
}

export function sameCookie(expected, actual) {
  if (!actual || expected.name !== actual.name || expected.value !== actual.value) return false;
  const fields = ['path', 'secure', 'httpOnly', 'hostOnly', 'sameSite'];
  if (fields.some(key => (expected[key] ?? 'unspecified') !== (actual[key] ?? 'unspecified'))) return false;
  if (expected.domain.replace(/^\./, '') !== actual.domain.replace(/^\./, '')) return false;
  return Math.abs((expected.expirationDate || 0) - (actual.expirationDate || 0)) < 2;
}
