export interface FeishuBaseLocation {
  appToken: string;
  tableId: string;
  viewId: string | null;
}

const SAFE_ID = /^[A-Za-z0-9]+$/u;

export function parseFeishuBaseUrl(input: string): FeishuBaseLocation {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("请输入有效的飞书多维表格链接");
  }

  const host = url.hostname.toLowerCase();
  const pathMatch = /^\/base\/([A-Za-z0-9]+)\/?$/u.exec(url.pathname);
  const tableId = url.searchParams.get("table") ?? "";
  const viewId = url.searchParams.get("view");
  if (
    url.protocol !== "https:" ||
    !host.endsWith(".feishu.cn") ||
    host === "feishu.cn" ||
    !pathMatch ||
    !SAFE_ID.test(tableId) ||
    (viewId !== null && !SAFE_ID.test(viewId))
  ) {
    throw new Error("请输入有效的飞书多维表格链接");
  }

  return { appToken: pathMatch[1]!, tableId, viewId };
}
