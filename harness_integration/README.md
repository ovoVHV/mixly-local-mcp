# Mixly AI with DeepSeek Harness

This integration adds one AI toolbar button to Mixly and starts the official DeepSeek Harness web client with Mixly Local MCP attached.

## Architecture

- One shared runtime is installed in `%LOCALAPPDATA%\MixlyHarness`.
- A portable Node.js 24 x64 runtime runs DeepSeek Harness and the MCP server.
- Mixly 2/3 load a thin toolbar adapter from their `boards/index.html` page.
- Mixly 4 patches its shared `boards/index.html`, so every board page gets the button. `MixlyHarness_Mixly4_Plugin.zip` remains a compatibility fallback and contributes no toolbox blocks.
- Mixly 2/3/4 reuse one Harness runtime. Each running Harness process pins one Mixly installation; switching installations restarts the process instead of mutating a live chat context.
- Existing Harness settings and sessions stay shared, while the process working directory and pinned MCP context follow the selected Mixly installation. The panel title shows the pinned generation.
- Mixly 2/3 store their absolute installation path in the adapter tag and receive browser API polyfills required by Electron 19 / Chromium 102.
- Opening the panel creates or reuses the current Mixly workspace and a blank session before the UI is shown.

## Local install

For end users, extract the release ZIP anywhere. Mixly 4 users double-click
`MixlyLocalMCP/Install_Mixly4_AI.cmd`; Mixly 2/3 users double-click
`MixlyLocalMCP/Install_Mixly23_AI.cmd`. The 2/3 installer scans parent folders
for the usual Mixly roots before asking for a path. The two installers keep
their generation-specific paths separate, install the portable runtime, and
patch the selected board pages. Close and reopen each selected Mixly
application once after installation so its toolbar adapter is loaded.

Both installers check for Node.js 18 or newer and reuse the existing portable
Harness Node runtime when available.

```powershell
node install.js `
  --mcp-source E:\mixly2.0-win32-x64\_repo_feedback `
  --mixly2-home E:\mixly2.0-win32-x64 `
  --mixly3-home E:\path\to\mixly3 `
  --mixly4-home E:\mixly4_win-x86\mixly4_win
```

The Mixly 4 global adapter works immediately after installation and a page reload. The ZIP can still be imported through Mixly 4's plugin manager as a fallback.

Harness stores its API key and model settings in its own settings UI. No credential is written into the adapter, launcher, Cordis patch, or MCP configuration.

In Mixly 4, `mixly_build_project` performs a live Blockly refresh when Harness has pinned a CDP port. This is tool-call-level progress, not token-by-token insertion; the final `mixly_project_workflow` remains mandatory for plugin import, validation, generation, and WASM compilation.
