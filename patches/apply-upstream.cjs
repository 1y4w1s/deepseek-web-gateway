'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Minimal downstream compatibility fix for the upstream web-search instruction conflict.
// Fail instead of silently launching an unpatched adapter after an upstream change.
const edits = [
  {
    "id": "dsh-tool-args-envelope",
    "before": "    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};",
    "after": "    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};\n    // The Web model sometimes duplicates the tool-call envelope inside arguments.\n    // Unwrap only an exact {name, arguments} with a matching tool name.\n    if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)\n        && parsedArgs.name === toolName && Object.prototype.hasOwnProperty.call(parsedArgs, 'arguments')\n        && Object.keys(parsedArgs).every(key => key === 'name' || key === 'arguments')\n        && parsedArgs.arguments && typeof parsedArgs.arguments === 'object' && !Array.isArray(parsedArgs.arguments)) {\n        parsedArgs = parsedArgs.arguments;\n    }"
  },
  {
    "id": "dsh-unkeyed-signature",
    "before": "function unkeyedAgentId(remoteAddr, userAgent) {",
    "after": "function unkeyedAgentId(remoteAddr, userAgent, messages = []) {"
  },
  {
    "id": "dsh-unkeyed-seed",
    "before": "    const digest = crypto.createHash('sha256').update(`${addr}\\u0000${ua}`, 'utf8').digest('hex').slice(0, 12);",
    "after": "    // DSH uses a shared User-Agent across distinct tasks and sends no x-agent-session.\n    // Keep one task's turns together without merging unrelated first user prompts.\n    const firstUser = Array.isArray(messages) ? messages.find(m => m && m.role === 'user') : null;\n    const firstText = firstUser ? normalizeMessageContent(firstUser.content) : '';\n    const taskSeed = /^deepseek-harness\\//i.test(ua) && firstText\n        ? crypto.createHash('sha256').update(firstText, 'utf8').digest('hex') : '';\n    const key = `${addr}\\u0000${ua}` + (taskSeed ? `\\u0000${taskSeed}` : '');\n    const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);"
  },
  {
    "id": "dsh-unkeyed-call",
    "before": "                : unkeyedAgentId(remoteAddr, req.headers['user-agent']);",
    "after": "                : unkeyedAgentId(remoteAddr, req.headers['user-agent'], messages);"
  },
  {
    "id": "web-tool-prompt",
    "before": "    text += 'Web: DeepSeek Search is already on. Answer in plain text with the findings. Do not use bash, curl, websearch, or webfetch for the web, and do not say you lack web access.\\n';",
    "after": "    text += toolFunctionNames(tools).some(name => /web_?search|web_?fetch|browser_search/i.test(name))\n        ? 'Web: Use the advertised web search/fetch tool for live facts. For GitHub source, use an available git/terminal tool to inspect real files when permitted; do not invent fetched content.\\n'\n        : 'Web: Native DeepSeek web search may be available depending on model settings. To read GitHub source, use an advertised git/terminal tool when permitted; otherwise state that source access is unavailable.\\n';"
  },
  {
    "id": "web-tool-reminder",
    "before": "        'Web: answer in text. DeepSeek Search is already on. Do not use bash or curl for the web.',",
    "after": "        names.some(name => /web_?search|web_?fetch|browser_search/i.test(name))\n            ? 'Web: Use the advertised web search/fetch tool. For GitHub source, use an advertised git/terminal tool when permitted.'\n            : 'Web: Use native search if enabled; to inspect GitHub source, use an advertised git/terminal tool when permitted.',"
  },
  {
    "id": "web-tool-repair",
    "before": "Do not. Answer in plain text from what you already know.",
    "after": "Do not call an unadvertised tool. If a web tool is available, use its exact advertised name; otherwise state that live source access is unavailable."
  },
  {
    "id": "pace-account-model-completions",
    "before": "async function askDeepSeekStream(prompt, agentId, model = DEFAULT_MODEL_ID, freshSessionPrompt = prompt, lockHolder = null, imageContext = null, webFlags = null) {",
    "after": "// Keep DeepSeek Web messages spaced without slowing output or local tools.\n// The existing per-account chat lock serializes concurrent DSH tasks.\nasync function paceAccountCompletion(account) {\n    const remaining = 15000 - (Date.now() - (account.lastCompletionSentAt || 0));\n    if (remaining > 0) await sleep(remaining);\n    account.lastCompletionSentAt = Date.now();\n}\n\nasync function askDeepSeekStream(prompt, agentId, model = DEFAULT_MODEL_ID, freshSessionPrompt = prompt, lockHolder = null, imageContext = null, webFlags = null) {"
  },
  {
    "id": "pace-completion-first",
    "before": "        const resp = await dsStreamFetch('https://chat.deepseek.com/api/v0/chat/completion', {",
    "after": "        await paceAccountCompletion(account);\n        const resp = await dsStreamFetch('https://chat.deepseek.com/api/v0/chat/completion', {"
  },
  {
    "id": "pace-completion-recreate",
    "before": "                const resp2 = await dsStreamFetch('https://chat.deepseek.com/api/v0/chat/completion', {",
    "after": "                await paceAccountCompletion(account);\n                const resp2 = await dsStreamFetch('https://chat.deepseek.com/api/v0/chat/completion', {"
  },
  {
    "id": "fenced-json-closing-delimiters",
    "before": "        absorbJsonToolPayload(fence[2].trim(), calls, seen);",
    "after": "        absorbJsonToolPayload(fence[2].trim(), calls, seen);\n        // Reuse the existing closing-delimiter-only repair for JSON fences too.\n        absorbJsonToolPayload(repairTruncatedJsonEnvelope(fence[2].trim()), calls, seen);"
  },
  {
    "id": "tool-markup-prose-field",
    "before": "    return /TOOL_CALL:\\s*[\\w-]+|<\\s*[|｜]*\\s*tool_call\\b|[|｜]+\\s*DSML\\s*[|｜]+|[<＜]\\s*\\/?\\s*(?:DSML)?(?:[\\w.-]+:)?(?:tool[\\s_-]*calls|function[\\s_-]*calls|invoke)\\b|[\"'](?:tool_call|tool_calls|function_call)[\"']\\s*:/i.test(String(text || ''));\r",
    "after": "    return /TOOL_CALL:\\s*[\\w-]+|<\\s*[|｜]*\\s*tool_call\\b|[|｜]+\\s*DSML\\s*[|｜]+|[<＜]\\s*\\/?\\s*(?:DSML)?(?:[\\w.-]+:)?(?:tool[\\s_-]*calls|function[\\s_-]*calls|invoke)\\b|\\{\\s*[\"'](?:tool_call|tool_calls|function_call)[\"']\\s*:/i.test(String(text || ''));\r"
  },
  {
    "id": "no-execute-source-code-fences",
    "before": "function collectAgentToolCalls(text, allowedToolNames) {\r\n    const allowed = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames || []);\r\n    if (!text || allowed.size === 0) return [];\r\n    const keepAllowed = (raw) => {\r\n        const calls = [];\r\n        const seen = new Set();\r\n        for (const call of raw) {\r\n            if (!call || !allowed.has(call.name)) continue;\r\n            rememberToolCall(calls, seen, call);\r\n            if (calls.length >= MAX_AGENT_TOOL_CALLS) break;\r\n        }\r\n        return calls;\r\n    };\r\n    const calls = keepAllowed(hasDsmlToolMarkup(text) ? listDsmlToolCalls(text) : collectJsonToolCalls(text));\r\n    if (calls.length > 0 || !hasDsmlToolMarkup(text)) return calls;\r\n    const repaired = keepAllowed(listDsmlToolCalls(repairGarbledDsmlStructure(text)));\r\n    if (repaired.length > 0) {\r\n        console.log(`[parseToolCall] Repaired garbled DSML structure: ${repaired.map(call => call.name).join(', ')}`);\r\n        return repaired;\r\n    }\r\n    const salvaged = salvageGarbledDsmlCalls(text);\r\n    if (salvaged.length === 0 || !salvaged.every(call => allowed.has(call.name))) return [];\r\n    console.log(`[parseToolCall] Salvaged garbled DSML: ${salvaged.map(call => call.name).join(', ')}`);\r\n    return keepAllowed(salvaged);\r\n}\r\n\r",
    "after": "// Source-code examples must never be interpreted as executable tool requests.\nfunction withoutSourceCodeFences(text) {\n    return String(text || '').replace(/```([a-zA-Z0-9#+_-]+)\\s*([\\s\\S]*?)```/gi,\n        (whole, language) => language.toLowerCase() === 'json' ? whole : '');\n}\nfunction collectAgentToolCalls(text, allowedToolNames) {\r\n    const allowed = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames || []);\n    const executableText = withoutSourceCodeFences(text);\r\n    if (!text || allowed.size === 0) return [];\r\n    const keepAllowed = (raw) => {\r\n        const calls = [];\r\n        const seen = new Set();\r\n        for (const call of raw) {\r\n            if (!call || !allowed.has(call.name)) continue;\r\n            rememberToolCall(calls, seen, call);\r\n            if (calls.length >= MAX_AGENT_TOOL_CALLS) break;\r\n        }\r\n        return calls;\r\n    };\r\n    const calls = keepAllowed(hasDsmlToolMarkup(executableText) ? listDsmlToolCalls(executableText) : collectJsonToolCalls(executableText));\r\n    if (calls.length > 0 || !hasDsmlToolMarkup(executableText)) return calls;\r\n    const repaired = keepAllowed(listDsmlToolCalls(repairGarbledDsmlStructure(executableText)));\r\n    if (repaired.length > 0) {\r\n        console.log(`[parseToolCall] Repaired garbled DSML structure: ${repaired.map(call => call.name).join(', ')}`);\r\n        return repaired;\r\n    }\r\n    const salvaged = salvageGarbledDsmlCalls(executableText);\r\n    if (salvaged.length === 0 || !salvaged.every(call => allowed.has(call.name))) return [];\r\n    console.log(`[parseToolCall] Salvaged garbled DSML: ${salvaged.map(call => call.name).join(', ')}`);\r\n    return keepAllowed(salvaged);\r\n}\r\n\r"
  },
  {
    "id": "no-false-markup-source-code-fences",
    "before": "function looksLikeToolCallMarkup(text) {",
    "after": "function looksLikeToolCallMarkup(text) {\n    text = withoutSourceCodeFences(text);"
  }
];

function patchSource(source) {
    let output = source;
    const makePattern = value => new RegExp(
        value.replace(/\r\n/g, '\n').replace(/\r$/, '')
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\n/g, '\\r?\\n'),
        'g'
    );
    for (const edit of edits) {
        const before = makePattern(edit.before);
        const after = makePattern(edit.after);
        const beforeCount = [...output.matchAll(before)].length;
        const afterCount = [...output.matchAll(after)].length;
        if (afterCount === 1 && beforeCount <= 1) {
            continue;
        }
        if (beforeCount === 1 && afterCount === 0) {
            const newline = output.includes('\r\n') ? '\r\n' : '\n';
            const replacement = edit.after.replace(/\r\n/g, '\n').replace(/\r$/, '')
                .replace(/\n/g, newline);
            output = output.replace(before, () => replacement);
        } else {
            throw new Error('Upstream changed near ' + edit.id + '; review the patch before launching.');
        }
    }
    return output;
}

if (require.main === module) {
    const upstream = process.argv[2] || path.resolve(__dirname, '..', 'runtime', 'upstream');
    const file = path.join(upstream, 'server.js');
    const source = fs.readFileSync(file, 'utf8');
    const patched = patchSource(source);
    if (patched !== source) fs.writeFileSync(file, patched, 'utf8');
    console.log(patched === source ? 'Web tool compatibility patch already installed' : 'Web tool compatibility patch applied');
}

module.exports = { patchSource };