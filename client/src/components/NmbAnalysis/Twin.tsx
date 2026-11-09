import { useMemo, useState } from 'react';
import { Button, Checkbox, Input, Label, Spinner, Textarea } from '@librechat/client';
import type { TNmbDataset, TNmbAnalysisLimits } from 'librechat-data-provider';
import { useNmbSyntheticQuery, useSynthesizeNmbDatasetMutation } from '~/data-provider';
import { buildAnalysisPrompt, DEFAULT_IMPORTS } from './prompt';
import { useLocalize } from '~/hooks';

const DEFAULT_ROWS = 100;
const PREVIEW_ROWS = 10;

type Props = { dataset: TNmbDataset; limits?: TNmbAnalysisLimits };

/** Column selection, synthetic twin generation and preview, and the prompt for the chat. */
export default function Twin({ dataset, limits }: Props) {
  const localize = useLocalize();
  const maxRows = limits?.synthetic_max_rows ?? 1000;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(dataset.columns.filter((c) => c.share).map((c) => c.name)),
  );
  const [rows, setRows] = useState(Math.min(DEFAULT_ROWS, maxRows));
  const [question, setQuestion] = useState('');
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const synthesize = useSynthesizeNmbDatasetMutation();
  const hasTwin = dataset.synthetic != null;
  const {
    data: twin,
    isLoading: twinLoading,
    isError: twinError,
  } = useNmbSyntheticQuery(dataset.id, { enabled: hasTwin });
  const rowsValid = Number.isInteger(rows) && rows >= 1 && rows <= maxRows;

  const promptColumns = useMemo(() => {
    const shared = new Set(twin?.columns ?? dataset.synthetic?.columns ?? []);
    return dataset.columns.filter((c) => shared.has(c.name));
  }, [dataset.columns, dataset.synthetic, twin]);

  const toggle = (name: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });

  const generate = () =>
    synthesize.mutate({
      id: dataset.id,
      body: {
        columns: dataset.columns.filter((c) => selected.has(c.name)).map((c) => c.name),
        rows,
      },
    });

  const copyPrompt = async () => {
    if (!twin) {
      return;
    }
    const text = buildAnalysisPrompt({
      name: dataset.name,
      columns: promptColumns,
      csv: twin.csv,
      allowedImports: limits?.allowed_imports ?? DEFAULT_IMPORTS,
      question,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2" aria-labelledby="nmb-schema-title">
        <h2 id="nmb-schema-title" className="text-sm font-semibold">
          {localize('com_nmb_analysis_schema_title')}
        </h2>
        <p className="text-text-secondary text-xs">{localize('com_nmb_analysis_schema_help')}</p>
        <div className="overflow-x-auto">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="text-text-secondary text-xs">
                <th className="py-1 pe-2 text-start">{localize('com_nmb_analysis_col_share')}</th>
                <th className="py-1 pe-2 text-start">{localize('com_nmb_analysis_col_name')}</th>
                <th className="py-1 pe-2 text-start">{localize('com_nmb_analysis_col_kind')}</th>
                <th className="py-1 text-start">{localize('com_nmb_analysis_col_flags')}</th>
              </tr>
            </thead>
            <tbody>
              {dataset.columns.map((c) => {
                const id = `nmb-col-${c.name}`;
                return (
                  <tr key={c.name} className="border-border-light border-t">
                    <td className="py-1 pe-2">
                      <Checkbox
                        id={id}
                        checked={selected.has(c.name)}
                        onCheckedChange={(v) => toggle(c.name, v === true)}
                        aria-label={localize('com_nmb_analysis_share_column', { 0: c.name })}
                      />
                    </td>
                    <td className="py-1 pe-2">
                      <Label htmlFor={id} className="font-mono text-xs">
                        {c.name}
                      </Label>
                    </td>
                    <td className="text-text-secondary py-1 pe-2 text-xs">{c.kind}</td>
                    <td className="py-1 text-xs">
                      {c.sensitive && (
                        <span title={c.sensitive_entities.join(', ')}>
                          {localize('com_nmb_analysis_sensitive')}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="nmb-twin-rows" className="text-xs">
            {localize('com_nmb_analysis_rows')}
          </Label>
          <Input
            id="nmb-twin-rows"
            type="number"
            min={1}
            max={maxRows}
            value={Number.isNaN(rows) ? '' : rows}
            onChange={(e) => setRows(e.target.valueAsNumber)}
            className="w-28"
          />
        </div>
        <Button
          type="button"
          variant="submit"
          disabled={synthesize.isLoading || selected.size === 0 || !rowsValid}
          onClick={generate}
        >
          {synthesize.isLoading ? (
            <>
              <Spinner className="mr-2 size-4" />
              {localize('com_nmb_analysis_generating')}
            </>
          ) : (
            localize(hasTwin ? 'com_nmb_analysis_regenerate' : 'com_nmb_analysis_generate')
          )}
        </Button>
        {!rowsValid && (
          <p role="alert" className="text-text-destructive text-sm">
            {localize('com_nmb_analysis_rows_invalid', { 0: String(maxRows) })}
          </p>
        )}
      </section>
      {synthesize.isError && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_nmb_analysis_synthesize_failed')}
        </p>
      )}
      {hasTwin && (
        <section className="flex flex-col gap-3" aria-labelledby="nmb-twin-title">
          <h2 id="nmb-twin-title" className="text-sm font-semibold">
            {localize('com_nmb_analysis_twin_title')}
          </h2>
          {twinLoading && <Spinner className="size-5" />}
          {twinError && (
            <p role="alert" className="text-text-destructive text-sm">
              {localize('com_nmb_analysis_twin_failed')}
            </p>
          )}
          {twin && (
            <>
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      {twin.columns.map((name) => (
                        <th key={name} className="px-2 py-1 text-start font-mono">
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {twin.rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                      <tr key={i} className="border-border-light border-t">
                        {row.map((cell, j) => (
                          <td key={j} className="px-2 py-1">
                            {cell == null ? '' : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="nmb-question" className="text-xs">
                  {localize('com_nmb_analysis_question')}
                </Label>
                <Textarea
                  id="nmb-question"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={localize('com_nmb_analysis_question_placeholder')}
                  className="min-h-20"
                />
              </div>
              <div className="flex items-center gap-3">
                <Button type="button" variant="outline" onClick={copyPrompt}>
                  {localize('com_nmb_analysis_copy_prompt')}
                </Button>
                {copied === 'ok' && (
                  <span role="status" className="text-text-secondary text-sm">
                    {localize('com_nmb_analysis_copied')}
                  </span>
                )}
                {copied === 'failed' && (
                  <span role="alert" className="text-text-destructive text-sm">
                    {localize('com_nmb_analysis_copy_failed')}
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
