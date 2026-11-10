import { useEffect, useState } from 'react';
import {
  dataService,
  NMB_PLACEHOLDER_REGEX,
  NMB_SYNTHETIC_NOTE_MARKER,
  stripNmbMaskNote,
} from 'librechat-data-provider';
import { useOptionalMessagesOperations } from '~/Providers/MessagesViewContext';
import { useNmbMeQuery } from '~/data-provider';

const MAX_CACHE = 200;
/** Display-only results. Never written back to the message store or sent anywhere. */
const unmaskCache = new Map<string, string>();
/** Whether a message list carries the synthetic note. Keyed by array identity so a render pass scans once. */
const syntheticByList = new WeakMap<object, boolean>();

type MessageLike = {
  text?: unknown;
  content?: unknown;
};

const hasMarker = (value: unknown): boolean =>
  typeof value === 'string' && value.includes(NMB_SYNTHETIC_NOTE_MARKER);

function messageHasSyntheticNote(message: MessageLike): boolean {
  if (hasMarker(message.text)) {
    return true;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some((part: { text?: unknown } | null) => {
    const text = part?.text;
    return (
      hasMarker(text) ||
      (text != null && typeof text === 'object' && hasMarker((text as { value?: unknown }).value))
    );
  });
}

/** True when any message in the list was released with synthetic values. */
function listHasSyntheticNote(messages: MessageLike[] | undefined | null): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  const known = syntheticByList.get(messages);
  if (known != null) {
    return known;
  }
  const found = messages.some(messageHasSyntheticNote);
  syntheticByList.set(messages, found);
  return found;
}

/**
 * What to show for a message while the gateway is on. The stored text stays masked or synthetic
 * (that is what the model sees on later turns); this only changes the rendering:
 * - the gateway's one-line notes are hidden from the user's own message;
 * - placeholders in a finished assistant reply are restored for the signed-in user through the
 *   server, which derives the mapping from the session;
 * - in a conversation where a prompt was released with synthetic values, the fake values in the
 *   user's message and in the replies are restored the same way.
 * With the gateway off, or while streaming, the text is returned unchanged.
 */
export default function useNmbDisplayText(
  text: string,
  { isCreatedByUser, streaming }: { isCreatedByUser: boolean; streaming: boolean },
): { text: string; masked: boolean } {
  const { data: me } = useNmbMeQuery();
  const { getMessages } = useOptionalMessagesOperations();
  const enabled = me?.enabled === true;
  const visible = enabled && isCreatedByUser ? stripNmbMaskNote(text) : text;
  const masked = enabled && NMB_PLACEHOLDER_REGEX.test(visible);
  const synthetic =
    enabled &&
    !streaming &&
    visible.length > 0 &&
    (hasMarker(text) || listHasSyntheticNote(getMessages() as MessageLike[] | undefined));
  const tokensOnly = masked && !isCreatedByUser && !streaming;
  const shouldUnmask = synthetic || tokensOnly;
  const cacheKey = synthetic ? `s:${visible}` : visible;
  const [restored, setRestored] = useState<string | undefined>(() =>
    shouldUnmask ? unmaskCache.get(cacheKey) : undefined,
  );

  useEffect(() => {
    if (!shouldUnmask) {
      setRestored(undefined);
      return;
    }
    const cached = unmaskCache.get(cacheKey);
    if (cached != null) {
      setRestored(cached);
      return;
    }
    /** A value restored for different text must never be shown for this text. */
    setRestored(undefined);
    let cancelled = false;
    const request = synthetic
      ? dataService.unmaskNmbText(visible, { synthetic: true })
      : dataService.unmaskNmbText(visible);
    request
      .then((res) => {
        if (unmaskCache.size >= MAX_CACHE) {
          unmaskCache.delete(unmaskCache.keys().next().value as string);
        }
        unmaskCache.set(cacheKey, res.text);
        if (!cancelled) {
          setRestored(res.text);
        }
      })
      .catch(() => {
        /** Leave the masked text in place; it is always safe to show. */
        if (!cancelled) {
          setRestored(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shouldUnmask, synthetic, cacheKey, visible]);

  return { text: shouldUnmask && restored != null ? restored : visible, masked };
}
