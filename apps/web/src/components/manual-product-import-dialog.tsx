import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, FileSpreadsheet, LoaderCircle, RefreshCw, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { ApiError, apiFetch, toUserMessage } from "../api/client";

type ImportSample = { id?: string; itemId: string | null; title: string };
type ImportPreview = {
  canApply: boolean;
  previewId: string | null;
  catalogRevision: number;
  worksheetName: string;
  summary: { added: number; retained: number; removed: number; conflicts: number };
  samples: { added: ImportSample[]; retained: ImportSample[]; removed: ImportSample[]; conflicts: ImportSample[] };
};
type LocalPickerPreview = { cancelled: true } | (ImportPreview & { cancelled: false; displayFilename: string });

type ManualProductImportDialogProps = {
  trigger: ReactElement;
  onApplied?: () => void;
};

const acceptedExtension = /\.xlsx$/iu;

export function ManualProductImportDialog({ trigger, onApplied }: ManualProductImportDialogProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [localPickerPending, setLocalPickerPending] = useState(false);
  const [applyPending, setApplyPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationGeneration = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    operationGeneration.current += 1;
    setFile(null);
    setSelectedFilename(null);
    setPreview(null);
    setPreviewPending(false);
    setLocalPickerPending(false);
    setApplyPending(false);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const chooseFile = (next: File | null) => {
    const generation = ++operationGeneration.current;
    setPreview(null);
    setError(null);
    setPreviewPending(false);
    if (!next) {
      setFile(null);
      setSelectedFilename(null);
      return;
    }
    if (!acceptedExtension.test(next.name)) {
      setFile(null);
      setSelectedFilename(null);
      setError("请选择 .xlsx 格式的 Excel 文件");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFile(next);
    setSelectedFilename(next.name);
    void requestUploadPreview(next, generation);
  };

  const requestUploadPreview = async (next: File, generation: number) => {
    setPreviewPending(true);
    const form = new FormData();
    form.append("file", next);
    try {
      const result = await apiFetch<ImportPreview>("/api/manual-products/import/preview", { method: "POST", body: form });
      if (operationGeneration.current !== generation) return;
      setPreview(result);
    } catch (failure) {
      if (operationGeneration.current !== generation) return;
      setError(toUserMessage(failure, "无法预览该名单，请检查文件后重试"));
    } finally {
      if (operationGeneration.current === generation) setPreviewPending(false);
    }
  };

  const requestLocalPreview = async () => {
    if (localPickerPending || applyPending) return;
    const generation = ++operationGeneration.current;
    setError(null);
    setPreviewPending(false);
    setLocalPickerPending(true);
    try {
      const result = await apiFetch<LocalPickerPreview>("/api/manual-products/import/select-and-preview", { method: "POST" });
      if (operationGeneration.current !== generation || result.cancelled) return;
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      setSelectedFilename(result.displayFilename);
      setPreview(result);
    } catch (failure) {
      if (operationGeneration.current !== generation) return;
      const pickerDidNotSelectAFile = failure instanceof ApiError && [
        "manual_product_local_picker_unavailable",
        "manual_product_local_picker_failed",
      ].includes(failure.code);
      if (!pickerDidNotSelectAFile) {
        setFile(null);
        setSelectedFilename(null);
        setPreview(null);
        if (inputRef.current) inputRef.current.value = "";
      }
      setError(toUserMessage(failure, "无法打开本机文件选择窗口，请使用浏览器上传（备用）"));
    } finally {
      if (operationGeneration.current === generation) setLocalPickerPending(false);
    }
  };

  const apply = async () => {
    if (!preview?.canApply || !preview.previewId || applyPending) return;
    const previewId = preview.previewId;
    const generation = ++operationGeneration.current;
    setApplyPending(true);
    setError(null);
    try {
      await apiFetch("/api/manual-products/import/apply", {
        method: "POST",
        body: JSON.stringify({ previewId }),
      }, { replayOnSessionRecovery: false });
      if (operationGeneration.current !== generation) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["manual-products"] }),
        queryClient.invalidateQueries({ queryKey: ["manual-product-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      onApplied?.();
      setOpen(false);
    } catch (failure) {
      if (operationGeneration.current !== generation) return;
      // Apply tokens are one-use. Any failed response must force a fresh preview.
      setPreview(null);
      setError(toUserMessage(failure, "名单更新未完成，请重新选择文件后再试"));
    } finally {
      if (operationGeneration.current === generation) setApplyPending(false);
    }
  };

  const busy = localPickerPending || applyPending;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content manual-product-import-dialog" aria-describedby="manual-import-description">
          <header className="dialog-header">
            <div className="dialog-title-lockup"><span><FileSpreadsheet size={20} /></span><div>
              <Dialog.Title>导入 Excel 名单</Dialog.Title>
              <Dialog.Description id="manual-import-description">按商品 ID 预览并更新 Excel 来源名单；手工添加不受影响。</Dialog.Description>
            </div></div>
            <Dialog.Close asChild><button className="icon-button" type="button" aria-label="关闭 Excel 导入" disabled={busy}><X size={18} /></button></Dialog.Close>
          </header>
          <div className="dialog-scroll-body import-dialog-body">
            <section className="local-picker-step">
              <div><strong>从电脑选择 Excel</strong><small>{selectedFilename ? `已选择：${selectedFilename}` : "打开本机文件窗口，选中后自动预览名单变化"}</small></div>
              <button className="button primary" type="button" disabled={busy} onClick={() => void requestLocalPreview()}>
                {localPickerPending ? <LoaderCircle className="spin" size={16} /> : <FileSpreadsheet size={16} />}
                {localPickerPending ? "等待选择文件" : "从电脑选择 Excel"}
              </button>
            </section>
            <section className="browser-upload-fallback" aria-label="浏览器上传备用入口">
              <div className="browser-upload-heading"><strong>浏览器上传（备用）</strong><small>系统文件窗口无法打开时使用；选择后会自动预览。</small></div>
              <div className="file-picker">
                <span><Upload size={18} /></span>
                <div><strong>{file?.name ?? "尚未选择文件"}</strong><small>文件最大 5MB；必须包含商品 ID，商品标题可选</small></div>
                <input
                  ref={inputRef}
                  className="file-picker-input"
                  aria-label="浏览器上传（备用）"
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                  disabled={busy}
                />
              </div>
              {previewPending && <span className="inline-pending"><LoaderCircle className="spin" size={14} />正在预览名单</span>}
            </section>

            {preview && <section className="import-preview" aria-label="Excel 名单变化预览">
              <div className="import-preview-heading"><div><p className="eyebrow">差异预览</p><h3>{preview.worksheetName}</h3></div><span>{preview.canApply ? "可以更新" : "需要修正"}</span></div>
              <div className="import-diff-grid">
                <DiffCount label="新增" value={preview.summary.added} tone="success" />
                <DiffCount label="保留" value={preview.summary.retained} />
                <DiffCount label="移除" value={preview.summary.removed} tone="warning" />
                <DiffCount label="冲突" value={preview.summary.conflicts} tone="danger" />
              </div>
              <div className="import-samples">
                <SampleGroup title="新增示例" items={preview.samples.added} />
                <SampleGroup title="保留示例" items={preview.samples.retained} />
                <SampleGroup title="移除示例" items={preview.samples.removed} />
                <SampleGroup title="冲突示例" items={preview.samples.conflicts} />
              </div>
              {!preview.canApply && <div className="dialog-error" role="alert"><AlertTriangle size={16} /><span>发现 {preview.summary.conflicts} 条冲突，请修正 Excel 后重新选择文件</span></div>}
              <p className="import-safety-note"><Check size={15} />手工添加的商品不会被本次替换移除</p>
            </section>}

            {error && <div className="dialog-error" role="alert"><span>{error}</span>{!preview && <button type="button" onClick={reset}><RefreshCw size={14} />重新选择文件</button>}</div>}
          </div>
          <footer className="dialog-footer">
            <Dialog.Close asChild><button className="button secondary" type="button" disabled={busy}>取消</button></Dialog.Close>
            <button className="button primary" type="button" disabled={!preview?.canApply || !preview.previewId || previewPending || busy} onClick={() => void apply()}>
              {applyPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{applyPending ? "正在更新" : "确认更新 Excel 名单"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DiffCount({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return <div className={`import-diff-count ${tone}`}><span>{label}</span><strong>{label} {value}</strong></div>;
}

function SampleGroup({ title, items }: { title: string; items: ImportSample[] }) {
  if (!items.length) return null;
  return <div className="import-sample-group"><strong>{title}</strong>{items.map((item, index) => <div key={`${item.id ?? item.itemId ?? item.title}-${index}`}><span>{item.title || "未提供商品标题"}</span><small>{item.itemId ? `ID ${item.itemId}` : "缺少商品 ID，当前不会自动匹配"}</small></div>)}</div>;
}
