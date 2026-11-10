import React from 'react';
import type { ErrorPayload } from '../parts';
import { act, fireEvent, render, screen } from 'test/layout-test-utils';
import NmbError from '../NmbError';

const REVIEW = 'rev_0123456789ab';
const RELEASE = `[[nmb:release:${REVIEW}]]`;

const mocks = {
  sub: { data: undefined as unknown, refetch: jest.fn() },
  ask: jest.fn(),
  isSubmitting: false,
  conversationId: 'c1' as string | undefined,
  messages: [] as unknown[],
};

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useNmbSubmissionQuery: () => mocks.sub,
}));
jest.mock('~/Providers/MessagesViewContext', () => ({
  useOptionalMessagesOperations: () => ({ ask: mocks.ask, getMessages: () => mocks.messages }),
  useOptionalMessagesConversation: () => ({
    conversation: { conversationId: mocks.conversationId },
    conversationId: mocks.conversationId,
  }),
  useMessagesIsSubmitting: () => mocks.isSubmitting,
}));
jest.mock('~/Providers/MessageContext', () => ({
  useMessageContext: () => ({ messageId: 'm-card' }),
}));

const json: ErrorPayload = { type: 'nmb_review_pending', review_id: REVIEW };
const approved = (released?: boolean) => ({ status: 'approved-masked', released });

const setMessages = (conversationId = 'c1') => {
  mocks.messages = [
    { messageId: 'm-user', conversationId, parentMessageId: null, text: 'held prompt' },
    { messageId: 'm-card', conversationId, parentMessageId: 'm-user', text: '' },
  ];
};

const renderCard = () => render(<NmbError json={json} text="" />);

beforeEach(() => {
  sessionStorage.clear();
  mocks.sub = { data: undefined, refetch: jest.fn() };
  mocks.ask = jest.fn();
  mocks.isSubmitting = false;
  mocks.conversationId = 'c1';
  setMessages();
  jest.useRealTimers();
});

describe('NmbError states that are unchanged', () => {
  it('shows pending while waiting for a decision', () => {
    mocks.sub.data = { status: 'pending' };
    renderCard();
    expect(screen.getByText(/waiting for review|needs review|pending/i)).toBeInTheDocument();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('shows the reviewer reason when rejected and never sends', () => {
    mocks.sub.data = { status: 'rejected', reason: 'contains a secret' };
    renderCard();
    expect(screen.getByText(/contains a secret/)).toBeInTheDocument();
    expect(mocks.ask).not.toHaveBeenCalled();
  });
});

describe('NmbError automatic release', () => {
  it('sends the release sentinel once, as the next turn of the card conversation', () => {
    mocks.sub.data = approved(false);
    renderCard();
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.ask).toHaveBeenCalledWith(
      { text: RELEASE, parentMessageId: null, conversationId: 'c1' },
      {},
    );
  });

  it('shows the sending state instead of the manual button', () => {
    mocks.sub.data = approved(false);
    renderCard();
    expect(screen.getByRole('status')).toHaveTextContent('Approved, sending to the assistant');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not send again on re-render or remount in the same tab', () => {
    mocks.sub.data = approved(false);
    const { rerender, unmount } = renderCard();
    rerender(<NmbError json={json} text="" />);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(`nmb:release-sent:${REVIEW}`)).toBe('1');
    unmount();
    renderCard();
    expect(mocks.ask).toHaveBeenCalledTimes(1);
  });

  it('falls back to the manual button when this tab already tried (remount after a failed send)', () => {
    sessionStorage.setItem(`nmb:release-sent:${REVIEW}`, '1');
    mocks.sub.data = approved(false);
    renderCard();
    expect(mocks.ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send approved message' }));
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.ask.mock.calls[0][0].text).toBe(RELEASE);
  });

  it('waits while a turn is running and sends once when the chat goes idle', () => {
    mocks.isSubmitting = true;
    mocks.sub.data = approved(false);
    const { rerender } = renderCard();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send approved message' })).toBeDisabled();
    mocks.isSubmitting = false;
    rerender(<NmbError json={json} text="" />);
    expect(mocks.ask).toHaveBeenCalledTimes(1);
  });

  it('does not send when the card is not in the open conversation', () => {
    setMessages('other-conversation');
    mocks.sub.data = approved(false);
    renderCard();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send approved message' })).toBeInTheDocument();
  });

  it('does not send when the card message is not among the open messages', () => {
    mocks.messages = [];
    mocks.sub.data = approved(false);
    renderCard();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('does not send for a prompt that was already released', () => {
    mocks.sub.data = approved(true);
    renderCard();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('re-reads the submission when the turn ends, then offers the manual button if still not released', () => {
    mocks.sub.data = approved(false);
    const { rerender } = renderCard();
    mocks.isSubmitting = true;
    rerender(<NmbError json={json} text="" />);
    mocks.isSubmitting = false;
    rerender(<NmbError json={json} text="" />);
    expect(mocks.sub.refetch).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send approved message' })).toBeInTheDocument();
  });

  it('offers the manual button if no turn starts within the grace period', () => {
    jest.useFakeTimers();
    mocks.sub.data = approved(false);
    renderCard();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(3500);
    });
    expect(screen.getByRole('button', { name: 'Send approved message' })).toBeInTheDocument();
  });
});

describe('NmbError after release', () => {
  it('says it was sent and offers Send again, which reuses the same send', () => {
    mocks.sub.data = approved(true);
    renderCard();
    expect(screen.getByText('Approved and sent.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(mocks.ask).toHaveBeenCalledWith(
      { text: RELEASE, parentMessageId: null, conversationId: 'c1' },
      {},
    );
  });

  it('disables Send again while a turn is running', () => {
    mocks.isSubmitting = true;
    mocks.sub.data = approved(true);
    renderCard();
    expect(screen.getByRole('button', { name: 'Send again' })).toBeDisabled();
  });
});
