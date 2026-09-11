/* 딴짓 차단기 - 팝업 UI */

const DEFAULTS = {
  blocked: [],
  allowed: [],
  enabled: true,
  passHash: "",
  salt: "",
  lastError: "",
  blockPage: {
    title: "잠깐! 지금은 접속할 수 없어요",
    message: "이 사이트는 사용자가 직접 차단 목록에 추가했습니다.\n지금 해야 할 일로 돌아가 볼까요?",
    emoji: "🛑"
  }
};

const UNLOCK_MINUTES = 5;
const ALLOW_RULE_BASE = 100000;
const $ = (id) => document.getElementById(id);

let state = null;
let permCache = {}; // domain → boolean

/* ---------- 유틸 ---------- */

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSalt() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function showMsg(el, text, kind) {
  setMsg(el, text, kind);
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
}

async function save(patch) {
  Object.assign(state, patch);
  await chrome.storage.local.set(patch);
}

/* ---------- 사이트별 권한 ---------- */

/** 도메인과 모든 서브도메인을 포함하는 match pattern */
function originPattern(domain) {
  return "*://*." + domain + "/*";
}

async function refreshPermissions() {
  permCache = {};
  for (const domain of state.blocked) {
    try {
      permCache[domain] = await chrome.permissions.contains({
        origins: [originPattern(domain)]
      });
    } catch (e) {
      permCache[domain] = false;
    }
  }
}

function missingPermissionDomains() {
  return state.blocked.filter((d) => !permCache[d]);
}

/**
 * 권한 요청. 반드시 클릭 핸들러에서 await 없이 곧바로 호출해야 한다
 * (사용자 제스처가 끊기면 크롬이 요청을 거부한다).
 * 권한 창이 뜨면 팝업이 닫힐 수 있는데, 그래도 백그라운드가
 * permissions.onAdded 를 받아 규칙을 다시 적용하므로 문제없다.
 */
function requestOrigins(domains) {
  return chrome.permissions.request({
    origins: domains.map(originPattern)
  });
}

/* ---------- 잠금 ---------- */

async function isUnlocked() {
  if (!state.passHash) return true;
  const { unlockUntil = 0 } = await chrome.storage.session.get({ unlockUntil: 0 });
  return Date.now() < unlockUntil;
}

async function markUnlocked() {
  await chrome.storage.session.set({ unlockUntil: Date.now() + UNLOCK_MINUTES * 60 * 1000 });
}

async function checkPassword(input) {
  return (await sha256(state.salt + ":" + input)) === state.passHash;
}

/* ---------- 목록 렌더링 ---------- */

function makeDeleteButton(onClick) {
  const btn = document.createElement("button");
  btn.className = "del";
  btn.title = "삭제";
  btn.textContent = "✕";
  btn.addEventListener("click", onClick);
  return btn;
}

function emptyRow(ul, text) {
  const li = document.createElement("li");
  li.className = "empty";
  li.textContent = text;
  ul.appendChild(li);
}

function renderBlockedList() {
  const ul = $("list");
  ul.innerHTML = "";
  if (state.blocked.length === 0) {
    emptyRow(ul, "차단된 사이트가 없습니다.");
    return;
  }
  state.blocked.forEach((domain) => {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.textContent = domain;
    li.appendChild(left);

    const right = document.createElement("span");
    right.className = "rowRight";

    if (!permCache[domain]) {
      const grant = document.createElement("button");
      grant.className = "chip";
      grant.textContent = "권한 허용";
      grant.title = "이 사이트를 차단하려면 접근 권한이 필요합니다";
      grant.addEventListener("click", () => {
        // await 없이 즉시 호출 — 사용자 제스처 유지
        requestOrigins([domain]).then(() => reload()).catch(() => {});
      });
      right.appendChild(grant);
    }
    right.appendChild(makeDeleteButton(async () => {
      await save({ blocked: state.blocked.filter((d) => d !== domain) });
      reload();
    }));

    li.appendChild(right);
    ul.appendChild(li);
  });
}

function renderAllowedList() {
  const ul = $("allowList");
  ul.innerHTML = "";
  if (state.allowed.length === 0) {
    emptyRow(ul, "예외가 없습니다.");
    return;
  }
  state.allowed.forEach((domain) => {
    const li = document.createElement("li");
    li.className = "allowItem";
    const span = document.createElement("span");
    span.textContent = domain;
    li.append(span, makeDeleteButton(async () => {
      await save({ allowed: state.allowed.filter((d) => d !== domain) });
      reload();
    }));
    ul.appendChild(li);
  });
}

function renderPermissionBanner() {
  const el = $("permBanner");
  const missing = missingPermissionDomains();
  el.innerHTML = "";
  if (missing.length === 0) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");

  const text = document.createElement("div");
  text.textContent =
    missing.length + "개 사이트가 아직 차단되지 않습니다. 접근 권한이 필요합니다.";
  el.appendChild(text);

  const btn = document.createElement("button");
  btn.className = "primary";
  btn.style.marginTop = "7px";
  btn.textContent = "권한 한 번에 허용";
  btn.addEventListener("click", () => {
    requestOrigins(missing).then(() => reload()).catch(() => {});
  });
  el.appendChild(btn);
}

function renderSettings() {
  $("enabledToggle").checked = state.enabled;
  $("statusText").textContent = state.enabled ? "차단 작동 중" : "차단 일시 중지됨";
  $("bpEmoji").value = state.blockPage.emoji;
  $("bpTitle").value = state.blockPage.title;
  $("bpMessage").value = state.blockPage.message;
  const hasPw = !!state.passHash;
  $("pwLabel").textContent = hasPw ? "비밀번호 변경 / 해제" : "비밀번호 설정";
  $("pwCurrent").classList.toggle("hidden", !hasPw);
}

/* ---------- 진단 ---------- */

function describeRule(r) {
  const kind = r.id >= ALLOW_RULE_BASE ? "예외" : "차단";
  const filter = (r.condition && r.condition.urlFilter) || "?";
  const excl = r.condition && r.condition.excludedRequestDomains;
  return `#${r.id} p${r.priority} ${kind}(${r.action.type})  ${filter}` +
         (excl && excl.length ? `\n      └ 제외: ${excl.join(", ")}` : "");
}

async function renderRuleDump() {
  const el = $("ruleDump");
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    if (!rules.length) {
      el.textContent = "등록된 규칙이 없습니다.";
      return;
    }
    rules.sort((a, b) => a.id - b.id);
    el.textContent = rules.map(describeRule).join("\n");
  } catch (e) {
    el.textContent = "규칙을 읽지 못했습니다: " + String((e && e.message) || e);
  }
}

function renderError() {
  const el = $("errorBanner");
  if (state.lastError) {
    el.textContent = "규칙 적용 오류: " + state.lastError;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

async function runTest() {
  const el = $("testResult");
  let raw = $("testUrl").value.trim();
  if (!raw) {
    setMsg(el, "테스트할 주소를 입력하세요.", "err");
    return;
  }
  if (!/^[a-z]+:\/\//i.test(raw)) raw = "https://" + raw;

  if (!chrome.declarativeNetRequest.testMatchOutcome) {
    setMsg(el, "이 크롬 버전에서는 테스트 기능을 쓸 수 없습니다.", "err");
    return;
  }
  try {
    const res = await chrome.declarativeNetRequest.testMatchOutcome({
      url: raw,
      type: "main_frame",
      method: "get"
    });
    const matched = res.matchedRules || [];
    if (!matched.length) {
      setMsg(el, "✅ 통과 — 어떤 규칙에도 걸리지 않습니다.", "ok");
      return;
    }
    const ids = matched.map((m) => m.ruleId);
    const blockedBy = ids.filter((id) => id < ALLOW_RULE_BASE);
    const allowedBy = ids.filter((id) => id >= ALLOW_RULE_BASE);
    if (allowedBy.length) {
      setMsg(el, `✅ 허용 — 예외 규칙 #${allowedBy.join(", #")} 이 적용됩니다.`, "ok");
    } else {
      setMsg(el, `🛑 차단 — 차단 규칙 #${blockedBy.join(", #")} 에 걸립니다.`, "err");
    }
  } catch (e) {
    setMsg(el, "테스트 실패: " + String((e && e.message) || e), "err");
  }
}

/* ---------- 화면 전환 ---------- */

async function reload() {
  state = await chrome.storage.local.get(DEFAULTS);
  await refreshPermissions();
  renderPermissionBanner();
  renderBlockedList();
  renderAllowedList();
  renderSettings();
  renderError();
  setTimeout(renderRuleDump, 400);
}

async function showMain() {
  $("lock").classList.add("hidden");
  $("main").classList.remove("hidden");
  await reload();
}

function showLock() {
  $("main").classList.add("hidden");
  $("lock").classList.remove("hidden");
  $("unlockInput").focus();
}

/* ---------- 추가 동작 ---------- */

async function addBlocked() {
  const domain = normalizeBlockDomain($("domainInput").value);
  if (!domain) {
    showMsg($("addMsg"), "올바른 주소를 입력하세요. (예: naver.com)", "err");
    return;
  }
  if (state.blocked.includes(domain)) {
    showMsg($("addMsg"), "이미 차단 목록에 있습니다.", "err");
    return;
  }
  await save({ blocked: [...state.blocked, domain].sort() });
  $("domainInput").value = "";
  await reload();

  const covered = state.allowed.filter((a) => isUnder(a, domain));
  const suffix = covered.length ? ` · 예외 유지: ${covered.join(", ")}` : "";
  if (permCache[domain]) {
    showMsg($("addMsg"), domain + " 차단됨" + suffix, "ok");
  } else {
    showMsg($("addMsg"), `${domain} 추가됨 · 아래 "권한 허용"을 눌러야 실제로 차단됩니다.`, "warn");
  }
}

async function addAllowed() {
  const domain = normalizeDomain($("allowInput").value);
  if (!domain) {
    showMsg($("allowMsg"), "올바른 주소를 입력하세요. (예: map.naver.com)", "err");
    return;
  }
  if (state.allowed.includes(domain)) {
    showMsg($("allowMsg"), "이미 예외 목록에 있습니다.", "err");
    return;
  }
  if (state.blocked.includes(domain)) {
    showMsg($("allowMsg"), "차단 목록과 같은 도메인입니다. 차단 목록에서 삭제하세요.", "err");
    return;
  }
  await save({ allowed: [...state.allowed, domain].sort() });
  $("allowInput").value = "";
  await reload();

  const parent = state.blocked.find((b) => isUnder(domain, b));
  if (parent) {
    showMsg($("allowMsg"), `${domain} 허용됨 (${parent} 차단보다 우선)`, "ok");
  } else {
    showMsg($("allowMsg"), `${domain} 추가됨 · 상위 차단 도메인이 없어 지금은 효과가 없습니다.`, "warn");
  }
}

/* ---------- 이벤트 ---------- */

function wireEvents() {
  $("unlockBtn").addEventListener("click", async () => {
    if (await checkPassword($("unlockInput").value)) {
      await markUnlocked();
      await showMain();
    } else {
      showMsg($("lockMsg"), "비밀번호가 올바르지 않습니다.", "err");
      $("unlockInput").select();
    }
  });
  $("unlockInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("unlockBtn").click();
  });

  $("enabledToggle").addEventListener("change", async (e) => {
    await save({ enabled: e.target.checked });
    renderSettings();
  });

  $("addBtn").addEventListener("click", addBlocked);
  $("domainInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBlocked();
  });

  $("allowAddBtn").addEventListener("click", addAllowed);
  $("allowInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addAllowed();
  });

  $("testBtn").addEventListener("click", runTest);
  $("testUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runTest();
  });

  $("reloadRulesBtn").addEventListener("click", async () => {
    setMsg($("reloadMsg"), "적용 중…", "");
    try {
      const res = await chrome.runtime.sendMessage({ type: "rebuild" });
      if (res && res.ok) {
        await reload();
        setMsg($("reloadMsg"), "규칙을 다시 적용했습니다.", "ok");
      } else {
        setMsg($("reloadMsg"), "실패: " + ((res && res.error) || "응답 없음"), "err");
      }
    } catch (e) {
      setMsg($("reloadMsg"), "실패: " + String((e && e.message) || e), "err");
    }
  });

  $("savePageBtn").addEventListener("click", async () => {
    await save({
      blockPage: {
        emoji: $("bpEmoji").value.trim() || "🛑",
        title: $("bpTitle").value.trim() || DEFAULTS.blockPage.title,
        message: $("bpMessage").value
      }
    });
    showMsg($("pageMsg"), "차단 페이지를 저장했습니다.", "ok");
  });

  $("savePwBtn").addEventListener("click", async () => {
    const hasPw = !!state.passHash;
    if (hasPw && !(await checkPassword($("pwCurrent").value))) {
      showMsg($("pwMsg"), "현재 비밀번호가 올바르지 않습니다.", "err");
      return;
    }
    const next = $("pwNew").value;
    if (!next) {
      await save({ passHash: "", salt: "" });
      await chrome.storage.session.remove("unlockUntil");
      showMsg($("pwMsg"), hasPw ? "비밀번호를 해제했습니다." : "비밀번호를 입력하세요.", hasPw ? "ok" : "err");
    } else if (next.length < 4) {
      showMsg($("pwMsg"), "비밀번호는 4자 이상이어야 합니다.", "err");
      return;
    } else {
      const salt = randomSalt();
      await save({ salt, passHash: await sha256(salt + ":" + next) });
      await markUnlocked();
      showMsg($("pwMsg"), "비밀번호를 저장했습니다.", "ok");
    }
    $("pwCurrent").value = "";
    $("pwNew").value = "";
    renderSettings();
  });
}

/* ---------- 시작 ---------- */

(async function init() {
  state = await chrome.storage.local.get(DEFAULTS);
  wireEvents();
  if (await isUnlocked()) await showMain();
  else showLock();
})();
