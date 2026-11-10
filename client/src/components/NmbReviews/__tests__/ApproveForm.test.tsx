import React from 'react';
import type { TNmbFinding, TNmbOriginal } from 'librechat-data-provider';
import { fireEvent, render, screen, within } from 'test/layout-test-utils';
import ApproveForm from '../ApproveForm';

const original: TNmbOriginal = {
  id: 'rev_0123456789ab',
  source: 'text',
  segments: [{ location: 'text', text: 'Pay ACCT-9876543210 now' }],
};

const findings: TNmbFinding[] = [
  {
    entity: 'ACCOUNT_NUMBER',
    type: 'financial',
    location: { segment: 'text', start: 4, end: 19 },
    score: 0.9,
    action: 'BLOCK',
    value_hash: 'abc123abc123',
  },
];

const setup = (props: Partial<React.ComponentProps<typeof ApproveForm>> = {}) => {
  const onApprove = jest.fn();
  render(
    <ApproveForm
      original={original}
      findings={findings}
      regexEnabled={false}
      busy={false}
      onApprove={onApprove}
      {...props}
    />,
  );
  return onApprove;
};

const note = () => screen.getByPlaceholderText(/note/i);

describe('ApproveForm', () => {
  it('offers both approvals, each with a one-line explanation', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Approve as masked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Synthesize and release' })).toBeInTheDocument();
    expect(screen.getByText(/Sensitive values become tokens/)).toBeInTheDocument();
    expect(screen.getByText(/replaced by realistic fake ones/)).toBeInTheDocument();
  });

  it('keeps the masked-data list inside the masked approval only', () => {
    setup();
    const masked = screen.getByRole('region', { name: 'Approve as masked' });
    const synthetic = screen.getByRole('region', { name: 'Synthesize and release' });
    expect(within(masked).getByRole('checkbox')).toBeInTheDocument();
    expect(within(synthetic).queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('approves as masked with the chosen additions and a trimmed note', () => {
    const onApprove = setup();
    fireEvent.change(note(), { target: { value: '  looks fine  ' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve as masked' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({
      note: 'looks fine',
      additions: [{ value: 'ACCT-9876543210', mode: 'literal' }],
      mode: 'masked',
    });
  });

  it('approves as masked without a note or additions by default', () => {
    const onApprove = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Approve as masked' }));
    expect(onApprove).toHaveBeenCalledWith({ note: undefined, additions: [], mode: 'masked' });
  });

  it('asks for confirmation before a synthetic release and does not approve yet', () => {
    const onApprove = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Synthesize and release' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/model will see realistic fake values/)).toBeInTheDocument();
    expect(within(dialog).getByText(/owner sees the real values restored/)).toBeInTheDocument();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('releases synthetically after confirming, ignoring any additions that were ticked', () => {
    const onApprove = setup();
    fireEvent.change(note(), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Synthesize and release' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Synthesize and release' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith({ note: 'ok', additions: [], mode: 'synthetic' });
  });

  it('does not approve when the confirmation is dismissed', () => {
    const onApprove = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Synthesize and release' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onApprove).not.toHaveBeenCalled();
  });

  it.each([
    ['masked', /Approving as masked/],
    ['synthetic', /Creating fake values/],
  ])('shows the %s progress message while the approval is running', (mode, message) => {
    const onApprove = jest.fn();
    const { rerender } = render(
      <ApproveForm
        original={original}
        findings={findings}
        regexEnabled={false}
        busy={false}
        onApprove={onApprove}
      />,
    );
    if (mode === 'masked') {
      fireEvent.click(screen.getByRole('button', { name: 'Approve as masked' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Synthesize and release' }));
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Synthesize and release' }),
      );
    }
    rerender(
      <ApproveForm
        original={original}
        findings={findings}
        regexEnabled={false}
        busy
        onApprove={onApprove}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Approve as masked' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Synthesize and release' })).toBeDisabled();
  });
});
