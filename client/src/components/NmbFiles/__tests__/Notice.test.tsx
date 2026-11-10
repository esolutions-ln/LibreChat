import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from 'test/layout-test-utils';
import Notice from '../Notice';

type Item = {
  id: string;
  filename: string | null;
  status: 'pending' | 'approved-masked' | 'rejected';
  created_at: string;
  resolved_at: string | null;
  reason: string | null;
};

const mocks = {
  me: { data: { enabled: true } as unknown },
  held: { data: undefined as { items: Item[] } | undefined },
  toast: jest.fn(),
};

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbMeQuery: () => mocks.me,
  useNmbHeldFilesQuery: () => mocks.held,
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mocks.toast }),
}));

const item = (over: Partial<Item>): Item => ({
  id: 'rev_aaaaaaaaaaaa',
  filename: 'portfolio.pdf',
  status: 'pending',
  created_at: '2025-01-01',
  resolved_at: null,
  reason: null,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  mocks.toast.mockClear();
  mocks.me = { data: { enabled: true } };
  mocks.held = { data: { items: [] } };
});

describe('NmbFiles Notice', () => {
  it('renders nothing when no upload is held', () => {
    const { container } = render(<Notice />);
    expect(container).toBeEmptyDOMElement();
  });

  it('tells the owner a held file is waiting for review', () => {
    mocks.held = { data: { items: [item({})] } };
    render(<Notice />);
    expect(screen.getByRole('status')).toHaveTextContent(/portfolio\.pdf/);
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for review/i);
  });

  it('tells the owner to attach the same file again once approved', () => {
    mocks.held = { data: { items: [item({ status: 'approved-masked' })] } };
    render(<Notice />);
    expect(screen.getByRole('status')).toHaveTextContent(/approved/i);
    expect(screen.getByRole('status')).toHaveTextContent(/attach the same file again/i);
  });

  it('shows the reviewer reason when rejected, and lets the owner dismiss it', async () => {
    mocks.held = {
      data: { items: [item({ status: 'rejected', reason: 'contains client data' })] },
    };
    render(<Notice />);
    expect(screen.getByRole('alert')).toHaveTextContent(/contains client data/);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows nothing while the gateway is off', () => {
    mocks.me = { data: { enabled: false } };
    mocks.held = { data: undefined };
    const { container } = render(<Notice />);
    expect(container).toBeEmptyDOMElement();
  });
});
