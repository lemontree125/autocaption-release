"""
patch_av_compat.py

faster-whisper 내부 코드(audio.py)가 av.open()을 호출할 때 metadata_errors="ignore"라는
옵션을 넘기는데, PyAV(av 패키지) 19.0.0부터 이 옵션이 없어지면서 다음 에러가 발생한다:

    TypeError: open() got an unexpected keyword argument 'metadata_errors'

이 스크립트는 faster-whisper가 실제로 설치된 위치를 찾아서, audio.py 안의
", metadata_errors=\"ignore\"" 부분을 제거한다 (옵션 하나를 안 넘기는 것뿐이라
어떤 av 버전에서도 안전하게 동작한다 — 특정 Python/av 버전을 맞출 필요가 없어짐).

여러 번 실행해도 안전함(idempotent) — 이미 패치되어 있으면 그냥 "이미 패치됨"이라고만 출력하고 끝남.
faster-whisper를 재설치/업데이트하면 이 패치가 초기화되므로, start-server.bat이 서버를 켤 때마다
자동으로 이 스크립트를 실행해서 매번 다시 확인/적용한다.
"""

import sys


def main():
    try:
        import faster_whisper
    except ImportError:
        print("[patch_av_compat] faster_whisper가 설치되어 있지 않습니다 — 건너뜀 "
              "(pip install faster-whisper 먼저 실행해주세요)")
        return 0

    import pathlib

    audio_py = pathlib.Path(faster_whisper.__file__).parent / "audio.py"
    if not audio_py.exists():
        print(f"[patch_av_compat] audio.py를 찾을 수 없습니다: {audio_py} — 건너뜀")
        return 0

    original = audio_py.read_text(encoding="utf-8")

    # 여러 가지로 쓰일 수 있는 형태를 전부 커버 (따옴표 종류, 공백, 인자 순서 등)
    patterns = [
        ', metadata_errors="ignore"',
        ", metadata_errors='ignore'",
        'metadata_errors="ignore", ',
        "metadata_errors='ignore', ",
    ]

    patched = original
    for pat in patterns:
        patched = patched.replace(pat, "")

    if patched == original:
        if "metadata_errors" in original:
            print("[patch_av_compat] metadata_errors가 남아있지만 알려진 패턴과 다릅니다 — "
                  "수동 확인이 필요할 수 있습니다: " + str(audio_py))
        else:
            print("[patch_av_compat] 이미 패치되어 있음 (또는 이 버전에는 해당 코드가 없음) — 건너뜀")
        return 0

    audio_py.write_text(patched, encoding="utf-8")
    print(f"[patch_av_compat] 패치 완료: {audio_py}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
