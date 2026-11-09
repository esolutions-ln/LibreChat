import type {
  AnalysisRun,
  AnalysisLimits,
  AnalysisTarget,
  AnalysisDataset,
  AnalysisSyntheticData,
} from './types';
import type { ScannerCall } from './scanner';
import { ScannerError } from './scanner';

export interface AnalysisFile {
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  size: number | null;
}

/** Scanner calls for the synthetic-data workbench. Every call is scoped to the session user. */
export interface AnalysisClient {
  upload(
    filename: string,
    data: Uint8Array,
    user: string,
    department?: string,
  ): Promise<AnalysisDataset>;
  list(user: string): Promise<AnalysisDataset[]>;
  get(id: string, user: string): Promise<AnalysisDataset>;
  remove(id: string, user: string): Promise<void>;
  synthesize(
    id: string,
    body: { user: string; columns: string[]; rows: number; seed?: number },
  ): Promise<AnalysisDataset>;
  synthetic(id: string, user: string): Promise<AnalysisSyntheticData>;
  execute(
    id: string,
    body: { user: string; code: string; target: AnalysisTarget },
  ): Promise<AnalysisRun>;
  getRun(id: string, user: string): Promise<AnalysisRun>;
  getRunFile(id: string, name: string, user: string): Promise<AnalysisFile>;
  limits(): Promise<AnalysisLimits>;
}

const RUN_STATUSES = new Set(['ok', 'error', 'rejected', 'timeout']);

const isObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object';

function isDataset(v: unknown): v is AnalysisDataset {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.rows === 'number' &&
    Array.isArray(v.columns)
  );
}

function isRun(v: unknown): v is AnalysisRun {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.dataset_id === 'string' &&
    typeof v.status === 'string' &&
    RUN_STATUSES.has(v.status) &&
    Array.isArray(v.files) &&
    Array.isArray(v.violations)
  );
}

const bad = (): ScannerError => new ScannerError('bad_response');
const q = (user: string): string => `user=${encodeURIComponent(user)}`;
const seg = encodeURIComponent;

export function createAnalysisClient(call: ScannerCall, executeTimeoutMs: number): AnalysisClient {
  const dataset = async (p: Promise<unknown>): Promise<AnalysisDataset> => {
    const out = await p;
    if (!isDataset(out)) {
      throw bad();
    }
    return out;
  };
  const run = async (p: Promise<unknown>): Promise<AnalysisRun> => {
    const out = await p;
    if (!isRun(out)) {
      throw bad();
    }
    return out;
  };

  return {
    upload: (filename, data, user, department) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(data)]), filename);
      form.append('user', user);
      if (department) {
        form.append('department', department);
      }
      return dataset(call('POST', '/analysis/datasets', { form }));
    },

    async list(user) {
      const out = await call('GET', `/analysis/datasets?${q(user)}`);
      if (!isObject(out) || !Array.isArray(out.items) || !out.items.every(isDataset)) {
        throw bad();
      }
      return out.items as AnalysisDataset[];
    },

    get: (id, user) => dataset(call('GET', `/analysis/datasets/${seg(id)}?${q(user)}`)),

    async remove(id, user) {
      await call('DELETE', `/analysis/datasets/${seg(id)}?${q(user)}`);
    },

    synthesize: (id, body) =>
      dataset(call('POST', `/analysis/datasets/${seg(id)}/synthesize`, { json: body })),

    async synthetic(id, user) {
      const out = await call('GET', `/analysis/datasets/${seg(id)}/synthetic?${q(user)}`);
      if (!isObject(out) || !Array.isArray(out.columns) || !Array.isArray(out.rows)) {
        throw bad();
      }
      return out as unknown as AnalysisSyntheticData;
    },

    execute: (id, body) =>
      run(
        call('POST', `/analysis/datasets/${seg(id)}/execute`, {
          json: body,
          timeoutMs: executeTimeoutMs,
        }),
      ),

    getRun: (id, user) => run(call('GET', `/analysis/runs/${seg(id)}?${q(user)}`)),

    async getRunFile(id, name, user) {
      const res = (await call('GET', `/analysis/runs/${seg(id)}/files/${seg(name)}?${q(user)}`, {
        raw: true,
      })) as Response;
      const length = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      return {
        body: res.body,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        size: Number.isFinite(length) ? length : null,
      };
    },

    async limits() {
      const out = await call('GET', '/analysis/limits');
      if (!isObject(out) || !Array.isArray(out.allowed_imports)) {
        throw bad();
      }
      return out as unknown as AnalysisLimits;
    },
  };
}
