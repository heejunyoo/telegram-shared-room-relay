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
npx wrangler secret put WEBHOOK_SECRET   # generate: openssl rand -hex 32
```

If wrangler asks to register a workers.dev subdomain, the user must choose it. Note the deployed URL: `https://telegram-relay.<your-subdomain>.workers.dev`.

## Optional: derive an agent's token from a bot token both sides already hold

If agent B already stores the Telegram bot token and cannot receive a new secret safely, set `PICKLE_TOKEN` (agent B's secret) to a value both sides compute locally. Nothing new is transferred. It is not stronger than a random token: anyone holding the bot token can compute it, so use it only when the same two parties already share that token. Do not derive the other agent's token or the webhook secret this way.

Exact bytes (versioned, bound to the role and the deployment origin):

```python
import hmac, hashlib
msg = ("telegram-relay/v1\nrole=<role>\norigin=<origin>").encode()   # origin: https scheme + host, lowercase, no trailing slash
token = hmac.new(bot_token.encode(), msg, hashlib.sha256).hexdigest()
```

Test vector (fake values): bot token `123456:FAKE-TEST-TOKEN-NOT-REAL`, role `pickle`, origin `https://telegram-relay.example.workers.dev` gives `33990acb7a44e3401857692be21cb1b110d6b043771612cce0be75133c6c8f70`. The same value comes out of `printf 'telegram-relay/v1\nrole=pickle\norigin=https://telegram-relay.example.workers.dev' | openssl dgst -sha256 -hmac '123456:FAKE-TEST-TOKEN-NOT-REAL' -hex`.

Set the worker secret from the same computation without printing it, then confirm with an authenticated `GET /updates?after=0` (200) and that the old value now returns 401.

## 2. Verify

Local suites (no deployment needed):

```bash
cd tests && npm ci && npm test                              # 40 checks
python3 ../tools/relay_check.py                             # 18 checks, offline
```

Deployed-path self-test (temporary, external exposure stays at zero):

1. Add to `[vars]`: `SELFTEST = "1"` and `SELFTEST_ORIGIN = "https://telegram-relay.<your-subdomain>.workers.dev"`, and add a cron trigger:
   ```toml
   [triggers]
   crons = ["*/2 * * * *"]
   ```
2. `npx wrangler deploy`, then `npx wrangler tail` and wait for the `SELFTEST {...}` log line: 24 checks run inside the real Durable Object and the suite wipes its own test data at the end.
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

With the bot in the room, have the user send any message, then read the transcript with either agent token (TEST_MODE records synthetic intake) or check the webhook deliveries: note the room `chat_id` and the user's Telegram `user id`. Bots do not need allowlist entries - bot messages are dropped (`is_bot`), and agents authenticate with their Bearer tokens.

## 5. Live cutover (irreversible-feeling step; do it deliberately)

1. In `wrangler.toml` `[vars]`, set `ALLOWED_CHAT_ID` and `ALLOWED_USER_IDS`, remove `TEST_MODE`, redeploy.
2. Give each agent its Bearer token and the relay URL through the secret route the user chose. The agent that answers in the room needs `target` = the other agent's label and `root_user_seq` of the user message it answers.
3. Send one real user message in the room and watch both agents read it via `GET /updates`.

Rollback: set `TEST_MODE = "1"` again and redeploy - sends stop immediately. To fully detach, `deleteWebhook` on the Telegram API.

## Operational notes

- Round governance: default 1 agent reply per user message per agent (`MAX_ROUNDS_PER_USER_MSG`). Raise it only if the room should allow multi-turn agent exchanges without the user speaking.
- The Durable Object is the single writer; sequence numbers are atomic. Do not run a second consumer against the bot token (no `getUpdates` polling anywhere) - the webhook must stay the sole consumer.
- Free-plan limits (requests/day, DO usage) are far above room-traffic scale as last checked in Nov 2026; limits change, so re-check current Cloudflare pricing and plan limits before relying on the free plan.
