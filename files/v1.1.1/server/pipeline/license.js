// license.js — AutoCaption 라이선스 (오프라인 Ed25519 서명 + 기기 코드 잠금 + 1인 2대)
//
// Bobos 플러그인의 라이선스 방식을 그대로 옮긴 것. UXP 패널은 Node의 crypto/child_process를
// 못 쓰기 때문에, 검증 로직 전체를 여기(server.js가 require하는 일반 Node 모듈)로 옮겼다.
// 패널(main.js)은 fetch로 GET/POST /api/license를 호출해서 이 모듈의 결과를 받아간다.
//
// 키 형식: "AUTOCAPTION-" + base64url(JSON 페이로드) + "." + base64url(Ed25519 서명)
//   페이로드: { p:"autocaption", v:1, n:이름, d:기기코드, i:발급일, k:키ID }
//   서명 대상 = 페이로드 base64url 문자열(ASCII) 그대로 — JSON 재정렬 문제 없음
//
// 기기 코드 = sha256("autocaption-device-v1|" + 기기 고유값) 앞 10바이트 → Crockford base32 16자
//   윈도우: 레지스트리 MachineGuid (기존 licensing.js와 같은 값을 재사용 — 단, 접두어가 달라서
//   기기 코드 자체 문자열은 다르게 나온다. 같은 컴퓨터에서 나온 기기 코드는 항상 같다.)
//
// 저장 위치: %APPDATA%\AutoCaption\license.key (Windows) — 프로젝트 폴더를 재설치해도 키가 남는다.
//   (APPDATA를 못 읽는 환경이면 이 모듈이 있는 server/pipeline/license.key로 대체)
//
// 차단(REVOKED): 유출된 키의 키ID(k)를 REVOKED 배열에 넣고, 이 파일을 포함한 업데이트를
//   팀원에게 다시 배포하면 그 키는 더 이상 통과하지 못한다 (서버가 없으므로 "재배포"가 곧 차단 방법).

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const cp = require("child_process");

// 인증 기능 스위치. false면 라이선스 검사를 통째로 건너뛰고 항상 통과시킨다 (코드는 그대로
// 남겨둠 - 다시 켜려면 true로 바꾸고 재배포). Bobos의 인증 잠금과 같은 방식.
const ENFORCE = false;

const PRODUCT = "autocaption";
const DEVICE_PREFIX = "autocaption-device-v1";
const KEY_PREFIX = "AUTOCAPTION-";

// AutoCaption 전용으로 새로 발급한 키쌍의 공개키. 개인키(private-key.pem)는
// 절대 이 프로젝트 폴더에 넣지 않는다 — 관리자 PC의 키 발급 도구 폴더에만 둔다.
const PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MCowBQYDK2VwAyEAwXG1GDNJ2HeDpGVQRF7GEgW6663GGNyRvwdjyKHr7+Y=\n" +
  "-----END PUBLIC KEY-----\n";

// 유출되거나 회수해야 하는 키의 키ID(k)를 여기 추가하고 팀원에게 업데이트를 재배포하면 차단된다.
// 예: const REVOKED = ["a1b2c3d4"];
const REVOKED = [];

const CONFIG_DIR = __dirname;
const IS_WIN = process.platform === "win32";

const MESSAGES = {
  format: "키 형식이 올바르지 않습니다. 받은 키 전체(AUTOCAPTION-로 시작)를 빠짐없이 붙여넣었는지 확인해주세요.",
  sig: "올바른 AutoCaption 키가 아닙니다. 받은 키를 그대로 다시 붙여넣어주세요.",
  device: "이 키는 다른 컴퓨터용입니다. 이 컴퓨터의 기기 코드를 관리자에게 보내고 새 키를 받아주세요.",
  revoked: "사용이 중지된 키입니다. 관리자에게 문의해주세요.",
  expired: "라이선스 기간이 만료되었습니다. 관리자에게 문의해 새 키를 받아주세요.",
  none: "아직 등록된 라이선스 키가 없습니다."
};

// ---- 인코딩
function b64uEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
const ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 — I·L·O·U 없음
function base32(buf) {
  let out = "", bits = 0, val = 0;
  for (let i = 0; i < buf.length; i++) {
    val = (val << 8) | buf[i];
    bits += 8;
    while (bits >= 5) { out += ALPH[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPH[(val << (5 - bits)) & 31];
  return out;
}

// ---- 기기 코드
function rawMachineId() {
  try {
    if (IS_WIN) {
      const out = cp
        .execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { windowsHide: true })
        .toString();
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (m) return "win|" + m[1].toLowerCase();
    }
  } catch (e) { /* 아래 폴백으로 */ }
  let user = "";
  try { user = os.userInfo().username; } catch (e2) { /* 무시 */ }
  let cpuModel = "";
  try { cpuModel = (os.cpus()[0] || {}).model || ""; } catch (e3) { /* 무시 */ }
  return "fb|" + os.hostname() + "|" + os.platform() + "|" + os.arch() + "|" + user + "|" + cpuModel;
}

let deviceCache = null;
function deviceCode() {
  if (deviceCache) return deviceCache;
  const h = crypto.createHash("sha256").update(DEVICE_PREFIX + "|" + rawMachineId(), "utf8").digest();
  const s = base32(h.slice(0, 10)); // 80비트 = 16자
  deviceCache = s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16);
  return deviceCache;
}

// ---- 키 검증
function parseKey(key) {
  const s = String(key || "").replace(/\s+/g, "");
  if (s.indexOf(KEY_PREFIX) !== 0) return null;
  const parts = s.slice(KEY_PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let lic;
  try { lic = JSON.parse(b64uDecode(parts[0]).toString("utf8")); } catch (e) { return null; }
  if (!lic || typeof lic !== "object") return null;
  return { clean: s, payloadB64: parts[0], sig: b64uDecode(parts[1]), lic };
}

function verify(key) {
  const parsed = parseKey(key);
  if (!parsed) return { ok: false, reason: "format", deviceCode: deviceCode() };

  let good = false;
  try {
    good = crypto.verify(
      null,
      Buffer.from(parsed.payloadB64, "ascii"),
      crypto.createPublicKey(PUBLIC_KEY_PEM),
      parsed.sig
    );
  } catch (e) { good = false; }

  if (!good || parsed.lic.p !== PRODUCT || parsed.lic.v !== 1) {
    return { ok: false, reason: "sig", deviceCode: deviceCode() };
  }
  if (REVOKED.indexOf(parsed.lic.k) >= 0) {
    return { ok: false, reason: "revoked", lic: parsed.lic, deviceCode: deviceCode() };
  }
  if (parsed.lic.d !== deviceCode()) {
    return { ok: false, reason: "device", lic: parsed.lic, deviceCode: deviceCode() };
  }
  if (parsed.lic.e && new Date(parsed.lic.e).getTime() < Date.now()) {
    return { ok: false, reason: "expired", lic: parsed.lic, deviceCode: deviceCode() };
  }
  return { ok: true, lic: parsed.lic, clean: parsed.clean, deviceCode: deviceCode() };
}

// ---- 저장
function licFile() {
  try {
    if (IS_WIN && process.env.APPDATA) {
      return path.join(process.env.APPDATA, "AutoCaption", "license.key");
    }
  } catch (e) { /* 아래 폴백으로 */ }
  return path.join(CONFIG_DIR, "license.key");
}
function load() {
  try {
    const t = fs.readFileSync(licFile(), "utf8").trim();
    if (t) return t;
  } catch (e) { /* 파일 없음 */ }
  return "";
}
function save(key) {
  const f = licFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, key, "utf8");
}
function clear() {
  try { fs.unlinkSync(licFile()); } catch (e) { /* 무시 */ }
}

// 서버 시작 시 / 매 요청 시: 저장된 키 확인
function check() {
  if (!ENFORCE) return { ok: true, reason: null, deviceCode: deviceCode(), lic: { n: "(인증 비활성)", i: null, e: null } };
  const k = load();
  if (!k) return { ok: false, reason: "none", deviceCode: deviceCode() };
  return verify(k);
}
// 등록: 검증을 통과한 키만 저장
function activate(key) {
  const r = verify(key);
  if (r.ok) save(r.clean);
  return r;
}

function message(reason) {
  return MESSAGES[reason] || "";
}

module.exports = { deviceCode, check, activate, verify, clear, message, PRODUCT, ENFORCE };
