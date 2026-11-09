/**
 * Categorical series colours. Theme tokens have no categorical set, so these are data encodings
 * rather than appearance: the Okabe-Ito colour-blind-safe set plus extra hues, all with enough
 * contrast against both the light and the dark surface. Text, axes and grid use theme classes.
 */
export const SERIES_COLORS: readonly string[] = [
  '#0072B2',
  '#E69F00',
  '#009E73',
  '#CC79A7',
  '#56B4E9',
  '#D55E00',
  '#8E6BBF',
  '#7F7F7F',
  '#17A2B8',
  '#B5651D',
  '#6A9F3B',
  '#E377C2',
];

export const seriesColor = (index: number): string => SERIES_COLORS[index % SERIES_COLORS.length];

export type Domain = { min: number; max: number; ticks: number[] };

/** Rounds `range / count` to 1, 2, 5 or 10 times a power of ten. */
function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / pow;
  const nice = [1, 2, 5].find((n) => frac <= n) ?? 10;
  return nice * pow;
}

/** A value axis with round tick marks that always contains `[min, max]`; `zero` forces the baseline in. */
export function niceDomain(min: number, max: number, zero: boolean, count = 5): Domain {
  let lo = zero ? Math.min(0, min) : min;
  let hi = zero ? Math.max(0, max) : max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
  }
  const step = niceStep(hi - lo, count);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  const n = Math.round((end - start) / step);
  for (let i = 0; i <= n; i++) {
    ticks.push(Number((start + i * step).toPrecision(12)));
  }
  return { min: start, max: end, ticks };
}

export const formatValue = (value: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

export const formatTick = (value: number): string =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value);

/** Min and max over every non-null value, or null when there is none. */
export function extent(values: Array<number | null>[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const row of values) {
    for (const v of row) {
      if (v != null) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
  }
  return min === Infinity ? null : { min, max };
}

/** Per-category totals of the positive and the negative values, for stacked bars. */
export function stackExtent(values: Array<number | null>[]): { min: number; max: number } | null {
  const width = values[0]?.length ?? 0;
  let min = Infinity;
  let max = -Infinity;
  for (let c = 0; c < width; c++) {
    let pos = 0;
    let neg = 0;
    let any = false;
    for (const row of values) {
      const v = row[c];
      if (v != null) {
        any = true;
        if (v >= 0) {
          pos += v;
        } else {
          neg += v;
        }
      }
    }
    if (any) {
      min = Math.min(min, neg);
      max = Math.max(max, pos);
    }
  }
  return min === Infinity ? null : { min, max };
}

/** `{n}` characters for a slug used as a download filename. */
export function fileSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'chart';
}
