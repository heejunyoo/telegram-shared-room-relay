#!/usr/bin/env python3
"""
scripts/test_pickle_relay.py
--serve 모드로 갱신된 relay_check.py 모의 서버를 띄운 뒤,
피클의 실제 클라이언트(scripts/relay_client.py)의 Outbox 패턴, 장애 복구,
그리고 중계 규약 18개 항목 전반을 종합 검증하는 통합 시험 스크립트.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

# 피클 클라이언트 import
sys.path.insert(0, str(Path(__file__).parent))
from relay_client import PickleRelayClient

TEST_ADMIN = "relay-test-admin"


def run_tests():
    print("=" * 72)
    print("피클 중계 클라이언트(PickleRelayClient) Outbox 패턴 및 규약 종합 검증")
    print("=" * 72)

    mock_path = Path(__file__).resolve().parent.parent / "tools" / "relay_check.py"
    server_cmd = [sys.executable, "-u", str(mock_path), "--serve"]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["RELAY_MOCK_PAGE"] = "3"

    print("[1] relay_check.py --serve 모의 서버 기동 중...")
    proc = subprocess.Popen(
        server_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env
    )

    base_url = None
    try:
        for _ in range(50):
            line = proc.stdout.readline()
            if not line:
                time.sleep(0.1)
                continue
            line = line.strip()
            print(f"  [모의 서버 출력] {line}")
            if "목 중계 서버 실행 중: " in line:
                base_url = line.split("목 중계 서버 실행 중: ")[1].strip()
                break
            time.sleep(0.05)

        if not base_url:
            raise RuntimeError("모의 서버 기동 실패 또는 base_url 확인 불가")

        print(f"\n[2] 모의 서버 연결 확인 성공: {base_url}\n")

        temp_dir = tempfile.mkdtemp(prefix="pickle-relay-comprehensive-")
        pk_state = os.path.join(temp_dir, "pickle_cursor.json")
        pk_outbox = os.path.join(temp_dir, "pickle_outbox.json")
        in_state = os.path.join(temp_dir, "instinct_cursor.json")
        in_outbox = os.path.join(temp_dir, "instinct_outbox.json")

        client = PickleRelayClient(base_url, "pk-test-token", state_path=pk_state, outbox_path=pk_outbox)
        instinct_client = PickleRelayClient(base_url, "in-test-token", state_path=in_state, outbox_path=in_outbox)

        def inject_user_msg(text):
            req = urllib.request.Request(
                f"{base_url}/test/inject",
                data=json.dumps({"text": text}).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-Test-Admin": TEST_ADMIN},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode("utf-8"))["seq"]

        passed_count = 0

        def assert_check(name, condition, extra=""):
            nonlocal passed_count
            if condition:
                print(f"  [통과] {name}")
                passed_count += 1
            else:
                print(f"  [실패] {name} - {extra}")
                raise AssertionError(f"Test failed: {name} ({extra})")

        print("--- [검증 1: 첫 전송 전 Outbox 원자적 기록 및 멱등키 단일 생성 (요구사항 1)] ---")
        test_key = "intent-key-001"
        item = client._record_intent("의도 저장 테스트", target="all", idempotency_key=test_key)
        assert_check("메모리 Outbox 객체 생성 완료", item["idempotency_key"] == test_key and item["status"] == "pending")

        with open(pk_outbox, "r", encoding="utf-8") as f:
            disk_outbox = json.load(f)
        assert_check("디스크에 원자적으로 저장됨 (relay_outbox.json)", test_key in disk_outbox and disk_outbox[test_key]["text"] == "의도 저장 테스트", str(disk_outbox))

        item_repeat = client._record_intent("의도 저장 테스트", target="all", idempotency_key=test_key)
        assert_check("동일 키로 의도 재등록 시 키 유지 및 중복 생성 방지", item_repeat["idempotency_key"] == test_key)

        print("\n--- [검증 2: 통신 장애 시 새 키 생성 금지 및 동일 키 보존 (요구사항 2)] ---")
        failing_client = PickleRelayClient("http://127.0.0.1:9999", "pk-test-token",
                                          state_path=os.path.join(temp_dir, "f_cur.json"),
                                          outbox_path=os.path.join(temp_dir, "f_outbox.json"))
        fail_net_key = "net-fail-key-001"
        s_fail, r_fail = failing_client.send("네트워크 장애 테스트", idempotency_key=fail_net_key)
        assert_check("통신 장애 발생 시 500 에러 처리", s_fail == 500 and "network_error" in r_fail.get("error", ""))

        with open(failing_client.outbox_path, "r", encoding="utf-8") as f:
            f_disk = json.load(f)
        assert_check("통신 장애 후 Outbox에 동일 멱등키와 pending 상태 영속 유지",
                     fail_net_key in f_disk and f_disk[fail_net_key]["status"] == "pending",
                     str(f_disk))

        print("\n--- [검증 3: telegram_status에 따른 완료 판정 및 failed 처리 (요구사항 3)] ---")
        # 3-1. unconfirmed: 미확정 상태 유지
        unconf_key = "unconf-key-002"
        s_un, r_un = client.send("[unconfirmed] 지연 발언", idempotency_key=unconf_key)
        with open(pk_outbox, "r", encoding="utf-8") as f:
            cur_outbox = json.load(f)
        assert_check("unconfirmed 수신 시 완료 처리하지 않고 unconfirmed 상태 유지",
                     cur_outbox[unconf_key]["status"] == "unconfirmed" and cur_outbox[unconf_key]["telegram_status"] == "unconfirmed",
                     str(cur_outbox.get(unconf_key)))

        # 3-2. ok: 성공 확정 (confirmed)
        ok_key = "ok-key-003"
        s_ok, r_ok = client.send("정상 발언", idempotency_key=ok_key)
        with open(pk_outbox, "r", encoding="utf-8") as f:
            cur_outbox = json.load(f)
        assert_check("ok 수신 시 confirmed로 완료 확정",
                     cur_outbox[ok_key]["status"] == "confirmed" and str(cur_outbox[ok_key]["telegram_status"]).startswith("ok:"),
                     str(cur_outbox.get(ok_key)))

        # 3-3. failed: 실패 확정 (failed) 및 새 키 자동 재전송 금지
        fail_key = "fail-key-004"
        s_fl, r_fl = client.send("[fail] 거절 발언", idempotency_key=fail_key)
        with open(pk_outbox, "r", encoding="utf-8") as f:
            cur_outbox = json.load(f)
        assert_check("failed 수신 시 failed 상태로 영속 완료 확정",
                     cur_outbox[fail_key]["status"] == "failed" and cur_outbox[fail_key]["telegram_status"] == "failed:simulated",
                     str(cur_outbox.get(fail_key)))

        s_fl2, r_fl2 = client.send("[fail] 거절 발언", idempotency_key=fail_key)
        assert_check("failed 항목 재호출 시 새 키 전송 없이 저장된 실패 상태 유지 반환",
                     r_fl2.get("telegram_status") == "failed:simulated" and r_fl2.get("duplicated") is True,
                     str(r_fl2))

        print("\n--- [검증 4: 응답 미도착 크래시 후 재시작 시 동일 키 복구 및 중복 방지 (요구사항 4)] ---")
        crash_key = "crash-rec-key-005"
        crash_text = "희준 님: 결제 승인 요청 (크래시 복구 시뮬레이션)"

        # 1단계: Outbox 파일에 pending 상태 시뮬레이션 기록 (응답 수신 전 크래시 모의)
        with open(pk_outbox, "r", encoding="utf-8") as f:
            active_outbox = json.load(f)
        active_outbox[crash_key] = {
            "idempotency_key": crash_key,
            "text": crash_text,
            "target": "all",
            "reply_to": None,
            "root_user_seq": None,
            "status": "pending",
            "telegram_status": None,
            "seq": None,
            "created_at": int(time.time()),
            "updated_at": int(time.time())
        }
        with open(pk_outbox, "w", encoding="utf-8") as f:
            json.dump(active_outbox, f, indent=2, ensure_ascii=False)

        # 2단계: 서버에만 전송 성공 반영 (DB에 원본 기록 생성)
        raw_req = urllib.request.Request(
            f"{base_url}/send",
            data=json.dumps({"text": crash_text, "target": "all", "idempotency_key": crash_key}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer pk-test-token"},
            method="POST"
        )
        with urllib.request.urlopen(raw_req, timeout=10) as r:
            server_first_resp = json.loads(r.read().decode("utf-8"))
        original_seq = server_first_resp["seq"]

        # 3단계: 클라이언트 재시작 (신규 인스턴스)
        restarted_client = PickleRelayClient(base_url, "pk-test-token", state_path=pk_state, outbox_path=pk_outbox)
        assert_check("재시작 시 디스크의 pending Outbox 항목 복구 성공",
                     crash_key in restarted_client.outbox and restarted_client.outbox[crash_key]["status"] == "pending")

        # 4단계: flush_outbox() 로 동일 멱등키 재확인
        recovered = restarted_client.flush_outbox()
        assert_check("flush_outbox() 실행 완료", len(recovered) >= 1)

        # 5단계: 중복 생성 없이 원본 seq 일치 및 confirmed 확정 검증
        final_item = restarted_client.outbox[crash_key]
        assert_check("동일 멱등키로 재확인하여 중복 생성 없이 원본 seq 일치",
                     final_item["seq"] == original_seq, f"final_seq={final_item.get('seq')}")
        assert_check("telegram_status 확인 후 confirmed 로 정상 완료 확정",
                     final_item["status"] == "confirmed" and str(final_item["telegram_status"]).startswith("ok:"),
                     str(final_item))

        # 6단계: 서버 대화록에 중복 발언 없이 단 1건만 존재하는지 최종 전수 확인
        all_received_by_in = []
        instinct_client.poll(handler=lambda m: all_received_by_in.append(m))
        matching_count = sum(1 for m in all_received_by_in if m["text"] == crash_text)
        assert_check("서버 대화록에 중복 발언 없이 단 1건만 존재함 검증", matching_count == 1, f"matching_count={matching_count}")

        print("\n--- [검증 5: 중계 기본 규약 및 가시성/거버넌스 검증] ---")
        # 5-1. 인증 및 요청 유효성
        bad_client = PickleRelayClient(base_url, "invalid-token", state_path=os.path.join(temp_dir, "bad.json"))
        try:
            bad_client.poll()
            assert_check("잘못된 토큰 읽기 거부(401)", False, "예외 미발생")
        except RuntimeError as e:
            assert_check("잘못된 토큰 읽기 거부(401)", "401" in str(e), str(e))

        s, r = client.send("", idempotency_key="empty-text")
        assert_check("본문 text 누락 시 거절(400)", s == 400 and r.get("error") == "text_required")

        # 5-2. 사용자 메시지 수신 및 커서 전진
        u_seq = inject_user_msg("사용자 질문: 텔레그램 연동 상태 확인")
        rcv = []
        client.poll(handler=lambda m: rcv.append(m))
        assert_check("사용자 메시지 정상 수신 및 커서 전진", any(m["seq"] == u_seq for m in rcv) and client.cursor >= u_seq)

        # 5-3. 타깃 가시성 및 자기 발언 제외
        client.send("피클: 전체 공유 공지", target="all", idempotency_key="notice-001")
        in_msgs = []
        instinct_client.poll(handler=lambda m: in_msgs.append(m))
        assert_check("상대방(인스팅트)이 전체 공지 수신", any(m["text"] == "피클: 전체 공유 공지" for m in in_msgs))
        pk_msgs = client.poll()
        assert_check("피클 본인 발언은 피클 poll에서 제외", not any(m["text"] == "피클: 전체 공유 공지" for m in pk_msgs))

        # 5-4. 성공한 왕복 발언의 동일 키 재확인 시 429가 아닌 duplicated:true 반환
        root_seq = inject_user_msg("사용자 질문: 왕복 멱등성 재검증")
        client.poll()  # 새로 주입된 사용자 메시지 수신 및 커서 전진
        cross_k = "cross-test-k-100"
        s_cr1, r_cr1 = client.send("답변 1", target="instinct", root_user_seq=root_seq, idempotency_key=cross_k)
        s_cr2, r_cr2 = client.send("답변 1", target="instinct", root_user_seq=root_seq, idempotency_key=cross_k)
        assert_check("성공한 왕복 발언 동일 키 재확인 시 429 아닌 duplicated 반환",
                     s_cr2 == 200 and r_cr2.get("duplicated") is True and r_cr2.get("seq") == r_cr1.get("seq"))

        # 5-5. 커서 영속성 및 재개 검증
        restarted_client2 = PickleRelayClient(base_url, "pk-test-token", state_path=pk_state, outbox_path=pk_outbox)
        assert_check("커서 복구 후 중복 수신 0건", len(restarted_client2.poll()) == 0)

        print("\n" + "=" * 72)
        print(f"🎉 전 항목 통과 완료! (총 {passed_count}개 세부 검증 항목 100% 통과)")
        print("=" * 72)

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        if "temp_dir" in locals() and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
        print("[서버 정리] 모의 서버 프로세스 및 임시 디렉토리 정리 완료")


if __name__ == "__main__":
    run_tests()
