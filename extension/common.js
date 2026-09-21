/* 딴짓 차단기 - 팝업·백업 페이지가 함께 쓰는 공용 코드
 *
 * 여기 DEFAULTS 는 background.js 의 DEFAULTS 와 모양이 같아야 한다.
 * (서비스 워커는 common.js 를 불러오지 않으므로 따로 들고 있다)
 */

const DEFAULTS = {
  blocked: [],
  allowed: [],
  enabled: true,      // 차단 켜기/끄기 — 기기별
  lockOn: false,      // 잠금 켜기/끄기 — 기기별
  quizCount: 1,       // 잠금을 풀려면 맞혀야 할 문제 수 (1~10) — 기기별
  wrongPause: 5,      // 틀렸을 때 정답을 보여준 뒤 다음 문제로 넘어가기까지 초 (1~10) — 기기별
  deviceName: "",     // 동기화된 기기 목록에 보이는 이름 — 기기별
  syncOn: true,       // 이 기기 동기화 켜기/끄기 — 기기별. 끄면 주고받기 모두 멈춤
  deviceId: "",       // 기기끼리 구분하는 임의 번호 — 기기별 (처음 켤 때 background 가 만든다)
  words: [],          // 잠금 문제 단어 — 기기별 (동기화 안 함). 비어 있으면 기본 단어
  lastError: ""
  // 차단 화면 문구는 2.2.0 부터 고정 (blocked.js). 저장·동기화·엑셀 어디에도 없다.
};

const UNLOCK_MINUTES = 5;
const QUIZ_MAX = 10;
const PAUSE_MAX = 10; // 틀린 뒤 기다리는 시간 최대 (초)

/** 잠금 화면의 "틀리면 N초 뒤 다음 문제" 선택 칸을 채우고, 바꾸면 바로 저장한다.
 *  잠금을 푸는 것과는 상관없는 설정이라 잠긴 상태에서도 바꿀 수 있다. */
function setupPauseSelect(sel, state) {
  if (!sel) return;
  sel.innerHTML = "";
  for (let n = 1; n <= PAUSE_MAX; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = n + "초";
    sel.appendChild(o);
  }
  sel.value = String(wrongPauseSec(state));
  sel.addEventListener("change", async () => {
    const n = wrongPauseSec({ wrongPause: sel.value });
    state.wrongPause = n;
    await chrome.storage.local.set({ wrongPause: n });
  });
}

/** 틀렸을 때 정답을 보여주는 시간(초). 1~10, 기본 5 */
function wrongPauseSec(state) {
  const n = Math.round(Number(state && state.wrongPause));
  return Number.isFinite(n) ? Math.min(PAUSE_MAX, Math.max(1, n)) : 5;
}

/** 설치 직후 붙일 기기 이름. 사용자가 설정에서 바꿀 수 있다. */
function defaultDeviceName() {
  const ua = navigator.userAgent || "";
  if (/CrOS/.test(ua)) return "크롬북";
  if (/Mac OS X|Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Android/.test(ua)) return "안드로이드";
  if (/Linux|X11/.test(ua)) return "Linux PC";
  return "이 기기";
}

/* ---------- 잠금 ---------- */

async function isUnlocked(state) {
  if (!state.lockOn) return true;
  const { unlockUntil = 0 } = await chrome.storage.session.get({ unlockUntil: 0 });
  return Date.now() < unlockUntil;
}

async function markUnlocked() {
  await chrome.storage.session.set({ unlockUntil: Date.now() + UNLOCK_MINUTES * 60 * 1000, quizDone: 0 });
}

/* 잠금 문제: quizCount 개를 "맞히기만" 하면 풀린다. 틀려도 맞힌 개수는 그대로.
 * 맞힌 개수는 session 에 두어 팝업이 닫혀도 이어서 푼다 (크롬을 껐다 켜면 처음부터). */

function quizNeed(state) {
  const n = Math.round(Number(state && state.quizCount));
  return Number.isFinite(n) ? Math.min(QUIZ_MAX, Math.max(1, n)) : 1;
}

async function getQuizDone() {
  const { quizDone = 0 } = await chrome.storage.session.get({ quizDone: 0 });
  return Math.max(0, Number(quizDone) || 0);
}

async function setQuizDone(n) {
  await chrome.storage.session.set({ quizDone: n });
}

/** 잠금 화면 안내 문구와 진행 표시 */
function quizHintText(need) {
  return need > 1 ? `뜻을 ${need}개 맞히면 5분 동안 열립니다.` : "뜻을 맞히면 5분 동안 열립니다.";
}
function quizProgText(done, need) {
  return need > 1 ? `${done} / ${need} 맞힘` : "";
}

/* ---------- 도메인 ---------- */

/**
 * 입력값에서 호스트만 뽑아낸다.
 * URL 파서를 쓰므로 한글 도메인은 자동으로 퓨니코드(xn--...)로 변환된다.
 * DNR 의 urlFilter 는 ASCII 만 허용하기 때문에 이 변환이 반드시 필요하다.
 */
function normalizeDomain(raw) {
  let v = (raw || "").trim();
  if (!v) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) v = "https://" + v;

  let host;
  try {
    host = new URL(v).hostname;
  } catch (e) {
    return null;
  }
  if (!host || host.startsWith("[")) return null; // 빈 값·IPv6 제외

  host = host.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host)) return null; // ASCII 만 (퓨니코드 변환 후에도 남는 이상 문자 차단)
  // TLD 가 있어야 함. xn-- 로 시작하는 국제화 TLD(.한국 → .xn--3e0b707e)도 허용하고,
  // 숫자만으로 끝나는 IP 주소는 배제한다.
  if (!/\.(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$/.test(host)) return null;
  return host;
}

/** 차단 목록에서 www. 는 의미가 없으므로 제거 (서브도메인까지 함께 차단되므로) */
function normalizeBlockDomain(raw) {
  const v = normalizeDomain(raw);
  return v ? v.replace(/^www\./, "") : null;
}

/** a 가 b 자신이거나 b의 서브도메인인가 */
function isUnder(a, b) {
  return a === b || a.endsWith("." + b);
}

/** 도메인과 모든 서브도메인을 포함하는 match pattern */
function originPattern(domain) {
  return "*://*." + domain + "/*";
}

/* ---------- 동기화된 기기 ----------
 * 크롬 동기화 저장소에 기기마다 한 칸(d_<기기번호>)을 둔다.
 *   { d: 기기 이름, at: 마지막으로 목록이 바뀐 시각, b: 차단 목록, a: 예외 목록, off?: 동기화 끔 }
 * 목록이 바뀌면 그 칸이 최신 상태로 덮어써진다. 쌓이지 않는다.
 * 백그라운드(sync.js)가 쓰고, 팝업·동기화 페이지가 읽고 지운다. */

const DEVICE_PREFIX = "d_";

/** 동기화 저장소 전체 → 기기 배열 (최근에 바뀐 순). 각 항목 {id, d, at, b, a, off} */
function devicesFrom(all) {
  if (!all) return [];
  const out = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(DEVICE_PREFIX) || !v || !Array.isArray(v.b) || !Array.isArray(v.a)) continue;
    out.push({ id: k.slice(DEVICE_PREFIX.length), d: v.d || "이름 없는 기기", at: v.at || 0,
               b: v.b, a: v.a, off: !!v.off });
  }
  return out.sort((x, y) => y.at - x.at);
}

async function readDevices() {
  try {
    return devicesFrom(await chrome.storage.sync.get(null));
  } catch (e) {
    return [];
  }
}

/* ---------- 이전 목록 보관함 ----------
 * 공유 차단·예외 목록이 바뀌기 직전 상태. 동기화 저장소에 v_<시각> 으로 쌓인다 (sync.js 가 쓴다).
 *   { c: 기록한 시각, t: 그 목록이 쓰이던 시각, b: 차단 목록, a: 예외 목록 } */

const VERSION_PREFIX = "v_";

/** 동기화 저장소 전체 → 기록 배열 (최근 것부터). 각 항목 {key, c, t, b, a} */
function versionsFrom(all) {
  const out = [];
  for (const [k, v] of Object.entries(all || {})) {
    if (!k.startsWith(VERSION_PREFIX) || !v || !Array.isArray(v.b) || !Array.isArray(v.a)) continue;
    out.push({ key: k, c: v.c || 0, t: v.t || v.c || 0, b: v.b, a: v.a });
  }
  return out.sort((x, y) => y.c - x.c);
}

async function readVersions() {
  try {
    return versionsFrom(await chrome.storage.sync.get(null));
  } catch (e) {
    return [];
  }
}

/* ---------- 대표 단어 리스트 ----------
 * 단어는 기기마다 따로다. 대신 동기화 저장소에 "대표 단어 리스트" 자리가 딱 하나 있다.
 *   - 누구나 원할 때 자기 단어를 올린다 (이전 파일을 덮어쓴다). 누가 올렸는지는 남기지 않는다.
 *   - 다른 기기는 원할 때 직접 내려받는다 (자기 단어를 바꾸기). 자동으로 바뀌지 않는다.
 * 저장 형태: rwm = { r: 개정, n: 조각 수, at: 올린 시각, c: 단어 수 }, rw0… = { r, d: [단어…] } */

const REP_MAX_WORDS = 100;
const REP_CHUNK_BYTES = 7500;
const REP_TOTAL_BUDGET = 95 * 1024; // 동기화 저장소 전체 한도(100KB)에서 여유를 둔다

async function readRepWords() {
  let all;
  try { all = await chrome.storage.sync.get(null); } catch (e) { return null; }
  const m = all && all.rwm;
  if (!m || !m.n) return null;
  const out = [];
  for (let i = 0; i < m.n; i++) {
    const c = all["rw" + i];
    if (!c || c.r !== m.r || !Array.isArray(c.d)) return null; // 아직 덜 도착함
    out.push(...c.d);
  }
  return { words: out, at: m.at || 0, count: out.length };
}

/** 단어 목록을 대표 단어 리스트로 올린다. 실패하면 이유(문자열)를 던진다. */
async function writeRepWords(words) {
  if (words.length > REP_MAX_WORDS) throw new Error(`대표 단어 리스트는 ${REP_MAX_WORDS}개까지 올릴 수 있습니다. 지금 ${words.length}개입니다.`);
  const enc = new TextEncoder();
  const size = (s) => enc.encode(s).length;
  const r = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const items = {};
  let cur = [], curBytes = 0, n = 0;
  for (const w of words) {
    const add = size(JSON.stringify(w)) + 1;
    if (cur.length && curBytes + add > REP_CHUNK_BYTES) { items["rw" + n++] = { r, d: cur }; cur = []; curBytes = 0; }
    cur.push(w); curBytes += add;
  }
  if (cur.length) items["rw" + n++] = { r, d: cur };
  items.rwm = { r, n, at: Date.now(), c: words.length };

  const all = await chrome.storage.sync.get(null);
  const stale = Object.keys(all).filter((k) => /^rw\d+$/.test(k) && !(k in items));
  const projected = { ...all, ...items };
  for (const k of stale) delete projected[k];
  let total = 0;
  for (const [k, v] of Object.entries(projected)) total += size(k) + size(JSON.stringify(v));
  if (total > REP_TOTAL_BUDGET) throw new Error("크롬 동기화 저장 공간이 부족해 올리지 못했습니다. 단어 수를 줄여 보세요.");

  await chrome.storage.sync.set(items);
  if (stale.length) await chrome.storage.sync.remove(stale);
}

/** 두 단어 목록이 같은가 (순서까지) */
function sameWords(a, b) {
  const key = (l) => JSON.stringify(usableWords(l).map((w) => [w.word, w.lang, w.ipa, w.read, w.ko]));
  return key(a) === key(b);
}

/* ---------- 표시 ---------- */

function timeAgo(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return "방금 전";
  if (sec < 3600) return Math.floor(sec / 60) + "분 전";
  if (sec < 86400) return Math.floor(sec / 3600) + "시간 전";
  if (sec < 86400 * 7) return Math.floor(sec / 86400) + "일 전";
  return new Date(ts).toLocaleDateString("ko-KR");
}

function stampShort(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yday = new Date(today.getTime() - 86400000).toDateString() === d.toDateString();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (sameDay) return "오늘 " + hm;
  if (yday) return "어제 " + hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
