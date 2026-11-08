// test_worker.mjs - cloudflare/src/index.js 를 miniflare(실제 Workers/DO 런타임)로 실행 검증
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs"; // npm ci 후 실행 (tests/ 에서);
import { MockAgent, setGlobalDispatcher } from "undici";

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

// 15) TEST_MODE + 허용 목록 설정: 허용 목록은 항상 강제, 전송은 계속 차단
const mf4 = new Miniflare({
  modules: true,
  script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
  compatibilityDate: "2026-08-06",
  durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
  fetchMock: mockAgent,
  bindings: { PICKLE_TOKEN: "pickle-secret", INSTINCT_TOKEN: "instinct-secret", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "777" },
});
const hook4 = (id, from, chat, text) => mf4.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: id, from: { id: from, is_bot: false }, chat: { id: chat }, date: 1794000040, text } }) });
await hook4(701, 777, 555, "허용된 사용자");
await hook4(702, 888, 555, "같은 방 다른 사용자");
await hook4(703, 777, 999, "다른 방 허용 사용자");
await hook4(704, 12345, 99999, "합성 신원");
const r4 = await (await mf4.dispatchFetch(base + "/updates?after=0", { headers: { Authorization: "Bearer pickle-secret" } })).json();
const t4 = r4.messages.map((m) => m.text);
check("test mode + allowlist: expected ids accepted", t4.includes("허용된 사용자"), JSON.stringify(t4));
check("test mode + allowlist: outsiders rejected", t4.length === 1, JSON.stringify(t4));
const tgBefore4 = tgCalls;
const r4s = await (await mf4.dispatchFetch(base + "/send", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer pickle-secret" }, body: JSON.stringify({ text: "차단 유지", idempotency_key: "tm-2" }) })).json();
check("test mode + allowlist: send still blocked, no telegram call", r4s.telegram_status === "blocked:test_mode" && tgCalls === tgBefore4, JSON.stringify(r4s));
await mf4.dispose();

// 16) 응답 정책: root 필수, 활성화 이전 root 거부, 에이전트별 질문당 1회(대상 무관), 선제 발신 금지
const mf5 = new Miniflare({
  modules: true,
  script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
  compatibilityDate: "2026-08-06",
  durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
  fetchMock: mockAgent,
  bindings: { PICKLE_TOKEN: "pickle-secret", INSTINCT_TOKEN: "instinct-secret", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "777", MIN_ROOT_USER_SEQ: "2" },
});
const hook5 = (id, text) => mf5.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: id, from: { id: 777, is_bot: false }, chat: { id: 555 }, date: 1794000050, text } }) });
await hook5(801, "활성화 이전");
await hook5(802, "활성화 이후 질문");
const u5 = await (await mf5.dispatchFetch(base + "/updates?after=0", { headers: { Authorization: "Bearer pickle-secret" } })).json();
const oldSeq = u5.messages.find((m) => m.text === "활성화 이전").seq;
const newSeq = u5.messages.find((m) => m.text === "활성화 이후 질문").seq;
const send5 = async (tok, body) => { const r = await mf5.dispatchFetch(base + "/send", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
let q = await send5("pickle-secret", { text: "선제", idempotency_key: "p-0" });
check("policy: send without root rejected", q.status === 400 && q.data.error === "root_user_seq_required", JSON.stringify(q));
q = await send5("pickle-secret", { text: "옛 질문", idempotency_key: "p-1", root_user_seq: oldSeq });
check("policy: root before activation rejected", q.status === 400 && q.data.error === "root_before_activation", JSON.stringify(q));
q = await send5("pickle-secret", { text: "답1", idempotency_key: "p-2", root_user_seq: newSeq });
check("policy: first reply accepted", q.status === 200 && q.data.telegram_status === "blocked:test_mode", JSON.stringify(q));
q = await send5("pickle-secret", { text: "답2", idempotency_key: "p-3", root_user_seq: newSeq });
check("policy: second reply same agent same question rejected (target all)", q.status === 429 && q.data.error === "reply_limit_exceeded", JSON.stringify(q));
q = await send5("pickle-secret", { text: "답1", idempotency_key: "p-2", root_user_seq: newSeq });
check("policy: same-key retry returns duplicate, not 429", q.status === 200 && q.data.duplicated === true, JSON.stringify(q));
q = await send5("instinct-secret", { text: "다른 에이전트 답", idempotency_key: "i-1", root_user_seq: newSeq });
check("policy: other agent gets its own single reply", q.status === 200, JSON.stringify(q));
await mf5.dispose();

// 16b) 예외: EXTRA_REPLIES 로 지정한 (발신자, 질문) 쌍만 추가 1회 허용
const mf6 = new Miniflare({
  modules: true,
  script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
  compatibilityDate: "2026-08-06",
  durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
  fetchMock: mockAgent,
  bindings: { PICKLE_TOKEN: "pickle-secret", INSTINCT_TOKEN: "instinct-secret", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "777", MIN_ROOT_USER_SEQ: "1", EXTRA_REPLIES: "instinct:1" },
});
const hook6 = (id, text) => mf6.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: id, from: { id: 777, is_bot: false }, chat: { id: 555 }, date: 1794000060, text } }) });
await hook6(901, "질문 A");
await hook6(902, "질문 B");
const send6 = async (tok, body) => { const r = await mf6.dispatchFetch(base + "/send", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
q = await send6("instinct-secret", { text: "1", idempotency_key: "e-1", root_user_seq: 1 });
check("extra: first reply accepted", q.status === 200, JSON.stringify(q));
q = await send6("instinct-secret", { text: "2", idempotency_key: "e-2", root_user_seq: 1 });
check("extra: listed pair gets exactly one more", q.status === 200, JSON.stringify(q));
q = await send6("instinct-secret", { text: "3", idempotency_key: "e-3", root_user_seq: 1 });
check("extra: third reply rejected", q.status === 429, JSON.stringify(q));
q = await send6("pickle-secret", { text: "1", idempotency_key: "e-4", root_user_seq: 1 });
q = await send6("pickle-secret", { text: "2", idempotency_key: "e-5", root_user_seq: 1 });
check("extra: other sender not widened", q.status === 429, JSON.stringify(q));
q = await send6("instinct-secret", { text: "1", idempotency_key: "e-6", root_user_seq: 2 });
q = await send6("instinct-secret", { text: "2", idempotency_key: "e-7", root_user_seq: 2 });
check("extra: other question not widened", q.status === 429, JSON.stringify(q));
await mf6.dispose();

// 16d) unlimited: 횟수 제한만 해제, root 연결은 유지
{
  const m = new Miniflare({
    modules: true,
    script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
    compatibilityDate: "2026-08-06",
    durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
    fetchMock: mockAgent,
    bindings: { PICKLE_TOKEN: "pickle-secret", INSTINCT_TOKEN: "instinct-secret", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "777", MIN_ROOT_USER_SEQ: "1", MAX_REPLIES_PER_USER_MSG: "unlimited", MAX_ROUNDS_PER_USER_MSG: "unlimited" },
  });
  await m.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: 961, from: { id: 777, is_bot: false }, chat: { id: 555 }, date: 1794000080, text: "질문" } }) });
  const s = async (tok, body) => { const r = await m.dispatchFetch(base + "/send", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify(body) }); return r.status; };
  const st = []; for (let n = 0; n < 12; n++) st.push(await s("instinct-secret", { text: "x", idempotency_key: "u" + n, root_user_seq: 1, target: n % 2 ? "pickle" : "all" }));
  check("unlimited: 12 sends incl. targeted all accepted", st.every((c) => c === 200), JSON.stringify(st));
  check("unlimited: still needs root", (await s("instinct-secret", { text: "x", idempotency_key: "u-noroot" })) === 400);
  check("unlimited: root must be a user row", (await s("instinct-secret", { text: "x", idempotency_key: "u-bad", root_user_seq: 999 })) === 400);
  await m.dispose();
}

// 16c) 추가 횟수 지정, 만료
async function mkExtra(extra, until) {
  const m = new Miniflare({
    modules: true,
    script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
    compatibilityDate: "2026-08-06",
    durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
    fetchMock: mockAgent,
    bindings: Object.assign({ PICKLE_TOKEN: "pickle-secret", INSTINCT_TOKEN: "instinct-secret", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "777", MIN_ROOT_USER_SEQ: "1", EXTRA_REPLIES: extra }, until ? { EXTRA_REPLIES_UNTIL: until } : {}),
  });
  await m.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: 951, from: { id: 777, is_bot: false }, chat: { id: 555 }, date: 1794000070, text: "질문" } }) });
  const s = async (tok, k) => (await m.dispatchFetch(base + "/send", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + tok }, body: JSON.stringify({ text: "x", idempotency_key: k, root_user_seq: 1 }) })).status;
  return { m, s };
}
{
  const { m, s } = await mkExtra("instinct:1:3,pickle:1:2", String(Math.floor(Date.now() / 1000) + 3600));
  const iSt = []; for (let n = 0; n < 5; n++) iSt.push(await s("instinct-secret", "i" + n));
  const pSt = []; for (let n = 0; n < 4; n++) pSt.push(await s("pickle-secret", "p" + n));
  check("extra count: instinct 1+3 allowed then 429", JSON.stringify(iSt) === "[200,200,200,200,429]", JSON.stringify(iSt));
  check("extra count: pickle 1+2 allowed then 429", JSON.stringify(pSt) === "[200,200,200,429]", JSON.stringify(pSt));
  await m.dispose();
}
{
  const { m, s } = await mkExtra("instinct:1:3", String(Math.floor(Date.now() / 1000) - 5));
  const st = []; for (let n = 0; n < 2; n++) st.push(await s("instinct-secret", "x" + n));
  check("extra expiry: expired exception ignored", JSON.stringify(st) === "[200,429]", JSON.stringify(st));
  await m.dispose();
}


// 17) 설정만으로 에이전트 추가: AGENTS + AGENT_TOKEN_<이름> (코드 수정 없음)
{
  const mkReg = async (extra) => {
    const m = new Miniflare({
      modules: true,
      script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
      compatibilityDate: "2026-08-06",
      durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
      fetchMock: mockAgent,
      bindings: { BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "7", ...extra },
    });
    const c = async (method, path, token, body) => {
      const res = await m.dispatchFetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
      let data = null; try { data = await res.json(); } catch {}
      return { status: res.status, data };
    };
    await m.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: 1, from: { id: 7, is_bot: false }, chat: { id: 555 }, date: 1794000100, text: "q" } }) });
    return { m, c };
  };
  // 기본값(AGENTS 미설정): 기존 두 신원과 PICKLE_TOKEN/INSTINCT_TOKEN 그대로
  { const { m, c } = await mkReg({ PICKLE_TOKEN: "pk", INSTINCT_TOKEN: "in" });
    check("registry default: legacy tokens still authenticate", (await c("GET", "/updates?after=0", "pk")).status === 200 && (await c("GET", "/updates?after=0", "in")).status === 200);
    check("registry default: unknown token 401", (await c("GET", "/updates?after=0", "zz")).status === 401);
    const r = await c("POST", "/send", "pk", { text: "a", idempotency_key: "d1", target: "instinct", root_user_seq: 1 });
    check("registry default: agent target works", r.status === 200 && r.data.telegram_status === "blocked:test_mode", JSON.stringify(r));
    check("registry default: unknown target rejected", (await c("POST", "/send", "pk", { text: "a", idempotency_key: "d2", target: "ghost", root_user_seq: 1 })).data.error === "invalid_target");
    await m.dispose(); }
  // 제3 에이전트: 설정만으로 추가, 라우팅과 echo 제거 동작
  { const { m, c } = await mkReg({ AGENTS: "pickle,instinct,data-analyst", PICKLE_TOKEN: "pk", INSTINCT_TOKEN: "in", AGENT_TOKEN_DATA_ANALYST: "da" });
    check("third agent authenticates", (await c("GET", "/updates?after=0", "da")).status === 200);
    const r = await c("POST", "/send", "da", { text: "to pickle", idempotency_key: "t1", target: "pickle", root_user_seq: 1 });
    check("third agent: targeted send ok", r.status === 200 && r.data.ok === true, JSON.stringify(r));
    check("third agent: target needs root", (await c("POST", "/send", "da", { text: "x", idempotency_key: "t2", target: "pickle" })).data.error === "root_user_seq_required");
    check("third agent: pickle sees it", (await c("GET", "/updates?after=0", "pk")).data.messages.some((x) => x.text === "to pickle" && x.sender === "data-analyst"));
    check("third agent: instinct does not see pickle-only msg", !(await c("GET", "/updates?after=0", "in")).data.messages.some((x) => x.text === "to pickle"));
    check("third agent: own message hidden from itself", !(await c("GET", "/updates?after=0", "da")).data.messages.some((x) => x.sender === "data-analyst"));
    const r2 = await c("POST", "/send", "pk", { text: "back", idempotency_key: "t3", target: "data-analyst", root_user_seq: 1 });
    check("targeting the third agent works", r2.status === 200);
    check("third agent sees message targeted at it", (await c("GET", "/updates?after=0", "da")).data.messages.some((x) => x.text === "back"));
    await m.dispose(); }
  // 새 이름은 추가만 되고 기존 신원 호환 유지, 명시 목록에서 빠지면 토큰도 무효
  { const { m, c } = await mkReg({ AGENTS: "alpha,beta", AGENT_TOKEN_ALPHA: "a1", AGENT_TOKEN_BETA: "b1", PICKLE_TOKEN: "pk" });
    check("explicit list: alpha ok", (await c("GET", "/updates?after=0", "a1")).status === 200);
    check("explicit list: legacy token not in list rejected", (await c("GET", "/updates?after=0", "pk")).status === 401);
    await m.dispose(); }
  // 같은 토큰을 두 이름에 설정하면 모호하므로 인증 거부(fail closed)
  { const { m, c } = await mkReg({ AGENTS: "alpha,beta", AGENT_TOKEN_ALPHA: "same", AGENT_TOKEN_BETA: "same" });
    check("duplicate token fails closed", (await c("GET", "/updates?after=0", "same")).status === 401);
    await m.dispose(); }
  // foo-bar 와 foo_bar 는 같은 비밀값 이름으로 겹치므로 둘 다 제외(fail closed), 다른 이름은 영향 없음
  { const { m, c } = await mkReg({ AGENTS: "foo-bar, foo_bar ,Zed,zed,x".replace("x", "ok2") + "," + "a".repeat(33) + "," + "b".repeat(32), AGENT_TOKEN_FOO_BAR: "fb", AGENT_TOKEN_ZED: "z1", AGENT_TOKEN_OK2: "o2", ["AGENT_TOKEN_" + "B".repeat(32)]: "bmax", ["AGENT_TOKEN_" + "A".repeat(33)]: "atoolong" });
    check("collision: foo-bar/foo_bar both refused", (await c("GET", "/updates?after=0", "fb")).status === 401);
    check("collision: target of a colliding name rejected", (await c("POST", "/send", "o2", { text: "t", idempotency_key: "c1", target: "foo-bar", root_user_seq: 1 })).data.error === "invalid_target");
    check("whitespace trimmed, case-folded, duplicates merged", (await c("GET", "/updates?after=0", "z1")).status === 200);
    check("32-char name accepted, 33-char ignored", (await c("GET", "/updates?after=0", "bmax")).status === 200 && (await c("GET", "/updates?after=0", "atoolong")).status === 401);
    await m.dispose(); }
  // 잘못된 이름(예약어, 형식 오류)은 무시, 토큰 미설정 이름은 접속 불가
  { const { m, c } = await mkReg({ AGENTS: "all,user,Bad Name,ok-1,nosecret", AGENT_TOKEN_ALL: "x", AGENT_TOKEN_USER: "y", AGENT_TOKEN_OK_1: "o1" });
    check("reserved names ignored", (await c("GET", "/updates?after=0", "x")).status === 401 && (await c("GET", "/updates?after=0", "y")).status === 401);
    check("valid name works, unset secret name has no access", (await c("GET", "/updates?after=0", "o1")).status === 200 && (await c("GET", "/updates?after=0", "")).status === 401);
    const r = await c("POST", "/send", "o1", { text: "z", idempotency_key: "n1", target: "all" });
    check("sender label comes from token", r.status === 200);
    await m.dispose(); }
}


// 18) 멱등 키는 (에이전트, 발송 의도)에 묶인다. 충돌은 409이고 다른 쪽 기록을 노출하지 않는다.
{
  const m = new Miniflare({
    modules: true,
    script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
    compatibilityDate: "2026-08-06",
    durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
    fetchMock: mockAgent,
    bindings: { PICKLE_TOKEN: "pk", INSTINCT_TOKEN: "in", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", TEST_MODE: "1", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "7" },
  });
  const c = async (method, path, token, body) => {
    const res = await m.dispatchFetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, data };
  };
  for (const [id, text] of [[11, "q1"], [12, "q2"]])
    await m.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: id, from: { id: 7, is_bot: false }, chat: { id: 555 }, date: 1794000200 + id, text } }) });
  const first = await c("POST", "/send", "pk", { text: "hello", idempotency_key: "k1", target: "instinct", root_user_seq: 1, reply_to: 2 });
  check("idem: first send accepted", first.status === 200 && first.data.ok, JSON.stringify(first));
  const same = await c("POST", "/send", "pk", { text: "hello", idempotency_key: "k1", target: "instinct", root_user_seq: 1, reply_to: 2 });
  check("idem: true same-key retry returns original", same.data.duplicated === true && same.data.seq === first.data.seq && same.data.telegram_status === first.data.telegram_status, JSON.stringify(same));
  const other = await c("POST", "/send", "in", { text: "hello", idempotency_key: "k1", target: "pickle", root_user_seq: 1 });
  check("idem: other sender same key -> 409, no seq/status leak", other.status === 409 && other.data.seq === undefined && other.data.telegram_status === undefined && other.data.duplicated === undefined, JSON.stringify(other));
  for (const [name, patch] of [["text", { text: "other" }], ["target", { target: "all" }], ["root", { root_user_seq: 2 }], ["reply_to", { reply_to: 1 }], ["reply_to dropped", { reply_to: null }]]) {
    const r = await c("POST", "/send", "pk", { text: "hello", idempotency_key: "k1", target: "instinct", root_user_seq: 1, reply_to: 2, ...patch });
    check("idem: same sender, different " + name + " -> 409", r.status === 409 && r.data.seq === undefined, JSON.stringify(r));
  }
  const all = await c("GET", "/updates?after=0", "in");
  check("idem: conflicts wrote nothing", all.data.messages.filter((x) => x.sender === "pickle").length === 1);
  // 빈 값 표현은 같은 의도: target 생략 = all, reply_to 생략 = null
  const a1 = await c("POST", "/send", "pk", { text: "plain", idempotency_key: "k2" });
  const a2 = await c("POST", "/send", "pk", { text: "plain", idempotency_key: "k2", target: "all", reply_to: null });
  check("idem: omitted vs explicit defaults is the same intent", a2.data.duplicated === true && a2.data.seq === a1.data.seq, JSON.stringify(a2));
  // 사용자(웹훅) 행의 키를 에이전트가 쓸 수 없다
  const tgk = await c("POST", "/send", "pk", { text: "q1", idempotency_key: "tg:11" });
  check("idem: agent cannot probe user-row key", tgk.status === 409 && tgk.data.seq === undefined, JSON.stringify(tgk));
  await m.dispose();
}

// 19) 셀프테스트는 일회용 DO에서만 실행된다. 운영 대화록은 절대 건드리지 않는다.
{
  const m = new Miniflare({
    modules: true,
    script: readFileSync(new URL("../cloudflare/src/index.js", import.meta.url), "utf8"),
    compatibilityDate: "2026-08-06",
    durableObjects: { TRANSCRIPT: { className: "Transcript", useSQLite: true } },
    fetchMock: mockAgent,
    bindings: { PICKLE_TOKEN: "pk", INSTINCT_TOKEN: "in", BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "hooksecret", ALLOWED_CHAT_ID: "555", ALLOWED_USER_IDS: "7", SELFTEST: "1" },
  });
  const read = async () => (await (await m.dispatchFetch(base + "/updates?after=0", { headers: { Authorization: "Bearer pk" } })).json()).messages;
  for (const [id, text] of [[21, "prod-a"], [22, "prod-b"]])
    await m.dispatchFetch(base + "/tg/hooksecret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: { message_id: id, from: { id: 7, is_bot: false }, chat: { id: 555 }, date: 1794000300 + id, text } }) });
  const before = JSON.stringify(await read());
  const tgBeforeSt = tgCalls;
  const w = await m.getWorker();
  await w.scheduled({ cron: "* * * * *" });
  const after = JSON.stringify(await read());
  check("selftest: production transcript unchanged by a selftest run", before === after && JSON.parse(before).length === 2, before + " / " + after);
  check("selftest: no Telegram call even without TEST_MODE", tgCalls === tgBeforeSt);
  const ns = await m.getDurableObjectNamespace("TRANSCRIPT");
  const prod = ns.get(ns.idFromName("shared-room"));
  const poke = async (cmd) => (await prod.fetch("https://relay.internal/selftest", { method: "POST", body: JSON.stringify({ cmd }) })).status;
  check("selftest: cleanup refused on the production DO", (await poke("cleanup")) === 403);
  check("selftest: init refused on a non-empty DO", (await poke("init")) === 409);
  check("selftest: still unchanged after direct attempts", JSON.stringify(await read()) === before);
  await m.dispose();
}

function armTgMany(n) { for (let i = 0; i < n; i++) armTg(); }

console.log("\n" + failures.length + " failures");
process.exit(failures.length ? 1 : 0);
