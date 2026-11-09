import { useState } from 'react';
import { Button } from '@librechat/client';
import type { TNmbChartSpec, TNmbReportFormat } from 'librechat-data-provider';
import { useNmbReportExportMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { fileSlug } from './scale';

/** Hands a blob to the browser as a download, then releases the object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type ExportError =
  | 'com_nmb_report_rate_limited'
  | 'com_nmb_report_unavailable'
  | 'com_nmb_report_export_failed';

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

function errorKey(error: unknown): ExportError {
  const status = statusOf(error);
  if (status === 429) {
    return 'com_nmb_report_rate_limited';
  }
  if (status === 503) {
    return 'com_nmb_report_unavailable';
  }
  return 'com_nmb_report_export_failed';
}

/** Excel and PDF exports of the chart, rendered by the scanner from the validated spec. */
export default function Export({ spec }: { spec: TNmbChartSpec }) {
  const localize = useLocalize();
  const [error, setError] = useState<ExportError | null>(null);
  const [pending, setPending] = useState<TNmbReportFormat | null>(null);
  const mutation = useNmbReportExportMutation();

  const run = (format: TNmbReportFormat) => {
    setError(null);
    setPending(format);
    mutation.mutate(
      { format, spec },
      {
        onSuccess: (blob) => saveBlob(blob, `${fileSlug(spec.title)}.${format}`),
        onError: (e) => setError(errorKey(e)),
        onSettled: () => setPending(null),
      },
    );
  };

  const busy = pending != null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run('xlsx')}
        >
          {localize('com_nmb_report_download_xlsx')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run('pdf')}
        >
          {localize('com_nmb_report_download_pdf')}
        </Button>
        {busy && (
          <span className="text-text-secondary text-xs" role="status">
            {localize('com_nmb_report_exporting')}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-text-destructive text-xs">
          {localize(error)}
        </p>
      )}
    </div>
  );
}
