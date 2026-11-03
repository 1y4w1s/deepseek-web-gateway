'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { patchSource } = require('../patches/apply-upstream.cjs');

const candidates = [
    path.resolve(__dirname, '..', 'runtime', 'upstream', 'server.js'),
    path.resolve(__dirname, '..', '..', 'upstream', 'server.js'),
];
const upstreamPath = candidates.find(file => fs.existsSync(file));
const source = fs.readFileSync(upstreamPath, 'utf8');
const patched = patchSource(source);

function extractFunctions(src, startName, endName, bindings) {
    const start = src.indexOf(startName);
    const end = src.indexOf(endName, start);
    assert.ok(start !== -1 && end > start, 'Expected upstream source section exists');
    return vm.runInNewContext(src.slice(start, end) + '\n(' + bindings + ')', {
        MAX_UPSTREAM_PROMPT_CHARS: 200000,
        MAX_TOOL_ARGUMENT_CHARS: 128 * 1024,
        compactToolSchema: schema => schema,
        appendPromptInstruction: (prompt, reminder) => prompt + '\n' + reminder,
    });
}

function formatters() {
    return extractFunctions(patched, 'function formatToolDefinitions(tools) {', '\nconst MAX_AGENT_TOOL_CALLS', '{formatToolDefinitions, formatToolReminder}');
}

const webTool = {
    type: 'function',
    function: { name: 'websearch', description: 'Search the web', parameters: { type: 'object' } },
};
const gitTool = {
    type: 'function',
    function: { name: 'bash', description: 'Run approved commands', parameters: { type: 'object' } },
};

test('fresh upstream checkout patches on LF and CRLF without changing unrelated content', () => {
    const { execFileSync } = require('node:child_process');
    const pristine = execFileSync('git', ['show', 'HEAD:server.js'], {
        cwd: path.dirname(upstreamPath), encoding: 'utf8',
    });
    for (const source of [pristine.replace(/\r\n/g, '\n'), pristine.replace(/\r?\n/g, '\r\n')]) {
        const result = patchSource(source);
        assert.notEqual(result, source);
        assert.doesNotThrow(() => new vm.Script(result));
        assert.equal(patchSource(result), result);
    }
});

test('patch is syntactically valid and idempotent', () => {
    assert.doesNotThrow(() => new vm.Script(patched, { filename: 'server.js' }));
    assert.equal(patchSource(patched), patched);
});

test('web tools are correctly advertised instead of forbidden', () => {
    const { formatToolDefinitions, formatToolReminder } = formatters();
    const prompt = formatToolDefinitions([webTool, gitTool]);
    const reminder = formatToolReminder([webTool, gitTool]);
    assert.match(prompt, /Use the advertised web search\/fetch tool/);
    assert.match(prompt, /GitHub source/);
    assert.match(prompt, /## websearch/);
    assert.match(reminder, /Use the advertised web search\/fetch tool/);
    assert.doesNotMatch(prompt + reminder, /DeepSeek Search is already on/);
});

test('the no-web-tool case does not invent internet access', () => {
    const { formatToolDefinitions, formatToolReminder } = formatters();
    const prompt = formatToolDefinitions([gitTool]);
    const reminder = formatToolReminder([gitTool]);
    assert.match(prompt, /Native DeepSeek web search may be available/);
    assert.match(prompt, /otherwise state that source access is unavailable/);
    assert.doesNotMatch(reminder, /DeepSeek Search is already on/);
});

test('native-tool repair keeps advertised web tools possible in nosearch mode', () => {
    const repairs = extractFunctions(patched, 'function emptyResponseNudge(searchEnabled) {', '\nfunction noToolsRepairPrompt()', '{nativeToolRepairPrompt}');
    assert.match(repairs.nativeToolRepairPrompt(false), /use its exact advertised name/);
    assert.doesNotMatch(repairs.nativeToolRepairPrompt(false), /Answer in plain text from what you already know/);
    assert.match(repairs.nativeToolRepairPrompt(true), /native Web Search is already enabled/);
});

test('DSH first-user task identities stay stable across turns but separate unrelated tasks', () => {
    const crypto = require('node:crypto');
    const start = patched.indexOf('const UNKEYED_WARNED = new Set();');
    const end = patched.indexOf('const MAX_HISTORY_LENGTH', start);
    assert.ok(start !== -1 && end > start);
    const unkeyedAgentId = vm.runInNewContext(
        patched.slice(start, end) + '\n(unkeyedAgentId)',
        {
            crypto,
            console: { log: () => {} },
            normalizeMessageContent: value => typeof value === 'string' ? value : JSON.stringify(value),
        },
    );
    const agent = 'deepseek-harness/0.2.1-rc.5';
    const taskA = [{ role: 'user', content: 'Inspect project A' }];
    const taskAFollowup = [...taskA, { role: 'assistant', content: 'Checking...' }, { role: 'user', content: 'Now inspect files' }];
    const taskB = [{ role: 'user', content: 'Inspect project B' }];
    const first = unkeyedAgentId('127.0.0.1', agent, taskA);
    assert.equal(first, unkeyedAgentId('127.0.0.1', agent, taskAFollowup));
    assert.notEqual(first, unkeyedAgentId('127.0.0.1', agent, taskB));
    assert.notEqual(first, unkeyedAgentId('127.0.0.1', agent, []));
    const oldKey = crypto.createHash('sha256').update('127.0.0.1\u0000cli').digest('hex').slice(0, 12);
    assert.equal(unkeyedAgentId('127.0.0.1', 'cli', taskA), 'unkeyed-' + oldKey);
    assert.match(patched, /unkeyedAgentId\(remoteAddr, req\.headers\['user-agent'\], messages\)/);
});

test('DSH duplicate tool envelope is unwrapped into exact tool arguments', () => {
    const tools = extractFunctions(patched,
        'function buildToolCall(name, args = {}) {', '\nfunction parseJsonToolCandidate(',
        '{buildToolCall, coerceToolCallObject}');
    const wrapped = { name:'pwsh', arguments:{ name:'pwsh', arguments:{ command:'git status', description:'Read status' } } };
    const coerced = tools.coerceToolCallObject({ tool_call: wrapped });
    assert.equal(coerced.name, 'pwsh');
    assert.deepEqual(JSON.parse(coerced.arguments), { command:'git status', description:'Read status' });
    const read = tools.coerceToolCallObject({ tool_call:{ name:'read', arguments:{name:'read', arguments:{file_path:'README.md'}} } });
    assert.deepEqual(JSON.parse(read.arguments), {file_path:'README.md'});
    const ordinary = tools.buildToolCall('pwsh', {command:'git --version',description:'Check git'});
    assert.deepEqual(JSON.parse(ordinary.arguments), {command:'git --version',description:'Check git'});
    const unrelated = tools.buildToolCall('pwsh', {name:'other',arguments:{command:'X'}});
    assert.equal(JSON.parse(unrelated.arguments).name, 'other');
});

test('DeepSeek Web requests are paced per account without delaying first use or other accounts', async () => {
    let now = 100000;
    const waits = [];
    const paceAccountCompletion = vm.runInNewContext(
        patched.slice(
            patched.indexOf('async function paceAccountCompletion(account) {'),
            patched.indexOf('async function askDeepSeekStream(')
        ) + '\n(paceAccountCompletion)',
        {
            Date: { now: () => now },
            sleep: async ms => { waits.push(ms); now += ms; },
        },
    );
    const accountA = {};
    await paceAccountCompletion(accountA);
    assert.equal(accountA.lastCompletionSentAt, 100000);
    now += 2000;
    await paceAccountCompletion(accountA);
    assert.equal(accountA.lastCompletionSentAt, 115000);
    assert.deepEqual(waits, [13000]);
    const accountB = {};
    await paceAccountCompletion(accountB);
    assert.equal(accountB.lastCompletionSentAt, now);
    now += 9000;
    await paceAccountCompletion(accountA);
    assert.deepEqual(waits, [13000, 6000]);
    assert.match(patched, /await paceAccountCompletion\(account\);\s*const resp = await dsStreamFetch/);
    assert.match(patched, /await paceAccountCompletion\(account\);\s*const resp2 = await dsStreamFetch/);
});

test('an upstream mismatch fails rather than silently skipping the correction', () => {
    const mismatched = patched.replace('Web: Use the advertised web search/fetch tool', 'Web: changed upstream instruction');
    assert.throws(() => patchSource(mismatched), /Upstream changed near web-tool-prompt/);
});