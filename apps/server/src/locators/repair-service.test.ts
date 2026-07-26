import { describe, expect, it } from "vitest";
import { openDatabase, runMigrations } from "../storage/database";
import { LocatorRepository } from "../storage/repositories";
import { LocatorRepairService, sanitizeSemanticSnapshot } from "./repair-service";

describe("locator repair service", () => {
  it("builds a small semantic snapshot without values, buyer data or order numbers", () => {
    const snapshot = sanitizeSemanticSnapshot([
      { tag: "input", role: "textbox", placeholder: "登录密码", value: "real-password" } as never,
      { tag: "button", role: "button", name: "提交" },
      { tag: "div", role: "row", name: "买家张三 订单号3311603223191045455" },
    ]);
    expect(snapshot).toContain("登录密码");
    expect(snapshot).toContain("提交");
    expect(snapshot).not.toContain("real-password");
    expect(snapshot).not.toContain("张三");
    expect(snapshot).not.toContain("3311603223191045455");
  });

  it("keeps controlled navigation semantics but removes arbitrary names, aria text and short identifiers", () => {
    const snapshot = sanitizeSemanticSnapshot([
      { tag: "a", role: "link", name: "评价管理", ariaLabel: "评价管理" },
      { tag: "button", role: "button", name: "有内容" },
      { tag: "a", role: "link", name: "张三" },
      { tag: "button", role: "button", name: "子账号小金", ariaLabel: "小金的快捷操作" },
      { tag: "a", role: "link", name: "商品详情与买家留言" },
      { tag: "button", role: "button", name: "A12", ariaLabel: "工号A12" },
      { tag: "div", role: "row", ariaLabel: "昵称阿杰" },
    ]);

    expect(snapshot).toContain("评价管理");
    expect(snapshot).toContain("有内容");
    for (const sensitive of ["张三", "子账号小金", "小金的快捷操作", "商品详情与买家留言", "A12", "工号A12", "昵称阿杰"]) {
      expect(snapshot).not.toContain(sensitive);
    }
  });

  it("auto-applies a uniquely validated low-risk repair", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const service = new LocatorRepairService({
      repository,
      ai: { suggestLocatorRepair: async () => ({ strategy: "text", selector: "评价管理", reason: "入口名称稳定" }) },
      probe: async () => ({ matches: 1, shadowValidated: true, postconditionPassed: true }),
    });

    const repair = await service.repair("navigation.reviews", [{ tag: "a", role: "link", name: "评价管理" }]);
    expect(repair.status).toBe("auto_applied");
    expect(repository.get("navigation.reviews")).toMatchObject({ version: 2, health: "recovered", selector: "评价管理" });
  });

  it("keeps a validated reply submit repair pending until a person approves it", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const service = new LocatorRepairService({
      repository,
      ai: { suggestLocatorRepair: async () => ({ strategy: "role", selector: "button:确认回复", reason: "唯一提交操作" }) },
      probe: async () => ({ matches: 1, shadowValidated: true, postconditionPassed: true }),
    });

    const repair = await service.repair("reply.submit", [{ tag: "button", role: "button", name: "确认回复" }]);
    expect(repair.status).toBe("pending_approval");
    expect(repository.get("reply.submit")).toMatchObject({ version: 1, health: "healthy" });
  });

  it("rejects scripts and candidates that are not uniquely validated", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const service = new LocatorRepairService({
      repository,
      ai: { suggestLocatorRepair: async () => ({ strategy: "css", selector: "javascript:alert(1)", reason: "bad" }) },
      probe: async () => ({ matches: 1, shadowValidated: true, postconditionPassed: true }),
    });
    await expect(service.repair("navigation.reviews", [])).rejects.toThrow("候选定位不安全");

    const nonUnique = new LocatorRepairService({
      repository,
      ai: { suggestLocatorRepair: async () => ({ strategy: "text", selector: "评价管理", reason: "candidate" }) },
      probe: async () => ({ matches: 2, shadowValidated: false, postconditionPassed: false }),
    });
    const repair = await nonUnique.repair("navigation.reviews", []);
    expect(repair.status).toBe("rejected");
    expect(repository.get("navigation.reviews")).toMatchObject({ version: 1, health: "healthy" });
  });

  it("rejects a unique locator whose text belongs to a different business action", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const suggestions = [
      { strategy: "role" as const, selector: "button:搜索", reason: "按钮唯一" },
      { strategy: "text" as const, selector: "有内容", reason: "筛选名称与步骤一致" },
    ];
    const probed: string[] = [];
    const service = new LocatorRepairService({
      repository,
      ai: { suggestLocatorRepair: async () => suggestions.shift()! },
      probe: async ({ selector }) => {
        probed.push(selector);
        return { matches: 1, shadowValidated: true, postconditionPassed: true };
      },
      maxCandidates: 2,
    });

    const repair = await service.repair("review.filter.content", [
      { tag: "button", role: "button", name: "搜索" },
      { tag: "button", role: "button", name: "有内容" },
    ]);

    expect(repair.status).toBe("auto_applied");
    expect(repository.get("review.filter.content")).toMatchObject({ selector: "有内容" });
    expect(probed).toEqual(["有内容"]);
  });

  it("tests bounded alternative candidates until one passes all validations", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    const repository = new LocatorRepository(database);
    repository.ensureDefaults();
    const suggestions = [
      { strategy: "text" as const, selector: "评价", reason: "第一个候选过宽" },
      { strategy: "role" as const, selector: "link:评价管理", reason: "第二个候选唯一" },
    ];
    const receivedRejected: unknown[] = [];
    const service = new LocatorRepairService({
      repository,
      ai: {
        suggestLocatorRepair: async (input) => {
          receivedRejected.push(input.rejectedCandidates ?? []);
          return suggestions.shift()!;
        },
      },
      probe: async ({ selector }) => selector === "评价"
        ? { matches: 3, shadowValidated: false, postconditionPassed: false }
        : { matches: 1, shadowValidated: true, postconditionPassed: true },
      maxCandidates: 3,
    });

    const repair = await service.repair("navigation.reviews", [{ tag: "a", role: "link", name: "评价管理" }]);

    expect(repair.status).toBe("auto_applied");
    // The semantically wrong first candidate is rejected before it reaches
    // the version store, so only the validated candidate creates version 2.
    expect(repository.get("navigation.reviews")).toMatchObject({ version: 2, selector: "link:评价管理", health: "recovered" });
    expect(receivedRejected).toEqual([[], [{ strategy: "text", selector: "评价", reason: "候选元素与当前业务步骤不一致" }]]);
  });
});
