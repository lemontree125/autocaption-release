// updater.js — AutoCaption 자동 업데이트 (v1.1.0~)
//
// 보보스와 같은 방식: GitHub Pages(공개)에 version.json과 새 파일을 올려 두면, 패널을 열 때
// 서버가 새 버전이 있는지 확인하고, 사용자가 [지금 업데이트]를 누르면 받아서 적용한다.
//
// 흐름
//   1) check(): RELEASE_BASE/version.json을 읽어 지금 버전(app-version.json)과 비교
//   2) apply(): version.json의 files를 전부 _update\v<버전>\ 에 받고 sha256을 확인
//      (하나라도 못 받거나 해시가 다르면 아무것도 바꾸지 않고 중단)
//   3) updater.ps1을 따로(분리된 프로세스로) 실행하고 이 서버는 그대로 응답만 돌려준다.
//      updater.ps1이 서버를 끄고 → 지금 파일을 _backup에 보관 → 새 파일로 교체 →
//      (ccx 설치였으면) 패널을 Adobe 설치기로 다시 설치 → 서버를 다시 켜고 → 40초 안에
//      응답이 없으면 백업으로 되돌린다.
//
// version.json 형식
//   { "v": "1.1.1", "note": "바뀐 점 한 줄", "installer": 1,
//     "files": [ { "path": "server/server.js", "sha256": "…" }, … ] }
//   - installer: Python 패키지·ffmpeg처럼 install.bat이 깔아야 하는 것이 바뀌면 숫자를 올린다.
//     지금 설치본의 installer보다 크면 자동 업데이트 대신 "새 설치 파일 필요" 안내만 한다.
//   - 파일 위치: RELEASE_BASE/files/v<버전>/<path>

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RELEASE_BASE = (process.env.AUTOCAPTION_RELEASE_BASE || "https://lemontree125.github.io/autocaption-release/").replace(/\/?$/, "/");
const DOWNLOAD_PAGE = RELEASE_BASE; // 새 설치 파일이 필요할 때 여는 안내 페이지

const SERVER_DIR = __dirname;
const INSTALL_ROOT = path.dirname(SERVER_DIR); // %LOCALAPPDATA%\AutoCaption
const CHECK_CACHE_MS = 10 * 60 * 1000;

let cachedCheck = null; // { at, result }
let applying = false;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, "")); } catch (e) { return fallback; }
}

function currentVersion() {
  return readJson(path.join(SERVER_DIR, "app-version.json"), { v: "0.0.0", installer: 0 });
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 개발 폴더(git 저장소)에서 돌아가는 서버가 자기 원본 코드를 덮어쓰지 않도록 막는다.
function isDevCopy() {
  return fs.existsSync(path.join(INSTALL_ROOT, ".git")) || fs.existsSync(path.join(INSTALL_ROOT, "DEV"));
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemoteVersion() {
  // GitHub Pages는 캐시가 있어서, 주소 뒤에 시각을 붙여 항상 최신 version.json을 받는다.
  const res = await fetchWithTimeout(RELEASE_BASE + "version.json?t=" + Date.now(), 10000);
  const remote = await res.json();
  if (!remote || typeof remote.v !== "string" || !Array.isArray(remote.files)) {
    throw new Error("version.json 형식이 올바르지 않습니다.");
  }
  return remote;
}

async function check(force) {
  if (!force && cachedCheck && Date.now() - cachedCheck.at < CHECK_CACHE_MS) return cachedCheck.result;
  const cur = currentVersion();
  let result;
  try {
    const remote = await fetchRemoteVersion();
    const newer = compareVersions(remote.v, cur.v) > 0;
    const needsInstaller = newer && Number(remote.installer || 0) > Number(cur.installer || 0);
    result = {
      current: cur.v,
      latest: remote.v,
      note: remote.note || "",
      available: newer && !needsInstaller,
      needsInstaller,
      devCopy: isDevCopy()
    };
  } catch (e) {
    // 인터넷이 안 되거나 Pages가 아직 없으면 조용히 "업데이트 없음"으로 본다.
    result = { current: cur.v, latest: null, available: false, needsInstaller: false, error: e.message, devCopy: isDevCopy() };
  }
  cachedCheck = { at: Date.now(), result };
  return result;
}

function safeRelPath(p) {
  // version.json에 "../" 같은 경로가 들어와도 설치 폴더 밖에는 절대 쓰지 않는다.
  const norm = path.normalize(String(p || "")).replace(/^([\\/])+/, "");
  if (!norm || norm.startsWith("..") || path.isAbsolute(norm)) return null;
  if (!/^(server|plugin)[\\/]/.test(norm)) return null; // 서버와 패널 파일만 교체 대상
  return norm;
}

async function apply() {
  if (applying) throw new Error("이미 업데이트를 진행 중입니다.");
  if (isDevCopy()) throw new Error("개발 폴더에서 실행 중인 서버는 자동 업데이트를 하지 않습니다.");
  applying = true;
  try {
    const cur = currentVersion();
    const remote = await fetchRemoteVersion();
    if (compareVersions(remote.v, cur.v) <= 0) throw new Error("이미 최신 버전입니다 (v" + cur.v + ").");
    if (Number(remote.installer || 0) > Number(cur.installer || 0)) {
      throw new Error("이번 업데이트는 새 설치 파일이 필요합니다. 안내 페이지에서 내려받아 install.bat을 실행해 주세요.");
    }

    const staging = path.join(INSTALL_ROOT, "_update", "v" + remote.v);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    // 1) 전부 받고 해시 확인 - 하나라도 실패하면 아무것도 바꾸지 않는다.
    for (const f of remote.files) {
      const rel = safeRelPath(f.path);
      if (!rel) throw new Error("허용되지 않는 파일 경로: " + f.path);
      const url = RELEASE_BASE + "files/v" + remote.v + "/" + rel.split(path.sep).map(encodeURIComponent).join("/");
      const res = await fetchWithTimeout(url, 60000);
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = crypto.createHash("sha256").update(buf).digest("hex");
      if (f.sha256 && hash !== String(f.sha256).toLowerCase()) {
        throw new Error("파일이 손상되었습니다(해시 불일치): " + rel);
      }
      const dst = path.join(staging, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
    }

    // 2) 교체는 분리된 PowerShell(updater.ps1)이 한다 - 이 서버 프로세스를 꺼야 하기 때문.
    //    새 버전의 updater.ps1이 받아졌으면 그걸 쓰고, 없으면 지금 설치본의 것을 쓴다.
    const newScript = path.join(staging, "server", "updater.ps1");
    const script = fs.existsSync(newScript) ? newScript : path.join(SERVER_DIR, "updater.ps1");
    const runner = path.join(INSTALL_ROOT, "_update", "updater-run.ps1");
    fs.copyFileSync(script, runner); // 교체 도중 server 폴더의 원본이 바뀌어도 실행 중인 스크립트는 안전하게
    // updater.ps1은 wscript(창 없음)를 거쳐 "자기만의 숨은 콘솔"로 띄운다. 시험으로 확인한 두 가지 함정:
    //  - node에서 powershell을 detached로 바로 띄우면(DETACHED_PROCESS) 아무것도 안 하고 끝난다.
    //  - detached 없이 띄우면 서버와 콘솔을 같이 쓰게 되어, updater.ps1이 서버(cmd.exe)를 끄는 순간
    //    콘솔이 닫히면서 updater.ps1 자신도 같이 꺼진다.
    // 서버를 켤 때와 같은 방식(wscript + WshShell.Run 창 숨김)이면 둘 다 피한다.
    // VBS는 UTF-16(BOM)으로 저장해야 사용자 폴더 이름에 한글이 있어도 경로가 깨지지 않는다.
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"'; // VBS 문자열 안의 따옴표는 두 번
    const psArgs = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", runner,
      "-Root", INSTALL_ROOT, "-Staging", staging, "-FromVersion", cur.v, "-ToVersion", remote.v,
      "-Port", String(Number(process.env.AUTOCAPTION_PORT) || 8934)];
    const cmdLine = psArgs.map((a) => (/[\s"]/.test(a) ? '"' + a + '"' : a)).join(" ");
    const vbs = 'Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run ' + q(cmdLine) + ", 0, False\r\n";
    const vbsPath = path.join(INSTALL_ROOT, "_update", "updater-run.vbs");
    fs.writeFileSync(vbsPath, Buffer.from("﻿" + vbs, "utf16le"));
    // wscript를 node의 자식으로 띄우면, node가 자식들을 묶어 두는 job object 때문에 updater.ps1이
    // 서버(node)를 끄는 순간 updater.ps1도 같이 꺼지는 것을 시험으로 확인했다.
    // 그래서 WMI(Win32_Process.Create)에게 대신 띄우게 한다 - WMI 서비스가 만든 프로세스는 node와
    // 아무 관계가 없어서 서버가 꺼져도 끝까지 돈다. 경로는 따옴표 문제를 피하려고 환경 변수로 넘긴다.
    const r = require("child_process").spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('wscript.exe \"' + $env:AC_UPDATER_VBS + '\"') }; exit [int]$r.ReturnValue"
    ], { env: { ...process.env, AC_UPDATER_VBS: vbsPath }, windowsHide: true, timeout: 30000 });
    if (r.status !== 0) {
      throw new Error("업데이트 프로그램을 시작하지 못했습니다 (WMI 코드 " + r.status + "): " + String(r.stderr || "").slice(0, 300));
    }
    cachedCheck = null;
    return { started: true, from: cur.v, to: remote.v };
  } finally {
    applying = false;
  }
}

function lastStatus() {
  return readJson(path.join(INSTALL_ROOT, "update-status.json"), null);
}

module.exports = { check, apply, currentVersion, lastStatus, DOWNLOAD_PAGE, RELEASE_BASE };
