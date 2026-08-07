# 更新日志

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
