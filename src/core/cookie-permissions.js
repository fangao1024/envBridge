import { getDomain } from '../vendor/tldts.js';
import { normalizeOrigin, permissionPattern, isLocalHost } from './origin.js';

export function cookieHosts(origin) {
  const host = new URL(normalizeOrigin(origin)).hostname;
  if (isLocalHost(host)) return [host];
  const root = getDomain(host, { extractHostname: false, allowPrivateDomains: true });
  const hosts = [host];
  if (!root) return hosts;
  let parent = host;
  while (parent !== root) {
    const separator = parent.indexOf('.');
    if (separator < 0) break;
    parent = parent.slice(separator + 1);
    hosts.push(parent);
  }
  return hosts;
}

export function cookiePermissionPatterns(origin) {
  // Cookie enumeration checks the cookie's own host and Secure-derived scheme,
  // not the URL of the page using it. Request exact parent hosts, never siblings.
  // Chromium checks each requested pattern against one manifest pattern; a
  // *:// request is not covered by separate http://*/* and https://*/* entries.
  return cookieHosts(origin).flatMap(host => [`http://${host}/*`, `https://${host}/*`]);
}

export function migrationPermissionPatterns(sourceOrigin, targetOrigin, types) {
  const patterns = [permissionPattern(sourceOrigin), permissionPattern(targetOrigin)];
  if (types.cookies) patterns.push(...cookiePermissionPatterns(sourceOrigin), ...cookiePermissionPatterns(targetOrigin));
  return [...new Set(patterns)];
}
