'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly4-mcp-fixture-'));
fs.mkdirSync(path.join(fixtureRoot, 'boards', 'default', 'arduino_avr'), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, 'static-server'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({
  version: '4.0Pre',
  'node-main': './static-server/server.js',
  main: 'http://localhost:65234'
}));
fs.writeFileSync(path.join(fixtureRoot, 'static-server', 'server.js'), '');
fs.writeFileSync(path.join(fixtureRoot, 'boards', 'index.html'), '<!doctype html>');
fs.writeFileSync(path.join(fixtureRoot, 'boards', 'default', 'arduino_avr', 'index.xml'), '<xml/>');

process.env.MIXLY_HOME = fixtureRoot;
const server = require('./mixly_mcp_server.js');
const layout = server.detectMixlyLayout(fixtureRoot);
assert.equal(layout.generation, 4);
assert.equal(layout.runtime, 'nwjs');
assert.equal(server.mixlyHttpOrigin(layout), 'http://localhost:65234');

const mixly4Url = server.buildEditorUrl({
  thirdParty: false,
  boardIndex: './boards/default/arduino_avr/index.xml',
  boardType: 'Arduino AVR',
  boardImg: './boards/default/arduino_avr/media/uno.png',
  language: 'C/C++'
}, 'C:/outside/project.mix', layout, fixtureRoot);
assert.match(mixly4Url, /^http:\/\/localhost:65234\/boards\/index\.html\?/);
assert(!mixly4Url.startsWith('file:'));
assert(!mixly4Url.includes('filePath='), 'Mixly 4 must load project text through EditorMix');

const oldLayout = { generation: 2, runtime: 'electron', packageJson: {} };
const oldUrl = server.buildEditorUrl({
  thirdParty: false,
  boardIndex: './boards/default/arduino_avr/index.xml',
  boardType: 'Arduino AVR',
  boardImg: './boards/default/arduino_avr/media/uno.png',
  language: 'C/C++'
}, 'C:/workspace/project.mix', oldLayout, fixtureRoot);
assert(oldUrl.startsWith('file:///'));
assert(oldUrl.includes('filePath=C%3A%2Fworkspace%2Fproject.mix'));

const targets = [
  { id: 'other', type: 'page', title: 'Other', url: 'http://localhost:65234/other.html', webSocketDebuggerUrl: 'ws://other' },
  { id: 'mixvm', type: 'page', title: 'MixVM', url: 'http://localhost:65234/mixvm/index.html', webSocketDebuggerUrl: 'ws://mixvm' },
  { id: 'devtools', type: 'page', title: 'DevTools', url: 'devtools://devtools', webSocketDebuggerUrl: 'ws://devtools' },
  { id: 'editor', type: 'page', title: 'Mixly', url: 'http://localhost:65234/boards/index.html', webSocketDebuggerUrl: 'ws://editor' }
];
assert.equal(server.selectCdpTarget(targets, 'http://localhost:65234').id, 'editor');
assert.equal(server.selectCdpTarget(targets, 'http://localhost:65234').type, 'page');
const guidance = server.generationAwareWorkflow();
assert.equal(guidance.generation, 4);
assert.equal(guidance.compileEngine, 'browser-wasm');
assert.equal(guidance.finalTool, 'mixly_project_workflow');
assert(guidance.rules.some((rule) => rule.includes('wasmSketchFiles')));
assert.match(server.mcpServerInstructions(), /强制规则/);
assert.match(server.mcpServerInstructions(), /PluginManager\/OPFS/);
assert.match(server.mcpServerInstructions(), /桌面 WASM 编译/);
process.env.MIXLY_CDP_PORT = '9347';
assert.equal(server.getCdpPort({}), 9347);
assert.equal(server.getCdpPort({ cdpPort: 9355 }), 9355);

(async () => {
  const diagnostics = await server.getCdpDiagnostics(1, 250);
  assert.equal(diagnostics.available, false);
  assert.equal(diagnostics.reason, 'endpoint-unavailable');
  assert(Array.isArray(diagnostics.attempts));
  console.log('Mixly 4 runtime fixture passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
