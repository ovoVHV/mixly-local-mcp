'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const cdpPort = Number(process.env.MIXLY_CDP_PORT || 9347);
const timeoutMs = Number(process.env.MIXLY_WASM_TIMEOUT_MS || 300000);
const externalClick = process.env.MIXLY_EXTERNAL_UI_CLICK === '1';
const clickOnly = process.env.MIXLY_CLICK_ONLY === '1';
const mixlyHome = path.resolve(process.env.MIXLY_HOME || 'E:\\mixly4_win-x86\\mixly4_win');
const runtimeRoot = path.resolve(
  process.env.MIXLY4_X64_RUNTIME_ROOT || path.join(mixlyHome, '.mixly-mcp-nw-sdk-x64')
);

async function targets() {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!response.ok) throw new Error(`CDP target lookup failed: HTTP ${response.status}`);
  return response.json();
}

async function connect() {
  const pages = (await targets()).filter((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  const page = pages.find((item) => /\/boards\/index\.html(?:[?#]|$)/i.test(item.url || ''));
  if (!page) throw new Error(`Mixly board page not found on CDP ${cdpPort}`);
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

function nwMemory() {
  try {
    const escapedRuntimeRoot = runtimeRoot.replace(/'/g, "''");
    const script = [
      `$root=[IO.Path]::GetFullPath('${escapedRuntimeRoot}')`,
      "$items=Get-Process nw -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($root,[StringComparison]::OrdinalIgnoreCase) }",
      "$sum=($items | Measure-Object WorkingSet64 -Sum).Sum",
      "if($null -eq $sum){$sum=0}",
      "[Console]::Write((@{count=@($items).Count;workingSet=[int64]$sum;responding=(@($items | Where-Object { -not $_.Responding }).Count -eq 0)} | ConvertTo-Json -Compress))"
    ].join(';');
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    }));
  } catch (error) {
    return { count: 0, workingSet: 0, responding: false, error: error.message };
  }
}

async function main() {
  const cdp = await connect();
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  };
  try {
    await cdp.send('Page.bringToFront');
    const before = JSON.parse(await evaluate(`(()=>{
      const active=Mixly.app.getContext().getService('EditorsManager').getActive();
      const code=active.getCode();
      const manager=Mixly.PluginManager||Mixly.StatusBarPlugin;
      const plugin=manager.runtimePlugins&&manager.runtimePlugins.get('MAX30102_WASM_HeartRate');
      const compile=document.querySelector('#arduino-compile-btn,[data-id="arduino-compile-btn"]');
      const candidates=Array.from(document.querySelectorAll('button,a,[role="button"]')).map((node)=>{
        const rect=node.getBoundingClientRect();
        return {id:node.id||'',text:(node.innerText||node.title||node.getAttribute('aria-label')||'').trim(),display:getComputedStyle(node).display,visibility:getComputedStyle(node).visibility,width:rect.width,height:rect.height,x:rect.x,y:rect.y};
      }).filter((item)=>/compile|编译/i.test(item.id+' '+item.text));
      return JSON.stringify({title:document.title,url:location.href,blockCount:Blockly.getMainWorkspace().getAllBlocks(false).length,pluginMounted:Boolean(plugin),pluginBlocks:plugin?Object.keys(plugin.blocks||{}).length:0,pluginGenerators:plugin?Object.keys(plugin.generators||{}).length:0,libraryFiles:Object.keys(Blockly.generator.libs_||{}),code,compile:compile?{id:compile.id,html:compile.outerHTML.slice(0,500),rect:(()=>{const r=compile.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()}:null,candidates});
    })()`));
    if (before.blockCount !== 19) throw new Error(`Expected 19 Blockly nodes, got ${before.blockCount}`);
    if (!before.pluginMounted || before.pluginBlocks !== 13 || before.pluginGenerators !== 13) {
      throw new Error(`MAX30102 plugin is not fully mounted: ${JSON.stringify(before)}`);
    }
    if (/\.h\.h[>\"]/.test(before.code)) throw new Error('Generated code still contains a doubled .h include');
    const expectedFiles = [
      'MAX30105.h', 'MAX30105.cpp', 'heartRate.h', 'heartRate.cpp',
      'MixlyMAX30102HeartRate.h', 'MixlyMAX30102HeartRate.cpp'
    ];
    if (!expectedFiles.every((name) => before.libraryFiles.includes(name))) {
      throw new Error(`WASM sketch files are incomplete: ${JSON.stringify(before.libraryFiles)}`);
    }

    let compileRect = (before.compile && before.compile.rect) ||
      before.candidates.find((item) => item.width >= 2 && item.height >= 2);
    if (!compileRect || compileRect.width < 2 || compileRect.height < 2) {
      await evaluate(`(()=>{
        const candidates=Array.from(document.querySelectorAll('button,a,[role="button"]'));
        const more=candidates.find((node)=>/更多|more/i.test((node.innerText||node.title||node.getAttribute('aria-label')||'').trim()));
        if(more)more.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      compileRect = JSON.parse(await evaluate(`(()=>{const node=document.querySelector('#arduino-compile-btn,[data-id="arduino-compile-btn"]');if(!node)return JSON.stringify(null);const r=node.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height})})()`));
    }
    if (!compileRect || compileRect.width < 2 || compileRect.height < 2) {
      throw new Error(`Visible compile button not found: ${JSON.stringify(before.candidates)}`);
    }

    const x = compileRect.x + compileRect.width / 2;
    const y = compileRect.y + compileRect.height / 2;
    const memoryBefore = nwMemory();
    let peakWorkingSet = memoryBefore.workingSet;
    let minimumProcessCount = memoryBefore.count;
    if (!externalClick) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      if (clickOnly) {
        console.log(JSON.stringify({ clicked: true, x, y, method: 'Input.dispatchMouseEvent' }));
        return;
      }
    } else {
      console.error('READY_FOR_EXTERNAL_UI_CLICK');
    }

    const startedAt = Date.now();
    let output = '';
    let completed = false;
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const memory = nwMemory();
      peakWorkingSet = Math.max(peakWorkingSet, memory.workingSet || 0);
      minimumProcessCount = Math.min(minimumProcessCount, memory.count || 0);
      if (!memory.count) throw new Error('Visible Mixly NW.js host exited during WASM compilation');
      output = String(await evaluate(`(()=>{const manager=Mixly.app.getContext().getService('StatusBarsManager');const bar=manager.getStatusBarById('output');if(!bar)return '';if(typeof bar.getValue==='function')return bar.getValue();const editor=typeof bar.getEditor==='function'?bar.getEditor():bar.editor;return editor&&typeof editor.getValue==='function'?editor.getValue():(bar.$dom&&bar.$dom.innerText)||''})()`));
      if (/==[^=]*(?:编译成功|compile\s*success|success)[^=]*==/i.test(output)) {
        completed = true;
        break;
      }
      if (/==[^=]*(?:编译失败|compile\s*failed|failed)[^=]*==/i.test(output)) break;
    }
    const memoryAfter = nwMemory();
    const result = {
      passed: completed,
      click: { selector: '#arduino-compile-btn', x, y, visible: true, method: externalClick ? 'Windows UI Automation' : 'Input.dispatchMouseEvent' },
      runtime: { title: before.title, url: before.url, bitness: 'x64', blockCount: before.blockCount },
      plugin: { mounted: before.pluginMounted, blocks: before.pluginBlocks, generators: before.pluginGenerators, wasmSketchFiles: before.libraryFiles },
      memory: { before: memoryBefore, after: memoryAfter, peakWorkingSet, peakMiB: Math.round(peakWorkingSet / 1048576 * 10) / 10, minimumProcessCount },
      durationMs: Date.now() - startedAt,
      output
    };
    console.log(JSON.stringify(result, null, 2));
    if (!completed) process.exitCode = 1;
  } finally {
    cdp.socket.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
