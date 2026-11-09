import { useState } from 'react';
import { Button } from '@librechat/client';
import { dataService } from 'librechat-data-provider';
import type { TNmbRun, TNmbRunStatus } from 'librechat-data-provider';
import { parseViolation } from './prompt';
import { useLocalize } from '~/hooks';
import Charts from './Charts';
import { cn } from '~/utils';

const STATUS_KEYS = {
  ok: 'com_nmb_analysis_status_ok',
  error: 'com_nmb_analysis_status_error',
  rejected: 'com_nmb_analysis_status_rejected',
  timeout: 'com_nmb_analysis_status_timeout',
} as const satisfies Record<TNmbRunStatus, string>;

function Output({ label, text }: { label: string; text: string }) {
  if (!text) {
    return null;
  }
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-text-secondary text-xs font-medium">{label}</h4>
      <pre className="bg-surface-secondary max-h-72 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
        {text}
      </pre>
    </section>
  );
}

/** Output of one sandbox run. Real-data output is private to the user and never sent to the model. */
export default function Result({ run }: { run: TNmbRun }) {
  const localize = useLocalize();
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = async (name: string) => {
    setDownloadError(null);
    try {
      const blob = await dataService.downloadNmbRunFile(run.id, name);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError(name);
    }
  };

  return (
    <div
      className="border-border-medium flex flex-col gap-3 rounded-lg border p-4"
      aria-live="polite"
      data-testid="nmb-run-result"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{localize('com_nmb_analysis_result')}</h3>
        <span
          className={cn(
            'rounded px-2 py-0.5 text-xs font-medium',
            run.status === 'ok' ? 'bg-surface-active' : 'bg-surface-destructive text-white',
          )}
        >
          {localize(STATUS_KEYS[run.status])}
        </span>
        <span className="text-text-secondary text-xs">
          {localize(
            run.target === 'real'
              ? 'com_nmb_analysis_target_real'
              : 'com_nmb_analysis_target_synthetic',
          )}
          {' · '}
          {localize('com_nmb_analysis_duration', { 0: String(run.duration_ms) })}
        </span>
        {!run.llm_safe && (
          <span className="bg-surface-tertiary rounded px-2 py-0.5 text-xs font-medium">
            {localize('com_nmb_analysis_private')}
          </span>
        )}
      </div>
      {run.violations.length > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="text-text-secondary text-xs font-medium">
            {localize('com_nmb_analysis_violations')}
          </h4>
          <ul className="list-disc pl-5 text-sm">
            {run.violations.map((v) => {
              const { rule, line } = parseViolation(v);
              return (
                <li key={v}>
                  <code className="font-mono text-xs">{rule}</code>
                  {line != null && ` ${localize('com_nmb_analysis_line', { 0: String(line) })}`}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Output label={localize('com_nmb_analysis_stdout')} text={run.stdout} />
      <Output label={localize('com_nmb_analysis_stderr')} text={run.stderr} />
      <Charts run={run} />
      {run.files.length > 0 && (
        <section className="flex flex-col gap-1">
          <h4 className="text-text-secondary text-xs font-medium">
            {localize('com_nmb_analysis_files')}
          </h4>
          <ul className="flex flex-col gap-1">
            {run.files.map((f) => (
              <li key={f.name} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="text-text-secondary text-xs">
                  {localize('com_nmb_analysis_bytes', { 0: String(f.bytes) })}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => download(f.name)}
                  aria-label={localize('com_nmb_analysis_download_file', { 0: f.name })}
                >
                  {localize('com_nmb_analysis_download')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {downloadError && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_nmb_analysis_download_failed', { 0: downloadError })}
        </p>
      )}
    </div>
  );
}
