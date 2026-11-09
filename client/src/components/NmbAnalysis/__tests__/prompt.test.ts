import { buildAnalysisPrompt, parseViolation, DEFAULT_IMPORTS } from '../prompt';

const base = {
  name: 'statements.csv',
  columns: [
    { name: 'amount', kind: 'numeric' as const },
    { name: 'booked_at', kind: 'datetime' as const },
  ],
  csv: 'amount,booked_at\n10.5,2025-01-02\n',
  allowedImports: ['pandas', 'numpy'],
};

describe('buildAnalysisPrompt', () => {
  it('includes the dataset name, schema and the synthetic sample', () => {
    const out = buildAnalysisPrompt(base);
    expect(out).toContain('Dataset: statements.csv');
    expect(out).toContain('- amount (numeric)');
    expect(out).toContain('- booked_at (datetime)');
    expect(out).toContain('```csv\namount,booked_at\n10.5,2025-01-02\n```');
    expect(out).toContain('synthetic');
  });

  it('states the code contract with the limits imports', () => {
    const out = buildAnalysisPrompt(base);
    expect(out).toContain('DATA_PATH');
    expect(out).toContain('OUTPUT_DIR');
    expect(out).toContain('Only import: pandas, numpy.');
    expect(out).toContain('Do not use the network');
  });

  it('tells the model it may draw a chart with the provided save_chart, within the limits', () => {
    const out = buildAnalysisPrompt(base);
    expect(out).toContain('save_chart(spec, name)');
    expect(out).toContain('do not import it');
    expect(out).toContain('"version": 1');
    expect(out).toContain('"bar" | "stacked_bar" | "line" | "pie"');
    expect(out).toContain('"values": [number or None]');
    expect(out).toContain('at most 60 categories, 12 series and 5 charts');
    expect(out).toContain('aggregated values only');
    expect(out).toContain('Do not also print the same numbers');
  });

  it('keeps save_chart out of the import allow-list', () => {
    expect(buildAnalysisPrompt(base)).toContain('Only import: pandas, numpy.');
    expect(DEFAULT_IMPORTS).not.toContain('save_chart');
  });

  it('falls back to the default import list', () => {
    const out = buildAnalysisPrompt({ ...base, allowedImports: [] });
    expect(out).toContain(`Only import: ${DEFAULT_IMPORTS.join(', ')}.`);
  });

  it('adds the question only when provided', () => {
    expect(buildAnalysisPrompt(base)).not.toContain('Analysis to perform');
    expect(buildAnalysisPrompt({ ...base, question: '  monthly totals ' })).toContain(
      'Analysis to perform:\nmonthly totals',
    );
  });

  it('lists only the columns given', () => {
    const out = buildAnalysisPrompt({ ...base, columns: [base.columns[0]] });
    expect(out).not.toContain('booked_at (datetime)');
  });
});

describe('parseViolation', () => {
  it('splits rule and line', () => {
    expect(parseViolation('import:os@3')).toEqual({ rule: 'import:os', line: 3 });
  });

  it('reads the scanner line form rule@L<line>', () => {
    expect(parseViolation('import_not_allowed@L3')).toEqual({
      rule: 'import_not_allowed',
      line: 3,
    });
  });

  it('keeps rules without a line', () => {
    expect(parseViolation('too_long')).toEqual({ rule: 'too_long' });
  });
});
