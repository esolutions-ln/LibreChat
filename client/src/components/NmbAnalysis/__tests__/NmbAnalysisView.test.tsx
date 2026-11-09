import React from 'react';
import { render, screen } from 'test/layout-test-utils';
import NmbAnalysisView from '../NmbAnalysisView';

const mocks = {
  me: { data: undefined as unknown, isLoading: false },
  datasets: { data: undefined as unknown, isLoading: false, isError: false, refetch: jest.fn() },
  upload: { isLoading: false, isError: false, mutate: jest.fn() },
};

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbMeQuery: () => mocks.me,
  useNmbDatasetsQuery: () => mocks.datasets,
  useNmbAnalysisLimitsQuery: () => ({ data: undefined }),
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

  it('shows an error when the upload fails', () => {
    mocks.upload = { isLoading: false, isError: true, mutate: jest.fn() };
    render(<NmbAnalysisView />);
    expect(screen.getByRole('alert')).toHaveTextContent(/Could not upload/i);
  });
});
