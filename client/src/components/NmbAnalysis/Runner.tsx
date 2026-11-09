import { useState } from 'react';
import { Button, OGDialog, OGDialogTemplate, Textarea } from '@librechat/client';
import type { TNmbRun, TNmbRunTarget, TNmbAnalysisLimits } from 'librechat-data-provider';
import { useExecuteNmbDatasetMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import Result from './Result';

type Props = {
  datasetId: string;
  hasSynthetic: boolean;
  limits?: TNmbAnalysisLimits;
};

/** Paste the code the assistant wrote, test it on the synthetic twin, then run it on the real data. */
export default function Runner({ datasetId, hasSynthetic, limits }: Props) {
  const localize = useLocalize();
  const [code, setCode] = useState('');
  const [run, setRun] = useState<TNmbRun | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const execute = useExecuteNmbDatasetMutation();
  const maxChars = limits?.max_code_chars;
  const tooLong = maxChars != null && code.length > maxChars;
  const disabled = !code.trim() || tooLong || execute.isLoading;

  const submit = (target: TNmbRunTarget) => {
    setRun(null);
    execute.mutate(
      { id: datasetId, body: { code, target } },
      { onSuccess: (data) => setRun(data) },
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="nmb-runner-title">
      <h2 id="nmb-runner-title" className="text-sm font-semibold">
        {localize('com_nmb_analysis_code_title')}
      </h2>
      <Textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-label={localize('com_nmb_analysis_code_label')}
        placeholder={localize('com_nmb_analysis_code_placeholder')}
        spellCheck={false}
        className="min-h-48"
      />
      {tooLong && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_nmb_analysis_code_too_long', { 0: String(maxChars) })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !hasSynthetic}
          onClick={() => submit('synthetic')}
        >
          {localize('com_nmb_analysis_test_synthetic')}
        </Button>
        <Button
          type="button"
          variant="submit"
          disabled={disabled}
          onClick={() => setConfirmOpen(true)}
        >
          {localize('com_nmb_analysis_run_real')}
        </Button>
      </div>
      {!hasSynthetic && (
        <p className="text-text-secondary text-xs">
          {localize('com_nmb_analysis_test_needs_twin')}
        </p>
      )}
      {execute.isLoading && (
        <p className="text-text-secondary text-sm" role="status">
          {localize('com_nmb_analysis_running')}
        </p>
      )}
      {execute.isError && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize(
            (execute.error as { response?: { status?: number } } | null)?.response?.status === 429
              ? 'com_nmb_analysis_rate_limited'
              : 'com_nmb_analysis_run_failed',
          )}
        </p>
      )}
      {run && <Result run={run} />}
      <OGDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <OGDialogTemplate
          title={localize('com_nmb_analysis_confirm_title')}
          description={localize('com_nmb_analysis_confirm_body')}
          className="w-11/12 max-w-md"
          showCloseButton={false}
          selection={{
            selectHandler: () => {
              setConfirmOpen(false);
              submit('real');
            },
            selectText: localize('com_nmb_analysis_confirm_run'),
          }}
        />
      </OGDialog>
    </section>
  );
}
