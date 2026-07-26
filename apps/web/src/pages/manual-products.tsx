import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Clock3, FileSpreadsheet, PackageSearch, Plus, Search, Trash2, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, toUserMessage } from "../api/client";
import { ManualProductForm, type ManualProductItem } from "../components/manual-product-form";
import { ManualProductImportDialog } from "../components/manual-product-import-dialog";

type ManualProductList = {
  catalogRevision: number;
  total: number;
  page: number;
  pageSize: number;
  items: ManualProductItem[];
  stats: {
    total: number;
    manualSourceCount: number;
    excelSourceCount: number;
    lastImportAt: string | null;
  };
};

type RemoveTarget = {
  product: ManualProductItem;
  revision: number;
  nextProductId: string | null;
  trigger: HTMLButtonElement;
};

type PendingFocus =
  | { kind: "next"; productId: string | null }
  | { kind: "trigger"; element: HTMLButtonElement };

const outcomeCopy = {
  created: "商品已添加到自动跳过名单",
  reused: "该商品已在名单中，来源信息已保留",
  enriched: "该商品 ID 已更新并保留原有名单来源",
  merged: "相同商品 ID 已合并为一条名单记录",
} as const;

export function ManualProductsPage() {
  const queryClient = useQueryClient();
  const [draftQuery, setDraftQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const list = useQuery({
    queryKey: ["manual-products", submittedQuery, page],
    queryFn: () => apiFetch<ManualProductList>(`/api/manual-products?query=${encodeURIComponent(submittedQuery)}&page=${page}&pageSize=20`),
  });
  const remove = useMutation({
    mutationFn: (target: RemoveTarget) => apiFetch<{ removed: boolean; catalogRevision: number }>(`/api/manual-products/${target.product.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: target.revision }),
    }, { replayOnSessionRecovery: false }),
    onSuccess: async (_result, target) => {
      const shouldMoveBack = page > 1 && (list.data?.items.length ?? 0) === 1;
      if (shouldMoveBack) setPage((current) => Math.max(1, current - 1));
      setNotice("商品已移出自动跳过名单");
      setRemoveTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["manual-products"] }),
        queryClient.invalidateQueries({ queryKey: ["manual-product-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      setPendingFocus({ kind: "next", productId: target.nextProductId });
    },
    onError: async (error, target) => {
      if (error instanceof ApiError && error.code === "manual_product_catalog_changed") {
        setRemoveTarget(null);
        setNotice("名单已更新，请重新选择商品并再次确认移出");
        await queryClient.invalidateQueries({ queryKey: ["manual-products"] });
        setPendingFocus({ kind: "trigger", element: target.trigger });
      }
    },
  });

  const data = list.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pageOutOfRange = Boolean(data && page > totalPages);
  useEffect(() => {
    if (data && page > totalPages) setPage(totalPages);
  }, [data, page, totalPages]);
  useEffect(() => {
    if (!pendingFocus || list.isFetching) return;
    const requested = pendingFocus.kind === "next"
      ? (pendingFocus.productId ? removeButtonRefs.current.get(pendingFocus.productId) : null)
      : (pendingFocus.element.isConnected ? pendingFocus.element : null);
    (requested ?? searchRef.current ?? headingRef.current)?.focus();
    setPendingFocus(null);
  }, [data, list.isFetching, page, pendingFocus]);

  const submitSearch = () => {
    setSubmittedQuery(draftQuery.trim());
    setPage(1);
  };

  return (
    <section className="page-content manual-products-page">
      <div className="page-heading manual-products-heading">
        <div><p className="eyebrow">自动分流</p><h1 ref={headingRef} tabIndex={-1}>自动跳过商品</h1><span>命中的中差评自动跳过，不回复、不投诉；好评继续自动处理</span></div>
        <div className="manual-products-actions">
          <ManualProductImportDialog trigger={<button className="button secondary" type="button"><FileSpreadsheet size={16} />导入 Excel 名单</button>} onApplied={() => setNotice("Excel 来源名单已更新")} />
          <div className="manual-add-action">
            <ManualProductForm
              catalogRevision={data?.catalogRevision ?? null}
              trigger={<button className="button primary" type="button" disabled={!data}><Plus size={16} />手工添加商品</button>}
              onSaved={(result) => setNotice(outcomeCopy[result.outcome])}
            />
            {!data && <span className="manual-catalog-loading" role="status">名单读取完成后可添加</span>}
          </div>
        </div>
      </div>

      <article className="manual-rule-callout">
        <span><UsersRound size={20} /></span>
        <div><strong>自动回复前先检查商品名单</strong><p>命中的中评和差评会由自动流程直接跳过，不生成回复或提交投诉；好评继续自动处理。</p></div>
      </article>

      <div className="manual-stats-grid" aria-label="自动跳过商品统计">
        <SummaryCard label="总商品" value={data?.stats.total} detail="当前生效名单" />
        <SummaryCard label="手工添加" value={data?.stats.manualSourceCount} detail="不会被 Excel 替换移除" />
        <SummaryCard label="Excel 导入" value={data?.stats.excelSourceCount} detail="最近一次整体替换结果" />
        <SummaryCard label="最近导入" value={data?.stats.lastImportAt ? formatManualProductDateTime(data.stats.lastImportAt) : "尚未导入"} detail="仅记录成功确认" compact />
      </div>

      {notice && <div className="manual-page-notice" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><X size={14} /></button></div>}

      <article className="panel manual-products-panel">
        <div className="manual-products-toolbar">
          <form className="manual-search-form" role="search" onSubmit={(event) => { event.preventDefault(); submitSearch(); }}>
            <label className="search-box"><Search size={16} /><input ref={searchRef} type="search" maxLength={200} aria-label="搜索商品标题或商品 ID" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="搜索商品标题或商品 ID" /></label>
            <button className="button secondary" type="submit">搜索</button>
          </form>
          <span>{data ? `${data.total} 条结果` : "正在读取名单"}</span>
        </div>

        {list.isPending && !data && <div className="empty-state spacious">正在读取自动跳过商品…</div>}
        {list.isError && <div className="empty-state spacious"><AlertTriangle size={23} /><strong>名单读取失败</strong><span>请检查本地服务后重试。</span><button className="button secondary" type="button" onClick={() => void list.refetch()}>重新读取</button></div>}
        {pageOutOfRange && <div className="empty-state spacious" role="status">名单已更新，正在返回有效页…</div>}
        {data && data.items.length === 0 && !pageOutOfRange && !submittedQuery && <div className="empty-state spacious polished"><PackageSearch size={28} /><strong>名单还是空的</strong><span>可以手工添加商品，或导入包含商品 ID 的 Excel 名单；商品标题可选。</span></div>}
        {data && data.items.length === 0 && !pageOutOfRange && submittedQuery && <div className="empty-state spacious polished"><Search size={26} /><strong>没有找到相关商品</strong><span>请检查标题或商品 ID，也可以清空搜索查看全部。</span><button className="button secondary" type="button" onClick={() => { setDraftQuery(""); setSubmittedQuery(""); setPage(1); }}>清空搜索</button></div>}
        {data && data.items.length > 0 && <div className="manual-product-list" aria-label="自动跳过商品列表">
          {data.items.map((product, index) => <article className="manual-product-row" key={product.id}>
            <div className="manual-product-identity"><strong>{product.title || "未提供商品标题"}</strong><span>{product.itemId ? `商品 ID：${product.itemId}` : "缺少商品 ID，当前不会自动匹配"}</span></div>
            <ProductSourceTags product={product} />
            <div className="manual-last-match"><Clock3 size={14} /><span>{product.lastMatchedAt ? `最近命中 ${formatManualProductDateTime(product.lastMatchedAt)}` : "尚未命中评价"}</span></div>
            <button ref={(node) => { if (node) removeButtonRefs.current.set(product.id, node); else removeButtonRefs.current.delete(product.id); }} className="text-danger manual-remove-action" type="button" aria-label={`移出 ${product.title || product.itemId || "历史名单商品"}`} onClick={(event) => {
              setNotice(null);
              remove.reset();
              setRemoveTarget({
                product,
                revision: data.catalogRevision,
                nextProductId: data.items[index + 1]?.id ?? null,
                trigger: event.currentTarget,
              });
            }}><Trash2 size={15} />移出</button>
          </article>)}
        </div>}

        {data && data.total > data.pageSize && <nav className="manual-pagination" aria-label="自动跳过商品分页">
          <button className="button secondary" type="button" aria-label="上一页" disabled={page <= 1 || list.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}><ArrowLeft size={15} />上一页</button>
          <span>第 {page} / {totalPages} 页</span>
          <button className="button secondary" type="button" aria-label="下一页" disabled={page >= totalPages || list.isFetching} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>下一页<ArrowRight size={15} /></button>
        </nav>}
      </article>

      <RemoveProductDialog
        target={removeTarget}
        pending={remove.isPending}
        errorMessage={remove.error ? toUserMessage(remove.error, "商品移出失败，请稍后重试") : null}
        onCancel={() => {
          if (remove.isPending) return;
          const trigger = removeTarget?.trigger;
          setRemoveTarget(null);
          queueMicrotask(() => trigger?.focus());
        }}
        onConfirm={() => { if (removeTarget) remove.mutate(removeTarget); }}
      />
    </section>
  );
}

function SummaryCard({ label, value, detail, compact = false }: { label: string; value: number | string | undefined; detail: string; compact?: boolean }) {
  return <article className={`manual-summary-card${compact ? " compact" : ""}`}><span>{label}</span><strong>{value ?? "—"}</strong><small>{detail}</small></article>;
}

function ProductSourceTags({ product }: { product: ManualProductItem }) {
  return <div className="manual-source-tags" aria-label={`${product.title || product.itemId || "历史名单商品"} 来源`}>{product.sources.map((source) => <span className={`manual-source-tag ${source}`} key={source}>{source === "manual" ? "手工添加" : "Excel 导入"}</span>)}</div>;
}

function RemoveProductDialog({ target, pending, errorMessage, onCancel, onConfirm }: { target: RemoveTarget | null; pending: boolean; errorMessage: string | null; onCancel: () => void; onConfirm: () => void }) {
  return <Dialog.Root open={Boolean(target)} onOpenChange={(open) => { if (!open) onCancel(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content manual-remove-dialog" role="alertdialog" aria-describedby="manual-remove-description">
        <header className="dialog-header"><div className="dialog-title-lockup"><span><Trash2 size={20} /></span><div><Dialog.Title>确认移出名单</Dialog.Title><Dialog.Description id="manual-remove-description">移出后，该商品下一轮发现的中评和差评将恢复自动处理。</Dialog.Description></div></div><button className="icon-button" type="button" aria-label="取消移出" disabled={pending} onClick={onCancel}><X size={18} /></button></header>
        <div className="dialog-scroll-body">
          <div className="remove-product-summary">
            <strong>{target?.product.title || "未提供商品标题"}</strong>
            <span>{target?.product.itemId ? `商品 ID：${target.product.itemId}` : "缺少商品 ID，当前不会自动匹配"}</span>
            {target && <ProductSourceTags product={target.product} />}
          </div>
          <p className="remove-product-warning">将从当前名单全部移除；若 Excel 文件仍含该商品，下次导入会重新加入。</p>
          {errorMessage && <div className="dialog-error" role="alert"><span>{errorMessage}</span></div>}
        </div>
        <footer className="dialog-footer"><button className="button secondary" type="button" disabled={pending} onClick={onCancel}>取消</button><button className="button primary danger" type="button" disabled={pending} onClick={onConfirm}>{pending ? "正在移出" : "确认移出"}</button></footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function formatManualProductDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
