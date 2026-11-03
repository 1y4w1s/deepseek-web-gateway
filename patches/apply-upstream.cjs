'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Minimal downstream compatibility fix for the upstream web-search instruction conflict.
// Fail instead of silently launching an unpatched adapter after an upstream change.
const edits = [
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
  }
];

function patchSource(source) {
    let output = source;
    for (const edit of edits) {
        const beforeCount = output.split(edit.before).length - 1;
        const afterCount = output.split(edit.after).length - 1;
        if (beforeCount === 1 && afterCount === 0) {
            output = output.replace(edit.before, edit.after);
        } else if (beforeCount === 0 && afterCount === 1) {
            continue; // already patched
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