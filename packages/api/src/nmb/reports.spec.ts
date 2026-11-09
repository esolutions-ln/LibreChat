import type { ReportAuditEntry, ReportClient } from './reports';
import type { NmbConfig } from './types';
import { createReportClient, createReportHandlers } from './reports';
import { baseConfig, mockReq, mockRes } from './testkit.helper';
import { ScannerError } from './scanner';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const config: NmbConfig = { ...baseConfig, reports: { enabled: true } };
const spec = () => ({
  version: 1,
  title: 'Secret Quarterly Title',
  type: 'bar',
  categories: ['2023', '2024'],
  series: [{ name: 'Confidential Series', values: [1.5, 2.5] }],
});
const FILE = { bytes: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' };

function setup(opts: { config?: NmbConfig; render?: jest.Mock } = {}) {
  const audits: ReportAuditEntry[] = [];
  const render = opts.render ?? jest.fn().mockResolvedValue(FILE);
  const handlers = createReportHandlers({
    config: opts.config ?? config,
    reports: { render } as unknown as ReportClient,
    recordAudit: async (e) => {
      audits.push(e);
    },
  });
  return { handlers, render, audits };
}

const call = async (handler: unknown, req: ReturnType<typeof mockReq>) => {
  const res = mockRes() as ReturnType<typeof mockRes> & { end: jest.Mock };
  res.end = jest.fn();
  const next = jest.fn();
  await (handler as (q: unknown, r: unknown, n: unknown) => Promise<void>)(req, res, next);
  return { res, next };
};

describe('report gate', () => {
  it.each([
    ['gateway off', { ...config, enabled: false }],
    ['reports off', { ...config, reports: { enabled: false } }],
  ])('answers 404 when %s', async (_n, cfg) => {
    const { handlers } = setup({ config: cfg });
    const { res, next } = await call(handlers.gate, mockReq());
    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('answers 503 when the scanner is not configured and passes otherwise', async () => {
    const bad = setup({ config: { ...config, serviceKey: '' } });
    expect((await call(bad.handlers.gate, mockReq())).res.statusCode).toBe(503);
    const ok = setup();
    expect((await call(ok.handlers.gate, mockReq())).next).toHaveBeenCalled();
  });
});

describe('export', () => {
  const body = (over: Record<string, unknown> = {}) => ({ format: 'pdf', spec: spec(), ...over });

  it('requires an authenticated user', async () => {
    const { handlers, render } = setup();
    const { res } = await call(handlers.exportReport, mockReq({ user: undefined, body: body() }));
    expect(res.statusCode).toBe(401);
    expect(render).not.toHaveBeenCalled();
  });

  it.each([[{ format: 'docx' }], [{ format: undefined }], [{ spec: { version: 1 } }]])(
    'rejects an invalid request %j',
    async (over) => {
      const { handlers, render } = setup();
      const { res } = await call(handlers.exportReport, mockReq({ body: body(over) }));
      expect(res.statusCode).toBe(400);
      expect(render).not.toHaveBeenCalled();
    },
  );

  it('returns the file as a private, non-sniffable attachment', async () => {
    const { handlers, render } = setup();
    const { res } = await call(handlers.exportReport, mockReq({ body: body() }));
    expect(render).toHaveBeenCalledWith(
      'pdf',
      expect.objectContaining({ title: 'Secret Quarterly Title' }),
    );
    expect(res.end).toHaveBeenCalledWith(FILE.bytes);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="report.pdf"');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('audits format and counts, never titles, names or values', async () => {
    const { handlers, audits } = setup();
    await call(handlers.exportReport, mockReq({ body: body({ format: 'xlsx' }) }));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'nmb_report.exported',
      outcome: 'success',
      metadata: { format: 'xlsx', chart: 'bar', series: 1, points: 2, bytes: FILE.bytes.length },
    });
    const text = JSON.stringify(audits);
    expect(text).not.toContain('Secret Quarterly Title');
    expect(text).not.toContain('Confidential Series');
    expect(text).not.toContain('1.5');
  });

  it('answers 503 without detail and audits a failure when the scanner is down', async () => {
    const { handlers, audits } = setup({
      render: jest.fn().mockRejectedValue(new ScannerError('unavailable')),
    });
    const { res } = await call(handlers.exportReport, mockReq({ body: body() }));
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('scanner');
    expect(audits[0].outcome).toBe('failure');
  });

  it('answers 422 when the scanner rejects the spec', async () => {
    const { handlers } = setup({
      render: jest.fn().mockRejectedValue(new ScannerError('bad_request', 422)),
    });
    expect((await call(handlers.exportReport, mockReq({ body: body() }))).res.statusCode).toBe(422);
  });
});

describe('report client', () => {
  const response = (bytes: Buffer, type = 'application/pdf') =>
    ({
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    }) as unknown as Response;

  it('posts the spec to the right scanner path and returns bytes and type', async () => {
    const call = jest.fn().mockResolvedValue(response(Buffer.from('abc')));
    const out = await createReportClient(call).render('xlsx', spec() as never);
    expect(call).toHaveBeenCalledWith('POST', '/report/xlsx', { json: spec(), raw: true });
    expect(out.bytes.toString()).toBe('abc');
    expect(out.contentType).toBe('application/pdf');
  });

  it('treats an empty body as a bad response', async () => {
    const call = jest.fn().mockResolvedValue(response(Buffer.alloc(0)));
    await expect(createReportClient(call).render('pdf', spec() as never)).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});
