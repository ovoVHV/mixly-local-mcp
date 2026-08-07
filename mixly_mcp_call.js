'use strict';

// Small command-line client for smoke-testing one tool without an MCP host.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const toolName = process.argv[2];
if (!toolName) {
  console.error('Usage: node mixly_mcp_call.js <tool-name> [json-arguments|--args-file path|@path|-]');
  process.exit(2);
}

let toolArguments = {};
try {
  const argumentSpec = process.argv[3];
  let argumentText = argumentSpec || '';
  if (argumentSpec === '--args-file') {
    if (!process.argv[4]) throw new Error('缺少 --args-file 路径');
    argumentText = fs.readFileSync(path.resolve(process.argv[4]), 'utf8');
  } else if (argumentSpec && argumentSpec.startsWith('@')) {
    argumentText = fs.readFileSync(path.resolve(argumentSpec.slice(1)), 'utf8');
  } else if (argumentSpec === '-') {
    argumentText = fs.readFileSync(0, 'utf8');
  }
  toolArguments = argumentText ? JSON.parse(argumentText) : {};
} catch (error) {
  console.error(`Invalid JSON arguments: ${error.message}`);
  process.exit(2);
}

const child = spawn(process.execPath, [path.join(__dirname, 'mixly_mcp_server.js')], {
  cwd: path.resolve(__dirname, '..'),
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit']
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
let initialized = false;

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 1 && !initialized) {
    initialized = true;
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArguments }
    })}\n`);
    return;
  }
  if (message.id !== 2) return;
  if (message.result && message.result.isError) {
    console.error(message.result.content[0].text);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(message.result.structuredContent, null, 2));
  }
  child.stdin.end();
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'mixly-mcp-call', version: '1.0.0' }
  }
})}\n`);
