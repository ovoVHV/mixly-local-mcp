'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(workspaceRoot, `.mixly-mcp-bundle-fixture-${process.pid}`);
const boardRoot = path.join(fixtureRoot, 'boards', 'default', 'arduino_esp32');
const projectPath = path.join(fixtureRoot, 'BundleBoardBuild.mix');
const invalidProjectPath = path.join(fixtureRoot, 'BundleBoardInvalid.mix');
const serverPath = path.join(__dirname, 'mixly_mcp_server.js');

let child;
let output;
let stderr = '';
let nextId = 0;
const pending = new Map();

function writeFixture(relativePath, content) {
  const destination = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf8');
}

function createFixture() {
  cleanFixture();

  writeFixture('boards.json', [
    '[',
    '  /* JSONC is used by real Mixly board catalogs. */',
    '  {"boardType":"Fixture ESP32 Family","boardIndex":"./boards/default/arduino_esp32/index.xml","language":"C/C++"}',
    ']',
    ''
  ].join('\n'));

  writeFixture('boards/default/arduino_esp32/index.xml', [
    '<xml>',
    '  <script src=main.bundle.test.js></script>',
    '</xml>',
    ''
  ].join('\n'));
  writeFixture('boards/default/arduino_esp32/config.json', '{"board":"./boards.json","language":"C/C++"}\n');
  writeFixture('boards/default/arduino_esp32/boards.json', [
    '{',
    '  "Fixture ESP32": {"key":"fixture:esp32:dev","xmlPath":"./xml/esp32.xml","config":[]}',
    '}',
    ''
  ].join('\n'));

  writeFixture('boards/default/arduino_esp32/xml/esp32.xml', [
    '<xml>',
    '  <category name=Network>',
    '    <block type=esp_now_send>',
    '      <value name=mac><shadow type=text><field name=TEXT>AA:BB:CC:DD:EE:FF</field></shadow></value>',
    '      <statement name=success></statement>',
    '    </block>',
    '    <block type=esp_now_receive></block>',
    '    <block type=direct_probe></block>',
    '    <block type=inline_function_probe></block>',
    '    <block type=inline_arrow_probe></block>',
    '    <block type=toolbox_only></block>',
    '  </category>',
    '</xml>',
    ''
  ].join('\n'));

  writeFixture('boards/default/arduino_esp32/examples/send.mix', [
    '<xml board=arduino_esp32>',
    '  <block type=esp_now_send id=example-send x=20 y=20>',
    '    <value name=mac><shadow type=text><field name=TEXT>11:22:33:44:55:66</field></shadow></value>',
    '    <statement name=success></statement>',
    '  </block>',
    '</xml>',
    ''
  ].join('\n'));

  const fillerBeforeGenerator = Array.from({ length: 5 }, (_, index) => `// registry separator ${index + 1}`);
  const fillerBetweenKinds = Array.from({ length: 60 }, (_, index) => `// block separator ${index + 1}`);
  const fillerAfterSendBlock = Array.from({ length: 60 }, (_, index) => `// receive separator ${index + 1}`);
  writeFixture('boards/default/arduino_esp32/main.bundle.test.js', [
    "'use strict';",
    'const Runtime={Blocks:{},Arduino:{forBlock:{},valueToCode:function(){return "";},statementToCode:function(){return "";}}};',
    'const webpack={d:function(target,definitions){for(const key of Object.keys(definitions)){Object.defineProperty(target,key,{enumerable:true,get:definitions[key]});}}};',
    'const blockExports={};',
    'const generatorExports={};',
    'const unrelatedExports={};',
    'webpack.d(blockExports,{esp_now_send:()=>wT,esp_now_receive:()=>rT,direct_probe:()=>oldDT});',
    'webpack.d(generatorExports,{esp_now_send:()=>wG,esp_now_receive:()=>rG,direct_probe:()=>oldDG});',
    'webpack.d(unrelatedExports,{exported_but_not_registered:()=>notABlock});',
    ...fillerBeforeGenerator,
    ';const wG=function(block){',
    '  const mac=Runtime.Arduino.valueToCode(this,"mac",0);',
    '  const success=Runtime.Arduino.statementToCode(this,"success");',
    '  return `send(${mac});\\n${success}`;',
    '};',
    ';const rG=function(){const body=Runtime.Arduino.statementToCode(this,"receive_data");return `receive(){\\n${body}}\\n`;};',
    ';const oldDG=function(){return "oldDirect();\\n";};',
    ';const dG=function(){return "directProbe();\\n";};',
    ...fillerBetweenKinds,
    ';const wT={init:function(){',
    '  this.appendDummyInput().appendField(new Runtime.FieldDropdown([["All", "*"], ["Peer", "P"]]), "CHANNEL");',
    '  this.appendValueInput("mac");',
    '  this.appendStatementInput("success");',
    '  this.setPreviousStatement(true);',
    '  this.setNextStatement(true);',
    '}};',
    ...fillerAfterSendBlock,
    ';const rT={init:function(){this.appendStatementInput("receive_data");}};',
    ';const oldDT={init:function(){this.setPreviousStatement(true);this.setNextStatement(true);}};',
    ';const dT={init:function(){this.setPreviousStatement(true);this.setNextStatement(true);}};',
    ';const notABlock={metadata:true};',
    'const directBlocks={',
    '  direct_probe:dT,',
    '  inline_function_probe:{init:function(){this.appendValueInput("VALUE");this.setPreviousStatement(!0);this.setNextStatement(!0);}},',
    '  inline_arrow_probe:{init:function(){this.appendValueInput("ITEM");this.setOutput(!0);}}',
    '};',
    'const directGenerators={',
    '  direct_probe:dG,',
    '  inline_function_probe:function(){const value=Runtime.Arduino.valueToCode(this,"VALUE",0);return `inline(${value});\\n`;},',
    '  inline_arrow_probe:(block)=>{const item=Runtime.Arduino.valueToCode(block,"ITEM",0);return [`arrow(${item})`,0];}',
    '};',
    'Object.assign(Runtime.Blocks,blockExports);',
    'Object.assign(Runtime.Blocks,directBlocks);',
    'Object.assign(Runtime.Arduino.forBlock,generatorExports);',
    'Object.assign(Runtime.Arduino.forBlock,directGenerators);',
    ''
  ].join('\n'));

  writeFixture('boards/default/arduino_esp32/lazy.bundle.abcdef.js', [
    'const lazyBlocks={lazy_only:lazyDefinition};',
    'const lazyGenerators={lazy_only:lazyGenerator};',
    'Object.assign(Runtime.Blocks,lazyBlocks);',
    'Object.assign(Runtime.Arduino.forBlock,lazyGenerators);',
    ';const lazyDefinition={init:function(){this.setPreviousStatement(true);}};',
    ';const lazyGenerator=function(){return "lazy();\\n";};',
    ''
  ].join('\n'));

  writeFixture('boards/default/python/index.xml', '');
  writeFixture('boards/default/python/main.bundle.empty.js', '');
  writeFixture('boards/default_src/python/blocks/fallback.js', [
    'export const source_fallback={init:function(){this.setPreviousStatement(true);this.setNextStatement(true);}};',
    ''
  ].join('\n'));
  writeFixture('boards/default_src/python/generators/fallback.js', [
    'export const source_fallback=function(){return "fallback()\\n";};',
    ''
  ].join('\n'));
}

function cleanFixture() {
  const relative = path.relative(workspaceRoot, fixtureRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside workspace: ${fixtureRoot}`);
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function startServer() {
  child = spawn(process.execPath, [serverPath], {
    cwd: workspaceRoot,
    env: { ...process.env, MIXLY_HOME: fixtureRoot },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  output.on('line', (line) => {
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

function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method} ${params.name || ''}`));
    }, 30000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function call(name, args) {
  const response = await request('tools/call', { name, arguments: args });
  assert(response.result, `${name} returned no result`);
  if (response.result.isError) {
    throw new Error(`${name} failed: ${response.result.content[0].text}`);
  }
  return response.result.structuredContent;
}

async function callExpectingError(name, args) {
  const response = await request('tools/call', { name, arguments: args });
  assert.equal(response.result.isError, true, `${name} should have failed`);
  return JSON.parse(response.result.content[0].text);
}

async function main() {
  createFixture();
  startServer();

  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mixly-bundle-board-test', version: '1.0.0' }
  });
  assert.equal(initialized.result.serverInfo.name, 'mixly-local-builder');

  const scanned = await call('mixly_scan_library', { board: 'default/arduino_esp32' });
  assert.equal(scanned.board.id, 'default/arduino_esp32');
  assert.equal(scanned.official.discoveryMode, 'bundle+toolbox+source');
  assert.equal(scanned.official.bundleFileCount, 1);
  assert.equal(scanned.official.blockFileCount, 1);
  assert.equal(scanned.official.generatorFileCount, 1);
  assert.equal(scanned.official.toolboxFileCount, 2);
  assert.equal(scanned.official.exampleProjectCount, 1);
  assert.equal(scanned.official.blockTypeCount, 6);
  assert.equal(scanned.official.generatorTypeCount, 5);
  assert.deepEqual(scanned.blockTypes, [
    'direct_probe',
    'esp_now_receive',
    'esp_now_send',
    'inline_arrow_probe',
    'inline_function_probe',
    'toolbox_only'
  ]);
  assert.deepEqual(scanned.generatorTypes, [
    'direct_probe',
    'esp_now_receive',
    'esp_now_send',
    'inline_arrow_probe',
    'inline_function_probe'
  ]);
  assert(!scanned.availableBlockTypes.includes('exported_but_not_registered'));
  assert(!scanned.availableBlockTypes.includes('lazy_only'));

  const profiledScan = await call('mixly_scan_library', {
    board: 'Fixture ESP32 Family@Fixture ESP32'
  });
  assert.equal(profiledScan.board.id, 'default/arduino_esp32');
  assert.equal(profiledScan.board.boardType, 'Fixture ESP32 Family');
  assert.equal(profiledScan.board.selectedProfile, 'Fixture ESP32');
  assert.equal(profiledScan.board.fqbn, 'fixture:esp32:dev');
  assert.equal(profiledScan.board.xmlPath, 'xml/esp32.xml');

  const fallbackScan = await call('mixly_scan_library', { board: 'default/python' });
  assert.equal(fallbackScan.official.discoveryMode, 'source+toolbox');
  assert.equal(fallbackScan.official.bundleFileCount, 0);
  assert.deepEqual(fallbackScan.blockTypes, ['source_fallback']);
  assert.deepEqual(fallbackScan.generatorTypes, ['source_fallback']);

  const specifications = await call('mixly_get_block_specs', {
    board: 'default/arduino_esp32',
    blockTypes: ['esp_now_send', 'esp_now_receive', 'direct_probe', 'inline_function_probe', 'inline_arrow_probe'],
    includeSource: true
  });
  assert.equal(specifications.found, 5);
  assert.deepEqual(specifications.unknownTypes, []);

  const sendSpec = specifications.specs.find((item) => item.type === 'esp_now_send');
  assert(sendSpec, 'esp_now_send specification is missing');
  assert.deepEqual(sendSpec.contract.valueInputs, ['mac']);
  assert.deepEqual(sendSpec.contract.statementInputs, ['success']);
  assert.deepEqual(sendSpec.contract.fieldNames, ['CHANNEL']);
  assert.equal(sendSpec.contract.connection, 'statement');
  assert.equal(sendSpec.definition.format, 'bundle');
  assert.equal(sendSpec.definition.symbol, 'wT');
  assert.equal(sendSpec.generator.symbol, 'wG');
  assert(sendSpec.definition.excerpt.includes('appendValueInput("mac")'));
  assert(sendSpec.definition.excerpt.includes('appendStatementInput("success")'));
  assert(sendSpec.generator.excerpt.includes('valueToCode(this,"mac"'));
  assert(sendSpec.generator.excerpt.includes('statementToCode(this,"success"'));
  assert(!sendSpec.definition.excerpt.includes('webpack.d('));
  assert(!sendSpec.generator.excerpt.includes('webpack.d('));
  assert(sendSpec.defaultXml.startsWith('<block type=esp_now_send>'));
  assert.deepEqual(sendSpec.exampleProjects, [
    'boards/default/arduino_esp32/examples/send.mix'
  ]);
  assert(sendSpec.exampleXml.includes('<block type=esp_now_send'));

  const receiveSpec = specifications.specs.find((item) => item.type === 'esp_now_receive');
  assert(receiveSpec, 'esp_now_receive specification is missing');
  assert.equal(receiveSpec.contract.connection, 'hat');
  assert.deepEqual(receiveSpec.contract.statementInputs, ['receive_data']);

  const directSpec = specifications.specs.find((item) => item.type === 'direct_probe');
  assert(directSpec, 'direct_probe specification is missing');
  assert.equal(directSpec.definition.symbol, 'dT');
  assert.equal(directSpec.generator.symbol, 'dG');
  assert.notEqual(directSpec.definition.symbol, 'oldDT');
  assert.notEqual(directSpec.generator.symbol, 'oldDG');

  const inlineFunctionSpec = specifications.specs.find((item) => item.type === 'inline_function_probe');
  assert(inlineFunctionSpec, 'inline_function_probe specification is missing');
  assert.equal(inlineFunctionSpec.definition.symbol, undefined);
  assert.equal(inlineFunctionSpec.generator.symbol, undefined);
  assert.equal(inlineFunctionSpec.contract.connection, 'statement');
  assert.deepEqual(inlineFunctionSpec.contract.valueInputs, ['VALUE']);
  assert(inlineFunctionSpec.definition.excerpt.includes('setPreviousStatement(!0)'));
  assert(inlineFunctionSpec.generator.excerpt.includes('valueToCode(this,"VALUE"'));

  const inlineArrowSpec = specifications.specs.find((item) => item.type === 'inline_arrow_probe');
  assert(inlineArrowSpec, 'inline_arrow_probe specification is missing');
  assert.equal(inlineArrowSpec.contract.connection, 'output');
  assert.deepEqual(inlineArrowSpec.contract.valueInputs, ['ITEM']);
  assert(inlineArrowSpec.generator.excerpt.includes('valueToCode(block,"ITEM"'));

  const built = await call('mixly_build_project', {
    board: 'Fixture ESP32 Family@Fixture ESP32',
    projectPath,
    overwrite: true,
    tree: {
      blocks: [{
        type: 'esp_now_send',
        next: { type: 'direct_probe' }
      }]
    }
  });
  assert.equal(built.passed, true);
  assert.equal(built.boardProfile, 'Fixture ESP32');
  assert.equal(built.fqbn, 'fixture:esp32:dev');
  assert.equal(built.serializedNodes, 2);
  assert.deepEqual(built.unknownTypes, []);
  assert(fs.existsSync(projectPath));
  const projectXml = fs.readFileSync(projectPath, 'utf8');
  assert(projectXml.includes('board="Fixture ESP32 Family@Fixture ESP32"'));
  assert(projectXml.includes('type="esp_now_send"'));
  assert(projectXml.includes('type="direct_probe"'));

  const unknownError = await callExpectingError('mixly_build_project', {
    board: 'default/arduino_esp32',
    projectPath: invalidProjectPath,
    overwrite: true,
    tree: { blocks: [{ type: 'bundle_missing_block' }] }
  });
  assert.deepEqual(unknownError.details.unknownTypes, ['bundle_missing_block']);
  assert.equal(unknownError.details.passed, false);
  assert(!fs.existsSync(invalidProjectPath));

  await request('shutdown');
  child.stdin.end();
  console.log('Mixly bundle board workflow passed');
  console.log(`Blocks: ${scanned.official.blockTypeCount}; generators: ${scanned.official.generatorTypeCount}`);
  console.log(`Bundle files: ${scanned.official.bundleFileCount}; toolbox files: ${scanned.official.toolboxFileCount}; examples: ${scanned.official.exampleProjectCount}`);
}

main().catch((error) => {
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(() => {
  if (output) output.close();
  if (child && !child.killed) child.kill();
  cleanFixture();
});
