/** Types for the NMB secure-gateway review workflow (`/api/nmb`). */

export type TNmbReviewStatus = 'pending' | 'approved-masked' | 'rejected';

export type TNmbMe = {
  enabled: boolean;
  reviewer: boolean;
  /** The scanner accepts pattern entries on the masked-data list. */
  regexBlocklist: boolean;
  /** Synthetic-data analysis is available. */
  analysis?: boolean;
};

/** One finding as shown to a reviewer. Never contains the raw value. */
export type TNmbFinding = {
  entity: string;
  type: string;
  location: { segment: string; start: number; end: number };
  score: number;
  action: 'MASK' | 'BLOCK' | 'ALLOW';
  value_hash: string;
};

export type TNmbReview = {
  id: string;
  user: string;
  user_label: string;
  department: string | null;
  source: 'text' | 'file';
  decision_at_creation: 'review' | 'reject';
  reason: string | null;
  findings: TNmbFinding[];
  status: TNmbReviewStatus;
  reviewer: string | null;
  reviewer_note: string | null;
  blocklist_additions: string[];
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type TNmbReviewsResponse = { items: TNmbReview[] };

export type TNmbOriginal = {
  id: string;
  source: 'text' | 'file';
  segments: Array<{ location: string; text: string }>;
};

/** A reviewer's choice to add a value or pattern to the masked-data list. */
export type TNmbBlocklistChoice = { value: string; mode: 'literal' | 'regex' };

export type TNmbApproveBody = { note?: string; additions?: TNmbBlocklistChoice[] };
export type TNmbRejectBody = { reason: string };

export type TNmbBlocklistEntry = {
  term?: string;
  regex?: string;
  entity?: string;
  source?: 'base' | 'runtime';
};

/** The end user's view of one of their own held submissions. */
export type TNmbSubmission = {
  id: string;
  source: 'text' | 'file';
  status: TNmbReviewStatus;
  created_at: string;
  resolved_at: string | null;
  /** Only set for a rejected submission. */
  reason: string | null;
};

export type TNmbUnmaskResponse = { text: string; restored: number };

/**
 * Start of the one-line note the gateway appends to a masked message so the model keeps
 * redaction tokens verbatim. Shared so the client can hide it from display.
 */
export const NMB_MASK_NOTE_MARKER = '\n\n[NMB redaction note:';
export const NMB_MASK_NOTE = `${NMB_MASK_NOTE_MARKER} tokens such as <TYPE_000> stand in for redacted values; keep them exactly as written.]`;

/** Matches a placeholder the scanner emits, e.g. `<ACCOUNT_001>`. */
export const NMB_PLACEHOLDER_REGEX = /<[A-Z][A-Z_]*_\d{3,}>/;

/** The text without the gateway's trailing note. */
export const stripNmbMaskNote = (text: string): string => {
  const i = text.indexOf(NMB_MASK_NOTE_MARKER);
  return i === -1 ? text : text.slice(0, i);
};

/** Synthetic-data analysis (`/api/nmb/datasets`, `/api/nmb/runs`). */
export type TNmbColumnKind =
  | 'numeric'
  | 'integer'
  | 'datetime'
  | 'boolean'
  | 'categorical'
  | 'text'
  | 'identifier';

export type TNmbColumn = {
  name: string;
  kind: TNmbColumnKind;
  null_fraction: number;
  sensitive: boolean;
  sensitive_entities: string[];
  /** Default selection for the synthetic twin. */
  share: boolean;
};

export type TNmbSynthetic = {
  rows: number;
  columns: string[];
  engine: 'builtin' | 'sdv';
  generated_at: string;
};

export type TNmbDataset = {
  id: string;
  name: string;
  rows: number;
  created_at: string;
  expires_at?: string;
  columns: TNmbColumn[];
  synthetic: TNmbSynthetic | null;
};

export type TNmbSyntheticData = {
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  csv: string;
};

export type TNmbSynthesizeBody = {
  columns: string[];
  rows?: number;
  seed?: number;
};

export type TNmbRunTarget = 'synthetic' | 'real';
export type TNmbRunStatus = 'ok' | 'error' | 'rejected' | 'timeout';

export type TNmbRunFile = { name: string; bytes: number; kind: string };

export type TNmbRun = {
  id: string;
  dataset_id: string;
  target: TNmbRunTarget;
  status: TNmbRunStatus;
  stdout: string;
  stderr: string;
  files: TNmbRunFile[];
  /** Rule ids with line numbers, e.g. `import:os@3`. Never source text. */
  violations: string[];
  duration_ms: number;
  /** True only for synthetic runs; real output never goes to the model. */
  llm_safe: boolean;
  created_at: string;
};

export type TNmbExecuteBody = { code: string; target: TNmbRunTarget };

export type TNmbAnalysisLimits = {
  max_code_chars: number;
  timeout_s: number;
  max_output_bytes: number;
  allowed_imports: string[];
  max_upload_bytes: number;
  synthetic_max_rows: number;
};
