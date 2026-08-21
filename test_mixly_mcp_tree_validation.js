'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { projectLoadDiagnostics } = require('./mixly_mcp_server');

const root = path.resolve(__dirname, '..');
const libraryName = 'McpTreeContractTest';
const libraryPath = path.join(
  root, 'resources', 'app', 'src', 'boards', 'default', 'arduino_avr',
  'libraries', 'ThirdParty', libraryName
);
const mutationProject = path.join(root, 'McpControlsIfMutationTest.mix');
const invalidIfProject = path.join(root, 'McpControlsIfConnectionTest.mix');
const invalidOfficialProject = path.join(root, 'McpOfficialConnectionTest.mix');
const invalidProject = path.join(root, 'McpInvalidConnectionTest.mix');
const validProject = path.join(root, 'McpValidConnectionTest.mix');
const malformedNextProject = path.join(root, 'McpMalformedNextTest.mix');

const child = spawn(process.execPath, [path.join(__dirname, 'mixly_mcp_server.js')], {
  cwd: root,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe']
});
const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextRequestId = 0;
let stderr = '';

child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
output.on('line', (line) => {
  const message = JSON.parse(line);
  const resolve = pending.get(message.id);
  if (!resolve) return;
  pending.delete(message.id);
  resolve(message);
});

function request(method, params = {}, timeoutMs = 120000) {
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Request timed out: ${method} ${params.name || ''}`));
    }, timeoutMs);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function call(name, args) {
  return request('tools/call', { name, arguments: args });
}

function cleanup() {
  fs.rmSync(libraryPath, { recursive: true, force: true });
  for (const filePath of [mutationProject, invalidIfProject, invalidOfficialProject, invalidProject, validProject, malformedNextProject]) {
    fs.rmSync(filePath, { force: true });
  }
}

function testLoadDiagnostics() {
  const parent = {
    id: 'parent-id', type: 'custom_container', parent: null, parentConnection: null
  };
  const child = {
    id: 'child-id', type: 'custom_action', parent,
    parentConnection: { kind: 'statement', name: 'DO' }
  };
  const grandchild = {
    id: 'grandchild-id', type: 'controls_delay', parent: child,
    parentConnection: { kind: 'next', name: null }
  };
  const diagnostics = projectLoadDiagnostics(
    { blocks: [parent, child, grandchild] },
    [{ id: parent.id, type: parent.type, parent: null }]
  );
  assert.deepEqual(diagnostics.missingTypes, [
    { type: 'controls_delay', expected: 1, loaded: 0, missing: 1 },
    { type: 'custom_action', expected: 1, loaded: 0, missing: 1 }
  ]);
  assert.deepEqual(diagnostics.missingBlocks[0], {
    id: 'child-id',
    type: 'custom_action',
    parent: { id: 'parent-id', type: 'custom_container' },
    parentConnection: { kind: 'statement', name: 'DO' },
    nearestLoadedAncestor: { id: 'parent-id', type: 'custom_container' }
  });
  assert.deepEqual(diagnostics.missingBlocks[1].nearestLoadedAncestor, {
    id: 'parent-id', type: 'custom_container'
  });
}

async function main() {
  cleanup();
  testLoadDiagnostics();
  await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'mixly-tree-validation-test', version: '1.0.0' }
  });

  const malformedNext = await call('mixly_save_project', {
    board: 'default/arduino_avr',
    projectPath: malformedNextProject,
    overwrite: true,
    requireChineseNames: false,
    projectXml: '<xml xmlns="http://www.w3.org/1999/xhtml"><block type="controls_delay" id="first"></block><next><block type="controls_delay" id="lost"></block></next></xml>'
  });
  assert.equal(malformedNext.result.isError, true);
  const malformedNextFailure = JSON.parse(malformedNext.result.content[0].text);
  assert.equal(malformedNextFailure.details.code, 'MIXLY_XML_STRUCTURE_INVALID');
  assert(malformedNextFailure.details.structureErrors.some((item) => item.code === 'CONNECTION_OUTSIDE_BLOCK'));
  assert.match(malformedNextFailure.details.hint, /tree|结构树/);
  assert.equal(fs.existsSync(malformedNextProject), false);

  const mutationBuild = await call('mixly_build_project', {
    board: 'default/arduino_avr',
    projectPath: mutationProject,
    overwrite: true,
    requireChineseNames: false,
    tree: {
      blocks: [{
        type: 'controls_if',
        id: 'if-root',
        values: {
          IF0: { block: { type: 'logic_boolean', id: 'if-zero', fields: { BOOL: 'TRUE' } } },
          IF1: { block: { type: 'logic_boolean', id: 'if-one', fields: { BOOL: 'FALSE' } } }
        },
        statements: {
          DO0: { type: 'controls_delay', id: 'do-zero', values: { DELAY_TIME: { shadow: { type: 'math_number', fields: { NUM: '1' } } } } },
          DO1: { type: 'controls_delay', id: 'do-one', values: { DELAY_TIME: { shadow: { type: 'math_number', fields: { NUM: '2' } } } } },
          ELSE: { type: 'controls_delay', id: 'do-else', values: { DELAY_TIME: { shadow: { type: 'math_number', fields: { NUM: '3' } } } } }
        }
      }]
    }
  });
  assert.equal(mutationBuild.result.isError, undefined);
  const mutationXml = fs.readFileSync(mutationProject, 'utf8');
  const mutationTag = (mutationXml.match(/<block type="controls_if"[\s\S]*?<mutation\b[^>]*>/) || [])[0];
  assert(mutationTag, mutationXml);
  assert.match(mutationTag, /elseif="1"/);
  assert.match(mutationTag, /else="1"/);
  assert.match(mutationXml, /<statement name="DO1">/);
  assert.match(mutationXml, /<statement name="ELSE">/);

  const invalidIf = await call('mixly_build_project', {
    board: 'default/arduino_avr',
    projectPath: invalidIfProject,
    overwrite: true,
    requireChineseNames: false,
    tree: {
      blocks: [{
        type: 'controls_if',
        id: 'bad-if',
        values: { IF0: { block: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } } },
        statements: { DO: { type: 'controls_delay' } }
      }]
    }
  });
  assert.equal(invalidIf.result.isError, true);
  const invalidIfFailure = JSON.parse(invalidIf.result.content[0].text);
  assert.deepEqual(invalidIfFailure.details.invalidNodes[0], {
    node: { type: 'controls_if', id: 'bad-if', path: 'blocks[0]' },
    owner: 'official/dynamic-aware',
    invalidNames: { fields: [], values: [], statements: ['DO'] },
    legalNames: { fields: [], values: ['IF0'], statements: ['DO0'] }
  });
  assert.equal(fs.existsSync(invalidIfProject), false);

  const invalidOfficial = await call('mixly_build_project', {
    board: 'default/arduino_avr',
    projectPath: invalidOfficialProject,
    overwrite: true,
    requireChineseNames: false,
    tree: {
      blocks: [{
        type: 'controls_delay',
        id: 'bad-delay',
        fields: { UNITS: 'delay' },
        values: { TIME: { shadow: { type: 'math_number', fields: { NUM: '1' } } } }
      }]
    }
  });
  assert.equal(invalidOfficial.result.isError, true);
  const invalidOfficialFailure = JSON.parse(invalidOfficial.result.content[0].text);
  assert.deepEqual(invalidOfficialFailure.details.invalidNodes[0], {
    node: { type: 'controls_delay', id: 'bad-delay', path: 'blocks[0]' },
    owner: 'official',
    invalidNames: { fields: ['UNITS'], values: ['TIME'], statements: [] },
    legalNames: { fields: ['UNIT'], values: ['DELAY_TIME'], statements: [] }
  });
  assert.equal(fs.existsSync(invalidOfficialProject), false);

  const created = await call('mixly_create_library', {
    libraryName,
    board: 'default/arduino_avr',
    overwrite: true,
    blocksJs: [
      "Blockly.Blocks['mcp_tree_contract_container'] = {",
      '  init: function() {',
      "    this.appendDummyInput().appendField('Mode', 'MODE');",
      "    this.appendValueInput('VALUE');",
      "    this.appendStatementInput('DO');",
      '    this.setPreviousStatement(true);',
      '    this.setNextStatement(true);',
      '  }',
      '};'
    ].join('\n'),
    generatorsJs: [
      "Blockly.Arduino.forBlock['mcp_tree_contract_container'] = function(block) {",
      "  block.getFieldValue('MODE');",
      "  Blockly.Arduino.valueToCode(block, 'VALUE', Blockly.Arduino.ORDER_NONE);",
      "  return Blockly.Arduino.statementToCode(block, 'DO');",
      '};'
    ].join('\n'),
    toolboxXml: '<category name="Contract"><block type="mcp_tree_contract_container"></block></category>',
    primitiveReasons: [{
      type: 'mcp_tree_contract_container',
      reason: 'Regression fixture for strict connection contracts',
      officialCandidatesChecked: ['controls_if']
    }]
  });
  assert.equal(created.result.isError, undefined, created.result.content && created.result.content[0].text);

  const specs = await call('mixly_get_block_specs', {
    board: 'default/arduino_avr',
    blockTypes: ['mcp_tree_contract_container']
  });
  const contract = specs.result.structuredContent.specs[0].contract;
  assert.deepEqual(contract.fieldNames, ['MODE']);
  assert.deepEqual(contract.valueInputs, ['VALUE']);
  assert.deepEqual(contract.statementInputs, ['DO']);

  const invalid = await call('mixly_build_project', {
    board: 'default/arduino_avr',
    projectPath: invalidProject,
    overwrite: true,
    requireChineseNames: false,
    tree: {
      blocks: [{
        type: 'mcp_tree_contract_container',
        id: 'bad-container',
        fields: { MOD: 'run' },
        values: { VALUE0: { shadow: { type: 'math_number', fields: { NUM: '1' } } } },
        statements: { DO0: { type: 'controls_delay' } }
      }]
    }
  });
  assert.equal(invalid.result.isError, true);
  const failure = JSON.parse(invalid.result.content[0].text);
  assert.equal(failure.details.writePrevented, true, JSON.stringify(failure, null, 2));
  assert.deepEqual(failure.details.invalidNodes[0], {
    node: { type: 'mcp_tree_contract_container', id: 'bad-container', path: 'blocks[0]' },
    owner: `ThirdParty/${libraryName}`,
    invalidNames: { fields: ['MOD'], values: ['VALUE0'], statements: ['DO0'] },
    legalNames: { fields: ['MODE'], values: ['VALUE'], statements: ['DO'] }
  });
  assert.equal(fs.existsSync(invalidProject), false);

  const valid = await call('mixly_build_project', {
    board: 'default/arduino_avr',
    projectPath: validProject,
    overwrite: true,
    requireChineseNames: false,
    tree: {
      blocks: [{
        type: 'mcp_tree_contract_container',
        id: 'valid-container',
        fields: { MODE: 'run' },
        values: { VALUE: { shadow: { type: 'math_number', fields: { NUM: '1' } } } },
        statements: { DO: { type: 'controls_delay' } }
      }]
    }
  });
  assert.equal(valid.result.isError, undefined, valid.result.content && valid.result.content[0].text);
  assert(valid.result.structuredContent.treeContractValidation.checkedTypes.includes('controls_delay'));
  assert(valid.result.structuredContent.treeContractValidation.checkedTypes.includes('math_number'));
  assert(valid.result.structuredContent.treeContractValidation.checkedTypes.includes('mcp_tree_contract_container'));
  assert(fs.existsSync(validProject));

  await request('shutdown');
  child.stdin.end();
  console.log('Mixly MCP tree normalization and contract validation regressions passed');
  console.log('Live-load diagnostics include missing IDs, types, parent blocks and parent connections');
}

main().catch((error) => {
  console.error(error);
  if (stderr) console.error(stderr);
  child.kill();
  process.exitCode = 1;
}).finally(cleanup);
