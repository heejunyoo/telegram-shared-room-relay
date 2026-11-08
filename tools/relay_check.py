#!/usr/bin/env python3
# relay_check.py - 피클 측 중계 클라이언트 검증 도구 (표준 라이브러리만 사용)
#
# 목적: 실제 텔레그램 연결 없이(오프라인) 피클의 중계 클라이언트가 규약을
#       올바르게 구현했는지 검증한다. 실제 비밀 값은 전혀 포함되어 있지 않다.
#
# 사용:
#   python3 relay_check.py            # 목(mock) 중계 서버를 띄워 참조 클라이언트로 전 항목 검증
#   python3 relay_check.py --serve    # 목 서버만 띄움. 피클이 직접 만든 클라이언트를 붙일 때
#   python3 relay_check.py --live URL # 배포된 중계에 읽기 전용 안전 점검 (토큰은 환경 변수로)
#
# 환경 가정: Python 3.8+ 만 있으면 됨. 실행 위치(맥미니 등)나 네트워크는 가정하지 않음.
import json, os, sqlite3, sys, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib import request as urlreq
from urllib.error import HTTPError

# 시험 전용 값. 실제 자격 증명이 아니며 실제 서버에서는 동작하지 않는다.
TEST_TOKENS = {"pk-test-token": "pickle", "in-test-token": "instinct"}
TEST_ADMIN = "relay-test-admin"


# ---------------------------------------------------------------- 목 서버
class MockRelay:
    """배포된 Workers 중계와 같은 규약을 로컬에서 제공하는 시험용 서버.

    실제 서버와의 차이(시험 편의용 추가분):
      - POST /test/inject : 사용자 메시지를 흉내 내어 대화록에 넣는다 (시험 전용).
      - 환경 변수 RELAY_MOCK_PAGE 로 페이지 크기 조정 가능 (기본 200, 실제 서버 고정값).
      - 텔레그램 전송은 항상 성공한 것으로 처리. 본문이 [unconfirmed] 로 시작하면
        결과 불명(unconfirmed)을 흉내 낸다.
    """

    def __init__(self):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.db.execute(
                "CREATE TABLE messages ("
                "seq INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, "
                "target TEXT NOT NULL DEFAULT 'all', text TEXT NOT NULL, "
                "reply_to INTEGER, root_user_seq INTEGER, idem_key TEXT UNIQUE, "
                "tg_message_id INTEGER, send_status TEXT, ts INTEGER NOT NULL)")
        self.page = int(os.environ.get("RELAY_MOCK_PAGE", "200"))
        self.max_rounds = int(os.environ.get("RELAY_MOCK_MAX_ROUNDS", "1"))
        self.tg_counter = 0

    def append(self, sender, target, text, reply_to, root_user_seq,
               idem_key, tg_message_id, send_status):
        with self.lock:
            if idem_key:
                row = self.db.execute(
                    "SELECT seq FROM messages WHERE idem_key=?",
                    (idem_key,)).fetchone()
                if row:
                    return row[0]
            cur = self.db.execute(
                "INSERT INTO messages(sender,target,text,reply_to,"
                "root_user_seq,idem_key,tg_message_id,send_status,ts) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (sender, target, text, reply_to, root_user_seq, idem_key,
                 tg_message_id, send_status, int(time.time())))
            return cur.lastrowid

    def handle(self, method, path, query, headers, body):
        if path == "/test/inject" and method == "POST":
            if headers.get("x-test-admin") != TEST_ADMIN:
                return 401, {"ok": False, "error": "unauthorized"}
            self.tg_counter += 1
            seq = self.append("user", "all", str(body.get("text", "")),
                              None, None, "tg:%d" % self.tg_counter,
                              self.tg_counter, None)
            return 200, {"ok": True, "seq": seq}

        token = (headers.get("authorization") or "").replace("Bearer", "").strip()
        agent = TEST_TOKENS.get(token)
        if not agent:
            return 401, {"ok": False, "error": "unauthorized"}

        if path == "/updates" and method == "GET":
            after = int(query.get("after", "0"))
            with self.lock:
                rows = self.db.execute(
                    "SELECT seq,sender,target,text,reply_to,root_user_seq,ts "
                    "FROM messages WHERE seq>? AND sender!=? "
                    "AND (target='all' OR target=? OR sender='user') "
                    "ORDER BY seq LIMIT ?", (after, agent, agent,
                                             self.page)).fetchall()
            msgs = [dict(zip(("seq", "sender", "target", "text", "reply_to",
                              "root_user_seq", "ts"), r)) for r in rows]
            cursor = msgs[-1]["seq"] if msgs else after
            return 200, {"ok": True, "cursor": cursor,
                         "has_more": len(msgs) == self.page, "messages": msgs}

        if path == "/send" and method == "POST":
            if not body.get("text"):
                return 400, {"ok": False, "error": "text_required"}
            if not body.get("idempotency_key"):
                return 400, {"ok": False, "error": "idempotency_key_required"}
            # 멱등 키 확인이 왕복 제한보다 먼저: 완료된 전송의 같은-키 재시도는
            # 제한 계산과 무관하게 기존 결과를 그대로 돌려준다 (배포본과 동일 순서).
            with self.lock:
                dup = self.db.execute(
                    "SELECT seq, send_status FROM messages WHERE idem_key=?",
                    (body["idempotency_key"],)).fetchone()
            if dup:
                return 200, {"ok": True, "seq": dup[0], "duplicated": True,
                             "telegram_status": dup[1]}
            target = body.get("target") or "all"
            root = body.get("root_user_seq")
            if target in ("pickle", "instinct"):
                if not root:
                    return 400, {"ok": False,
                                 "error": "root_user_seq_required"}
                with self.lock:
                    row = self.db.execute(
                        "SELECT sender FROM messages WHERE seq=?",
                        (root,)).fetchone()
                if not row or row[0] != "user":
                    return 400, {"ok": False, "error": "invalid_root_user_seq"}
                with self.lock:
                    used = self.db.execute(
                        "SELECT COUNT(*) FROM messages WHERE root_user_seq=? "
                        "AND sender=? AND target IN ('pickle','instinct')",
                        (root, agent)).fetchone()[0]
                if used >= self.max_rounds:
                    return 429, {"ok": False, "error": "round_limit_exceeded",
                                 "root_user_seq": root}
            seq = self.append(agent, target, str(body["text"]),
                              body.get("reply_to"), root,
                              body["idempotency_key"], None, "pending")
            # 목 텔레그램: [unconfirmed] 로 시작하면 결과 불명,
            # [fail] 로 시작하면 명시적 거절을 시뮬레이션한다.
            if str(body["text"]).startswith("[unconfirmed]"):
                status = "unconfirmed"
            elif str(body["text"]).startswith("[fail]"):
                status = "failed:simulated"
            else:
                self.tg_counter += 1
                status = "ok:%d" % self.tg_counter
            with self.lock:
                self.db.execute(
                    "UPDATE messages SET send_status=? WHERE seq=?",
                    (status, seq))
            return 200, {"ok": True, "seq": seq, "telegram_status": status}

        return 404, {"ok": False, "error": "not_found"}

    def count_text(self, text):
        with self.lock:
            return self.db.execute(
                "SELECT COUNT(*) FROM messages WHERE text=?",
                (text,)).fetchone()[0]


def make_handler(relay):
    class Handler(BaseHTTPRequestHandler):
        def _run(self, method):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                body = {}
            path, _, qs = self.path.partition("?")
            query = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
            status, payload = relay.handle(
                method, path, query,
                {k.lower(): v for k, v in self.headers.items()}, body)
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._run("GET")

        def do_POST(self):
            self._run("POST")

        def log_message(self, *args):
            pass

    return Handler


# ------------------------------------------------------------- 참조 클라이언트
class RelayClient:
    """규약을 구현한 참조 클라이언트. 피클은 이 클래스를 그대로 쓰거나,
    같은 동작을 자체 구현으로 맞추면 된다.

    규약 요지:
      - 커서는 메시지 처리(저장)를 마친 뒤에만 올리고, 재시작 시 저장된
        커서부터 다시 읽는다.
      - 쓰기에는 항상 idempotency_key 를 넣고, 재시도에는 같은 키를 쓴다.
      - 응답이 unconfirmed 이면 같은 키로 다시 보내 상태만 확인한다
        (서버는 duplicated 로 기존 결과를 돌려준다). 새 키 재전송 금지.
    """

    def __init__(self, base_url, token, state_path):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.state_path = state_path
        self.cursor = 0
        if os.path.exists(state_path):
            with open(state_path) as f:
                self.cursor = json.load(f).get("cursor", 0)

    def _save_cursor(self):
        with open(self.state_path, "w") as f:
            json.dump({"cursor": self.cursor}, f)

    def _call(self, method, path, body=None):
        req = urlreq.Request(self.base_url + path, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("User-Agent", "relay-check/1.0")
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req.add_header("content-type", "application/json")
        try:
            with urlreq.urlopen(req, data=data, timeout=15) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"ok": False,
                                "error": "http_%d" % e.code,
                                "body": raw[:200]}

    def poll(self, handler):
        """새 메시지를 모두 처리할 때까지 읽는다. 각 메시지는 handler(msg)
        가 정상 반환된 뒤에만 커서를 올린다. 처리 건수를 반환."""
        done = 0
        while True:
            status, res = self._call("GET", "/updates?after=%d" % self.cursor)
            if status != 200 or not res.get("ok"):
                raise RuntimeError("updates failed: %s %s" % (status, res))
            for msg in res["messages"]:
                handler(msg)                      # 처리(저장)가 먼저
                self.cursor = msg["seq"]          # 그 다음에만 커서 전진
                self._save_cursor()
                done += 1
            if not res.get("has_more"):
                return done

    def send(self, text, target="all", reply_to=None, root_user_seq=None,
             idempotency_key=None):
        """한 번 보낸다. 응답이 unconfirmed 이면 같은 멱등 키로 한 번 더
        물어 최종 상태를 확인한다. 반환: 서버 응답 dict."""
        key = idempotency_key or "pk-%s" % uuid.uuid4()
        body = {"text": text, "target": target, "reply_to": reply_to,
                "root_user_seq": root_user_seq, "idempotency_key": key}
        status, res = self._call("POST", "/send", body)
        if status == 200 and res.get("telegram_status") == "unconfirmed":
            time.sleep(0.2)          # 같은 키로 상태만 다시 확인
            status, res = self._call("POST", "/send", body)
        return res


# ------------------------------------------------------------------ 검증
class Failure(Exception):
    pass


def check(name, cond, detail=""):
    if cond:
        print("  통과: " + name)
    else:
        raise Failure("%s 실패 %s" % (name, detail))


def run_verification(base_url):
    import tempfile
    tmp = tempfile.mkdtemp(prefix="relay-check-")
    pk = RelayClient(base_url, "pk-test-token", os.path.join(tmp, "pk.json"))
    ik = RelayClient(base_url, "in-test-token", os.path.join(tmp, "in.json"))
    got = {"pickle": [], "instinct": []}

    def inject(text):
        req = urlreq.Request(base_url + "/test/inject", method="POST",
                             data=json.dumps({"text": text}).encode())
        req.add_header("content-type", "application/json")
        req.add_header("X-Test-Admin", TEST_ADMIN)
        with urlreq.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode())["seq"]

    print("검증 시작 (대상: %s)" % base_url)

    # 인증
    bad = RelayClient(base_url, "no-such-token", os.path.join(tmp, "x.json"))
    try:
        bad.poll(lambda m: None)
        raise Failure("인증 없이 읽기 성공")
    except RuntimeError as e:
        check("토큰 없음/오류 시 읽기 거부(401)", "401" in str(e), str(e))
    s, r = bad._call("POST", "/send", {"text": "x", "idempotency_key": "k0"})
    check("토큰 오류 시 쓰기 거부(401)", s == 401, str(r))

    # 요청 검증
    s, r = pk._call("POST", "/send", {"idempotency_key": "k1"})
    check("본문 text 없음 거절(400)", s == 400 and r["error"] == "text_required", str(r))
    s, r = pk._call("POST", "/send", {"text": "x"})
    check("멱등 키 없음 거절(400)", s == 400 and r["error"] == "idempotency_key_required", str(r))
    s, r = pk._call("POST", "/send", {"text": "x", "target": "instinct",
                                      "idempotency_key": "k2"})
    check("에이전트 간 발언에 기준 메시지 없음 거절(400)",
          s == 400 and r["error"] == "root_user_seq_required", str(r))

    # 사용자 메시지 수신/가시성
    root = inject("사용자 질문 1")
    pk.poll(lambda m: got["pickle"].append(m))
    ik.poll(lambda m: got["instinct"].append(m))
    check("사용자 메시지가 양쪽에 전달", any(m["text"] == "사용자 질문 1"
          for m in got["pickle"]) and any(m["text"] == "사용자 질문 1"
          for m in got["instinct"]))

    # 멱등성
    r1 = pk.send("같은 말", idempotency_key="dup-key-1")
    r2 = pk.send("같은 말", idempotency_key="dup-key-1")
    check("같은 멱등 키 재시도는 duplicated", r2.get("duplicated") is True
          and r1["seq"] == r2["seq"], str(r2))

    # target 가시성과 자기 발언 제외
    r = pk.send("피클만의 전체 발언", target="all")
    got["pickle"].clear(); got["instinct"].clear()
    pk.poll(lambda m: got["pickle"].append(m))
    ik.poll(lambda m: got["instinct"].append(m))
    check("자기 발언은 자기 목록에서 제외", not any(
        m["text"] == "피클만의 전체 발언" for m in got["pickle"]))
    check("all 발언은 상대에게 보임", any(
        m["text"] == "피클만의 전체 발언" for m in got["instinct"]))
    pk.send("인스팅트에게만", target="instinct", root_user_seq=root)
    got["pickle"].clear(); got["instinct"].clear()
    pk.poll(lambda m: got["pickle"].append(m))
    ik.poll(lambda m: got["instinct"].append(m))
    check("target 발언은 대상에게만 표시", any(
        m["text"] == "인스팅트에게만" for m in got["instinct"]) and not any(
        m["text"] == "인스팅트에게만" for m in got["pickle"]))

    # 잘못된 기준 메시지
    s, r = pk._call("POST", "/send", {"text": "x", "target": "instinct",
                                      "root_user_seq": 99999,
                                      "idempotency_key": "k3"})
    check("없는 기준 메시지 거절(400)",
          s == 400 and r["error"] == "invalid_root_user_seq", str(r))

    # 왕복 제한 (기본 1회)
    r1 = pk.send("답변 1", target="instinct", root_user_seq=root)
    s, r2 = pk._call("POST", "/send", {"text": "답변 2", "target": "instinct",
                                       "root_user_seq": root,
                                       "idempotency_key": "k4"})
    check("질문당 왕복 제한 초과 시 429",
          s == 429 and r2["error"] == "round_limit_exceeded", str(r2))

    # 왕복 제한과 멱등성의 순서: 성공한 에이전트 간 발언의 같은-키 재시도는
    # 429가 아니라 duplicated로 기존 결과를 돌려줘야 한다
    root2 = inject("사용자 질문 2")
    r1 = pk.send("첫 답변", target="instinct", root_user_seq=root2,
                 idempotency_key="cross-1")
    s, r2 = pk._call("POST", "/send", {"text": "첫 답변", "target": "instinct",
                                       "root_user_seq": root2,
                                       "idempotency_key": "cross-1"})
    check("성공한 왕복 발언의 같은 키 재시도는 duplicated (429 아님)",
          s == 200 and r2.get("duplicated") is True and r2["seq"] == r1["seq"],
          str(r2))

    # 명시적 거절(failed)은 최종 상태: 재시도 없이 끝내고,
    # 같은 키로 물으면 저장된 상태를 돌려준다
    r = pk.send("[fail] 명시적 거절 시뮬레이션", idempotency_key="k6")
    check("failed 응답은 재시도 없이 최종 처리",
          r.get("telegram_status") == "failed:simulated" and
          r.get("duplicated") is not True, str(r))
    s, r = pk._call("POST", "/send", {"text": "[fail] 명시적 거절 시뮬레이션",
                                      "idempotency_key": "k6"})
    check("failed 발언의 같은 키 조회는 duplicated + 저장 상태",
          r.get("duplicated") is True and
          r.get("telegram_status") == "failed:simulated", str(r))

    # 결과 불명 처리: 같은 키로 다시 물으면 중복 없이 상태 확인
    r = pk.send("[unconfirmed] 타임아웃 시뮬레이션", idempotency_key="k5")
    check("unconfirmed 재확인은 duplicated 로 상태 반환",
          r.get("duplicated") is True and
          r.get("telegram_status") == "unconfirmed", str(r))

    # 페이지네이션과 재시작 복구
    for i in range(7):
        inject("연속 %d" % i)
    seen = []
    pk.poll(lambda m: seen.append(m["seq"]))
    check("has_more 페이지를 끝까지 읽음", len(seen) >= 7, str(seen))
    pk2 = RelayClient(base_url, "pk-test-token", pk.state_path)  # 재시작 흉내
    again = []
    pk2.poll(lambda m: again.append(m))
    check("재시작 후 저장 커서부터 재개(재수신 없음)", len(again) == 0, str(again))

    print("모든 검증 항목을 통과했습니다.")


def run_live_checks(url):
    token = os.environ.get("RELAY_TOKEN", "")
    if not token:
        raise Failure("--live 에는 환경 변수 RELAY_TOKEN 이 필요합니다 "
                      "(코드에 넣지 말고 실행 시 환경 변수로만 전달)")
    print("배포 서버 안전 점검 (읽기/거부 확인만, 쓰지 않음): %s" % url)
    c = RelayClient(url, token, os.devnull + ".none")
    s, r = c._call("GET", "/updates?after=0")
    check("인증된 읽기 200", s == 200 and r.get("ok") is True, str(r))
    s, r = c._call("POST", "/send", {"text": "probe"})
    check("멱등 키 없음 거절(400)", s == 400, str(r))
    bad = RelayClient(url, "wrong-token", os.devnull + ".none")
    s, r = bad._call("GET", "/updates?after=0")
    check("잘못된 토큰 거부(401)", s == 401, str(r))
    print("배포 서버 안전 점검을 통과했습니다. (성공 쓰기는 실환경 전환 시 확인)")


def main():
    args = sys.argv[1:]
    if "--live" in args:
        url = args[args.index("--live") + 1]
        run_live_checks(url)
        return
    relay = MockRelay()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(relay))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % port
    if "--serve" in args:
        print("목 중계 서버 실행 중: %s" % base)
        print("시험 토큰: pickle=%s  instinct=%s" %
              tuple(TEST_TOKENS.keys()))
        print("사용자 메시지 주입: POST /test/inject "
              "(헤더 X-Test-Admin: %s, 본문 {\"text\": ...})" % TEST_ADMIN)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
        return
    os.environ["RELAY_MOCK_PAGE"] = "3"   # has_more 경로를 적은 데이터로 검증
    relay.page = 3
    try:
        run_verification(base)
    except Failure as e:
        print("실패: %s" % e)
        sys.exit(1)


if __name__ == "__main__":
    main()
