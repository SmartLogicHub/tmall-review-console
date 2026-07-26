export function StatusPill({ tone, children }: { tone: "neutral" | "success" | "warning" | "danger" | "rose"; children: React.ReactNode }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}
