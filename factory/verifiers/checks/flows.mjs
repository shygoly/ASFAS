// checks/flows.mjs — FLOWS.md ↔ 状态写入点 双向对拍
//
// **impl 是状态级语义，不是转移级（MS-25）。**
// 参考实现的校验器初版把它当转移级，结果同一张表上 A→B(no) 与 C→B(yes)
// 互相矛盾却都判通过 —— 因为逐条检查时两者各自"成立"。
// 语义没想清楚的校验器会给出虚假的绿。

import { readText } from '../lib/scan.mjs';
import { fencedBlocks, parseFlowBlock } from '../lib/md.mjs';
import { setEqual, describe } from '../lib/compare.mjs';
import { createReporter, assertParsed } from '../lib/report.mjs';

export default function checkFlows(a) {
  const r = createReporter('flows');
  const rel = a.metaFiles.FLOWS;
  const t = readText(a.root, rel);
  if (t == null) { r.fail('FL-0', 'FLOWS.md 不存在'); return r; }

  const blocks = fencedBlocks(t, 'flow').map(parseFlowBlock)
    .filter((b) => b.machine && !/^<|\{\{/.test(b.machine));      // 排除格式说明块
  if (!assertParsed(r, 'FL-1', 'FLOWS flow 块', blocks.length)) return r;

  const codeEnums = a.schemaEnums?.() ?? null;
  let transitions = 0, implYes = 0, implNo = 0;

  for (const b of blocks) {
    const id = b.machine;

    // ── 校验器 A：五段齐全（MS-24）─────────────────────────
    for (const bad of b.bad)
      r.fail('FL-2', `${rel} \`${id}\`: 转移行五段不全或 impl 取值非法 → ${bad}`);
    if (!b.states) { r.fail('FL-2', `${rel} \`${id}\`: 缺 states`); continue; }
    if (!b.initial) r.fail('FL-2', `${rel} \`${id}\`: 缺 initial`);
    if (!assertParsed(r, 'FL-2', `\`${id}\` 的转移`, b.transitions.length)) continue;
    transitions += b.transitions.length;

    // ── 校验器 B：states == 枚举取值集合 ───────────────────
    if (codeEnums && b.enum && codeEnums[b.enum]) {
      const res = setEqual(b.states, codeEnums[b.enum]);
      if (!res.ok) r.fail('FL-3', describe(`${rel} \`${id}\` 的 states 与枚举 \`${b.enum}\` 不符`, res));
    } else if (codeEnums && b.enum && !codeEnums[b.enum]) {
      r.fail('FL-3', `${rel} \`${id}\`: 声明的枚举 \`${b.enum}\` 在 schema 中不存在`);
    }

    // ── 校验器 C：from/to ∈ states ────────────────────────
    const S = new Set(b.states);
    for (const tr of b.transitions) {
      if (tr.from !== '*' && !S.has(tr.from)) r.fail('FL-4', `${rel} \`${id}\`: from \`${tr.from}\` 不在 states 内 → ${tr.raw}`);
      if (!S.has(tr.to)) r.fail('FL-4', `${rel} \`${id}\`: to \`${tr.to}\` 不在 states 内 → ${tr.raw}`);
    }

    // ── 校验器 D：impl 双向，**状态级**（MS-25）───────────
    const byState = new Map();
    for (const tr of b.transitions) {
      if (!byState.has(tr.to)) byState.set(tr.to, new Set());
      byState.get(tr.to).add(tr.impl);
    }
    for (const [state, impls] of byState) {
      if (impls.size > 1) {
        r.fail('FL-5', `${rel} \`${id}\`: 目标态 \`${state}\` 被同时声明 impl:yes 与 impl:no —— 矛盾声明（MS-25 状态级语义）`);
        continue;
      }
      const declared = [...impls][0] === 'yes';
      declared ? implYes++ : implNo++;
      const actual = a.stateHasWriter?.(id, state);
      if (actual == null) { r.warn('FL-5', `\`${id}.${state}\`: adapter.stateHasWriter 无法判定 —— 跳过（跳过必须可见）`); continue; }
      if (declared && !actual)
        r.fail('FL-5', `${rel} \`${id}\`: 声明 \`${state}\` impl:yes，但代码中找不到写入点`);
      if (!declared && actual)
        r.fail('FL-5', `${rel} \`${id}\`: 声明 \`${state}\` impl:no，但代码中**存在**写入点 —— 文档落后于实现`);
    }

    // ── 校验器 E：via 可解析 ──────────────────────────────
    for (const tr of b.transitions) {
      if (tr.impl !== 'yes') continue;
      const ok = a.viaResolves?.(tr.via);
      if (ok === false) r.fail('FL-6', `${rel} \`${id}\`: via \`${tr.via}\` 无法在代码中定位 → ${tr.raw}`);
    }
  }

  // ── 校验器 F：impl:no 的状态须有处置（MS-26）──────────────
  const unimplemented = new Set();
  for (const b of blocks)
    for (const [state, impls] of groupByTo(b))
      if (impls.size === 1 && [...impls][0] === 'no') unimplemented.add(`${b.machine}.${state}`);
  const dispositionText = t.split(/##\s*.*未实现/)[1] ?? '';
  const dangling = [...unimplemented].filter((k) => !dispositionText.includes(k.split('.').pop()));
  if (dangling.length)
    r.fail('FL-7', `${rel}: ${dangling.length} 个 impl:no 状态在「未实现状态的处置」节无条目 —— 不留悬空（MS-26）：${dangling.slice(0, 8).join(', ')}`);

  if (!r.failed)
    r.pass(`FLOWS 双向对拍：${blocks.length} 台状态机 · ${transitions} 条转移（impl:yes ${implYes} / impl:no ${implNo}）`);
  return r;
}

function groupByTo(b) {
  const m = new Map();
  for (const tr of b.transitions) {
    if (!m.has(tr.to)) m.set(tr.to, new Set());
    m.get(tr.to).add(tr.impl);
  }
  return m;
}
