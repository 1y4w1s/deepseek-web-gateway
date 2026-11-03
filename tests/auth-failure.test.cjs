'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const candidates = [path.resolve(__dirname, '..', 'runtime', 'upstream', 'server.js'), path.resolve(__dirname, '..', '..', 'upstream', 'server.js')];
const upstreamFile = candidates.find(file => fs.existsSync(file));
assert.ok(upstreamFile, 'An installed upstream server.js is required');
const S = require(upstreamFile).__test;
const makeAccount = () => ({
  id: 'fake-auth', file: path.join(path.dirname(upstreamFile), 'fake-auth.json'),
  config: { token: 'fixture-token-A', cookie: 'fixture-cookie=A' },
  cooldownUntil: 0, cooldownReason: null, failures: 0, totalFailures: 0,
  adminDisabled: false,
});

test('401 stops an invalid login even after the ordinary 600s cooldown would expire', t => {
  const a = makeAccount();
  const previous = S.accounts.splice(0, S.accounts.length, a);
  t.after(() => S.accounts.splice(0, S.accounts.length, ...previous));
  S.markAccountFailure(a, 401, 'completion', null, 'INVALID_TOKEN');
  assert.equal(a.authBlocked, true);
  assert.equal(S.adminAccountView(a).disabled_by, 'auth');
  a.cooldownUntil = Date.now() - 1000;
  assert.equal(S.accountCanServe(a), false);
  assert.throws(() => S.selectAccountForSession(S.createSession()),
    err => err.status === 401 && err.type === 'auth_expired' && /login|auth|sign.?in/i.test(err.message));
});

test('reload with unchanged credentials preserves auth hold; changed credentials release it', () => {
  const a = makeAccount();
  S.markAccountFailure(a, 401, 'PoW', null, 'invalid token');
  const same = S.buildAccountsList([{ file: a.file, config: { ...a.config } }], [a]);
  assert.equal(same.list[0].authBlocked, true);
  const renewed = S.buildAccountsList([{ file: a.file, config: { ...a.config, token: 'fixture-token-B' } }], [a]);
  assert.equal(renewed.list[0].authBlocked, false);
  assert.equal(renewed.list[0].cooldownUntil, 0);
  assert.equal(S.accountCanServe(renewed.list[0]), true);
});

test('pinned 401 is reported as auth_expired, not 429 or a generic paused account', t => {
  const a = makeAccount();
  const previous = S.accounts.splice(0, S.accounts.length, a);
  t.after(() => S.accounts.splice(0, S.accounts.length, ...previous));
  S.markAccountFailure(a, 401, 'completion', null, 'INVALID_TOKEN');
  assert.throws(() => S.selectAccountForSession(S.createSession(), { pinnedAccountId: a.id }),
    err => err.status === 401 && err.type === 'auth_expired');
  assert.equal(S.adminPoolSummary().disabled, 1);
});

test('other valid logins remain available while one is auth-blocked', t => {
  const a = makeAccount();
  const b = { ...makeAccount(), id: 'fake-good', file: 'good.json', config: { token: 'test-good', cookie: 'good=yes' } };
  const previous = S.accounts.splice(0, S.accounts.length, a, b);
  t.after(() => S.accounts.splice(0, S.accounts.length, ...previous));
  S.markAccountFailure(a, 401, 'PoW', null, 'INVALID_TOKEN');
  const selected = S.selectAccountForSession(S.createSession());
  assert.equal(selected.id, b.id);
  assert.equal(S.adminPoolSummary().can_serve, 1);
});
test('dashboard cannot falsely clear a rejected login through the rate-limit button', async t => {
  const http = require('node:http');
  const a = makeAccount();
  const previous = S.accounts.splice(0, S.accounts.length, a);
  t.after(() => S.accounts.splice(0, S.accounts.length, ...previous));
  S.markAccountFailure(a, 401, 'PoW', null, 'INVALID_TOKEN');
  const server = S.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method: 'POST', path: '/admin/accounts/' + a.id + '/clear-cooldown' }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', s => { body += s; });
      res.on('end', () => resolve({status:res.statusCode, body:JSON.parse(body)}));
    });
    req.on('error', reject); req.end();
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.type, 'auth_expired');
  assert.equal(a.authBlocked, true);
});
test('429 remains a timed cooldown and is not reclassified as auth failure', () => {
  const a = makeAccount();
  S.markAccountFailure(a, 429, 'completion', '5', 'too frequent');
  assert.equal(a.authBlocked, undefined);
  assert.equal(a.cooldownReason, 'rate_limit');
  assert.equal(S.accountCanServe(a), false);
  a.cooldownUntil = Date.now() - 1;
  assert.equal(S.accountCanServe(a), true);
});

test('403 keeps existing temporary cooldown semantics', () => {
  const a = makeAccount();
  S.markAccountFailure(a, 403, 'access', null, 'forbidden');
  assert.equal(a.authBlocked, undefined);
  a.cooldownUntil = Date.now() - 1;
  assert.equal(S.accountCanServe(a), true);
});