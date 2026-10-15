import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cookieHosts, cookiePermissionPatterns, migrationPermissionPatterns } from '../src/core/cookie-permissions.js';
import { readCookies } from '../src/core/cookie-reader.js';

test('51miz cookies require exact www and parent hosts for both schemes', () => {
  assert.deepEqual(cookieHosts('https://www.51miz.com'), ['www.51miz.com', '51miz.com']);
  assert.deepEqual(cookiePermissionPatterns('https://www.51miz.com'), ['http://www.51miz.com/*', 'https://www.51miz.com/*', 'http://51miz.com/*', 'https://51miz.com/*']);
  assert.deepEqual(cookieHosts('https://mobile.prod.51miz.com'), ['mobile.prod.51miz.com', 'prod.51miz.com', '51miz.com']);
});
test('cookie parent grants stop at public and private suffix boundaries', () => {
  assert.deepEqual(cookieHosts('https://www.example.co.uk'), ['www.example.co.uk', 'example.co.uk']);
  assert.deepEqual(cookieHosts('https://app.user.github.io'), ['app.user.github.io', 'user.github.io']);
  assert.deepEqual(cookieHosts('https://www.city.kawasaki.jp'), ['www.city.kawasaki.jp', 'city.kawasaki.jp']);
  assert.deepEqual(cookieHosts('http://localhost:3000'), ['localhost']);
  assert.deepEqual(cookieHosts('http://127.0.0.1:3000'), ['127.0.0.1']);
  assert.deepEqual(cookieHosts('http://[::1]:3000'), ['[::1]']);
});
test('non-cookie transfers keep origin host grants only', () => {
  assert.deepEqual(migrationPermissionPatterns('https://www.51miz.com','http://localhost:3000',{localStorage:true}), ['https://www.51miz.com/*','http://localhost/*']);
  const withCookies=migrationPermissionPatterns('https://www.51miz.com','http://localhost:3000',{cookies:true});
  for(const host of ['51miz.com','www.51miz.com','localhost']) {
    assert(withCookies.includes(`http://${host}/*`));assert(withCookies.includes(`https://${host}/*`));
  }
  assert(!withCookies.some(pattern=>pattern.includes('://*.')));
});

test('every requested cookie permission is individually covered by the shipped manifest', async () => {
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  for(const [source,target] of [
    ['https://www.51miz.com','http://localhost:3000'],
    ['https://app.user.github.io','https://www.example.co.uk'],
    ['http://127.0.0.1:4000','http://[::1]:3000']
  ]) {
    const patterns=migrationPermissionPatterns(source,target,{cookies:true});
    assert.equal(patterns.length,new Set(patterns).size);
    for(const pattern of patterns) {
      const scheme=pattern.split('://')[0];
      assert(['http','https'].includes(scheme),`Unsupported request scheme: ${pattern}`);
      assert(manifest.optional_host_permissions.includes(`${scheme}://*/*`),`Missing declaration for ${pattern}`);
    }
  }
});
test('reader preserves parent-domain, HttpOnly and non-root-path cookies while excluding siblings', async () => {
  const cookies=[
    {name:'parent_secure',domain:'.51miz.com',hostOnly:false,secure:true,path:'/'},
    {name:'parent_api',domain:'.51miz.com',hostOnly:false,secure:false,httpOnly:true,path:'/api'},
    {name:'www_plain',domain:'www.51miz.com',hostOnly:true,secure:false,path:'/'},
    {name:'root_only',domain:'51miz.com',hostOnly:true,path:'/'},
    {name:'sibling_only',domain:'login.51miz.com',hostOnly:true,path:'/'},
    {name:'sibling_domain',domain:'.login.51miz.com',hostOnly:false,path:'/'}
  ];
  let query;
  const api={permissions:{contains:async ({origins})=>{assert.deepEqual(origins,cookiePermissionPatterns('https://www.51miz.com'));return true;}},cookies:{getAll:async details=>{query=details;return cookies;}}};
  const actual=await readCookies({origin:'https://www.51miz.com',storeId:'selected-tab-store'},api);
  assert.deepEqual(actual.map(cookie=>cookie.name),['parent_secure','parent_api','www_plain']);
  assert.deepEqual(query,{storeId:'selected-tab-store',domain:'51miz.com'});
  assert(!('url' in query));assert(!('path' in query));
});
test('incomplete cookie grants produce an actionable error instead of an empty list', async () => {
  let read=false;
  const api={permissions:{contains:async()=>false},cookies:{getAll:async()=>{read=true;return [];}}};
  await assert.rejects(readCookies({origin:'https://www.51miz.com',storeId:'0'},api),/COOKIE_PERMISSION_REQUIRED:.*51miz\.com/);
  assert.equal(read,false);
});
test('missing cookie store never falls back to another profile store', async () => {
  const api={permissions:{contains:async()=>true},cookies:{getAll:async()=>{throw new Error('should not read');}}};
  await assert.rejects(readCookies({origin:'https://www.51miz.com'},api),/COOKIE_STORE_NOT_FOUND/);
});
