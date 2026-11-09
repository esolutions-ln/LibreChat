/** ChartSpec v1 (docs/nmb/REPORTS.md). Validated at the gateway so the scanner only ever sees a bounded, well-formed spec. */

export type ChartType = 'bar' | 'stacked_bar' | 'line' | 'pie';

export interface ChartSeries {
  name: string;
  values: Array<number | null>;
}

export interface ChartSpec {
  version: 1;
  title: string;
  type: ChartType;
  unit?: string;
  source?: string;
  /** `model`: read by the AI from a document (default). `computed`: produced by analysis code from uploaded data. */
  origin?: 'model' | 'computed';
  categories: string[];
  series: ChartSeries[];
}

export type ChartSpecError =
  | 'not_object'
  | 'version'
  | 'title'
  | 'type'
  | 'text_field'
  | 'origin'
  | 'categories'
  | 'series'
  | 'values'
  | 'pie_negative'
  | 'too_large'
  | 'control_chars';

export type ChartSpecResult = { ok: true; spec: ChartSpec } | { ok: false; error: ChartSpecError };

const TYPES = new Set<string>(['bar', 'stacked_bar', 'line', 'pie']);
const MAX_TITLE = 120;
const MAX_NOTE = 120;
const MAX_NAME = 80;
const MAX_CATEGORIES = 60;
const MAX_SERIES = 12;
export const MAX_SPEC_BYTES: number = 64 * 1024;
/* eslint-disable-next-line no-control-regex */
const CONTROL = /[\u0000-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

const text = (v: unknown, max: number, required: boolean): string | undefined | null => {
  if (v === undefined) {
    return required ? null : undefined;
  }
  if (typeof v !== 'string' || v.length > max || (required && v.trim().length === 0)) {
    return null;
  }
  return v;
};

export function validateChartSpec(input: unknown): ChartSpecResult {
  if (!isRecord(input)) {
    return { ok: false, error: 'not_object' };
  }
  if (input.version !== 1) {
    return { ok: false, error: 'version' };
  }
  const title = text(input.title, MAX_TITLE, true);
  if (typeof title !== 'string') {
    return { ok: false, error: 'title' };
  }
  if (typeof input.type !== 'string' || !TYPES.has(input.type)) {
    return { ok: false, error: 'type' };
  }
  const unit = text(input.unit, MAX_NOTE, false);
  const source = text(input.source, MAX_NOTE, false);
  if (unit === null || source === null) {
    return { ok: false, error: 'text_field' };
  }
  if (input.origin !== undefined && input.origin !== 'model' && input.origin !== 'computed') {
    return { ok: false, error: 'origin' };
  }
  const categories = input.categories;
  if (
    !Array.isArray(categories) ||
    categories.length < 1 ||
    categories.length > MAX_CATEGORIES ||
    !categories.every((c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_NAME)
  ) {
    return { ok: false, error: 'categories' };
  }
  const series = input.series;
  if (!Array.isArray(series) || series.length < 1 || series.length > MAX_SERIES) {
    return { ok: false, error: 'series' };
  }
  const cleanSeries: ChartSeries[] = [];
  for (const s of series) {
    if (
      !isRecord(s) ||
      typeof s.name !== 'string' ||
      s.name.length < 1 ||
      s.name.length > MAX_NAME
    ) {
      return { ok: false, error: 'series' };
    }
    const values = s.values;
    if (
      !Array.isArray(values) ||
      values.length !== categories.length ||
      !values.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v)))
    ) {
      return { ok: false, error: 'values' };
    }
    cleanSeries.push({ name: s.name, values: values as Array<number | null> });
  }
  if (input.type === 'pie' && cleanSeries[0].values.some((v) => v != null && v < 0)) {
    return { ok: false, error: 'pie_negative' };
  }
  const spec: ChartSpec = {
    version: 1,
    title,
    type: input.type as ChartType,
    ...(unit ? { unit } : {}),
    ...(source ? { source } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    categories: categories as string[],
    series: cleanSeries,
  };
  const strings = [
    title,
    unit ?? '',
    source ?? '',
    ...spec.categories,
    ...spec.series.map((s) => s.name),
  ];
  if (strings.some((s) => CONTROL.test(s))) {
    return { ok: false, error: 'control_chars' };
  }
  if (Buffer.byteLength(JSON.stringify(spec), 'utf8') > MAX_SPEC_BYTES) {
    return { ok: false, error: 'too_large' };
  }
  return { ok: true, spec };
}
