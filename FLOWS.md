# FLOWS.md — 流程契约（Source of Truth）

> **本文件的 `flow` 块是解析目标**，与状态写入点做**双向**对拍。
> 破坏格式 / 声明与实现不符 = **测试红**（`npm run verify:flows`，已挂进 `npm test`）。
>
> 关联：[`DECISIONS.md`](DECISIONS.md)（`INV-n` 在册）· `spec/ASFAS.html` §41（工作流模型）。
>
> **只写事实**：`impl: yes` = 代码里真有这条转移；`impl: no` = **状态存在但没人写它**。
> 后者不是遗漏登记，是待办或死值，逐条在 §2 给出处置。
>
> **`impl` 是状态级语义，不是转移级**（`MS-25`）。改任何状态写入前先读对应 `flow` 块。

---

## 0. 契约格式

每台状态机一个 ` ```flow ` 块：

```
machine: <对象>.<状态字段>
enum:    <枚举名>
states:  [<全部取值>]
initial: <初值>
- <from> → <to> | via: <入口> | by: <触发者> | inv: <INV-n 或 -> | impl: yes|no
```

**四要素缺一不可**：`via`（唯一合法入口）· `by`（谁能触发）· `inv`（受哪条不变量约束）· `impl`（是否已实现）。
`by: system` 表示无人工触发。

---

## 1. workflow_run.status

编排面唯一的状态机。**状态不落盘**——它由事件序列推导（`INV-1`），
所以下面每条转移的 `via` 是**事件类型**，而不是 API 路由。

```flow
machine: workflow_run.status
enum: WorkflowState
states: [pending, running, awaiting_human, terminated]
initial: pending
- pending → running | via: event:workflow.started | by: human | inv: INV-1 | impl: yes
- running → running | via: event:stage.entered | by: system | inv: INV-1 | impl: yes
- running → awaiting_human | via: event:gate.evaluated | by: system | inv: INV-2 | impl: yes
- awaiting_human → running | via: event:release.granted | by: human | inv: INV-2 | impl: yes
- awaiting_human → running | via: event:path-release.granted | by: human | inv: INV-2 | impl: yes
- running → terminated | via: event:workflow.terminated | by: system | inv: INV-3 | impl: yes
- awaiting_human → terminated | via: event:workflow.terminated | by: system | inv: INV-3 | impl: yes
```

- **唯一写入点**是 `factory/orchestration/workflow.mjs` 的 `deriveState()`。
  它是纯函数：同一事件序列必然推出同一状态，这是 `WF-1`「重启后能从最后一个事件恢复」的前提。
- `running → awaiting_human` 只在 `gate_class === 'release'` 且 `result === 'pending'` 时发生。
  **人工放行闸门未过 = 等人，不是失败**——区分这两者是 `INV-2`（决策权不下放）的落点。
  若把它当失败，工作流会走失败路由重试，等于让智能体绕过人继续推进。
- `awaiting_human → running` 有两条进入路径：`release.granted`（阶段级、终态——放行后
  `workflow.terminated` 紧随，是 `D-PROJ-1` 语义）与 `path-release.granted`（路径级、非终态——
  `D-RELEASE-1`：L2 改动集放行后工作流**继续推进**，改动集合并生效）。
- `running → running` 不是空转：`stage.entered` 会更新 `stage` 字段，只是不改 `status`。

---

## 2. 未实现状态的处置

> `impl: no` 的转移**必须**在此逐条给出处置结论，不留悬空。

**当前为空**——四个状态在 `deriveState()` 中都有写入点，没有死状态。

### 2.1 缺失的触发路径（不是未实现状态）

`impl` 是**状态级**语义（`MS-25`），表达不了「状态实现了但缺某条进入路径」。
这类缺口记在这里，不得写成 `impl: no`——那会让同一目标态出现 `yes`/`no` 矛盾声明。

**当前为空。** 曾登记的 `pending → terminated`（放弃一个尚未启动的实例）已判定为
**不可达且不应声明**：`pending` 是空事件序列的推导结果，而空事件序列意味着该实例在磁盘上不存在。
放弃一个不存在的东西没有语义。`WF-2` ⑥要求的放弃路径由
`running → terminated` 与 `awaiting_human → terminated`（`reason: abandoned`）承载，
触发命令是 `cli.mjs abandon`，已实现。

---

## 附录：格式契约（校验器解析规则）

1. 每个 `flow` 块须含 `machine` / `enum` / `states` / `initial` 四个头字段。
2. 每条转移行须五段齐全：`from → to` + `via` + `by` + `inv` + `impl`；缺任一段即红。
3. 每条转移的 `from` / `to` **∈** `states`；`initial` **∈** `states`。
4. **`impl` 双向（状态级语义）**：
   - `impl: yes` 的目标态 → `deriveState()` 中须存在对该状态的写入点；
   - `impl: no` 的目标态 → 须**不存在**写入点；
   - 同一目标态被同时声明 `yes` 与 `no` → **红**（矛盾声明）。
5. `inv` 非 `-` 时须在 [`DECISIONS.md`](DECISIONS.md) §1 在册。
6. `via: event:X` 的 `X` 须在 `factory/orchestration/events.mjs` 的 `EVENT_TYPES` 闭集内。
7. `impl: no` 的转移须在 §2「未实现状态的处置」有条目。
8. **任一 `flow` 块解析为 0 行转移 = 格式契约破坏 = 红。**
