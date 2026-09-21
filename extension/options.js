/* 딴짓 차단기 - 동기화 · 백업 페이지 (공용 코드와 잠금 화면은 pagekit.js) */

let pending = null; // 불러오기 확인 대기 중인 데이터

/* ---------------- 동기화된 기기 ---------------- */

function fillChips(el, list) {
  el.innerHTML = "";
  if (!list.length) {
    const none = document.createElement("span");
    none.className = "none";
    none.textContent = "없음";
    el.appendChild(none);
    return;
  }
  for (const d of list) {
    const s = document.createElement("span");
    s.textContent = d;
    el.appendChild(s);
  }
}

/** 기기 한 줄 */
function deviceRow(dev, { isMe, curB, curA }) {
  const b = uniqSorted(dev.b);
  const a = uniqSorted(dev.a);
  const sameAsMine = sameList(b, curB) && sameList(a, curA);

  const row = document.createElement("div");
  row.className = "hrow";
  row.dataset.dev = dev.id;

  const head = document.createElement("button");
  head.className = "hhead";

  const name = document.createElement("span");
  name.className = "hdev";
  name.textContent = dev.d;
  head.appendChild(name);
  if (isMe) head.appendChild(tag("이 기기", "now"));
  if (dev.off) head.appendChild(tag("동기화 꺼짐"));

  const info = document.createElement("span");
  info.className = "hcount";
  info.textContent = `${dev.at ? stampShort(dev.at) + " 기준 · " : ""}차단 ${b.length} · 예외 ${a.length}`;
  head.appendChild(info);

  const body = document.createElement("div");
  body.className = "hbody";
  body.hidden = true;

  const l1 = document.createElement("div"); l1.className = "lbl"; l1.textContent = "차단";
  const d1 = document.createElement("div"); d1.className = "doms"; fillChips(d1, b);
  const l2 = document.createElement("div"); l2.className = "lbl"; l2.textContent = "예외";
  const d2 = document.createElement("div"); d2.className = "doms"; fillChips(d2, a);
  body.append(l1, d1, l2, d2);

  const actions = document.createElement("div");
  actions.className = "row";

  if (isMe) {
    const on = state.syncOn !== false;
    const btn = document.createElement("button");
    btn.dataset.act = "toggle";
    btn.textContent = on ? "이 기기 동기화 끄기" : "이 기기 동기화 켜기";
    btn.addEventListener("click", async () => {
      await chrome.storage.local.set({ syncOn: !on });
      await reloadState();
      setMsg($("devMsg"), !on
        ? "동기화를 켰습니다. 10분 동안은 다른 기기 목록과 합칩니다."
        : "동기화를 껐습니다. 이제 이 기기 목록은 이 기기에서만 쓰입니다.", "ok");
      await renderDevices();
    });
    actions.appendChild(btn);
  } else {
    if (!sameAsMine) {
      actions.appendChild(confirmButton("이 목록 가져오기", "정말 가져올까요? 한 번 더", "adopt",
        () => adoptFrom(dev)));
    }
    // 지금 기능: 목록의 이 줄만 지운다. 그 기기의 차단·동기화는 그대로이고, 켜져 있으면 다시 나타난다.
    actions.appendChild(confirmButton("안 쓰는 기기 정리", "켜져 있는 기기면 다시 나타납니다. 한 번 더", "delete",
      () => deleteDevice(dev)));
  }
  body.appendChild(actions);
  if (!isMe) {
    const note = document.createElement("div");
    note.className = "devNote";
    note.textContent = "안 쓰는 기기 정리: 더 이상 쓰지 않는 기기를 이 목록에서만 지웁니다. 그 기기의 차단과 동기화는 바뀌지 않으며, 그 기기가 켜져서 동기화하면 다시 나타납니다.";
    body.appendChild(note);
  }

  head.addEventListener("click", () => { body.hidden = !body.hidden; });
  row.append(head, body);
  return row;
}

async function renderDevices() {
  const box = $("devList");
  const all = await readDevices();
  box.innerHTML = "";

  const { syncStatus = {} } = await chrome.storage.local.get("syncStatus");
  if (syncStatus.devOff) {
    setMsg($("devMsg"),
      "차단 목록이 너무 길어 이 기기 상태를 동기화 목록에 올리지 못하고 있습니다. (크롬 동기화는 항목 하나에 8KB까지만 담깁니다) 차단은 그대로 동작합니다.",
      "warn");
  }

  const curB = uniqSorted(state.blocked);
  const curA = uniqSorted(state.allowed);

  // 이 기기는 늘 맨 위에, 지금 이 기기의 실제 목록으로 보여준다
  const mineInSync = all.find((d) => d.id === state.deviceId);
  const me = {
    id: state.deviceId || "me",
    d: state.deviceName || "이 기기",
    at: mineInSync ? mineInSync.at : 0,
    b: curB, a: curA,
    off: state.syncOn === false
  };
  box.appendChild(deviceRow(me, { isMe: true, curB, curA }));

  const others = all.filter((d) => d.id !== state.deviceId);
  for (const d of others) box.appendChild(deviceRow(d, { isMe: false, curB, curA }));

  if (!others.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "아직 다른 기기가 없습니다. 같은 구글 계정의 다른 크롬에 설치하면 여기에 나타납니다.";
    box.appendChild(p);
  }
}

/** 다른 기기의 목록을 이 기기로 가져온다 (동기화가 켜져 있으면 다른 기기에도 퍼진다) */
async function adoptFrom(dev) {
  const blocked = uniqSorted(dev.b);
  const allowed = uniqSorted(dev.a).filter((d) => !blocked.includes(d));
  await chrome.storage.local.set({ blocked, allowed });
  await reloadState();
  setMsg($("devMsg"),
    `${dev.d} 목록을 가져왔습니다 — 차단 ${blocked.length}개 · 예외 ${allowed.length}개.` +
    (state.syncOn !== false ? " 동기화 중인 다른 기기에도 곧 반영됩니다." : ""),
    "ok");
  await renderDevices();
  await refreshPermCard();
}

/** 다른 기기의 칸을 지운다. 그 기기가 동기화를 켠 채 다시 목록을 바꾸면 다시 나타난다. */
async function deleteDevice(dev) {
  await chrome.storage.sync.remove(DEVICE_PREFIX + dev.id);
  setMsg($("devMsg"),
    `${dev.d} 을(를) 목록에서 정리했습니다. 그 기기가 켜져서 동기화하면 다시 나타납니다.`, "ok");
  await renderDevices();
}

/* ---------------- 이전 목록 보관함 ---------------- */

function diffText(label, from, to) {
  const add = to.filter((d) => !from.includes(d)).length;
  const del = from.filter((d) => !to.includes(d)).length;
  if (!add && !del) return `${label} 그대로`;
  return `${label} ` + [add ? `+${add}` : "", del ? `−${del}` : ""].filter(Boolean).join(" ");
}

function versionRow(v, curB, curA) {
  const b = uniqSorted(v.b);
  const a = uniqSorted(v.a);
  const same = sameList(b, curB) && sameList(a, curA);

  const row = document.createElement("div");
  row.className = "hrow";
  row.dataset.ver = v.key;

  const head = document.createElement("button");
  head.className = "hhead";
  const name = document.createElement("span");
  name.className = "hdev";
  name.textContent = `${stampShort(v.c)}에 고치기 전 목록`;
  head.appendChild(name);
  if (same) head.appendChild(tag("지금과 같음"));
  const info = document.createElement("span");
  info.className = "hcount";
  info.textContent = `차단 ${b.length} · 예외 ${a.length}`;
  head.appendChild(info);

  const body = document.createElement("div");
  body.className = "hbody";
  body.hidden = true;

  if (!same) {
    const diff = document.createElement("div");
    diff.className = "diff";
    diff.innerHTML = "되돌리면 지금보다 <b></b>";
    diff.querySelector("b").textContent = `${diffText("차단", curB, b)} · ${diffText("예외", curA, a)}`;
    body.appendChild(diff);
  }
  const l1 = document.createElement("div"); l1.className = "lbl"; l1.textContent = "차단";
  const d1 = document.createElement("div"); d1.className = "doms"; fillChips(d1, b);
  const l2 = document.createElement("div"); l2.className = "lbl"; l2.textContent = "예외";
  const d2 = document.createElement("div"); d2.className = "doms"; fillChips(d2, a);
  body.append(l1, d1, l2, d2);

  if (!same) {
    const actions = document.createElement("div");
    actions.className = "row";
    actions.appendChild(confirmButton("이 시점으로 되돌리기", "정말 되돌릴까요? 한 번 더", "restore",
      () => restoreVersion(v)));
    body.appendChild(actions);
  }

  head.addEventListener("click", () => { body.hidden = !body.hidden; });
  row.append(head, body);
  return row;
}

async function renderVersions() {
  const box = $("verList");
  const list = await readVersions();
  // 펼쳐 둔 줄은 다시 그려도 펼친 채로
  const open = new Set([...box.querySelectorAll(".hrow")]
    .filter((r) => !r.querySelector(".hbody").hidden).map((r) => r.dataset.ver));
  box.innerHTML = "";
  if (!list.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "아직 기록이 없습니다. 차단·예외 목록이 바뀌면 바뀌기 직전 상태가 여기에 남습니다.";
    box.appendChild(p);
    return;
  }
  const curB = uniqSorted(state.blocked);
  const curA = uniqSorted(state.allowed);
  for (const v of list) {
    const row = versionRow(v, curB, curA);
    if (open.has(v.key)) row.querySelector(".hbody").hidden = false;
    box.appendChild(row);
  }
}

/** 기록의 차단·예외 목록으로 되돌린다. 동기화가 켜져 있으면 다른 기기에도 퍼지고,
 *  되돌리기 직전 상태도 기록에 남는다 (백그라운드가 올릴 때). */
async function restoreVersion(v) {
  const blocked = uniqSorted(v.b);
  const allowed = uniqSorted(v.a).filter((d) => !blocked.includes(d));
  await chrome.storage.local.set({ blocked, allowed });
  await reloadState();
  setMsg($("verMsg"),
    `${stampShort(v.c)}에 고치기 전 목록으로 되돌렸습니다 — 차단 ${blocked.length}개 · 예외 ${allowed.length}개.` +
    (state.syncOn !== false
      ? " 동기화 중인 다른 기기에도 곧 반영됩니다."
      : " 이 기기는 동기화가 꺼져 있어 이 기기 목록만 바뀌었습니다."),
    "ok");
  await renderVersions();
  await renderDevices();
  await refreshPermCard();
}

/* ---------------- 상태 ↔ 엑셀 ---------------- */

function toSheets() {
  return [
    { name: SHEET_BLOCK, widths: [44], rows: [["도메인"], ...state.blocked.map((d) => [d])] },
    { name: SHEET_ALLOW, widths: [44], rows: [["도메인"], ...state.allowed.map((d) => [d])] },
    { name: SHEET_SETTINGS, widths: [24, 64], rows: [
      ["항목", "값"],
      ["내보낸 시각", new Date().toLocaleString("ko-KR")],
      ["확장 프로그램 버전", chrome.runtime.getManifest().version]
    ] },
    { name: SHEET_GUIDE, header: false, widths: [96], rows: [
      ["딴짓 차단기 백업 파일"],
      [""],
      ["• '차단목록'과 '예외목록' 시트의 A열에 도메인을 한 줄에 하나씩 적으세요. 첫 줄(제목)은 읽지 않습니다."],
      ["• https:// 나 뒤쪽 경로가 붙어 있어도 도메인만 읽습니다. 예) https://www.youtube.com/watch → youtube.com"],
      ["• 잠금 문제 단어는 이 파일에 들어가지 않습니다. 팝업 설정 → 잠금 문제 단어에서 단어 엑셀 파일을 쓰세요."]
    ] }
  ];
}

function exportBytes() {
  return XlsxLite.write(toSheets());
}

function readDomainColumn(rows, normalizer) {
  const valid = [];
  const invalid = [];
  (rows || []).forEach((row, i) => {
    const raw = String((row && row[0]) ?? "").trim();
    if (!raw) return;
    const d = normalizer(raw);
    if (d) valid.push(d);
    else if (i > 0) invalid.push(raw); // 첫 줄은 제목이므로 조용히 넘긴다
  });
  return { list: uniqSorted(valid), invalid };
}

function parseBook(book) {
  let blockRows = findSheet(book, SHEET_BLOCK);
  const allowRows = findSheet(book, SHEET_ALLOW);
  const wordRowsIn = findSheet(book, SHEET_WORDS);

  let guessed = false;
  if (!blockRows && !allowRows) {
    // 우리 형식이 아닌 파일 → 첫 시트의 A열을 차단 목록으로 본다
    const first = Object.keys(book)[0];
    if (!first) throw new Error("비어 있는 파일입니다.");
    blockRows = book[first];
    guessed = true;
  }

  const b = readDomainColumn(blockRows, normalizeBlockDomain);
  const a = readDomainColumn(allowRows, normalizeDomain);

  // 단어 시트는 읽지 않는다 (단어는 단어 파일로 따로). 예전 합본 파일이면 알려만 준다.
  const hasWordSheet = !!wordRowsIn;

  return {
    blocked: b.list,
    allowed: a.list.filter((d) => !b.list.includes(d)),
    conflicts: a.list.filter((d) => b.list.includes(d)),
    hasWordSheet,
    invalid: [...b.invalid, ...a.invalid],
    guessed
  };
}

/* ---------------- 불러오기 확인 · 적용 ---------------- */

function openPreview(data, sourceLabel) {
  pending = data;
  const mergedB = uniqSorted([...state.blocked, ...data.blocked]);
  const mergedA = uniqSorted([...state.allowed, ...data.allowed]).filter((d) => !mergedB.includes(d));
  $("dlgFrom").textContent = sourceLabel + (data.guessed
    ? " · 딴짓 차단기 형식이 아니어서 첫 시트의 A열을 차단 목록으로 읽었습니다"
    : "");
  $("cB0").textContent = state.blocked.length;
  $("cB1").textContent = data.blocked.length;
  $("cB2").textContent = `${mergedB.length} (+${mergedB.length - state.blocked.length})`;
  $("cA0").textContent = state.allowed.length;
  $("cA1").textContent = data.allowed.length;
  $("cA2").textContent = `${mergedA.length} (+${mergedA.length - state.allowed.length})`;

  const removed = state.blocked.filter((d) => !data.blocked.includes(d)).length;
  $("overwriteDesc").textContent =
    "지금 목록을 지우고 파일 내용으로 바꿉니다." +
    (removed ? ` 현재 차단 중인 ${removed}개가 목록에서 빠집니다.` : "");

  const notes = [];
  if (data.invalid.length) {
    const shown = data.invalid.slice(0, 8).join(", ");
    notes.push(`주소로 읽을 수 없어 건너뛴 칸 ${data.invalid.length}개: ${shown}${data.invalid.length > 8 ? " …" : ""}`);
  }
  if (data.hasWordSheet) {
    notes.push("이 파일의 '단어' 시트는 읽지 않습니다. 단어는 팝업 설정 → 잠금 문제 단어 화면의 '단어 엑셀 불러오기'로 따로 가져오세요.");
  }
  if (data.conflicts.length) {
    notes.push(`차단과 예외 양쪽에 있는 주소 ${data.conflicts.length}개는 차단으로 처리합니다: ${data.conflicts.join(", ")}`);
  }
  const inv = $("dlgInvalid");
  inv.textContent = notes.join("\n");
  inv.style.whiteSpace = "pre-line";
  inv.hidden = notes.length === 0;
  $("dlg").showModal();
}

async function applyImport(mode) {
  const d = pending;
  if (!d) return;
  let blocked, allowed;

  if (mode === "merge") {
    blocked = uniqSorted([...state.blocked, ...d.blocked]);
    allowed = uniqSorted([...state.allowed, ...d.allowed]);
  } else {
    blocked = d.blocked;
    allowed = d.allowed;
  }
  allowed = allowed.filter((x) => !blocked.includes(x));

  await chrome.storage.local.set({ blocked, allowed });
  await reloadState();
  $("dlg").close();
  pending = null;

  const label = mode === "merge" ? "합쳤습니다" : "덮어썼습니다";
  setMsg($("fileMsg"), `${label} — 차단 ${blocked.length}개 · 예외 ${allowed.length}개`, "ok");
  await refreshPermCard();
  setTimeout(() => { renderDevices(); renderVersions(); }, 2500);
}

/* ---------------- 사이트 권한 ---------------- */

async function missingPerms() {
  const out = [];
  for (const d of state.blocked) {
    let ok = false;
    try { ok = await chrome.permissions.contains({ origins: [originPattern(d)] }); } catch (e) { /* 무시 */ }
    if (!ok) out.push(d);
  }
  return out;
}

async function refreshPermCard() {
  const miss = await missingPerms();
  $("permCard").hidden = miss.length === 0;
  if (miss.length) {
    $("permDesc").textContent =
      `${miss.length}개 사이트는 아직 차단되지 않습니다. 사이트 접근 권한을 허용해야 차단이 적용됩니다.`;
    $("permBtn").onclick = () => {
      // 클릭 직후 바로 호출해야 크롬이 권한 창을 띄운다
      chrome.permissions.request({ origins: miss.map(originPattern) })
        .then(async (granted) => {
          setMsg($("permMsg"), granted ? "권한을 허용했습니다." : "권한 허용이 취소되었습니다.", granted ? "ok" : "warn");
          await refreshPermCard();
        })
        .catch((e) => setMsg($("permMsg"), String(e.message || e), "err"));
    };
  }
}

/* ---------------- 파일 ---------------- */

function onExport() {
  try {
    download(exportBytes(), `딴짓차단기_목록_${stamp()}.xlsx`);
    setMsg($("fileMsg"), `내보냈습니다 — 차단 ${state.blocked.length}개 · 예외 ${state.allowed.length}개`, "ok");
  } catch (e) {
    setMsg($("fileMsg"), "내보내기 실패: " + (e.message || e), "err");
  }
}

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    setMsg($("fileMsg"), "읽는 중…");
    const data = parseBook(await XlsxLite.read(await file.arrayBuffer()));
    setMsg($("fileMsg"), "");
    openPreview(data, `파일: ${file.name}`);
  } catch (err) {
    setMsg($("fileMsg"), "불러오기 실패: " + (err.message || err), "err");
  }
}

/* ---------------- 시작 ---------------- */

async function showMain() {
  $("lock").hidden = true;
  $("main").hidden = false;
  await renderDevices();
  await renderVersions();
  await refreshPermCard();
}

function wire() {
  $("exportBtn").addEventListener("click", onExport);
  $("importBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", onFilePicked);
  $("mergeBtn").addEventListener("click", () => applyImport("merge"));
  $("overwriteBtn").addEventListener("click", () => applyImport("overwrite"));
  $("cancelBtn").addEventListener("click", () => { pending = null; $("dlg").close(); });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if ($("main").hidden) return;
    if (area === "local" && (changes.blocked || changes.allowed ||
                              changes.syncOn || changes.deviceName || changes.syncStatus)) {
      await reloadState();
      await renderDevices();
      await renderVersions();
    } else if (area === "sync") {
      await renderDevices();
      await renderVersions();
    }
  });
}

(async function init() {
  await reloadState();
  wire();
  if (await isUnlocked(state)) await showMain();
  else showLock();
})();
