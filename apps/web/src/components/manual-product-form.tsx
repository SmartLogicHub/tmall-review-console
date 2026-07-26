import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, PackagePlus, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { ApiError, apiFetch, toUserMessage } from "../api/client";

export type ManualProductItem = {
  id: string;
  itemId: string | null;
  title: string;
  sources: Array<"manual" | "excel">;
  createdAt?: string;
  updatedAt?: string;
  lastMatchedAt: string | null;
};

type ManualProductFormProps = {
  catalogRevision: number | null;
  trigger: ReactElement;
  onSaved?: (result: CreateResult) => void;
};

type CreateResult = {
  outcome: "created" | "reused" | "enriched" | "merged";
  product: ManualProductItem;
  catalogRevision: number;
};

export function ManualProductForm({ catalogRevision, trigger, onSaved }: ManualProductFormProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [itemId, setItemId] = useState("");
  const [frozenRevision, setFrozenRevision] = useState<number | null>(null);
  const itemIdRef = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: () => {
      if (frozenRevision === null) throw new Error("名单尚未加载，请稍后重试");
      return apiFetch<CreateResult>("/api/manual-products", {
        method: "POST",
        body: JSON.stringify({ itemId: itemId.trim(), title: title.trim(), expectedRevision: frozenRevision }),
      }, { replayOnSessionRecovery: false });
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["manual-products"] }),
        queryClient.invalidateQueries({ queryKey: ["manual-product-summary"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      onSaved?.(result);
      setOpen(false);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "manual_product_catalog_changed") {
        await queryClient.invalidateQueries({ queryKey: ["manual-products"] });
      }
    },
  });

  useEffect(() => {
    if (open) return;
    setTitle("");
    setItemId("");
    setFrozenRevision(null);
    save.reset();
  }, [open]);

  const conflict = save.error instanceof ApiError && save.error.code === "manual_product_catalog_changed";
  const errorMessage = conflict
    ? "名单已在其他页面更新。请关闭后重新添加，系统不会自动重复提交。"
    : save.error ? toUserMessage(save.error, "商品保存失败，请稍后重试") : null;
  const canSave = Boolean(itemId.trim()) && itemId.trim().length <= 200
    && frozenRevision !== null && !save.isPending && !conflict;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      if (save.isPending) return;
      if (next) setFrozenRevision(catalogRevision);
      setOpen(next);
    }}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content manual-product-form-dialog"
          aria-describedby="manual-product-form-description"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            itemIdRef.current?.focus();
          }}
        >
          <header className="dialog-header">
            <div className="dialog-title-lockup"><span><PackagePlus size={20} /></span><div>
              <Dialog.Title>添加自动跳过商品</Dialog.Title>
              <Dialog.Description id="manual-product-form-description">系统只按商品 ID 匹配；标题变化不会影响名单。</Dialog.Description>
            </div></div>
            <Dialog.Close asChild><button className="icon-button" type="button" aria-label="关闭添加商品" disabled={save.isPending}><X size={18} /></button></Dialog.Close>
          </header>
          <div className="dialog-scroll-body manual-product-form-fields">
            <label className="field"><span>商品 ID（必填）</span><input ref={itemIdRef} aria-label="商品 ID（必填）" maxLength={200} value={itemId} onChange={(event) => { setItemId(event.target.value); save.reset(); }} placeholder="填写天猫商品 ID" /></label>
            <label className="field"><span>商品标题（选填，仅用于辨认）</span><input aria-label="商品标题（选填，仅用于辨认）" maxLength={500} value={title} onChange={(event) => { setTitle(event.target.value); save.reset(); }} placeholder="可填写当前商品标题，后续变化不影响匹配" /></label>
            <p className="dialog-note">加入名单后，命中的中差评自动跳过，不回复、不投诉；好评继续自动处理。</p>
            {errorMessage && <div className="dialog-error" role="alert"><span>{errorMessage}</span>{conflict && <Dialog.Close asChild><button type="button"><RefreshCw size={14} />重新打开</button></Dialog.Close>}</div>}
          </div>
          <footer className="dialog-footer">
            <Dialog.Close asChild><button className="button secondary" type="button" disabled={save.isPending}>取消</button></Dialog.Close>
            <button className="button primary" type="button" disabled={!canSave} onClick={() => save.mutate()}>
              {save.isPending ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{save.isPending ? "正在添加" : "添加到名单"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
