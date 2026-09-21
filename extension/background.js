/* 딴짓 차단기 - 백그라운드 서비스 워커
 *
 * 예외 처리를 두 겹으로 건다:
 *   1) 차단 규칙(priority 1)의 조건에서 excludedRequestDomains 로 예외 도메인을 아예 제외
 *   2) 예외 규칙(priority 2, allow)을 별도로 추가 — 차단보다 우선순위가 높다
 *
 * 주의: rebuildRules() 는 서비스 워커 기동 시점과 storage 변경 시점에서 동시에
 * 호출될 수 있다. 동시에 실행되면 같은 규칙 ID를 중복 등록하려다
 * "Rule with id N does not have a unique ID" 오류로 호출 전체가 실패한다.
 * → 아래 rebuildQueue 로 직렬화하고, 삭제 목록에 추가할 ID까지 포함시켜 방지한다. */

importScripts("common.js", "sync.js"); // DEFAULTS·공용 함수, 크롬 동기화

const BLOCK_RULE_BASE = 1;
const ALLOW_RULE_BASE = 100000;
const BLOCK_PRIORITY = 1;
const ALLOW_PRIORITY = 2;

async function getState() {
  return chrome.storage.local.get(DEFAULTS);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 도메인과 모든 서브도메인의 http/https 주소 전체에 매칭되는 정규식.
 *   naver.com      → O    m.naver.com/abc → O
 *   evilnaver.com  → X    naver.com.evil.com → X
 * 주소 전체를 매칭해야 regexSubstitution 의 \0 이 원래 주소 전체가 된다.
 */
function domainRegex(domain) {
  return "^https?://([^/?#]*\\.)?" + escapeRegex(domain) + "([:/?#].*)?$";
}

/**
 * 차단 목록 → 안내 페이지로 리디렉트하는 규칙 (예외 도메인은 조건에서 제외)
 * regexSubstitution 으로 원래 주소(\0)를 안내 페이지 주소 끝에 붙여 넘긴다.
 * 치환은 크롬이 직접 하므로 확장 프로그램이 요청 내용을 읽는 것은 아니다.
 */
function buildBlockRules(blocked, allowed) {
  const page = chrome.runtime.getURL("blocked.html");
  return blocked.map((domain, index) => {
    const condition = {
      regexFilter: domainRegex(domain),
      resourceTypes: ["main_frame"]
    };
    // 이 차단 도메인 아래에 걸린 예외들은 매칭 대상에서 빼버린다
    const excluded = allowed.filter((a) => isUnder(a, domain));
    if (excluded.length) condition.excludedRequestDomains = excluded;

    return {
      id: BLOCK_RULE_BASE + index,
      priority: BLOCK_PRIORITY,
      action: {
        type: "redirect",
        redirect: {
          // u= 는 반드시 맨 끝에 둔다 (원래 주소 안의 & ? # 를 그대로 보존하기 위해)
          regexSubstitution: page + "?d=" + encodeURIComponent(domain) + "&u=\\0"
        }
      },
      condition
    };
  });
}

/** 예외 목록 → 차단보다 우선하는 허용 규칙 */
function buildAllowRules(allowed) {
  return allowed.map((domain, index) => ({
    id: ALLOW_RULE_BASE + index,
    priority: ALLOW_PRIORITY,
    action: { type: "allow" },
    condition: {
      urlFilter: "||" + domain + "^",
      resourceTypes: ["main_frame"]
    }
  }));
}

/** 현재 등록된 동적 규칙을 전부 제거 */
async function clearAllRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: []
    });
  }
}

async function applyRules(attempt) {
  const { blocked, allowed, enabled } = await getState();
  const uniqBlocked = [...new Set(blocked)];
  const uniqAllowed = [...new Set(allowed)];

  const addRules = enabled
    ? [...buildBlockRules(uniqBlocked, uniqAllowed), ...buildAllowRules(uniqAllowed)]
    : [];

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  // 기존 규칙 ID + 지금 추가할 ID를 모두 삭제 목록에 넣는다.
  // 크롬은 삭제를 먼저 처리하므로 ID 중복이 원천적으로 발생하지 않는다.
  const removeRuleIds = [
    ...new Set([...existing.map((r) => r.id), ...addRules.map((r) => r.id)])
  ];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    await chrome.storage.local.set({ lastError: "" });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error("[딴짓 차단기] 규칙 적용 실패:", msg);
    if (attempt === 0) {
      // 남아있는 규칙을 전부 지우고 딱 한 번 다시 시도
      await clearAllRules();
      return applyRules(1);
    }
    await chrome.storage.local.set({ lastError: msg });
  }

  await updateBadge(enabled ? uniqBlocked.length : 0, enabled);
}

// 동시 실행 방지용 직렬 큐
let rebuildQueue = Promise.resolve();

function rebuildRules() {
  const run = () => applyRules(0).catch((e) => {
    console.error("[딴짓 차단기]", e);
  });
  rebuildQueue = rebuildQueue.then(run, run); // 앞선 작업의 성패와 무관하게 진행
  return rebuildQueue;
}

/** 사이트 접근 권한이 없어 아직 차단되지 않는 도메인 수 */
async function countMissingPerms(blocked) {
  let n = 0;
  for (const d of blocked) {
    try {
      if (!(await chrome.permissions.contains({ origins: [originPattern(d)] }))) n++;
    } catch (e) { n++; }
  }
  return n;
}

async function updateBadge(count, enabled) {
  try {
    const { blocked } = await getState();
    const missing = enabled ? await countMissingPerms([...new Set(blocked)]) : 0;
    if (missing) {
      // 다른 기기에서 동기화로 넘어온 주소는 이 기기에서 권한을 한 번 허용해야 차단된다
      await chrome.action.setBadgeBackgroundColor({ color: "#e8a200" });
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({ title: `딴짓 차단기 — ${missing}개 사이트 권한 허용 필요` });
      return;
    }
    await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#d93025" : "#9aa0a6" });
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    await chrome.action.setTitle({ title: "딴짓 차단기" });
  } catch (e) {
    /* 배지 설정 실패는 무시 */
  }
}

/* ---------- 기기 설정 · 이전 버전에서 넘어오기 ---------- */

async function initDevice() {
  const cur = await chrome.storage.local.get({
    deviceName: "", deviceId: "", lockOn: false, passHash: "", salt: "", blockPage: null, syncGone: null
  });
  const patch = {};

  // 2.2.0 부터 차단 화면 문구는 고정 — 예전에 저장해 둔 문구는 지운다
  if (cur.blockPage) await chrome.storage.local.remove("blockPage");
  if (cur.syncGone !== null) await chrome.storage.local.remove("syncGone");

  if (!cur.deviceId) {
    patch.deviceId = Math.random().toString(36).slice(2, 10);
  }
  if (!cur.deviceName) {
    patch.deviceName = defaultDeviceName();
  }
  // v1.x 에서 비밀번호를 걸어 두었다면 잠금이 켜진 상태로 넘어온다
  if (cur.passHash) {
    patch.lockOn = true;
  }
  if (cur.passHash || cur.salt) {
    await chrome.storage.local.remove(["passHash", "salt"]);
  }

  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.blocked || changes.allowed || changes.enabled) rebuildRules();
});

/* declarativeNetRequestWithHostAccess 를 쓰므로 규칙은 "권한이 허용된 호스트"에만
 * 적용된다. 사용자가 권한을 주거나 회수하면 규칙을 다시 계산해야 한다. */
chrome.permissions.onAdded.addListener(() => rebuildRules());
chrome.permissions.onRemoved.addListener(() => rebuildRules());

/* 서비스 워커는 설치·브라우저 시작·잠에서 깰 때 모두 새로 기동되므로
 * onInstalled / onStartup 리스너 없이 이 한 줄이면 충분하다.
 * (리스너를 함께 두면 같은 시점에 두 번 호출되어 ID 중복 오류를 유발했다) */
initDevice().then(() => {
  rebuildRules();
  Sync.init();
});
