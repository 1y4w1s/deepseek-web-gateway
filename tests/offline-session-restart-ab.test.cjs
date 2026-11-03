'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const candidates = [
  path.resolve(__dirname, '..', 'runtime', 'upstream', 'server.js'),
  path.resolve(__dirname, '..', '..', 'upstream', 'server.js'),
];
const server = candidates.find(p => fs.existsSync(p));
assert.ok(server, 'existing upstream needed; no network or DeepSeek account used');
const S = require(server).__test;

const tools = Array.from({length: 12}, (_, i) => ({
  type: 'function',
  function: {
    name: 'local_tool_' + i,
    description: 'Inspect project files or run local tests. ' + 'help '.repeat(30),
    parameters: {type: 'object', properties: {command: {type: 'string', description: 'workspace command'}}},
  },
}));

function messages(turns, toolChars) {
  const transcript = [
    {role: 'system', content: 'You are an engineering assistant. Follow the project rules.\n' + 'Rule: verify edits locally.\n'.repeat(110)},
    {role: 'user', content: 'Fix an isolated cart pricing defect.\n' + 'Project spec.\n'.repeat(75)},
  ];
  for (let i = 0; i < turns; i++) {
    transcript.push({role: 'assistant', content: 'Reading source and tests in turn ' + i});
    transcript.push({role: 'tool', content: 'synthetic local test output ' + i + ': ' + 'log line. '.repeat(Math.ceil(toolChars / 10))});
    transcript.push({role: 'assistant', content: 'Inspected the output. Continue to the next file.'});
  }
  transcript.push({role: 'user', content: 'Now validate the current fix, and report test outcome.'});
  return transcript;
}

function compare(turns, toolChars) {
  const history = messages(turns, toolChars);
  const warmSession = S.createSession();
  const first = S.resolveUpstreamPrompt(warmSession, history, tools);
  Object.assign(warmSession, {
    id: 'synthetic-remote-session',
    accountId: 'synthetic-account',
    parentMessageId: 17,
    createdAt: Date.now(),
    messageCount: 18,
    sentSystemFingerprint: first.fingerprint,
  });
  const saved = {
    id: warmSession.id,
    accountId: warmSession.accountId,
    parentMessageId: warmSession.parentMessageId,
    createdAt: warmSession.createdAt,
    messageCount: warmSession.messageCount,
    sentSystemFingerprint: warmSession.sentSystemFingerprint,
  };
  const coldSession = S.createSession();
  const restoredSession = Object.assign(S.createSession(), saved);
  const wrap = session => {
    const resolved = S.resolveUpstreamPrompt(session, history, tools);
    const built = S.buildBoundedPrompt(resolved.systemPrompt, resolved.historyPrefix, resolved.conversation);
    return {resolved, built};
  };
  const warm = wrap(warmSession);
  const cold = wrap(coldSession);
  const restored = wrap(restoredSession);
  assert.equal(cold.resolved.omittedPriorTurns, false);
  assert.equal(cold.resolved.omittedSystem, false);
  assert.equal(warm.resolved.omittedPriorTurns, true);
  assert.equal(warm.resolved.omittedSystem, true);
  assert.equal(restored.resolved.omittedPriorTurns, true);
  assert.equal(restored.resolved.omittedSystem, true);
  assert.equal(restored.built.prompt, warm.built.prompt);
  assert.ok(cold.built.promptChars > warm.built.promptChars);
  return {
    turns, syntheticToolCharsPerTurn: toolChars,
    normalContinuationChars: warm.built.promptChars,
    coldRestartChars: cold.built.promptChars,
    hypotheticalRestoredChars: restored.built.promptChars,
    savedMetadataBytes: Buffer.byteLength(JSON.stringify(saved)),
    coldWasCompacted: cold.built.compacted,
    extraCharsFromColdRestart: cold.built.promptChars - warm.built.promptChars,
    coldCreatesNewChat: !coldSession.id,
    restoredKeepsChat: Boolean(restoredSession.id),
  };
}

test('small DSH-style history A/B: cold restart repeats work only once', () => {
  const result = compare(5, 2500);
  assert.equal(result.coldWasCompacted, false);
  assert.ok(result.extraCharsFromColdRestart > 10000);
  console.log('RESTART_AB_SMALL ' + JSON.stringify(result));
});

test('large history A/B: cold restart must compact while hypothetical restore continues', () => {
  const result = compare(12, 9000);
  assert.equal(result.coldWasCompacted, true);
  assert.ok(result.coldRestartChars <= 80000);
  assert.ok(result.extraCharsFromColdRestart > 40000);
  console.log('RESTART_AB_LARGE ' + JSON.stringify(result));
});

test('persisted metadata cannot override existing remote session TTL or depth limit', () => {
  const now = Date.now();
  const expired = Object.assign(S.createSession(), {id:'old', createdAt: now - (2 * 60 * 60 * 1000) - 1, messageCount:1, sentSystemFingerprint:'old'});
  const ttl = S.prepareSessionForPrompt(expired, now);
  assert.equal(ttl.reason, 'session_ttl');
  assert.equal(expired.id, null);
  assert.equal(expired.sentSystemFingerprint, null);
  const full = Object.assign(S.createSession(), {id:'too-many', createdAt: now, messageCount:100, sentSystemFingerprint:'old'});
  const depth = S.prepareSessionForPrompt(full, now);
  assert.equal(depth.reason, 'max_message_depth');
  assert.equal(full.id, null);
  assert.equal(full.sentSystemFingerprint, null);
});

test('without DSH client history, a cold restart has nothing to recover', () => {
  const session = S.createSession();
  const onlyLatest = [
    {role:'system', content:'Current instructions'},
    {role:'user', content:'Continue the earlier bugfix'},
  ];
  const result = S.resolveUpstreamPrompt(session, onlyLatest, []);
  assert.doesNotMatch(result.fullConversation, /cart pricing/);
  assert.match(result.fullConversation, /earlier bugfix/);
  assert.equal(result.omittedPriorTurns, false);
});