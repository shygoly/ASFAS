# tech_stack

- **运行时**：Node.js `>=20`（`package.json` engines；实测 v20.20.1）。**无浏览器、无前端框架、无构建步骤**。
- **语言**：纯 JavaScript ES Modules，全部用 `.mjs` 扩展名（即便 `package.json` 已 `"type":"module"`）。无 TypeScript，无转译。
- **标准库限定**：校验器代码只用 `node:fs` / `node:path` / `node:url`。**项目适配器额外约束**：不得 `import` 工厂内部模块，只用标准库（`FR-14` 接口收窄）。
- **依赖**：`package.json` 是 `private:true`，**无任何 dependencies / devDependencies**。零安装即可运行（`npm test` 不需要先 `npm install`）。
- **包管理器**：npm（`package.json` + `.gitignore` 忽略 `node_modules/`）。
- **Serena 语言后端**：`typescript`（LSP 用 tsserver 处理 `.mjs`/`.js`）。
- **文档载体**：架构宪法 `spec/ASFAS.html` 是单一巨型 HTML（含内联 SVG 图、rid 标记的规范性陈述、CP 检查点）。元语文档是 Markdown 表格 + ` ```flow ` 围栏块。
