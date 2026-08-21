'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const cdpPort = Number(process.env.MIXLY_CDP_PORT || 9347);
const mixlyHome = path.resolve(process.env.MIXLY_HOME || 'E:\\mixly4_win-x86\\mixly4_win');
const installRoot = path.resolve(
  process.env.MIXLY_HARNESS_HOME || path.join(process.env.LOCALAPPDATA, 'MixlyHarness')
);
const serverPath = path.join(installRoot, 'mcp', 'mixly_mcp_server.js');
const argsPath = path.resolve(
  process.env.MIXLY_LIVE_PREVIEW_ARGS || path.join(mixlyHome, 'McpLivePreviewArgs.json')
);
const screenshotPath = path.join(__dirname, 'mixly4_live_preview_panel.png');

async function findBoardPage() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  assert(response.ok, `CDP target lookup failed: HTTP ${response.status}`);
  const pages = await response.json();
  const page = pages.find((item) => item.type === 'page'
    && item.webSocketDebuggerUrl
    && /\/boards\/index\.html(?:[?#]|$)/i.test(item.url || ''));
  assert(page, `Mixly 4 board page not found on CDP ${cdpPort}`);
  return page;
}

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function pageState(cdp) {
  return JSON.parse(await evaluate(cdp, `(()=>{
    const panel=document.querySelector('#mixly-harness-panel');
    const frame=panel&&panel.querySelector('.mixly-harness-frame');
    const workspace=typeof Blockly==='object'&&typeof Blockly.getMainWorkspace==='function'
      ?Blockly.getMainWorkspace():null;
    const blocks=workspace&&typeof workspace.getAllBlocks==='function'
      ?workspace.getAllBlocks(false).map((block)=>{
        const root=typeof block.getSvgRoot==='function'?block.getSvgRoot():null;
        const rect=root&&root.getBoundingClientRect();
        const xy=typeof block.getRelativeToSurfaceXY==='function'?block.getRelativeToSurfaceXY():null;
        return {
          type:block.type,
          rendered:block.rendered,
          xy:xy&&{x:xy.x,y:xy.y},
          rect:rect&&{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
          fields:Object.fromEntries(block.inputList.flatMap((input)=>input.fieldRow)
            .filter((field)=>field&&field.name)
            .map((field)=>[field.name,field.getValue()]))
        };
      }):[];
    return JSON.stringify({
      url:location.href,
      panel:{
        exists:Boolean(panel),
        open:panel&&panel.dataset.open,
        generation:panel&&panel.dataset.generation,
        frame:frame&&frame.src,
        rect:panel&&(()=>{const rect=panel.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}})()
      },
      blocks,
      workspace:workspace&&{
        scale:workspace.scale,
        scrollX:workspace.scrollX,
        scrollY:workspace.scrollY,
        scrollMethod:typeof workspace.scroll,
        centerOnBlockMethod:typeof workspace.centerOnBlock,
        zoomToFitMethod:typeof workspace.zoomToFit,
        scrollbarSetMethod:workspace.scrollbar&&typeof workspace.scrollbar.set,
        metrics:typeof workspace.getMetrics==='function'?workspace.getMetrics():null,
        injectionRect:workspace.getInjectionDiv&&workspace.getInjectionDiv()
          ?(()=>{const rect=workspace.getInjectionDiv().getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height}})():null
      }
    });
  })()`));
}

function callBuildProject() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: mixlyHome,
      windowsHide: true,
      env: {
        ...process.env,
        MIXLY_HOME: mixlyHome,
        MIXLY4_HOME: mixlyHome,
        MIXLY_MIXLY4: '1',
        MIXLY_CDP_PORT: String(cdpPort),
        MIXLY_EXPECTED_ORIGIN: 'http://localhost:65234',
        MIXLY_MCP_TOOL_MODE: 'compact'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = '';
    let settled = false;
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: {
            name: 'mixly_build_project',
            arguments: JSON.parse(fs.readFileSync(argsPath, 'utf8'))
          }
        })}\n`);
      } else if (message.id === 2) {
        settled = true;
        child.stdin.end();
        if (message.result?.isError) reject(new Error(message.result.content?.[0]?.text || stderr));
        else resolve(message.result?.structuredContent || {});
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(stderr || `MCP process exited with ${code}`));
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'mixly4-live-preview-panel-test', version: '1.0.0' }
      }
    })}\n`);
  });
}

async function main() {
  assert(fs.existsSync(serverPath), `Installed MCP server not found: ${serverPath}`);
  assert(fs.existsSync(argsPath), `Live preview arguments not found: ${argsPath}`);
  const beforePage = await findBoardPage();
  const cdp = await connect(beforePage);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    const before = await pageState(cdp);
    assert.equal(before.panel.exists, true, 'Mixly AI panel is missing before live preview');
    assert.equal(before.panel.open, 'true', 'Mixly AI panel is closed before live preview');

    const build = await callBuildProject();
    assert.equal(build.livePreview?.updated, true, JSON.stringify(build.livePreview));
    assert.equal(build.livePreview?.navigated, false, JSON.stringify(build.livePreview));

    const afterPage = await findBoardPage();
    assert.equal(afterPage.id, beforePage.id, 'Live preview replaced the Mixly page target');
    assert.equal(afterPage.url, beforePage.url, 'Live preview navigated the Mixly board page');
    const after = await pageState(cdp);
    assert.equal(after.url, before.url, 'Live preview changed location.href');
    assert.equal(after.panel.exists, true, 'Mixly AI panel disappeared after live preview');
    assert.equal(after.panel.open, 'true', 'Mixly AI panel closed after live preview');
    assert.equal(after.panel.generation, '4');
    assert.match(after.panel.frame || '', /^http:\/\/127\.0\.0\.1:30\d{2}\/?$/);
    assert(after.blocks.some((block) => block.type === 'controls_delay'), 'controls_delay block was not inserted');
    assert(after.blocks.some((block) => block.type === 'math_number' && String(block.fields.NUM) === '750'),
      'math_number shadow with value 750 was not inserted');
    const visibleDelay = after.blocks.find((block) => block.type === 'controls_delay');
    assert(visibleDelay.rect && visibleDelay.rect.width > 0 && visibleDelay.rect.height > 0,
      'controls_delay block does not have a rendered SVG rectangle');
    assert(visibleDelay.rect.x >= after.workspace.metrics.absoluteLeft,
      'controls_delay block is hidden behind the Blockly toolbox');
    assert(visibleDelay.rect.x + visibleDelay.rect.width <= after.panel.rect.x,
      'controls_delay block is hidden behind the Mixly AI panel');

    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    process.stdout.write(`${JSON.stringify({
      passed: true,
      targetId: beforePage.id,
      url: beforePage.url,
      livePreview: build.livePreview,
      panelBefore: before.panel,
      panelAfter: after.panel,
      workspace: after.workspace,
      blocks: after.blocks,
      screenshotPath
    }, null, 2)}\n`);
  } finally {
    cdp.socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
