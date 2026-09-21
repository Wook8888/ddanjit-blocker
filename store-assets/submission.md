# 심사 제출 문구 (Privacy practices 탭)

> 대시보드 → **Privacy practices** 탭에 들어가는 내용입니다.
> 여기가 **반려가 가장 많이 갈리는 구간**입니다. 심사관이 직접 읽고 판단합니다.
>
> **영어로 작성하세요.** 심사관이 한국어를 읽지 못할 수 있습니다.
> 아래 각 항목은 영어 원문을 그대로 복사해서 넣으시고, 한국어는 이해용입니다.

---

## 1. Single purpose (단일 목적)

영어 — **이대로 복사**

```
Ddanjit Blocker blocks websites that the user chooses.

The user enters domains into a block list in the extension popup. The extension
turns that list into declarativeNetRequest rules and registers them with Chrome,
so that navigation to those domains is redirected to a block page bundled inside
the extension. The user can also add exceptions (for example, block naver.com but
still allow map.naver.com), customize the text shown on the block page, and
optionally require a short multiple-choice word question before the settings can
be changed.

That is the extension's only function. It has no other features.
```

한국어 (이해용)

> 사용자가 지정한 웹사이트를 차단합니다. 팝업의 차단 목록에 도메인을 입력하면
> 그 목록을 declarativeNetRequest 규칙으로 만들어 크롬에 등록하고, 해당 도메인으로의
> 이동을 확장 프로그램에 포함된 차단 페이지로 돌립니다. 예외 지정, 차단 페이지 문구
> 변경, 설정 변경 시 단어 문제 확인 기능이 있습니다. 이 외의 기능은 없습니다.

> **왜 이렇게 쓰나** — "단일 목적"은 한 문장으로 요약되어야 통과합니다.
> 기능을 여러 개 나열하면 "목적이 여러 개 아니냐"는 의심을 받습니다.
> 위 문장은 부가 기능들을 **차단이라는 하나의 목적에 딸린 것**으로 묶어서 서술했습니다.

---

## 2. Permission justifications (권한별 사유)

권한마다 입력칸이 따로 있습니다. 각각 아래 문구를 넣으세요.

### `storage`

```
Used to persist the user's own settings: the block list, the exception list, the
custom block page text and emoji, the words used by the optional unlock question,
a short history of the user's own recent list changes, and the enabled/lock state.

The extension makes no network requests and contacts no server of ours. If the user
has Chrome Sync enabled, chrome.storage.sync lets Chrome carry these settings between
the user's own signed-in Chrome browsers. No account, email address or password is
ever requested or stored.
```

> 기기에 사용자 설정을 저장하기 위해서만 사용. 어디로도 전송하지 않음.

### `declarativeNetRequestWithHostAccess`

```
This is the mechanism that performs the blocking, which is the extension's single
purpose. The extension converts the user's block list into dynamic
declarativeNetRequest rules and hands them to Chrome.

We deliberately chose declarativeNetRequestWithHostAccess over the broader
declarativeNetRequest permission so that rules apply only to hosts the user has
explicitly granted access to.

The extension never inspects request contents. It only supplies rules to Chrome and
lets Chrome do the matching.
```

> 차단 기능 그 자체. 더 넓은 `declarativeNetRequest` 대신 **일부러** 이걸 골랐다는 점을 강조.

### Host permissions — `<all_urls>` (optional)

이 항목이 가장 중요합니다. `<all_urls>` 가 manifest 에 보이면 심사관이 반드시 확인합니다.

```
<all_urls> is declared under optional_host_permissions only. It is NEVER requested
at install time, and the extension is fully installable without granting it.

When the user adds a domain to their block list, the extension calls
chrome.permissions.request() for that single domain pattern only — for example
*://*.example.com/* — at the moment the user adds it. Nothing else is requested.

Host access is required because the declarativeNetRequest "redirect" action needs
host access to the request URL in order to send that navigation to the extension's
block page.

The reason the manifest declares <all_urls> rather than a fixed list is that the
domains are chosen by the user at runtime and cannot be known in advance.

The extension does not inject content scripts, does not read page content, does not
read or record browsing history, and does not make any network requests.
```

> 요지: ① 설치 시에는 요구 안 함 ② 사용자가 추가한 도메인만 그때그때 요청
> ③ redirect 액션에 기술적으로 필요 ④ 목록을 미리 알 수 없어서 `<all_urls>` 선언
> ⑤ 콘텐츠 스크립트·페이지 읽기·방문 기록 수집 전부 없음

---

## 3. Remote code (원격 코드)

**"No, I am not using remote code"** 선택.

확인란 옆에 설명을 넣을 수 있으면:

```
All JavaScript and CSS is contained in the extension package. There are no external
script tags, no CDN references, no eval(), and no dynamically fetched or executed code.
```

> **미신고 시 즉시 거절입니다.** 우리 코드는 CDN도 eval도 쓰지 않으니 당당히 "없음"입니다.

---

## 4. Data usage (데이터 사용 신고)

수집 항목 체크박스가 여러 개 나옵니다 — **전부 체크 해제**하세요.

| 항목 | 체크 |
|---|---|
| Personally identifiable information | ❌ |
| Health information | ❌ |
| Financial and payment information | ❌ |
| Authentication information | ❌ |
| Personal communications | ❌ |
| Location | ❌ |
| Web history | ❌ |
| User activity | ❌ |
| Website content | ❌ |

> ("Authentication information" 은 체크하지 않습니다 — 비밀번호 기능 자체가 없습니다.)
> 참고로 예전 버전에는 비밀번호가 있었고, 그때도 체크 대상이 아니었습니다:
> **체크하지 마세요.** 이 항목은 사용자의 *외부 서비스 자격증명*을 수집·전송하는 경우를
> 말합니다. 우리는 확장 자체의 설정 잠금용 해시를 기기에만 저장하므로 해당하지 않습니다.

그 아래 **세 개의 확인 서약**은 전부 체크합니다. 전부 사실입니다.

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

---

## 5. 개인정보처리방침 URL

```
https://wook8888.github.io/ddanjit-blocker/
```

> 제출 전에 **반드시 브라우저로 직접 열어서** 뜨는지 확인하세요.
> 열리지 않는 URL 은 그 자체로 반려 사유입니다.

---

## 6. 심사에 유리하게 작용할 것들

제출 전에 아래를 확인해두면 통과 확률이 올라갑니다.

- **소스가 공개되어 있습니다** — <https://github.com/Wook8888/ddanjit-blocker>
  Homepage URL 에 넣어두면 심사관이 코드를 직접 볼 수 있어 신뢰도가 올라갑니다
- **난독화·압축을 하지 않았습니다** — 정책상 난독화는 금지, 압축은 심사를 어렵게 만듭니다.
  우리 코드는 주석까지 그대로 있는 원본입니다
- **설치 시 권한 경고가 없습니다** — 광범위 권한을 install-time 에 요구하지 않는 확장은
  심층 심사 대상에서 벗어날 가능성이 높습니다

---

## 7. 반려되면

반려 메일에 **위반한 정책 조항과 사유**가 적혀 옵니다. 당황하지 말고:

1. 어느 항목이 문제인지 확인 (대부분 권한 사유 설명 부족)
2. 해당 설명을 보완해서 **다시 제출** — 재제출에 횟수 제한은 없습니다
3. 명백히 오판이라고 판단되면 회신으로 이의 제기 가능

재제출은 처음 심사보다 대체로 빠릅니다.
반려 메일 내용을 그대로 보여주시면 문구를 수정해 드리겠습니다.
