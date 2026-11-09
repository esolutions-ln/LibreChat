import React from 'react';
import type { TNmbChartSpec, TNmbRun } from 'librechat-data-provider';
import { render, screen, waitFor } from 'test/layout-test-utils';
import Charts, { chartFiles } from '../Charts';

const mocks = {
  me: { data: { enabled: true, reviewer: false, regexBlocklist: false, reports: true } as unknown },
  download: jest.fn(),
};

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      downloadNmbRunFile: (...args: unknown[]) => mocks.download(...args),
    },
  };
});
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbMeQuery: () => mocks.me,
  useNmbReportExportMutation: () => ({ mutate: jest.fn() }),
}));

const spec: TNmbChartSpec = {
  version: 1,
  title: 'Spend by month',
  type: 'bar',
  origin: 'computed',
  categories: ['Jan', 'Feb'],
  series: [{ name: 'Spend', values: [10, 20] }],
};

const blobOf = (text: string) => ({ text: async () => text }) as unknown as Blob;

/** A fresh id per run: the shared test QueryClient would otherwise reuse a pending fetch. */
let seq = 0;
const run = (names: string[]): TNmbRun => ({
  id: `run_${++seq}`,
  dataset_id: 'ds_0123456789ab',
  target: 'real',
  status: 'ok',
  stdout: '',
  stderr: '',
  files: names.map((name) => ({
    name,
    bytes: 100,
    kind: name.endsWith('.chart.json') ? 'chart' : 'csv',
  })),
  violations: [],
  duration_ms: 10,
  llm_safe: false,
  created_at: '2025-01-01',
});

beforeEach(() => {
  mocks.me = { data: { enabled: true, reviewer: false, regexBlocklist: false, reports: true } };
  mocks.download.mockReset();
});

describe('chartFiles', () => {
  it('keeps only names ending in .chart.json', () => {
    expect(
      chartFiles(
        run(['a.chart.json', 'summary.csv', 'chart.json', 'b.chart.json.csv', 'c.chart.json']),
      ),
    ).toEqual(['a.chart.json', 'c.chart.json']);
  });
});

describe('Charts', () => {
  it('renders nothing, and fetches nothing, for a run without charts', () => {
    const { container } = render(<Charts run={run(['summary.csv'])} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('shows a loading status while the file is fetched', () => {
    mocks.download.mockReturnValue(new Promise(() => undefined));
    render(<Charts run={run(['spend.chart.json'])} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading chart spend.chart.json');
  });

  it('fetches the run file and renders the chart from its text, with the computed note', async () => {
    mocks.download.mockResolvedValue(blobOf(JSON.stringify(spec)));
    const r = run(['spend.chart.json', 'summary.csv']);
    render(<Charts run={r} />);
    expect(
      await screen.findByRole('figure', { name: 'Chart: Spend by month' }),
    ).toBeInTheDocument();
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledWith(r.id, 'spend.chart.json');
    expect(screen.getByText(/computed by your analysis script/)).toBeInTheDocument();
    expect(screen.queryByText(/read from the document by the AI/)).not.toBeInTheDocument();
  });

  it('renders one chart per chart file', async () => {
    mocks.download.mockImplementation(async (_id: string, name: string) =>
      blobOf(JSON.stringify({ ...spec, title: name })),
    );
    render(<Charts run={run(['a.chart.json', 'b.chart.json'])} />);
    await waitFor(() => expect(screen.getAllByRole('figure')).toHaveLength(2));
  });

  it('shows an invalid-chart message for a file that is not a valid spec', async () => {
    mocks.download.mockResolvedValue(blobOf('not json'));
    render(<Charts run={run(['bad.chart.json'])} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Chart bad.chart.json is not a valid chart',
    );
    expect(screen.queryByRole('figure')).not.toBeInTheDocument();
  });

  it('shows a per-file error when the fetch fails and still renders the other chart', async () => {
    mocks.download.mockImplementation(async (_id: string, name: string) => {
      if (name === 'bad.chart.json') {
        throw new Error('network');
      }
      return blobOf(JSON.stringify(spec));
    });
    render(<Charts run={run(['bad.chart.json', 'good.chart.json'])} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not show chart bad.chart.json',
    );
    expect(await screen.findByRole('figure')).toBeInTheDocument();
  });

  it('hides the export buttons, but still draws the chart, when reports are off', async () => {
    mocks.me = { data: { enabled: true, reviewer: false, regexBlocklist: false, reports: false } };
    mocks.download.mockResolvedValue(blobOf(JSON.stringify(spec)));
    render(<Charts run={run(['spend.chart.json'])} />);
    expect(await screen.findByRole('figure')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download Excel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).not.toBeInTheDocument();
  });

  it('shows the export buttons when reports are on', async () => {
    mocks.download.mockResolvedValue(blobOf(JSON.stringify(spec)));
    render(<Charts run={run(['spend.chart.json'])} />);
    expect(await screen.findByRole('button', { name: 'Download Excel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
  });

  it('does not export while the user info is still loading', async () => {
    mocks.me = { data: undefined };
    mocks.download.mockResolvedValue(blobOf(JSON.stringify(spec)));
    render(<Charts run={run(['spend.chart.json'])} />);
    expect(await screen.findByRole('figure')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download Excel' })).not.toBeInTheDocument();
  });
});
