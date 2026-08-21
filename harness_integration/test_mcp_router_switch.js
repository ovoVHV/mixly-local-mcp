'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

function writeContext(contextPath, mixlyHome, generation) {
  fs.writeFileSync(contextPath, `${JSON.stringify({
    mixlyHome,
    generation: String(generation),
    cdpPort: '',
    origin: ''
  })}\n`, 'utf8');
}

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-mcp-router-'));
  const mixly2Root = path.join(temporaryRoot, 'mixly2');
  const mixly4Root = path.join(temporaryRoot, 'mixly4');
  const contextPath = path.join(temporaryRoot, 'active-context.json');
  fs.mkdirSync(path.join(mixly2Root, 'resources', 'app', 'src', 'boards'), { recursive: true });
  fs.mkdirSync(path.join(mixly4Root, 'boards'), { recursive: true });
  fs.writeFileSync(path.join(mixly4Root, 'package.json'), `${JSON.stringify({
    name: 'Mixly',
    version: '4.0-test',
    'node-main': './static-server/server.js'
  })}\n`, 'utf8');
  writeContext(contextPath, mixly2Root, 2);

  const child = spawn(process.execPath, [path.join(__dirname, 'mcp_router.js')], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      MIXLY_CONTEXT_FILE: contextPath,
      MIXLY_MCP_NODE: process.execPath,
      MIXLY_MCP_SERVER: path.join(__dirname, '..', 'mixly_mcp_server.js')
    }
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  let nextId = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Router test timed out: ${method}`));
    }, 20000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'router-switch-test', version: '1' }
    });
    assert(initialized.result);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const mixly2 = await request('tools/call', { name: 'mixly_detect_environment', arguments: {} });
    assert.match(JSON.stringify(mixly2.result), /"generation"\s*:\s*2/);

    writeContext(contextPath, mixly4Root, 4);
    const stillMixly2 = await request('tools/call', { name: 'mixly_detect_environment', arguments: {} });
    assert.match(JSON.stringify(stillMixly2.result), /"generation"\s*:\s*2/);
    assert.doesNotMatch(JSON.stringify(stillMixly2.result), /"generation"\s*:\s*4/);
    process.stdout.write('Harness MCP router kept its pinned Mixly 2 context after the context file changed.\n');
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
