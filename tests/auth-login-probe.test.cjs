'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { patchAuthSource } = require('../patches/apply-upstream.cjs');

const candidates = [
  path.resolve(__dirname, '..', 'runtime', 'upstream', 'scripts', 'deepseek_chrome_auth.js'),
  path.resolve(__dirname, '..', '..', 'upstream', 'scripts', 'deepseek_chrome_auth.js'),
];
const input = candidates.find(p => fs.existsSync(p));
assert.ok(input, 'requires upstream Chrome auth script');
const source = fs.readFileSync(input, 'utf8');
const patched = patchAuthSource(source);
const start = patched.indexOf('async function verifyCapturedAuth(cdp, auth) {');
const end = patched.indexOf('function chromeInstallHelp(checked) {', start);
assert.ok(start > -1 && end > start, 'probe must be defined before login UI');
const verify = vm.runInNewContext(patched.slice(start, end) + '\nverifyCapturedAuth', { URL, console });
const fixtureAuth = { token: 'fixture-token', cookie: 'ds_session_id=fixture', href: 'https://chat.deepseek.com/chat' };
const good = () => ({ ok: true, json: async () => ({ code: 0, data: { biz_code: 0 } }) });
function cdpResponse(fetchImpl, timers = {}) {
  const call = { count: 0, args: null };
  return {
    call,
    async send(method, args) {
      call.count++;
      call.args = { method, awaitPromise: args.awaitPromise, returnByValue: args.returnByValue };
      const result = await vm.runInNewContext(args.expression, {
        fetch: fetchImpl,
        AbortController,
        setTimeout: timers.setTimeout || setTimeout,
        clearTimeout: timers.clearTimeout || clearTimeout,
      });
      return { result: { value: result } };
    },
  };
}

test('probe is valid JS, must run only in chat.deepseek.com and never log credential', () => {
  assert.doesNotThrow(() => new vm.Script(patched));
  assert.match(patched, /const verified = await verifyCapturedAuth\(cdp, auth\)/);
  assert.match(patched, /const success = verified && writeCapturedAuth\(outPath, persisted\)/);
  assert.match(patched, /if \(!success\) process\.exitCode = 2/);
});

test('successful authenticated PoW challenge permits a save', async () => {
  const cdp = cdpResponse(async (url, opts) => {
    assert.equal(url, '/api/v0/chat/create_pow_challenge');
    assert.equal(opts.method, 'POST');
    assert.equal(opts.credentials, 'include');
    assert.equal(opts.headers.authorization, 'Bearer fixture-token');
    assert.equal(JSON.parse(opts.body).target_path, '/api/v0/chat/completion');
    return good();
  });
  assert.equal(await verify(cdp, fixtureAuth), true);
  assert.deepEqual(cdp.call.args, {method: 'Runtime.evaluate', awaitPromise: true, returnByValue: true});
  assert.equal(cdp.call.count, 1);
});

test('401 and unsuccessful business response reject the login', async () => {
  const rejected = cdpResponse(async () => ({ ok: false, status: 401 }));
  assert.equal(await verify(rejected, fixtureAuth), false);
  const bizFail = cdpResponse(async () => ({ ok: true, json: async () => ({ code: 0, data: { biz_code: 7 } }) }));
  assert.equal(await verify(bizFail, fixtureAuth), false);
});

test('slow challenge times out and rejects the login without retries', async () => {
  const timers = { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} };
  const stalled = cdpResponse((_url, opts) => new Promise((_resolve, reject) => {
    if (opts.signal.aborted) reject(new Error('abort'));
    else opts.signal.addEventListener('abort', () => reject(new Error('abort')), {once: true});
  }), timers);
  assert.equal(await verify(stalled, fixtureAuth), false);
  assert.equal(stalled.call.count, 1);
});

test('foreign tab and missing token never send a browser fetch or reveal token', async () => {
  const cdp = cdpResponse(async () => { throw Error('must not run'); });
  assert.equal(await verify(cdp, { ...fixtureAuth, href: 'https://example.com/' }), false);
  assert.equal(await verify(cdp, { ...fixtureAuth, token: '' }), false);
  assert.equal(cdp.call.count, 0);
});

test('failed verification never overwrites an existing login file', async () => {
  const start = patched.indexOf('    const { href, cookiesCount, ...persisted } = auth;');
  const end = patched.indexOf('    cdp.close();', start);
  assert.ok(start >= 0 && end > start, 'save gate must precede closing CDP');
  const gate = vm.runInNewContext('(async function gate(auth, cdp, outPath, writeCapturedAuth, verifyCapturedAuth, console) {\n'
    + patched.slice(start, end) + '\nreturn success;\n})');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-auth-gate-'));
  const target = path.join(tmp, 'existing.json');
  const savedBefore = '{"token":"previous-working-login"}';
  fs.writeFileSync(target, savedBefore);
  let writes = 0;
  const write = (p, value) => { writes++; fs.writeFileSync(p, JSON.stringify(value)); return true; };
  const silent = { error: () => {} };
  try {
    assert.equal(await gate(fixtureAuth, {}, target, write, async () => false, silent), false);
    assert.equal(fs.readFileSync(target, 'utf8'), savedBefore);
    assert.equal(writes, 0);
    assert.equal(await gate(fixtureAuth, {}, target, write, async () => true, silent), true);
    assert.equal(writes, 1);
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).token, 'fixture-token');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('local first-run and re-login launcher applies auth patch before Chrome capture', () => {
  const ps = fs.readFileSync(path.resolve(__dirname, '..', '..', 'Authenticate.ps1'), 'utf8');
  assert.match(ps, /publish\\patches\\apply-upstream\.cjs/);
  assert.ok(ps.indexOf('& $node $patcher $repo') > 0);
  assert.ok(ps.indexOf('scripts/deepseek_chrome_auth.js') > ps.indexOf('& $node $patcher $repo'));
  assert.match(ps, /if \(\$LASTEXITCODE -ne 0\).*throw/);
});

test('auth patch is fresh-checkout compatible for LF and CRLF and idempotent', () => {
  const { execFileSync } = require('node:child_process');
  const pristine = execFileSync('git', ['show', 'HEAD:scripts/deepseek_chrome_auth.js'], {
    cwd: path.resolve(input, '..', '..'), encoding: 'utf8',
  });
  for (const copy of [pristine.replace(/\r\n/g, '\n'), pristine.replace(/\r?\n/g, '\r\n')]) {
    const applied = patchAuthSource(copy);
    assert.notEqual(applied, copy);
    assert.equal(patchAuthSource(applied), applied);
    assert.doesNotThrow(() => new vm.Script(applied));
  }
  assert.equal(patchAuthSource(source), patched);
});