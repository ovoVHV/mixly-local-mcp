'use strict';

/*
 * Local Mixly MCP server.
 * stdout is reserved for newline-delimited JSON-RPC; diagnostics use stderr.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const zlib = require('zlib');
const { compareCode } = require('./mixly_code_equivalence');

function looksLikeMixlyRoot(candidate) {
  if (!candidate) return false;
  const resolved = path.resolve(candidate);
  return fs.existsSync(path.join(resolved, 'resources', 'app', 'src', 'boards')) ||
    fs.existsSync(path.join(resolved, 'boards'));
}

// Mixly 4 is an NW.js app whose board files live at the package root. Older
// releases keep them below resources/app/src, so the runtime layout must be
// detected before choosing library and launch behavior.
function detectMixlyLayout(root) {
  const packageJson = readJsonFile(path.join(root, 'package.json')) || {};
  const nodeMain = String(packageJson['node-main'] || '').replace(/\\/g, '/');
  if (fs.existsSync(path.join(root, 'boards')) && /(?:^|\/)static-server\/server\.js$/i.test(nodeMain)) {
    return { generation: 4, runtime: 'nwjs', packageJson };
  }
  if (fs.existsSync(path.join(root, 'resources', 'app', 'src', 'boards'))) {
    return { generation: 2, runtime: 'electron', packageJson };
  }
  return { generation: 3, runtime: 'source', packageJson };
}

function resolveMixlyRoot() {
  const explicit = process.env.MIXLY_HOME;
  if (explicit && !looksLikeMixlyRoot(explicit)) {
    throw new Error(`MIXLY_HOME 不是有效的 Mixly 安装目录: ${path.resolve(explicit)}`);
  }
  const candidates = [
    explicit,
    process.cwd(),
    path.resolve(__dirname, '..')
  ].filter(Boolean);
  const found = candidates.find(looksLikeMixlyRoot);
  if (found) return path.resolve(found);
  throw new Error(
    '找不到 Mixly 根目录。请设置 MIXLY_HOME，或把 MCP 的 cwd 配置为 Mixly 安装目录。'
  );
}

const ROOT = resolveMixlyRoot();
const HELPER_DIR = __dirname;
const MIXLY_LAYOUT = detectMixlyLayout(ROOT);
const APP_SRC_ROOT = fs.existsSync(path.join(ROOT, 'resources', 'app', 'src', 'boards'))
  ? path.join(ROOT, 'resources', 'app', 'src')
  : ROOT;
const MIXLY_EXE = path.join(ROOT, process.platform === 'win32' ? 'Mixly.exe' : 'mixly');
const DEFAULT_LIB_ROOT = path.join(ROOT, 'arduino-cli', 'libraries');
const BOARDS_DIR = path.join(APP_SRC_ROOT, 'boards');
const MIXLY4_WASM_DIR = path.join(ROOT, 'common', 'modules', 'web-modules', 'mixly', 'wasm');
// Mixly 4 stores installed plugins in OPFS.  Keep MCP-created sources in a
// private, deterministic staging area instead of writing into the read-only
// application board tree (which also caused the historical EISDIR import
// failure when a ZIP was unpacked there).
const MIXLY4_STAGING_DIR = path.join(ROOT, '.mixly-mcp-staging');
const DEFAULT_CDP_PORT = 9333;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const MCP_SERVER_VERSION = require('./package.json').version;
const COMMAND_TIMEOUT_MS = 180000;
const DEFAULT_COMPILE_TIMEOUT_MS = 900000;
const DISCOVERY_CACHE_TTL_MS = 30000;
const libraryScanCache = new Map();
const blockSpecsCache = new Map();

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writesLocal = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const mayOverwrite = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const toolDefinitions = [
  {
    name: 'mixly_scan_library',
    title: '扫描本地 Mixly 积木',
    description: '按关键词扫描当前板卡的官方与第三方积木。用 queries 一次查询多个能力；includeSpecs=true 可在同一调用中附带候选的真实契约，避免再用 shell 查生成器。默认只返回计数摘要，只有确需全集时才传 full=true。结果缓存 30 秒。',
    inputSchema: {
      type: 'object', required: ['board'],
      properties: {
        board: { type: 'string', description: '环境探测返回的板卡 id、boardType、id@型号、唯一型号名或 FQBN。' },
        boardRoot: { type: 'string', description: '工作区内的自定义板卡根目录；通常不需要。' },
        query: { type: 'string', maxLength: 120, description: '候选关键词，例如 rgb、oled、serial；普通调用应提供。' },
        queries: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 120 }, description: '一次查询多个独立能力，例如 ["digital read", "eeprom", "oled"]；与 query 二选一。' },
        includeSpecs: { type: 'boolean', description: '把匹配 type 的 defaultXml 和输入契约一并返回，最多 20 个；规划复杂工程时建议 true。' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: '候选上限，默认 60。' },
        full: { type: 'boolean', description: '返回完整类型清单；默认 false，可能产生大量 token。' },
        refresh: { type: 'boolean', description: '忽略 30 秒缓存并重新扫描。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Mixly 4 OPFS 读取使用的 CDP 端口，默认 9333。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_scan_arduino_libraries',
    title: '扫描板卡可用 Arduino 库',
    description: '按板卡扫描本机可编译的 Arduino 库。Mixly 4 直接读取内置 WASM 库包的 libraries.manifest.json；Mixly 2/3 扫描本地 Arduino 与 ThirdParty 库目录。可按库名或头文件过滤，并按需返回完整文件清单。',
    inputSchema: {
      type: 'object', required: ['board'],
      properties: {
        board: { type: 'string', description: 'mixly_detect_environment 返回的板卡 id、boardType、profile 或 FQBN。' },
        libraryNames: { type: 'array', maxItems: 50, items: { type: 'string' }, description: '可选库名过滤，不区分大小写。' },
        headers: { type: 'array', maxItems: 50, items: { type: 'string' }, description: '可选 #include 头文件过滤，例如 Adafruit_SSD1306.h。' },
        includeFiles: { type: 'boolean', description: '是否返回每个库的完整文件清单，默认 false。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_get_block_specs',
    title: '读取积木真实接口',
    description: '读取指定积木的真实 XML 与输入契约。默认跳过昂贵的示例工程遍历；仅在 defaultXml 不足时传 includeExamples=true。结果缓存 30 秒。',
    inputSchema: {
      type: 'object', required: ['board', 'blockTypes'],
      properties: {
        board: { type: 'string', description: '环境探测返回的板卡 id、boardType、id@型号、唯一型号名或 FQBN。' },
        blockTypes: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' }, description: '要查询的准确积木 type；一次最多 50 个。' },
        includeSource: { type: 'boolean', description: '返回精简的块定义和生成器源码片段，默认 false；复杂动态块可开启。' },
        includeExamples: { type: 'boolean', description: '遍历本地示例并返回用法，默认 false。' },
        refresh: { type: 'boolean', description: '忽略 30 秒缓存并重新读取。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Mixly 4 OPFS 读取使用的 CDP 端口，默认 9333。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_inspect_library',
    title: '检查标准积木库结构',
    description: '检查已安装第三方库的完整目录、脚本、语言、媒体、Arduino libraries、定义/生成器覆盖和图片字段模式。制作新库前优先参考本机标准库；图片仅用于用户明确要求的块图标或下拉选项。',
    inputSchema: {
      type: 'object', required: ['board', 'library'],
      properties: {
        board: { type: 'string' },
        library: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{1,63}$' },
        blockTypes: { type: 'array', maxItems: 30, items: { type: 'string' }, description: '可选；只返回这些块的接口摘要。' },
        includeSource: { type: 'boolean', description: '是否返回所选积木的精简源码片段，默认 false。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Mixly 4 OPFS 读取使用的 CDP 端口，默认 9333。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_detect_environment',
    title: '探测本机 Mixly 和 Arduino 环境',
    description: '必须先调用。默认返回精简板卡摘要且不运行 Arduino CLI；准备 CLI 编译时才传 probeCli=true，需要诊断细节时才传 details=true。Mixly 4 会返回 WASM 强制工作流。',
    inputSchema: {
      type: 'object',
      properties: {
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' },
        arduinoCliPath: { type: 'string', description: '可选的 CLI 候选路径。' },
        arduinoCliConfigPath: { type: 'string', description: '可选的 arduino-cli 配置文件；省略时自动使用所选内置 CLI 同目录下的 arduino-cli.json/yaml。' },
        probeCli: { type: 'boolean', description: '执行 version/core list，默认 false；只在准备 Arduino CLI 编译时开启。' },
        details: { type: 'boolean', description: '返回完整板卡、CDP targets 和 WASM 包细节，默认 false。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_get_board_profiles',
    title: '读取板卡型号与 FQBN 配置',
    description: '读取目标板卡目录自己的 config.json/boards.json，返回全部本地型号、基础 FQBN、可选参数和型号工具箱 XML。用于按用户真实硬件选择配置，不固定 Nano、ESP32 或其他板卡。',
    inputSchema: {
      type: 'object', required: ['board'],
      properties: {
        board: { type: 'string', description: 'mixly_detect_environment 返回的板卡 id、boardType、id@型号、唯一型号名或 FQBN。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_analyze_source',
    title: '分析目标板源码',
    description: '分析 C/C++、MicroPython 或 Python 源码中的依赖、常量、函数、引脚和硬件能力，用于规划官方积木与缺失底层原语。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: 'Arduino 源码路径；默认只允许当前 Mixly 工作区内。' },
        sourceText: { type: 'string', description: '直接传入源码文本；与 sourcePath 二选一。' },
        language: { type: 'string', description: '可选语言提示；省略时自动判断。' },
        allowExternalPath: { type: 'boolean', description: '显式允许读取工作区外的 sourcePath，默认 false。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_verify_equivalence',
    title: '审计生成代码与参考源码',
    description: '对参考源码、积木生成代码及生成端辅助源码执行保守静态审计，报告遗漏或改变的保护条件、提示文本、常量、关键引脚/时序调用和必需正则。它不是形式化证明，也不替代真实 Blockly、编译或硬件测试。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '参考源码文件；与 sourceText 二选一。' },
        sourceText: { type: 'string', description: '参考源码文本；与 sourcePath 二选一。' },
        generatedPath: { type: 'string', description: '积木生成的代码文件；与 generatedText 二选一。' },
        generatedText: { type: 'string', description: '积木生成的代码文本；与 generatedPath 二选一。' },
        supportPaths: { type: 'array', items: { type: 'string' }, description: '生成端自定义 Arduino 库或其他辅助实现文件；用于补充实现审计，默认不参与主文件 requiredPatterns 或 exact 匹配。' },
        includeSupportInRequiredPatterns: { type: 'boolean', description: '显式允许 requiredPatterns 扫描 supportPaths；默认只扫描主生成文件。' },
        mode: { type: 'string', enum: ['report', 'behavioral-strict', 'exact'], description: '默认 report；behavioral-strict 有缺口即失败，exact 比较去注释且忽略字符串外空白后的文本。' },
        ignoreStrings: { type: 'array', items: { type: 'string' }, description: '已人工确认可忽略的参考源码字符串。' },
        ignoreIdentifiers: { type: 'array', items: { type: 'string' }, description: '已人工确认可忽略的调用或常量名。' },
        requiredPatterns: { type: 'array', items: {}, description: '生成端必须匹配的正则字符串，或 {label, pattern, flags} 对象。' },
        allowExternalPath: { type: 'boolean', description: '显式允许读取 Mixly 工作区外的文件，默认 false。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_create_library',
    title: '创建小型自定义积木库',
    description: '创建小型缺失积木库。Mixly 2/3 生成传统 ThirdParty 结构；Mixly 4 生成 OPFS 插件暂存目录，浏览器编译需要的非内置 C/C++ 文件必须同时放入 wasmSketchFiles，只有 extraFiles/libraries 不足以让 WASM 编译器参与链接。创建后应调用 mixly_project_workflow，由它自动打包、导入和验证。',
    inputSchema: {
      type: 'object',
      required: ['libraryName', 'board', 'blocksJs', 'generatorsJs', 'toolboxXml'],
      properties: {
        libraryName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{1,63}$' },
        board: { type: 'string', description: '环境探测返回的板卡 id、boardType、id@型号、唯一型号名或 FQBN。' },
        blocksJs: { type: 'string', description: '只定义小型底层能力，不得把完整 setup/loop 或业务流程做成一个块。' },
        generatorsJs: { type: 'string', description: '只生成该原语所需的最小表达式或语句。' },
        toolboxXml: { type: 'string', description: 'category/toolbox XML；标准布局会自动补 script/link 标签。' },
        primitiveReasons: { type: 'array', items: { type: 'object' }, description: '可选说明：{type, reason, officialCandidatesChecked:[...]}；缺少时只给提示，不阻止建库。' },
        layout: { type: 'string', enum: ['standard', 'flat'], description: '默认 standard；flat 仅兼容旧库。' },
        version: { type: 'string', description: 'config.json 版本，默认 1.0.0。' },
        xmlFileName: { type: 'string', pattern: '^[A-Za-z0-9_-]+\\.xml$' },
        extraFiles: { type: 'array', items: { type: 'object' }, description: '可选文件：{relativePath,text} 或 {relativePath,contentBase64}；仅允许 css/language/media/libraries/examples/README。' },
        wasmSketchFiles: { type: 'array', items: { type: 'object' }, description: 'Mixly 4 专用：随生成代码注入 WASM sketchFiles 的 C/C++ 源文件，格式为 {name,text} 或 {name,contentBase64}；支持 .h/.hpp/.c/.cc/.cpp。' },
        imageMode: { type: 'string', enum: ['none', 'block-icon', 'dropdown-options'], description: '默认 none；使用图片时建议说明是块图标还是图片选项。' },
        userRequestedImages: { type: 'boolean', description: '记录用户是否明确要求图片；不一致时 MCP 返回提示但不阻止。' },
        overwrite: { type: 'boolean', description: '目录存在时允许更新文件，默认 false。' }
      }
    },
    annotations: mayOverwrite
  },
  {
    name: 'mixly_build_project',
    title: '从结构树构建 Mixly 工程',
    description: '把结构化积木树直接序列化为 .mix，自动转义 XML、嵌套 next 链、连接全局变量声明并安排顶层布局。不要手写 .mix XML；大型树应写 JSON 后传 treePath。Harness 中的 Mixly 4 默认立即刷新当前 Blockly；最终仍必须调用 mixly_project_workflow。',
    inputSchema: {
      type: 'object', required: ['board', 'projectPath'],
      properties: {
        board: { type: 'string' },
        projectPath: { type: 'string', description: '工作区内 .mix 输出路径。' },
        treePath: { type: 'string', description: '工作区内 JSON 树文件；大型工程优先使用。' },
        tree: { type: 'object', description: '小型工程可直接传；与 treePath 二选一。' },
        sourcePath: { type: 'string', description: '可选原始源码路径，用于防黑盒组合度核对。' },
        sourceText: { type: 'string' },
        customPrefixes: { type: 'array', items: { type: 'string' } },
        requireChineseNames: { type: 'boolean', description: '默认 true；检查用户可见变量、函数和参数并给出中文命名提示，i/j 等循环下标除外。' },
        allowExternalSourcePath: { type: 'boolean' },
        overwrite: { type: 'boolean', description: '目标已存在时必须显式为 true。' },
        livePreview: { type: 'boolean', description: 'Mixly 4 Harness 默认 true：写入后立即载入当前 Blockly；显式 true 时预览失败会让工具失败。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535 },
        waitMs: { type: 'integer', minimum: 1000, maximum: 120000 }
      }
    },
    annotations: mayOverwrite
  },
  {
    name: 'mixly_save_project',
    title: '校验并写入 Mixly 工程',
    description: '兼容导入已有 projectXml 后原子写入 .mix。会拒绝未安装 type、游离/重复 next 和无效 XML；新工程不要手写 XML，应使用 mixly_build_project 的 tree/treePath。',
    inputSchema: {
      type: 'object', required: ['board', 'projectPath', 'projectXml'],
      properties: {
        board: { type: 'string' },
        projectPath: { type: 'string' },
        projectXml: { type: 'string' },
        sourcePath: { type: 'string' },
        sourceText: { type: 'string' },
        customPrefixes: { type: 'array', items: { type: 'string' } },
        requireChineseNames: { type: 'boolean', description: '默认 true；非中文名称只产生提示。绝不能翻译官方 type 或输入名。' },
        allowExternalSourcePath: { type: 'boolean' },
        overwrite: { type: 'boolean' },
        livePreview: { type: 'boolean', description: 'Mixly 4 Harness 默认 true：保存后立即载入当前 Blockly。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535 },
        waitMs: { type: 'integer', minimum: 1000, maximum: 120000 }
      }
    },
    annotations: mayOverwrite
  },
  {
    name: 'mixly_package_library',
    title: '打包 Mixly 积木库',
    description: '把小型第三方积木库打成兼容 ZIP。Mixly 2/3 保持传统 0 目录条目格式；Mixly 4 使用根部 plugin.json/index.xml/index.js，并为嵌套载荷保留必要父目录条目。通常无需单独调用，mixly_project_workflow 会自动打包工程引用的暂存插件。',
    inputSchema: {
      type: 'object', required: ['library'],
      properties: {
        library: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{1,63}$' },
        board: { type: 'string', description: '可省略；MCP 会从已安装库目录自动识别。' },
        outputPath: { type: 'string', description: '工作区内 ZIP 路径，默认 <library>_Mixly_Library.zip。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Mixly 4 OPFS 读取使用的 CDP 端口，默认 9333。' }
      }
    },
    annotations: writesLocal
  },
  {
    name: 'mixly_launch',
    title: '启动 Mixly 调试实例',
    description: '探测并启动当前 Mixly 运行时。Mixly 4 会优先使用安装目录内可提供 CDP 的 64 位 NW.js/SDK 运行时；只有 HTTP 而没有 CDP 不再误报为可用，因为那种实例无法自动导入、打开和点击 WASM 编译。',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', description: 'Mixly 4 建议传入目标板卡；启动后会自动进入板卡页并等待 Blockly/PluginManager 就绪。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' },
        profilePath: { type: 'string', description: '工作区内的隔离用户目录，默认 .mixly-mcp-profile。' },
        runtimeExecutable: { type: 'string', description: 'Mixly 4 可选 NW.js 可执行文件，必须位于 MIXLY_HOME 内；省略时优先发现本地 x64 SDK/运行时。' },
        waitMs: { type: 'integer', minimum: 1000, maximum: 120000, description: '默认 30000。' }
      }
    },
    annotations: writesLocal
  },
  {
    name: 'mixly_import_library',
    title: '真实导入 Mixly 库',
    description: '导入并刷新第三方积木库。Mixly 2/3 调用 Electron LibManager；Mixly 4 必须在已打开的可自动化窗口中调用 OPFS PluginManager，并立即挂载插件。项目交付优先调用 mixly_project_workflow 自动完成，不要只生成 ZIP 就停止。',
    inputSchema: {
      type: 'object', required: ['zipPath'],
      properties: {
        zipPath: { type: 'string' },
        libraryName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{1,63}$' },
        board: { type: 'string', description: '建议必传；MCP 会先进入目标板卡页，避免在 Mixly 首页调用导入 API 超时。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' }
      }
    },
    annotations: mayOverwrite
  },
  {
    name: 'mixly_open_project',
    title: '在 Mixly 中打开工程',
    description: '把调试实例导航到正确板卡并打开 .mix 工程。Mixly 4 使用 HTTP URL，并通过 EditorMix.setValue 载入 MCP 已读取的工程文本。',
    inputSchema: {
      type: 'object', required: ['projectPath', 'board'],
      properties: {
        projectPath: { type: 'string' },
        board: { type: 'string', description: '环境探测返回的板卡 id、boardType、id@型号、唯一型号名或 FQBN。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' },
        waitMs: { type: 'integer', minimum: 1000, maximum: 120000, description: '默认 30000。' }
      }
    },
    annotations: writesLocal
  },
  {
    name: 'mixly_validate_project',
    title: '验证 Mixly 工程',
    description: '在真实 Blockly 工作区加载 .mix。节点丢失或 Blockly 加载失败会报错；变量连接、孤立值块、重叠、命名和积木占比作为 warnings 返回，供 AI 主动优化。',
    inputSchema: {
      type: 'object', required: ['projectPath'],
      properties: {
        projectPath: { type: 'string' },
        customPrefixes: { type: 'array', items: { type: 'string' }, description: '自定义块类型前缀，例如 liftlight_。' },
        sourcePath: { type: 'string', description: '可选原始源码，用于识别少量黑盒块代替完整程序。' },
        sourceText: { type: 'string' },
        requireChineseNames: { type: 'boolean', description: '默认 true；非中文名称作为 warning 返回。' },
        allowExternalSourcePath: { type: 'boolean' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' }
      }
    },
    annotations: writesLocal
  },
  {
    name: 'mixly_generate_code',
    title: '从积木生成目标代码',
    description: '在真实 Mixly 中加载指定 .mix 并生成代码。Mixly 4 优先调用当前 EditorMix.getCode；工程文件和输出文件均由 MCP 进程读写。',
    inputSchema: {
      type: 'object', required: ['projectPath', 'outputPath'],
      properties: {
        projectPath: { type: 'string' },
        outputPath: { type: 'string', description: '工作区内输出路径，例如 .ino 或 .py。' },
        generator: { type: 'string', description: '可选 Blockly 生成器名称，例如 Arduino、Python；默认自动探测。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' }
      }
    },
    annotations: writesLocal
  },
  {
    name: 'mixly_project_workflow',
    title: '构建并验证 Mixly 工程',
    description: '最终交付必须调用。一次完成构建或复用已有 .mix、启动 Mixly、自动发现工程引用的暂存积木插件、打包并导入、打开工程、真实 Blockly 验证、代码生成；Mixly 4 C/C++ 默认还会点击可见桌面编译按钮并等待浏览器 WASM 结果。Arduino CLI 仅是可选兼容检查，绝不替代 WASM。',
    inputSchema: {
      type: 'object', required: ['board', 'projectPath'],
      properties: {
        board: { type: 'string' },
        projectPath: { type: 'string' },
        treePath: { type: 'string' },
        tree: { type: 'object' },
        outputPath: { type: 'string', description: '生成代码路径；默认与 .mix 同名，C/C++ 使用 .ino，其他板卡使用 .py。' },
        sourcePath: { type: 'string' },
        sourceText: { type: 'string' },
        customPrefixes: { type: 'array', items: { type: 'string' } },
        requireChineseNames: { type: 'boolean' },
        allowExternalSourcePath: { type: 'boolean' },
        overwrite: { type: 'boolean' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535 },
        profilePath: { type: 'string' },
        runtimeExecutable: { type: 'string', description: '传给 mixly_launch 的可选 Mixly 4 NW.js 运行时。' },
        waitMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        generator: { type: 'string' },
        autoImportLibraries: { type: 'boolean', description: 'Mixly 4 默认 true：按工程 block type 自动发现、打包并导入暂存插件。' },
        libraryNames: { type: 'array', items: { type: 'string' }, description: '可选强制导入的积木插件名；工程引用的暂存插件无需手工列出。' },
        libraryZipPaths: { type: 'array', items: { type: 'string' }, description: '可选已有插件 ZIP；工作流会在打开工程前导入。' },
        desktopCompile: { type: 'boolean', description: 'Mixly 4 C/C++ 默认 true：点击桌面编译按钮并等待真实 WASM 结果；设 false 才跳过。' },
        desktopCompileTimeoutMs: { type: 'integer', minimum: 1000, maximum: 900000, description: '桌面 WASM 编译超时，默认 300000 毫秒。' },
        equivalenceMode: { type: 'string', enum: ['report', 'behavioral-strict', 'exact'], description: '传入参考源码时默认 report；严格交付可使用 behavioral-strict 或 exact。' },
        equivalenceSupportPaths: { type: 'array', items: { type: 'string' }, description: '生成端自定义库或辅助实现源码文件。' },
        equivalenceRequiredPatterns: { type: 'array', items: {}, description: '生成端必须保留的关键业务正则。' },
        equivalenceIncludeSupportInRequiredPatterns: { type: 'boolean', description: '显式允许等价性 requiredPatterns 扫描辅助源码；默认只扫描主生成代码。' },
        equivalenceIgnoreStrings: { type: 'array', items: { type: 'string' } },
        equivalenceIgnoreIdentifiers: { type: 'array', items: { type: 'string' } },
        compile: { type: 'boolean', description: '额外调用 arduino-cli 做生成代码兼容检查；Mixly 4 的最终结果以 desktopCompile 的 WASM 输出为准。' },
        fqbn: { type: 'string' },
        fqbns: { type: 'array', items: { type: 'string' } },
        arduinoCliPath: { type: 'string' },
        arduinoCliConfigPath: { type: 'string', description: '可选 arduino-cli 配置文件；内置 CLI 默认自动使用相邻配置。' },
        librariesPath: { type: 'string' },
        librariesPaths: { type: 'array', items: { type: 'string' }, description: '额外 Arduino 库目录列表；可与向后兼容的 librariesPath 同时使用。' },
        mixlyLibraries: { type: 'array', items: { type: 'string' }, description: '当前板卡 ThirdParty 库名称；自动加入各库的 libraries 目录。' },
        compileTimeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
        keepBuild: { type: 'boolean' }
      }
    },
    annotations: mayOverwrite
  },
  {
    name: 'mixly_compile',
    title: 'Arduino CLI 兼容编译',
    description: '使用用户本机的 arduino-cli 对 .ino 做兼容编译。Mixly 4 桌面端实际使用浏览器 WASM 编译器及独立库包，因此此工具不能冒充桌面 WASM 实测；AI 必须根据环境探测和目标板明确传入 fqbn 或 fqbns。',
    inputSchema: {
      type: 'object', required: ['sketchPath'],
      properties: {
        sketchPath: { type: 'string' },
        fqbn: { type: 'string' },
        fqbns: { type: 'array', items: { type: 'string' }, description: '需要连续验证多个板卡配置时使用。' },
        arduinoCliPath: { type: 'string', description: 'AI 探测到的 arduino-cli 路径；省略时 MCP 从环境变量、Mixly 目录和 PATH 查找。' },
        arduinoCliConfigPath: { type: 'string', description: '可选 arduino-cli 配置文件；内置 CLI 默认自动使用相邻的 arduino-cli.json/yaml，避免误读全局核心。' },
        librariesPath: { type: 'string', description: '单个 Arduino 库目录；为向后兼容保留。' },
        librariesPaths: { type: 'array', items: { type: 'string' }, description: '多个 Arduino 库目录；与 librariesPath 合并、去重后逐个传给 arduino-cli。' },
        board: { type: 'string', description: 'Mixly 板卡 id、boardType、profile 或 FQBN；与 mixlyLibraries 一起使用。' },
        mixlyLibraries: { type: 'array', items: { type: 'string' }, description: 'Mixly ThirdParty 库名称；自动加入当前板卡 ThirdParty/<name>/libraries。' },
        allowExternalPath: { type: 'boolean', description: '显式允许工作区外 sketch/libraries 路径，默认 false。' },
        keepBuild: { type: 'boolean', description: '保留临时构建目录，默认 false。' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000, description: '单个 FQBN 的编译超时；默认 900000 毫秒，ESP32 首次构建可按需增加。' },
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: 'Mixly 4 OPFS Arduino 库物化使用的 CDP 端口，默认 9333。' }
      }
    },
    annotations: writesLocal
  }
];

// Harness defaults to a compact, workflow-oriented surface. The remaining
// tools stay callable over MCP for compatibility, but their schemas are not
// sent to the model unless the full surface is explicitly requested.
const compactToolNames = new Set([
  'mixly_detect_environment',
  'mixly_get_board_profiles',
  'mixly_scan_library',
  'mixly_get_block_specs',
  'mixly_inspect_library',
  'mixly_analyze_source',
  'mixly_create_library',
  'mixly_build_project',
  'mixly_project_workflow'
]);

function listedToolDefinitions() {
  return process.env.MIXLY_MCP_TOOL_MODE === 'compact'
    ? toolDefinitions.filter((tool) => compactToolNames.has(tool.name))
    : toolDefinitions;
}

function fail(message, details) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function ensureInsideWorkspace(filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`路径不在 Mixly 工作区内: ${resolved}`);
  }
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  if (fs.existsSync(existing)) {
    const realRoot = fs.realpathSync.native(ROOT);
    const realExisting = fs.realpathSync.native(existing);
    const realRelative = path.relative(realRoot, realExisting);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      fail(`路径通过符号链接或联接点离开 Mixly 工作区: ${resolved}`, {
        resolvedPath: resolved,
        realExistingPath: realExisting
      });
    }
  }
  return resolved;
}

function resolveInputPath(filePath, allowExternalPath = false) {
  if (!filePath) fail('缺少文件路径');
  return allowExternalPath ? path.resolve(filePath) : ensureInsideWorkspace(filePath);
}

function stripUtf8Bom(text) {
  return String(text).replace(/^\uFEFF/, '');
}

let boardCatalogCache = null;

function inferBoardLanguage(id) {
  if (/micropython/i.test(id)) return 'MicroPython';
  if (/(^|\/)python/i.test(id)) return 'Python';
  return 'C/C++';
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const source = fs.readFileSync(filePath, 'utf8');
  let normalized = '';
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') { lineComment = false; normalized += character; }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"') { quote = character; normalized += character; continue; }
    if (character === '/' && next === '/') { lineComment = true; index++; continue; }
    if (character === '/' && next === '*') { blockComment = true; index++; continue; }
    normalized += character;
  }
  try { return JSON.parse(normalized.replace(/^\uFEFF/, '')); } catch (_) { return null; }
}

function boardProfileTable(boardRoot, includeOptions = false) {
  const configPath = path.join(boardRoot, 'config.json');
  const config = readJsonFile(configPath);
  let table = config && config.board;
  if (typeof table === 'string') table = readJsonFile(path.resolve(path.dirname(configPath), table));
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    table = readJsonFile(path.join(boardRoot, 'boards.json'));
  }
  if (!table || typeof table !== 'object' || Array.isArray(table)) return [];
  return Object.entries(table).map(([name, raw]) => {
    const value = typeof raw === 'string' ? { key: raw } : (raw && typeof raw === 'object' ? raw : {});
    const xmlPath = value.xmlPath ? path.resolve(boardRoot, value.xmlPath) : null;
    const configuration = Array.isArray(value.config)
      ? value.config.map((item) => {
        if (!item || typeof item !== 'object' || !item.key) return null;
        return {
          key: String(item.key),
          label: item.label == null ? null : String(item.label),
          options: Array.isArray(item.options) ? item.options.map((option) => {
            if (typeof option === 'string') return { key: option, label: option };
            if (!option || typeof option !== 'object' || option.key == null) return null;
            return {
              key: String(option.key),
              label: option.label == null ? null : String(option.label)
            };
          }).filter(Boolean) : []
        };
      }).filter(Boolean)
      : [];
    const profile = {
      name,
      fqbn: value.key || value.fqbn || null,
      group: value.group || null,
      xmlPath: xmlPath && path.relative(boardRoot, xmlPath).replace(/\\/g, '/'),
      configurationKeys: configuration.map((item) => item.key)
    };
    if (includeOptions) profile.configuration = configuration;
    return profile;
  }).filter((profile) => profile.name || profile.fqbn);
}

function boardWithProfile(board, profile) {
  if (!profile) return board;
  return {
    ...board,
    selectedProfile: profile.name,
    fqbn: profile.fqbn,
    xmlPath: profile.xmlPath || board.xmlPath || null
  };
}

function matchingProfile(board, selector) {
  if (!selector || !Array.isArray(board.profiles)) return null;
  const normalized = String(selector).trim().toLowerCase();
  return board.profiles.find((profile) =>
    String(profile.name || '').toLowerCase() === normalized ||
    String(profile.fqbn || '').toLowerCase() === normalized
  ) || null;
}

function getBoardProfiles(args) {
  const selected = getBoard(args.board);
  const profiles = boardProfileTable(selected.root, true);
  const board = { ...selected };
  delete board.profiles;
  return {
    board,
    profileCount: profiles.length,
    profiles,
    usageHint: 'fqbn 是本机板卡元数据提供的基础值；configuration 列出可追加的 key=value 选项。根据用户真实型号选择，编译前再核对已安装 core，不能把任一型号当成全局默认值。'
  };
}

function getBoardCatalog() {
  if (boardCatalogCache) return boardCatalogCache;
  const srcRoot = APP_SRC_ROOT;
  const knownPath = path.join(srcRoot, 'boards.json');
  const knownData = readJsonFile(knownPath);
  const knownBoards = Array.isArray(knownData) ? knownData : [];
  const knownByIndex = new Map(knownBoards.map((board) => [
    String(board.boardIndex || '').replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase(), board
  ]));
  const isTemplate = (id) => MIXLY_LAYOUT.generation === 4 &&
    /^default\/(?:arduino|micropython|python)$/i.test(String(id || '').replace(/\\/g, '/'));
  const normalizeIndexPath = (boardIndex) => {
    if (!boardIndex) return null;
    const normalized = String(boardIndex).replace(/\\/g, '/').replace(/^\.\//, '');
    const candidate = path.resolve(srcRoot, normalized);
    const relative = path.relative(BOARDS_DIR, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return candidate;
  };
  let indexFiles;
  if (MIXLY_LAYOUT.generation === 4 && knownBoards.length) {
    // Mixly 4's boards.json contains the user-facing board list. Keep its
    // order and metadata, then append any physically present unlisted board.
    indexFiles = knownBoards
      .map((board) => normalizeIndexPath(board.boardIndex))
      .filter(Boolean)
      .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
      .filter((filePath) => !isTemplate(path.dirname(path.relative(BOARDS_DIR, filePath)).replace(/\\/g, '/')));
    const knownPaths = new Set(indexFiles.map((filePath) => path.resolve(filePath).toLowerCase()));
    const orphanFiles = filesRecursive(BOARDS_DIR, 'index.xml')
      .filter((filePath) => !/[\\/]libraries[\\/]/i.test(path.relative(BOARDS_DIR, filePath)))
      .filter((filePath) => !isTemplate(path.dirname(path.relative(BOARDS_DIR, filePath)).replace(/\\/g, '/')))
      .filter((filePath) => !knownPaths.has(path.resolve(filePath).toLowerCase()));
    indexFiles = [...indexFiles, ...orphanFiles];
  } else {
    indexFiles = filesRecursive(BOARDS_DIR, 'index.xml')
      .filter((filePath) => !/[\\/]libraries[\\/]/i.test(path.relative(BOARDS_DIR, filePath)))
      .filter((filePath) => !isTemplate(path.dirname(path.relative(BOARDS_DIR, filePath)).replace(/\\/g, '/')));
  }
  boardCatalogCache = indexFiles.map((indexPath) => {
    const relativeIndex = path.relative(srcRoot, indexPath).replace(/\\/g, '/');
    const id = path.dirname(path.relative(BOARDS_DIR, indexPath)).replace(/\\/g, '/');
    const known = knownByIndex.get(relativeIndex.toLowerCase()) || {};
    let boardImg = known.boardImg || '';
    if (!boardImg) {
      const mediaFiles = filesRecursive(path.join(path.dirname(indexPath), 'media'))
        .filter((file) => /\.(?:png|jpe?g|webp)$/i.test(file));
      if (mediaFiles.length) {
        boardImg = `./${path.relative(srcRoot, mediaFiles[0]).replace(/\\/g, '/')}`;
      }
    }
    return {
      id,
      root: path.dirname(indexPath),
      thirdParty: id.startsWith('extend/'),
      boardIndex: `./${relativeIndex}`,
      boardType: known.boardType || path.basename(path.dirname(indexPath)),
      boardImg,
      language: known.language || inferBoardLanguage(id),
      env: known.env || null,
      xmlPath: known.xmlPath || null,
      profiles: boardProfileTable(path.dirname(indexPath))
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return boardCatalogCache;
}

function boardCatalogDiagnostics() {
  const srcRoot = APP_SRC_ROOT;
  const knownPath = path.join(srcRoot, 'boards.json');
  const knownData = readJsonFile(knownPath);
  const knownBoards = Array.isArray(knownData) ? knownData : [];
  const isTemplate = (value) => /^default\/(?:arduino|micropython|python)$/i.test(String(value || '').replace(/\\/g, '/'));
  const normalize = (value) => {
    if (!value) return null;
    const candidate = path.resolve(srcRoot, String(value).replace(/\\/g, '/').replace(/^\.\//, ''));
    const relative = path.relative(BOARDS_DIR, candidate);
    return relative.startsWith('..') || path.isAbsolute(relative) ? null : candidate;
  };
  const indexed = knownBoards.map((raw) => {
    const indexPath = normalize(raw && raw.boardIndex);
    const id = indexPath
      ? path.dirname(path.relative(BOARDS_DIR, indexPath)).replace(/\\/g, '/')
      : String(raw && raw.boardIndex || '').replace(/^\.\//, '').replace(/\/index\.xml$/i, '');
    return {
      id,
      boardType: raw && raw.boardType || null,
      boardIndex: raw && raw.boardIndex || null,
      template: isTemplate(id),
      present: Boolean(indexPath && fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()),
      path: indexPath
    };
  });
  const physical = filesRecursive(BOARDS_DIR, 'index.xml')
    .filter((filePath) => !/[\\/]libraries[\\/]/i.test(path.relative(BOARDS_DIR, filePath)))
    .map((filePath) => path.dirname(path.relative(BOARDS_DIR, filePath)).replace(/\\/g, '/'));
  const knownIds = new Set(indexed.map((item) => item.id.toLowerCase()));
  const orphan = physical.filter((id) => !knownIds.has(id.toLowerCase()) && !isTemplate(id)).sort();
  return {
    indexedCount: indexed.length,
    availableCount: indexed.filter((item) => item.present && !item.template).length,
    missing: indexed.filter((item) => !item.present && !item.template),
    filteredTemplates: indexed.filter((item) => item.template),
    orphanInstalled: orphan,
    source: knownBoards.length ? 'boards.json+filesystem' : 'filesystem'
  };
}

function getBoard(selector) {
  if (!selector) fail('需要指定板卡；请先调用 mixly_detect_environment 获取 boards 列表');
  const rawSelector = String(selector).trim();
  const separator = rawSelector.indexOf('@');
  const familySelector = separator > 0 ? rawSelector.slice(0, separator).trim() : rawSelector;
  const profileSelector = separator > 0 ? rawSelector.slice(separator + 1).trim() : null;
  const normalized = familySelector.toLowerCase();
  const catalog = getBoardCatalog();
  const exact = catalog.find((board) =>
    board.id.toLowerCase() === normalized ||
    board.boardType.toLowerCase() === normalized ||
    board.boardIndex.toLowerCase() === normalized
  );
  if (exact) {
    if (!profileSelector) return exact;
    const profile = matchingProfile(exact, profileSelector);
    if (!profile) fail(`Board profile not found: ${profileSelector}`, {
      availableProfiles: exact.profiles.map((item) => item.name)
    });
    return boardWithProfile(exact, profile);
  }
  if (!profileSelector) {
    const profileMatches = catalog
      .map((board) => ({ board, profile: matchingProfile(board, familySelector) }))
      .filter((item) => item.profile);
    if (profileMatches.length === 1) return boardWithProfile(profileMatches[0].board, profileMatches[0].profile);
    if (profileMatches.length > 1) {
      fail(`Board profile is ambiguous; use board@profile: ${profileMatches.map((item) => `${item.board.id}@${item.profile.name}`).join(', ')}`);
    }
  }
  const byDirectory = catalog.filter((board) => path.basename(board.root).toLowerCase() === normalized);
  if (byDirectory.length === 1) return byDirectory[0];
  if (byDirectory.length > 1) {
    fail(`板卡目录名不唯一，请使用完整 id: ${byDirectory.map((board) => board.id).join(', ')}`);
  }
  fail(`未安装板卡: ${selector}`, { availableBoardIds: catalog.map((board) => board.id) });
}

function getCdpPort(args) {
  return Number(args.cdpPort || process.env.MIXLY_CDP_PORT || DEFAULT_CDP_PORT);
}

function unique(values) {
  return [...new Set(values)];
}

function readDiscoveryCache(cache, key, refresh) {
  if (refresh === true) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  const ageMs = Date.now() - entry.createdAt;
  if (ageMs >= DISCOVERY_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { value: entry.value, ageMs };
}

function writeDiscoveryCache(cache, key, value) {
  cache.set(key, { value, createdAt: Date.now() });
  return value;
}

function invalidateDiscoveryCaches() {
  libraryScanCache.clear();
  blockSpecsCache.clear();
}

function filesRecursive(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesRecursive(full, suffix));
    else if (!suffix || entry.name.endsWith(suffix)) result.push(full);
  }
  return result;
}

const tarManifestCache = new Map();

function tarHeaderString(header, start, length) {
  const end = header.indexOf(0, start);
  return header.toString('utf8', start, end < 0 ? start + length : end).trim();
}

function tarHeaderNumber(header, start, length) {
  const value = tarHeaderString(header, start, length).replace(/\0/g, '').trim();
  if (!value) return 0;
  const parsed = Number.parseInt(value, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Read one small JSON entry without unpacking the 100+ MB compiler archive.
function readTarEntry(tarPath, targetName) {
  if (!fs.existsSync(tarPath) || !fs.statSync(tarPath).isFile()) return null;
  const wanted = String(targetName).replace(/\\/g, '/').replace(/^\.\//, '');
  const descriptor = fs.openSync(tarPath, 'r');
  try {
    const header = Buffer.alloc(512);
    let offset = 0;
    const total = fs.statSync(tarPath).size;
    while (offset + 512 <= total) {
      const read = fs.readSync(descriptor, header, 0, 512, offset);
      if (read !== 512 || header.every((byte) => byte === 0)) break;
      let name = tarHeaderString(header, 0, 100);
      const prefix = tarHeaderString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
      name = name.replace(/\\/g, '/').replace(/^\.\//, '');
      const size = tarHeaderNumber(header, 124, 12);
      const type = String.fromCharCode(header[156] || 0);
      const dataOffset = offset + 512;
      if ((name === wanted || name.endsWith(`/${wanted}`)) && (!type || type === '0')) {
        if (size > 64 * 1024 * 1024) return null;
        const data = Buffer.alloc(size);
        if (size) fs.readSync(descriptor, data, 0, size, dataOffset);
        return data;
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return null;
}

function readTarJson(tarPath, targetName) {
  const stat = fs.existsSync(tarPath) ? fs.statSync(tarPath) : null;
  if (!stat || !stat.isFile()) return null;
  const cacheKey = `${tarPath}:${stat.size}:${stat.mtimeMs}:${targetName}`;
  if (tarManifestCache.has(cacheKey)) return tarManifestCache.get(cacheKey);
  const entry = readTarEntry(tarPath, targetName);
  if (!entry) return null;
  try {
    const value = JSON.parse(stripUtf8Bom(entry.toString('utf8')));
    tarManifestCache.set(cacheKey, value);
    return value;
  } catch (_) {
    tarManifestCache.set(cacheKey, null);
    return null;
  }
}

function mixly4WasmArchives() {
  if (!fs.existsSync(MIXLY4_WASM_DIR) || !fs.statSync(MIXLY4_WASM_DIR).isDirectory()) return [];
  return fs.readdirSync(MIXLY4_WASM_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tar$/i.test(entry.name))
    .map((entry) => {
      const libraryMatch = /^(.+)-libraries_[^.]+\.tar$/i.exec(entry.name);
      const compilerMatch = /^(.+?)wasm_[^.]+\.tar$/i.exec(entry.name);
      const platform = libraryMatch
        ? libraryMatch[1].toLowerCase()
        : (compilerMatch ? compilerMatch[1].toLowerCase() : null);
      const archivePath = path.join(MIXLY4_WASM_DIR, entry.name);
      const manifest = libraryMatch
        ? readTarJson(archivePath, 'libraries.manifest.json')
        : null;
      return {
        platform,
        kind: libraryMatch ? 'libraries' : (compilerMatch ? 'compiler' : 'other'),
        archive: archivePath,
        archiveName: entry.name,
        manifest
      };
    });
}

function wasmPlatformForBoard(board) {
  const value = [board && board.id, board && board.boardType, board && board.fqbn]
    .filter(Boolean).join(' ').toLowerCase();
  if (/arduino[_/]?avr|arduino:avr|\bavr\b/.test(value)) return 'avr';
  if (/arduino[_/]?esp32|esp32:|\besp32\b/.test(value)) return 'esp32';
  if (/arduino[_/]?esp8266|esp8266:|\besp8266\b/.test(value)) return 'esp8266';
  return null;
}

function isArduinoBoard(board) {
  if (!board) return false;
  if (board.language && !/c\/c\+\+/i.test(String(board.language))) return false;
  return Boolean(wasmPlatformForBoard(board)) || /arduino/i.test(`${board.id || ''} ${board.boardType || ''}`) ||
    String(board.fqbn || '').includes(':');
}

function manifestLibraryEntries(manifest, archivePath, platform) {
  if (!manifest) return [];
  const source = Array.isArray(manifest) ? manifest : (manifest.libraries || manifest);
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).map(([key, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const files = Array.isArray(raw.files) ? raw.files.map(String) : [];
    const includes = Array.isArray(raw.includes) ? raw.includes.map(String) : [];
    const headers = unique([
      ...files.filter((file) => /\.(?:h|hh|hpp|hxx)$/i.test(file)).map((file) => path.basename(file)),
      ...includes.filter((file) => /\.(?:h|hh|hpp|hxx)$/i.test(file)).map((file) => path.basename(file))
    ]).sort();
    return {
      name: String(key || raw.name || raw.libraryName || '').trim(),
      displayName: raw.displayName == null ? null : String(raw.displayName),
      version: raw.version == null ? null : String(raw.version),
      platform,
      source: 'mixly4-wasm',
      archive: archivePath,
      include: raw.include == null ? null : String(raw.include),
      includes,
      headers,
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : [],
      files,
      fileCount: files.length
    };
  }).filter((entry) => entry && entry.name).sort((left, right) => left.name.localeCompare(right.name));
}

function parseLibraryProperties(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return {};
  const result = {};
  for (const line of stripUtf8Bom(fs.readFileSync(filePath, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*([^#=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) result[match[1].trim()] = match[2];
  }
  return result;
}

function filesystemArduinoLibraries(board) {
  const roots = [{ path: DEFAULT_LIB_ROOT, source: 'arduino-cli' }];
  const thirdPartyRoot = board && board.root
    ? path.join(board.root, 'libraries', 'ThirdParty')
    : null;
  if (thirdPartyRoot && fs.existsSync(thirdPartyRoot)) {
    for (const entry of fs.readdirSync(thirdPartyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(thirdPartyRoot, entry.name, 'libraries');
      if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
        roots.push({ path: nested, source: `ThirdParty/${entry.name}` });
      }
    }
  }
  const result = [];
  const seen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root.path) || !fs.statSync(root.path).isDirectory()) continue;
    for (const entry of fs.readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const libraryPath = path.join(root.path, entry.name);
      const files = filesRecursive(libraryPath).filter((file) => fs.statSync(file).isFile());
      if (!files.length) continue;
      const properties = parseLibraryProperties(path.join(libraryPath, 'library.properties'));
      const headers = files.filter((file) => /\.(?:h|hh|hpp|hxx)$/i.test(file))
        .map((file) => path.basename(file)).sort();
      const key = `${root.source}:${entry.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        name: properties.name || entry.name,
        displayName: properties.name || entry.name,
        version: properties.version || null,
        platform: wasmPlatformForBoard(board),
        source: root.source,
        path: libraryPath,
        headers: unique(headers),
        dependencies: properties.depends ? properties.depends.split(',').map((value) => value.trim()).filter(Boolean) : [],
        files: files.map((file) => path.relative(libraryPath, file).replace(/\\/g, '/')).sort(),
        fileCount: files.length
      });
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function scanArduinoLibraries(args) {
  const board = getBoard(args.board);
  if (!isArduinoBoard(board)) {
    return {
      board: board.id,
      boardProfile: board.selectedProfile || null,
      fqbn: board.fqbn || null,
      layout: mixlyLayoutSummary(),
      platform: null,
      source: 'unsupported-board',
      archive: null,
      libraryCount: 0,
      libraries: [],
      reason: '当前板卡不是 Arduino C/C++ 板卡，没有可关联的 Arduino 库清单。'
    };
  }
  const platform = wasmPlatformForBoard(board);
  const archives = mixly4WasmArchives();
  const archive = MIXLY_LAYOUT.generation === 4
    ? archives.find((item) => item.kind === 'libraries' && item.platform === platform)
    : null;
  let libraries = archive
    ? manifestLibraryEntries(archive.manifest, archive.archive, platform)
    : filesystemArduinoLibraries(board);
  const names = Array.isArray(args.libraryNames)
    ? args.libraryNames.map((value) => String(value).toLowerCase()).filter(Boolean)
    : [];
  const headers = Array.isArray(args.headers)
    ? args.headers.map((value) => path.basename(String(value).toLowerCase())).filter(Boolean)
    : [];
  if (names.length) {
    libraries = libraries.filter((library) => names.some((name) =>
      library.name.toLowerCase() === name || String(library.displayName || '').toLowerCase() === name));
  }
  if (headers.length) {
    libraries = libraries.filter((library) => headers.some((header) =>
      library.headers.some((candidate) => candidate.toLowerCase() === header)));
  }
  if (args.includeFiles !== true) {
    libraries = libraries.map(({ files, path: libraryPath, ...library }) => ({
      ...library,
      path: libraryPath || null,
      files: undefined
    })).map((library) => {
      delete library.files;
      return library;
    });
  }
  return {
    board: board.id,
    boardProfile: board.selectedProfile || null,
    fqbn: board.fqbn || null,
    layout: mixlyLayoutSummary(),
    platform,
    source: archive ? 'mixly4-wasm' : 'filesystem',
    archive: archive ? archive.archive : null,
    libraryCount: libraries.length,
    libraries
  };
}

function moduleExportTypes(source) {
  return unique([...source.matchAll(/(?:^|[;\r\n])\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]));
}

function registryEntries(body) {
  const entries = [];
  for (const match of String(body).matchAll(
    /(?:^|,)(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:\s*(?:\(\)\s*=>\s*)?([A-Za-z_$][\w$]*)/g
  )) {
    const type = match[1] || match[2];
    if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(type)) entries.push([type, match[3]]);
  }
  return entries;
}

function matchingBraceIndex(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index++; continue; }
    if (character === '/' && next === '*') { blockComment = true; index++; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

function topLevelObjectRanges(source, start, end) {
  const ranges = [];
  let rangeStart = start;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < end; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') { lineComment = true; index++; continue; }
    if (character === '/' && next === '*') { blockComment = true; index++; continue; }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') braces++;
    else if (character === '}') braces--;
    else if (character === '[') brackets++;
    else if (character === ']') brackets--;
    else if (character === '(') parentheses++;
    else if (character === ')') parentheses--;
    else if (character === ',' && braces === 0 && brackets === 0 && parentheses === 0) {
      ranges.push([rangeStart, index]);
      rangeStart = index + 1;
    }
  }
  ranges.push([rangeStart, end]);
  return ranges;
}

function directRegistryEntries(source, objectName, beforeIndex = source.length) {
  const escapedName = escapeRegExp(objectName);
  const pattern = new RegExp(`(?:\\b(?:var|let|const)\\s+|[,;]\\s*)?${escapedName}\\s*=\\s*\\{`, 'g');
  let best = [];
  for (const match of source.matchAll(pattern)) {
    if (match.index >= beforeIndex) break;
    const openIndex = match.index + match[0].lastIndexOf('{');
    const closeIndex = matchingBraceIndex(source, openIndex);
    if (closeIndex < 0 || closeIndex > beforeIndex) continue;
    const entries = [];
    for (const [start, end] of topLevelObjectRanges(source, openIndex + 1, closeIndex)) {
      const property = source.slice(start, end);
      const keyed = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:\s*/.exec(property);
      if (keyed) {
        const type = keyed[1] || keyed[2] || keyed[3];
        if (!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(type)) continue;
        const valueOffset = start + keyed[0].length;
        const value = source.slice(valueOffset, end).trim();
        const alias = /^(?:\(\)\s*=>\s*)?([A-Za-z_$][\w$]*)\s*$/.exec(value);
        entries.push([type, alias ? alias[1] : null, alias ? null : valueOffset, alias ? null : end]);
        continue;
      }
      const method = /^\s*(?:async\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*\(/.exec(property);
      if (method) {
        const type = method[1] || method[2] || method[3];
        if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(type)) entries.push([type, null, start + method.index, end]);
        continue;
      }
      const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(property);
      if (shorthand) entries.push([shorthand[1], shorthand[1], null]);
    }
    if (entries.length > best.length) best = entries;
  }
  return best;
}

function bundleRegistry(source) {
  const exported = new Map();
  const exportPattern = /[A-Za-z_$][\w$]*\.d\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{([^{}]{1,200000})\}\s*\)/g;
  for (const match of source.matchAll(exportPattern)) {
    exported.set(match[1], registryEntries(match[2]));
  }
  const blocks = new Map();
  const generators = new Map();
  const assignment = /Object\.assign\(\s*([^,()]*(?:\.Blocks|\.forBlock))\s*,([^()]*)\)/g;
  for (const match of source.matchAll(assignment)) {
    const destination = /\.Blocks\s*$/.test(match[1]) ? blocks : generators;
    const objectNames = match[2].split(',').map((item) => item.trim())
      .filter((item) => /^[A-Za-z_$][\w$]*$/.test(item));
    for (const objectName of objectNames) {
      const entries = exported.get(objectName) || directRegistryEntries(source, objectName, match.index);
      for (const [type, symbol, inlineIndex, inlineEnd] of entries) {
        destination.set(type, { type, symbol, inlineIndex, inlineEnd, objectName, assignmentIndex: match.index });
      }
    }
  }
  return { blocks, generators };
}

function toolboxBlockTypes(source) {
  return unique([...source.matchAll(/<block\b[^>]*>/gi)]
    .map((match) => markupAttributes(match[0]).type)
    .filter(Boolean));
}

function extractBlockTypes(source) {
  const registry = bundleRegistry(source);
  if (registry.blocks.size) return [...registry.blocks.keys()];
  return unique([
    ...[...source.matchAll(
      /Blockly\.Blocks(?:\[['"]([^'"\]]+)['"]\]|\.([A-Za-z0-9_]+))\s*=\s*/g
    )].map((match) => match[1] || match[2]),
    ...[...source.matchAll(/["']type["']\s*:\s*["']([A-Za-z][A-Za-z0-9_-]+)["']/g)].map((match) => match[1]),
    ...[...source.matchAll(/(?:statementBlock|valueBlock|outputBlock|defineBlock)\(\s*["']([A-Za-z][A-Za-z0-9_-]+)["']/g)].map((match) => match[1]),
    ...moduleExportTypes(source),
    ...registry.blocks.keys()
  ]);
}

function extractGeneratorTypes(source) {
  const registry = bundleRegistry(source);
  if (registry.generators.size) return [...registry.generators.keys()];
  return unique([
    ...[...source.matchAll(
      /(?:Blockly\.[A-Za-z0-9_]+\.)?forBlock(?:\[['"]([^'"\]]+)['"]\]|\.([A-Za-z0-9_]+))\s*=\s*/g
    )].map((match) => match[1] || match[2]),
    ...[...source.matchAll(
      /Blockly\.(?:Arduino|Python|MicroPython)(?:\[['"]([^'"\]]+)['"]\]|\.([A-Za-z0-9_]+))\s*=\s*function/g
    )].map((match) => match[1] || match[2]),
    ...[...source.matchAll(/register\(\s*["']([A-Za-z][A-Za-z0-9_-]+)["']/g)].map((match) => match[1]),
    ...moduleExportTypes(source),
    ...registry.generators.keys()
  ]);
}

const NON_BLOCK_MODULE_EXPORTS = new Set([
  'blocks',
  'generators',
  'languages',
  'blockDefinitions'
]);

function extractLibraryBlockTypes(source) {
  return extractBlockTypes(source).filter((type) => !NON_BLOCK_MODULE_EXPORTS.has(type));
}

function extractLibraryGeneratorTypes(source) {
  return extractGeneratorTypes(source).filter((type) => !NON_BLOCK_MODULE_EXPORTS.has(type));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativeToRoot(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

const analyzedSourceCache = new Map();
const ANALYZED_SOURCE_CACHE_LIMIT = 24;

function analyzedSourceFile(filePath) {
  const stats = fs.statSync(filePath);
  const signature = `${stats.size}:${stats.mtimeMs}`;
  const cached = analyzedSourceCache.get(filePath);
  if (cached && cached.signature === signature) {
    analyzedSourceCache.delete(filePath);
    analyzedSourceCache.set(filePath, cached);
    return cached;
  }
  const source = fs.readFileSync(filePath, 'utf8');
  const result = { signature, source, registry: bundleRegistry(source) };
  analyzedSourceCache.delete(filePath);
  analyzedSourceCache.set(filePath, result);
  while (analyzedSourceCache.size > ANALYZED_SOURCE_CACHE_LIMIT) {
    analyzedSourceCache.delete(analyzedSourceCache.keys().next().value);
  }
  return result;
}

function symbolAssignment(source, symbol) {
  const escaped = escapeRegExp(symbol);
  const pattern = new RegExp(`(?:^|[,;{}\\n])\\s*(?:(?:export\\s+)?(?:var|let|const)\\s+)?${escaped}\\s*=\\s*`, 'g');
  const match = pattern.exec(source);
  if (!match) return null;
  const rhsStart = match.index + match[0].length;
  const rhs = /^([A-Za-z_$][\w$]*)/.exec(source.slice(rhsStart));
  return { index: match.index, rhsStart, alias: rhs ? rhs[1] : null };
}

function resolveAssignedSymbol(source, symbol) {
  let current = symbol;
  const visited = new Set();
  let assignment = null;
  while (current && !visited.has(current) && visited.size < 12) {
    visited.add(current);
    assignment = symbolAssignment(source, current);
    if (!assignment || !assignment.alias || assignment.alias === current) break;
    const rhs = source.slice(assignment.rhsStart);
    if (/^(?:async\s+)?function\b|^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\{/.test(rhs)) break;
    current = assignment.alias;
  }
  return { symbol: current, assignment };
}

function displayedSourcePath(filePath, displayRoot, displayPrefix) {
  if (displayRoot && displayPrefix) {
    const relative = path.relative(displayRoot, filePath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `${displayPrefix}/${relative.replace(/\\/g, '/')}`;
    }
  }
  return relativeToRoot(filePath);
}

function sourceLocation(files, blockType, kind, includeSource, displayRoot = null, displayPrefix = null) {
  const escaped = escapeRegExp(blockType);
  const patterns = kind === 'block'
    ? [
        new RegExp(`Blockly\\.Blocks(?:\\[['"]${escaped}['"]\\]|\\.${escaped})\\s*=`),
        new RegExp(`['"]type['"]\\s*:\\s*['"]${escaped}['"]`),
        new RegExp(`\\bexport\\s+(?:const|let|var|function|class)\\s+${escaped}\\b`),
        new RegExp(`(?:^|[,{}])(?:['"]${escaped}['"]|${escaped})\\s*:\\s*\\(\\)\\s*=>`)
      ]
    : [
        new RegExp(`forBlock(?:\\[['"]${escaped}['"]\\]|\\.${escaped})\\s*=`),
        new RegExp(`Blockly\\.(?:Arduino|Python|MicroPython)(?:\\[['"]${escaped}['"]\\]|\\.${escaped})\\s*=`),
        new RegExp(`\\bregister\\(\\s*['"]${escaped}['"]\\s*,`),
        new RegExp(`\\bexport\\s+(?:const|let|var|function|class)\\s+${escaped}\\b`),
        new RegExp(`(?:^|[,{}])(?:['"]${escaped}['"]|${escaped})\\s*:\\s*\\(\\)\\s*=>`)
      ];
  for (const filePath of files) {
    const analyzed = analyzedSourceFile(filePath);
    const source = analyzed.source;
    let index = -1;
    let matchedPatternIndex = -1;
    let sourceSymbol = null;
    const registry = analyzed.registry;
    const bundled = registry.blocks.size > 0 || registry.generators.size > 0;
    if (bundled) {
      const entry = (kind === 'block' ? registry.blocks : registry.generators).get(blockType);
      if (!entry) continue;
      sourceSymbol = entry.symbol || null;
      if (Number.isInteger(entry.inlineIndex)) {
        index = entry.inlineIndex;
      } else if (entry.symbol) {
        let currentSymbol = entry.symbol;
        const visited = new Set();
        while (currentSymbol && !visited.has(currentSymbol) && visited.size < 12) {
          visited.add(currentSymbol);
          const symbol = escapeRegExp(currentSymbol);
          const symbolPatterns = [
            new RegExp(`(?:^|[,;{}])\\s*(?:(?:var|let|const)\\s+)?${symbol}\\s*=\\s*(?:async\\s+)?(?:function\\b|\\{|(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)`),
            new RegExp(`\\bfunction\\s+${symbol}\\s*\\(`),
            new RegExp(`(?:^|[,;{}])\\s*(?:(?:var|let|const)\\s+)?${symbol}\\s*=\\s*`)
          ];
          let found = false;
          for (const pattern of symbolPatterns) {
            const match = pattern.exec(source);
            if (match) { index = match.index; found = true; break; }
          }
          if (!found) break;
          const assignment = symbolAssignment(source, currentSymbol);
          if (!assignment || !assignment.alias || assignment.alias === currentSymbol) break;
          const rhs = source.slice(assignment.rhsStart);
          if (/^(?:async\s+)?function\b|^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\{/.test(rhs)) break;
          currentSymbol = assignment.alias;
        }
      }
    } else {
      for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
        const pattern = patterns[patternIndex];
        const match = pattern.exec(source);
        if (match) {
          index = match.index;
          matchedPatternIndex = patternIndex;
          break;
        }
      }
      if (index >= 0) {
        const resolved = resolveAssignedSymbol(source, blockType);
        if (resolved.assignment && resolved.symbol !== blockType) {
          const rhs = source.slice(resolved.assignment.rhsStart);
          if (/^(?:function|async|true|false|null|undefined)\b/.test(rhs)) {
            index = resolved.assignment.index;
          } else if (/^(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|^\{/.test(rhs)) {
            index = resolved.assignment.index;
          } else {
            index = -1;
          }
        } else if (resolved.symbol !== blockType) {
          index = -1;
        }
      }
    }
    if (index < 0) continue;
    const line = source.slice(0, index).split(/\r?\n/).length;
    const lineStart = source.lastIndexOf('\n', index);
    const lineEnd = source.indexOf('\n', index);
    const currentLineLength = (lineEnd < 0 ? source.length : lineEnd) - Math.max(0, lineStart);
    let preciseSource = null;
    const canExtractDefinition = bundled || matchedPatternIndex !== 1;
    const openIndex = canExtractDefinition ? source.indexOf('{', index) : -1;
    if (openIndex >= index && openIndex - index < 2000) {
      const closeIndex = matchingBraceIndex(source, openIndex);
      if (closeIndex > openIndex && closeIndex - index <= 100000) {
        let preciseStart = index;
        while (/\s/.test(source[preciseStart] || '')) preciseStart++;
        while (/[},;]/.test(source[preciseStart] || '')) preciseStart++;
        preciseSource = source.slice(preciseStart, closeIndex + 1).trim();
      }
    }
    let excerpt;
    if (preciseSource) {
      excerpt = preciseSource;
    } else if (currentLineLength > 5000) {
      excerpt = source.slice(Math.max(0, index - 300), Math.min(source.length, index + 5000));
    } else {
      const lines = source.split(/\r?\n/);
      excerpt = lines.slice(Math.max(0, line - 3), Math.min(lines.length, line + 55)).join('\n');
    }
    const result = {
      file: displayedSourcePath(filePath, displayRoot, displayPrefix),
      line,
      format: /(?:^|[\\/])[^\\/]*\.bundle(?:\.[^\\/]*)?\.js$/i.test(filePath) ? 'bundle' : 'source'
    };
    if (sourceSymbol) {
      result.symbol = sourceSymbol;
      const resolved = resolveAssignedSymbol(source, sourceSymbol);
      if (resolved.symbol && resolved.symbol !== sourceSymbol) result.resolvedSymbol = resolved.symbol;
    }
    if (includeSource) result.excerpt = excerpt;
    let analysisSource = preciseSource || excerpt;
    if (kind === 'generator' && preciseSource) {
      const helperSources = [];
      const calledNames = unique([...preciseSource.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
        .map((match) => match[1]));
      for (const calledName of calledNames) {
        const declaration = new RegExp(`\\bfunction\\s+${escapeRegExp(calledName)}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
        if (!declaration) continue;
        const helperOpen = source.indexOf('{', declaration.index);
        const helperClose = matchingBraceIndex(source, helperOpen);
        if (helperClose <= helperOpen || helperClose - declaration.index > 10000) continue;
        const helperSource = source.slice(declaration.index, helperClose + 1);
        if (/valueToCode|statementToCode|getFieldValue/.test(helperSource)) helperSources.push(helperSource);
      }
      if (helperSources.length) analysisSource = `${helperSources.join('\n')}\n${analysisSource}`;
    }
    result.analysisSource = analysisSource;
    return result;
  }
  return null;
}

function markupAttributes(tag) {
  const attributes = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of String(tag).matchAll(pattern)) {
    attributes[match[1]] = match[2] != null ? match[2] : match[3] != null ? match[3] : match[4];
  }
  return attributes;
}

function extractXmlBlock(source, blockType) {
  const start = [...String(source).matchAll(/<block\b[^>]*>/gi)]
    .find((match) => markupAttributes(match[0]).type === String(blockType));
  if (!start) return null;
  if (/\/>\s*$/.test(start[0])) return start[0];
  const token = /<block\b[^>]*>|<\/block\s*>/gi;
  token.lastIndex = start.index;
  let depth = 0;
  let match;
  while ((match = token.exec(source))) {
    if (/^<\/block/i.test(match[0])) depth--;
    else if (!/\/>\s*$/.test(match[0])) depth++;
    if (depth === 0) return source.slice(start.index, token.lastIndex);
  }
  return null;
}

function xmlNames(source, tag, attribute) {
  if (!source) return [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  return unique([...String(source).matchAll(pattern)]
    .map((match) => markupAttributes(match[0])[attribute])
    .filter(Boolean));
}

function directXmlNames(source, tag, attribute) {
  if (!source) return [];
  const names = [];
  let depth = 0;
  for (const match of String(source).matchAll(/<\/?[A-Za-z_:][^>]*>/g)) {
    const token = match[0];
    if (/^<\//.test(token)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const name = (token.match(/^<\s*([A-Za-z_:][A-Za-z0-9_.:-]*)/) || [])[1];
    if (depth === 1 && name && name.toLowerCase() === String(tag).toLowerCase()) {
      const value = markupAttributes(token)[attribute];
      if (value) names.push(value);
    }
    if (!/\/\s*>$/.test(token)) depth++;
  }
  return unique(names);
}

function codeNames(source, patterns) {
  if (!source) return [];
  return unique(patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1])));
}

// Return top-level arguments for calls in a compact block definition.  A
// regular expression cannot safely find the second argument when the first
// one contains nested constructors (for example FieldDropdown(...)).
function callStringArguments(source, methodName, argumentIndex) {
  if (!source) return [];
  const values = [];
  const callPattern = new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(`, 'g');
  for (const match of String(source).matchAll(callPattern)) {
    const openIndex = match.index + match[0].lastIndexOf('(');
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let argumentStart = openIndex + 1;
    const argumentsFound = [];
    let closeIndex = -1;
    for (let index = openIndex; index < source.length; index++) {
      const character = source[index];
      const next = source[index + 1];
      if (lineComment) {
        if (character === '\n' || character === '\r') lineComment = false;
        continue;
      }
      if (blockComment) {
        if (character === '*' && next === '/') { blockComment = false; index++; }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '/' && next === '/') { lineComment = true; index++; continue; }
      if (character === '/' && next === '*') { blockComment = true; index++; continue; }
      if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
      if (character === '(' || character === '[' || character === '{') {
        depth++;
        continue;
      }
      if (character === ')' || character === ']' || character === '}') {
        if (character === ')' && depth === 1) {
          argumentsFound.push(source.slice(argumentStart, index));
          closeIndex = index;
          break;
        }
        if (depth > 0) depth--;
        continue;
      }
      if (character === ',' && depth === 1) {
        argumentsFound.push(source.slice(argumentStart, index));
        argumentStart = index + 1;
      }
    }
    if (closeIndex < 0 || argumentIndex < 0 || argumentIndex >= argumentsFound.length) continue;
    const argument = argumentsFound[argumentIndex].trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(argument);
    if (!quoted) continue;
    let value = quoted[2];
    value = value.replace(/\\([\\\\'"`])/g, '$1');
    values.push(value);
  }
  return unique(values);
}

function generatorValueDefaults(generatorSource) {
  const source = String(generatorSource || '');
  const defaults = new Map();
  const fallbackPattern = String.raw`(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|true|false|null)`;
  const decodeFallback = (fallbackSource) => {
    const value = String(fallbackSource).trim();
    if (value.startsWith('"')) {
      try { return JSON.parse(value); } catch (_) { return value.slice(1, -1); }
    }
    if (value.startsWith("'")) {
      return value.slice(1, -1)
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
    }
    return value;
  };
  const record = (name, fallbackSource) => {
    if (name && !defaults.has(name)) defaults.set(name, decodeFallback(fallbackSource));
  };

  const direct = new RegExp(
    String.raw`valueToCode\(\s*[^,]+,\s*(['"])([^'"]+)\1\s*,[^)]*\)\s*\|\|\s*(${fallbackPattern})`,
    'g'
  );
  for (const match of source.matchAll(direct)) record(match[2], match[3]);

  const helperNames = unique([...source.matchAll(
    /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{[^{}]{0,500}?valueToCode\([^)]*\)\s*\|\|\s*[A-Za-z_$][\w$]*[^{}]{0,100}?\}/g
  )].map((match) => match[1]));
  for (const helperName of helperNames) {
    const helperCall = new RegExp(
      String.raw`\b${escapeRegExp(helperName)}\s*\(\s*[^,()]+,\s*(['"])([^'"]+)\1\s*,\s*(${fallbackPattern})\s*\)`,
      'g'
    );
    for (const match of source.matchAll(helperCall)) record(match[2], match[3]);
  }
  return defaults;
}

function contractFromSources(defaultXml, definitionSource, generatorSource) {
  const valueInputs = unique([
    ...directXmlNames(defaultXml, 'value', 'name'),
    ...codeNames(definitionSource, [/appendValueInput\(\s*['"]([^'"]+)['"]/g]),
    ...codeNames(generatorSource, [/valueToCode\([^,]+,\s*['"]([^'"]+)['"]/g])
  ]);
  const statementInputs = unique([
    ...directXmlNames(defaultXml, 'statement', 'name'),
    ...codeNames(definitionSource, [/appendStatementInput\(\s*['"]([^'"]+)['"]/g]),
    ...codeNames(generatorSource, [/statementToCode\([^,]+,\s*['"]([^'"]+)['"]/g])
  ]);
  const fieldNames = unique([
    ...directXmlNames(defaultXml, 'field', 'name'),
    ...callStringArguments(definitionSource, 'appendField', 1),
    ...codeNames(generatorSource, [/getFieldValue\(\s*['"]([^'"]+)['"]/g])
  ]);
  let connection = 'unknown';
  if (/setOutput\(\s*(?:true|!0)\b/.test(definitionSource || '')) connection = 'output';
  else if (/setPreviousStatement\(\s*(?:true|!0)\b/.test(definitionSource || '')) connection = 'statement';
  else if (/setNextStatement\(\s*(?:true|!0)\b/.test(definitionSource || '')) connection = 'statement';
  else if (/setHat\(|MIXLY_SETUP/.test(definitionSource || '')) connection = 'hat';
  else if (statementInputs.length) connection = 'hat';
  const valueDefaults = generatorValueDefaults(generatorSource);
  return {
    valueInputs,
    optionalValueInputs: valueInputs.filter((name) => valueDefaults.has(name)),
    valueDefaults: valueInputs
      .filter((name) => valueDefaults.has(name))
      .map((name) => ({ name, fallbackCode: valueDefaults.get(name) })),
    statementInputs,
    fieldNames,
    connection,
    hasMutation: /<mutation\b/i.test(defaultXml || '') || /mutationToDom|domToMutation|setMutator/.test(definitionSource || ''),
    usesImage: /Field(?:Image|Bitmap)|image[_-]?properties/i.test(definitionSource || '')
  };
}

function readSource(args) {
  if (args.sourceText != null) return String(args.sourceText);
  if (!args.sourcePath) fail('需要 sourcePath 或 sourceText');
  const sourcePath = resolveInputPath(args.sourcePath, args.allowExternalPath === true);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    fail(`源码文件不存在: ${sourcePath}`);
  }
  return stripUtf8Bom(fs.readFileSync(sourcePath, 'utf8'));
}

function equivalencePrimaryFile(args, textField, pathField, label, allowExternalPath) {
  const hasText = args[textField] != null;
  const hasPath = typeof args[pathField] === 'string' && args[pathField].trim().length > 0;
  if (hasText === hasPath) fail(`${label}必须且只能提供 ${textField} 或 ${pathField} 其中一个`);
  if (hasText) {
    return { name: `<${textField}>`, text: stripUtf8Bom(String(args[textField])) };
  }
  const filePath = resolveInputPath(args[pathField], allowExternalPath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`${label}文件不存在或不是文件: ${filePath}`);
  }
  return { name: filePath, text: stripUtf8Bom(fs.readFileSync(filePath, 'utf8')) };
}

function equivalenceSupportFiles(supportPaths, allowExternalPath) {
  const result = [];
  const seen = new Set();
  for (let index = 0; index < (supportPaths || []).length; index++) {
    const filePath = resolveInputPath(supportPaths[index], allowExternalPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      fail(`生成端辅助源码不存在或不是文件 (supportPaths[${index}]): ${filePath}`);
    }
    const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name: filePath, text: stripUtf8Bom(fs.readFileSync(filePath, 'utf8')) });
  }
  return result;
}

function checkedRequiredPatterns(patterns) {
  return (patterns || []).map((item, index) => {
    const descriptor = typeof item === 'string' ? { label: item, pattern: item } : item;
    if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.pattern !== 'string' || !descriptor.pattern) {
      fail(`requiredPatterns[${index}] 必须是非空正则字符串或 {label, pattern, flags} 对象`);
    }
    if (descriptor.label != null && typeof descriptor.label !== 'string') {
      fail(`requiredPatterns[${index}].label 必须是字符串`);
    }
    if (descriptor.flags != null && typeof descriptor.flags !== 'string') {
      fail(`requiredPatterns[${index}].flags 必须是字符串`);
    }
    try { new RegExp(descriptor.pattern, descriptor.flags || 'm'); } catch (error) {
      fail(`requiredPatterns[${index}] 正则无效: ${error.message}`);
    }
    return descriptor;
  });
}

function wasmPackageSummary() {
  return mixly4WasmArchives().map((archive) => {
    const manifestLibraries = archive.kind === 'libraries'
      ? manifestLibraryEntries(archive.manifest, archive.archive, archive.platform)
      : [];
    const compilerManifest = archive.kind === 'compiler'
      ? readTarJson(archive.archive, 'manifest.json')
      : null;
    const fqbn = compilerFqbnsFromManifest(compilerManifest, archive.platform);
    return {
      kind: archive.kind,
      platform: archive.platform,
      archive: archive.archive,
      archiveName: archive.archiveName,
      archiveBytes: fs.statSync(archive.archive).size,
      libraryCount: manifestLibraries.length,
      compilerFqbns: fqbn,
      libraryManifest: archive.kind === 'libraries' ? 'libraries.manifest.json' : null
    };
  });
}

function compilerFqbnsFromManifest(manifest, platform) {
  if (!manifest) return [];
  if (Array.isArray(manifest.fqbns)) return manifest.fqbns.map(String).filter(Boolean);
  const family = platform === 'avr' ? 'arduino:avr' : (platform === 'esp32' ? 'esp32:esp32' : null);
  if (!family || !manifest.boards) return [];
  if (Array.isArray(manifest.boards)) {
    return manifest.boards.map((item) => item && (item.fqbn || item.board || item.key))
      .filter(Boolean).map((value) => String(value).includes(':') ? String(value) : `${family}:${value}`);
  }
  if (typeof manifest.boards === 'object') {
    return Object.keys(manifest.boards).map((value) => `${family}:${value}`);
  }
  return [];
}

function mixlyLayoutSummary() {
  return {
    generation: MIXLY_LAYOUT.generation,
    runtime: MIXLY_LAYOUT.runtime,
    version: MIXLY_LAYOUT.packageJson.version || null,
    nodeMain: MIXLY_LAYOUT.packageJson['node-main'] || null,
    main: MIXLY_LAYOUT.packageJson.main || null,
    chromiumArgs: MIXLY_LAYOUT.packageJson['chromium-args'] || null
  };
}

function windowsExecutableArchitecture(executablePath) {
  if (process.platform !== 'win32' || !executablePath || !fs.existsSync(executablePath)) return null;
  try {
    const header = Buffer.alloc(4096);
    const descriptor = fs.openSync(executablePath, 'r');
    try {
      const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
      if (bytesRead < 64 || header.toString('ascii', 0, 2) !== 'MZ') return null;
      const peOffset = header.readUInt32LE(0x3c);
      if (peOffset + 6 > bytesRead || header.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;
      const machine = header.readUInt16LE(peOffset + 4);
      return ({ 0x014c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' })[machine] || `pe-0x${machine.toString(16)}`;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (_) {
    return null;
  }
}

function nwExecutablesBelow(container, source) {
  if (!container || !fs.existsSync(container) || !fs.statSync(container).isDirectory()) return [];
  const candidates = [];
  const direct = path.join(container, process.platform === 'win32' ? 'nw.exe' : 'nw');
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) candidates.push({ path: direct, source });
  for (const entry of fs.readdirSync(container, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^nwjs/i.test(entry.name)) continue;
    const executable = path.join(container, entry.name, process.platform === 'win32' ? 'nw.exe' : 'nw');
    if (fs.existsSync(executable) && fs.statSync(executable).isFile()) {
      candidates.push({ path: executable, source });
    }
  }
  return candidates;
}

function mixly4RuntimeCandidates(explicitPath = null) {
  const candidates = [];
  const append = (candidatePath, source) => {
    if (!candidatePath) return;
    const resolved = path.resolve(candidatePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
    if (candidates.some((item) => item.path.toLowerCase() === resolved.toLowerCase())) return;
    candidates.push({
      path: resolved,
      source,
      architecture: windowsExecutableArchitecture(resolved),
      nwRuntime: /^nw(?:\.exe)?$/i.test(path.basename(resolved)),
      sdk: /nwjs-sdk/i.test(resolved)
    });
  };
  if (explicitPath) {
    const resolved = ensureInsideWorkspace(explicitPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      fail(`指定的 Mixly 4 runtimeExecutable 不存在: ${resolved}`);
    }
    append(resolved, 'explicit');
  }
  append(process.env.MIXLY4_RUNTIME, 'environment');
  for (const [relative, source] of [
    ['.mixly-mcp-nw-sdk-x64/node_modules/nw', 'local-x64-sdk'],
    ['.mixly-mcp-nw-x64/node_modules/nw', 'local-x64-runtime'],
    ['node_modules/nw', 'mixly-node-modules']
  ]) {
    for (const item of nwExecutablesBelow(path.join(ROOT, ...relative.split('/')), source)) {
      append(item.path, item.source);
    }
  }
  append(MIXLY_EXE, 'packaged-executable');
  return candidates.sort((left, right) => {
    const score = (item) =>
      (item.source === 'explicit' ? 1000 : 0) +
      (item.source === 'environment' ? 900 : 0) +
      (item.architecture === 'x64' ? 100 : item.architecture === 'arm64' ? 80 : 0) +
      (item.sdk ? 30 : item.nwRuntime ? 20 : 0);
    return score(right) - score(left);
  });
}

function preferredMixlyRuntime(args = {}) {
  if (!isMixly4()) {
    return fs.existsSync(MIXLY_EXE)
      ? { path: MIXLY_EXE, source: 'packaged-executable', architecture: windowsExecutableArchitecture(MIXLY_EXE), nwRuntime: false, sdk: false }
      : null;
  }
  return mixly4RuntimeCandidates(args.runtimeExecutable)[0] || null;
}

function compileEngineSummary(wasmPackages, selectedCli) {
  const desktopWasm = isMixly4();
  const preferredRuntime = preferredMixlyRuntime();
  const executableArch = preferredRuntime && preferredRuntime.architecture;
  const archiveBytes = wasmPackages.reduce((total, item) => total + (item.archiveBytes || 0), 0);
  return {
    desktop: desktopWasm ? {
      engine: 'browser-wasm',
      executable: preferredRuntime && preferredRuntime.path,
      executableSource: preferredRuntime && preferredRuntime.source,
      executableArchitecture: executableArch,
      packageArchiveBytes: archiveBytes,
      packages: wasmPackages.map(({ kind, platform, archiveName, archiveBytes: bytes }) => ({
        kind, platform, archiveName, archiveBytes: bytes
      })),
      librarySource: 'Mixly 4 WASM archives plus generator.libs_ sketch files',
      coldStartMemoryRisk: executableArch === 'x86' ? 'high' : 'normal',
      warning: executableArch === 'x86'
        ? 'Mixly 4 x86 cold WASM compilation loads and extracts large compiler/library archives in-process; low available memory can terminate the desktop process.'
        : null
    } : {
      engine: 'runtime-dependent',
      executableArchitecture: executableArch
    },
    mcp: {
      engine: 'arduino-cli',
      executable: selectedCli,
      purpose: desktopWasm ? 'generated C++ compatibility check' : 'Arduino compile check',
      desktopEquivalent: desktopWasm ? false : null
    }
  };
}

function verifyEquivalence(args) {
  const allowExternalPath = args.allowExternalPath === true;
  const sourceFile = equivalencePrimaryFile(args, 'sourceText', 'sourcePath', '参考源码', allowExternalPath);
  const generatedFile = equivalencePrimaryFile(args, 'generatedText', 'generatedPath', '生成代码', allowExternalPath);
  const supportFiles = equivalenceSupportFiles(args.supportPaths, allowExternalPath);
  const mode = args.mode || 'report';
  const result = compareCode({
    mode,
    sourceFiles: [sourceFile],
    generatedPrimaryFiles: [generatedFile],
    supportFiles,
    ignoreStrings: args.ignoreStrings || [],
    ignoreIdentifiers: args.ignoreIdentifiers || [],
    requiredPatterns: checkedRequiredPatterns(args.requiredPatterns),
    includeSupportInRequiredPatterns: args.includeSupportInRequiredPatterns === true
  });
  return {
    ...result,
    blocking: mode !== 'report',
    status: mode === 'report'
      ? (result.behavioralGapCount ? 'gaps-found' : 'no-gaps-found')
      : (result.passed ? 'passed' : 'failed'),
    inputs: {
      source: sourceFile.name,
      generated: generatedFile.name,
      support: supportFiles.map((file) => file.name)
    }
  };
}

function indexedScriptFiles(boardRoot, segment) {
  const indexPath = path.join(boardRoot, 'index.xml');
  if (!fs.existsSync(indexPath)) return [];
  const indexSource = fs.readFileSync(indexPath, 'utf8');
  return unique([...indexSource.matchAll(/<script\b[^>]*>/gi)]
    .map((match) => markupAttributes(match[0]).src)
    .filter(Boolean)
    .filter((source) => source.replace(/\\/g, '/').includes(`/${segment}/`) || source.startsWith(`${segment}/`))
    .map((source) => path.resolve(boardRoot, source))
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile()));
}

function allIndexedScriptFiles(boardRoot) {
  const indexPath = path.join(boardRoot, 'index.xml');
  if (!fs.existsSync(indexPath)) return [];
  const indexSource = fs.readFileSync(indexPath, 'utf8');
  return unique([...indexSource.matchAll(/<script\b[^>]*>/gi)]
    .map((match) => markupAttributes(match[0]).src)
    .filter(Boolean)
    .map((source) => path.resolve(boardRoot, source))
    .filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile()));
}

function companionSourceRoots(boardRoot) {
  const relative = path.relative(BOARDS_DIR, boardRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return [];
  const segments = relative.split(path.sep);
  if (segments.length < 2 || /_src$/i.test(segments[0])) return [];
  const candidates = [
    path.join(BOARDS_DIR, `${segments[0]}_src`, ...segments.slice(1)),
    path.join(BOARDS_DIR, 'default_src', ...segments.slice(1))
  ];
  return unique(candidates.filter((candidate) =>
    candidate !== boardRoot && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
  ));
}

function directFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function prioritizeSourceFiles(files) {
  const score = (filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes('/default_src/') || normalized.includes('/extend_src/')) return 0;
    if (/\/(?:blocks?|generators?)\//i.test(normalized)) return 1;
    if (/\.bundle(?:\.[^/]*)?\.js$/i.test(normalized)) return 9;
    return 5;
  };
  return unique(files).sort((left, right) => score(left) - score(right) || left.localeCompare(right));
}

function boardSourceFiles(boardRoot, boardMeta = null) {
  const indexed = allIndexedScriptFiles(boardRoot);
  const indexedBlocks = indexedScriptFiles(boardRoot, 'blocks');
  const indexedGenerators = indexedScriptFiles(boardRoot, 'generators');
  const companionRoots = companionSourceRoots(boardRoot);
  const sourceRoots = [boardRoot, ...companionRoots];
  const bundles = unique([
    ...directFiles(boardRoot, (name) => /^main\.bundle(?:\.[^.]+)?\.js$/i.test(name)),
    ...indexed.filter((filePath) => /\.bundle(?:\.[^\\/]*)?\.js$/i.test(filePath))
  ]).filter((filePath) => fs.statSync(filePath).size > 0);
  const blockSources = sourceRoots.flatMap((sourceRoot) => [
    ...filesRecursive(path.join(sourceRoot, 'block'), '.js'),
    ...filesRecursive(path.join(sourceRoot, 'blocks'), '.js')
  ]);
  const generatorSources = sourceRoots.flatMap((sourceRoot) => [
    ...filesRecursive(path.join(sourceRoot, 'generator'), '.js'),
    ...filesRecursive(path.join(sourceRoot, 'generators'), '.js')
  ]);
  const allToolboxes = unique([
    path.join(boardRoot, 'index.xml'),
    ...sourceRoots.flatMap((sourceRoot) => [
      ...filesRecursive(path.join(sourceRoot, 'xml'), '.xml'),
      ...filesRecursive(path.join(sourceRoot, 'origin', 'xml'), '.xml')
    ])
  ]).filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  const preferredToolbox = boardMeta && boardMeta.xmlPath
    ? path.resolve(boardRoot, boardMeta.xmlPath)
    : null;
  const preferredExists = preferredToolbox && allToolboxes.includes(preferredToolbox);
  const toolboxes = unique([
    ...(preferredExists ? [preferredToolbox] : []),
    ...allToolboxes.sort().filter((filePath) => filePath !== preferredToolbox)
  ]);
  return {
    blocks: prioritizeSourceFiles([
      ...blockSources,
      ...indexedBlocks,
      ...indexed,
      ...bundles
    ]),
    generators: prioritizeSourceFiles([
      ...generatorSources,
      ...indexedGenerators,
      ...indexed,
      ...bundles
    ]),
    toolboxes,
    examples: filesRecursive(path.join(boardRoot, 'examples'), '.mix').sort(),
    bundles: bundles.sort(),
    companionRoots,
    runtimeScripts: indexed,
    runtimeGenerators: unique([...indexedGenerators, ...bundles])
  };
}

function exampleUsages(exampleFiles, blockType, limit = 8, displayRoot = null, displayPrefix = null) {
  const usages = [];
  for (const filePath of exampleFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const blockXml = extractXmlBlock(source, blockType);
    if (!blockXml) continue;
    usages.push({
      project: displayedSourcePath(filePath, displayRoot, displayPrefix),
      blockXml
    });
    if (usages.length >= limit) break;
  }
  return usages;
}

function libraryFiles(libraryPath) {
  const allFiles = filesRecursive(libraryPath).filter((filePath) => fs.statSync(filePath).isFile());
  const xml = allFiles.filter((filePath) => /\.xml$/i.test(filePath));
  const indexedScripts = unique(xml.flatMap((xmlPath) => {
    const source = fs.readFileSync(xmlPath, 'utf8');
    return [...source.matchAll(/<script\b[^>]*>/gi)]
      .map((match) => markupAttributes(match[0]).src)
      .filter(Boolean)
      .map((src) => path.resolve(path.dirname(xmlPath), src));
  })).filter((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  const scriptsReferencedAs = (segment) => unique(xml.flatMap((xmlPath) => {
    const source = fs.readFileSync(xmlPath, 'utf8');
    return [...source.matchAll(/<script\b[^>]*>/gi)]
      .map((match) => markupAttributes(match[0]).src)
      .filter(Boolean)
      .map((src) => path.resolve(path.dirname(xmlPath), src))
      .filter((filePath) => filePath.replace(/\\/g, '/').includes(`/${segment}/`));
  })).filter((filePath) => fs.existsSync(filePath));
  return {
    all: allFiles.sort(),
    xml: xml.sort(),
    blocks: unique([
      ...allFiles.filter((filePath) => /[\\/]block[s]?[\\/].*\.js$/i.test(filePath)),
      ...allFiles.filter((filePath) => /[\\/](?:blocks|block)\.js$/i.test(filePath)),
      ...scriptsReferencedAs('block'),
      ...indexedScripts
    ]).sort(),
    generators: unique([
      ...allFiles.filter((filePath) => /[\\/]generator[s]?[\\/].*\.js$/i.test(filePath)),
      ...allFiles.filter((filePath) => /[\\/](?:generators|generator)\.js$/i.test(filePath)),
      ...scriptsReferencedAs('generator'),
      ...indexedScripts
    ]).sort()
  };
}

function blockSpecsFromResources(args, board, libraries, storage) {
  const officialFiles = boardSourceFiles(board.root, board);
  const specs = [];
  const unknownTypes = [];
  const includeExamples = args.includeExamples === true;

  for (const blockType of unique(args.blockTypes.map(String))) {
    let owner = 'official';
    let examples = includeExamples ? exampleUsages(officialFiles.examples, blockType) : [];
    let defaultXml = officialFiles.toolboxes
      .map((filePath) => extractXmlBlock(fs.readFileSync(filePath, 'utf8'), blockType))
      .find(Boolean) || (examples[0] && examples[0].blockXml) || null;
    let definition = sourceLocation(officialFiles.blocks, blockType, 'block', args.includeSource === true);
    let generator = sourceLocation(officialFiles.generators, blockType, 'generator', args.includeSource === true);

    if (!definition && !generator && !defaultXml) {
      for (const library of libraries) {
        const candidateFiles = libraryFiles(library.path);
        const candidateExamples = includeExamples
          ? candidateFiles.all.filter((filePath) => /\.mix$/i.test(filePath))
          : [];
        const candidateUsages = includeExamples
          ? exampleUsages(candidateExamples, blockType, 8, library.path, library.owner)
          : [];
        const candidateXml = candidateFiles.xml
          .map((filePath) => extractXmlBlock(fs.readFileSync(filePath, 'utf8'), blockType))
          .find(Boolean) || (candidateUsages[0] && candidateUsages[0].blockXml) || null;
        const candidateDefinition = sourceLocation(
          candidateFiles.blocks, blockType, 'block', args.includeSource === true, library.path, library.owner
        );
        const candidateGenerator = sourceLocation(
          candidateFiles.generators, blockType, 'generator', args.includeSource === true, library.path, library.owner
        );
        if (!candidateDefinition && !candidateGenerator && !candidateXml && !candidateUsages.length) continue;
        owner = library.owner;
        examples = candidateUsages;
        defaultXml = candidateXml;
        definition = candidateDefinition;
        generator = candidateGenerator;
        break;
      }
    }

    if (!definition && !generator && !defaultXml && !examples.length) {
      unknownTypes.push(blockType);
      continue;
    }
    const definitionSource = definition ? definition.analysisSource : '';
    const generatorSource = generator ? generator.analysisSource : '';
    if (definition) delete definition.analysisSource;
    if (generator) delete generator.analysisSource;
    const spec = {
      type: blockType,
      owner,
      definition,
      generator,
      contract: contractFromSources(defaultXml, definitionSource, generatorSource),
      defaultXml,
      usageRule: '复制 defaultXml 的 field/value/statement 名称；只替换 field 值和 shadow 默认值，不翻译接口名称。'
    };
    if (includeExamples) {
      spec.exampleProjects = examples.map((item) => item.project);
      spec.exampleXml = examples[0] ? examples[0].blockXml : null;
    }
    specs.push(spec);
  }

  return {
    board: board.id,
    boardProfile: board.selectedProfile || null,
    fqbn: board.fqbn || null,
    requested: args.blockTypes.length,
    found: specs.length,
    unknownTypes,
    specs,
    examplesIncluded: includeExamples,
    pluginStorage: storage,
    namingRule: {
      interfaceNames: 'type、field name、value name、statement name 必须保持本地定义中的原文',
      userNames: '变量 VAR、函数 NAME、mutation name 与 arg name 使用自然中文，并在声明/读取/赋值/定义/调用处完全一致'
    }
  };
}

async function getBlockSpecs(args) {
  if (!Array.isArray(args.blockTypes) || !args.blockTypes.length || args.blockTypes.length > 50) {
    fail('blockTypes 必须包含 1 到 50 个积木 type');
  }
  const board = getBoard(args.board);
  const cacheKey = JSON.stringify({
    board: board.id,
    profile: board.selectedProfile || null,
    fqbn: board.fqbn || null,
    xmlPath: board.xmlPath || null,
    blockTypes: unique(args.blockTypes.map(String)),
    includeSource: args.includeSource === true,
    includeExamples: args.includeExamples === true,
    cdpPort: isMixly4() ? getCdpPort(args) : null
  });
  const cached = readDiscoveryCache(blockSpecsCache, cacheKey, args.refresh);
  if (cached) {
    return {
      ...cached.value,
      cache: { hit: true, ageMs: cached.ageMs, ttlMs: DISCOVERY_CACHE_TTL_MS }
    };
  }
  const startedAt = Date.now();
  const context = await thirdPartyLibraryContext(board, args, { mode: 'analysis' });
  try {
    const value = blockSpecsFromResources(args, board, context.resources, context.storage);
    writeDiscoveryCache(blockSpecsCache, cacheKey, value);
    return {
      ...value,
      cache: { hit: false, ageMs: 0, ttlMs: DISCOVERY_CACHE_TTL_MS, buildMs: Date.now() - startedAt }
    };
  } finally {
    context.cleanup();
  }
}

function libraryResourceDisplayPath(resource, storage) {
  if (resource.source === 'mixly4-opfs') {
    return `opfs:${storage.root}/${resource.name}/${resource.version || resource.metadata.version || ''}`.replace(/\/$/, '');
  }
  return resource.path;
}

async function inspectLibrary(args) {
  const board = getBoard(args.board);
  const context = await thirdPartyLibraryContext(board, args, {
    mode: 'analysis', libraryNames: [args.library]
  });
  try {
    const resource = context.resources.find((candidate) => candidate.name.toLowerCase() === args.library.toLowerCase());
    if (!resource) {
      if (isMixly4() && !context.storage.available) {
        fail(`无法确认 Mixly 4 插件是否已安装: ${args.library}`, {
          code: 'MIXLY4_OPFS_UNAVAILABLE',
          pluginStorage: context.storage,
          stagingLibraries: context.resources.map((item) => item.name)
        });
      }
      fail(`第三方积木库不存在: ${args.library}`, {
        board: board.id,
        availableLibraries: context.resources.map((item) => item.name),
        pluginStorage: context.storage
      });
    }
    const files = libraryFiles(resource.path);
    const relativeFiles = unique(resource.fileList || files.all.map((filePath) =>
      path.relative(resource.path, filePath).replace(/\\/g, '/'))).sort();
    const blockSource = files.blocks.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
    const generatorSource = files.generators.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
    const toolboxSource = files.xml.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
    const toolboxTypes = toolboxBlockTypes(toolboxSource).sort();
    const definedTypes = extractLibraryBlockTypes(blockSource).sort();
    const generatorTypes = extractLibraryGeneratorTypes(generatorSource).sort();
    const requestedTypes = args.blockTypes && args.blockTypes.length
      ? args.blockTypes
      : toolboxTypes.slice(0, 20);
    const specs = requestedTypes.length
      ? blockSpecsFromResources({
        board: board.id,
        blockTypes: requestedTypes,
        includeSource: args.includeSource === true
      }, board, [resource], context.storage).specs.filter((spec) => spec.owner === resource.owner)
      : [];
    const pluginLayout = relativeFiles.includes('index.xml') && relativeFiles.includes('index.js') &&
      relativeFiles.includes('plugin.json');
    return {
      board: board.id,
      library: resource.name,
      owner: resource.owner,
      source: resource.source,
      installed: resource.installed,
      libraryPath: libraryResourceDisplayPath(resource, context.storage),
      config: resource.metadata,
      pluginStorage: context.storage,
      structure: {
        standardLayout: pluginLayout || (relativeFiles.some((name) => name.startsWith('block/')) &&
          relativeFiles.some((name) => name.startsWith('generator/')) && relativeFiles.includes('config.json')),
        pluginLayout,
        fileCount: relativeFiles.length,
        topLevelDirectories: unique(relativeFiles.filter((name) => name.includes('/')).map((name) => name.split('/')[0])).sort(),
        xmlFiles: relativeFiles.filter((name) => /\.xml$/i.test(name)),
        blockFiles: files.blocks.map((filePath) => path.relative(resource.path, filePath).replace(/\\/g, '/')),
        generatorFiles: files.generators.map((filePath) => path.relative(resource.path, filePath).replace(/\\/g, '/')),
        languageFiles: relativeFiles.filter((name) => name.startsWith('language/')),
        mediaFiles: relativeFiles.filter((name) => name.startsWith('media/')),
        arduinoLibraryFileCount: relativeFiles.filter((name) => name.startsWith('libraries/')).length,
        sampleFiles: relativeFiles.filter((name) => !name.startsWith('libraries/')).slice(0, 120)
      },
      coverage: {
        toolboxTypes,
        definedTypes,
        generatorTypes,
        missingDefinitions: toolboxTypes.filter((type) => !definedTypes.includes(type)),
        missingGenerators: toolboxTypes.filter((type) => !generatorTypes.includes(type))
      },
      patterns: {
        usesFieldImage: /FieldImage/.test(blockSource),
        usesFieldBitmap: /FieldBitmap/.test(blockSource),
        usesFieldGridDropdown: /FieldGridDropdown/.test(blockSource),
        usesDropdown: /FieldDropdown/.test(blockSource),
        usesLanguageMessages: /Blockly\.Msg/.test(blockSource),
        scriptReferences: unique([...toolboxSource.matchAll(/<script\b[^>]*>/gi)]
          .map((match) => markupAttributes(match[0]).src).filter(Boolean)),
        styleReferences: unique([...toolboxSource.matchAll(/<link\b[^>]*>/gi)]
          .map((match) => markupAttributes(match[0]).href).filter(Boolean))
      },
      imagePolicy: '图片能力仅作为可选表现层：只有用户明确要求图片块图标或图片选项时，才在 mixly_create_library 中传 userRequestedImages=true 和对应 imageMode。',
      specs
    };
  } finally {
    context.cleanup();
  }
}

async function scanLibrarySnapshot(args) {
  const selectedBoard = args.boardRoot ? null : getBoard(args.board);
  const boardRoot = args.boardRoot
    ? ensureInsideWorkspace(args.boardRoot)
    : selectedBoard.root;
  const sourceFiles = boardSourceFiles(boardRoot, selectedBoard);
  const blockFiles = sourceFiles.blocks;
  const generatorFiles = sourceFiles.generators;
  const registeredGeneratorFiles = sourceFiles.bundles.length
    ? sourceFiles.runtimeGenerators
    : generatorFiles;
  const toolboxTypes = unique(sourceFiles.toolboxes.flatMap((file) =>
    toolboxBlockTypes(fs.readFileSync(file, 'utf8'))
  )).sort();
  const blockTypes = unique([
    ...blockFiles.flatMap((file) => extractBlockTypes(fs.readFileSync(file, 'utf8'))),
    ...toolboxTypes
  ]).sort();
  const generatorTypes = unique(registeredGeneratorFiles.flatMap((file) =>
    extractGeneratorTypes(analyzedSourceFile(file).source)
  )).sort();
  const context = await thirdPartyLibraryContext(selectedBoard || { root: boardRoot }, args, {
    boardRoot: args.boardRoot ? boardRoot : null,
    mode: 'analysis'
  });
  try {
    const thirdParty = [];
    for (const resource of context.resources) {
      const localFiles = libraryFiles(resource.path);
      const relativeFiles = unique(resource.fileList || localFiles.all.map((filePath) =>
        path.relative(resource.path, filePath).replace(/\\/g, '/'))).sort();
      const xmlFiles = relativeFiles.filter((name) => /\.xml$/i.test(name));
      const customTypes = unique([
        ...localFiles.xml.flatMap((xmlPath) => {
          const xml = fs.readFileSync(xmlPath, 'utf8');
          return toolboxBlockTypes(xml);
        }),
        ...localFiles.blocks.flatMap((filePath) => extractLibraryBlockTypes(fs.readFileSync(filePath, 'utf8')))
      ]).sort();
      const blockSource = localFiles.blocks.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
      thirdParty.push({
        name: resource.name,
        owner: resource.owner,
        source: resource.source,
        installed: resource.installed,
        version: resource.version || resource.metadata.version || null,
        libraryPath: libraryResourceDisplayPath(resource, context.storage),
        xmlFiles,
        customTypes,
        standardLayout: (relativeFiles.includes('index.xml') && relativeFiles.includes('index.js') && relativeFiles.includes('plugin.json')) ||
          (relativeFiles.some((name) => name.startsWith('block/')) && relativeFiles.some((name) => name.startsWith('generator/'))),
        pluginLayout: relativeFiles.includes('index.xml') && relativeFiles.includes('index.js') && relativeFiles.includes('plugin.json'),
        hasImages: /Field(?:Image|Bitmap)|image[_-]?properties/.test(blockSource),
        mediaFileCount: relativeFiles.filter((name) => name.startsWith('media/')).length,
        arduinoLibraryFileCount: relativeFiles.filter((name) => name.startsWith('libraries/')).length
      });
    }

    const thirdPartyBlockTypes = unique(thirdParty.flatMap((library) => library.customTypes)).sort();
    const availableBlockTypes = unique([...blockTypes, ...thirdPartyBlockTypes]).sort();
    let arduinoLibraries = null;
    if (selectedBoard) {
      const catalog = scanArduinoLibraries({ board: selectedBoard.id });
      arduinoLibraries = {
        source: catalog.source,
        platform: catalog.platform,
        archive: catalog.archive,
        libraryCount: catalog.libraryCount,
        availableNames: catalog.libraries.map((library) => library.name)
      };
    }
    return {
      board: selectedBoard,
      boardRoot,
      official: {
        blockFileCount: blockFiles.length,
        generatorFileCount: generatorFiles.length,
        toolboxFileCount: sourceFiles.toolboxes.length,
        exampleProjectCount: sourceFiles.examples.length,
        bundleFileCount: sourceFiles.bundles.length,
        companionSourceRoots: sourceFiles.companionRoots.map(relativeToRoot),
        blockTypeCount: blockTypes.length,
        generatorTypeCount: generatorTypes.length,
        discoveryMode: sourceFiles.bundles.length ? 'bundle+toolbox+source' : 'source+toolbox'
      },
      blockTypes,
      generatorTypes,
      thirdPartyBlockTypes,
      availableBlockTypes,
      thirdParty,
      pluginStorage: context.storage,
      arduinoLibraries,
      usageHint: isMixly4()
        ? 'availableBlockTypes 包含官方积木以及 OPFS/暂存插件积木。pluginStorage.available=false 时只能确认 staging，不能据此断言某个 OPFS 插件未安装。'
        : 'availableBlockTypes 同时包含官方和 ThirdParty 积木，并兼容打包型板卡。优先复用本地块；不熟悉的 type 可调用 mixly_get_block_specs 获取真实 defaultXml、接口和本地示例。',
      advisory: '这些是建议，不是阻止规则；AI 可以根据用户目标决定是否创建新库。'
    };
  } finally {
    context.cleanup();
  }
}

function compactBoardForDiscovery(board) {
  if (!board) return null;
  return {
    id: board.id,
    boardType: board.boardType,
    language: board.language,
    thirdParty: board.thirdParty,
    selectedProfile: board.selectedProfile || null,
    fqbn: board.fqbn || null,
    xmlPath: board.xmlPath || null
  };
}

function typeFamilySummary(types, limit = 24) {
  const counts = new Map();
  for (const type of types) {
    const family = String(type).split('_')[0] || String(type);
    counts.set(family, (counts.get(family) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((left, right) => right.count - left.count || left.family.localeCompare(right.family))
    .slice(0, limit);
}

function matchesDiscoveryQuery(value, terms) {
  const normalized = String(value || '').toLowerCase();
  return terms.every((term) => normalized.includes(term));
}

function discoveryQueries(args) {
  const single = String(args.query || '').trim();
  const hasMultiple = Array.isArray(args.queries);
  const multiple = hasMultiple
    ? unique(args.queries.map((value) => String(value || '').trim()).filter(Boolean))
    : [];
  if (single && multiple.length) fail('query 与 queries 只能使用一个');
  if (hasMultiple && !multiple.length) fail('queries 至少包含一个非空关键词');
  if (!multiple.length) return null;
  if (multiple.length > 8) fail('queries 最多包含 8 个关键词');
  const oversized = multiple.filter((query) => query.length > 120);
  if (oversized.length) fail('queries 中每个关键词最多 120 个字符', { oversized });
  return multiple;
}

function formatLibraryScan(snapshot, args, cache) {
  const query = String(args.query || '').trim();
  const full = args.full === true;
  const limit = args.limit == null ? 60 : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('limit 必须是 1 到 500 的整数');
  if (query.length > 120) fail('query 最多 120 个字符');
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const board = compactBoardForDiscovery(snapshot.board);
  const compactStorage = snapshot.pluginStorage ? {
    kind: snapshot.pluginStorage.kind || null,
    available: snapshot.pluginStorage.available !== false,
    root: snapshot.pluginStorage.root || null,
    reason: snapshot.pluginStorage.reason || null
  } : null;
  const compactArduinoLibraries = snapshot.arduinoLibraries ? {
    source: snapshot.arduinoLibraries.source,
    platform: snapshot.arduinoLibraries.platform,
    archive: snapshot.arduinoLibraries.archive,
    libraryCount: snapshot.arduinoLibraries.libraryCount,
    availableNameCount: Array.isArray(snapshot.arduinoLibraries.availableNames)
      ? snapshot.arduinoLibraries.availableNames.length
      : 0
  } : null;

  if (full) {
    return {
      ...snapshot,
      resultMode: 'full',
      query: query || null,
      cache
    };
  }

  if (!terms.length) {
    return {
      board,
      boardRoot: snapshot.boardRoot,
      official: snapshot.official,
      totals: {
        officialBlockTypes: snapshot.blockTypes.length,
        generatorTypes: snapshot.generatorTypes.length,
        thirdPartyBlockTypes: snapshot.thirdPartyBlockTypes.length,
        availableBlockTypes: snapshot.availableBlockTypes.length,
        thirdPartyLibraries: snapshot.thirdParty.length
      },
      blockTypes: [],
      generatorTypes: [],
      thirdPartyBlockTypes: [],
      availableBlockTypes: [],
      thirdParty: snapshot.thirdParty.slice(0, 60).map((library) => ({
        name: library.name,
        owner: library.owner,
        source: library.source,
        installed: library.installed,
        version: library.version,
        typeCount: library.customTypes.length
      })),
      typeFamilies: typeFamilySummary(snapshot.availableBlockTypes),
      pluginStorage: compactStorage,
      arduinoLibraries: compactArduinoLibraries,
      resultMode: 'summary',
      query: null,
      matchedCount: 0,
      truncated: snapshot.thirdParty.length > 60,
      cache,
      usageHint: '请根据源码能力传 query 获取相关候选；只有审计全集时才传 full=true。选中 type 后调用 mixly_get_block_specs。',
      advisory: snapshot.advisory
    };
  }

  const matchingLibraries = new Set(snapshot.thirdParty
    .filter((library) => matchesDiscoveryQuery(`${library.name} ${library.owner}`, terms))
    .map((library) => library.name));
  const candidates = snapshot.availableBlockTypes.filter((type) => {
    if (matchesDiscoveryQuery(type, terms)) return true;
    return snapshot.thirdParty.some((library) =>
      matchingLibraries.has(library.name) && library.customTypes.includes(type)
    );
  });
  const selectedTypes = candidates.slice(0, limit);
  const selected = new Set(selectedTypes);
  const thirdParty = snapshot.thirdParty
    .filter((library) => matchingLibraries.has(library.name) || library.customTypes.some((type) => selected.has(type)))
    .map((library) => ({
      ...library,
      customTypes: library.customTypes.filter((type) => selected.has(type))
    }));
  const matchingArduinoNames = snapshot.arduinoLibraries && Array.isArray(snapshot.arduinoLibraries.availableNames)
    ? snapshot.arduinoLibraries.availableNames.filter((name) => matchesDiscoveryQuery(name, terms)).slice(0, limit)
    : [];
  return {
    board,
    boardRoot: snapshot.boardRoot,
    official: snapshot.official,
    totals: {
      officialBlockTypes: snapshot.blockTypes.length,
      generatorTypes: snapshot.generatorTypes.length,
      thirdPartyBlockTypes: snapshot.thirdPartyBlockTypes.length,
      availableBlockTypes: snapshot.availableBlockTypes.length,
      thirdPartyLibraries: snapshot.thirdParty.length
    },
    blockTypes: snapshot.blockTypes.filter((type) => selected.has(type)),
    generatorTypes: snapshot.generatorTypes.filter((type) => selected.has(type)),
    thirdPartyBlockTypes: snapshot.thirdPartyBlockTypes.filter((type) => selected.has(type)),
    availableBlockTypes: selectedTypes,
    thirdParty,
    pluginStorage: compactStorage,
    arduinoLibraries: compactArduinoLibraries ? {
      ...compactArduinoLibraries,
      matchingNames: matchingArduinoNames
    } : null,
    resultMode: 'filtered',
    query,
    matchedCount: candidates.length,
    truncated: candidates.length > selectedTypes.length,
    limit,
    cache,
    usageHint: '候选已按 query 过滤；选中 type 后调用 mixly_get_block_specs，不要为找单个积木请求 full=true。',
    advisory: snapshot.advisory
  };
}

async function scanLibrary(args) {
  const selectedBoard = args.boardRoot ? null : getBoard(args.board);
  const boardRoot = args.boardRoot ? ensureInsideWorkspace(args.boardRoot) : selectedBoard.root;
  const queries = discoveryQueries(args);
  if (queries && args.full === true) fail('queries 不能与 full=true 同时使用');
  if (args.includeSpecs === true && !selectedBoard) {
    fail('includeSpecs=true 需要使用 board，不能只传 boardRoot');
  }
  const cacheKey = JSON.stringify({
    board: selectedBoard ? selectedBoard.id : null,
    profile: selectedBoard && selectedBoard.selectedProfile || null,
    fqbn: selectedBoard && selectedBoard.fqbn || null,
    xmlPath: selectedBoard && selectedBoard.xmlPath || null,
    boardRoot,
    cdpPort: isMixly4() ? getCdpPort(args) : null
  });
  const cached = readDiscoveryCache(libraryScanCache, cacheKey, args.refresh);
  let snapshot;
  let cache;
  if (cached) {
    snapshot = cached.value;
    cache = {
      hit: true,
      ageMs: cached.ageMs,
      ttlMs: DISCOVERY_CACHE_TTL_MS
    };
  } else {
    const startedAt = Date.now();
    snapshot = await scanLibrarySnapshot(args);
    writeDiscoveryCache(libraryScanCache, cacheKey, snapshot);
    cache = {
      hit: false,
      ageMs: 0,
      ttlMs: DISCOVERY_CACHE_TTL_MS,
      buildMs: Date.now() - startedAt
    };
  }

  let result;
  if (queries) {
    const groups = queries.map((query) => formatLibraryScan(snapshot, { ...args, query, full: false }, cache));
    const first = groups[0];
    result = {
      board: first.board,
      boardRoot: first.boardRoot,
      official: first.official,
      totals: first.totals,
      resultMode: 'multi-filtered',
      query: null,
      queries,
      matches: groups.map((group) => ({
        query: group.query,
        availableBlockTypes: group.availableBlockTypes,
        matchedCount: group.matchedCount,
        truncated: group.truncated,
        thirdParty: group.thirdParty.map((library) => ({
          name: library.name,
          owner: library.owner,
          customTypes: library.customTypes
        })),
        arduinoLibraryNames: group.arduinoLibraries && group.arduinoLibraries.matchingNames || []
      })),
      availableBlockTypes: unique(groups.flatMap((group) => group.availableBlockTypes)),
      pluginStorage: first.pluginStorage,
      arduinoLibraries: first.arduinoLibraries ? {
        source: first.arduinoLibraries.source,
        platform: first.arduinoLibraries.platform,
        libraryCount: first.arduinoLibraries.libraryCount
      } : null,
      limitPerQuery: first.limit,
      cache,
      usageHint: '已在一次调用中按多个能力分组返回候选；使用附带 specs，或只对最终选中的 type 调用 mixly_get_block_specs。',
      advisory: snapshot.advisory
    };
  } else {
    result = formatLibraryScan(snapshot, args, cache);
  }

  if (args.includeSpecs === true) {
    const specTypes = (result.availableBlockTypes || []).slice(0, 20);
    const resolved = specTypes.length ? await getBlockSpecs({
      board: args.board,
      blockTypes: specTypes,
      includeExamples: false,
      includeSource: false,
      cdpPort: args.cdpPort,
      refresh: args.refresh
    }) : { specs: [], unknownTypes: [], cache: null };
    result = {
      ...result,
      specs: resolved.specs.map((spec) => ({
        type: spec.type,
        owner: spec.owner,
        contract: spec.contract,
        defaultXml: spec.defaultXml
      })),
      specTypes,
      unknownSpecTypes: resolved.unknownTypes,
      specsTruncated: (result.availableBlockTypes || []).length > specTypes.length,
      specsCache: resolved.cache
    };
  }
  return result;
}

function analyzeSource(args) {
  const source = readSource(args);
  const language = args.language || (
    /^\s*(?:from\s+[A-Za-z0-9_.]+\s+import\s+|import\s+[A-Za-z0-9_.]+|def\s+\w+\s*\()/m.test(source) &&
    !/^\s*#include/m.test(source)
      ? 'Python'
      : 'C/C++'
  );
  const includes = unique([...source.matchAll(/^\s*#include\s*[<"]([^>"]+)[>"]/gm)].map((m) => m[1]));
  const imports = unique([
    ...[...source.matchAll(/^\s*import\s+([^#\r\n]+)/gm)].map((m) => m[1].trim()),
    ...[...source.matchAll(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+([^#\r\n]+)/gm)]
      .map((m) => `from ${m[1]} import ${m[2].trim()}`)
  ]);
  const defines = [...source.matchAll(/^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/gm)]
    .map((m) => ({ name: m[1], value: m[2].trim() }));
  const pythonConstants = [...source.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*([^#\r\n]+)$/gm)]
    .map((m) => ({ name: m[1], value: m[2].trim() }));
  const cppFunctions = [...source.matchAll(
    /^\s*(?:static\s+)?(?:const\s+)?[A-Za-z_][\w:*&<> ]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^;{}]*)\)\s*\{/gm
  )].map((m) => ({ name: m[1], signature: m[2].trim() }));
  const pythonFunctions = [...source.matchAll(/^\s*def\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(([^)]*)\)\s*:/gmu)]
    .map((m) => ({ name: m[1], signature: m[2].trim() }));
  const functions = unique([...cppFunctions, ...pythonFunctions].map((item) => JSON.stringify(item)))
    .map((item) => JSON.parse(item));
  const constants = [...defines, ...pythonConstants];
  const pins = constants.filter((item) => /PIN|LED|BTN|BUTTON|SENSOR|GPIO/i.test(item.name));
  return {
    language,
    includes,
    imports,
    defines: constants,
    pins,
    functions,
    capabilities: {
      neopixel: /Adafruit_NeoPixel|NeoPixel|neopixel|WS2812/i.test(source),
      oled: /SSD1306|U8g2/i.test(source),
      temperatureHumidity: /\bDHT\b|AHTX0|AHT20|AHT10/i.test(source),
      serial: /Serial\s*\.|\bUART\s*\(/.test(source),
      digitalInput: /digitalRead\s*\(|\.value\s*\(\s*\)/.test(source),
      digitalOutput: /digitalWrite\s*\(|\.value\s*\([^)]/.test(source),
      analogInput: /analogRead\s*\(|\bADC\s*\(/.test(source),
      timing: /millis\s*\(|delay\s*\(|sleep(?:_ms)?\s*\(/.test(source),
      cStringBuffer: /char\s+\w+\s*\[[^\]]+\]|strcmp\s*\(|strncmp\s*\(/.test(source),
      procedures: functions.length
    },
    sourceLength: source.length
  };
}

function safeLibraryRelativePath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || path.isAbsolute(normalized)) {
    fail(`积木库附加文件路径不安全: ${relativePath}`);
  }
  if (!/^(?:css|language|media|libraries|examples)\/|^README(?:\.[A-Za-z0-9_-]+)*$/i.test(normalized)) {
    fail(`附加文件只允许放入 css/language/media/libraries/examples 或 README: ${normalized}`);
  }
  return normalized;
}

function validateLibraryJavaScript(source, label) {
  try { new Function(source); } catch (error) { // eslint-disable-line no-new-func
    fail(`${label} JavaScript 语法错误: ${error.message}`);
  }
}

function mixly4BoardStorageKey(board) {
  const value = String(board && (board.id || board.boardType) || 'board').trim();
  // Keep the key readable while preventing board ids such as extend/foo from
  // escaping the staging root or colliding with arbitrary path components.
  return value.replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'board';
}

function mixly4StagingLibraryPath(board, libraryName) {
  return path.join(MIXLY4_STAGING_DIR, 'libraries', mixly4BoardStorageKey(board), libraryName);
}

function mixly4LegacyStagingLibraryPath(libraryName) {
  // Early development builds used a board-independent staging directory.  It
  // is harmless to read it for packaging and makes upgrades non-destructive.
  return path.join(MIXLY4_STAGING_DIR, 'libraries', libraryName);
}

function mixly4LibrarySourceCandidates(board, libraryName) {
  const candidates = [mixly4StagingLibraryPath(board, libraryName)];
  const legacy = mixly4LegacyStagingLibraryPath(libraryName);
  if (!candidates.includes(legacy)) candidates.push(legacy);
  return candidates;
}

function safePluginRelativePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) return null;
  return normalized;
}

function normalizeMixly4PluginMetadata(info, fallbackName) {
  const source = info && typeof info === 'object' ? info : {};
  const omitted = new Set([
    'installed', 'installedAt', 'updatedAt', 'installedFiles', 'libraryFiles', 'exampleFiles',
    'indexFile', 'entryScriptFiles', 'entryStyleFiles', 'entrySourceMapFiles',
    'entrySourceMapMap', 'indexXml', 'indexXmlData', 'packageFilesMap', 'packageFileGroups'
  ]);
  const metadata = {};
  for (const [key, value] of Object.entries(source)) {
    if (omitted.has(key) || value === undefined) continue;
    metadata[key] = value;
  }
  const id = String(source.id || fallbackName || '').trim();
  const version = String(source.currentVersion || source.version || source.latestVersion || '1.0.0').trim();
  return {
    ...metadata,
    id,
    // Mixly 4 mounts MicroPython plugin libraries from
    // <storageRoot>/<dir>/<currentVersion>/libraries while PluginManager
    // stores files under the id, so dir must default to the id.
    dir: String(source.dir || id).trim() || id,
    name: source.name || id,
    displayName: source.displayName || source.title || source.name || id,
    version,
    latestVersion: source.latestVersion || version,
    versions: Array.isArray(source.versions) && source.versions.length ? source.versions : [version],
    source: source.source || 'local',
    local: source.local !== false
  };
}

function mixly4StagingResources(board) {
  const roots = [mixly4StagingLibraryPath(board, '')];
  const legacyRoot = path.join(MIXLY4_STAGING_DIR, 'libraries');
  const resources = [];
  const seen = new Set();
  const appendDirectory = (libraryPath, name) => {
    const key = String(name).toLowerCase();
    if (seen.has(key) || !fs.existsSync(libraryPath) || !fs.statSync(libraryPath).isDirectory()) return;
    const entryFiles = filesRecursive(libraryPath).filter((filePath) => fs.statSync(filePath).isFile());
    if (!entryFiles.length) return;
    seen.add(key);
    const metadataPath = path.join(libraryPath, 'plugin.json');
    const metadata = readJsonFile(metadataPath) || {};
    resources.push({
      name,
      owner: `Plugin/${name}`,
      source: 'mixly4-staging',
      installed: false,
      path: libraryPath,
      metadata: normalizeMixly4PluginMetadata(metadata, name),
      fileList: entryFiles.map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/')).sort()
    });
  };
  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) appendDirectory(path.join(root, entry.name), entry.name);
    }
  }
  // Early Mixly 4 MCP builds used libraries/<name> without a board key. Only
  // accept directories that look like plugin roots so board-key directories
  // are not accidentally reported as libraries.
  if (fs.existsSync(legacyRoot) && fs.statSync(legacyRoot).isDirectory()) {
    for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(legacyRoot, entry.name);
      if (!fs.existsSync(path.join(candidate, 'index.xml')) && !fs.existsSync(path.join(candidate, 'plugin.json'))) continue;
      appendDirectory(candidate, entry.name);
    }
  }
  return resources.sort((left, right) => left.name.localeCompare(right.name));
}

function filesystemThirdPartyResources(boardRoot) {
  const thirdPartyRoot = path.join(boardRoot, 'libraries', 'ThirdParty');
  if (!fs.existsSync(thirdPartyRoot) || !fs.statSync(thirdPartyRoot).isDirectory()) return [];
  return fs.readdirSync(thirdPartyRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const libraryPath = path.join(thirdPartyRoot, entry.name);
      return {
        name: entry.name,
        owner: `ThirdParty/${entry.name}`,
        source: 'filesystem',
        installed: true,
        path: libraryPath,
        metadata: readJsonFile(path.join(libraryPath, 'config.json')) || {},
        fileList: filesRecursive(libraryPath)
          .filter((filePath) => fs.statSync(filePath).isFile())
          .map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/')).sort()
      };
    }).sort((left, right) => left.name.localeCompare(right.name));
}

function mixly4OpfsSnapshotExpression(board, options = {}) {
  const root = `plugins/libraries/${String(board.boardType || board.id || '').replace(/^\/+/, '')}`;
  const mode = options.mode || 'analysis';
  const requestedNames = unique((options.libraryNames || []).map((name) => String(name).toLowerCase()));
  const maxBase64Bytes = Number(options.maxBase64Bytes || 128 * 1024 * 1024);
  return `(async()=>{
    const manager=(typeof Mixly==='object'&&(Mixly.PluginManager||Mixly.StatusBarPlugin))||null;
    if(!manager||!manager.fs)throw new Error('Mixly.PluginManager.fs is unavailable');
    const fsApi=manager.fs;
    const normalize=(value)=>String(value||'').split('\\\\').join('/').replace(/^\\/+/, '').replace(/\\/{2,}/g,'/');
    const root=normalize(${JSON.stringify(root)});
    const mode=${JSON.stringify(mode)};
    const requested=new Set(${JSON.stringify(requestedNames)});
    const manifestPath=root+'/installed.json';
    const manifestText=await fsApi.readFile(manifestPath,'utf8').catch(()=> '');
    if(!manifestText)return JSON.stringify({available:true,root,currentRoot:typeof manager.getStorageRoot==='function'?manager.getStorageRoot():null,manifestFound:false,schemaVersion:null,plugins:[]});
    let manifest;
    try{manifest=JSON.parse(manifestText)}catch(error){throw new Error('Invalid Mixly 4 installed.json: '+error.message)}
    const plugins=[];
    let transferred=0;
    const entries=Object.entries(manifest.plugins||{});
    for(const [manifestKey,rawValue] of entries){
      const raw=rawValue&&typeof rawValue==='object'?rawValue:{};
      const id=String(raw.id||manifestKey||'').trim();
      const aliases=[id,manifestKey,raw.name,raw.displayName].filter(Boolean).map((value)=>String(value).toLowerCase());
      if(requested.size&&![...requested].some((name)=>aliases.includes(name)))continue;
      const version=String(raw.currentVersion||raw.version||raw.latestVersion||'').trim();
      const versionRoot=normalize(root+'/'+id+(version?'/'+version:''));
      const storedGroups=[
        raw.installedFiles,raw.libraryFiles,raw.exampleFiles,
        raw.entryScriptFiles,raw.entryStyleFiles,raw.entrySourceMapFiles,
        Object.values(raw.packageFilesMap||{}),
        ...Object.values(raw.packageFileGroups||{})
      ];
      let stored=[...new Set(storedGroups.flatMap((group)=>Array.isArray(group)?group:[group])
        .filter((value)=>typeof value==='string').map(normalize).filter(Boolean))];
      if(!stored.length&&version){
        const listed=await fsApi.readDirectory(versionRoot,{recursive:true}).catch(()=>[]);
        for(const item of listed){
          const relative=normalize(typeof item==='string'?item:(item&&item.name));
          if(!relative)continue;
          const full=normalize(versionRoot+'/'+relative);
          const stat=await fsApi.stat(full).catch(()=>null);
          if(stat&&typeof stat.isFile==='function'&&stat.isFile())stored.push(full);
        }
      }
      const fileMap=new Map;
      for(const storedPath of stored){
        const full=normalize(storedPath);
        const prefix=versionRoot+'/';
        let relative=full.startsWith(prefix)?full.slice(prefix.length):full.split('/').pop();
        relative=normalize(relative);
        if(relative&&!relative.split('/').includes('..'))fileMap.set(relative,full);
      }
      if(raw.indexFile){
        const full=normalize(raw.indexFile);
        const relative=full.startsWith(versionRoot+'/')?full.slice(versionRoot.length+1):full.split('/').pop();
        if(relative)fileMap.set(normalize(relative),full);
      }
      const files=[...fileMap.keys()].sort();
      const content=[];
      for(const relative of files){
        const lower=relative.toLowerCase();
        const wanted=mode==='full'||(mode==='libraries'&&lower.startsWith('libraries/'))||
          (mode==='analysis'&&/\\.(?:xml|js|mjs|cjs|json|mix)$/i.test(relative));
        if(!wanted)continue;
        const encoded=await fsApi.readFile(fileMap.get(relative),'base64').catch(()=>null);
        if(encoded==null)continue;
        transferred+=encoded.length;
        if(transferred>${maxBase64Bytes})throw new Error('Mixly 4 OPFS snapshot exceeds transfer limit');
        content.push({relativePath:relative,contentBase64:encoded});
      }
      if(raw.indexXml&&!files.some((name)=>name.toLowerCase()==='index.xml')){
        files.push('index.xml');
        if(mode==='full'||mode==='analysis')content.push({relativePath:'index.xml',contentBase64:btoa(unescape(encodeURIComponent(String(raw.indexXml))))});
      }
      plugins.push({id,name:raw.name||id,version,metadata:raw,files:files.sort(),content});
    }
    return JSON.stringify({available:true,root,currentRoot:typeof manager.getStorageRoot==='function'?manager.getStorageRoot():null,manifestFound:true,schemaVersion:manifest.schemaVersion||1,plugins});
  })()`;
}

async function readMixly4OpfsSnapshot(board, args = {}, options = {}) {
  const cdpPort = getCdpPort(args);
  const cdp = await getCdpDiagnostics(cdpPort);
  if (!cdp.available) {
    return {
      available: false,
      reason: 'cdp-unavailable',
      cdpPort,
      cdp,
      root: `plugins/libraries/${board.boardType}`,
      plugins: []
    };
  }
  try {
    const evaluated = await evaluateCdp(mixly4OpfsSnapshotExpression(board, options), cdpPort);
    const value = evaluated.value;
    if (!value || value.available !== true || !Array.isArray(value.plugins)) {
      return { available: false, reason: 'invalid-opfs-response', cdpPort, cdp, root: null, plugins: [], raw: evaluated.raw };
    }
    return { ...value, cdpPort, cdp, reason: null };
  } catch (error) {
    return {
      available: false,
      reason: 'opfs-read-failed',
      cdpPort,
      cdp,
      root: `plugins/libraries/${board.boardType}`,
      plugins: [],
      error: error.message,
      details: error.details || null
    };
  }
}

function materializeMixly4Plugin(plugin, temporaryRoot) {
  const name = String(plugin.id || plugin.name || '').trim();
  const directoryName = name.replace(/[^A-Za-z0-9_.-]+/g, '_') || 'plugin';
  const pluginRoot = path.join(temporaryRoot, directoryName);
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const item of Array.isArray(plugin.content) ? plugin.content : []) {
    const relativePath = safePluginRelativePath(item.relativePath);
    if (!relativePath || typeof item.contentBase64 !== 'string') continue;
    const outputPath = path.join(pluginRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(item.contentBase64, 'base64'));
  }
  const metadata = normalizeMixly4PluginMetadata(plugin.metadata, name);
  const metadataPath = path.join(pluginRoot, 'plugin.json');
  if (!fs.existsSync(metadataPath)) fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const fileList = unique([
    ...(Array.isArray(plugin.files) ? plugin.files.map(safePluginRelativePath).filter(Boolean) : []),
    'plugin.json'
  ]).sort();
  return {
    name,
    owner: `Plugin/${name}`,
    source: 'mixly4-opfs',
    installed: true,
    version: plugin.version || metadata.version || null,
    path: pluginRoot,
    metadata,
    fileList
  };
}

async function thirdPartyLibraryContext(board, args = {}, options = {}) {
  const boardRoot = options.boardRoot || board.root;
  if (!isMixly4() || options.boardRoot) {
    return {
      resources: filesystemThirdPartyResources(boardRoot),
      storage: { kind: 'filesystem', available: true, root: path.join(boardRoot, 'libraries', 'ThirdParty') },
      cleanup() {}
    };
  }
  const staging = mixly4StagingResources(board);
  const snapshot = await readMixly4OpfsSnapshot(board, args, {
    mode: options.mode || 'analysis',
    libraryNames: options.libraryNames || []
  });
  let temporaryRoot = null;
  let installed = [];
  if (snapshot.available && snapshot.plugins.length) {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-mcp-opfs-'));
    installed = snapshot.plugins.map((plugin) => materializeMixly4Plugin(plugin, temporaryRoot));
  }
  const byName = new Map(staging.map((resource) => [resource.name.toLowerCase(), resource]));
  for (const resource of installed) {
    const key = resource.name.toLowerCase();
    const staged = byName.get(key);
    if (staged) resource.stagingPath = staged.path;
    byName.set(key, resource);
  }
  return {
    resources: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    storage: {
      kind: 'mixly4-opfs',
      available: snapshot.available,
      reason: snapshot.reason,
      root: snapshot.root,
      currentRoot: snapshot.currentRoot || null,
      manifestFound: snapshot.manifestFound === true,
      cdpPort: snapshot.cdpPort,
      installedPluginCount: installed.length,
      stagingRoot: path.join(MIXLY4_STAGING_DIR, 'libraries', mixly4BoardStorageKey(board)),
      stagingPluginCount: staging.length,
      materializedRoot: temporaryRoot,
      error: snapshot.error || null
    },
    cleanup() {
      if (temporaryRoot && fs.existsSync(temporaryRoot)) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  };
}

function isMixly4LibrarySource(sourceDir) {
  return isMixly4() && path.resolve(sourceDir).startsWith(path.resolve(MIXLY4_STAGING_DIR) + path.sep);
}

function stripLegacyLibraryDirectives(source) {
  return String(source || '')
    // Closure directives are meaningful in Mixly 2/3 but are not available
    // inside an ES module loaded by Mixly 4.
    .replace(/^\s*goog\.(?:provide|require)\s*\([^;]*\);?\s*$/gmi, '')
    .replace(/^\s*goog\.module\s*\([^;]*\);?\s*$/gmi, '')
    // A module wrapper supplies its own strict mode; retaining this directive
    // would be valid but makes generated files unnecessarily noisy.
    .replace(/^\s*["']use strict["'];\s*$/gmi, '')
    // Accept callers that already supplied an ES-module export.  The wrapper
    // below collects those values and emits one canonical export surface.
    .replace(/^\s*export\s+(?=(?:const|let|var|function|class)\b)/gmi, '')
    .replace(/^\s*export\s+default\s+/gmi, '')
    .trim();
}

function mixly4GeneratorNames(board) {
  const language = String(board && board.language || '').toLowerCase();
  if (language.includes('micro')) return ['MicroPython', 'Python', 'generator', 'Arduino'];
  if (language.includes('python')) return ['Python', 'MicroPython', 'generator', 'Arduino'];
  return ['Arduino', 'generator', 'MicroPython', 'Python'];
}

function mixly4IndexXml(toolboxXml, normalizedExtras) {
  let body = String(toolboxXml || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*\/?\s*>/gi, '')
    .trim();
  // PluginManager reads direct child <category> nodes.  Most Mixly 2/3
  // toolboxes are wrapped in <xml> (or <toolbox>), so unwrap exactly one
  // outer container before writing the Mixly 4 index file.
  const wrapped = /^<(?:xml|toolbox)\b[^>]*>([\s\S]*)<\/(?:xml|toolbox)>$/i.exec(body);
  if (wrapped) body = wrapped[1].trim();
  const cssLinks = normalizedExtras
    .filter((item) => /^css\/.*\.css$/i.test(item.relativePath))
    .map((item) => `<link rel="stylesheet" type="text/css" href="./${item.relativePath}">`);
  return [
    '<!-- Mixly 4 plugin toolbox; scripts are loaded as an ES module. -->',
    '<script type="module" src="./index.js"></script>',
    ...cssLinks,
    body
  ].filter((line) => line !== '').join('\n') + '\n';
}

function mixly4PluginIndexJs({ blocksJs, generatorsJs, blockTypes, generatorTypes, board, wasmSketchFiles = [] }) {
  const blockSource = stripLegacyLibraryDirectives(blocksJs);
  const generatorSource = stripLegacyLibraryDirectives(generatorsJs);
  const names = mixly4GeneratorNames(board);
  const namesLiteral = JSON.stringify(names);
  const blockTypesLiteral = JSON.stringify(unique(blockTypes));
  const generatorTypesLiteral = JSON.stringify(unique(generatorTypes));
  const wasmSketchFilesLiteral = JSON.stringify(Object.fromEntries(
    wasmSketchFiles.map((item) => [item.name, item.content.toString('utf8')])
  ));
  // The generated module deliberately provides a small compatibility bridge:
  // existing Mixly 2/3 sources can continue assigning Blockly.Blocks and
  // Blockly.Arduino.forBlock, while Mixly 4 receives plain exported maps.
  return `/* Generated by Mixly Local MCP for Mixly 4. */
const __globalBlockly = globalThis.Blockly || {};
let __activeGenerator = null;
const __dynamicGeneratorKeys = new Set([
  'definitions_', 'setups_', 'setups_begin_', 'setups_end_', 'libs_',
  'loops_begin_', 'loops_end_', 'variableDB_', 'nameDB_'
]);
function __makeGenerator(name) {
  const base = (__globalBlockly && (__globalBlockly[name] || __globalBlockly.generator)) || {};
  const registry = Object.assign(Object.create(base.forBlock || null), base.forBlock || {});
  const target = Object.assign(Object.create(base), base);
  target.forBlock = registry;
  return new Proxy(target, {
    get(target, key, receiver) {
      if (key === 'forBlock') return registry;
      if (__activeGenerator && __dynamicGeneratorKeys.has(key)) return __activeGenerator[key];
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' && __activeGenerator ? value.bind(__activeGenerator) : value;
    },
    set(target, key, value, receiver) {
      if (__activeGenerator && __dynamicGeneratorKeys.has(key)) {
        __activeGenerator[key] = value;
        return true;
      }
      return Reflect.set(target, key, value, receiver);
    }
  });
}
const __blocks = Object.assign(Object.create(__globalBlockly.Blocks || null), __globalBlockly.Blocks || {});
const __generators = Object.fromEntries(${namesLiteral}.map((name) => [name, __makeGenerator(name)]));
const __wasmSketchFiles = ${wasmSketchFilesLiteral};
const __wasmSourceNamesKey = '__mixlyMcpWasmSourceNames';
const __wasmFinishPatchedKey = '__mixlyMcpWasmFinishPatched';
function __installWasmSketchFiles(generator) {
  if (!generator || !Object.keys(__wasmSketchFiles).length) return;
  if (!generator.libs_ || typeof generator.libs_ !== 'object') generator.libs_ = {};
  for (const [name, source] of Object.entries(__wasmSketchFiles)) {
    if (generator.libs_[name] == null) generator.libs_[name] = source;
  }
  if (!generator[__wasmSourceNamesKey]) {
    Object.defineProperty(generator, __wasmSourceNamesKey, {
      value: new Set(), configurable: true
    });
  }
  for (const name of Object.keys(__wasmSketchFiles)) generator[__wasmSourceNamesKey].add(name);
  if (generator[__wasmFinishPatchedKey] || typeof generator.finish !== 'function') return;
  const originalFinish = generator.finish;
  Object.defineProperty(generator, __wasmFinishPatchedKey, {
    value: true, configurable: true
  });
  generator.finish = function (...args) {
    const saved = new Map();
    const libs = this.libs_;
    if (libs && typeof libs === 'object') {
      for (const name of this[__wasmSourceNamesKey] || []) {
        if (!Object.prototype.hasOwnProperty.call(libs, name)) continue;
        saved.set(name, libs[name]);
        delete libs[name];
      }
    }
    try {
      return originalFinish.apply(this, args);
    } finally {
      if (libs && typeof libs === 'object') {
        for (const [name, source] of saved) libs[name] = source;
      }
    }
  };
}
const __defineBlocksWithJsonArray = (definitions) => {
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (!definition || !definition.type) continue;
    const json = definition;
    __blocks[definition.type] = { init() { this.jsonInit(json); } };
  }
};
const Blockly = Object.assign({}, __globalBlockly, {
  Blocks: __blocks,
  Arduino: __generators.Arduino,
  Python: __generators.Python,
  MicroPython: __generators.MicroPython,
  generator: __generators.generator,
  defineBlocksWithJsonArray: __defineBlocksWithJsonArray,
  common: Object.assign({}, __globalBlockly.common || {}, { defineBlocksWithJsonArray: __defineBlocksWithJsonArray })
});
const goog = globalThis.goog || { provide() {}, require() {}, module() {} };
(() => {
${blockSource}
  if (typeof blocks !== 'undefined' && blocks && typeof blocks === 'object') Object.assign(__blocks, blocks);
  if (typeof blockDefinitions !== 'undefined' && Array.isArray(blockDefinitions)) __defineBlocksWithJsonArray(blockDefinitions);
})();
(() => {
${generatorSource}
  if (typeof generators !== 'undefined' && generators && typeof generators === 'object') {
    for (const name of ${namesLiteral}) Object.assign(__generators[name].forBlock, generators);
  }
})();
function __wrapGenerator(fn) {
  if (typeof fn !== 'function') return fn;
  return function (...args) {
    const previous = __activeGenerator;
    __activeGenerator = args[1] || null;
    try {
      __installWasmSketchFiles(__activeGenerator);
      return fn.apply(this, args);
    } finally { __activeGenerator = previous; }
  };
}
const __blockTypes = ${blockTypesLiteral};
const __generatorTypes = ${generatorTypesLiteral};
const __exportedBlocks = Object.fromEntries(__blockTypes.map((type) => [type, __blocks[type]]).filter(([, value]) => value));
const __exportedGenerators = Object.fromEntries(__generatorTypes.map((type) => {
  for (const name of ${namesLiteral}) {
    const target = __generators[name];
    if (target && typeof target.forBlock?.[type] === 'function') return [type, __wrapGenerator(target.forBlock[type])];
    if (target && typeof target[type] === 'function') return [type, __wrapGenerator(target[type])];
  }
  return [type, undefined];
}).filter(([, value]) => value));
export { __exportedBlocks as blocks, __exportedGenerators as generators };
`;
}

function validateMixly4Module(source, label) {
  const temporary = path.join(os.tmpdir(), `mixly4-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  try {
    fs.writeFileSync(temporary, source, 'utf8');
    const result = spawnSync(process.execPath, ['--check', temporary], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000
    });
    if (result.error || result.status !== 0) {
      fail(`${label} Mixly 4 ES 模块语法错误`, {
        stderr: String(result.stderr || ''),
        stdout: String(result.stdout || ''),
        error: result.error ? result.error.message : null
      });
    }
  } finally {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort */ }
  }
}

function createLibrary(args) {
  const board = getBoard(args.board);
  const libraryName = args.libraryName;
  const mixly4 = isMixly4();
  const destination = mixly4
    ? mixly4StagingLibraryPath(board, libraryName)
    : path.join(board.root, 'libraries', 'ThirdParty', libraryName);
  const layout = args.layout || 'standard';
  const xmlFileName = mixly4
    ? 'index.xml'
    : (args.xmlFileName || (layout === 'standard' ? 'index.xml' : `${libraryName.toLowerCase()}.xml`));
  if (fs.existsSync(destination) && args.overwrite !== true) {
    fail(`积木库已存在；如需更新请显式传 overwrite=true: ${destination}`);
  }

  validateLibraryJavaScript(args.blocksJs, 'blocksJs');
  validateLibraryJavaScript(args.generatorsJs, 'generatorsJs');
  const warnings = [];
  if (/\.set(?:Check|Output)\([^\n)]*["'](?:Number|Boolean|String)["']/.test(args.blocksJs)) {
    warnings.push('Blockly 类型检查建议使用 Number/Boolean/String 构造器，不要使用同名字符串');
  }
  if (/\bvoid\s+(?:setup|loop)\s*\(/.test(args.generatorsJs)) {
    warnings.push('生成器包含完整 setup() 或 loop()；建议优先用本地 setup/循环/函数积木组合');
  }
  const variableFieldReads = [...args.generatorsJs.matchAll(/getFieldValue\(\s*['"]VAR['"]\s*\)/g)].length;
  const escapedVariableReads = [...args.generatorsJs.matchAll(
    /(?:variableDB_|nameDB_)\.getName\s*\(\s*[A-Za-z_$][\w$]*\.getFieldValue\(\s*['"]VAR['"]\s*\)/g
  )].length;
  if (variableFieldReads > escapedVariableReads) {
    warnings.push(`生成器有 ${variableFieldReads - escapedVariableReads} 处直接读取 VAR；变量名必须通过 variableDB_.getName/nameDB_.getName 转成目标语言合法标识符，尤其要覆盖中文变量`);
  }

  const blockTypes = extractBlockTypes(args.blocksJs);
  const generatorTypes = extractGeneratorTypes(args.generatorsJs);
  const toolboxTypes = toolboxBlockTypes(args.toolboxXml);
  if (!blockTypes.length || !generatorTypes.length || !toolboxTypes.length) {
    fail('积木库必须同时包含块定义、目标语言生成器和工具箱 block 条目');
  }
  const missingDefinitions = toolboxTypes.filter((type) => !blockTypes.includes(type));
  const missingGenerators = toolboxTypes.filter((type) => !generatorTypes.includes(type));
  if (missingDefinitions.length || missingGenerators.length) {
    fail('积木库定义不完整', { missingDefinitions, missingGenerators });
  }

  const primitiveReasons = Array.isArray(args.primitiveReasons) ? args.primitiveReasons : [];
  const reasonByType = new Map(primitiveReasons.map((item) => [item && item.type, item]));
  const invalidReasons = toolboxTypes.filter((type) => {
    const item = reasonByType.get(type);
    return !item || typeof item.reason !== 'string' || item.reason.trim().length < 8 ||
      !Array.isArray(item.officialCandidatesChecked) || !item.officialCandidatesChecked.length;
  });
  if (invalidReasons.length) {
    warnings.push(`以下自定义块没有记录本地候选核对信息，可先扫描官方和 ThirdParty 积木再决定是否复用: ${invalidReasons.join(', ')}`);
  }

  const emittedFunctions = [...args.generatorsJs.matchAll(
    /\b(?:void|bool|boolean|char|int|float|double|String|uint\d+_t|unsigned\s+long)\s+[A-Za-z_]\w*\s*\([^;{}]*\)\s*\{/g
  )].length;
  if (emittedFunctions > Math.max(2, toolboxTypes.length)) {
    warnings.push(`生成器中检测到 ${emittedFunctions} 个函数、工具箱只有 ${toolboxTypes.length} 个类型；可考虑把业务逻辑拆成更多本地积木`);
  }

  const extraFiles = Array.isArray(args.extraFiles) ? args.extraFiles : [];
  const normalizedExtras = extraFiles.map((item) => {
    if (!item || typeof item !== 'object') fail('extraFiles 每项必须是对象');
    const relativePath = safeLibraryRelativePath(item.relativePath);
    const hasText = typeof item.text === 'string';
    const hasBase64 = typeof item.contentBase64 === 'string';
    if (hasText === hasBase64) fail(`附加文件必须且只能提供 text 或 contentBase64: ${relativePath}`);
    return {
      relativePath,
      content: hasText ? Buffer.from(item.text, 'utf8') : Buffer.from(item.contentBase64, 'base64')
    };
  });
  const imageMode = args.imageMode || 'none';
  const wasmSketchFiles = (Array.isArray(args.wasmSketchFiles) ? args.wasmSketchFiles : []).map((item, index) => {
    if (!item || typeof item !== 'object') fail(`wasmSketchFiles[${index}] 必须是对象`);
    const name = String(item.name || '').trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}\.(?:h|hpp|c|cc|cpp)$/i.test(name) || /[\\/]/.test(name)) {
      fail(`wasmSketchFiles[${index}].name 必须是无目录的 C/C++ 文件名: ${name}`);
    }
    const hasText = typeof item.text === 'string';
    const hasBase64 = typeof item.contentBase64 === 'string';
    if (hasText === hasBase64) fail(`wasmSketchFiles[${index}] 必须且只能提供 text 或 contentBase64`);
    return {
      name,
      content: hasText ? Buffer.from(item.text, 'utf8') : Buffer.from(item.contentBase64, 'base64')
    };
  });
  const duplicateWasmNames = wasmSketchFiles
    .map((item) => item.name.toLowerCase())
    .filter((name, index, values) => values.indexOf(name) !== index);
  if (duplicateWasmNames.length) fail(`wasmSketchFiles 文件名重复: ${unique(duplicateWasmNames).join(', ')}`);
  if (wasmSketchFiles.length && !mixly4) {
    warnings.push('wasmSketchFiles 仅在 Mixly 4 插件模块中注入；旧版 Mixly 请同时通过 extraFiles 提供 Arduino libraries。');
  }
  const sourceUsesImages = /Field(?:Image|Bitmap)|FieldGridDropdown|image[_-]?properties/i.test(args.blocksJs);
  const hasMediaImages = normalizedExtras.some((item) =>
    item.relativePath.startsWith('media/') && /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(item.relativePath)
  );
  if ((imageMode !== 'none' || sourceUsesImages || hasMediaImages) && args.userRequestedImages !== true) {
    warnings.push('检测到图片字段或媒体文件，但没有记录 userRequestedImages=true；请确认用户是否需要图片');
  }
  if (args.userRequestedImages === true && imageMode === 'none' && (sourceUsesImages || hasMediaImages)) {
    warnings.push('已记录用户需要图片，但 imageMode 仍为 none；建议标明 block-icon 或 dropdown-options');
  }

  const slug = libraryName.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const files = new Map();
  if (mixly4) {
    if (args.xmlFileName && args.xmlFileName !== 'index.xml') {
      warnings.push('Mixly 4 PluginManager 只识别根部 index.xml，已忽略自定义 xmlFileName');
    }
    if (layout === 'flat') warnings.push('Mixly 4 使用插件布局，已忽略 layout=flat');
    const pluginVersion = String(args.version || '1.0.0');
    const pluginXml = mixly4IndexXml(args.toolboxXml, normalizedExtras);
    const pluginJs = mixly4PluginIndexJs({
      blocksJs: args.blocksJs,
      generatorsJs: args.generatorsJs,
      blockTypes: toolboxTypes,
      generatorTypes,
      board,
      wasmSketchFiles
    });
    validateMixly4Module(pluginJs, 'index.js');
    const pluginMetadata = {
      id: libraryName,
      // dir mirrors id: the MicroPython uploader resolves installed library
      // directories through manifest.dir, not through the id-based path that
      // PluginManager writes to.
      dir: libraryName,
      name: libraryName,
      displayName: libraryName,
      version: pluginVersion,
      latestVersion: pluginVersion,
      versions: [pluginVersion],
      source: 'local',
      local: true,
      // Mixly 4's default rules already copy these two directories.  Keeping
      // the declaration explicit makes the ZIP self-describing and lets a
      // future PluginManager retain additional media/language files.
      storageRules: [
        { type: 'directory', source: 'libraries', listKey: 'libraryFiles' },
        { type: 'directory', source: 'examples', listKey: 'exampleFiles' },
        { type: 'directory', source: 'media' },
        { type: 'directory', source: 'language' }
      ],
      mixly: { generation: 4, board: board.id }
    };
    files.set('index.xml', Buffer.from(pluginXml, 'utf8'));
    files.set('index.js', Buffer.from(pluginJs, 'utf8'));
    files.set('plugin.json', Buffer.from(`${JSON.stringify(pluginMetadata, null, 2)}\n`, 'utf8'));
  } else if (layout === 'standard') {
    const toolboxBody = args.toolboxXml
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<link\b[^>]*\/?\s*>/gi, '')
      .trim();
    const languageScripts = normalizedExtras
      .filter((item) => /^language\/.*\.js$/i.test(item.relativePath))
      .map((item) => `<script type="text/javascript" src="./${item.relativePath}"></script>`);
    const cssLinks = normalizedExtras
      .filter((item) => /^css\/.*\.css$/i.test(item.relativePath))
      .map((item) => `<link rel="stylesheet" type="text/css" href="./${item.relativePath}"></link>`);
    const indexSource = [
      ...cssLinks,
      ...languageScripts,
      `<script type="text/javascript" src="./block/${slug}.js"></script>`,
      `<script type="text/javascript" src="./generator/${slug}.js"></script>`,
      '', toolboxBody, ''
    ].join('\n');
    files.set(`block/${slug}.js`, Buffer.from(args.blocksJs, 'utf8'));
    files.set(`generator/${slug}.js`, Buffer.from(args.generatorsJs, 'utf8'));
    files.set(xmlFileName, Buffer.from(indexSource, 'utf8'));
    files.set('config.json', Buffer.from(`${JSON.stringify({ version: args.version || '1.0.0' }, null, 2)}\n`, 'utf8'));
  } else {
    files.set('blocks.js', Buffer.from(args.blocksJs, 'utf8'));
    files.set('generators.js', Buffer.from(args.generatorsJs, 'utf8'));
    files.set(xmlFileName, Buffer.from(args.toolboxXml, 'utf8'));
  }
  for (const item of normalizedExtras) files.set(item.relativePath, item.content);

  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(temporary, { recursive: true });
  try {
    for (const [relativePath, content] of files) {
      const outputPath = path.join(temporary, relativePath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, content);
    }
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  invalidateDiscoveryCaches();
  return {
    libraryName,
    board: board.id,
    destination,
    layout,
    format: mixly4 ? 'mixly4-plugin-staging' : 'mixly-legacy',
    staging: mixly4,
    files: [...files.keys()].sort(),
    wasmSketchFiles: wasmSketchFiles.map((item) => ({ name: item.name, bytes: item.content.length })),
    blockTypes,
    imageMode,
    warnings,
    compatibilityChecks: {
      javascriptSyntax: 'passed',
      definitionGeneratorToolboxCoverage: 'passed',
      advisoryCount: warnings.length
    }
  };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function appendTreeNext(head, next) {
  if (!head) return next;
  let tail = head;
  const seen = new Set();
  while (tail.next && !seen.has(tail)) {
    seen.add(tail);
    tail = tail.next.block || tail.next;
  }
  tail.next = next;
  return head;
}

function projectTreeNodeEntries(tree) {
  const entries = [];
  const seen = new Set();
  let nextId = 0;

  function visit(node, nodePath) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const diagnosticId = node.id || `mcp-${++nextId}`;
    entries.push({ node, path: nodePath, id: diagnosticId });

    for (const [name, connection] of Object.entries(node.values || {})) {
      if (!connection || typeof connection !== 'object') continue;
      if (connection.shadow) visit(connection.shadow, `${nodePath}.values.${name}.shadow`);
      if (connection.block) visit(connection.block, `${nodePath}.values.${name}.block`);
      if (!connection.shadow && !connection.block) visit(connection, `${nodePath}.values.${name}`);
    }
    for (const [name, connection] of Object.entries(node.statements || {})) {
      if (!connection || typeof connection !== 'object') continue;
      const hasBlockWrapper = Boolean(connection.block);
      visit(connection.block || connection, `${nodePath}.statements.${name}${hasBlockWrapper ? '.block' : ''}`);
    }
    if (node.next && typeof node.next === 'object') {
      const hasBlockWrapper = Boolean(node.next.block);
      visit(node.next.block || node.next, `${nodePath}.next${hasBlockWrapper ? '.block' : ''}`);
    }
  }

  for (let index = 0; index < (tree.blocks || []).length; index++) {
    visit(tree.blocks[index], `blocks[${index}]`);
  }
  return entries;
}

function mutationAttribute(mutation, name) {
  if (!mutation) return undefined;
  if (typeof mutation === 'string') {
    const tag = (mutation.match(/<mutation\b[^>]*>/i) || [])[0];
    return tag ? markupAttributes(tag)[name] : undefined;
  }
  if (mutation.xml) {
    const tag = (String(mutation.xml).match(/<mutation\b[^>]*>/i) || [])[0];
    return tag ? markupAttributes(tag)[name] : undefined;
  }
  if (mutation[name] != null) return mutation[name];
  return mutation.attributes && mutation.attributes[name];
}

function mutationXmlWithAttributes(source, attributes = {}, removeNames = []) {
  return String(source).replace(/<mutation\b([^>]*?)(\/?)>/i, (tag, body, selfClosing) => {
    let updated = body;
    for (const name of removeNames) {
      const pattern = new RegExp(`\\s+${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
      updated = updated.replace(pattern, '');
    }
    for (const [name, value] of Object.entries(attributes)) {
      const pattern = new RegExp(`\\s+${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
      updated = updated.replace(pattern, '');
      updated += ` ${name}="${xmlEscape(value)}"`;
    }
    return `<mutation${updated}${selfClosing}>`;
  });
}

function inferControlsIfMutation(node, diagnostic) {
  if (!node || node.type !== 'controls_if') return;
  const connectionNames = [
    ...Object.entries(node.values || {})
      .filter(([, connection]) => Boolean(connection))
      .map(([name]) => name),
    ...Object.entries(node.statements || {})
      .filter(([, connection]) => Boolean(connection))
      .map(([name]) => name)
  ];
  const branchIndexes = connectionNames
    .map((name) => /^(?:IF|DO)(\d+)$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const inferredElseIf = branchIndexes.length ? Math.max(...branchIndexes) : 0;
  const presentIndexes = new Set(branchIndexes);
  const missingIndexes = Array.from({ length: inferredElseIf }, (_, index) => index + 1)
    .filter((index) => !presentIndexes.has(index));
  if (missingIndexes.length) {
    fail('controls_if 分支编号不连续，会生成空的中间分支', {
      node: diagnostic || { id: node.id || null, type: node.type },
      missingIndexes,
      suppliedConnections: connectionNames.sort(),
      writePrevented: true
    });
  }
  const hasElse = Boolean(node.statements && node.statements.ELSE);

  const attributes = {};
  if (inferredElseIf) {
    attributes.elseif = inferredElseIf;
  }
  if (hasElse) attributes.else = 1;

  if (typeof node.mutation === 'string') {
    if (/<mutation\b/i.test(node.mutation)) {
      node.mutation = mutationXmlWithAttributes(node.mutation, attributes, ['elseif', 'else']);
    } else if (Object.keys(attributes).length) {
      node.mutation = { attributes };
    } else {
      delete node.mutation;
    }
  } else if (node.mutation && node.mutation.xml) {
    node.mutation = {
      ...node.mutation,
      xml: mutationXmlWithAttributes(node.mutation.xml, attributes, ['elseif', 'else'])
    };
  } else if (node.mutation && typeof node.mutation === 'object') {
    const mutation = { ...node.mutation };
    delete mutation.elseif;
    delete mutation.else;
    const nestedAttributes = { ...(mutation.attributes || {}) };
    delete nestedAttributes.elseif;
    delete nestedAttributes.else;
    Object.assign(nestedAttributes, attributes);
    if (Object.keys(nestedAttributes).length) mutation.attributes = nestedAttributes;
    else delete mutation.attributes;
    Object.assign(mutation, attributes);
    if (!Object.keys(attributes).length) {
      delete mutation.elseif;
      delete mutation.else;
    }
    node.mutation = Object.keys(mutation).length ? mutation : undefined;
  } else if (Object.keys(attributes).length) {
    node.mutation = { ...attributes };
  } else {
    delete node.mutation;
  }
}

function normalizeProjectTree(tree) {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) fail('工程树必须是 JSON 对象');
  const cloned = JSON.parse(JSON.stringify(tree));
  const blocks = cloned.blocks || cloned.topBlocks;
  if (!Array.isArray(blocks) || !blocks.length) fail('工程树必须包含非空 blocks 或 topBlocks 数组');

  const globalDeclarations = blocks.filter((node) => node && node.type === 'variables_declare');
  const others = blocks.filter((node) => !node || node.type !== 'variables_declare');
  if (globalDeclarations.length) {
    let declarationStack = globalDeclarations[0];
    for (const declaration of globalDeclarations.slice(1)) declarationStack = appendTreeNext(declarationStack, declaration);
    blocks.splice(0, blocks.length, declarationStack, ...others);
  }

  let procedureIndex = 0;
  let generalIndex = 0;
  for (const node of blocks) {
    if (!node || typeof node !== 'object') fail('每个顶层积木必须是对象');
    if (node.type === 'variables_declare') {
      node.x = 20;
      node.y = 20;
    } else if (node.type === 'procedures_defnoreturn' || node.type === 'procedures_defreturn') {
      node.x = 1000 + procedureIndex * 1300;
      node.y = 20;
      procedureIndex++;
    } else if (node.type === 'base_setup') {
      node.x = 20;
      node.y = 850;
    } else {
      node.x = 20 + generalIndex * 1000;
      node.y = 2200;
      generalIndex++;
    }
  }
  cloned.blocks = blocks;
  delete cloned.topBlocks;
  for (const { node, id, path: nodePath } of projectTreeNodeEntries(cloned)) {
    inferControlsIfMutation(node, { type: node.type, id, path: nodePath });
  }
  return cloned;
}

function serializeMutation(mutation) {
  if (!mutation) return '';
  if (typeof mutation === 'string') return mutation;
  if (mutation.xml) return String(mutation.xml);
  const reserved = new Set(['args', 'attributes', 'xml']);
  const attributes = { ...(mutation.attributes || {}) };
  for (const [name, value] of Object.entries(mutation)) {
    if (!reserved.has(name) && value != null && typeof value !== 'object') attributes[name] = value;
  }
  const attrText = Object.entries(attributes).map(([name, value]) => ` ${xmlEscape(name)}="${xmlEscape(value)}"`).join('');
  const args = Array.isArray(mutation.args) ? mutation.args : [];
  const argXml = args.map((arg) => {
    const item = typeof arg === 'string' ? { name: arg } : arg;
    const type = item.vartype ? ` vartype="${xmlEscape(item.vartype)}"` : '';
    return `<arg name="${xmlEscape(item.name)}"${type}></arg>`;
  }).join('');
  return `<mutation${attrText}>${argXml}</mutation>`;
}

function serializeProjectTree(tree) {
  let nextId = 0;
  const seenObjects = new Set();
  function serializeNode(node, forcedTag) {
    if (!node || typeof node !== 'object' || !node.type) fail('积木节点缺少 type');
    if (seenObjects.has(node)) fail(`积木树出现循环引用或重复节点: ${node.type}`);
    seenObjects.add(node);
    const tag = forcedTag || node.tag || 'block';
    if (tag !== 'block' && tag !== 'shadow') fail(`不支持的节点标签: ${tag}`);
    const id = node.id || `mcp-${++nextId}`;
    const attrs = [`type="${xmlEscape(node.type)}"`, `id="${xmlEscape(id)}"`];
    if (node.x != null) attrs.push(`x="${xmlEscape(node.x)}"`, `y="${xmlEscape(node.y == null ? 0 : node.y)}"`);
    let body = serializeMutation(node.mutation);
    for (const [name, value] of Object.entries(node.fields || {})) {
      const fieldValue = value && typeof value === 'object' && value.value != null ? value.value : value;
      body += `<field name="${xmlEscape(name)}">${xmlEscape(fieldValue)}</field>`;
    }
    for (const [name, connection] of Object.entries(node.values || {})) {
      if (!connection) continue;
      let content = '';
      if (connection.shadow) content += serializeNode(connection.shadow, 'shadow');
      if (connection.block) content += serializeNode(connection.block, 'block');
      if (!connection.shadow && !connection.block) content += serializeNode(connection, connection.tag || 'block');
      body += `<value name="${xmlEscape(name)}">${content}</value>`;
    }
    for (const [name, connection] of Object.entries(node.statements || {})) {
      if (!connection) continue;
      const child = connection.block || connection;
      body += `<statement name="${xmlEscape(name)}">${serializeNode(child, 'block')}</statement>`;
    }
    if (node.next) body += `<next>${serializeNode(node.next.block || node.next, 'block')}</next>`;
    return `<${tag} ${attrs.join(' ')}>${body}</${tag}>`;
  }
  const boardAttribute = tree.boardAttribute || tree.mixlyBoard || tree.board || '';
  const boardText = boardAttribute ? ` board="${xmlEscape(boardAttribute)}"` : '';
  const xml = `<xml version="Mixly 2.0 rc4"${boardText} xmlns="http://www.w3.org/1999/xhtml">${tree.blocks.map((node) => serializeNode(node, 'block')).join('')}</xml>`;
  return { xml, nodeCount: (xml.match(/<(?:block|shadow)\b/g) || []).length };
}

function decodeXmlText(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlAttributes(tag) {
  const attributes = {};
  for (const [name, value] of Object.entries(markupAttributes(tag))) {
    attributes[name] = decodeXmlText(value);
  }
  return attributes;
}

function parseProjectXml(projectXml) {
  if (typeof projectXml !== 'string' || !/^\s*<xml\b/i.test(projectXml)) fail('projectXml 必须以 <xml> 根节点开始');
  const stack = [];
  const blocks = [];
  const ids = [];
  const structureErrors = [];
  const tokens = projectXml.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue;
    if (!token.startsWith('<')) {
      const field = stack[stack.length - 1];
      if (field && field.name === 'field') field.text += token;
      continue;
    }
    if (/^<\//.test(token)) {
      const closingName = (token.match(/^<\/\s*([A-Za-z0-9_:.-]+)/) || [])[1];
      const entry = stack.pop();
      if (!entry || entry.name !== closingName) fail(`XML 标签没有正确闭合: ${token}`);
      if (entry.name === 'field' && entry.owner) {
        entry.owner.fields[entry.attributes.name || ''] = decodeXmlText(entry.text.trim());
      }
      if (entry.name === 'next' && entry.childBlocks !== 1) {
        structureErrors.push({
          code: 'INVALID_NEXT_CHILD_COUNT',
          owner: entry.ownerBlock ? { type: entry.ownerBlock.type, id: entry.ownerBlock.id } : null,
          childBlocks: entry.childBlocks
        });
      }
      continue;
    }
    if (/^<\?/.test(token) || /^<!/.test(token)) continue;
    const name = (token.match(/^<\s*([A-Za-z0-9_:.-]+)/) || [])[1];
    if (!name) continue;
    const attributes = xmlAttributes(token);
    const directParentEntry = stack[stack.length - 1] || null;
    const parentBlock = [...stack].reverse().find((entry) => entry.block)?.block || null;
    const parentConnectionEntry = [...stack].reverse().find((entry) =>
      entry.name === 'value' || entry.name === 'statement' || entry.name === 'next'
    );
    let connectionOwner = null;
    if (name === 'value' || name === 'statement' || name === 'next') {
      connectionOwner = directParentEntry && directParentEntry.block || null;
      if (!connectionOwner) {
        structureErrors.push({ code: 'CONNECTION_OUTSIDE_BLOCK', connection: name, input: attributes.name || null });
      } else {
        const key = name === 'next' ? 'next' : `${name}:${attributes.name || ''}`;
        if (connectionOwner._connectionKeys.has(key)) {
          structureErrors.push({
            code: name === 'next' ? 'DUPLICATE_NEXT' : 'DUPLICATE_CONNECTION',
            owner: { type: connectionOwner.type, id: connectionOwner.id },
            connection: name,
            input: attributes.name || null
          });
        }
        connectionOwner._connectionKeys.add(key);
      }
    }
    let block = null;
    if (name === 'block' || name === 'shadow') {
      const directConnection = directParentEntry &&
        (directParentEntry.name === 'value' || directParentEntry.name === 'statement' || directParentEntry.name === 'next')
        ? directParentEntry : null;
      if (directConnection) {
        directConnection.childBlocks += 1;
        if (directConnection.name === 'next' && name !== 'block') {
          structureErrors.push({ code: 'NEXT_REQUIRES_BLOCK', childTag: name });
        }
        if (directConnection.name === 'next' && directConnection.childBlocks > 1) {
          structureErrors.push({ code: 'NEXT_HAS_MULTIPLE_BLOCKS', childBlocks: directConnection.childBlocks });
        }
      } else if (parentBlock) {
        structureErrors.push({
          code: 'BLOCK_WITHOUT_CONNECTION',
          owner: { type: parentBlock.type, id: parentBlock.id },
          child: { type: attributes.type || '', id: attributes.id || '' }
        });
      }
      block = {
        tag: name,
        type: attributes.type || '',
        id: attributes.id || '',
        x: attributes.x == null ? null : Number(attributes.x),
        y: attributes.y == null ? null : Number(attributes.y),
        parent: parentBlock,
        parentConnection: parentBlock && parentConnectionEntry ? {
          kind: parentConnectionEntry.name,
          name: parentConnectionEntry.attributes.name || null
        } : null,
        fields: {},
        mutation: null,
        args: [],
        _connectionKeys: new Set()
      };
      blocks.push(block);
      if (block.id) ids.push(block.id);
    } else if (name === 'mutation' && parentBlock) {
      parentBlock.mutation = attributes;
    } else if (name === 'arg' && parentBlock) {
      parentBlock.args.push(attributes);
    }
    const selfClosing = /\/\s*>$/.test(token);
    if (!selfClosing) {
      stack.push({
        name,
        attributes,
        block,
        ownerBlock: connectionOwner,
        childBlocks: name === 'next' ? 0 : undefined,
        owner: name === 'field' ? parentBlock : null,
        text: name === 'field' ? '' : undefined
      });
    }
  }
  if (stack.length) fail(`XML 仍有未闭合标签: ${stack.map((entry) => entry.name).join(', ')}`);
  for (const block of blocks) delete block._connectionKeys;
  if (structureErrors.length) {
    fail('Blockly XML 连接结构无效；不要手写 .mix，请改用 mixly_build_project 的 tree/treePath', {
      code: 'MIXLY_XML_STRUCTURE_INVALID',
      structureErrors,
      hint: '<next> 必须直接位于前一个 block 内并包住唯一的下一个 block；结构树序列化会自动完成嵌套与 XML 转义。'
    });
  }
  const duplicateIds = unique(ids.filter((id, index) => ids.indexOf(id) !== index));
  return { blocks, duplicateIds, topBlocks: blocks.filter((block) => !block.parent && block.tag === 'block') };
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

function chineseNamingViolations(parsed) {
  const allowedShortNames = new Set(['i', 'j', 'k', 'x', 'y', 'z', 'r', 'g', 'b']);
  const violations = [];
  for (const block of parsed.blocks) {
    if (/^variables_(?:declare|get|set)$/.test(block.type)) {
      const name = block.fields.VAR;
      if (name && !hasChinese(name) && !allowedShortNames.has(name)) {
        violations.push({ kind: 'variable', name, blockType: block.type, id: block.id });
      }
    }
    if (/^procedures_def/.test(block.type)) {
      const name = block.fields.NAME;
      if (name && !hasChinese(name)) violations.push({ kind: 'procedure', name, blockType: block.type, id: block.id });
    }
    const procedureCallName = block.mutation && block.mutation.name;
    if (/^procedures_call/.test(block.type) && procedureCallName && !hasChinese(procedureCallName)) {
      violations.push({ kind: 'procedure-call', name: procedureCallName, blockType: block.type, id: block.id });
    }
    for (const arg of block.args) {
      if (arg.name && !hasChinese(arg.name) && !allowedShortNames.has(arg.name)) {
        violations.push({ kind: 'parameter', name: arg.name, blockType: block.type, id: block.id });
      }
    }
  }
  return violations;
}

function sourceForProject(args) {
  if (args.sourceText != null) return String(args.sourceText);
  if (!args.sourcePath) return null;
  const sourcePath = resolveInputPath(args.sourcePath, args.allowExternalSourcePath === true);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) fail(`源码文件不存在: ${sourcePath}`);
  return stripUtf8Bom(fs.readFileSync(sourcePath, 'utf8'));
}

async function projectCompatibility(args, projectXml) {
  const rootTag = (String(projectXml).match(/<xml\b[^>]*>/i) || [])[0] || '';
  const boardAttribute = markupAttributes(rootTag).board || '';
  const boardSelector = args.board || boardAttribute;
  if (!boardSelector) fail('无法从工程识别板卡；请显式传 board');
  const board = getBoard(boardSelector);
  const parsed = parseProjectXml(projectXml);
  const scanned = await scanLibrary({
    board: board.selectedProfile ? `${board.id}@${board.selectedProfile}` : board.id,
    cdpPort: args.cdpPort,
    full: true
  });
  const thirdPartyTypes = unique(scanned.thirdParty.flatMap((library) => library.customTypes));
  const installedTypes = new Set(scanned.availableBlockTypes || [...scanned.blockTypes, ...thirdPartyTypes]);
  const unknownTypes = unique(parsed.blocks.map((block) => block.type).filter((type) => !installedTypes.has(type)));
  const customPrefixes = Array.isArray(args.customPrefixes) ? args.customPrefixes : [];
  const customBlocks = parsed.blocks.filter((block) =>
    customPrefixes.some((prefix) => block.type.startsWith(prefix)) || thirdPartyTypes.includes(block.type)
  );
  const source = sourceForProject(args);
  const sourceAnalysis = source ? analyzeSource({ sourceText: source }) : null;
  const procedureDefinitions = parsed.blocks.filter((block) => /^procedures_def/.test(block.type));
  const topVariableDeclarations = parsed.topBlocks.filter((block) => block.type === 'variables_declare');
  const missingCoordinates = parsed.topBlocks.filter((block) => block.x == null || block.y == null)
    .map((block) => ({ type: block.type, id: block.id }));
  const duplicateCoordinates = [];
  const coordinateMap = new Map();
  for (const block of parsed.topBlocks.filter((item) => item.x != null && item.y != null)) {
    const key = `${block.x},${block.y}`;
    if (coordinateMap.has(key)) duplicateCoordinates.push([coordinateMap.get(key), block.id]);
    else coordinateMap.set(key, block.id);
  }
  const namingViolations = args.requireChineseNames === false ? [] : chineseNamingViolations(parsed);
  const compositionViolations = [];
  if (topVariableDeclarations.length > 1) {
    compositionViolations.push(`发现 ${topVariableDeclarations.length} 个断开的顶层变量声明；全局变量必须通过 next 连接成一个栈`);
  }
  if (sourceAnalysis && sourceAnalysis.sourceLength >= 600 && parsed.blocks.length < 20) {
    compositionViolations.push('原始源码较长但工程少于 20 个节点，疑似把完整程序封进少量黑盒块');
  }
  if (sourceAnalysis && sourceAnalysis.functions.filter((item) => !/^(?:setup|loop)$/.test(item.name)).length >= 3 && procedureDefinitions.length < 2) {
    compositionViolations.push('源码包含多个业务函数，但工程没有用足够的官方函数定义积木表达结构');
  }
  if (source && /\bif\s*\(/.test(source) && !parsed.blocks.some((block) => block.type === 'controls_if')) {
    compositionViolations.push('源码包含 if，但工程没有官方 controls_if 积木');
  }
  if (source && /\b(?:for|while)\s*\(/.test(source) && !parsed.blocks.some((block) => /^controls_(?:for|while)/.test(block.type))) {
    compositionViolations.push('源码包含循环，但工程没有官方循环积木');
  }
  const customRatio = parsed.blocks.length ? customBlocks.length / parsed.blocks.length : 0;
  if (sourceAnalysis && customBlocks.length && customRatio > 0.35) {
    compositionViolations.push(`自定义块占比 ${(customRatio * 100).toFixed(1)}%，没有体现官方本地积木优先`);
  }
  const errors = [];
  const warnings = [];
  if (unknownTypes.length) errors.push('使用了当前板卡官方目录和 ThirdParty 中都未安装的 block type');
  if (parsed.duplicateIds.length) warnings.push('存在重复 block/shadow id，建议重建唯一 id');
  if (missingCoordinates.length) warnings.push('顶层积木缺少稳定 x/y 坐标，建议补充布局坐标');
  if (duplicateCoordinates.length) warnings.push('多个顶层积木使用完全相同的坐标，建议重新布局');
  if (namingViolations.length) warnings.push('部分用户可见变量、函数或参数不是中文，可按用户偏好调整');
  warnings.push(...compositionViolations);
  return {
    board: board.id,
    boardProfile: board.selectedProfile || null,
    fqbn: board.fqbn || null,
    totalNodes: parsed.blocks.length,
    topLevelBlocks: parsed.topBlocks.length,
    topLevelTypes: parsed.topBlocks.map((block) => block.type),
    topVariableDeclarationStacks: topVariableDeclarations.length,
    procedureDefinitions: procedureDefinitions.length,
    customNodes: customBlocks.length,
    nativeNodes: parsed.blocks.length - customBlocks.length,
    customRatio,
    unknownTypes,
    duplicateIds: parsed.duplicateIds,
    missingCoordinates,
    duplicateCoordinates,
    namingViolations,
    compositionViolations,
    errors,
    warnings,
    passed: errors.length === 0,
    parsed
  };
}

function atomicWriteProject(projectPath, projectXml, overwrite) {
  const outputPath = ensureInsideWorkspace(projectPath);
  if (path.extname(outputPath).toLowerCase() !== '.mix') fail('projectPath 必须使用 .mix 后缀');
  if (fs.existsSync(outputPath) && overwrite !== true) fail(`工程已存在；如需覆盖请显式传 overwrite=true: ${outputPath}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, projectXml, 'utf8');
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
  fs.renameSync(temporary, outputPath);
  return outputPath;
}

async function saveProject(args) {
  const report = await projectCompatibility(args, args.projectXml);
  if (!report.passed) fail('Mixly 工程兼容性检查失败', { ...report, parsed: undefined });
  const projectPath = atomicWriteProject(args.projectPath, args.projectXml, args.overwrite);
  const livePreview = await previewProjectUpdate(args, projectPath);
  delete report.parsed;
  return { projectPath, livePreview, ...report };
}

async function validateProjectTreeConnections(tree, boardSelector) {
  const entries = projectTreeNodeEntries(tree);
  const requestedTypes = unique(entries.map(({ node }) => node.type).filter(Boolean));
  const specs = [];
  for (let index = 0; index < requestedTypes.length; index += 50) {
    const specificationBatch = await getBlockSpecs({
      board: boardSelector,
      blockTypes: requestedTypes.slice(index, index + 50),
      includeSource: false
    });
    specs.push(...specificationBatch.specs);
  }
  const reliableSpecs = new Map(specs
    .filter((spec) => spec.definition && !spec.contract.hasMutation)
    .map((spec) => [spec.type, spec]));
  const skippedDynamicTypes = unique(specs
    .filter((spec) => spec.contract.hasMutation)
    .map((spec) => spec.type)).sort();
  const unresolvedTypes = requestedTypes.filter((type) => !reliableSpecs.has(type) && !skippedDynamicTypes.includes(type)).sort();
  const checkedTypes = new Set(reliableSpecs.keys());
  const invalidNodes = [];
  let checkedNodes = 0;

  for (const entry of entries) {
    const spec = reliableSpecs.get(entry.node.type);
    let owner;
    let legalNames;
    if (spec) {
      owner = spec.owner;
      legalNames = {
        fields: spec.contract.fieldNames,
        values: spec.contract.valueInputs,
        statements: spec.contract.statementInputs
      };
    } else if (entry.node.type === 'controls_if') {
      const elseIfCount = Math.max(0, Number(mutationAttribute(entry.node.mutation, 'elseif')) || 0);
      const hasElse = /^(?:1|true)$/i.test(String(mutationAttribute(entry.node.mutation, 'else') || ''));
      owner = 'official/dynamic-aware';
      legalNames = {
        fields: [],
        values: Array.from({ length: elseIfCount + 1 }, (_, index) => `IF${index}`),
        statements: [
          ...Array.from({ length: elseIfCount + 1 }, (_, index) => `DO${index}`),
          ...(hasElse ? ['ELSE'] : [])
        ]
      };
      checkedTypes.add(entry.node.type);
    } else {
      continue;
    }
    checkedNodes++;
    const suppliedNames = {
      fields: Object.keys(entry.node.fields || {}),
      values: Object.keys(entry.node.values || {}),
      statements: Object.keys(entry.node.statements || {})
    };
    const invalidNames = {
      fields: suppliedNames.fields.filter((name) => !legalNames.fields.includes(name)),
      values: suppliedNames.values.filter((name) => !legalNames.values.includes(name)),
      statements: suppliedNames.statements.filter((name) => !legalNames.statements.includes(name))
    };
    if (!invalidNames.fields.length && !invalidNames.values.length && !invalidNames.statements.length) continue;
    invalidNodes.push({
      node: { type: entry.node.type, id: entry.id, path: entry.path },
      owner,
      invalidNames,
      legalNames
    });
  }

  if (invalidNodes.length) {
    fail('结构化积木树包含无效的积木连接名', {
      invalidNodes,
      checkedTypes: [...checkedTypes].sort(),
      skippedDynamicTypes,
      unresolvedTypes,
      writePrevented: true
    });
  }
  return {
    checkedNodes,
    checkedTypes: [...checkedTypes].sort(),
    skippedDynamicTypes,
    unresolvedTypes
  };
}

async function buildProject(args) {
  let tree = args.tree;
  if (args.treePath) {
    const treePath = ensureInsideWorkspace(args.treePath);
    if (!fs.existsSync(treePath) || !fs.statSync(treePath).isFile()) fail(`工程树文件不存在: ${treePath}`);
    try { tree = JSON.parse(stripUtf8Bom(fs.readFileSync(treePath, 'utf8'))); } catch (error) { fail(`工程树 JSON 无效: ${error.message}`); }
  }
  if (!tree) fail('需要 treePath 或 tree');
  const normalized = normalizeProjectTree(tree);
  if (!normalized.board && !normalized.boardAttribute && !normalized.mixlyBoard) {
    const board = getBoard(args.board);
    normalized.boardAttribute = board.selectedProfile
      ? `${board.boardType}@${board.selectedProfile}`
      : board.boardType;
  }
  const treeContractValidation = await validateProjectTreeConnections(normalized, args.board);
  const serialized = serializeProjectTree(normalized);
  const report = await projectCompatibility(args, serialized.xml);
  if (!report.passed) fail('结构化积木工程兼容性检查失败', { ...report, parsed: undefined });
  const projectPath = atomicWriteProject(args.projectPath, serialized.xml, args.overwrite);
  const livePreview = await previewProjectUpdate(args, projectPath);
  delete report.parsed;
  return {
    projectPath,
    treeSource: args.treePath ? ensureInsideWorkspace(args.treePath) : 'inline',
    serializedNodes: serialized.nodeCount,
    autoLayout: true,
    globalVariablesChained: true,
    livePreview,
    treeContractValidation,
    ...report
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs || COMMAND_TIMEOUT_MS;
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function runNodeTool(script, args = [], options = {}) {
  const result = await runCommand(process.execPath, [path.join(HELPER_DIR, script), ...args], options);
  if (result.timedOut) fail(`工具执行超时: ${script}`, result);
  if (result.code !== 0) fail(`工具执行失败: ${script}`, result);
  return result;
}

function parseToolOutput(output) {
  const trimmed = output.trim();
  if (!trimmed) return null;
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (_) {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        value = JSON.parse(lines[index]);
        break;
      } catch (_) { /* try earlier line */ }
    }
  }
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { /* plain string result */ }
  }
  return value;
}

async function inferLibraryBoard(libraryName, args = {}) {
  for (const board of getBoardCatalog()) {
    const libraryPath = path.join(board.root, 'libraries', 'ThirdParty', libraryName);
    if (fs.existsSync(libraryPath) && fs.statSync(libraryPath).isDirectory()) return board.id;
    if (isMixly4() && mixly4LibrarySourceCandidates(board, libraryName).some((candidate) =>
      fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    )) return board.id;
  }
  if (isMixly4()) {
    for (const board of getBoardCatalog()) {
      const snapshot = await readMixly4OpfsSnapshot(board, args, {
        mode: 'analysis', libraryNames: [libraryName]
      });
      if (snapshot.available && snapshot.plugins.some((plugin) =>
        [plugin.id, plugin.name].filter(Boolean).some((name) =>
          String(name).toLowerCase() === String(libraryName).toLowerCase()
        )
      )) return board.id;
    }
  }
  fail(`无法自动识别积木库所属板卡，请传 board: ${libraryName}`);
}

function requireLocalDependency(name) {
  const candidates = [
    path.join(HELPER_DIR, 'node_modules', name),
    path.join(ROOT, 'resources', 'app', 'node_modules', name)
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (_) { /* try next local source */ }
  }
  fail(`缺少本地依赖 ${name}；请在 MCP 目录执行 npm install`);
}

async function packageLegacyLibrary(args) {
  const boardName = args.board || await inferLibraryBoard(args.library, args);
  const board = getBoard(boardName);
  const sourceDir = path.join(board.root, 'libraries', 'ThirdParty', args.library);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    fail(`积木库目录不存在: ${sourceDir}`);
  }
  const outputPath = ensureInsideWorkspace(
    args.outputPath || path.join(ROOT, `${args.library}_Mixly_Library.zip`)
  );
  const files = filesRecursive(sourceDir)
    .filter((filePath) => fs.statSync(filePath).isFile())
    .map((filePath) => ({
      absolute: filePath,
      relative: path.relative(sourceDir, filePath).replace(/\\/g, '/')
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative));
  if (!files.length) fail(`积木库没有可打包文件: ${sourceDir}`);

  const yazl = requireLocalDependency('yazl');
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(temporaryPath);
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
    for (const file of files) {
      zip.addFile(file.absolute, `${args.library}/${file.relative}`);
    }
    zip.end();
  });
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
  fs.renameSync(temporaryPath, outputPath);
  return {
    library: args.library,
    board: boardName,
    zipPath: outputPath,
    entries: files.map((file) => `${args.library}/${file.relative}`),
    fileEntries: files.length,
    directoryEntries: 0
  };
}

async function packageLibrary(args) {
  const boardName = args.board || await inferLibraryBoard(args.library, args);
  const board = getBoard(boardName);
  const context = await thirdPartyLibraryContext(board, args, {
    mode: 'full',
    libraryNames: [args.library]
  });
  try {
    const requestedName = String(args.library).toLowerCase();
    const resource = context.resources.find((candidate) =>
      candidate.name.toLowerCase() === requestedName
    );
    if (!resource) {
      if (isMixly4() && !context.storage.available) {
        fail(`无法读取 Mixly 4 插件并完成打包: ${args.library}`, {
          code: 'MIXLY4_OPFS_UNAVAILABLE',
          pluginStorage: context.storage,
          stagingLibraries: context.resources.map((item) => item.name)
        });
      }
      fail(`积木库不存在: ${args.library}`, {
        board: board.id,
        availableLibraries: context.resources.map((item) => item.name),
        pluginStorage: context.storage
      });
    }

    const sourceDir = resource.stagingPath || resource.path;
    const source = resource.stagingPath ? 'mixly4-staging' : resource.source;
    const outputPath = ensureInsideWorkspace(
      args.outputPath || path.join(ROOT, `${args.library}_Mixly_Library.zip`)
    );
    const files = filesRecursive(sourceDir)
      .filter((filePath) => fs.statSync(filePath).isFile())
      .map((filePath) => ({
        absolute: filePath,
        relative: path.relative(sourceDir, filePath).replace(/\\/g, '/')
      }))
      .sort((left, right) => left.relative.localeCompare(right.relative));
    if (!files.length) fail(`积木库没有可打包文件: ${sourceDir}`);

    const archiveRoot = isMixly4() ? '' : `${resource.name}/`;
    const entries = files.map((file) => `${archiveRoot}${file.relative}`);
    const directoryEntries = isMixly4()
      ? unique(entries.flatMap((entry) => {
          const parts = entry.split('/');
          return parts.slice(0, -1).map((_, index) => `${parts.slice(0, index + 1).join('/')}/`);
        })).sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
      : [];
    const outputDirectory = path.dirname(outputPath);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
    const yazl = requireLocalDependency('yazl');
    try {
      await new Promise((resolve, reject) => {
        const zip = new yazl.ZipFile();
        const output = fs.createWriteStream(temporaryPath);
        output.on('close', resolve);
        output.on('error', reject);
        zip.outputStream.on('error', reject);
        zip.outputStream.pipe(output);
        for (const directory of directoryEntries) zip.addEmptyDirectory(directory);
        for (let index = 0; index < files.length; index++) {
          zip.addFile(files[index].absolute, entries[index]);
        }
        zip.end();
      });
      if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
      fs.renameSync(temporaryPath, outputPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
    return {
      library: resource.name,
      board: boardName,
      source,
      zipPath: outputPath,
      entries,
      fileEntries: files.length,
      directoryEntries: directoryEntries.length,
      pluginStorage: context.storage
    };
  } finally {
    context.cleanup();
  }
}

// Runtime helpers keep the HTTP/NW.js transport separate from the legacy
// file/Electron transport while sharing target selection and diagnostics.
function isMixly4(layout = MIXLY_LAYOUT) {
  return layout && layout.generation === 4 && layout.runtime === 'nwjs';
}

function mixlyHttpOrigin(layout = MIXLY_LAYOUT) {
  const main = layout && layout.packageJson && layout.packageJson.main;
  if (typeof main === 'string' && /^https?:\/\//i.test(main)) {
    try { return new URL(main).origin; } catch (_) { /* use the known default below */ }
  }
  return isMixly4(layout) ? 'http://localhost:65234' : null;
}

function buildEditorUrl(board, projectPath = '', layout = MIXLY_LAYOUT, appSrcRoot = APP_SRC_ROOT) {
  const parameters = {
    thirdPartyBoard: board && board.thirdParty ? 'true' : 'false',
    boardIndex: board && board.boardIndex || '',
    boardType: board && board.boardType || '',
    boardImg: board && board.boardImg || '',
    language: board && board.language || ''
  };
  // Mixly 4 is served by static-server.  A file:// URL bypasses its module
  // loader and produces misleading Blockly shadow/import errors.
  if (isMixly4(layout)) {
    const origin = mixlyHttpOrigin(layout);
    return `${origin}/boards/index.html?${new URLSearchParams(parameters).toString()}`;
  }
  const url = new URL(pathToFileURL(path.join(appSrcRoot, 'boards', 'index.html')).href);
  if (projectPath) parameters.filePath = projectPath.replace(/\\/g, '/');
  url.search = new URLSearchParams(parameters).toString();
  return url.href;
}

function summarizeCdpTargets(targets) {
  return (Array.isArray(targets) ? targets : []).map((target) => ({
    id: target.id || null,
    type: target.type || null,
    title: target.title || '',
    url: target.url || '',
    origin: (() => {
      try { return new URL(target.url || '').origin; } catch (_) { return null; }
    })(),
    webSocketDebuggerUrl: target.webSocketDebuggerUrl || null
  }));
}

function targetScore(target, expectedOrigin) {
  if (!target || target.type !== 'page' || !target.webSocketDebuggerUrl) return -1;
  if (/^devtools:\/\//i.test(target.url || '') || /devtools/i.test(target.title || '')) return -1;
  const value = String(target.url || '');
  let score = 1;
  if (/\/boards\/index\.html(?:[?#]|$)/i.test(value)) score += 100;
  else if (/\/mixvm\/index\.html(?:[?#]|$)/i.test(value)) score += 80;
  if (expectedOrigin) {
    try {
      const actual = new URL(value);
      const expected = new URL(expectedOrigin);
      const sameLoopback = actual.protocol === expected.protocol && actual.port === expected.port &&
        ['localhost', '127.0.0.1', '::1'].includes(actual.hostname) &&
        ['localhost', '127.0.0.1', '::1'].includes(expected.hostname);
      if (actual.origin === expectedOrigin || sameLoopback) score += 50;
      else if (isMixly4()) return -1;
    } catch (_) {
      if (isMixly4()) return -1;
    }
  }
  return score;
}

function selectCdpTarget(targets, expectedOrigin = null) {
  return (Array.isArray(targets) ? targets : [])
    .map((target) => ({ target, score: targetScore(target, expectedOrigin) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score)[0]?.target || null;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error('CDP endpoint returned a non-array target list');
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function getCdpTargets(cdpPort, timeoutMs = 2000) {
  const endpoints = [
    `http://127.0.0.1:${cdpPort}/json/list`,
    `http://127.0.0.1:${cdpPort}/json`,
    `http://localhost:${cdpPort}/json/list`,
    `http://localhost:${cdpPort}/json`
  ];
  const errors = [];
  const perEndpointTimeout = Math.max(250, Math.floor(timeoutMs / endpoints.length));
  for (const endpoint of endpoints) {
    try {
      return await fetchJsonWithTimeout(endpoint, perEndpointTimeout);
    } catch (error) {
      errors.push({ endpoint, message: error.name === 'AbortError' ? 'timeout' : String(error.message || error) });
    }
  }
  const error = new Error(`CDP endpoint unavailable on port ${cdpPort}`);
  error.cdpAttempts = errors;
  throw error;
}

async function getCdpDiagnostics(cdpPort, timeoutMs = 1200) {
  try {
    const targets = await getCdpTargets(cdpPort, timeoutMs);
    const expectedOrigin = isMixly4() ? mixlyHttpOrigin() : null;
    const target = selectCdpTarget(targets, expectedOrigin);
    return {
      running: true,
      available: Boolean(target),
      port: cdpPort,
      target: target ? summarizeCdpTargets([target])[0] : null,
      targets: summarizeCdpTargets(targets),
      reason: target ? null : 'no Mixly page target'
    };
  } catch (error) {
    return {
      running: false,
      available: false,
      port: cdpPort,
      target: null,
      targets: [],
      reason: 'endpoint-unavailable',
      error: error.message,
      attempts: error.cdpAttempts || []
    };
  }
}

async function probeMixlyHttp(origin, timeoutMs = 1200) {
  if (!origin) return { available: false, origin: null, reason: 'not-http-runtime' };
  const url = `${origin.replace(/\/$/, '')}/boards/index.html`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
    try {
      const response = await fetch(url, { signal: controller.signal });
      return { available: response.ok, origin, url, status: response.status, reason: response.ok ? null : `HTTP ${response.status}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { available: false, origin, url, reason: error.name === 'AbortError' ? 'timeout' : String(error.message || error) };
  }
}

async function waitForHttp(origin, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let last = null;
  while (Date.now() < deadline) {
    last = await probeMixlyHttp(origin, Math.min(1200, Math.max(250, deadline - Date.now())));
    if (last.available) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last || probeMixlyHttp(origin, 500);
}

async function waitForCdp(cdpPort, waitMs, options = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await getCdpTargets(cdpPort);
      const selected = selectCdpTarget(targets, isMixly4() ? mixlyHttpOrigin() : null);
      if (selected) return targets;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (options.returnNull) return null;
  fail(`等待 Mixly CDP 端口 ${cdpPort} 超时`, {
    cdpPort,
    reason: 'cdpUnavailable',
    runtime: mixlyLayoutSummary(),
    httpOrigin: mixlyHttpOrigin(),
    lastError: lastError ? lastError.message : null,
    attempts: lastError && lastError.cdpAttempts ? lastError.cdpAttempts : []
  });
}

function runtimeAutomation(cdp, http) {
  return {
    generation: MIXLY_LAYOUT.generation,
    runtime: MIXLY_LAYOUT.runtime,
    httpOrigin: mixlyHttpOrigin(),
    http,
    cdp,
    automation: {
      available: Boolean(cdp && cdp.available),
      transport: cdp && cdp.available ? 'cdp' : null,
      reason: cdp && cdp.available ? null : 'cdpUnavailable'
    }
  };
}

function cdpUnavailable(operation, cdp, http, extra = {}) {
  fail(`Mixly ${operation} 无法自动化：当前运行时未暴露可用 CDP`, {
    code: 'MIXLY4_CDP_UNAVAILABLE',
    operation,
    runtime: mixlyLayoutSummary(),
    httpOrigin: mixlyHttpOrigin(),
    manualUrl: extra.url || `${mixlyHttpOrigin() || ''}/boards/index.html`,
    cdp,
    http,
    hint: 'Mixly 4 普通 NW.js 构建可能不提供 /json 调试端点；请使用带调试端口的 SDK 构建，或在 Mixly 界面手工完成此操作。',
    ...extra
  });
}

async function requireCdpTarget(operation, cdpPort, url = null) {
  const http = await probeMixlyHttp(mixlyHttpOrigin());
  const cdp = await getCdpDiagnostics(cdpPort);
  if (!cdp.target) cdpUnavailable(operation, cdp, http, { url });
  return { cdp, http, target: cdp.target };
}

function mixly4BoardPageKey(url) {
  try {
    const parsed = new URL(String(url));
    const boardIndex = String(parsed.searchParams.get('boardIndex') || '')
      .replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    return boardIndex ? `${parsed.origin}${parsed.pathname}|${boardIndex}` : '';
  } catch (_) {
    return '';
  }
}

function sameMixly4BoardPage(currentUrl, expectedUrl) {
  const current = mixly4BoardPageKey(currentUrl);
  const expected = mixly4BoardPageKey(expectedUrl);
  return Boolean(current && expected && current === expected);
}

async function navigateMixly4Board(boardSelector, cdpPort, waitMs) {
  if (!isMixly4() || !boardSelector) return null;
  const url = projectUrl('', boardSelector);
  const diagnostics = await getCdpDiagnostics(cdpPort, 700);
  if (diagnostics.target && sameMixly4BoardPage(diagnostics.target.url, url)) {
    const workspace = await waitForWorkspace(cdpPort, Number(waitMs || 30000));
    return { url: diagnostics.target.url, workspace, navigated: false };
  }
  await runNodeTool('validate_mixly_workspace.js', ['--navigate', url], {
    env: {
      MIXLY_CDP_PORT: String(cdpPort),
      MIXLY_EXPECTED_ORIGIN: mixlyHttpOrigin() || '',
      MIXLY_MIXLY4: '1'
    },
    timeoutMs: Math.max(30000, Number(waitMs || 30000))
  });
  const workspace = await waitForWorkspace(cdpPort, Number(waitMs || 30000));
  return { url, workspace, navigated: true };
}

async function launchMixly(args) {
  const cdpPort = getCdpPort(args);
  const waitMs = Number(args.waitMs || 30000);
  const cdpBefore = await getCdpDiagnostics(cdpPort);
  const httpOrigin = mixlyHttpOrigin();
  if (isMixly4()) {
    const httpBefore = await probeMixlyHttp(httpOrigin);
    if (httpBefore.available && cdpBefore.available) {
      const boardPage = await navigateMixly4Board(args.board, cdpPort, waitMs);
      return {
        alreadyRunning: true,
        pid: null,
        cdpPort,
        profilePath: null,
        boardPage,
        runtime: runtimeAutomation(cdpBefore, httpBefore),
        targets: cdpBefore.targets
      };
    }
    if (httpBefore.available) {
      fail('Mixly 4 已启动，但当前实例没有 CDP，MCP 无法自动导入、打开工程或执行 WASM 编译', {
        code: 'MIXLY4_HTTP_WITHOUT_CDP',
        http: httpBefore,
        cdp: cdpBefore,
        cdpPort,
        hint: '请关闭当前普通实例后重新调用 mixly_project_workflow；MCP 会优先启动 MIXLY_HOME 内可自动化的 64 位 NW.js/SDK 运行时。'
      });
    }
  } else if (cdpBefore.available) {
    return { alreadyRunning: true, cdpPort, runtime: runtimeAutomation(cdpBefore, null), targets: cdpBefore.targets };
  }

  const runtimeCandidate = preferredMixlyRuntime(args);
  if (!runtimeCandidate) fail(`找不到可用的 Mixly 运行时: ${MIXLY_EXE}`);
  const profilePath = ensureInsideWorkspace(args.profilePath || path.join(ROOT, '.mixly-mcp-profile'));
  fs.mkdirSync(profilePath, { recursive: true });
  const launchArgs = runtimeCandidate.nwRuntime
    ? [`--remote-debugging-port=${cdpPort}`, ROOT]
    : [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profilePath}`];
  const child = spawn(runtimeCandidate.path, launchArgs, {
    cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false
  });
  child.unref();

  if (isMixly4()) {
    const http = await waitForHttp(httpOrigin, waitMs);
    if (!http || !http.available) {
      fail('Mixly 4 HTTP 服务启动超时', {
        code: 'MIXLY4_HTTP_UNAVAILABLE', runtime: mixlyLayoutSummary(), httpOrigin, http,
        pid: child.pid, profilePath
      });
    }
    await waitForCdp(cdpPort, waitMs);
    const diagnostics = await getCdpDiagnostics(cdpPort);
    const boardPage = await navigateMixly4Board(args.board, cdpPort, waitMs);
    return {
      alreadyRunning: false,
      pid: child.pid,
      cdpPort,
      profilePath: runtimeCandidate.nwRuntime ? path.join(ROOT, 'nw_cache') : profilePath,
      requestedProfilePath: profilePath,
      runtimeExecutable: runtimeCandidate.path,
      runtimeExecutableSource: runtimeCandidate.source,
      runtimeArchitecture: runtimeCandidate.architecture,
      boardPage,
      runtime: runtimeAutomation(diagnostics, http),
      targets: diagnostics.targets
    };
  }
  await waitForCdp(cdpPort, waitMs);
  const diagnostics = await getCdpDiagnostics(cdpPort);
  return { alreadyRunning: false, pid: child.pid, cdpPort, profilePath, runtime: runtimeAutomation(diagnostics, null), targets: diagnostics.targets };
}

async function evaluateCdp(expression, cdpPort) {
  const expressionPath = path.join(
    os.tmpdir(),
    `mixly-cdp-expression-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.js`
  );
  fs.writeFileSync(expressionPath, String(expression), 'utf8');
  try {
    const result = await runNodeTool('validate_mixly_workspace.js', ['--expression-file', expressionPath], {
      env: {
        MIXLY_CDP_PORT: String(cdpPort),
        MIXLY_EXPECTED_ORIGIN: mixlyHttpOrigin() || '',
        MIXLY_MIXLY4: isMixly4() ? '1' : '0'
      },
      timeoutMs: COMMAND_TIMEOUT_MS
    });
    return { value: parseToolOutput(result.stdout), raw: result.stdout.trim() };
  } finally {
    fs.rmSync(expressionPath, { force: true });
  }
}

async function clickCdpSelector(selector, cdpPort) {
  const result = await runNodeTool('validate_mixly_workspace.js', ['--click-selector', selector], {
    env: {
      MIXLY_CDP_PORT: String(cdpPort),
      MIXLY_EXPECTED_ORIGIN: mixlyHttpOrigin() || '',
      MIXLY_MIXLY4: isMixly4() ? '1' : '0'
    },
    timeoutMs: 30000
  });
  return parseToolOutput(result.stdout);
}

function zipEntries(zipPath) {
  const stat = fs.statSync(zipPath);
  if (stat.size > 128 * 1024 * 1024) fail('Mixly 库 ZIP 超过自动导入大小限制', { zipPath, size: stat.size });
  const data = fs.readFileSync(zipPath);
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const start = Math.max(0, data.length - 0x10000 - 22);
  const eocdOffset = data.lastIndexOf(eocd, data.length - 22);
  if (eocdOffset < start) fail('无法读取 ZIP 中央目录', { zipPath });
  const count = data.readUInt16LE(eocdOffset + 10);
  const directorySize = data.readUInt32LE(eocdOffset + 12);
  const directoryOffset = data.readUInt32LE(eocdOffset + 16);
  if (directoryOffset + directorySize > data.length) fail('ZIP 中央目录越界', { zipPath });
  const entries = [];
  let offset = directoryOffset;
  for (let index = 0; index < count && offset + 46 <= data.length; index++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) break;
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const uncompressedSize = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { data, entries };
}

function readZipEntry(zipPath, wantedNames) {
  const wanted = new Set((Array.isArray(wantedNames) ? wantedNames : [wantedNames])
    .filter(Boolean).map((name) => String(name).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()));
  const zip = zipEntries(zipPath);
  const entry = zip.entries.find((item) => {
    const name = item.name.replace(/^\.\//, '').toLowerCase();
    const base = path.posix.basename(name);
    return wanted.has(name) || wanted.has(base) || [...wanted].some((wantedName) => name.endsWith(`/${wantedName}`));
  });
  if (!entry || entry.uncompressedSize > 32 * 1024 * 1024) return null;
  const data = zip.data;
  if (entry.localOffset + 30 > data.length || data.readUInt32LE(entry.localOffset) !== 0x04034b50) return null;
  const nameLength = data.readUInt16LE(entry.localOffset + 26);
  const extraLength = data.readUInt16LE(entry.localOffset + 28);
  const payloadStart = entry.localOffset + 30 + nameLength + extraLength;
  const payloadEnd = payloadStart + entry.compressedSize;
  if (payloadEnd > data.length) return null;
  const payload = data.subarray(payloadStart, payloadEnd);
  if (entry.method === 0) return Buffer.from(payload);
  if (entry.method === 8) return zlib.inflateRawSync(payload);
  return null;
}

function mixly4PluginMetadata(zipPath, libraryName) {
  const metadataEntry = readZipEntry(zipPath, ['plugin.json', 'package.json']);
  let metadata = {};
  if (metadataEntry) {
    try { metadata = JSON.parse(stripUtf8Bom(metadataEntry.toString('utf8'))); } catch (error) {
      fail('Mixly 4 插件元数据不是有效 JSON', { zipPath, error: error.message });
    }
  }
  const indexXml = readZipEntry(zipPath, ['index.xml']);
  if (!indexXml) {
    fail('Mixly 4 导入要求 ZIP 包含 index.xml；旧版仅 Arduino 库 ZIP 不能直接作为插件导入', {
      code: 'MIXLY4_PLUGIN_FORMAT_REQUIRED', zipPath, libraryName
    });
  }
  const id = String(metadata.id || metadata.name || libraryName || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(id)) {
    fail('Mixly 4 插件 id 不合法', { code: 'MIXLY4_PLUGIN_METADATA_REQUIRED', zipPath, id });
  }
  const version = String(metadata.version || metadata.latestVersion || '0.0.0').trim();
  return {
    ...metadata,
    id,
    // Keep dir in sync with the id-based storage directory; without it the
    // MicroPython uploader joins an undefined segment and skips or breaks
    // the plugin libraries mount.
    dir: String(metadata.dir || id).trim() || id,
    name: metadata.name || id,
    displayName: metadata.displayName || metadata.title || metadata.name || id,
    version,
    latestVersion: metadata.latestVersion || version,
    currentVersion: metadata.currentVersion || version
  };
}

async function importMixly4Plugin(args, zipPath, libraryName) {
  const url = args.board ? projectUrl('', args.board) : null;
  const { cdp, http } = await requireCdpTarget('库导入', getCdpPort(args), url);
  if (url) {
    await navigateMixly4Board(args.board, getCdpPort(args), Number(args.waitMs || 30000));
  }
  const metadata = mixly4PluginMetadata(zipPath, libraryName);
  const base64 = fs.readFileSync(zipPath).toString('base64');
  if (base64.length > 170 * 1024 * 1024) {
    fail('Mixly 4 插件 ZIP 过大，拒绝通过 CDP 内联传输', { code: 'MIXLY4_PLUGIN_TOO_LARGE', zipPath });
  }
  const expression = `new Promise(async(resolve,reject)=>{try{
    const raw=atob(${JSON.stringify(base64)});
    const bytes=new Uint8Array(raw.length);
    for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
    const blob=new Blob([bytes],{type:'application/zip'});
    const manager=Mixly.PluginManager||Mixly.StatusBarPlugin;
    if(!manager||typeof manager.installPlugin!=='function')throw new Error('Mixly.PluginManager.installPlugin is unavailable');
    const metadata=${JSON.stringify(metadata)};
    // Mixly 4 creates the storage-rule root but not nested parent folders.
    // Supply a rule handler so real Arduino library layouts can be installed.
    metadata.storageRules=(metadata.storageRules||[]).map((rule)=>{
      if(!rule||rule.type!=='directory')return rule;
      return {...rule,handler:async({blob,storagePath,fs})=>{
        const normalized=String(storagePath||'').replaceAll('\\\\','/');
        const separator=normalized.lastIndexOf('/');
        if(separator>0)await fs.createDirectory(normalized.slice(0,separator),{recursive:true});
        await fs.writeFile(storagePath,await blob.arrayBuffer());
        return storagePath;
      }};
    });
    const result=await manager.installPlugin(metadata,${JSON.stringify(metadata.version)},blob,'install',{});
    if(typeof manager.mountInstalledPlugin==='function')await manager.mountInstalledPlugin(${JSON.stringify(metadata.id)});
    resolve(JSON.stringify({id:${JSON.stringify(metadata.id)},version:${JSON.stringify(metadata.version)},installed:true,result}));
  }catch(error){reject(error)}})`;
  const evaluated = await evaluateCdp(expression, getCdpPort(args));
  if (!evaluated.value || evaluated.value.installed !== true) {
    fail('Mixly 4 插件导入失败', { cdp, http, raw: evaluated.raw, metadata });
  }
  return { zipPath, libraryName, format: 'mixly4-plugin', metadata, ...evaluated.value };
}

async function importLibrary(args) {
  const zipPath = ensureInsideWorkspace(args.zipPath);
  if (!fs.existsSync(zipPath) || path.extname(zipPath).toLowerCase() !== '.zip') {
    fail(`ZIP 文件不存在或后缀不正确: ${zipPath}`);
  }
  const inferredName = path.basename(zipPath).replace(/_Mixly_Library\.zip$/i, '').replace(/\.zip$/i, '');
  const libraryName = args.libraryName || inferredName;
  if (isMixly4()) {
    const result = await importMixly4Plugin(args, zipPath, libraryName);
    invalidateDiscoveryCaches();
    return result;
  }
  const cdpPort = getCdpPort(args);
  if (args.board) {
    const url = projectUrl('', args.board);
    await runNodeTool('validate_mixly_workspace.js', ['--navigate', url], {
      env: { MIXLY_CDP_PORT: String(cdpPort) }
    });
    await waitForWorkspace(cdpPort, 30000);
  }
  const expression = `new Promise((resolve)=>{const fs=Mixly.require('fs');const path=Mixly.require('path');const done=(error)=>setTimeout(()=>{const destination=path.join(Mixly.Env.boardDirPath,'libraries','ThirdParty');const libraryPath=path.join(destination,${JSON.stringify(libraryName)});resolve(JSON.stringify({error:error?String(error):null,destination,libraryPath,libraryExists:fs.existsSync(libraryPath),files:fs.existsSync(libraryPath)?fs.readdirSync(libraryPath).sort():[],thirdPartyXmlCount:(Mixly.Env.thirdPartyXML||[]).length}));},300);Mixly.Electron.LibManager.importFromLocalWithZip('MIXLY',${JSON.stringify(zipPath)},done);})`;
  const evaluated = await evaluateCdp(expression, cdpPort);
  if (!evaluated.value || evaluated.value.error) {
    fail('Mixly 积木库导入失败', evaluated.value || evaluated.raw);
  }
  invalidateDiscoveryCaches();
  return { zipPath, libraryName, ...evaluated.value };
}

function projectUrl(projectPath, boardName) {
  return buildEditorUrl(getBoard(boardName), projectPath, MIXLY_LAYOUT, APP_SRC_ROOT);
}

async function waitForWorkspace(cdpPort, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let lastError = null;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      const evaluated = await evaluateCdp(
        `(()=>{const app=(typeof Mixly==='object'&&Mixly.app)||((typeof window==='object'&&window.MixlyApp)||null);const editors=app&&typeof app.getWorkspace==='function'?app.getWorkspace().getEditorsManager():null;const active=editors&&typeof editors.getActive==='function'?editors.getActive():null;const page=active&&typeof active.getPage==='function'?active.getPage('block'):null;const workspace=page&&typeof page.getEditor==='function'?page.getEditor():(typeof Blockly==='object'&&typeof Blockly.getMainWorkspace==='function'?Blockly.getMainWorkspace():null);return JSON.stringify({ready:document.readyState,blockly:typeof Blockly,mixly:typeof Mixly,workspaceReady:Boolean(workspace&&typeof workspace.getAllBlocks==='function'),editorReady:Boolean(active&&typeof active.setValue==='function'),board:(typeof Mixly==='object'&&Mixly.Boards&&typeof Mixly.Boards.getSelectedBoardName==='function')?Mixly.Boards.getSelectedBoardName():null,url:location.href});})()`,
        cdpPort
      );
      lastState = evaluated.value;
      if (lastState && lastState.ready === 'complete' && lastState.blockly === 'object' && lastState.workspaceReady === true) {
        return lastState;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const cdp = await getCdpDiagnostics(cdpPort, 500);
  fail('等待 Mixly Blockly 工作区就绪超时', {
    code: 'MIXLY_WORKSPACE_TIMEOUT', runtime: mixlyLayoutSummary(), cdp,
    lastState, lastError: lastError ? lastError.message : null
  });
}

async function openProject(args) {
  const projectPath = ensureInsideWorkspace(args.projectPath);
  if (!fs.existsSync(projectPath)) fail(`Mixly 工程不存在: ${projectPath}`);
  const cdpPort = getCdpPort(args);
  const url = projectUrl(projectPath, args.board);
  const runtime = isMixly4() ? await requireCdpTarget('project-open', cdpPort, url) : null;
  if (isMixly4()) {
    await navigateMixly4Board(args.board, cdpPort, Number(args.waitMs || 30000));
  } else {
    await runNodeTool('validate_mixly_workspace.js', ['--navigate', url], {
      env: {
        MIXLY_CDP_PORT: String(cdpPort),
        MIXLY_EXPECTED_ORIGIN: mixlyHttpOrigin() || '',
        MIXLY_MIXLY4: '0'
      }
    });
  }
  const workspace = await waitForWorkspace(cdpPort, Number(args.waitMs || 30000));
  let loaded = null;
  if (isMixly4()) {
    const evaluated = await evaluateCdp(loadProjectExpression(projectPath,
      `return JSON.stringify({loaded:true,totalNodes:workspace.getAllBlocks(false).length,url:location.href});`
    ), cdpPort);
    loaded = evaluated.value || { loaded: false, raw: evaluated.raw };
  }
  return { projectPath, board: args.board, cdpPort, url, workspace, loaded, runtime: runtime ? runtime.cdp : null };
}

async function previewProjectUpdate(args, projectPath) {
  if (!isMixly4()) return { enabled: false, updated: false, reason: 'mixly-generation-not-4' };
  if (args.livePreview === false) return { enabled: false, updated: false, reason: 'explicitly-disabled' };
  if (args.livePreview !== true && !process.env.MIXLY_CDP_PORT) {
    return { enabled: false, updated: false, reason: 'harness-cdp-not-pinned' };
  }
  const cdpPort = getCdpPort(args);
  const diagnostics = await getCdpDiagnostics(cdpPort, 500);
  if (!diagnostics.available) {
    const result = { enabled: true, updated: false, reason: 'cdp-unavailable', cdpPort };
    if (args.livePreview === true) fail('Mixly 4 实时积木预览不可用', result);
    return result;
  }
  try {
    const expectedUrl = projectUrl('', args.board);
    const currentUrl = diagnostics.target && diagnostics.target.url;
    if (!sameMixly4BoardPage(currentUrl, expectedUrl)) {
      const mismatch = {
        enabled: true,
        updated: false,
        cdpPort,
        reason: 'active-board-mismatch',
        currentUrl,
        expectedUrl,
        hint: '实时预览不会自动切换板卡，以免刷新页面并关闭 AI 侧栏。请先在 Mixly 选择目标板卡。'
      };
      if (args.livePreview === true) fail('Mixly 4 实时预览板卡与当前页面不一致', mismatch);
      return mismatch;
    }
    await waitForWorkspace(cdpPort, Number(args.waitMs || 30000));
    const evaluated = await evaluateCdp(loadProjectExpression(projectPath,
      `return JSON.stringify({loaded:true,totalNodes:workspace.getAllBlocks(false).length,url:location.href});`
    ), cdpPort);
    const loaded = evaluated.value || { loaded: false, raw: evaluated.raw };
    const expectedNodes = parseProjectXml(fs.readFileSync(projectPath, 'utf8')).blocks.length;
    const loadedNodes = loaded && loaded.totalNodes;
    const updated = Boolean(loaded && loaded.loaded && loadedNodes === expectedNodes);
    const result = {
      enabled: true,
      updated,
      cdpPort,
      board: args.board,
      expectedNodes,
      totalNodes: loadedNodes,
      reason: updated ? null : 'loaded-node-count-mismatch',
      url: currentUrl,
      navigated: false
    };
    if (!updated && args.livePreview === true) fail('Mixly 4 实时积木预览节点不完整', result);
    return result;
  } catch (error) {
    if (args.livePreview === true) throw error;
    return { enabled: true, updated: false, cdpPort, reason: error.message || String(error) };
  }
}

// Mixly 4 runs in web mode even though the host is NW.js.  Reading the
// project in the MCP process and passing its XML to EditorMix avoids relying
// on the removed Mixly.require/Electron bridge and also works over CDP.
function loadProjectExpression(projectPath, body) {
  if (!isMixly4()) {
    const encodedPath = JSON.stringify(projectPath.replace(/\\/g, '/'));
    return `(()=>{const fs=Mixly.require('fs');const source=fs.readFileSync(${encodedPath},'utf8');const dom=Blockly.utils.xml.textToDom(source);const workspace=Blockly.getMainWorkspace();if(!workspace||typeof workspace.setResizesEnabled!=='function')throw new Error('Blockly workspace is not ready');Blockly.Xml.clearWorkspaceAndLoadFromXml(dom,workspace);${body}})()`;
  }
  const source = fs.readFileSync(projectPath, 'utf8');
  const extension = path.extname(projectPath).toLowerCase() || '.mix';
  return `(async()=>{const source=${JSON.stringify(source)};const extension=${JSON.stringify(extension)};const app=(typeof Mixly==='object'&&Mixly.app)||((typeof window==='object'&&window.MixlyApp)||null);const editors=app&&typeof app.getWorkspace==='function'?app.getWorkspace().getEditorsManager():null;const active=editors&&typeof editors.getActive==='function'?editors.getActive():null;const blockEditor=active&&typeof active.getPage==='function'&&active.getPage('block')?active.getPage('block').getEditor():null;if(active&&typeof active.setValue==='function'){active.setValue(source,extension)}else{const workspace=blockEditor||(typeof Blockly==='object'&&typeof Blockly.getMainWorkspace==='function'?Blockly.getMainWorkspace():null);if(!workspace)throw new Error('Mixly 4 block editor is not ready');const dom=Blockly.utils.xml.textToDom(source);Blockly.Xml.clearWorkspaceAndLoadFromXml(dom,workspace)}await new Promise((resolve)=>setTimeout(resolve,80));const workspace=blockEditor||(typeof Blockly==='object'&&typeof Blockly.getMainWorkspace==='function'?Blockly.getMainWorkspace():null);if(!workspace||typeof workspace.getAllBlocks!=='function')throw new Error('Mixly 4 Blockly workspace is not ready');const topBlocks=typeof workspace.getTopBlocks==='function'?workspace.getTopBlocks(true):[];if(topBlocks.length&&typeof workspace.centerOnBlock==='function'){workspace.centerOnBlock(topBlocks[0].id);await new Promise((resolve)=>requestAnimationFrame(resolve));const panel=document.getElementById('mixly-harness-panel');if(panel&&panel.dataset.open==='true'&&typeof workspace.scroll==='function'){const panelWidth=panel.getBoundingClientRect().width;if(panelWidth>0)workspace.scroll(workspace.scrollX-panelWidth/2,workspace.scrollY)}}${body}})()`;
}

function projectLoadDiagnostics(parsed, liveBlocks) {
  const inventory = Array.isArray(liveBlocks) ? liveBlocks : [];
  const loadedById = new Map(inventory.filter((block) => block.id).map((block) => [block.id, block]));
  const expectedById = new Map(parsed.blocks.filter((block) => block.id).map((block) => [block.id, block]));
  const missingBlocks = parsed.blocks.filter((block) => block.id && !loadedById.has(block.id)).map((block) => {
    let ancestor = block.parent;
    while (ancestor && (!ancestor.id || !loadedById.has(ancestor.id))) ancestor = ancestor.parent;
    return {
      id: block.id,
      type: block.type,
      parent: block.parent ? { id: block.parent.id || null, type: block.parent.type } : null,
      parentConnection: block.parentConnection || null,
      nearestLoadedAncestor: ancestor ? { id: ancestor.id || null, type: ancestor.type } : null
    };
  });
  const unexpectedBlocks = inventory.filter((block) => block.id && !expectedById.has(block.id));
  const mismatchedBlocks = inventory.filter((block) => {
    const expected = block.id && expectedById.get(block.id);
    return expected && expected.type !== block.type;
  }).map((block) => ({
    id: block.id,
    expectedType: expectedById.get(block.id).type,
    loadedType: block.type,
    loadedParent: block.parent || null
  }));
  const countTypes = (blocks) => {
    const counts = new Map();
    for (const block of blocks) counts.set(block.type, (counts.get(block.type) || 0) + 1);
    return counts;
  };
  const expectedTypes = countTypes(parsed.blocks);
  const loadedTypes = countTypes(inventory);
  const missingTypes = [...expectedTypes.entries()].map(([type, expected]) => ({
    type,
    expected,
    loaded: loadedTypes.get(type) || 0,
    missing: expected - (loadedTypes.get(type) || 0)
  })).filter((item) => item.missing > 0).sort((left, right) => right.missing - left.missing || left.type.localeCompare(right.type));
  return { missingBlocks, missingTypes, mismatchedBlocks, unexpectedBlocks };
}

async function validateProject(args) {
  const projectPath = ensureInsideWorkspace(args.projectPath);
  if (!fs.existsSync(projectPath)) fail(`Mixly 工程不存在: ${projectPath}`);
  if (isMixly4()) await requireCdpTarget('project-validation', getCdpPort(args));
  await waitForWorkspace(getCdpPort(args), 30000);
  const prefixes = args.customPrefixes || [];
  const projectXml = fs.readFileSync(projectPath, 'utf8');
  const staticReport = await projectCompatibility(args, projectXml);
  if (!staticReport.passed) fail('Mixly 工程静态兼容性检查失败', { ...staticReport, parsed: undefined });
  const expression = loadProjectExpression(projectPath,
    `workspace.zoomToFit();const blocks=workspace.getAllBlocks(false);const top=workspace.getTopBlocks(false);const prefixes=${JSON.stringify(prefixes)};const custom=blocks.filter((block)=>prefixes.some((prefix)=>block.type.startsWith(prefix)));const rects=top.map((block)=>{const p=block.getRelativeToSurfaceXY();const s=block.getHeightWidth();return{id:block.id,type:block.type,x:p.x,y:p.y,width:s.width,height:s.height};});const overlaps=[];for(let i=0;i<rects.length;i++){for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];if(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y)overlaps.push([a.id,b.id]);}}const orphanValues=top.filter((block)=>block.outputConnection).map((block)=>({id:block.id,type:block.type}));const topVariables=top.filter((block)=>block.type==='variables_declare').map((block)=>block.id);const blockInventory=blocks.map((block)=>{const parent=block.getParent();return{id:block.id,type:block.type,parent:parent?{id:parent.id,type:parent.type}:null};});return JSON.stringify({ready:document.readyState,title:document.title,board:Mixly.Boards.getSelectedBoardName(),totalNodes:blocks.length,nativeNodes:blocks.length-custom.length,customNodes:custom.length,customTypes:[...new Set(custom.map((block)=>block.type))].sort(),procedures:blocks.filter((block)=>block.type==='procedures_defnoreturn'||block.type==='procedures_defreturn').map((block)=>block.getFieldValue('NAME')).sort(),chineseProcedures:blocks.filter((block)=>(block.type==='procedures_defnoreturn'||block.type==='procedures_defreturn')&&/[\\u3400-\\u9fff]/.test(block.getFieldValue('NAME')||'')).map((block)=>block.getFieldValue('NAME')).sort(),thirdPartyXmlCount:(Mixly.Env.thirdPartyXML||[]).length,scale:workspace.scale,topLevelBlocks:top.length,topVariableDeclarationStacks:topVariables.length,orphanValues,rects,overlaps,blockInventory});`
  );
  const evaluated = await evaluateCdp(expression, getCdpPort(args));
  if (!evaluated.value || typeof evaluated.value !== 'object') {
    fail('Mixly 工程验证没有返回结构化结果', evaluated.raw);
  }
  const liveErrors = [];
  const liveWarnings = [];
  const loadDiagnostics = projectLoadDiagnostics(staticReport.parsed, evaluated.value.blockInventory);
  if (evaluated.value.totalNodes !== staticReport.totalNodes) {
    liveErrors.push(`XML 有 ${staticReport.totalNodes} 个节点，真实 Blockly 只加载 ${evaluated.value.totalNodes} 个`);
  }
  if (evaluated.value.topVariableDeclarationStacks > 1) liveWarnings.push('真实工作区中的全局变量声明没有连接成一个栈');
  if (evaluated.value.orphanValues.length) liveWarnings.push('存在孤立的值积木，建议连接或删除');
  if (evaluated.value.overlaps.length) liveWarnings.push('顶层积木布局发生重叠，建议重新排布');
  if (liveErrors.length) {
    const liveResult = { ...evaluated.value };
    delete liveResult.blockInventory;
    fail('Mixly 真实工作区兼容性检查失败', {
      liveErrors,
      expectedNodes: staticReport.totalNodes,
      loadedNodes: evaluated.value.totalNodes,
      ...loadDiagnostics,
      ...liveResult
    });
  }
  delete evaluated.value.blockInventory;
  delete staticReport.parsed;
  return {
    projectPath,
    customPrefixes: prefixes,
    staticCompatibility: staticReport,
    ...evaluated.value,
    liveErrors,
    liveWarnings,
    warnings: [...staticReport.warnings, ...liveWarnings],
    passed: true
  };
}

async function generateMixly4Code(args, projectPath, outputPath) {
  const cdpPort = getCdpPort(args);
  await requireCdpTarget('code-generation', cdpPort);
  await waitForWorkspace(cdpPort, Number(args.waitMs || 30000));
  const expression = loadProjectExpression(projectPath,
    `const requested=${JSON.stringify(args.generator || '')};let generatorName='';let code='';if(!requested&&active&&typeof active.getCode==='function'){generatorName='Mixly.EditorMix';code=String(active.getCode()||'')}else{const preferred=requested?[requested]:['generator','Arduino','C','C++','Python','MicroPython','MicroPythonV2','JavaScript','Lua'];generatorName=preferred.find((name)=>Blockly[name]&&typeof Blockly[name].workspaceToCode==='function')||'';if(!generatorName)throw new Error('No Blockly code generator is available for the current Mixly 4 board');code=String(Blockly[generatorName].workspaceToCode(workspace)||'')}const blocks=workspace.getAllBlocks(false);return JSON.stringify({code,generator:generatorName,codeLength:code.length,totalNodes:blocks.length,procedures:blocks.filter((block)=>block.type==='procedures_defnoreturn'||block.type==='procedures_defreturn').map((block)=>block.getFieldValue('NAME')).sort()});`
  );
  const evaluated = await evaluateCdp(expression, cdpPort);
  if (!evaluated.value || typeof evaluated.value.code !== 'string') {
    fail('Mixly 4 code generation failed', { raw: evaluated.raw, projectPath });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, evaluated.value.code, 'utf8');
  const result = { ...evaluated.value };
  delete result.code;
  return { projectPath, outputPath, ...result };
}

async function generateCode(args) {
  const projectPath = ensureInsideWorkspace(args.projectPath);
  const outputPath = ensureInsideWorkspace(args.outputPath);
  if (!fs.existsSync(projectPath)) fail(`Mixly 工程不存在: ${projectPath}`);
  if (isMixly4()) return generateMixly4Code(args, projectPath, outputPath);
  await waitForWorkspace(getCdpPort(args), 30000);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const expression = loadProjectExpression(projectPath,
    `const requested=${JSON.stringify(args.generator || '')};const preferred=requested?[requested]:['Arduino','Python','MicroPython','MicroPythonV2','JavaScript','Lua'];const generatorName=[...preferred,...Object.keys(Blockly)].find((name)=>Blockly[name]&&typeof Blockly[name].workspaceToCode==='function');if(!generatorName)throw new Error('No Blockly code generator is available for the current board');const code=Blockly[generatorName].workspaceToCode(workspace);fs.writeFileSync(${JSON.stringify(outputPath.replace(/\\/g, '/'))},code,'utf8');const blocks=workspace.getAllBlocks(false);return JSON.stringify({outputPath:${JSON.stringify(outputPath.replace(/\\/g, '/'))},generator:generatorName,codeLength:code.length,totalNodes:blocks.length,procedures:blocks.filter((block)=>block.type==='procedures_defnoreturn'||block.type==='procedures_defreturn').map((block)=>block.getFieldValue('NAME')).sort()});`
  );
  const evaluated = await evaluateCdp(expression, getCdpPort(args));
  if (!evaluated.value || !fs.existsSync(outputPath)) {
    fail('Mixly 代码生成失败', evaluated.raw);
  }
  return { projectPath, ...evaluated.value };
}

function projectBlockTypes(projectPath) {
  const parsed = parseProjectXml(fs.readFileSync(projectPath, 'utf8'));
  return unique(parsed.blocks.map((block) => block.type).filter(Boolean)).sort();
}

async function prepareWorkflowLibraries(args, board, boardSelector, projectPath) {
  if (!isMixly4()) {
    return {
      applicable: false,
      reason: 'Mixly 2/3 use their existing ThirdParty import model',
      imported: [],
      reused: []
    };
  }
  const cdpPort = getCdpPort(args);
  const blockTypes = projectBlockTypes(projectPath);
  const inferredNames = [];
  if (args.autoImportLibraries !== false) {
    for (let index = 0; index < blockTypes.length; index += 50) {
      const specs = await getBlockSpecs({
        board: boardSelector,
        blockTypes: blockTypes.slice(index, index + 50),
        includeSource: false,
        cdpPort
      });
      for (const spec of specs.specs || []) {
        const match = /^Plugin\/(.+)$/.exec(String(spec.owner || ''));
        if (match) inferredNames.push(match[1]);
      }
    }
  }
  const requestedNames = unique([
    ...inferredNames,
    ...(Array.isArray(args.libraryNames) ? args.libraryNames : []),
    ...(Array.isArray(args.mixlyLibraries) ? args.mixlyLibraries : [])
  ].map((name) => String(name).trim()).filter(Boolean));
  for (const name of requestedNames) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(name)) fail(`Mixly 4 工作流插件名不合法: ${name}`);
  }

  const context = await thirdPartyLibraryContext(board, { ...args, cdpPort }, {
    mode: 'analysis',
    libraryNames: requestedNames
  });
  let resources;
  try {
    resources = context.resources.map((resource) => ({
      name: resource.name,
      source: resource.source,
      installed: resource.installed === true,
      path: resource.path,
      stagingPath: resource.stagingPath || (resource.source === 'mixly4-staging' ? resource.path : null),
      version: resource.version || resource.metadata?.version || null
    }));
  } finally {
    context.cleanup();
  }

  const imported = [];
  const reused = [];
  const packageRoot = path.join(MIXLY4_STAGING_DIR, 'packages', mixly4BoardStorageKey(board));
  for (const name of requestedNames) {
    const resource = resources.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!resource) {
      fail(`Mixly 4 工作流找不到工程所需插件: ${name}`, {
        code: 'MIXLY4_WORKFLOW_LIBRARY_MISSING',
        projectPath,
        blockTypes,
        requestedNames,
        availableLibraries: resources.map((item) => item.name)
      });
    }
    if (!resource.stagingPath) {
      reused.push({ name: resource.name, source: resource.source, version: resource.version });
      continue;
    }
    const zipPath = path.join(packageRoot, `${resource.name}.zip`);
    const packaged = await packageLibrary({
      board: boardSelector,
      library: resource.name,
      outputPath: zipPath,
      cdpPort
    });
    const installed = await importLibrary({
      zipPath,
      libraryName: resource.name,
      board: boardSelector,
      cdpPort,
      waitMs: args.waitMs
    });
    imported.push({
      name: resource.name,
      inferredFromProject: inferredNames.includes(resource.name),
      zipPath,
      packaged: {
        source: packaged.source,
        fileEntries: packaged.fileEntries,
        directoryEntries: packaged.directoryEntries,
        entries: packaged.entries
      },
      installed: {
        format: installed.format,
        id: installed.id || installed.metadata?.id || resource.name,
        version: installed.version || installed.metadata?.version || null,
        installed: installed.installed === true
      }
    });
  }

  for (const zipInput of Array.isArray(args.libraryZipPaths) ? args.libraryZipPaths : []) {
    const zipPath = ensureInsideWorkspace(zipInput);
    const installed = await importLibrary({
      zipPath,
      board: boardSelector,
      cdpPort,
      waitMs: args.waitMs
    });
    imported.push({
      name: installed.libraryName,
      inferredFromProject: false,
      zipPath,
      packaged: null,
      installed: {
        format: installed.format || null,
        id: installed.id || installed.metadata?.id || installed.libraryName,
        version: installed.version || installed.metadata?.version || null,
        installed: installed.installed !== false
      }
    });
  }

  return {
    applicable: true,
    autoImport: args.autoImportLibraries !== false,
    projectBlockTypes: blockTypes,
    inferredNames: unique(inferredNames),
    requestedNames,
    imported,
    reused
  };
}

function mixly4DesktopCompileStateExpression() {
  return `(()=>{
    const selector='#arduino-compile-btn,[data-id="arduino-compile-btn"],[m-id="arduino-compile-btn"]';
    const buttons=Array.from(document.querySelectorAll(selector));
    const button=buttons.find((candidate)=>{const style=getComputedStyle(candidate);const rect=candidate.getBoundingClientRect();return rect.width>=2&&rect.height>=2&&style.display!=='none'&&style.visibility!=='hidden'})||buttons[0]||null;
    const manager=Mixly.app.getContext().getService('StatusBarsManager');
    const bar=manager&&manager.getStatusBarById('output');
    let output='';
    if(bar){
      if(typeof bar.getValue==='function')output=String(bar.getValue()||'');
      else {const editor=typeof bar.getEditor==='function'?bar.getEditor():bar.editor;output=editor&&typeof editor.getValue==='function'?String(editor.getValue()||''):String(bar.$dom&&bar.$dom.innerText||'');}
    }
    const generator=(typeof Blockly==='object'&&(Blockly.generator||Blockly.Arduino))||{};
    const workspace=typeof Blockly==='object'&&typeof Blockly.getMainWorkspace==='function'?Blockly.getMainWorkspace():null;
    const rect=button&&button.getBoundingClientRect();
    return JSON.stringify({title:document.title,buttonFound:Boolean(button),buttonVisible:Boolean(rect&&rect.width>=2&&rect.height>=2),buttonDisabled:Boolean(button&&button.disabled),output,blockCount:workspace?workspace.getAllBlocks(false).length:0,sketchFiles:Object.keys(generator.libs_||{})});
  })()`;
}

async function compileMixly4Desktop(args) {
  if (!isMixly4()) return { applicable: false, reason: 'not-mixly4' };
  const cdpPort = getCdpPort(args);
  const timeoutMs = Number(args.desktopCompileTimeoutMs || 300000);
  await requireCdpTarget('桌面 WASM 编译', cdpPort);
  await waitForWorkspace(cdpPort, Number(args.waitMs || 30000));
  let before = (await evaluateCdp(mixly4DesktopCompileStateExpression(), cdpPort)).value;
  if (before && before.buttonFound && !before.buttonVisible) {
    try {
      await clickCdpSelector('li.layui-nav-item.mixly-scrollbar > a', cdpPort);
    } catch (_) {
      await evaluateCdp(`(()=>{const more=Array.from(document.querySelectorAll('a,button,[role="button"]')).find((node)=>/^(?:更多|more)/i.test((node.innerText||node.title||node.getAttribute('aria-label')||'').trim()));if(more){more.click();return true}return false})()`, cdpPort);
    }
    const menuDeadline = Date.now() + 3000;
    while (Date.now() < menuDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      before = (await evaluateCdp(mixly4DesktopCompileStateExpression(), cdpPort)).value;
      if (before && before.buttonVisible) break;
    }
  }
  if (!before || !before.buttonFound || !before.buttonVisible || before.buttonDisabled) {
    fail('Mixly 4 当前板卡没有可点击的桌面编译按钮', {
      code: 'MIXLY4_WASM_COMPILE_BUTTON_UNAVAILABLE',
      state: before
    });
  }
  const compileSelector = '#arduino-compile-btn,[data-id="arduino-compile-btn"],[m-id="arduino-compile-btn"]';
  let click = await clickCdpSelector(compileSelector, cdpPort);
  let clickState = before;
  const clickConfirmationDeadline = Date.now() + 1500;
  while (Date.now() < clickConfirmationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    clickState = (await evaluateCdp(mixly4DesktopCompileStateExpression(), cdpPort)).value;
    if (clickState && clickState.output !== before.output) break;
  }
  if (!clickState || clickState.output === before.output) {
    const fallback = await evaluateCdp(`(()=>{const selector=${JSON.stringify(compileSelector)};const buttons=Array.from(document.querySelectorAll(selector));const button=buttons.find((candidate)=>{const style=getComputedStyle(candidate);const rect=candidate.getBoundingClientRect();return rect.width>=2&&rect.height>=2&&style.display!=='none'&&style.visibility!=='hidden'&&!candidate.disabled});if(!button)return JSON.stringify({clicked:false,method:'HTMLElement.click'});button.click();return JSON.stringify({clicked:true,method:'HTMLElement.click',tag:button.tagName,text:String(button.innerText||'').trim()})})()`, cdpPort);
    if (!fallback.value || fallback.value.clicked !== true) {
      fail('Mixly 4 编译按钮点击后没有启动编译', {
        code: 'MIXLY4_WASM_COMPILE_CLICK_UNCONFIRMED',
        primaryClick: click,
        fallback: fallback.value || fallback.raw,
        state: clickState
      });
    }
    click = {
      ...click,
      method: 'Input.dispatchMouseEvent+HTMLElement.click-fallback',
      fallback: fallback.value
    };
  } else {
    click = { ...click, confirmedByOutput: true };
  }
  const startedAt = Date.now();
  let changed = Boolean(clickState && clickState.output !== before.output);
  let runningSeen = Boolean(clickState && /(?:编译中|compil(?:e|ing)|loading .*compiler)/i.test(clickState.output || ''));
  let state = clickState || before;
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    try {
      state = (await evaluateCdp(mixly4DesktopCompileStateExpression(), cdpPort)).value;
    } catch (error) {
      fail('Mixly 4 在桌面 WASM 编译期间退出或失去响应', {
        code: 'MIXLY4_WASM_HOST_EXITED',
        elapsedMs: Date.now() - startedAt,
        error: error.message
      });
    }
    const output = String(state && state.output || '');
    changed = changed || output !== String(before.output || '');
    runningSeen = runningSeen || /编译中|compil(?:e|ing)|linking|resolving libraries/i.test(output);
    const success = /==\s*编译成功\s*==|==[^=]*compile\s*success[^=]*==/i.test(output);
    const failed = /==\s*编译失败\s*==|==[^=]*compile\s*fail(?:ed|ure)[^=]*==/i.test(output);
    if (failed) {
      fail('Mixly 4 桌面 WASM 编译失败', {
        code: 'MIXLY4_WASM_COMPILE_FAILED',
        click,
        elapsedMs: Date.now() - startedAt,
        output
      });
    }
    if (success && (changed || runningSeen || Date.now() - startedAt >= 1500)) {
      const metrics = compileMetrics(output);
      return {
        applicable: true,
        passed: true,
        engine: 'browser-wasm',
        validationScope: 'mixly4-visible-desktop-compile',
        desktopEquivalent: true,
        click,
        title: state.title,
        blockCount: state.blockCount,
        sketchFiles: state.sketchFiles,
        elapsedMs: Date.now() - startedAt,
        output: output.length > 6000 ? output.slice(-6000) : output,
        metrics,
        resourceRisk: compileResourceRisk(metrics)
      };
    }
  }
  fail('Mixly 4 桌面 WASM 编译超时', {
    code: 'MIXLY4_WASM_COMPILE_TIMEOUT',
    timeoutMs,
    click,
    changed,
    runningSeen,
    lastOutput: state && state.output
  });
}

async function projectWorkflow(args) {
  const board = getBoard(args.board);
  const boardSelector = board.selectedProfile ? `${board.id}@${board.selectedProfile}` : board.id;
  const projectPath = ensureInsideWorkspace(args.projectPath);
  const hasReferenceSource = args.sourceText != null || Boolean(args.sourcePath);
  if (args.equivalenceMode && !hasReferenceSource) {
    fail('使用 equivalenceMode 时必须同时传入 sourcePath 或 sourceText');
  }
  const hasTree = Boolean(args.treePath || args.tree);
  let build;
  if (hasTree) {
    build = await buildProject({ ...args, livePreview: false });
  } else {
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isFile()) {
      fail('mixly_project_workflow 需要 tree/treePath，或 projectPath 必须指向已经存在的 .mix 工程');
    }
    if (path.extname(projectPath).toLowerCase() !== '.mix') fail('projectPath 必须使用 .mix 后缀');
    build = {
      projectPath,
      skipped: true,
      reason: 'existing-project',
      totalNodes: parseProjectXml(fs.readFileSync(projectPath, 'utf8')).blocks.length
    };
  }
  const launchedResult = await launchMixly(args);
  const launched = {
    alreadyRunning: launchedResult.alreadyRunning,
    pid: launchedResult.pid || null,
    cdpPort: launchedResult.cdpPort,
    runtimeExecutable: launchedResult.runtimeExecutable || null,
    runtimeExecutableSource: launchedResult.runtimeExecutableSource || null,
    runtimeArchitecture: launchedResult.runtimeArchitecture || null,
    automation: launchedResult.runtime && launchedResult.runtime.automation,
    boardPage: launchedResult.boardPage ? {
      url: launchedResult.boardPage.url,
      workspace: launchedResult.boardPage.workspace
    } : null
  };
  const libraries = await prepareWorkflowLibraries(args, board, boardSelector, projectPath);
  const openedResult = await openProject({
    projectPath,
    board: boardSelector,
    cdpPort: getCdpPort(args),
    waitMs: args.waitMs
  });
  const opened = {
    projectPath: openedResult.projectPath,
    board: openedResult.board,
    url: openedResult.url,
    workspace: openedResult.workspace,
    loaded: openedResult.loaded
  };
  const validated = await validateProject({
    projectPath,
    board: boardSelector,
    customPrefixes: args.customPrefixes,
    sourcePath: args.sourcePath,
    sourceText: args.sourceText,
    requireChineseNames: args.requireChineseNames,
    allowExternalSourcePath: args.allowExternalSourcePath,
    cdpPort: getCdpPort(args)
  });
  const extension = board.language === 'C/C++' ? '.ino' : /Python/i.test(board.language) ? '.py' : '.txt';
  const outputPath = ensureInsideWorkspace(args.outputPath ||
    path.join(path.dirname(projectPath), `${path.basename(projectPath, path.extname(projectPath))}${extension}`));
  const generated = await generateCode({
    projectPath,
    outputPath,
    generator: args.generator,
    cdpPort: getCdpPort(args)
  });
  let equivalence = null;
  if (hasReferenceSource) {
    equivalence = verifyEquivalence({
      sourcePath: args.sourceText != null ? undefined : args.sourcePath,
      sourceText: args.sourceText,
      generatedPath: outputPath,
      supportPaths: args.equivalenceSupportPaths,
      mode: args.equivalenceMode || 'report',
      requiredPatterns: args.equivalenceRequiredPatterns,
      includeSupportInRequiredPatterns: args.equivalenceIncludeSupportInRequiredPatterns === true,
      ignoreStrings: args.equivalenceIgnoreStrings,
      ignoreIdentifiers: args.equivalenceIgnoreIdentifiers,
      allowExternalPath: args.allowExternalSourcePath === true
    });
    if (equivalence.passed === false) {
      fail('Mixly 生成代码未通过源码等价性审计', { equivalence });
    }
  }
  let desktopCompiled = null;
  if (isMixly4() && /C\/C\+\+/i.test(String(board.language || '')) && args.desktopCompile !== false) {
    desktopCompiled = await compileMixly4Desktop({
      cdpPort: getCdpPort(args),
      waitMs: args.waitMs,
      desktopCompileTimeoutMs: args.desktopCompileTimeoutMs
    });
  } else if (isMixly4()) {
    desktopCompiled = {
      applicable: false,
      reason: args.desktopCompile === false ? 'explicitly-disabled' : `board-language-${board.language || 'unknown'}`
    };
  }
  let compiled = null;
  if (args.compile === true) {
    compiled = await compileSketch({
      sketchPath: outputPath,
      fqbn: args.fqbn,
      fqbns: args.fqbns,
      arduinoCliPath: args.arduinoCliPath,
      arduinoCliConfigPath: args.arduinoCliConfigPath,
      librariesPath: args.librariesPath,
      librariesPaths: args.librariesPaths,
      board: boardSelector,
      mixlyLibraries: args.mixlyLibraries,
      allowExternalPath: false,
      keepBuild: args.keepBuild,
      timeoutMs: args.compileTimeoutMs
    });
    if (!compiled.passed) fail('Mixly 工程编译失败', { compiled });
  }
  return {
    passed: true,
    board: boardSelector,
    fqbn: board.fqbn || null,
    projectPath,
    outputPath,
    generation: MIXLY_LAYOUT.generation,
    finalCompileEngine: desktopCompiled && desktopCompiled.passed ? 'browser-wasm' : (compiled && compiled.passed ? 'arduino-cli' : null),
    stages: { build, launched, libraries, opened, validated, generated, equivalence, desktopCompiled, compiled }
  };
}

function executablesOnPath(commandName) {
  const pathDirectories = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const results = [];
  for (const directory of pathDirectories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${commandName}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) results.push(path.resolve(candidate));
    }
  }
  return results;
}

function copySketchSupport(sourceDir, targetDir, selectedFile) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    if (source === selectedFile) continue;
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      copySketchSupport(source, target, selectedFile);
    } else if (!/\.ino$/i.test(entry.name)) {
      fs.copyFileSync(source, target);
    }
  }
}

function stageSketchForCli(sketchPath) {
  const stat = fs.statSync(sketchPath);
  let sourceDir = stat.isDirectory() ? sketchPath : path.dirname(sketchPath);
  let selectedFile = stat.isFile() ? sketchPath : null;
  if (stat.isDirectory()) {
    const inoFiles = fs.readdirSync(sketchPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ino$/i.test(entry.name))
      .map((entry) => path.join(sketchPath, entry.name));
    if (inoFiles.length === 1) selectedFile = inoFiles[0];
  }
  if (!selectedFile || !/\.ino$/i.test(selectedFile)) {
    return { sketchPath, cleanup: null, staged: false };
  }
  const stem = path.basename(selectedFile, path.extname(selectedFile));
  if (path.basename(sourceDir) === stem && path.basename(selectedFile) === `${stem}.ino`) {
    return { sketchPath: sourceDir, cleanup: null, staged: false };
  }
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-mcp-sketch-'));
  try {
    const targetDir = path.join(stagingRoot, stem);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(selectedFile, path.join(targetDir, `${stem}.ino`));
    // A generated sketch may live directly in MIXLY_HOME. In that case its
    // siblings are application assets and live profile files, not sketch
    // support files; copying them can be huge and can hit locked nw_cache
    // session files while the desktop app is open.
    if (path.resolve(sourceDir) !== path.resolve(ROOT)) {
      copySketchSupport(sourceDir, targetDir, selectedFile);
    }
    return { sketchPath: targetDir, cleanup: () => fs.rmSync(stagingRoot, { recursive: true, force: true }), staged: true };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function arduinoCliCandidates(explicitPath) {
  return unique([
    explicitPath ? path.resolve(explicitPath) : null,
    process.env.ARDUINO_CLI ? path.resolve(process.env.ARDUINO_CLI) : null,
    path.join(ROOT, 'arduino-cli', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'),
    path.join(ROOT, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'),
    process.platform === 'win32' ? 'C:/Program Files/arduino-cli/arduino-cli.exe' : null,
    process.platform === 'win32'
      ? 'C:/Program Files/Arduino IDE/resources/app/lib/backend/resources/arduino-cli.exe'
      : null,
    ...executablesOnPath('arduino-cli')
  ].filter((candidate) => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()));
}

function findArduinoCli(explicitPath) {
  const candidates = arduinoCliCandidates(explicitPath);
  if (explicitPath && !candidates.some((candidate) => path.resolve(candidate) === path.resolve(explicitPath))) {
    fail(`指定的 arduino-cli 不存在: ${path.resolve(explicitPath)}`);
  }
  return candidates[0] || null;
}

function resolveArduinoCliConfig(explicitPath, arduinoCli) {
  if (explicitPath) {
    const configPath = path.resolve(explicitPath);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
      fail(`指定的 arduino-cli 配置文件不存在: ${configPath}`);
    }
    return { path: configPath, source: 'explicit' };
  }
  if (!arduinoCli) return { path: null, source: null };
  const cliPath = path.resolve(arduinoCli);
  const relative = path.relative(ROOT, cliPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { path: null, source: 'arduino-cli-default' };
  }
  const directory = path.dirname(cliPath);
  const candidate = [
    path.join(directory, 'arduino-cli.json'),
    path.join(directory, 'arduino-cli.yaml'),
    path.join(directory, 'arduino-cli.yml')
  ].find((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
  return candidate
    ? { path: candidate, source: 'adjacent-to-bundled-cli' }
    : { path: null, source: 'arduino-cli-default' };
}

function generationAwareWorkflow() {
  if (!isMixly4()) {
    return {
      generation: MIXLY_LAYOUT.generation,
      finalTool: 'mixly_project_workflow',
      libraryModel: 'filesystem-third-party',
      compileEngine: 'arduino-cli-or-board-runtime',
      rules: [
        '优先扫描并复用本地官方与 ThirdParty 积木。',
        '缺失原语才创建传统 block/generator/index.xml 库。',
        '新工程使用 mixly_build_project 的 tree/treePath；不要手写 .mix XML 或自行拼 next 标签。',
        '交付前调用 mixly_project_workflow 真实打开、验证和生成代码。'
      ]
    };
  }
  const runtime = preferredMixlyRuntime();
  return {
    generation: 4,
    finalTool: 'mixly_project_workflow',
    mandatory: true,
    libraryModel: 'plugin-manager-opfs',
    compileEngine: 'browser-wasm',
    compatibilityCompileEngine: 'arduino-cli',
    desktopEquivalent: false,
    preferredRuntime: runtime ? {
      executable: runtime.path,
      source: runtime.source,
      architecture: runtime.architecture,
      automationCapable: runtime.nwRuntime || runtime.sdk
    } : null,
    rules: [
      '禁止把 Mixly 2/3 的 libraries/ThirdParty 文件夹复制流程套到 Mixly 4。',
      '自定义库必须生成 plugin.json、index.xml、ES module index.js，并通过 PluginManager 安装到 OPFS。',
      'WASM 编译需要的非内置 .h/.hpp/.c/.cc/.cpp 必须传给 mixly_create_library.wasmSketchFiles；只放 extraFiles/libraries 不会自动参与浏览器链接。',
      '不要用 shell 直接修改 .mixly-mcp-staging；更新已有自制库时重新调用 mixly_create_library(overwrite=true)，让 MCP 重做语法和覆盖校验。',
      '新工程必须使用 mixly_build_project 的 tree/treePath；禁止手写 .mix XML，结构树会自动转义 < 并正确嵌套 next。',
      '创建库和工程后必须调用 mixly_project_workflow；它会自动发现工程引用的暂存插件、打包、导入、打开、验证、生成代码并默认点击桌面 WASM 编译。',
      'mixly_compile 的 Arduino CLI 结果只表示生成 C++ 兼容，不是 Mixly 4 桌面编译通过。'
    ],
    requiredSequence: [
      'mixly_detect_environment',
      'mixly_scan_library(queries=[能力...], includeSpecs=true) + mixly_scan_arduino_libraries',
      'mixly_get_block_specs（仅补查未随扫描返回的复杂动态块）',
      'mixly_create_library（仅缺少底层原语时，按需提供 wasmSketchFiles）',
      'mixly_project_workflow（最终闭环，不得停在创建 ZIP 或 .mix）'
    ]
  };
}

async function detectEnvironment(args) {
  const cdpPort = getCdpPort(args);
  const cdp = await getCdpDiagnostics(cdpPort);
  const http = isMixly4() ? await probeMixlyHttp(mixlyHttpOrigin()) : null;
  const details = args.details === true;

  const cliCandidates = arduinoCliCandidates(args.arduinoCliPath);
  const selectedCli = cliCandidates[0] || null;
  const cliConfig = resolveArduinoCliConfig(args.arduinoCliConfigPath, selectedCli);
  let cliProbe = null;
  if (selectedCli && args.probeCli === true) {
    const version = await runCommand(selectedCli, ['version'], { timeoutMs: 15000 });
    const coreArgs = [
      'core', 'list',
      ...(cliConfig.path ? ['--config-file', cliConfig.path] : [])
    ];
    const cores = await runCommand(selectedCli, coreArgs, { timeoutMs: 30000 });
    cliProbe = {
      version: `${version.stdout}\n${version.stderr}`.trim(),
      versionExitCode: version.code,
      installedCores: `${cores.stdout}\n${cores.stderr}`.trim(),
      coreListExitCode: cores.code
    };
  }

  const libraryCandidates = unique([
    DEFAULT_LIB_ROOT,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Documents', 'Arduino', 'libraries') : null,
    process.env.HOME ? path.join(process.env.HOME, 'Arduino', 'libraries') : null
  ].filter((candidate) => candidate && fs.existsSync(candidate)));
  const wasmPackages = wasmPackageSummary();
  const boards = details
    ? getBoardCatalog()
    : getBoardCatalog().map((board) => ({
      ...compactBoardForDiscovery(board),
      profileCount: Array.isArray(board.profiles) ? board.profiles.length : 0
    }));
  const cdpSummary = details ? cdp : {
    running: cdp.running,
    available: cdp.available,
    port: cdp.port,
    target: cdp.target ? {
      type: cdp.target.type,
      title: cdp.target.title,
      url: cdp.target.url,
      origin: cdp.target.origin
    } : null,
    reason: cdp.reason
  };
  const wasmPackageResult = details ? wasmPackages : wasmPackages.map((item) => ({
    kind: item.kind,
    platform: item.platform,
    archiveName: item.archiveName,
    archiveBytes: item.archiveBytes,
    libraryCount: item.libraryCount,
    compilerFqbns: item.compilerFqbns
  }));

  return {
    mixlyRoot: ROOT,
    mixlyLayout: mixlyLayoutSummary(),
    launch: {
      runtime: MIXLY_LAYOUT.runtime,
      generation: MIXLY_LAYOUT.generation,
      httpOrigin: mixlyHttpOrigin(),
      requiresHttpServer: MIXLY_LAYOUT.generation === 4,
      http,
      automation: {
        available: cdp.available,
        transport: cdp.available ? 'cdp' : null,
        reason: cdp.available ? null : 'cdpUnavailable'
      }
    },
    mixlyExecutable: fs.existsSync(MIXLY_EXE) ? MIXLY_EXE : null,
    node: { executable: process.execPath, version: process.version, platform: process.platform, arch: process.arch },
    boards,
    boardCount: boards.length,
    cdp: cdpSummary,
    arduinoCli: {
      selected: selectedCli,
      configFile: cliConfig.path,
      configSource: cliConfig.source,
      candidates: details ? cliCandidates : undefined,
      probe: cliProbe
    },
    compileEngines: compileEngineSummary(wasmPackages, selectedCli),
    generationAwareWorkflow: generationAwareWorkflow(),
    libraryCandidates: details ? libraryCandidates : undefined,
    wasmPackages: wasmPackageResult,
    detailsIncluded: details
  };
}

function compileMetrics(text) {
  const flash = text.match(/Sketch uses\s+([\d,]+) bytes.*?Maximum is\s+([\d,]+) bytes/i);
  const sram = text.match(/Global variables use\s+([\d,]+) bytes.*?maximum is\s+([\d,]+) bytes/i);
  const metric = (match) => {
    if (!match) return null;
    const used = Number(match[1].replace(/,/g, ''));
    const maximum = Number(match[2].replace(/,/g, ''));
    return {
      used,
      maximum,
      percent: maximum > 0 ? Number(((used / maximum) * 100).toFixed(1)) : null
    };
  };
  return {
    flash: metric(flash),
    sram: metric(sram)
  };
}

function compileResourceRisk(metrics) {
  const warnings = [];
  let level = 'normal';
  const inspect = (name, metric, warningAt, highAt, explanation) => {
    if (!metric || metric.percent == null) return;
    if (metric.percent >= highAt) {
      level = 'high';
      warnings.push(`${name} 使用率 ${metric.percent}%（${metric.used}/${metric.maximum} bytes），${explanation}`);
    } else if (metric.percent >= warningAt) {
      if (level !== 'high') level = 'warning';
      warnings.push(`${name} 使用率 ${metric.percent}%（${metric.used}/${metric.maximum} bytes），余量偏低`);
    }
  };
  inspect('Flash', metrics.flash, 80, 90, '已接近程序存储上限');
  inspect('SRAM', metrics.sram, 70, 80, '静态占用较高，运行期栈、堆和库缓冲区仍会继续使用内存');
  if (!metrics.flash && !metrics.sram) level = 'unknown';
  return { level, warnings };
}

function compileLibraryLogicalPath(board, resource, sourceRoot, source) {
  const name = String(resource.name || '').trim();
  if (source === 'filesystem') {
    return path.join(board.root, 'libraries', 'ThirdParty', name, 'libraries');
  }
  if (source === 'mixly4-staging') return path.join(sourceRoot, 'libraries');
  const root = String(resource.opfsRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const version = String(resource.version || resource.metadata?.currentVersion || resource.metadata?.version || '').trim();
  return [root, name, version, 'libraries'].filter(Boolean).join('/');
}

function compileLibraryCandidates(board, resource, context) {
  const candidates = [];
  const append = (sourceRoot, source, temporary) => {
    if (!sourceRoot || !fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) return;
    const librariesPath = path.join(sourceRoot, 'libraries');
    if (!fs.existsSync(librariesPath) || !fs.statSync(librariesPath).isDirectory()) return;
    candidates.push({
      name: resource.name,
      source,
      path: librariesPath,
      logicalPath: compileLibraryLogicalPath(board, resource, sourceRoot, source),
      temporary,
      pluginPath: sourceRoot
    });
  };

  // Staging is deterministic and is preferred when a library was just created
  // by the MCP. Fall back to the materialized OPFS copy for installed plugins.
  if (resource.stagingPath) append(resource.stagingPath, 'mixly4-staging', false);
  if (resource.path && resource.path !== resource.stagingPath) {
    const source = resource.source === 'mixly4-opfs' ? 'mixly4-opfs' : resource.source;
    append(resource.path, source, source === 'mixly4-opfs');
  }
  for (const candidate of candidates) {
    if (candidate.source === 'mixly4-opfs') {
      candidate.opfsRoot = context.storage.root || null;
      candidate.logicalPath = compileLibraryLogicalPath(board, {
        ...resource,
        opfsRoot: candidate.opfsRoot
      }, candidate.pluginPath, candidate.source);
    }
  }
  return candidates;
}

async function resolveCompileLibraryPaths(args, allowExternal) {
  const explicitInputs = [
    ...(args.librariesPath ? [{ value: args.librariesPath, field: 'librariesPath' }] : []),
    ...(Array.isArray(args.librariesPaths)
      ? args.librariesPaths.map((value, index) => ({ value, field: `librariesPaths[${index}]` }))
      : [])
  ];
  const explicitPaths = explicitInputs.map(({ value, field }) => {
    if (!String(value).trim()) fail(`参数 ${field} 不能为空`);
    const resolved = resolveInputPath(value, allowExternal);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      fail(`Arduino 库目录不存在或不是目录 (${field}): ${resolved}`);
    }
    return resolved;
  });

  const requestedMixlyLibraries = [];
  const requestedNames = new Set();
  for (const name of Array.isArray(args.mixlyLibraries) ? args.mixlyLibraries : []) {
    const key = name.toLowerCase();
    if (requestedNames.has(key)) continue;
    requestedNames.add(key);
    requestedMixlyLibraries.push(name);
  }
  if (requestedMixlyLibraries.length && !args.board) {
    fail('使用 mixlyLibraries 时必须同时传入 board');
  }
  const resolvedMixlyLibraries = [];
  const selectedBoard = args.board ? getBoard(args.board) : null;
  let mixlyBoard = selectedBoard
    ? (selectedBoard.selectedProfile ? `${selectedBoard.id}@${selectedBoard.selectedProfile}` : selectedBoard.id)
    : null;
  let mixlyContext = null;
  if (requestedMixlyLibraries.length) {
    const board = selectedBoard;
    mixlyContext = await thirdPartyLibraryContext(board, args, {
      mode: isMixly4() ? 'libraries' : 'analysis',
      libraryNames: requestedMixlyLibraries
    });
    const availableLibraries = mixlyContext.resources.map((resource) => resource.name).sort();
    for (const requestedName of requestedMixlyLibraries) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(requestedName)) {
        mixlyContext.cleanup();
        fail(`Mixly library name is invalid: ${requestedName}`);
      }
      const resource = mixlyContext.resources.find((candidate) =>
        candidate.name.toLowerCase() === requestedName.toLowerCase()
      );
      if (!resource) {
        const details = {
          board: board.id,
          availableMixlyLibraries: availableLibraries,
          pluginStorage: mixlyContext.storage
        };
        mixlyContext.cleanup();
        if (isMixly4() && !mixlyContext.storage.available) {
          details.code = 'MIXLY4_OPFS_UNAVAILABLE';
          fail(`Unable to read Mixly 4 plugin library: ${requestedName}`, details);
        }
        fail(`Mixly ThirdParty library is not installed: ${requestedName}`, details);
      }
      const candidates = compileLibraryCandidates(board, resource, mixlyContext);
      const selected = candidates[0];
      if (!selected) {
        const details = {
          board: board.id,
          library: resource.name,
          pluginStorage: mixlyContext.storage,
          pluginPath: resource.path,
          stagingPath: resource.stagingPath || null,
          candidates: candidates.map((candidate) => candidate.path)
        };
        mixlyContext.cleanup();
        fail(`Mixly library has no Arduino libraries directory: ${resource.name}`, details);
      }
      // Keep the Mixly 2/3 response contract byte-for-byte compatible while
      // exposing source/temporary paths for the new Mixly 4 resolver.
      resolvedMixlyLibraries.push(!isMixly4() && selected.source === 'filesystem'
        ? { name: selected.name, path: selected.path }
        : selected);
    }
  }

  let defaultPath = null;
  if (explicitInputs.length === 0 && fs.existsSync(DEFAULT_LIB_ROOT)) {
    if (!fs.statSync(DEFAULT_LIB_ROOT).isDirectory()) {
      fail(`默认 Arduino 库路径不是目录: ${DEFAULT_LIB_ROOT}`);
    }
    defaultPath = DEFAULT_LIB_ROOT;
  }
  const allPaths = [
    ...(defaultPath ? [defaultPath] : []),
    ...explicitPaths,
    ...resolvedMixlyLibraries.map((library) => library.path)
  ];
  const pathKeys = new Set();
  const librariesPaths = allPaths.filter((libraryPath) => {
    const key = process.platform === 'win32' ? libraryPath.toLowerCase() : libraryPath;
    if (pathKeys.has(key)) return false;
    pathKeys.add(key);
    return true;
  });
  const cleanupState = {
    required: Boolean(mixlyContext),
    completed: false,
    temporaryPaths: mixlyContext?.storage?.materializedRoot ? [mixlyContext.storage.materializedRoot] : [],
    removed: []
  };
  const cleanup = () => {
    if (!mixlyContext) {
      cleanupState.completed = true;
      return;
    }
    const temporaryPaths = cleanupState.temporaryPaths.slice();
    mixlyContext.cleanup();
    cleanupState.removed = temporaryPaths.filter((candidate) => !fs.existsSync(candidate));
    cleanupState.completed = true;
  };
  return {
    librariesPath: librariesPaths[0] || null,
    librariesPaths,
    mixlyBoard,
    mixlyLibraryPaths: resolvedMixlyLibraries,
    selectedBoard,
    mixlyLibraryStorage: mixlyContext ? mixlyContext.storage : null,
    cleanupState,
    cleanup
  };
}

function tryFqbnBase(value) {
  const normalized = String(value || '').trim();
  const parts = normalized.split(':');
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !part.trim())) return null;
  return parts.slice(0, 3).join(':').toLowerCase();
}

function fqbnBase(value) {
  const base = tryFqbnBase(value);
  if (!base) fail(`FQBN 格式不正确: ${value}`);
  return base;
}

function compileFqbnList(args) {
  const hasSingle = args.fqbn != null;
  const hasMultiple = Array.isArray(args.fqbns) && args.fqbns.length > 0;
  if (hasSingle && hasMultiple) fail('fqbn 与 fqbns 只能选择一个，不能同时传入');
  const values = hasMultiple ? args.fqbns : (hasSingle ? [args.fqbn] : []);
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < values.length; index++) {
    const value = String(values[index]).trim();
    if (!value) fail(`${hasMultiple ? `fqbns[${index}]` : 'fqbn'} 不能为空`);
    fqbnBase(value);
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  if (!normalized.length) fail('编译前必须由 AI 根据用户板卡传入 fqbn 或 fqbns');
  return normalized;
}

function validateCompileBoardFqbns(board, fqbns) {
  if (!board) return { checked: false, board: null, candidates: [], matches: [] };
  const profiles = board.selectedProfile
    ? [{ name: board.selectedProfile, fqbn: board.fqbn }]
    : (board.profiles || []);
  const candidates = profiles
    .filter((profile) => profile && profile.fqbn)
    .map((profile) => ({ name: profile.name, fqbn: profile.fqbn, base: tryFqbnBase(profile.fqbn) }))
    .filter((profile) => profile.base);
  if (!candidates.length) {
    return { checked: false, board: board.id, candidates: [], matches: [] };
  }
  const matches = fqbns.map((fqbn) => ({
    fqbn,
    profiles: candidates
      .filter((candidate) => candidate.base === fqbnBase(fqbn))
      .map(({ name, fqbn: profileFqbn }) => ({ name, fqbn: profileFqbn }))
  }));
  const mismatches = matches.filter((item) => item.profiles.length === 0).map((item) => item.fqbn);
  if (mismatches.length) {
    fail('编译 FQBN 与所选 Mixly 板卡不匹配', {
      board: board.selectedProfile ? `${board.id}@${board.selectedProfile}` : board.id,
      mismatches,
      availableFqbns: unique(candidates.map((candidate) => candidate.fqbn))
    });
  }
  return {
    checked: true,
    board: board.selectedProfile ? `${board.id}@${board.selectedProfile}` : board.id,
    candidates: unique(candidates.map((candidate) => candidate.fqbn)),
    matches
  };
}

async function compileSketch(args) {
  const allowExternal = args.allowExternalPath === true;
  const sketchPath = resolveInputPath(args.sketchPath, allowExternal);
  if (!fs.existsSync(sketchPath)) fail(`Arduino 工程不存在: ${sketchPath}`);
  const libraryResolution = await resolveCompileLibraryPaths(args, allowExternal);
  let staged = null;
  try {
    const arduinoCli = findArduinoCli(args.arduinoCliPath);
    if (!arduinoCli) {
      fail('找不到 arduino-cli；请先调用 mixly_detect_environment，或显式传 arduinoCliPath');
    }
    const arduinoCliConfig = resolveArduinoCliConfig(args.arduinoCliConfigPath, arduinoCli);
    const fqbnList = compileFqbnList(args);
    const boardFqbnValidation = validateCompileBoardFqbns(libraryResolution.selectedBoard, fqbnList);
    const results = [];
    const timeoutMs = Number(args.timeoutMs || DEFAULT_COMPILE_TIMEOUT_MS);
    staged = stageSketchForCli(sketchPath);
    for (const fqbn of fqbnList) {
      const buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-mcp-build-'));
      let result;
      try {
        const compileArgs = [
          'compile',
          ...(arduinoCliConfig.path ? ['--config-file', arduinoCliConfig.path] : []),
          '--fqbn', fqbn
        ];
        for (const librariesPath of libraryResolution.librariesPaths) {
          compileArgs.push('--libraries', librariesPath);
        }
        compileArgs.push('--build-path', buildPath, staged.sketchPath);
        result = await runCommand(arduinoCli, compileArgs, { timeoutMs });
      } finally {
        if (args.keepBuild !== true) fs.rmSync(buildPath, { recursive: true, force: true });
      }
      const diagnostics = `${result.stdout}\n${result.stderr}`.trim();
      const metrics = compileMetrics(diagnostics);
      results.push({
        fqbn,
        code: result.code,
        timedOut: result.timedOut,
        metrics,
        resourceRisk: compileResourceRisk(metrics),
        diagnostics: diagnostics.length > 30000 ? diagnostics.slice(-30000) : diagnostics,
        buildPath: args.keepBuild === true ? buildPath : null
      });
    }
    const riskRank = { unknown: 0, normal: 1, warning: 2, high: 3 };
    const highestRisk = results.reduce((current, item) =>
      riskRank[item.resourceRisk.level] > riskRank[current] ? item.resourceRisk.level : current, 'unknown');
    return {
      engine: 'arduino-cli',
      validationScope: isMixly4() ? 'generated-cpp-compatibility' : 'arduino-compile',
      desktopEquivalent: isMixly4() ? false : null,
      sketchPath,
      cliSketchPath: staged.sketchPath,
      staged: staged.staged,
      arduinoCli,
      arduinoCliConfigPath: arduinoCliConfig.path,
      arduinoCliConfigSource: arduinoCliConfig.source,
      boardFqbnValidation,
      librariesPath: libraryResolution.librariesPath,
      librariesPaths: libraryResolution.librariesPaths,
      mixlyBoard: libraryResolution.mixlyBoard,
      mixlyLibraryPaths: libraryResolution.mixlyLibraryPaths,
      mixlyLibraryStorage: libraryResolution.mixlyLibraryStorage,
      cleanup: libraryResolution.cleanupState,
      timeoutMs,
      results,
      resourceRisk: {
        level: highestRisk,
        warnings: results.flatMap((item) => item.resourceRisk.warnings.map((message) => ({ fqbn: item.fqbn, message })))
      },
      passed: results.every((item) => item.code === 0 && !item.timedOut)
    };
  } finally {
    if (staged && staged.cleanup) staged.cleanup();
    libraryResolution.cleanup();
  }
}

function validateArguments(toolName, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('工具参数必须是 JSON 对象');
  const definition = toolDefinitions.find((tool) => tool.name === toolName);
  if (!definition) fail(`未知工具: ${toolName}`);
  const schema = definition.inputSchema;
  for (const required of schema.required || []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      fail(`缺少必填参数: ${required}`);
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties[name];
    if (!property || value == null) continue;
    if (property.type === 'string' && typeof value !== 'string') fail(`参数 ${name} 必须是字符串`);
    if (property.type === 'boolean' && typeof value !== 'boolean') fail(`参数 ${name} 必须是布尔值`);
    if ((property.type === 'number' || property.type === 'integer') &&
      (typeof value !== 'number' || !Number.isFinite(value))) {
      fail(`参数 ${name} 必须是数字`);
    }
    if (property.type === 'integer' && !Number.isInteger(value)) fail(`参数 ${name} 必须是整数`);
    if (property.type === 'array' && !Array.isArray(value)) fail(`参数 ${name} 必须是数组`);
    if (property.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) fail(`参数 ${name} 必须是对象`);
    if (property.type === 'array' && Array.isArray(value)) {
      if (property.minItems != null && value.length < property.minItems) fail(`参数 ${name} 项目数少于 ${property.minItems}`);
      if (property.maxItems != null && value.length > property.maxItems) fail(`参数 ${name} 项目数多于 ${property.maxItems}`);
      if (property.items && property.items.type === 'string' && value.some((item) => typeof item !== 'string')) {
        fail(`参数 ${name} 的每一项都必须是字符串`);
      }
      if (property.items && property.items.type === 'object' && value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
        fail(`参数 ${name} 的每一项都必须是对象`);
      }
    }
    if (property.enum && !property.enum.includes(value)) fail(`参数 ${name} 不在允许范围内`);
    if (property.pattern && typeof value === 'string' && !(new RegExp(property.pattern)).test(value)) {
      fail(`参数 ${name} 格式不正确`);
    }
    if (property.minimum != null && value < property.minimum) fail(`参数 ${name} 小于最小值`);
    if (property.maximum != null && value > property.maximum) fail(`参数 ${name} 大于最大值`);
  }
  return args;
}

async function callTool(name, rawArgs = {}) {
  const args = validateArguments(name, rawArgs);
  switch (name) {
    case 'mixly_scan_library': return scanLibrary(args);
    case 'mixly_scan_arduino_libraries': return scanArduinoLibraries(args);
    case 'mixly_get_block_specs': return getBlockSpecs(args);
    case 'mixly_inspect_library': return inspectLibrary(args);
    case 'mixly_detect_environment': return detectEnvironment(args);
    case 'mixly_get_board_profiles': return getBoardProfiles(args);
    case 'mixly_analyze_source': return analyzeSource(args);
    case 'mixly_verify_equivalence': return verifyEquivalence(args);
    case 'mixly_create_library': return createLibrary(args);
    case 'mixly_build_project': return buildProject(args);
    case 'mixly_save_project': return saveProject(args);
    case 'mixly_package_library': return packageLibrary(args);
    case 'mixly_launch': return launchMixly(args);
    case 'mixly_import_library': return importLibrary(args);
    case 'mixly_open_project': return openProject(args);
    case 'mixly_validate_project': return validateProject(args);
    case 'mixly_generate_code': return generateCode(args);
    case 'mixly_project_workflow': return projectWorkflow(args);
    case 'mixly_compile': return compileSketch(args);
    default: fail(`未知工具: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function mcpServerInstructions() {
  const generationNotice = isMixly4()
    ? 'Mixly 4 强制规则：使用 PluginManager/OPFS；非内置 C/C++ 必须放入 wasmSketchFiles；最终调用 mixly_project_workflow 自动启动软件、导入插件并点击桌面 WASM 编译。mixly_compile 仅是 CLI 兼容检查。'
    : 'Mixly 2/3 使用本地官方积木与传统 ThirdParty 库，最终调用 mixly_project_workflow。';
  return `${generationNotice} 快速流程：先 mixly_detect_environment（默认勿探测 CLI），分析源码后优先一次调用 mixly_scan_library(queries=[能力关键词...],includeSpecs=true)；只有复杂动态块再调用 mixly_get_block_specs，勿用 shell 搜官方生成器。不要索取 full 或示例，除非确有需要。优先拼官方/已安装积木，缺失底层原语才建小库；更新自制库应重新调用 mixly_create_library(overwrite=true)，不要直接修改 staging。新工程只能用 mixly_build_project 的 tree/treePath，禁止手写 .mix XML；它会自动转义文本并嵌套 next。Mixly 4 中每完成一组可运行结构树可立即刷新 Blockly，但不要为了动画逐块重发完整工程。变量、函数、判断、循环和硬件操作保持可见；不得为回避变量/XML而把业务状态机藏进自定义库，没有 ELSE 子树不得添加“否则”。有参考源码时做等价审计。最终交付不得停在 ZIP 或 .mix。`;
}

function toolResultText(toolName, value) {
  const summary = { tool: toolName, ok: true };
  if (value && typeof value === 'object') {
    for (const key of [
      'passed', 'status', 'board', 'boardCount', 'generation', 'finalCompileEngine',
      'projectPath', 'outputPath', 'libraryName', 'zipPath', 'resultMode', 'query',
      'requested', 'found', 'matchedCount', 'truncated', 'cache'
    ]) {
      if (value[key] !== undefined) summary[key] = value[key];
    }
    if (toolName === 'mixly_detect_environment') {
      summary.mixlyRoot = value.mixlyRoot;
      summary.layout = value.mixlyLayout;
      summary.boards = Array.isArray(value.boards) ? value.boards.map((board) => board.id) : [];
      summary.cdpAvailable = Boolean(value.cdp && value.cdp.available);
      summary.finalTool = value.generationAwareWorkflow && value.generationAwareWorkflow.finalTool;
      summary.compileEngine = value.generationAwareWorkflow && value.generationAwareWorkflow.compileEngine;
    } else if (toolName === 'mixly_scan_library') {
      summary.board = value.board && value.board.id || value.board;
      summary.totals = value.totals || value.official;
      summary.candidates = value.availableBlockTypes || [];
      summary.next = value.resultMode === 'summary'
        ? '再次调用 mixly_scan_library 并传 queries + includeSpecs=true'
        : Array.isArray(value.specs) ? '使用已返回的真实契约构建 tree/treePath' : '对选中的 type 调用 mixly_get_block_specs';
    } else if (toolName === 'mixly_get_block_specs') {
      summary.types = Array.isArray(value.specs) ? value.specs.map((spec) => ({ type: spec.type, owner: spec.owner })) : [];
      summary.unknownTypes = value.unknownTypes || [];
      summary.examplesIncluded = value.examplesIncluded;
    } else if (toolName === 'mixly_build_project') {
      summary.totalNodes = value.totalNodes;
      summary.livePreview = value.livePreview;
    } else if (toolName === 'mixly_project_workflow' && value.stages) {
      summary.importedLibraries = value.stages.libraries && Array.isArray(value.stages.libraries.imported)
        ? value.stages.libraries.imported.map((item) => item.name)
        : [];
      summary.desktopCompiled = Boolean(value.stages.desktopCompiled && value.stages.desktopCompiled.passed);
      summary.metrics = value.stages.desktopCompiled && value.stages.desktopCompiled.metrics || null;
    }
  }
  summary.detail = '完整结果见 structuredContent';
  return JSON.stringify(summary);
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0') {
    send({ jsonrpc: '2.0', id: message && message.id != null ? message.id : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'exit') {
    process.exit(0);
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mixly-local-builder', version: MCP_SERVER_VERSION },
        instructions: mcpServerInstructions()
      }
    });
    return;
  }
  if (message.method === 'ping') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: listedToolDefinitions() } });
    return;
  }
  if (message.method === 'tools/call') {
    callTool(message.params && message.params.name, (message.params && message.params.arguments) || {})
      .then((value) => send({
        jsonrpc: '2.0', id: message.id,
        result: {
          structuredContent: value,
          content: [{ type: 'text', text: toolResultText(message.params && message.params.name, value) }]
        }
      }))
      .catch((error) => {
        process.stderr.write(`[mixly-local-mcp] ${error.stack || error.message || String(error)}\n`);
        send({
          jsonrpc: '2.0', id: message.id,
          result: {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ message: error.message, details: error.details || null }, null, 2)
            }]
          }
        });
      });
    return;
  }
  if (message.id != null) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
  }
}

function startServer() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (!line.trim()) return;
    try {
      handleMessage(JSON.parse(line));
    } catch (error) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    }
  });
  input.on('close', () => process.exit(0));
}

if (require.main === module) startServer();

module.exports = {
  projectLoadDiagnostics,
  detectMixlyLayout,
  mixlyHttpOrigin,
  buildEditorUrl,
  projectUrl,
  selectCdpTarget,
  summarizeCdpTargets,
  getCdpPort,
  getCdpDiagnostics,
  generationAwareWorkflow,
  mcpServerInstructions,
  preferredMixlyRuntime
};
