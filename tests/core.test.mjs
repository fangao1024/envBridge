import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrigin, permissionPattern, domainMatches } from '../src/core/origin.js';
import { rewriteCookie, sameCookie } from '../src/core/cookie.js';
import { storageDiff, schemaConflicts } from '../src/core/diff.js';
import '../src/core/codec.js';

const cookie = overrides => ({ name: 'token', value: 'test-only', domain: '.example.com', path: '/', hostOnly: false, secure: true, httpOnly: true, sameSite: 'no_restriction', session: false, expirationDate: 2000000000, ...overrides });
test('origins retain ports and reject credentials and browser pages', () => {
  assert.equal(normalizeOrigin('https://EXAMPLE.com:8443/path?q=x'), 'https://example.com:8443');
  assert.equal(permissionPattern('http://localhost:3001'), 'http://localhost/*');
  for (const input of ['chrome://settings', 'file:///tmp', 'https://user:secret@example.com', 'example.com']) assert.throws(() => normalizeOrigin(input));
  assert(domainMatches('www.example.com', '.example.com'));
  assert(!domainMatches('example.com.evil.test', '.example.com'));
  assert(!domainMatches('www.example.com', 'example.com', true));
});
test('rewrite handles HTTP, SameSite, localhost, HttpOnly, expiry and non-root paths', () => {
  const result = rewriteCookie(cookie({ path: '/api' }), 'https://www.example.com', 'http://localhost:3000');
  assert(result.writable); assert.equal(result.next.secure, false); assert.equal(result.next.sameSite, 'lax');
  assert.equal(result.next.hostOnly, true); assert(!('domain' in result.details));
  assert.equal(result.details.url, 'http://localhost:3000/api'); assert.equal(result.details.httpOnly, true);
  assert.equal(result.details.expirationDate, 2000000000); assert.equal(result.warnings.length, 2);
});
test('preserve blocks unrelated domains and host-only cookies', () => {
  assert(rewriteCookie(cookie(), 'https://www.example.com', 'https://test.example.com', 'preserve').writable);
  assert(!rewriteCookie(cookie(), 'https://www.example.com', 'https://other.test', 'preserve').writable);
  assert(!rewriteCookie(cookie({ domain: 'www.example.com', hostOnly: true }), 'https://www.example.com', 'https://test.example.com', 'preserve').writable);
  assert(!rewriteCookie(cookie(), 'https://www.example.com', 'http://test.example.com', 'preserve').writable);
});
test('domain rewriting preserves parent, scoped-domain and host-only cookies across environments', () => {
  const parent = rewriteCookie(cookie({domain:'.51miz.com'}), 'https://www.51miz.com', 'https://www.dev.com');
  assert.equal(parent.next.domain,'.dev.com');assert.equal(parent.details.domain,'.dev.com');assert.equal(parent.next.hostOnly,false);
  assert.equal(parent.details.url,'https://www.dev.com/');
  const bareSource = rewriteCookie(cookie({domain:'.51miz.com'}), 'https://51miz.com', 'https://www.dev.com');
  assert.equal(bareSource.next.domain,'.dev.com');
  const scoped = rewriteCookie(cookie({domain:'.prod.51miz.com'}), 'https://www.prod.51miz.com', 'https://www.test.dev.com');
  assert.equal(scoped.next.domain,'.test.dev.com');
  const host = rewriteCookie(cookie({domain:'www.51miz.com',hostOnly:true}), 'https://www.51miz.com', 'https://www.dev.com');
  assert.equal(host.next.domain,'www.dev.com');assert.equal(host.next.hostOnly,true);assert(!('domain' in host.details));
  const suffix = rewriteCookie(cookie({domain:'.example.co.uk'}), 'https://www.example.co.uk', 'https://app.user.github.io');
  assert.equal(suffix.next.domain,'.user.github.io');
  for(const origin of ['http://localhost:3000','http://127.0.0.1:3000','http://[::1]:3000']) {
    const local = rewriteCookie(cookie({domain:'.51miz.com'}),'https://www.51miz.com',origin);
    assert.equal(local.next.hostOnly,true);assert(!local.next.domain.startsWith('.'));assert(!('domain' in local.details));
  }
  const fromLocal = rewriteCookie(cookie({domain:'localhost',hostOnly:true,secure:false}), 'http://localhost:3000', 'https://www.dev.com');
  assert.equal(fromLocal.next.domain,'www.dev.com');assert.equal(fromLocal.next.hostOnly,true);
});
test('special cookie prefixes and partitioned cookies are never silently downgraded', () => {
  for (const name of ['__Host-token', '__Secure-token', '__Http-token', '__Host-Http-token']) assert(!rewriteCookie(cookie({ name }), 'https://example.com', 'http://localhost').writable);
  const host = rewriteCookie(cookie({ name: '__Host-token', hostOnly: true, domain: 'example.com' }), 'https://example.com', 'https://other.test');
  assert(host.writable); assert(!('domain' in host.details)); assert.equal(host.details.path, '/'); assert.equal(host.details.secure, true);
  assert(!rewriteCookie(cookie({ partitionKey: { topLevelSite: 'https://example.com' } }), 'https://example.com', 'https://other.test').writable);
  assert(!rewriteCookie(cookie({ expirationDate: 1 }), 'https://example.com', 'https://other.test').writable);
});
test('verification compares values and attributes, accepting leading-dot normalization', () => {
  assert(sameCookie(cookie(), cookie({ domain: 'example.com' })));
  assert(!sameCookie(cookie(), cookie({ value: 'different' })));
  assert(!sameCookie(cookie(), cookie({ httpOnly: false })));
  assert(!sameCookie(cookie(), cookie({ expirationDate: 1999999990 })));
});
test('storage diff and schema conflict detection cover removed keys and unique indexes', () => {
  const source = [{ key: 'token', value: 'a' }, { key: 'new', value: 'b' }];
  const target = [{ key: 'token', value: 'old' }, { key: 'extra', value: 'c' }];
  assert.deepEqual(storageDiff(source, target, 'clear').map(item => item.status), ['modify','add','remove']);
  const db = { stores: [{ name: 'users', keyPath: 'id', autoIncrement: false, indexes: [{ name: 'email', keyPath: 'email', unique: true, multiEntry: false }] }] };
  assert.deepEqual(schemaConflicts(db, structuredClone(db)), []);
  const conflict = structuredClone(db); conflict.stores[0].keyPath = null; conflict.stores[0].indexes[0].unique = false;
  assert.equal(schemaConflicts(db, conflict).length, 2);
});
test('lossless envelope preserves cycles, shared references, binary views, collections and primitives', async () => {
  const shared = { name: 'shared' }; const buffer = new Uint8Array([1,2,3,4]).buffer;
  const value = { date: new Date('2026-01-02T00:00:00Z'), nan: NaN, inf: Infinity, zero: -0, bigint: 9007199254740993n, undefined, a: shared, b: shared, buffer, view: new Uint8Array(buffer, 1, 2), dataView: new DataView(buffer, 2, 2), map: new Map([[shared, new Set([1, shared])]]), regex: /env/gi, array: new Array(3), blob: new Blob(['content'], { type: 'text/plain' }), file: new File(['x'], 'test.txt', { lastModified: 123 }) };
  value.self = value; value.array[2] = 'end'; Object.defineProperty(value, '__proto__', { value: { safe: true }, enumerable: true });
  const codec = globalThis.EnvBridgeCodec(); const wire = await codec.encode(value); const decoded = codec.decode(JSON.parse(JSON.stringify(wire)));
  assert.equal(decoded.self, decoded); assert.equal(decoded.a, decoded.b); assert.equal(decoded.view.buffer, decoded.buffer); assert.equal(decoded.dataView.buffer, decoded.buffer);
  assert.deepEqual([...decoded.view], [2,3]); assert.equal(decoded.date.getTime(), value.date.getTime());
  assert.equal(decoded.bigint, value.bigint); assert(Object.is(decoded.zero, -0)); assert(Number.isNaN(decoded.nan)); assert.equal(decoded.inf, Infinity);
  assert.equal(decoded.map.get(decoded.a).has(decoded.a), true); assert.equal(0 in decoded.array, false); assert.equal(decoded.array.length, 3);
  assert.equal(await decoded.blob.text(), 'content'); assert.equal(decoded.file.name, 'test.txt'); assert.equal(decoded.file.lastModified, 123);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype); assert.deepEqual(decoded.__proto__, { safe: true });
  assert.equal(JSON.stringify(await codec.encode(decoded)), JSON.stringify(wire));
});
test('unsupported IndexedDB types fail instead of becoming empty objects', async () => {
  class Unknown {}
  await assert.rejects(globalThis.EnvBridgeCodec().encode(new Unknown()), /UNSUPPORTED_VALUE/);
});
