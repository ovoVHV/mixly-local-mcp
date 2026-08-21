'use strict';

// End-to-end Mixly 4 plugin test. By default it uses an isolated profile;
// MIXLY4_EXTERNAL_CDP=1 reuses an explicitly supplied browser/CDP host.
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const workspaceRoot = __dirname;
const mixlyHome = path.resolve(process.env.MIXLY4_HOME || 'E:/mixly4_win-x86/mixly4_win');
const serverPath = path.join(workspaceRoot, 'mixly_mcp_server.js');
const validatePath = path.join(workspaceRoot, 'validate_mixly_workspace.js');
const stamp = `${process.pid}-${Date.now()}`;
const testRoot = path.join(mixlyHome, `.mixly4-mcp-live-${stamp}`);
const profilePath = path.join(mixlyHome, `.mixly4-mcp-live-profile-${stamp}`);
const libraryName = `McpLive_${process.pid}_${Date.now()}`;
const blockType = `mixly4_mcp_live_${process.pid}`;
const board = 'default/arduino_avr';
const boardType = 'Arduino AVR';
const externalCdp = process.env.MIXLY4_EXTERNAL_CDP === '1';
const cdpPort = Number(process.env.MIXLY4_TEST_CDP_PORT || (19000 + (process.pid % 900)));
const expectedOrigin = process.env.MIXLY4_TEST_ORIGIN || 'http://localhost:65234';
const zipPath = path.join(testRoot, `${libraryName}.zip`);
const projectPath = path.join(testRoot, 'fixture.mix');
const outputPath = path.join(testRoot, 'fixture.ino');
const stagingPath = path.join(
  mixlyHome,
  '.mixly-mcp-staging',
  'libraries',
  'default__arduino_avr',
  libraryName
);

let child = null;
let lineReader = null;
let stderr = '';
let nextId = 0;
const pending = new Map();
let launchResult = null;
let baselineProcesses = [];

function writeFile(relativePath, content) {
  const destination = path.join(testRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf8');
}

function processSnapshot() {
  const command = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  try {
    const value = JSON.parse(result.stdout);
    return (Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId),
      name: String(item.Name || ''),
      executablePath: String(item.ExecutablePath || ''),
      commandLine: String(item.CommandLine || '')
    })).filter((item) => Number.isInteger(item.pid) && item.pid > 0);
  } catch (_) {
    return [];
  }
}

function pathIsInside(candidate, root) {
  if (!candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function existingMixlyProcesses() {
  const root = mixlyHome.toLowerCase();
  return processSnapshot().filter((item) => {
    const exe = item.executablePath.toLowerCase();
    const commandLine = item.commandLine.toLowerCase();
    return exe.startsWith(root) || commandLine.includes(root);
  });
}

function portOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function startServer() {
  child = spawn(process.execPath, [serverPath], {
    cwd: workspaceRoot,
    env: { ...process.env, MIXLY_HOME: mixlyHome },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  lineReader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  lineReader.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    request.resolve(message);
  });
  child.on('exit', (code) => {
    if (!pending.size) return;
    const error = new Error(`MCP server exited before replying (code ${code})`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
}

// Slightly above the server COMMAND_TIMEOUT_MS (180s) so a cold-start import
// fails on the server with diagnostics instead of orphaning a client timeout.
function request(method, params = {}, timeoutMs = 210000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request timed out: ${method} ${params.name || ''}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function call(name, args) {
  const response = await request('tools/call', { name, arguments: args });
  assert(response.result, `${name} returned no result: ${JSON.stringify(response)}`);
  if (response.result.isError !== undefined) {
    assert.equal(
      response.result.isError,
      false,
      `${name} failed: ${response.result.content && response.result.content[0]?.text}`
    );
  }
  return response.result.structuredContent;
}

function parseCdpOutput(stdout) {
  const outer = JSON.parse(stdout.trim());
  if (typeof outer === 'string') return JSON.parse(outer);
  return outer;
}

function evaluateCdp(expression, timeoutMs = 120000) {
  const result = spawnSync(process.execPath, [validatePath, expression], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      MIXLY_CDP_PORT: String(cdpPort),
      MIXLY_EXPECTED_ORIGIN: expectedOrigin,
      MIXLY_MIXLY4: '1'
    },
    windowsHide: true,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CDP expression failed: ${result.stderr || result.stdout}`);
  }
  return parseCdpOutput(result.stdout);
}

function cleanupStaging() {
  if (!pathIsInside(stagingPath, mixlyHome) || !stagingPath.endsWith(libraryName)) {
    throw new Error(`Refusing to clean staging path: ${stagingPath}`);
  }
  fs.rmSync(stagingPath, { recursive: true, force: true });
}

function stopServer() {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return request('shutdown', {}, 10000)
    .catch(() => {})
    .then(() => new Promise((resolve) => {
      child.stdin.end();
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    }));
}

function stopOwnedMixly() {
  if (externalCdp) return;
  const baseline = new Set(baselineProcesses.map((item) => item.pid));
  const marker = profilePath.toLowerCase();
  const portMarker = `remote-debugging-port=${cdpPort}`;
  const candidates = processSnapshot().filter((item) => {
    if (baseline.has(item.pid)) return false;
    const commandLine = item.commandLine.toLowerCase();
    const executable = item.executablePath.toLowerCase();
    return commandLine.includes(marker) || commandLine.includes(portMarker) || executable.startsWith(mixlyHome.toLowerCase());
  });
  for (const item of candidates) {
    const commandLine = item.commandLine.toLowerCase();
    const executable = item.executablePath.toLowerCase();
    if (!commandLine.includes(marker) && !commandLine.includes(portMarker) && !executable.startsWith(mixlyHome.toLowerCase())) continue;
    spawnSync('taskkill.exe', ['/PID', String(item.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  }
}

function removeOwnedFiles() {
  for (const target of [testRoot, profilePath]) {
    if (!pathIsInside(target, mixlyHome)) throw new Error(`Refusing to clean path outside Mixly root: ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  cleanupStaging();
}

function createProject() {
  writeFile('fixture.mix', [
    '<xml version="Mixly 2.0 rc2" board="Arduino AVR@Arduino/Genuino Uno">',
    `  <block type="${blockType}" x="40" y="40">`,
    '    <value name="VALUE">',
    '      <shadow type="math_number"><field name="NUM">7</field></shadow>',
    '    </value>',
    '  </block>',
    '</xml>',
    ''
  ].join('\n'));
}

async function main() {
  if (!fs.existsSync(path.join(mixlyHome, 'Mixly.exe'))) throw new Error(`Mixly 4 executable not found: ${mixlyHome}`);
  baselineProcesses = existingMixlyProcesses();
  if (!externalCdp) {
    if (baselineProcesses.length) {
      throw new Error(`Refusing to reuse or stop an existing Mixly process: ${baselineProcesses.map((item) => item.pid).join(', ')}`);
    }
    if (await portOpen(65234)) throw new Error('Mixly HTTP port 65234 is already in use; refusing to reuse it');
    if (await portOpen(cdpPort)) throw new Error(`CDP port ${cdpPort} is already in use; refusing to reuse it`);
  } else {
    const httpPort = Number(new URL(expectedOrigin).port || (expectedOrigin.startsWith('https:') ? 443 : 80));
    if (!(await portOpen(httpPort))) throw new Error(`MIXLY4_EXTERNAL_CDP requires Mixly HTTP host ${expectedOrigin}`);
    if (!(await portOpen(cdpPort))) throw new Error(`MIXLY4_EXTERNAL_CDP requires CDP port ${cdpPort}`);
  }

  fs.mkdirSync(testRoot, { recursive: true });
  createProject();
  startServer();
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mixly4-live-plugin-import', version: '1.0.0' }
  });

  const environment = await call('mixly_detect_environment', { probeCli: false, cdpPort });
  assert.equal(environment.mixlyLayout.generation, 4);
  assert.equal(environment.mixlyLayout.runtime, 'nwjs');
  assert(environment.boards.some((item) => item.id === board), `Board ${board} not present in catalog`);

  const created = await call('mixly_create_library', {
    libraryName,
    board,
    version: '1.0.0',
    overwrite: true,
    blocksJs: [
      `Blockly.Blocks['${blockType}'] = {`,
      '  init: function() {',
      "    this.appendValueInput('VALUE').appendField('MCP live fixture');",
      '    this.setPreviousStatement(true);',
      '    this.setNextStatement(true);',
      '  }',
      '};'
    ].join('\n'),
    generatorsJs: [
      `Blockly.Arduino.forBlock['${blockType}'] = function(block) {`,
      "  const value = Blockly.Arduino.valueToCode(block, 'VALUE', Blockly.Arduino.ORDER_NONE) || '0';",
      "  return `fixtureSet(${value});\\n`;",
      '};'
    ].join('\n'),
    toolboxXml: [
      '<xml>',
      '  <category name="MCP live fixture">',
      `    <block type="${blockType}">`,
      '      <value name="VALUE"><shadow type="math_number"><field name="NUM">7</field></shadow></value>',
      '    </block>',
      '  </category>',
      '</xml>'
    ].join('\n'),
    primitiveReasons: [{
      type: blockType,
      reason: 'A minimal unique block verifies real Mixly 4 plugin mounting and code generation.',
      officialCandidatesChecked: ['controls_delay']
    }]
  });
  assert.equal(created.format, 'mixly4-plugin-staging');
  assert.equal(created.staging, true);
  assert(fs.existsSync(path.join(stagingPath, 'plugin.json')));

  const packaged = await call('mixly_package_library', { board, library: libraryName, outputPath: zipPath });
  assert.deepEqual(packaged.entries, ['index.js', 'index.xml', 'plugin.json']);
  assert(fs.existsSync(zipPath));

  if (externalCdp) {
    launchResult = await call('mixly_launch', { cdpPort, waitMs: 5000 });
    assert.equal(launchResult.alreadyRunning, true, `External host was not detected: ${JSON.stringify(launchResult)}`);
    assert.equal(launchResult.pid, null, `External host must not be owned by the test: ${JSON.stringify(launchResult)}`);
    assert.equal(launchResult.cdpPort, cdpPort);
    assert.equal(launchResult.runtime.automation.available, true, JSON.stringify(launchResult.runtime));
  } else {
    launchResult = await call('mixly_launch', { cdpPort, profilePath, waitMs: 90000 });
    assert.equal(launchResult.alreadyRunning, false, `Unexpectedly reused Mixly: ${JSON.stringify(launchResult)}`);
    assert(launchResult.pid, 'Mixly launch did not return a process id');
    assert.equal(launchResult.cdpPort, cdpPort);
    assert.equal(launchResult.runtime.generation, 4);
    assert.equal(launchResult.runtime.httpOrigin, 'http://localhost:65234');
  }

  const imported = await call('mixly_import_library', {
    zipPath,
    libraryName,
    board,
    cdpPort,
    waitMs: 90000
  });
  assert.equal(imported.format, 'mixly4-plugin');
  assert.equal(imported.installed, true);
  assert.equal(imported.metadata.id, libraryName);
  assert.equal(imported.metadata.dir, libraryName);

  const runtime = evaluateCdp(`(async()=>{const manager=Mixly.PluginManager||Mixly.StatusBarPlugin;const root=typeof manager.getStorageRoot==='function'?manager.getStorageRoot():'plugins/libraries/${boardType}';const text=await manager.fs.readFile(root+'/installed.json','utf8');const manifest=JSON.parse(text);const info=manifest.plugins[${JSON.stringify(libraryName)}];const mounted=manager.runtimePlugins&&manager.runtimePlugins.get(${JSON.stringify(libraryName)});const generator=(typeof Blockly==='object'&&(Blockly.generator||Blockly.Arduino))||{};return JSON.stringify({storageRoot:root,manifestFound:Boolean(info),installedDir:info&&info.dir,installedVersion:info&&info.currentVersion,libraryFiles:info&&info.libraryFiles||[],runtimeMounted:Boolean(mounted),runtimeBlockTypes:mounted?Object.keys(mounted.blocks||{}):[],runtimeGeneratorTypes:mounted?Object.keys(mounted.generators||{}):[],blockRegistered:Boolean(Blockly.Blocks&&Blockly.Blocks[${JSON.stringify(blockType)}]),generatorRegistered:Boolean(generator.forBlock&&typeof generator.forBlock[${JSON.stringify(blockType)}]==='function'),toolboxRegistered:Boolean((Mixly.Env&&Mixly.Env.thirdPartyXML||[]).some((xml)=>String(xml).includes(${JSON.stringify(blockType)})))})})()`);
  assert.equal(runtime.manifestFound, true, JSON.stringify(runtime));
  assert.equal(runtime.installedDir, libraryName, JSON.stringify(runtime));
  assert.equal(runtime.runtimeMounted, true, JSON.stringify(runtime));
  assert.equal(runtime.blockRegistered, true, JSON.stringify(runtime));
  assert.equal(runtime.generatorRegistered, true, JSON.stringify(runtime));
  assert.equal(runtime.toolboxRegistered, true, JSON.stringify(runtime));

  const scanned = await call('mixly_scan_library', { board, cdpPort, query: blockType });
  const installed = scanned.thirdParty.find((item) => item.name === libraryName);
  assert(installed, `Imported plugin missing from scan: ${JSON.stringify(scanned.thirdParty)}`);
  assert.equal(installed.source, 'mixly4-opfs');
  assert(scanned.availableBlockTypes.includes(blockType));

  const specs = await call('mixly_get_block_specs', { board, blockTypes: [blockType], includeSource: true, cdpPort });
  assert.equal(specs.found, 1);
  assert.equal(specs.specs[0].owner, `Plugin/${libraryName}`);

  const validation = await call('mixly_validate_project', {
    projectPath,
    customPrefixes: ['mixly4_mcp_live_'],
    cdpPort
  });
  assert.equal(validation.passed, true, JSON.stringify(validation));
  assert(validation.customTypes.includes(blockType));

  const generated = await call('mixly_generate_code', { projectPath, outputPath, generator: 'Arduino', cdpPort });
  assert.equal(generated.totalNodes, 2, 'statement block plus numeric shadow should both load');
  const code = fs.readFileSync(outputPath, 'utf8');
  assert.match(code, /fixtureSet\(7\);/);

  const removed = evaluateCdp(`(async()=>{const manager=Mixly.PluginManager||Mixly.StatusBarPlugin;await manager.uninstallPlugin(${JSON.stringify(libraryName)});const text=await manager.fs.readFile(${JSON.stringify(`plugins/libraries/${boardType}/installed.json`)},'utf8').catch(()=> '');const manifest=text?JSON.parse(text):{plugins:{}};return JSON.stringify({removed:!manifest.plugins[${JSON.stringify(libraryName)}],runtimeMounted:Boolean(manager.runtimePlugins&&manager.runtimePlugins.get(${JSON.stringify(libraryName)}))})})()`);
  assert.equal(removed.removed, true, JSON.stringify(removed));
  assert.equal(removed.runtimeMounted, false, JSON.stringify(removed));

  console.log('Mixly 4 live plugin import passed');
  console.log(JSON.stringify({ hostMode: externalCdp ? 'external' : 'isolated', libraryName, blockType, cdpPort, runtime, generated: { generator: generated.generator, code: code.trim() } }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(async () => {
  try { await stopServer(); } catch (_) { /* best effort */ }
  stopOwnedMixly();
  try { removeOwnedFiles(); } catch (error) { console.error(`Cleanup failed: ${error.message}`); process.exitCode = 1; }
});
