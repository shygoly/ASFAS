// checks/domain.mjs — DOMAIN.md ↔ schema 双向对拍
//
// 两个集合：① 数据对象名（集合相等）② 枚举名 + **有序**取值（MS-20 顺序敏感）。
// 双向：缺项与死项都红（VC-4）。单向子集检查发现不了死条目，
// 而智能体读到不存在的对象名会基于它写代码。

import { readText } from '../lib/scan.mjs';
import { parseTables, backticked, valueList } from '../lib/md.mjs';
import { setEqual, orderedEqual, describe } from '../lib/compare.mjs';
import { createReporter, assertParsed } from '../lib/report.mjs';

export default function checkDomain(a) {
  const r = createReporter('domain');
  const rel = a.metaFiles.DOMAIN;
  const t = readText(a.root, rel);
  if (t == null) { r.fail('DM-0', 'DOMAIN.md 不存在'); return r; }

  const tables = parseTables(t);

  // 表分类按**小节标题**，不靠猜行内容 ——
  // 首次在真实项目上运行时，靠"行内是否含 [列表]"猜分类，把整张枚举表
  // 误判成对象表，产生 28 项假死条目 + 23 项假缺失。分类依据必须显式。
  const isEnumTable = (tb) => /枚举|enum/i.test(tb.heading);
  const isSlackTable = (tb) => /松弛|保留未用|已知|格式契约/.test(tb.heading);

  // ── 枚举全集表：首列反引号枚举名 + 某列为有序取值列表 ────────
  const docEnums = {};
  for (const tb of tables.filter(isEnumTable)) {
    for (const row of tb.rows) {
      const name = backticked(row[0]);
      if (!name) continue;
      const vals = row.slice(1).map(valueList).find(Boolean);
      if (vals) docEnums[name] = vals;
    }
  }

  // ── 对象表：聚合小节中首列反引号的行 ──────────────────────
  const docObjects = new Set();
  const invNoted = new Map();
  for (const tb of tables) {
    if (isEnumTable(tb) || isSlackTable(tb)) continue;
    for (const row of tb.rows) {
      const name = backticked(row[0]);
      if (!name || docEnums[name]) continue;
      if (!/^[a-z][a-z0-9_]*$/.test(name)) continue;      // 对象名形态；排除 ID、路径等
      docObjects.add(name);
      invNoted.set(name, row[row.length - 1] ?? '');
    }
  }

  if (!assertParsed(r, 'DM-1', 'DOMAIN 对象表', docObjects.size)) return r;
  if (!assertParsed(r, 'DM-2', 'DOMAIN 枚举表', Object.keys(docEnums).length)) return r;

  // ── 校验器 A：对象名集合相等 ──────────────────────────────
  const codeObjects = a.schemaObjects?.();
  if (codeObjects == null) {
    r.warn('DM-3', 'adapter.schemaObjects() 返回 null —— 对象名对拍已跳过（跳过必须可见）');
  } else {
    const res = setEqual([...docObjects], codeObjects);
    if (!res.ok) r.fail('DM-3', describe(`${rel} 对象名与 schema 不符`, res));
    else r.pass(`DOMAIN 对象名集合相等（${docObjects.size} 个，双向）`);
  }

  // ── 校验器 B：枚举名集合相等 + 逐枚举有序相等 ──────────────
  const codeEnums = a.schemaEnums?.();
  if (codeEnums == null) {
    r.warn('DM-4', 'adapter.schemaEnums() 返回 null —— 枚举对拍已跳过');
  } else {
    const nameRes = setEqual(Object.keys(docEnums), Object.keys(codeEnums));
    if (!nameRes.ok) r.fail('DM-4', describe(`${rel} 枚举名与 schema 不符`, nameRes));
    let orderBad = 0;
    for (const name of Object.keys(docEnums)) {
      if (!codeEnums[name]) continue;
      const ord = orderedEqual(docEnums[name], codeEnums[name]);
      if (!ord.ok) { orderBad++; r.fail('DM-5', describe(`${rel} 枚举 \`${name}\` 取值不符`, ord)); }
    }
    if (nameRes.ok && !orderBad) r.pass(`DOMAIN 枚举与 schema 有序相等（${Object.keys(docEnums).length} 个，顺序敏感）`);
  }

  // ── 每张对象行须标注 INV 落点（MS-21）：空白与 "—" 须可区分 ──
  const blank = [...invNoted.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k);
  if (blank.length)
    r.fail('DM-6', `${rel}: ${blank.length} 张对象未标注不变量落点（须显式写 \`—\`，空白与 \`—\` 须可区分，MS-21）：${blank.slice(0, 8).join(', ')}`);

  return r;
}
