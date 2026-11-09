import { useMutation, useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService, parseNmbChartSpec } from 'librechat-data-provider';
import type {
  UseQueryOptions,
  UseMutationResult,
  UseMutationOptions,
  QueryObserverResult,
} from '@tanstack/react-query';
import type { TNmbChartParse, TNmbChartSpec, TNmbReportFormat } from 'librechat-data-provider';

export type NmbReportExportVars = { format: TNmbReportFormat; spec: TNmbChartSpec };

/** Renders the chart on the server and returns the file. Nothing is cached or invalidated. */
export const useNmbReportExportMutation = (
  options?: UseMutationOptions<Blob, unknown, NmbReportExportVars>,
): UseMutationResult<Blob, unknown, NmbReportExportVars> =>
  useMutation(({ format, spec }) => dataService.exportNmbReport(format, spec), options);

/**
 * A chart a run saved with `save_chart`. Real-run values must not outlive the panel that shows
 * them, so nothing is kept (`cacheTime: 0`) and nothing refetches. A file that is not a valid
 * spec resolves to `{ ok: false }` rather than failing the query.
 */
export const useNmbRunChartQuery = (
  runId: string,
  name: string,
  config?: UseQueryOptions<TNmbChartParse>,
): QueryObserverResult<TNmbChartParse> =>
  useQuery<TNmbChartParse>(
    [QueryKeys.nmbRunChart, runId, name],
    async () => parseNmbChartSpec(await (await dataService.downloadNmbRunFile(runId, name)).text()),
    {
      cacheTime: 0,
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      ...config,
    },
  );
