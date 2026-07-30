// report.mjs — 结果收集与退出码
//
// VC-2：治理只诊断、不自动改。传入 --fix 即非零退出。
// §25.8：退出码 0 = 全绿；非 0 = 有失败。**警告不影响退出码。**
// §25.3：错误消息必须指出维度与位置 —— 否则智能体会开始随机试探，
//        最终可能通过修改元语来消除报错，恰好绕过对拍的意义。

export function rejectFixFlag(argv = process.argv) {
  if (argv.includes('--fix') || argv.includes('--write')) {
    console.error('✗ VC-2：治理只诊断、不自动改。校验器不提供 --fix。');
    console.error('  违规的价值在于它揭示了理解偏差；自动修会让执行者跳过"为什么违规"。');
    process.exit(2);
  }
}

export function createReporter(name) {
  const passes = [], fails = [], warns = [];
  return {
    pass: (m) => passes.push(m),
    /** dim: 检查维度标识；msg 须含位置 */
    fail: (dim, msg) => fails.push({ dim, msg }),
    warn: (dim, msg) => warns.push({ dim, msg }),
    get failed() { return fails.length; },
    render({ quiet = false } = {}) {
      if (!quiet) {
        for (const m of passes) console.log(`  ✓ ${m}`);
        for (const w of warns) console.log(`  ⚠ ${w.dim} ${w.msg}`);
      }
      for (const f of fails) console.error(`  ✗ ${f.dim} ${f.msg}`);
      return { name, pass: passes.length, fail: fails.length, warn: warns.length };
    },
  };
}

/** 格式契约先验（VC-3）：解析目标为空即失败，不得判为"无违规" */
export function assertParsed(reporter, dim, label, n) {
  if (n === 0) {
    reporter.fail(dim, `格式契约：${label} 解析为 0 行 —— 解析空转 = 红（MS-8）`);
    return false;
  }
  return true;
}

export function summarize(results) {
  const fail = results.reduce((a, r) => a + r.fail, 0);
  const warn = results.reduce((a, r) => a + r.warn, 0);
  console.log('━'.repeat(62));
  if (fail) {
    console.error(`✗ governance: ${fail} 项失败` + (warn ? `，${warn} 项警告` : ''));
    return 1;
  }
  console.log(`✓ governance: 全部通过` + (warn ? `（${warn} 项警告，不影响退出码）` : ''));
  return 0;
}
