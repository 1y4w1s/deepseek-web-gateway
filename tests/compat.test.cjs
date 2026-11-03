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

test('an upstream mismatch fails rather than silently skipping the correction', () => {
    const mismatched = source.replace('Web: answer in text. DeepSeek Search is already on.', 'Web: changed upstream instruction.');
    assert.throws(() => patchSource(mismatched), /Upstream changed near web-tool-reminder/);
});