'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const workspaceRoot = __dirname;
const fixtureRoot = path.join(workspaceRoot, `.mixly4-plugin-fixture-${process.pid}`);
const boardId = 'default/arduino_avr';
const boardStorageKey = 'default__arduino_avr';
const libraryName = 'Mixly4PluginFixture';
const blockType = 'mixly4_plugin_fixture_set';
const stagingLibraryPath = path.join(
  fixtureRoot,
  '.mixly-mcp-staging',
  'libraries',
  boardStorageKey,
  libraryName
);
const zipPath = path.join(fixtureRoot, `${libraryName}.zip`);
const compileSketchPath = path.join(fixtureRoot, 'CompileFixture', 'CompileFixture.ino');
const rootCompileSketchPath = path.join(fixtureRoot, 'RootCompileFixture.ino');
const explicitLibrariesPath = path.join(fixtureRoot, 'shared-libraries');
const compileArgumentsPath = path.join(fixtureRoot, 'compile-arguments.json');
const rootCompileInspectionPath = path.join(fixtureRoot, 'root-compile-inspection.json');
const serverPath = path.join(workspaceRoot, 'mixly_mcp_server.js');

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

function cleanup() {
  const relative = path.relative(workspaceRoot, fixtureRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside the test workspace: ${fixtureRoot}`);
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function createFixture() {
  cleanup();
  writeFixture('package.json', `${JSON.stringify({
    name: 'Mixly',
    version: '4.0Pre-fixture',
    'node-main': './static-server/server.js',
    main: 'http://localhost:65234',
    'chromium-args': '--user-data-dir=./nw_cache/'
  }, null, 2)}\n`);
  writeFixture('boards.json', `${JSON.stringify([{
    boardType: 'Arduino AVR',
    boardIndex: './boards/default/arduino_avr/index.xml',
    language: 'C/C++'
  }], null, 2)}\n`);
  writeFixture('boards/default/arduino_avr/index.xml', '<xml></xml>\n');
  writeFixture('boards/default/arduino_avr/config.json', `${JSON.stringify({
    board: { Nano: { key: 'arduino:avr:nano', config: [] } }
  }, null, 2)}\n`);
  writeFixture('CompileFixture/CompileFixture.ino', [
    '#include <FixtureArduino.h>',
    'void setup() { fixtureArduinoSet(7); }',
    'void loop() {}',
    ''
  ].join('\n'));
  writeFixture('RootCompileFixture.ino', 'void setup() {}\nvoid loop() {}\n');
  writeFixture('nw_cache/marker.txt', 'Mixly runtime data must not be copied into a staged sketch.\n');
  writeFixture('compile', [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    `fs.writeFileSync(${JSON.stringify(compileArgumentsPath)}, JSON.stringify(process.argv.slice(2)), 'utf8');`,
    `fs.writeFileSync(${JSON.stringify(rootCompileInspectionPath)}, JSON.stringify({ sketchPath: process.argv[process.argv.length - 1], hasNwCache: fs.existsSync(path.join(process.argv[process.argv.length - 1], 'nw_cache')) }), 'utf8');`,
    "console.log('Sketch uses 128 bytes (0%) of program storage space. Maximum is 30720 bytes.');",
    "console.log('Global variables use 16 bytes (0%) of dynamic memory. Maximum is 2048 bytes.');",
    ''
  ].join('\n'));
  fs.mkdirSync(explicitLibrariesPath, { recursive: true });
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

function request(method, params = {}, timeoutMs = 30000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request timed out: ${method} ${params.name || ''}`));
    }, timeoutMs);
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
  assert(response.result, `${name} returned no result: ${JSON.stringify(response)}`);
  assert.equal(
    response.result.isError,
    undefined,
    `${name} failed: ${response.result.content && response.result.content[0].text}`
  );
  return response.result.structuredContent;
}

function zipEntryNames(filePath) {
  const archive = fs.readFileSync(filePath);
  const endSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const minimumOffset = Math.max(0, archive.length - 65557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= minimumOffset; offset--) {
    if (archive.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  assert(endOffset >= 0, 'ZIP end-of-central-directory record is missing');
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const names = [];
  for (let index = 0; index < entryCount; index++) {
    assert.equal(archive.readUInt32LE(offset), centralSignature, `Invalid ZIP central entry ${index}`);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    names.push(archive.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  try {
    await request('shutdown');
    child.stdin.end();
    await new Promise((resolve) => child.once('exit', resolve));
  } catch (_) {
    child.kill();
  }
}

async function main() {
  createFixture();
  startServer();
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mixly4-plugin-library-fixture', version: '1.0.0' }
  });

  const environment = await call('mixly_detect_environment', { probeCli: false });
  assert.equal(environment.mixlyLayout.generation, 4);
  assert.equal(environment.mixlyLayout.runtime, 'nwjs');

  const created = await call('mixly_create_library', {
    libraryName,
    board: boardId,
    version: '1.2.3',
    overwrite: true,
    blocksJs: [
      `Blockly.Blocks['${blockType}'] = {`,
      '  init: function() {',
      "    this.appendDummyInput().appendField('Mode', 'MODE');",
      "    this.appendValueInput('VALUE');",
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
      '  <category name="Fixture">',
      `    <block type="${blockType}">`,
      '      <value name="VALUE"><shadow type="math_number"><field name="NUM">7</field></shadow></value>',
      '    </block>',
      '  </category>',
      '</xml>'
    ].join('\n'),
    primitiveReasons: [{
      type: blockType,
      reason: 'Fixture primitive used to verify Mixly 4 plugin lifecycle behavior.',
      officialCandidatesChecked: ['controls_delay']
    }],
    wasmSketchFiles: [{
      name: 'FixtureWasm.h',
      text: '#pragma once\\ninline int fixtureWasmValue() { return 7; }\\n'
    }, {
      name: 'FixtureWasm.cpp',
      text: '#include "FixtureWasm.h"\\n'
    }],
    extraFiles: [{
      relativePath: 'libraries/FixtureArduino/src/FixtureArduino.h',
      text: [
        '#pragma once',
        'inline void fixtureArduinoSet(int value) { (void)value; }',
        ''
      ].join('\n')
    }]
  });

  assert.equal(created.format, 'mixly4-plugin-staging');
  assert.equal(created.staging, true);
  assert.deepEqual(created.wasmSketchFiles.map((item) => item.name), ['FixtureWasm.h', 'FixtureWasm.cpp']);
  assert.equal(path.resolve(created.destination), path.resolve(stagingLibraryPath));
  assert.deepEqual(created.files, [
    'index.js',
    'index.xml',
    'libraries/FixtureArduino/src/FixtureArduino.h',
    'plugin.json'
  ]);

  const pluginPath = path.join(stagingLibraryPath, 'plugin.json');
  const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
  assert.equal(plugin.id, libraryName);
  assert.equal(plugin.dir, libraryName);
  assert.equal(plugin.version, '1.2.3');
  assert.deepEqual(plugin.versions, ['1.2.3']);
  assert.equal(plugin.mixly.generation, 4);
  assert.equal(plugin.mixly.board, boardId);

  const legacyPlugin = { ...plugin };
  delete legacyPlugin.dir;
  fs.writeFileSync(pluginPath, `${JSON.stringify(legacyPlugin, null, 2)}\n`, 'utf8');

  const indexXml = fs.readFileSync(path.join(stagingLibraryPath, 'index.xml'), 'utf8');
  assert.match(indexXml, /<script type="module" src="\.\/index\.js"><\/script>/);
  assert.match(indexXml, /<category name="Fixture">/);
  assert.match(indexXml, new RegExp(`<block type="${blockType}">`));
  assert.doesNotMatch(indexXml, /<xml\b/i, 'Mixly 4 categories must be direct index.xml children');

  const indexJs = fs.readFileSync(path.join(stagingLibraryPath, 'index.js'), 'utf8');
  assert.match(indexJs, /export\s*\{\s*__exportedBlocks as blocks,\s*__exportedGenerators as generators\s*\}/);
  assert.match(indexJs, new RegExp(blockType));
  const previousBlockly = globalThis.Blockly;
  try {
    globalThis.Blockly = {
      Blocks: {},
      Arduino: {
        forBlock: {},
        ORDER_NONE: 0,
        valueToCode() { return '7'; },
        finish(code) {
          return `${Object.keys(this.libs_ || {}).map((name) => `#include "${name}.h"`).join('\n')}\n${code}`;
        }
      },
      generator: { forBlock: {} }
    };
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(indexJs).toString('base64')}`;
    const pluginModule = await import(moduleUrl);
    assert.deepEqual(Object.keys(pluginModule.blocks), [blockType]);
    assert.deepEqual(Object.keys(pluginModule.generators), [blockType]);
    assert.equal(pluginModule.generators[blockType]({}, globalThis.Blockly.Arduino), 'fixtureSet(7);\n');
    assert.match(globalThis.Blockly.Arduino.libs_['FixtureWasm.h'], /fixtureWasmValue/);
    assert.match(globalThis.Blockly.Arduino.libs_['FixtureWasm.cpp'], /FixtureWasm\.h/);
    const finished = globalThis.Blockly.Arduino.finish('fixtureSet(7);\n');
    assert.doesNotMatch(finished, /FixtureWasm\.(?:h|cpp)\.h/);
    assert.match(globalThis.Blockly.Arduino.libs_['FixtureWasm.h'], /fixtureWasmValue/);
    assert.match(globalThis.Blockly.Arduino.libs_['FixtureWasm.cpp'], /FixtureWasm\.h/);
  } finally {
    if (previousBlockly === undefined) delete globalThis.Blockly;
    else globalThis.Blockly = previousBlockly;
  }

  const scanned = await call('mixly_scan_library', { board: boardId, query: blockType });
  const scannedPlugin = scanned.thirdParty.find((library) => library.name === libraryName);
  assert(scannedPlugin, `Staged plugin missing from scan: ${JSON.stringify(scanned.thirdParty)}`);
  assert.equal(scannedPlugin.source, 'mixly4-staging');
  assert.deepEqual(scannedPlugin.xmlFiles, ['index.xml']);
  assert.deepEqual(scannedPlugin.customTypes, [blockType]);
  assert(scanned.thirdPartyBlockTypes.includes(blockType));
  assert(scanned.availableBlockTypes.includes(blockType));

  const specifications = await call('mixly_get_block_specs', {
    board: boardId,
    blockTypes: [blockType],
    includeSource: true
  });
  assert.equal(specifications.found, 1);
  assert.deepEqual(specifications.unknownTypes, []);
  assert.equal(specifications.specs[0].owner, `Plugin/${libraryName}`);
  assert.deepEqual(specifications.specs[0].contract.fieldNames, ['MODE']);
  assert.deepEqual(specifications.specs[0].contract.valueInputs, ['VALUE']);
  assert.match(specifications.specs[0].defaultXml, new RegExp(`type="${blockType}"`));

  const inspected = await call('mixly_inspect_library', {
    board: boardId,
    library: libraryName,
    blockTypes: [blockType],
    includeSource: true
  });
  assert.equal(inspected.library, libraryName);
  assert.equal(inspected.source, 'mixly4-staging');
  assert.equal(inspected.config.dir, libraryName);
  assert.equal(inspected.structure.standardLayout, true);
  assert.deepEqual(inspected.structure.xmlFiles, ['index.xml']);
  assert(inspected.structure.sampleFiles.includes('plugin.json'));
  assert.deepEqual(inspected.coverage.toolboxTypes, [blockType]);
  assert.deepEqual(inspected.coverage.definedTypes, [blockType]);
  assert.deepEqual(inspected.coverage.generatorTypes, [blockType]);
  assert.equal(inspected.specs[0].owner, `Plugin/${libraryName}`);

  fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`, 'utf8');

  const compiled = await call('mixly_compile', {
    sketchPath: compileSketchPath,
    fqbn: 'arduino:avr:nano',
    arduinoCliPath: process.execPath,
    librariesPath: explicitLibrariesPath,
    board: boardId,
    mixlyLibraries: [libraryName]
  });
  const stagedArduinoLibraries = path.join(stagingLibraryPath, 'libraries');
  assert.equal(compiled.passed, true, JSON.stringify(compiled.results));
  assert.equal(compiled.engine, 'arduino-cli');
  assert.equal(compiled.validationScope, 'generated-cpp-compatibility');
  assert.equal(compiled.desktopEquivalent, false);
  assert.deepEqual(compiled.librariesPaths, [explicitLibrariesPath, stagedArduinoLibraries]);
  assert.equal(compiled.mixlyLibraryPaths.length, 1);
  assert.equal(compiled.mixlyLibraryPaths[0].name, libraryName);
  assert.equal(compiled.mixlyLibraryPaths[0].source, 'mixly4-staging');
  assert.equal(compiled.mixlyLibraryPaths[0].path, stagedArduinoLibraries);
  assert.equal(compiled.mixlyLibraryPaths[0].temporary, false);
  assert.equal(compiled.cleanup.required, true);
  assert.equal(compiled.cleanup.completed, true);
  assert.deepEqual(compiled.cleanup.temporaryPaths, []);
  const compileArguments = JSON.parse(fs.readFileSync(compileArgumentsPath, 'utf8'));
  const libraryFlags = compileArguments.reduce((values, value, index) => {
    if (value === '--libraries') values.push(compileArguments[index + 1]);
    return values;
  }, []);
  assert.deepEqual(libraryFlags, [explicitLibrariesPath, stagedArduinoLibraries]);

  const rootCompiled = await call('mixly_compile', {
    sketchPath: rootCompileSketchPath,
    fqbn: 'arduino:avr:nano',
    arduinoCliPath: process.execPath,
    board: boardId
  });
  assert.equal(rootCompiled.passed, true, JSON.stringify(rootCompiled.results));
  assert.equal(rootCompiled.staged, true);
  const rootInspection = JSON.parse(fs.readFileSync(rootCompileInspectionPath, 'utf8'));
  assert.equal(rootInspection.hasNwCache, false, JSON.stringify(rootInspection));

  const packaged = await call('mixly_package_library', {
    board: boardId,
    library: libraryName,
    outputPath: zipPath
  });
  const expectedEntries = [
    'index.js',
    'index.xml',
    'libraries/FixtureArduino/src/FixtureArduino.h',
    'plugin.json'
  ];
  const expectedDirectories = [
    'libraries/',
    'libraries/FixtureArduino/',
    'libraries/FixtureArduino/src/'
  ];
  assert.deepEqual(packaged.entries, expectedEntries);
  assert.equal(packaged.fileEntries, expectedEntries.length);
  assert.equal(packaged.directoryEntries, expectedDirectories.length);
  assert.deepEqual(zipEntryNames(zipPath), [...expectedDirectories, ...expectedEntries]);
  assert(packaged.entries.every((entry) => !entry.startsWith(`${libraryName}/`)));

  await stopServer();
  console.log('Mixly 4 plugin fixture lifecycle passed');
  console.log('create, scan, specs, inspect, staged Arduino library compile and nested-directory ZIP packaging were verified over MCP stdio');
}

main().catch(async (error) => {
  await stopServer();
  console.error(error.stack || error.message);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
}).finally(() => {
  cleanup();
});
