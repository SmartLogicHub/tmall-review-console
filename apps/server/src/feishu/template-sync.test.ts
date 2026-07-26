import { describe, expect, it, vi } from "vitest";
import { openDatabase, runMigrations } from "../storage/database";
import { TemplateRepository } from "../storage/repositories";
import { normalizeFeishuTable, TemplateSyncService } from "./template-sync";

const goodFields = [
  { field_name: "关键词分类" },
  { field_name: "包含关键词" },
  { field_name: "回复话术 1" },
  { field_name: "回复话术 2" },
];

const goodRecords = [
  {
    record_id: "rec-1",
    fields: {
      关键词分类: "音质好评",
      包含关键词: "音质好、清晰\n好听",
      "回复话术 1": [{ text: "感谢您的认可" }],
      "回复话术 2": "祝您使用愉快",
      附件: [{ file_token: "secret-file" }],
    },
  },
  {
    record_id: "rec-2",
    fields: {
      关键词分类: "通用整体好评类",
      包含关键词: "",
      "回复话术 1": "感谢您的支持",
    },
  },
];

describe("normalizeFeishuTable", () => {
  it("uses only fixed fields, supports rich text, and ignores extra columns", () => {
    const result = normalizeFeishuTable("good", goodFields, goodRecords);
    expect(result.templates[0]).toMatchObject({
      category: "音质好评",
      keywords: ["音质好", "清晰", "好听"],
      replies: [
        { sequence: 1, text: "感谢您的认可" },
        { sequence: 2, text: "祝您使用愉快" },
      ],
    });
  });

  it("reports the record and field for unsupported relevant cells", () => {
    const records = structuredClone(goodRecords);
    records[0]!.fields["回复话术 1"] = { file_token: "unsupported" } as never;
    expect(() => normalizeFeishuTable("good", goodFields, records)).toThrow(
      /rec-1.*回复话术 1.*不支持/,
    );
  });

  it("rejects missing required fields and duplicate reply sequence columns", () => {
    expect(() => normalizeFeishuTable("good", goodFields.slice(1), goodRecords)).toThrow(
      /关键词分类/,
    );
    expect(() =>
      normalizeFeishuTable(
        "good",
        [...goodFields, { field_name: "回复话术1" }],
        goodRecords,
      ),
    ).toThrow(/话术序号 1 重复/);
  });
});

describe("TemplateSyncService", () => {
  it("keeps a validated active version usable with a warning when a later sync fails", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new TemplateRepository(database);
    repository.saveSource({
      library: "good",
      url: "https://tenant.feishu.cn/base/app-token?table=table-id",
      appToken: "app-token",
      tableId: "table-id",
      viewId: null,
    });
    const client = {
      testConnection: vi.fn(async () => undefined),
      listFields: vi.fn(async () => goodFields),
      listRecords: vi.fn(async () => goodRecords),
    };
    const service = new TemplateSyncService({ repository, client });

    expect(repository.getHealth("good")).toMatchObject({ state: "not_ready", usable: false });

    await service.sync("good");
    expect(repository.getHealth("good")).toMatchObject({ state: "ready", usable: true });

    client.listRecords.mockResolvedValueOnce(goodRecords.slice(0, 1));
    await expect(service.sync("good")).rejects.toThrow();
    expect(repository.getHealth("good")).toMatchObject({
      state: "usable_with_warning",
      usable: true,
      warning: { code: "TEMPLATE_SYNC_FAILED" },
    });

    await service.sync("good");
    expect(repository.getHealth("good")).toMatchObject({ state: "ready", usable: true });
    database.close();
  });

  it("does not report a missing required category in the active version as usable", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new TemplateRepository(database);
    repository.saveSource({
      library: "good",
      url: "https://tenant.feishu.cn/base/app-token?table=table-id",
      appToken: "app-token",
      tableId: "table-id",
      viewId: null,
    });
    const service = new TemplateSyncService({
      repository,
      client: {
        testConnection: vi.fn(async () => undefined),
        listFields: vi.fn(async () => goodFields),
        listRecords: vi.fn(async () => goodRecords),
      },
    });
    await service.sync("good");

    const fallback = repository.getActiveCategories("good").at(-1)!;
    database.prepare("DELETE FROM template_categories WHERE category = ?").run(fallback.category);

    expect(repository.getHealth("good")).toMatchObject({
      state: "not_ready",
      usable: false,
      reason: "active_version_invalid",
    });
    database.close();
  });

  it("redacts source and credential values when recording a failed sync", () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new TemplateRepository(database);
    repository.saveSource({
      library: "good",
      url: "https://tenant.feishu.cn/base/app-token?table=table-id",
      appToken: "app-token",
      tableId: "table-id",
      viewId: null,
    });

    repository.recordSyncFailure(
      "good",
      "TEMPLATE_SYNC_FAILED",
      "request https://tenant.feishu.cn/base/private app_token=private-token table_id=private-table",
    );

    const stored = String(repository.getSource("good")?.last_error_message ?? "");
    expect(stored).not.toContain("tenant.feishu.cn");
    expect(stored).not.toContain("private-token");
    expect(stored).not.toContain("private-table");
    database.close();
  });

  it("remains not ready when the first sync fails before any active version exists", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new TemplateRepository(database);
    repository.saveSource({
      library: "good",
      url: "https://tenant.feishu.cn/base/app-token?table=table-id",
      appToken: "app-token",
      tableId: "table-id",
      viewId: null,
    });
    const service = new TemplateSyncService({
      repository,
      client: {
        testConnection: vi.fn(async () => undefined),
        listFields: vi.fn(async () => goodFields),
        listRecords: vi.fn(async () => goodRecords.slice(0, 1)),
      },
    });

    await expect(service.sync("good")).rejects.toThrow();
    expect(repository.getHealth("good")).toMatchObject({ state: "not_ready", usable: false });
    database.close();
  });

  it("activates only a fully valid version and keeps it after a failed sync", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new TemplateRepository(database);
    repository.saveSource({
      library: "good",
      url: "https://tenant.feishu.cn/base/app-token?table=table-id",
      appToken: "app-token",
      tableId: "table-id",
      viewId: null,
    });
    const client = {
      testConnection: vi.fn(async () => undefined),
      listFields: vi.fn(async () => goodFields),
      listRecords: vi.fn(async () => goodRecords),
    };
    const service = new TemplateSyncService({ repository, client });

    const first = await service.sync("good");
    expect(first).toMatchObject({ changed: true, categoryCount: 2, replyCount: 3 });
    expect(repository.getActiveCategories("good")).toHaveLength(2);

    client.listRecords.mockResolvedValueOnce(goodRecords.slice(0, 1));
    await expect(service.sync("good")).rejects.toThrow(/通用整体好评类/);
    expect(repository.getActiveCategories("good").map((item) => item.category)).toEqual([
      "音质好评",
      "通用整体好评类",
    ]);
    expect(repository.getSource("good")).toMatchObject({ status: "error" });
    database.close();
  });
});
