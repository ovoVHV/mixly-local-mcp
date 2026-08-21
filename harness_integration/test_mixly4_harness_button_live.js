'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const cdpPort = Number(process.env.MIXLY_CDP_PORT || 9347);
const installRoot = path.resolve(
  process.env.MIXLY_HARNESS_HOME || path.join(process.env.LOCALAPPDATA, 'MixlyHarness')
);
const expectedHome = path.resolve(process.env.MIXLY_HOME || 'E:\\mixly4_win-x86\\mixly4_win');
const screenshotPath = path.join(__dirname, 'mixly4_context_lock_live.png');
const expectRestore = process.env.MIXLY_TEST_EXPECT_PANEL_RESTORE === '1';

async function connect() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!response.ok) throw new Error(`CDP target lookup failed: HTTP ${response.status}`);
  const pages = (await response.json()).filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  const page = pages.find((item) => /\/boards\/index\.html(?:[?#]|$)/i.test(item.url || ''))
    || (process.env.MIXLY_TEST_NAVIGATE_URL
      ? pages.find((item) => /^https?:\/\/localhost:65234\//i.test(item.url || ''))
      : null);
  if (!page) throw new Error(`Mixly 4 board page not found on CDP ${cdpPort}`);

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
  return { page, socket, send };
}

async function main() {
  const cdp = await connect();
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };

  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.bringToFront');
    if (process.env.MIXLY_TEST_NAVIGATE_URL) {
      await cdp.send('Page.navigate', { url: process.env.MIXLY_TEST_NAVIGATE_URL });
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    await cdp.send('Page.reload', { ignoreCache: true });

    let button = null;
    const buttonDeadline = Date.now() + 30000;
    while (Date.now() < buttonDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        button = JSON.parse(await evaluate(`(()=>{
          const node=document.querySelector('#mixly-harness-button');
          if(!node)return JSON.stringify(null);
          const rect=node.getBoundingClientRect();
          node.addEventListener('click',(event)=>{globalThis.__mixlyHarnessTrustedClick=event.isTrusted;},{once:true,capture:true});
          const selected=typeof Mixly==='object'&&Mixly.Boards&&typeof Mixly.Boards.getSelectedBoardName==='function'
            ?Mixly.Boards.getSelectedBoardName():'';
          return JSON.stringify({title:node.title,disabled:node.disabled,x:rect.x,y:rect.y,width:rect.width,height:rect.height,selected,url:location.href});
        })()`));
      } catch (_) {
        button = null;
      }
      if (button && button.width >= 2 && button.height >= 2) break;
    }
    assert(button, 'Mixly AI toolbar button did not load after the real page reload');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    button = JSON.parse(await evaluate(`(()=>{
      const node=document.querySelector('#mixly-harness-button');
      if(!node)return JSON.stringify(null);
      const rect=node.getBoundingClientRect();
      node.addEventListener('click',(event)=>{globalThis.__mixlyHarnessTrustedClick=event.isTrusted;},{once:true,capture:true});
      const selected=typeof Mixly==='object'&&Mixly.Boards&&typeof Mixly.Boards.getSelectedBoardName==='function'
        ?Mixly.Boards.getSelectedBoardName():'';
      return JSON.stringify({title:node.title,disabled:node.disabled,x:rect.x,y:rect.y,width:rect.width,height:rect.height,selected,url:location.href});
    })()`));
    assert.equal(button.disabled, false);
    assert.match(button.title, /Mixly 4 AI/);

    const x = button.x + button.width / 2;
    const y = button.y + button.height / 2;
    if (!expectRestore) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1
      });
    }

    let panel = null;
    const panelDeadline = Date.now() + 100000;
    while (Date.now() < panelDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      panel = JSON.parse(await evaluate(`(()=>{
        const node=document.querySelector('#mixly-harness-panel');
        if(!node)return JSON.stringify(null);
        const title=node.querySelector('.mixly-harness-title');
        const frame=node.querySelector('.mixly-harness-frame');
        return JSON.stringify({
          open:node.dataset.open,
          generation:node.dataset.generation,
          title:title&&title.textContent,
          root:title&&title.title,
          frame:frame&&frame.src,
          trusted:globalThis.__mixlyHarnessTrustedClick
        });
      })()`));
      if (panel && panel.open === 'true' && panel.title === 'Mixly AI · Mixly 4') break;
    }

    assert(panel, 'Mixly AI panel was not created');
    if (!expectRestore) {
      assert.equal(panel.trusted, true, 'Mixly AI was not opened by a trusted desktop input event');
    }
    assert.equal(panel.open, 'true');
    assert.equal(panel.generation, '4');
    assert.equal(panel.title, 'Mixly AI · Mixly 4');
    assert.equal(path.resolve(panel.root), expectedHome);
    assert.match(panel.frame, /^http:\/\/127\.0\.0\.1:30\d{2}\/?$/);

    const instancePath = path.join(installRoot, 'state', 'shared', 'instance.json');
    const contextPath = path.join(installRoot, 'state', 'shared', 'active-context.json');
    const instance = JSON.parse(fs.readFileSync(instancePath, 'utf8'));
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    assert.equal(instance.ok, true);
    assert.equal(instance.generation, '4');
    assert.equal(path.resolve(instance.mixlyHome), expectedHome);
    assert.equal(context.generation, '4');
    assert.equal(path.resolve(context.mixlyHome), expectedHome);
    assert.equal(context.cdpPort, String(cdpPort));

    await new Promise((resolve) => setTimeout(resolve, 8000));
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    process.stdout.write(`${JSON.stringify({
      passed: true,
      board: { selected: button.selected, url: button.url },
      click: expectRestore ? { skipped: true, restored: true } : { trusted: panel.trusted, x, y },
      panel,
      instance: {
        pid: instance.pid,
        generation: instance.generation,
        mixlyHome: instance.mixlyHome,
        restarted: instance.restarted,
        url: instance.url
      },
      context,
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
