/* 딴짓 차단기 - 차단 안내 페이지 */

const DEFAULT_PAGE = {
  title: "잠깐! 지금은 접속할 수 없어요",
  message: "이 사이트는 사용자가 직접 차단 목록에 추가했습니다.\n지금 해야 할 일로 돌아가 볼까요?",
  emoji: "🛑"
};

(async function () {
  const domain = new URLSearchParams(location.search).get("d") || "";
  const domainEl = document.getElementById("domain");
  if (domain) domainEl.textContent = domain;
  else domainEl.style.display = "none";

  const { blockPage } = await chrome.storage.local.get({ blockPage: DEFAULT_PAGE });
  document.getElementById("emoji").textContent = blockPage.emoji || DEFAULT_PAGE.emoji;
  document.getElementById("title").textContent = blockPage.title || DEFAULT_PAGE.title;
  document.getElementById("message").textContent =
    blockPage.message !== undefined ? blockPage.message : DEFAULT_PAGE.message;
  document.title = blockPage.title || DEFAULT_PAGE.title;
})();
