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

async function renderProgress() {
  const need = quizNeed(state);
  $("lockNeed").textContent = quizHintText(need);
  $("qProg").textContent = quizProgText(Math.min(await getQuizDone(), need), need);
}

async function answer(picked, box) {
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
    const need = quizNeed(state);
    const done = (await getQuizDone()) + 1;
    if (done < need) {
      await setQuizDone(done);
      await renderProgress();
    }
    setTimeout(async () => {
      answering = false;
      if (done >= need) {
        await markUnlocked();
        await showMain();
      } else {
        renderQuestion();
      }
    }, 380);
  } else {
    const sec = wrongPauseSec(state);
    setMsg($("lockMsg"), `틀렸어요. 초록색이 정답 · ${sec}초 뒤 다음 문제`, "err");
    setTimeout(() => {
      answering = false;
      setMsg($("lockMsg"), "");
      renderQuestion();
    }, sec * 1000); // 틀리면 정답 뜻을 볼 수 있게 정한 시간만큼 멈춘다
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
  $("quizCount").value = String(quizNeed(state));
  $("wrongPause").value = String(wrongPauseSec(state));
  $("syncToggle").checked = state.syncOn !== false;
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
  el.className = "syncLine";
  el.title = "누르면 동기화된 기기를 볼 수 있습니다";
  if (state.syncOn === false) {
    el.textContent = "⏸ 이 기기 동기화 꺼짐 · 이 기기 목록만 사용";
    return;
  }
  const others = (await readDevices()).filter((d) => d.id !== state.deviceId && !d.off);
  el.textContent = others.length
    ? `🔄 ${others.length + 1}대 기기와 동기화 중`
    : "🔄 크롬 동기화 켜짐";
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
  renderProgress();
  setupPauseSelect($("lockPause"), state);
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
  $("wordsBtn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("words.html") });
    window.close();
  });
  $("syncLine").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#devices") });
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

  for (let n = 1; n <= QUIZ_MAX; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = n + "개";
    $("quizCount").appendChild(o);
  }
  $("quizCount").addEventListener("change", async (e) => {
    const n = quizNeed({ quizCount: e.target.value });
    await save({ quizCount: n });
    await setQuizDone(0);
    showMsg($("lockSetMsg"), `잠금을 풀려면 문제 ${n}개를 맞혀야 합니다.`, "ok");
  });

  for (let n = 1; n <= PAUSE_MAX; n++) {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = n + "초";
    $("wrongPause").appendChild(o);
  }
  $("wrongPause").addEventListener("change", async (e) => {
    const n = wrongPauseSec({ wrongPause: e.target.value });
    await save({ wrongPause: n });
    showMsg($("lockSetMsg"), `틀리면 정답을 ${n}초 동안 보여준 뒤 다음 문제로 넘어갑니다.`, "ok");
  });

  $("syncToggle").addEventListener("change", async (e) => {
    const on = e.target.checked;
    await save({ syncOn: on });
    showMsg($("syncSetMsg"), on
      ? "동기화를 켰습니다. 10분 동안은 다른 기기 목록과 합칩니다."
      : "동기화를 껐습니다. 이제 이 기기 목록은 이 기기에서만 쓰입니다.", "ok");
    renderSync();
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && state && !$("main").classList.contains("hidden")) renderSync();
});

(async function init() {
  state = await chrome.storage.local.get(DEFAULTS);
  wireEvents();
  if (await isUnlocked(state)) await showMain();
  else showLock();
})();
