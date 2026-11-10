import React from 'react';
import { render, screen } from 'test/layout-test-utils';
import NmbAnalysisView from '../NmbAnalysisView';

const mocks = {
  me: { data: undefined as unknown, isLoading: false },
  datasets: { data: undefined as unknown, isLoading: false, isError: false, refetch: jest.fn() },
  upload: { isLoading: false, isError: false, mutate: jest.fn() },
  run: { data: undefined as unknown, isLoading: false, isError: false },
};

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbMeQuery: () => mocks.me,
  useNmbDatasetsQuery: () => mocks.datasets,
  useNmbAnalysisLimitsQuery: () => ({ data: undefined }),
  useNmbRunQuery: () => mocks.run,
  useUploadNmbDatasetMutation: () => mocks.upload,
  useDeleteNmbDatasetMutation: () => ({ isLoading: false, isError: false, mutate: jest.fn() }),
  useNmbSyntheticQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useSynthesizeNmbDatasetMutation: () => ({ isLoading: false, isError: false, mutate: jest.fn() }),
  useExecuteNmbDatasetMutation: () => ({ isLoading: false, isError: false, mutate: jest.fn() }),
}));
jest.mock('~/hooks/Nav/useDrawerViewport', () => ({ __esModule: true, default: () => false }));
jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({ __esModule: true, default: () => null }));

const enabled = { enabled: true, reviewer: false, regexBlocklist: false, analysis: true };

beforeEach(() => {
  mocks.me = { data: enabled, isLoading: false };
  mocks.datasets = { data: { items: [] }, isLoading: false, isError: false, refetch: jest.fn() };
  mocks.upload = { isLoading: false, isError: false, mutate: jest.fn() };
  mocks.run = { data: undefined, isLoading: false, isError: false };
  window.history.pushState({}, '', '/analysis');
});

describe('NmbAnalysisView', () => {
  it('shows a spinner while the feature flag loads', () => {
    mocks.me = { data: undefined, isLoading: true };
    const { container } = render(<NmbAnalysisView />);
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.queryByText('com_nmb_analysis_title')).not.toBeInTheDocument();
  });

  it('shows the disabled state when analysis is off', () => {
    mocks.me = { data: { ...enabled, analysis: false }, isLoading: false };
    render(<NmbAnalysisView />);
    expect(screen.getByRole('status')).toHaveTextContent(/not available/i);
    expect(screen.queryByText(/Upload CSV/i)).not.toBeInTheDocument();
  });

  it('shows the empty state with no datasets', () => {
    render(<NmbAnalysisView />);
    expect(screen.getByText(/No datasets yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Select or upload a dataset/i)).toBeInTheDocument();
  });

  it('shows a retry when the dataset list fails to load', () => {
    mocks.datasets = { data: undefined, isLoading: false, isError: true, refetch: jest.fn() };
    render(<NmbAnalysisView />);
    expect(screen.getByRole('button', { name: /Could not load datasets/i })).toBeInTheDocument();
  });

  it('lists datasets', () => {
    mocks.datasets = {
      data: {
        items: [
          {
            id: 'ds_1',
            name: 'statements.csv',
            rows: 42,
            created_at: '2025-01-01',
            columns: [],
            synthetic: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
    render(<NmbAnalysisView />);
    expect(screen.getByText('statements.csv')).toBeInTheDocument();
    expect(screen.getByText('42 rows')).toBeInTheDocument();
  });

  it('shows nothing extra without a run in the link', () => {
    render(<NmbAnalysisView />);
    expect(screen.queryByText('Result from your chat')).not.toBeInTheDocument();
  });

  it('shows the result of a run a chat agent linked to, in the private result view', () => {
    window.history.pushState({}, '', '/analysis?dataset=ds_1&run=run_0123456789ab');
    mocks.run = {
      data: {
        id: 'run_0123456789ab',
        dataset_id: 'ds_1',
        target: 'real',
        status: 'ok',
        stdout: 'avg 12.5',
        stderr: '',
        files: [],
        violations: [],
        duration_ms: 5,
        llm_safe: false,
        created_at: '2025-01-01',
      },
      isLoading: false,
      isError: false,
    };
    render(<NmbAnalysisView />);
    expect(screen.getByText('Result from your chat')).toBeInTheDocument();
    expect(screen.getByTestId('nmb-run-result')).toHaveTextContent('avg 12.5');
  });

  it('says so when the linked run cannot be loaded', () => {
    window.history.pushState({}, '', '/analysis?run=run_0123456789ab');
    mocks.run = { data: undefined, isLoading: false, isError: true };
    render(<NmbAnalysisView />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not load that result/i);
  });

  it('shows an error when the upload fails', () => {
    mocks.upload = { isLoading: false, isError: true, mutate: jest.fn() };
    render(<NmbAnalysisView />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not upload/i);
  });
});
