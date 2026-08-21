'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const repoRoot = __dirname;
const mixlyRoot = process.env.MIXLY4_HOME || 'E:\\mixly4_win-x86\\mixly4_win';
const cdpPort = Number(process.env.MIXLY4_TEST_CDP_PORT || 9347);
const board = 'default/arduino_avr';
const suffix = `${process.pid}`;
const libraryName = `Mixly4RealFixture${suffix}`;
const blockType = `mixly4_real_fixture_${suffix}`;
const testRoot = path.join(mixlyRoot, `.mixly4-mcp-real-test-${suffix}`);
const profilePath = path.join(testRoot, 'profile');
const zipPath = path.join(testRoot, `${libraryName}.zip`);
const projectPath = path.join(testRoot, 'fixture.mix');
const outputPath = path.join(testRoot, 'fixture.ino');
const stagingPath = path.join(mixlyRoot, '.mixly-mcp-staging', 'libraries', 'default__arduino_avr', libraryName);
const serverPath = path.join(repoRoot, 'mixly_mcp_server.js');
const helperPath = path.join(repoRoot, 'validate_mixly_workspace.js');

let child;
let output;
let stderr = '';
let nextId = 0;
const pending = new Map();
let launchedPid = null;

function assertInsideRoot(target) {
  const relative = path.relative(mixlyRoot, path.resolve(target));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `unsafe test path: ${target}`);
}

function cleanupPath(target) {
  assertInsideRoot(target);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function startServer() {
  child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: { ...process.env, MIXLY_HOME: mixlyRoot },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  output.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch (error) {
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

function request(method, params = {}, timeoutMs = 180000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`request timed out: ${method}`));
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
  assert.equal(
    response.result.isError,
    undefined,
    `${name} failed: ${response.result.content && response.result.content[0].text}`
  );
  return response.result.structuredContent;
}

function evaluate(expression) {
  const result = spawnSync(process.execPath, [helperPath, expression], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIXLY_CDP_PORT: String(cdpPort),
      MIXLY_EXPECTED_ORIGIN: 'http://localhost:65234',
      MIXLY_MIXLY4: '1'
    },
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true
  });
  assert.equal(result.status, 0, `CDP evaluation failed: ${result.stderr || result.stdout}`);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  try {
    await request('shutdown', {}, 5000);
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  } catch (_) {
    child.kill();
  }
}

function stopLaunchedMixly() {
  if (!launchedPid) return;
  const pid = Number(launchedPid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  });
  launchedPid = null;
}

function createProjectXml() {
  return [
    '<xml xmlns="https://developers.google.com/blockly/xml" board="Arduino AVR">',
    `  <block type="${blockType}" id="fixture-block" x="20" y="20">`,
    '    <field name="MODE">RUN</field>',
    '    <value name="VALUE">',
    '      <shadow type="math_number" id="fixture-number">',
    '        <field name="NUM">7</field>',
    '      </shadow>',
    '    </value>',
    '  </block>',
    '</xml>'
  ].join('\n');
}

async function main() {
  assert(fs.existsSync(path.join(mixlyRoot, 'Mixly.exe')), `Mixly 4 not found: ${mixlyRoot}`);
  cleanupPath(testRoot);
  fs.mkdirSync(testRoot, { recursive: true });
  startServer();
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mixly4-real-import-test', version: '1.0.0' }
  });

  const environment = await call('mixly_detect_environment', { probeCli: false, cdpPort });
  assert.equal(environment.mixlyLayout.generation, 4);
  assert.equal(environment.mixlyLayout.runtime, 'nwjs');

  await call('mixly_create_library', {
    libraryName,
    board,
    version: '1.0.0',
    overwrite: true,
    blocksJs: [
      `Blockly.Blocks['${blockType}'] = {`,
      '  init: function() {',
      "    this.appendDummyInput().appendField('Mode', 'MODE');",
      "    this.appendValueInput('VALUE').setCheck('Number');",
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
      '  <category name="Real Fixture">',
      `    <block type="${blockType}">`,
      '      <value name="VALUE"><shadow type="math_number"><field name="NUM">7</field></shadow></value>',
      '    </block>',
      '  </category>',
      '</xml>'
    ].join('\n'),
    primitiveReasons: [{
      type: blockType,
      reason: 'Real Mixly 4 import and code-generation integration fixture.',
      officialCandidatesChecked: ['controls_delay']
    }]
  });

  const launched = await call('mixly_launch', {
    cdpPort,
    profilePath,
    waitMs: 60000
  });
  assert.equal(launched.alreadyRunning, false, 'refusing to modify an already-running Mixly instance');
  launchedPid = launched.pid;
  assert(Number.isInteger(launchedPid) && launchedPid > 0, `launch did not return a PID: ${JSON.stringify(launched)}`);

  const packaged = await call('mixly_package_library', {
    board,
    library: libraryName,
    outputPath: zipPath,
    cdpPort
  });
  assert.equal(packaged.source, 'mixly4-staging');
  assert(packaged.entries.includes('index.js'));
  assert(packaged.entries.every((entry) => !entry.startsWith(`${libraryName}/`)));

  const imported = await call('mixly_import_library', {
    board,
    libraryName,
    zipPath,
    cdpPort,
    waitMs: 60000
  });
  assert.equal(imported.format, 'mixly4-plugin');
  assert.equal(imported.metadata.id, libraryName);
  assert.equal(imported.installed, true);

  const scanned = await call('mixly_scan_library', { board, cdpPort, query: blockType });
  const installed = scanned.thirdParty.find((item) => item.name === libraryName);
  assert(installed, `installed plugin absent from scan: ${JSON.stringify(scanned.thirdParty)}`);
  assert.equal(installed.source, 'mixly4-opfs');
  assert(scanned.thirdPartyBlockTypes.includes(blockType));

  const runtime = evaluate(`JSON.stringify({type:${JSON.stringify(blockType)},block:!!(Blockly.Blocks&&Blockly.Blocks[${JSON.stringify(blockType)}]),generator:!!(Blockly.Arduino&&Blockly.Arduino.forBlock&&Blockly.Arduino.forBlock[${JSON.stringify(blockType)}]),plugin:!!(Mixly.PluginManager&&Mixly.PluginManager.runtimePlugins&&[...Mixly.PluginManager.runtimePlugins].some((item)=>String(item.id||item.name||'')===${JSON.stringify(libraryName)}))})`);
  assert.equal(runtime.block, true, JSON.stringify(runtime));
  assert.equal(runtime.generator, true, JSON.stringify(runtime));

  const projectXml = createProjectXml();
  const saved = await call('mixly_save_project', {
    board,
    projectPath,
    projectXml,
    overwrite: true,
    requireChineseNames: false,
    cdpPort
  });
  assert.equal(saved.projectPath, projectPath);
  const opened = await call('mixly_open_project', { board, projectPath, cdpPort, waitMs: 60000 });
  assert.equal(opened.loaded.loaded, true, JSON.stringify(opened));
  const validated = await call('mixly_validate_project', {
    board,
    projectPath,
    customPrefixes: ['mixly4_real_fixture_'],
    requireChineseNames: false,
    cdpPort
  });
  assert.equal(validated.passed, true, JSON.stringify(validated));
  assert(validated.customTypes.includes(blockType), JSON.stringify(validated));

  const generated = await call('mixly_generate_code', {
    projectPath,
    outputPath,
    cdpPort
  });
  assert(fs.existsSync(outputPath));
  const code = fs.readFileSync(outputPath, 'utf8');
  assert.match(code, /fixtureSet\(7\)/, code);
  assert(generated.codeLength > 0, JSON.stringify(generated));
  console.log('Mixly 4 real import and block code generation passed');
  console.log(JSON.stringify({ libraryName, blockType, cdpPort, installedSource: installed.source, code }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  stopLaunchedMixly();
  for (const target of [testRoot, stagingPath]) {
    try { cleanupPath(target); } catch (error) { console.error(error.message); }
  }
});
