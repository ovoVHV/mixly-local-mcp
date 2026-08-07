'use strict';

/*
 * Local Mixly MCP server.
 * stdout is reserved for newline-delimited JSON-RPC; diagnostics use stderr.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { compareCode } = require('./mixly_code_equivalence');

function looksLikeMixlyRoot(candidate) {
  if (!candidate) return false;
  const resolved = path.resolve(candidate);
  return fs.existsSync(path.join(resolved, 'resources', 'app', 'src', 'boards')) ||
    fs.existsSync(path.join(resolved, 'boards'));
}

function resolveMixlyRoot() {
  const candidates = [
    process.env.MIXLY_HOME,
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
const APP_SRC_ROOT = fs.existsSync(path.join(ROOT, 'resources', 'app', 'src', 'boards'))
  ? path.join(ROOT, 'resources', 'app', 'src')
  : ROOT;
const MIXLY_EXE = path.join(ROOT, process.platform === 'win32' ? 'Mixly.exe' : 'mixly');
const DEFAULT_LIB_ROOT = path.join(ROOT, 'arduino-cli', 'libraries');
const BOARDS_DIR = path.join(APP_SRC_ROOT, 'boards');
const DEFAULT_CDP_PORT = 9333;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const COMMAND_TIMEOUT_MS = 180000;
const DEFAULT_COMPILE_TIMEOUT_MS = 900000;

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writesLocal = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const mayOverwrite = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

const toolDefinitions = [
  {
    name: 'mixly_scan_library',
    title: '扫描本地 Mixly 积木',
    description: '扫描指定板卡当前安装的官方积木、生成器和 ThirdParty 第三方库，同时识别 Mixly 3 的 bundle、xml 和 default_src。结果动态来自本地文件；选中候选后可调用 mixly_get_block_specs 读取真实接口和本地示例。',
    inputSchema: {
      type: 'object', required: ['board'],
      properties: {
        board: { type: 'string', description: '环境探测返回的板卡 id、boardType、id@型号、唯一型号名或 FQBN。' },
        boardRoot: { type: 'string', description: '工作区内的自定义板卡根目录；通常不需要。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_get_block_specs',
    title: '读取积木真实接口',
    description: '读取官方或 ThirdParty 积木的真实工具箱 XML、field/value/statement 名称、默认 shadow、可留空输入及生成器回退值、连接类型、定义位置和本地示例工程，帮助 AI 使用当前机器实际安装的积木。',
    inputSchema: {
      type: 'object', required: ['board', 'blockTypes'],
      properties: {
        board: { type: 'string', description: '环境探测返回的板卡 id、boardType、id@型号、唯一型号名或 FQBN。' },
        blockTypes: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' }, description: '要查询的准确积木 type；一次最多 50 个。' },
        includeSource: { type: 'boolean', description: '返回精简的块定义和生成器源码片段，默认 false；复杂动态块可开启。' }
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
        includeSource: { type: 'boolean', description: '是否返回所选积木的精简源码片段，默认 false。' }
      }
    },
    annotations: readOnly
  },
  {
    name: 'mixly_detect_environment',
    title: '探测本机 Mixly 和 Arduino 环境',
    description: '先调用此工具查找本机 Mixly 根目录、板卡、CDP 状态、arduino-cli 候选路径、CLI 版本和已安装核心。AI 应根据结果选择 CLI、库目录和目标 FQBN。',
    inputSchema: {
      type: 'object',
      properties: {
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' },
        arduinoCliPath: { type: 'string', description: '可选的 CLI 候选路径。' },
        probeCli: { type: 'boolean', description: '是否执行 version/core list，默认 true。' }
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
    description: '对参考源码、积木生成代码及生成端辅助源码执行保守静态审计，报告遗漏的保护条件调用、提示文本、常量、副作用调用和必需正则。它不是形式化证明，也不替代真实 Blockly、编译或硬件测试。',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '参考源码文件；与 sourceText 二选一。' },
        sourceText: { type: 'string', description: '参考源码文本；与 sourcePath 二选一。' },
        generatedPath: { type: 'string', description: '积木生成的代码文件；与 generatedText 二选一。' },
        generatedText: { type: 'string', description: '积木生成的代码文本；与 generatedPath 二选一。' },
        supportPaths: { type: 'array', items: { type: 'string' }, description: '生成端自定义 Arduino 库或其他辅助实现文件；会与 generatedPath/generatedText 一起审计。' },
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
    description: '创建兼容的 ThirdParty 积木库，默认生成标准 block/generator/index.xml/config.json 结构。MCP 会提示本地复用、粒度和图片使用风险，但只阻止语法错误或定义/生成器/工具箱缺失等不可用结构。',
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
    description: '把结构化积木树直接序列化为 .mix，自动把全局变量声明连接成一个 next 栈并安排顶层布局。大型树应传 treePath，服务端直接读文件，不把 JSON 放进子进程命令行，因此不会触发 ENAMETOOLONG。',
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
        overwrite: { type: 'boolean', description: '目标已存在时必须显式为 true。' }
      }
    },
    annotations: mayOverwrite
  },
  {
    name: 'mixly_save_project',
    title: '校验并写入 Mixly 工程',
    description: '校验已有 projectXml 后原子写入 .mix。未安装的 type 或无效 XML 会报错；重复 id、变量断链、布局和积木粒度作为 warnings 返回，不阻止写入。',
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
        overwrite: { type: 'boolean' }
      }
    },
    annotations: mayOverwrite
  },
  {
    name: 'mixly_package_library',
    title: '打包 Mixly 积木库',
    description: '把已安装的小型第三方积木库打成兼容 ZIP。ZIP 只含文件条目，不创建目录条目，从而避免 Mixly 的 EISDIR 导入错误。',
    inputSchema: {
      type: 'object', required: ['library'],
      properties: {
        library: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]{1,63}$' },
        board: { type: 'string', description: '可省略；MCP 会从已安装库目录自动识别。' },
        outputPath: { type: 'string', description: '工作区内 ZIP 路径，默认 <library>_Mixly_Library.zip。' }
      }
    },
    annotations: writesLocal
  },
  {
    name: 'mixly_launch',
    title: '启动 Mixly 调试实例',
    description: '确保存在带 CDP 远程调试端口的 Mixly 实例；已有实例时直接复用。真实导入、打开、验证和代码生成依赖此实例。',
    inputSchema: {
      type: 'object',
      properties: {
        cdpPort: { type: 'integer', minimum: 1, maximum: 65535, description: '默认 9333。' },
        profilePath: { type: 'string', description: '工作区内的隔离用户目录，默认 .mixly-mcp-profile。' },
        waitMs: { type: 'integer', minimum: 1000, maximum: 120000, description: '默认 30000。' }
      }
    },
    annotations: writesLocal
  },
  {
    name: 'mixly_import_library',
    title: '真实导入 Mixly 库',
    description: '通过正在运行的 Mixly 调用 importFromLocalWithZip，导入 ZIP 并刷新第三方工具箱；返回导入错误、文件和积木库状态。',
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
    description: '把调试实例导航到正确板卡并打开 .mix 工程，等待 Blockly 工作区就绪。',
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
    description: '在真实 Mixly 中加载指定 .mix，自动选择当前板卡可用的 Blockly 代码生成器；也可由 AI 显式指定 generator。',
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
    description: '一次完成结构树构建、Mixly 启动、工程打开、真实 Blockly 验证、代码生成和可选 Arduino 编译。适合最终闭环；扫描候选和读取规格仍应在构建前单独完成。',
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
        waitMs: { type: 'integer', minimum: 1000, maximum: 120000 },
        generator: { type: 'string' },
        equivalenceMode: { type: 'string', enum: ['report', 'behavioral-strict', 'exact'], description: '传入参考源码时默认 report；严格交付可使用 behavioral-strict 或 exact。' },
        equivalenceSupportPaths: { type: 'array', items: { type: 'string' }, description: '生成端自定义库或辅助实现源码文件。' },
        equivalenceRequiredPatterns: { type: 'array', items: {}, description: '生成端必须保留的关键业务正则。' },
        equivalenceIgnoreStrings: { type: 'array', items: { type: 'string' } },
        equivalenceIgnoreIdentifiers: { type: 'array', items: { type: 'string' } },
        compile: { type: 'boolean', description: '为 true 时在生成后调用 arduino-cli。' },
        fqbn: { type: 'string' },
        fqbns: { type: 'array', items: { type: 'string' } },
        arduinoCliPath: { type: 'string' },
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
    title: '编译 Arduino 代码',
    description: '使用用户本机的 arduino-cli 编译 .ino。AI 必须根据环境探测和目标板明确传入 fqbn 或 fqbns；MCP 不下载、不捆绑编译器。',
    inputSchema: {
      type: 'object', required: ['sketchPath'],
      properties: {
        sketchPath: { type: 'string' },
        fqbn: { type: 'string' },
        fqbns: { type: 'array', items: { type: 'string' }, description: '需要连续验证多个板卡配置时使用。' },
        arduinoCliPath: { type: 'string', description: 'AI 探测到的 arduino-cli 路径；省略时 MCP 从环境变量、Mixly 目录和 PATH 查找。' },
        librariesPath: { type: 'string', description: '单个 Arduino 库目录；为向后兼容保留。' },
        librariesPaths: { type: 'array', items: { type: 'string' }, description: '多个 Arduino 库目录；与 librariesPath 合并、去重后逐个传给 arduino-cli。' },
        board: { type: 'string', description: 'Mixly 板卡 id、boardType、profile 或 FQBN；与 mixlyLibraries 一起使用。' },
        mixlyLibraries: { type: 'array', items: { type: 'string' }, description: 'Mixly ThirdParty 库名称；自动加入当前板卡 ThirdParty/<name>/libraries。' },
        allowExternalPath: { type: 'boolean', description: '显式允许工作区外 sketch/libraries 路径，默认 false。' },
        keepBuild: { type: 'boolean', description: '保留临时构建目录，默认 false。' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000, description: '单个 FQBN 的编译超时；默认 900000 毫秒，ESP32 首次构建可按需增加。' }
      }
    },
    annotations: writesLocal
  }
];

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
  const indexFiles = filesRecursive(BOARDS_DIR, 'index.xml');
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
  return Number(args.cdpPort || DEFAULT_CDP_PORT);
}

function unique(values) {
  return [...new Set(values)];
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

function sourceLocation(files, blockType, kind, includeSource) {
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
      file: relativeToRoot(filePath),
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
  return fs.readFileSync(sourcePath, 'utf8');
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

function verifyEquivalence(args) {
  const allowExternalPath = args.allowExternalPath === true;
  const sourceFile = equivalencePrimaryFile(args, 'sourceText', 'sourcePath', '参考源码', allowExternalPath);
  const generatedFile = equivalencePrimaryFile(args, 'generatedText', 'generatedPath', '生成代码', allowExternalPath);
  const supportFiles = equivalenceSupportFiles(args.supportPaths, allowExternalPath);
  const mode = args.mode || 'report';
  const result = compareCode({
    mode,
    sourceFiles: [sourceFile],
    generatedFiles: [generatedFile, ...supportFiles],
    ignoreStrings: args.ignoreStrings || [],
    ignoreIdentifiers: args.ignoreIdentifiers || [],
    requiredPatterns: checkedRequiredPatterns(args.requiredPatterns)
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

function exampleUsages(exampleFiles, blockType, limit = 8) {
  const usages = [];
  for (const filePath of exampleFiles) {
    const source = fs.readFileSync(filePath, 'utf8');
    const blockXml = extractXmlBlock(source, blockType);
    if (!blockXml) continue;
    usages.push({
      project: relativeToRoot(filePath),
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

function getBlockSpecs(args) {
  if (!Array.isArray(args.blockTypes) || !args.blockTypes.length || args.blockTypes.length > 50) {
    fail('blockTypes 必须包含 1 到 50 个积木 type');
  }
  const board = getBoard(args.board);
  const officialFiles = boardSourceFiles(board.root, board);
  const thirdPartyRoot = path.join(board.root, 'libraries', 'ThirdParty');
  const libraries = fs.existsSync(thirdPartyRoot)
    ? fs.readdirSync(thirdPartyRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(thirdPartyRoot, entry.name) }))
    : [];
  const specs = [];
  const unknownTypes = [];

  for (const blockType of unique(args.blockTypes.map(String))) {
    let owner = 'official';
    let sourceFiles = officialFiles;
    let examples = exampleUsages(officialFiles.examples, blockType);
    let defaultXml = officialFiles.toolboxes
      .map((filePath) => extractXmlBlock(fs.readFileSync(filePath, 'utf8'), blockType))
      .find(Boolean) || (examples[0] && examples[0].blockXml) || null;
    let definition = sourceLocation(sourceFiles.blocks, blockType, 'block', args.includeSource === true);
    let generator = sourceLocation(sourceFiles.generators, blockType, 'generator', args.includeSource === true);

    if (!definition && !generator && !defaultXml) {
      for (const library of libraries) {
        const candidateFiles = libraryFiles(library.path);
        const candidateExamples = candidateFiles.all.filter((filePath) => /\.mix$/i.test(filePath));
        const candidateUsages = exampleUsages(candidateExamples, blockType);
        const candidateXml = candidateFiles.xml
          .map((filePath) => extractXmlBlock(fs.readFileSync(filePath, 'utf8'), blockType))
          .find(Boolean) || (candidateUsages[0] && candidateUsages[0].blockXml) || null;
        const candidateDefinition = sourceLocation(candidateFiles.blocks, blockType, 'block', args.includeSource === true);
        const candidateGenerator = sourceLocation(candidateFiles.generators, blockType, 'generator', args.includeSource === true);
        if (!candidateDefinition && !candidateGenerator && !candidateXml && !candidateUsages.length) continue;
        owner = `ThirdParty/${library.name}`;
        sourceFiles = candidateFiles;
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
    specs.push({
      type: blockType,
      owner,
      definition,
      generator,
      contract: contractFromSources(defaultXml, definitionSource, generatorSource),
      defaultXml,
      exampleProjects: examples.map((item) => item.project),
      exampleXml: examples[0] ? examples[0].blockXml : null,
      usageRule: '复制 defaultXml 的 field/value/statement 名称；只替换 field 值和 shadow 默认值，不翻译接口名称。'
    });
  }

  return {
    board: board.id,
    boardProfile: board.selectedProfile || null,
    fqbn: board.fqbn || null,
    requested: args.blockTypes.length,
    found: specs.length,
    unknownTypes,
    specs,
    namingRule: {
      interfaceNames: 'type、field name、value name、statement name 必须保持本地定义中的原文',
      userNames: '变量 VAR、函数 NAME、mutation name 与 arg name 使用自然中文，并在声明/读取/赋值/定义/调用处完全一致'
    }
  };
}

function inspectLibrary(args) {
  const board = getBoard(args.board);
  const libraryPath = path.join(board.root, 'libraries', 'ThirdParty', args.library);
  if (!fs.existsSync(libraryPath) || !fs.statSync(libraryPath).isDirectory()) {
    fail(`第三方积木库不存在: ${libraryPath}`);
  }
  const files = libraryFiles(libraryPath);
  const relativeFiles = files.all.map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/'));
  const blockSource = files.blocks.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
  const generatorSource = files.generators.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
  const toolboxSource = files.xml.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
  const toolboxTypes = toolboxBlockTypes(toolboxSource).sort();
  const definedTypes = extractBlockTypes(blockSource).sort();
  const generatorTypes = extractGeneratorTypes(generatorSource).sort();
  const requestedTypes = args.blockTypes && args.blockTypes.length
    ? args.blockTypes
    : toolboxTypes.slice(0, 20);
  const specs = getBlockSpecs({
    board: board.id,
    blockTypes: requestedTypes,
    includeSource: args.includeSource === true
  }).specs.filter((spec) => spec.owner === `ThirdParty/${args.library}`);
  const configPath = path.join(libraryPath, 'config.json');
  let config = null;
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { config = { invalidJson: true }; }
  }
  return {
    board: board.id,
    library: args.library,
    libraryPath,
    config,
    structure: {
      standardLayout: relativeFiles.some((name) => name.startsWith('block/')) &&
        relativeFiles.some((name) => name.startsWith('generator/')) &&
        relativeFiles.includes('config.json'),
      fileCount: relativeFiles.length,
      topLevelDirectories: unique(relativeFiles.filter((name) => name.includes('/')).map((name) => name.split('/')[0])).sort(),
      xmlFiles: files.xml.map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/')),
      blockFiles: files.blocks.map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/')),
      generatorFiles: files.generators.map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/')),
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
        .map((m) => markupAttributes(m[0]).src).filter(Boolean)),
      styleReferences: unique([...toolboxSource.matchAll(/<link\b[^>]*>/gi)]
        .map((m) => markupAttributes(m[0]).href).filter(Boolean))
    },
    imagePolicy: '图片能力仅作为可选表现层：只有用户明确要求图片块图标或图片选项时，才在 mixly_create_library 中传 userRequestedImages=true 和对应 imageMode。',
    specs
  };
}

function scanLibrary(args) {
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
  const thirdPartyRoot = path.join(boardRoot, 'libraries', 'ThirdParty');
  const thirdParty = [];

  if (fs.existsSync(thirdPartyRoot)) {
    for (const entry of fs.readdirSync(thirdPartyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const libraryPath = path.join(thirdPartyRoot, entry.name);
      const localFiles = libraryFiles(libraryPath);
      const xmlFiles = localFiles.xml.map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/'));
      const customTypes = unique([
        ...localFiles.xml.flatMap((xmlPath) => {
        const xml = fs.readFileSync(xmlPath, 'utf8');
        return toolboxBlockTypes(xml);
        }),
        ...localFiles.blocks.flatMap((filePath) => extractBlockTypes(fs.readFileSync(filePath, 'utf8')))
      ]).sort();
      const allRelative = localFiles.all.map((filePath) => path.relative(libraryPath, filePath).replace(/\\/g, '/'));
      const blockSource = localFiles.blocks.map((filePath) => fs.readFileSync(filePath, 'utf8')).join('\n');
      thirdParty.push({
        name: entry.name,
        xmlFiles,
        customTypes,
        standardLayout: allRelative.some((name) => name.startsWith('block/')) &&
          allRelative.some((name) => name.startsWith('generator/')),
        hasImages: /Field(?:Image|Bitmap)|image[_-]?properties/.test(blockSource),
        mediaFileCount: allRelative.filter((name) => name.startsWith('media/')).length,
        arduinoLibraryFileCount: allRelative.filter((name) => name.startsWith('libraries/')).length
      });
    }
  }

  const thirdPartyBlockTypes = unique(thirdParty.flatMap((library) => library.customTypes)).sort();
  const availableBlockTypes = unique([...blockTypes, ...thirdPartyBlockTypes]).sort();
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
    usageHint: 'availableBlockTypes 同时包含官方和 ThirdParty 积木，并兼容打包型板卡。优先复用本地块；不熟悉的 type 可调用 mixly_get_block_specs 获取真实 defaultXml、接口和本地示例。',
    advisory: '这些是建议，不是阻止规则；AI 可以根据用户目标决定是否创建新库。'
  };
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

function createLibrary(args) {
  const board = getBoard(args.board);
  const libraryName = args.libraryName;
  const destination = path.join(board.root, 'libraries', 'ThirdParty', libraryName);
  const layout = args.layout || 'standard';
  const xmlFileName = args.xmlFileName || (layout === 'standard' ? 'index.xml' : `${libraryName.toLowerCase()}.xml`);
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
  if (layout === 'standard') {
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
  return {
    libraryName,
    board: board.id,
    destination,
    layout,
    files: [...files.keys()].sort(),
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

function mutationXmlWithAttributes(source, attributes) {
  return String(source).replace(/<mutation\b([^>]*?)(\/?)>/i, (tag, body, selfClosing) => {
    let updated = body;
    for (const [name, value] of Object.entries(attributes)) {
      const pattern = new RegExp(`\\s+${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
      updated = updated.replace(pattern, '');
      updated += ` ${name}="${xmlEscape(value)}"`;
    }
    return `<mutation${updated}${selfClosing}>`;
  });
}

function inferControlsIfMutation(node) {
  if (!node || node.type !== 'controls_if') return;
  const connectionNames = [
    ...Object.keys(node.values || {}),
    ...Object.keys(node.statements || {})
  ];
  const branchIndexes = connectionNames
    .map((name) => /^(?:IF|DO)(\d+)$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const inferredElseIf = branchIndexes.length ? Math.max(...branchIndexes) : 0;
  const hasElse = Object.prototype.hasOwnProperty.call(node.statements || {}, 'ELSE');
  if (!inferredElseIf && !hasElse) return;

  const attributes = {};
  if (inferredElseIf) {
    const existing = Number(mutationAttribute(node.mutation, 'elseif')) || 0;
    attributes.elseif = Math.max(existing, inferredElseIf);
  }
  if (hasElse) attributes.else = 1;

  if (typeof node.mutation === 'string') {
    node.mutation = /<mutation\b/i.test(node.mutation)
      ? mutationXmlWithAttributes(node.mutation, attributes)
      : { attributes };
  } else if (node.mutation && node.mutation.xml) {
    node.mutation = {
      ...node.mutation,
      xml: mutationXmlWithAttributes(node.mutation.xml, attributes)
    };
  } else {
    node.mutation = { ...(node.mutation || {}), ...attributes };
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
  for (const { node } of projectTreeNodeEntries(cloned)) inferControlsIfMutation(node);
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
      continue;
    }
    if (/^<\?/.test(token) || /^<!/.test(token)) continue;
    const name = (token.match(/^<\s*([A-Za-z0-9_:.-]+)/) || [])[1];
    if (!name) continue;
    const attributes = xmlAttributes(token);
    const parentBlock = [...stack].reverse().find((entry) => entry.block)?.block || null;
    const parentConnectionEntry = [...stack].reverse().find((entry) =>
      entry.name === 'value' || entry.name === 'statement' || entry.name === 'next'
    );
    let block = null;
    if (name === 'block' || name === 'shadow') {
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
        args: []
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
        owner: name === 'field' ? parentBlock : null,
        text: name === 'field' ? '' : undefined
      });
    }
  }
  if (stack.length) fail(`XML 仍有未闭合标签: ${stack.map((entry) => entry.name).join(', ')}`);
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
  return fs.readFileSync(sourcePath, 'utf8');
}

function projectCompatibility(args, projectXml) {
  const rootTag = (String(projectXml).match(/<xml\b[^>]*>/i) || [])[0] || '';
  const boardAttribute = markupAttributes(rootTag).board || '';
  const boardSelector = args.board || boardAttribute;
  if (!boardSelector) fail('无法从工程识别板卡；请显式传 board');
  const board = getBoard(boardSelector);
  const parsed = parseProjectXml(projectXml);
  const scanned = scanLibrary({
    board: board.selectedProfile ? `${board.id}@${board.selectedProfile}` : board.id
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

function saveProject(args) {
  const report = projectCompatibility(args, args.projectXml);
  if (!report.passed) fail('Mixly 工程兼容性检查失败', { ...report, parsed: undefined });
  const projectPath = atomicWriteProject(args.projectPath, args.projectXml, args.overwrite);
  delete report.parsed;
  return { projectPath, ...report };
}

function validateProjectTreeConnections(tree, boardSelector) {
  const entries = projectTreeNodeEntries(tree);
  const requestedTypes = unique(entries.map(({ node }) => node.type).filter(Boolean));
  const specs = [];
  for (let index = 0; index < requestedTypes.length; index += 50) {
    specs.push(...getBlockSpecs({
      board: boardSelector,
      blockTypes: requestedTypes.slice(index, index + 50),
      includeSource: false
    }).specs);
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

function buildProject(args) {
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
  const treeContractValidation = validateProjectTreeConnections(normalized, args.board);
  const serialized = serializeProjectTree(normalized);
  const report = projectCompatibility(args, serialized.xml);
  if (!report.passed) fail('结构化积木工程兼容性检查失败', { ...report, parsed: undefined });
  const projectPath = atomicWriteProject(args.projectPath, serialized.xml, args.overwrite);
  delete report.parsed;
  return {
    projectPath,
    treeSource: args.treePath ? ensureInsideWorkspace(args.treePath) : 'inline',
    serializedNodes: serialized.nodeCount,
    autoLayout: true,
    globalVariablesChained: true,
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

function inferLibraryBoard(libraryName) {
  for (const board of getBoardCatalog()) {
    const libraryPath = path.join(board.root, 'libraries', 'ThirdParty', libraryName);
    if (fs.existsSync(libraryPath) && fs.statSync(libraryPath).isDirectory()) return board.id;
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

async function packageLibrary(args) {
  const boardName = args.board || inferLibraryBoard(args.library);
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

async function getCdpTargets(cdpPort, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json`, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdp(cdpPort, waitMs) {
  const deadline = Date.now() + waitMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await getCdpTargets(cdpPort);
      if (targets.some((target) => target.type === 'page')) return targets;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  fail(`等待 Mixly CDP 端口 ${cdpPort} 超时`, lastError ? lastError.message : null);
}

async function launchMixly(args) {
  const cdpPort = getCdpPort(args);
  try {
    const targets = await getCdpTargets(cdpPort);
    return { alreadyRunning: true, cdpPort, targets: targets.map(({ type, title, url }) => ({ type, title, url })) };
  } catch (_) { /* launch a new isolated instance */ }

  if (!fs.existsSync(MIXLY_EXE)) fail(`找不到 Mixly.exe: ${MIXLY_EXE}`);
  const profilePath = ensureInsideWorkspace(args.profilePath || path.join(ROOT, '.mixly-mcp-profile'));
  fs.mkdirSync(profilePath, { recursive: true });
  const child = spawn(MIXLY_EXE, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profilePath}`
  ], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  const targets = await waitForCdp(cdpPort, Number(args.waitMs || 30000));
  return {
    alreadyRunning: false,
    pid: child.pid,
    cdpPort,
    profilePath,
    targets: targets.map(({ type, title, url }) => ({ type, title, url }))
  };
}

async function evaluateCdp(expression, cdpPort) {
  const result = await runNodeTool('validate_mixly_workspace.js', [expression], {
    env: { MIXLY_CDP_PORT: String(cdpPort) },
    timeoutMs: COMMAND_TIMEOUT_MS
  });
  return { value: parseToolOutput(result.stdout), raw: result.stdout.trim() };
}

async function importLibrary(args) {
  const zipPath = ensureInsideWorkspace(args.zipPath);
  if (!fs.existsSync(zipPath) || path.extname(zipPath).toLowerCase() !== '.zip') {
    fail(`ZIP 文件不存在或后缀不正确: ${zipPath}`);
  }
  const inferredName = path.basename(zipPath).replace(/_Mixly_Library\.zip$/i, '').replace(/\.zip$/i, '');
  const libraryName = args.libraryName || inferredName;
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
  return { zipPath, libraryName, ...evaluated.value };
}

function projectUrl(projectPath, boardName) {
  const board = getBoard(boardName);
  const url = new URL(pathToFileURL(path.join(
    APP_SRC_ROOT, 'boards', 'index.html'
  )).href);
  const parameters = {
    thirdPartyBoard: board.thirdParty ? 'true' : 'false',
    boardIndex: board.boardIndex,
    boardType: board.boardType,
    boardImg: board.boardImg,
    language: board.language
  };
  if (projectPath) parameters.filePath = projectPath.replace(/\\/g, '/');
  url.search = new URLSearchParams(parameters).toString();
  return url.href;
}

async function waitForWorkspace(cdpPort, waitMs) {
  const deadline = Date.now() + waitMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const evaluated = await evaluateCdp(
        `JSON.stringify({ready:document.readyState,blockly:typeof Blockly,mixly:typeof Mixly,board:(typeof Mixly==='object'&&Mixly.Boards)?Mixly.Boards.getSelectedBoardName():null,url:location.href})`,
        cdpPort
      );
      if (evaluated.value && evaluated.value.ready === 'complete' && evaluated.value.blockly === 'object') {
        return evaluated.value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail('等待 Mixly Blockly 工作区就绪超时', lastError ? lastError.message : null);
}

async function openProject(args) {
  const projectPath = ensureInsideWorkspace(args.projectPath);
  if (!fs.existsSync(projectPath)) fail(`Mixly 工程不存在: ${projectPath}`);
  const cdpPort = getCdpPort(args);
  const url = projectUrl(projectPath, args.board);
  await runNodeTool('validate_mixly_workspace.js', ['--navigate', url], {
    env: { MIXLY_CDP_PORT: String(cdpPort) }
  });
  const workspace = await waitForWorkspace(cdpPort, Number(args.waitMs || 30000));
  return { projectPath, board: args.board, cdpPort, url, workspace };
}

function loadProjectExpression(projectPath, body) {
  const encodedPath = JSON.stringify(projectPath.replace(/\\/g, '/'));
  return `(()=>{const fs=Mixly.require('fs');const source=fs.readFileSync(${encodedPath},'utf8');const dom=Blockly.utils.xml.textToDom(source);const workspace=Blockly.getMainWorkspace();Blockly.Xml.clearWorkspaceAndLoadFromXml(dom,workspace);${body}})()`;
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
  const prefixes = args.customPrefixes || [];
  const projectXml = fs.readFileSync(projectPath, 'utf8');
  const staticReport = projectCompatibility(args, projectXml);
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

async function generateCode(args) {
  const projectPath = ensureInsideWorkspace(args.projectPath);
  const outputPath = ensureInsideWorkspace(args.outputPath);
  if (!fs.existsSync(projectPath)) fail(`Mixly 工程不存在: ${projectPath}`);
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

async function projectWorkflow(args) {
  const board = getBoard(args.board);
  const boardSelector = board.selectedProfile ? `${board.id}@${board.selectedProfile}` : board.id;
  const projectPath = ensureInsideWorkspace(args.projectPath);
  const hasReferenceSource = args.sourceText != null || Boolean(args.sourcePath);
  if (args.equivalenceMode && !hasReferenceSource) {
    fail('使用 equivalenceMode 时必须同时传入 sourcePath 或 sourceText');
  }
  const build = buildProject(args);
  const launched = await launchMixly(args);
  const opened = await openProject({
    projectPath,
    board: boardSelector,
    cdpPort: getCdpPort(args),
    waitMs: args.waitMs
  });
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
      ignoreStrings: args.equivalenceIgnoreStrings,
      ignoreIdentifiers: args.equivalenceIgnoreIdentifiers,
      allowExternalPath: args.allowExternalSourcePath === true
    });
    if (equivalence.passed === false) {
      fail('Mixly 生成代码未通过源码等价性审计', { equivalence });
    }
  }
  let compiled = null;
  if (args.compile === true) {
    compiled = await compileSketch({
      sketchPath: outputPath,
      fqbn: args.fqbn,
      fqbns: args.fqbns,
      arduinoCliPath: args.arduinoCliPath,
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
    stages: { build, launched, opened, validated, generated, equivalence, compiled }
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
    copySketchSupport(sourceDir, targetDir, selectedFile);
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

async function detectEnvironment(args) {
  const cdpPort = getCdpPort(args);
  let cdp = { running: false, port: cdpPort, targets: [] };
  try {
    const targets = await getCdpTargets(cdpPort);
    cdp = {
      running: true,
      port: cdpPort,
      targets: targets.map(({ type, title, url }) => ({ type, title, url }))
    };
  } catch (_) { /* Mixly CDP is optional during discovery */ }

  const cliCandidates = arduinoCliCandidates(args.arduinoCliPath);
  const selectedCli = cliCandidates[0] || null;
  let cliProbe = null;
  if (selectedCli && args.probeCli !== false) {
    const version = await runCommand(selectedCli, ['version'], { timeoutMs: 15000 });
    const cores = await runCommand(selectedCli, ['core', 'list'], { timeoutMs: 30000 });
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

  return {
    mixlyRoot: ROOT,
    mixlyExecutable: fs.existsSync(MIXLY_EXE) ? MIXLY_EXE : null,
    node: { executable: process.execPath, version: process.version, platform: process.platform, arch: process.arch },
    boards: getBoardCatalog(),
    cdp,
    arduinoCli: { selected: selectedCli, candidates: cliCandidates, probe: cliProbe },
    libraryCandidates
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

function resolveCompileLibraryPaths(args, allowExternal) {
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
  let mixlyBoard = null;
  if (requestedMixlyLibraries.length) {
    const board = getBoard(args.board);
    mixlyBoard = board.selectedProfile ? `${board.id}@${board.selectedProfile}` : board.id;
    const thirdPartyRoot = path.join(board.root, 'libraries', 'ThirdParty');
    const availableLibraries = fs.existsSync(thirdPartyRoot)
      ? fs.readdirSync(thirdPartyRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
      : [];
    for (const requestedName of requestedMixlyLibraries) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(requestedName)) {
        fail(`Mixly 库名称格式不正确: ${requestedName}`);
      }
      const name = availableLibraries.find((candidate) =>
        candidate.toLowerCase() === requestedName.toLowerCase()
      );
      if (!name) {
        fail(`当前板卡未安装 Mixly ThirdParty 库: ${requestedName}`, {
          board: board.id,
          availableMixlyLibraries: availableLibraries.sort()
        });
      }
      const libraryPath = path.join(thirdPartyRoot, name, 'libraries');
      if (!fs.existsSync(libraryPath) || !fs.statSync(libraryPath).isDirectory()) {
        fail(`Mixly ThirdParty 库没有 Arduino libraries 目录: ${libraryPath}`);
      }
      resolvedMixlyLibraries.push({ name, path: libraryPath });
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
  return {
    librariesPath: librariesPaths[0] || null,
    librariesPaths,
    mixlyBoard,
    mixlyLibraryPaths: resolvedMixlyLibraries
  };
}

async function compileSketch(args) {
  const allowExternal = args.allowExternalPath === true;
  const sketchPath = resolveInputPath(args.sketchPath, allowExternal);
  if (!fs.existsSync(sketchPath)) fail(`Arduino 工程不存在: ${sketchPath}`);
  const libraryResolution = resolveCompileLibraryPaths(args, allowExternal);
  const arduinoCli = findArduinoCli(args.arduinoCliPath);
  if (!arduinoCli) {
    fail('找不到 arduino-cli；请先调用 mixly_detect_environment，或显式传 arduinoCliPath');
  }
  const fqbnList = Array.isArray(args.fqbns) && args.fqbns.length
    ? unique(args.fqbns)
    : (args.fqbn ? [args.fqbn] : []);
  if (!fqbnList.length) fail('编译前必须由 AI 根据用户板卡传入 fqbn 或 fqbns');
  const results = [];
  const timeoutMs = Number(args.timeoutMs || DEFAULT_COMPILE_TIMEOUT_MS);
  const staged = stageSketchForCli(sketchPath);
  try {
    for (const fqbn of fqbnList) {
      const buildPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mixly-mcp-build-'));
      let result;
      try {
        const compileArgs = ['compile', '--fqbn', fqbn];
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
  } finally {
    if (staged.cleanup) staged.cleanup();
  }
  const riskRank = { unknown: 0, normal: 1, warning: 2, high: 3 };
  const highestRisk = results.reduce((current, item) =>
    riskRank[item.resourceRisk.level] > riskRank[current] ? item.resourceRisk.level : current, 'unknown');
  return {
    sketchPath,
    cliSketchPath: staged.sketchPath,
    staged: staged.staged,
    arduinoCli,
    librariesPath: libraryResolution.librariesPath,
    librariesPaths: libraryResolution.librariesPaths,
    mixlyBoard: libraryResolution.mixlyBoard,
    mixlyLibraryPaths: libraryResolution.mixlyLibraryPaths,
    timeoutMs,
    results,
    resourceRisk: {
      level: highestRisk,
      warnings: results.flatMap((item) => item.resourceRisk.warnings.map((message) => ({ fqbn: item.fqbn, message })))
    },
    passed: results.every((item) => item.code === 0 && !item.timedOut)
  };
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
    if ((property.type === 'number' || property.type === 'integer') && typeof value !== 'number') {
      fail(`参数 ${name} 必须是数字`);
    }
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
        serverInfo: { name: 'mixly-local-builder', version: '2.3.0' },
        instructions: '所有规则以提示和帮助复用为主，不因风格选择阻止 AI。建议先用 mixly_detect_environment 探测环境，并用 mixly_get_board_profiles 从本机元数据选择真实型号、FQBN 和配置项；不要固定任一板卡。分析源码后，再用 mixly_scan_library 动态扫描目标板当前安装的全部积木；availableBlockTypes 同时包含板卡官方目录和 libraries/ThirdParty，第三方积木也是可优先复用的本地积木。遇到不熟悉的 type，可调用 mixly_get_block_specs 读取本机真实 defaultXml、字段、输入、shadow 和生成器接口，不要凭名称猜结构；新安装或后续增加的积木会自动进入扫描结果，无需修改 MCP。mixly_inspect_library 可查看第三方库目录、语言、媒体、图片字段和 Arduino libraries。变量、函数、判断、循环、数学、时间及硬件操作尽量保持为可见积木；粒度过大只返回 warning。中文名称按用户偏好处理：只修改 variables_* 的 VAR、procedure 的 NAME、mutation name/arg name，声明与引用保持一致，官方 type 和输入名不要翻译。图片使用与用户要求不一致时只提示。大型工程建议通过 treePath 调用 mixly_build_project；构建器会连接变量栈、安排布局、推导 controls_if mutation，并在写入前检查本机可可靠解析的官方与 ThirdParty 块输入契约。最后必须真实打开、验证和生成代码；有参考源码时用 mixly_verify_equivalence 检查明显行为遗漏，要求严格交付时使用 behavioral-strict 或 exact。Arduino 编译可隔离传入多个库目录，结果中的 Flash/SRAM 风险不能因编译成功而忽略。只有无效 XML、未安装 block type、定义/生成器缺失、真实 Blockly 节点丢失、严格等价审计失败或编译失败等确定不可用问题才报错，命名、粒度、变量断链、孤立块和重叠都作为 warnings 返回。'
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
    send({ jsonrpc: '2.0', id: message.id, result: { tools: toolDefinitions } });
    return;
  }
  if (message.method === 'tools/call') {
    callTool(message.params && message.params.name, (message.params && message.params.arguments) || {})
      .then((value) => send({
        jsonrpc: '2.0', id: message.id,
        result: {
          structuredContent: value,
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        }
      }))
      .catch((error) => send({
        jsonrpc: '2.0', id: message.id,
        result: {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({ message: error.message, details: error.details || null }, null, 2)
          }]
        }
      }));
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
  projectLoadDiagnostics
};
