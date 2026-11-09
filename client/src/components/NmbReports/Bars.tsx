import type { TNmbChartSpec } from 'librechat-data-provider';
import { Axes, H, W, makeLayout, makeY } from './Frame';
import { extent, niceDomain, seriesColor, stackExtent } from './scale';

export type PointTitle = (series: number, category: number, value: number) => string;

type Props = { spec: TNmbChartSpec; stacked: boolean; title: PointTitle };

/** Grouped or stacked columns. Null values leave a gap; values are exposed through `<title>`. */
export default function Bars({ spec, stacked, title }: Props) {
  const rows = spec.series.map((s) => s.values);
  const range = (stacked ? stackExtent(rows) : extent(rows)) ?? { min: 0, max: 1 };
  const domain = niceDomain(range.min, range.max, true);
  const layout = makeLayout(spec.categories);
  const y = makeY(layout, domain);
  const n = spec.categories.length;
  const band = layout.innerW / n;
  const group = band * 0.8;
  const barW = stacked ? group : group / spec.series.length;
  const xAt = (i: number) => layout.left + band * i + band / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" aria-hidden="true" focusable="false">
      <Axes layout={layout} domain={domain} categories={spec.categories} xAt={xAt} />
      {spec.categories.map((_, c) => {
        let pos = 0;
        let neg = 0;
        return spec.series.map((s, si) => {
          const v = s.values[c];
          if (v == null) {
            return null;
          }
          let top: number;
          let bottom: number;
          if (stacked) {
            const from = v >= 0 ? pos : neg;
            if (v >= 0) {
              pos += v;
            } else {
              neg += v;
            }
            top = y(Math.max(from, from + v));
            bottom = y(Math.min(from, from + v));
          } else {
            top = y(Math.max(0, v));
            bottom = y(Math.min(0, v));
          }
          const x = stacked ? xAt(c) - group / 2 : xAt(c) - group / 2 + si * barW;
          return (
            <rect
              key={`${c}-${si}`}
              x={x}
              y={top}
              width={Math.max(1, barW - 1)}
              height={Math.max(1, bottom - top)}
              fill={seriesColor(si)}
            >
              <title>{title(si, c, v)}</title>
            </rect>
          );
        });
      })}
    </svg>
  );
}
