import type { TNmbChartSpec } from 'librechat-data-provider';
import type { PointTitle } from './Bars';
import { Axes, H, W, makeLayout, makeY } from './Frame';
import { extent, niceDomain, seriesColor } from './scale';

type Props = { spec: TNmbChartSpec; title: PointTitle };

/** Splits a series at null values so a missing figure shows as a gap, not as a zero. */
function segments(values: Array<number | null>): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (run.length) {
        out.push(run);
      }
      run = [];
    } else {
      run.push(i);
    }
  });
  if (run.length) {
    out.push(run);
  }
  return out;
}

export default function Lines({ spec, title }: Props) {
  const range = extent(spec.series.map((s) => s.values)) ?? { min: 0, max: 1 };
  const domain = niceDomain(range.min, range.max, false);
  const layout = makeLayout(spec.categories);
  const y = makeY(layout, domain);
  const n = spec.categories.length;
  const band = layout.innerW / n;
  const xAt = (i: number) => layout.left + band * i + band / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" aria-hidden="true" focusable="false">
      <Axes layout={layout} domain={domain} categories={spec.categories} xAt={xAt} />
      {spec.series.map((s, si) => (
        <g key={`${s.name}-${si}`} stroke={seriesColor(si)} fill={seriesColor(si)}>
          {segments(s.values).map((run) =>
            run.length > 1 ? (
              <polyline
                key={run[0]}
                points={run.map((i) => `${xAt(i)},${y(s.values[i] as number)}`).join(' ')}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeDasharray={si >= 6 ? '6 3' : undefined}
              />
            ) : null,
          )}
          {s.values.map((v, i) =>
            v == null ? null : (
              <circle key={i} cx={xAt(i)} cy={y(v)} r={3.5} stroke="none">
                <title>{title(si, i, v)}</title>
              </circle>
            ),
          )}
        </g>
      ))}
    </svg>
  );
}
