// src/index.js - 공용 방 중계 (Workers + Durable Object)
function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json" } });
}

// 에이전트 등록부. 에이전트 이름 목록은 AGENTS(쉼표 구분, 기본 "pickle,instinct")이고
// 각 이름의 토큰은 비밀값 AGENT_TOKEN_<이름 대문자, '-'는 '_'> 이다.
// 하위 호환: pickle -> PICKLE_TOKEN, instinct -> INSTINCT_TOKEN 도 계속 인식한다.
// 이름 규칙은 소문자로 시작하는 [a-z0-9_-] 최대 32자이며 "all", "user"는 예약어다.
// 규칙에 맞지 않는 이름은 무시한다. 새 에이전트 추가 = AGENTS 갱신 + 비밀값 1개 + 재배포 (코드 수정 없음).
var RESERVED_NAMES = ["all", "user"];
function agentNames(env) {
  var raw = env.AGENTS ? String(env.AGENTS) : "pickle,instinct";
  var out = [];
  raw.split(",").forEach(function (x) {
    var n = x.trim().toLowerCase();
    if (/^[a-z][a-z0-9_-]{0,31}$/.test(n) && RESERVED_NAMES.indexOf(n) === -1 &&
        out.indexOf(n) === -1) out.push(n);
  });
  // "foo-bar"와 "foo_bar"는 같은 비밀값 이름(AGENT_TOKEN_FOO_BAR)을 가리켜 신원이
  // 모호하다. 충돌하는 이름은 모두 제외한다(fail closed): 인증도, 대상 지정도 안 된다.
  var keyOf = function (n) { return n.toUpperCase().replace(/-/g, "_"); };
  return out.filter(function (n) {
    return out.filter(function (o) { return keyOf(o) === keyOf(n); }).length === 1;
  });
}
function agentToken(env, name) {
  var v = env["AGENT_TOKEN_" + name.toUpperCase().replace(/-/g, "_")];
  if (!v && name === "pickle") v = env.PICKLE_TOKEN;
  if (!v && name === "instinct") v = env.INSTINCT_TOKEN;
  return v ? String(v) : "";
}

// Bearer 토큰이 곧 작성자. 본문의 sender 필드는 신뢰하지 않음 (스푸핑 방지).
// 같은 토큰이 두 이름에 설정돼 있으면 신원이 모호하므로 인증하지 않는다(fail closed).
function authenticate(request, env) {
  var h = request.headers.get("Authorization") || "";
  var token = h.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  var hit = agentNames(env).filter(function (n) {
    return agentToken(env, n) === token; });
  return hit.length === 1 ? hit[0] : null;
}

// 방·사용자 허용 목록. 허용 목록이 하나라도 설정되면 TEST_MODE 여부와 무관하게
// 항상 강제한다(둘 다 있어야 통과, fail-closed). 합성 신원은 허용 목록이 아예
// 없고 TEST_MODE=1일 때(실 방 미연결 로컬/모의 시험)에만 허용한다.
function allowlistOk(msg, env) {
  var configured = !!(env.ALLOWED_CHAT_ID || env.ALLOWED_USER_IDS);
  if (!configured && env.TEST_MODE === "1") return true;
  if (!env.ALLOWED_CHAT_ID || !env.ALLOWED_USER_IDS) return false;
  if (String(msg.chat && msg.chat.id) !== String(env.ALLOWED_CHAT_ID))
    return false;
  var ids = String(env.ALLOWED_USER_IDS).split(",").map(function (s) {
    return s.trim(); });
  if (!msg.from || ids.indexOf(String(msg.from.id)) === -1) return false;
  return true;
}

// room: 대화록 DO 이름. 운영은 항상 "shared-room". 셀프테스트는 일회용 별도 이름을
// 쓰므로 운영 대화록과 절대 같은 DO를 건드리지 않는다.
async function relayFetch(request, env, room) {
  {
    var url = new URL(request.url);
    var stub = env.TRANSCRIPT.get(env.TRANSCRIPT.idFromName(room));

    // 1) 텔레그램 웹훅: 사용자 메시지 수신 (비밀 경로 보호)
    if (request.method === "POST" &&
        url.pathname === "/tg/" + env.WEBHOOK_SECRET) {
      var update = await request.json().catch(function () { return null; });
      var msg = update && update.message;
      if (msg && msg.text && msg.from && !msg.from.is_bot &&
          allowlistOk(msg, env)) {
        await stub.fetch("https://relay.internal/ingest", {
          method: "POST",
          body: JSON.stringify({
            text: msg.text, chatId: msg.chat.id,
            tgMessageId: msg.message_id,
            ts: msg.date || Math.floor(Date.now() / 1000) }) });
      }
      return new Response("ok"); // 텔레그램에는 항상 200
    }

    // 2) 에이전트 API
    var agent = authenticate(request, env);
    if (!agent) return json({ ok: false, error: "unauthorized" }, 401);

    if (request.method === "GET" && url.pathname === "/updates") {
      var after = Number(url.searchParams.get("after") || "0");
      return stub.fetch("https://relay.internal/updates?after=" +
        after + "&agent=" + agent);
    }

    if (request.method === "POST" && url.pathname === "/send") {
      var body = await request.json().catch(function () { return null; });
      if (!body || !body.text)
        return json({ ok: false, error: "text_required" }, 400);
      // 멱등 키 필수: 없으면 중복 방지 불가라 거절
      if (!body.idempotency_key)
        return json({ ok: false, error: "idempotency_key_required" }, 400);
      // 에이전트 간 발언은 기준 사용자 메시지 필수 (왕복 제한의 기준)
      var tgt = body.target || "all";
      if (tgt !== "all" && agentNames(env).indexOf(tgt) === -1)
        return json({ ok: false, error: "invalid_target" }, 400);
      if (tgt !== "all" && !body.root_user_seq)
        return json({ ok: false, error: "root_user_seq_required" }, 400);
      return stub.fetch("https://relay.internal/send", {
        method: "POST",
        body: JSON.stringify({
          sender: agent,                 // 인증 토큰으로 결정
          text: String(body.text),
          target: tgt,
          reply_to: body.reply_to || null,
          root_user_seq: body.root_user_seq || null,
          idempotency_key: body.idempotency_key }) });
    }
    return json({ ok: false, error: "not_found" }, 404);
  }
}

var handler = {
  async fetch(request, env) {
    return relayFetch(request, env, "shared-room");
  },

  // 시험 배포 검증용: SELFTEST=1 + cron 트리거가 있을 때만 동작.
  // 실제 배포된 DO를 직접 구동해 결과를 로그로 남긴다.
  async scheduled(event, env, ctx) {
    if (env.SELFTEST !== "1") return;
    ctx.waitUntil(selfTest(env, ctx).then(function (report) {
      console.log("SELFTEST " + JSON.stringify(report));
    }));
  } };
export default handler;

// 대화록 Durable Object: 단일 작성자라 순번 부여와 기록이 원자적으로 처리됨
export class Transcript {
  constructor(state, env) {
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (" +
      "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "sender TEXT NOT NULL, target TEXT NOT NULL DEFAULT 'all', " +
      "text TEXT NOT NULL, reply_to INTEGER, idem_key TEXT UNIQUE, " +
      "tg_message_id INTEGER, send_status TEXT, ts INTEGER NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    // v1 -> v2 스키마: root_user_seq 추가 (이미 있으면 건너뜀)
    var cols = Array.from(this.sql.exec("PRAGMA table_info(messages)"))
      .map(function (c) { return c.name; });
    if (cols.indexOf("root_user_seq") === -1)
      this.sql.exec(
        "ALTER TABLE messages ADD COLUMN root_user_seq INTEGER");
  }

  async fetch(request) {
    var url = new URL(request.url);

    if (url.pathname === "/ingest" && request.method === "POST") {
      var m = await request.json();
      this.sql.exec(
        "INSERT INTO meta(key, value) VALUES('chat_id', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(m.chatId));
      // 웹훅 재전송 대비: tg:<message_id> 키로 중복 기록 방지
      var seq = this.append({ sender: "user", target: "all",
        text: m.text, reply_to: null, root_user_seq: null,
        idem_key: "tg:" + m.tgMessageId,
        tg_message_id: m.tgMessageId, send_status: null, ts: m.ts });
      return json({ ok: true, seq: seq });
    }

    if (url.pathname === "/updates") {
      var after = Number(url.searchParams.get("after") || "0");
      var agent = url.searchParams.get("agent");
      // 자기 발언 제외, all 또는 자신을 대상으로 한 기록 + 사용자 메시지
      var rows = Array.from(this.sql.exec(
        "SELECT seq, sender, target, text, reply_to, root_user_seq, ts " +
        "FROM messages " +
        "WHERE seq > ? AND sender != ? " +
        "AND (target = 'all' OR target = ? OR sender = 'user') " +
        "ORDER BY seq LIMIT 200", after, agent, agent));
      var cursor = rows.length ? rows[rows.length - 1].seq : after;
      // 200건이 꽉 찼으면 뒤에 더 있을 수 있음: 클라이언트는 has_more가
      // false가 될 때까지 cursor를 올려가며 다시 읽는다
      return json({ ok: true, cursor: cursor,
        has_more: rows.length === 200, messages: rows });
    }

    if (url.pathname === "/send" && request.method === "POST") {
      var b = await request.json();
      if (!b.idempotency_key)
        return json({ ok: false, error: "idempotency_key_required" }, 400);
      // 멱등 키 확인이 왕복 제한보다 먼저: 완료된 전송의 같은-키 재시도는
      // 제한 계산과 무관하게 기존 결과를 그대로 돌려준다.
      var dup = Array.from(this.sql.exec(
        "SELECT seq, send_status, sender, target, text, reply_to, " +
        "root_user_seq FROM messages WHERE idem_key = ?",
        b.idempotency_key));
      if (dup.length) {
        var d0 = dup[0];
        // 키는 (보낸 에이전트, 발송 의도)에 묶인다. 다른 에이전트가 같은 키를 쓰면
        // 기존 기록의 seq/status를 알려주지 않고 충돌로만 답한다.
        if (d0.sender !== b.sender)
          return json({ ok: false, error: "idempotency_key_conflict" }, 409);
        // 같은 에이전트라도 내용, 대상, root, reply_to 중 하나라도 다르면 같은 의도의
        // 재시도가 아니다. 저장된 기록의 필드와 그대로 비교한다(기존 행도 같은 열을 가짐).
        // 빈 값 표현(null/undefined/0)은 null로 맞춰 비교한다.
        var nz = function (v) { return v === null || v === undefined ||
          v === "" || Number(v) === 0 ? null : Number(v); };
        if (String(d0.text) !== String(b.text) ||
            String(d0.target || "all") !== String(b.target || "all") ||
            nz(d0.reply_to) !== nz(b.reply_to) ||
            nz(d0.root_user_seq) !== nz(b.root_user_seq))
          return json({ ok: false, error: "idempotency_key_reused_with_" +
            "different_request" }, 409);
        // 진짜 같은 재시도: 재전송 없이 기존 결과 반환
        return json({ ok: true, seq: d0.seq,
          duplicated: true, telegram_status: d0.send_status });
      }
      // 선택적 응답 정책(MIN_ROOT_USER_SEQ 또는 MAX_REPLIES_PER_USER_MSG 설정 시):
      // 모든 발신은 사용자 메시지(root)에 대한 답이어야 하고(먼저 말 걸기 금지),
      // 활성화 이전 메시지에는 답할 수 없으며, 에이전트별로 사용자 메시지 1건당
      // 대상과 무관하게 MAX_REPLIES_PER_USER_MSG(기본 1)회까지만 보낼 수 있다.
      if (this.env.MIN_ROOT_USER_SEQ || this.env.MAX_REPLIES_PER_USER_MSG) {
        if (!b.root_user_seq)
          return json({ ok: false, error: "root_user_seq_required" }, 400);
        var proot = Array.from(this.sql.exec(
          "SELECT sender FROM messages WHERE seq = ?", b.root_user_seq));
        if (!proot.length || proot[0].sender !== "user")
          return json({ ok: false, error: "invalid_root_user_seq" }, 400);
        if (Number(b.root_user_seq) < Number(this.env.MIN_ROOT_USER_SEQ || 0))
          return json({ ok: false, error: "root_before_activation" }, 400);
        // "unlimited" 로 설정하면 횟수 제한만 끈다(root 연결·allowlist는 그대로).
        var unlimP = String(this.env.MAX_REPLIES_PER_USER_MSG || "")
          .toLowerCase() === "unlimited";
        var maxP = unlimP ? Infinity
          : Number(this.env.MAX_REPLIES_PER_USER_MSG || 1);
        // 선택적 예외: EXTRA_REPLIES="sender:rootSeq[:추가횟수],..." 에 적힌
        // (발신자, 질문) 쌍에만 답변을 추가 허용한다(횟수 생략 시 1). 다른 쌍은 영향 없음.
        // EXTRA_REPLIES_UNTIL(유닉스 초)이 지나면 예외는 자동으로 무효가 된다.
        var untilSec = Number(this.env.EXTRA_REPLIES_UNTIL || 0);
        if (!untilSec || Date.now() / 1000 < untilSec) {
          var pairPfx = b.sender + ":" + b.root_user_seq;
          String(this.env.EXTRA_REPLIES || "").split(",").forEach(function (x) {
            var parts = x.trim().split(":");
            if (parts.length >= 2 && parts[0] + ":" + parts[1] === pairPfx) {
              var n = parts.length > 2 ? Number(parts[2]) : 1;
              if (n > 0 && n <= 20) maxP += Math.floor(n);
            }
          });
        }
        var usedP = Array.from(this.sql.exec(
          "SELECT COUNT(*) AS c FROM messages " +
          "WHERE root_user_seq = ? AND sender = ?",
          b.root_user_seq, b.sender))[0].c;
        if (usedP >= maxP)
          return json({ ok: false, error: "reply_limit_exceeded",
            root_user_seq: b.root_user_seq }, 429);
      }
      if (b.target && b.target !== "all") {   // 에이전트 대상 발언
        if (!b.root_user_seq)
          return json({ ok: false, error: "root_user_seq_required" }, 400);
        var root = Array.from(this.sql.exec(
          "SELECT sender FROM messages WHERE seq = ?", b.root_user_seq));
        if (!root.length || root[0].sender !== "user")
          return json({ ok: false, error: "invalid_root_user_seq" }, 400);
        // 서버 강제 왕복 제한: 에이전트 간 발언은 사용자 질문 1건당
        // 에이전트별 MAX_ROUNDS_PER_USER_MSG(기본 1)회까지
        var maxR = String(this.env.MAX_ROUNDS_PER_USER_MSG || "")
          .toLowerCase() === "unlimited" ? Infinity
          : Number(this.env.MAX_ROUNDS_PER_USER_MSG || 1);
        var used = Array.from(this.sql.exec(
          "SELECT COUNT(*) AS c FROM messages " +
          "WHERE root_user_seq = ? AND sender = ? " +
          "AND target != 'all'",
          b.root_user_seq, b.sender))[0].c;
        if (used >= maxR)
          return json({ ok: false, error: "round_limit_exceeded",
            root_user_seq: b.root_user_seq }, 429);
      }
      var seq2 = this.append({ sender: b.sender, target: b.target,
        text: b.text, reply_to: b.reply_to,
        root_user_seq: b.root_user_seq,
        idem_key: b.idempotency_key, tg_message_id: null,
        send_status: "pending", ts: Math.floor(Date.now() / 1000) });
      var status = await this.sendToTelegram(seq2, b);
      return json({ ok: true, seq: seq2, telegram_status: status });
    }

    // 내부 전용 (워커의 scheduled 셀프테스트만 stub으로 호출; 공개 라우트 없음)
    if (url.pathname === "/selftest" && request.method === "POST") {
      var c = await request.json();
      var isSt = Array.from(this.sql.exec(
        "SELECT value FROM meta WHERE key = 'selftest'")).length > 0;
      // init은 비어 있는 DO에만 허용한다. 운영 대화록(메시지 있음)은 시험용으로
      // 표시될 수 없고, 표시되지 않은 DO에서는 fill/cleanup이 모두 거부된다.
      if (c.cmd === "init") {
        var cnt = Array.from(this.sql.exec(
          "SELECT COUNT(*) AS c FROM messages"))[0].c;
        if (cnt > 0 && !isSt)
          return json({ ok: false, error: "selftest_refused_nonempty" }, 409);
        this.sql.exec("INSERT OR REPLACE INTO meta(key, value) " +
          "VALUES('selftest', '1')");
        return json({ ok: true });
      }
      if (!isSt)
        return json({ ok: false, error: "selftest_not_enabled" }, 403);
      if (c.cmd === "fill") {
        for (var i = 0; i < (c.n || 0); i++)
          this.append({ sender: c.sender || "user", target: "all",
            text: "selftest-fill-" + i, reply_to: null, root_user_seq: null,
            idem_key: "st-fill-" + i, tg_message_id: null,
            send_status: "selftest", ts: Math.floor(Date.now() / 1000) });
        return json({ ok: true });
      }
      if (c.cmd === "cleanup") {
        this.sql.exec("DELETE FROM messages");
        this.sql.exec("DELETE FROM meta WHERE key != 'selftest'");
        return json({ ok: true });
      }
      return json({ ok: false, error: "unknown_cmd" }, 400);
    }
    return json({ ok: false, error: "not_found" }, 404);
  }

  append(m) {
    if (m.idem_key) {
      var existing = Array.from(this.sql.exec(
        "SELECT seq FROM messages WHERE idem_key = ?", m.idem_key));
      if (existing.length) return existing[0].seq;
    }
    this.sql.exec(
      "INSERT INTO messages(sender, target, text, reply_to, idem_key," +
      " tg_message_id, send_status, ts, root_user_seq) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
      m.sender, m.target, m.text, m.reply_to, m.idem_key,
      m.tg_message_id, m.send_status, m.ts, m.root_user_seq);
    // 단일 실행 흐름이므로 직후 조회가 안전
    return Array.from(
      this.sql.exec("SELECT last_insert_rowid() AS seq"))[0].seq;
  }

  async sendToTelegram(seq, b) {
    // 시험 모드: 실제 텔레그램 전송을 구조적으로 차단한다.
    // BOT_TOKEN이 나중에 실제 값으로 바뀌어도 TEST_MODE=1인 동안은 못 보냄.
    var stRoom = Array.from(this.sql.exec(
      "SELECT value FROM meta WHERE key = 'selftest'")).length > 0;
    if (this.env.TEST_MODE === "1" || stRoom) {
      this.sql.exec(
        "UPDATE messages SET send_status='blocked:test_mode' WHERE seq=?",
        seq);
      return "blocked:test_mode";
    }
    // 허용 방이 설정되어 있으면 저장된 chat_id가 아니라 항상 그 방으로만 보낸다.
    var chat = this.env.ALLOWED_CHAT_ID
      ? [{ value: String(this.env.ALLOWED_CHAT_ID) }]
      : Array.from(this.sql.exec(
        "SELECT value FROM meta WHERE key = 'chat_id'"));
    if (!chat.length) {
      this.sql.exec(
        "UPDATE messages SET send_status='failed:no_chat_id' WHERE seq=?",
        seq);
      return "failed:no_chat_id"; // 사용자 메시지가 먼저 와야 chat_id 확인
    }
    var payload = { chat_id: chat[0].value, text: b.text };
    if (b.reply_to) {
      var ref = Array.from(this.sql.exec(
        "SELECT tg_message_id FROM messages WHERE seq = ?", b.reply_to));
      if (ref.length && ref[0].tg_message_id)
        payload.reply_to_message_id = ref[0].tg_message_id;
    }
    try {
      var r = await fetch(
        "https://api.telegram.org/bot" + this.env.BOT_TOKEN + "/sendMessage",
        { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Number(this.env.TG_TIMEOUT_MS || 10000)) });
      var data = await r.json();
      if (data.ok) {
        this.sql.exec(
          "UPDATE messages SET send_status='sent', tg_message_id=?" +
          " WHERE seq=?", data.result.message_id, seq);
        return "sent";
      }
      // 텔레그램이 명시적으로 거절한 경우만 안전하게 재시도 가능
      this.sql.exec("UPDATE messages SET send_status=? WHERE seq=?",
        "failed:" + data.error_code, seq);
      return "failed:" + data.description;
    } catch (e) {
      // 타임아웃 등 결과 불명: 봇은 자기 메시지를 다시 읽을 수 없어
      // 도달 확인 불가. 자동 재전송하면 중복 가능 -> '미확인'으로 남김
      this.sql.exec(
        "UPDATE messages SET send_status='unconfirmed' WHERE seq=?", seq);
      return "unconfirmed";
    }
  }
}

// 배포된 DO를 직접 구동하는 셀프테스트 (SELFTEST=1 일 때 cron이 실행)
async function selfTest(env, ctx) {
  // 운영 DO("shared-room")와 분리된 일회용 DO에서만 실행한다.
  var room = "selftest-" + Date.now() + "-" +
    Math.random().toString(36).slice(2, 10);
  var stub = env.TRANSCRIPT.get(env.TRANSCRIPT.idFromName(room));
  // 합성 신원은 일회용 방에서만: 이 env 사본은 이 함수 안에서만 쓰인다.
  var stEnv = Object.assign({}, env, { TEST_MODE: "1",
    ALLOWED_CHAT_ID: "", ALLOWED_USER_IDS: "" });
  var R = [];
  function t(name, cond, detail) {
    R.push({ name: name, pass: !!cond, detail: detail || null }); }
  function dc(path, body) {  // DO 내부 호출
    return stub.fetch("https://relay.internal" + path,
      { method: "POST", body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); }); }
  function http(method, path, token, body) {  // 워커 공개 라우트 경유 호출
    return relayFetch(new Request("https://relay.test" + path, {
      method: method,
      headers: { "content-type": "application/json",
        "Authorization": token ? "Bearer " + token : "" },
      body: body ? JSON.stringify(body) : undefined }), stEnv, room)
      .then(async function (r) {
        var d = null; try { d = await r.json(); } catch (e) {}
        return { status: r.status, data: d }; });
  }

  var init = await dc("/selftest", { cmd: "init" });
  if (!init.ok) return { total: 0, failed: 1, failed_names: ["init_refused"],
    results: [] };

  var r = await http("GET", "/updates?after=0", null);
  t("auth_no_token_401", r.status === 401);
  r = await http("GET", "/updates?after=0", "wrong");
  t("auth_wrong_token_401", r.status === 401);
  r = await http("GET", "/updates?after=0", env.INSTINCT_TOKEN);
  t("auth_ok_200_empty", r.status === 200 && r.data.ok &&
    r.data.messages.length === 0);

  r = await http("POST", "/send", env.INSTINCT_TOKEN,
    { text: "st-1", idempotency_key: "st-1" });
  t("send_blocked_in_test_mode", r.status === 200 &&
    r.data.telegram_status === "blocked:test_mode", JSON.stringify(r.data));
  var s1 = r.data.seq;
  r = await http("POST", "/send", env.INSTINCT_TOKEN,
    { text: "st-1", idempotency_key: "st-1" });
  t("send_dup_same_seq", r.data.duplicated === true && r.data.seq === s1);
  r = await http("POST", "/send", env.INSTINCT_TOKEN, { text: "x" });
  t("send_missing_key_400", r.status === 400 &&
    r.data.error === "idempotency_key_required");

  var hook = "/tg/" + env.WEBHOOK_SECRET;
  await http("POST", hook, null, { message: { message_id: 900001,
    from: { id: 777, is_bot: false }, chat: { id: 555 },
    date: 1762600000, text: "user-q" } });
  await http("POST", hook, null, { message: { message_id: 900001,
    from: { id: 777, is_bot: false }, chat: { id: 555 },
    date: 1762600000, text: "user-q" } });
  r = await http("GET", "/updates?after=0", env.PICKLE_TOKEN);
  var userMsgs = r.data.messages.filter(function (m) {
    return m.text === "user-q"; });
  t("webhook_recorded_once", userMsgs.length === 1);
  var sUser = userMsgs.length ? userMsgs[0].seq : null;

  // 허용 목록: 다른 방/다른 사용자는 기록되지 않아야 함
  await http("POST", hook, null, { message: { message_id: 900002,
    from: { id: 777, is_bot: false }, chat: { id: 999 },
    date: 1762600001, text: "wrong-chat" } });
  await http("POST", hook, null, { message: { message_id: 900003,
    from: { id: 888, is_bot: false }, chat: { id: 555 },
    date: 1762600002, text: "wrong-user" } });
  r = await http("GET", "/updates?after=0", env.PICKLE_TOKEN);
  var txts = r.data.messages.map(function (m) { return m.text; });
  // TEST_MODE=1에서는 합성 신원이 의도적으로 허용된다 (라이브 모드의
  // fail-closed 허용 목록 차단은 로컬 런타임 테스트 13번이 검증)
  t("testmode_synthetic_chat_allowed", txts.indexOf("wrong-chat") !== -1,
    JSON.stringify(txts));
  t("testmode_synthetic_user_allowed", txts.indexOf("wrong-user") !== -1);

  // 왕복 제한: 에이전트 간 발언은 사용자 질문 1건당 에이전트별 1회
  r = await http("POST", "/send", env.PICKLE_TOKEN, { text: "p2i",
    target: "instinct", root_user_seq: sUser, idempotency_key: "st-2" });
  t("round_first_ok", r.status === 200, JSON.stringify(r.data));
  r = await http("POST", "/send", env.PICKLE_TOKEN, { text: "p2i-again",
    target: "instinct", root_user_seq: sUser, idempotency_key: "st-3" });
  t("round_limit_429", r.status === 429 &&
    r.data.error === "round_limit_exceeded", JSON.stringify(r.data));
  // 소진된 왕복의 같은-키 재시도는 429가 아니라 duplicated + 저장된 상태
  r = await http("POST", "/send", env.PICKLE_TOKEN, { text: "p2i",
    target: "instinct", root_user_seq: sUser, idempotency_key: "st-2" });
  t("round_retry_same_key_duplicated", r.status === 200 &&
    r.data.duplicated === true &&
    r.data.telegram_status === "blocked:test_mode", JSON.stringify(r.data));
  r = await http("POST", "/send", env.INSTINCT_TOKEN, { text: "i2p",
    target: "pickle", root_user_seq: sUser, idempotency_key: "st-4" });
  t("round_other_agent_ok", r.status === 200);
  r = await http("POST", "/send", env.PICKLE_TOKEN, { text: "x",
    target: "instinct", idempotency_key: "st-5" });
  t("round_missing_root_400", r.status === 400 &&
    r.data.error === "root_user_seq_required");
  r = await http("POST", "/send", env.PICKLE_TOKEN, { text: "x",
    target: "instinct", root_user_seq: 999999, idempotency_key: "st-6" });
  t("round_bad_root_400", r.status === 400 &&
    r.data.error === "invalid_root_user_seq");

  // 에코/타겟 필터
  r = await http("GET", "/updates?after=0", env.PICKLE_TOKEN);
  t("echo_own_hidden", r.data.messages.every(function (m) {
    return m.sender !== "pickle"; }));
  t("target_hidden_from_nontarget", r.data.messages.every(function (m) {
    return m.text !== "p2i"; })); // pickle은 target=instinct 발언을 못 봄
  r = await http("GET", "/updates?after=0", env.INSTINCT_TOKEN);
  t("target_seen_by_instinct", r.data.messages.some(function (m) {
    return m.text === "p2i"; }));
  t("echo_instinct_own_hidden", r.data.messages.every(function (m) {
    return m.sender !== "instinct"; }));

  // 페이지네이션: 205건 채운 뒤 200 + 나머지
  await dc("/selftest", { cmd: "fill", n: 205, sender: "user" });
  r = await http("GET", "/updates?after=0", env.PICKLE_TOKEN);
  var page1 = r.data;
  t("page1_200_has_more", page1.messages.length === 200 &&
    page1.has_more === true, "len=" + page1.messages.length);
  r = await http("GET", "/updates?after=" + page1.cursor,
    env.PICKLE_TOKEN);
  t("page2_rest_no_more", r.data.messages.length > 0 &&
    r.data.has_more === false &&
    r.data.messages[0].seq > page1.cursor);
  r = await http("GET", "/updates?after=999999", env.PICKLE_TOKEN);
  t("cursor_stays_when_empty", r.data.cursor === 999999 &&
    r.data.messages.length === 0);

  // 공개 URL 자기 호출 (최선 노력: 외부 인그레스+인증 경로 확인)
  // 배포한 자신의 워커 주소를 SELFTEST_ORIGIN 변수로 지정했을 때만 실행한다.
  if (env.SELFTEST_ORIGIN) {
    try {
      var pr = await fetch(
        env.SELFTEST_ORIGIN.replace(/\/$/, "") + "/updates?after=0",
        { headers: { Authorization: "Bearer " + env.INSTINCT_TOKEN } });
      t("public_url_auth_get", pr.status === 200, "status=" + pr.status);
    } catch (e) {
      t("public_url_auth_get", false, String(e));
    }
  }

  await dc("/selftest", { cmd: "cleanup" });
  r = await http("GET", "/updates?after=0", env.PICKLE_TOKEN);
  t("cleanup_empty", r.data.messages.length === 0);

  var failed = R.filter(function (x) { return !x.pass; });
  return { total: R.length, failed: failed.length,
    failed_names: failed.map(function (x) { return x.name; }),
    results: R };
}
