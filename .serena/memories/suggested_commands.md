# suggested_commands

## 闸门（每次改完代码必跑 —— 见 `mem:task_completion`）

```bash
npm test                 # = verify + verify:negative，CI/默认测试命令
npm run verify           # node spec/check-asfas-doc.mjs     —— spec HTML 自校验 9 维度
npm run verify:negative  # node spec/negative-verify.mjs     —— 逐维度负向验证
```

零依赖，无需 `npm install`。退出码：0 全绿；非 0 有失败；**警告不影响退出码**。

## 校验器套件（针对被治理项目，不在本仓 CI 里跑）

```bash
node factory/verifiers/run-all.mjs <项目>/governance.adapter.mjs
# 可选第二参数：只跑某一项（按标签包含匹配，便于负向验证定位）
node factory/verifiers/run-all.mjs ./governance.adapter.mjs DOMAIN
```

## 系统工具（Darwin / zsh 备注）

本机 zsh，常规 `git`/`grep`/`ls` 行为与标准 unix 一致，无需特殊形式。
查看 spec HTML 用浏览器：`open spec/ASFAS.html`。
