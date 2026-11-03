'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const candidates = [
  path.resolve(__dirname, '..', 'runtime', 'upstream', 'server.js'),
  path.resolve(__dirname, '..', '..', 'upstream', 'server.js'),
];
const upstream = candidates.find(file => fs.existsSync(file));
assert.ok(upstream, 'requires existing upstream checkout; no live requests');
const S = require(upstream).__test;

function send(session, messages, maxChars = 80000) {
  const resolved = S.resolveUpstreamPrompt(session, messages, []);
  return { resolved, built: S.buildBoundedPrompt(resolved.systemPrompt, resolved.historyPrefix, resolved.conversation, maxChars) };
}
const system = { role: 'system', content: 'Inspect an isolated source bug; preserve test error details.' };
const firstUser = { role: 'user', content: 'Diagnose cart.py and test_cart.py' };
function assistantCall(i) {
  return { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'pwsh', arguments: JSON.stringify({command: 'python -m unittest -q --case '+i}) } }] };
}
function toolOut(content) { return { role: 'tool', content }; }
function repeatedLogs(n, len) {
  const msgs = [system, firstUser];
  for (let i = 0; i < n; i++) {
    msgs.push(assistantCall(i), toolOut('TEST_'+i+': ' + '#'.repeat(len-18) + '\nTRACE_END_'+i));
  }
  return msgs;
}
function stickyFrom(messages) {
  const first = send(S.createSession(), messages);
  return { id:'remote-chat-fixture', parentMessageId: 11, sentSystemFingerprint: first.resolved.fingerprint };
}

test('healthy sticky session sends only newly returned tool output', () => {
  const all = repeatedLogs(8, 9000);
  const warm = send(stickyFrom(all), all);
  const cold = send(S.createSession(), all);
  assert.equal(warm.resolved.omittedPriorTurns, true);
  assert.equal(warm.resolved.omittedSystem, true);
  assert.equal(cold.resolved.omittedPriorTurns, false);
  assert.equal(warm.built.compacted, false);
  assert.ok(warm.built.prompt.includes('TRACE_END_7'));
  assert.ok(!warm.built.prompt.includes('TRACE_END_0'));
  assert.ok(warm.built.promptChars < cold.built.promptChars);
  console.log('TOOL_OUTPUT_STICKY '+JSON.stringify({turns:8,perResultChars:9000,warmChars:warm.built.promptChars,coldChars:cold.built.promptChars,coldCompacted:cold.built.compacted,priorResultOmitted:true}));
});

test('an essential recent traceback remains complete below overall request cap', () => {
  const traceback = 'TRACE_START\n' + 'stack frame\n'.repeat(1600) + 'TRACE_END';
  const messages = [system, firstUser, assistantCall(1), toolOut(traceback)];
  const result = send(stickyFrom(messages), messages);
  assert.equal(result.built.compacted, false);
  assert.match(result.built.prompt, /TRACE_START/);
  assert.match(result.built.prompt, /TRACE_END/);
  assert.equal(result.built.prompt.includes(traceback), true);
  console.log('TOOL_OUTPUT_PRESERVED '+JSON.stringify({toolChars:traceback.length,upstreamChars:result.built.promptChars,wasCompacted:result.built.compacted}));
});

test('a single oversized fresh result triggers bounded compaction and retains the diagnostic tail', () => {
  const giant = 'TRACE_START\n' + 'frame\n'.repeat(18000) + 'TRACE_END';
  const messages = [system, firstUser, assistantCall(2), toolOut(giant)];
  const result = send(stickyFrom(messages), messages);
  assert.equal(result.built.compacted, true);
  assert.ok(result.built.promptChars <= 80000);
  assert.match(result.built.prompt, /TRACE_START/);
  assert.match(result.built.prompt, /TRACE_END/);
  console.log('TOOL_OUTPUT_OVERSIZE '+JSON.stringify({toolChars:giant.length,upstreamChars:result.built.promptChars,wasCompacted:result.built.compacted}));
});

test('new identical tool result is still transmitted: dedup needs a reliable result identity', () => {
  const log = 'SAME_BUILD_LOG_START\n' + 'output\n'.repeat(3300) + 'SAME_BUILD_LOG_END';
  const msgs = [system, firstUser, assistantCall(1), toolOut(log), assistantCall(2), toolOut(log)];
  const warm = send(stickyFrom(msgs), msgs);
  assert.equal(warm.resolved.omittedPriorTurns, true);
  assert.equal(warm.built.compacted, false);
  assert.match(warm.built.prompt, /SAME_BUILD_LOG_END/);
  assert.equal((warm.built.prompt.match(/SAME_BUILD_LOG_START/g) || []).length, 1);
  console.log('TOOL_OUTPUT_DUPLICATE '+JSON.stringify({repeatChars:log.length,upstreamChars:warm.built.promptChars,oneLatestCopy:true,noUnverifiedDedup:true}));
});

test('without assistant boundary a client can resend old user/tool chunks in a live session', () => {
  const chunks = [system, firstUser, toolOut('OLD_RESULT_START '+'x'.repeat(12000)+' OLD_RESULT_END'), toolOut('LATEST_RESULT_START '+'y'.repeat(12000)+' LATEST_RESULT_END')];
  const warm = send(stickyFrom(chunks), chunks);
  assert.equal(warm.resolved.omittedPriorTurns, true);
  assert.match(warm.built.prompt, /OLD_RESULT_END/);
  assert.match(warm.built.prompt, /LATEST_RESULT_END/);
  console.log('TOOL_OUTPUT_NO_ASSISTANT_BOUNDARY '+JSON.stringify({messageRoles:chunks.map(x=>x.role),upstreamChars:warm.built.promptChars,oldResultPresent:true,requiresClientShapeEvidence:true}));
});