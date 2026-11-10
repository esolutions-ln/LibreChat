/** Wire types for the nmb-scanner HTTP contract (docs/nmb/INTERFACE.md). */

export type ScanDecisionKind = 'allow' | 'mask' | 'review' | 'reject';
export type FindingAction = 'MASK' | 'BLOCK' | 'ALLOW';
export type ReviewStatus = 'pending' | 'approved-masked' | 'rejected';

export interface ScanFinding {
  entity: string;
  type: string;
  location: { segment: string; start: number; end: number };
  score: number;
  action: FindingAction;
  value_hash: string;
  placeholder?: string | null;
}

export interface ScanResult {
  decision: ScanDecisionKind;
  conversation_id: string;
  findings: ScanFinding[];
  sanitized_content: string | null;
  review_required_reason: string | null;
  review_id: string | null;
  document?: Record<string, unknown> | null;
  sanitized_segments?: Array<{ location: string; text: string }> | null;
  summary?: Record<string, unknown>;
}

export interface ReviewItem {
  id: string;
  user: string;
  department: string | null;
  conversation_id: string;
  source: 'text' | 'file';
  decision_at_creation: 'review' | 'reject';
  reason: string | null;
  findings: ScanFinding[];
  status: ReviewStatus;
  reviewer: string | null;
  reviewer_note: string | null;
  blocklist_additions: string[];
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  /** How the reviewer approved it; null until approved. */
  mode?: ApprovalMode | null;
  /** Set once the owner's chat has sent the approved text to the model; null before. */
  released_at?: string | null;
}

/** `masked`: values become `<TYPE_nnn>` tokens. `synthetic`: values become realistic fakes (docs/nmb/SYNTHETIC.md). */
export type ApprovalMode = 'masked' | 'synthetic';

export interface ReviewOriginal {
  id: string;
  source: 'text' | 'file';
  segments: Array<{ location: string; text: string }>;
}

export interface ReviewResult {
  id: string;
  status: ReviewStatus;
  sanitized_content: string | null;
  sanitized_segments: Array<{ location: string; text: string }> | null;
  mode?: ApprovalMode | null;
}

export interface ScanContext {
  /** Placeholder namespace. Derived from the authenticated session, never from the request body. */
  scope: string;
  user: string;
  department?: string;
  roles: string[];
}

export interface ReviewActionBody {
  reviewer: string;
  roles: string[];
  note?: string;
  blocklist_additions?: string[];
  mode?: ApprovalMode;
}

export interface BlocklistEntry {
  term?: string;
  regex?: string;
  entity?: string;
  source?: 'base' | 'runtime';
}

export interface NmbConfig {
  enabled: boolean;
  scannerUrl: string;
  serviceKey: string;
  timeoutMs: number;
  /** LibreChat role name -> department sent to the scanner. */
  roleDepartments: Record<string, string>;
  defaultDepartment?: string;
  /** Append a one-line note telling the model that `<TYPE_nnn>` tokens are redactions. */
  maskNote: boolean;
  /** Scanner has the `regexes` blocklist extension (not in INTERFACE.md yet). */
  regexBlocklist: boolean;
  analysis: NmbAnalysisConfig;
  reports: NmbReportsConfig;
}

/** Inline charts and Excel/PDF export of model-written chart specs (docs/nmb/REPORTS.md). Off unless enabled. */
export interface NmbReportsConfig {
  enabled: boolean;
}

/** Synthetic-data analysis (docs/nmb/ANALYSIS.md). Off unless explicitly enabled. */
export interface NmbAnalysisConfig {
  enabled: boolean;
  maxUploadBytes: number;
  maxCodeChars: number;
  /** Upper bound for one execute call, including the scanner's own sandbox timeout. */
  executeTimeoutMs: number;
  /** Executions one user may start per window (synthetic and real both count). */
  executeRateMax: number;
  executeRateWindowMinutes: number;
  /** Executions one user may have running at once on this instance. */
  maxConcurrentRuns: number;
}

export type AnalysisColumnKind =
  | 'numeric'
  | 'integer'
  | 'datetime'
  | 'boolean'
  | 'categorical'
  | 'text'
  | 'identifier';

export interface AnalysisColumn {
  name: string;
  kind: AnalysisColumnKind;
  null_fraction: number;
  sensitive: boolean;
  sensitive_entities: string[];
  share: boolean;
}

export interface AnalysisSynthetic {
  rows: number;
  columns: string[];
  engine: 'builtin' | 'sdv';
  generated_at: string;
}

export interface AnalysisDataset {
  id: string;
  name: string;
  rows: number;
  created_at: string;
  expires_at: string | null;
  columns: AnalysisColumn[];
  synthetic: AnalysisSynthetic | null;
}

export interface AnalysisSyntheticData {
  columns: string[];
  rows: unknown[][];
  csv: string;
}

export type AnalysisTarget = 'synthetic' | 'real';
export type AnalysisRunStatus = 'ok' | 'error' | 'rejected' | 'timeout';

export interface AnalysisRunFile {
  name: string;
  bytes: number;
  kind: string;
}

export interface AnalysisRun {
  id: string;
  dataset_id: string;
  target: AnalysisTarget;
  status: AnalysisRunStatus;
  stdout: string;
  stderr: string;
  files: AnalysisRunFile[];
  violations: string[];
  duration_ms: number;
  /** True only for synthetic runs. Real-run output must never be shown to the model. */
  llm_safe: boolean;
  created_at: string;
}

export interface AnalysisLimits {
  max_code_chars: number;
  timeout_s: number;
  max_output_bytes: number;
  allowed_imports: string[];
  max_upload_bytes: number;
  synthetic_max_rows: number;
}
