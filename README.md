# ai-factory

**Knowledge Driven Software Factory** — 工厂层仓库。

本仓库承载与项目无关的软件工厂能力。它治理的项目（`GMPGCPwork`、`diabetes` 等）各自独立，
本仓不包含任何项目的业务知识（ASFAS `FINV-4`）。

## 唯一架构宪法

[`spec/ASFAS.html`](spec/ASFAS.html) — **Agent Native Software Factory Architecture Specification**，
Level 2 Engineering Specification。用浏览器打开。

规范性定稿：

- **Part I–III**（§1–§25）设计理念 · 四层架构 · **知识体系（元语规范）**
- **Part IV**（§26–§34）智能体模型 · 动作分级与归级算法 · 决策血缘 · **六个角色的完整契约** · 禁止智能体化的面
- **Part V**（§35–§40）运行时抽象接口与错误分类 · SDK 概念映射 · 会话与 SubAgent 选用判据 · Checkpoint 与血缘的区分 · **工具面授权矩阵** · 替换协议
- **Part VI**（§41–§47）工作流模型 + 六类工作流（各含时序图、阶段契约、失败路由、终止条件）
- **Part VIII**（§53–§55）扩展规程

仅 Part VII（基础设施）待补，已定范围与关键条款（见附录 I 未决清单）。
附录 A：70 条一致性检查点 `CP-1`…`CP-70`。

L1 白皮书与 L3 开发手册**派生自**本文件，不得包含与之冲突的规范性陈述（`FR-0`）。

## 当前状态

| 项 | 状态 |
|---|---|
| ASFAS 版本 | `1.3.0-draft`（2026-07-30） |
| 自身一致性等级 | **`C1`** — 校验器 8 维度全部通过负向验证，挂进 `npm test` |
| `factory/` 实现 | 未开始 |
| 项目注册表 | 未建 |

> 本仓遵守 ASFAS `FP-6`（不预埋）：`factory/` / `runtime/` / `projects/` 目录在有实际实现时才创建。

## 闸门

```bash
npm test
```

- `spec/check-asfas-doc.mjs` — 8 条检查维度：章节连续性与侧栏双向一致 · 规范性陈述编号唯一且连续 ·
  内部引用可解析 · **附录 B 数量与实际相等**（数字漂移守护）· `CP-n` 连续 ·
  **SVG 内无非法元素** · 块级标签平衡 · Part 结构齐备
- `spec/negative-verify.mjs` — 逐维度负向验证（`VC-8`）：注入违规 → 须红且消息命中 → 回滚 → 须绿

无 `--fix`（`VC-2`：治理只诊断、不自动改）。传入即以退出码 2 报错。
