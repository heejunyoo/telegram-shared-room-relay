# Relay contract

The relay is the sole consumer of the Telegram bot's updates (webhook). Both agents talk only to the relay, never to Telegram directly. Authentication is a per-agent Bearer token; the token IS the sender identity - any `sender` field in a request body is ignored.

## Read

```
GET /updates?after=<cursor>
Authorization: Bearer <agent token>
```

- Returns up to 200 messages with `seq > cursor`, oldest first.
- `has_more: true` means keep paging by raising the cursor to the last seen `seq`.
- An agent never sees its own messages. Messages with `target` set are visible only to that target agent (and are not echo-visible to the sender).
- Cursor rule: advance and persist your cursor only AFTER you have durably processed (stored) the message. Re-reading is always safe; the server only returns messages after the cursor.

## Write

```
POST /send
Authorization: Bearer <agent token>
{ "text": "...", "idempotency_key": "...", "target": "<agent name>" | "all",
  "root_user_seq": 123, "reply_to": 456 }
```

- `idempotency_key` is REQUIRED. The server dedups on it: a retry with the same key returns `duplicated: true` with the original `seq` and the stored `telegram_status` - and dedup runs BEFORE the round-limit gate, so a same-key retry of an accepted send is never answered with 429.
- `target` (default `all`): `all` = visible to every other agent; a configured agent name = visible only to that agent. An unknown target is rejected with `400 invalid_target`. Agent names are configuration (`AGENTS`, default `instinct,pickle`; see SETUP "Agents: names and tokens"). Both are relay-transcript writes; the relay also mirrors the message to the Telegram room.
- Agent-to-agent sends (`target` = another agent's name) require `root_user_seq` = the `seq` of the user message being answered. Per user message, each agent gets `MAX_ROUNDS_PER_USER_MSG` (default 1) agent-targeted sends; beyond that the server returns `429 round_limit_exceeded`. An unknown root returns `400 invalid_root_user_seq`; a missing root returns `400 root_user_seq_required`.

### Idempotency key binding and errors

A key is bound to the agent that first used it and to the full request: `text`, `target`, `root_user_seq` and `reply_to`, with omitted values treated as their defaults (`target` all, `root_user_seq` and `reply_to` none). The server stores these fields on every row and compares them on a repeat.

| Situation | Answer |
|---|---|
| Same agent, same request | `200` with `duplicated: true`, the original `seq` and stored `telegram_status`. No new row, no call to Telegram. |
| Same agent, key reused with a different `text`, `target`, `root_user_seq` or `reply_to` | `409 idempotency_key_reused_with_different_request`. Nothing is stored. |
| Another agent uses a key that already exists | `409 idempotency_key_conflict`. The answer carries no `seq` and no status, so one agent learns nothing about another agent's rows. |
| New key starting with `tg:` (any case) | `400 reserved_idempotency_key_prefix`. That prefix is reserved for messages from the Telegram webhook. |

Rows written before `root_user_seq` was stored have no root. A retry of such a row that carries a root gets the 409 above; a retry without one is accepted as before. A key that already exists from the same agent is still answered by the stored-row path, so old pending keys can still be recovered.

A client should treat any 409 as terminal for that key: stop, report, and do not mint a new key for the same message.

## Optional reply policy (server enforced)

Set `MIN_ROOT_USER_SEQ` and/or `MAX_REPLIES_PER_USER_MSG` to turn it on. Then, for every agent send regardless of `target`:

- `root_user_seq` is required and must be a user message: no unprompted posts (`400 root_user_seq_required`, `400 invalid_root_user_seq`).
- `root_user_seq` must be at least `MIN_ROOT_USER_SEQ`, so an agent cannot answer messages from before the policy started (`400 root_before_activation`). Set it to the first seq you want answered.
- Each agent may send at most `MAX_REPLIES_PER_USER_MSG` (default 1, or `unlimited` to disable the count) messages per user message (`429 reply_limit_exceeded`). A same-key retry of an accepted send still returns `duplicated: true` first.
- Optional exception: `EXTRA_REPLIES="<sender>:<root_seq>[:<extra>],..."` allows `<extra>` more replies (default 1, max 20) for each listed (sender, user message) pair. Other senders and other messages keep the normal limit. Set `EXTRA_REPLIES_UNTIL` (unix seconds) to make it expire on its own. Use it only for a deliberate, finite follow-up, then remove it and redeploy.

### Task collaboration without a count cap

Set `MAX_REPLIES_PER_USER_MSG` (and `MAX_ROUNDS_PER_USER_MSG` if agents send to each other by name) to `unlimited` to turn the server count limits off. Nothing else changes: every send still needs a real user message as root, the allowlist still applies, and the same-key retry rule still holds. A number (for example 6) still works if you want a cap. The server does not judge meaning, so the agents' own rules decide when to stop:

- Use a fixed key per distinct message, such as `<agent>-reply-<root>-<n>`. Retry a pending send with the same key and text, never a new key.
- Keep messages to task questions, progress and a final report. Stop when the task is complete, when there is no progress, or on an error, and report the state.

When `ALLOWED_CHAT_ID` is set, outgoing sends always go to that chat, never to a chat id learned from intake.

## telegram_status lifecycle

Every accepted send returns a `telegram_status`:

- `sent` - the Telegram Bot API returned ok for `sendMessage`. Terminal. This means Telegram accepted the message, not that a device displayed it; the bot API gives no read or delivery receipt.
- `failed:<reason>` - Telegram explicitly rejected it (or no chat id is known). Terminal. Do NOT retry with a new key. The first response carries Telegram's description (`failed:<description>`), while a later same-key query returns the stored form (`failed:<error code>`), so match on the `failed:` prefix only.
- `unconfirmed` - the result is ambiguous (timeout, no response). The message may or may not have been delivered. NEVER resend with a new key - that is the only way duplicates happen. Re-query with the SAME key; the server returns `duplicated: true` with the stored status.
- `pending` - stored before the Telegram call. You should normally not see it. If a same-key query returns it, the call may have been interrupted: treat it as `unconfirmed`.
- `blocked:test_mode` - TEST_MODE is on; nothing was sent to Telegram. Terminal for that send.

## The caller-side durability rule (required)

The client's idempotency key must survive process death:

1. Before the FIRST send attempt, persist (intent, idempotency_key) to a local outbox. Generate the key once per logical message.
2. On ambiguous failure (timeout, 5xx, network error), keep the outbox entry pending and re-query with the same key. Never mint a new key for the same logical message.
3. On restart, reload the outbox and finish pending entries with their stored keys (`flush_outbox`).
4. Mark an entry done only on a terminal server answer (`sent`, `failed:`, `blocked:`, a 409 key conflict, or `duplicated` with a terminal stored status). `pending`, `unconfirmed`, an unknown status, a 5xx and a timeout are not terminal: keep the entry and re-query with the same key.

`examples/relay_client.py` implements all of this and `examples/test_pickle_relay.py` tests it, including a crash-after-server-accept recovery check.

## Webhook intake (server side)

- Telegram posts to `/tg/<WEBHOOK_SECRET>`.
- Messages from bots (`is_bot`) are dropped - agents' room messages reach the other agent through the relay transcript, not by reading Telegram.
- In live mode the allowlist (`ALLOWED_CHAT_ID`, `ALLOWED_USER_IDS`) is fail-closed: unset means nothing is recorded.
- In TEST_MODE, synthetic identities are accepted and nothing is sent to Telegram.
