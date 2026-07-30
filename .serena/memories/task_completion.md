# task_completion

每次改完本仓的 `.mjs` 代码或 `spec/ASFAS.html` 后，必须验证闸门全绿才算完成：

```bash
npm test   # = node spec/check-asfas-doc.mjs && node spec/negative-verify.mjs
```

要求：
- **退出码 0**（非 0 须修复，不得提交）。警告不影响退出码，可接受。
- 若改了校验器逻辑（`factory/verifiers/` 或 `spec/*.mjs`），**新增/变更的检查维度须配负向用例**（VC-8）：`negative-verify.mjs` / `negative-harness.mjs`。未经负向验证的检查不计入一致性证据（FR-3）。
- 零依赖、无需 `npm install`。
- 改了 `factory/verifiers/*` 不会触发 `npm test`（本仓 CI 只跑 spec 自校验）；但若改了 `lib/md.mjs` 解析层等共享逻辑，应同步确认 spec 校验器不受影响（两者解析逻辑独立）。

提示：提交前 `git status` 确认无意外的 `node_modules/`（已在 `.gitignore`）。
