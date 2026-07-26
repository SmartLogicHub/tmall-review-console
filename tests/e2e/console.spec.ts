import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";

test("运营人员主流程、配置入口与凭据安全", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "评论处理工作台" })).toBeVisible();
  await expect(page.getByText("评论助手")).toBeVisible();
  await expect(page.getByText("自动回复控制台")).toBeVisible();
  await expect(page.getByText("漫步者", { exact: true })).toHaveCount(0);
  await expect(page.getByText("漫步者官方旗舰店", { exact: true })).toHaveCount(0);
  await expect(page.getByText("天猫评论助手", { exact: true })).toHaveCount(0);
  await expect(page.getByText("启用前还需完成必要配置")).toBeVisible();
  await expect(page.getByRole("button", { name: "立即处理一轮" })).toBeDisabled();
  await expect(page.getByText("试运行模式")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "元素健康" })).toHaveCount(0);
  await expect(page.getByText(/LOCAL WORKSPACE|AUTOMATION|骨架|适配器/)).toHaveCount(0);
  const scrollingBefore = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const content = document.querySelector<HTMLElement>(".page-scroll");
    if (!sidebar || !content) throw new Error("页面外壳不存在");
    return {
      sidebarTop: sidebar.getBoundingClientRect().top,
      contentOverflowY: getComputedStyle(content).overflowY,
      contentHasIndependentScroll: content.scrollHeight > content.clientHeight && ["auto", "scroll"].includes(getComputedStyle(content).overflowY),
    };
  });
  expect(scrollingBefore.contentOverflowY).toBe("visible");
  expect(scrollingBefore.contentHasIndependentScroll).toBe(false);
  const desktopHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(desktopHorizontalOverflow).toBeLessThanOrEqual(1);
  await page.evaluate(() => window.scrollTo(0, Math.min(500, document.documentElement.scrollHeight - innerHeight)));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const sidebarTopAfter = await page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().top);
  expect(sidebarTopAfter).toBeLessThan(scrollingBefore.sidebarTop);
  await page.screenshot({ path: "output/playwright/e2e-workbench-1366x768.png", fullPage: true });

  await page.getByRole("link", { name: "话术库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "好评话术库" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "差评话术库" })).toBeVisible();
  await expect(page.getByText("每条新评价都会在命中分类中随机抽取一条话术；已处理的同一评价不会重复提交。")).toBeVisible();
  const goodUrl = page.getByLabel("好评库飞书链接");
  const badUrl = page.getByLabel("差评库飞书链接");
  await expect(goodUrl).toBeInViewport();
  await goodUrl.fill("https://example.feishu.cn/base/apptoken?table=tablegood");
  await page.getByRole("button", { name: "保存链接" }).first().click();
  await expect(page.getByText("链接已保存。").first()).toBeVisible();
  await badUrl.fill("https://example.feishu.cn/base/apptoken?table=tablebad");
  await page.getByRole("button", { name: "保存链接" }).nth(1).click();
  await expect(page.getByText("链接已保存。").nth(1)).toBeVisible();
  await expect(page.getByRole("button", { name: "同步话术" }).last()).toBeVisible();
  await page.screenshot({ path: "output/playwright/e2e-templates-1366x768.png", fullPage: true });

  await page.getByRole("link", { name: "设置" }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("heading", { name: "淘宝商家登录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "DeepSeek" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "飞书应用" })).toBeVisible();

  await page.getByLabel("淘宝商家账号").fill("e2e-merchant-account");
  const password = page.getByLabel("淘宝商家密码");
  await password.fill("e2e-password");
  await page.getByRole("button", { name: "保存并验证登录" }).click();
  await expect(password).toHaveValue("");
  await expect(page.getByText("登录已验证，可以开始处理评论。")).toBeVisible();

  const deepseekKey = page.getByLabel("DeepSeek API Key");
  await deepseekKey.fill("e2e-deepseek-key");
  await page.getByRole("button", { name: "保存 DeepSeek" }).click();
  await expect(deepseekKey).toHaveValue("");

  await page.getByLabel("飞书 App ID").fill("cli_e2e_test");
  const feishuSecret = page.getByLabel("飞书 App Secret");
  await feishuSecret.fill("e2e-feishu-secret");
  await page.getByRole("button", { name: "保存飞书凭据" }).click();
  await expect(feishuSecret).toHaveValue("");
  await expect.poll(() => page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByText("高级设置与诊断").click();
  await expect(page.getByRole("heading", { name: "存储与自动清理" })).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复出厂设置" })).toBeVisible();
  await page.screenshot({ path: "output/playwright/e2e-settings-1366x768.png", fullPage: true });
});

test("窄屏仍能看到主导航和关键入口", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto("/");
  for (const label of ["工作台", "回复结果", "话术库", "自动跳过商品", "设置"]) await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "立即处理一轮" })).toBeVisible();
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(horizontalOverflow).toBeLessThanOrEqual(1);
  const scopeTrigger = page.getByRole("button", { name: "修改本轮处理范围" });
  await scopeTrigger.click();
  await expect(page.getByRole("dialog", { name: "选择处理日期" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "保存处理范围" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(scopeTrigger).toBeFocused();
  await page.getByRole("button", { name: "编辑自动计划" }).click();
  await expect(page.getByRole("dialog", { name: "设置自动运行时间" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存自动计划" })).toBeInViewport();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "output/playwright/e2e-workbench-768x900.png", fullPage: true });
});

test("日期、自动计划与跳过商品名单形成可保存的完整闭环", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "修改本轮处理范围" }).click();
  await page.getByRole("button", { name: "自定义日期" }).click();
  await page.getByRole("button", { name: "2026-07-10" }).click();
  await page.getByRole("button", { name: "2026-07-15" }).click();
  await page.getByRole("button", { name: "保存处理范围" }).click();
  await expect(page.getByRole("dialog", { name: "选择处理日期" })).toHaveCount(0);
  await page.getByRole("button", { name: "修改本轮处理范围" }).click();
  await expect(page.getByText("2026-07-10 至 2026-07-15", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "编辑自动计划" }).click();
  await page.getByRole("button", { name: "添加时间段" }).click();
  await page.getByRole("button", { name: "添加时间段" }).click();
  await page.getByLabel("时间段1开始时间").fill("08:00");
  await page.getByLabel("时间段1结束时间").fill("09:00");
  await page.getByLabel("时间段2开始时间").fill("10:00");
  await page.getByLabel("时间段2结束时间").fill("11:00");
  await page.getByLabel("运行间隔（分钟）").fill("20");
  await page.getByRole("button", { name: "保存自动计划" }).click();
  await expect(page.getByRole("dialog", { name: "设置自动运行时间" })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑自动计划" }).click();
  await expect(page.getByRole("switch", { name: "启用自动回复计划" })).not.toBeChecked();
  await expect(page.getByLabel("时间段1开始时间")).toHaveValue("08:00");
  await expect(page.getByLabel("时间段2开始时间")).toHaveValue("10:00");
  await expect(page.getByLabel("运行间隔（分钟）")).toHaveValue("20");
  await page.keyboard.press("Escape");

  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("跳过商品").addRows([
    ["商品标题", "商品 ID"],
    ["E2E 商品一", "900000000000001"],
    ["E2E 商品二", "900000000000002"],
    ["E2E 商品三", "900000000000003"],
    ["E2E 商品四", "900000000000004"],
  ]);
  const workbookBytes = Buffer.from(await workbook.xlsx.writeBuffer());

  await page.getByRole("link", { name: "自动跳过商品", exact: true }).click();
  await page.getByRole("button", { name: "导入 Excel 名单" }).click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByLabel("浏览器上传（备用）").click(),
  ]);
  await fileChooser.setFiles({
    name: "e2e-manual-products.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbookBytes,
  });
  await expect(page.getByLabel("Excel 名单变化预览")).toContainText("新增 4");
  await page.getByRole("button", { name: "确认更新 Excel 名单" }).click();
  await expect(page.getByText("Excel 来源名单已更新")).toBeVisible();

  const search = page.getByRole("searchbox", { name: "搜索商品标题或商品 ID" });
  await search.fill("900000000000003");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText("E2E 商品三")).toBeVisible();
  await search.fill("");
  await page.getByRole("button", { name: "搜索", exact: true }).click();

  await page.getByRole("button", { name: "手工添加商品" }).click();
  await page.getByLabel("商品 ID（必填）").fill("900000000000099");
  await page.getByLabel("商品标题（选填，仅用于辨认）").fill("E2E 临时手工商品");
  await page.getByRole("button", { name: "添加到名单" }).click();
  await expect(page.getByText("商品已添加到自动跳过名单")).toBeVisible();
  await page.getByRole("button", { name: "移出 E2E 临时手工商品" }).click();
  await page.getByRole("button", { name: "确认移出" }).click();
  await expect(page.getByText("商品已移出自动跳过名单")).toBeVisible();

  await page.getByRole("link", { name: "工作台", exact: true }).click();
  await expect(page.getByRole("link", { name: "自动跳过商品 · 4" })).toBeVisible();
  await expect(page.getByText("漫步者", { exact: true })).toHaveCount(0);
  await expect(page.getByText("漫步者官方旗舰店", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

for (const width of [360, 375]) {
  test(`自动跳过商品在 ${width}px 窄屏保持可用`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    const manualLink = page.getByRole("link", { name: "自动跳过商品", exact: true });
    await manualLink.scrollIntoViewIfNeeded();
    await manualLink.click();
    await expect(page.getByRole("heading", { name: "自动跳过商品" })).toBeVisible();
    await expect(page.getByRole("button", { name: "导入 Excel 名单" })).toBeVisible();
    await expect(page.getByRole("button", { name: "手工添加商品" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "搜索商品标题或商品 ID" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test(`工作台与弹窗适配 ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "修改本轮处理范围" })).toBeVisible();
    await expect(page.getByRole("button", { name: "编辑自动计划" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

    await page.getByRole("button", { name: "修改本轮处理范围" }).click();
    await expect(page.getByRole("dialog", { name: "选择处理日期" })).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "保存处理范围" })).toBeInViewport();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "编辑自动计划" }).click();
    await expect(page.getByRole("dialog", { name: "设置自动运行时间" })).toBeVisible();
    await expect(page.getByLabel("运行间隔（分钟）")).toBeVisible();
    await expect(page.getByRole("button", { name: "保存自动计划" })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `output/playwright/e2e-workbench-${viewport.width}x${viewport.height}.png`, fullPage: true });
  });
}

test("回复结果可追溯且没有公开的逐条提交入口", async ({ page }) => {
  await page.goto("/replies");
  await page.getByRole("button", { name: /查看评论详情：音质还可以/u }).click();

  await expect(page.getByRole("heading", { name: "回复详情" })).toBeVisible();
  await expect(page.getByText("买家明确反馈夹耳朵")).toBeVisible();
  await expect(page.getByText("非常抱歉给您带来不适的佩戴体验。")).toBeVisible();
  await expect(page.getByText(/建议调整 X1 EVO 的佩戴角度/u)).toBeVisible();
  await expect(page.getByText("回复已生成，等待自动提交")).toBeVisible();
  await expect(page.getByRole("button", { name: /发送|提交|批量回复/u })).toHaveCount(0);
  await page.screenshot({ path: "output/playwright/e2e-reply-detail-1366x768.png", fullPage: true });
});
