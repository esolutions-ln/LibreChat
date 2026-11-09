import React from 'react';
import { render, screen } from 'test/layout-test-utils';
import type { TNmbRun } from 'librechat-data-provider';
import Result from '../Result';

const base: TNmbRun = {
  id: 'run_1',
  dataset_id: 'ds_1',
  target: 'real',
  status: 'ok',
  stdout: 'total: 12',
  stderr: '',
  files: [{ name: 'summary.csv', bytes: 812, kind: 'csv' }],
  violations: [],
  duration_ms: 1200,
  llm_safe: false,
  created_at: '2025-01-01',
};

describe('Result', () => {
  it('shows output, files and the private marker for a real run', () => {
    render(<Result run={base} />);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('total: 12')).toBeInTheDocument();
    expect(screen.getByText('summary.csv')).toBeInTheDocument();
    expect(screen.getByText(/Private/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download summary.csv/i })).toBeInTheDocument();
  });

  it('lists violations as rule and line for a rejected run', () => {
    render(
      <Result
        run={{
          ...base,
          status: 'rejected',
          stdout: '',
          files: [],
          violations: ['import:os@3', 'call:open@7'],
        }}
      />,
    );
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText('import:os')).toBeInTheDocument();
    expect(screen.getByText('call:open')).toBeInTheDocument();
    expect(screen.getByText(/line 3/)).toBeInTheDocument();
    expect(screen.getByText(/line 7/)).toBeInTheDocument();
  });

  it('does not mark a synthetic run as private', () => {
    render(<Result run={{ ...base, target: 'synthetic', llm_safe: true }} />);
    expect(screen.queryByText(/Private/i)).not.toBeInTheDocument();
  });
});
