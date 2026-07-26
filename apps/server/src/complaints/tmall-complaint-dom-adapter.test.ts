import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { executeComplaintBrowserFlow } from "./complaint-browser-flow";
import { createTmallComplaintDomAdapter } from "./tmall-complaint-dom-adapter";

const description = "该评价内容为“测试原文”。经核对，内容与订单无关，符合“评价内容无意义”场景。请平台审核。";
const pages: Array<Awaited<ReturnType<typeof chromium.launch>>> = [];

async function fixture(html: string) {
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  pages.push(browser);
  const page = await browser.newPage();
  await page.setContent(html);
  return page;
}

afterEach(async () => {
  await Promise.all(pages.splice(0).map((browser) => browser.close()));
});

function reviewRow(sourceKey: string, phase: "initial" | "followup") {
  const action = phase === "initial" ? "投诉评价" : "投诉追评";
  return `<section data-review-row data-review-source-key="${sourceKey}" data-review-phase="${phase}"><p>订单号：12345678</p><button type="button" onclick="document.querySelector('#complaint-dialog').hidden=false">${action}</button></section>`;
}

function complaintDialog(extra = "") {
  return `<section id="complaint-dialog" role="dialog" hidden>
    <label><input type="radio" name="complaint-type" value="meaningless" />评价内容无意义</label>
    <label><input type="checkbox" name="chat-authorization" />授权查看聊天记录</label>
    <textarea aria-label="投诉描述"></textarea>
    ${extra}
    <button type="button">提交</button>
  </section>`;
}

// These are real-browser integration tests. Full-suite worker contention can make
// a cold Chromium launch exceed Vitest's 5-second unit-test default on Windows.
describe("Tmall complaint DOM adapter", { timeout: 15_000 }, () => {
  it("opens the complaint entry when Tmall renders it as a plain link", async () => {
    const page = await fixture(`<section data-review-row data-review-source-key="tmall:target" data-review-phase="initial">
      <p>订单号：12345678</p>
      <a href="#" onclick="event.preventDefault();document.querySelector('#complaint-dialog').hidden=false">投诉评价</a>
    </section>${complaintDialog()}`);
    const adapter = createTmallComplaintDomAdapter(page as never);

    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:target", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "prepare_only",
      adapter,
    });

    expect(result).toEqual({ state: "prepared", actionLabel: "投诉评价" });
    expect(await page.locator("textarea").inputValue()).toBe(description);
  });

  it("binds the initial complaint action to the exact source row and stops before submit in prepare-only mode", async () => {
    const page = await fixture(`${reviewRow("tmall:target", "initial")}${reviewRow("tmall:other", "initial")}${complaintDialog()}`);
    const adapter = createTmallComplaintDomAdapter(page as never);

    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:target", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "prepare_only",
      adapter,
    });

    expect(result).toEqual({ state: "prepared", actionLabel: "投诉评价" });
    expect(await page.locator("textarea").inputValue()).toBe(description);
    expect(await page.getByRole("button", { name: "提交", exact: true }).getAttribute("data-clicked")).toBeNull();
  });

  it("closes an unchanged complaint dialog with its top-right × rather than the bottom cancel action", async () => {
    const closeControl = '<button type="button" class="next-dialog-close" aria-label="关闭投诉" onclick="document.querySelector(\'#complaint-dialog\').hidden=true">×</button><button type="button" data-bottom-cancel onclick="this.setAttribute(\'data-clicked\', \'true\')">取消</button>';
    const page = await fixture(`${reviewRow("tmall:handled", "initial")}${complaintDialog(closeControl)}`);
    const adapter = createTmallComplaintDomAdapter(page as never, {
      click: async (control) => {
        if ((await control.innerText()).trim() === "提交") {
          await control.evaluate((element) => element.setAttribute("data-clicked", "true"));
          return;
        }
        await control.click();
      },
    });

    const target = await adapter.resolveVerifiedTarget({ sourceKey: "tmall:handled", reviewPhase: "initial" });
    const dialog = await target!.openComplaint("投诉评价");
    const submit = (await dialog.listSubmitControls())[0]!;
    await dialog.clickSubmit(submit.id);

    expect(await dialog.readSubmissionEvidence()).toMatchObject({ accepted: false, remainsOnComplaintPage: true });
    await dialog.closeComplaintDialog();
    expect(await page.locator("#complaint-dialog").isHidden()).toBe(true);
    expect(await page.locator("[data-bottom-cancel]").getAttribute("data-clicked")).toBeNull();
  });

  it("closes Tmall's outer complaint frame with its top-right × instead of the iframe cancel button", async () => {
    const page = await fixture(`<section data-review-row data-review-source-key="tmall:iframe" data-review-phase="initial">
      <button type="button" onclick="document.querySelector('#shop-external-modal').hidden=false">投诉评价</button>
    </section>
    <div id="shop-external-modal" hidden style="width: 900px; height: 600px"></div>`);
    await page.route("https://ss.taobao.com/complaint", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<label><input type="radio" name="complaint-type" value="meaningless_content" />评价内容无意义</label>
        <textarea aria-label="投诉描述"></textarea>
        <button type="button">提交</button>
        <button type="button" data-iframe-cancel onclick="this.setAttribute('data-clicked', 'true')">取消</button>`,
    }));
    await page.locator("#shop-external-modal").evaluate((modal) => {
      modal.innerHTML = '<div class="modal-content"><span class="close" onclick="document.querySelector(\'#shop-external-modal\').hidden=true">×</span><iframe style="width: 900px; height: 600px" src="https://ss.taobao.com/complaint"></iframe></div>';
    });
    await page.locator("#shop-external-modal").evaluate((modal) => modal.removeAttribute("hidden"));
    await expect.poll(() => page.frames().filter((frame) => frame.url() === "https://ss.taobao.com/complaint").length).toBe(1);
    const complaintFrame = page.frames().find((frame) => frame.url() === "https://ss.taobao.com/complaint")!;
    expect(await complaintFrame.locator("body").isVisible()).toBe(true);
    const adapter = createTmallComplaintDomAdapter(page as never, {
      click: async (control) => {
        if ((await control.innerText()).trim() === "提交") return;
        await control.click();
      },
    });

    const target = await adapter.resolveVerifiedTarget({ sourceKey: "tmall:iframe", reviewPhase: "initial" });
    const complaint = await target!.openComplaint("投诉评价");
    await complaint.selectOfficialType("meaningless_content");
    await complaint.fillDescription(description);
    const submit = (await complaint.listSubmitControls())[0]!;
    await complaint.clickSubmit(submit.id);

    expect(await complaint.readSubmissionEvidence()).toMatchObject({ accepted: false, remainsOnComplaintPage: true });
    await complaint.closeComplaintDialog();
    expect(await page.locator("#shop-external-modal").isHidden()).toBe(true);
    expect(await page.frames().find((frame) => frame.url() === "https://ss.taobao.com/complaint")!.locator("[data-iframe-cancel]").getAttribute("data-clicked")).toBeNull();
  });

  it("uses 投诉追评 for a follow-up and rejects checked chat authorization before filling", async () => {
    const page = await fixture(`${reviewRow("tmall:followup", "followup")}${complaintDialog()}`);
    await page.locator("input[name='chat-authorization']").evaluate((input) => { (input as HTMLInputElement).checked = true; });
    const adapter = createTmallComplaintDomAdapter(page as never);

    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:followup", reviewPhase: "followup" },
      complaintType: "meaningless_content",
      description,
      mode: "prepare_only",
      adapter,
    });

    expect(result).toEqual({ state: "failed", actionLabel: "投诉追评", reason: "安全哨兵未通过：聊天授权已勾选或投诉凭证不为空" });
    expect(await page.locator("textarea").inputValue()).toBe("");
  });

  it("fails closed when a target row has no exact source-key identity", async () => {
    const page = await fixture(`<section data-review-row data-review-phase="initial"><button type="button">投诉评价</button></section>${complaintDialog()}`);
    const adapter = createTmallComplaintDomAdapter(page as never);

    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:target", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "prepare_only",
      adapter,
    });

    expect(result).toEqual({ state: "failed", actionLabel: "投诉评价", reason: "当前评价与待投诉目标不一致" });
  });

  it("runs the database checkpoint immediately before the unique submit click and reports a pre-click failure", async () => {
    const page = await fixture(`${reviewRow("tmall:target", "initial")}${complaintDialog()}`);
    let checkpointCalls = 0;
    let identityCalls = 0;
    const adapter = createTmallComplaintDomAdapter(page as never, {
      identifyRow: async () => {
        identityCalls += 1;
        return { sourceKey: "tmall:target", reviewPhase: "initial" };
      },
      beforeSubmitClick: async () => {
        checkpointCalls += 1;
        throw new Error("attempt already locked");
      },
    });

    const result = await executeComplaintBrowserFlow({
      target: { sourceKey: "tmall:target", reviewPhase: "initial" },
      complaintType: "meaningless_content",
      description,
      mode: "submit",
      adapter,
    });

    expect(result).toEqual({ state: "failed_before_click", actionLabel: "投诉评价", reason: "投诉提交前检查未通过" });
    expect(identityCalls).toBe(2);
    expect(checkpointCalls).toBe(1);
    expect(await page.getByRole("button", { name: "提交", exact: true }).getAttribute("data-clicked")).toBeNull();
  });

});
