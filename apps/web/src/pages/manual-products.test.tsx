import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetApiSessionForTests } from "../api/client";
import "../styles.css";
import { formatManualProductDateTime, ManualProductsPage } from "./manual-products";

type Product = {
  id: string;
  itemId: string | null;
  title: string;
  normalizedTitle?: string;
  sources: Array<"manual" | "excel">;
  lastMatchedAt: string | null;
};

let products: Product[];
let revision: number;
let lastImportAt: string | null;
let previewResponse: Record<string, unknown>;
let localPickerResponse: Record<string, unknown>;
let localPickerStatus: number;
let applyStatus: number;
let createOutcome: "created" | "reused" | "enriched" | "merged";
let deleteStatus: number;
let requests: Array<{ url: string; init: RequestInit | undefined }>;
let listFailure: Error | null;
let createFailure: Error | null;
let previewFailure: Error | null;
let previewResponder: (() => Promise<Response>) | null;
let deleteFailure: Error | null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function listResponse(url: string) {
  const parsed = new URL(url, "http://localhost");
  const query = (parsed.searchParams.get("query") ?? "").toLowerCase();
  const page = Number(parsed.searchParams.get("page") ?? 1);
  const pageSize = Number(parsed.searchParams.get("pageSize") ?? 20);
  const filtered = products.filter((product) => `${product.title} ${product.itemId ?? ""}`.toLowerCase().includes(query));
  return {
    catalogRevision: revision,
    total: filtered.length,
    page,
    pageSize,
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    stats: {
      total: products.length,
      manualSourceCount: products.filter((product) => product.sources.includes("manual")).length,
      excelSourceCount: products.filter((product) => product.sources.includes("excel")).length,
      lastImportAt,
    },
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><ManualProductsPage /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  resetApiSessionForTests();
  products = [];
  revision = 3;
  lastImportAt = null;
  applyStatus = 200;
  createOutcome = "created";
  deleteStatus = 200;
  requests = [];
  listFailure = null;
  createFailure = null;
  previewFailure = null;
  previewResponder = null;
  deleteFailure = null;
  previewResponse = {
    canApply: true,
    previewId: "preview-1",
    catalogRevision: 3,
    worksheetName: "Sheet1",
    summary: { added: 2, retained: 1, removed: 1, conflicts: 0 },
    samples: {
      added: [{ title: "新增耳机", itemId: "1001" }],
      retained: [{ title: "保留耳机", itemId: "1002" }],
      removed: [{ id: "old", title: "移除耳机", itemId: "1003" }],
      conflicts: [],
    },
  };
  localPickerResponse = { cancelled: true };
  localPickerStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "test-csrf" });
    requests.push({ url, init });
    if (url.includes("/api/manual-products/import/select-and-preview")) return json(localPickerResponse, localPickerStatus);
    if (url.includes("/api/manual-products/import/preview")) {
      if (previewFailure) throw previewFailure;
      if (previewResponder) return previewResponder();
      return json(previewResponse);
    }
    if (url.includes("/api/manual-products/import/apply")) {
      if (applyStatus === 409) return json({ error: "manual_product_catalog_changed", detail: "名单已更新，请重新选择文件" }, 409);
      if (applyStatus === 410) return json({ error: "import_preview_invalid", detail: "预览已失效，请重新上传" }, 410);
      revision += 1;
      return json({ catalogRevision: revision, added: 2, retained: 1, removed: 1 });
    }
    if (url.includes("/api/manual-products/") && init?.method === "DELETE") {
      if (deleteFailure) throw deleteFailure;
      if (deleteStatus === 409) return json({ error: "manual_product_catalog_changed", detail: "名单已在其他页面更新" }, 409);
      const id = url.split("/").at(-1)!;
      products = products.filter((product) => product.id !== id);
      revision += 1;
      return json({ removed: true, catalogRevision: revision });
    }
    if (url.endsWith("/api/manual-products") && init?.method === "POST") {
      if (createFailure) throw createFailure;
      const body = JSON.parse(String(init.body)) as { title: string; itemId: string | null; expectedRevision: number };
      products.unshift({ id: `p-${products.length + 1}`, title: body.title, itemId: body.itemId, sources: ["manual"], lastMatchedAt: null });
      revision += 1;
      return json({ outcome: createOutcome, product: products[0], catalogRevision: revision });
    }
    if (url.includes("/api/manual-products")) {
      if (listFailure) throw listFailure;
      return json(listResponse(url));
    }
    return json({ error: "not_found" }, 404);
  }));
});

describe("manual product workspace", () => {
  it("explains that listed neutral and negative reviews are skipped automatically", async () => {
    renderPage();

    expect(await screen.findByText("命中的中评和差评会由自动流程直接跳过，不生成回复或提交投诉；好评继续自动处理。")).toBeInTheDocument();
    expect(screen.queryByText(/转人工|保留给人工处理|逐条判断/)).not.toBeInTheDocument();
  });

  it("keeps product IDs and Excel verification text at a readable minimum size", () => {
    const { container } = render(<>
      <div className="manual-product-identity"><span>商品 ID：960227744800</span></div>
      <div className="import-sample-group"><small>ID 960227744800</small></div>
      <div className="file-picker"><div><small>文件最大 5MB；必须包含商品 ID</small></div></div>
    </>);

    for (const element of container.querySelectorAll("small, .manual-product-identity span")) {
      expect(Number.parseFloat(getComputedStyle(element).fontSize)).toBeGreaterThanOrEqual(11);
    }
  });

  it("opens the Windows picker from the primary action and shows its preview immediately", async () => {
    localPickerResponse = { ...previewResponse, cancelled: false, displayFilename: "中差评剔除产品.xlsx" };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });

    await user.click(within(dialog).getByRole("button", { name: "从电脑选择 Excel" }));

    expect(await within(dialog).findByText("已选择：中差评剔除产品.xlsx")).toBeVisible();
    expect(within(dialog).getByLabelText("Excel 名单变化预览")).toHaveTextContent("新增 2");
    expect(within(dialog).getByRole("button", { name: "确认更新 Excel 名单" })).toBeEnabled();
    expect(requests.some((request) => request.url.endsWith("/api/manual-products/import/select-and-preview") && request.init?.method === "POST")).toBe(true);
  });

  it("keeps the import dialog open when the Windows picker is cancelled", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    await user.click(within(dialog).getByRole("button", { name: "从电脑选择 Excel" }));
    expect(dialog).toBeVisible();
    expect(within(dialog).queryByLabelText("Excel 名单变化预览")).not.toBeInTheDocument();
  });

  it("keeps an existing preview when a later Windows picker is cancelled", async () => {
    localPickerResponse = { ...previewResponse, cancelled: false, displayFilename: "中差评剔除产品.xlsx" };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    const choose = within(dialog).getByRole("button", { name: "从电脑选择 Excel" });

    await user.click(choose);
    expect(await within(dialog).findByLabelText("Excel 名单变化预览")).toBeVisible();
    localPickerResponse = { cancelled: true };
    await user.click(choose);

    expect(within(dialog).getByLabelText("Excel 名单变化预览")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认更新 Excel 名单" })).toBeEnabled();
  });

  it("clears a stale preview when a newly selected local workbook is invalid", async () => {
    localPickerResponse = { ...previewResponse, cancelled: false, displayFilename: "中差评剔除产品.xlsx" };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    const choose = within(dialog).getByRole("button", { name: "从电脑选择 Excel" });

    await user.click(choose);
    expect(await within(dialog).findByLabelText("Excel 名单变化预览")).toBeVisible();
    localPickerStatus = 422;
    localPickerResponse = { error: "invalid_manual_product_workbook", detail: "Excel 必须包含唯一的商品 ID 列" };
    await user.click(choose);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Excel 必须包含唯一的商品 ID 列");
    expect(within(dialog).queryByLabelText("Excel 名单变化预览")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("已选择：中差评剔除产品.xlsx")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认更新 Excel 名单" })).toBeDisabled();
  });

  it("exposes the native file input directly and shows the selected filename", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    const fileInput = within(dialog).getByLabelText("浏览器上传（备用）");

    expect(fileInput).toBeVisible();
    expect(fileInput).not.toBeDisabled();
    expect(fileInput).not.toHaveAttribute("hidden");
    expect(fileInput).not.toHaveStyle({ display: "none" });
    await user.upload(fileInput, new File(["workbook"], "中差评剔除产品.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    expect(within(dialog).getByText("中差评剔除产品.xlsx")).toBeVisible();
  });

  it("requires only a stable item ID when manually adding a product", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "手工添加商品" }));
    const dialog = screen.getByRole("dialog", { name: "添加自动跳过商品" });
    const itemId = within(dialog).getByLabelText("商品 ID（必填）");
    const title = within(dialog).getByLabelText("商品标题（选填，仅用于辨认）");
    expect(within(dialog).getByText("加入名单后，命中的中差评自动跳过，不回复、不投诉；好评继续自动处理。")).toBeVisible();
    expect(itemId).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "添加到名单" })).toBeDisabled();

    await user.type(itemId, "960227744800");
    expect(within(dialog).getByRole("button", { name: "添加到名单" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "添加到名单" }));

    const create = requests.find((request) => request.url.endsWith("/api/manual-products") && request.init?.method === "POST");
    expect(JSON.parse(String(create?.init?.body))).toEqual({
      itemId: "960227744800",
      title: "",
      expectedRevision: 3,
    });
    expect(title).not.toHaveValue();
  });

  it("formats malformed timestamps as a stable user-facing fallback", () => {
    expect(formatManualProductDateTime("not-a-date")).toBe("时间未知");
  });

  it("shows aggregate counts and a useful empty state without leaking internal fields", async () => {
    renderPage();

    expect(await screen.findByRole("heading", { name: "自动跳过商品" })).toBeVisible();
    expect(screen.getByText("命中的中差评自动跳过，不回复、不投诉；好评继续自动处理")).toBeVisible();
    expect(await screen.findByText("名单还是空的")).toBeVisible();
    expect(screen.getByText("总商品")).toBeVisible();
    expect(screen.getAllByText("手工添加").length).toBeGreaterThan(0);
    expect(screen.getByText("Excel 导入")).toBeVisible();
    expect(screen.queryByText(/normalizedTitle|catalogRevision|sourceKey|revision/u)).not.toBeInTheDocument();
  });

  it("uses submitted search, paginates, labels sources and displays recent matches", async () => {
    products = Array.from({ length: 22 }, (_, index) => ({
      id: `p-${index + 1}`,
      itemId: String(9000 + index),
      title: index === 0 ? "G3 MAX 游戏耳机" : `测试商品 ${index + 1}`,
      sources: index === 0 ? ["manual", "excel"] : ["excel"],
      lastMatchedAt: index === 0 ? "2026-07-15T04:30:00.000Z" : null,
    }));
    lastImportAt = "2026-07-15T03:00:00.000Z";
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("G3 MAX 游戏耳机")).toBeVisible();
    expect(screen.getAllByText("手工添加").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Excel 导入").length).toBeGreaterThan(0);
    expect(screen.getByText(/最近命中/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
    const input = screen.getByRole("searchbox", { name: "搜索商品标题或商品 ID" });
    expect(input).toHaveAttribute("maxlength", "200");
    const readsBeforeTyping = requests.filter((request) => request.url.includes("/api/manual-products?")).length;
    await user.type(input, "G3 MAX");
    expect(requests.filter((request) => request.url.includes("/api/manual-products?")).length).toBe(readsBeforeTyping);
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(requests.some((request) => request.url.includes("query=G3%20MAX"))).toBe(true));
    expect(screen.getByText("G3 MAX 游戏耳机")).toBeVisible();
    expect(screen.getByText("总商品").parentElement).toHaveTextContent("22");
    expect(screen.getByText("1 条结果")).toBeVisible();
  });

  it.each([
    ["created", "商品已添加到自动跳过名单"],
    ["reused", "该商品已在名单中，来源信息已保留"],
    ["enriched", "该商品 ID 已更新并保留原有名单来源"],
    ["merged", "相同商品 ID 已合并为一条名单记录"],
  ] as const)("explains the %s result in merchant language", async (outcome, copy) => {
    createOutcome = outcome;
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "手工添加商品" }));
    await user.type(screen.getByLabelText("商品 ID（必填）"), "960227744800");
    await user.type(screen.getByLabelText("商品标题（选填，仅用于辨认）"), "结果测试商品");
    await user.click(screen.getByRole("button", { name: "添加到名单" }));
    expect(await screen.findByText(copy)).toBeVisible();
  });

  it("requires the merchant to reopen and reconfirm after a delete revision conflict", async () => {
    products = [{ id: "p-1", itemId: "100", title: "冲突商品", sources: ["excel"], lastMatchedAt: null }];
    deleteStatus = 409;
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("冲突商品");
    await user.click(screen.getByRole("button", { name: "移出 冲突商品" }));
    await user.click(screen.getByRole("button", { name: "确认移出" }));

    expect(await screen.findByText("名单已更新，请重新选择商品并再次确认移出")).toBeVisible();
    expect(screen.queryByRole("alertdialog", { name: "确认移出名单" })).not.toBeInTheDocument();
    expect(requests.filter((request) => request.init?.method === "DELETE")).toHaveLength(1);
  });

  it("moves back a page after deleting the final result on the current page", async () => {
    products = Array.from({ length: 21 }, (_, index) => ({ id: `p-${index}`, itemId: String(index), title: `商品 ${index}`, sources: ["manual"], lastMatchedAt: null }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("商品 0");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("商品 20")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "移出 商品 20" }));
    await user.click(screen.getByRole("button", { name: "确认移出" }));
    expect(await screen.findByText("商品 0")).toBeVisible();
    expect(screen.queryByText("商品 20")).not.toBeInTheDocument();
  });

  it("returns to the last valid page when an Excel replacement shrinks the catalog", async () => {
    products = Array.from({ length: 21 }, (_, index) => ({
      id: `p-${index}`,
      itemId: String(index),
      title: `商品 ${index}`,
      sources: ["excel"],
      lastMatchedAt: null,
    }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("商品 0");
    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("商品 20")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    await user.upload(within(dialog).getByLabelText("浏览器上传（备用）"), new File(["workbook"], "replacement.xlsx"));
    products = products.slice(0, 20);
    await user.click(await within(dialog).findByRole("button", { name: "确认更新 Excel 名单" }));

    expect(await screen.findByText("商品 0")).toBeVisible();
    expect(screen.queryByText("名单还是空的")).not.toBeInTheDocument();
    expect(requests.some((request) => request.url.includes("page=1&pageSize=20"))).toBe(true);
  });

  it("ignores a late preview response after the merchant selects a replacement workbook", async () => {
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let requestCount = 0;
    previewResponder = async () => {
      requestCount += 1;
      if (requestCount === 1) return firstResponse;
      return json({
        ...previewResponse,
        previewId: "preview-new-file",
        summary: { added: 9, retained: 0, removed: 0, conflicts: 0 },
      });
    };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    const input = within(dialog).getByLabelText("浏览器上传（备用）");
    await user.upload(input, new File(["a"], "first.xlsx"));
    await user.upload(input, new File(["b"], "second.xlsx"));
    expect(await within(dialog).findByText("新增 9")).toBeVisible();
    resolveFirst(json({ ...previewResponse, previewId: "preview-old-file" }));
    await waitFor(() => expect(within(dialog).getByText("新增 9")).toBeVisible());
    expect(within(dialog).queryByText("新增 2")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "确认更新 Excel 名单" })).toBeEnabled();
  });

  it("adds a manual item with a frozen revision and refreshes the list", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");

    await user.click(screen.getByRole("button", { name: "手工添加商品" }));
    const dialog = screen.getByRole("dialog", { name: "添加自动跳过商品" });
    expect(within(dialog).getByRole("button", { name: "添加到名单" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("商品 ID（必填）"), "123456789012345678");
    await user.type(within(dialog).getByLabelText("商品标题（选填，仅用于辨认）"), "R206BT 音箱");
    await user.click(within(dialog).getByRole("button", { name: "添加到名单" }));

    await waitFor(() => expect(screen.getByText("R206BT 音箱")).toBeVisible());
    const create = requests.find((request) => request.url.endsWith("/api/manual-products") && request.init?.method === "POST");
    expect(JSON.parse(String(create?.init?.body))).toEqual({ title: "R206BT 音箱", itemId: "123456789012345678", expectedRevision: 3 });
  });

  it("never replays a manual add after session recovery", async () => {
    let bootstrapCount = 0;
    let createCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) {
        bootstrapCount += 1;
        return json({ csrfToken: `csrf-${bootstrapCount}` });
      }
      if (url.endsWith("/api/manual-products") && init?.method === "POST") {
        createCount += 1;
        return json({ error: "invalid_session" }, 401);
      }
      if (url.includes("/api/manual-products")) return json(listResponse(url));
      return json({ error: "not_found" }, 404);
    }));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "手工添加商品" }));
    await user.type(screen.getByLabelText("商品 ID（必填）"), "900000000000001");
    await user.type(screen.getByLabelText("商品标题（选填，仅用于辨认）"), "只提交一次的商品");
    await user.click(screen.getByRole("button", { name: "添加到名单" }));

    expect(await screen.findByText("本地服务已重新连接，请重新确认此操作")).toBeVisible();
    expect(createCount).toBe(1);
    expect(bootstrapCount).toBe(2);
  });

  it("does not expose unexpected transport errors from manual add", async () => {
    createFailure = new Error("ECONNREFUSED 127.0.0.1:43121 internal-stack");
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "手工添加商品" }));
    await user.type(screen.getByLabelText("商品 ID（必填）"), "900000000000002");
    await user.type(screen.getByLabelText("商品标题（选填，仅用于辨认）"), "错误文案测试商品");
    await user.click(screen.getByRole("button", { name: "添加到名单" }));
    expect(await screen.findByText("商品保存失败，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/ECONNREFUSED|internal-stack/u)).not.toBeInTheDocument();
  });

  it("requires a second confirmation to remove an item and does not auto-replay a revision conflict", async () => {
    products = [{ id: "p-1", itemId: "100", title: "待移出商品", sources: ["manual", "excel"], lastMatchedAt: null }];
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("待移出商品");

    await user.click(screen.getByRole("button", { name: "移出 待移出商品" }));
    const dialog = screen.getByRole("alertdialog", { name: "确认移出名单" });
    expect(within(dialog).getByText("手工添加")).toBeVisible();
    expect(within(dialog).getByText("Excel 导入")).toBeVisible();
    expect(within(dialog).getByText("将从当前名单全部移除；若 Excel 文件仍含该商品，下次导入会重新加入。")).toBeVisible();
    expect(requests.filter((request) => request.init?.method === "DELETE")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(requests.filter((request) => request.init?.method === "DELETE")).toHaveLength(1));
    expect(JSON.parse(String(requests.find((request) => request.init?.method === "DELETE")?.init?.body))).toEqual({ expectedRevision: 3 });
  });

  it("returns focus to the next remove action after a successful deletion", async () => {
    products = [
      { id: "p-1", itemId: "1", title: "第一件商品", sources: ["manual"], lastMatchedAt: null },
      { id: "p-2", itemId: "2", title: "下一件商品", sources: ["excel"], lastMatchedAt: null },
    ];
    const user = userEvent.setup();
    renderPage();
    const first = await screen.findByRole("button", { name: "移出 第一件商品" });
    await user.click(first);
    await user.click(screen.getByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "移出 下一件商品" })).toHaveFocus());
  });

  it("focuses search when deleting the final row and restores the trigger on cancel", async () => {
    products = [{ id: "p-1", itemId: "1", title: "唯一商品", sources: ["manual"], lastMatchedAt: null }];
    const user = userEvent.setup();
    renderPage();
    const trigger = await screen.findByRole("button", { name: "移出 唯一商品" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "搜索商品标题或商品 ID" })).toHaveFocus());
  });

  it("restores focus to the original row after a delete conflict", async () => {
    products = [{ id: "p-1", itemId: "100", title: "冲突商品", sources: ["excel"], lastMatchedAt: null }];
    deleteStatus = 409;
    const user = userEvent.setup();
    renderPage();
    const trigger = await screen.findByRole("button", { name: "移出 冲突商品" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "确认移出" }));
    await screen.findByText("名单已更新，请重新选择商品并再次确认移出");
    expect(trigger).toHaveFocus();
  });

  it("uses a safe fallback for unexpected delete failures", async () => {
    products = [{ id: "p-1", itemId: "100", title: "删除失败商品", sources: ["manual"], lastMatchedAt: null }];
    deleteFailure = new Error("SQLITE_BUSY /private/path");
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "移出 删除失败商品" }));
    await user.click(screen.getByRole("button", { name: "确认移出" }));
    expect(await screen.findByText("商品移出失败，请稍后重试")).toBeVisible();
    expect(screen.queryByText(/SQLITE_BUSY|private\/path/u)).not.toBeInTheDocument();
  });

  it("previews Excel differences and explicitly confirms replacement without changing manual sources", async () => {
    products = [{ id: "manual-only", itemId: null, title: "手工保留商品", sources: ["manual"], lastMatchedAt: null }];
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("手工保留商品");

    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    const file = new File(["workbook"], "中差评剔除产品.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await user.upload(within(dialog).getByLabelText("浏览器上传（备用）"), file);

    expect(await within(dialog).findByText("新增 2")).toBeVisible();
    expect(within(dialog).getByText("保留 1")).toBeVisible();
    expect(within(dialog).getByText("移除 1")).toBeVisible();
    expect(within(dialog).getByText("冲突 0")).toBeVisible();
    expect(within(dialog).getByText("手工添加的商品不会被本次替换移除")).toBeVisible();
    const apply = within(dialog).getByRole("button", { name: "确认更新 Excel 名单" });
    await user.click(apply);
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/api/manual-products/import/apply"))).toBe(true));
    expect(screen.queryByRole("dialog", { name: "导入 Excel 名单" })).not.toBeInTheDocument();
    expect(screen.getByText("手工保留商品")).toBeVisible();
  });

  it("blocks conflicting previews and clears an expired preview before asking for a new upload", async () => {
    previewResponse = {
      ...previewResponse,
      canApply: false,
      previewId: null,
      summary: { added: 1, retained: 0, removed: 0, conflicts: 1 },
      samples: { added: [], retained: [], removed: [], conflicts: [{ title: "冲突商品", itemId: null }] },
    };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    await user.upload(within(dialog).getByLabelText("浏览器上传（备用）"), new File(["x"], "products.xlsx"));

    expect(await within(dialog).findByText("发现 1 条冲突，请修正 Excel 后重新选择文件")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认更新 Excel 名单" })).toBeDisabled();
  });

  it("uses a safe Chinese fallback for unexpected workbook preview failures", async () => {
    previewFailure = new Error("ZIP_CENTRAL_DIRECTORY private parser detail");
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    await user.upload(within(dialog).getByLabelText("浏览器上传（备用）"), new File(["x"], "broken.xlsx"));
    expect(await within(dialog).findByText("无法预览该名单，请检查文件后重试")).toBeVisible();
    expect(within(dialog).queryByText(/ZIP_CENTRAL_DIRECTORY|private parser/u)).not.toBeInTheDocument();
  });

  it("disables manual add while the catalog revision is still loading", async () => {
    let resolveList!: (response: Response) => void;
    const pendingList = new Promise<Response>((resolve) => { resolveList = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/bootstrap")) return json({ csrfToken: "csrf-delayed" });
      if (url.includes("/api/manual-products")) return pendingList;
      return json({ error: "not_found" }, 404);
    }));
    renderPage();
    const add = screen.getByRole("button", { name: "手工添加商品" });
    expect(add).toBeDisabled();
    expect(screen.getByText("名单读取完成后可添加")).toBeVisible();
    resolveList(json(listResponse("/api/manual-products?page=1&pageSize=20")));
    await waitFor(() => expect(add).toBeEnabled());
  });

  it("keeps page failures user-facing without exposing transport details", async () => {
    listFailure = new Error("fetch failed ENOTFOUND internal-host");
    renderPage();
    expect(await screen.findByText("名单读取失败")).toBeVisible();
    expect(screen.getByText("请检查本地服务后重试。")).toBeVisible();
    expect(screen.queryByText(/ENOTFOUND|internal-host/u)).not.toBeInTheDocument();
  });

  it("invalidates a consumed preview on catalog conflict so confirmation cannot be replayed", async () => {
    applyStatus = 409;
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("名单还是空的");
    await user.click(screen.getByRole("button", { name: "导入 Excel 名单" }));
    const dialog = screen.getByRole("dialog", { name: "导入 Excel 名单" });
    await user.upload(within(dialog).getByLabelText("浏览器上传（备用）"), new File(["x"], "products.xlsx"));
    await user.click(await within(dialog).findByRole("button", { name: "确认更新 Excel 名单" }));

    expect(await within(dialog).findByText("名单已更新，请重新选择文件")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "确认更新 Excel 名单" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "重新选择文件" }));
    expect(within(dialog).getByRole("button", { name: "确认更新 Excel 名单" })).toBeDisabled();
  });
});
