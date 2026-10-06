# 商品优先话术分类实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 本次按用户要求在当前会话内执行，不使用子智能体。

**Goal:** 让已识别商品族的评价优先在对应产品专属分类中选择话术，通用分类仅作为后备。

**Architecture:** 在现有 `refineFallbackCategory` 的确定性修正层增加产品族候选分层，复用现有商品识别、兼容性和语义评分，不改变飞书话术结构、回复提交和投诉流程。

**Tech Stack:** TypeScript、Vitest、SQLite、Vite、Windows .NET Launcher

---

### Task 1: 建立真实问题回归测试

**Files:**
- Modify: `apps/server/src/drafts/template-selection.test.ts`

- [ ] 添加 MF1 扩音器断连加延迟评价，模型返回通用“连接有延迟”，预期改为扩音器专属分类。
- [ ] 添加专属分类与评论问题不相关时仍保留通用分类的边界测试。
- [ ] 运行 `npx.cmd vitest run src/drafts/template-selection.test.ts`，确认新测试因当前逻辑失败。

### Task 2: 实现商品族候选分层

**Files:**
- Modify: `apps/server/src/drafts/template-selection.ts`

- [ ] 提取判断分类是否明确属于当前商品族的函数。
- [ ] 对当前库的有效分类统一评分。
- [ ] 当存在语义合格的产品专属分类时，只从专属候选中选最高分。
- [ ] 保持无法识别商品、无相关专属分类和同分场景的安全行为。
- [ ] 运行定向测试确认转绿。

### Task 3: 完整回归

**Files:**
- Test: `apps/server/src/drafts/template-selection.test.ts`
- Test: `apps/server/src/drafts/processor.test.ts`
- Test: `apps/server/src/app.test.ts`

- [ ] 运行根目录类型检查。
- [ ] 运行服务端完整测试（排除仅受当前沙箱 Windows 凭据会话限制的真实凭据测试）。
- [ ] 运行前端、领域和打包安全测试。
- [ ] 检查没有非预期文件改动。

### Task 4: 生成跨电脑发布包

**Files:**
- Package output: `release-final-20260731-v10-product-first-transfer`
- Archive output: `release-final-20260731-v10-product-first-transfer.zip`

- [ ] 构建 Windows 发布目录并包含本地数据库。
- [ ] 确认数据库完整、保留回复记录、不包含旧浏览器登录目录。
- [ ] 使用 UTF-8 ZIP 打包并核对中文启动程序、浏览器选择器、数据库和网页资源。
- [ ] 计算 SHA-256 并提供最终压缩包链接。
