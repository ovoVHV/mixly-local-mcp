'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const archivePath = path.join(root, 'Mixly_Local_MCP_v2.3.0.zip');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-local-mcp-package-'));
const compressing = require(path.join(root, 'resources', 'app', 'node_modules', 'compressing'));
const yauzl = require(path.join(root, 'resources', 'app', 'node_modules', 'yauzl'));

function zipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
      if (error) return reject(error);
      const entries = [];
      zipFile.on('entry', (entry) => { entries.push(entry.fileName); zipFile.readEntry(); });
      zipFile.on('end', () => resolve(entries));
      zipFile.on('error', reject);
      zipFile.readEntry();
    });
  });
}

async function callPackagedServer(serverPath) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: temporaryRoot,
    env: { ...process.env, MIXLY_HOME: root },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let stderr = '';
  let initialization;
  let environment;
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged MCP timeout: ${stderr}`));
    }, 60000);
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        initialization = message.result;
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'mixly_detect_environment', arguments: { probeCli: false } }
        })}\n`);
      } else if (message.id === 2) {
        environment = message.result.structuredContent;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`);
      } else if (message.id === 3) {
        clearTimeout(timer);
        child.stdin.end();
        child.once('close', () => resolve({ initialization, environment, tools: message.result.tools }));
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'package-test', version: '1' } }
    })}\n`);
  });
}

function callPackagedValidator(validatorPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      validatorPath,
      'JSON.stringify({ready:document.readyState,blockly:typeof Blockly})'
    ], {
      cwd: temporaryRoot,
      env: { ...process.env, MIXLY_CDP_PORT: '9333' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Packaged validator failed: ${stderr}`));
      let value = JSON.parse(stdout.trim());
      if (typeof value === 'string') value = JSON.parse(value);
      resolve(value);
    });
  });
}

function runPackagedScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(scriptPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Packaged script failed: ${stderr || stdout}`));
      resolve(stdout.trim());
    });
  });
}

async function main() {
  try {
    const entries = await zipEntries(archivePath);
    assert.equal(entries.filter((entry) => entry.endsWith('/')).length, 0);
    assert(entries.includes('MixlyLocalMCP/mixly_mcp_server.js'));
    assert(entries.includes('MixlyLocalMCP/mixly_code_equivalence.js'));
    assert(entries.includes('MixlyLocalMCP/test_mixly_code_equivalence.js'));
    assert(entries.includes('MixlyLocalMCP/node_modules/ws/index.js'));
    await compressing.zip.uncompress(archivePath, temporaryRoot, { zipFileNameEncoding: 'GBK' });
    const serverPath = path.join(temporaryRoot, 'MixlyLocalMCP', 'mixly_mcp_server.js');
    const equivalenceTestPath = path.join(
      temporaryRoot, 'MixlyLocalMCP', 'test_mixly_code_equivalence.js'
    );
    const readme = fs.readFileSync(path.join(temporaryRoot, 'MixlyLocalMCP', 'README.md'), 'utf8');
    const packaged = await callPackagedServer(serverPath);
    const equivalenceTest = await runPackagedScript(equivalenceTestPath);
    const validator = await callPackagedValidator(path.join(
      temporaryRoot, 'MixlyLocalMCP', 'validate_mixly_workspace.js'
    ));
    assert.equal(packaged.initialization.serverInfo.version, '2.3.0');
    assert.match(readme, /^# Mixly Local MCP 2\.3\.0/m);
    assert.match(readme, /mixly_get_board_profiles/);
    assert.match(readme, /mixly_verify_equivalence/);
    assert.match(readme, /behavioral-strict/);
    assert.match(readme, /保守静态审计/);
    assert.match(readme, /GitHub Issues/);
    assert.match(readme, /gitee\.com\/mixly2\/mixly2\.0-win32-x64\/issues/);
    assert.match(readme, /gitee\.com\/mixly2\/mixly2\.0_src\/issues/);
    assert.match(packaged.initialization.instructions, /官方目录和 libraries\/ThirdParty/);
    assert.match(packaged.initialization.instructions, /无需修改 MCP/);
    assert.equal(packaged.environment.mixlyRoot, root);
    assert(packaged.environment.boards.length > 5);
    assert(packaged.tools.some((tool) => tool.name === 'mixly_get_block_specs'));
    assert(packaged.tools.some((tool) => tool.name === 'mixly_get_board_profiles'));
    assert(packaged.tools.some((tool) => tool.name === 'mixly_build_project'));
    assert(packaged.tools.some((tool) => tool.name === 'mixly_verify_equivalence'));
    assert(packaged.tools.some((tool) => tool.name === 'mixly_project_workflow'));
    const equivalenceDefinition = packaged.tools.find(
      (tool) => tool.name === 'mixly_verify_equivalence'
    );
    const workflowDefinition = packaged.tools.find(
      (tool) => tool.name === 'mixly_project_workflow'
    );
    assert.deepEqual(equivalenceDefinition.inputSchema.properties.mode.enum, [
      'report', 'behavioral-strict', 'exact'
    ]);
    assert.equal(equivalenceDefinition.inputSchema.properties.supportPaths.type, 'array');
    assert.equal(equivalenceDefinition.inputSchema.properties.requiredPatterns.type, 'array');
    assert.deepEqual(workflowDefinition.inputSchema.properties.equivalenceMode.enum, [
      'report', 'behavioral-strict', 'exact'
    ]);
    assert.equal(workflowDefinition.inputSchema.properties.equivalenceSupportPaths.type, 'array');
    assert.equal(workflowDefinition.inputSchema.properties.equivalenceRequiredPatterns.type, 'array');
    assert.match(equivalenceTest, /equivalence audit passed/);
    assert.equal(validator.blockly, 'object');
    console.log(`Portable MCP package passed: ${entries.length} files / 0 directories`);
    console.log(`Packaged server detected ${packaged.environment.boards.length} installed board entries via MIXLY_HOME`);
    console.log('Packaged CDP validator used its local WebSocket dependency successfully');
  } finally {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== 'EBUSY' || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
