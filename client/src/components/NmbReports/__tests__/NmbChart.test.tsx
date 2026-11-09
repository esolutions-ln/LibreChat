import React from 'react';
import { fireEvent, render, screen, within } from 'test/layout-test-utils';
import type { TNmbChartSpec } from 'librechat-data-provider';
import NmbChart from '../NmbChart';

type Vars = { format: string; spec: TNmbChartSpec };
type Opts = {
  onSuccess?: (blob: Blob) => void;
  onError?: (e: unknown) => void;
  onSettled?: () => void;
};

const mocks = {
  me: { data: { enabled: true, reviewer: false, regexBlocklist: false, reports: true } as unknown },
  mutate: jest.fn<void, [Vars, Opts]>(),
};

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbMeQuery: () => mocks.me,
  useNmbReportExportMutation: () => ({ mutate: mocks.mutate }),
}));

const spec: TNmbChartSpec = {
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

const fallback = <pre data-testid="fallback" />;
const json = (over: Partial<TNmbChartSpec> = {}) => JSON.stringify({ ...spec, ...over });
const renderChart = (code: string) => render(<NmbChart code={code} fallback={fallback} />);

beforeEach(() => {
  mocks.me = { data: { enabled: true, reviewer: false, regexBlocklist: false, reports: true } };
  mocks.mutate.mockReset();
});

describe('NmbChart rendering', () => {
  it('renders an accessible figure with title, unit, source, legend and the AI-check note', () => {
    renderChart(json());
    expect(screen.getByRole('figure', { name: 'Chart: Net interest income' })).toBeInTheDocument();
    expect(screen.getByText('Unit: USD m')).toBeInTheDocument();
    expect(screen.getByText('Source: Income statement')).toBeInTheDocument();
    const legend = within(screen.getByRole('list', { hidden: true }));
    expect(legend.getByText('Net interest income')).toBeInTheDocument();
    expect(legend.getByText('Fee income')).toBeInTheDocument();
    expect(screen.getByText(/Check them against the source/)).toBeInTheDocument();
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument();
  });

  it('draws one bar per non-null value with the figure in its title', () => {
    const { container } = renderChart(json());
    const plot = container.querySelector('figure > svg') as SVGElement;
    expect(plot.querySelectorAll('rect')).toHaveLength(3);
    expect(plot.querySelector('rect title')?.textContent).toContain('41.2');
  });

  it('keeps the data in a table for screen readers and toggles it visibly', () => {
    renderChart(json());
    const table = screen.getByRole('table');
    expect(table).toHaveClass('sr-only');
    expect(screen.getByRole('cell', { name: '48.9' })).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show data' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide data' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(table).not.toHaveClass('sr-only');
  });

  it('renders a null value as an empty cell, not a zero', () => {
    renderChart(json());
    const rows = screen.getAllByRole('row');
    const last = rows[rows.length - 1];
    expect(last.querySelectorAll('td')[1]).toHaveTextContent('');
  });

  it('stacks bars', () => {
    const { container } = renderChart(json({ type: 'stacked_bar' }));
    const plot = container.querySelector('figure > svg') as SVGElement;
    expect(plot.querySelectorAll('rect')).toHaveLength(3);
  });

  it('draws lines with a point per value and a gap for null', () => {
    const { container } = renderChart(json({ type: 'line' }));
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
  });

  it('draws a pie from the first series with category shares in the legend', () => {
    const { container } = renderChart(
      json({ type: 'pie', series: [{ name: 'Share', values: [25, 75] }] }),
    );
    expect(container.querySelectorAll('path')).toHaveLength(2);
    const legend = within(screen.getByRole('list', { hidden: true }));
    expect(legend.getByText(/2023/)).toHaveTextContent('2023 (25%)');
    expect(legend.getByText(/2024/)).toHaveTextContent('2024 (75%)');
  });
});

describe('NmbChart fallback', () => {
  it('shows the ordinary block when reports are off', () => {
    mocks.me = { data: { enabled: true, reviewer: false, regexBlocklist: false, reports: false } };
    renderChart(json());
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
  });

  it('shows the ordinary block while the user info is still loading', () => {
    mocks.me = { data: undefined };
    renderChart(json());
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
  });

  it.each([
    ['partial JSON while streaming', '{"version":1,"title":"Net'],
    ['plain text', 'not a chart'],
    ['a spec that breaks a limit', json({ categories: ['a'] })],
    ['an unknown chart type', JSON.stringify({ ...spec, type: 'radar' })],
  ])('shows the ordinary block for %s and does not throw', (_name, code) => {
    renderChart(code);
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
  });
});

describe('NmbChart export', () => {
  let anchors: Array<{ href: string; download: string }>;
  let click: jest.SpyInstance;

  beforeEach(() => {
    anchors = [];
    URL.createObjectURL = jest.fn(() => 'blob:report');
    URL.revokeObjectURL = jest.fn();
    click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchors.push({ href: this.href, download: this.download });
    });
  });

  afterEach(() => click.mockRestore());

  it('sends the validated spec for each format', () => {
    mocks.mutate.mockImplementation((_vars, opts) => opts.onSettled?.());
    renderChart(json());
    fireEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ format: 'xlsx', spec });
    expect(mocks.mutate.mock.calls[1][0]).toEqual({ format: 'pdf', spec });
  });

  it('downloads the file under a name from the title and releases the object URL', () => {
    jest.useFakeTimers();
    mocks.mutate.mockImplementation((_vars, opts) => {
      opts.onSuccess?.(new Blob(['x']));
      opts.onSettled?.();
    });
    renderChart(json());
    fireEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    expect(anchors).toEqual([{ href: 'blob:report', download: 'net-interest-income.xlsx' }]);
    jest.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report');
    jest.useRealTimers();
  });

  it('disables both buttons and announces progress while a file is being made', () => {
    mocks.mutate.mockImplementation(() => undefined);
    renderChart(json());
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the file');
  });

  it.each([
    [429, /Too many exports/],
    [503, /export service is unavailable/],
    [500, /could not be created/],
    [undefined, /could not be created/],
  ])('shows an alert for HTTP %s and re-enables the buttons', (status, message) => {
    mocks.mutate.mockImplementation((_vars, opts) => {
      opts.onError?.(status ? { response: { status } } : new Error('network'));
      opts.onSettled?.();
    });
    renderChart(json());
    fireEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
    expect(anchors).toHaveLength(0);
  });

  it('clears an earlier error on the next attempt', () => {
    mocks.mutate.mockImplementationOnce((_vars, opts) => {
      opts.onError?.({ response: { status: 503 } });
      opts.onSettled?.();
    });
    mocks.mutate.mockImplementationOnce(() => undefined);
    renderChart(json());
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
