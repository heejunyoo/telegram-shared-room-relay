# Setup and cutover

A new agent needs from the user: a **Cloudflare account** (free plan) with wrangler authentication (browser login or API token), a **Telegram bot token** (@BotFather), and the shared room with the bot added and the allowed Telegram user ids (discovered in step 4). The agent generates the Bearer tokens and webhook secret itself. Prerequisites on the machine: Node >= 22, npm, Python >= 3.10, openssl, curl. See the README input table. Keep secrets out of chat: exchange them through whatever secret store the user prefers (a password-manager handoff, a local file on the user's machine, etc.), never by pasting into a messenger.

## 1. Deploy in TEST_MODE (nothing reaches Telegram)

```bash
cd cloudflare
npm ci                                # pinned wrangler
cp wrangler.toml.example wrangler.toml
npx wrangler login                    # or CLOUDFLARE_API_TOKEN=...
npx wrangler deploy                   # TEST_MODE=1 is set in the template
npx wrangler secret put BOT_TOKEN
npx wrangler secret put INSTINCT_TOKEN   # generate: openssl rand -hex 32
npx wrangler secret put PICKLE_TOKEN     # generate: openssl rand -hex 32
# (more agents or other names: see "Agents: names and tokens" below)
npx wrangler secret put WEBHOOK_SECRET   # generate: openssl rand -hex 32
```

If wrangler asks to register a workers.dev subdomain, the user must choose it. Note the deployed URL: `https://telegram-relay.<your-subdomain>.workers.dev`.

## Agents: names and tokens (configuration only)

The relay knows agents by name. Each name has one Bearer token, and the token is the identity.

- Default (nothing set): two names, `instinct` and `pickle`, with tokens `INSTINCT_TOKEN` and `PICKLE_TOKEN` as in step 1.
- Your own list: set `AGENTS` in `[vars]` to a comma-separated list, for example `AGENTS = "alpha,beta,gamma"`, and put one secret per name: `npx wrangler secret put AGENT_TOKEN_ALPHA` (name in capitals, `-` becomes `_`). Generate each value with `openssl rand -hex 32`. Redeploy. No code change.
- Adding an agent later: add its name to `AGENTS`, set its `AGENT_TOKEN_<NAME>` secret, redeploy. Existing agents and tokens keep working. Their messages, cursors and outbox keys are unaffected.
- Names: start with a lowercase letter, then lowercase letters, digits, `_` or `-`, up to 32 characters. `all` and `user` are reserved. Names that break the rule are ignored.
- If `AGENTS` is set, only the names in it can authenticate. The legacy `PICKLE_TOKEN` and `INSTINCT_TOKEN` are then used only for the names `pickle` and `instinct` if you list them and have not set `AGENT_TOKEN_PICKLE` / `AGENT_TOKEN_INSTINCT`.
- `foo-bar` and `foo_bar` would share one secret name (`AGENT_TOKEN_FOO_BAR`), so both are refused. Use names that stay distinct after `-` becomes `_`.
- A name without a secret cannot log in. The same token value on two names authenticates nobody (fail closed). Use a different random value per agent.
- Replacing the token of an existing name cuts the old client off at once. Do that only on purpose, never to add an agent.

## 2. Verify

Local suites (no deployment needed):

```bash
cd tests && npm ci && npm test                              # worker suite
python3 ../tools/relay_check.py                             # offline harness
```

Deployed-path self-test (temporary, external exposure stays at zero):

1. Add to `[vars]`: `SELFTEST = "1"` and `SELFTEST_ORIGIN = "https://telegram-relay.<your-subdomain>.workers.dev"`, and add a cron trigger:
   ```toml
   [triggers]
   crons = ["*/2 * * * *"]
   ```
2. `npx wrangler deploy`, then `npx wrangler tail` and wait for the `SELFTEST {...}` log line: the self-test runs inside the real Durable Object and the suite wipes its own test data at the end.
3. Remove the cron AND the two vars and redeploy. Wrangler does NOT remove a schedule just because you deleted it from the file - you must set `crons = []` explicitly and redeploy. Verify with the Cloudflare schedules API or dashboard that no schedules remain.

Smoke checks from any machine:

```bash
curl -i https://telegram-relay.<your-subdomain>.workers.dev/updates?after=0          # 401
curl -i -H "Authorization: Bearer <INSTINCT_TOKEN>" https://...workers.dev/updates?after=0   # 200, empty
```

## 3. Connect Telegram (still no room messages)

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://telegram-relay.<your-subdomain>.workers.dev/tg/<WEBHOOK_SECRET>"
```

Telegram now delivers updates to the relay. With TEST_MODE on, sends are still blocked, so you can safely add the bot to the room and observe intake.

## 4. Discover the allowlist

With the bot in the room, have the user send any message, then read the transcript with either agent token (with no allowlist configured and TEST_MODE on, any sender is accepted; the relay does not expose ids) or check the webhook deliveries: note the room `chat_id` and the user's Telegram `user id`. Bots do not need allowlist entries - bot messages are dropped (`is_bot`), and agents authenticate with their Bearer tokens.

## 5. Live cutover (irreversible-feeling step; do it deliberately)

0. Set the allowlist as soon as you know the ids, even while TEST_MODE is on. Once `ALLOWED_CHAT_ID` or `ALLOWED_USER_IDS` is set, the allowlist is always enforced (both are then required, otherwise nothing is accepted). TEST_MODE then only blocks sends. Synthetic identities are accepted only when no allowlist is configured and TEST_MODE is on, so never leave a public webhook in that state longer than needed.
1. In `wrangler.toml` `[vars]`, make sure `ALLOWED_CHAT_ID` and `ALLOWED_USER_IDS` are set, remove `TEST_MODE`, redeploy.
2. Give each agent its Bearer token and the relay URL through the secret route the user chose. The agent that answers in the room needs `target` = the other agent's label and `root_user_seq` of the user message it answers.
3. Send one real user message in the room and watch both agents read it via `GET /updates`.

Rollback: set `TEST_MODE = "1"` again and redeploy - sends stop immediately. To fully detach, `deleteWebhook` on the Telegram API.

## Operational notes

- Round governance: default 1 agent reply per user message per agent (`MAX_ROUNDS_PER_USER_MSG`). Raise it only if the room should allow multi-turn agent exchanges without the user speaking.
- The Durable Object is the single writer; sequence numbers are atomic. Do not run a second consumer against the bot token (no `getUpdates` polling anywhere) - the webhook must stay the sole consumer.
- Free-plan limits (requests/day, DO usage) are far above room-traffic scale as last checked in Nov 2026; limits change, so re-check current Cloudflare pricing and plan limits before relying on the free plan.
