'use strict';

const assert = require('assert');
const path = require('path');
const readline = require('readline');
const { performance } = require('perf_hooks');
const { spawn } = require('child_process');

const child = spawn(process.execPath, [path.join(__dirname, 'mixly_mcp_server.js')], {
  cwd: __dirname,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit']
});
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 1;

lines.on('line', (line) => {
  const message = JSON.parse(line);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  waiter.resolve(message);
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout: ${method}`));
    }, 60000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function timedCall(name, args) {
  const startedAt = performance.now();
  const response = await request('tools/call', { name, arguments: args });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(response.result.isError, undefined, response.result.content && response.result.content[0].text);
  return { response, elapsedMs };
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'compact-result-test', version: '1' }
  });

  const first = await timedCall('mixly_scan_library', {
    board: 'default/arduino_avr', query: 'rgb', refresh: true
  });
  const second = await timedCall('mixly_scan_library', {
    board: 'default/arduino_avr', query: 'rgb'
  });
  const full = await timedCall('mixly_scan_library', {
    board: 'default/arduino_avr', full: true
  });
  const summary = await timedCall('mixly_scan_library', {
    board: 'default/arduino_avr'
  });
  const multi = await timedCall('mixly_scan_library', {
    board: 'default/arduino_avr', queries: ['display_rgb', 'DHT'], limit: 5, includeSpecs: true
  });

  const firstValue = first.response.result.structuredContent;
  const secondValue = second.response.result.structuredContent;
  const fullValue = full.response.result.structuredContent;
  const summaryValue = summary.response.result.structuredContent;
  const multiValue = multi.response.result.structuredContent;
  assert.equal(firstValue.cache.hit, false);
  assert.equal(secondValue.cache.hit, true);
  assert(second.elapsedMs < first.elapsedMs, `${second.elapsedMs} should be below ${first.elapsedMs}`);
  assert(firstValue.availableBlockTypes.includes('display_rgb'));
  assert(firstValue.availableBlockTypes.length <= 60);
  assert.equal(summaryValue.resultMode, 'summary');
  assert.deepEqual(summaryValue.availableBlockTypes, []);
  assert.equal(multiValue.resultMode, 'multi-filtered');
  assert.equal(multiValue.matches.length, 2);
  assert(multiValue.availableBlockTypes.includes('display_rgb'));
  assert(multiValue.availableBlockTypes.includes('DHT'));
  assert(multiValue.specs.some((spec) => spec.type === 'display_rgb'));
  assert(multiValue.specs.some((spec) => spec.type === 'DHT'));

  const queryBytes = Buffer.byteLength(JSON.stringify(firstValue));
  const fullBytes = Buffer.byteLength(JSON.stringify(fullValue));
  const textBytes = Buffer.byteLength(first.response.result.content[0].text);
  assert(queryBytes < fullBytes, `${queryBytes} should be below ${fullBytes}`);
  assert(textBytes < queryBytes, `${textBytes} should be below ${queryBytes}`);

  const detected = await timedCall('mixly_detect_environment', {});
  assert.equal(detected.response.result.structuredContent.arduinoCli.probe, null);
  assert.equal(detected.response.result.structuredContent.detailsIncluded, false);
  assert.equal(Object.hasOwn(detected.response.result.structuredContent.boards[0], 'profiles'), false);

  const specsFirst = await timedCall('mixly_get_block_specs', {
    board: 'default/arduino_avr', blockTypes: ['display_rgb']
  });
  const specsSecond = await timedCall('mixly_get_block_specs', {
    board: 'default/arduino_avr', blockTypes: ['display_rgb']
  });
  assert.equal(specsFirst.response.result.structuredContent.examplesIncluded, false);
  assert.equal(specsSecond.response.result.structuredContent.cache.hit, true);

  child.stdin.end();
  console.log(JSON.stringify({
    firstScanMs: Number(first.elapsedMs.toFixed(1)),
    cachedScanMs: Number(second.elapsedMs.toFixed(1)),
    queryBytes,
    fullBytes,
    textBytes,
    detectMs: Number(detected.elapsedMs.toFixed(1)),
    cachedSpecsMs: Number(specsSecond.elapsedMs.toFixed(1)),
    multiScanMs: Number(multi.elapsedMs.toFixed(1)),
    multiBytes: Buffer.byteLength(JSON.stringify(multiValue))
  }));
}

main().catch((error) => {
  child.kill();
  console.error(error.stack || error);
  process.exitCode = 1;
});
