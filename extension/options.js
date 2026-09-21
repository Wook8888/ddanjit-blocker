/* 딴짓 차단기 - 동기화 · 백업 페이지 */

const $ = (id) => document.getElementById(id);
let state = null;
let pending = null; // 불러오기 확인 대기 중인 데이터

const SHEET_BLOCK = "차단목록";
const SHEET_ALLOW = "예외목록";
const SHEET_SETTINGS = "설정";
const SHEET_WORDS = "단어";
const SHEET_GUIDE = "안내";

const WORD_HEADER = ["단어", "언어", "발음기호", "한국어 발음", "뜻"];

/* ---------------- 공통 ---------------- */

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

async function reloadState() {
  state = await chrome.storage.local.get(DEFAULTS);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

const uniqSorted = (arr) => [...new Set(arr || [])].sort();
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ---------------- 잠금 (단어 문제) ---------------- */

let currentQ = null;
let lastWord = "";
let answering = false;

function renderQuestion() {
  currentQ = buildQuestion(state.words, lastWord);
  if (!currentQ) return false;
  lastWord = currentQ.word.word;

  $("qWord").textContent = currentQ.word.word;
  $("qIpa").textContent = currentQ.word.ipa || "";
  $("qRead").textContent = [currentQ.word.read, currentQ.word.lang].filter(Boolean).join(" · ");

  const box = $("qOpts");
  box.innerHTML = "";
  currentQ.options.forEach((text, i) => {
    const btn = document.createElement("button");
    btn.textContent = text;
    btn.addEventListener("click", () => answerQuestion(i, box));
    box.appendChild(btn);
  });
  return true;
}

function answerQuestion(picked, box) {
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

function showLock() {
  $("main").hidden = true;
  $("lock").hidden = false;
  if (!renderQuestion()) markUnlocked().then(showMain);
}

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

/** 두 번 눌러야 실행되는 버튼 (실수 방지) */
function confirmButton(label, armedLabel, act, onConfirm) {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.dataset.act = act;
  let armed = false;
  btn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      btn.textContent = armedLabel;
      btn.classList.add("primary");
      setTimeout(() => {
        if (!armed) return;
        armed = false;
        btn.textContent = label;
        btn.classList.remove("primary");
      }, 4000);
      return;
    }
    armed = false;
    onConfirm();
  });
  return btn;
}

function tag(text, cls) {
  const t = document.createElement("span");
  t.className = "tag" + (cls ? " " + cls : "");
  t.textContent = text;
  return t;
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
    actions.appendChild(confirmButton("목록에서 삭제", "정말 삭제할까요? 한 번 더", "delete",
      () => deleteDevice(dev)));
  }
  body.appendChild(actions);

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
    `${dev.d} 을(를) 목록에서 지웠습니다. 그 기기가 동기화를 켠 채로 다시 쓰이면 다시 나타납니다.`, "ok");
  await renderDevices();
}

/* ---------------- 단어 ---------------- */

function renderWords() {
  const mine = usableWords(state.words);
  const el = $("wordDesc");
  if (mine.length >= QUIZ_CHOICES) {
    el.textContent = `직접 정한 단어 ${mine.length}개로 문제를 냅니다.`;
  } else if (mine.length) {
    el.textContent = `직접 정한 단어가 ${mine.length}개뿐이라 기본 단어 ${DEFAULT_WORDS.length}개로 문제를 냅니다. (최소 ${QUIZ_CHOICES}개 필요)`;
  } else {
    el.textContent = `기본 단어 ${DEFAULT_WORDS.length}개로 문제를 냅니다.`;
  }
  $("resetWordsBtn").disabled = mine.length === 0;
}

/* ---------------- 상태 ↔ 엑셀 ---------------- */

function wordRows() {
  const list = usableWords(state.words);
  const src = list.length >= QUIZ_CHOICES ? list : usableWords(DEFAULT_WORDS);
  return src.map((w) => [w.word, w.lang, w.ipa, w.read, w.ko]);
}

function toSheets() {
  const bp = state.blockPage || DEFAULTS.blockPage;
  return [
    { name: SHEET_BLOCK, widths: [44], rows: [["도메인"], ...state.blocked.map((d) => [d])] },
    { name: SHEET_ALLOW, widths: [44], rows: [["도메인"], ...state.allowed.map((d) => [d])] },
    { name: SHEET_SETTINGS, widths: [24, 64], rows: [
      ["항목", "값"],
      ["차단 화면 이모지", bp.emoji || ""],
      ["차단 화면 제목", bp.title || ""],
      ["차단 화면 안내 문구", bp.message || ""],
      ["내보낸 시각", new Date().toLocaleString("ko-KR")],
      ["확장 프로그램 버전", chrome.runtime.getManifest().version]
    ] },
    { name: SHEET_WORDS, widths: [26, 12, 24, 18, 52], rows: [WORD_HEADER, ...wordRows()] },
    { name: SHEET_GUIDE, header: false, widths: [96], rows: [
      ["딴짓 차단기 백업 파일"],
      [""],
      ["• '차단목록'과 '예외목록' 시트의 A열에 도메인을 한 줄에 하나씩 적으세요. 첫 줄(제목)은 읽지 않습니다."],
      ["• https:// 나 뒤쪽 경로가 붙어 있어도 도메인만 읽습니다. 예) https://www.youtube.com/watch → youtube.com"],
      ["• '설정' 시트의 값을 바꾸면 차단 화면 문구가 바뀝니다."],
      [""],
      ["• '단어' 시트는 잠금을 풀 때 나오는 문제입니다. 한 줄이 한 문제입니다."],
      ["  단어와 뜻은 반드시 채워야 하고, 언어·발음기호·한국어 발음은 비워도 됩니다."],
      ["  보기 네 개는 적지 않습니다. 정답은 그 줄의 뜻이고 나머지 셋은 다른 줄의 뜻에서 가져옵니다."],
      ["  그래서 단어가 최소 4개는 있어야 하고, 뜻이 서로 겹치면 뒤엣것은 버려집니다."]
    ] }
  ];
}

function exportBytes() {
  return XlsxLite.write(toSheets());
}

/** 시트 이름을 공백 무시하고 찾는다 */
function findSheet(book, name) {
  const key = Object.keys(book).find((k) => k.replace(/\s/g, "") === name);
  return key ? book[key] : null;
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

function readWordSheet(rows) {
  const out = [];
  const invalid = [];
  (rows || []).forEach((row, i) => {
    const c = (k) => String((row && row[k]) ?? "").trim();
    if (i === 0 && c(0) === WORD_HEADER[0]) return; // 제목 줄
    if (!c(0) && !c(4)) return; // 빈 줄
    const w = normalizeWord({ word: c(0), lang: c(1), ipa: c(2), read: c(3), ko: c(4) });
    if (w) out.push(w);
    else if (i > 0) invalid.push(c(0) || c(4));
  });
  return { list: usableWords(out), invalid };
}

function parseBook(book) {
  let blockRows = findSheet(book, SHEET_BLOCK);
  const allowRows = findSheet(book, SHEET_ALLOW);
  const settingRows = findSheet(book, SHEET_SETTINGS);
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

  let words = [];
  let wordInvalid = [];
  if (wordRowsIn) {
    const w = readWordSheet(wordRowsIn);
    if (w.list.length && w.list.length < QUIZ_CHOICES) {
      throw new Error(
        `'단어' 시트에 쓸 수 있는 줄이 ${w.list.length}개뿐입니다. 보기를 4개 만들려면 최소 ${QUIZ_CHOICES}개가 필요합니다.`
      );
    }
    words = w.list;
    wordInvalid = w.invalid;
  }

  let blockPage = null;
  if (settingRows) {
    const map = {};
    for (const r of settingRows.slice(1)) {
      const k = String(r[0] ?? "").replace(/\s/g, "");
      if (k) map[k] = String(r[1] ?? "");
    }
    const pickVal = (word) => {
      const k = Object.keys(map).find((x) => x.includes(word));
      return k !== undefined ? map[k] : undefined;
    };
    const emoji = pickVal("이모지");
    const title = pickVal("제목");
    const message = pickVal("안내");
    if (emoji !== undefined || title !== undefined || message !== undefined) {
      blockPage = {
        emoji: (emoji || "").trim() || DEFAULTS.blockPage.emoji,
        title: (title || "").trim() || DEFAULTS.blockPage.title,
        message: message !== undefined ? message : DEFAULTS.blockPage.message
      };
    }
  }

  return {
    blocked: b.list,
    allowed: a.list.filter((d) => !b.list.includes(d)),
    conflicts: a.list.filter((d) => b.list.includes(d)),
    blockPage,
    words,
    invalid: [...b.invalid, ...a.invalid],
    wordInvalid,
    guessed
  };
}

/* ---------------- 불러오기 확인 · 적용 ---------------- */

function mergeWords(cur, add) {
  return usableWords([...cur, ...add]);
}

function openPreview(data, sourceLabel) {
  pending = data;
  const mergedB = uniqSorted([...state.blocked, ...data.blocked]);
  const mergedA = uniqSorted([...state.allowed, ...data.allowed]).filter((d) => !mergedB.includes(d));
  const curW = usableWords(state.words);
  const mergedW = mergeWords(curW, data.words);

  $("dlgFrom").textContent = sourceLabel + (data.guessed
    ? " · 딴짓 차단기 형식이 아니어서 첫 시트의 A열을 차단 목록으로 읽었습니다"
    : "");
  $("cB0").textContent = state.blocked.length;
  $("cB1").textContent = data.blocked.length;
  $("cB2").textContent = `${mergedB.length} (+${mergedB.length - state.blocked.length})`;
  $("cA0").textContent = state.allowed.length;
  $("cA1").textContent = data.allowed.length;
  $("cA2").textContent = `${mergedA.length} (+${mergedA.length - state.allowed.length})`;
  $("cP1").textContent = data.blockPage ? "있음" : "없음";
  $("cW0").textContent = curW.length || "기본";
  $("cW1").textContent = data.words.length;
  $("cW2").textContent = data.words.length ? mergedW.length : (curW.length || "기본");

  const removed = state.blocked.filter((d) => !data.blocked.includes(d)).length;
  $("overwriteDesc").textContent =
    "지금 목록을 지우고 파일 내용으로 바꿉니다." +
    (removed ? ` 현재 차단 중인 ${removed}개가 목록에서 빠집니다.` : "") +
    (data.blockPage ? " 차단 화면 문구도 파일 것으로 바뀝니다." : "") +
    (data.words.length ? " 단어도 파일 것으로 바뀝니다." : "");

  const notes = [];
  if (data.invalid.length) {
    const shown = data.invalid.slice(0, 8).join(", ");
    notes.push(`주소로 읽을 수 없어 건너뛴 칸 ${data.invalid.length}개: ${shown}${data.invalid.length > 8 ? " …" : ""}`);
  }
  if (data.wordInvalid.length) {
    notes.push(`'단어' 시트에서 단어나 뜻이 비어 건너뛴 줄 ${data.wordInvalid.length}개`);
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
  let blocked, allowed, words;
  let blockPage = state.blockPage;
  const curW = usableWords(state.words);

  if (mode === "merge") {
    blocked = uniqSorted([...state.blocked, ...d.blocked]);
    allowed = uniqSorted([...state.allowed, ...d.allowed]);
    words = d.words.length ? mergeWords(curW, d.words) : state.words;
  } else {
    blocked = d.blocked;
    allowed = d.allowed;
    words = d.words.length ? d.words : state.words;
    if (d.blockPage) blockPage = d.blockPage;
  }
  allowed = allowed.filter((x) => !blocked.includes(x));

  await chrome.storage.local.set({ blocked, allowed, blockPage, words });
  await reloadState();
  $("dlg").close();
  pending = null;

  const label = mode === "merge" ? "합쳤습니다" : "덮어썼습니다";
  setMsg($("fileMsg"), `${label} — 차단 ${blocked.length}개 · 예외 ${allowed.length}개`, "ok");
  renderWords();
  await refreshPermCard();
  setTimeout(renderDevices, 2500);
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
    const blob = new Blob([exportBytes()], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `딴짓차단기_백업_${stamp()}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
  renderWords();
  await renderDevices();
  await refreshPermCard();
}

function wire() {
  $("exportBtn").addEventListener("click", onExport);
  $("importBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", onFilePicked);

  $("resetWordsBtn").addEventListener("click", async () => {
    await chrome.storage.local.set({ words: [] });
    await reloadState();
    renderWords();
    setMsg($("wordMsg"), `기본 단어 ${DEFAULT_WORDS.length}개로 되돌렸습니다.`, "ok");
  });

  $("mergeBtn").addEventListener("click", () => applyImport("merge"));
  $("overwriteBtn").addEventListener("click", () => applyImport("overwrite"));
  $("cancelBtn").addEventListener("click", () => { pending = null; $("dlg").close(); });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if ($("main").hidden) return;
    if (area === "local" && (changes.blocked || changes.allowed || changes.blockPage || changes.words ||
                              changes.syncOn || changes.deviceName || changes.syncStatus)) {
      await reloadState();
      renderWords();
      await renderDevices();
    } else if (area === "sync") {
      await renderDevices();
    }
  });
}

(async function init() {
  await reloadState();
  wire();
  if (await isUnlocked(state)) await showMain();
  else showLock();
})();
