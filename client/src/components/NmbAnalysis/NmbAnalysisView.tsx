import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Spinner } from '@librechat/client';
import {
  useNmbRunQuery,
  useNmbMeQuery,
  useNmbDatasetsQuery,
  useNmbAnalysisLimitsQuery,
  useDeleteNmbDatasetMutation,
} from '~/data-provider';
import { useDocumentTitle, useLocalize } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import Upload from './Upload';
import Result from './Result';
import Runner from './Runner';
import Twin from './Twin';
import { cn } from '~/utils';

/**
 * Synthetic-data analysis. The model only ever sees a synthetic twin; code it writes runs on the
 * real data inside the scanner sandbox. The server enforces ownership and the feature flag.
 */
export default function NmbAnalysisView() {
  const localize = useLocalize();
  const isSmallScreen = useDrawerViewport();
  const { data: me, isLoading: meLoading } = useNmbMeQuery();
  const [params] = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(params.get('dataset'));
  const enabled = me?.enabled === true && me.analysis === true;
  const { data, isLoading, isError, refetch } = useNmbDatasetsQuery({ enabled });
  // A chat agent that ran code on the real data links here with ?run=: the result is shown to the user only.
  const runId = params.get('run') ?? undefined;
  const chatRun = useNmbRunQuery(enabled ? runId : undefined);
  const { data: limits } = useNmbAnalysisLimitsQuery({ enabled });
  const remove = useDeleteNmbDatasetMutation({ onSuccess: () => setOpenId(null) });
  useDocumentTitle(`${localize('com_nmb_analysis_title')} | LibreChat`);

  if (meLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  }
  if (!enabled) {
    return (
      <div
        role="status"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p className="text-text-secondary text-sm">{localize('com_nmb_analysis_disabled')}</p>
      </div>
    );
  }

  const items = data?.items ?? [];
  const selected = items.find((d) => d.id === openId) ?? null;

  return (
    <div className="bg-surface-primary-alt text-text-primary flex h-full w-full min-w-0 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 px-4 py-3 sm:px-5 md:px-6 lg:px-8">
        {isSmallScreen && <OpenSidebar />}
        <h1 className="text-base font-semibold">{localize('com_nmb_analysis_title')}</h1>
      </header>
      <p className="text-text-secondary px-4 pb-3 text-sm sm:px-5 md:px-6 lg:px-8">
        {localize('com_nmb_analysis_intro')}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 pb-4 sm:px-5 md:flex-row md:px-6 lg:px-8">
        <nav
          className="flex shrink-0 flex-col gap-2 md:w-80"
          aria-label={localize('com_nmb_analysis_datasets')}
        >
          <Upload maxBytes={limits?.max_upload_bytes} onUploaded={(d) => setOpenId(d.id)} />
          {isLoading && <Spinner className="size-5" />}
          {isError && (
            <Button type="button" variant="outline" onClick={() => refetch()}>
              {localize('com_nmb_analysis_load_failed')}
            </Button>
          )}
          {!isLoading && !isError && items.length === 0 && (
            <p className="text-text-secondary text-sm">{localize('com_nmb_analysis_empty')}</p>
          )}
          <ul className="flex flex-col gap-1 overflow-y-auto">
            {items.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  aria-current={d.id === openId}
                  onClick={() => setOpenId(d.id)}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-start text-sm',
                    d.id === openId ? 'bg-surface-active' : 'hover:bg-surface-hover',
                  )}
                >
                  <span className="block truncate font-medium">{d.name}</span>
                  <span className="text-text-secondary text-xs">
                    {localize('com_nmb_analysis_rows_count', { 0: String(d.rows) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-h-0 flex-1 overflow-y-auto">
          {runId != null && (
            <section className="mb-6 flex flex-col gap-2" aria-labelledby="nmb-chat-run-title">
              <h2 id="nmb-chat-run-title" className="text-base font-semibold">
                {localize('com_nmb_analysis_chat_run')}
              </h2>
              {chatRun.isLoading && <Spinner className="size-5" />}
              {chatRun.isError && (
                <p role="alert" className="text-text-destructive text-sm">
                  {localize('com_nmb_analysis_chat_run_failed')}
                </p>
              )}
              {chatRun.data && <Result run={chatRun.data} />}
            </section>
          )}
          {!selected ? (
            <p className="text-text-secondary text-sm">{localize('com_nmb_analysis_select')}</p>
          ) : (
            <div key={selected.id} className="flex flex-col gap-6">
              <div className="flex items-center justify-between gap-3">
                <h2 className="truncate text-base font-semibold">{selected.name}</h2>
                <Button
                  type="button"
                  variant="outline"
                  disabled={remove.isLoading}
                  onClick={() => remove.mutate(selected.id)}
                >
                  {localize('com_nmb_analysis_delete')}
                </Button>
              </div>
              {remove.isError && (
                <p role="alert" className="text-text-destructive text-sm">
                  {localize('com_nmb_analysis_delete_failed')}
                </p>
              )}
              <Twin dataset={selected} limits={limits} />
              <Runner
                datasetId={selected.id}
                hasSynthetic={selected.synthetic != null}
                limits={limits}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
