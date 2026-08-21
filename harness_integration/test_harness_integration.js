'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const launcher = require('./launcher');
const installer = require('./install');

function listCompactTools() {
  const serverPath = path.join(__dirname, '..', 'mixly_mcp_server.js');
  const routerPath = path.join(__dirname, 'mcp_router.js');
  const mixlyHome = path.resolve(__dirname, '..', '..');
  const contextPath = path.join(__dirname, `.tmp-router-context-${process.pid}.json`);
  fs.writeFileSync(contextPath, `${JSON.stringify({
    mixlyHome,
    generation: '2',
    cdpPort: '',
    origin: ''
  })}\n`, 'utf8');
  const child = spawn(process.execPath, [routerPath], {
    cwd: path.join(__dirname, '..'),
    windowsHide: true,
    env: {
      ...process.env,
      MIXLY_CONTEXT_FILE: contextPath,
      MIXLY_MCP_NODE: process.execPath,
      MIXLY_MCP_SERVER: serverPath
    },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Compact MCP tools/list timed out'));
    }, 10000);
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      } else if (message.id === 2) {
        clearTimeout(timer);
        child.stdin.end();
        fs.rmSync(contextPath, { force: true });
        resolve(message.result.tools.map((tool) => tool.name));
      }
    });
    child.on('error', (error) => {
      fs.rmSync(contextPath, { force: true });
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'harness-test', version: '1' } }
    })}\n`);
  });
}

async function main() {
  assert.deepEqual(launcher.parseArgs(['--mixly-home', 'C:\\Mixly', '--generation', '4']), {
    'mixly-home': 'C:\\Mixly',
    generation: '4'
  });
  assert.equal(launcher.instanceKey('C:\\Mixly'), launcher.instanceKey('c:\\mixly'));
  const port = await launcher.choosePort();
  assert(port >= 3080 && port <= 3099);

  const adapterSource = fs.readFileSync(path.join(__dirname, 'adapter', 'mixly_harness_adapter.js'), 'utf8');
  new vm.Script(adapterSource, { filename: 'mixly_harness_adapter.js' });
  assert(adapterSource.includes('mixly-harness-frame'));
  assert(adapterSource.includes('event.isTrusted'));
  assert(adapterSource.includes('Mixly AI · Mixly'));
  assert(adapterSource.includes('mixly-harness-panel-state-v1'));
  assert(adapterSource.includes("candidate('fs')"));
  assert(!adapterSource.includes('nw.Window.open'));
  assert(!adapterSource.includes("layui-btn-primary mixly-nav"));
  const mixly4Fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly4-harness-global-'));
  try {
    fs.mkdirSync(path.join(mixly4Fixture, 'boards'), { recursive: true });
    fs.writeFileSync(path.join(mixly4Fixture, 'boards', 'index.html'), '<html><body></body></html>', 'utf8');
    const installed = installer.patchBoardsHtml(mixly4Fixture, 4);
    installer.patchBoardsHtml(mixly4Fixture, 4);
    const patchedHtml = fs.readFileSync(installed.htmlPath, 'utf8');
    assert(patchedHtml.includes('data-mixly-generation="4"'));
    assert.equal((patchedHtml.match(/mixly-harness:start/g) || []).length, 1);
    assert(fs.existsSync(installed.adapterPath));
  } finally {
    fs.rmSync(mixly4Fixture, { recursive: true, force: true });
  }
  const pluginSource = fs.readFileSync(path.join(__dirname, 'mixly4_plugin', 'index.js'), 'utf8');
  assert(pluginSource.includes("export { blocks, generators }"));
  assert(pluginSource.includes('mixly_harness_adapter.js'));

  const patch = fs.readFileSync(path.join(__dirname, 'config', 'mixly-mcp.cordis.yml'), 'utf8');
  assert(patch.includes("name: '@deepseek-ai/dsh-mcp-client'"));
  assert(patch.includes('MIXLY_MCP_ROUTER'));
  const tools = await listCompactTools();
  assert.equal(tools.length, 9);
  assert(tools.includes('mixly_build_project'));
  assert(tools.includes('mixly_project_workflow'));
  assert(!tools.includes('mixly_compile'));
  process.stdout.write('Harness integration static tests passed.\n');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
