import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from 'test/layout-test-utils';
import type { TNmbDataset } from 'librechat-data-provider';
import Twin from '../Twin';

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbSyntheticQuery: () => ({
    data: { columns: ['segment'], rows: [['Retail']], csv: 'segment\nRetail\n' },
    isLoading: false,
    isError: false,
  }),
  useSynthesizeNmbDatasetMutation: () => ({ isLoading: false, isError: false, mutate: jest.fn() }),
}));

const dataset: TNmbDataset = {
  id: 'ds_1',
  name: 'customers.csv',
  rows: 1,
  created_at: '2025-01-01',
  columns: [
    { name: 'segment', kind: 'categorical', sensitive: false, share: true },
  ] as TNmbDataset['columns'],
  synthetic: { rows: 1, columns: ['segment'], engine: 'builtin', generated_at: '2025-01-01' },
};

const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

describe('Twin copy prompt', () => {
  afterEach(() => {
    setClipboard(undefined);
    document.execCommand = undefined as unknown as typeof document.execCommand;
  });

  it('copies with the async clipboard API', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<Twin dataset={dataset} />);
    await userEvent.click(screen.getByRole('button', { name: /copy prompt for chat/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('falls back to execCommand when the clipboard API is missing (plain HTTP)', async () => {
    setClipboard(undefined);
    document.execCommand = jest.fn().mockReturnValue(true);
    render(<Twin dataset={dataset} />);
    await userEvent.click(screen.getByRole('button', { name: /copy prompt for chat/i }));
    await waitFor(() => expect(document.execCommand).toHaveBeenCalledWith('copy'));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows the prompt for manual copy when every copy method fails', async () => {
    setClipboard(undefined);
    document.execCommand = jest.fn().mockReturnValue(false);
    render(<Twin dataset={dataset} />);
    await userEvent.click(screen.getByRole('button', { name: /copy prompt for chat/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const box = screen.getByRole('textbox', {
      name: /copy prompt for chat/i,
    }) as HTMLTextAreaElement;
    expect(box.value).toContain('customers.csv');
  });
});
