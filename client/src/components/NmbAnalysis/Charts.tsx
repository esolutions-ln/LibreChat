import type { TNmbRun } from 'librechat-data-provider';
import { useNmbMeQuery, useNmbRunChartQuery } from '~/data-provider';
import { ChartCard } from '~/components/NmbReports';
import { useLocalize } from '~/hooks';

const CHART_FILE = /\.chart\.json$/;

export const chartFiles = (run: TNmbRun): string[] =>
  run.files.map((f) => f.name).filter((name) => CHART_FILE.test(name));

function ChartFile({
  runId,
  name,
  exportable,
}: {
  runId: string;
  name: string;
  exportable: boolean;
}) {
  const localize = useLocalize();
  const { data, isLoading, isError } = useNmbRunChartQuery(runId, name);

  if (isLoading) {
    return (
      <p role="status" className="text-text-secondary text-sm">
        {localize('com_nmb_analysis_chart_loading', { 0: name })}
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="text-text-destructive text-sm">
        {localize('com_nmb_analysis_chart_failed', { 0: name })}
      </p>
    );
  }
  if (!data?.ok) {
    return (
      <p role="alert" className="text-text-destructive text-sm">
        {localize('com_nmb_analysis_chart_invalid', { 0: name })}
      </p>
    );
  }
  return <ChartCard spec={data.spec} exportable={exportable} />;
}

function ChartList({ run, names }: { run: TNmbRun; names: string[] }) {
  const localize = useLocalize();
  const { data: me } = useNmbMeQuery();
  return (
    <section className="flex flex-col gap-2" aria-label={localize('com_nmb_analysis_charts')}>
      <h4 className="text-text-secondary text-xs font-medium">
        {localize('com_nmb_analysis_charts')}
      </h4>
      {names.map((name) => (
        <ChartFile key={name} runId={run.id} name={name} exportable={Boolean(me?.reports)} />
      ))}
    </section>
  );
}

/**
 * Charts a run saved with `save_chart`, shown inline. They render even when reports are off; only
 * the Excel/PDF export needs the reports feature. A run without charts renders nothing and calls
 * no query hook.
 */
export default function Charts({ run }: { run: TNmbRun }) {
  const names = chartFiles(run);
  return names.length === 0 ? null : <ChartList run={run} names={names} />;
}
