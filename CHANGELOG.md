# 更新日志

## 2.5.16 - 2026-08-31

- 修复 Mixly 2/3 从错误的 `process.cwd()` 启动 Harness，安装器现在把每一代的绝对根目录写入适配器配置。
- 为 Electron 19 / Chromium 102 注入 `AbortSignal.timeout`、`AbortSignal.any` 和 `Promise.withResolvers` 兼容层，修复 AI 面板打开后连接反复中断、工作区一直加载的问题。
- Harness 启动后自动创建或复用当前 Mixly 工作区和空白会话，用户不再需要手工选择工作区。
- 修复复用运行中 Harness 时状态仍显示 `starting`，并给旧版面板 URL 增加兼容缓存标识。

## 2.5.15 - 2026-08-23

- 修复 `legacy-peer-deps` 导致 `@deepseek-ai/cordis-plugin-group` 等运行时 peer 依赖被省略、最终校验失败的问题。
- 安装器会检查关键运行包；即使 CLI 文件存在但依赖不完整，也会自动补齐而不是直接进入失败校验。

## 2.5.14 - 2026-08-23

- 发布包内置 DeepSeek Harness lockfile，避免首次安装时 npm 长时间解析 500 多个依赖。
- npm 使用 `legacy-peer-deps` 和离线缓存优先策略；连续 180 秒无输出会自动中止并切换 registry。

## 2.5.13 - 2026-08-23

- npm 安装显示最后一条依赖下载事件和“等待进程输出”状态，不再只显示 `0 B` 让人误以为卡死。
- npm 单个请求增加 20 秒超时和一次重试；国内镜像失败时自动回退官方 registry。
- npm 使用详细 fetch 日志及 `replace-registry-host`，锁文件中的官方 tarball 地址也会按当前 registry 替换。

## 2.5.12 - 2026-08-23

- Node.js 运行时下载默认优先使用 npmmirror 国内镜像，失败时自动回退官方源。
- DeepSeek Harness 的 npm 安装默认使用 npmmirror registry；可用 `MIXLY_NPM_REGISTRY` 覆盖。

## 2.5.11 - 2026-08-23

- 2/3 代安装器的空路径会直接跳过；两代路径都为空时以成功状态结束，不再把“未选择安装目标”当成错误。
- Mixly 4 安装器的空路径也会直接跳过；未选择目标时不会先检查 Node.js 或联网。
- Node.js 下载显示真实百分比、速度和预计剩余时间；解压、Harness 安装和校验显示统一阶段百分比。
- Harness 的 npm 安装改为可见的实时状态，显示耗时和输出量，避免 npm spinner 看起来像卡住。

## 2.5.10 - 2026-08-23

- 两个分代安装器现在检查 Node.js 主版本是否至少为 18，并优先复用已有的 `%LOCALAPPDATA%\\MixlyHarness\\runtime\\node\\node.exe`。
- 缺少系统 Node.js 时不再直接抛出模糊错误，而是明确提示可用的安装方式。

## 2.5.9 - 2026-08-23

- `Install_Mixly23_AI.cmd` 会自动向上扫描安装器目录的父目录，识别常见的 Mixly 2/3 安装位置；识别成功时无需用户填写路径。
- 只有无法自动识别时才回退到手动输入，并明确要求填写 Mixly 根目录，而不是 `MixlyLocalMCP` 文件夹。

## 2.5.8 - 2026-08-23

- 将安装入口拆分为 `Install_Mixly4_AI.cmd` 和 `Install_Mixly23_AI.cmd`，Mixly 4 与 Mixly 2/3 不再共用一个交互命令。
- 删除容易让用户误解的全代际通用安装入口，保留清晰的代际边界。

## 2.5.7 - 2026-08-23

- 通用一键安装器现在同时支持 Mixly 2、Mixly 3 和 Mixly 4；用户可填写任意代际路径，留空即可跳过。
- `Install_Mixly4_AI.cmd` 保留为旧入口并自动转发到通用安装器。

## 2.5.6 - 2026-08-23

- 新增 `Install_Mixly4_AI.cmd` 一键安装入口：自动识别 Mixly 4 根目录，安装便携 Node.js 与 DeepSeek Harness，并注入全板卡 AI 按钮。
- 发布包文档补充从解压到首次重开 Mixly 4 的完整用户流程，降低手工填写路径和启动参数的要求。

## 2.5.5 - 2026-08-23

- 修复 Mixly 4 内置 AI 在同一安装目录的 CDP 端口变化时重启整个 Harness，避免用户允许重启后当前任务和会话被杀掉。
- 同一 Mixly 安装现在沿用已运行 Harness 锁定的 MCP 上下文；只有切换 Mixly 代际或安装目录才重启。
- 适配器在复用会话时明确提示“未重启任务”，并增加 CDP 变化与代际变化回归断言。

## 2.5.4 - 2026-08-21

- `mixly_scan_library` 支持最多 8 个 `queries` 分组检索，并可用 `includeSpecs=true` 在一次调用中附带最多 20 个候选的精简真实契约。
- Harness 指令优先使用多能力扫描，不再通过 shell 逐个搜索官方生成器；更新自制库需重新走 MCP 校验。
- 新工程强制推荐 `mixly_build_project.tree/treePath`，禁止手写 `.mix`；结构树自动完成文本转义、`next` 嵌套和连接契约验证。
- `parseProjectXml` 提前拒绝游离、重复或非法子节点的 `<next>`，避免合法 XML 被 Blockly 静默截断后才在真实加载阶段发现节点丢失。
- 新增多能力扫描、内联契约和错误 `next` 回归；Mixly 4 ESP32 的真实 122 节点复杂工程通过静态与 live Blockly 一致性验证。

## 2.5.3 - 2026-08-21

- Mixly 4 实时预览改为直接更新当前 Blockly 工作区，同一板卡不再导航或重载页面，Harness 侧栏和会话保持打开。
- 打开工程和导入 Mixly 4 插件统一复用板卡页面判断；只有板卡实际变化时才导航。
- AI 侧栏状态写入同源会话存储，必要的刷新或板卡切换后自动恢复；用户手动关闭后保持关闭。
- 工程加载后将首个顶层积木居中到侧栏左侧可见区域，避免已渲染积木被 AI 面板遮挡。
- 新增真实 Mixly 4 回归：MCP 写入前后 target、URL、侧栏均不变，并检查积木 SVG 位于可视区域。

## 2.5.2 - 2026-08-21

- Mixly 4 AI 入口改为全局 `boards/index.html` 适配器，修复按钮只在导入 Harness 插件的 Arduino Uno 页面出现的问题。
- 保留 OPFS 插件兼容路径，并验证重复加载不会产生第二个 AI 按钮。
- Harness 精简模式公开 `mixly_build_project`；在锁定 CDP 的 Mixly 4 中，结构树写入后默认立即载入当前 Blockly，最终工作流仍负责完整验证与编译。

## 2.5.1 - 2026-08-21

- 修复共享 `active-context.json` 被其他 Mixly 窗口覆盖后，同一 Harness 聊天会从 Mixly 4 静默切到 Mixly 2 的问题。
- MCP 路由器在启动时固定 Mixly 根目录、代际、CDP 和 origin；代际切换由启动器结束旧进程树后重新启动。
- Harness 工作目录绑定当前 Mixly 根目录；保留共享 `DSH_HOME` 中已有的 API 配置和聊天数据，MCP 上下文不再随文件变化。
- AI 侧栏标题显示当前 Mixly 代际，适配器忽略脚本伪造的按钮点击。
- 修复 MCP 忽略 Harness 注入的 Mixly 4 CDP 端口；无参数工具调用现在使用实际窗口端口，不再错误回退到 `9333`。

## 2.5.0 - 2026-08-21

### Mixly 内置 AI 客户端

- 新增官方 DeepSeek Harness 集成。Mixly 2/3 通过薄适配脚本增加顶栏按钮，Mixly 4 通过不贡献任何工具箱积木的 OPFS 插件增加按钮。
- Harness 使用便携 Node.js 24 和官方 `@deepseek-ai/dsh`，统一安装在 `%LOCALAPPDATA%\MixlyHarness`；三个 Mixly 代际共用一个 Web 客户端和配置目录。
- 新增动态 MCP stdio 路由器。点击任意 Mixly 窗口会更新活动根目录，下一次工具调用自动切换对应 MCP 子进程，无需重启 Harness。
- Harness 侧只公开 8 个高频工作流工具的 schema，19 个工具仍可按名称调用，减少工具描述占用和模型选错概率。
- Mixly 4 客户端改为主窗口内持久 iframe 侧栏，带刷新和关闭按钮；不再使用会被 NW.js 回收的远程子窗口。
- 启动器可按当前页面 origin 自动发现 Mixly 4 CDP 端口，避免把实际 `9347` 错当成默认 `9333`。
- 纯 Web Mixly 3 页面会安全禁用 AI 按钮；只有真实 Node 桥接存在时才允许启动，不与 `.mixly-nav` 委托事件冲突。

### 验证

- Mixly 2 和 Mixly 4 均通过可见桌面窗口真实鼠标点击；共享 Harness 冷启动约 4.5 秒，代际上下文复用切换约 0.44 秒。
- Mixly 4 侧栏持续加载 10 秒以上，iframe 返回 HTTP 200，工具箱没有新增 Harness 分类或积木。
- 路由器在同一 MCP 客户端连接中完成 Mixly 2 到 Mixly 4 切换，并分别返回正确代际探测结果。

## 2.4.3 - 2026-08-16

### 性能与上下文

- `mixly_scan_library` 默认返回计数摘要；普通候选检索使用 `query` 和最多 60 个结果，只有审计全集时才传 `full=true`。
- 积木扫描和规格读取增加 30 秒常驻进程缓存；`refresh=true` 可强制更新，建库和导库成功后会自动失效，避免读取旧插件。
- `mixly_get_block_specs` 默认不遍历本地 `.mix` 示例，需要示例时显式传 `includeExamples=true`。
- `mixly_detect_environment` 默认不执行 Arduino CLI 子进程，也不返回板卡 profiles/CDP targets 等诊断细节；分别通过 `probeCli=true`、`details=true` 按需展开。
- MCP 工具调用的 `content` 改为短摘要，完整结果只保留在 `structuredContent`，避免同一大对象重复消耗上下文；初始化说明同步压缩。
- Mixly 4 隐藏编译菜单改为等待可见状态；发送真实鼠标事件后必须观察到输出变化，未触发时使用可见按钮的原生点击兜底并如实记录方法。

### 验证

- 本机 AVR/RGB 首次扫描约 960 ms，30 秒缓存命中约 6.7 ms；关键词结构化结果约 2.2 KB，完整全集约 42.7 KB，文本摘要约 0.7 KB。

## 2.4.2 - 2026-08-16

### Mixly 4 工作流

- MCP 初始化指令与环境探测新增代际感知规则，明确区分 Mixly 4 的 OPFS 插件、`wasmSketchFiles` 和浏览器 WASM 编译，与 Mixly 2/3 的文件系统 ThirdParty 流程。
- `mixly_project_workflow` 自动识别工程引用的暂存插件，完成打包、`PluginManager` 导入、打开、验证、代码生成，并对 C/C++ 默认点击桌面按钮等待真实 WASM 结果。
- 工作流支持直接复用已有 `.mix`；`libraryNames`、`libraryZipPaths`、`autoImportLibraries`、`desktopCompile` 可控制高级行为。
- `mixly_launch` 优先选择本地 64 位 NW.js/SDK，自动从 MixVM 首页进入目标板卡页；HTTP 存在但 CDP 不可用时返回明确错误，不再继续执行伪自动化流程。
- 桌面编译可展开“更多”菜单并点击其中的编译命令；工作流返回内容移除冗长 OPFS manifest。

### 验证

- 从 HTTP/CDP 均未启动的状态只调用一次 `mixly_project_workflow`：MCP 自行启动 x64 Mixly 4、导入 MAX30102 插件、加载 19 个节点、注入 6 个 WASM 源文件并输出 `==编译成功==`。

## 2.4.1 - 2026-08-14

### 新增

- `mixly_create_library` 支持 `wasmSketchFiles`，将 `.h/.hpp/.c/.cc/.cpp` 作为精确命名的浏览器 WASM `sketchFiles` 注入 Mixly 4 生成器。
- 新增可见 Mixly 4 桌面窗口的编译按钮点击与进程存活回归测试，并加入 13 块的 MAX30102 心率插件示例。

### 修复与优化

- 生成代码时临时隔离 WASM 源文件键，避免 Mixly 4 把 `MAX30105.h` 等键再次拼成 `.h.h`，同时在编译阶段保留完整源文件。
- Mixly 4 OPFS 导入为嵌套文件递归创建父目录；大型 CDP 表达式通过临时文件传递，避免 Windows 命令行过长。
- MAX30102 WASM 库使用单翻译单元兼容入口，解决独立 `.cpp` 在 AVR 浏览器编译器中未参与链接的问题。

### 验证

- 在可见的 64 位 Mixly 4 窗口中实际点击编译，Arduino AVR UNO 完成 MAX30102 工程的 WASM 编译和链接，输出 `==编译成功==`，宿主未退出。

## 2.4.0 - 2026-08-10

### 新增

- 兼容 Mixly 4 NW.js/HTTP 运行时，自动识别根部 `boards` 与 `static-server/server.js`，默认服务地址为 `http://localhost:65234`。
- `mixly_scan_arduino_libraries` 支持从 Mixly 4 WASM 归档的 `libraries.manifest.json` 返回库名、版本、头文件、依赖和文件清单。
- Mixly 4 已安装插件可通过 OPFS `PluginManager.fs` 读取 `installed.json`、`index.xml` 和 `index.js`，纳入积木扫描与规格检查。
- `mixly_create_library` 在 Mixly 4 下生成 `plugin.json`、`index.xml` 和 ES module `index.js`，并在暂存目录中等待打包/导入。

### 修复与优化

- Mixly 4 导入改用 `PluginManager.installPlugin`，不再把插件解压到只读板卡目录，避免 `EISDIR`。
- Mixly 4 插件 ZIP 使用根部入口文件和平铺文件条目；Mixly 2/3 的传统 `block/`、`generator/` 结构保持兼容。
- 发布脚本和便携包测试从 `package.json` 读取版本，README 使用仓库内版本，减少发布包与源码文档漂移。

### 验证

- Mixly 4 HTTP/CDP 探测、WASM 库清单读取和插件运行时回归测试加入发布验证。

## 2.3.0 - 2026-08-07

### 新增

- 新增 `mixly_verify_equivalence`，提供 `report`、`behavioral-strict`、`exact` 三种源码审计模式。
- `mixly_project_workflow` 新增生成后等价性阶段，并支持生成端辅助源码和关键业务正则。
- 积木规格新增可留空输入及生成器回退值信息。
- 编译结果新增 Flash/SRAM 百分比和 `resourceRisk`。

### 修复与优化

- 构建前校验官方及 ThirdParty 积木的字段、值输入和语句输入名称。
- 自动推导 `controls_if` 的 `elseif`/`else` mutation。
- 真实 Blockly 加载丢节点时返回缺失块、父块和父连接详情。
- UTF-8 BOM、中文参数文件、中文路径及大型 `treePath` 可稳定读取。
- Arduino CLI 支持多个隔离库目录，并能解析所选板卡的 ThirdParty Arduino 库。
- 自定义生成器直接使用未转义变量名时给出兼容性警告。

### 验证

- MCP 协议共 18 个工具；AVR 本机扫描到 529 个官方积木类型。
- 官方/ThirdParty 契约、Mixly bundle、源码等价性、中文路径、真实 Blockly、Nano 编译及便携包解包启动回归通过。
- 发布 ZIP 不包含目录条目，避免 `EISDIR`。

## 2.2.0 - 2026-08-07

- 支持 Mixly 2/3、全板卡动态发现、官方与 ThirdParty 积木扫描。
- 支持结构树构建、真实 Blockly 验证、代码生成、Arduino CLI 编译和便携 ZIP。
