import { stripNmbMaskNote } from 'librechat-data-provider';
import { MASK_NOTE, SYNTHETIC_NOTE, SYNTHETIC_NOTE_MARKER, createNmbChatGateway } from './chat';
import {
  baseConfig,
  fakeScanner,
  mockReq,
  mockRes,
  reviewItem,
  scanResult,
} from './testkit.helper';
import { createNmbHandlers } from './handlers';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const REVIEWER = { id: 'rev-user', role: 'REVIEWER', username: 'asmith' };
const OWNER = { id: 'user-1', role: 'USER', username: 'jdoe' };
const ID = 'rev_0123456789ab';

function handlersWith(scanner = fakeScanner()) {
  const handlers = createNmbHandlers({
    config: baseConfig,
    scanner,
    isReviewer: jest.fn().mockResolvedValue(true),
    recordAudit: jest.fn().mockResolvedValue(undefined),
  });
  return { handlers, scanner };
}

const call = async (handler: unknown, req: ReturnType<typeof mockReq>) => {
  const res = mockRes();
  await (handler as (q: unknown, r: unknown, n: unknown) => Promise<void>)(req, res, jest.fn());
  return res;
};

describe('approve with a mode', () => {
  const approve = (body: Record<string, unknown>) =>
    mockReq({ user: REVIEWER, params: { id: ID }, body });

  it('defaults to masked and sends the mode to the scanner', async () => {
    const { handlers, scanner } = handlersWith();
    const res = await call(handlers.approve, approve({ note: 'ok' }));
    expect(res.body).toMatchObject({ status: 'approved-masked', mode: 'masked' });
    expect(scanner.approveMasked.mock.calls[0][1]).toMatchObject({ mode: 'masked' });
  });

  it('passes synthetic through and ignores blocklist additions', async () => {
    const { handlers, scanner } = handlersWith();
    const res = await call(
      handlers.approve,
      approve({ mode: 'synthetic', additions: [{ value: 'Project Falcon', mode: 'literal' }] }),
    );
    expect(res.body).toMatchObject({ mode: 'synthetic' });
    expect(scanner.approveMasked.mock.calls[0][1]).toMatchObject({
      mode: 'synthetic',
      blocklist_additions: [],
    });
    expect(scanner.addBlocklist).not.toHaveBeenCalled();
    expect(scanner.getOriginal).not.toHaveBeenCalled();
  });

  it.each(['redact', 5, null])('rejects the mode %j', async (mode) => {
    const { handlers, scanner } = handlersWith();
    const res = await call(handlers.approve, approve({ mode }));
    expect(res.statusCode).toBe(400);
    expect(scanner.approveMasked).not.toHaveBeenCalled();
  });
});

describe('submission status', () => {
  it('reports the mode and whether the text was already sent, never the content', async () => {
    const scanner = fakeScanner({
      getReview: jest.fn().mockResolvedValue(
        reviewItem({
          status: 'approved-masked',
          mode: 'synthetic',
          released_at: '2026-11-10T08:00:00+00:00',
        }),
      ),
    });
    const { handlers } = handlersWith(scanner);
    const res = await call(handlers.mySubmission, mockReq({ user: OWNER, params: { id: ID } }));
    expect(res.body).toMatchObject({
      status: 'approved-masked',
      mode: 'synthetic',
      released: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/sanitized|original/);
  });

  it('is not released before the first send', async () => {
    const scanner = fakeScanner({
      getReview: jest
        .fn()
        .mockResolvedValue(reviewItem({ status: 'approved-masked', mode: 'masked' })),
    });
    const { handlers } = handlersWith(scanner);
    const res = await call(handlers.mySubmission, mockReq({ user: OWNER, params: { id: ID } }));
    expect(res.body).toMatchObject({ mode: 'masked', released: false });
  });
});

describe('unmask with synthetic values', () => {
  it('forwards text without placeholders when synthetic is asked for', async () => {
    const scanner = fakeScanner({
      unmask: jest.fn().mockResolvedValue({ text: 'Pay Jane Moyo', restored: 1 }),
    });
    const { handlers } = handlersWith(scanner);
    const res = await call(
      handlers.unmask,
      mockReq({ user: OWNER, body: { text: 'Pay Tariro Ncube', synthetic: true } }),
    );
    expect(scanner.unmask).toHaveBeenCalledWith('u:user-1', 'Pay Tariro Ncube', ['user'], true);
    expect(res.body).toEqual({ text: 'Pay Jane Moyo', restored: 1 });
  });

  it('still skips the scanner for plain text with no placeholders and no synthetic flag', async () => {
    const { handlers, scanner } = handlersWith();
    const res = await call(handlers.unmask, mockReq({ user: OWNER, body: { text: 'hello' } }));
    expect(scanner.unmask).not.toHaveBeenCalled();
    expect(res.body).toEqual({ text: 'hello', restored: 0 });
  });
});

describe('releasing an approved prompt', () => {
  const release = async (mode: 'masked' | 'synthetic', scanner = fakeScanner()) => {
    scanner.getReview.mockResolvedValue(reviewItem({ status: 'approved-masked', mode }));
    scanner.getResult.mockResolvedValue({
      id: ID,
      status: 'approved-masked',
      sanitized_content: 'Pay Tariro Ncube 4521 8830 1167',
      sanitized_segments: null,
      mode,
    });
    scanner.scanText.mockResolvedValue(scanResult({ sanitized_content: 'unused' }));
    const gate = createNmbChatGateway({ config: baseConfig, scanner });
    const req = mockReq({ user: OWNER, body: { text: `[[nmb:release:${ID}]]` } });
    const res = mockRes();
    const next = jest.fn();
    await gate(req, res, next);
    return { req, res, next, scanner };
  };

  it('adds the synthetic note, marks the release, and continues', async () => {
    const { req, next, scanner } = await release('synthetic');
    expect(req.body.text).toBe(`Pay Tariro Ncube 4521 8830 1167${SYNTHETIC_NOTE}`);
    expect(scanner.markReleased).toHaveBeenCalledWith(ID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not add the synthetic note to a masked release', async () => {
    const { req, scanner } = await release('masked');
    expect(req.body.text).not.toContain(SYNTHETIC_NOTE_MARKER);
    expect(req.body.text).not.toContain(MASK_NOTE);
    expect(scanner.markReleased).toHaveBeenCalledWith(ID);
  });

  it('still releases when recording the release fails', async () => {
    const scanner = fakeScanner({
      markReleased: jest.fn().mockRejectedValue(new Error('down')),
    });
    const { req, next } = await release('synthetic', scanner);
    expect(req.body.text).toContain(SYNTHETIC_NOTE_MARKER);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('only releases for the owner', async () => {
    const scanner = fakeScanner();
    scanner.getReview.mockResolvedValue(
      reviewItem({ user: 'someone-else', status: 'approved-masked', mode: 'synthetic' }),
    );
    const gate = createNmbChatGateway({ config: baseConfig, scanner });
    const res = mockRes();
    const next = jest.fn();
    await gate(mockReq({ user: OWNER, body: { text: `[[nmb:release:${ID}]]` } }), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(scanner.markReleased).not.toHaveBeenCalled();
  });
});

describe('display stripping', () => {
  it('removes the synthetic note, alone or after the others', () => {
    expect(stripNmbMaskNote(`hello${SYNTHETIC_NOTE}`)).toBe('hello');
    expect(stripNmbMaskNote(`hello${MASK_NOTE}${SYNTHETIC_NOTE}`)).toBe('hello');
  });
});
