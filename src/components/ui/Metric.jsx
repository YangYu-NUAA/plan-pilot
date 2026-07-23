export function Metric({ label, value, tone = "" }) {
  return (
    <article className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

// 今日完成环：SVG 圆环实时显示完成进度，满格时变绿并弹一下
export function MetricRing({ done, total }) {
  const R = 15.5;
  const C = 2 * Math.PI * R;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const full = total > 0 && done >= total;
  return (
    <article className={`metric metric-ring${full ? " is-full" : ""}`}>
      <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">
        <circle className="ring-track" cx="20" cy="20" r={R} fill="none" strokeWidth="5" />
        <circle
          className="ring-bar"
          cx="20" cy="20" r={R} fill="none" strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - ratio)}
          transform="rotate(-90 20 20)"
        />
      </svg>
      <div className="metric-ring-text">
        <span>完成/总数</span>
        <strong>{done}/{total}</strong>
      </div>
    </article>
  );
}

