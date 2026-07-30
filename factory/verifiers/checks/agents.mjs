// checks/agents.mjs — AGENTS.md 入口指针检查（FR-8）
//
// AGENTS.md **不是元语**，是目录与阅读规则。它若含一手事实就必然复制其他六本内容，
// 违反 FP-1。因此本检查中有一条是"检查某物**不存在**" —— 容易被遗漏，
// 但它守护的是 FR-8 这条结构性约束。

import { readText } from '../lib/scan.mjs';
import { parseTables, relativeLinks } from '../lib/md.mjs';
import { setEqual, describe } from '../lib/compare.mjs';
import { createReporter } from '../lib/report.mjs';
import { statSync } from 'node:fs';
import { join } from 'node:path';

// 数字化规模断言：注定漂移（MA-1）
const NUMERIC_CLAIM = /(\d+)\s*(个|张|条|本|处)\s*(模块|表|枚举|页面|文件|服务|接口|路由)|(\d+)\s*行(骨架|代码|的)/g;

export default function checkAgents(a) {
  const r = createReporter('agents');
  const rel = a.metaFiles.AGENTS;
  const t = readText(a.root, rel);
  if (t == null) { r.fail('AG-0', 'AGENTS.md 不存在'); return r; }

  // ── A：全部元语被指向，且指向的都存在（双向）──────────────
  const declared = Object.entries(a.metaFiles)
    .filter(([n, p]) => p && n !== 'AGENTS').map(([n]) => n);
  const linked = new Set();
  for (const link of relativeLinks(t)) {
    const base = link.split('/').pop().replace(/\.md$/, '');
    if (declared.includes(base)) linked.add(base);
    try { statSync(join(a.root, link)); }
    catch { r.fail('AG-1', `${rel}: 链接目标不存在 → \`${link}\``); }
  }
  const res = setEqual([...linked], declared);
  if (!res.ok) r.fail('AG-2', describe(`${rel} 的元语指针与实际元语集合不符`, res));

  // ── B：不得写数字化规模断言（MA-1）────────────────────────
  const claims = [...t.matchAll(NUMERIC_CLAIM)].map((m) => m[0].trim());
  if (claims.length)
    r.fail('AG-3', `${rel}: 含 ${claims.length} 处数字化规模断言 —— **写数字的文档注定漂移**（MA-1），改为"以 \`ls\` 为准"或写结构描述：${claims.slice(0, 5).join(' / ')}`);

  // ── C：不得含契约段（FR-8）—— 检查"某物不存在" ────────────
  // 判据：本文件不应出现被其他校验器解析的那类表（首列反引号 ID + 多行）
  for (const tb of parseTables(t)) {
    const idRows = tb.rows.filter((row) => /^`[A-Za-z]+-[A-Za-z0-9]+`/.test(row[0] ?? ''));
    if (idRows.length >= 2)
      r.fail('AG-4', `${rel}: 「${tb.heading}」疑似契约段（${idRows.length} 行 ID 登记）—— AGENTS.md 是入口指针，不得含一手事实（FR-8）`);
  }

  // ── D：命令清单须真实可跑 ────────────────────────────────
  const pkg = readText(a.root, 'package.json');
  if (pkg) {
    let scripts = {};
    try { scripts = JSON.parse(pkg).scripts ?? {}; } catch { /* 忽略解析失败 */ }
    const cmds = [...t.matchAll(/^\s*(?:pnpm|npm|yarn)\s+(?:run\s+)?([a-z][\w:-]*)/gm)].map((m) => m[1]);
    const unknown = [...new Set(cmds)].filter((c) =>
      !scripts[c] && !['install', 'test', 'build', 'start', 'dev', 'lint', 'format'].includes(c));
    if (unknown.length)
      r.warn('AG-5', `${rel}: ${unknown.length} 条命令在 package.json 中找不到：${unknown.slice(0, 6).join(', ')}`);
  }

  // ── E：篇幅（MS-40）────────────────────────────────────
  const lines = t.split('\n').length;
  if (lines > 120)
    r.warn('AG-6', `${rel}: ${lines} 行（建议 <100，MS-40）—— 超长通常意味着一手事实混了进来，应下沉到元语而非压缩措辞`);

  if (!r.failed) r.pass(`AGENTS 入口指针：${declared.length} 本元语指针可解析 · 无数字断言 · 无契约段`);
  return r;
}
