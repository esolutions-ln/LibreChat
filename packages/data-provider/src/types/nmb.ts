/** Types for the NMB secure-gateway review workflow (`/api/nmb`). */

export type TNmbReviewStatus = 'pending' | 'approved-masked' | 'rejected';

export type TNmbMe = {
  enabled: boolean;
  reviewer: boolean;
  /** The scanner accepts pattern entries on the masked-data list. */
  regexBlocklist: boolean;
  /** Synthetic-data analysis is available. */
  analysis?: boolean;
  /** Inline charts and Excel/PDF export of financial results are available. */
  reports?: boolean;
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
  /** How an approved item was cleared; absent on older scanners, which means masked. */
  mode?: TNmbApproveMode;
};

export type TNmbReviewsResponse = { items: TNmbReview[] };

export type TNmbOriginal = {
  id: string;
  source: 'text' | 'file';
  segments: Array<{ location: string; text: string }>;
};

/** A reviewer's choice to add a value or pattern to the masked-data list. */
export type TNmbBlocklistChoice = { value: string; mode: 'literal' | 'regex' };

/** How an approved prompt reaches the model: sensitive values as tokens, or as realistic fakes. */
export type TNmbApproveMode = 'masked' | 'synthetic';

export type TNmbApproveBody = {
  note?: string;
  /** Ignored by the gateway for `synthetic`. */
  additions?: TNmbBlocklistChoice[];
  mode?: TNmbApproveMode;
};
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
  /** How an approved submission was cleared. Absent on older gateways, which means masked. */
  mode?: TNmbApproveMode;
  /** The approved prompt has already been sent to the model. */
  released?: boolean;
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

/** Start of the note that tells the model how to answer with an `nmb-chart` block. */
export const NMB_CHART_NOTE_MARKER = '\n\n[NMB chart note:';

/** Start of the note that tells the model a released prompt carries realistic fake values. */
export const NMB_SYNTHETIC_NOTE_MARKER = '\n\n[NMB synthetic note:';

/** The text without the gateway's trailing note(s): cut at the earliest marker present. */
export const stripNmbMaskNote = (text: string): string => {
  const cuts = [NMB_MASK_NOTE_MARKER, NMB_CHART_NOTE_MARKER, NMB_SYNTHETIC_NOTE_MARKER]
    .map((marker) => text.indexOf(marker))
    .filter((i) => i !== -1);
  return cuts.length === 0 ? text : text.slice(0, Math.min(...cuts));
};

/** Financial-results charts (docs/nmb/REPORTS.md). */
export type TNmbChartType = 'bar' | 'stacked_bar' | 'line' | 'pie';

export type TNmbChartSeries = { name: string; values: Array<number | null> };

/** Where the figures came from: read by the AI from a document, or computed by analysis code. */
export type TNmbChartOrigin = 'model' | 'computed';

export type TNmbChartSpec = {
  version: 1;
  title: string;
  type: TNmbChartType;
  origin?: TNmbChartOrigin;
  unit?: string;
  source?: string;
  categories: string[];
  series: TNmbChartSeries[];
};

export type TNmbReportFormat = 'xlsx' | 'pdf';

export type TNmbChartError =
  | 'invalid_json'
  | 'too_large'
  | 'invalid_shape'
  | 'unsupported_version'
  | 'invalid_type'
  | 'invalid_text'
  | 'too_many_categories'
  | 'too_many_series'
  | 'length_mismatch'
  | 'invalid_value'
  | 'negative_pie';

export type TNmbChartParse =
  | { ok: true; spec: TNmbChartSpec }
  | { ok: false; error: TNmbChartError };

export const NMB_CHART_LIMITS = {
  maxBytes: 64 * 1024,
  maxTitle: 120,
  maxNote: 120,
  maxName: 80,
  maxCategories: 60,
  maxSeries: 12,
} as const;

const CHART_TYPES = new Set<string>(['bar', 'stacked_bar', 'line', 'pie']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

const utf8Length = (s: string): number =>
  typeof TextEncoder === 'undefined' ? s.length : new TextEncoder().encode(s).length;

const isText = (v: unknown, max: number, required: boolean): v is string =>
  typeof v === 'string' &&
  v.length <= max &&
  (!required || v.trim().length > 0) &&
  !CONTROL_CHARS.test(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

const fail = (error: TNmbChartError): TNmbChartParse => ({ ok: false, error });

/**
 * Validates the JSON of an `nmb-chart` block against every limit in the contract. Pure and
 * non-throwing: partial JSON (a block still streaming) is simply `invalid_json`.
 */
export function parseNmbChartSpec(json: string): TNmbChartParse {
  const { maxBytes, maxTitle, maxNote, maxName, maxCategories, maxSeries } = NMB_CHART_LIMITS;
  if (utf8Length(json) > maxBytes) {
    return fail('too_large');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return fail('invalid_json');
  }
  if (!isRecord(raw)) {
    return fail('invalid_shape');
  }
  if (raw.version !== 1) {
    return fail('unsupported_version');
  }
  if (typeof raw.type !== 'string' || !CHART_TYPES.has(raw.type)) {
    return fail('invalid_type');
  }
  const type = raw.type as TNmbChartType;
  if (raw.origin !== undefined && raw.origin !== 'model' && raw.origin !== 'computed') {
    return fail('invalid_type');
  }
  if (!isText(raw.title, maxTitle, true)) {
    return fail('invalid_text');
  }
  for (const key of ['unit', 'source'] as const) {
    if (raw[key] !== undefined && !isText(raw[key], maxNote, false)) {
      return fail('invalid_text');
    }
  }
  if (!Array.isArray(raw.categories) || !Array.isArray(raw.series)) {
    return fail('invalid_shape');
  }
  if (raw.categories.length < 1 || raw.categories.length > maxCategories) {
    return fail('too_many_categories');
  }
  if (raw.series.length < 1 || raw.series.length > maxSeries) {
    return fail('too_many_series');
  }
  if (!raw.categories.every((c) => isText(c, maxName, true))) {
    return fail('invalid_text');
  }
  const categories = raw.categories as string[];
  const series: TNmbChartSeries[] = [];
  for (const s of raw.series as unknown[]) {
    if (!isRecord(s) || !isText(s.name, maxName, true) || !Array.isArray(s.values)) {
      return fail(isRecord(s) && Array.isArray(s.values) ? 'invalid_text' : 'invalid_shape');
    }
    if (s.values.length !== categories.length) {
      return fail('length_mismatch');
    }
    for (const v of s.values) {
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
        return fail('invalid_value');
      }
      if (type === 'pie' && typeof v === 'number' && v < 0) {
        return fail('negative_pie');
      }
    }
    series.push({ name: s.name, values: s.values as Array<number | null> });
  }
  return {
    ok: true,
    spec: {
      version: 1,
      title: raw.title,
      type,
      ...(raw.origin === 'model' || raw.origin === 'computed' ? { origin: raw.origin } : {}),
      ...(typeof raw.unit === 'string' && raw.unit ? { unit: raw.unit } : {}),
      ...(typeof raw.source === 'string' && raw.source ? { source: raw.source } : {}),
      categories,
      series,
    },
  };
}

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
