#!/usr/bin/env node
// adapter.mjs — Claude Agent SDK 运行时绑定（ASFAS §36 · FADR-1）
//
// 本文件是**唯一**允许 import 厂商 SDK 的地方（`CP-：厂商 SDK 命中仅在 runtime/<vendor>/`）。
// 工厂层只认识 `factory/runtime/interface.mjs` 的形状，换绑定时 factory/ 零改动（`FINV-5`）。
//
// ## 本绑定当前是骨架：run / meter / capabilities 已实现，其余经 capabilities() 显式声明缺口
//   `RT-12`：新增可选能力 MUST 经 capabilities() 声明，MUST NOT 用"调用后看是否抛异常"探测。
//   缺口是声明出来的事实，不是沉默——`FP-7`（诚实缺口）。
//
// ## 四条容易写错的地方，都已固化在下面的注释里
//   1. `RT-5`：run() MUST NOT 抛异常表示活动失败——抛出会绕过 Record 阶段（`AG-2`）且丢计量（`AG-8`）。
//   2. `RT-8`：MUST NOT 自行重试 output_invalid——静默重试会让 iterations 失真，`AG-10` 护栏形同虚设。
//   3. `RT-13`：超出 tool_grants 的内置工具 MUST 被显式禁用，不能靠"不在 prompt 里提它"。
//   4. `settingSources: []` **挡不住 auto memory** —— 它无视该选项直接进 system prompt。
//      收窄会话面需要四件事一起做：settingSources / DISABLE_AUTO_MEMORY / 独立 cwd / 独立 CLAUDE_CONFIG_DIR。

import { mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertActivity, assertActivityResult, EMPTY_METERING,
} from '../../factory/runtime/interface.mjs';
import { resolveProvider, buildEnv } from './providers.mjs';

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * SDK 内置工具名单（`§36.3` 升级必查项：新版本可能新增内置工具且默认开启）。
 *
 * 这份名单是**纵深防御**，不是主防线。主防线是 permissionMode:'dontAsk'——未授权工具
 * 一律拒绝，不依赖名单完整性。理由：名单会随 SDK 版本漂移，而漂移是静默的；
 * 把安全性押在一份会过期的清单上，正是 `FP-7` 要求诚实登记的那类缺口。
 */
export const SDK_BUILTIN_TOOLS = Object.freeze([
  'Read', 'Write', 'Edit', 'Bash', 'BashOutput', 'KillShell', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'NotebookEdit', 'TodoWrite', 'Task', 'Agent',
  'Skill', 'SlashCommand', 'Workflow', 'SendMessage',
]);

/** run_id → 计量。meter() 的数据源；`RT-10` 保证同一 run_id 不并发，故无需加锁。 */
const ledger = new Map();

/** 活动工作副本的根。可用 env 覆盖，便于把它挂到隔离卷上（`§48`）。 */
export const WORKSPACE_ROOT = process.env.AI_FACTORY_WORKSPACE_ROOT ?? join(tmpdir(), 'ai-factory-runs');

/**
 * 每活动一份隔离路径。
 *
 * `RT-10`：不同 run_id 的并发活动，若 action_level_ceiling ≥ L1，MUST 在**相互隔离的工作副本**中执行。
 * 官方 Hosting 文档同样要求多租户共享容器时按租户分 `cwd` 与 `CLAUDE_CONFIG_DIR`——
 * 后者是为了不共享 `~/.claude.json` 全局配置。两条要求指向同一个做法。
 *
 * **纯函数，不建目录**：`RB-5`/`RB-7` 会调用 buildQuery 做断言，断言不该在磁盘上留垃圾。
 * 真正的 mkdir 在 run() 里。
 */
export function isolationPaths(runId) {
  // run_id 由工厂给出，但目录名是攻击面：`../` 会让工作副本逃逸到隔离区之外。
  // 运行时对自己的落盘路径负责，这里 fail-closed 而不是 sanitize——
  // 悄悄改写 run_id 会让血缘里的 id 与磁盘上的目录对不上（CP-79：run_id 贯穿四层且不得被重新生成）。
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    const e = new Error(`run_id "${runId}" 含非法字符，无法用作隔离目录名（只许 [A-Za-z0-9._-]）`);
    e.class = 'runtime_fault';
    throw e;
  }
  const base = join(WORKSPACE_ROOT, runId);
  return { cwd: join(base, 'work'), configDir: join(base, 'config') };
}

/**
 * 构造一次 query() 的入参。**抽成纯函数是为了让 `RT-13` 可断言**——
 * RT-13 要求"适配器 MUST 有一条测试断言未授权工具确实不可调用"。若收窄逻辑埋在 run() 里，
 * 那条断言就只能靠联网跑一次模型来做，既慢又不确定；抽出来后 spec/ 的校验器可以直接对
 * 返回的 options 做集合断言，零网络零依赖。
 * @param {import('../../factory/runtime/interface.mjs').Activity} activity
 * @param {{model:string, baseUrl:string, authToken:string}} resolved
 */
export function buildQuery(activity, resolved) {
  const granted = new Set(activity.tool_grants);
  const iso = isolationPaths(activity.run_id);
  return {
    prompt: typeof activity.input === 'string' ? activity.input : JSON.stringify(activity.input),
    options: {
      // 供应商路由的落点。SDK 的 env 是替换语义，buildEnv 已带上继承项。
      // CLAUDE_CONFIG_DIR 逐活动隔离：默认所有会话共享 ~/.claude.json 全局配置，
      // 那等于给跨活动的状态泄漏开了一条不经 tool_grants 的通道。
      env: { ...buildEnv(resolved), CLAUDE_CONFIG_DIR: iso.configDir },
      model: resolved.model,
      // deepseek-v4-flash：thinking 默认启用（1M 上下文，budget_tokens 被 DeepSeek 端忽略，
      // 故用 enabled 而非预算式）。SDK 的 thinking 配置经 Anthropic 协议透传给 DeepSeek 端点。
      thinking: { type: 'enabled' },

      // 工作副本隔离（RT-10 / §48）。不给 cwd 的话所有活动共用应用进程的工作目录，
      // 并发活动会互相覆盖文件。
      cwd: iso.cwd,

      // ── RT-13 工具面收窄 ────────────────────────────────
      allowedTools: [...granted],
      // 主防线：未授权工具一律拒绝，不依赖 blocklist 完整性。
      permissionMode: 'dontAsk',
      // 纵深防御：显式禁用已知内置工具中未授权的部分。
      disallowedTools: SDK_BUILTIN_TOOLS.filter((t) => !granted.has(t)),
      // 不加载仓内 .claude/ 与 CLAUDE.md：环境里的配置若能拓宽工具面，
      // RT-13 就成了摆设，同时活动也不再确定性可重放（VC-1）。
      settingSources: [],
      strictMcpConfig: true,

      // ── 护栏 ────────────────────────────────────────────
      // 迭代上限直接落到 SDK。RT-8：适配器自身不重试，重试次数须对工作流可见。
      maxTurns: activity.budget.iterations,
    },
  };
}

const gap = (msg) => {
  const e = new Error(msg);
  e.class = 'capability_missing';   // 工作流处置：升级；MUST NOT 降级绕过（§40）
  return e;
};

/**
 * 把任意异常映射到 `§35.3` 的六类。只有运行时知道失败发生在哪一层，故分类在这里给出。
 * 导出是为了让 spec/ 的校验器能对分类做纯函数断言，不必联网复现每一类故障。
 *
 * ## 计费类错误 MUST NOT 归为 transient —— 实测踩到的坑
 *   Z.AI 的"余额不足/无资源包"用 HTTP 429 返回，与限流同码。若按 429 归 transient，
 *   `RT-7` 说 transient「同参数重试且不计入迭代护栏」——于是工作流会**无限重试一个
 *   永远不会成功的活动**，既烧不掉护栏也升级不到人。计费问题重试无意义，须立即升级。
 *   因此计费判据 MUST 排在状态码判据**之前**。
 */
export function classify(err) {
  if (err?.class) return err.class;                       // providers.mjs 已分好类的
  const m = String(err?.message ?? err);
  if (/insufficient balance|no resource package|recharge|quota|billing|credit balance|arrearage|余额/i.test(m)) {
    return 'permission_denied';                           // 立即升级，重试无意义（§35.3）
  }
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|\b(429|502|503|504)\b|rate.?limit|overload/i.test(m)) {
    return 'transient';                                   // RT-7：不计入迭代护栏
  }
  if (/\b(401|403)\b|unauthor|forbidden|permission|invalid.*api.?key/i.test(m)) return 'permission_denied';
  // 迭代/预算超限：AG-10 预算超限 → 升级给人，不重试。SDK 有时用 error_max_turns subtype，
  // 有时用普通 error result 带 "maximum number of turns" 文本——两条路径都必须归 budget_exceeded，
  // 否则 runtime_fault（不计入迭代护栏）会让引擎无限重试一个永远不会完成的活动（RT-7 的镜像缺陷）。
  if (/maximum number of turns|max turns|iteration limit|迭代上限|超护栏/i.test(m)) return 'budget_exceeded';
  if (new RegExp(`Cannot find (module|package).*${SDK_PACKAGE}`).test(m)) return 'capability_missing';
  return 'runtime_fault';                                 // 兜底归适配器缺陷，不诬赖活动
}

/** 从 SDK 的 result 消息取计量。`AG-8`：取不到的字段 MUST 是 null，不得用 0 冒充。 */
function meteringFrom(result, startedAt) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    tokens_in: num(result?.usage?.input_tokens ?? result?.input_tokens),
    tokens_out: num(result?.usage?.output_tokens ?? result?.output_tokens),
    cost_usd: num(result?.total_cost_usd),
    duration_ms: num(result?.duration_ms) ?? (startedAt ? Date.now() - startedAt : null),
  };
}

/**
 * 执行一次活动。
 * `RT-14`：一次 run() 一个会话，活动结束会话即销毁——MUST NOT 跨活动复用以省 token（违反 `AG-3`）。
 * @param {import('../../factory/runtime/interface.mjs').Activity} activity
 * @returns {Promise<import('../../factory/runtime/interface.mjs').ActivityResult>}
 */
async function run(activity) {
  const startedAt = Date.now();
  let metering = { ...EMPTY_METERING };
  // 血缘的 `agent` 字段要求"角色 id + **模型标识**"（`AG-7`）。只有运行时知道这次实际跑在哪个模型上，
  // 所以由绑定回报——工厂层拿不到也猜不出。解析失败时保持 null（`AG-8`：未知是事实，不是 0 也不是编造）。
  let binding = null;
  try {
    assertActivity(activity);
    const resolved = resolveProvider(activity.role);
    binding = { provider: resolved.provider, model: resolved.model };

    // 惰性 import：让本模块在 SDK 未安装时**仍可加载**，
    // 边界校验器与形状断言因此不需要 npm install（本仓根目录零依赖，见 mem:tech_stack）。
    let query;
    try {
      ({ query } = await import(SDK_PACKAGE));
    } catch (e) {
      throw gap(`${SDK_PACKAGE} 未安装：先在 runtime/claude-agent-sdk/ 下 npm install（${e.message}）`);
    }

    // buildQuery 是纯函数，目录要在这里真的建出来（否则 SDK 拿到不存在的 cwd 会失败）。
    const q = buildQuery(activity, resolved);
    mkdirSync(q.options.cwd, { recursive: true });
    mkdirSync(q.options.env.CLAUDE_CONFIG_DIR, { recursive: true });

    // D-RELEASE-1：写类活动（≥L1）先 seed 隔离副本——把项目工作区复制进隔离 cwd，
    // 否则活动没有源码可改（先干后放的"干"的前提）。L0 只读活动不需要。
    // seed 来源经 activity.input.seed.source 注入（engine 填 project.localPath，FINV-4：
    // 适配器不硬编码任何项目）。
    if (activity.action_level_ceiling !== 'L0') {
      seedWorkspace(q.options.cwd, activity.input?.seed?.source);
    }

    const response = query(q);

    // RT-9：流式输出只用于可观测性，MUST NOT 用于推进。
    // 推进条件只依赖下面那个**完整的、已 parse 的**终值（FINV-9）。
    let result = null;
    for await (const msg of response) {
      if (msg?.type === 'result') result = msg;
    }
    metering = meteringFrom(result, startedAt);
    ledger.set(activity.run_id, metering);

    if (!result) {
      return finish({ ok: false, error: { class: 'runtime_fault', message: 'SDK 未返回 result 消息' }, metering }, binding);
    }
    if (result.is_error || result.subtype === 'error_max_turns') {
      const cls = result.subtype === 'error_max_turns' ? 'budget_exceeded' : classify(new Error(result.result ?? 'unknown'));
      return finish({ ok: false, error: { class: cls, message: String(result.result ?? result.subtype) }, metering }, binding);
    }

    // WF-9：输出 parse 失败 = output_invalid，回同一角色并附失败位置（§25.3）。
    // 这里**不重试**——重试次数是护栏计量对象，由工作流可见地控制（RT-8）。
    let output;
    try {
      output = JSON.parse(result.result);
    } catch (e) {
      return finish({
        ok: false,
        error: { class: 'output_invalid', message: `活动输出非 JSON：${e.message}`, location: `run_id=${activity.run_id}` },
        metering,
      }, binding);
    }
    // D-RELEASE-1：写类活动（action_level_ceiling ≥ L1）收集实际改动集（diff 来源）。
    // 隔离副本 cwd 是 git 仓库时用 git diff 取已修改/未跟踪文件；非 git 或收集失败时省略
    // changed_paths（VC-12：无法判定则可见处理，不假阳性）。
    const changedPaths = collectChangedPaths(q.options.cwd, activity.action_level_ceiling);
    return finish({ ok: true, output, metering, ...(changedPaths ? { changed_paths: changedPaths } : {}) }, binding);
  } catch (err) {
    // RT-5 的落点：任何异常都转成返回值，且带上已知的计量。
    return finish({
      ok: false,
      error: { class: classify(err), message: String(err?.message ?? err), location: `role=${activity?.role ?? '?'}` },
      metering,
    }, binding);
  }
}

/**
 * 从活动工作副本收集实际改动集。
 * 隔离 cwd 是 git 仓库时：`git status --porcelain` 提取已修改/未跟踪路径。
 * 写类活动（≥L1）才有意义；L0 只读恒返回 null（无改动可言）。
 * 收集失败（非 git / git 不可用）返回 null → 上层按 VC-12 可见处理。
 * @param {string} cwd 活动隔离工作副本
 * @param {string} ceiling 动作等级上限
 * @returns {string[]|null}
 */
// 生成目录/文件，不属于"活动的实际改动"：活动在隔离副本跑 pnpm install / build
// 会生成 node_modules / dist，git status 会把它们显示为未跟踪目录——必须过滤，
// 否则改动集被污染（合并时会尝试复制整个 node_modules，EISDIR 且毫无意义）。
const GENERATED_DIRS = /(^|\/)(node_modules|dist|build|\.next|\.nx|coverage|\.turbo)(\/|$)/;

function collectChangedPaths(cwd, ceiling) {
  if (!ceiling || ceiling === 'L0') return null;
  try {
    // --untracked-files=all：把未跟踪**目录**展开成其中的文件——否则活动新建的
    // 目录（如 .github/workflows/）只显示为目录名，合并端 copyFileSync 复制不了目录
    // （L4-repro 试点即踩中：CI 目录合并失败 ENOENT）。
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', stdio: 'pipe' });
    return out.split('\n').filter((l) => l.trim())
      .map((l) => l.slice(3).trim())                     // "?? path" / " M path" → path
      .filter((p) => p && !GENERATED_DIRS.test(p))       // 排除生成目录
      .filter(Boolean);
  } catch {
    return null;                                         // 非 git 工作副本 → 无法判定
  }
}

/**
 * 把项目 seed 进隔离工作副本（D-RELEASE-1：先干后放的"干"）。
 *
 * **从项目工作区当前状态复制，但以 commit 时刻为 baseline**——两点权衡：
 * ① 必须包含**上游阶段已合并的改动**（如 Test 阶段写测试后放行合并到工作区，
 *    Impl 阶段才能看到要实现的测试）。若从 git HEAD seed，Test 的测试文件
 *    不在其中，Impl 看不到要实现什么（试点即踩中：Impl 声称实现但无改动）。
 * ② 不能把"活动自己的改动"误当 baseline——用 rsync 复制后立即 `git add -A`
 *    + commit，活动改动发生在 baseline 之后，diff 只含活动自己的。
 *    项目既有并发编辑残留会进 baseline（无害：它们是"seed 时的状态"，
 *    不是本活动的改动，collectChangedPaths 只报 baseline 之后的）。
 *
 * 排除生成目录/大目录（node_modules/dist/.next 等）。
 * seed 失败不阻塞：活动仍可在（空）隔离副本跑，diff 为空由上层 fail-closed 处理。
 * @param {string} target 隔离 cwd
 * @param {string|null} source 项目 local_path（engine 注入）
 */
function seedWorkspace(target, source) {
  if (!source || !target) return;
  try {
    mkdirSync(target, { recursive: true });
    // 分三步 seed，每步独立容错（单文件失败不中断整链）：
    // ① git archive 干净树 → tar 解包（基线 HEAD）
    // ② 叠加"工作区相对 HEAD 的已跟踪改动"（上游 Test 阶段放行合并的文件）
    // ③ 叠加未跟踪源文件（missingness.ts 等新增实现），排除生成目录/大文件
    const overlay = (cmd) => {
      try { execFileSync('sh', ['-c', cmd, 'sh', source, target], { stdio: 'pipe' }); }
      catch { /* 单文件复制失败容错：缺失的文件由活动按需处理，不中断 seed */ }
    };
    overlay(`git -C "$1" archive HEAD | tar -x -C "$2"`);
    // 已跟踪的改动（上游 Test 阶段放行合并）：while read 流式，避免 xargs -I 命令行膨胀超长
    overlay(`git -C "$1" diff HEAD --name-only | while IFS= read -r f; do [ -f "$1/$f" ] && mkdir -p "$2/$(dirname "$f")" && cp "$1/$f" "$2/$f" || true; done`);
    // 未跟踪源文件（missingness.ts 等新增实现），排除生成目录/大文件
    overlay(`git -C "$1" ls-files --others --exclude-standard | while IFS= read -r f; do ` +
      `case "$f" in node_modules/*|*/node_modules/*|dist/*|*/dist/*|.next/*|.nx/*|coverage/*|.agent-runs/*|.workflow-runs/*|*.pptx|*.pdf|screenshots/*|output/*|pitch/*|*.png) ;; *) ` +
      `  [ -f "$1/$f" ] && mkdir -p "$2/$(dirname "$f")" && cp "$1/$f" "$2/$f" || true ;; esac; done`);
    // 建立 baseline：git init + 初始 commit。隔离副本必须有 .git，
    // collectChangedPaths 的 `git status` 才能把"活动改动"与"seed 内容"区分开。
    execFileSync('git', ['-C', target, 'init', '-q']);
    execFileSync('git', ['-C', target, 'add', '-A']);
    execFileSync('git', ['-C', target, '-c', 'user.email=seed@ai-factory', '-c', 'user.name=seed', 'commit', '-q', '-m', 'seed baseline']);
  } catch {
    // seed 失败不阻塞（见函数头注释）。
  }
}

/** 返回前自检契约。绑定自己违约要在这里就炸，而不是让工厂层拿到畸形结果再去猜。 */
function finish(result, binding) {
  // binding 是接口的**可选**扩展字段：血缘要它，工作流不依赖它。
  // 可选字段不构成 RT-11 意义上的破坏性变更，故无需同一提交更新其他绑定。
  if (binding) result.binding = binding;
  assertActivityResult(result);
  return result;
}

/** @returns {Promise<import('../../factory/runtime/interface.mjs').Metering>} */
async function meter(runId) {
  return ledger.get(runId) ?? { ...EMPTY_METERING };   // 未知全 null，不是 0（AG-8）
}

/** `RT-12`：能力与缺口都 MUST 声明式暴露，工厂层据此在**派工前**判断活动能否执行（`FP-4` fail-closed）。 */
async function capabilities() {
  return {
    binding: 'claude-agent-sdk',
    implemented: ['run', 'meter', 'capabilities'],
    gaps: [
      { method: 'handoff', reason: 'typed state 的 schema 尚未定义（FR-17 要求只传引用）' },
      { method: 'resume', reason: 'checkpoint 存储面未定（§38）' },
      { method: 'checkpoint', reason: '同上' },
      { method: 'cancel', reason: '血缘写入面未定；cancel MUST 触发 Record 阶段（AG-2），无血缘则不可实现' },
    ],
    enforcement_gaps: [
      // §52.2：达到 C4 MUST 提供预算的运行时强制点。未达时该缺口 MUST 登记（FP-7）。
      { item: 'budget.tokens / budget.minutes', reason: '无运行时强制点，仅 iterations 经 maxTurns 生效' },
      // 目录级隔离 ≠ 沙箱。RT-10 要求 ≥L1 活动在隔离工作副本中执行，本绑定只做到
      // 每活动独立 cwd/CLAUDE_CONFIG_DIR；进程、文件系统、网络出口的真隔离属 L4（§48），未接入。
      { item: 'action_level_ceiling ≥ L1 的沙箱隔离', reason: '仅目录级隔离，无容器/网络出口隔离（§48 属基础设施层，未接入）' },
    ],
    provider_routing: 'per-query options.env（SDK 无 per-agent 供应商路由）',
  };
}

const notImplemented = (name, why) => async () => { throw gap(`${name}() 未实现：${why}`); };

export default {
  run,
  meter,
  capabilities,
  handoff: notImplemented('handoff', 'typed state schema 未定'),
  resume: notImplemented('resume', 'checkpoint 存储面未定'),
  cancel: notImplemented('cancel', '血缘写入面未定'),
  checkpoint: notImplemented('checkpoint', 'checkpoint 存储面未定'),
};
