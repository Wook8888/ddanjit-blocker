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

const BLOCK_RULE_BASE = 1;
const ALLOW_RULE_BASE = 100000;
const BLOCK_PRIORITY = 1;
const ALLOW_PRIORITY = 2;

const DEFAULTS = {
  blocked: [],
  allowed: [],
  enabled: true,
  passHash: "",
  salt: "",
  blockPage: {
    title: "잠깐! 지금은 접속할 수 없어요",
    message: "이 사이트는 사용자가 직접 차단 목록에 추가했습니다.\n지금 해야 할 일로 돌아가 볼까요?",
    emoji: "🛑"
  }
};

async function getState() {
  return chrome.storage.local.get(DEFAULTS);
}

/** a 가 b 자신이거나 b의 서브도메인인가 */
function isUnder(a, b) {
  return a === b || a.endsWith("." + b);
}

/** 차단 목록 → 안내 페이지로 리디렉트하는 규칙 (예외 도메인은 조건에서 제외) */
function buildBlockRules(blocked, allowed) {
  return blocked.map((domain, index) => {
    const condition = {
      // ||example.com^  →  example.com 및 모든 서브도메인
      urlFilter: "||" + domain + "^",
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
          extensionPath: "/blocked.html?d=" + encodeURIComponent(domain)
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

async function updateBadge(count, enabled) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#d93025" : "#9aa0a6" });
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  } catch (e) {
    /* 배지 설정 실패는 무시 */
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.blocked || changes.allowed || changes.enabled) rebuildRules();
});

/* declarativeNetRequestWithHostAccess 를 쓰므로 규칙은 "권한이 허용된 호스트"에만
 * 적용된다. 사용자가 권한을 주거나 회수하면 규칙을 다시 계산해야 한다. */
chrome.permissions.onAdded.addListener(() => rebuildRules());
chrome.permissions.onRemoved.addListener(() => rebuildRules());

// 팝업의 "규칙 다시 적용" 버튼용
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "rebuild") {
    rebuildRules()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 비동기 응답
  }
});

/* 서비스 워커는 설치·브라우저 시작·잠에서 깰 때 모두 새로 기동되므로
 * onInstalled / onStartup 리스너 없이 이 한 줄이면 충분하다.
 * (리스너를 함께 두면 같은 시점에 두 번 호출되어 ID 중복 오류를 유발했다) */
rebuildRules();
