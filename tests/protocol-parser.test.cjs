'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const candidates = [path.resolve(__dirname, '..', 'runtime', 'upstream', 'server.js'), path.resolve(__dirname, '..', '..', 'upstream', 'server.js')];
const upstreamFile = candidates.find(file => fs.existsSync(file));
assert.ok(upstreamFile, 'Run tests after first upstream installation');
const S = require(upstreamFile).__test;
const advertised = new Set(['read', 'pwsh']);
const fence = String.fromCharCode(96).repeat(3);

test('missing closing JSON delimiters inside an otherwise complete json fence recover locally', () => {
    const payload = fence+'json\n{"tool_call":{"name":"read","arguments":{"path":"a.txt"}}\n'+fence;
    const calls = S.collectAgentToolCalls(payload, advertised);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'read');
    assert.deepEqual(JSON.parse(calls[0].arguments), { path:'a.txt' });
});

test('fenced-json repair preserves exact command argument bytes', () => {
    const command = 'Write-Output "{\\"phase\\":\\"test\\"}"';
    const partial = JSON.stringify({tool_call:{name:'pwsh',arguments:{command,description:'read-only'}}}).slice(0,-1);
    const calls = S.collectAgentToolCalls(fence+'json\n'+partial+'\n'+fence,advertised);
    assert.equal(calls.length,1);
    assert.deepEqual(JSON.parse(calls[0].arguments), {command,description:'read-only'});
});

test('an unfinished string, a source-code fence and an unadvertised call remain unexecutable', () => {
    for(const body of [
        fence+'json\n{"tool_call":{"name":"pwsh","arguments":{"command":"echo no\n'+fence,
        fence+'python\n{"tool_call":{"name":"pwsh","arguments":{"command":"echo no"}}\n'+fence,
        fence+'python\n'+JSON.stringify({tool_call:{name:'pwsh',arguments:{command:'Remove-Item important.txt',description:'sample only'}}})+'\n'+fence,
        fence+'json\n{"tool_call":{"name":"delete_all","arguments":{}}\n'+fence
    ]) {
        assert.deepEqual(S.collectAgentToolCalls(body,advertised), []);
    }
});

test('full JSON fences are still valid explicit calls, not blocked as source code', () => {
    const body = fence+'json\n'+JSON.stringify({tool_call:{name:'read',arguments:{path:'package.json'}}})+'\n'+fence;
    const calls = S.collectAgentToolCalls(body, advertised);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].arguments), {path:'package.json'});
});

test('complete DSML shown inside source-code fence is never executed', () => {
    const dsml = '<｜｜DSML｜｜ tool_calls>\n<｜｜DSML｜｜ invoke name="read">\n<｜｜DSML｜｜ parameter name="path" string="true">test.py</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ tool_calls>';
    const body = fence+'python\n'+dsml+'\n'+fence;
    assert.deepEqual(S.collectAgentToolCalls(body, advertised), []);
    assert.equal(S.looksLikeToolCallMarkup(body), false);
});

test('documentation mentioning a JSON field without an object is not a tool invocation', () => {
    const prose = 'The error specifically mentions "tool_calls": the model emitted an invalid envelope.';
    assert.equal(S.collectAgentToolCalls(prose, advertised).length,0);
    assert.equal(S.looksLikeToolCallMarkup(prose),false);
    assert.equal(S.looksLikeToolCallMarkup('{"tool_call":{"name":"read","arguments":'),true);
});

test('recovered object is not silently upgraded to tool name outside advertised set', () => {
    const body = fence+'json\n{"tool_call":{"name":"exec_admin","arguments":{}}\n'+fence;
    assert.deepEqual(S.collectAgentToolCalls(body,advertised), []);
});