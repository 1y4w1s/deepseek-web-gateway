'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { patchSource } = require('../patches/apply-upstream.cjs');

const candidates = [
  path.resolve(__dirname, '..', 'runtime', 'upstream', 'server.js'),
  path.resolve(__dirname, '..', '..', 'upstream', 'server.js'),
];
const upstream = candidates.find(p => fs.existsSync(p));
assert.ok(upstream, 'expected existing upstream checkout');
const source = patchSource(fs.readFileSync(upstream, 'utf8'));
const begin = source.indexOf('function resolveUpstreamPrompt(');
const end = source.indexOf('// === Admin API and dashboard ===', begin);
assert.ok(begin > -1 && end > begin);

const resolve = vm.runInNewContext(source.slice(begin, end) + '\nresolveUpstreamPrompt', {
  formatMessages: (messages, tools) => ({
    systemPrompt: [
      messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n'),
      ...tools.map(t => JSON.stringify(t)),
    ].join('\n'),
    prompt: messages.filter(m => m.role !== 'system').map(m => m.content).join('\n'),
  }),
  fingerprintPrompt: value => crypto.createHash('sha256').update(value).digest('hex'),
  continuationMessages: messages => messages.filter(m => m.role !== 'system').slice(-1),
  appendPromptInstruction: value => value,
  noToolsContract: () => '',
});

const prompt = system => [{role: 'system', content: system}, {role: 'user', content: 'fix cart.py'}];
const tool = name => ({type: 'function', function: {name, parameters: {type: 'object'}}});

test('identical system prompt and tools: continue without re-sending context', () => {
  const session = {id: null, sentSystemFingerprint: null};
  const original = resolve(session, prompt('standing instructions'), [tool('read')]);
  session.id = 'remote-session';
  session.sentSystemFingerprint = original.fingerprint;
  const next = resolve(session, prompt('standing instructions'), [tool('read')]);
  assert.equal(next.omittedSystem, true);
  assert.equal(next.systemPrompt, '');
  assert.equal(next.omittedPriorTurns, true);
});

test('a changed system prompt is not silently omitted', () => {
  const session = {id: 'remote-session', sentSystemFingerprint: resolve({}, prompt('old rules'), [tool('read')]).fingerprint};
  const next = resolve(session, prompt('new rules'), [tool('read')]);
  assert.equal(next.omittedSystem, false);
  assert.match(next.systemPrompt, /new rules/);
});

test('new or changed tools must refresh upstream tool definitions', () => {
  const first = resolve({}, prompt('rules'), [tool('read')]);
  const session = {id: 'remote-session', sentSystemFingerprint: first.fingerprint};
  const changed = resolve(session, prompt('rules'), [tool('read'), tool('pwsh')]);
  assert.equal(changed.omittedSystem, false);
  assert.match(changed.systemPrompt, /pwsh/);
  assert.notEqual(changed.fingerprint, first.fingerprint);
  session.sentSystemFingerprint = changed.fingerprint;
  assert.equal(resolve(session, prompt('rules'), [tool('read'), tool('pwsh')]).omittedSystem, true);
});

test('edited tool schema invalidates fingerprint without changing tool name', () => {
  const baseTool = tool('pwsh');
  const session = {id: 'remote-session', sentSystemFingerprint: resolve({}, prompt('rules'), [baseTool]).fingerprint};
  const adjusted = {type: 'function', function: {name:'pwsh', parameters: {type:'object', properties:{command:{type:'string'}}}}};
  assert.equal(resolve(session, prompt('rules'), [adjusted]).omittedSystem, false);
});