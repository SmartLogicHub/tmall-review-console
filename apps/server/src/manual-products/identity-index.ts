import { type ManualProductIdentity } from "@tmall/domain";

export class ManualProductIdentityIndex<
  T extends ManualProductIdentity & { id: string },
> {
  private readonly rows = new Map<string, T>();
  private readonly order = new Map<string, number>();
  private readonly byItemId = new Map<string, Set<string>>();
  private nextOrder = 0;

  constructor(rows: readonly T[]) {
    for (const row of rows) this.add(row);
  }

  candidates(identity: ManualProductIdentity): T[] {
    const ids = new Set<string>();
    const itemId = normalizedItemId(identity.itemId);
    if (itemId) for (const id of this.byItemId.get(itemId) ?? []) ids.add(id);
    return [...ids]
      .sort((left, right) => this.order.get(left)! - this.order.get(right)!)
      .map((id) => this.rows.get(id)!);
  }

  add(row: T): void {
    this.rows.set(row.id, row);
    if (!this.order.has(row.id)) {
      this.order.set(row.id, this.nextOrder);
      this.nextOrder += 1;
    }
    this.addTo(this.byItemId, normalizedItemId(row.itemId), row.id);
  }

  replace(row: T): void {
    this.removeFromCandidates(row.id);
    this.add(row);
  }

  remove(id: string): void {
    this.removeFromCandidates(id);
    this.rows.delete(id);
    this.order.delete(id);
  }

  private removeFromCandidates(id: string): void {
    const previous = this.rows.get(id);
    if (!previous) return;
    this.removeFrom(this.byItemId, normalizedItemId(previous.itemId), id);
  }

  private addTo(index: Map<string, Set<string>>, key: string | null, id: string): void {
    if (!key) return;
    const ids = index.get(key) ?? new Set<string>();
    ids.add(id);
    index.set(key, ids);
  }

  private removeFrom(index: Map<string, Set<string>>, key: string | null, id: string): void {
    if (!key) return;
    const ids = index.get(key);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) index.delete(key);
  }
}

function normalizedItemId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}
