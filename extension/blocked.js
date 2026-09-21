/* 딴짓 차단기 - 차단 안내 페이지 */

const DEFAULT_PAGE = {
  title: "잠깐!",
  message: "딴짓 차단기 작동 중",
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

(async function () {
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

  const { blockPage } = await chrome.storage.local.get({ blockPage: DEFAULT_PAGE });
  document.getElementById("emoji").textContent = blockPage.emoji || DEFAULT_PAGE.emoji;
  document.getElementById("title").textContent = blockPage.title || DEFAULT_PAGE.title;
  document.getElementById("message").textContent =
    blockPage.message !== undefined ? blockPage.message : DEFAULT_PAGE.message;
  document.title = blockPage.title || DEFAULT_PAGE.title;
})();
