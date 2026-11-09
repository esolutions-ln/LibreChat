import { useId, useMemo, useState } from 'react';
import { Button } from '@librechat/client';
import { parseNmbChartSpec } from 'librechat-data-provider';
import type { TNmbChartSpec } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { PointTitle } from './Bars';
import { formatValue, seriesColor } from './scale';
import { useNmbMeQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import Export from './Export';
import Lines from './Lines';
import Bars from './Bars';
import Pie from './Pie';

type Props = {
  /** The raw JSON inside the fence. */
  code: string;
  /** What to show when this is not a chart (reports off, partial or invalid JSON). */
  fallback: ReactNode;
};

function Plot({ spec, point }: { spec: TNmbChartSpec; point: PointTitle }) {
  if (spec.type === 'pie') {
    return <Pie spec={spec} title={(c, v) => point(0, c, v)} />;
  }
  if (spec.type === 'line') {
    return <Lines spec={spec} title={point} />;
  }
  return <Bars spec={spec} stacked={spec.type === 'stacked_bar'} title={point} />;
}

type ChartCardProps = {
  spec: TNmbChartSpec;
  /** Show the Excel/PDF buttons. Defaults to true. */
  exportable?: boolean;
};

/** A validated chart with legend, data table, optional export and a note on where the figures came from. */
export function ChartCard({ spec, exportable = true }: ChartCardProps) {
  const localize = useLocalize();
  const tableId = useId();
  const [showData, setShowData] = useState(false);
  const isPie = spec.type === 'pie';
  const total = isPie ? spec.series[0].values.reduce<number>((a, v) => a + (v ?? 0), 0) : 0;

  const point = (series: number, category: number, value: number): string =>
    localize('com_nmb_report_value_title', {
      0: spec.series[series].name,
      1: spec.categories[category],
      2: formatValue(value),
    });

  return (
    <figure
      className="border-border-light bg-surface-primary my-3 flex flex-col gap-3 rounded-lg border p-3"
      aria-label={localize('com_nmb_report_chart_label', { 0: spec.title })}
    >
      <figcaption className="flex flex-col gap-0.5">
        <span className="text-text-primary text-sm font-semibold">{spec.title}</span>
        {spec.unit && (
          <span className="text-text-secondary text-xs">
            {localize('com_nmb_report_unit', { 0: spec.unit })}
          </span>
        )}
      </figcaption>

      <Plot spec={spec} point={point} />

      <ul className="text-text-secondary flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-hidden="true">
        {(isPie ? spec.categories : spec.series.map((s) => s.name)).map((name, i) => (
          <li key={`${name}-${i}`} className="flex items-center gap-1.5">
            <svg viewBox="0 0 10 10" className="size-2.5 shrink-0" aria-hidden="true">
              <rect width="10" height="10" rx="2" fill={seriesColor(i)} />
            </svg>
            {name}
            {isPie &&
              total > 0 &&
              ` (${Math.round(((spec.series[0].values[i] ?? 0) / total) * 100)}%)`}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          aria-expanded={showData}
          aria-controls={tableId}
          onClick={() => setShowData((v) => !v)}
        >
          {localize(showData ? 'com_nmb_report_hide_data' : 'com_nmb_report_show_data')}
        </Button>
        <div className={showData ? 'max-h-72 overflow-auto' : undefined}>
          <table id={tableId} className={showData ? 'w-full text-left text-xs' : 'sr-only'}>
            <caption className="sr-only">
              {localize('com_nmb_report_table_caption', { 0: spec.title })}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="text-text-secondary pr-3 pb-1 font-medium">
                  {localize('com_nmb_report_category')}
                </th>
                {spec.series.map((s, i) => (
                  <th
                    key={`${s.name}-${i}`}
                    scope="col"
                    className="text-text-secondary px-2 pb-1 font-medium"
                  >
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.categories.map((c, ci) => (
                <tr key={`${c}-${ci}`} className="border-border-light border-t">
                  <th scope="row" className="text-text-primary py-1 pr-3 font-normal">
                    {c}
                  </th>
                  {spec.series.map((s, si) => (
                    <td key={si} className="text-text-primary px-2 py-1 tabular-nums">
                      {s.values[ci] == null ? '' : formatValue(s.values[ci] as number)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {spec.source && (
        <p className="text-text-secondary text-xs">
          {localize('com_nmb_report_source', { 0: spec.source })}
        </p>
      )}
      {exportable && <Export spec={spec} />}
      <p className="text-text-secondary text-xs">
        {localize(
          spec.origin === 'computed' ? 'com_nmb_report_computed_note' : 'com_nmb_report_check_note',
        )}
      </p>
    </figure>
  );
}

/**
 * An `nmb-chart` fence rendered as a chart. It only takes over when reports are enabled and the JSON
 * is a complete, valid spec; a block that is still streaming, or malformed, stays an ordinary code block.
 */
export default function NmbChart({ code, fallback }: Props) {
  const { data: me } = useNmbMeQuery();
  const parsed = useMemo(() => parseNmbChartSpec(code), [code]);
  if (!me?.reports || !parsed.ok) {
    return <>{fallback}</>;
  }
  return <ChartCard spec={parsed.spec} />;
}
