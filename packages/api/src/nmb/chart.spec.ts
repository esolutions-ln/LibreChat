import { stripNmbMaskNote } from 'librechat-data-provider';
import type { NmbConfig } from './types';
import { baseConfig, fakeScanner, mockReq, mockRes, scanResult } from './testkit.helper';
import { CHART_NOTE, CHART_NOTE_MARKER, MASK_NOTE, createNmbChatGateway } from './chat';
import { MAX_SPEC_BYTES, validateChartSpec } from './chart';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const valid = () => ({
  version: 1,
  title: 'Net interest income',
  type: 'bar',
  unit: 'USD m',
  source: 'Annual report',
  categories: ['2023', '2024'],
  series: [{ name: 'NII', values: [41.2, null] }],
});

describe('validateChartSpec', () => {
  it('accepts a valid spec, keeping nulls and optional fields', () => {
    const r = validateChartSpec(valid());
    expect(r.ok).toBe(true);
    expect(r.ok && r.spec.series[0].values).toEqual([41.2, null]);
    expect(r.ok && r.spec.unit).toBe('USD m');
  });

  it('drops unknown fields rather than forwarding them', () => {
    const r = validateChartSpec({
      ...valid(),
      html: '<script>',
      series: [{ ...valid().series[0], x: 1 }],
    });
    expect(r.ok && JSON.stringify(r.spec)).not.toMatch(/script|"x"/);
  });

  it.each([
    ['not an object', null, 'not_object'],
    ['an array', [], 'not_object'],
    ['wrong version', { ...valid(), version: 2 }, 'version'],
    ['empty title', { ...valid(), title: '  ' }, 'title'],
    ['long title', { ...valid(), title: 'x'.repeat(121) }, 'title'],
    ['unknown type', { ...valid(), type: 'radar' }, 'type'],
    ['non-string unit', { ...valid(), unit: 5 }, 'text_field'],
    ['no categories', { ...valid(), categories: [] }, 'categories'],
    [
      '61 categories',
      { ...valid(), categories: Array.from({ length: 61 }, (_, i) => `c${i}`) },
      'categories',
    ],
    ['numeric category', { ...valid(), categories: [2023, 2024] }, 'categories'],
    ['no series', { ...valid(), series: [] }, 'series'],
    [
      '13 series',
      {
        ...valid(),
        series: Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, values: [1, 2] })),
      },
      'series',
    ],
    ['unnamed series', { ...valid(), series: [{ name: '', values: [1, 2] }] }, 'series'],
    ['length mismatch', { ...valid(), series: [{ name: 'a', values: [1] }] }, 'values'],
    ['NaN value', { ...valid(), series: [{ name: 'a', values: [1, NaN] }] }, 'values'],
    ['Infinity value', { ...valid(), series: [{ name: 'a', values: [1, Infinity] }] }, 'values'],
    ['string value', { ...valid(), series: [{ name: 'a', values: [1, '2'] }] }, 'values'],
    [
      'negative pie',
      { ...valid(), type: 'pie', series: [{ name: 'a', values: [1, -2] }] },
      'pie_negative',
    ],
    ['control chars', { ...valid(), title: 'a\u0007b' }, 'control_chars'],
    ['newline in name', { ...valid(), categories: ['a\nb', 'c'] }, 'control_chars'],
  ])('rejects %s', (_n, input, error) => {
    expect(validateChartSpec(input)).toEqual({ ok: false, error });
  });

  it.each(['model', 'computed'])('keeps origin %s', (origin) => {
    const r = validateChartSpec({ ...valid(), origin });
    expect(r.ok && r.spec.origin).toBe(origin);
  });

  it('leaves origin unset when absent and rejects any other value', () => {
    const r = validateChartSpec(valid());
    expect(r.ok && 'origin' in r.spec).toBe(false);
    expect(validateChartSpec({ ...valid(), origin: 'user' })).toEqual({
      ok: false,
      error: 'origin',
    });
    expect(validateChartSpec({ ...valid(), origin: 1 })).toEqual({ ok: false, error: 'origin' });
  });

  it('allows a negative value outside pie charts', () => {
    expect(validateChartSpec({ ...valid(), series: [{ name: 'a', values: [-1, 2] }] }).ok).toBe(
      true,
    );
  });

  it('accepts the worst-case valid spec: the byte cap is only a backstop above the element limits', () => {
    const worst = {
      ...valid(),
      title: 'x'.repeat(120),
      unit: 'u'.repeat(120),
      source: 's'.repeat(120),
      categories: Array.from(
        { length: 60 },
        (_, i) => `${String(i).padStart(2, '0')}${'c'.repeat(78)}`,
      ),
      series: Array.from({ length: 12 }, (_, i) => ({
        name: `${String(i).padStart(2, '0')}${'n'.repeat(78)}`,
        values: Array.from({ length: 60 }, () => 1.2345678901234567e-100),
      })),
    };
    const r = validateChartSpec(worst);
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(worst))).toBeLessThan(MAX_SPEC_BYTES);
  });
});

describe('chart note in the chat gateway', () => {
  const on: NmbConfig = { ...baseConfig, reports: { enabled: true } };
  const send = async (body: Record<string, unknown>, config: NmbConfig = on) => {
    const gate = createNmbChatGateway({
      config,
      scanner: fakeScanner({
        scanText: jest
          .fn()
          .mockImplementation(async (text: string) => scanResult({ sanitized_content: text })),
      }),
    });
    const req = mockReq({ body });
    await gate(req, mockRes(), jest.fn());
    return req.body.text as string;
  };

  it('is appended when files are attached', async () => {
    expect(await send({ text: 'Analyse this', files: [{ file_id: 'f1' }] })).toBe(
      `Analyse this${CHART_NOTE}`,
    );
  });

  it.each([
    'Show a chart of revenue',
    'plot net income',
    'Visualise the trend',
    'a bar graph please',
  ])('is appended when the message asks for a visual: %s', async (text) => {
    expect(await send({ text })).toBe(`${text}${CHART_NOTE}`);
  });

  it('is not appended to an ordinary message', async () => {
    expect(await send({ text: 'What was profit in 2024?' })).toBe('What was profit in 2024?');
  });

  it('is not appended when reports are disabled', async () => {
    expect(await send({ text: 'chart revenue', files: [{ file_id: 'f1' }] }, baseConfig)).toBe(
      'chart revenue',
    );
  });

  it('follows the redaction note, so one strip removes both', async () => {
    const gate = createNmbChatGateway({
      config: on,
      scanner: fakeScanner({
        scanText: jest.fn().mockResolvedValue(
          scanResult({
            decision: 'mask',
            sanitized_content: 'chart <ACCOUNT_001>',
            findings: [
              {
                entity: 'ACCOUNT_NUMBER',
                type: 'financial',
                location: { segment: 'text', start: 6, end: 19 },
                score: 0.9,
                action: 'MASK',
                value_hash: 'abc123abc123',
                placeholder: '<ACCOUNT_001>',
              },
            ],
          }),
        ),
      }),
    });
    const req = mockReq({ body: { text: 'chart 1234567890123' } });
    await gate(req, mockRes(), jest.fn());
    expect(req.body.text).toBe(`chart <ACCOUNT_001>${MASK_NOTE}${CHART_NOTE}`);
    expect(req.body.text.indexOf(CHART_NOTE_MARKER)).toBeGreaterThan(
      req.body.text.indexOf(MASK_NOTE),
    );
  });

  it('is removed again by the display stripper, so edited messages do not accumulate notes', () => {
    expect(stripNmbMaskNote(`hello${CHART_NOTE}`)).toBe('hello');
    expect(stripNmbMaskNote(`hello${MASK_NOTE}${CHART_NOTE}`)).toBe('hello');
    expect(stripNmbMaskNote('hello')).toBe('hello');
  });

  it('tells the model the exact fence and limits', () => {
    expect(CHART_NOTE).toContain('nmb-chart');
    expect(CHART_NOTE).toContain('60 categories and 12 series');
  });
});
