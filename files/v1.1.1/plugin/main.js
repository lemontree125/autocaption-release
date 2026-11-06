// main.js - UXP 패널 로직

// UXP에서는 비어 있는 input의 .value가 ""가 아니라 null로 나온다 (UDT 콘솔에서 확인).
// 그래서 .value.trim()을 바로 부르면 "Cannot read properties of null (reading 'trim')"이 난다.
// 입력칸 값은 항상 이 함수로 읽는다.
function textOf(el) { return el ? String(el.value ?? "").trim() : ""; }
function val(id) { return textOf(document.getElementById(id)); }

// 스크립트 맨 위(require 등)에서 뭔가 터지면 라이선스 게이트 화면이
// "확인 중…" 상태로 영원히 멈춰버리고 원인도 안 보였다. 그래서 가장
// 먼저, 어떤 에러든 기기 코드 칸에 직접 찍히게 걸어둔다.
function showBootError(msg) {
  try {
    const el = document.getElementById("licGateDevice");
    if (el) el.textContent = "(초기화 오류: " + msg + ")";
  } catch (e) { /* 무시 */ }
}
window.addEventListener("error", (ev) => {
  showBootError((ev && (ev.message || (ev.error && ev.error.toString()))) || "알 수 없는 오류");
});
window.addEventListener("unhandledrejection", (ev) => {
  showBootError((ev && ev.reason && ev.reason.toString()) || "알 수 없는 오류");
});

let ppro, uxpFs;
try {
  ppro = require("premierepro");
  uxpFs = require("uxp").storage.localFileSystem;
} catch (e) {
  showBootError("premierepro/uxp 모듈 로드 실패: " + e.toString());
  throw e;
}
const SERVER_URL = "http://localhost:8934";

function log(msg) {
  const el = document.getElementById("log");
  el.textContent += msg + "\n";
  el.scrollTop = el.scrollHeight;
}
function setStatus(msg) {
  document.getElementById("status-bar").textContent = msg;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let cancelRequested = false;
class CancelledError extends Error {}

function checkCancelled() {
  if (cancelRequested) throw new CancelledError("사용자가 중단했습니다.");
}

async function getProjectAndSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("활성 프로젝트가 없습니다.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("활성 시퀀스가 없습니다.");
  return { project, sequence };
}

async function loadTracks() {
  const speakerList = document.getElementById("speakerTrackList");
  const clippingList = document.getElementById("clippingTrackList");
  const excludeList = document.getElementById("excludeTrackList");
  try {
    const { sequence } = await getProjectAndSequence();

    // "대상 트랙"(자막 생성 기준 컷 경계)은 더 이상 사람이 직접 고르지 않는다 - runPipeline()이
    // 화자 분리면 각 화자 트랙, 아니면 클립이 있는 오디오 트랙을 자동으로 찾아서 쓴다
    // (autoDetectSourceTrack/getTrackCuts). 여기서는 화자 분리/클리핑 검사용/자동감지 제외용
    // 트랙 체크박스 목록만 채운다.
    const audioCount = await sequence.getAudioTrackCount();
    speakerList.innerHTML = "";
    clippingList.innerHTML = "";
    excludeList.innerHTML = "";
    for (let i = 0; i < audioCount; i++) {
      let name = "A" + (i + 1);
      try {
        const track = await sequence.getAudioTrack(i);
        if (track.name) name = track.name;
      } catch (e) { /* 무시 */ }

      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "speakerTrackOption";
      checkbox.value = i;
      if (i < 2) checkbox.checked = true; // 기본으로 처음 2개 트랙 체크 (흔한 2인 인터뷰 상황)
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(" " + name));
      speakerList.appendChild(label);

      // 클리핑 검사용 트랙 체크박스는 기본 전부 해제(안 건드리면 지금처럼 전체 믹스 기준 검사)
      const clipLabel = document.createElement("label");
      const clipCheckbox = document.createElement("input");
      clipCheckbox.type = "checkbox";
      clipCheckbox.className = "clippingTrackOption";
      clipCheckbox.value = i;
      clipLabel.appendChild(clipCheckbox);
      clipLabel.appendChild(document.createTextNode(" " + name));
      clippingList.appendChild(clipLabel);

      // 자동 감지 제외 트랙: 배경음악처럼 "클립은 있지만 대본으로 쓰면 안 되는" 트랙을
      // 체크해두면, 화자 분리를 안 쓸 때의 자동 감지 대상에서 건너뛴다.
      const excludeLabel = document.createElement("label");
      const excludeCheckbox = document.createElement("input");
      excludeCheckbox.type = "checkbox";
      excludeCheckbox.className = "excludeTrackOption";
      excludeCheckbox.value = i;
      excludeLabel.appendChild(excludeCheckbox);
      excludeLabel.appendChild(document.createTextNode(" " + name));
      excludeList.appendChild(excludeLabel);
    }
    return true;
  } catch (e) {
    return false;
  }
}
async function loadTracksWithRetry(maxRetries, delayMs) {
  for (let i = 0; i < maxRetries; i++) {
    const ok = await loadTracks();
    if (ok) return;
    await sleep(delayMs);
  }
  log("트랙 로드 실패 - ↻ 버튼으로 수동 새로고침해주세요.");
}

// 프리셋 파일 선택 (네이티브 파일 선택창 - 직접 타이핑/오타/실수로 지워질 위험 없음)
let selectedPresetEntry = null; // uxp storage Entry 객체 (nativePath 속성 보유)

function updatePresetDisplay() {
  const display = document.getElementById("presetPathDisplay");
  if (!selectedPresetEntry) {
    display.textContent = "(선택 안 됨)";
  } else if (usingBundledPreset) {
    display.textContent = "기본 프리셋 사용 중 (audio_only) - 다른 걸 쓰려면 직접 선택하세요";
  } else {
    display.textContent = selectedPresetEntry.nativePath;
  }
}

let usingBundledPreset = false; // 사용자가 직접 고른 게 아니라 플러그인에 내장된 기본 프리셋을 쓰는 중인지

async function restoreSettings() {
  // 경로 문자열(nativePath)만 저장해뒀다가 "file:" URL로 다시 열려고 하면
  // UXP 보안 샌드박스가 막아서 매번 실패했었다 - 한 번 고른 파일에 대한
  // "영구 접근 토큰"을 UXP가 공식으로 제공하는데(createPersistentToken /
  // getEntryForPersistentToken), 이걸 저장해둬야 다음에 패널을 열 때도
  // 사용자에게 다시 묻지 않고 같은 파일에 접근할 수 있다.
  const savedToken = localStorage.getItem("autocaption_presetToken");
  if (savedToken) {
    try {
      selectedPresetEntry = await uxpFs.getEntryForPersistentToken(savedToken);
    } catch (e) {
      // 파일이 이동/삭제됐거나 토큰이 만료됐으면 그냥 무시 (다시 선택하면 됨)
      selectedPresetEntry = null;
    }
  }

  // 사용자가 직접 고른 적이 없으면(또는 위에서 실패했으면), 플러그인 안에
  // 미리 넣어둔 기본 프리셋(presets/audio_only.epr)을 자동으로 쓴다 -
  // 파일 선택 버튼이 일부 PC에서 안 열리는 문제와 무관하게 바로 동작하도록.
  if (!selectedPresetEntry) {
    try {
      selectedPresetEntry = await uxpFs.getEntryWithUrl("plugin:/presets/audio_only.epr");
      usingBundledPreset = true;
    } catch (e) {
      // 내장 프리셋도 없으면 그냥 "선택 안 됨" 상태로 둔다 (수동 선택 필요)
    }
  }
  updatePresetDisplay();

  const savedProject = localStorage.getItem("autocaption_projectName");
  if (savedProject) document.getElementById("projectName").value = savedProject;

  const savedApiKey = localStorage.getItem("autocaption_apiKey");
  if (savedApiKey) document.getElementById("claudeApiKey").value = savedApiKey;
}

document.getElementById("claudeApiKey").addEventListener("change", (e) => {
  localStorage.setItem("autocaption_apiKey", textOf(e.target));
});
document.getElementById("btnToggleApiKeyVisibility").addEventListener("click", () => {
  const input = document.getElementById("claudeApiKey");
  input.type = input.type === "password" ? "text" : "password";
});

// 라이선스 삭제: 다른 컴퓨터로 옮기거나 재등록이 필요할 때 사용. 서버에서 license.key
// 파일을 지우고, 패널은 다시 라이선스 등록 화면(initApp)으로 돌아간다.
document.getElementById("btnDeleteLicense").addEventListener("click", async () => {
  const sure = confirm("이 컴퓨터에 등록된 라이선스를 삭제할까요?\n삭제 후에는 라이선스 키를 다시 등록해야 합니다.");
  if (!sure) return;
  try {
    const serverUp = await checkServer();
    if (!serverUp) {
      log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요.");
      return;
    }
    await serverPost("/api/license/delete", {});
    log("✔ 라이선스가 삭제되었습니다. 등록 화면으로 돌아갑니다.");
    initApp();
  } catch (e) {
    log("✘ 라이선스 삭제 실패: " + e.toString());
  }
});

document.getElementById("projectName").addEventListener("change", (e) => {
  localStorage.setItem("autocaption_projectName", textOf(e.target));
});

async function refreshProjectList() {
  try {
    const res = await serverGet("/api/projects");
    const listEl = document.getElementById("projectNameList");
    listEl.innerHTML = "";
    (res.projects || []).forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p;
      listEl.appendChild(opt);
    });
  } catch (e) {
    // 서버가 아직 안 켜져있으면 조용히 무시 (자동완성 목록만 못 채움)
  }
}

document.getElementById("btnPickPreset").addEventListener("click", async () => {
  log("프리셋 파일 선택창을 여는 중... (다른 창 뒤에 숨어있을 수도 있어요)");
  try {
    // .epr 확장자 필터가 윈도우에 등록 안 돼있으면 선택창 자체가 안 뜨는
    // 경우가 있어서, 일단 필터 없이 아무 파일이나 고를 수 있게 둔다
    // (epr이 아닌 파일을 선택해도 나중에 export 시도할 때 실패로 걸러짐).
    const file = await uxpFs.getFileForOpening();
    if (!file) {
      log("프리셋 선택 취소됨.");
      return;
    }
    selectedPresetEntry = file;
    usingBundledPreset = false;
    try {
      const token = await uxpFs.createPersistentToken(file);
      localStorage.setItem("autocaption_presetToken", token);
    } catch (tokenErr) {
      log("⚠ 프리셋을 다음에 자동으로 기억하지는 못하지만, 지금은 정상적으로 쓸 수 있어요: " + tokenErr.toString());
    }
    updatePresetDisplay();
    log("✔ 프리셋 선택됨: " + file.nativePath);
  } catch (e) {
    log("✘ 프리셋 선택 실패: " + e.toString());
  }
});

let selectedSpellcheckFiles = []; // uxp storage Entry 객체 배열

document.getElementById("btnPickSpellcheckFile").addEventListener("click", async () => {
  try {
    const files = await uxpFs.getFileForOpening({ types: ["txt", "srt"], allowMultiple: true });
    if (files) {
      selectedSpellcheckFiles = Array.isArray(files) ? files : [files];
      const display = document.getElementById("spellcheckFilePathDisplay");
      display.textContent = selectedSpellcheckFiles.length
        ? `${selectedSpellcheckFiles.length}개 파일 선택됨: ` + selectedSpellcheckFiles.map((f) => f.name).join(", ")
        : "(선택 안 됨)";
      log(`✔ 맞춤법 검사용 파일 ${selectedSpellcheckFiles.length}개 선택됨: ` + selectedSpellcheckFiles.map((f) => f.nativePath).join(", "));
    }
  } catch (e) {
    log("파일 선택 실패: " + e.toString());
  }
});

document.getElementById("btnRunSpellcheck").addEventListener("click", async () => {
  const resultEl = document.getElementById("spellcheckResult");
  if (!selectedSpellcheckFiles.length) {
    log("✘ 맞춤법 검사할 파일을 먼저 선택해주세요.");
    return;
  }
  const btn = document.getElementById("btnRunSpellcheck");
  btn.disabled = true;
  try {
    const serverUp = await checkServer();
    if (!serverUp) {
      log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요.");
      return;
    }
    const projectName = val("projectName");
    const videoContext = val("videoContext");
    const apiKey = val("claudeApiKey");
    const checkPeriod = document.getElementById("spellcheckCheckPeriod").checked;

    setStatus("맞춤법 검사 중...");
    log(`맞춤법 검사 시작 (${selectedSpellcheckFiles.length}개 파일)`);
    const res = await serverPost("/api/spellcheck-text", {
      filePaths: selectedSpellcheckFiles.map((f) => f.nativePath),
      project: projectName,
      videoContext,
      apiKey,
      checkPeriod
    });

    const parts = [];
    let totalChanges = 0;
    let totalLines = 0;
    for (const fr of res.fileResults) {
      const fileName = fr.filePath.split(/[\\/]/).pop();
      if (fr.error) {
        parts.push(`■ ${fileName}\n✘ ${fr.error}`);
        continue;
      }
      totalLines += fr.totalLines;
      totalChanges += fr.changes.length;
      if (fr.changes.length === 0) {
        parts.push(`■ ${fileName} (${fr.totalLines}줄) — 변경/확인 필요 사항 없음`);
      } else {
        const body = fr.changes.map((c) => {
          const label = c.timecode || `${c.line}줄`;
          if (c.suggested) {
            return `${label}\n${c.original} → ${c.suggested}\n(${c.reason})`;
          }
          return `${label}\n${c.original}\n⚠ 확인 필요: ${c.reason}`;
        }).join("\n\n");
        parts.push(`■ ${fileName} (${fr.totalLines}줄 중 ${fr.changes.length}건)\n\n${body}`);
      }
    }
    resultEl.textContent = parts.join("\n\n---\n\n");
    resultEl.style.display = "";
    setStatus("완료");
    log(`✔ 맞춤법 검사 완료: 총 ${totalLines}줄 중 ${totalChanges}건 발견`);
  } catch (e) {
    log("✘ 맞춤법 검사 실패: " + e.toString());
    setStatus("오류");
  } finally {
    btn.disabled = false;
  }
});

let selectedBaseFiles = [];
let selectedTargetFileEntry = null;

document.getElementById("btnPickBaseFile").addEventListener("click", async () => {
  try {
    const files = await uxpFs.getFileForOpening({ types: ["txt", "srt"], allowMultiple: true });
    if (files) {
      selectedBaseFiles = Array.isArray(files) ? files : [files];
      const display = document.getElementById("baseFilePathDisplay");
      display.textContent = selectedBaseFiles.length
        ? `${selectedBaseFiles.length}개 파일 선택됨: ` + selectedBaseFiles.map((f) => f.name).join(", ")
        : "(선택 안 됨)";
      log(`✔ 원본 파일 ${selectedBaseFiles.length}개 선택됨: ` + selectedBaseFiles.map((f) => f.nativePath).join(", "));
    }
  } catch (e) {
    log("원본 파일 선택 실패: " + e.toString());
  }
});

document.getElementById("btnPickTargetFile").addEventListener("click", async () => {
  try {
    const file = await uxpFs.getFileForOpening({ types: ["txt", "srt"] });
    if (file) {
      selectedTargetFileEntry = file;
      document.getElementById("targetFilePathDisplay").textContent = file.name;
      log("✔ 완성본 파일 선택됨: " + file.nativePath);
    }
  } catch (e) {
    log("완성본 파일 선택 실패: " + e.toString());
  }
});

document.getElementById("btnRunCompare").addEventListener("click", async () => {
  const resultEl = document.getElementById("compareResult");
  if (!selectedBaseFiles.length || !selectedTargetFileEntry) {
    log("✘ 원본(1개 이상)과 완성본 파일을 둘 다 선택해주세요.");
    return;
  }
  const btn = document.getElementById("btnRunCompare");
  btn.disabled = true;
  try {
    const serverUp = await checkServer();
    if (!serverUp) {
      log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요.");
      return;
    }
    setStatus("자막 비교 중...");
    const wordLevel = document.getElementById("compareWordLevel").checked;
    log(`자막 비교 시작 (${wordLevel ? "단어 단위" : "캡션 단위"}): 원본 ${selectedBaseFiles.length}개 (${selectedBaseFiles.map((f) => f.name).join(", ")}) vs ${selectedTargetFileEntry.name}`);
    const res = await serverPost("/api/compare-captions", {
      baseFilePaths: selectedBaseFiles.map((f) => f.nativePath),
      targetFilePath: selectedTargetFileEntry.nativePath,
      wordLevel
    });

    if (!res.diffs || res.diffs.length === 0) {
      resultEl.textContent = `원본 ${res.baseCount}줄 / 완성본 ${res.targetCount}줄 — 차이 없음`;
    } else {
      resultEl.textContent = `원본 ${res.baseCount}줄 / 완성본 ${res.targetCount}줄 중 ${res.diffs.length}건 차이:\n\n` +
        res.diffs.map((d) => {
          const label = d.baseTimecode || d.targetTimecode || "";
          const prefix = label ? label + "\n" : "";
          if (d.type === "changed") {
            return `${prefix}- ${d.baseText}\n+ ${d.targetText}`;
          }
          if (d.type === "removed") {
            return `${prefix}- ${d.baseText}  (완성본에서 삭제됨)`;
          }
          return `${prefix}+ ${d.targetText}  (완성본에서 새로 추가됨)`;
        }).join("\n\n");
    }
    resultEl.style.display = "";
    setStatus("완료");
    log(`✔ 자막 비교 완료: ${res.diffs ? res.diffs.length : 0}건 차이 발견`);
  } catch (e) {
    log("✘ 자막 비교 실패: " + e.toString());
    setStatus("오류");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnCopySpellcheckResult").addEventListener("click", async () => {
  try {
    await navigator.clipboard.setContent({ "text/plain": document.getElementById("spellcheckResult").textContent });
    setStatus("맞춤법 검사 결과가 클립보드에 복사되었습니다.");
  } catch (e) {
    log("복사 실패: " + e.toString());
  }
});

document.getElementById("btnCopyCompareResult").addEventListener("click", async () => {
  try {
    await navigator.clipboard.setContent({ "text/plain": document.getElementById("compareResult").textContent });
    setStatus("자막 비교 결과가 클립보드에 복사되었습니다.");
  } catch (e) {
    log("복사 실패: " + e.toString());
  }
});

async function serverPost(pathName, body) {
  const res = await fetch(SERVER_URL + pathName, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`서버 오류(${res.status}): ${errBody}`);
  }
  return res.json();
}
async function serverGet(pathName) {
  const res = await fetch(SERVER_URL + pathName);
  if (!res.ok) throw new Error(`서버 오류(${res.status})`);
  return res.json();
}

async function checkServer() {
  try {
    const res = await fetch(SERVER_URL + "/ping");
    return res.ok;
  } catch (e) {
    return false;
  }
}

// ===== 자막 저장 위치 / Auto Caption bin / 파일 위치 열기 (v1.1.0) =====
const CAPTION_BIN_NAME = "Auto Caption";
let lastSrtPath = null;

// 서버가 저장 위치와 파일 이름을 정할 때 쓰는 정보. speakerNum은 화자 분리 모드에서만 넣는다.
function outputInfo(opts, speakerNum) {
  return {
    projectFilePath: opts.projectFilePath || "",
    outputName: opts.projectName || "",
    speakerNum: speakerNum || null
  };
}

function speakerNumFromSuffix(fileSuffix) {
  const m = /^_(\d+)$/.exec(fileSuffix || "");
  return m ? Number(m[1]) : null;
}

// 프로젝트 루트에서 "Auto Caption" bin을 찾고, 없으면 만든다. 실패하면 루트에 넣는다.
async function getCaptionBin(project) {
  const root = await project.getRootItem();
  async function findBin() {
    const items = await root.getItems();
    for (const it of items) {
      if (!it || it.name !== CAPTION_BIN_NAME) continue;
      try {
        const folder = ppro.FolderItem.cast(it);
        if (folder && typeof folder.getItems === "function") return folder;
      } catch (e) {
        // bin이 아닌 같은 이름의 항목이면 건너뛴다
      }
    }
    return null;
  }
  try {
    let bin = await findBin();
    if (bin) return bin;
    // create*Action()은 반드시 lockedAccess/executeTransaction 콜백 안에서 만들어야 한다 (마커 코드와 같은 규칙).
    project.lockedAccess(() => {
      project.executeTransaction((compoundAction) => {
        compoundAction.addAction(root.createBinAction(CAPTION_BIN_NAME, false));
      }, "AutoCaption: Auto Caption bin 만들기");
    });
    bin = await findBin();
    if (bin) return bin;
    log(`⚠ "${CAPTION_BIN_NAME}" bin을 만들지 못해 프로젝트 맨 위에 가져옵니다.`);
  } catch (e) {
    log(`⚠ "${CAPTION_BIN_NAME}" bin 준비 실패, 프로젝트 맨 위에 가져옵니다: ` + e.toString());
  }
  return root;
}

async function importCaptionFile(project, srtPath) {
  const bin = await getCaptionBin(project);
  await project.importFiles([srtPath], true, bin, false);
  lastSrtPath = srtPath;
  document.getElementById("btnRevealLast").hidden = false;
}

async function currentOutputInfoForFolder() {
  let projectFilePath = "";
  try {
    const project = await ppro.Project.getActiveProject();
    if (project) projectFilePath = project.path || "";
  } catch (e) {
    // 열린 프로젝트가 없으면 문서\AutoCaption 쪽 폴더를 연다
  }
  return { projectFilePath, outputName: val("projectName"), speakerNum: null };
}

document.getElementById("btnRevealLast").addEventListener("click", async () => {
  if (!lastSrtPath) return;
  try {
    await serverPost("/api/reveal", { path: lastSrtPath });
  } catch (e) {
    log("✘ 파일 위치 열기 실패: " + e.toString());
  }
});

document.getElementById("btnOpenOutputFolder").addEventListener("click", async () => {
  try {
    const r = await serverPost("/api/open-output-folder", { output: await currentOutputInfoForFolder() });
    log("📂 자막 폴더: " + r.dir);
  } catch (e) {
    log("✘ 자막 폴더 열기 실패: " + e.toString());
  }
});

async function createColoredMarkers(project, sequence, items) {
  // items: [{startSec, name, comment, colorIndex}]
  if (!items.length) return;
  const markers = await ppro.Markers.getMarkers(sequence);

  // 클리핑 검사처럼 같은 시퀀스에 반복해서 돌리면, 예전 실행에서 남은 마커와 이번에 새로
  // 만드는 마커가 이름도 시간도 거의 똑같을 수 있다(같은 오디오를 같은 방식으로 또 검사하니까).
  // 그래서 추가하기 "직전"의 마커 guid를 미리 기억해두고, 추가 "직후"에 이전엔 없던(guid가
  // 새로운) 마커만 색칠 대상으로 좁힌다 - 이름/시간이 겹쳐도 진짜 새로 만든 것만 정확히 구분된다.
  let beforeGuids = null;
  try {
    const beforeMarkers = await markers.getMarkers();
    beforeGuids = new Set();
    for (const m of beforeMarkers) {
      if (m.guid) beforeGuids.add(m.guid.toString());
    }
  } catch (e) {
    beforeGuids = null; // guid 미지원 버전이면 이후 이름+시간 매칭으로만 폴백
  }

  // 마커 추가를 전부 하나의 트랜잭션으로 묶는다. 마커 개수만큼(예: 200개) Premiere에
  // 개별 트랜잭션을 수백 번 날리면 부담이 커서, 한 번의 트랜잭션에 다 담아 보낸다.
  // 주의: lockedAccess/executeTransaction 콜백 안에서는 await를 쓰면 안 되고(Adobe 공식
  // 권장사항), create*Action()도 반드시 이 콜백 "안에서" 호출해야 한다 - 밖에서 만들어서
  // 나중에 추가하면 조용히 무시될 수 있다.
  try {
    project.lockedAccess(() => {
      project.executeTransaction((compoundAction) => {
        for (const it of items) {
          const addAction = markers.createAddMarkerAction(
            it.name,
            ppro.Marker.MARKER_TYPE_COMMENT,
            ppro.TickTime.createWithSeconds(it.startSec),
            ppro.TickTime.TIME_ZERO,
            it.comment
          );
          compoundAction.addAction(addAction);
        }
      });
    });
  } catch (e) {
    log(`마커 일괄 생성 실패: ` + e.toString());
    return;
  }

  // 색상 지정: 어떤 마커에 어떤 색을 입힐지 "판단"하는 비동기 작업(getStart/getName 등)은
  // 먼저 다 끝내서 순수 데이터로만 뽑아두고, 실제 createSetColorByIndexAction() 호출과
  // addAction()은 반드시 같은 lockedAccess/executeTransaction 콜백 "안에서" 동기적으로 한다.
  try {
    const allMarkers = await markers.getMarkers();
    let candidates = allMarkers;
    if (beforeGuids) {
      const fresh = [];
      for (const m of allMarkers) {
        if (m.guid && !beforeGuids.has(m.guid.toString())) fresh.push(m);
      }
      if (fresh.length) candidates = fresh; // 새로 생긴 마커가 잡히면 그것만 후보로 좁힌다
    }

    const usedItemIdx = new Set(); // 같은 item이 두 후보에 중복 매칭되는 걸 막는 안전장치
    const matchedMarkers = []; // [{marker, colorIndex}] - 여기까진 전부 비동기(await) 가능한 영역
    for (const m of candidates) {
      const st = await m.getStart();
      const nm = await m.getName();
      const matchIdx = items.findIndex((it, idx) =>
        !usedItemIdx.has(idx) && Math.abs(it.startSec - st.seconds) < 0.01 && it.name === nm);
      if (matchIdx !== -1) {
        usedItemIdx.add(matchIdx);
        matchedMarkers.push({ marker: m, colorIndex: items[matchIdx].colorIndex });
      }
    }

    if (matchedMarkers.length) {
      project.lockedAccess(() => {
        project.executeTransaction((compoundAction) => {
          for (const { marker, colorIndex } of matchedMarkers) {
            const colorAction = marker.createSetColorByIndexAction(colorIndex);
            compoundAction.addAction(colorAction);
          }
        });
      });
    }
  } catch (e) {
    log("마커 색상 지정 중 일부 실패: " + e.toString());
  }
}

function getSelectedTranslationLangs() {
  return Array.from(document.querySelectorAll(".translateLangOption:checked")).map(cb => ({
    code: cb.value,
    label: cb.dataset.label
  }));
}

// 파이프라인 실행 중(특히 화자 3명 + 번역까지 돌면 꽤 오래 걸림) 사용자가 다른 시퀀스 탭으로
// 전환하면, project.importFiles()의 자동 캡션 트랙 생성은 스크립트가 들고 있는 sequence 객체가
// 아니라 "그 순간 Premiere에서 실제로 활성화된 시퀀스"를 기준으로 동작한다. 그래서 뒤늦게 끝난
// import가 엉뚱한 시퀀스로 들어가는 문제가 생길 수 있음 — import/export 직전마다 활성 시퀀스가
// 원래 시퀀스와 같은지 확인하고, 다르면 강제로 되돌린다.
async function ensureCorrectSequenceActive(project, targetSequence, markerPrefix) {
  const current = await project.getActiveSequence();
  const currentGuid = current ? String(current.guid) : null;
  const targetGuid = String(targetSequence.guid);
  if (currentGuid === targetGuid) return;

  log(`${markerPrefix || ""}⚠ 활성 시퀀스가 작업 시작 시점과 달라짐 (현재: "${current ? current.name : "없음"}") — 원래 시퀀스("${targetSequence.name}")로 되돌립니다.`);
  const ok = await project.setActiveSequence(targetSequence);
  if (!ok) {
    throw new Error(`활성 시퀀스를 원래 시퀀스("${targetSequence.name}")로 되돌리지 못했습니다. 작업 도중에는 다른 시퀀스로 전환하지 마세요.`);
  }
}

async function pollJob(jobId, onProgress) {
  while (true) {
    checkCancelled();
    await sleep(1000);
    checkCancelled();
    const job = await serverGet("/api/job-status?id=" + jobId);
    if (job.status === "running") {
      onProgress(job.progress || {});
    } else if (job.status === "done") {
      return job.result;
    } else if (job.status === "error") {
      throw new Error("서버 작업 실패: " + job.error);
    }
  }
}

async function recognizeAndCorrect(project, sequence, cuts, audioPath, opts) {
  const { lang, useAiCorrection, usePeriod, paddingCount, markerColor, fileSuffix, markerPrefix, filterSilent, projectName, videoContext, apiKey, compoundSpacing } = opts;

  setStatus(`${markerPrefix}음성 인식 + AI 교정 시작...`);
  const speakerNum = speakerNumFromSuffix(fileSuffix);
  const startRes = await serverPost("/api/transcribe-and-correct/start", {
    audioPath, cuts, lang, useAiCorrection, usePeriod, paddingCount, fileSuffix,
    project: projectName, videoContext, apiKey, compoundSpacing,
    output: outputInfo(opts, speakerNum), writeSrt: !filterSilent,
    detectSilence: true, silenceThresholdDb: filterSilent ? -40 : -50
  });
  let result = await pollJob(startRes.jobId, (p) => {
    setStatus(`${markerPrefix}${p.phase || "처리 중"}... (${p.done || 0}/${p.total || "?"})`);
  });
  let processed = result.segments;
  if (result.correctionError) {
    log(`${markerPrefix}⚠ AI 문맥 교정 실패 (Whisper 원본 텍스트로 진행됨): ` + result.correctionError);
  }

  if (filterSilent) {
    const before = processed.length;
    processed = processed.filter(s => s.text && s.text.trim().length >= 1);
    log(`${markerPrefix}이 화자가 말한 구간만 남김: ${before}개 → ${processed.length}개`);
    if (processed.length === 0) {
      log(`${markerPrefix}이 화자가 말한 구간이 없어서 자막을 생성하지 않습니다.`);
      return null;
    }
    // 무음 필터링 후 SRT를 다시 만들어야 함 (서버가 필터 전 기준으로 이미 만들어둔 SRT는 못 씀)
    // -> 서버에 다시 요청하지 않고, 클라이언트에서 필터링된 세그먼트로 새 SRT 경로를 받기 위해
    //    재구성 요청을 보낸다.
    const rebuildRes = await serverPost("/api/rebuild-srt", { segments: processed, lang, output: outputInfo(opts, speakerNum) });
    result = { ...result, srtPath: rebuildRes.srtPath };
  }

  log(`--- ${markerPrefix}인식 결과 ---`);
  processed.forEach(s => log(`[${s.startSec.toFixed(2)}~${s.endSec.toFixed(2)}] ${s.text}${s.needsReview ? "  ⚠ 확인 필요 (" + (s.reason || "") + ")" : ""}`));

  const flagged = processed.filter(s => s.needsReview);
  if (flagged.length) {
    setStatus(`${markerPrefix}마커 생성 중...`);
    const flagItems = flagged.map(s => ({
      startSec: s.startSec,
      name: `${markerPrefix}자막 확인 필요`,
      // 반복 제거 마커는 AI 교정과 상관없으므로 "AI 교정" 문구를 붙이지 않는다 (잘못 지웠으면 이 구절을 되살리면 됨).
      comment: !s.reason ? `인식 신뢰도 낮음: "${s.text}"`
        : s.reason.startsWith("반복 제거됨") ? `${s.reason} (일부러 반복한 말이면 이 구절을 다시 넣어 주세요)`
        : `AI 교정 확인 필요: ${s.reason}`,
      colorIndex: markerColor
    }));
    await createColoredMarkers(project, sequence, flagItems);
    log(`${markerPrefix}✔ ${flagged.length}개 구간에 마커 생성 완료`);
  }

  setStatus(`${markerPrefix}자막 import 중...`);
  await ensureCorrectSequenceActive(project, sequence, markerPrefix);
  await importCaptionFile(project, result.srtPath);
  log(`${markerPrefix}✔ 자막 저장 + import 완료 (${CAPTION_BIN_NAME} bin): ` + result.srtPath);

  return { processed, fileSuffix, markerPrefix };
}

// 화자 여러 명(또는 소스 여러 개)의 대본을 전부 합쳐서, 번역 시작 전에 딱 한 번 Claude에게
// "이 영상 전체에서 일관되게 써야 할 고유명사"를 뽑아달라고 요청한다. 이 결과를 모든
// 화자/언어의 번역 요청에 공통으로 끼워 넣으면, 화자별로 번역이 따로 돌면서 같은 단어가
// 서로 다르게 번역되는 문제를 등록 없이도 이번 영상 안에서는 방지할 수 있다.
async function buildSessionGlossary(sources, translationLangs, opts) {
  if (!translationLangs.length || !sources.length) return {};
  const combinedKoreanText = sources.map(s => s.processed.map(seg => seg.text).join("\n")).join("\n");
  try {
    const res = await serverPost("/api/build-session-glossary", {
      combinedKoreanText,
      project: opts.projectName,
      videoContext: opts.videoContext,
      apiKey: opts.apiKey,
      langs: translationLangs.map(l => ({ code: l.code, label: l.label }))
    });
    const sessionGlossary = res.sessionGlossary || {};
    for (const [code, map] of Object.entries(sessionGlossary)) {
      const entries = Object.entries(map);
      if (entries.length) {
        log(`ℹ 이번 영상에서 새로 감지되어 통일한 고유명사(${code}): ` + entries.map(([ko, tr]) => `${ko}→${tr}`).join(", "));
      }
    }
    if (Object.values(sessionGlossary).some(m => Object.keys(m).length)) {
      log("ℹ 위 표기들은 이번 영상 안에서만 통일됩니다. 다음 영상에서도 계속 고정하고 싶으면 \"고유명사 사전 관리\"에서 직접 등록해두세요.");
    }
    return sessionGlossary;
  } catch (e) {
    log("⚠ 번역 일관성 사전 정리(세션 글로서리) 실패 - 자동 통일 없이 번역을 진행합니다: " + e.toString());
    return {};
  }
}

async function translateAndImport(project, sequence, processed, opts, sessionGlossary) {
  const { fileSuffix, markerPrefix, projectName, videoContext, apiKey } = opts;
  const translationLangs = getSelectedTranslationLangs();
  const stripPunctuation = document.getElementById("translateStripPunct").checked;
  for (const langOpt of translationLangs) {
    checkCancelled();
    setStatus(`${markerPrefix}${langOpt.label} 번역 중...`);
    try {
      const translateRes = await serverPost("/api/translate", {
        segments: processed,
        targetLangLabel: langOpt.label,
        targetLangCode: langOpt.code,
        paddingCount: 0,
        fileSuffix,
        output: outputInfo(opts, opts.speakerNum != null ? opts.speakerNum : speakerNumFromSuffix(fileSuffix)),
        project: projectName,
        videoContext,
        apiKey,
        stripPunctuation,
        sessionGlossary: sessionGlossary ? sessionGlossary[langOpt.code] : undefined
      });
      if (translateRes.emptyCount > 0) {
        log(`${markerPrefix}⚠ ${langOpt.label} 번역: 빈 텍스트로 제외된 구간 ${translateRes.emptyCount}개`);
      }
      // 따로 번역(SRT 파일)에서 "Premiere로 가져오기"를 끄면 파일 저장만 한다.
      if (opts.importResult === false || !project) {
        lastSrtPath = translateRes.srtPath;
        document.getElementById("btnRevealLast").hidden = false;
        log(`${markerPrefix}✔ ${langOpt.label} 번역 자막 저장 완료: ` + translateRes.srtPath);
        continue;
      }
      if (sequence) await ensureCorrectSequenceActive(project, sequence, markerPrefix);
      await importCaptionFile(project, translateRes.srtPath);
      log(`${markerPrefix}✔ ${langOpt.label} 번역 자막 저장 + import 완료: ` + translateRes.srtPath);
    } catch (e) {
      log(`${markerPrefix}✘ ${langOpt.label} 번역 실패: ` + e.toString());
    }
  }
}

// ===== 따로 번역: 이미 만든(또는 직접 고친) SRT 파일을 골라 번역 (v1.1.0) =====
let selectedTranslateFiles = [];

document.getElementById("btnPickTranslateFiles").addEventListener("click", async () => {
  try {
    const files = await uxpFs.getFileForOpening({ types: ["srt"], allowMultiple: true });
    if (files) {
      selectedTranslateFiles = Array.isArray(files) ? files : [files];
      document.getElementById("translateFilesDisplay").textContent = selectedTranslateFiles.length
        ? `${selectedTranslateFiles.length}개 파일 선택됨: ` + selectedTranslateFiles.map((f) => f.name).join(", ")
        : "(선택 안 됨)";
      log(`✔ 번역할 SRT ${selectedTranslateFiles.length}개 선택됨: ` + selectedTranslateFiles.map((f) => f.nativePath).join(", "));
    }
  } catch (e) {
    log("파일 선택 실패: " + e.toString());
  }
});

document.getElementById("btnRunTranslateFiles").addEventListener("click", async () => {
  const btn = document.getElementById("btnRunTranslateFiles");
  if (!selectedTranslateFiles.length) { log("✘ 번역할 SRT 파일을 먼저 선택해주세요."); return; }
  if (!hasApiKey()) { log("✘ 번역에는 Claude API 키가 필요합니다. \"API 키\" 탭에 키를 넣어주세요."); return; }
  const langs = getSelectedTranslationLangs();
  if (!langs.length) { log("✘ 위에서 번역할 언어를 하나 이상 체크해주세요."); return; }

  btn.disabled = true;
  cancelRequested = false;
  try {
    if (!(await checkServer())) {
      log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요.");
      return;
    }
    const importResult = document.getElementById("translateImportToggle").checked;
    let project = null;
    let sequence = null;
    try {
      project = await ppro.Project.getActiveProject();
      if (project) sequence = await project.getActiveSequence();
    } catch (e) {
      // 열린 프로젝트가 없어도 파일 저장은 할 수 있다
    }
    if (importResult && !project) log("⚠ 열린 Premiere 프로젝트가 없어 가져오기 없이 파일만 저장합니다.");

    const opts = {
      projectName: val("projectName"),
      videoContext: val("videoContext"),
      apiKey: val("claudeApiKey"),
      projectFilePath: project ? (project.path || "") : "",
      importResult,
      fileSuffix: "",
      markerPrefix: ""
    };

    log(`=== 따로 번역 시작: 파일 ${selectedTranslateFiles.length}개 × ${langs.map((l) => l.label).join(", ")} ===`);
    for (const file of selectedTranslateFiles) {
      const prefix = `[${file.name}] `;
      setStatus(`${prefix}읽는 중...`);
      let segments;
      try {
        segments = (await serverPost("/api/parse-srt", { filePath: file.nativePath })).segments;
      } catch (e) {
        log(`${prefix}✘ SRT 읽기 실패: ` + e.toString());
        continue;
      }
      if (!segments.length) { log(`${prefix}✘ 자막이 하나도 없는 파일입니다.`); continue; }
      log(`${prefix}자막 ${segments.length}개 읽음`);
      // 원본 파일 이름에 _화자N_이 있으면 번역 파일 이름에도 그대로 붙인다.
      const m = /_화자(\d+)_/.exec(file.name);
      const fileOpts = { ...opts, markerPrefix: prefix, speakerNum: m ? Number(m[1]) : null };
      const sessionGlossary = await buildSessionGlossary([{ processed: segments }], langs, fileOpts);
      await translateAndImport(project, sequence, segments, fileOpts, sessionGlossary);
    }
    setStatus("완료");
    log("=== 따로 번역 완료 ===");
  } catch (e) {
    log("✘ 따로 번역 실패: " + e.toString());
    setStatus("실패");
  } finally {
    btn.disabled = false;
  }
});

async function detectAndMarkClipping(project, sequence, audioPath, totalDuration, includeWarn, markerPrefix) {
  checkCancelled();
  setStatus(`${markerPrefix}오디오 레벨 검사 시작...`);
  const clipStartRes = await serverPost("/api/detect-clipping/start", {
    // 경고(-1dB) 체크박스가 꺼져 있으면 warnDb를 도달 불가능한 값으로 둬서, "경고"로
    // 분류될 구간 자체가 안 생기게 한다 (0dB 근접만 잡힘).
    audioPath, totalDurationSec: totalDuration, windowSec: 1, warnDb: includeWarn ? -1 : 999, clipDb: 0
  });
  const clipResult = await pollJob(clipStartRes.jobId, (p) => {
    setStatus(`${markerPrefix}오디오 레벨 검사 중... (${p.done || 0}/${p.total || "?"})`);
  });
  const events = clipResult.events;
  const clipCount = events.filter(e => e.level === "clip").length;
  const warnCount = events.filter(e => e.level === "warn").length;
  log(`${markerPrefix}오디오 레벨 검사 완료: 0dB 근접 ${clipCount}개, -1dB 근접 ${warnCount}개 (실제 클리핑 여부는 직접 확인 필요)`);
  if (events.length) {
    events.forEach(e => {
      log(`${markerPrefix}  ${e.startSec.toFixed(2)}~${e.endSec.toFixed(2)}초 (${e.level}, max: ${e.maxDb?.toFixed?.(2)}dB)`);
    });
    const clipItems = events.map(e => ({
      startSec: e.startSec,
      name: `${markerPrefix}⚠ 오디오 레벨 확인 필요`,
      comment: `${e.startSec.toFixed(2)}~${e.endSec.toFixed(2)}초, 순간 최대 음량 ${e.maxDb?.toFixed?.(2)}dB (${e.level === "clip" ? "0dB" : "-1dB"} 근접 - 실제로 찌그러지는지 직접 들어보고 확인 필요)`,
      colorIndex: e.level === "clip" ? 1 : 3
    }));
    await createColoredMarkers(project, sequence, clipItems);
    log(`${markerPrefix}✔ ${events.length}개 구간에 오디오 레벨 마커 생성 완료`);
  }
  return { clipCount, warnCount };
}

// 오디오 트랙 하나의 클립들을 "컷(컷 경계)" 배열로 변환.
async function getTrackCuts(track) {
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const cuts = [];
  for (let i = 0; i < items.length; i++) {
    const startTick = await items[i].getStartTime();
    const endTick = await items[i].getEndTime();
    let name = "clip" + i;
    try { name = await items[i].getName(); } catch (e) { /* 무시 */ }
    cuts.push({ index: i, name, startSec: startTick.seconds, endSec: endTick.seconds });
  }
  return cuts;
}

// 화자 분리를 안 쓸 때는 "대상 트랙"을 사람이 직접 고르지 않고, 클립이 실제로 있는
// 첫 오디오 트랙을 자동으로 찾아서 쓴다 - 나레이션을 몇 번 트랙에 얹었든 매번 트랙을
// 바꿔 선택할 필요가 없도록. excludeIndices에 들어있는 트랙(배경음악 등 - 클립은 있지만
// 대본으로 쓰면 안 되는 트랙)은 자동 감지 대상에서 건너뛴다.
async function autoDetectSourceTrack(sequence, excludeIndices) {
  const exclude = excludeIndices instanceof Set ? excludeIndices : new Set(excludeIndices || []);
  const audioCount = await sequence.getAudioTrackCount();
  for (let i = 0; i < audioCount; i++) {
    if (exclude.has(i)) continue;
    const track = await sequence.getAudioTrack(i);
    const cuts = await getTrackCuts(track);
    if (cuts.length > 0) {
      let name = "A" + (i + 1);
      try { if (track.name) name = track.name; } catch (e) { /* 무시 */ }
      return { trackIndex: i, name, cuts };
    }
  }
  return null;
}

async function runClippingOnly() {
  cancelRequested = false;
  document.getElementById("btnStart").style.display = "none";
  document.getElementById("btnClippingOnly").disabled = true;
  document.getElementById("btnStop").style.display = "";

  try {
    const serverUp = await checkServer();
    if (!serverUp) {
      log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요.");
      return;
    }
    if (!selectedPresetEntry) {
      log("✘ 오디오 전용 export 프리셋(.epr) 파일을 먼저 선택해주세요.");
      return;
    }
    const presetPath = selectedPresetEntry.nativePath;
    const includeWarn = document.getElementById("clippingIncludeWarn").checked;

    setStatus("시퀀스 길이 확인 중...");
    const { project, sequence } = await getProjectAndSequence();
    const endTime = await sequence.getEndTime();
    const totalDuration = endTime.seconds;
    if (!totalDuration || totalDuration <= 0) {
      log("✘ 시퀀스 길이를 확인할 수 없습니다.");
      setStatus("실패");
      return;
    }

    const encoder = await ppro.EncoderManager.getManager();
    if (!encoder.isAMEInstalled) {
      log("✘ Adobe Media Encoder가 설치되어 있지 않습니다.");
      setStatus("실패");
      return;
    }

    const trackIndices = Array.from(document.querySelectorAll(".clippingTrackOption:checked")).map(cb => Number(cb.value));

    if (trackIndices.length === 0) {
      // 트랙 선택 없음 - 기존 방식대로 전체 믹스 기준 한 번만 검사
      setStatus("오디오 추출 중...");
      const tempPathRes = await serverGet("/api/temp-path?name=autocaption_uxp_mixdown_clipcheck.wav");
      const audioPath = tempPathRes.path;
      await ensureCorrectSequenceActive(project, sequence, "");
      const exportOk = await encoder.exportSequence(sequence, ppro.Constants.ExportType.IMMEDIATELY, audioPath, presetPath);
      if (!exportOk) { log("✘ 오디오 export 실패"); setStatus("실패"); return; }
      log("✔ 오디오 추출 완료: " + audioPath);
      await detectAndMarkClipping(project, sequence, audioPath, totalDuration, includeWarn, "");
    } else {
      // 트랙 선택됨 - 각 트랙을 솔로로 따로 뽑아서 각각 검사 (여러 트랙이 동시에 소리 날 때
      // 합쳐진 레벨로 오탐 나는 것을 방지)
      log(`트랙별 검사 모드: ${trackIndices.length}개 트랙 선택됨 (오디오 트랙 ${trackIndices.join(", ")})`);
      const audioTrackCount = await sequence.getAudioTrackCount();
      const audioTracks = [];
      const originalMutes = [];
      for (let i = 0; i < audioTrackCount; i++) {
        const t = await sequence.getAudioTrack(i);
        audioTracks.push(t);
        originalMutes.push(await t.isMuted());
      }

      let trackNum = 1;
      for (const trackIdx of trackIndices) {
        checkCancelled();
        const markerPrefix = `[A${trackIdx + 1}] `;
        setStatus(`${markerPrefix}오디오 트랙 음소거 설정 중...`);
        for (let i = 0; i < audioTracks.length; i++) {
          await audioTracks[i].setMute(i !== trackIdx);
        }
        const soloAudioPath = (await serverGet(`/api/temp-path?name=autocaption_uxp_mixdown_clipcheck_${trackNum}.wav`)).path;
        await ensureCorrectSequenceActive(project, sequence, markerPrefix);
        const exportOk = await encoder.exportSequence(sequence, ppro.Constants.ExportType.IMMEDIATELY, soloAudioPath, presetPath);
        if (!exportOk) { log(`${markerPrefix}✘ 오디오 export 실패`); trackNum++; continue; }
        log(`${markerPrefix}✔ 오디오 추출 완료: ` + soloAudioPath);
        await detectAndMarkClipping(project, sequence, soloAudioPath, totalDuration, includeWarn, markerPrefix);
        trackNum++;
      }

      for (let i = 0; i < audioTracks.length; i++) {
        await audioTracks[i].setMute(originalMutes[i]);
      }
      log("✔ 오디오 트랙 음소거 상태 원상복구 완료");
    }

    setStatus("완료");
    log("=== 클리핑 검사만 완료 ===");
  } catch (e) {
    if (e instanceof CancelledError) {
      log("■ 사용자에 의해 중단되었습니다.");
      setStatus("중단됨");
    } else {
      log("✘ 치명적 오류: " + e.toString());
      setStatus("오류");
    }
  } finally {
    document.getElementById("btnStart").style.display = "";
    document.getElementById("btnClippingOnly").disabled = false;
    document.getElementById("btnStop").style.display = "none";
  }
}

async function runPipeline() {
  cancelRequested = false;
  document.getElementById("btnStart").style.display = "none";
  document.getElementById("btnStop").style.display = "";

  try {
    const serverUp = await checkServer();
    if (!serverUp) {
      log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요.");
      setStatus("서버 연결 실패");
      return;
    }

    if (!selectedPresetEntry) {
      log("✘ 오디오 전용 export 프리셋(.epr) 파일을 먼저 선택해주세요.");
      return;
    }
    const presetPath = selectedPresetEntry.nativePath;

    const lang = document.getElementById("srcLang").value;
    const projectName = val("projectName");
    const videoContext = val("videoContext");
    const apiKey = val("claudeApiKey");
    const noApiMode = !hasApiKey();
    if (noApiMode) {
      log("ℹ API 키 없이 자막만 만듭니다 (AI 교정·번역 없음, 무료).");
    }
    const usePeriod = false; // 문장부호 기능 포기 (Premiere가 caption import 시 지워버림)
    const paddingCount = 0; // 공백 패딩 기능 포기 (Premiere가 트림하거나 깨진 글자로 표시됨)
    const useAiCorrection = !noApiMode && document.getElementById("aiCorrectionToggle").checked;
    const compoundSpacing = document.getElementById("compoundSpacingToggle").checked;
    const markerColor = Number(document.getElementById("markerColor").value);
    const speakerSeparation = document.getElementById("speakerSeparationToggle").checked;

    setStatus("시퀀스 확인 중...");
    const { project, sequence } = await getProjectAndSequence();

    // Premiere UXP API는 캡션 트랙을 스크립트로 삭제하는 기능을 제공하지 않는다(공식 확인됨).
    // 자동 정리는 못 해도, 이미 캡션 트랙이 있으면 최소한 경고는 띄워서 옛날 테스트 트랙과
    // 헷갈리지 않게 한다.
    try {
      const captionCount = await sequence.getCaptionTrackCount();
      if (captionCount > 0) {
        const names = [];
        for (let i = 0; i < captionCount; i++) {
          try {
            const ct = await sequence.getCaptionTrack(i);
            names.push(ct.name || `캡션 트랙 ${i + 1}`);
          } catch (e) {
            names.push(`캡션 트랙 ${i + 1}`);
          }
        }
        log(`⚠ 이 시퀀스에 이미 캡션 트랙이 ${captionCount}개 있습니다: ${names.join(", ")}`);
        log("⚠ Premiere UXP API는 캡션 트랙 삭제를 지원하지 않아 자동 정리가 불가능합니다. 이전 테스트 트랙이 섞여 보이면 시작 전에 타임라인에서 직접 지워주세요.");
      }
    } catch (e) {
      // 구버전 Premiere 등으로 getCaptionTrackCount를 지원하지 않으면 조용히 무시
    }

    const encoder = await ppro.EncoderManager.getManager();
    if (!encoder.isAMEInstalled) { log("✘ Adobe Media Encoder가 설치되어 있지 않습니다."); setStatus("실패"); return; }

    const projectFilePath = project.path || "";
    const commonOpts = { lang, useAiCorrection, usePeriod, paddingCount, markerColor, projectName, videoContext, apiKey, compoundSpacing, projectFilePath };
    // "인식할 때 같이 번역"을 끄면 언어를 체크해 둬도 인식 때는 번역하지 않는다 (따로 번역용으로만 체크한 경우).
    const translationLangs = document.getElementById("translateWithRecognition").checked ? getSelectedTranslationLangs() : [];

    if (!speakerSeparation) {
      // "대상 트랙"을 직접 고르지 않고, 소스가 실제로 얹혀 있는(클립이 있는) 오디오 트랙을
      // 자동으로 찾는다. 배경음악처럼 체크해둔 "자동 감지 제외" 트랙은 건너뛴다.
      const excludeIndices = Array.from(document.querySelectorAll(".excludeTrackOption:checked")).map(cb => Number(cb.value));
      if (excludeIndices.length) {
        log(`자동 감지 제외 트랙: 오디오 트랙 ${excludeIndices.map(i => i + 1).join(", ")}`);
      }
      setStatus("대상 트랙 자동 감지 중...");
      const detected = await autoDetectSourceTrack(sequence, excludeIndices);
      if (!detected) {
        log("✘ 클립이 있는 오디오 트랙을 찾지 못했습니다. 타임라인에 오디오 클립이 있는지, 제외 설정이 너무 많지 않은지 확인해주세요.");
        setStatus("실패");
        return;
      }
      log(`✔ 대상 트랙 자동 감지: ${detected.name} (클립 ${detected.cuts.length}개)`);
      const cuts = detected.cuts;

      setStatus("오디오 추출 중...");
      const tempPathRes = await serverGet("/api/temp-path?name=autocaption_uxp_mixdown.wav");
      const audioPath = tempPathRes.path;
      await ensureCorrectSequenceActive(project, sequence, "");
      const exportOk = await encoder.exportSequence(sequence, ppro.Constants.ExportType.IMMEDIATELY, audioPath, presetPath);
      if (!exportOk) { log("✘ 오디오 export 실패"); setStatus("실패"); return; }
      log("✔ 오디오 추출 완료: " + audioPath);

      const result = await recognizeAndCorrect(project, sequence, cuts, audioPath, { ...commonOpts, fileSuffix: "", markerPrefix: "", filterSilent: false });
      if (result && translationLangs.length) {
        const sessionGlossary = await buildSessionGlossary([result], translationLangs, commonOpts);
        await translateAndImport(project, sequence, result.processed, { ...commonOpts, fileSuffix: result.fileSuffix, markerPrefix: result.markerPrefix }, sessionGlossary);
      }
    } else {
      const checkedBoxes = Array.from(document.querySelectorAll(".speakerTrackOption:checked"));
      if (checkedBoxes.length < 1) {
        log("화자 분리 실패: 최소 1개 이상의 오디오 트랙을 선택해주세요.");
        setStatus("실패");
        return;
      }
      const speakerTrackIndices = checkedBoxes.map(cb => Number(cb.value));
      log(`화자 분리 모드: ${speakerTrackIndices.length}개 트랙 선택됨 (오디오 트랙 ${speakerTrackIndices.join(", ")})`);

      const audioTrackCount = await sequence.getAudioTrackCount();
      const audioTracks = [];
      const originalMutes = [];
      for (let i = 0; i < audioTrackCount; i++) {
        const t = await sequence.getAudioTrack(i);
        audioTracks.push(t);
        originalMutes.push(await t.isMuted());
      }

      // 1단계: 화자별로 인식+교정만 먼저 전부 끝낸다 (번역은 아직 안 함)
      const speakerResults = [];
      let speakerNum = 1;
      for (const trackIdx of speakerTrackIndices) {
        checkCancelled();
        const markerPrefix = `[화자 ${speakerNum}] `;
        // 화자 분리 모드에서는 "대상 트랙"도 수동 선택 없이, 그 화자가 체크된 트랙 자신의
        // 클립을 컷 경계로 그대로 쓴다 (화자 트랙 ≠ 컷 기준 트랙이 따로 있던 예전 방식 제거).
        const speakerCuts = await getTrackCuts(audioTracks[trackIdx]);
        if (speakerCuts.length === 0) {
          log(`${markerPrefix}⚠ 이 트랙에 클립이 없어 건너뜁니다.`);
          speakerNum++;
          continue;
        }
        setStatus(`${markerPrefix}오디오 트랙 음소거 설정 중...`);
        for (let i = 0; i < audioTracks.length; i++) {
          await audioTracks[i].setMute(i !== trackIdx);
        }
        const speakerAudioPath = (await serverGet(`/api/temp-path?name=autocaption_uxp_mixdown_${speakerNum}.wav`)).path;
        await ensureCorrectSequenceActive(project, sequence, markerPrefix);
        const speakerExportOk = await encoder.exportSequence(sequence, ppro.Constants.ExportType.IMMEDIATELY, speakerAudioPath, presetPath);
        if (!speakerExportOk) { log(`${markerPrefix}✘ 오디오 export 실패`); speakerNum++; continue; }
        log(`${markerPrefix}✔ 오디오 추출 완료: ` + speakerAudioPath);
        const result = await recognizeAndCorrect(project, sequence, speakerCuts, speakerAudioPath, { ...commonOpts, fileSuffix: `_${speakerNum}`, markerPrefix, filterSilent: true });
        if (result) speakerResults.push(result);
        speakerNum++;
      }

      // 원래 음소거 상태로 복구
      for (let i = 0; i < audioTracks.length; i++) {
        await audioTracks[i].setMute(originalMutes[i]);
      }
      log("✔ 오디오 트랙 음소거 상태 원상복구 완료");

      // 2단계: 화자 전원의 대본을 합쳐서 이번 영상 전체에서 통일할 고유명사를 한 번만 정리하고,
      // 그 결과를 모든 화자의 번역에 공통으로 적용한다 (화자별로 번역이 따로 돌면서 같은 단어가
      // 다르게 번역되는 문제 방지).
      if (translationLangs.length && speakerResults.length) {
        const sessionGlossary = await buildSessionGlossary(speakerResults, translationLangs, commonOpts);
        for (const result of speakerResults) {
          await translateAndImport(project, sequence, result.processed, { ...commonOpts, fileSuffix: result.fileSuffix, markerPrefix: result.markerPrefix }, sessionGlossary);
        }
      }
    }

    setStatus("완료");
    log("=== 파이프라인 완료 ===");
  } catch (e) {
    if (e instanceof CancelledError) {
      log("■ 사용자에 의해 중단되었습니다.");
      setStatus("중단됨");
    } else {
      log("✘ 치명적 오류: " + e.toString());
      setStatus("오류");
    }
  } finally {
    document.getElementById("btnStart").style.display = "";
    document.getElementById("btnStop").style.display = "none";
  }
}

document.getElementById("btnStart").addEventListener("click", () => {
  runPipeline();
});
document.getElementById("btnClippingOnly").addEventListener("click", () => {
  runClippingOnly();
});
document.getElementById("btnStop").addEventListener("click", () => {
  cancelRequested = true;
  log("중단 요청됨... (현재 진행 중인 단계가 끝나는 대로 멈춥니다)");
});
document.getElementById("btnRefreshTracks").addEventListener("click", () => {
  loadTracks();
});
document.getElementById("speakerSeparationToggle").addEventListener("change", (e) => {
  document.getElementById("speakerTrackRow").style.display = e.target.checked ? "" : "none";
});
document.getElementById("btnCopyLog").addEventListener("click", async () => {
  try {
    await navigator.clipboard.setContent({ "text/plain": document.getElementById("log").textContent });
    setStatus("로그가 클립보드에 복사되었습니다.");
  } catch (e) {
    log("복사 실패: " + e.toString());
  }
});

document.getElementById("btnRegisterProperNoun").addEventListener("click", async () => {
  const koInput = document.getElementById("pnKo");
  const projectInput = document.getElementById("pnProject");
  const enInput = document.getElementById("pnEn");
  const jaInput = document.getElementById("pnJa");
  const zhInput = document.getElementById("pnZh");
  const ko = textOf(koInput);
  const pnProject = textOf(projectInput);
  const en = textOf(enInput);
  const ja = textOf(jaInput);
  const zhCN = textOf(zhInput);

  if (!ko) { log("✘ 고유명사(한국어 원어)를 입력해주세요."); return; }

  try {
    const serverUp = await checkServer();
    if (!serverUp) { log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요."); return; }

    const res = await serverPost("/api/proper-nouns/add", { ko, en, ja, zhCN, project: pnProject });
    const entry = res.entry || {};
    const parts = [];
    if (entry.en) parts.push("en: " + entry.en);
    if (entry.ja) parts.push("ja: " + entry.ja);
    if (entry["zh-CN"]) parts.push("zh-CN: " + entry["zh-CN"]);
    const scopeLabel = entry.project ? `프로젝트: ${entry.project}` : "공통";
    log(`✔ 고유명사 등록됨: "${ko}" [${scopeLabel}]` + (parts.length ? ` (${parts.join(", ")})` : " (번역 표기 없음 — 인식/교정 힌트로만 사용됨)"));
    koInput.value = "";
    projectInput.value = "";
    enInput.value = "";
    jaInput.value = "";
    zhInput.value = "";
    refreshProjectList();
  } catch (e) {
    log("✘ 고유명사 등록 실패: " + e.toString());
  }
});

document.getElementById("btnViewProperNouns").addEventListener("click", async () => {
  const listEl = document.getElementById("properNounList");
  try {
    const serverUp = await checkServer();
    if (!serverUp) { log("✘ 로컬 서버(http://localhost:8934)에 연결할 수 없습니다. start-server.bat을 먼저 실행해주세요."); return; }

    const res = await serverGet("/api/proper-nouns");
    const entries = Object.entries(res.glossary || {});
    if (entries.length === 0) {
      listEl.textContent = "(등록된 고유명사 없음)";
    } else {
      listEl.textContent = entries.map(([ko, byLang]) => {
        const scopeLabel = byLang.project ? `프로젝트: ${byLang.project}` : "공통";
        return `${ko}  →  en: ${byLang.en || "-"} / ja: ${byLang.ja || "-"} / zh-CN: ${byLang["zh-CN"] || "-"}  [${scopeLabel}]`;
      }).join("\n");
    }
    listEl.style.display = "";
  } catch (e) {
    log("✘ 고유명사 목록 조회 실패: " + e.toString());
  }
});

function setupResizeHandle() {
  const handle = document.getElementById("resizeHandle");
  const settingsEl = document.getElementById("settingsScroll");
  const MIN_HEIGHT = 80;

  function getMaxHeight() {
    // 액션 버튼줄 + 로그 최소 높이(대략 220px)는 항상 남겨둔다.
    return Math.max(MIN_HEIGHT, document.body.clientHeight - 220);
  }

  const saved = parseInt(localStorage.getItem("autocaption_settingsHeight"), 10);
  if (!isNaN(saved)) {
    settingsEl.style.height = Math.min(saved, getMaxHeight()) + "px";
  } else if (document.body.clientHeight > 0) {
    // 저장된 값이 없으면 패널 높이의 약 45%를 기본값으로 (나머지는 로그/버튼 몫)
    const auto = Math.floor(document.body.clientHeight * 0.45);
    settingsEl.style.height = Math.max(MIN_HEIGHT, Math.min(auto, getMaxHeight())) + "px";
  }

  let dragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    handle.classList.add("dragging");
    startY = e.clientY;
    startHeight = settingsEl.getBoundingClientRect().height;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const newHeight = Math.max(MIN_HEIGHT, Math.min(getMaxHeight(), startHeight + (e.clientY - startY)));
    settingsEl.style.height = newHeight + "px";
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    localStorage.setItem("autocaption_settingsHeight", Math.round(settingsEl.getBoundingClientRect().height));
  });
}

function setupTabs() {
  const buttons = Array.from(document.querySelectorAll(".tab-btn"));
  const contents = Array.from(document.querySelectorAll(".tab-content"));

  function showTab(name) {
    buttons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    contents.forEach((c) => c.classList.toggle("active", c.dataset.tab === name));
    try { localStorage.setItem("autocaption_activeTab", name); } catch (e) { /* 무시 */ }
    document.getElementById("settingsScroll").scrollTop = 0;
  }

  buttons.forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  const saved = localStorage.getItem("autocaption_activeTab");
  if (saved && buttons.some((b) => b.dataset.tab === saved)) showTab(saved);
}

// ===== 라이선스 등록 화면 =====
// 서버(license.js)가 실제 검증을 전부 하고, 패널은 결과(ok/reason/deviceCode)만 받아서
// 화면을 보여준다. 실제 Whisper/ffmpeg/Claude 작업은 서버 쪽에서 매 요청마다 다시 확인하므로,
// 여기 패널 JS를 고쳐서 등록 화면을 건너뛰어도 실제 작업은 막힌다.
// document.execCommand("copy")는 UXP 패널 안에서는 동작 안 해서(클립보드가 안 바뀜),
// 앱 다른 곳(로그 복사 등)과 똑같이 UXP 전용 navigator.clipboard.setContent를 써야 한다.
// 이 함수는 async라서, 호출하는 쪽에서 await 해야 결과(성공/실패)를 정확히 알 수 있다.
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.setContent({ "text/plain": text });
    return true;
  } catch (e) {
    return false;
  }
}

// ===== API 없이 쓰는 모드 =====
// API 키가 없으면(패널 칸도 비어 있고 서버 llm.json에도 없으면) AI 교정과 번역을 자동으로
// 끄고 잠근다. 키가 없는데 켜져 있으면 매번 "교정 실패/번역 실패"가 떠서 고장처럼 보였다.
let serverHasDefaultKey = false;

function hasApiKey() {
  return serverHasDefaultKey || !!val("claudeApiKey");
}

function applyApiMode() {
  const noKey = !hasApiKey();
  document.getElementById("noApiNotice").hidden = !noKey;
  const aiToggle = document.getElementById("aiCorrectionToggle");
  if (noKey) {
    // 키가 생기면 원래 상태로 돌려놓기 위해 끄기 전 상태를 기억해 둔다.
    if (!aiToggle.disabled) aiToggle.dataset.prevChecked = aiToggle.checked ? "1" : "0";
    aiToggle.checked = false;
    aiToggle.disabled = true;
  } else if (aiToggle.disabled) {
    aiToggle.disabled = false;
    aiToggle.checked = aiToggle.dataset.prevChecked !== "0";
  }
  document.querySelectorAll(".translateLangOption").forEach((cb) => {
    if (noKey) cb.checked = false;
    cb.disabled = noKey;
  });
}

async function refreshServerKeyStatus() {
  try {
    const r = await serverGet("/ping");
    serverHasDefaultKey = !!r.hasDefaultKey;
  } catch (e) {
    serverHasDefaultKey = false;
  }
  applyApiMode();
}

document.getElementById("claudeApiKey").addEventListener("input", applyApiMode);

// ===== 자동 업데이트 띠 (v1.1.0~) =====
// 패널을 열 때 서버에 새 버전이 있는지 묻는다. 작업 중 갑자기 바뀌지 않도록 사용자가 버튼을 눌러야 적용된다.
function showUpdateBanner(text, buttonLabel, onClick) {
  const banner = document.getElementById("updateBanner");
  document.getElementById("updateBannerText").textContent = text;
  const btn = document.getElementById("updateBannerBtn");
  btn.hidden = !buttonLabel;
  btn.disabled = false;
  btn.textContent = buttonLabel || "";
  btn.onclick = onClick || null;
  banner.hidden = false;
}

async function waitForUpdatedServer(targetVersion) {
  // updater.ps1이 서버를 껐다 켜는 동안 몇 초 응답이 없을 수 있다. 최대 90초 기다린다.
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    try {
      const v = await withTimeout(serverGet("/api/version"), 2000, "버전 확인");
      if (v.current === targetVersion) {
        // 새 서버가 먼저 응답하고 updater.ps1이 결과 파일을 조금 뒤에 쓰므로 한 번 더 읽는다.
        await sleep(2000);
        const again = await serverGet("/api/version").catch(() => v);
        return { ok: true, status: again.lastUpdate && again.lastUpdate.to === targetVersion ? again.lastUpdate : null };
      }
      if (v.lastUpdate && v.lastUpdate.to === targetVersion && v.lastUpdate.ok === false) return { ok: false, status: v.lastUpdate };
    } catch (e) {
      // 서버가 재시작 중
    }
  }
  return { ok: false, status: null };
}

async function checkForUpdate() {
  let r;
  try {
    r = await serverGet("/api/update/check");
  } catch (e) {
    return; // 확인 실패는 조용히 넘어간다 (인터넷이 없을 때 등)
  }
  log(`AutoCaption v${r.current}`);
  if (r.devCopy) return; // 개발 폴더의 서버는 업데이트하지 않는다
  if (r.needsInstaller) {
    showUpdateBanner(`새 버전 v${r.latest}은(는) 새 설치 파일이 필요합니다. ${r.note || ""}`, "안내 페이지 열기", async () => {
      try { await serverPost("/api/open-download-page", {}); } catch (e) { log("✘ 안내 페이지 열기 실패: " + e.toString()); }
    });
    return;
  }
  if (!r.available) return;
  showUpdateBanner(`새 버전 v${r.latest}이(가) 있습니다. ${r.note || ""}`, "지금 업데이트", async () => {
    const btn = document.getElementById("updateBannerBtn");
    btn.disabled = true;
    showUpdateBanner(`v${r.latest} 받는 중... 끝날 때까지 패널을 닫지 마세요.`, null);
    try {
      await serverPost("/api/update/apply", {});
    } catch (e) {
      showUpdateBanner("업데이트를 시작하지 못했습니다: " + e.toString(), "다시 시도", () => checkForUpdate());
      return;
    }
    showUpdateBanner(`v${r.latest} 적용 중... 서버를 다시 시작하고 있습니다 (최대 1분).`, null);
    const done = await waitForUpdatedServer(r.latest);
    if (done.ok) {
      const note = done.status && done.status.plugin ? ` (${done.status.plugin})` : "";
      showUpdateBanner(`v${r.latest} 업데이트 완료. Premiere Pro를 다시 시작하면 새 패널이 적용됩니다.${note}`, null);
      log(`✔ v${r.latest} 업데이트 완료${note}`);
    } else {
      const why = done.status && done.status.message ? done.status.message : "응답 없음";
      showUpdateBanner(`업데이트에 실패해 이전 버전으로 되돌렸습니다: ${why}`, null);
      log("✘ 업데이트 실패: " + why);
    }
  });
}

function startApp() {
  document.getElementById("licenseGate").hidden = true;
  document.getElementById("serverWait").hidden = true;
  document.getElementById("appRoot").hidden = false;
  restoreSettings().then(refreshServerKeyStatus, refreshServerKeyStatus);
  checkForUpdate();
  loadTracksWithRetry(4, 800);
  refreshProjectList();
  setupResizeHandle();
  setupTabs();
}

function showLicenseGate(info) {
  document.getElementById("appRoot").hidden = true;
  const gate = document.getElementById("licenseGate");
  gate.hidden = false;

  const msgEl = document.getElementById("licGateMsg");
  function say(text, cls) {
    msgEl.textContent = text || "";
    msgEl.className = "lic-gate-msg" + (cls ? " " + cls : "");
  }

  const deviceEl = document.getElementById("licGateDevice");
  deviceEl.textContent = (info && info.deviceCode) || "(확인 불가)";

  if (info && info.message) say(info.message, "err");

  document.getElementById("licGateCopy").onclick = async () => {
    const dev = deviceEl.textContent;
    if (!dev || dev === "(확인 불가)") return;
    const ok = await copyTextToClipboard(dev);
    say(ok ? "기기 코드를 복사했어요. 관리자에게 보내주세요." : "복사가 안 되면 코드를 드래그해서 복사해주세요.", ok ? "ok" : "err");
  };

  document.getElementById("licGateOk").onclick = async () => {
    const key = val("licGateKey");
    if (!key) { say("받은 키를 위 칸에 붙여넣어주세요.", "err"); return; }
    try {
      const r = await serverPost("/api/license", { key });
      if (!r.ok) { say(r.message || "등록에 실패했습니다.", "err"); return; }
      startApp();
    } catch (e) {
      say("서버와 통신하지 못했습니다: " + e.toString(), "err");
    }
  };
}

// fetch가 응답도 에러도 없이 그냥 멈춰버리는 환경이 있어서(네트워크 스택
// 이슈 등), 일정 시간 안에 안 끝나면 "멈춤" 대신 눈에 보이는 에러로 바꾼다.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + " - " + ms + "ms 안에 응답이 없습니다")), ms))
  ]);
}

// 서버가 켜질 때까지 "서버 연결 대기" 화면을 보여주며 몇 초마다 다시 확인한다.
// v1.0.6까지는 서버가 늦게 켜지면 인증 기능이 꺼져 있어도 라이선스 등록 화면이 뜨고
// 다시 확인하지 않아서, 패널을 다시 열기 전까지 아무것도 못 하는 문제가 있었다.
function waitForServer() {
  const wait = document.getElementById("serverWait");
  const msgEl = document.getElementById("serverWaitMsg");
  const retryBtn = document.getElementById("serverWaitRetry");
  return new Promise((resolve) => {
    let tries = 0;
    let timer = null;
    let checking = false;
    async function tryOnce() {
      if (checking) return;
      checking = true;
      clearTimeout(timer);
      tries++;
      let up = false;
      try {
        up = await withTimeout(checkServer(), 4000, "서버 확인 시간 초과");
      } catch (e) {
        up = false;
      }
      checking = false;
      if (up) {
        wait.hidden = true;
        resolve();
        return;
      }
      document.getElementById("appRoot").hidden = true;
      wait.hidden = false;
      msgEl.textContent = tries < 10
        ? `서버를 기다리는 중입니다 (${tries}번째 확인). 3초 뒤 자동으로 다시 확인합니다.`
        : `아직 연결되지 않았습니다 (${tries}번째 확인). 아래 안내대로 서버를 직접 켜 주세요. 켜지면 자동으로 연결됩니다.`;
      msgEl.className = "lic-gate-msg" + (tries < 10 ? "" : " err");
      timer = setTimeout(tryOnce, 3000);
    }
    retryBtn.onclick = tryOnce;
    tryOnce();
  });
}

async function initApp() {
  await waitForServer();
  let r;
  try {
    r = await withTimeout(serverGet("/api/license"), 8000, "라이선스 확인 시간 초과");
  } catch (e) {
    // 서버는 켜져 있는데 라이선스 확인만 실패한 경우 - 서버가 막 재시작 중일 수 있으니 다시 기다린다.
    log("⚠ 라이선스 상태 확인 실패, 3초 뒤 다시 시도합니다: " + e.toString());
    await new Promise((r2) => setTimeout(r2, 3000));
    return initApp();
  }
  // 인증 기능이 꺼져 있으면(서버 license.js의 ENFORCE=false) 키 등록 화면을 절대 띄우지 않는다.
  if (r.enforced === false) {
    document.getElementById("licenseMgmtGroup").hidden = true;
    startApp();
    return;
  }
  if (r.ok) {
    startApp();
    return;
  }
  showLicenseGate(r);
}

initApp();
