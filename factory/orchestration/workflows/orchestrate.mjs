// orchestrate.mjs — 编排工作流：Supervisor 缺口分析（ASFAS §42 · AG-16 / AG-17 / WF-8）
//
// 与 research.mjs 的定位差异：research 是**具名未决项**的研究（产出决策候选）；
// orchestrate 是**跨级别缺口分析**（产出任务清单），由 Supervisor 承接。
//
// ## 为什么 supervisor 在这里不标 deterministic
//   `AG-17`：Supervisor 对流程的作用 MUST 限于查表执行——这适用于阶段序列固定的流程。
//   但"分析一个项目的缺口并拆成任务"是**开放式推理**：输入是项目现状（MedTrust RWS
//   L1.5-L4 半走通），输出是缺口清单——没有一张表可以查。派模型调用做分析不是
//   "把确定性换成非确定性"，而是"没有确定性规则可表达这件事"（`FINV-1` 的边界：
//   能确定性表达的不交给模型，不能的才交给 Activity）。
//
// ## L0 上限的合规意义（AG-16）
//   本工作流所有阶段 `action_level: 'L0'`——分析只读项目事实，产出任务清单，
//   **不写任何文件**。缺口修复（写代码）是后续 L1 执行工作流的任务，不在本定义内。
//   写类任务当前也被归级门 Q-6 挡着（编排面无路径级放行闸），这不是本工作流的选择，
//   是编排面当前能力的诚实边界。

/** Supervisor 的 typed 输出 schema（`WF-8` ③）。parse 失败即 `output_invalid`（`WF-9`）。 */
export const ORCHESTRATE_OUTPUT_SCHEMA = Object.freeze({
  tasks: 'Array<{id, level:"L0"|"L1.5"|"L2"|"L3"|"L4", gap, suggested_action, acceptance}>',
});

/**
 * 任务清单的行为闸门判据：产出必须能被后续执行工作流直接消费。
 * ① ≥2 个任务（单一任务无法与"只看了第一处"区分）；
 * ② 每条任务的 level 在闭集内（L0/L1.5/L2/L3/L4）；
 * ③ 每条任务的 gap / suggested_action / acceptance 非空——没有验收标准的任务无法执行。
 *
 * @returns {{ok:boolean, reason?:string}}
 */
export function evaluateTasks(output) {
  if (!output || typeof output !== 'object') return { ok: false, reason: '输出不是对象' };
  const tasks = output.tasks;
  if (!Array.isArray(tasks) || tasks.length < 2) {
    return { ok: false, reason: `任务清单 ${Array.isArray(tasks) ? tasks.length : 0} 条，须 ≥2（单一任务无法与"只看了第一处"区分）` };
  }
  const LEVELS = new Set(['L0', 'L1.5', 'L2', 'L3', 'L4']);
  for (const t of tasks) {
    if (!LEVELS.has(t.level)) return { ok: false, reason: `任务 "${t.id ?? '?'}" 的 level "${t.level}" 不在闭集（L0/L1.5/L2/L3/L4）` };
    for (const f of ['gap', 'suggested_action', 'acceptance']) {
      if (!t[f] || String(t[f]).trim().length < 8) {
        return { ok: false, reason: `任务 "${t.id ?? '?'}" 缺 ${f}（没有验收标准的任务无法执行）` };
      }
    }
  }
  return { ok: true };
}

/** `WF-2` 六项齐备。形状由 workflow.mjs 的 assertWorkflowDefinition 机器校验。 */
export const orchestrateWorkflow = Object.freeze({
  id: 'orchestrate',

  // ① 触发条件
  trigger: '跨级别缺口分析请求（被治理项目 + 目标级别范围 + 完成判据）',

  // ②③④ 阶段序列 · 每阶段角色与动作等级 · 闸门位置与判据
  stages: [
    {
      id: 'dispatch',
      role: 'supervisor',
      action_level: 'L0',          // AG-16：Supervisor MUST 是 L0，无文件写入能力
      // 不标 deterministic —— 开放式缺口分析，派活动给 supervisor（见头注释）
      output_schema: ORCHESTRATE_OUTPUT_SCHEMA,
      // §28.1 ④ Prompt 契约：只含当前状态与可选动作集，MUST NOT 内联项目事实（FR-17）。
      prompt_contract: [
        '你在执行一次编排分析，产出是**任务清单**（缺口 + 建议动作 + 验收标准），不是代码（L0）。',
        '只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何解释性前后文。',
        '输出形状：{"tasks": [{"id": "<简短标识>", "level": "L0|L1.5|L2|L3|L4", "gap": "<缺口描述>", "suggested_action": "<建议动作>", "acceptance": "<验收标准>"}]}',
        '硬要求（缺一即被闸门打回）：',
        '  ① tasks 至少 2 条；',
        '  ② 每条 level 必须是 L0/L1.5/L2/L3/L4 之一；',
        '  ③ 每条必须有 gap / suggested_action / acceptance，acceptance 要可验证（不是"改进"这类形容词）。',
      ].join('\n'),
      gates: [
        { id: 'intake-complete', class: 'structural', criterion: '问题与判据均非空' },
        { id: 'tasks-complete', class: 'behavioral', criterion: '输出含 ≥2 任务，每条有 level/gap/suggested_action/acceptance' },
      ],
    },
    {
      id: 'decide',
      role: 'supervisor',
      action_level: 'L0',
      deterministic: true,         // 只是把任务清单摆到人面前，没有模型的事
      gates: [
        { id: 'human-decision', class: 'release', criterion: '人确认任务清单（后续 L1 执行工作流按此拆包）' },
      ],
    },
  ],

  // ⑤ 失败路由（WF-11：回退目标阶段 + 重试上限；达上限升级给人）
  failure_routes: {
    dispatch: { to: 'dispatch', max_retries: 2 },
    decide: { to: 'decide', max_retries: 0 },
  },

  // ⑥ 终止条件（含放弃路径）
  terminal: {
    on_success: 'completed',
    on_abandon: 'abandoned',
    on_escalate: 'escalated',
  },
});
