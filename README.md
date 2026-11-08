# telegram-shared-room-relay

한 텔레그램 방에 사용자와 두 개의 AI 에이전트(봇)가 함께 대화할 수 있게 해 주는 중계 서버입니다. 텔레그램 봇은 다른 봇의 메시지를 볼 수 없기 때문에, 중계 서버가 공용 대화록(transcript)을 보관하고 각 에이전트는 중계를 통해 상대방의 발언을 읽고 답합니다. 어느 한쪽이 같은 내용을 두 번 읽거나 두 번 쓰지 않도록, 읽기 커서와 쓰기 멱등 키를 규약으로 강제합니다.

A relay server that lets a user and two AI agents (bots) share one Telegram room. Telegram bots cannot see each other's messages, so the relay keeps the shared transcript and each agent reads and replies through it. The contract enforces a durable read cursor and write idempotency keys so neither side ever reads or sends the same thing twice.

- Server: Cloudflare Workers + Durable Object (SQLite). Free plan is enough for this traffic.
- Client: any language. A verified Python reference client is included.
- Costs: $0 on the Cloudflare free plan at this scale. Telegram bots are free.

---

## Repository layout

```
cloudflare/src/index.js        Relay worker (API + Durable Object transcript)
cloudflare/wrangler.toml.example  Deploy configuration template
tests/test_worker.mjs          40-check suite on a real Workers/DO runtime (miniflare)
tools/relay_check.py           Offline mock relay + reference client + 18-check verifier
examples/relay_client.py       Production-shaped Python client with durable outbox
examples/test_pickle_relay.py  Integration test for the example client (21 checks)
docs/CONTRACT.md               The relay contract both agents must implement
docs/SETUP.md                  Deploy + Telegram cutover guide
```

## Quickstart (what a new agent needs)

You need exactly two things from the user: a **Cloudflare account** and a **Telegram bot token** (from @BotFather). Everything else is generated locally.

```bash
cd cloudflare
cp wrangler.toml.example wrangler.toml
npx wrangler deploy                      # TEST_MODE=1: no real Telegram sends
npx wrangler secret put BOT_TOKEN        # Telegram bot token
npx wrangler secret put INSTINCT_TOKEN   # random Bearer token you generate for agent A
npx wrangler secret put PICKLE_TOKEN     # random Bearer token you generate for agent B
npx wrangler secret put WEBHOOK_SECRET   # random path secret you generate
```

Full steps, self-test, webhook registration, and live cutover: [docs/SETUP.md](docs/SETUP.md).

## Verify before you trust it

```bash
cd tests && npm install miniflare && node test_worker.mjs   # 40 checks
python3 tools/relay_check.py                                # 18 checks, fully offline
python3 tools/relay_check.py --serve                        # mock server for your own client
```

Current status: the worker passed the 40-check local suite, the 18-check offline harness, and a 24-check self-test on a real test deployment (TEST_MODE). The example client passed independent crash-recovery reproduction (response-loss after server accept, restart, same-key recovery, no duplicate). The relay has **not** been connected to a live Telegram room yet; that is the remaining cutover step in docs/SETUP.md.

## The one rule that matters most

Never resend with a new idempotency key after an ambiguous failure (timeout, 5xx, lost response). Record intent + key to a durable outbox **before** the first send, and re-query with the same key. See `examples/relay_client.py` for a complete implementation and [docs/CONTRACT.md](docs/CONTRACT.md) for why.

## License

MIT (see LICENSE). Sender labels (`instinct`, `pickle`) are just configurable examples of "agent A" and "agent B"; rename freely.
