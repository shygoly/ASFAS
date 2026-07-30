#!/usr/bin/env node
// negative-harness.mjs — 负向验证脚手架（VC-7 / VC-8）
//
// 未经负向验证的校验器**不计入一致性证据**（FR-3）。
// VC-8：负向验证须覆盖**每一条检查维度**，而非每个校验器一次。
//
// 协议（§25.3）：
//   1. 前置：基线必须绿 —— 否则负向验证无意义，且一个恒红的校验器会"通过"每条用例
//   2. 在**工作区**注入违规（VC-5：闸门须检查即将提交的内容）
//   3. 须红，且错误消息须指出维度与位置
//   4. 回滚 → 须绿
//
// 用法：
//   import { runNegativeSuite } from '.../negative-harness.mjs'
//   runNegativeSuite({ verifyCmd, cases: [{ dim, file, mutate }] })

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function run(cmd) {
  try { execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8' }); return { red: false, out: '' }; }
  catch (e) { return { red: true, out: (e.stdout ?? '') + (e.stderr ?? '') }; }
}

/**
 * @param {object} o
 * @param {string[]} o.verifyCmd  形如 ['node','factory/verifiers/run-all.mjs','./adapter.mjs']
 * @param {{dim:string,file:string,mutate:(s:string)=>string}[]} o.cases
 */
export function runNegativeSuite({ verifyCmd, cases }) {
  console.log('负向验证 —— 每条维度：注入 → 须红且消息命中 → 回滚 → 须绿\n');

  const base = run(verifyCmd);
  if (base.red) {
    console.error('✗ 基线不绿，负向验证无法进行。');
    console.error('  闸门挂进一个长期红的命令等于没挂（FINV-8）——');
    console.error('  先修掉或隔离既有失败，再做负向验证。');
    process.exit(1);
  }

  let failed = 0;
  for (const { dim, file, mutate } of cases) {
    const original = readFileSync(file, 'utf8');
    const mutated = mutate(original);
    if (mutated === original) {
      console.error(`✗ ${dim}：注入未生效（锚点已变，用例需更新）`);
      console.error('  用例失效必须**显式报错**，不得静默跳过 —— 静默跳过是假绿。');
      failed++; continue;
    }
    writeFileSync(file, mutated);
    const r = run(verifyCmd);
    writeFileSync(file, original);
    const back = run(verifyCmd);

    const tag = dim.split(/\s/)[0];
    if (!r.red) { console.error(`✗ ${dim}：注入违规后仍为绿 —— 假绿`); failed++; }
    else if (!r.out.includes(tag)) { console.error(`✗ ${dim}：报红但消息未指出维度 ${tag}（§25.3 要求消息定位问题）`); failed++; }
    else if (back.red) { console.error(`✗ ${dim}：回滚后仍红 —— 校验器有状态，或注入未完全回滚`); failed++; }
    else console.log(`  ✓ ${dim}：注入 → 红（消息命中）· 回滚 → 绿`);
  }

  console.log('━'.repeat(62));
  if (failed) { console.error(`✗ 负向验证：${failed}/${cases.length} 项未通过`); process.exit(1); }
  console.log(`✓ 负向验证：${cases.length}/${cases.length} 条用例全部通过（VC-8）`);
}
