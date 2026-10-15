export function normalizeOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('INVALID_ORIGIN: 请输入完整的 http:// 或 https:// 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('INVALID_ORIGIN: 仅支持不含账号密码的 HTTP / HTTPS 页面。');
  }
  return url.origin;
}

export function permissionPattern(input) {
  const url = new URL(normalizeOrigin(input));
  // Host grants intentionally cover every port; data operations still check exact origins.
  return `${url.protocol}//${url.hostname}/*`;
}

export function domainMatches(hostname, domain, hostOnly = false) {
  const plain = domain.replace(/^\./, '').toLowerCase();
  const host = hostname.toLowerCase();
  return host === plain || (!hostOnly && host.endsWith(`.${plain}`));
}

export function isLocalHost(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}
