# ai-factory

**Knowledge Driven Software Factory** — 工厂层仓库。

本仓库承载与项目无关的软件工厂能力。它治理的项目（`GMPGCPwork`、`diabetes` 等）各自独立，
本仓不包含任何项目的业务知识（ASFAS `FINV-4`）。

## 唯一架构宪法

[`spec/ASFAS.html`](spec/ASFAS.html) — **Agent Native Software Factory Architecture Specification**，
Level 2 Engineering Specification。用浏览器打开。

- Part I–III（§1–§25）规范性定稿：设计理念 · 四层架构 · **知识体系（元语规范）**
- Part IV–VIII 已定范围与关键条款，细则待补（见附录 I 未决清单）
- 附录 A：46 条一致性检查点 `CP-1`…`CP-46`

L1 白皮书与 L3 开发手册**派生自**本文件，不得包含与之冲突的规范性陈述（`FR-0`）。

## 当前状态

| 项 | 状态 |
|---|---|
| ASFAS 版本 | `1.0.0-draft`（2026-07-30） |
| 自身一致性等级 | `C0` — `check-asfas-doc.mjs` 未实现（未决 `QA-1`） |
| `factory/` 实现 | 未开始 |
| 项目注册表 | 未建 |

> 本仓遵守 ASFAS `FP-6`（不预埋）：`factory/` / `runtime/` / `projects/` 目录在有实际实现时才创建。
