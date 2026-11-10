import { useMemo, useState } from 'react';
import { Button, Checkbox, Label, OGDialog, OGDialogTemplate, Textarea } from '@librechat/client';
import type {
  TNmbFinding,
  TNmbOriginal,
  TNmbApproveMode,
  TNmbBlocklistChoice,
} from 'librechat-data-provider';
import { escapeRegex, findingValue } from '~/components/Nmb/highlight';
import { useLocalize } from '~/hooks';

type Choice = { checked: boolean; mode: 'literal' | 'regex' };

export type ApproveBody = {
  note?: string;
  additions: TNmbBlocklistChoice[];
  mode: TNmbApproveMode;
};

/**
 * Two ways to approve a held prompt. "Approve masked" sends sensitive values as tokens and lets the
 * reviewer add values or patterns to the masked-data list (taken from the original the reviewer
 * already opened, sent back only as their own choice). "Synthesize and release" replaces them with
 * realistic fakes, so there is nothing to add to the list, and asks for confirmation first.
 */
export default function ApproveForm({
  original,
  findings,
  regexEnabled,
  busy,
  onApprove,
}: {
  original: TNmbOriginal;
  findings: TNmbFinding[];
  regexEnabled: boolean;
  busy: boolean;
  onApprove: (body: ApproveBody) => void;
}) {
  const localize = useLocalize();
  const [note, setNote] = useState('');
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [lastMode, setLastMode] = useState<TNmbApproveMode | null>(null);

  const rows = useMemo(
    () =>
      findings
        .map((finding, index) => ({
          finding,
          index,
          value: findingValue(finding, original.segments),
        }))
        .filter((row) => row.value.length > 0),
    [findings, original.segments],
  );

  const trimmedNote = note.trim() || undefined;

  const submitMasked = () => {
    const additions: TNmbBlocklistChoice[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const choice = choices[row.index];
      if (!choice?.checked) {
        continue;
      }
      const value = choice.mode === 'regex' ? escapeRegex(row.value) : row.value;
      const key = `${choice.mode}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        additions.push({ value, mode: choice.mode });
      }
    }
    setLastMode('masked');
    onApprove({ note: trimmedNote, additions, mode: 'masked' });
  };

  const submitSynthetic = () => {
    setLastMode('synthetic');
    onApprove({ note: trimmedNote, additions: [], mode: 'synthetic' });
  };

  return (
    <div className="flex flex-col gap-5">
      <Textarea
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        placeholder={localize('com_nmb_note_placeholder')}
        aria-label={localize('com_nmb_note_placeholder')}
      />

      <section className="flex flex-col gap-3" aria-labelledby="nmb-approve-masked-title">
        <h4 id="nmb-approve-masked-title" className="text-sm font-semibold">
          {localize('com_nmb_approve_masked')}
        </h4>
        <p className="text-text-secondary text-sm">{localize('com_nmb_approve_masked_help')}</p>
        <h5 className="text-text-secondary text-xs font-medium">
          {localize('com_nmb_add_to_masked_list')}
        </h5>
        {rows.length === 0 ? (
          <p className="text-text-secondary text-sm">{localize('com_nmb_nothing_to_add')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map(({ finding, index, value }) => {
              const choice = choices[index] ?? { checked: false, mode: 'literal' };
              const id = `nmb-add-${index}`;
              return (
                <li
                  key={index}
                  className="border-border-light flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm"
                >
                  <Checkbox
                    id={id}
                    checked={choice.checked}
                    onCheckedChange={(checked) =>
                      setChoices((prev) => ({
                        ...prev,
                        [index]: { ...choice, checked: checked === true },
                      }))
                    }
                    aria-label={localize('com_nmb_add_finding_aria', { 0: finding.entity })}
                  />
                  <Label htmlFor={id} className="min-w-0 flex-1 truncate font-mono">
                    <span className="text-text-secondary mr-2 font-sans">{finding.entity}</span>
                    {value}
                  </Label>
                  <select
                    className="border-border-light bg-surface-primary rounded-md border px-2 py-1"
                    value={choice.mode}
                    disabled={!choice.checked}
                    aria-label={localize('com_nmb_match_mode')}
                    onChange={(e) =>
                      setChoices((prev) => ({
                        ...prev,
                        [index]: {
                          ...choice,
                          mode: e.target.value === 'regex' ? 'regex' : 'literal',
                        },
                      }))
                    }
                  >
                    <option value="literal">{localize('com_nmb_mode_literal')}</option>
                    {regexEnabled && (
                      <option value="regex">{localize('com_nmb_mode_regex')}</option>
                    )}
                  </select>
                </li>
              );
            })}
          </ul>
        )}
        <div>
          <Button type="button" onClick={submitMasked} disabled={busy}>
            {localize('com_nmb_approve_masked')}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="nmb-approve-synthetic-title">
        <h4 id="nmb-approve-synthetic-title" className="text-sm font-semibold">
          {localize('com_nmb_approve_synthetic')}
        </h4>
        <p className="text-text-secondary text-sm">{localize('com_nmb_approve_synthetic_help')}</p>
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
          >
            {localize('com_nmb_approve_synthetic')}
          </Button>
        </div>
      </section>

      {busy && lastMode && (
        <p role="status" className="text-text-secondary text-sm">
          {localize(
            lastMode === 'synthetic' ? 'com_nmb_approving_synthetic' : 'com_nmb_approving_masked',
          )}
        </p>
      )}

      <OGDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <OGDialogTemplate
          title={localize('com_nmb_approve_synthetic_confirm_title')}
          description={localize('com_nmb_approve_synthetic_confirm_body')}
          className="w-11/12 max-w-md"
          showCloseButton={false}
          selection={{
            selectHandler: () => {
              setConfirmOpen(false);
              submitSynthetic();
            },
            selectText: localize('com_nmb_approve_synthetic'),
          }}
        />
      </OGDialog>
    </div>
  );
}
