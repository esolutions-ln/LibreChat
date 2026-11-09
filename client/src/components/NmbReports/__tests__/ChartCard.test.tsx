import React from 'react';
import type { TNmbChartSpec } from 'librechat-data-provider';
import { render, screen } from 'test/layout-test-utils';
import { ChartCard } from '../NmbChart';

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbReportExportMutation: () => ({ mutate: jest.fn() }),
}));

const spec: TNmbChartSpec = {
  version: 1,
  title: 'Revenue',
  type: 'line',
  categories: ['2023', '2024'],
  series: [{ name: 'Revenue', values: [1, 2] }],
};

const MODEL_NOTE = /read from the document by the AI/;
const COMPUTED_NOTE = /computed by your analysis script/;

describe('ChartCard', () => {
  it('shows the export buttons by default', () => {
    render(<ChartCard spec={spec} />);
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
  });

  it('hides the export buttons when exportable is false and keeps the rest of the card', () => {
    render(<ChartCard spec={spec} exportable={false} />);
    expect(screen.queryByRole('button', { name: 'Download Excel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'Chart: Revenue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show data' })).toBeInTheDocument();
  });

  it.each([
    ['no origin', undefined],
    ['origin model', 'model' as const],
  ])('shows the check-against-the-source note for %s', (_name, origin) => {
    render(<ChartCard spec={{ ...spec, origin }} />);
    expect(screen.getByText(MODEL_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(COMPUTED_NOTE)).not.toBeInTheDocument();
  });

  it('shows the computed note for origin computed', () => {
    render(<ChartCard spec={{ ...spec, origin: 'computed' }} />);
    expect(screen.getByText(COMPUTED_NOTE)).toBeInTheDocument();
    expect(screen.queryByText(MODEL_NOTE)).not.toBeInTheDocument();
  });
});
