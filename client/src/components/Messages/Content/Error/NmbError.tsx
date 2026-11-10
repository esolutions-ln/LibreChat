import { useCallback, useEffect, useRef, useState } from 'react';
import { findMessageById } from 'librechat-data-provider';
import type { ErrorRendererProps } from './parts';
import {
  useOptionalMessagesOperations,
  useOptionalMessagesConversation,
  useMessagesIsSubmitting,
} from '~/Providers/MessagesViewContext';
import { ErrorAction, ErrorActions, ErrorBody, readString } from './parts';
import { useMessageContext } from '~/Providers/MessageContext';
import { useNmbSubmissionQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

const REVIEW_ID = /^rev_[a-f0-9]{12}$/;
/** How long to wait for the chat to start the turn before offering the manual button instead. */
const SEND_GRACE_MS = 3000;

const sentKey = (reviewId: string): string => `nmb:release-sent:${reviewId}`;

/** Per-tab memory that this review's release was already started, so a remount never repeats it. */
const wasSent = (reviewId: string): boolean => {
  try {
    return sessionStorage.getItem(sentKey(reviewId)) === '1';
  } catch {
    return false;
  }
};

const markSent = (reviewId: string): void => {
  try {
    sessionStorage.setItem(sentKey(reviewId), '1');
  } catch {
    /* storage unavailable: the in-memory guard still prevents a repeat while this card is mounted */
  }
};

type SendPhase = 'idle' | 'sending' | 'done';

/**
 * Gateway outcomes for a message or file that was not sent: held for review, rejected, scanner
 * unavailable or not cleared. A held message polls its own status. Once approved, its owner's chat
 * sends the approved version by itself, once; the manual button stays as the fallback when that is
 * skipped or does not complete. Nothing here ever shows the sensitive content.
 */
export default function NmbError({ json }: ErrorRendererProps) {
  const localize = useLocalize();
  const type = readString(json, 'type');
  const rawId = readString(json, 'review_id');
  const reviewId = rawId != null && REVIEW_ID.test(rawId) ? rawId : undefined;
  const isPending = type === 'nmb_review_pending';
  const { data, refetch } = useNmbSubmissionQuery(isPending ? reviewId : undefined);
  const { ask, getMessages } = useOptionalMessagesOperations();
  const { conversation } = useOptionalMessagesConversation();
  const isSubmitting = useMessagesIsSubmitting();
  const { messageId } = useMessageContext();

  const approved = reviewId != null && data?.status === 'approved-masked';
  const released = approved && data?.released === true;
  const startedRef = useRef(false);
  const sawSubmittingRef = useRef(false);
  const [phase, setPhase] = useState<SendPhase>('idle');
  const conversationId = conversation?.conversationId;

  /** Sends the release sentinel as the next turn of the card's own conversation. */
  const send = useCallback(() => {
    if (reviewId == null) {
      return;
    }
    const row = findMessageById(getMessages(), messageId);
    const userMessage = row?.parentMessageId
      ? findMessageById(getMessages(), row.parentMessageId)
      : undefined;
    ask(
      {
        text: `[[nmb:release:${reviewId}]]`,
        parentMessageId: userMessage?.parentMessageId ?? null,
        conversationId: conversationId ?? userMessage?.conversationId ?? null,
      },
      {},
    );
  }, [ask, getMessages, messageId, conversationId, reviewId]);

  /**
   * Automatic release, once. Skipped while a turn is running (it runs when the chat goes idle),
   * when this tab already started it, when the card is not in the open conversation, or when the
   * prompt was already released.
   */
  useEffect(() => {
    if (!approved || released || isSubmitting || startedRef.current || reviewId == null) {
      return;
    }
    if (wasSent(reviewId)) {
      return;
    }
    const row = findMessageById(getMessages(), messageId);
    if (row == null) {
      return;
    }
    if (row.conversationId && conversationId && row.conversationId !== conversationId) {
      return;
    }
    startedRef.current = true;
    markSent(reviewId);
    setPhase('sending');
    send();
  }, [approved, released, isSubmitting, reviewId, messageId, conversationId, getMessages, send]);

  /** Ends the sending state when the turn finishes (and re-reads `released`), or if no turn starts. */
  useEffect(() => {
    if (phase !== 'sending') {
      return;
    }
    if (isSubmitting) {
      sawSubmittingRef.current = true;
      return;
    }
    if (sawSubmittingRef.current) {
      setPhase('done');
      refetch();
      return;
    }
    const timer = setTimeout(() => setPhase('done'), SEND_GRACE_MS);
    return () => clearTimeout(timer);
  }, [phase, isSubmitting, refetch]);

  if (type === 'nmb_rejected') {
    const reason = readString(json, 'reason');
    return (
      <ErrorBody>
        <div>{localize('com_nmb_chat_rejected')}</div>
        {reason && (
          <div className="text-text-secondary">
            {localize('com_nmb_chat_reason', { 0: reason })}
          </div>
        )}
      </ErrorBody>
    );
  }
  if (type === 'nmb_unavailable') {
    return localize('com_nmb_chat_unavailable');
  }
  if (type === 'nmb_file_not_cleared') {
    return localize('com_nmb_chat_file_not_cleared');
  }
  if (type === 'nmb_forbidden') {
    return localize('com_nmb_chat_forbidden');
  }
  if (!isPending) {
    return localize('com_nmb_chat_unavailable');
  }

  if (data?.status === 'rejected') {
    return (
      <ErrorBody>
        <div>{localize('com_nmb_chat_rejected')}</div>
        {data.reason && (
          <div className="text-text-secondary">
            {localize('com_nmb_chat_reason', { 0: data.reason })}
          </div>
        )}
      </ErrorBody>
    );
  }

  if (approved && released) {
    return (
      <ErrorBody>
        <div>{localize('com_nmb_chat_approved_sent')}</div>
        <ErrorActions>
          <ErrorAction onClick={send} disabled={isSubmitting}>
            {localize('com_nmb_chat_send_again')}
          </ErrorAction>
        </ErrorActions>
      </ErrorBody>
    );
  }

  if (approved && phase === 'sending') {
    return (
      <ErrorBody>
        <div role="status">{localize('com_nmb_chat_approved_sending')}</div>
      </ErrorBody>
    );
  }

  if (approved) {
    return (
      <ErrorBody>
        <div>{localize('com_nmb_chat_approved')}</div>
        <ErrorActions>
          <ErrorAction onClick={send} disabled={isSubmitting}>
            {localize('com_nmb_chat_send_approved')}
          </ErrorAction>
        </ErrorActions>
      </ErrorBody>
    );
  }

  return localize('com_nmb_chat_pending');
}
