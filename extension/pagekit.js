/* 딴짓 차단기 - 동기화·백업 페이지와 단어 페이지가 함께 쓰는 코드 (잠금 화면 포함)
 * 이 파일을 불러오는 페이지는 showMain() 을 정의해야 한다 (잠금이 풀리면 부른다). */

const $ = (id) => document.getElementById(id);
let state = null;

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

function download(bytes, name) {
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 시트 이름을 공백 무시하고 찾는다 */
function findSheet(book, name) {
  const key = Object.keys(book).find((k) => k.replace(/\s/g, "") === name);
  return key ? book[key] : null;
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

async function renderProgress() {
  const need = quizNeed(state);
  $("lockNeed").textContent = quizHintText(need);
  $("qProg").textContent = quizProgText(Math.min(await getQuizDone(), need), need);
}

async function answerQuestion(picked, box) {
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

function showLock() {
  $("main").hidden = true;
  $("lock").hidden = false;
  renderProgress();
  setupPauseSelect($("lockPause"), state);
  if (!renderQuestion()) markUnlocked().then(showMain);
}
