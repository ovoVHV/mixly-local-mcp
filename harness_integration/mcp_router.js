'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const contextPath = process.env.MIXLY_CONTEXT_FILE;
const mcpNode = process.env.MIXLY_MCP_NODE || process.execPath;
const mcpServer = process.env.MIXLY_MCP_SERVER;
let child = null;
let childContextKey = '';
let pinnedContext = null;
let childSequence = 0;
let initializeParams = null;
let initialized = false;
let queue = Promise.resolve();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function readContext() {
  if (!contextPath || !fs.existsSync(contextPath)) {
    throw new Error('Mixly Harness 活动环境尚未建立，请从 Mixly 顶栏重新打开 AI 客户端。');
  }
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const mixlyHome = path.resolve(String(context.mixlyHome || ''));
  if (!fs.existsSync(mixlyHome) || !fs.statSync(mixlyHome).isDirectory()) {
    throw new Error(`Mixly Harness 活动目录无效: ${mixlyHome}`);
  }
  return {
    ...context,
    mixlyHome,
    generation: String(context.generation || '0'),
    cdpPort: String(context.cdpPort || ''),
    origin: String(context.origin || '')
  };
}

function contextKey(context) {
  return [
    context.mixlyHome.toLowerCase(),
    context.generation,
    context.cdpPort,
    context.origin
  ].join('|');
}

function stopChild() {
  if (!child) return;
  child.close();
  child = null;
  childContextKey = '';
}

function createChild(context) {
  if (!mcpServer || !fs.existsSync(mcpServer)) {
    throw new Error(`Mixly MCP 服务文件不存在: ${mcpServer || '(unset)'}`);
  }
  const processHandle = spawn(mcpNode, [mcpServer], {
    cwd: context.mixlyHome,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MIXLY_HOME: context.mixlyHome,
      MIXLY4_HOME: context.mixlyHome,
      MIXLY_MCP_TOOL_MODE: 'compact',
      MIXLY_CDP_PORT: context.cdpPort,
      MIXLY_EXPECTED_ORIGIN: context.origin,
      MIXLY_MIXLY4: context.generation === '4' ? '1' : '0'
    }
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: processHandle.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      process.stderr.write(`[Mixly MCP router] invalid child output: ${line}\n`);
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
      return;
    }
    write(message);
  });
  processHandle.stderr.on('data', (data) => process.stderr.write(`[Mixly MCP] ${data}`));
  processHandle.on('exit', (code, signal) => {
    for (const resolve of pending.values()) {
      resolve({
        jsonrpc: '2.0',
        error: { code: -32001, message: `Mixly MCP 已退出 (${code ?? signal ?? 'unknown'})` }
      });
    }
    pending.clear();
    if (child && child.processHandle === processHandle) {
      child = null;
      childContextKey = '';
    }
  });

  return {
    processHandle,
    notify(message) {
      processHandle.stdin.write(`${JSON.stringify(message)}\n`);
    },
    request(message) {
      return new Promise((resolve, reject) => {
        const originalId = message.id;
        const proxyId = `mixly-router-${process.pid}-${++childSequence}`;
        const timer = setTimeout(() => {
          pending.delete(proxyId);
          reject(new Error(`Mixly MCP 调用超时: ${message.method || 'unknown'}`));
        }, 190000);
        pending.set(proxyId, (response) => {
          clearTimeout(timer);
          resolve({ ...response, id: originalId });
        });
        processHandle.stdin.write(`${JSON.stringify({ ...message, id: proxyId })}\n`);
      });
    },
    close() {
      lines.close();
      if (!processHandle.killed) processHandle.kill();
    }
  };
}

async function ensureChild() {
  // A Harness process owns exactly one Mixly context. The launcher restarts
  // Harness to switch generations so an unrelated window cannot steal a task.
  if (!pinnedContext) pinnedContext = readContext();
  const context = pinnedContext;
  const key = contextKey(context);
  if (child && childContextKey === key) return child;
  stopChild();
  child = createChild(context);
  childContextKey = key;
  if (initializeParams) {
    const response = await child.request({
      jsonrpc: '2.0',
      id: 'mixly-router-initialize',
      method: 'initialize',
      params: initializeParams
    });
    if (response.error) throw new Error(response.error.message || 'Mixly MCP 初始化失败');
    if (initialized) child.notify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  }
  return child;
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  try {
    if (message.method === 'initialize') {
      initializeParams = message.params || {};
      const active = await ensureChild();
      write(await active.request(message));
      return;
    }
    if (message.method === 'notifications/initialized') initialized = true;
    const active = await ensureChild();
    if (message.id === undefined) {
      active.notify(message);
      return;
    }
    write(await active.request(message));
  } catch (error) {
    if (message.id === undefined) {
      process.stderr.write(`[Mixly MCP router] ${error.stack || error.message || error}\n`);
      return;
    }
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: error.message || String(error) }
    });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  queue = queue.then(async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    await handle(message);
  });
});
input.on('close', stopChild);
process.on('SIGTERM', () => {
  stopChild();
  process.exit(0);
});
