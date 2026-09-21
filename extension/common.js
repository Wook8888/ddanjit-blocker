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
  deviceName: "",     // 동기화 기록에 남는 이름 — 기기별
  words: [],          // 잠금 문제 단어 — 동기화됨. 비어 있으면 기본 단어
  lastError: "",
  // 차단 화면 문구. 팝업에서 고치는 칸은 없애고 이 값으로 고정했다.
  // 그래도 백업 엑셀의 '설정' 시트에서는 바꿀 수 있다.
  blockPage: {
    title: "잠깐!",
    message: "딴짓 차단기 작동 중",
    emoji: "□"
  }
};

const UNLOCK_MINUTES = 5;

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
  await chrome.storage.session.set({ unlockUntil: Date.now() + UNLOCK_MINUTES * 60 * 1000 });
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

/* ---------- 동기화 기록 ----------
 * 크롬 동기화 저장소에 h0~h9 로 스냅샷을 돌려 쓴다.
 *   hi = 가장 최근 기록이 들어 있는 칸,  hn = 들어 있는 개수
 * 백그라운드(sync.js)가 쓰고, 팝업·백업 페이지가 읽는다. */

const HISTORY_MAX = 10;

/** 최신 → 과거 순서의 칸 번호 */
function historyOrder(hi, hn) {
  const out = [];
  for (let k = 0; k < hn; k++) {
    out.push(((hi - k) % HISTORY_MAX + HISTORY_MAX) % HISTORY_MAX);
  }
  return out;
}

/** 동기화 저장소 전체 → 기록 배열 (최신순). 각 항목 {at, d, b, a, r?, slot} */
function historyFrom(all) {
  if (!all) return [];
  const hn = Math.min(Math.max(all.hn | 0, 0), HISTORY_MAX);
  const hi = Math.min(Math.max(all.hi | 0, 0), HISTORY_MAX - 1);
  const out = [];
  for (const slot of historyOrder(hi, hn)) {
    const e = all["h" + slot];
    if (e && Array.isArray(e.b) && Array.isArray(e.a)) out.push({ ...e, slot });
  }
  return out;
}

async function readHistory() {
  try {
    return historyFrom(await chrome.storage.sync.get(null));
  } catch (e) {
    return [];
  }
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
