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

  it('keeps rules without a line', () => {
    expect(parseViolation('too_long')).toEqual({ rule: 'too_long' });
  });
});
