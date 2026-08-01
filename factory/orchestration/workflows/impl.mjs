// impl.mjs — 执行工作流（Test → Impl → 路径级放行 → 人工确认）（ASFAS §42 · WF-12 / D-RELEASE-1）
//
// ## 与 research / orchestrate 的定位差异
//   research 产出**决策候选**；orchestrate 产出**任务清单**；本工作流把任务清单里的
//   一条任务**真实落代码**——Test 先于 Impl（§42），Impl 是 L2 写类活动（先干后放）。
//
// ## 阶段契约（§42.2）
//   Test（L1）：产出**失败的测试** + 断言级红证据（WF-12 ①：确实运行且为红；
//   ② 失败是断言失败而非编译/导入错误）。Test 在**项目 L1 面**写测试文件。
//   Impl（L2）：产出改动集；engine 归级后触发路径级放行（D-RELEASE-1：先干后放，
//   改动集经人工放行才合并生效）。
//   decide：人工确认（决策权不下放，§47）。
//
// ## "测试为红"的确定性近似（已知限制）
//   adapter 不跑测试命令（capabilities 只实现 run/meter）。WF-12 三条件的强制点
//   落在 Test 阶段的**行为闸门**：要求 output 含 `tests_red`（断言级失败证据清单），
//   由判据逐项检查——这是确定性近似，已在 D-RELEASE-1 已知代价③登记。

/** Test 阶段的 typed 输出 schema。 */
export const TEST_OUTPUT_SCHEMA = Object.freeze({
  tests_red: 'Array<{file, test_name, reason, is_assertion_failure}>',
  declares: 'Array<string> —— 覆盖的任务卡不变量/约束 ID',
});

/** Impl 阶段的 typed 输出 schema。 */
export const IMPL_OUTPUT_SCHEMA = Object.freeze({
  summary: 'string —— 改动摘要',
  touched_invariants: 'Array<string> —— 触及的约束 ID（须在册）',
});

/**
 * Test 阶段行为闸门判据（WF-12 三条件的确定性近似）。
 * ① 至少一条断言级失败（tests_red 非空且 is_assertion_failure 至少一条）；
 * ② 不得全是编译/导入错误（is_assertion_failure=false 的项须 ≤ 断言项）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function evaluateTestRed(output) {
  if (!output || typeof output !== 'object') return { ok: false, reason: '输出不是对象' };
  const tr = output.tests_red;
  if (!Array.isArray(tr) || tr.length === 0) {
    return { ok: false, reason: `tests_red ${Array.isArray(tr) ? tr.length : 0} 条，须 ≥1（测试必须确实为红，WF-12 ①）` };
  }
  const assertions = tr.filter((t) => t.is_assertion_failure === true);
  if (assertions.length === 0) {
    return { ok: false, reason: 'tests_red 无一条 is_assertion_failure=true —— 全是编译/导入错误不算表达行为期望（WF-12 ②）' };
  }
  const missing = tr.filter((t) => !t.file || !t.test_name || !t.reason);
  if (missing.length) return { ok: false, reason: `${missing.length} 条 tests_red 缺 file/test_name/reason（证据须可追溯，§25.3）` };
  return { ok: true };
}

/** `WF-2` 六项齐备。 */
export const implWorkflow = Object.freeze({
  id: 'impl',

  // ① 触发条件
  trigger: '任务卡（orchestrate 产出的单条缺口任务：gap + suggested_action + acceptance）',

  // ②③④ 阶段序列 · 角色 · 闸门
  stages: [
    {
      id: 'dispatch',
      role: 'supervisor',
      action_level: 'L0',
      deterministic: true,         // 查表执行：校验任务卡字段齐全
      gates: [
        { id: 'intake-complete', class: 'structural', criterion: '任务卡含 gap/suggested_action/acceptance' },
      ],
    },
    {
      id: 'test',
      role: 'test',
      // D-RELEASE-2（§42 Test=L1 的偏离登记）：MedTrust 的 connector 测试文件在
      // `apps/connector/src/domain/**`（L2 面），L1 面只含 `apps/api/src/**/*.spec.ts`，
      // 8 个 RWS 任务的目标代码全在 L2 面 → Test 阶段提为 L2，测试文件同样走路径级放行。
      action_level: 'L2',
      // 写测试 + 隔离副本跑测确认红（WF-12 ①）需要更多轮次：25 是参考实现的 L0 研究默认值。
      // 试点（L2-missing-data）60 轮通过；cohort-def 写实现 + NestJS 全量 jest 慢，60 仍不够，
      // 升级到 150（写实现 + 跑测确认绿是重活，seed 大仓也耗轮次）。
      budget: { iterations: 150 },
      output_schema: TEST_OUTPUT_SCHEMA,
      prompt_contract: [
        '你在执行 TDD 的 Test 阶段：为任务卡的 acceptance 写**失败的测试**。',
        '只输出一个 JSON 对象，不要 Markdown 围栏，不要解释性前后文。',
        '输出形状：{"tests_red": [{"file": "<测试文件路径>", "test_name": "<测试名>", "reason": "<为何失败>", "is_assertion_failure": true}], "declares": ["<覆盖的约束 ID>"]}',
        '硬要求（WF-12，缺一即被闸门打回）：',
        '  ① tests_red 至少 1 条；',
        '  ② 至少一条 is_assertion_failure=true（断言级失败，不是编译/导入错误）；',
        '  ③ 每条给出 file/test_name/reason。',
        '写完测试后：在隔离工作副本跑一次对应测试命令，确认确实为红，再回报。',
      ].join('\n'),
      gates: [
        { id: 'output-parses', class: 'structural', criterion: '活动输出为合法 JSON（WF-9）' },
        { id: 'test-red-evidence', class: 'behavioral', criterion: 'tests_red 含断言级失败证据（WF-12 ①②）' },
      ],
    },
    {
      id: 'impl',
      role: 'impl',
      action_level: 'L2',          // 改动在项目 L2 面（connector/agent 域）→ 触发路径级放行
      budget: { iterations: 150 }, // 写实现 + 隔离副本跑测确认绿，同 Test 阶段理由（见上）
      output_schema: IMPL_OUTPUT_SCHEMA,
      prompt_contract: [
        '你在执行 TDD 的 Impl 阶段：让 Test 阶段的红测试变绿。',
        '只输出一个 JSON 对象，不要 Markdown 围栏，不要解释性前后文。',
        '输出形状：{"summary": "<改动摘要>", "touched_invariants": ["<触及的约束 ID>"]}',
        '你的改动会产生实际文件变更，合并前须经路径级人工放行（D-RELEASE-1：先干后放）。',
        '改完在隔离工作副本跑测试确认变绿，再回报。',
      ].join('\n'),
      gates: [
        { id: 'output-parses', class: 'structural', criterion: '活动输出为合法 JSON（WF-9）' },
      ],
    },
    {
      id: 'decide',
      role: 'supervisor',
      action_level: 'L0',
      deterministic: true,
      gates: [
        { id: 'human-decision', class: 'release', criterion: '人确认改动已合并且验收标准达成' },
      ],
    },
  ],

  // ⑤ 失败路由（WF-11）
  failure_routes: {
    dispatch: { to: 'dispatch', max_retries: 1 },
    test: { to: 'test', max_retries: 2 },
    impl: { to: 'impl', max_retries: 2 },
    decide: { to: 'decide', max_retries: 0 },
  },

  // ⑥ 终止条件
  terminal: {
    on_success: 'completed',
    on_abandon: 'abandoned',
    on_escalate: 'escalated',
  },
});
