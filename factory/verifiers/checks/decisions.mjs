// checks/decisions.mjs — DECISIONS.md ↔ 代码 ID 双向对拍
//
// A：代码 + 元语中出现的 ID 必须在册 —— **硬失败**
// B：在册但全仓零引用 —— **WARN，不红**（MS-31）
//    纯业务决策可能不体现为任何代码标记；设为硬失败会迫使团队给业务决策
//    强加代码标记，或把它们移出登记册，两者都更糟。
//    它的作用是提供清单供人判断，不是自动裁决。

import { readText, walk } from '../lib/scan.mjs';
import { parseTables, backticked, extractIds, isIdPlaceholder } from '../lib/md.mjs';
import { subsetOf } from '../lib/compare.mjs';
import { createReporter, assertParsed } from '../lib/report.mjs';

export default function checkDecisions(a) {
  const r = createReporter('decisions');
  const rel = a.metaFiles.DECISIONS;
  const t = readText(a.root, rel);
  if (t == null) { r.fail('DC-0', 'DECISIONS.md 不存在'); return r; }

  // ── 在册集合：各登记表首列的反引号 ID ─────────────────────
  const registered = new Set();
  for (const tb of parseTables(t))
    for (const row of tb.rows) {
      for (const id of (row[0].match(/`([^`]+)`/g) ?? []).map((s) => s.slice(1, -1)))
        // 命名空间表里的 `ADR-n` / `D-xxx` 是**在讲写法**，不是在册条目
        if (/^[A-Za-z]+-[A-Za-z0-9]+$/.test(id) && !isIdPlaceholder(id)) registered.add(id);
    }
  if (!assertParsed(r, 'DC-1', 'DECISIONS 登记表', registered.size)) return r;

  // ── 命名空间表须存在且置顶（MS-28）────────────────────────
  const firstTable = parseTables(t)[0];
  if (!firstTable || !/命名空间|namespace/i.test(firstTable.heading))
    r.fail('DC-2', `${rel}: 首张表不是命名空间表 —— 智能体拿到 ID 需先查表才知去哪找（MS-28）`);

  // ── 待定项唯一位置（MS-29）：其他元语不得自建未决表 ────────
  for (const [name, mrel] of Object.entries(a.metaFiles)) {
    if (mrel == null || name === 'DECISIONS') continue;
    const mt = readText(a.root, mrel) ?? '';
    for (const tb of parseTables(mt))
      if (/待定|未决/.test(tb.heading) && tb.rows.length > 1)
        r.fail('DC-3', `${mrel}: 自建了未决清单（${tb.rows.length} 行）—— 未决项唯一位置 = DECISIONS.md（MS-29）；此处只可放指针`);
  }

  // ── 校验器 A：引用的 ID 必须在册（词边界；子编号按父编号查）──
  const files = walk(a.root, { dirs: a.idScanSurface, exts: a.idScanExts });
  const metaRels = Object.values(a.metaFiles).filter(Boolean);
  const used = new Map();                       // id → 首个出现位置
  for (const f of [...files, ...metaRels]) {
    const body = readText(a.root, f);
    if (body == null) continue;
    if (f === rel) continue;                    // 登记册自身不算引用
    for (const id of extractIds(body, a.idPrefixes)) if (!used.has(id)) used.set(id, f);
  }
  const parentOf = (id) => id.replace(/\.\d+$/, '');
  const offenders = [...used.keys()].filter((id) => !registered.has(id) && !registered.has(parentOf(id)));
  if (offenders.length)
    r.fail('DC-4', `未在册的 ID ${offenders.length} 个：` +
      offenders.slice(0, 8).map((id) => `\`${id}\`(${used.get(id)})`).join(', ') + (offenders.length > 8 ? ' …' : ''));

  // ── 校验器 B：在册但零引用 → WARN ────────────────────────
  const usedParents = new Set([...used.keys()].map(parentOf));
  const orphans = [...registered].filter((id) => !used.has(id) && !usedParents.has(id)).sort();
  if (orphans.length)
    r.warn('DC-5', `在册但全仓零引用 ${orphans.length} 个（纯业务决策可不落代码；但若已落地却未打标记，属可追溯性缺口）：${orphans.slice(0, 10).join(', ')}${orphans.length > 10 ? ' …' : ''}`);

  if (!r.failed) {
    const res = subsetOf([...used.keys()].map(parentOf), [...registered]);
    r.pass(`DECISIONS 双向对拍：在册 ${registered.size} 个 · 被引用 ${used.size} 个 · 越界 ${res.outside.length} 个`);
  }
  return r;
}
