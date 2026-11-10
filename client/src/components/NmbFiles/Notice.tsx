import { useEffect, useRef } from 'react';
import { useAtom } from 'jotai';
import { Button, useToastContext } from '@librechat/client';
import type { TNmbHeldFile } from 'librechat-data-provider';
import { useNmbHeldFilesQuery, useNmbMeQuery } from '~/data-provider';
import { createStorageAtom } from '~/store/jotai-utils';
import { useLocalize } from '~/hooks';

/** Rejected notices the user has closed; approved ones stay until the file is attached again. */
const dismissedAtom = createStorageAtom<string[]>('nmbDismissedHeldFiles', []);

const decided = (f: TNmbHeldFile) => f.status !== 'pending';

/**
 * Tells the person who uploaded a held document what happened to it. A decision also raises a
 * toast once per review, so it is noticed even when the notice is out of view. Approval does not
 * send anything: the owner attaches the same file again and asks their own question.
 */
export default function Notice() {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: me } = useNmbMeQuery();
  const { data } = useNmbHeldFilesQuery({ enabled: me?.enabled === true });
  const [dismissed, setDismissed] = useAtom(dismissedAtom);
  const seen = useRef<Map<string, string> | null>(null);
  const items = (data?.items ?? []).filter((f) => !dismissed.includes(f.id));

  useEffect(() => {
    if (!data) {
      return;
    }
    const next = new Map(data.items.map((f) => [f.id, f.status]));
    const previous = seen.current;
    seen.current = next;
    if (previous == null) {
      return;
    }
    for (const f of data.items) {
      if (decided(f) && previous.get(f.id) === 'pending') {
        showToast({
          message:
            f.status === 'rejected'
              ? localize('com_nmb_held_file_rejected', { 0: f.filename ?? '' })
              : localize('com_nmb_held_file_approved', { 0: f.filename ?? '' }),
          status: f.status === 'rejected' ? 'error' : 'success',
          duration: 12000,
        });
      }
    }
  }, [data, localize, showToast]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-2 pb-2 md:px-4">
      {items.map((f) => {
        const name = f.filename ?? localize('com_nmb_held_file_unnamed');
        const rejected = f.status === 'rejected';
        return (
          <div
            key={f.id}
            role={rejected ? 'alert' : 'status'}
            className="border-border-medium bg-surface-secondary text-text-primary flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
          >
            <p>
              {f.status === 'pending' && localize('com_nmb_held_file_pending', { 0: name })}
              {f.status === 'approved-masked' &&
                localize('com_nmb_held_file_approved', { 0: name })}
              {rejected && localize('com_nmb_held_file_rejected', { 0: name })}
              {rejected && f.reason ? ` ${f.reason}` : ''}
            </p>
            {rejected && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDismissed((prev) => [...prev, f.id])}
              >
                {localize('com_nmb_held_file_dismiss')}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
