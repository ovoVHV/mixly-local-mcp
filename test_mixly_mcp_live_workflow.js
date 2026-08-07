'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const testDirectory = path.join(root, 'MixlyMcpLiveTest');
const outputSketch = path.join(testDirectory, 'LiftLightGenerated.ino');
const structuredProject = path.join(testDirectory, 'StructuredChinese.mix');
const structuredSketch = path.join(testDirectory, 'StructuredChinese', 'StructuredChinese.ino');
const workflowProject = path.join(testDirectory, 'Workflow.mix');
const workflowSketch = path.join(testDirectory, 'Workflow', 'Workflow.ino');
const child = spawn(process.execPath, [path.join(__dirname, 'mixly_mcp_server.js')], {
  cwd: root,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe']
});
const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let id = 0;
let stderr = '';

child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
output.on('line', (line) => {
  const message = JSON.parse(line);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  request(message);
});

function request(method, params = {}, timeoutMs = 240000) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Request timed out: ${method} ${params.name || ''}`));
    }, timeoutMs);
    pending.set(requestId, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
}

async function call(name, args, timeoutMs) {
  const response = await request('tools/call', { name, arguments: args }, timeoutMs);
  if (response.result && response.result.isError) {
    throw new Error(`${name} failed: ${response.result.content[0].text}`);
  }
  return response.result.structuredContent;
}

function clean() {
  const relative = path.relative(root, testDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to clean path outside workspace: ${testDirectory}`);
  }
  fs.rmSync(testDirectory, { recursive: true, force: true });
}

async function main() {
  clean();
  await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'mixly-live-test', version: '1.0.0' }
  });

  const packaged = await call('mixly_package_library', {
    library: 'LiftLight', board: 'arduino_avr'
  });
  assert.equal(packaged.directoryEntries, 0);
  assert.equal(packaged.fileEntries, 3);

  const launched = await call('mixly_launch', { cdpPort: 9333 });
  assert.equal(launched.cdpPort, 9333);

  const imported = await call('mixly_import_library', {
    zipPath: packaged.zipPath, libraryName: 'LiftLight',
    board: 'default/arduino_avr', cdpPort: 9333
  });
  assert.equal(imported.error, null);
  assert.deepEqual(imported.files, ['blocks.js', 'generators.js', 'liftlight.xml']);

  await call('mixly_open_project', {
    projectPath: path.join(root, 'Nano_Lift_Lighting.mix'),
    board: 'arduino_avr', cdpPort: 9333, waitMs: 60000
  }, 120000);

  const validated = await call('mixly_validate_project', {
    projectPath: path.join(root, 'Nano_Lift_Lighting.mix'),
    customPrefixes: ['liftlight_'], requireChineseNames: false, cdpPort: 9333
  });
  assert.equal(validated.totalNodes, 369);
  assert.equal(validated.customNodes, 28);
  assert.equal(validated.chineseProcedures.length, 9);
  assert(validated.staticCompatibility.duplicateIds.length > 0);
  assert(validated.overlaps.some((pair) => pair.includes('ll-43') && pair.includes('ll-131')));
  assert(validated.warnings.some((warning) => /重复/.test(warning)));
  assert(validated.warnings.some((warning) => /重叠/.test(warning)));

  const generated = await call('mixly_generate_code', {
    projectPath: path.join(root, 'Nano_Lift_Lighting.mix'),
    outputPath: outputSketch, cdpPort: 9333
  });
  assert.equal(generated.totalNodes, 369);
  assert(generated.codeLength > 4000);
  assert(fs.existsSync(outputSketch));

  const compiled = await call('mixly_compile', {
    sketchPath: outputSketch,
    fqbns: ['arduino:avr:nano:cpu=atmega328', 'arduino:avr:nano:cpu=atmega328old']
  }, 360000);
  assert.equal(compiled.passed, true);
  assert.equal(compiled.staged, true);
  assert.equal(compiled.results.length, 2);
  assert(compiled.results.every((result) => result.code === 0));

  console.log('MCP live workflow passed');
  console.log(`ZIP: ${packaged.fileEntries} files / ${packaged.directoryEntries} directories`);
  console.log(`Mixly: ${validated.totalNodes} blocks (${validated.nativeNodes} native + ${validated.customNodes} custom)`);
  console.log(`Chinese procedures: ${validated.chineseProcedures.length}; generated code: ${generated.codeLength} bytes`);
  for (const result of compiled.results) {
    console.log(`${result.fqbn}: Flash ${result.metrics.flash.used}/${result.metrics.flash.maximum}, SRAM ${result.metrics.sram.used}/${result.metrics.sram.maximum}`);
  }

  const structured = await call('mixly_build_project', {
    board: 'default/arduino_avr', projectPath: structuredProject, overwrite: true,
    tree: {
      boardAttribute: 'Arduino AVR@Arduino Nano',
      blocks: [
        {
          type: 'variables_declare',
          fields: { variables_type: 'global_variate', VAR: '当前计数', TYPE: 'int' },
          values: { VALUE: { shadow: { type: 'math_number', fields: { NUM: '0' } } } }
        },
        {
          type: 'variables_declare',
          fields: { variables_type: 'global_variate', VAR: '运行状态', TYPE: 'boolean' },
          values: { VALUE: { block: { type: 'logic_boolean', fields: { BOOL: 'TRUE' } } } }
        },
        {
          type: 'procedures_defnoreturn', fields: { NAME: '设置计数' },
          mutation: { args: [{ name: '新数值', vartype: 'int' }] },
          statements: {
            STACK: {
              type: 'variables_set', fields: { VAR: '当前计数' },
              values: { VALUE: { block: { type: 'variables_get', fields: { VAR: '新数值' } } } }
            }
          }
        },
        {
          type: 'base_setup',
          statements: {
            DO: {
              type: 'procedures_callnoreturn',
              mutation: { name: '设置计数', args: [{ name: '新数值' }] },
              values: { ARG0: { shadow: { type: 'math_number', fields: { NUM: '1' } } } }
            }
          }
        },
        {
          type: 'procedures_callnoreturn',
          mutation: { name: '设置计数', args: [{ name: '新数值' }] },
          values: { ARG0: { block: { type: 'variables_get', fields: { VAR: '当前计数' } } } }
        }
      ]
    }
  });
  assert.equal(structured.topVariableDeclarationStacks, 1);
  assert.equal(structured.namingViolations.length, 0);
  await call('mixly_open_project', {
    projectPath: structuredProject, board: 'default/arduino_avr', cdpPort: 9333, waitMs: 60000
  }, 120000);
  const structuredValidation = await call('mixly_validate_project', {
    projectPath: structuredProject, cdpPort: 9333
  });
  assert.equal(structuredValidation.passed, true);
  assert.equal(structuredValidation.topVariableDeclarationStacks, 1);
  assert.equal(structuredValidation.overlaps.length, 0);
  assert.deepEqual(structuredValidation.chineseProcedures, ['设置计数']);
  await call('mixly_generate_code', {
    projectPath: structuredProject, outputPath: structuredSketch, cdpPort: 9333
  });
  const structuredCompile = await call('mixly_compile', {
    sketchPath: structuredSketch, fqbn: 'arduino:avr:nano:cpu=atmega328'
  }, 360000);
  assert.equal(structuredCompile.passed, true, JSON.stringify(structuredCompile, null, 2));
  console.log(`Structured builder passed: ${structured.totalNodes} blocks, one chained variable stack, Chinese names, no overlap`);

  const workflow = await call('mixly_project_workflow', {
    board: 'default/arduino_avr@Arduino Nano',
    projectPath: workflowProject,
    outputPath: workflowSketch,
    overwrite: true,
    cdpPort: 9333,
    waitMs: 60000,
    compile: true,
    fqbn: 'arduino:avr:nano:cpu=atmega328',
    compileTimeoutMs: 360000,
    tree: {
      blocks: [
        { type: 'base_setup', statements: {} },
        {
          type: 'controls_delay', fields: { UNIT: 'delay' },
          values: { DELAY_TIME: { shadow: { type: 'math_number', fields: { NUM: '10' } } } }
        }
      ]
    }
  }, 480000);
  assert.equal(workflow.passed, true);
  assert.equal(workflow.board, 'default/arduino_avr@Arduino Nano');
  assert.equal(workflow.fqbn, 'arduino:avr:nano');
  assert.equal(workflow.stages.validated.passed, true);
  assert.equal(workflow.stages.compiled.passed, true);
  assert(fs.existsSync(workflowProject));
  assert(fs.existsSync(workflowSketch));
  console.log('One-call project workflow passed: build, open, validate, generate and compile');
  await request('shutdown');
  child.stdin.end();
}

main().catch((error) => {
  console.error(error);
  if (stderr) console.error(stderr);
  child.kill();
  process.exitCode = 1;
}).finally(() => {
  clean();
});
