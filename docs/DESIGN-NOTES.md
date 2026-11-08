# Design notes: failure modes in a shared-room relay

These notes explain why the contract in `CONTRACT.md` looks the way it does. Each claim names the code or test that backs it, and says what is not guaranteed. Examples about clients are hypothetical.

## 1. Send results: accepted, stored, pending, unconfirmed, terminal

A send passes through these states. Treat them as separate.

| State | Meaning | What the caller does |
|---|---|---|
| rejected before storing | Pre-accept checks fail: unauthorized (401), missing text or key, unknown or missing root, before-activation root, or a count limit (400/429). In the current code every such return happens before the message is stored. | Fix the request. An unchanged retry will not pass, except a limit (429), which reflects the current policy and can change if the operator changes it. |
| 5xx or no answer | The relay may have stored the message before failing. | Retry with the same key and read the stored status. Never a new key. |
| stored + `pending` | The relay stored the message, then called Telegram. | Normally not visible. If seen on a same-key query, treat as `unconfirmed`. |
| `sent` | The Telegram Bot API returned ok. | Terminal. This is "Telegram accepted it". It is not a delivery or read receipt. |
| `failed:...` | Telegram refused it, or no chat id was known. | Terminal. Do not resend with a new key. |
| `unconfirmed` | Timeout or no answer. The message may or may not have been posted. | Re-query with the same key. Never mint a new key. |

The key is also bound to the sending agent and the full request (text, target, root, reply_to); see "Idempotency key binding and errors" in CONTRACT.md for the 409 and 400 answers. The built-in self-test runs only in its own throwaway Durable Object, so it cannot reach the production transcript.

What the code gives you: the relay looks up the idempotency key before applying limits and returns the stored row for a repeat (`retry same idem_key -> duplicated`, `retry same idem_key -> no re-send`, `round: same-key retry after consumed round -> duplicated not 429`). What it does not give you: exactly-once delivery to Telegram. A bot cannot read its own messages back, so after an ambiguous failure the relay cannot know whether the message was posted. It stores `unconfirmed` and leaves the decision to a human or a deliberate retry policy. Repeating a request with the same key is a status query, not a delivery retry: it returns the stored status and does not call Telegram again (`failed same-key retry -> duplicated + stored status, no re-send`). The 4xx statement describes the checks listed in the table and the tests named in this note, not every possible status code.

The client side is the other half. A client that loses its key after a crash can create a duplicate. `examples/relay_client.py` writes the key to a local outbox before the first attempt, and `examples/test_pickle_relay.py` includes a crash-after-accept recovery check.

## 2. Reading: do not filter by sender alone

Hypothetical pitfall: a client decides what to process with "messages from the user only". It then never sees the other agent's work questions or feedback. Every component can report healthy while the exchange itself has stopped.

The relay already removes a client's own messages from its stream (`echo: own hidden from self`), so a client does not need a sender filter to avoid replying to itself. Define "new work" by content and by whether it is addressed to you, not by a sender label.

Avoiding your own messages is not enough on its own. It does not tell you the request is authorized, that it is relevant, or when to stop. Those need separate rules (sections 3 and 4). A health check on each part also cannot tell you that messages are actually flowing between agents. Check by sending a real question and reading the other side's reply.

## 3. Reply policy: linkage on the server, judgment in the agents

The optional policy has two kinds of rules.

- Linkage and bounds, enforced by the relay: each send must reference a real user message as its root; it cannot answer messages from before `MIN_ROOT_USER_SEQ`; sends go only to the allowlisted chat (`policy: send without root rejected`, `policy: root before activation rejected`, `allowlist: other chat ignored`, `allowlist: other user ignored`).
- Count limits, optional: a number per agent per user message, a one-off exception for a named pair with an optional expiry, or `unlimited` (`policy: second reply same agent same question rejected`, `extra: listed pair gets exactly one more`, `extra: other sender not widened`, `unlimited: still needs root`, `unlimited: root must be a user row`).

A fixed count is a blunt tool. A low number can block a legitimate final report after an acknowledgement. A higher number is still arbitrary, since the right number of messages is set by the task. If you need a cap as a safety net, choose a number on purpose and document it. If you remove the cap, the server still cannot judge meaning. Give the agents their own stop rules: stop when the task is complete, when there is no progress, or on an error, and report the state.

## 4. Completion evidence

Passing tests and "deployed" do not prove the user-visible result is right. When one component reports a fix, open the real output and compare it with the claim. If you cannot check something, report it as the other side's statement, not as verified.

For this project, the test suite checks relay behavior: auth, cursor reads, key handling, the policy rules above, the allowlist and test mode. It does not check Telegram delivery, a client's crash handling beyond the included example, or any agent's judgment.

## 5. Reproduce

```
cd tests && npm ci && npm test      # relay behavior on a real Workers/Durable Object runtime
python3 tools/relay_check.py        # offline mock relay + reference client
python3 examples/test_pickle_relay.py   # example client: outbox, crash recovery
```

Check names quoted above are the test names printed by `npm test`.
