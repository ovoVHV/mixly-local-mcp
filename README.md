# Mixly Local MCP 2.2.0
下载zip文件解压到本地mixly目录，直接用ai客户端调用即可
这是一个完全在用户电脑上运行的 Mixly MCP。它不需要公网服务器，不上传源码，也不在服务器编译。

任何支持本地 STDIO MCP 的 AI 客户端都可以使用，例如 Codex、Claude Desktop、Cursor 和 Cline。每个客户端需要单独添加一次本地 MCP 配置。

## 设计原则

- 不固定板卡。MCP 从用户自己的 `boards.json`、`boards/default` 和 `boards/extend` 动态发现全部已安装板卡。
- 不固定 Arduino CLI 路径。AI 先调用环境探测，也可以把自己找到的路径传给编译工具。
- 不固定 FQBN。AI 必须根据用户的实际板卡和本机已安装核心选择 FQBN。
- 不捆绑 Arduino CLI、板卡核心和第三方 Arduino 库。
- 建议不要把完整业务程序或多个业务函数封装成少量黑盒积木；这种粒度问题只提示，不阻止 AI 按用户目标实现。
- 官方目录和 `libraries/ThirdParty` 都是可复用的本地积木来源。每次扫描都读取当前磁盘内容，后续新增积木无需修改 MCP。
- 候选块应读取真实规格，不根据块名猜字段和输入。
- 图形界面的变量、函数和参数建议使用自然中文；协议字符串和循环下标可以保留原文。命名偏好只产生提示。
- 建议把全局变量声明通过 `next` 连接为一条栈，并给顶层积木稳定、无重叠的坐标；布局问题只产生提示。
- 图片是否合适取决于用户要求；未记录用户图片需求时会提示 AI 确认，但不会阻止建库。本版 MCP 不提供识图能力。
- 只有无效 XML/JavaScript、当前板卡没有该 block type、块定义或生成器缺失、真实 Blockly 节点丢失、代码生成或编译失败等确定不可用的问题才报错。
- ZIP 只有文件条目，没有目录条目，避免 Mixly 导入时出现 `EISDIR`。

## 本地部署包

分发文件：

```text
Mixly_Local_MCP_v2.2.0.zip
```

解压后目录包含：

```text
MixlyLocalMCP/
  mixly_mcp_server.js
  validate_mixly_workspace.js
  mixly_mcp_call.js
  package.json
  package-lock.json
  node_modules/
  README.md
```

依赖已经放入 ZIP。用户只需要：

- Node.js 18 或更高版本
- 一份本机 Mixly 2.x 或 Mixly 3.x
- 支持本地 STDIO MCP 的 AI 客户端
- 需要编译 C/C++ 时，本机存在可用的 `arduino-cli`

## Mixly 根目录

MCP 按以下顺序寻找 Mixly：

1. 环境变量 `MIXLY_HOME`
2. MCP 进程的工作目录 `cwd`
3. MCP 脚本上一级目录

只要该目录中存在打包版的 `resources/app/src/boards`，或源码树的 `boards`，就会被识别为 Mixly 根目录。附件、聊天记录或示例中出现的路径不会被当成本机目录；实际读写始终以本机 `MIXLY_HOME` 为准。

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
| `mixly_scan_library` | 扫描选定板卡的官方积木、生成器和第三方积木库 |
| `mixly_get_block_specs` | 返回候选块真实 XML、字段、输入、shadow、连接和生成器接口 |
| `mixly_inspect_library` | 学习标准第三方库目录、语言、媒体、Arduino 库和图片模式 |
| `mixly_create_library` | 为目标板创建缺失的底层原语，默认生成标准库目录 |
| `mixly_build_project` | 从结构树或大型 `treePath` 构建、连接并布局 `.mix` |
| `mixly_save_project` | 静态检查已有 XML 后原子写入 `.mix` |
| `mixly_package_library` | 递归打包积木库，保持 0 个目录条目 |
| `mixly_launch` | 启动或复用带 CDP 端口的本机 Mixly |
| `mixly_import_library` | 调用 Mixly 自身 API 真实导入 ZIP |
| `mixly_open_project` | 使用动态发现的板卡配置打开 `.mix` |
| `mixly_validate_project` | 在真实 Blockly 中检查节点、连接、中文名称、孤立块和重叠 |
| `mixly_generate_code` | 自动选择当前板卡的 Blockly 生成器，输出 `.ino`、`.py` 等代码 |
| `mixly_project_workflow` | 一次完成构建、启动、打开、真实验证、代码生成和可选编译 |
| `mixly_compile` | 可选地调用用户本机 `arduino-cli` 编译 C/C++ 工程 |

## AI 推荐工作流

```text
mixly_detect_environment
  -> 确认用户需要的板卡是否已经安装
  -> mixly_get_board_profiles(board=<动态板卡 id>)
  -> 按用户真实型号选择 FQBN 和配置项
  -> mixly_analyze_source
  -> mixly_scan_library(board=<动态板卡 id>)
  -> 从 availableBlockTypes 选择官方或 ThirdParty 候选
  -> mixly_get_block_specs(blockTypes=<候选本地块>)
  -> 按真实 defaultXml 设计结构树
  -> mixly_inspect_library（需要自定义库时先看标准结构）
  -> mixly_create_library（仅确认缺少底层原语时）
  -> mixly_package_library
  -> mixly_launch
  -> mixly_import_library
  -> mixly_project_workflow(treePath=<大型 JSON 树>, compile=<是否编译>)
```

如果环境探测中没有用户需要的板卡，AI 应帮助用户安装对应 Mixly 板卡支持或 Arduino core，然后重新探测，不能偷偷换成固定板卡。板卡选择器也支持 `板卡家族@具体型号`，例如 `default/arduino_avr@Arduino Nano`；具体名称必须来自 `mixly_get_board_profiles` 的本机结果。

`mixly_project_workflow` 是最终闭环工具，不代替前面的源码分析、动态扫描和真实规格读取。C/C++ 编译仍要求 AI 明确传入用户板卡的 `fqbn` 或 `fqbns`，不会把 ESP32、Nano 或任何其他板卡写成默认值。

## 本地积木兼容规则

`mixly_detect_environment` 还会读取各板卡目录的 `config.json` 和 `boards.json`，在 `profiles` 中返回型号名、FQBN、型号工具箱 XML 与配置键。后续工具的 `board` 参数既可使用原有板卡 id，也可使用 `板卡id@型号`、`boardType@型号`、唯一型号名或 FQBN；例如 `default/arduino_esp32@ESP32 Dev Module`。这让型号专用工具箱和编译目标保持一致。

`mixly_scan_library` 会在每次调用时重新扫描板卡官方脚本和 `libraries/ThirdParty`，因此以后安装的新积木也会自动出现。Mixly 3 板卡同时支持 `main.bundle.*.js`、无引号 XML 属性、`xml/`、`origin/xml/`、`default_src`/`extend_src` 伴随源码和本地 `.mix` 示例。只扫描非空主 bundle 及 `index.xml` 明确引用的脚本，不会把 Pyodide 等 lazy chunk 误当作当前板卡积木；零字节占位 bundle 会自动回退到伴随源码。

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
- 带 mutation 的 `controls_if`、函数定义和函数调用必须保留 mutation。
- `mixly_validate_project` 会比较 XML 节点数与真实 Blockly 加载节点数；少一个也失败。

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

`mixly_create_library` 默认建立：

```text
LibraryName/
  block/libraryname.js
  generator/libraryname.js
  config.json
  index.xml
```

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

服务端直接读文件，不把几万字符 JSON 作为子进程命令行参数，因此不会出现 `ENAMETOOLONG`。构建器会把多个顶层 `variables_declare` 自动连成一个 `next` 栈，并给变量、函数、setup 和主循环分配稳定位置。真实验证还会检查孤立值块和顶层矩形重叠，这些可维护性问题以 `warnings` 返回；只有真实加载后节点数量减少才会失败。

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

Arduino CLI 会把草图目录内的全部 `.ino` 合并编译。原始参考源码、另一份生成代码或测试草图不能以 `.ino` 形式放在同一目录，否则会出现 `setup()` / `loop()` 重定义；参考代码改用 `.txt`，不同可编译草图放入各自同名目录。直接传入不在同名草图目录中的单个 `.ino` 时，MCP 会自动暂存为 Arduino CLI 接受的目录结构，并在结束后清理。

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

大型 JSON 参数可通过 `--args-file path`、`@path` 或 stdin `-` 传给命令行测试客户端，避免命令行长度和转义问题：

```powershell
Get-Content -Raw args.json | node tools\mixly_mcp_call.js mixly_build_project -
```

源码目录中的协议测试：

```powershell
node tools\test_mixly_mcp_protocol.js
```

Mixly 3 bundle、无引号 XML、示例和 lazy chunk 回归测试：

```powershell
node tools\test_mixly_mcp_bundle_board.js
```

真实 Mixly 导入、代码生成和本地编译测试：

```powershell
node tools\test_mixly_mcp_live_workflow.js
```

部署 ZIP 自包含测试：

```powershell
node tools\test_mixly_local_mcp_package.js
```

## 当前机器验证结果

- 动态发现 21 个板卡入口，包含默认板卡和 `boards/extend` 扩展板。
- 发现本机 AVR、ESP32 和 ESP8266 Arduino cores。
- MCP 2.2.0 协议共 17 个工具；AVR 当前扫描到 529 个官方类型，并把官方和 `ThirdParty` 类型合并到 `availableBlockTypes`。
- Mixly 3 ESP32 源码树扫描到 659 个运行时块定义、642 个运行时生成器、1 个主 bundle、5 个工具箱 XML 和 28 个官方示例工程；ESP-NOW 定义、生成器、默认 XML 和示例均可直接读取。
- 后续新增的官方脚本和第三方库会在调用时重新扫描；命名、积木粒度、变量断链、孤立块、重叠和图片意图均只返回提示。
- `Emakefun_tts20` 的完整标准目录以及 `handuan` 的语言包、媒体和 `FieldImage` 模式均被正确识别。
- `treePath` 回归使用 240 个中文全局变量、480 个节点，自动连接为 1 条声明栈，没有命令行长度问题。
- 新版构建器生成的中文变量/中文函数/中文参数工程在真实 Blockly 中加载为 12 个节点，变量栈为 1、重叠为 0，并通过 Nano 编译。
- LiftLight 工程真实加载为 369 个积木，其中 341 个官方块、28 个底层自定义块、9 个中文函数；其旧重复 ID 和重叠只返回警告。
- 从积木生成代码后，Nano 新旧 Bootloader 在本机 Arduino CLI 上均编译通过。
- NanoEnv、LiftLight 和 MoonBase ZIP 均为 0 个目录条目。
