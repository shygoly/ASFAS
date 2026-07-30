# conventions

## 文件 / 代码风格

- **`.mjs` 顶部头注释是规范**：每文件开头 `// <name>.mjs — <一句话职责>` 后跟一或多个 `//` 段落，解释"为什么这么写"，并大量用 ASFAS ID（`MS-n`/`VC-n`/`FR-n` 等，见 `mem:core`）引用宪法条款。**改代码前必读头注释** —— 它在解释设计依据。新增 `.mjs` 文件须延续此风格。
- 函数式 / 过程式风格，**无 class**。check 文件 `export default function checkXxx(a) { … return r; }`，返回 reporter。
- 模块入口（`run-all.mjs`、spec 校验器）顶部 `#!/usr/bin/env node`。
- `const` 优先；小工具函数命名简短（`h`/`s`/`t`/`r` 局部短名常见）。
- 无 linter / formatter 配置（无 eslint/prettier）。一致性靠人 + 校验器自身。

## 维度码命名（每个 fail/warn 的第一参数 `dim`）

`<2字母>-<数字>`：`FC-n` 格式契约 · `DM-n` DOMAIN · `FL-n` FLOWS · `DC-n` DECISIONS · `DP-n` DEPLOY · `AG-n` AGENTS（spec 自校验器用 `A`..`I` 大写字母维度）。同一维度内数字递增，不重用。每个维度码须有对应负向用例（VC-8）。

## 注释里的 ID 与中文

- 注释用中文写"为什么"，含设计教训与"真实项目上首次运行踩的坑"。
- ID 用反引号包裹：`MS-20`、`VC-3`。
- 错误消息（`r.fail(dim, msg)`）用中文，须含位置（文件/字段）与维度（`§25.3`）。

## 适配器（项目侧 governance.adapter.mjs）约定

- default export 对象，字段：`root` / `metaFiles`（含条件元语填 `null`，`MS-2`）/ `idPrefixes` / `idScanSurface` / `schemaObjects()` / `schemaEnums()` / `stateHasWriter()` / `viaResolves()` / `envReads()` / `guardResolves()` 等。
- 方法返回 `null` = 不适用（跳过+警告）；返回闭集（集合/数组）才参与对拍。
- **不 import 工厂内部模块**（`FR-14`）。
