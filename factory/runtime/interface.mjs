// interface.mjs — 工厂层与运行时之间的唯一接口文件（ASFAS §35 · RT-1）
//
// 本文件是 `FINV-5`（运行时最小化）的落点：把运行时整体换成另一厂商实现后，
// 工厂层与元语层 MUST 零改动。判据可测——`§40` 的替换协议要求提交 diff 证明。
//
// ## 本文件的三条硬约束（会被 spec/check-runtime-boundary.mjs 机器守护）
//   1. MUST NOT import 任何厂商 SDK。工厂层认识的只有这里的形状，不认识 Claude Agent SDK。
//   2. MUST NOT import 任何第三方依赖。只用 node 标准库——本仓零安装即可跑（见 mem:tech_stack）。
//   3. 方法集是闭集。`RT-11`：破坏性变更 MUST 同时更新全部已登记绑定，同一提交；
//      MUST NOT 用"某绑定暂不支持新方法"分批迁移——迁移期恰恰是最需要 FINV-5 成立的时候。
//
// ## 为什么接口里带校验函数，而不只是类型声明
//   JSDoc 类型只在编辑器里成立，跑起来就没了。`RT-5` 要求"活动失败作返回值而非异常"、
//   `AG-8` 要求"计量未知返回空而非 0"——这两条只有在运行时真的检查了才算数。
//   本文件因此同时是 契约 与 契约的强制点：绑定的返回值过不了 assertActivityResult 就是缺陷。

/** RT-1 接口方法闭集（§35.1）。顺序即文档顺序，不表示调用顺序。 */
export const RUNTIME_METHODS = Object.freeze([
  'run',          // 执行一次活动，返回 typed 结果
  'handoff',      // 把 typed 状态交给另一角色（FR-17：引用而非内容）
  'resume',       // 从检查点恢复
  'cancel',       // 中止并落血缘（MUST 触发 Record 阶段，AG-2）
  'checkpoint',   // 写检查点
  'meter',        // 返回 token 与时长计量
  'capabilities', // §40 能力缺口声明（RT-12：声明式，不靠调用后看是否抛异常）
]);

/** 错误分类闭集（§35.3）。只有运行时知道失败发生在哪一层，故分类 MUST 由运行时给出。 */
export const ERROR_CLASSES = Object.freeze({
  //                      工作流处置              计入迭代护栏
  transient:          'retry_same_params',    // 否 —— 基础设施抖动不是智能体的失败（RT-7）
  output_invalid:     'return_to_same_role',  // 是 —— 输出 parse 失败（WF-9）
  budget_exceeded:    'escalate_to_human',    // —— 不重试（AG-10）
  permission_denied:  'escalate_to_human',    // —— 重试无意义
  capability_missing: 'escalate_to_human',    // —— MUST NOT 降级绕过（§40）
  runtime_fault:      'escalate_and_flag',    // 否 —— 适配器自身缺陷
});

/** 不计入迭代护栏的错误类。RT-7：与 output_invalid 合并会让护栏在网络不稳时误报。 */
export const NON_ITERATING_ERRORS = Object.freeze(['transient', 'runtime_fault']);

/** 动作等级闭集（§27.6 归级算法的取值域）。 */
export const ACTION_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);

/**
 * @typedef {Object} Activity
 * @property {string}   run_id                 贯穿运行时/沙箱/工具面/存储四层，MUST NOT 被重新生成（CP-79）
 * @property {string}   role                   MUST 在能力注册表在册（MS-37）；SDK 侧 MUST NOT 另行定义身份
 * @property {string}   action_level_ceiling   由归级算法算出（§27.6）
 * @property {string[]} semantic_refs          FR-17：引用而非内容——摘要会分叉，引用不会
 * @property {string[]} tool_grants            闭集；运行时 MUST NOT 扩展（RT-6 / AG-1）
 * @property {unknown}  input                  typed，由角色契约定义
 * @property {{iterations:number, tokens?:number, minutes?:number}} budget
 */

/**
 * @typedef {Object} Metering
 * @property {number|null} tokens_in    未知 MUST 为 null 而非 0（AG-8）
 * @property {number|null} tokens_out   同上
 * @property {number|null} cost_usd     同上
 * @property {number|null} duration_ms  同上
 */

/**
 * @typedef {{ok:true, output:unknown, metering:Metering, changed_paths?:string[]}
 *         | {ok:false, error:{class:string, message:string, location?:string}, metering:Metering}} ActivityResult
 *
 * `changed_paths`（可选，仅 ok:true）：活动实际改写的路径数组（diff 来源）。
 * `D-RELEASE-1`：L2 活动的合并门用它做路径级放行对拍；L0/L1 可不提供。
 * 运行时无法收集时**省略**该字段，由工作流按 `VC-12` 可见处理，不假阳性。
 */

/** 计量空值。AG-8：未知返回空而非 0——0 是一个会污染成本度量的谎。 */
export const EMPTY_METERING = Object.freeze({
  tokens_in: null, tokens_out: null, cost_usd: null, duration_ms: null,
});

const fail = (m) => { throw new TypeError(`RT 契约违反：${m}`); };

/**
 * RT-11 守护：绑定 MUST 实现全部 7 个方法。
 * 只查形状不查行为——行为由 §40 一致性测试套件验收。
 * @param {object} adapter @param {string} name 绑定名，用于报错定位（§25.3）
 */
export function assertAdapterShape(adapter, name = '(匿名绑定)') {
  if (!adapter || typeof adapter !== 'object') fail(`${name}: 绑定须 default export 一个对象`);
  const missing = RUNTIME_METHODS.filter((m) => typeof adapter[m] !== 'function');
  if (missing.length) fail(`${name}: 缺 RT-1 方法 ${missing.join(', ')}（RT-11：不得分批迁移）`);
  const extra = Object.keys(adapter).filter((k) => typeof adapter[k] === 'function' && !RUNTIME_METHODS.includes(k));
  // RT-2：接口 MUST NOT 暴露"让智能体自行决定下一步"的方法。多出来的公开方法即是这类口子的入口，
  // 所以这里判红而不是警告——推进由工作流裁决（FG-3），运行时只执行被指定的活动。
  if (extra.length) fail(`${name}: 暴露了接口外的方法 ${extra.join(', ')}（RT-2：接口是闭集）`);
  return true;
}

/** 入参契约。派工前校验，避免把畸形活动送进模型会话再由结果反推问题。 */
export function assertActivity(a) {
  if (!a || typeof a !== 'object') fail('Activity 须为对象');
  for (const f of ['run_id', 'role', 'action_level_ceiling']) {
    if (typeof a[f] !== 'string' || !a[f]) fail(`Activity.${f} 须为非空字符串`);
  }
  if (!ACTION_LEVELS.includes(a.action_level_ceiling)) {
    fail(`Activity.action_level_ceiling "${a.action_level_ceiling}" 非法（须为 ${ACTION_LEVELS.join('/')}）`);
  }
  for (const f of ['semantic_refs', 'tool_grants']) {
    if (!Array.isArray(a[f])) fail(`Activity.${f} 须为数组（闭集）`);
  }
  const it = a.budget?.iterations;
  // 无迭代上限 = 无护栏。AG-10 的护栏建立在这个数字上，缺了它整条链形同虚设。
  if (!Number.isInteger(it) || it < 1) fail('Activity.budget.iterations 须为 ≥1 的整数（AG-10 护栏计量对象）');
  return true;
}

/** 计量契约。AG-8：字段可为 null（未知），但 MUST NOT 缺字段或用 0 冒充未知。 */
export function assertMetering(m, ctx = '') {
  if (!m || typeof m !== 'object') fail(`${ctx}metering 须为对象`);
  for (const f of Object.keys(EMPTY_METERING)) {
    if (!(f in m)) fail(`${ctx}metering 缺字段 ${f}（AG-8：未知须显式 null，不得省略）`);
    if (m[f] !== null && typeof m[f] !== 'number') fail(`${ctx}metering.${f} 须为 number 或 null`);
  }
  return true;
}

/**
 * 返回值契约。RT-5：活动失败 MUST 作为 ok:false 的返回值表达并携带计量——
 * 抛异常会绕过 Record 阶段（AG-2 要求失败会话同样落血缘），计量丢失会污染成本度量（AG-8）。
 */
export function assertActivityResult(r) {
  if (!r || typeof r !== 'object') fail('ActivityResult 须为对象');
  if (r.ok !== true && r.ok !== false) fail('ActivityResult.ok 须为布尔字面量');
  assertMetering(r.metering, 'ActivityResult.');
  if (r.ok === true && r.changed_paths !== undefined) {
    if (!Array.isArray(r.changed_paths) || r.changed_paths.some((p) => typeof p !== 'string')) {
      fail('ActivityResult.changed_paths 须为字符串数组（D-RELEASE-1 合并门对拍依据）');
    }
  }
  if (r.ok === false) {
    const cls = r.error?.class;
    if (!cls) fail('ActivityResult.error.class 缺失（工作流据此选择失败路由 WF-11，不得靠猜）');
    if (!(cls in ERROR_CLASSES)) fail(`ActivityResult.error.class "${cls}" 不在闭集（${Object.keys(ERROR_CLASSES).join('/')}）`);
    if (typeof r.error.message !== 'string' || !r.error.message) {
      fail('ActivityResult.error.message 缺失（§25.3：错误消息须含位置，否则智能体随机试探）');
    }
  }
  return true;
}

/** 该错误类是否计入迭代护栏。工作流用它更新 budget，不要在别处重新判断。 */
export const countsAsIteration = (errorClass) => !NON_ITERATING_ERRORS.includes(errorClass);
