'use strict';

(function installMixlyHarnessButton() {
  if (globalThis.__mixlyHarnessAdapterInstalled) return;
  globalThis.__mixlyHarnessAdapterInstalled = true;

  const script = document.currentScript;
  const configuredGeneration = Number(script && script.dataset.mixlyGeneration || 0);
  const generation = Number(globalThis.__MIXLY_HARNESS_GENERATION__ || configuredGeneration || 0);
  const buttonId = 'mixly-harness-button';
  const panelId = 'mixly-harness-panel';
  const panelStateKey = 'mixly-harness-panel-state-v1';
  let harnessUrl = '';
  let cachedNodeRequire;
  let nodeBridgeChecked = false;

  function getNodeRequire() {
    if (nodeBridgeChecked) return cachedNodeRequire;
    nodeBridgeChecked = true;
    const candidates = [];
    if (globalThis.Mixly && typeof globalThis.Mixly.require === 'function') {
      candidates.push(globalThis.Mixly.require.bind(globalThis.Mixly));
    }
    if (typeof globalThis.require === 'function') candidates.push(globalThis.require);
    for (const candidate of candidates) {
      try {
        const fs = candidate('fs');
        if (fs && typeof fs.readFileSync === 'function') {
          cachedNodeRequire = candidate;
          return cachedNodeRequire;
        }
      } catch (_) {
        // Browser builds expose an AMD-style require that is not a Node bridge.
      }
    }
    cachedNodeRequire = null;
    return cachedNodeRequire;
  }

  function requireNode(name) {
    const nodeRequire = getNodeRequire();
    if (nodeRequire) return nodeRequire(name);
    throw new Error('Mixly Node bridge is unavailable');
  }

  function hasNodeBridge() {
    return Boolean(getNodeRequire());
  }

  function notify(message, error) {
    const layer = globalThis.layer || globalThis.layui && globalThis.layui.layer;
    if (layer && typeof layer.msg === 'function') {
      layer.msg(message, { time: error ? 5000 : 1800, icon: error ? 2 : 1 });
    }
    (error ? console.error : console.info)(`[Mixly Harness] ${message}`);
  }

  function setState(button, state, title) {
    button.dataset.state = state;
    button.disabled = state === 'starting';
    button.title = title;
    const icon = button.querySelector('a');
    if (icon && button.dataset.iconMode !== 'text') {
      icon.className = state === 'starting' ? 'codicon-loading codicon-modifier-spin' : 'codicon-sparkle';
    }
  }

  function readPanelState() {
    try { return JSON.parse(sessionStorage.getItem(panelStateKey) || 'null'); } catch (_) { return null; }
  }

  function writePanelState(value) {
    try { sessionStorage.setItem(panelStateKey, JSON.stringify(value)); } catch (_) { /* optional persistence */ }
  }

  function ensurePanelStyles() {
    if (document.getElementById('mixly-harness-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'mixly-harness-panel-styles';
    style.textContent = `
      #${panelId} {
        position: fixed;
        top: 35px;
        right: 0;
        bottom: 0;
        z-index: 2147483000;
        display: none;
        width: min(1040px, calc(100vw - 40px));
        min-width: 320px;
        background: #ffffff;
        border-left: 1px solid #c8ccd2;
        box-shadow: -8px 0 24px rgba(30, 38, 48, 0.18);
      }
      #${panelId}[data-open="true"] {
        display: grid;
        grid-template-rows: 38px minmax(0, 1fr);
      }
      #${panelId} .mixly-harness-header {
        display: flex;
        align-items: center;
        min-width: 0;
        padding-left: 12px;
        color: #20242a;
        background: #f5f6f8;
        border-bottom: 1px solid #d7dbe0;
      }
      #${panelId} .mixly-harness-title {
        min-width: 0;
        flex: 1;
        overflow: hidden;
        font-size: 14px;
        font-weight: 600;
        letter-spacing: 0;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${panelId} .mixly-harness-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 38px;
        height: 38px;
        padding: 0;
        color: #343a40;
        background: transparent;
        border: 0;
        border-left: 1px solid #d7dbe0;
        border-radius: 0;
        cursor: pointer;
      }
      #${panelId} .mixly-harness-action:hover,
      #${panelId} .mixly-harness-action:focus-visible {
        color: #00695c;
        background: #e7efed;
        outline: none;
      }
      #${panelId} .mixly-harness-action > span {
        font-size: 18px;
      }
      #${panelId} .mixly-harness-frame {
        width: 100%;
        height: 100%;
        background: #ffffff;
        border: 0;
      }
      body.dark #${panelId},
      html[data-theme="dark"] #${panelId} {
        background: #17191d;
        border-left-color: #41464d;
      }
      body.dark #${panelId} .mixly-harness-header,
      html[data-theme="dark"] #${panelId} .mixly-harness-header {
        color: #f0f2f4;
        background: #25292e;
        border-bottom-color: #41464d;
      }
      body.dark #${panelId} .mixly-harness-action,
      html[data-theme="dark"] #${panelId} .mixly-harness-action {
        color: #e1e5e9;
        border-left-color: #41464d;
      }
      @media (max-width: 640px) {
        #${panelId} { width: calc(100vw - 8px); }
      }
    `;
    document.head.appendChild(style);
  }

  function createPanel() {
    const existing = document.getElementById(panelId);
    if (existing) return existing;
    ensurePanelStyles();
    const panel = document.createElement('section');
    panel.id = panelId;
    panel.dataset.open = 'false';
    panel.setAttribute('aria-label', 'Mixly AI');
    panel.innerHTML = `
      <header class="mixly-harness-header">
        <span class="mixly-harness-title">Mixly AI</span>
        <button class="mixly-harness-action mixly-harness-refresh" type="button" title="刷新" aria-label="刷新">
          <span class="codicon-refresh" aria-hidden="true"></span>
        </button>
        <button class="mixly-harness-action mixly-harness-close" type="button" title="关闭" aria-label="关闭">
          <span class="codicon-close" aria-hidden="true"></span>
        </button>
      </header>
      <iframe class="mixly-harness-frame" title="DeepSeek Harness" allow="clipboard-read; clipboard-write"></iframe>
    `;
    const frame = panel.querySelector('.mixly-harness-frame');
    frame.addEventListener('load', () => {
      panel.dataset.loaded = 'true';
    });
    panel.querySelector('.mixly-harness-refresh').addEventListener('click', () => {
      panel.dataset.loaded = 'false';
      frame.src = harnessUrl || frame.src;
    });
    panel.querySelector('.mixly-harness-close').addEventListener('click', () => {
      panel.dataset.open = 'false';
      writePanelState({ open: false });
      document.getElementById(buttonId)?.focus();
    });
    document.body.appendChild(panel);
    return panel;
  }

  function openHarness(url, activeContext) {
    harnessUrl = url;
    const panel = createPanel();
    const activeGeneration = String(activeContext && activeContext.generation || generation || '?');
    const title = panel.querySelector('.mixly-harness-title');
    title.textContent = `Mixly AI · Mixly ${activeGeneration}`;
    title.title = activeContext && activeContext.mixlyHome || '';
    panel.dataset.generation = activeGeneration;
    const nav = document.querySelector('.mixly-nav, #nav, .layui-nav');
    if (nav) panel.style.top = `${Math.max(35, Math.round(nav.getBoundingClientRect().bottom))}px`;
    const frame = panel.querySelector('.mixly-harness-frame');
    if (frame.src !== url && frame.src !== `${url}/`) {
      panel.dataset.loaded = 'false';
      frame.src = url;
    }
    panel.dataset.open = 'true';
    writePanelState({ open: true, url, activeContext: activeContext || { generation } });
    panel.querySelector('.mixly-harness-close').focus();
  }

  function restoreHarnessPanel() {
    const saved = readPanelState();
    if (!saved || saved.open !== true || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(String(saved.url || ''))) return;
    openHarness(saved.url, saved.activeContext || { generation, mixlyHome: '' });
  }

  function waitForResponse(fs, responsePath, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (fs.existsSync(responsePath)) {
          clearInterval(timer);
          try {
            const value = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
            try { fs.unlinkSync(responsePath); } catch (_) { /* response cleanup is best effort */ }
            resolve(value);
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          clearInterval(timer);
          reject(new Error('DeepSeek Harness start timed out'));
        }
      }, 250);
    });
  }

  async function launch(button) {
    setState(button, 'starting', '正在启动 DeepSeek Harness');
    try {
      const childProcess = requireNode('node:child_process');
      const fs = requireNode('node:fs');
      const os = requireNode('node:os');
      const path = requireNode('node:path');
      const installRoot = path.join(process.env.LOCALAPPDATA, 'MixlyHarness');
      const nodePath = path.join(installRoot, 'runtime', 'node', 'node.exe');
      const launcherPath = path.join(installRoot, 'launcher.js');
      const responsePath = path.join(
        os.tmpdir(),
        `mixly-harness-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
      );
      if (!fs.existsSync(nodePath) || !fs.existsSync(launcherPath)) {
        throw new Error(`Harness 尚未安装完整：${installRoot}`);
      }
      const args = [
        launcherPath,
        '--mixly-home',
        process.cwd(),
        '--generation',
        String(generation),
        '--response',
        responsePath
      ];
      if (generation === 4) {
        args.push('--cdp-port', process.env.MIXLY_CDP_PORT || '');
        args.push('--origin', location.origin);
      }
      const child = childProcess.spawn(nodePath, args, {
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.unref();
      const result = await waitForResponse(fs, responsePath, 95000);
      if (!result.ok) throw new Error(result.message || 'DeepSeek Harness 启动失败');
      setState(button, 'ready', '打开 Mixly AI');
      openHarness(result.url, result.activeContext);
      if (result.restarted) notify(`已切换并锁定 Mixly ${result.activeContext.generation} 环境`);
      else notify(result.reused ? `Mixly ${result.activeContext.generation} AI 已打开` : 'Mixly AI 启动成功');
    } catch (error) {
      setState(button, 'error', `Mixly AI 启动失败：${error.message || error}`);
      notify(error.message || String(error), true);
    }
  }

  function createButton() {
    if (document.getElementById(buttonId)) return true;
    const nav = document.querySelector('.mixly-nav, #nav, .layui-nav');
    if (!nav) return false;
    const button = document.createElement('button');
    button.id = buttonId;
    button.type = 'button';
    button.className = 'layui-btn layui-btn-xs layui-btn-primary';
    button.setAttribute('aria-label', 'Mixly AI');
    button.title = `打开 Mixly ${generation || '?'} AI`;
    button.style.width = '30px';
    button.style.minWidth = '30px';
    button.style.height = '28px';
    button.style.padding = '0';
    button.style.margin = '0 4px 0 0';
    button.innerHTML = '<a class="codicon-sparkle" aria-hidden="true"></a>';
    if (hasNodeBridge()) {
      button.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        launch(button);
      });
    }
    else {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      button.title = 'Mixly AI 需要桌面版';
    }

    const fileButton = document.querySelector('button[data-id="6"]');
    if (fileButton && fileButton.parentNode) fileButton.parentNode.insertBefore(button, fileButton);
    else {
      const container = document.querySelector(
        '.right-btn-container, #nav-right-btn-list, .editor-btn-container, .left-btn-container, #nav-left-btn-list'
      );
      if (container && container.id === 'nav-right-btn-list') container.insertBefore(button, container.firstElementChild);
      else (container || nav).appendChild(button);
    }
    requestAnimationFrame(() => {
      const icon = button.querySelector('a');
      if (!icon) return;
      const content = getComputedStyle(icon, '::before').content;
      if (!content || content === 'none' || content === 'normal' || content === '""') {
        button.dataset.iconMode = 'text';
        icon.className = '';
        icon.textContent = 'AI';
        icon.style.fontSize = '12px';
        icon.style.fontWeight = '700';
        icon.style.letterSpacing = '0';
      }
    });
    setTimeout(restoreHarnessPanel, 0);
    return true;
  }

  if (createButton()) return;
  const observer = new MutationObserver(() => {
    if (createButton()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);
})();
