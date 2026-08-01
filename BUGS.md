# ai-factory — 已知 Bug / 待办清单

> **TODO 形式维护**：每条是一个待办项，修完勾掉（`- [x]`），保留历史。新增 bug 在此登记，附复现证据。
> 归属：本仓是工厂层，bug 影响所有被治理项目（README：修一次对所有项目生效）。

## 未修复

### BUG-1: 并行 `start` 的 workflowId 撞号（事件流混写）
- **发现**：2026-08-01，GMPGCPwork D-06A/D-01C 两个 research 并行启动时撞同一 ID。
- **根因**：`factory/orchestration/cli.mjs:108` 的 `workflowId = ${wf.id}-${Date.now().toString(36)}` 只用毫秒时间戳，**无随机后缀**。并行进程在同一毫秒启动 → 同 ID → 两 workflow 写同一 `.jsonl` 事件文件，事件混写，无法按 workflow 单独 `release`/`status`。
- **复现证据**：`.workflow-runs/GMPGCPWork/research-msa844gi.jsonl` 含两条不同 question 的完整事件（LDAP + 附件），`workflow_id` 相同。
- **影响**：并行编排（D-RELEASE-1 语义）不可靠；混写后决策血缘按 workflow 追溯失效。
- **待办**：
  - [ ] `cli.mjs:108` workflowId 加随机后缀（`${Date.now().toString(36)}-${randomUUID().slice(0,4)}`）
  - [ ] `engine.mjs`/`events.mjs` 对已存在的 workflow 文件加防重写守卫（写前检查同 ID 存在 → 报错而非追加）
  - [ ] 补负向验证：并行启动两个 research → workflowId 唯一、事件不混写

### BUG-2: 并行 `start` 的 research 输出可能互相污染（候选撞库）
- **发现**：同 BUG-1 的现场——两个 research 的 `activity.completed` 事件混在同一 `.jsonl`，若按 `workflow_id` 全量读取，会读到对方的候选。
- **根因**：BUG-1 的必然结果。
- **待办**：
  - [ ] BUG-1 修完后，`status`/`release` 的 `findLog` 应能唯一定位；加集成断言：并行两 workflow 各自 `status` 只看到自己的事件

## 已修复
（无）

---

## 排查日志（非 bug，佐证）
- `.serena/memories/registry.md`：项目侧漂移导致闸门红——设计意图（`FR-16`），不是 bug。
- `runtime/claude-agent-sdk/adapter.mjs:144`：runtime_fault 兜底不计入迭代护栏——设计，不是 bug。
