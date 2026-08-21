'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const workspaceRoot = path.resolve(__dirname, '..');
const fixtureRoot = path.join(workspaceRoot, `.mixly4-wasm-fixture-${process.pid}`);
const serverPath = path.join(__dirname, 'mixly_mcp_server.js');
let child;
let lines;
let nextId = 0;
const pending = new Map();

function writeFixture(relativePath, content, encoding = 'utf8') {
  const destination = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, encoding);
}

function tarEntry(name, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.fill(32, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function writeTar(relativePath, entries) {
  const body = Buffer.concat([
    ...entries.map(([name, value]) => tarEntry(name, value)),
    Buffer.alloc(1024)
  ]);
  writeFixture(relativePath, body);
}

function createFixture() {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  writeFixture('package.json', JSON.stringify({
    name: 'Mixly',
    version: '4.0Pre-fixture',
    'node-main': './static-server/server.js',
    main: 'http://localhost:65234',
    'chromium-args': '--user-data-dir=./nw_cache/'
  }));
  writeFixture('boards.json', JSON.stringify([
    { boardType: 'Arduino AVR', boardIndex: './boards/default/arduino_avr/index.xml', language: 'C/C++' }
  ]));
  writeFixture('boards/default/arduino_avr/index.xml', '<xml></xml>');
  writeFixture('boards/default/arduino_avr/config.json', JSON.stringify({
    board: { Nano: { key: 'arduino:avr:nano', config: [] } }
  }));
  writeFixture('boards/default/arduino/index.xml', '<xml></xml>');
  const manifest = {
    libraries: {
      Adafruit_SSD1306: {
        include: 'libraries/Adafruit_SSD1306',
        includes: ['libraries/Adafruit_SSD1306'],
        files: [
          'libraries/Adafruit_SSD1306/Adafruit_SSD1306.cpp',
          'libraries/Adafruit_SSD1306/Adafruit_SSD1306.h',
          'libraries/Adafruit_SSD1306/library.properties'
        ],
        version: '2.4.5',
        displayName: 'Adafruit SSD1306',
        dependencies: ['Adafruit_GFX_Library']
      }
    }
  };
  writeTar('common/modules/web-modules/mixly/wasm/avr-libraries_fixture.tar', [
    ['libraries.manifest.json', JSON.stringify(manifest)]
  ]);
  writeTar('common/modules/web-modules/mixly/wasm/avrwasm_fixture.tar', [
    ['avrwasm/manifest.json', JSON.stringify({ boards: [{ board: 'nano', mcu: 'atmega328p' }] })]
  ]);
}

function startServer() {
  child = spawn(process.execPath, [serverPath], {
    cwd: workspaceRoot,
    env: { ...process.env, MIXLY_HOME: fixtureRoot },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
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
  child.stderr.resume();
}

function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function call(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  assert(result.result && !result.result.isError, `${name} failed`);
  return result.result.structuredContent;
}

async function main() {
  createFixture();
  startServer();
  await request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'mixly4-fixture', version: '1.0.0' }
  });
  const environment = await call('mixly_detect_environment', { probeCli: false });
  assert.equal(environment.mixlyLayout.generation, 4);
  assert.equal(environment.mixlyLayout.runtime, 'nwjs');
  assert.equal(environment.compileEngines.desktop.engine, 'browser-wasm');
  assert.equal(environment.compileEngines.mcp.engine, 'arduino-cli');
  assert.equal(environment.compileEngines.mcp.desktopEquivalent, false);
  assert(environment.boards.some((board) => board.id === 'default/arduino_avr'));
  assert(!environment.boards.some((board) => board.id === 'default/arduino'));
  const avrPackage = environment.wasmPackages.find((item) => item.kind === 'libraries');
  assert.equal(avrPackage.libraryCount, 1);
  assert(avrPackage.archiveBytes > 0);
  const avrCompiler = environment.wasmPackages.find((item) => item.kind === 'compiler');
  assert.deepEqual(avrCompiler.compilerFqbns, ['arduino:avr:nano']);
  const catalog = await call('mixly_scan_arduino_libraries', {
    board: 'default/arduino_avr',
    libraryNames: ['Adafruit_SSD1306'],
    headers: ['Adafruit_SSD1306.h'],
    includeFiles: true
  });
  assert.equal(catalog.source, 'mixly4-wasm');
  assert.equal(catalog.libraryCount, 1);
  assert.equal(catalog.libraries[0].version, '2.4.5');
  assert(catalog.libraries[0].files.some((file) => /Adafruit_SSD1306\.h$/.test(file)));
  child.stdin.end();
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

main().catch((error) => {
  try { if (child && !child.killed) child.kill(); } catch (_) { /* best effort */ }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
