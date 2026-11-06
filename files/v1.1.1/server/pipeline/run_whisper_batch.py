#!/usr/bin/env python
# run_whisper_batch.py
# 모델을 한 번만 불러온 뒤 여러 오디오 파일을 순서대로 처리해서, 매 클립마다 모델을 다시
# 불러오는 비효율을 없앤다.
#
# 사용법: python run_whisper_batch.py <segments_json_path> --lang ko
# segments_json_path 안의 파일은 ["C:/.../seg_0.wav", "C:/.../seg_1.wav", ...] 형태의 JSON 배열.
# 결과는 stdout에 JSON 배열로 한 번에 출력: [{"text":..., "avg_logprob":...}, ...]

import sys
import json
import argparse

# Windows에서 기본 콘솔 인코딩(cp949 등) 때문에 한글이 깨지는 것을 방지:
# 강제로 UTF-8로 출력하도록 고정한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("segments_json_path")
    parser.add_argument("--lang", default="ko")
    parser.add_argument("--model", default="medium")
    parser.add_argument("--initial_prompt", default=None)
    args = parser.parse_args()

    with open(args.segments_json_path, "r", encoding="utf-8") as f:
        audio_paths = json.load(f)

    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    results = []
    for audio_path in audio_paths:
        segments, info = model.transcribe(
            audio_path,
            language=args.lang,
            beam_size=5,
            initial_prompt=args.initial_prompt
        )
        texts = []
        logprobs = []
        for seg in segments:
            texts.append(seg.text.strip())
            logprobs.append(seg.avg_logprob)
        avg_logprob = sum(logprobs) / len(logprobs) if logprobs else -999
        results.append({"text": " ".join(texts).strip(), "avg_logprob": avg_logprob})
        # 진행 상황을 stderr로 흘려보내면 stdout(결과 JSON)과 섞이지 않는다.
        print(f"[{len(results)}/{len(audio_paths)}] done", file=sys.stderr)

    print(json.dumps(results, ensure_ascii=False))

if __name__ == "__main__":
    main()
