import {
  NMB_CHART_LIMITS,
  NMB_CHART_NOTE_MARKER,
  NMB_MASK_NOTE,
  NMB_MASK_NOTE_MARKER,
  NMB_SYNTHETIC_NOTE_MARKER,
  parseNmbChartSpec,
  stripNmbMaskNote,
} from '../src/types/nmb';
import * as endpoints from '../src/api-endpoints';
import * as dataService from '../src/data-service';
import request from '../src/request';

jest.mock('../src/request', () => ({
  __esModule: true,
  default: { post: jest.fn().mockResolvedValue({}), get: jest.fn() },
}));

const valid = {
  version: 1,
  title: 'Net interest income',
  type: 'bar',
  unit: 'USD m',
  source: 'Income statement',
  categories: ['2023', '2024'],
  series: [
    { name: 'Net interest income', values: [41.2, 48.9] },
    { name: 'Fee income', values: [12, null] },
  ],
};

const parse = (over: Record<string, unknown> = {}) =>
  parseNmbChartSpec(JSON.stringify({ ...valid, ...over }));

const errorOf = (r: ReturnType<typeof parseNmbChartSpec>) => (r.ok ? null : r.error);

describe('parseNmbChartSpec', () => {
  it('accepts a valid spec and keeps nulls', () => {
    const r = parse();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.series[1].values).toEqual([12, null]);
      expect(r.spec.unit).toBe('USD m');
    }
  });

  it.each(['bar', 'stacked_bar', 'line', 'pie'])('accepts type %s', (type) => {
    expect(parse({ type }).ok).toBe(true);
  });

  it('treats partial or non-JSON text as invalid_json, never throwing', () => {
    expect(errorOf(parseNmbChartSpec('{"version":1,"title":"x"'))).toBe('invalid_json');
    expect(errorOf(parseNmbChartSpec(''))).toBe('invalid_json');
    expect(errorOf(parseNmbChartSpec('not json'))).toBe('invalid_json');
  });

  it('rejects non-objects', () => {
    expect(errorOf(parseNmbChartSpec('[1]'))).toBe('invalid_shape');
    expect(errorOf(parseNmbChartSpec('null'))).toBe('invalid_shape');
    expect(errorOf(parse({ categories: 'a' }))).toBe('invalid_shape');
    expect(errorOf(parse({ series: [{ name: 'a' }] }))).toBe('invalid_shape');
  });

  it('rejects an unknown version and chart type', () => {
    expect(errorOf(parse({ version: 2 }))).toBe('unsupported_version');
    expect(errorOf(parse({ type: 'radar' }))).toBe('invalid_type');
    expect(errorOf(parse({ type: 3 }))).toBe('invalid_type');
  });

  it('enforces text limits and rejects control characters', () => {
    expect(errorOf(parse({ title: '' }))).toBe('invalid_text');
    expect(errorOf(parse({ title: '   ' }))).toBe('invalid_text');
    expect(errorOf(parse({ title: 'x'.repeat(NMB_CHART_LIMITS.maxTitle + 1) }))).toBe(
      'invalid_text',
    );
    expect(parse({ title: 'x'.repeat(NMB_CHART_LIMITS.maxTitle) }).ok).toBe(true);
    expect(errorOf(parse({ unit: 'u'.repeat(NMB_CHART_LIMITS.maxNote + 1) }))).toBe('invalid_text');
    expect(errorOf(parse({ source: 'a\u0000b' }))).toBe('invalid_text');
    expect(errorOf(parse({ title: 'a\nb' }))).toBe('invalid_text');
    expect(errorOf(parse({ categories: ['ok', 'bad\u0007'] }))).toBe('invalid_text');
    expect(
      errorOf(
        parse({ series: [{ name: 'n'.repeat(NMB_CHART_LIMITS.maxName + 1), values: [1, 2] }] }),
      ),
    ).toBe('invalid_text');
  });

  it('limits categories to 1..60', () => {
    expect(errorOf(parse({ categories: [], series: [{ name: 'a', values: [] }] }))).toBe(
      'too_many_categories',
    );
    const many = Array.from({ length: 61 }, (_, i) => `c${i}`);
    expect(
      errorOf(parse({ categories: many, series: [{ name: 'a', values: many.map(() => 1) }] })),
    ).toBe('too_many_categories');
    const ok = many.slice(0, 60);
    expect(parse({ categories: ok, series: [{ name: 'a', values: ok.map(() => 1) }] }).ok).toBe(
      true,
    );
  });

  it('limits series to 1..12', () => {
    expect(errorOf(parse({ series: [] }))).toBe('too_many_series');
    const series = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `s${i}`, values: [1, 2] }));
    expect(parse({ series: series(12) }).ok).toBe(true);
    expect(errorOf(parse({ series: series(13) }))).toBe('too_many_series');
  });

  it('requires every series to match the category count', () => {
    expect(errorOf(parse({ series: [{ name: 'a', values: [1] }] }))).toBe('length_mismatch');
    expect(errorOf(parse({ series: [{ name: 'a', values: [1, 2, 3] }] }))).toBe('length_mismatch');
  });

  it('accepts only finite numbers or null as values', () => {
    expect(errorOf(parse({ series: [{ name: 'a', values: ['1', 2] }] }))).toBe('invalid_value');
    expect(errorOf(parse({ series: [{ name: 'a', values: [true, 2] }] }))).toBe('invalid_value');
    expect(errorOf(parse({ series: [{ name: 'a', values: [{}, 2] }] }))).toBe('invalid_value');
    // 1e999 parses to Infinity
    expect(errorOf(parseNmbChartSpec(JSON.stringify(valid).replace('41.2', '1e999')))).toBe(
      'invalid_value',
    );
    expect(parse({ series: [{ name: 'a', values: [null, null] }] }).ok).toBe(true);
  });

  it('rejects negative values for a pie but allows them elsewhere', () => {
    const series = [{ name: 'a', values: [5, -1] }];
    expect(errorOf(parse({ type: 'pie', series }))).toBe('negative_pie');
    expect(parse({ type: 'bar', series }).ok).toBe(true);
    expect(parse({ type: 'pie', series: [{ name: 'a', values: [5, null] }] }).ok).toBe(true);
  });

  it('rejects a spec over 64 KB', () => {
    const big = JSON.stringify({ ...valid, source: 'x'.repeat(NMB_CHART_LIMITS.maxBytes) });
    expect(errorOf(parseNmbChartSpec(big))).toBe('too_large');
  });

  it.each(['model', 'computed'])('accepts and keeps origin %s', (origin) => {
    const r = parse({ origin });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.origin).toBe(origin);
    }
  });

  it('leaves origin unset when absent and rejects any other value', () => {
    const r = parse();
    expect(r.ok && r.spec.origin).toBeFalsy();
    expect(errorOf(parse({ origin: 'user' }))).toBe('invalid_type');
    expect(errorOf(parse({ origin: '' }))).toBe('invalid_type');
    expect(errorOf(parse({ origin: null }))).toBe('invalid_type');
    expect(errorOf(parse({ origin: 1 }))).toBe('invalid_type');
  });

  it('drops unknown fields from the returned spec', () => {
    const r = parse({ extra: 'x', series: [{ name: 'a', values: [1, 2], color: 'red' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec).not.toHaveProperty('extra');
      expect(r.spec.series[0]).toEqual({ name: 'a', values: [1, 2] });
    }
  });
});

describe('stripNmbMaskNote', () => {
  it('leaves text without a note untouched', () => {
    expect(stripNmbMaskNote('hello')).toBe('hello');
  });

  it('cuts at the redaction note', () => {
    expect(stripNmbMaskNote(`pay <ACCOUNT_001>${NMB_MASK_NOTE}`)).toBe('pay <ACCOUNT_001>');
  });

  it('cuts at the chart note', () => {
    expect(stripNmbMaskNote(`chart it${NMB_CHART_NOTE_MARKER} reply with a block.]`)).toBe(
      'chart it',
    );
  });

  it('cuts at the earliest marker when both notes are present, in either order', () => {
    const redaction = `${NMB_MASK_NOTE_MARKER} tokens stand in.]`;
    const chart = `${NMB_CHART_NOTE_MARKER} reply with a block.]`;
    expect(stripNmbMaskNote(`text${redaction}${chart}`)).toBe('text');
    expect(stripNmbMaskNote(`text${chart}${redaction}`)).toBe('text');
  });

  it('keeps the redaction marker unchanged', () => {
    expect(NMB_MASK_NOTE_MARKER).toBe('\n\n[NMB redaction note:');
    expect(NMB_CHART_NOTE_MARKER).toBe('\n\n[NMB chart note:');
    expect(NMB_SYNTHETIC_NOTE_MARKER).toBe('\n\n[NMB synthetic note:');
  });

  it('cuts at the synthetic note', () => {
    expect(stripNmbMaskNote(`Pay Jane Doe${NMB_SYNTHETIC_NOTE_MARKER} names are fictional.]`)).toBe(
      'Pay Jane Doe',
    );
  });

  it('cuts at the earliest of all three markers, whatever the order', () => {
    const notes = [
      `${NMB_MASK_NOTE_MARKER} a.]`,
      `${NMB_CHART_NOTE_MARKER} b.]`,
      `${NMB_SYNTHETIC_NOTE_MARKER} c.]`,
    ];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      expect(stripNmbMaskNote(`text${order.map((i) => notes[i]).join('')}`)).toBe('text');
    }
  });

  it('does not cut text that only mentions a note without the line break', () => {
    expect(stripNmbMaskNote('see [NMB synthetic note: in the docs')).toBe(
      'see [NMB synthetic note: in the docs',
    );
  });
});

describe('unmaskNmbText and approveNmbReview payloads', () => {
  const post = request.post as jest.Mock;
  beforeEach(() => post.mockClear());

  it('sends only the text for the token-only behaviour', async () => {
    await dataService.unmaskNmbText('pay <ACCOUNT_001>');
    expect(post).toHaveBeenCalledWith(endpoints.nmbUnmask(), { text: 'pay <ACCOUNT_001>' });
    await dataService.unmaskNmbText('x', {});
    await dataService.unmaskNmbText('x', { synthetic: false });
    expect(post).toHaveBeenLastCalledWith(endpoints.nmbUnmask(), { text: 'x' });
  });

  it('adds synthetic: true only when asked', async () => {
    await dataService.unmaskNmbText('Pay Jane Doe', { synthetic: true });
    expect(post).toHaveBeenCalledWith(endpoints.nmbUnmask(), {
      text: 'Pay Jane Doe',
      synthetic: true,
    });
  });

  it('passes the approval mode through to the gateway', async () => {
    await dataService.approveNmbReview('rev_0123456789ab', { note: 'ok', mode: 'synthetic' });
    expect(post).toHaveBeenCalledWith(endpoints.nmbReviewApprove('rev_0123456789ab'), {
      note: 'ok',
      mode: 'synthetic',
    });
  });
});

describe('nmb analysis and report endpoints', () => {
  it('addresses analysis routes under /api/nmb/analysis and encodes ids', () => {
    expect(endpoints.nmbDatasets()).toMatch(/\/api\/nmb\/analysis\/datasets$/);
    expect(endpoints.nmbRun('run_1')).toMatch(/\/api\/nmb\/analysis\/runs\/run_1$/);
    expect(endpoints.nmbRunFile('run_1', 'a b.csv')).toMatch(/\/files\/a%20b\.csv$/);
    expect(endpoints.nmbAnalysisLimits()).toMatch(/\/api\/nmb\/analysis\/limits$/);
  });

  it('exposes the report export route', () => {
    expect(endpoints.nmbReportExport()).toMatch(/\/api\/nmb\/reports\/export$/);
  });
});
