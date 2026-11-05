// whisper-pipeline.js
// CEP 패널의 --enable-nodejs 설정 덕분에 require() 사용 가능.
// 사전 준비물(사용자 PC에 설치 필요):
//   1) ffmpeg (PATH에 등록)
//   2) Python + faster-whisper  (pip install faster-whisper)
//      또는 whisper.cpp 바이너리
//
// 이 파일은 "설계 스캐폴드"입니다. 실제 Premiere 환경에서 경로/버전 맞춰 테스트 필요.

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * 1) mixdown WAV 전체를 클립 컷 경계(startSec~endSec)대로 잘라서
 * 2) 진짜 무음/거의 무음인 구간은 ffmpeg로 미리 걸러내고 (Whisper가 무음에서 헛소리를
 *    반복 생성하는 걸 방지하기 위함 - 특히 화자 분리 모드에서 흔함)
 * 3) 나머지 구간만 whisper 모델을 "한 번만" 불러와서 순서대로 인식
 * cuts: [{index, startSec, endSec, name}, ...]  (hostscript.getSequenceCuts 결과)
 */
async function transcribeByCuts(fullWavPath, cuts, opts) {
  opts = opts || {};
  const tmpDir = opts.tmpDir || path.join(path.dirname(fullWavPath), "_segments");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const silenceThresholdDb = opts.silenceThresholdDb ?? -50; // 이보다 조용하면 "무음"으로 판단

  // 1) 모든 구간을 먼저 잘라내고, 무음 여부를 미리 판단한다.
  const segPaths = [];
  const isSilent = [];
  for (const cut of cuts) {
    const segPath = path.join(tmpDir, `seg_${cut.index}.wav`);
    await sliceAudio(fullWavPath, segPath, cut.startSec, cut.endSec);
    let silent = false;
    if (opts.detectSilence) {
      try {
        const meanVolume = await detectMeanVolume(segPath);
        silent = (meanVolume === null) || (meanVolume < silenceThresholdDb);
      } catch (e) {
        silent = false; // 측정 실패 시 안전하게 "무음 아님"으로 처리해서 인식은 시도
      }
    }
    segPaths.push(segPath);
    isSilent.push(silent);
    if (typeof opts.onProgress === "function") {
      opts.onProgress({ phase: "slice", done: segPaths.length, total: cuts.length });
    }
  }

  // 2) 무음이 아닌 구간만 whisper로 넘긴다.
  const activeIndices = [];
  const activeSegPaths = [];
  for (let i = 0; i < segPaths.length; i++) {
    if (!isSilent[i]) {
      activeIndices.push(i);
      activeSegPaths.push(segPaths[i]);
    }
  }

  let texts = [];
  if (activeSegPaths.length > 0) {
    const listPath = path.join(tmpDir, "_segments_list.json");
    fs.writeFileSync(listPath, JSON.stringify(activeSegPaths), "utf8");
    texts = await runWhisperBatch(listPath, opts.lang || "ko", opts.onProgress, activeSegPaths.length, opts.initialPrompt);
  }

  // 3) 결과를 원래 순서로 재조립 (무음 구간은 빈 텍스트로)
  const textByOriginalIndex = new Array(segPaths.length).fill(null);
  activeIndices.forEach((origIdx, i) => { textByOriginalIndex[origIdx] = texts[i]; });

  return cuts.map((cut, i) => {
    if (isSilent[i]) {
      return {
        index: cut.index,
        startSec: cut.startSec,
        endSec: cut.endSec,
        rawText: "",
        confidence: 0,
        needsReview: false
      };
    }
    const t = textByOriginalIndex[i];
    return {
      index: cut.index,
      startSec: cut.startSec,
      endSec: cut.endSec,
      rawText: t.text,
      confidence: t.avg_logprob,
      needsReview: t.avg_logprob < (opts.confidenceThreshold ?? -1.0)
    };
  });
}

/**
 * ffmpeg의 volumedetect 필터로 오디오 파일의 평균 음량(dB)을 측정한다.
 * 값이 낮을수록(더 마이너스일수록) 조용한 것. 측정 실패 시 null 반환.
 */
function detectMeanVolume(audioPath) {
  return new Promise((resolve) => {
    execFile("ffmpeg", [
      "-i", audioPath,
      "-af", "volumedetect",
      "-f", "null",
      "-"
    ], (err, stdout, stderr) => {
      const output = (stderr || "") + (stdout || "");
      const match = output.match(/mean_volume:\s*(-?\d+(\.\d+)?)\s*dB/);
      if (match) resolve(parseFloat(match[1]));
      else resolve(null);
    });
  });
}

function sliceAudio(inputPath, outputPath, startSec, endSec) {
  return new Promise((resolve, reject) => {
    const duration = Math.max(0.05, endSec - startSec);
    execFile("ffmpeg", [
      "-y",
      "-ss", String(startSec),
      "-t", String(duration),
      "-i", inputPath,
      "-ac", "1",
      "-ar", "16000",
      outputPath
    ], (err) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

/**
 * 클리핑(피크) 분석 전용 자르기 함수. Whisper용 sliceAudio()는 모노+16kHz로 다운샘플링하는데,
 * 이 리샘플링 필터가 원본에는 없던 순간적인 피크를 만들어낼 수 있어서(리샘플링 오버슈트),
 * 실제로는 0dB를 안 찍은 구간이 "클리핑"으로 잘못 잡히는 문제가 있었다. 피크 분석은 원본
 * 채널 수/샘플레이트 그대로 잘라서 봐야 정확하므로, 다운믹스/리샘플링 없이 자른다.
 */
function sliceAudioForAnalysis(inputPath, outputPath, startSec, endSec) {
  return new Promise((resolve, reject) => {
    const duration = Math.max(0.05, endSec - startSec);
    execFile("ffmpeg", [
      "-y",
      "-ss", String(startSec),
      "-t", String(duration),
      "-i", inputPath,
      outputPath
    ], (err) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

/**
 * run_whisper_batch.py를 실행해 모델을 한 번만 불러오고 여러 파일을 순서대로 인식한다.
 * stderr로 "[n/total] done" 진행 로그가 오는데, onProgress 콜백이 있으면 그때마다 호출해준다.
 */
function runWhisperBatch(listPath, lang, onProgress, total, initialPrompt) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join(__dirname, "run_whisper_batch.py"),
      listPath,
      "--lang", lang
    ];
    if (initialPrompt) {
      args.push("--initial_prompt", initialPrompt);
    }
    const child = spawn("python", args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });

    let stdout = "";
    let stderrTail = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail += text;
      const m = text.match(/\[(\d+)\/(\d+)\] done/);
      if (m && typeof onProgress === "function") {
        onProgress({ phase: "recognize", done: Number(m[1]), total: Number(m[2]) });
      }
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`whisper 배치 실행 실패 (exit ${code}): ${stderrTail.slice(-500)}`));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error("whisper 배치 출력 파싱 실패: " + stdout.slice(0, 300)));
      }
    });
  });
}

/**
 * 고유명사 사전 적용: dictionary.json의 { "오인식단어": "정정단어" } 매핑을 텍스트에 치환.
 */
function applyDictionary(text, dictionary) {
  // AI 교정이 특정 구간(특히 무음에 가까운 빈 인식 결과)에 대해 correctedText를 null로
  // 돌려주는 경우가 있었고, 이게 그대로 흘러들어와 아래 trim()에서
  // "Cannot read properties of null (reading 'trim')"로 전체 파이프라인이 죽는 문제가
  // 있었다 - null/undefined는 빈 문자열로 취급해서 안전하게 통과시킨다.
  let result = text == null ? "" : text;
  for (const wrong in dictionary) {
    const re = new RegExp(wrong, "g");
    result = result.replace(re, dictionary[wrong]);
  }
  return result;
}

/**
 * 문장부호 On/Off 처리 (문장이 실제로 끝나는 경우에만 적용, isSentenceEnd + endPunctuation 기반).
 * endPunctuation이 없으면(AI 교정 미사용 시) 이전 방식대로 항상 "."을 붙인다/뗀다.
 */
function applyPeriodOption(text, usePeriod, isSentenceEnd, endPunctuation) {
  // Premiere가 caption import 시 문장 끝 문장부호(. ? !)를 통째로 지워버리는 것으로 확인됨
  // (패딩 문제와 같은 종류의 Premiere 쪽 한계). 기능 자체를 비활성화하고 항상 문장부호 없이 반환.
  const safe = text == null ? "" : text; // null 방어 (위 applyDictionary 주석 참고)
  return safe.trim().replace(/[.!?]+$/, "");
}

/**
 * 결과 배열을 SRT 문자열로 변환 (import용).
 */
function toSrt(segments) {
  return segments.map((seg, i) => {
    return `${i + 1}\n${secToSrtTime(seg.startSec)} --> ${secToSrtTime(seg.endSec)}\n${seg.text}\n`;
  }).join("\n");
}

function secToSrtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, len) => String(n).padStart(len, "0");
  return `${pad(h,2)}:${pad(m,2)}:${pad(s,2)},${pad(ms,3)}`;
}

/**
 * 결과 배열을 Premiere의 Text 패널 "Export Text" 형식과 비슷한 .txt로 변환한다.
 * (예: "00;00;00;00 - 00;00;02;21" 형식 + 빈 줄로 구분). fps는 시퀀스의 실제 프레임레이트를
 * 받아와서 반영한다 (드롭프레임 보정까지는 하지 않는 단순 프레임 환산이라, 29.97fps 등에서는
 * Premiere 자체 표기와 프레임 몇 개 정도 차이가 날 수 있음).
 */
function toPremiereText(segments, fps) {
  fps = fps || 30;
  return segments.map(seg => {
    return `${secToTimecode(seg.startSec, fps)} - ${secToTimecode(seg.endSec, fps)}\n${seg.text}\n`;
  }).join("\n");
}

function secToTimecode(sec, fps) {
  const totalFrames = Math.round(sec * fps);
  const framesPerHour = Math.round(fps * 3600);
  const framesPerMinute = Math.round(fps * 60);
  const framesPerSecond = Math.round(fps);
  const h = Math.floor(totalFrames / framesPerHour);
  const m = Math.floor((totalFrames % framesPerHour) / framesPerMinute);
  const s = Math.floor((totalFrames % framesPerMinute) / framesPerSecond);
  const f = totalFrames % framesPerSecond;
  const pad = (n, len) => String(n).padStart(len, "0");
  return `${pad(h,2)};${pad(m,2)};${pad(s,2)};${pad(f,2)}`;
}

/**
 * 번역 자막처럼 언어별로 자연스러운 길이가 다른 경우, 한 구간의 텍스트가 너무 길면
 * 같은 시간 범위 안에서 2개로 쪼개 순차적으로 보여준다 (원본 한글 자막의 컷 타이밍은 건드리지 않음).
 * maxChars: 이 길이를 넘으면 분할 (기본 50자 - 화면에서 한 줄로 읽기 편한 정도).
 */
function splitLongSegments(segments, maxChars) {
  maxChars = maxChars || 50;
  const result = [];
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (text.length <= maxChars) { result.push(seg); continue; }

    const words = text.split(/\s+/);
    if (words.length < 2) { result.push(seg); continue; } // 쪼갤 단어 단위가 없으면 그대로

    // 앞쪽이 전체 글자 수의 절반쯤 되는 지점(단어 경계)에서 나눈다.
    let acc = 0;
    let splitIdx = Math.ceil(words.length / 2);
    for (let i = 0; i < words.length; i++) {
      acc += words[i].length + 1;
      if (acc >= text.length / 2) { splitIdx = i + 1; break; }
    }
    const first = words.slice(0, splitIdx).join(" ");
    const second = words.slice(splitIdx).join(" ");
    if (!first || !second) { result.push(seg); continue; }

    const dur = seg.endSec - seg.startSec;
    const ratio = first.length / (first.length + second.length);
    const mid = seg.startSec + dur * ratio;

    result.push({ ...seg, endSec: mid, text: first });
    result.push({ ...seg, startSec: mid, text: second });
  }
  return result;
}

/**
 * 자막 앞뒤에 공백을 추가한다 (배경 박스가 텍스트에 딱 붙어서 답답해 보이는 것 방지용).
 * count: 0~3, 앞뒤로 각각 이 횟수만큼 공백을 붙인다.
 */
function padSegments(segments, count) {
  // 여러 특수문자(NBSP, 점자 빈칸)로 시도했으나 Premiere의 caption import/렌더링 과정에서
  // 트림되거나(NBSP) 깨진 글자로 보이는(점자 빈칸) 문제가 있어 포기함. 기능 자체를 비활성화.
  return segments;
}

/**
 * ffmpeg의 volumedetect 필터로 오디오 파일의 평균/최대 음량(dB)을 함께 측정한다.
 */
function detectVolumeStats(audioPath) {
  return new Promise((resolve) => {
    execFile("ffmpeg", [
      "-i", audioPath,
      "-af", "volumedetect",
      "-f", "null",
      "-"
    ], (err, stdout, stderr) => {
      const output = (stderr || "") + (stdout || "");
      const meanMatch = output.match(/mean_volume:\s*(-?\d+(\.\d+)?)\s*dB/);
      const maxMatch = output.match(/max_volume:\s*(-?\d+(\.\d+)?)\s*dB/);
      resolve({
        mean: meanMatch ? parseFloat(meanMatch[1]) : null,
        max: maxMatch ? parseFloat(maxMatch[1]) : null
      });
    });
  });
}

/**
 * 전체 오디오를 일정 간격(windowSec)으로 잘라가며, 순간 최대 음량을 두 단계로 분류한다:
 * clipDb 이상이면 "clip"(0dB 근접, 빨간색), warnDb 이상이면 "warn"(-1dB 근접, 주황색).
 * 연속된 같은 등급 구간은 하나로 합쳐서 반환한다.
 *
 * 주의: 이건 "확정 판정"이 아니라 "이 근처는 사람이 한번 들어보고 확인해볼 만하다"는 힌트다.
 * (실제로 Flat factor/Peak count 등 여러 통계 지표로 "진짜 클리핑만" 정확히 구분해보려 했으나,
 * 리미터가 걸린 트랙에서는 정상적으로 0dB에 닿는 소리와 실제 클리핑을 통계로 구분이 안 됐고,
 * 반대로 아날로그 단계에서 이미 찌그러져 들어온 소리는 애초에 0dB를 안 찍어서 못 잡아내는
 * 사례도 있었다 - 그래서 다른 flag 마커들처럼 확인용 힌트로만 쓰기로 함.)
 *
 * audioPath: 전체 시퀀스 mixdown 오디오 파일
 * totalDurationSec: 검사할 전체 길이(초)
 * opts.windowSec: 몇 초 단위로 잘라서 검사할지 (기본 1초)
 * opts.warnDb: 경고 기준 (기본 -1dB)
 * opts.clipDb: 클리핑(확인 필요) 기준 (기본 0dB)
 *
 * 반환: [{startSec, endSec, level: "clip"|"warn"}, ...]
 */
async function detectAudioLevelEvents(audioPath, totalDurationSec, opts) {
  opts = opts || {};
  const windowSec = opts.windowSec || 1;
  const warnDb = opts.warnDb ?? -1;
  const clipDb = opts.clipDb ?? 0;
  const tmpDir = opts.tmpDir || path.join(path.dirname(audioPath), "_peak_windows");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const flags = [];
  let t = 0;
  let winIndex = 0;
  const totalWindows = Math.ceil(totalDurationSec / windowSec);
  while (t < totalDurationSec) {
    const end = Math.min(t + windowSec, totalDurationSec);
    const winPath = path.join(tmpDir, `win_${winIndex}.wav`);
    await sliceAudioForAnalysis(audioPath, winPath, t, end);
    const stats = await detectVolumeStats(winPath);
    let level = null;
    if (stats.max !== null) {
      if (stats.max >= clipDb) level = "clip";
      else if (stats.max >= warnDb) level = "warn";
    }
    flags.push({ startSec: t, endSec: end, level, maxDb: stats.max });
    if (typeof opts.onProgress === "function") {
      opts.onProgress({ done: winIndex + 1, total: totalWindows });
    }
    t = end;
    winIndex++;
  }

  // 연속으로 같은 등급인 구간들을 하나의 이벤트로 합친다.
  const events = [];
  let current = null;
  for (const f of flags) {
    if (f.level) {
      if (current && current.level === f.level) {
        current.endSec = f.endSec;
        if (f.maxDb !== null) current.maxDb = Math.max(current.maxDb ?? -Infinity, f.maxDb);
      } else {
        if (current) events.push(current);
        current = { startSec: f.startSec, endSec: f.endSec, level: f.level, maxDb: f.maxDb };
      }
    } else if (current) {
      events.push(current);
      current = null;
    }
  }
  if (current) events.push(current);

  return events;
}

module.exports = {
  transcribeByCuts,
  applyDictionary,
  applyPeriodOption,
  toSrt,
  toPremiereText,
  splitLongSegments,
  padSegments,
  detectAudioLevelEvents
};
