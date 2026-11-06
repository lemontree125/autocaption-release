// server.js
// UXP 패널은 ffmpeg/Python을 직접 실행할 수 없어서, 이 로컬 서버가 대신 실행해준다.
// UXP 패널(main.js)은 fetch()로 이 서버에 http://localhost:8934 로 요청을 보낸다.
//
// 실행 방법: node server.js  (또는 start-server.bat 더블클릭)
// 이 창을 닫으면 서버가 꺼지므로, 플러그인 쓰는 동안은 계속 켜두어야 한다.

const http = require("http");
const fs = require("fs");
const path = require("path");
const pipeline = require("./pipeline/whisper-pipeline.js");
const llm = require("./pipeline/llm-correction.js");
const license = require("./pipeline/license.js");
const updater = require("./updater.js");

// 개발/시험용으로만 AUTOCAPTION_PORT 환경 변수로 바꿀 수 있다. 패널은 항상 8934를 쓴다.
const PORT = Number(process.env.AUTOCAPTION_PORT) || 8934;
const CONFIG_DIR = path.join(__dirname, "pipeline");

// 사용자가 쌓는 데이터(등록한 고유명사·인식 힌트·기본 API 키)는 프로그램 폴더 밖에 둔다.
// v1.0.6까지는 server\pipeline 안에 있어서, install.bat을 다시 돌리면 server 폴더째 지워지며
// 등록해 둔 내용이 사라졌다. 자동 업데이트도 프로그램 폴더를 통째로 바꾸므로 반드시 분리해야 한다.
// 위치: %APPDATA%\AutoCaption\data (라이선스 키와 같은 상위 폴더)
const USER_DATA_FILES = ["known-terms.json", "proper-noun-translations.json", "llm.json"];
const USER_DATA_DIR = path.join(process.env.APPDATA || require("os").homedir(), "AutoCaption", "data");

function userDataPath(name) {
  return path.join(USER_DATA_DIR, name);
}

// 처음 실행할 때 한 번: 데이터 폴더에 파일이 없으면 지금 프로그램 폴더에 있는 것(기본값이거나
// 예전 버전에서 쌓인 내용)을 복사해 온다. 이미 있으면 절대 덮어쓰지 않는다.
function ensureUserData() {
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    for (const name of USER_DATA_FILES) {
      const dst = userDataPath(name);
      const src = path.join(CONFIG_DIR, name);
      if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
  } catch (e) {
    console.error("사용자 데이터 폴더 준비 실패:", e.message);
  }
}
ensureUserData();
const jobs = {}; // jobId -> { status, progress, result, error }
let nextJobId = 1;

// 서버가 로그인 시 숨김 창(start-server-hidden.ps1)으로 자동 실행될 땐 콘솔
// 창 자체가 안 보여서, 문제가 생겨도 로그를 확인할 방법이 없었다. 그래서
// console.log/error를 가로채서 파일에도 같이 남긴다 (500KB 넘으면 앞부분을
// 잘라내서 무한정 커지지 않게 함).
const LOG_PATH = path.join(__dirname, "server.log");
const MAX_LOG_SIZE = 500 * 1024;
function appendToLogFile(line) {
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_SIZE) {
      const existing = fs.readFileSync(LOG_PATH, "utf8");
      fs.writeFileSync(LOG_PATH, existing.slice(Math.floor(existing.length / 2)));
    }
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch (e) { /* 로그 파일 쓰기 실패는 무시 - 서버 동작엔 영향 없어야 함 */ }
}
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);
console.log = (...args) => {
  origConsoleLog(...args);
  appendToLogFile("[" + new Date().toISOString() + "] " + args.map(String).join(" "));
};
console.error = (...args) => {
  origConsoleError(...args);
  appendToLogFile("[" + new Date().toISOString() + "] [ERROR] " + args.map(String).join(" "));
};
process.on("uncaughtException", (err) => {
  appendToLogFile("[" + new Date().toISOString() + "] [UNCAUGHT] " + (err && err.stack ? err.stack : String(err)));
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

// Whisper/ffmpeg/Claude를 실제로 돌리는 엔드포인트 맨 앞에서 호출한다. 패널 JS만 고쳐서는
// 우회할 수 없도록, 라이선스 확인을 패널이 아니라 서버(여기) 쪽에서 매 요청마다 한다.
// 통과하면 true를 반환하고, 실패하면 403과 함께 응답을 보내고 false를 반환한다(호출부는 return만 하면 됨).
function requireLicense(res) {
  const r = license.check();
  if (!r.ok) {
    sendJson(res, 403, {
      error: "라이선스가 유효하지 않습니다: " + license.message(r.reason),
      licenseReason: r.reason,
      deviceCode: r.deviceCode
    });
    return false;
  }
  return true;
}

function loadKnownTerms(project) {
  let terms = [];
  try {
    const data = JSON.parse(fs.readFileSync(userDataPath("known-terms.json"), "utf8"));
    terms = data.terms || [];
  } catch (e) { /* 무시 */ }
  // 고유명사 사전(proper-noun-translations.json)에 등록된 한글 원어는 번역 표기가 없어도
  // (즉 한글만 등록된 경우에도) Whisper 인식 힌트 + Claude 교정 힌트로 함께 사용한다.
  // 단, 특정 프로젝트 전용으로 등록된 단어(project 필드 있음)는 지금 작업 중인 프로젝트와
  // 일치할 때만 포함한다 — 다른 현장 이름/시행사/신탁사 이름이 힌트로 섞여 들어가는 것을 방지.
  try {
    const glossary = JSON.parse(fs.readFileSync(userDataPath("proper-noun-translations.json"), "utf8"));
    for (const [ko, entry] of Object.entries(glossary)) {
      if (ko.startsWith("_")) continue;
      const scope = entry && entry.project;
      if (scope && scope !== project) continue; // 다른 프로젝트 전용이거나, 현재 프로젝트 미지정이면 제외
      if (!terms.includes(ko)) terms.push(ko);
    }
  } catch (e) { /* 무시 */ }
  return terms;
}

function loadDictionary() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "dictionary.json"), "utf8"));
  } catch (e) { return {}; }
}

function loadProperNounGlossary() {
  try {
    return JSON.parse(fs.readFileSync(userDataPath("proper-noun-translations.json"), "utf8"));
  } catch (e) { return {}; }
}

// "00;00;00;00 - 00;00;03;08" 다음 줄에 텍스트가 오고 빈 줄로 구분되는, SRT를 텍스트로
// export한 형식을 우선 인식한다. 이 형식이면 타임코드를 그대로 쓸 수 있다. 이 형식이
// 아니면(일반 텍스트) 한 줄 = 한 항목으로 폴백한다. 맞춤법 검사/자막 비교 둘 다 이 파서를 쓴다.
const TIMED_TEXT_TC_PATTERN = /^\d{2}[;:]\d{2}[;:]\d{2}[;:]\d{2}\s*-\s*\d{2}[;:]\d{2}[;:]\d{2}[;:]\d{2}$/;

function parseTimedTextFile(filePath) {
  let rawText = fs.readFileSync(filePath, "utf8");
  rawText = rawText.replace(/^\uFEFF/, ""); // BOM 제거
  const blocks = rawText.split(/\r?\n\r?\n+/);
  const items = []; // [{timecode: string|null, text: string}]
  for (const block of blocks) {
    const blockLines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (blockLines.length === 0) continue;
    if (TIMED_TEXT_TC_PATTERN.test(blockLines[0])) {
      const text = blockLines.slice(1).join(" ").trim();
      if (text) items.push({ timecode: blockLines[0], text });
    } else {
      for (const l of blockLines) items.push({ timecode: null, text: l });
    }
  }
  return items;
}

// 표준 SRT 파일 파서 (따로 번역용). "00:00:01,000 --> 00:00:03,500" 타임코드를 초 단위로 바꾼다.
// 밀리초 구분자는 쉼표와 마침표 둘 다 받는다. 여러 줄 자막은 한 줄로 합친다(번역 후 다시 나눔).
const SRT_TIME_PATTERN = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function parseSrtFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^﻿/, "");
  const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
  const segments = [];
  for (const block of raw.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const tcIndex = lines.findIndex((l) => SRT_TIME_PATTERN.test(l));
    if (tcIndex < 0) continue;
    const m = SRT_TIME_PATTERN.exec(lines[tcIndex]);
    const text = lines.slice(tcIndex + 1).join(" ").trim();
    if (!text) continue;
    segments.push({ index: segments.length, startSec: toSec(m[1], m[2], m[3], m[4]), endSec: toSec(m[5], m[6], m[7], m[8]), text });
  }
  return segments;
}

// 외부 라이브러리 없이 순수 JS로 구현한 LCS 기반 줄 단위 diff. 두 텍스트 배열을 비교해서
// same/added/removed 연산 순서를 반환한다. AI 판단이 아니라 완전히 기계적인 비교라서,
// "정확히 뭐가 달라졌는지"를 왜곡 없이 보여줄 수 있다(자막 비교용).
function diffTextArrays(baseTexts, targetTexts) {
  const n = baseTexts.length, m = targetTexts.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = baseTexts[i] === targetTexts[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (baseTexts[i] === targetTexts[j]) {
      ops.push({ type: "same", baseIndex: i, targetIndex: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "removed", baseIndex: i });
      i++;
    } else {
      ops.push({ type: "added", targetIndex: j });
      j++;
    }
  }
  while (i < n) { ops.push({ type: "removed", baseIndex: i }); i++; }
  while (j < m) { ops.push({ type: "added", targetIndex: j }); j++; }

  // 인접한 removed+added(또는 added+removed)는 "같은 자리가 수정됨"으로 합쳐서 보여준다.
  const merged = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === "removed" && ops[k + 1] && ops[k + 1].type === "added") {
      merged.push({ type: "changed", baseIndex: ops[k].baseIndex, targetIndex: ops[k + 1].targetIndex });
      k += 2;
    } else if (ops[k].type === "added" && ops[k + 1] && ops[k + 1].type === "removed") {
      merged.push({ type: "changed", baseIndex: ops[k + 1].baseIndex, targetIndex: ops[k].targetIndex });
      k += 2;
    } else {
      merged.push(ops[k]);
      k++;
    }
  }
  return merged;
}

// 타임코드 문자열(세미콜론 프레임 방식이든 콤마/밀리초 방식이든)을 정렬용 숫자로 바꾼다.
// 프레임 레이트를 정확히 몰라도, 같은 영상 안에서는 순서만 맞으면 되므로 이 정도로 충분하다.
function timecodeToSortKey(tc) {
  if (!tc) return 0;
  const first = tc.split(/-{1,3}>?/)[0].trim();
  const parts = first.split(/[;:,]/).map((p) => parseInt(p, 10) || 0);
  while (parts.length < 4) parts.push(0);
  const [h, m, s, f] = parts;
  return ((h * 60 + m) * 60 + s) * 1000 + f;
}

// diffTextArrays()가 만든 연산 순서를, "연속된 삭제/추가 덩어리"를 하나의 항목으로 묶어서
// 사람이 읽기 좋게 만든다. 컷을 다시 나누거나 합친 경우(캡션 개수 자체가 달라짐) 이 묶음이
// 없으면 한 문장의 재구성이 여러 줄의 삭제/추가로 쪼개져 보여서 노이즈가 심해진다.
// useTimecode가 true면 baseUnits/targetUnits를 {text, timecode} 형태로, false면 단순 문자열
// 배열(단어 단위 비교용)로 받는다.
function buildDiffEntries(ops, baseUnits, targetUnits, useTimecode) {
  const getText = (units, idx) => (useTimecode ? units[idx].text : units[idx]);
  const getTimecode = (units, idx) => (useTimecode ? units[idx].timecode : null);

  const entries = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === "same") { i++; continue; }
    let j = i;
    const baseIdxs = [];
    const targetIdxs = [];
    while (j < ops.length && ops[j].type !== "same") {
      if (ops[j].type === "removed") baseIdxs.push(ops[j].baseIndex);
      else if (ops[j].type === "added") targetIdxs.push(ops[j].targetIndex);
      else if (ops[j].type === "changed") { baseIdxs.push(ops[j].baseIndex); targetIdxs.push(ops[j].targetIndex); }
      j++;
    }
    const entry = { type: baseIdxs.length && targetIdxs.length ? "changed" : baseIdxs.length ? "removed" : "added" };
    if (baseIdxs.length) {
      entry.baseText = baseIdxs.map((k) => getText(baseUnits, k)).join(" ");
      if (useTimecode) entry.baseTimecode = getTimecode(baseUnits, baseIdxs[0]);
    }
    if (targetIdxs.length) {
      entry.targetText = targetIdxs.map((k) => getText(targetUnits, k)).join(" ");
      if (useTimecode) entry.targetTimecode = getTimecode(targetUnits, targetIdxs[0]);
    }
    entries.push(entry);
    i = j;
  }
  return entries;
}

// SRT 파일명에 붙일 실행 시각 스탬프(예: 0928-231045). 매번 같은 경로로 파일을 만들면
// Premiere가 "이미 import한 파일"로 보고 예전 항목을 재사용해서, 새로 만든 내용이 아니라
// 옛날 자막이 시퀀스에 들어가는 문제가 있었다. 파일명이 실행마다 달라지면 항상 새로 읽는다.
function runStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ===== 자막 파일 저장 위치 / 이름 (v1.1.0) =====
// 위치: Premiere 프로젝트 파일(.prproj) 옆 "AutoCaption 자막" 폴더.
//       프로젝트를 아직 저장하지 않았으면 문서\AutoCaption\<이름>.
// 이름: <이름>_[화자N_]<언어>_<YYYYMMDD-HHmm>.srt  (같은 이름이 있으면 -2, -3 …)
//       <이름> = 패널의 "현재 프로젝트/현장" 칸 → 비어 있으면 .prproj 파일 이름 → 그것도 없으면 AutoCaption
const OUTPUT_FOLDER_NAME = "AutoCaption 자막";

function safeFileName(s) {
  return String(s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 60);
}

function outputBaseName(info) {
  const fromField = safeFileName(info && info.outputName);
  if (fromField) return fromField;
  const prproj = info && info.projectFilePath ? path.basename(info.projectFilePath).replace(/\.prproj$/i, "") : "";
  return safeFileName(prproj) || "AutoCaption";
}

function outputDir(info) {
  const projectFilePath = info && info.projectFilePath;
  let dir;
  if (projectFilePath && path.isAbsolute(projectFilePath) && fs.existsSync(path.dirname(projectFilePath))) {
    dir = path.join(path.dirname(projectFilePath), OUTPUT_FOLDER_NAME);
  } else {
    const docs = path.join(require("os").homedir(), "Documents");
    dir = path.join(fs.existsSync(docs) ? docs : require("os").homedir(), "AutoCaption", outputBaseName(info));
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function outputSrtPath(info, langCode) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const speaker = info && Number(info.speakerNum) > 0 ? `_화자${Number(info.speakerNum)}` : "";
  const stem = `${outputBaseName(info)}${speaker}_${safeFileName(langCode) || "ko"}_${stamp}`;
  const dir = outputDir(info);
  let candidate = path.join(dir, stem + ".srt");
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(dir, `${stem}-${n}.srt`);
  return candidate;
}

// 탐색기 열기. UXP 패널은 다른 프로그램을 직접 실행할 수 없어서 서버가 대신 연다.
function openInExplorer(args) {
  require("child_process").execFile("explorer.exe", args, () => {
    // explorer.exe는 정상이어도 종료 코드 1을 돌려주는 경우가 많아서 결과는 무시한다.
  });
}

function loadApiKey(clientProvidedKey) {
  if (clientProvidedKey && clientProvidedKey.trim()) {
    return clientProvidedKey.trim();
  }
  try {
    const llmConfig = JSON.parse(fs.readFileSync(userDataPath("llm.json"), "utf8"));
    if (llmConfig.apiKey && llmConfig.apiKey.trim()) {
      return llmConfig.apiKey.trim();
    }
  } catch (e) {
    // llm.json이 없거나 읽기 실패 - 아래에서 에러로 처리
  }
  throw new Error("Claude API 키가 설정되지 않았습니다. 패널의 'Claude API 키' 칸에 본인 키를 입력해주세요.");
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  try {
    // 헬스체크 - UXP 패널이 서버가 켜져있는지 확인용
    if (req.method === "GET" && req.url === "/ping") {
      // hasDefaultKey: 서버 llm.json에 기본 API 키가 있는지 (패널의 "API 없이 쓰는 모드" 판단용, 키 값 자체는 보내지 않음)
      let hasDefaultKey = false;
      try { loadApiKey(""); hasDefaultKey = true; } catch (e) { hasDefaultKey = false; }
      return sendJson(res, 200, { ok: true, hasDefaultKey });
    }

    // 라이선스 상태 확인 - 패널이 시작할 때 호출. 미등록/만료/다른 기기 등이어도 200으로
    // 응답하고 ok:false + reason으로 알려준다 (패널이 등록 화면을 보여줄 수 있도록).
    if (req.method === "GET" && req.url === "/api/license") {
      const r = license.check();
      return sendJson(res, 200, {
        ok: r.ok,
        enforced: license.ENFORCE,
        reason: r.ok ? null : r.reason,
        message: r.ok ? null : license.message(r.reason),
        deviceCode: r.deviceCode,
        licensee: r.ok ? r.lic.n : null,
        issuedAt: r.ok ? r.lic.i : null,
        expiresAt: r.ok ? (r.lic.e || null) : null
      });
    }

    // 라이선스 키 등록 - 패널의 등록 화면에서 호출
    if (req.method === "POST" && req.url === "/api/license") {
      const body = await readJsonBody(req);
      const r = license.activate(body.key || "");
      return sendJson(res, 200, {
        ok: r.ok,
        reason: r.ok ? null : r.reason,
        message: r.ok ? null : license.message(r.reason),
        deviceCode: r.deviceCode,
        licensee: r.ok ? r.lic.n : null,
        issuedAt: r.ok ? r.lic.i : null,
        expiresAt: r.ok ? (r.lic.e || null) : null
      });
    }

    // 라이선스 삭제(초기화) - 패널 "라이선스 삭제" 버튼에서 호출. DELETE 대신 POST를
    // 쓴 이유: 위 OPTIONS 프리플라이트의 Access-Control-Allow-Methods에 DELETE를
    // 추가로 신경 쓸 필요 없이 기존 GET/POST만으로 끝내기 위함.
    if (req.method === "POST" && req.url === "/api/license/delete") {
      license.clear();
      return sendJson(res, 200, { ok: true });
    }

    // 오디오 레벨(클리핑/경고) 감지를 백그라운드 작업으로 시작
    if (req.method === "POST" && req.url === "/api/detect-clipping/start") {
      if (!requireLicense(res)) return;
      const body = await readJsonBody(req);
      const jobId = String(nextJobId++);
      jobs[jobId] = { status: "running", progress: { phase: "오디오 레벨 검사 중", done: 0, total: 0 } };

      (async () => {
        try {
          const { audioPath, totalDurationSec, windowSec, warnDb, clipDb } = body;
          const events = await pipeline.detectAudioLevelEvents(audioPath, totalDurationSec, {
            windowSec: windowSec || 1,
            warnDb: warnDb ?? -1,
            clipDb: clipDb ?? 0,
            tmpDir: path.join(require("os").tmpdir(), "autocaption_uxp_peak_windows"),
            onProgress: ({ done, total }) => {
              jobs[jobId].progress = { phase: "오디오 레벨 검사 중", done, total };
            }
          });
          jobs[jobId] = { status: "done", result: { events } };
        } catch (e) {
          jobs[jobId] = { status: "error", error: e.message };
        }
      })();

      return sendJson(res, 200, { jobId });
    }

    // 오디오 인식 + AI 교정을 "백그라운드 작업"으로 시작하고 jobId만 즉시 반환
    if (req.method === "POST" && req.url === "/api/transcribe-and-correct/start") {
      if (!requireLicense(res)) return;
      const body = await readJsonBody(req);
      const jobId = String(nextJobId++);
      jobs[jobId] = { status: "running", progress: { phase: "준비 중", done: 0, total: 0 } };

      // await 하지 않고 백그라운드로 실행 (요청은 바로 응답)
      (async () => {
        try {
          const { audioPath, cuts, lang, useAiCorrection, usePeriod, detectSilence, silenceThresholdDb, paddingCount, fileSuffix, project, videoContext, apiKey: clientApiKey, compoundSpacing } = body;
          const knownTerms = loadKnownTerms(project);
          const dictionary = loadDictionary();

          const promptParts = [];
          if (videoContext && videoContext.trim()) promptParts.push(videoContext.trim());
          if (knownTerms.length) promptParts.push(knownTerms.join(", "));

          let segments = await pipeline.transcribeByCuts(audioPath, cuts, {
            lang: lang || "ko",
            confidenceThreshold: -1.0,
            tmpDir: path.join(require("os").tmpdir(), "autocaption_uxp_segments" + (fileSuffix || "")),
            initialPrompt: promptParts.length ? promptParts.join(". ") : undefined,
            detectSilence: detectSilence !== false,
            silenceThresholdDb: silenceThresholdDb ?? -50,
            onProgress: ({ phase, done, total }) => {
              jobs[jobId].progress = { phase: phase === "slice" ? "오디오 자르는 중" : "음성 인식 중", done, total };
            }
          });

          let corrected;
          let correctionError = null;
          // AI 교정을 거치지 않은 Whisper 원문: 바로 이어지는 3단어 이상 반복을 지우고,
          // 지운 구절은 reason에 적어 마커로 남긴다 (AI 교정을 켜면 Claude가 정리하므로 적용하지 않음).
          const rawWithRepeatFix = (seg) => {
            const { text, removed } = pipeline.removeRepeatedPhrases(seg.rawText);
            if (!removed.length) return { ...seg, correctedText: seg.rawText, flagged: seg.needsReview, reason: null };
            return { ...seg, correctedText: text, flagged: true, reason: "반복 제거됨: " + removed.join(" / ") };
          };
          if (!useAiCorrection) {
            corrected = segments.map(rawWithRepeatFix);
          } else {
            jobs[jobId].progress = { phase: "AI 문맥 교정 중", done: 0, total: 1 };
            try {
              const apiKey = loadApiKey(clientApiKey);
              const results = await llm.correctWithContext(segments, apiKey, knownTerms, videoContext, compoundSpacing);
              corrected = segments.map((seg, i) => ({
                ...seg,
                // Claude가 특정 구간(특히 빈 인식 결과)에 correctedText: null을 돌려줄 때가
                // 있어서, 그대로 두면 이후 applyDictionary/applyPeriodOption에서 null.trim()으로
                // 전체 작업이 죽었다 - null이면 원본 인식 텍스트(rawText)로 안전하게 대체.
                correctedText: results[i].correctedText != null ? results[i].correctedText : (seg.rawText || ""),
                flagged: results[i].flagged,
                reason: results[i].reason,
                isSentenceEnd: results[i].isSentenceEnd,
                endPunctuation: results[i].endPunctuation
              }));
            } catch (e) {
              correctionError = e.message;
              corrected = segments.map(rawWithRepeatFix); // 교정 실패 = Whisper 원문 그대로이므로 반복 정리는 해 준다
            }
          }

          const processed = corrected.map(seg => {
            let text = pipeline.applyDictionary(seg.correctedText, dictionary);
            text = pipeline.applyPeriodOption(text, usePeriod, seg.isSentenceEnd, seg.endPunctuation);
            text = text.replace(/\./g, ""); // 문장 끝뿐 아니라 중간(여러 문장이 한 자막에 합쳐진 경우)의 온점도 전부 제거 - 일관성을 위해
            return { ...seg, text, needsReview: seg.flagged };
          })
            // 무음 구간처럼 글자가 하나도 없는 자막은 SRT에 넣지 않는다 (빈 자막이 Premiere에 빈 캡션으로 들어가는 것 방지).
            .filter(seg => seg.text && seg.text.trim());

          const padded = pipeline.padSegments(processed, paddingCount || 0);
          const srtText = pipeline.toSrt(padded);
          // 화자 분리 모드(writeSrt:false)에서는 여기서 파일을 만들지 않는다 - 무음 필터 후
          // /api/rebuild-srt가 최종본만 저장한다 (쓸모없는 필터 전 파일이 자막 폴더에 쌓이지 않게).
          let srtPath = null;
          if (body.writeSrt !== false) {
            srtPath = outputSrtPath(body.output, lang || "ko");
            fs.writeFileSync(srtPath, "\uFEFF" + srtText, "utf8");
          }

          jobs[jobId] = { status: "done", result: { segments: processed, srtPath, correctionError } };
        } catch (e) {
          jobs[jobId] = { status: "error", error: e.message };
        }
      })();

      return sendJson(res, 200, { jobId });
    }

    // 작업 상태 조회 (폴링용)
    if (req.method === "GET" && req.url.startsWith("/api/job-status")) {
      const url = new URL(req.url, "http://localhost");
      const jobId = url.searchParams.get("id");
      const job = jobs[jobId];
      if (!job) return sendJson(res, 404, { error: "job not found" });
      return sendJson(res, 200, job);
    }

    // 화자 분리 모드: 무음 필터링 후 남은 세그먼트로 SRT를 다시 만듦
    if (req.method === "POST" && req.url === "/api/rebuild-srt") {
      if (!requireLicense(res)) return;
      const body = await readJsonBody(req);
      const { segments } = body;
      const srtText = pipeline.toSrt(segments);
      const srtPath = outputSrtPath(body.output, body.lang || "ko");
      fs.writeFileSync(srtPath, "\uFEFF" + srtText, "utf8");
      return sendJson(res, 200, { srtPath });
    }

    // 번역 (결과도 SRT 파일로 만들어서 경로 반환)
    if (req.method === "POST" && req.url === "/api/translate") {
      if (!requireLicense(res)) return;
      const body = await readJsonBody(req);
      const { segments, targetLangLabel, targetLangCode, paddingCount, fileSuffix, project, videoContext, apiKey: clientApiKey, sessionGlossary, stripPunctuation } = body;
      const apiKey = loadApiKey(clientApiKey);
      const properNounGlossary = loadProperNounGlossary();
      const glossaryForLang = {};
      // 이번 영상 안에서만 통일하기로 한 세션 글로서리를 먼저 깔고,
      if (sessionGlossary && typeof sessionGlossary === "object") {
        Object.assign(glossaryForLang, sessionGlossary);
      }
      // 정식으로 등록된 영구 글로서리가 있으면 항상 그걸로 덮어쓴다(우선순위 높음).
      for (const [ko, byLang] of Object.entries(properNounGlossary)) {
        if (ko.startsWith("_")) continue;
        const scope = byLang.project;
        if (scope && scope !== project) continue; // 다른 프로젝트 전용 표기는 번역 시 사용 안 함
        if (byLang[targetLangCode]) glossaryForLang[ko] = byLang[targetLangCode];
      }
      const translations = await llm.translateSegments(segments, targetLangLabel, apiKey, glossaryForLang, videoContext);
      const translatedSegments = segments.map((s, i) => ({ ...s, text: translations[i].translatedText }))
        .filter(s => s.text && s.text.trim());
      let splitSegments = pipeline.splitLongSegments(translatedSegments, 50);
      if (stripPunctuation) {
        // 각 캡션 줄 "끝"의 마침표/쉼표(. 。 ． , ， 、)만 제거한다. 긴 문장을 나눈 조각도 줄 끝에
        // 쉼표가 남기 쉬워서 나눈 뒤에 처리한다. 물음표/느낌표는 뜻을 담고 있어 유지한다.
        splitSegments = splitSegments
          .map((s) => ({ ...s, text: s.text.replace(/[\s.。．,，、]+$/u, "") }))
          .filter((s) => s.text.trim());
      }
      const padded = pipeline.padSegments(splitSegments, paddingCount || 0);
      const srtText = pipeline.toSrt(padded);
      const srtPath = outputSrtPath(body.output, targetLangCode);
      fs.writeFileSync(srtPath, "\uFEFF" + srtText, "utf8");

      return sendJson(res, 200, { srtPath, emptyCount: segments.length - translatedSegments.length });
    }

    // 화자 여러 명의 대본을 합쳐서, 번역 시작 전에 이 영상 전체에서 통일할 고유명사를 한 번에 정리
    if (req.method === "POST" && req.url === "/api/build-session-glossary") {
      if (!requireLicense(res)) return;
      const body = await readJsonBody(req);
      const { combinedKoreanText, project, langs, videoContext, apiKey: clientApiKey } = body;
      const apiKey = loadApiKey(clientApiKey);
      const properNounGlossary = loadProperNounGlossary();

      const sessionGlossary = {};
      for (const langOpt of langs || []) {
        const alreadyKnown = [];
        for (const [ko, byLang] of Object.entries(properNounGlossary)) {
          if (ko.startsWith("_")) continue;
          const scope = byLang.project;
          if (scope && scope !== project) continue;
          if (byLang[langOpt.code]) alreadyKnown.push(ko); // 이미 이 언어 표기가 고정된 것만 "이미 안다"고 침
        }
        try {
          const results = await llm.extractSessionGlossary(combinedKoreanText, langOpt.label, apiKey, alreadyKnown, videoContext);
          const map = {};
          for (const r of results) {
            if (r && r.ko && r.translation) map[r.ko] = r.translation;
          }
          sessionGlossary[langOpt.code] = map;
        } catch (e) {
          sessionGlossary[langOpt.code] = {}; // 실패해도 파이프라인 전체를 막지 않고, 이번엔 자동 통일 없이 진행
        }
      }
      return sendJson(res, 200, { sessionGlossary });
    }

    // 고유명사 사전 조회/등록
    if (req.method === "GET" && req.url === "/api/proper-nouns") {
      const data = loadProperNounGlossary();
      const glossary = {};
      for (const [ko, byLang] of Object.entries(data)) {
        if (ko.startsWith("_")) continue;
        glossary[ko] = byLang;
      }
      return sendJson(res, 200, { glossary });
    }
    if (req.method === "POST" && req.url === "/api/proper-nouns/add") {
      const { ko, en, ja, zhCN, project } = await readJsonBody(req);
      if (!ko || !ko.trim()) {
        return sendJson(res, 400, { error: "고유명사(한국어 원어)를 입력해주세요." });
      }
      const p = userDataPath("proper-noun-translations.json");
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const existing = data[ko] || {};
      const merged = {
        en: (en && en.trim()) ? en.trim() : existing.en,
        ja: (ja && ja.trim()) ? ja.trim() : existing.ja,
        "zh-CN": (zhCN && zhCN.trim()) ? zhCN.trim() : existing["zh-CN"],
        project: (project && project.trim()) ? project.trim() : existing.project
      };
      Object.keys(merged).forEach((k) => { if (!merged[k]) delete merged[k]; });
      data[ko] = merged;
      fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      return sendJson(res, 200, { ko, entry: merged });
    }

    // 고유명사 사전에 지금까지 등록된 프로젝트명 목록 (패널의 자동완성용)
    if (req.method === "GET" && req.url === "/api/projects") {
      const data = loadProperNounGlossary();
      const set = new Set();
      for (const [ko, entry] of Object.entries(data)) {
        if (ko.startsWith("_")) continue;
        if (entry && entry.project) set.add(entry.project);
      }
      return sendJson(res, 200, { projects: Array.from(set) });
    }

    // 캡션 파이프라인과 무관한, 업로드된 텍스트 파일(1개 이상) 단독 맞춤법 검사. "바뀐 부분만" 목록으로 반환.
    if (req.method === "POST" && req.url === "/api/spellcheck-text") {
      if (!requireLicense(res)) return;
      const body = await readJsonBody(req);
      const { filePaths, project, videoContext, apiKey: clientApiKey, checkPeriod } = body;
      const paths = Array.isArray(filePaths) ? filePaths : [body.filePath].filter(Boolean);
      const apiKey = loadApiKey(clientApiKey);
      const knownTerms = loadKnownTerms(project);

      const normalize = (s) => (s || "").replace(/\s+/g, " ").trim();

      const fileResults = [];
      for (const filePath of paths) {
        let items;
        try {
          items = parseTimedTextFile(filePath);
        } catch (e) {
          fileResults.push({ filePath, error: "파일을 읽을 수 없습니다: " + e.message, changes: [], totalLines: 0 });
          continue;
        }

        if (items.length === 0) {
          fileResults.push({ filePath, changes: [], totalLines: 0 });
          continue;
        }

        // 같은 텍스트(예: 반복되는 화자 이름표)가 여러 번 나오면, 매번 따로 물어보지 않고
        // 한 번만 검사해서 결과를 재사용한다 (API 호출 절감 + 사소한 표기 흔들림으로 인한
        // 중복 "바뀜" 항목 방지).
        const uniqueTexts = Array.from(new Set(items.map((it) => it.text)));
        const uniqueResults = await llm.checkSpelling(uniqueTexts, apiKey, knownTerms, videoContext, checkPeriod);
        const byText = {};
        uniqueTexts.forEach((t, i) => { byText[t] = uniqueResults[i] || {}; });

        const changes = [];
        for (let i = 0; i < items.length; i++) {
          const orig = items[i].text;
          const timecode = items[i].timecode;
          const r = byText[orig] || {};
          const corrected = (r.correctedText || "").trim();
          if (corrected && normalize(corrected) !== normalize(orig)) {
            changes.push({ line: i + 1, timecode, original: orig, suggested: corrected, reason: r.reason || "맞춤법/문법 교정" });
          } else if (r.flagged && r.reason) {
            changes.push({ line: i + 1, timecode, original: orig, suggested: null, reason: r.reason });
          }
        }
        fileResults.push({ filePath, changes, totalLines: items.length });
      }

      return sendJson(res, 200, { fileResults });
    }

    // 원본(플러그인 결과) vs 완성본(직접 수정한 최종본) 순수 텍스트 비교. Claude 호출 없이
    // 기계적으로 정확한 diff만 보여준다.
    if (req.method === "POST" && req.url === "/api/compare-captions") {
      const body = await readJsonBody(req);
      const { baseFilePaths, targetFilePath, wordLevel } = body;
      const basePaths = Array.isArray(baseFilePaths) ? baseFilePaths : [body.baseFilePath].filter(Boolean);

      let baseItems = [];
      for (const p of basePaths) {
        try {
          baseItems = baseItems.concat(parseTimedTextFile(p));
        } catch (e) {
          return sendJson(res, 400, { error: `원본 파일을 읽을 수 없습니다 (${p}): ` + e.message });
        }
      }
      // 화자별로 나뉜 원본 파일 여러 개를 골랐을 수 있으니, 시간 순서대로 합쳐야 완성본과
      // 순서가 맞아서 diff가 의미 있게 나온다.
      baseItems.sort((a, b) => timecodeToSortKey(a.timecode) - timecodeToSortKey(b.timecode));

      let targetItems;
      try {
        targetItems = parseTimedTextFile(targetFilePath);
      } catch (e) {
        return sendJson(res, 400, { error: "완성본 파일을 읽을 수 없습니다: " + e.message });
      }

      let diffs;
      if (wordLevel) {
        // 컷을 다시 나누거나 합친 경우, 캡션 칸 단위 비교는 재구성 자체가 전부 차이로 잡혀
        // 노이즈가 심하다. 캡션 구성은 무시하고 전체 대사를 이어붙여 단어 단위로 비교하면,
        // 실제 텍스트가 달라진 부분(오타, 단어 교체)만 걸러낼 수 있다.
        const baseWords = baseItems.map((it) => it.text).join(" ").split(/\s+/).filter(Boolean);
        const targetWords = targetItems.map((it) => it.text).join(" ").split(/\s+/).filter(Boolean);
        const ops = diffTextArrays(baseWords, targetWords);
        diffs = buildDiffEntries(ops, baseWords, targetWords, false);
      } else {
        const baseTexts = baseItems.map((it) => it.text);
        const targetTexts = targetItems.map((it) => it.text);
        const ops = diffTextArrays(baseTexts, targetTexts);
        diffs = buildDiffEntries(ops, baseItems, targetItems, true);
      }

      return sendJson(res, 200, { diffs, baseCount: baseItems.length, targetCount: targetItems.length });
    }

    // 용어집 조회/추가/전체삭제
    if (req.method === "GET" && req.url === "/api/known-terms") {
      return sendJson(res, 200, { terms: loadKnownTerms() });
    }
    if (req.method === "POST" && req.url === "/api/known-terms/add") {
      const { term } = await readJsonBody(req);
      const p = userDataPath("known-terms.json");
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!data.terms.includes(term)) data.terms.push(term);
      fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      return sendJson(res, 200, { terms: data.terms });
    }
    // ===== 자동 업데이트 =====
    if (req.method === "GET" && req.url === "/api/version") {
      return sendJson(res, 200, { current: updater.currentVersion().v, lastUpdate: updater.lastStatus() });
    }
    if (req.method === "GET" && req.url.startsWith("/api/update/check")) {
      const force = new URL(req.url, "http://localhost").searchParams.get("force") === "1";
      return sendJson(res, 200, await updater.check(force));
    }
    if (req.method === "POST" && req.url === "/api/update/apply") {
      try {
        return sendJson(res, 200, await updater.apply());
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    // 새 설치 파일이 필요할 때 안내 페이지를 기본 브라우저로 연다 (주소는 고정, 요청에서 받지 않음)
    if (req.method === "POST" && req.url === "/api/open-download-page") {
      openInExplorer([updater.DOWNLOAD_PAGE]);
      return sendJson(res, 200, { ok: true });
    }

    // SRT 파일을 읽어 자막 구간 목록으로 돌려준다 (따로 번역용)
    if (req.method === "POST" && req.url === "/api/parse-srt") {
      const body = await readJsonBody(req);
      const p = typeof body.filePath === "string" ? body.filePath : "";
      if (!p || !/\.srt$/i.test(p) || !fs.existsSync(p)) {
        return sendJson(res, 400, { error: "SRT 파일을 찾을 수 없습니다: " + (p || "(없음)") });
      }
      return sendJson(res, 200, { segments: parseSrtFile(p) });
    }

    // 탐색기에서 자막 파일 위치 열기 (파일이 선택된 상태로). .srt 파일만 허용.
    if (req.method === "POST" && req.url === "/api/reveal") {
      const body = await readJsonBody(req);
      const p = typeof body.path === "string" ? path.normalize(body.path) : "";
      if (!p || !/\.srt$/i.test(p) || !path.isAbsolute(p) || !fs.existsSync(p)) {
        return sendJson(res, 400, { error: "열 수 있는 자막 파일이 아닙니다: " + (body.path || "(없음)") });
      }
      openInExplorer(["/select,", p]);
      return sendJson(res, 200, { ok: true });
    }

    // 탐색기에서 자막 폴더 열기. 경로를 직접 받지 않고 저장 규칙(outputDir)으로 계산한 폴더만 연다.
    if (req.method === "POST" && req.url === "/api/open-output-folder") {
      const body = await readJsonBody(req);
      const dir = outputDir(body.output);
      openInExplorer([dir]);
      return sendJson(res, 200, { ok: true, dir });
    }

    if (req.method === "POST" && req.url === "/api/known-terms/clear") {
      const p = userDataPath("known-terms.json");
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const count = data.terms.length;
      data.terms = [];
      fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
      return sendJson(res, 200, { cleared: count });
    }

    // 안전한 임시 폴더 경로 반환 (UXP 패널은 os.tmpdir()에 접근 못하므로 서버가 대신 알려줌)
    if (req.method === "GET" && req.url.startsWith("/api/temp-path")) {
      const url = new URL(req.url, "http://localhost");
      const name = url.searchParams.get("name") || "temp.wav";
      const tempPath = path.join(require("os").tmpdir(), name);
      return sendJson(res, 200, { path: tempPath });
    }

    sendJson(res, 404, { error: "알 수 없는 경로: " + req.url });
  } catch (e) {
    sendJson(res, 500, { error: e.message, stack: e.stack });
  }
});

// 라이선스가 없어도 서버 자체는 켜진다 (패널이 /api/license로 등록 화면을 보여줘야 하므로).
// 실제 Whisper/ffmpeg/Claude 작업은 requireLicense()가 매 요청마다 막는다.
server.listen(PORT, () => {
  console.log(`=== AutoCaption 로컬 서버 시작됨: http://localhost:${PORT} ===`);
  const r = license.check();
  if (r.ok) {
    console.log(`라이선스: ${r.lic.n} (기기 코드: ${r.deviceCode})${r.lic.e ? " (만료일: " + r.lic.e + ")" : " (무기한)"}`);
  } else {
    console.log(`라이선스: 미등록 (${license.message(r.reason)})`);
    console.log(`이 컴퓨터의 기기 코드: ${r.deviceCode}  ← 관리자에게 전달하고 키를 받아 플러그인 패널에서 등록하세요.`);
  }
  console.log("이 창을 닫지 마세요. 플러그인 쓰는 동안 계속 켜져있어야 합니다.");
});
