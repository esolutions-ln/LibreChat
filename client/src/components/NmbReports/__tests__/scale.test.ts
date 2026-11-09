import { extent, fileSlug, niceDomain, seriesColor, SERIES_COLORS, stackExtent } from '../scale';

describe('niceDomain', () => {
  it('rounds to a 1, 2 or 5 step and always contains the data', () => {
    const d = niceDomain(0, 48.9, true);
    expect(d.min).toBe(0);
    expect(d.max).toBe(50);
    expect(d.ticks).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('forces the zero baseline in for bars and not for lines', () => {
    expect(niceDomain(40, 90, true).min).toBe(0);
    expect(niceDomain(40, 90, false).min).toBe(40);
  });

  it('handles negatives, flat data and no finite range', () => {
    const neg = niceDomain(-30, 10, true);
    expect(neg.min).toBeLessThanOrEqual(-30);
    expect(neg.max).toBeGreaterThanOrEqual(10);
    expect(neg.ticks).toContain(0);
    const flat = niceDomain(5, 5, false);
    expect(flat.max).toBeGreaterThan(flat.min);
    expect(niceDomain(Infinity, -Infinity, true).ticks.length).toBeGreaterThan(1);
  });

  it('produces ticks free of floating point noise', () => {
    niceDomain(0, 1, true).ticks.forEach((t) => expect(String(t).length).toBeLessThan(6));
  });
});

describe('extent and stackExtent', () => {
  it('ignores nulls and reports null when there is no value', () => {
    expect(
      extent([
        [1, null],
        [null, 5],
      ]),
    ).toEqual({ min: 1, max: 5 });
    expect(extent([[null, null]])).toBeNull();
  });

  it('stacks positives and negatives separately per category', () => {
    expect(
      stackExtent([
        [10, -2],
        [5, -3],
        [null, 4],
      ]),
    ).toEqual({ min: -5, max: 15 });
    expect(stackExtent([[null]])).toBeNull();
  });
});

describe('series colours and file names', () => {
  it('has a distinct colour for each of the 12 allowed series and wraps beyond that', () => {
    expect(new Set(SERIES_COLORS).size).toBe(12);
    expect(seriesColor(12)).toBe(seriesColor(0));
  });

  it('builds a safe download slug', () => {
    expect(fileSlug('Net interest income, FY2024 (USD m)')).toBe(
      'net-interest-income-fy2024-usd-m',
    );
    expect(fileSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(fileSlug('???')).toBe('chart');
    expect(fileSlug('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
