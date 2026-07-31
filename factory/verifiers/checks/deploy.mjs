// checks/deploy.mjs — DEPLOY.md ↔ env 样例 ↔ 代码 三方对拍（MS-32）
//
// 两方对拍发现不了"两方都漏了同一个键"。三边闭合使"漏一处"无处藏身。
//
// **扫描面和检查逻辑一样重要**（MS-33）。参考实现中一个环境变量因扫描面
// 漏了前端目录而长期未被登记 —— 检查器一直在跑、一直是绿的。
// 故本检查附**反向枚举**：全仓扫一遍，面外命中列为警告。

import { readText, scanSurface, reverseEnumerate } from '../lib/scan.mjs';
import { parseTables, backticked } from '../lib/md.mjs';
import { tripleEqual, describe } from '../lib/compare.mjs';
import { createReporter, assertParsed } from '../lib/report.mjs';

const ENV_RE = /process\.env\.([A-Z0-9_]+)|import\.meta\.env\.([A-Z0-9_]+)/g;

export default function checkDeploy(a) {
  const r = createReporter('deploy');
  const rel = a.metaFiles.DEPLOY;
  const t = readText(a.root, rel);
  if (t == null) { r.fail('DP-0', 'DEPLOY.md 不存在'); return r; }

  const tables = parseTables(t);

  // ── 忽略名单（不参与对拍）──────────────────────────────
  const ignore = new Set();
  for (const tb of tables) {
    if (!/忽略/.test(tb.heading)) continue;
    for (const row of tb.rows) { const k = backticked(row[0]); if (k) ignore.add(k); }
  }

  // ── 文档登记的 env 键（排除端口表与忽略表）──────────────
  const docKeys = new Set();
  let secretCol = false;
  for (const tb of tables) {
    if (/忽略/.test(tb.heading) || /端口/.test(tb.heading)) continue;
    const hasSecret = tb.headers.some((h) => /secret/i.test(h));
    for (const row of tb.rows) {
      const k = backticked(row[0]);
      if (k && /^[A-Z][A-Z0-9_]*$/.test(k)) { docKeys.add(k); if (hasSecret) secretCol = true; }
    }
  }
  if (!assertParsed(r, 'DP-1', 'DEPLOY env 表', docKeys.size)) return r;
  if (!secretCol)
    r.fail('DP-2', `${rel}: env 表缺 \`secret\` 列 —— 须使"哪些键是密钥"成为可查事实而非默认知识（MS-34）`);

  // ── 样例文件的键 ────────────────────────────────────────
  const sample = readText(a.root, a.envSampleFile);
  if (sample == null) { r.fail('DP-3', `env 样例文件不存在：${a.envSampleFile}`); return r; }
  const sampleKeys = new Set([...sample.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));

  // 真值不得入库（MS-34）。
  // **只检 DEPLOY.md 标了 secret 的键** —— 本地开发占位（PORT=8000、
  // postgres://app:app@localhost/…）不是风险，无差别告警会淹没真正的密钥泄漏。
  const secretKeys = new Set();
  for (const tb of tables) {
    const si = tb.headers.findIndex((h) => /secret/i.test(h));
    if (si < 0) continue;
    for (const row of tb.rows) {
      const k = backticked(row[0]);
      if (k && /是|yes|✓|true/i.test(row[si] ?? '')) secretKeys.add(k);
    }
  }
  const isPlaceholderValue = (raw) => {
    const v = raw.trim();
    if (!v) return true;                                   // 空值（含仅尾随空格）
    if (/^(\{\}|\[\]|""|''|-|—)$/.test(v)) return true;    // 空结构占位
    if (/^(<|\{\{|#|CHANGE|PLACEHOLDER|xxx+|your|TODO|example|replace|_+)/i.test(v)) return true;
    if (/(localhost|127\.0\.0\.1|::1)/.test(v)) return true; // 本地连接串不可能是生产凭据
    return false;
  };
  const leaked = [...sample.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/gm)]
    .filter(([, k, v]) => secretKeys.has(k) && !isPlaceholderValue(v))
    .map((m) => m[1]);
  if (leaked.length)
    r.fail('DP-4', `${a.envSampleFile}: ${leaked.length} 个**标记为 secret** 的键疑似含真值（MS-34：样例只放键位与占位）：${leaked.join(', ')}`);

  // ── 代码读取的键 ────────────────────────────────────────
  // 两个捕获组（process.env.X / import.meta.env.X），必须取"命中的那个"；
  // 取 m[1] ?? m[0] 会把整段匹配文本当成键名（首次真实运行时即产生 `import.meta.env.DEV` 这类假键）。
  const codeKeys = new Set(
    scanSurface(a.root, a.envScanSurface, ENV_RE, { exts: a.envScanExts })
      .map((h) => (h.groups?.[0] ?? h.groups?.[1] ?? h.value))
      .filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k ?? '')));

  // ── 三方相等 ────────────────────────────────────────────
  const strip = (s) => [...s].filter((k) => !ignore.has(k));
  const res = tripleEqual({
    'DEPLOY.md': strip(docKeys),
    [a.envSampleFile]: strip(sampleKeys),
    '代码': strip(codeKeys),
  });
  if (!res.ok) {
    // 框架内置变量（Vite 的 DEV/PROD/MODE…）不是项目配置，但被代码读取 ——
    // 按 MS-32 它们**必须进忽略名单**，故仍报红，只是把修法直接写进消息。
    const BUILTIN = new Set(['DEV', 'PROD', 'MODE', 'SSR', 'BASE_URL', 'NODE_ENV', 'CI']);
    const builtins = res.problems.filter((p) => BUILTIN.has(p.key)).map((p) => p.key);
    let msg = describe('env 键位三方不相等', res);
    if (builtins.length)
      msg += `\n      提示：${builtins.join(', ')} 疑似框架内置变量 —— 按 MS-32 应加入 DEPLOY.md 的忽略名单，而非加入 env 表`;
    r.fail('DP-5', msg);
  } else r.pass(`DEPLOY 三方相等：${strip(docKeys).length} 个键（忽略 ${ignore.size} 个）`);

  // ── 反向枚举：扫描面外的读取点（VC-6 / §25.4）────────────
  const strays = reverseEnumerate(a.root, a.envScanSurface, ENV_RE, { exts: a.envScanExts });
  if (strays.length)
    r.warn('DP-6', `扫描面外发现 ${strays.length} 处 env 读取 —— 扫描面可能不完整（§22.2 的盲区来源）：` +
      strays.slice(0, 5).map((s) => `${s.file}(${s.sample})`).join(', '));

  return r;
}
