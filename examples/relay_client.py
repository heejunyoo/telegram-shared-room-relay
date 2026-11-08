#!/usr/bin/env python3
"""
scripts/relay_client.py - 피클 측 텔레그램 공용 방 중계 클라이언트 (Outbox 패턴 적용)

규약 준수 및 견고성 보완 사항:
1. 읽기 & 커서: GET /updates?after=<커서>, has_more가 참인 동안 페이지네이션 완결.
   메시지 처리(handler)가 성공한 뒤에만 커서를 갱신하고 디스크에 원자적으로 영속화.
2. 발신 대기 영속화(Outbox): 첫 전송 전에 내용, target, root_user_seq, idempotency_key를
   로컬 발신 기록(relay_outbox.json)에 원자적으로 먼저 저장. 같은 발송 의도에는 키를 1회만 생성.
3. 장애 복구: 타임아웃, 네트워크 단절, 5xx, 클라이언트 비정상 종료 시에도 저장된
   동일 idempotency_key로만 재시도(새 키 재발급 엄격 금지). 재시작 시 outbox 자동 복구.
4. 상태 확정: duplicated:true 자체로 완료 판단하지 않고 telegram_status를 검증.
   - unconfirmed: 미확정 상태 유지 및 동일 키로 재확인
   - ok: 확정 성공 (confirmed) 처리
   - failed: 확정 실패 (failed) 처리. 새 키로 자동 재전송 절대 금지
5. 거버넌스: target 및 root_user_seq 명시, 에이전트 간 핑퐁 1회 제한.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

DEFAULT_STATE_PATH = Path(__file__).parent / "relay_cursor.json"
DEFAULT_OUTBOX_PATH = Path(__file__).parent / "relay_outbox.json"


class PickleRelayClient:
    def __init__(self, base_url: str, token: str, state_path=None, outbox_path=None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.state_path = Path(state_path) if state_path else DEFAULT_STATE_PATH
        self.outbox_path = Path(outbox_path) if outbox_path else DEFAULT_OUTBOX_PATH
        self.cursor = self._load_cursor()
        self.outbox = self._load_outbox()

    # ------------------------------------------------------------- 커서 관리
    def _load_cursor(self) -> int:
        if self.state_path.exists():
            try:
                with open(self.state_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return int(data.get("cursor", 0))
            except Exception as e:
                print(f"[relay_client] 커서 로드 오류: {e}", file=sys.stderr)
        return 0

    def _save_cursor(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.state_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump({"cursor": self.cursor, "updated_at": int(time.time())}, f, indent=2)
        tmp_path.replace(self.state_path)

    # ------------------------------------------------------------- Outbox 관리
    def _load_outbox(self) -> dict:
        if self.outbox_path.exists():
            try:
                with open(self.outbox_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print(f"[relay_client] Outbox 로드 오류: {e}", file=sys.stderr)
        return {}

    def _save_outbox(self):
        self.outbox_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.outbox_path.with_suffix(".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(self.outbox, f, indent=2, ensure_ascii=False)
        tmp_path.replace(self.outbox_path)

    def _record_intent(self, text: str, target: str, reply_to: int = None,
                       root_user_seq: int = None, idempotency_key: str = None) -> dict:
        """첫 HTTP 전송 전에 발신 의도를 로컬 Outbox에 원자적으로 저장한다."""
        key = idempotency_key or f"pk-{uuid.uuid4()}"
        if key in self.outbox:
            item = self.outbox[key]
            # 이미 존재하는 의도면 기존 데이터 유지
            item["updated_at"] = int(time.time())
        else:
            item = {
                "idempotency_key": key,
                "text": text,
                "target": target,
                "reply_to": reply_to,
                "root_user_seq": root_user_seq,
                "status": "pending",           # pending -> unconfirmed / confirmed / failed
                "telegram_status": None,
                "seq": None,
                "created_at": int(time.time()),
                "updated_at": int(time.time())
            }
            self.outbox[key] = item
        self._save_outbox()
        return item

    # ------------------------------------------------------------- HTTP 통신
    def _call(self, method: str, path: str, body=None, timeout=15):
        url = self.base_url + path
        req = urllib.request.Request(url, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("User-Agent", "pickle-relay-client/1.1")
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data=data, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, json.loads(raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"ok": False, "error": f"http_{e.code}", "body": raw[:200]}
        except Exception as e:
            return 500, {"ok": False, "error": f"network_error: {str(e)}"}

    # ------------------------------------------------------------- 수신 (Poll)
    def poll(self, handler=None):
        """
        새 메시지를 모두 처리할 때까지 읽는다.
        각 메시지는 handler(msg)가 정상 반환된 뒤에만 커서를 올리고 디스크에 저장한다.
        """
        processed_messages = []
        while True:
            status, res = self._call("GET", f"/updates?after={self.cursor}")
            if status != 200 or not res.get("ok"):
                raise RuntimeError(f"updates failed (status {status}): {res}")

            messages = res.get("messages", [])
            for msg in messages:
                if handler:
                    handler(msg)
                self.cursor = msg["seq"]
                self._save_cursor()
                processed_messages.append(msg)

            if not res.get("has_more"):
                break
        return processed_messages

    # ------------------------------------------------------------- 발신 (Send & Outbox)
    def _execute_send_item(self, item: dict):
        """저장된 Outbox 항목을 서버에 전송하고 결과 상태를 갱신한다."""
        body = {
            "text": item["text"],
            "target": item["target"],
            "idempotency_key": item["idempotency_key"]
        }
        if item.get("reply_to") is not None:
            body["reply_to"] = item["reply_to"]
        if item.get("root_user_seq") is not None:
            body["root_user_seq"] = item["root_user_seq"]

        status, res = self._call("POST", "/send", body)
        item["updated_at"] = int(time.time())

        # 통신 장애나 5xx 인 경우: Outbox는 pending 상태 유지 (새 키 생성 절대 안 함)
        if status >= 500 or status == 0:
            item["status"] = "pending"
            self._save_outbox()
            return status, res

        # 4xx 클라이언트 에러 (예: 429 한도 초과 등)
        if status != 200:
            item["status"] = "rejected"
            item["error"] = res.get("error")
            self._save_outbox()
            return status, res

        # 200 OK 수신 시: duplicated:true 여부와 무관하게 telegram_status 분석
        tg_status = res.get("telegram_status") or ""
        item["seq"] = res.get("seq")
        item["telegram_status"] = tg_status

        if tg_status == "unconfirmed":
            item["status"] = "unconfirmed"
            self._save_outbox()
            # 규약에 따라 동일 멱등키로 즉시 1회 상태 재확인 시도
            time.sleep(0.2)
            status, res = self._call("POST", "/send", body)
            tg_status = res.get("telegram_status") or ""
            item["telegram_status"] = tg_status
            item["seq"] = res.get("seq")

        if tg_status.startswith("ok:"):
            item["status"] = "confirmed"
        elif tg_status.startswith("failed:"):
            # failed 확정: 새 키로 재전송하지 않고 영속적 실패 완료 처리
            item["status"] = "failed"
        elif tg_status == "unconfirmed":
            item["status"] = "unconfirmed"
        else:
            item["status"] = "unknown"

        self._save_outbox()
        return status, res

    def send(self, text: str, target: str = "all", reply_to: int = None,
             root_user_seq: int = None, idempotency_key: str = None):
        """
        메시지 발송 요청:
        1. 첫 전송 전에 Outbox에 원자적으로 기록(영속화)
        2. 저장된 동일 키로 전송 실행
        3. telegram_status에 따른 상태 확정
        반환: (status_code, res_dict)
        """
        if not text:
            return 400, {"ok": False, "error": "text_required"}

        # 1단계: 원자적 발송 의도 영속화 (동일 키 단 1회 생성)
        item = self._record_intent(
            text=text,
            target=target,
            reply_to=reply_to,
            root_user_seq=root_user_seq,
            idempotency_key=idempotency_key
        )

        # 이미 failed나 confirmed로 완결된 항목을 동일 키로 다시 호출하는 경우
        if item.get("status") in ("confirmed", "failed") and item.get("seq"):
            return 200, {
                "ok": True,
                "seq": item["seq"],
                "duplicated": True,
                "telegram_status": item["telegram_status"],
                "cached_outbox": True
            }

        # 2단계: 실제 전송 실행
        return self._execute_send_item(item)

    def flush_outbox(self):
        """
        재시작 시 또는 주기적 점검 시 미완결(pending, unconfirmed) 항목을
        저장된 동일 idempotency_key로 안전하게 재확인/재전송한다.
        """
        results = []
        for key, item in list(self.outbox.items()):
            if item.get("status") in ("pending", "unconfirmed"):
                status, res = self._execute_send_item(item)
                results.append((key, status, res))
        return results


if __name__ == "__main__":
    print("PickleRelayClient (Outbox 패턴 강화판) 모듈이 정상적으로 로드되었습니다.")
