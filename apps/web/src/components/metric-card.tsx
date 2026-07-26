export function MetricCard({ label, value, detail, tone = "paper" }: { label: string; value: string | number; detail: string; tone?: "paper" | "ink" | "rose" }) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}
