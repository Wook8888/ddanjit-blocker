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
  deviceName: "",     // 동기화된 기기 목록에 보이는 이름 — 기기별
  syncOn: true,       // 이 기기 동기화 켜기/끄기 — 기기별. 끄면 주고받기 모두 멈춤
  deviceId: "",       // 기기끼리 구분하는 임의 번호 — 기기별 (처음 켤 때 background 가 만든다)
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
