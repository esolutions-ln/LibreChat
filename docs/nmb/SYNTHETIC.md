# Synthetic approval and automatic release of held prompts

A reviewer can approve a held prompt in one of two ways:

- **masked** (existing): sensitive values become `<TYPE_nnn>` tokens.
- **synthetic** (new): every sensitive value is replaced by a realistic, format-preserving fake. The model sees natural text
  with no real value; the owner sees the real values restored in the reply.

After approval the owner's chat releases the prompt by itself, so the model's answer arrives in the chat of the user who
wrote the prompt without them pressing anything. It happens when that chat is open, or the next time the owner opens it.

```
user sends -> scanner BLOCK -> 423 held card in the owner's chat (polls /api/nmb/submissions/:id)
reviewer: Approve masked | Synthesize & release  -> scanner re-scans the original with the chosen mode
owner's card sees approved && !released -> sends [[nmb:release:<id>]] once
gateway: swaps in approved text (+ note), marks released, normal chat pipeline -> model -> answer in that chat
display: tokens or synthetic values in the user message and the answer are restored for the owner (display only)
```

## Scanner (`/reviews/{id}/approve-masked`, `/unmask`, `/reviews/{id}/released`)
- `POST /reviews/{id}/approve-masked` body gains `mode`: `"masked"` (default) or `"synthetic"`. Same response (decision object).
  The review item records `"mode"` and the result blob/`GET /reviews/{id}/result` returns `"mode"`.
- `synthetic` mode replaces EVERY finding of the review, including entities whose policy action is `BLOCK`, with a fake:
  deterministic per (scope, entity, normalised value) so equal real values get equal fakes inside one scope, never equal to
  any real value found in the same text, and never taken from real data. Per entity:
  `PERSON` first+last name from curated lists; `EMAIL` `first.last@example.org`-style on a reserved domain; `PHONE` same
  prefix and digit grouping with random digits; `ACCOUNT_NUMBER` same length and separators, random digits;
  `IBAN` same country code and length; `SWIFT_BIC` random 8 or 11 characters in the same shape; `CREDIT_CARD` Luhn-valid,
  same length and separators; `ZW_NATIONAL_ID`/`US_SSN` same pattern with random digits/letter; `API_KEY_SECRET` and
  `PRIVATE_KEY` a random token of the same length and character classes (never reversible); `ORG_KEYWORD`/blocklist terms
  `Project <Adjective> <Noun>`; any other entity a random token of the same length. Digits and letters keep their class.
- Mappings are stored in the existing `mappings` table with the fake as the key and the real value Fernet-encrypted when the
  entity is reversible (cards, secrets store no real value). A fake that collides with an existing key is regenerated.
- `POST /unmask` body gains `synthetic` (bool, default false). When true the scanner restores BOTH `<TYPE_nnn>` tokens and
  synthetic values (exact, longest first, whole tokens only) for the scope. Same role check as today. `restored` counts both.
- `POST /reviews/{id}/released` (service key only): sets `released_at` (ISO) on the item the first time and returns the item
  (idempotent). Review items expose `released_at` (null until then). It does not block a second release.

## Gateway (`/api/nmb/*`)
- `POST /reviews/:id/approve` body `{ note?, additions?, mode?: 'masked'|'synthetic' }`; `additions` are ignored for synthetic.
  Audit metadata gains `mode`.
- Releasing a synthetic review appends the synthetic note (marker `\n\n[NMB synthetic note:`) to the model-bound text instead
  of the redaction note, then calls `/reviews/{id}/released`. Display strips it like the other notes.
- `GET /submissions/:id` adds `mode` and `released` (boolean).
- `POST /unmask` body gains `synthetic` (bool); when true it always forwards to the scanner.

## Client
- Review detail: two approval actions with a one-line explanation each ("Approve masked", "Synthesize and release").
- Held card (`NmbError`): when `status === 'approved-masked' && !released`, send the release once automatically
  (guard against double sends); when `released`, show that it was sent, with a "Send again" action.
- Display: if any message in the conversation carries the synthetic note, restore synthetic values in that conversation's
  user and assistant text with `/api/nmb/unmask` (`synthetic: true`), display only, cached, never written back.
- New marker `NMB_SYNTHETIC_NOTE_MARKER`; `stripNmbMaskNote` cuts at the earliest of the three markers.

## Limits
Automatic release needs the owner's chat to be open or opened later: LibreChat has no server-side way to start a turn in a
conversation. Fake names can, rarely, equal a name that appears naturally in the same scope; only values issued for that
user are ever restored.
