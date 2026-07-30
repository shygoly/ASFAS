# ai-factory

**Knowledge Driven Software Factory** — 工厂层仓库。

本仓库承载与项目无关的软件工厂能力。它治理的项目（`GMPGCPwork`、`diabetes` 等）各自独立，
本仓不包含任何项目的业务知识（ASFAS `FINV-4`）。

## 唯一架构宪法

[`spec/ASFAS.html`](spec/ASFAS.html) — **Agent Native Software Factory Architecture Specification**，
Level 2 Engineering Specification。用浏览器打开。

**Part I–VIII 全部规范性定稿（55/55 章）：**

- **Part I–III**（§1–§25）设计理念 · 四层架构 · **知识体系（元语规范）**
- **Part IV**（§26–§34）智能体模型 · 动作分级与归级算法 · 决策血缘 · **六个角色的完整契约** · 禁止智能体化的面
- **Part V**（§35–§40）运行时抽象接口与错误分类 · SDK 概念映射 · 会话与 SubAgent 选用判据 · Checkpoint 与血缘的区分 · **工具面授权矩阵** · 替换协议
- **Part VI**（§41–§47）工作流模型 + 六类工作流（各含时序图、阶段契约、失败路由、终止条件）
- **Part VII**（§48–§52）沙箱与凭据派生 · 放行闸三判据 · 四类状态存储纪律 · 观测边界 · 成本归集与降本顺序
- **Part VIII**（§53–§55）扩展规程

222 条规范性陈述 · 12 个 ID 命名空间 · 18 张图 · **85 条一致性检查点** `CP-1`…`CP-85`。

## 校验器套件

`factory/verifiers/` — 把项目从 `C0` 带到 `C1`。共享解析层 + 六个检查
（格式契约先验 · DOMAIN · FLOWS · DECISIONS · DEPLOY · AGENTS）+ 负向验证脚手架。

```bash
cp factory/verifiers/adapter.example.mjs <项目>/governance.adapter.mjs   # 按本项目技术栈实现
node factory/verifiers/run-all.mjs <项目>/governance.adapter.mjs
```

**校验逻辑在工厂，适配器在项目**：修一次缺陷对所有项目生效，而"这个项目的 schema
长什么样"只有项目知道。详见 [factory/verifiers/README.md](factory/verifiers/README.md)。

## 元语模板

`templates/` — 9 份可复制模板（6 核心元语 + 2 条件元语 + `AGENTS.md` 入口指针）。
用 `{{…}}` 标占位，**不含任何示例业务内容**（填了示例的模板会被直接提交上去）。
用法见 ASFAS 附录 C；由校验器维度 `I` 守护。

待做：附录 E Prompt 规范 · F 命名与风格（见附录 I 未决 `QA-8`）。

L1 白皮书与 L3 开发手册**派生自**本文件，不得包含与之冲突的规范性陈述（`FR-0`）。

## 当前状态

| 项 | 状态 |
|---|---|
| ASFAS 版本 | `1.6.0-draft`（2026-07-30） |
| 自身一致性等级 | **`C1`** — 校验器 9 维度全部通过负向验证，挂进 `npm test` |
| `factory/` 实现 | **verifiers 已落地**（在真实 C2 项目上验证过）；其余未开始 |
| 项目注册表 | 未建 |

> 本仓遵守 ASFAS `FP-6`（不预埋）：`factory/` / `runtime/` / `projects/` 目录在有实际实现时才创建。

## 闸门

```bash
npm test
```

- `spec/check-asfas-doc.mjs` — 9 条检查维度：章节连续性与侧栏双向一致 · 规范性陈述编号唯一且连续 ·
  内部引用可解析 · **附录 B 数量与实际相等**（数字漂移守护）· `CP-n` 连续 ·
  **SVG 内无非法元素** · 块级标签平衡 · Part 结构齐备 · **模板集合与结构**
- `spec/negative-verify.mjs` — 逐维度负向验证（`VC-8`）：注入违规 → 须红且消息命中 → 回滚 → 须绿

无 `--fix`（`VC-2`：治理只诊断、不自动改）。传入即以退出码 2 报错。
