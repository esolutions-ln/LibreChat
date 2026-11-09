import type { TNmbChartSpec } from 'librechat-data-provider';
import { seriesColor } from './scale';

const R = 120;
const C = 150;

type Props = { spec: TNmbChartSpec; title: (category: number, value: number) => string };

const point = (angle: number): string =>
  `${C + R * Math.cos(angle - Math.PI / 2)},${C + R * Math.sin(angle - Math.PI / 2)}`;

/** One pie of the first series. Slices are keyed to the legend by category index. */
export default function Pie({ spec, title }: Props) {
  const values = spec.series[0].values.map((v) => (v == null ? 0 : v));
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return null;
  }
  let start = 0;
  return (
    <svg viewBox="0 0 300 300" className="mx-auto h-auto w-full max-w-xs" aria-hidden="true">
      {values.map((v, i) => {
        if (v <= 0) {
          return null;
        }
        const sweep = (v / total) * Math.PI * 2;
        const from = start;
        start += sweep;
        const shape =
          sweep >= Math.PI * 2 - 1e-6 ? (
            <circle cx={C} cy={C} r={R} fill={seriesColor(i)} />
          ) : (
            <path
              d={`M${C},${C} L${point(from)} A${R},${R} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(from + sweep)} Z`}
              fill={seriesColor(i)}
              className="stroke-surface-primary"
              strokeWidth={1}
            />
          );
        return (
          <g key={i}>
            {shape}
            <title>{title(i, v)}</title>
          </g>
        );
      })}
    </svg>
  );
}
