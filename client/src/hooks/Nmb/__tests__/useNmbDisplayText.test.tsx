import { renderHook, waitFor } from '@testing-library/react';
import { NMB_MASK_NOTE, NMB_SYNTHETIC_NOTE_MARKER } from 'librechat-data-provider';
import useNmbDisplayText from '../useNmbDisplayText';

const mocks = {
  me: { data: { enabled: true } as unknown },
  messages: undefined as unknown,
  unmask: jest.fn(),
};

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { unmaskNmbText: (...args: unknown[]) => mocks.unmask(...args) },
  };
});
jest.mock('~/data-provider', () => ({ useNmbMeQuery: () => mocks.me }));
jest.mock('~/Providers/MessagesViewContext', () => ({
  useOptionalMessagesOperations: () => ({ getMessages: () => mocks.messages }),
}));

const SYNTHETIC_NOTE = `${NMB_SYNTHETIC_NOTE_MARKER} names and numbers are fictional.]`;
const syntheticConversation = () => [
  { messageId: 'u1', text: `Pay Jane Doe 4421 0099 1234${SYNTHETIC_NOTE}` },
  { messageId: 'a1', text: 'Sure, paying Jane Doe.' },
];
const plainConversation = () => [
  { messageId: 'u1', text: 'hello' },
  { messageId: 'a1', text: 'hi there' },
];

/** Unique text per test: the hook keeps a module-level display cache on purpose. */
let n = 0;
const uniq = (s: string) => `${s} #${++n}`;

const hook = (text: string, opts: { isCreatedByUser: boolean; streaming?: boolean }) =>
  renderHook(() =>
    useNmbDisplayText(text, { isCreatedByUser: opts.isCreatedByUser, streaming: !!opts.streaming }),
  );

beforeEach(() => {
  mocks.me = { data: { enabled: true } };
  mocks.messages = plainConversation();
  mocks.unmask.mockReset();
  mocks.unmask.mockImplementation(async (text: string) => ({
    text: `RESTORED(${text})`,
    restored: 1,
  }));
});

describe('useNmbDisplayText in a conversation without a synthetic note', () => {
  it('restores tokens in an assistant reply with the original single-argument call', async () => {
    const text = uniq('Moved <ACCOUNT_001>');
    const { result } = hook(text, { isCreatedByUser: false });
    await waitFor(() => expect(result.current.text).toBe(`RESTORED(${text})`));
    expect(mocks.unmask).toHaveBeenCalledTimes(1);
    expect(mocks.unmask.mock.calls[0]).toEqual([text]);
    expect(result.current.masked).toBe(true);
  });

  it('makes no call for an assistant reply without tokens', () => {
    const text = uniq('Plain reply');
    const { result } = hook(text, { isCreatedByUser: false });
    expect(result.current.text).toBe(text);
    expect(mocks.unmask).not.toHaveBeenCalled();
  });

  it('never restores the user message, only hides the redaction note', () => {
    const text = uniq('Pay <ACCOUNT_001>');
    const { result } = hook(`${text}${NMB_MASK_NOTE}`, { isCreatedByUser: true });
    expect(result.current.text).toBe(text);
    expect(mocks.unmask).not.toHaveBeenCalled();
  });

  it('does not restore while streaming', () => {
    const { result } = hook(uniq('Moving <ACCOUNT_001>'), {
      isCreatedByUser: false,
      streaming: true,
    });
    expect(mocks.unmask).not.toHaveBeenCalled();
    expect(result.current.text).toMatch(/Moving/);
  });
});

describe('useNmbDisplayText in a conversation with a synthetic note', () => {
  beforeEach(() => {
    mocks.messages = syntheticConversation();
  });

  it('restores synthetic values in an assistant reply that has no tokens', async () => {
    const text = uniq('Done: paid Jane Doe');
    const { result } = hook(text, { isCreatedByUser: false });
    await waitFor(() => expect(result.current.text).toBe(`RESTORED(${text})`));
    expect(mocks.unmask).toHaveBeenCalledWith(text, { synthetic: true });
  });

  it('restores the user message too, hiding the note and sending the visible text', async () => {
    const visible = uniq('Pay Jane Doe');
    const { result } = hook(`${visible}${SYNTHETIC_NOTE}`, { isCreatedByUser: true });
    await waitFor(() => expect(result.current.text).toBe(`RESTORED(${visible})`));
    expect(mocks.unmask).toHaveBeenCalledWith(visible, { synthetic: true });
    expect(result.current.text).not.toContain('NMB synthetic note');
  });

  it('detects the note in structured content parts as well', async () => {
    mocks.messages = [
      { messageId: 'u1', text: '', content: [{ type: 'text', text: `hello${SYNTHETIC_NOTE}` }] },
    ];
    const text = uniq('Reply for Jane Doe');
    const { result } = hook(text, { isCreatedByUser: false });
    await waitFor(() => expect(result.current.text).toBe(`RESTORED(${text})`));
    expect(mocks.unmask).toHaveBeenCalledWith(text, { synthetic: true });
  });

  it('shows the visible text and makes no call while streaming', () => {
    const text = uniq('Streaming for Jane Doe');
    const { result } = hook(text, { isCreatedByUser: false, streaming: true });
    expect(result.current.text).toBe(text);
    expect(mocks.unmask).not.toHaveBeenCalled();
  });

  it('makes no call when the gateway is off', () => {
    mocks.me = { data: { enabled: false } };
    const text = uniq('Gateway off');
    const { result } = hook(text, { isCreatedByUser: false });
    expect(result.current.text).toBe(text);
    expect(mocks.unmask).not.toHaveBeenCalled();
  });

  it('keeps the visible text when the restore call fails', async () => {
    mocks.unmask.mockRejectedValue(new Error('network'));
    const text = uniq('Reply that fails');
    const { result } = hook(text, { isCreatedByUser: false });
    await waitFor(() => expect(mocks.unmask).toHaveBeenCalled());
    expect(result.current.text).toBe(text);
  });

  it('calls the server once per text and serves repeats from the cache', async () => {
    const text = uniq('Cached reply for Jane Doe');
    const first = hook(text, { isCreatedByUser: false });
    await waitFor(() => expect(first.result.current.text).toBe(`RESTORED(${text})`));
    const second = hook(text, { isCreatedByUser: false });
    expect(second.result.current.text).toBe(`RESTORED(${text})`);
    expect(mocks.unmask).toHaveBeenCalledTimes(1);
  });

  it('does not mutate the message list', async () => {
    const before = JSON.stringify(mocks.messages);
    const text = uniq('No write back');
    const { result } = hook(text, { isCreatedByUser: false });
    await waitFor(() => expect(result.current.text).toBe(`RESTORED(${text})`));
    expect(JSON.stringify(mocks.messages)).toBe(before);
  });
});

describe('useNmbDisplayText outside a messages view', () => {
  it('makes no synthetic call when there is no message list (e.g. search)', () => {
    mocks.messages = undefined;
    const text = uniq('Search result');
    const { result } = hook(text, { isCreatedByUser: false });
    expect(result.current.text).toBe(text);
    expect(mocks.unmask).not.toHaveBeenCalled();
  });

  it('still restores tokens there, as before', async () => {
    mocks.messages = undefined;
    const text = uniq('Moved <ACCOUNT_002>');
    const { result } = hook(text, { isCreatedByUser: false });
    await waitFor(() => expect(result.current.text).toBe(`RESTORED(${text})`));
    expect(mocks.unmask.mock.calls[0]).toEqual([text]);
  });
});
