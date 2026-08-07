'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const clientPath = path.join(__dirname, 'mixly_mcp_call.js');
const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-mcp-call-test-'));
const argumentsPath = path.join(fixtureDirectory, 'arguments.json');
const argumentsText = `\uFEFF${JSON.stringify({
  sourceText: 'void setup() {}\nvoid loop() {}\n'
})}`;

function callClient(argumentSpecs, input) {
  const result = spawnSync(process.execPath, [
    clientPath,
    'mixly_analyze_source',
    ...argumentSpecs
  ], {
    cwd: root,
    input,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || `Client exited with ${result.status}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.language, 'C/C++');
  return output;
}

try {
  fs.writeFileSync(argumentsPath, argumentsText, 'utf8');
  callClient(['--args-file', argumentsPath]);
  callClient([`@${argumentsPath}`]);
  callClient(['-'], argumentsText);
  console.log('MCP call client passed: UTF-8 BOM accepted for --args-file, @file and stdin');
} finally {
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
}
