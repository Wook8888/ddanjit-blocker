/* 딴짓 차단기 - 잠금 문제 단어 페이지 (words.html)
 * 팝업 설정의 "잠금 문제 단어"에서 연다. 단어는 이 기기에만 저장되고 동기화되지 않는다. */

let pendingWords = null; // 단어 불러오기 확인 대기 중인 단어

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
  if (!wordDirty) {
    loadWordDraft();
    renderWordTable();
  }
}

/* ---------------- 단어 편집 표 ---------------- */

const WORD_KEYS = ["word", "lang", "ipa", "read", "ko"];
let wordDraft = [];     // 표에 보이는 줄들 {word, lang, ipa, read, ko}
let wordDirty = false;  // 저장하지 않은 변경
let draftIsDefault = false;

const blankWord = () => ({ word: "", lang: "", ipa: "", read: "", ko: "" });
const cleanCell = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/** 저장된 단어 → 표. 직접 정한 단어가 없으면 기본 단어를 보여주고, 고쳐서 저장하면 내 단어가 된다. */
function loadWordDraft() {
  const raw = (state.words || []).filter((w) => w && typeof w === "object");
  draftIsDefault = raw.length === 0;
  const src = draftIsDefault ? DEFAULT_WORDS : raw;
  wordDraft = src.map((w) => Object.fromEntries(WORD_KEYS.map((k) => [k, cleanCell(w[k])])));
  setWordDirty(false);
}

function setWordDirty(on) {
  wordDirty = on;
  $("wordSaveBtn").disabled = !on;
  $("wordUndoBtn").disabled = !on;
  $("wordDirty").hidden = !on;
  $("wordNote").textContent = draftIsDefault && !on
    ? "지금은 기본 단어입니다. 고쳐서 저장하면 내 단어가 됩니다."
    : "";
}

function renderWordTable(marks = {}) {
  const box = $("wordTable");
  box.innerHTML = "";
  wordDraft.forEach((w, i) => {
    const row = document.createElement("div");
    row.className = "wRow" + (marks.bad && marks.bad.has(i) ? " bad" : "") + (marks.dup && marks.dup.has(i) ? " dup" : "");
    row.dataset.i = i;

    const n = document.createElement("span");
    n.className = "n";
    n.textContent = i + 1;
    row.appendChild(n);

    const make = (key, ph, cls) => {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = w[key];
      inp.placeholder = ph;
      inp.dataset.k = key;
      if (cls) inp.className = cls;
      inp.addEventListener("input", () => {
        wordDraft[i][key] = inp.value;
        row.classList.remove("bad", "dup");
        setWordDirty(true);
      });
      inp.addEventListener("paste", (e) => onCellPaste(e, i));
      return inp;
    };
    row.appendChild(make("word", "단어", "w need"));
    row.appendChild(make("lang", "언어"));
    row.appendChild(make("ipa", "발음기호"));
    row.appendChild(make("read", "한국어 발음"));

    const x = document.createElement("button");
    x.className = "x";
    x.title = "이 줄 삭제";
    x.textContent = "✕";
    x.dataset.act = "wdel";
    x.addEventListener("click", () => {
      wordDraft.splice(i, 1);
      setWordDirty(true);
      renderWordTable();
    });
    row.appendChild(x);

    const spacer = document.createElement("span");
    row.appendChild(spacer);
    row.appendChild(make("ko", "뜻 (정답)", "ko need"));
    box.appendChild(row);
  });
  if (!wordDraft.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "단어가 없습니다. [+ 단어 추가]를 누르거나 엑셀에서 복사해 붙여넣으세요.";
    box.appendChild(p);
  }
}

/** 엑셀·구글 시트에서 복사한 글 → 줄들. 탭으로 칸을 나눈다. */
function parsePastedWords(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split("\t").map(cleanCell);
    if (!rows.length && c[0] === WORD_HEADER[0]) continue; // 제목 줄
    if (c.every((v) => !v)) continue;
    const w = c.length === 2
      ? { word: c[0], lang: "", ipa: "", read: "", ko: c[1] }
      : { word: c[0] || "", lang: c[1] || "", ipa: c[2] || "", read: c[3] || "", ko: c[4] || "" };
    rows.push(w);
  }
  return rows;
}

/** 줄을 표 끝에 붙인다. 맨 끝의 빈 줄은 채워 쓴다. */
function addWordRows(rows) {
  while (wordDraft.length && WORD_KEYS.every((k) => !cleanCell(wordDraft[wordDraft.length - 1][k]))) wordDraft.pop();
  wordDraft.push(...rows);
  setWordDirty(true);
  renderWordTable();
  const box = $("wordTable");
  box.scrollTop = box.scrollHeight;
}

/** 칸에 여러 칸·여러 줄을 붙여넣으면 줄 추가로 처리한다 (한 칸짜리 글은 그냥 붙여넣기) */
function onCellPaste(e, i) {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (!/[\t\n]/.test(text.replace(/\r?\n$/, ""))) return;
  const rows = parsePastedWords(text);
  if (!rows.length) return;
  e.preventDefault();
  // 붙여넣은 줄이 빈 줄이면 그 자리를 쓴다
  if (WORD_KEYS.every((k) => !cleanCell(wordDraft[i][k]))) wordDraft.splice(i, 1);
  addWordRows(rows);
  setMsg($("wordMsg"), `${rows.length}줄을 추가했습니다. [저장]을 눌러야 적용됩니다.`, "ok");
}

function wordsToTsv(list) {
  const esc = (v) => cleanCell(v).replace(/\t/g, " ");
  return [WORD_HEADER, ...list.map((w) => WORD_KEYS.map((k) => esc(w[k])))].map((r) => r.join("\t")).join("\n");
}

async function copyWords() {
  const text = wordsToTsv(wordDraft.filter((w) => WORD_KEYS.some((k) => cleanCell(w[k]))));
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  setMsg($("wordMsg"), "표를 복사했습니다. 엑셀이나 다른 기기의 이 표에 붙여넣으면 됩니다.", "ok");
}

/** 저장 전 검사. 문제가 있는 줄 번호를 돌려준다. */
function checkWordDraft() {
  const bad = new Set();
  const dup = new Set();
  const rows = [];
  const seenKo = new Map();
  const seenWord = new Map();
  wordDraft.forEach((raw, i) => {
    const c = Object.fromEntries(WORD_KEYS.map((k) => [k, cleanCell(raw[k])]));
    if (WORD_KEYS.every((k) => !c[k])) return; // 빈 줄은 버린다
    if (!normalizeWord(c)) { bad.add(i); return; }
    if (seenKo.has(c.ko) || seenWord.has(c.word)) { dup.add(i); dup.add(seenKo.get(c.ko) ?? seenWord.get(c.word)); return; }
    seenKo.set(c.ko, i);
    seenWord.set(c.word, i);
    rows.push(c);
  });
  return { rows, bad, dup };
}

async function saveWordDraft() {
  const { rows, bad, dup } = checkWordDraft();
  const nums = (set) => [...set].sort((a, b) => a - b).map((i) => i + 1).join(", ");
  if (bad.size) {
    renderWordTable({ bad });
    setMsg($("wordMsg"), `${nums(bad)}번 줄에 단어나 뜻이 비어 있거나 너무 깁니다. (단어 60자, 뜻 120자까지)`, "err");
    return;
  }
  if (dup.size) {
    renderWordTable({ dup });
    setMsg($("wordMsg"), `${nums(dup)}번 줄의 단어나 뜻이 서로 겹칩니다. 보기가 헷갈리지 않도록 하나만 남겨 주세요.`, "err");
    return;
  }
  if (rows.length < QUIZ_CHOICES) {
    setMsg($("wordMsg"), `단어가 최소 ${QUIZ_CHOICES}개는 있어야 보기 네 개를 만들 수 있습니다. 지금 ${rows.length}개입니다.`, "err");
    return;
  }
  await chrome.storage.local.set({ words: rows });
  await reloadState();
  loadWordDraft();
  renderWordTable();
  renderWords();
  setMsg($("wordMsg"), `저장했습니다 — 단어 ${rows.length}개로 문제를 냅니다.`, "ok");
  await renderRep();
}

/* ---------------- 단어 엑셀 ---------------- */

function wordRows() {
  const list = usableWords(state.words);
  const src = list.length >= QUIZ_CHOICES ? list : usableWords(DEFAULT_WORDS);
  return src.map((w) => [w.word, w.lang, w.ipa, w.read, w.ko]);
}

function wordSheets() {
  return [
    { name: SHEET_WORDS, widths: [26, 12, 24, 18, 52], rows: [WORD_HEADER, ...wordRows()] },
    { name: SHEET_GUIDE, header: false, widths: [96], rows: [
      ["딴짓 차단기 잠금 문제 단어 파일"],
      [""],
      ["• '단어' 시트는 잠금을 풀 때 나오는 문제입니다. 한 줄이 한 문제입니다."],
      ["  단어와 뜻은 반드시 채워야 하고, 언어·발음기호·한국어 발음은 비워도 됩니다."],
      ["  보기 네 개는 적지 않습니다. 정답은 그 줄의 뜻이고 나머지 셋은 다른 줄의 뜻에서 가져옵니다."],
      ["  그래서 단어가 최소 4개는 있어야 하고, 뜻이 서로 겹치면 뒤엣것은 버려집니다."],
      ["• 단어는 동기화되지 않습니다. 다른 기기에서도 쓰려면 이 파일을 그 기기에서 불러오세요."]
    ] }
  ];
}

function exportWordBytes() {
  return XlsxLite.write(wordSheets());
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

/** 단어 파일 → 단어 목록. '단어' 시트가 없으면 첫 시트를 단어로 본다 */
function parseWordBook(book) {
  let rows = findSheet(book, SHEET_WORDS);
  if (!rows) {
    const first = Object.keys(book).find((k) => k.replace(/\s/g, "") !== SHEET_GUIDE);
    if (!first) throw new Error("비어 있는 파일입니다.");
    rows = book[first];
  }
  const w = readWordSheet(rows);
  if (!w.list.length) throw new Error("단어로 읽을 수 있는 줄이 없습니다. 단어와 뜻이 채워져 있는지 확인하세요.");
  if (w.list.length < QUIZ_CHOICES) {
    throw new Error(
      `쓸 수 있는 단어가 ${w.list.length}개뿐입니다. 보기를 4개 만들려면 최소 ${QUIZ_CHOICES}개가 필요합니다.`
    );
  }
  return w;
}

function mergeWords(cur, add) {
  return usableWords([...cur, ...add]);
}

/* ---------------- 단어 파일 ---------------- */

function openWordPreview(w, sourceLabel) {
  pendingWords = w.list;
  const cur = usableWords(state.words);
  $("wFrom").textContent = sourceLabel;
  $("wC0").textContent = cur.length || "기본";
  $("wC1").textContent = w.list.length;
  $("wC2").textContent = mergeWords(cur, w.list).length;
  const inv = $("wInvalid");
  inv.textContent = w.invalid.length ? `단어나 뜻이 비어 건너뛴 줄 ${w.invalid.length}개` : "";
  inv.hidden = !w.invalid.length;
  $("dlgW").showModal();
}

async function applyWords(mode) {
  const add = pendingWords;
  if (!add) return;
  const words = mode === "merge" ? mergeWords(usableWords(state.words), add) : add;
  await chrome.storage.local.set({ words });
  await reloadState();
  $("dlgW").close();
  pendingWords = null;
  wordDirty = false; // 파일 단어로 표를 새로 채운다
  renderWords();
  setMsg($("wordMsg"), `${mode === "merge" ? "합쳤습니다" : "바꿨습니다"} — 단어 ${words.length}개`, "ok");
}

function onWordExport() {
  try {
    download(exportWordBytes(), `딴짓차단기_단어_${stamp()}.xlsx`);
    const n = usableWords(state.words).length;
    setMsg($("wordMsg"), `내보냈습니다 — ${n >= QUIZ_CHOICES ? "단어 " + n + "개" : "기본 단어 " + DEFAULT_WORDS.length + "개"}`, "ok");
  } catch (e) {
    setMsg($("wordMsg"), "내보내기 실패: " + (e.message || e), "err");
  }
}

async function onWordFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    setMsg($("wordMsg"), "읽는 중…");
    const w = parseWordBook(await XlsxLite.read(await file.arrayBuffer()));
    setMsg($("wordMsg"), "");
    openWordPreview(w, `파일: ${file.name}`);
  } catch (err) {
    setMsg($("wordMsg"), "불러오기 실패: " + (err.message || err), "err");
  }
}

/* ---------------- 대표 단어 리스트 ---------------- */

let repCache = null;

async function renderRep() {
  const rep = await readRepWords();
  repCache = rep;
  const info = $("repInfo");
  const acts = $("repActions");
  acts.innerHTML = "";
  const syncOff = state.syncOn === false;
  const mine = effectiveWords(state.words);
  const same = rep && sameWords(rep.words, mine);

  if (syncOff) {
    info.textContent = "이 기기는 동기화가 꺼져 있어 대표 단어 리스트를 올리거나 내려받을 수 없습니다.";
    $("repSame").hidden = true;
    $("repPreview").hidden = true;
    return;
  }
  info.textContent = rep
    ? `${stampShort(rep.at)}에 올라옴 · ${rep.count}개`
    : "아직 대표 단어 리스트가 없습니다.";
  $("repSame").hidden = !same;

  if (rep) {
    const view = document.createElement("button");
    view.textContent = $("repPreview").hidden ? "펼쳐 보기" : "접기";
    view.dataset.act = "repView";
    view.addEventListener("click", () => {
      const box = $("repPreview");
      box.hidden = !box.hidden;
      view.textContent = box.hidden ? "펼쳐 보기" : "접기";
      if (!box.hidden) fillRepPreview(rep.words);
    });
    acts.appendChild(view);
    if (!$("repPreview").hidden) fillRepPreview(rep.words);
    // 내 단어와 같아도 버튼은 늘 보인다 (사용자 요청)
    acts.appendChild(confirmButton("내 단어 리스트로 가져오기",
      `내 단어 리스트(${mine.length}개)를 대표(${rep.count}개)로 바꿉니다. 한 번 더`, "repGet", downloadRep));
  } else {
    $("repPreview").hidden = true;
  }
  {
    const label = "내 단어 리스트를 대표로 올리기";
    let put;
    if (rep) {
      put = confirmButton(label, `기존 대표 단어 리스트(${rep.count}개)를 덮어씁니다. 한 번 더`, "repPut", uploadRep);
    } else {
      put = document.createElement("button"); // 처음 올릴 때는 덮어쓸 것이 없으니 한 번에
      put.textContent = label;
      put.dataset.act = "repPut";
      put.addEventListener("click", uploadRep);
    }
    acts.appendChild(put);
  }
}

function fillRepPreview(words) {
  const box = $("repPreview");
  box.innerHTML = "";
  for (const w of words) {
    const d = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = w.word;
    const s = document.createElement("span");
    s.textContent = " — " + w.ko;
    d.append(b, s);
    box.appendChild(d);
  }
}

function needSaveFirst() {
  if (!wordDirty) return false;
  setMsg($("repMsg"), "단어 표에 저장하지 않은 변경이 있습니다. 먼저 [저장]하거나 [변경 취소]해 주세요.", "err");
  return true;
}

async function uploadRep() {
  if (needSaveFirst()) return;
  const mine = effectiveWords(state.words);
  try {
    await writeRepWords(mine);
    setMsg($("repMsg"), `내 단어 리스트(${mine.length}개)를 대표 단어 리스트로 올렸습니다. 다른 기기에서 내려받을 수 있습니다.`, "ok");
  } catch (e) {
    setMsg($("repMsg"), e.message || String(e), "err");
  }
  await renderRep();
}

async function downloadRep() {
  if (needSaveFirst()) return;
  const rep = await readRepWords();
  if (!rep) {
    setMsg($("repMsg"), "대표 단어 리스트를 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.", "err");
    return;
  }
  const words = usableWords(rep.words);
  if (words.length < QUIZ_CHOICES) {
    setMsg($("repMsg"), `대표 단어 리스트에 쓸 수 있는 단어가 ${words.length}개뿐이라 가져오지 않았습니다.`, "err");
    return;
  }
  await chrome.storage.local.set({ words });
  await reloadState();
  wordDirty = false;
  renderWords();
  setMsg($("repMsg"), `대표 단어 리스트(${words.length}개)로 바꿨습니다.`, "ok");
  await renderRep();
}

/* ---------------- 시작 ---------------- */

async function showMain() {
  $("lock").hidden = true;
  $("main").hidden = false;
  renderWords();
  await renderRep();
}

function wire() {
  $("wordAddBtn").addEventListener("click", () => {
    addWordRows([blankWord()]);
    const inputs = $("wordTable").querySelectorAll(".wRow:last-child input");
    if (inputs[0]) inputs[0].focus();
  });
  $("wordPasteToggle").addEventListener("click", () => {
    $("wordPasteBox").hidden = !$("wordPasteBox").hidden;
    if (!$("wordPasteBox").hidden) $("wordPasteArea").focus();
  });
  $("wordPasteCancel").addEventListener("click", () => { $("wordPasteBox").hidden = true; });
  $("wordPasteAddBtn").addEventListener("click", () => {
    const rows = parsePastedWords($("wordPasteArea").value);
    if (!rows.length) {
      setMsg($("wordMsg"), "붙여넣은 내용에서 읽을 줄이 없습니다.", "err");
      return;
    }
    addWordRows(rows);
    $("wordPasteArea").value = "";
    $("wordPasteBox").hidden = true;
    setMsg($("wordMsg"), `${rows.length}줄을 추가했습니다. [저장]을 눌러야 적용됩니다.`, "ok");
  });
  $("wordCopyBtn").addEventListener("click", copyWords);
  $("wordSaveBtn").addEventListener("click", saveWordDraft);
  $("wordUndoBtn").addEventListener("click", () => {
    loadWordDraft();
    renderWordTable();
    setMsg($("wordMsg"), "저장하지 않은 변경을 취소했습니다.", "ok");
  });
  window.addEventListener("beforeunload", (e) => {
    if (wordDirty) { e.preventDefault(); e.returnValue = ""; }
  });

  $("wordExportBtn").addEventListener("click", onWordExport);
  $("wordImportBtn").addEventListener("click", () => $("wordFileInput").click());
  $("wordFileInput").addEventListener("change", onWordFilePicked);
  $("wMergeBtn").addEventListener("click", () => applyWords("merge"));
  $("wReplaceBtn").addEventListener("click", () => applyWords("replace"));
  $("wCancelBtn").addEventListener("click", () => { pendingWords = null; $("dlgW").close(); });

  $("resetWordsBtn").addEventListener("click", async () => {
    await chrome.storage.local.set({ words: [] });
    await reloadState();
    wordDirty = false;
    renderWords();
    setMsg($("wordMsg"), `기본 단어 ${DEFAULT_WORDS.length}개로 되돌렸습니다.`, "ok");
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if ($("main").hidden) return;
    if (area === "local" && (changes.words || changes.syncOn)) {
      await reloadState();
      renderWords();
      await renderRep();
    } else if (area === "sync" && Object.keys(changes).some((k) => /^rw/.test(k))) {
      await renderRep();
    }
  });
}

(async function init() {
  await reloadState();
  wire();
  if (await isUnlocked(state)) await showMain();
  else showLock();
})();
