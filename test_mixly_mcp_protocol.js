'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const serverPath = path.join(__dirname, 'mixly_mcp_server.js');
const child = spawn(process.execPath, [serverPath], {
  cwd: path.resolve(__dirname, '..'),
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe']
});
const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 0;
let stderr = '';

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

function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method} ${params.name || ''}`.trim()));
    }, 30000);
    pending.set(id, {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function main() {
  const initialized = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mixly-mcp-test', version: '1.0.0' }
  });
  assert.equal(initialized.result.serverInfo.name, 'mixly-local-builder');
  assert.equal(initialized.result.serverInfo.version, '2.3.0');
  assert.match(initialized.result.instructions, /libraries\/ThirdParty/);
  assert.match(initialized.result.instructions, /无需修改 MCP/);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  const listed = await request('tools/list');
  const names = listed.result.tools.map((tool) => tool.name);
  const expected = [
    'mixly_scan_library',
    'mixly_get_block_specs',
    'mixly_inspect_library',
    'mixly_detect_environment',
    'mixly_get_board_profiles',
    'mixly_analyze_source',
    'mixly_verify_equivalence',
    'mixly_create_library',
    'mixly_build_project',
    'mixly_save_project',
    'mixly_package_library',
    'mixly_launch',
    'mixly_import_library',
    'mixly_open_project',
    'mixly_validate_project',
    'mixly_generate_code',
    'mixly_project_workflow',
    'mixly_compile'
  ];
  for (const name of expected) assert(names.includes(name), `Missing tool: ${name}`);
  assert(listed.result.tools.every((tool) => tool.title && tool.annotations));
  const compileDefinition = listed.result.tools.find((tool) => tool.name === 'mixly_compile');
  const workflowDefinition = listed.result.tools.find((tool) => tool.name === 'mixly_project_workflow');
  const equivalenceDefinition = listed.result.tools.find((tool) => tool.name === 'mixly_verify_equivalence');
  for (const definition of [compileDefinition, workflowDefinition]) {
    assert.equal(definition.inputSchema.properties.librariesPaths.type, 'array');
    assert.equal(definition.inputSchema.properties.mixlyLibraries.type, 'array');
  }
  assert.equal(compileDefinition.inputSchema.properties.board.type, 'string');
  assert.deepEqual(equivalenceDefinition.inputSchema.properties.mode.enum, ['report', 'behavioral-strict', 'exact']);
  assert.equal(workflowDefinition.inputSchema.properties.equivalenceSupportPaths.type, 'array');

  const scanned = await request('tools/call', {
    name: 'mixly_scan_library',
    arguments: { board: 'default/arduino_avr' }
  });
  assert.equal(scanned.result.isError, undefined);
  assert(scanned.result.structuredContent.official.blockTypeCount > 100);
  assert(scanned.result.structuredContent.thirdParty.some((library) => library.name === 'LiftLight'));
  assert(scanned.result.structuredContent.thirdParty.some((library) => library.name === 'Emakefun_tts20'));
  assert(scanned.result.structuredContent.thirdParty.some((library) => library.name === 'handuan'));
  assert(scanned.result.structuredContent.availableBlockTypes.includes('DHT'));
  assert(scanned.result.structuredContent.availableBlockTypes.includes('mrtduino_ledlight'));
  assert(scanned.result.structuredContent.thirdPartyBlockTypes.includes('emakefun_tts20_play_text'));

  const specs = await request('tools/call', {
    name: 'mixly_get_block_specs',
    arguments: {
      board: 'default/arduino_avr',
      blockTypes: ['DHT', 'display_rgb', 'controls_if', 'variables_declare', 'nanoenv_oled_print']
    }
  });
  assert.equal(specs.result.isError, undefined);
  assert.equal(specs.result.structuredContent.unknownTypes.length, 0);
  const dhtSpec = specs.result.structuredContent.specs.find((item) => item.type === 'DHT');
  assert(dhtSpec.defaultXml.includes('<block type="DHT">'));
  assert(dhtSpec.contract.fieldNames.includes('TYPE'));
  assert(dhtSpec.contract.fieldNames.includes('PIN'));
  const rgbSpec = specs.result.structuredContent.specs.find((item) => item.type === 'display_rgb');
  assert(rgbSpec.contract.valueInputs.includes('_LED_'));
  assert(rgbSpec.contract.valueInputs.includes('COLOR'));
  const optionalTextSpec = specs.result.structuredContent.specs.find((item) => item.type === 'nanoenv_oled_print');
  assert.deepEqual(optionalTextSpec.contract.optionalValueInputs, ['VALUE']);
  assert.deepEqual(optionalTextSpec.contract.valueDefaults, [{ name: 'VALUE', fallbackCode: '""' }]);

  const inspectedHanduan = await request('tools/call', {
    name: 'mixly_inspect_library',
    arguments: { board: 'default/arduino_avr', library: 'handuan', blockTypes: ['mrtduino_ledlight'] }
  });
  assert.equal(inspectedHanduan.result.isError, undefined);
  assert.equal(inspectedHanduan.result.structuredContent.structure.standardLayout, true);
  assert.equal(inspectedHanduan.result.structuredContent.patterns.usesFieldImage, true);
  assert(inspectedHanduan.result.structuredContent.structure.mediaFiles.length > 0);
  assert.equal(inspectedHanduan.result.structuredContent.specs[0].owner, 'ThirdParty/handuan');

  const inspectedTts = await request('tools/call', {
    name: 'mixly_inspect_library',
    arguments: { board: 'default/arduino_avr', library: 'Emakefun_tts20', blockTypes: ['emakefun_tts20_play_text'] }
  });
  assert.equal(inspectedTts.result.isError, undefined);
  assert.equal(inspectedTts.result.structuredContent.structure.standardLayout, true);
  assert(inspectedTts.result.structuredContent.structure.arduinoLibraryFileCount > 0);
  assert.equal(inspectedTts.result.structuredContent.specs[0].owner, 'ThirdParty/Emakefun_tts20');

  const projectPath = path.resolve(__dirname, '..', 'McpProtocolBuildTest.mix');
  const built = await request('tools/call', {
    name: 'mixly_build_project',
    arguments: {
      board: 'default/arduino_avr@Arduino Nano',
      projectPath,
      overwrite: true,
      tree: {
        blocks: [
          {
            type: 'variables_declare',
            fields: { variables_type: 'global_variate', VAR: '候选指令', TYPE: 'String' },
            values: { VALUE: { shadow: { type: 'text', fields: { TEXT: 'S' } } } }
          },
          {
            type: 'variables_declare',
            fields: { variables_type: 'global_variate', VAR: '稳定指令', TYPE: 'String' },
            values: { VALUE: { shadow: { type: 'text', fields: { TEXT: 'S' } } } }
          },
          { type: 'base_setup', statements: {} }
        ]
      }
    }
  });
  assert.equal(built.result.isError, undefined);
  assert.equal(built.result.structuredContent.globalVariablesChained, true);
  assert.equal(built.result.structuredContent.topVariableDeclarationStacks, 1);
  assert(fs.existsSync(projectPath));
  assert.match(fs.readFileSync(projectPath, 'utf8'), /board="Arduino AVR@Arduino Nano"/);

  const warnedEnglish = await request('tools/call', {
    name: 'mixly_build_project',
    arguments: {
      board: 'default/arduino_avr',
      projectPath: path.resolve(__dirname, '..', 'McpProtocolEnglishTest.mix'),
      overwrite: true,
      tree: {
        blocks: [
          {
            type: 'variables_declare',
            fields: { variables_type: 'global_variate', VAR: 'candidateCommand', TYPE: 'String' },
            values: { VALUE: { shadow: { type: 'text', fields: { TEXT: 'S' } } } }
          }
        ]
      }
    }
  });
  assert.equal(warnedEnglish.result.isError, undefined);
  assert(warnedEnglish.result.structuredContent.namingViolations.length > 0);
  assert(warnedEnglish.result.structuredContent.warnings.some((warning) => /中文/.test(warning)));
  fs.rmSync(projectPath, { force: true });
  fs.rmSync(path.resolve(__dirname, '..', 'McpProtocolEnglishTest.mix'), { force: true });

  const largeTreePath = path.resolve(__dirname, '..', 'McpLargeTreeTest.json');
  const largeProjectPath = path.resolve(__dirname, '..', 'McpLargeTreeTest.mix');
  fs.writeFileSync(largeTreePath, `\uFEFF${JSON.stringify({
    boardAttribute: 'Arduino AVR@Arduino Nano',
    blocks: Array.from({ length: 240 }, (_, index) => ({
      type: 'variables_declare',
      fields: { variables_type: 'global_variate', VAR: `测试变量${index + 1}`, TYPE: 'int' },
      values: { VALUE: { shadow: { type: 'math_number', fields: { NUM: String(index) } } } }
    }))
  })}`, 'utf8');
  const builtFromFile = await request('tools/call', {
    name: 'mixly_build_project',
    arguments: {
      board: 'default/arduino_avr', treePath: largeTreePath,
      projectPath: largeProjectPath, overwrite: true
    }
  });
  assert.equal(builtFromFile.result.isError, undefined);
  assert.equal(builtFromFile.result.structuredContent.treeSource, largeTreePath);
  assert.equal(builtFromFile.result.structuredContent.serializedNodes, 480);
  assert.equal(builtFromFile.result.structuredContent.topVariableDeclarationStacks, 1);
  fs.rmSync(largeTreePath, { force: true });
  fs.rmSync(largeProjectPath, { force: true });

  const compatibilityLibrary = 'McpCompatTest';
  const compatibilityLibraryPath = path.resolve(
    __dirname, '..', 'resources', 'app', 'src', 'boards', 'default', 'arduino_avr',
    'libraries', 'ThirdParty', compatibilityLibrary
  );
  const imageLibraryPath = path.resolve(
    __dirname, '..', 'resources', 'app', 'src', 'boards', 'default', 'arduino_avr',
    'libraries', 'ThirdParty', 'McpImageRejectTest'
  );
  fs.rmSync(compatibilityLibraryPath, { recursive: true, force: true });
  fs.rmSync(imageLibraryPath, { recursive: true, force: true });
  const createdLibrary = await request('tools/call', {
    name: 'mixly_create_library',
    arguments: {
      libraryName: compatibilityLibrary,
      board: 'default/arduino_avr',
      overwrite: true,
      blocksJs: "Blockly.Blocks['mcp_test_primitive']={init:function(){this.appendDummyInput().appendField('测试底层原语').appendField(new Blockly.FieldTextInput('变量'),'VAR');this.setPreviousStatement(true);this.setNextStatement(true);}};",
      generatorsJs: "Blockly.Arduino.forBlock['mcp_test_primitive']=function(block){const rawName=block.getFieldValue('VAR');return 'delay(1);\\n';};",
      toolboxXml: '<category name="MCP测试"><block type="mcp_test_primitive"></block></category>',
      primitiveReasons: [{
        type: 'mcp_test_primitive',
        reason: '协议测试使用的最小底层原语',
        officialCandidatesChecked: ['controls_delay']
      }]
    }
  });
  assert.equal(createdLibrary.result.isError, undefined);
  assert.equal(createdLibrary.result.structuredContent.layout, 'standard');
  assert(createdLibrary.result.structuredContent.files.includes('config.json'));
  assert(createdLibrary.result.structuredContent.files.some((name) => name.startsWith('block/')));
  assert(createdLibrary.result.structuredContent.warnings.some((warning) => /variableDB_/.test(warning)));

  const warnedImage = await request('tools/call', {
    name: 'mixly_create_library',
    arguments: {
      libraryName: 'McpImageRejectTest',
      board: 'default/arduino_avr',
      overwrite: true,
      blocksJs: "Blockly.Blocks['mcp_image_test']={init:function(){this.appendDummyInput().appendField(new Blockly.FieldImage('./media/icon.png',20,20));this.setPreviousStatement(true);this.setNextStatement(true);}};",
      generatorsJs: "Blockly.Arduino.forBlock['mcp_image_test']=function(){return 'delay(1);\\n';};",
      toolboxXml: '<category name="MCP测试"><block type="mcp_image_test"></block></category>',
      primitiveReasons: [{
        type: 'mcp_image_test', reason: '协议测试图片授权开关',
        officialCandidatesChecked: ['controls_delay']
      }]
    }
  });
  assert.equal(warnedImage.result.isError, undefined);
  assert(warnedImage.result.structuredContent.warnings.some((warning) => /图片/.test(warning)));
  fs.rmSync(compatibilityLibraryPath, { recursive: true, force: true });
  fs.rmSync(imageLibraryPath, { recursive: true, force: true });

  const inheritedScan = await request('tools/call', {
    name: 'mixly_scan_library',
    arguments: { board: 'default/arduino_esp32s3' }
  });
  assert.equal(inheritedScan.result.structuredContent.board.id, 'default/arduino_esp32s3');
  assert(inheritedScan.result.structuredContent.blockTypes.includes('controls_if'));
  assert(inheritedScan.result.structuredContent.official.blockFileCount > 20);

  const analyzed = await request('tools/call', {
    name: 'mixly_analyze_source',
    arguments: {
      sourceText: '#include <Adafruit_NeoPixel.h>\n#define PIN_LED 6\nvoid setup(){ Serial.begin(115200); }\nvoid loop(){ digitalRead(PIN_LED); delay(10); }'
    }
  });
  assert.deepEqual(analyzed.result.structuredContent.includes, ['Adafruit_NeoPixel.h']);
  assert.equal(analyzed.result.structuredContent.capabilities.neopixel, true);
  assert.equal(analyzed.result.structuredContent.capabilities.serial, true);

  const analyzedPython = await request('tools/call', {
    name: 'mixly_analyze_source',
    arguments: {
      sourceText: 'from machine import Pin\nimport time\nLED_PIN = 2\ndef 闪烁():\n    led = Pin(LED_PIN, Pin.OUT)\n    time.sleep_ms(100)\n'
    }
  });
  assert.equal(analyzedPython.result.structuredContent.language, 'Python');
  assert(analyzedPython.result.structuredContent.imports.includes('from machine import Pin'));
  assert(analyzedPython.result.structuredContent.functions.some((item) => item.name === '闪烁'));

  const missingBehavior = await request('tools/call', {
    name: 'mixly_verify_equivalence',
    arguments: {
      mode: 'behavioral-strict',
      sourceText: 'void registerCard(){if(isUidRegistered(uid)){display("Already Registered");return;}delay(50);}',
      generatedText: 'void registerCard(){delay(50);}',
      requiredPatterns: [{ label: 'duplicate guard', pattern: 'isUidRegistered\\s*\\(' }]
    }
  });
  assert.equal(missingBehavior.result.isError, undefined);
  assert.equal(missingBehavior.result.structuredContent.passed, false);
  assert(missingBehavior.result.structuredContent.gaps.missingGuardCalls.includes('isUidRegistered'));
  assert(missingBehavior.result.structuredContent.gaps.missingStrings.includes('Already Registered'));
  assert.equal(missingBehavior.result.structuredContent.status, 'failed');

  const completeBehavior = await request('tools/call', {
    name: 'mixly_verify_equivalence',
    arguments: {
      mode: 'behavioral-strict',
      sourceText: 'void registerCard(){if(isUidRegistered(uid)){display("Already Registered");return;}delay(50);}',
      generatedText: 'void registerCard(){if(isUidRegistered(uid)){display("Already Registered");return;}delay(50);}',
      requiredPatterns: ['isUidRegistered\\s*\\(']
    }
  });
  assert.equal(completeBehavior.result.structuredContent.passed, true);
  assert.equal(completeBehavior.result.structuredContent.behavioralGapCount, 0);

  const equivalenceSupportPath = path.resolve(__dirname, '..', 'McpEquivalenceSupport.cpp');
  fs.writeFileSync(equivalenceSupportPath, 'void helper(){digitalWrite(2, HIGH);}\n', 'utf8');
  const supportedBehavior = await request('tools/call', {
    name: 'mixly_verify_equivalence',
    arguments: {
      mode: 'behavioral-strict',
      sourceText: 'void loop(){digitalWrite(2, HIGH);}',
      generatedText: 'void loop(){helper();}',
      supportPaths: [equivalenceSupportPath]
    }
  });
  assert.equal(supportedBehavior.result.structuredContent.passed, true);
  assert.deepEqual(supportedBehavior.result.structuredContent.inputs.support, [equivalenceSupportPath]);
  fs.rmSync(equivalenceSupportPath, { force: true });

  const detected = await request('tools/call', {
    name: 'mixly_detect_environment',
    arguments: { probeCli: false }
  });
  assert(detected.result.structuredContent.boards.length > 5);
  assert(detected.result.structuredContent.boards.some((board) => board.id === 'default/arduino_avr'));

  const profiles = await request('tools/call', {
    name: 'mixly_get_board_profiles', arguments: { board: 'default/arduino_avr' }
  });
  assert.equal(profiles.result.isError, undefined);
  const nanoProfile = profiles.result.structuredContent.profiles.find((profile) => profile.name === 'Arduino Nano');
  assert(nanoProfile);
  assert.equal(nanoProfile.fqbn, 'arduino:avr:nano');
  assert(nanoProfile.configuration.find((item) => item.key === 'cpu').options.some((item) => item.key === 'atmega328'));

  const invalid = await request('tools/call', {
    name: 'mixly_compile',
    arguments: {}
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /sketchPath/);

  const looseSketch = path.resolve(__dirname, '..', 'McpLooseCompile.ino');
  fs.writeFileSync(looseSketch, 'void setup() {}\nvoid loop() {}\n', 'utf8');
  const stagingBefore = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('mixly-mcp-sketch-')));
  const missingFqbn = await request('tools/call', {
    name: 'mixly_compile', arguments: { sketchPath: looseSketch }
  });
  assert.equal(missingFqbn.result.isError, true);
  assert.match(missingFqbn.result.content[0].text, /fqbn/);
  const stagingAfter = fs.readdirSync(os.tmpdir()).filter((name) =>
    name.startsWith('mixly-mcp-sketch-') && !stagingBefore.has(name)
  );
  assert.deepEqual(stagingAfter, []);

  const compileFixtureDirectory = path.resolve(__dirname, '..', 'McpCompileFixture');
  const compileFixtureSketch = path.join(compileFixtureDirectory, 'McpCompileFixture.ino');
  fs.mkdirSync(compileFixtureDirectory, { recursive: true });
  fs.writeFileSync(compileFixtureSketch, 'void setup() {}\nvoid loop() {}\n', 'utf8');
  const defaultLibrariesPath = path.resolve(__dirname, '..', 'arduino-cli', 'libraries');
  const handuanLibrariesPath = path.resolve(
    __dirname, '..', 'resources', 'app', 'src', 'boards', 'default', 'arduino_avr',
    'libraries', 'ThirdParty', 'handuan', 'libraries'
  );
  const emakefunLibrariesPath = path.resolve(
    __dirname, '..', 'resources', 'app', 'src', 'boards', 'default', 'arduino_avr',
    'libraries', 'ThirdParty', 'Emakefun_tts20', 'libraries'
  );
  const multipleLibraries = await request('tools/call', {
    name: 'mixly_compile',
    arguments: {
      sketchPath: compileFixtureSketch,
      fqbn: 'arduino:avr:nano:cpu=atmega328',
      arduinoCliPath: process.execPath,
      librariesPath: defaultLibrariesPath,
      librariesPaths: [defaultLibrariesPath, handuanLibrariesPath],
      board: 'default/arduino_avr',
      mixlyLibraries: ['emakefun_TTS20', 'Emakefun_tts20']
    }
  });
  assert.equal(multipleLibraries.result.isError, undefined);
  assert.equal(multipleLibraries.result.structuredContent.librariesPath, defaultLibrariesPath);
  assert.deepEqual(multipleLibraries.result.structuredContent.librariesPaths, [
    defaultLibrariesPath, handuanLibrariesPath, emakefunLibrariesPath
  ]);
  assert.equal(multipleLibraries.result.structuredContent.mixlyBoard, 'default/arduino_avr');
  assert.deepEqual(multipleLibraries.result.structuredContent.mixlyLibraryPaths, [
    { name: 'Emakefun_tts20', path: emakefunLibrariesPath }
  ]);
  assert.equal(multipleLibraries.result.structuredContent.passed, false);

  const invalidMixlyLibrary = await request('tools/call', {
    name: 'mixly_compile',
    arguments: {
      sketchPath: compileFixtureSketch,
      fqbn: 'arduino:avr:nano:cpu=atmega328',
      arduinoCliPath: process.execPath,
      board: 'default/arduino_avr',
      mixlyLibraries: ['../outside']
    }
  });
  assert.equal(invalidMixlyLibrary.result.isError, true);
  assert.match(invalidMixlyLibrary.result.content[0].text, /Mixly/);

  const missingLibrariesPath = await request('tools/call', {
    name: 'mixly_compile',
    arguments: {
      sketchPath: compileFixtureSketch,
      fqbn: 'arduino:avr:nano:cpu=atmega328',
      arduinoCliPath: process.execPath,
      librariesPaths: [path.resolve(__dirname, '..', 'McpMissingLibraries')]
    }
  });
  assert.equal(missingLibrariesPath.result.isError, true);
  assert.match(missingLibrariesPath.result.content[0].text, /librariesPaths\[0\]/);

  const mockCompileEntrypoint = path.resolve(__dirname, '..', 'compile');
  assert.equal(fs.existsSync(mockCompileEntrypoint), false, 'Resource-risk fixture would overwrite an existing file');
  fs.writeFileSync(mockCompileEntrypoint, [
    "console.log('Sketch uses 28000 bytes (91%) of program storage space. Maximum is 30720 bytes.');",
    "console.log('Global variables use 1800 bytes (87%) of dynamic memory. Maximum is 2048 bytes.');"
  ].join('\n'), 'utf8');
  try {
    const resourceRisk = await request('tools/call', {
      name: 'mixly_compile',
      arguments: {
        sketchPath: compileFixtureSketch,
        fqbn: 'arduino:avr:nano:cpu=atmega328',
        arduinoCliPath: process.execPath,
        librariesPaths: [defaultLibrariesPath]
      }
    });
    assert.equal(resourceRisk.result.structuredContent.passed, true);
    assert.equal(resourceRisk.result.structuredContent.results[0].metrics.flash.percent, 91.1);
    assert.equal(resourceRisk.result.structuredContent.results[0].metrics.sram.percent, 87.9);
    assert.equal(resourceRisk.result.structuredContent.results[0].resourceRisk.level, 'high');
    assert.equal(resourceRisk.result.structuredContent.resourceRisk.level, 'high');
    assert.equal(resourceRisk.result.structuredContent.resourceRisk.warnings.length, 2);
  } finally {
    fs.rmSync(mockCompileEntrypoint, { force: true });
  }
  fs.rmSync(compileFixtureDirectory, { recursive: true, force: true });
  fs.rmSync(looseSketch, { force: true });

  const ping = await request('ping');
  assert.deepEqual(ping.result, {});
  await request('shutdown');
  child.stdin.end();
  console.log(`MCP protocol passed: ${names.length} tools, AVR official blocks ${scanned.result.structuredContent.official.blockTypeCount}`);
  console.log('Structured results, Chinese instructions, scan/analyze calls, validation errors and ping passed');
}

main().catch((error) => {
  console.error(error);
  if (stderr) console.error(stderr);
  child.kill();
  process.exitCode = 1;
});
