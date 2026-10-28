/** A chart legend's sample of one line, in its color and its dash, where two
 *  lines would otherwise be told apart by hue alone (gold beside orange or
 *  coral is about 1.1 to 1.3:1). Its words name the line; this is decoration. */
export function LegendLine({ color, dash }: { color: string; dash: string }) {
  return (
    <svg className="chart-legend-line" width={16} height={4} viewBox="0 0 16 4" aria-hidden="true" focusable="false">
      <line x1={2} x2={14} y1={2} y2={2} stroke={color} strokeWidth={2} strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
}
