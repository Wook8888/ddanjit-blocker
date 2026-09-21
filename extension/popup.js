/* 딴짓 차단기 - 팝업 UI */

const $ = (id) => document.getElementById(id);

let state = null;
let permCache = {}; // domain → boolean

/* ---------- 유틸 (공용 함수는 common.js) ---------- */

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

/* ---------- 잠금 (단어 문제) ---------- */

let currentQ = null;
let lastWord = "";
let answering = false;

function renderQuestion() {
  currentQ = buildQuestion(state.words, lastWord);
  if (!currentQ) return false;
  lastWord = currentQ.word.word;

  $("qWord").textContent = currentQ.word.word;
  $("qIpa").textContent = currentQ.word.ipa || "";
  const tail = [currentQ.word.read, currentQ.word.lang].filter(Boolean).join(" · ");
  $("qRead").textContent = tail;

  const box = $("qOpts");
  box.innerHTML = "";
  currentQ.options.forEach((text, i) => {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.addEventListener("click", () => answer(i, box));
    box.appendChild(btn);
  });
  return true;
}

function answer(picked, box) {
  if (answering) return;
  answering = true;
  const correct = picked === currentQ.answer;

  [...box.children].forEach((btn, i) => {
    btn.disabled = true;
    if (i === currentQ.answer) btn.classList.add("right");
    else if (i === picked) btn.classList.add("wrong");
  });

  if (correct) {
    setMsg($("lockMsg"), "");
    setTimeout(async () => {
      answering = false;
      await markUnlocked();
      await showMain();
    }, 380);
  } else {
    setMsg($("lockMsg"), "다시 한 문제 더.", "err");
    setTimeout(() => {
      answering = false;
      setMsg($("lockMsg"), "");
      renderQuestion();
    }, 950);
  }
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
  $("lockToggle").checked = !!state.lockOn;
  if (document.activeElement !== $("devName")) $("devName").value = state.deviceName || "";
}

/* ---------- 오류 배너 ---------- */

function renderError() {
  const el = $("errorBanner");
  if (state.lastError) {
    el.textContent = "규칙 적용 오류: " + state.lastError;
    el.classList.remove("hidden");
  } else {
    el.classList.add("hidden");
  }
}

/* ---------- 크롬 동기화 줄 ---------- */

async function renderSync() {
  const el = $("syncLine");
  const { syncStatus = {} } = await chrome.storage.local.get("syncStatus");
  if (syncStatus.error) {
    el.textContent = "⚠ " + syncStatus.error;
    el.className = "syncLine err";
    el.title = "";
    return;
  }
  const hist = await readHistory();
  const last = hist[0];
  el.className = "syncLine";
  if (last) {
    el.textContent = `🔄 ${last.d}에서 변경 · ${timeAgo(last.at)}`;
    el.title = "누르면 동기화 기록을 볼 수 있습니다";
  } else {
    el.textContent = "🔄 크롬 동기화";
    el.title = "같은 구글 계정으로 로그인해 동기화를 켠 크롬끼리 목록이 자동으로 맞춰집니다.";
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
  renderSync();
}

async function showMain() {
  $("lock").classList.add("hidden");
  $("main").classList.remove("hidden");
  await reload();
}

function showLock() {
  $("main").classList.add("hidden");
  $("lock").classList.remove("hidden");
  if (!renderQuestion()) {
    // 문제를 만들 단어가 없으면 잠그지 않는다 (잠겨서 못 들어가는 일 방지)
    markUnlocked().then(showMain);
  }
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

  $("backupBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("syncLine").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#history") });
    window.close();
  });

  $("lockToggle").addEventListener("change", async (e) => {
    const on = e.target.checked;
    await save({ lockOn: on });
    if (on) await markUnlocked(); // 방금 켠 사람을 바로 내쫓지 않는다
    showMsg($("lockSetMsg"), on
      ? "잠금을 켰습니다. 다음에 열 때 단어 문제가 나옵니다."
      : "잠금을 껐습니다.", "ok");
  });

  $("saveDevBtn").addEventListener("click", async () => {
    const name = $("devName").value.trim().slice(0, 24);
    await save({ deviceName: name || defaultDeviceName() });
    $("devName").value = state.deviceName;
    showMsg($("devMsg"), "기기 이름을 저장했습니다.", "ok");
  });
  $("devName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("saveDevBtn").click();
  });
}

/* ---------- 시작 ---------- */

// 다른 기기에서 동기화로 목록이 바뀌면 팝업을 연 채로도 바로 반영
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !state || $("main").classList.contains("hidden")) return;
  if (changes.blocked || changes.allowed) {
    state = await chrome.storage.local.get(DEFAULTS);
    await refreshPermissions();
    renderPermissionBanner();
    renderBlockedList();
    renderAllowedList();
  }
  if (changes.syncStatus) renderSync();
});

(async function init() {
  state = await chrome.storage.local.get(DEFAULTS);
  wireEvents();
  if (await isUnlocked(state)) await showMain();
  else showLock();
})();
