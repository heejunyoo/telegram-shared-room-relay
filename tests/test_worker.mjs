// test_worker.mjs - cloudflare/src/index.js 를 miniflare(실제 Workers/DO 런타임)로 실행 검증
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs"; // npm install miniflare 후 실행;
import { MockAgent, setGlobalDispatcher } from "miniflare/node_modules/undici/index.js";

const failures = [];
function check(name, cond, detail = "") {
  console.log((cond ? "PASS" : "FAIL"), name, cond ? "" : detail);
  if (!cond) failures.push(name);
}

// 목 텔레그램
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
const tg = mockAgent.get("https://api.telegram.org");
let tgMode = "ok";
let tgCalls = 0;
const tgInterceptor = () =>
  tg.intercept({ path: /\/botTESTTOKEN\/sendMessage/, method: "POST" }).reply(() => {
    tgCalls++;
    if (tgMode === "hang") return new Promise(() => {}); // 응답 없음
    if (tgMode === "error")
      return { statusCode: 200, data: JSON.stringify({ ok: false, error_code: 400, description: "bad text" }) };
    return { statusCode: 200, data: JSON.stringify({ ok: true, result: { message_id: 9000 + tgCalls } }) };
  });

const mf = new Miniflare({
  modules: true,
  script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
  compatibilityDate: "2026-08-06",
  durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
  fetchMock: mockAgent,
  bindings: {
    PICKLE_TOKEN: "pickle-secret",
    INSTINCT_TOKEN: "instinct-secret",
    BOT_TOKEN: "TESTTOKEN",
    WEBHOOK_SECRET: "hooksecret",
    TG_TIMEOUT_MS: "800",
    ALLOWED_CHAT_ID: "555",
    ALLOWED_USER_IDS: "7",
  },
});

const base = "https://relay.test";
async function call(method, path, token, body) {
  const res = await mf.dispatchFetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// Telegram 인터셉트는 요청마다 등록 필요
function armTg() { tgInterceptor(); }

// 1) 인증
let r = await call("GET", "/updates?after=0");
check("auth: no token -> 401", r.status === 401);
r = await call("GET", "/updates?after=0", "wrong");
check("auth: wrong token -> 401", r.status === 401);

// 2) 웹훅 ingest: 사용자 메시지 기록, 봇 메시지 무시
r = await call("POST", "/tg/hooksecret", null, { message: { message_id: 100, from: { id: 7, is_bot: false }, chat: { id: 555 }, date: 1794000000, text: "안녕" } });
check("webhook: 200", r.status === 200);
r = await call("POST", "/tg/hooksecret", null, { message: { message_id: 101, from: { id: 8, is_bot: true }, chat: { id: 555 }, date: 1794000001, text: "봇 메시지" } });
r = await call("POST", "/tg/hooksecret", null, { message: { message_id: 100, from: { id: 7, is_bot: false }, chat: { id: 555 }, date: 1794000000, text: "안녕" } }); // 웹훅 재전송
r = await call("GET", "/updates?after=0", "pickle-secret");
const texts = r.data.messages.map((m) => m.text);
check("webhook: user message recorded", texts.includes("안녕"), JSON.stringify(texts));
check("webhook: bot message ignored", !texts.includes("봇 메시지"));
check("webhook: duplicate update deduped", texts.filter((t) => t === "안녕").length === 1);
// 잘못된 웹훅 경로는 인증 없이 401 (비밀 경로가 곧 인증)
r = await call("POST", "/tg/wrongsecret", null, { message: { message_id: 1, from: { is_bot: false }, chat: { id: 1 }, text: "x" } });
check("webhook: wrong secret path -> 401", r.status === 401);

// 2b) 허용 목록: 다른 방/다른 사용자 메시지는 기록 안 됨
await call("POST", "/tg/hooksecret", null, { message: { message_id: 200, from: { id: 7, is_bot: false }, chat: { id: 999 }, date: 1794000002, text: "다른 방" } });
await call("POST", "/tg/hooksecret", null, { message: { message_id: 201, from: { id: 9, is_bot: false }, chat: { id: 555 }, date: 1794000003, text: "다른 사용자" } });
r = await call("GET", "/updates?after=0", "pickle-secret");
const allowTexts = r.data.messages.map((m) => m.text);
check("allowlist: other chat ignored", !allowTexts.includes("다른 방"), JSON.stringify(allowTexts));
check("allowlist: other user ignored", !allowTexts.includes("다른 사용자"));
const userRootSeq = r.data.messages.find((m) => m.text === "안녕").seq;

// 3) 전송: chat_id 학습됨 -> sent
armTg();
r = await call("POST", "/send", "pickle-secret", { text: "피클 답변", idempotency_key: "k-1" });
check("send: ok + sent", r.data && r.data.telegram_status === "sent", JSON.stringify(r.data));
const seq1 = r.data.seq;

// 4) 멱등 키 재시도: duplicated, 재전송 없음
const n0 = tgCalls;
r = await call("POST", "/send", "pickle-secret", { text: "피클 답변", idempotency_key: "k-1" });
check("retry same idem_key -> duplicated", r.data.duplicated === true && r.data.seq === seq1, JSON.stringify(r.data));
check("retry same idem_key -> no re-send", tgCalls === n0);

// 5) 텔레그램 명시 거절 -> failed
tgMode = "error"; armTg();
r = await call("POST", "/send", "instinct-secret", { text: "x", idempotency_key: "k-err" });
check("explicit error -> failed", String(r.data.telegram_status).startsWith("failed"), JSON.stringify(r.data));
const nErr = tgCalls;
r = await call("POST", "/send", "instinct-secret", { text: "x", idempotency_key: "k-err" });
check("failed same-key retry -> duplicated + stored status, no re-send", r.data.duplicated === true && String(r.data.telegram_status).startsWith("failed") && tgCalls === nErr, JSON.stringify(r.data));

// 6) 결과 불명(hang) -> unconfirmed, 자동 재전송 없음
tgMode = "hang"; armTg();
const n1 = tgCalls;
r = await call("POST", "/send", "instinct-secret", { text: "x", idempotency_key: "k-hang" });
check("ambiguous timeout -> unconfirmed", r.data.telegram_status === "unconfirmed", JSON.stringify(r.data));
check("unconfirmed -> no auto resend", tgCalls === n1 + 1);
tgMode = "ok";

// 7) 커서/페이지네이션
r = await call("GET", "/updates?after=" + seq1, "pickle-secret");
const seqs = r.data.messages.map((m) => m.seq);
check("cursor: only after cursor", seqs.every((s) => s > seq1), JSON.stringify(seqs));
check("cursor: cursor == last seq", seqs.length ? r.data.cursor === seqs[seqs.length - 1] : r.data.cursor === seq1);

// 8) 에코 제외
r = await call("GET", "/updates?after=0", "pickle-secret");
const pTexts = r.data.messages;
r = await call("GET", "/updates?after=0", "instinct-secret");
const iTexts = r.data.messages;
check("echo: own hidden from self", pTexts.every((m) => m.sender !== "pickle"));
check("echo: peer sees them", iTexts.some((m) => m.sender === "pickle"));

// 8b) 멱등 키 누락 -> 400
r = await call("POST", "/send", "pickle-secret", { text: "키 없음" });
check("send: missing idempotency_key -> 400", r.status === 400 && r.data.error === "idempotency_key_required", JSON.stringify(r.data));

// 8c) 왕복 제한 (서버 강제)
r = await call("POST", "/send", "pickle-secret", { text: "에이전트간 1", target: "instinct", idempotency_key: "k-r0" });
check("round: missing root_user_seq -> 400", r.status === 400 && r.data.error === "root_user_seq_required");
r = await call("POST", "/send", "pickle-secret", { text: "에이전트간 1", target: "instinct", root_user_seq: 999999, idempotency_key: "k-r00" });
check("round: bad root -> 400", r.status === 400 && r.data.error === "invalid_root_user_seq");
armTg();
r = await call("POST", "/send", "pickle-secret", { text: "에이전트간 1", target: "instinct", root_user_seq: userRootSeq, idempotency_key: "k-r1" });
check("round: first agent-targeted ok", r.status === 200, JSON.stringify(r.data));
armTg();
r = await call("POST", "/send", "pickle-secret", { text: "에이전트간 2", target: "instinct", root_user_seq: userRootSeq, idempotency_key: "k-r2" });
check("round: second same-agent -> 429", r.status === 429 && r.data.error === "round_limit_exceeded", JSON.stringify(r.data));
armTg();
r = await call("POST", "/send", "pickle-secret", { text: "에이전트간 1", target: "instinct", root_user_seq: userRootSeq, idempotency_key: "k-r1" });
check("round: same-key retry after consumed round -> duplicated not 429", r.status === 200 && r.data.duplicated === true, JSON.stringify(r.data));
armTg();
r = await call("POST", "/send", "instinct-secret", { text: "역방향 1", target: "pickle", root_user_seq: userRootSeq, idempotency_key: "k-r3" });
check("round: other agent still allowed", r.status === 200);

// 9) target 필터 (별도 사용자 질문을 root로 사용: 질문당 에이전트별 1회 제한 때문)
await call("POST", "/tg/hooksecret", null, { message: { message_id: 300, from: { id: 7, is_bot: false }, chat: { id: 555 }, date: 1794000010, text: "두번째 질문" } });
r = await call("GET", "/updates?after=0", "pickle-secret");
const userRootSeq2 = r.data.messages.find((m) => m.text === "두번째 질문").seq;
armTg();
await call("POST", "/send", "instinct-secret", { text: "피클에게만", target: "pickle", root_user_seq: userRootSeq2, idempotency_key: "k-t1" });
r = await call("GET", "/updates?after=0", "pickle-secret");
check("target: visible to target", r.data.messages.some((m) => m.text === "피클에게만"));
r = await call("GET", "/updates?after=0", "instinct-secret");
check("target: hidden from other", r.data.messages.every((m) => m.text !== "피클에게만"));
check("target: user msg visible to both", r.data.messages.some((m) => m.text === "안녕"));

// 10) 동시 전송 20건 -> 고유 seq
armTgMany(20);
const results = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    call("POST", "/send", "pickle-secret", { text: "동시" + i, idempotency_key: "cc-" + i }).then((x) => x.data.seq)
  )
);
check("concurrent: 20 unique seqs", results.filter(Boolean).length === 20 && new Set(results).size === 20, JSON.stringify(results));
r = await call("GET", "/updates?after=0", "instinct-secret");
check("concurrent: all 20 recorded", r.data.messages.filter((m) => m.text.startsWith("동시")).length === 20);

// 11) 본문 sender 스푸핑 무시
armTg();
await call("POST", "/send", "pickle-secret", { text: "스푸핑", sender: "user", idempotency_key: "k-sp" });
r = await call("GET", "/updates?after=0", "instinct-secret");
const sp = r.data.messages.filter((m) => m.text === "스푸핑");
check("spoof: sender forced to token identity", sp.length === 1 && sp[0].sender === "pickle", JSON.stringify(sp));

// 12) 페이지네이션 완결성: 205건 채운 뒤 200 + 나머지, has_more 플래그
armTgMany(205);
for (let i = 0; i < 205; i++)
  await call("POST", "/send", "pickle-secret", { text: "채우기" + i, idempotency_key: "fill-" + i });
r = await call("GET", "/updates?after=0", "instinct-secret");
check("pagination: page1 200 + has_more", r.data.messages.length === 200 && r.data.has_more === true, "len=" + r.data.messages.length);
const c1 = r.data.cursor;
r = await call("GET", "/updates?after=" + c1, "instinct-secret");
check("pagination: page2 rest + no more", r.data.messages.length > 0 && r.data.has_more === false && r.data.messages[0].seq > c1);
r = await call("GET", "/updates?after=999999", "instinct-secret");
check("pagination: cursor stays when empty", r.data.cursor === 999999 && r.data.messages.length === 0);
// 채우기 205건이 1·2페이지 합산으로 전부 보이는지 (instinct 관점)
const f1 = (await call("GET", "/updates?after=0", "instinct-secret")).data;
const f2 = (await call("GET", "/updates?after=" + f1.cursor, "instinct-secret")).data;
const fillCount = [...f1.messages, ...f2.messages].filter((m) => m.text.startsWith("채우기")).length;
check("pagination: all 205 fill msgs across pages", fillCount === 205, "got=" + fillCount);

// 13) 라이브 모드 fail-closed: 허용 목록 미설정이면 웹훅 기록 안 함
const mf2 = new Miniflare({
  modules: true,
  script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
  compatibilityDate: "2026-08-06",
  durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
  fetchMock: mockAgent,
  bindings: { PICKLE_TOKEN: "pickle-secret", INSTINCT_TOKEN: "instinct-secret", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret" },
});
await mf2.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: 500, from: { id: 7, is_bot: false }, chat: { id: 555 }, date: 1794000020, text: "허용목록 없음" } }) });
let r2 = await mf2.dispatchFetch(base + "/updates?after=0", { headers: { Authorization: "Bearer pickle-secret" } });
check("live mode: unset allowlist fails closed", (await r2.json()).messages.length === 0);
await mf2.dispose();

// 14) TEST_MODE: 합성 신원 허용 + 실제 전송 구조적 차단 (실제 토큰이 와도 차단)
const mf3 = new Miniflare({
  modules: true,
  script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
  compatibilityDate: "2026-08-06",
  durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
  fetchMock: mockAgent,
  bindings: { PICKLE_TOKEN: "pickle-secret", INSTINCT_TOKEN: "instinct-secret", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1" },
});
await mf3.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: 600, from: { id: 12345, is_bot: false }, chat: { id: 99999 }, date: 1794000030, text: "합성 사용자" } }) });
let r3 = await mf3.dispatchFetch(base + "/updates?after=0", { headers: { Authorization: "Bearer pickle-secret" } });
check("test mode: synthetic identity recorded", (await r3.json()).messages.some((m) => m.text === "합성 사용자"));
const tgBefore = tgCalls;
r3 = await mf3.dispatchFetch(base + "/send", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer pickle-secret" }, body: JSON.stringify({ text: "차단 확인", idempotency_key: "tm-1" }) });
const r3d = await r3.json();
check("test mode: telegram send structurally blocked", r3d.telegram_status === "blocked:test_mode" && tgCalls === tgBefore, JSON.stringify(r3d));
await mf3.dispose();

function armTgMany(n) { for (let i = 0; i < n; i++) armTg(); }

console.log("\n" + failures.length + " failures");
process.exit(failures.length ? 1 : 0);
