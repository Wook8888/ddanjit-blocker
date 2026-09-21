/* 딴짓 차단기 - 차단 안내 페이지 */

/* 차단 화면 문구 — 고정. 바꾸는 곳이 없다. */
const BLOCK_PAGE = {
  title: "잠깐",
  message: "지금 해야 할 일로 돌아가 볼까요?",
  emoji: "□"
};

/**
 * 차단 규칙은 이 페이지로 리디렉트하면서 주소 끝에 원래 주소를 그대로 붙인다.
 *   blocked.html?d=naver.com&u=https://www.naver.com/some/path?x=1&y=2#top
 * 원래 주소 안에도 & ? # 가 들어있을 수 있으므로 URLSearchParams 로 읽지 않고
 * "&u=" 뒤의 문자열 전체(해시 포함)를 그대로 잘라낸다.
 */
function readBlockedInfo() {
  const href = location.href;
  const i = href.indexOf("&u=");
  const url = i >= 0 ? href.slice(i + 3) : "";
  const domain = new URLSearchParams(location.search).get("d") || "";
  return { url, domain };
}

(function () {
  const { url, domain } = readBlockedInfo();
  const shown = url || (domain ? "https://" + domain : "");

  if (shown) {
    document.getElementById("urlbox").hidden = false;
    document.getElementById("url").textContent = shown;
    if (domain) {
      document.getElementById("rule").hidden = false;
      document.getElementById("ruleDomain").textContent = domain;
    }
  }

  document.getElementById("emoji").textContent = BLOCK_PAGE.emoji;
  document.getElementById("title").textContent = BLOCK_PAGE.title;
  document.getElementById("message").textContent = BLOCK_PAGE.message;
  document.title = BLOCK_PAGE.title;
})();

/* ---------- 단어 문제 ----------
 * 팝업 잠금을 켠 사람에게만 나온다. 딴짓하려던 순간을 단어 하나 익히는 순간으로 바꾸려는 것.
 * 맞혀도 사이트는 열리지 않고, 팝업 잠금의 "N개 맞힘"에도 들어가지 않는다 (잠금을 푸는 통로가 아님).
 * 맞히면 잠깐 "정답!"을 보여주고 다음 문제로 계속. 틀리면 설정한 시간(1~10초) 동안 정답을 보여준다. */

(async function blockQuiz() {
  let state;
  try {
    state = await chrome.storage.local.get({ lockOn: false, words: [], wrongPause: 5 });
  } catch (e) {
    return;
  }
  if (!state.lockOn) return;

  const el = (id) => document.getElementById(id);
  let q = null;
  let last = "";
  let busy = false;

  function show() {
    q = buildQuestion(state.words, last);
    if (!q) { el("quiz").hidden = true; return; }
    last = q.word.word;
    el("qWord").textContent = q.word.word;
    el("qIpa").textContent = q.word.ipa || "";
    el("qRead").textContent = [q.word.read, q.word.lang].filter(Boolean).join(" · ");
    el("qMsg").textContent = "";
    el("qMsg").className = "qMsg";
    const box = el("qOpts");
    box.innerHTML = "";
    q.options.forEach((text, i) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.addEventListener("click", () => pick(i));
      box.appendChild(b);
    });
  }

  function pick(i) {
    if (busy) return;
    busy = true;
    const ok = i === q.answer;
    [...el("qOpts").children].forEach((b, j) => {
      b.disabled = true;
      if (j === q.answer) b.classList.add("right");
      else if (j === i) b.classList.add("wrong");
    });
    const msg = el("qMsg");
    let wait;
    if (ok) {
      msg.textContent = "정답!";
      msg.className = "qMsg ok";
      wait = 1200;
    } else {
      const sec = wrongPauseSec(state);
      msg.textContent = `틀렸어요. 초록색이 정답 · ${sec}초 뒤 다음 문제`;
      msg.className = "qMsg err";
      wait = sec * 1000;
    }
    setTimeout(() => { busy = false; show(); }, wait);
  }

  el("quiz").hidden = false;
  show();
})();
