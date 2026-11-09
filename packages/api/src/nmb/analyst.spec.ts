import type { AnalysisDataset, AnalysisRun, NmbConfig } from './types';
import { createAnalysisHandlers, type AnalysisAuditEntry } from './analyst';
import { createAnalysisClient, type AnalysisClient } from './analysis';
import { baseConfig, mockReq, mockRes } from './testkit.helper';
import { ScannerError } from './scanner';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const DS = 'ds_0123456789ab';
const RUN = 'run_0123456789ab';
const CODE = "import pandas as pd\nprint(pd.read_csv(DATA_PATH)['secret_col'].sum())";

const config: NmbConfig = {
  ...baseConfig,
  analysis: { enabled: true, maxUploadBytes: 100, maxCodeChars: 200, executeTimeoutMs: 1000 },
};

const dataset = (over: Partial<AnalysisDataset> = {}): AnalysisDataset => ({
  id: DS,
  name: 'statements.csv',
  rows: 10,
  created_at: '2026-11-10T10:00:00+00:00',
  expires_at: null,
  columns: [
    {
      name: 'iban_col',
      kind: 'identifier',
      null_fraction: 0,
      sensitive: true,
      sensitive_entities: ['IBAN'],
      share: false,
    },
    {
      name: 'amount',
      kind: 'numeric',
      null_fraction: 0,
      sensitive: false,
      sensitive_entities: [],
      share: true,
    },
  ],
  synthetic: null,
  ...over,
});

const run = (over: Partial<AnalysisRun> = {}): AnalysisRun => ({
  id: RUN,
  dataset_id: DS,
  target: 'real',
  status: 'ok',
  stdout: '42',
  stderr: '',
  files: [],
  violations: [],
  duration_ms: 12,
  llm_safe: false,
  created_at: '2026-11-10T10:00:00+00:00',
  ...over,
});

function fakeAnalysis(over: Partial<Record<keyof AnalysisClient, jest.Mock>> = {}) {
  const client = {
    upload: jest.fn().mockResolvedValue(dataset()),
    list: jest.fn().mockResolvedValue([dataset()]),
    get: jest.fn().mockResolvedValue(dataset()),
    remove: jest.fn().mockResolvedValue(undefined),
    synthesize: jest.fn().mockResolvedValue(dataset()),
    synthetic: jest.fn().mockResolvedValue({ columns: ['amount'], rows: [[1]], csv: 'amount\n1' }),
    execute: jest.fn().mockResolvedValue(run()),
    getRun: jest.fn().mockResolvedValue(run()),
    getRunFile: jest.fn(),
    limits: jest.fn().mockResolvedValue({ allowed_imports: ['pandas'] }),
    ...over,
  };
  return client as typeof client & AnalysisClient;
}

function setup(opts: { config?: NmbConfig; analysis?: ReturnType<typeof fakeAnalysis> } = {}) {
  const audits: AnalysisAuditEntry[] = [];
  const analysis = opts.analysis ?? fakeAnalysis();
  const handlers = createAnalysisHandlers({
    config: opts.config ?? config,
    analysis,
    recordAudit: async (e) => {
      audits.push(e);
    },
  });
  return { handlers, analysis, audits };
}

const call = async (handler: unknown, req: ReturnType<typeof mockReq>) => {
  const res = mockRes();
  const next = jest.fn();
  await (handler as (q: unknown, r: unknown, n: unknown) => Promise<void>)(req, res, next);
  return { res, next };
};

const withId = (over: Record<string, unknown> = {}) => mockReq({ params: { id: DS }, ...over });

describe('analysis gate', () => {
  it.each([
    ['gateway off', { ...config, enabled: false }],
    ['analysis off', { ...config, analysis: { ...config.analysis, enabled: false } }],
  ])('answers 404 when %s', async (_n, cfg) => {
    const { handlers } = setup({ config: cfg });
    const { res, next } = await call(handlers.gate, mockReq());
    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 503 when the scanner is not configured', async () => {
    const { handlers } = setup({ config: { ...config, serviceKey: '' } });
    expect((await call(handlers.gate, mockReq())).res.statusCode).toBe(503);
  });

  it('passes when enabled and configured', async () => {
    const { handlers } = setup();
    expect((await call(handlers.gate, mockReq())).next).toHaveBeenCalled();
  });

  it('requires an authenticated user', async () => {
    const { handlers, analysis } = setup();
    const { res } = await call(handlers.list, mockReq({ user: undefined }));
    expect(res.statusCode).toBe(401);
    expect(analysis.list).not.toHaveBeenCalled();
  });
});

describe('upload', () => {
  const file = (name: string, size = 10) => ({
    buffer: Buffer.from('a,b\n1,2'),
    originalname: name,
    size,
  });

  it('rejects anything but a CSV and an oversize file', async () => {
    const { handlers, analysis } = setup();
    expect((await call(handlers.upload, mockReq({ file: file('x.xlsx') }))).res.statusCode).toBe(
      422,
    );
    expect((await call(handlers.upload, mockReq({}))).res.statusCode).toBe(422);
    expect(
      (await call(handlers.upload, mockReq({ file: file('x.csv', 101) }))).res.statusCode,
    ).toBe(413);
    expect(analysis.upload).not.toHaveBeenCalled();
  });

  it('uploads under the session user and audits counts, never column names', async () => {
    const { handlers, analysis, audits } = setup();
    const { res } = await call(handlers.upload, mockReq({ file: file('statements.csv') }));
    expect(res.statusCode).toBe(201);
    expect(analysis.upload.mock.calls[0][2]).toBe('user-1');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'nmb_analysis.dataset_uploaded',
      outcome: 'success',
      metadata: { rows: 10, columns: 2, sensitive_columns: 1 },
    });
    expect(JSON.stringify(audits)).not.toContain('iban_col');
  });

  it('answers 422 and audits a failure when the scanner cannot parse the CSV', async () => {
    const { handlers, audits } = setup({
      analysis: fakeAnalysis({
        upload: jest.fn().mockRejectedValue(new ScannerError('bad_request', 422)),
      }),
    });
    const { res } = await call(handlers.upload, mockReq({ file: file('bad.csv') }));
    expect(res.statusCode).toBe(422);
    expect(audits[0].outcome).toBe('failure');
  });
});

describe('dataset routes', () => {
  it('rejects malformed ids before calling the scanner', async () => {
    const { handlers, analysis } = setup();
    const { res } = await call(handlers.get, mockReq({ params: { id: '../etc/passwd' } }));
    expect(res.statusCode).toBe(400);
    expect(analysis.get).not.toHaveBeenCalled();
  });

  it("answers 404 for another user's dataset without revealing it exists", async () => {
    const { handlers } = setup({
      analysis: fakeAnalysis({
        get: jest.fn().mockRejectedValue(new ScannerError('not_found', 404)),
      }),
    });
    const { res } = await call(handlers.get, withId());
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: 'Not found' });
  });

  it('scopes every scanner call to the session user, ignoring any user in the body', async () => {
    const { handlers, analysis } = setup();
    await call(handlers.synthesize, withId({ body: { columns: ['amount'], user: 'attacker' } }));
    expect(analysis.synthesize.mock.calls[0][1]).toMatchObject({ user: 'user-1' });
  });

  it('deletes and audits', async () => {
    const { handlers, audits } = setup();
    const { res } = await call(handlers.remove, withId());
    expect(res.body).toEqual({ deleted: true });
    expect(audits[0].action).toBe('nmb_analysis.dataset_deleted');
  });

  it('marks dataset and run responses as no-store', async () => {
    const { handlers } = setup();
    expect((await call(handlers.get, withId())).res.headers['Cache-Control']).toBe('no-store');
    expect(
      (await call(handlers.getRun, mockReq({ params: { id: RUN } }))).res.headers['Cache-Control'],
    ).toBe('no-store');
  });
});

describe('synthesize', () => {
  it.each([
    [{}],
    [{ columns: [] }],
    [{ columns: [1] }],
    [{ columns: ['a'], rows: 0 }],
    [{ columns: ['a'], rows: 10_001 }],
    [{ columns: ['a'], rows: 1.5 }],
  ])('rejects invalid body %j', async (body) => {
    const { handlers, analysis } = setup();
    expect((await call(handlers.synthesize, withId({ body }))).res.statusCode).toBe(400);
    expect(analysis.synthesize).not.toHaveBeenCalled();
  });

  it('defaults to 100 rows and audits counts only', async () => {
    const { handlers, analysis, audits } = setup();
    await call(handlers.synthesize, withId({ body: { columns: ['amount'] } }));
    expect(analysis.synthesize.mock.calls[0][1].rows).toBe(100);
    expect(audits[0]).toMatchObject({
      action: 'nmb_analysis.synthesized',
      metadata: { columns: 1, rows: 100 },
    });
  });

  it('answers 409 when the synthetic twin does not exist yet', async () => {
    const { handlers } = setup({
      analysis: fakeAnalysis({
        synthetic: jest.fn().mockRejectedValue(new ScannerError('conflict', 409)),
      }),
    });
    expect((await call(handlers.synthetic, withId())).res.statusCode).toBe(409);
  });
});

describe('execute', () => {
  it.each([
    [{ code: CODE }, 400],
    [{ code: CODE, target: 'prod' }, 400],
    [{ code: '   ', target: 'real' }, 400],
    [{ code: 42, target: 'real' }, 400],
    [{ code: 'x'.repeat(201), target: 'real' }, 413],
  ])('rejects %j with %i', async (body, status) => {
    const { handlers, analysis } = setup();
    expect((await call(handlers.execute, withId({ body }))).res.statusCode).toBe(status);
    expect(analysis.execute).not.toHaveBeenCalled();
  });

  it('runs on the real data for the session user and returns an uncached private result', async () => {
    const { handlers, analysis } = setup();
    const { res } = await call(handlers.execute, withId({ body: { code: CODE, target: 'real' } }));
    expect(analysis.execute.mock.calls[0]).toEqual([
      DS,
      { user: 'user-1', code: CODE, target: 'real' },
    ]);
    expect(res.body).toMatchObject({ llm_safe: false, status: 'ok' });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('audits a code fingerprint, never the code or its output', async () => {
    const { handlers, audits } = setup();
    await call(handlers.execute, withId({ body: { code: CODE, target: 'real' } }));
    expect(audits[0]).toMatchObject({
      action: 'nmb_analysis.executed',
      outcome: 'success',
      target: { type: 'nmb_run', id: RUN },
      metadata: { target: 'real', status: 'ok', code_chars: CODE.length },
    });
    const text = JSON.stringify(audits);
    expect(text).not.toContain('secret_col');
    expect(text).not.toContain('read_csv');
    expect(audits[0].metadata?.code_sha256).toMatch(/^[0-9a-f]{16}$/);
  });

  it('audits a rejected run with its violation count', async () => {
    const { handlers, audits } = setup({
      analysis: fakeAnalysis({
        execute: jest
          .fn()
          .mockResolvedValue(run({ status: 'rejected', violations: ['import:os@1'] })),
      }),
    });
    await call(handlers.execute, withId({ body: { code: CODE, target: 'synthetic' } }));
    expect(audits[0].metadata).toMatchObject({ status: 'rejected', violations: 1 });
  });

  it('hides scanner failure detail behind a 503 and audits the failure', async () => {
    const { handlers, audits } = setup({
      analysis: fakeAnalysis({
        execute: jest.fn().mockRejectedValue(new ScannerError('unavailable')),
      }),
    });
    const { res } = await call(handlers.execute, withId({ body: { code: CODE, target: 'real' } }));
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('scanner');
    expect(audits[0].outcome).toBe('failure');
  });
});

describe('run files', () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((s) => c.enqueue(new TextEncoder().encode(s)));
        c.close();
      },
    });

  it.each(['../x.csv', 'a/b.csv', '', '..'])('rejects the file name %j', async (name) => {
    const { handlers, analysis } = setup();
    const { res } = await call(handlers.getRunFile, mockReq({ params: { id: RUN, name } }));
    expect(res.statusCode).toBe(400);
    expect(analysis.getRunFile).not.toHaveBeenCalled();
  });

  it('streams the file as a private, non-sniffable attachment', async () => {
    const written: string[] = [];
    const getRunFile = jest.fn().mockResolvedValue({
      body: stream(['a,b\n', '1,2\n']),
      contentType: 'text/csv',
      size: 8,
    });
    const { handlers } = setup({ analysis: fakeAnalysis({ getRunFile }) });
    const res = mockRes() as unknown as ReturnType<typeof mockRes> & {
      write: (b: Buffer) => boolean;
      end: () => void;
    };
    res.write = (b: Buffer): boolean => {
      written.push(b.toString());
      return true;
    };
    res.end = jest.fn();
    await (handlers.getRunFile as unknown as (q: unknown, r: unknown, n: unknown) => Promise<void>)(
      mockReq({ params: { id: RUN, name: 'summary.csv' } }),
      res,
      jest.fn(),
    );
    expect(getRunFile).toHaveBeenCalledWith(RUN, 'summary.csv', 'user-1');
    expect(written.join('')).toBe('a,b\n1,2\n');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="summary.csv"');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});

describe('analysis client', () => {
  const ok = (body: unknown) => jest.fn().mockResolvedValue(body);

  it('encodes ids and scopes reads to the user', async () => {
    const callFn = ok({ items: [dataset()] });
    const client = createAnalysisClient(callFn, 5000);
    await client.list('u 1');
    expect(callFn).toHaveBeenCalledWith('GET', '/analysis/datasets?user=u%201');
  });

  it('gives execute its own timeout', async () => {
    const callFn = ok(run());
    await createAnalysisClient(callFn, 9000).execute(DS, { user: 'u', code: 'x', target: 'real' });
    expect(callFn.mock.calls[0][2]).toMatchObject({ timeoutMs: 9000 });
  });

  it('rejects malformed scanner responses', async () => {
    const client = createAnalysisClient(ok({ nope: true }), 1000);
    await expect(client.get(DS, 'u')).rejects.toMatchObject({ kind: 'bad_response' });
    await expect(client.list('u')).rejects.toMatchObject({ kind: 'bad_response' });
    await expect(client.getRun(RUN, 'u')).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('rejects a run whose status is not in the contract', async () => {
    const client = createAnalysisClient(ok(run({ status: 'weird' as never })), 1000);
    await expect(client.getRun(RUN, 'u')).rejects.toMatchObject({ kind: 'bad_response' });
  });
});
