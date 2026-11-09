import { useRef, useState } from 'react';
import { Button, Spinner } from '@librechat/client';
import type { TNmbDataset } from 'librechat-data-provider';
import { useUploadNmbDatasetMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

type Props = { maxBytes?: number; onUploaded: (dataset: TNmbDataset) => void };

/** CSV upload. The file goes to the scanner and is stored encrypted; it is never shown back. */
export default function Upload({ maxBytes = DEFAULT_MAX_BYTES, onUploaded }: Props) {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  const [invalid, setInvalid] = useState<'type' | 'size' | null>(null);
  const upload = useUploadNmbDatasetMutation({ onSuccess: onUploaded });

  const onFile = (file: File | undefined) => {
    setInvalid(null);
    if (!file) {
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setInvalid('type');
      return;
    }
    if (file.size > maxBytes) {
      setInvalid('size');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    upload.mutate(form);
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        data-testid="nmb-upload-input"
        aria-label={localize('com_nmb_analysis_upload')}
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={upload.isLoading}
        onClick={() => inputRef.current?.click()}
      >
        {upload.isLoading ? (
          <>
            <Spinner className="mr-2 size-4" />
            {localize('com_nmb_analysis_uploading')}
          </>
        ) : (
          localize('com_nmb_analysis_upload')
        )}
      </Button>
      {invalid === 'type' && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_nmb_analysis_upload_type')}
        </p>
      )}
      {invalid === 'size' && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_nmb_analysis_upload_size', { 0: String(Math.floor(maxBytes / 1048576)) })}
        </p>
      )}
      {upload.isError && (
        <p role="alert" className="text-text-destructive text-sm">
          {localize('com_nmb_analysis_upload_failed')}
        </p>
      )}
    </div>
  );
}
