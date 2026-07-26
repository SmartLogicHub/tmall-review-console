import { describe, expect, it } from "vitest";
import { parseFeishuBaseUrl } from "./url";

describe("parseFeishuBaseUrl", () => {
  it("parses an allowlisted Feishu Base URL with synthetic fixture identifiers", () => {
    expect(
      parseFeishuBaseUrl(
        "https://example-team.feishu.cn/base/bascnExample?table=tblExample&view=vewExample",
      ),
    ).toEqual({
      appToken: "bascnExample",
      tableId: "tblExample",
      viewId: "vewExample",
    });
  });

  it.each([
    "http://example-team.feishu.cn/base/bascnExample?table=tblExample",
    "https://feishu.cn/base/bascnExample?table=tblExample",
    "https://example-team.evilfeishu.cn/base/bascnExample?table=tblExample",
    "https://example-team.feishu.cn/wiki/bascnExample?table=tblExample",
    "https://example-team.feishu.cn/base/bascnExample?table=tbl-example",
    "https://example-team.feishu.cn/base/bascnExample",
  ])("rejects non-allowlisted or incomplete Base URL %s", (url) => {
    expect(() => parseFeishuBaseUrl(url)).toThrow(/飞书多维表格链接/u);
  });
});
