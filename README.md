# Mixly Local MCP 2.5.16

下载 ZIP 后解压到本地 Mixly 目录，再在 AI 客户端中配置并调用。

这是一个完全在用户电脑上运行的 Mixly MCP。它不需要公网服务器，不上传源码，也不在服务器编译。

任何支持本地 STDIO MCP 的 AI 客户端都可以使用，例如 Codex、Claude Desktop、Cursor 和 Cline。每个客户端需要单独添加一次本地 MCP 配置。

## 说明视频

- 抖音：[发现米思齐能用 AI 写代码，我直接愣住了](https://v.douyin.com/L0xDb-Hex1o/)
- 哔哩哔哩：[Mixly 米思齐巨好用的 AI 编程工具，调用 MCP 即可帮你编写代码](https://b23.tv/HU2z2vd)

以上为平台短链接，打开后会跳转到对应视频页面。

## 2.5.16 更新说明

- 修复 Mixly 2/3 AI 打开后工作区一直加载或完全不可用：旧版 Electron 缺少 Harness 使用的现代浏览器 API，现在安装器会自动加入兼容层。
- 2/3 代不再依赖进程当前目录，安装时会把正确的 Mixly 绝对路径写入按钮适配器。
- 打开 AI 时会自动注册并选中当前 Mixly 工作区，同时复用已有空白会话。

## 2.5.15 更新说明

- 修复 peer 依赖被省略导致 Harness 启动时报 `@deepseek-ai/cordis-plugin-group` 缺失。
- 已有不完整安装会被检测并自动补齐，不需要用户手动删除 runtime。

## 2.5.14 更新说明

- 发布包携带 Harness 依赖 lockfile，首次安装不再从零解析 500 多个依赖。
- npm 优先使用本地缓存；连续 180 秒无输出会中止当前 registry 并自动重试备用源。

## 2.5.13 更新说明

- Harness npm 安装会显示最后一条依赖 fetch 事件和等待状态；不再长时间只显示 `0 B`。
- npm 请求超时后会自动重试，国内 registry 失败会回退官方 registry。

## 2.5.12 更新说明

- Node.js 下载默认优先使用 npmmirror 国内镜像，镜像失败会自动回退到官方源。
- Harness npm 依赖默认使用 `https://registry.npmmirror.com`；设置 `MIXLY_NPM_REGISTRY` 可切换到公司或本地 registry。

## 2.5.11 更新说明

- 安装器显示 Node.js 下载百分比、速度和 ETA，并显示解压、Harness npm 安装、校验等阶段百分比。
- Harness npm 安装显示实时耗时和输出量；npm 本身没有可靠的总包数，因此该阶段使用明确的阶段进度而不是伪造包百分比。
- Mixly 2/3 安装器中空路径会跳过；两项都为空时直接成功退出，不再报“至少需要一个路径”。
- Mixly 4 安装器留空路径也会直接跳过，并且不会为了空安装目标先检查 Node.js 或联网。

## 2.5.10 更新说明

- 安装器自动检查 Node.js 18+；如果系统 PATH 没有 Node，会尝试复用已安装的 Harness 便携 Node。
- 两者都不存在时才提示用户安装 Node.js，不会在安装中途出现难以理解的 `node` 找不到错误。

## 2.5.9 更新说明

- Mixly 2/3 安装器会自动扫描安装器目录及父目录，常见解压结构无需手动填写路径。
- 无法自动识别时才要求输入 Mixly 根目录，不要填写 `MixlyLocalMCP` 文件夹本身。

## 2.5.8 更新说明

- 安装入口已拆分：Mixly 4 使用 `Install_Mixly4_AI.cmd`，Mixly 2/3 使用 `Install_Mixly23_AI.cmd`。
- 两个入口互不混问路径，避免把 Mixly 4 的 OPFS/页面流程和 Mixly 2/3 的传统适配器流程混在一起。

## 2.5.7 更新说明

- 一键安装器现在同时支持 Mixly 2、Mixly 3 和 Mixly 4；可填写一个或多个本机安装路径，留空即可跳过。
- 2.5.7 的通用入口在本版拆分为两个代际专用入口，旧的 Mixly 4 安装流程继续可用。

## 2.5.6 更新说明

- 新增 `Install_Mixly4_AI.cmd` 一键安装入口：自动识别 Mixly 4 根目录，安装便携 Node.js 与 DeepSeek Harness，并给所有板卡页面注入 AI 按钮。
- 用户不再需要手工拼接 Harness 安装命令；首次安装完成后只需关闭并重新打开 Mixly 4 一次。

## 2.5.5 更新说明

- 修复 Mixly 4 内置 AI 在同一安装目录的 CDP 端口变化时重启整个 Harness，避免允许重启后正在执行的任务被终止。
- 同一 Mixly 安装现在保持现有 Harness 会话和 MCP 上下文；只有切换 Mixly 代际或安装目录才会重启。
- 适配器在复用会话时会明确提示未重启任务。

## 2.5.4 更新说明

- `mixly_scan_library` 新增 `queries` 与 `includeSpecs`：最多 8 个能力一次扫描，并在同一结果中附带最多 20 个候选的 `type/owner/contract/defaultXml`，减少重复工具调用和 shell 搜索。
- MCP 初始化规则要求新工程使用 `mixly_build_project.tree/treePath`，不再手写 `.mix` XML；结构树会自动转义 `<`、嵌套 `next` 并校验真实输入契约。
- XML 解析器会在启动 Mixly 前拒绝游离、重复或包含错误子节点的 `<next>`，直接给出结构错误和修复提示，避免真实 Blockly 只加载半棵树后再返工。
- 已用 Mixly 4 ESP32 的 122 节点健康监测工程验证：静态节点与真实 Blockly 节点均为 122，未知 type 为 0。

## 2.5.3 更新说明

- Mixly 4 在当前板卡页直接把新工程写入现有 Blockly 工作区，不再通过整页导航模拟“实时插入”；页面、Harness 会话和 AI 侧栏都保持不变。
- 打开工程、导入插件和工作流会先比较当前板卡，板卡相同时不刷新；确需切换板卡或页面重载时，AI 侧栏会从会话状态自动恢复，手动关闭后则不会自行重开。
- 实时加载后自动把第一个顶层积木移到 AI 面板左侧的可见区域，避免积木已渲染却被侧栏盖住。

## 2.5.2 更新说明

- Mixly 4 AI 按钮改为注入所有板卡共用的 `boards/index.html`，不再依赖从 Arduino Uno 页面挂载的 OPFS 插件；Arduino AVR、ESP32 和 MicroPython 等板卡都会显示。
- OPFS 插件继续作为兼容兜底，全局适配器带幂等保护，不会重复生成按钮或侧栏。
- Harness 精简工具面增加 `mixly_build_project`：AI 每完成一组可运行的结构树即可立即刷新 Mixly 4 Blockly，不必等最终导库和 WASM 编译；禁止为了动画逐块重发完整工程。

## 2.5.1 更新说明

- 修复 Harness 会话串代：MCP 上下文在进程启动时锁定，运行中修改活动环境文件不会把 Mixly 4 任务静默切到 Mixly 2。
- 同一 Mixly 重复打开会复用现有进程；CDP 端口变化也不会重启当前任务。只有切换 2/3/4 或安装目录时会完整重启 Harness，并在侧栏标题显示当前锁定代际。
- Harness 工作目录直接绑定当前 Mixly 根目录；API 配置和聊天数据继续保留，MCP 子进程则固定在启动时选中的代际。
- 按钮只接受真实用户点击，防止后台页面用脚本触发后抢占当前环境。
- MCP 工具默认继承 Harness 锁定的 Mixly 4 CDP 端口，AI 无需每次填写 `cdpPort`，不会把实际 `9347` 错查成 `9333`。

## 2.5.0 更新说明

- 新增 Mixly 内置 AI 客户端：Mixly 2/3 写入轻量顶栏适配器，Mixly 4 导入 `MixlyHarness_Mixly4_Plugin.zip`；插件只增加一个图标按钮，不向工具箱塞积木。
- 按钮在 Mixly 主窗口右侧打开官方 DeepSeek Harness，Harness 通过官方 `@deepseek-ai/dsh-mcp-client` 加载本 MCP。
- 三个 Mixly 代际共用一个 Harness 运行时；2.5.1 起，切换安装目录会明确重启并锁定上下文，不再在同一聊天连接中动态换根目录。
- Mixly 4 会根据当前页面 origin 自动发现真实 CDP 端口；客户端使用持久 iframe 侧栏，不再创建会短暂出现后关闭的 NW.js 远程窗口。
- Harness 默认只公开 9 个高频工作流工具的 schema，完整 19 个工具仍保持可调用，减少工具上下文和无效往返。

### 安装 Mixly AI 按钮

```powershell
node harness_integration\install.js `
  --mcp-source . `
  --mixly2-home C:\Path\To\Mixly2 `
  --mixly3-home C:\Path\To\Mixly3 `
  --mixly4-home C:\Path\To\Mixly4
```

首次安装会把便携 Node.js 24 和官方 DeepSeek Harness 安装到 `%LOCALAPPDATA%\MixlyHarness`。Mixly 2/3 会直接写入带一次性备份的适配脚本；Mixly 4 会把插件 ZIP 放到安装根目录，再通过 Mixly 插件管理器或 `mixly_import_library` 导入。Harness 的 API Key 只在 Harness 自己的设置界面填写。

纯网页方式打开 Mixly 3 时没有本地 Node 桥接，AI 按钮会保持禁用；打包的 Electron/NW.js 桌面版才会启动本地 Harness。

## 2.4.3 更新说明

- `mixly_scan_library` 默认只返回摘要；按源码能力传 `query` 获取少量候选，`full=true` 仅用于全集审计。扫描与规格结果缓存 30 秒，建库/导库后自动失效。
- `mixly_get_block_specs` 默认跳过示例工程，只有需要真实示例时才传 `includeExamples=true`；`mixly_detect_environment` 默认不运行 Arduino CLI，准备 CLI 编译时才传 `probeCli=true`。
- 工具文本结果只保留短摘要，完整对象只放在 `structuredContent`，不再把大型结果重复两遍占用上下文。
- Mixly 4 编译按钮点击增加输出确认与重试，避免“按钮坐标可见但命令未触发”后空等到超时。

## 2.4.2 更新说明

- MCP 初始化指令和 `mixly_detect_environment.generationAwareWorkflow` 会在识别到 Mixly 4 后明确告诉 AI：插件位于 OPFS，缺失 C/C++ 依赖必须通过 `wasmSketchFiles` 注入，Arduino CLI 不是桌面 WASM 验证。
- `mixly_project_workflow` 成为 Mixly 4 的真正闭环：可复用已有 `.mix`，自动从工程 block type 识别暂存插件，完成打包、`PluginManager` 导入、工程打开、代码生成，并默认点击可见桌面按钮等待 WASM 编译结果。
- `mixly_launch` 会优先发现安装目录内的 64 位 NW.js/SDK，启动后主动进入目标板卡页面并等待 Blockly/PluginManager；只有 HTTP、没有 CDP 的实例不再误报为可自动化。
- 修复编译按钮被收进“更多”菜单时工作流找不到按钮的问题，并精简工作流返回内容，避免把完整 OPFS manifest 占用 AI 上下文。

## 2.4.1 更新说明

- `mixly_create_library` 新增 `wasmSketchFiles`，可把平铺的 `.h/.hpp/.c/.cc/.cpp` 精确注入 Mixly 4 浏览器编译器的 `sketchFiles`，不会再生成 `.h.h` 或 `.cpp.h` 伪头文件。
- Mixly 4 插件导入仍调用官方 `PluginManager.installPlugin`，并为嵌套 Arduino 库补齐 OPFS 父目录；大型插件改用表达式临时文件传给 CDP，避免 Windows `ENAMETOOLONG`。
- 增加可见桌面窗口的真实 WASM 点击编译回归。MAX30102 示例在 Arduino AVR UNO 上完成编译、链接及资源统计，编译期间窗口进程保持存活。

## 2.4.0 更新说明

- 兼容 Mixly 2、Mixly 3 和 Mixly 4；按本机目录结构自动识别 Electron、源码树和 NW.js/HTTP 运行时，不把附件路径或固定板卡当作环境。
- Mixly 4 使用 `package.json` 的静态服务入口（默认 `http://localhost:65234`），工程打开和代码生成通过其编辑器 API 工作；CDP 不可用时会明确返回诊断，不会终止用户已有实例。
- Mixly 4 的 Arduino 板卡直接读取随 WASM 编译器提供的 `libraries.manifest.json`，`mixly_scan_arduino_libraries` 可返回库名、版本、头文件、依赖和归档来源。
- Mixly 4 自定义库使用插件格式：ZIP 根部必须有 `plugin.json`、`index.xml` 和 ES module `index.js`；安装走 `PluginManager`/OPFS，不再写入只读的 `ThirdParty` 板卡目录。
- Mixly 2/3 发布 ZIP 保持 0 个目录条目；Mixly 4 插件使用根部入口文件，嵌套载荷则带必要的父目录条目。
- 新增 Mixly 4 HTTP、WASM 库清单和插件生成/导入回归测试；MCP 协议现有 19 个工具。

## 2.3.0 更新说明

- 构建 `.mix` 前按本机官方及 ThirdParty 积木规格校验 `fields`、`values`、`statements`，错误会返回节点 ID、树路径和合法输入名，不再等真实加载时静默丢树。
- 根据 `IFn/DOn/ELSE` 自动推导 `controls_if` mutation；真实 Blockly 少加载一个节点也会失败，并报告缺失块、父块、父连接和最近成功加载的祖先。
- 新增 `mixly_verify_equivalence`，支持 `report`、`behavioral-strict`、`exact`；统一工作流可在编译前检查遗漏的保护调用、提示文本、常量、副作用和必需正则。
- 积木规格新增 `optionalValueInputs`、`valueDefaults`，能说明允许留空且生成 `""`、`0` 等回退代码的输入，无需依赖识图判断空插槽。
- 参数文件、stdin 和 `treePath` 统一兼容 UTF-8 BOM 与中文路径。
- Arduino CLI 支持多个隔离 `librariesPaths`，并能按板卡解析 `ThirdParty/<库名>/libraries`，无需把自定义库复制到全局目录。
- 编译结果新增 Flash/SRAM 百分比和 `resourceRisk`；自定义生成器直接使用未转义的 `VAR` 字段时会给出中文变量兼容警告。
- MCP 协议现有 18 个工具；发布包已通过官方/ThirdParty 契约、Mixly bundle、真实 Blockly、Nano 编译和便携解包启动回归。

## 设计原则

- 不固定板卡。MCP 从用户自己的 `boards.json`、`boards/default` 和 `boards/extend` 动态发现全部已安装板卡。
- 不固定 Arduino CLI 路径。AI 先调用环境探测，也可以把自己找到的路径传给编译工具。
- 不固定 FQBN。AI 必须根据用户的实际板卡和本机已安装核心选择 FQBN。
- 不捆绑 Arduino CLI、板卡核心和第三方 Arduino 库。
- 建议不要把完整业务程序或多个业务函数封装成少量黑盒积木；这种粒度问题只提示，不阻止 AI 按用户目标实现。
- Mixly 2/3 的官方目录和 `libraries/ThirdParty`、Mixly 4 的官方板卡资源和 OPFS 插件都是可复用的本地积木来源；扫描读取当前本机内容，后续新增积木无需修改 MCP。
- 候选块应读取真实规格，不根据块名猜字段和输入。
- 图形界面的变量、函数和参数建议使用自然中文；协议字符串和循环下标可以保留原文。命名偏好只产生提示。
- 建议把全局变量声明通过 `next` 连接为一条栈，并给顶层积木稳定、无重叠的坐标；布局问题只产生提示。
- 图片是否合适取决于用户要求；未记录用户图片需求时会提示 AI 确认，但不会阻止建库。本版 MCP 不提供识图能力。
- 只有无效 XML/JavaScript、当前板卡没有该 block type、块定义或生成器缺失、真实 Blockly 节点丢失、代码生成或编译失败等确定不可用的问题才报错。
- 源码等价性检查是保守的静态审计，用来主动发现遗漏的保护条件、提示文本、常量和副作用调用；它不是形式化证明，也不替代真机测试。
- 编译结果会保留 Flash/SRAM 等资源占用诊断。接近板卡上限时属于部署风险，AI 应明确提示，不能只根据“编译通过”判断设备运行可靠。
- Mixly 2/3 ZIP 只有文件条目，避免旧导入器出现 `EISDIR`；Mixly 4 插件入口位于 ZIP 根部，并为嵌套 Arduino 库写入必要的父目录条目。

## 本地部署包

分发文件：

```text
Mixly_Local_MCP_v2.5.16.zip
```

解压后目录包含：

```text
MixlyLocalMCP/
  mixly_mcp_server.js
  mixly_code_equivalence.js
  test_mixly_code_equivalence.js
  validate_mixly_workspace.js
  mixly_mcp_call.js
  Mixly4_MCP_Server.cmd
  Install_Mixly23_AI.cmd
  Install_Mixly4_AI.cmd
  harness_integration/
  package.json
  package-lock.json
  node_modules/
  README.md
```

依赖已经放入 ZIP。用户只需要：

- Node.js 18 或更高版本
- 一份本机 Mixly 2.x、Mixly 3.x 或 Mixly 4.x
- 支持本地 STDIO MCP 的 AI 客户端
- 需要编译 C/C++ 时，本机存在可用的 `arduino-cli`

### 分代一键安装

1. 下载 `Mixly_Local_MCP_v2.5.16.zip` 并解压到任意目录。
2. Mixly 4 用户双击 `MixlyLocalMCP\Install_Mixly4_AI.cmd`。
3. Mixly 2/3 用户双击 `MixlyLocalMCP\Install_Mixly23_AI.cmd`。安装器会自动扫描父目录；只有扫描不到时才要求填写 Mixly 2/3 根目录。
4. 安装器会下载并保存便携 Node.js、安装 DeepSeek Harness，把 MCP 和对应代际的 AI 按钮写入 `%LOCALAPPDATA%\\MixlyHarness` 以及各自的板卡页面。
5. 安装完成后关闭并重新打开已选择的 Mixly 应用一次，让页面加载 AI 按钮。

这次“重新打开 Mixly 4”只发生在首次安装或更新适配器时，不会在 Harness 正在执行任务时因为 CDP 端口变化而重启任务。同一 Mixly 安装重复点击按钮会复用当前会话。

## Mixly 根目录

MCP 按以下顺序寻找 Mixly：

1. 环境变量 `MIXLY_HOME`
2. MCP 进程的工作目录 `cwd`
3. MCP 脚本上一级目录

只要该目录中存在打包版的 `resources/app/src/boards`，或源码树/Mixly 4 安装根部的 `boards`，就会被识别为 Mixly 根目录。根部同时存在 `boards` 且 `package.json` 的 `node-main` 指向 `static-server/server.js` 时识别为 Mixly 4。附件、聊天记录或示例中出现的路径不会被当成本机目录；实际读写始终以本机 `MIXLY_HOME` 为准。

## Codex 配置

CLI 添加方式：

```powershell
codex mcp add mixly-local-builder `
  --env MIXLY_HOME=C:\Path\To\Mixly `
  -- node C:\Path\To\MixlyLocalMCP\mixly_mcp_server.js
```

也可以写入 `~/.codex/config.toml`：

```toml
[mcp_servers.mixly-local-builder]
command = "node"
args = ["C:\\Path\\To\\MixlyLocalMCP\\mixly_mcp_server.js"]
cwd = "C:\\Path\\To\\Mixly"
startup_timeout_sec = 30
tool_timeout_sec = 1200

[mcp_servers.mixly-local-builder.env]
MIXLY_HOME = "C:\\Path\\To\\Mixly"
```

配置完成后重启 Codex，然后使用 `/mcp` 检查连接。

Mixly 4 客户端也可直接把命令配置为 `Mixly4_MCP_Server.cmd`，同时设置
`MIXLY_HOME`（或 `MIXLY4_HOME`）为 Mixly 4 安装根目录。该入口用于避免客户端
把工作目录中的 Mixly 2/3 误识别为当前目标；修改 MCP 配置后必须重新连接，
客户端才会读取包含 OPFS、`wasmSketchFiles` 和桌面 WASM 编译规则的初始化说明。

## Claude Desktop、Cursor、Cline

支持 `mcpServers` JSON 配置的客户端可使用：

```json
{
  "mcpServers": {
    "mixly-local-builder": {
      "command": "node",
      "args": [
        "C:\\Path\\To\\MixlyLocalMCP\\mixly_mcp_server.js"
      ],
      "cwd": "C:\\Path\\To\\Mixly",
      "env": {
        "MIXLY_HOME": "C:\\Path\\To\\Mixly"
      }
    }
  }
}
```

不同客户端的配置文件位置不同，但启动命令和环境变量相同。

## 工具列表

| 工具 | 用途 |
|---|---|
| `mixly_detect_environment` | 枚举 Mixly 根目录、全部板卡、CDP、CLI 候选、版本和已安装核心 |
| `mixly_get_board_profiles` | 读取板卡本地型号、基础 FQBN、配置选项和型号工具箱 XML |
| `mixly_analyze_source` | 分析 C/C++、MicroPython 或 Python 源码 |
| `mixly_scan_library` | 单关键词或多能力 `queries` 扫描本地积木；可用 `includeSpecs` 同时返回真实契约 |
| `mixly_scan_arduino_libraries` | 按板卡扫描 Arduino 库；Mixly 4 读取 WASM 清单，Mixly 2/3 扫描本地目录 |
| `mixly_get_block_specs` | 返回候选块真实 XML、字段、输入、shadow、连接和生成器接口 |
| `mixly_inspect_library` | 学习标准第三方库目录、语言、媒体、Arduino 库和图片模式 |
| `mixly_create_library` | 为目标板创建缺失的底层原语；Mixly 2/3 生成传统库，Mixly 4 可生成插件并通过 `wasmSketchFiles` 注入浏览器编译源文件 |
| `mixly_build_project` | 从结构树或大型 `treePath` 构建 `.mix`，并在序列化前校验块输入契约、推导 `controls_if` mutation |
| `mixly_save_project` | 静态检查已有 XML 后原子写入 `.mix` |
| `mixly_package_library` | 递归打包积木库；Mixly 2/3 保持 0 个目录条目，Mixly 4 平铺插件根目录并保留嵌套载荷所需的父目录条目 |
| `mixly_launch` | 启动或复用本机 Mixly；Mixly 4 优先选择可自动化的 64 位 NW.js 并进入目标板卡页 |
| `mixly_import_library` | 调用 Mixly 自身 API 导入 ZIP；Mixly 4 使用 `PluginManager`/OPFS |
| `mixly_open_project` | 使用动态发现的板卡配置打开 `.mix` |
| `mixly_validate_project` | 在真实 Blockly 中检查节点、连接、中文名称、孤立块和重叠；节点丢失时返回类型和父输入诊断 |
| `mixly_generate_code` | 自动选择当前板卡的 Blockly 生成器，输出 `.ino`、`.py` 等代码 |
| `mixly_verify_equivalence` | 对参考源码和积木生成代码执行 `report`、`behavioral-strict` 或 `exact` 静态审计 |
| `mixly_project_workflow` | 最终闭环；Mixly 4 自动打包/导入工程引用插件，并默认执行可见桌面 WASM 编译 |
| `mixly_compile` | 调用本机 `arduino-cli` 做生成代码兼容检查；Mixly 4 会明确标记它不等同于桌面 WASM 编译 |

## AI 推荐工作流

```text
mixly_detect_environment
  -> 确认用户需要的板卡是否已经安装
  -> mixly_get_board_profiles(board=<动态板卡 id>)
  -> 按用户真实型号选择 FQBN 和配置项
  -> mixly_analyze_source
  -> mixly_scan_library(board=<动态板卡 id>, queries=[<源码能力关键词>...], includeSpecs=true)
  -> mixly_scan_arduino_libraries(board=<动态板卡 id>)
  -> 从 availableBlockTypes 选择官方或 ThirdParty 候选
  -> mixly_get_block_specs(blockTypes=<尚未随扫描返回的复杂动态块>)
  -> 按真实 defaultXml 设计结构树
  -> mixly_inspect_library（需要自定义库时先看标准结构）
  -> mixly_create_library（仅确认缺少底层原语时）
  -> mixly_project_workflow(
       treePath=<大型 JSON 树>,
       sourcePath=<原始主源码>,
       equivalenceSupportPaths=<生成端辅助源码列表>,
       equivalenceMode=behavioral-strict,
       equivalenceRequiredPatterns=<关键业务规则>,
       desktopCompile=<Mixly 4 默认 true>,
       compile=<是否额外做 Arduino CLI 兼容检查>
     )
```

如果环境探测中没有用户需要的板卡，AI 应帮助用户安装对应 Mixly 板卡支持或 Arduino core，然后重新探测，不能偷偷换成固定板卡。板卡选择器也支持 `板卡家族@具体型号`，例如 `default/arduino_avr@Arduino Nano`；具体名称必须来自 `mixly_get_board_profiles` 的本机结果。

`mixly_project_workflow` 是最终闭环工具，不代替前面的源码分析、动态扫描和真实规格读取。Mixly 4 默认 `autoImportLibraries=true`：它从工程 type 的真实 owner 推断暂存插件，自动打包并导入；也可用 `libraryNames` 或 `libraryZipPaths` 强制指定。C/C++ 板卡默认 `desktopCompile=true`，结果的 `finalCompileEngine` 必须是 `browser-wasm` 才能称为 Mixly 4 桌面编译通过。传入 `sourcePath` 或 `sourceText` 时，工作流默认用 `report` 模式生成等价性报告；`equivalenceMode` 可改为 `behavioral-strict` 或 `exact`。只有额外启用 Arduino CLI 兼容检查时才需要明确传入 `fqbn` 或 `fqbns`。

## 本地积木兼容规则

`mixly_detect_environment` 默认只返回板卡摘要与 `profileCount`。需要型号名、FQBN、型号工具箱 XML 和配置项时调用 `mixly_get_board_profiles`；诊断完整环境时可传 `details=true`。后续工具的 `board` 参数既可使用板卡 id，也可使用 `板卡id@型号`、`boardType@型号`、唯一型号名或 FQBN；例如 `default/arduino_esp32@ESP32 Dev Module`。

`mixly_scan_library` 的完整扫描结果在常驻 MCP 进程中缓存 30 秒；传 `refresh=true` 可立即刷新，`mixly_create_library` 和 `mixly_import_library` 成功后也会自动清空缓存。默认调用只返回计数与类型族摘要；单能力可传 `query="rgb"`，复杂任务优先传 `queries=["digital read","eeprom","oled"]`。`includeSpecs=true` 会把最多 20 个候选的精简真实契约一起返回。只有确实需要所有 type 时才传 `full=true`。Mixly 3 仍支持 `main.bundle.*.js`、无引号 XML 属性、`xml/`、`origin/xml/`、`default_src`/`extend_src` 伴随源码和本地 `.mix` 示例。

Mixly 4 的已安装插件位于浏览器 OPFS，而不是板卡目录。MCP 通过运行中页面的 `PluginManager.fs` 读取 `plugins/libraries/<boardType>/installed.json` 以及对应版本目录，并把插件 `index.xml`、`index.js` 纳入扫描、规格读取和库检查。读取 OPFS 需要可用的 Mixly 4 HTTP 页面和 CDP；缺少自动化通道时会返回明确的运行时诊断。

`blockTypes` 是官方类型，`thirdPartyBlockTypes` 是第三方类型，`availableBlockTypes` 是两者的合集。打包板卡以运行时 `Object.assign(Blockly.Blocks/forBlock, ...)` 注册表为准，并按赋值顺序处理覆盖；可读伴随源码用于返回更清晰的定义和生成器片段。AI 可复用其中任何能表达需求的本地积木。

这些类型只用于找候选。AI 不能看到 `display_rgb` 就自行猜出 `LED`、`COLOR` 等输入，应继续调用：

```json
{
  "board": "default/arduino_avr",
  "blockTypes": ["display_rgb", "DHT", "controls_if"]
}
```

`mixly_get_block_specs` 会返回本地版本的 `defaultXml` 和接口契约。构建树时：

- `type`、`field name`、`value name`、`statement name` 原样使用，不能翻译。
- 默认 shadow 从 `defaultXml` 复制，只修改用户要填写的值。
- 生成器允许插槽留空并提供回退值时，契约会在 `optionalValueInputs` 和 `valueDefaults` 中列出，例如文本输入留空后生成 `""`；这类空位不需要识图，也不会被误报成缺失结构。
- `mixly_build_project` 会在写 XML 前按本机 block 规格校验 `fields`、`values` 和 `statements`；输入名不存在，或把 `value` 错放进 `statements` 等连接种类不匹配时，会返回树路径和该块允许的契约，避免到真实加载阶段才丢掉整棵子树。动态块和允许留空的输入不按“必填”误判。
- 新工程不要手写 `.mix` XML。大型结构先写 JSON 再传 `treePath`；序列化器会自动处理 XML 转义与 `next` 嵌套。兼容导入旧 XML 时，游离或重复的 `<next>` 会在打开软件前失败。
- `controls_if` 会根据实际的 `IF0/DO0`、`IF1/DO1` 等分支以及 `ELSE` 自动推导 `elseif`/`else` mutation；函数定义和调用等其他动态块仍应按真实 `defaultXml` 保留 mutation。
- `mixly_validate_project` 会比较 XML 节点与真实 Blockly 加载后的节点；少一个也失败，并返回丢失节点的 type、id、树路径和父块输入位置，便于直接定位错误的 `value`/`statement` 名或 mutation。

## 中文命名

中文只用于用户可见的名称值，不用于官方接口名。例子：

```xml
<block type="variables_declare">
  <field name="VAR">候选指令</field>
</block>
<block type="variables_get">
  <field name="VAR">候选指令</field>
</block>
<block type="procedures_defnoreturn">
  <field name="NAME">设置休息区</field>
  <mutation><arg name="颜色" vartype="uint32_t"></arg></mutation>
</block>
<block type="procedures_callnoreturn">
  <mutation name="设置休息区"><arg name="颜色"></arg></mutation>
</block>
```

声明、读取、赋值必须使用完全相同的 `VAR`；函数定义和调用必须使用完全相同的 `NAME/mutation name`；参数定义、参数变量和调用参数也必须同名。`i/j/k/x/y/r/g/b` 等循环或坐标短名可以保留。默认检查发现 `candidateCommand`、`setREST`、`color` 这类用户可见英文名时会返回命名提示，不会拒绝工程；不希望检查时可传 `requireChineseNames=false`。

## 标准库和图片

`Emakefun_tts20` 展示了 `block/`、`generator/`、`css/`、`examples/`、`libraries/`、`media/`、`config.json`、`index.xml` 的完整结构；`handuan` 还展示了 `language/` 和 `Blockly.FieldImage`。使用 `mixly_inspect_library` 可动态读取这些模式。

Mixly 2/3 中，`mixly_create_library` 默认建立：

```text
LibraryName/
  block/libraryname.js
  generator/libraryname.js
  config.json
  index.xml
```

Mixly 4 中不会改写安装目录的板卡文件，而是在 `.mixly-mcp-staging/libraries/<boardType>/` 生成待打包插件：

```text
LibraryName/
  plugin.json
  index.xml
  index.js
```

`index.xml` 的 `<category>` 是直接子节点；`index.js` 以 ES module 导出 `blocks`、`generators` 和 `languages`。`mixly_package_library` 对 Mixly 4 生成根部平铺 ZIP，不增加 `LibraryName/` 外层目录，但会为嵌套载荷加入父目录条目；随后 `mixly_import_library` 调用 `PluginManager.installPlugin`，通过自动创建父目录的存储处理器安装到 OPFS。`wasmSketchFiles` 用于注入浏览器 WASM 编译所需的平铺 C/C++ 源文件，`extraFiles` 仍用于传统 Arduino `libraries/`、媒体和示例。

媒体、语言、CSS、Arduino 库和示例通过 `extraFiles` 添加。若用户明确要求块图标或图片选项，可记录：

```json
{
  "userRequestedImages": true,
  "imageMode": "block-icon"
}
```

用户未明确要求图片时建议保持 `imageMode: "none"`。如果代码里出现图片但没有 `userRequestedImages=true`，MCP 会返回提示，让 AI 再确认用户意图，不会阻止建库。

## 大型工程和布局

大型树先写成工作区内 JSON 文件，再把路径交给 MCP：

```json
{
  "board": "default/arduino_avr",
  "treePath": "C:\\Mixly\\projects\\lift\\tree.json",
  "projectPath": "C:\\Mixly\\projects\\lift\\lift.mix",
  "overwrite": true
}
```

服务端直接读文件，不把几万字符 JSON 作为子进程命令行参数，因此不会出现 `ENAMETOOLONG`。`treePath` 和 `mixly_mcp_call.js` 的 `--args-file`、`@path`、stdin `-` 都按 UTF-8 读取，并容忍 UTF-8 BOM；中文文件名、中文目录和中文 JSON 值无需转成系统代码页。构建器会把多个顶层 `variables_declare` 自动连成一个 `next` 栈，并给变量、函数、setup 和主循环分配稳定位置。真实验证还会检查孤立值块和顶层矩形重叠，这些可维护性问题以 `warnings` 返回；只有真实加载后节点数量减少才会失败。

## 源码等价性审计

`mixly_verify_equivalence` 用于在积木生成代码后检查明显的业务逻辑遗漏。独立调用示例：

```json
{
  "sourcePath": "C:\\Project\\原始源码.ino",
  "generatedPath": "C:\\Project\\积木生成代码.ino",
  "supportPaths": [
    "C:\\Project\\CanteenSystem.h",
    "C:\\Project\\CanteenSystem.cpp"
  ],
  "mode": "behavioral-strict",
  "requiredPatterns": [
    {
      "label": "重复卡保护",
      "pattern": "isUidRegistered\\s*\\("
    }
  ],
  "ignoreStrings": ["> "],
  "ignoreIdentifiers": ["serialEvent"],
  "allowExternalPath": true
}
```

也可用 `sourceText`、`generatedText` 直接传内容。三种模式的含义：

- `report`：只报告缺失的保护条件调用、可见字符串、常量、副作用调用和必需正则，不因差异判失败；工作流有原始源码时默认使用此模式。
- `behavioral-strict`：上述保守检查发现任何缺口就失败，适合交付前审计。它可能对等价改写产生误报，可用 `ignoreStrings`、`ignoreIdentifiers` 排除已人工确认的差异。
- `exact`：忽略注释和空白后比较文本；适合要求生成结果保持原代码形态的场景，正常重构通常不会通过。

`requiredPatterns` 是对生成代码执行的正则断言，适合登记重复注册保护、权限检查、故障分支等不能仅靠通用统计可靠推断的规则。`supportPaths` 把生成端自定义 Arduino 库等辅助源码与 `generatedPath` 一起纳入审计；工作流中对应参数名为 `equivalenceSupportPaths` 和 `equivalenceRequiredPatterns`。

这套检查能抓出“原源码有 `isUidRegistered()` 防重复注册，生成代码却漏掉”的问题，但它只是保守静态审计，不是语义等价的形式化证明。通过后仍需真实 Blockly 验证、编译以及必要的硬件测试。

## Arduino CLI 规则

MCP 只负责调用，不负责下载或强制指定 CLI。探测顺序包括：

- 工具参数 `arduinoCliPath`
- 环境变量 `ARDUINO_CLI`
- Mixly 根目录下的 `arduino-cli`
- 常见 Arduino IDE 安装目录
- 系统 `PATH`

`mixly_compile` 必须传：

```json
{
  "sketchPath": "C:\\Project\\Project.ino",
  "fqbn": "厂商:架构:板卡",
  "allowExternalPath": true
}
```

需要验证多个配置时传 `fqbns` 数组。单个 FQBN 默认超时为 900000 毫秒，可通过 `timeoutMs` 调整到 1000 至 3600000 毫秒。MCP 不再默认 Nano，也不会擅自选择 ESP32、ESP8266 或其他板卡。

Arduino 库不必复制进全局 `arduino-cli/libraries`。旧参数 `librariesPath` 仍可传一个目录；`librariesPaths` 可传多个相互隔离的目录，MCP 去重后分别作为 `--libraries` 参数交给 CLI。当前板卡的自定义积木库可通过以下参数按名称解析：

```json
{
  "board": "default/arduino_avr@Arduino Nano",
  "mixlyLibraries": ["CanteenSystem"],
  "librariesPaths": ["C:\\Project\\shared-libraries"]
}
```

`mixlyLibraries` 只会解析所选板卡 `libraries/ThirdParty/<名称>/libraries` 下的 Arduino 库，并校验名称和目录边界；不会扫描或复制其他 ThirdParty 库，也不会污染全局库目录。编译返回中保留实际使用的 `librariesPaths` 和解析后的 `mixlyLibraryPaths`，便于复现依赖集合。

Arduino CLI 会把草图目录内的全部 `.ino` 合并编译。原始参考源码、另一份生成代码或测试草图不能以 `.ino` 形式放在同一目录，否则会出现 `setup()` / `loop()` 重定义；参考代码改用 `.txt`，不同可编译草图放入各自同名目录。直接传入不在同名草图目录中的单个 `.ino` 时，MCP 会自动暂存为 Arduino CLI 接受的目录结构，并在结束后清理。

编译成功不等于资源充足。MCP 会从 CLI 输出提取 Flash 和 SRAM 的已用量、上限与百分比，并在 `resourceRisk` 中汇总风险：Flash 从 80% 起提示、90% 起为高风险；SRAM 从 70% 起提示、80% 起为高风险。AI 应把实际数字写进交付结果。尤其是 AVR 上 SRAM 占用很高时，即使编译通过，运行期仍可能因栈、动态字符串或库缓冲区继续增长而不稳定。CLI 输出格式无法识别时风险级别为 `unknown`，不能据此宣称资源安全。

## 路径安全

默认只允许读写 `MIXLY_HOME` 内文件。源码或 Arduino 工程位于其他目录时，AI 必须在用户需求明确的情况下传：

```json
{
  "allowExternalPath": true
}
```

## 本机测试

环境探测冒烟测试：

```powershell
node MixlyLocalMCP\mixly_mcp_call.js mixly_detect_environment
```

大型 JSON 参数可通过 `--args-file path`、`@path` 或 stdin `-` 传给命令行测试客户端，避免命令行长度和转义问题；三种入口都接受无 BOM 或带 UTF-8 BOM 的文件及中文路径：

```powershell
Get-Content -Raw args.json | node tools\mixly_mcp_call.js mixly_build_project -
```

等价性审计单元测试：

```powershell
node tools\test_mixly_code_equivalence.js
```

源码目录中的协议测试：

```powershell
node tools\test_mixly_mcp_protocol.js
```

Mixly 3 bundle、无引号 XML、示例和 lazy chunk 回归测试：

```powershell
node tools\test_mixly_mcp_bundle_board.js
```

Mixly 4 HTTP/CDP 运行时和 WASM Arduino 库清单回归测试：

```powershell
node tools\test_mixly4_runtime.js
node tools\test_mixly4_wasm_library_catalog.js
node tools\test_mixly4_plugin_library_fixture.js
```

MAX30102 可见桌面窗口点击编译测试（先以 CDP 启动 Mixly 4）：

```powershell
$env:MIXLY_HOME='C:\Path\To\Mixly4'
$env:MIXLY_CDP_PORT='9347'
node tools\test_mixly4_visible_wasm_compile.js
```

真实 Mixly 导入、代码生成和本地编译测试：

```powershell
node tools\test_mixly_mcp_live_workflow.js
```

部署 ZIP 自包含测试：

```powershell
node tools\test_mixly_local_mcp_package.js
```

## 问题反馈

提交问题前请先判断问题属于哪一层，避免同一个问题在多个仓库重复提交：

- MCP 的板卡发现、积木扫描、规格读取、项目构建、真实验证、代码生成、编译调用或便携包问题：在本项目的 [GitHub Issues](../../issues/new/choose) 反馈。
- Mixly 桌面程序、安装包、启动、页面导航或积木库导入管理器问题：在 [Mixly 打包版 Gitee Issues](https://gitee.com/mixly2/mixly2.0-win32-x64/issues) 反馈。
- Mixly 官方板卡 XML、官方积木定义、生成器或板卡源码问题：在 [Mixly 源码 Gitee Issues](https://gitee.com/mixly2/mixly2.0_src/issues) 反馈。

如果问题同时涉及 MCP 和 Mixly 本体，优先在最容易稳定复现的一侧提交，并在正文中附上另一侧问题链接。提交前先搜索已有 Issues；不要在 GitHub 和 Gitee 重复创建内容相同的问题。

问题标题建议使用：

```text
[MCP 2.5.6][板卡 id@型号] 简短现象
```

问题正文至少包含：

- MCP 版本、Mixly 版本、操作系统、Node.js 版本；涉及编译时再附 Arduino CLI 版本。
- `MIXLY_HOME` 对应的是 Mixly 2 打包目录、Mixly 3 源码树还是 Mixly 4 安装根目录。路径可脱敏，但请保留目录结构特征。
- `mixly_get_board_profiles` 返回的板卡 id、具体型号和 FQBN；不要只写“ESP32”或“Nano”。
- 出错的 MCP 工具名称、已脱敏的参数、最小复现步骤、期望结果和实际结果。
- 可最小复现的 `.mix`、积木库 ZIP、源代码片段或工程树 JSON。大型工程请删去与问题无关的业务代码。
- 完整错误文本和错误发生阶段，例如 `Download Timeout`、`EISDIR`、`Could not connect shadow block`、代码生成失败或 Arduino 编译失败。

反馈前请删除 Wi-Fi 密码、访问令牌、私有仓库地址、个人路径、设备序列号及其他敏感信息。截图不是必需项；本 MCP 当前不提供识图能力，文字日志和最小复现文件通常更容易定位问题。

## 当前机器验证结果

- 动态发现 21 个板卡入口，包含默认板卡和 `boards/extend` 扩展板。
- 发现本机 AVR、ESP32 和 ESP8266 Arduino cores。
- MCP 2.5.6 协议共 19 个工具；Harness 精简模式公开 9 个工作流工具 schema。AVR 完整模式扫描到 529 个官方类型，多能力扫描和契约可在一次调用中返回。
- Mixly 3 ESP32 源码树扫描到 659 个运行时块定义、642 个运行时生成器、1 个主 bundle、5 个工具箱 XML 和 28 个官方示例工程；ESP-NOW 定义、生成器、默认 XML 和示例均可直接读取。
- Mixly 4 安装可识别 NW.js/HTTP 布局、板卡 `boardType`、WASM 编译器与 Arduino 库清单；插件生成采用 `plugin.json`、`index.xml`、`index.js` 根部入口并通过 `PluginManager` 导入 OPFS。
- 后续新增的官方脚本和第三方库会在调用时重新扫描；命名、积木粒度、变量断链、孤立块、重叠和图片意图均只返回提示。
- `Emakefun_tts20` 的完整标准目录以及 `handuan` 的语言包、媒体和 `FieldImage` 模式均被正确识别。
- `treePath` 回归使用 240 个中文全局变量、480 个节点，自动连接为 1 条声明栈，没有命令行长度问题。
- 结构树会在写入前校验 block 输入契约，`controls_if` 的 `elseif`/`else` mutation 可从分支自动推导；真实加载丢节点时返回具体块和父输入诊断。
- UTF-8 BOM、中文参数文件和中文路径通过命令行调用回归；多目录 Arduino 库与指定 ThirdParty 库可隔离传给编译器。
- 等价性审计覆盖 `report`、`behavioral-strict`、`exact` 及关键业务正则；它的测试结论只代表保守静态检查，不代表形式化等价证明。
- 新版构建器生成的中文变量/中文函数/中文参数工程在真实 Blockly 中加载为 12 个节点，变量栈为 1、重叠为 0，并通过 Nano 编译。
- LiftLight 工程真实加载为 369 个积木，其中 341 个官方块、28 个底层自定义块、9 个中文函数；其旧重复 ID 和重叠只返回警告。
- 从积木生成代码后，Nano 新旧 Bootloader 在本机 Arduino CLI 上均编译通过。
- NanoEnv、LiftLight 和 MoonBase ZIP 均为 0 个目录条目。
