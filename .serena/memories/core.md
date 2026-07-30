# core — ai-factory

**Knowledge Driven Software Factory — 工厂层仓库**（`package.json` desc）。这是治理仓库，不是应用：不含任何被治理项目的业务知识（ASFAS `FINV-4`）。三块资产 + 一份宪法：

- `spec/ASFAS.html` — **唯一架构宪法**：Agent Native Software Factory Architecture Specification（Level 2 Engineering Spec）。**用浏览器打开**，不要当文本读。当前 `1.6.0-draft`（2026-07-30），自身一致性 `C1`。
- `spec/check-asfas-doc.mjs` + `spec/negative-verify.mjs` — **spec 的自校验器**（`FR-1`）。验证 HTML 文档本身的完整性（章节/引用/CP/数量漂移/SVG/模板集合），9 维度 `A`..`I`。
- `factory/verifiers/` — **参考实现校验器套件**，把被治理项目从 `C0`（元语齐备）带到 `C1`（漂移报红）。代码侧事实走项目适配器。架构与契约见 `mem:verifiers`。
- `templates/` — 9 份元语模板（6 核心 + 2 条件 + `AGENTS.md`），`{{…}}` 占位，**不含任何示例业务内容**（填了示例会被直接提交）。

## 治理模型（理解一切代码的前提）

- 工厂与项目解耦：校验逻辑在工厂，适配器在项目。修一次 bug 对所有项目生效；"项目 schema 长什么样"只有项目知道。
- `factory/` 目录遵守 `FP-6`（不预埋）：只在有实际实现时才创建子目录（`runtime/`、`projects/` 当前未建）。
- `mem:verifiers` 详述六检查 / 共享解析层 / 负向验证 / 退出码语义。

## ASFAS ID 命名空间（注释与代码里大量出现，须认得）

| 前缀 | 含义 |
|---|---|
| `MS-n` | 元语规范（Meta-language Spec）—— 元语文档的格式契约 |
| `FINV-n` | 工厂不变量（Factory Invariants） |
| `FR-n` | 功能需求（对校验器/spec 本身的要求） |
| `FP-n` | 工厂原则 |
| `VC-n` | 校验器契约（Verifier Contracts）—— 见 `mem:verifiers` |
| `CP-n` | 一致性检查点（spec 文档内，`CP-1`..`CP-85`） |
| `PS-n` | 反模式（`PS-3` = 假绿）|
| `QA-n` | 附录 I 未决议题 |

代码注释用这些 ID 引用宪法条款作为设计依据 —— 改代码前先认出注释里的 ID，它在解释"为什么这么写"。

## L1/L3 派生纪律

L1 白皮书与 L3 开发手册**派生自** `spec/ASFAS.html`，不得包含与之冲突的规范性陈述（`FR-0`）。

## 进一步阅读

- `mem:verifiers` — 校验器套件架构、六检查、VC-1..VC-9 契约、维度码命名。
- `mem:conventions` — `.mjs` 代码风格、注释规范、维度码格式。
- `mem:task_completion` — 改完代码必须跑的闸门。
