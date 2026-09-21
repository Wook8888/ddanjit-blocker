/* 딴짓 차단기 - 잠금을 푸는 단어 문제
 *
 * 잠금이 켜져 있으면 팝업을 열 때 단어 한 문제가 나온다.
 * 단어 · 발음기호 · 한국어 발음을 보고 뜻 네 개 중 하나를 고른다.
 * 맞히면 5분 동안 열린다.
 *
 * 보기 네 개는 따로 적지 않는다. 정답은 그 줄의 뜻이고,
 * 나머지 세 개는 다른 줄의 뜻에서 가져온다. → 단어가 최소 네 개는 있어야 한다.
 *
 * 사용자가 백업 엑셀의 '단어' 시트에서 직접 고칠 수 있다.
 * 고친 목록이 쓸 수 없는 상태면 아래 기본 단어로 돌아간다.
 *
 * 목적은 완벽한 잠금이 아니라 충동적인 해제를 한 박자 늦추는 것이다.
 * 확장 프로그램 파일은 누구나 열어볼 수 있으므로 정답도 함께 들어 있다.
 */

const QUIZ_CHOICES = 4; // 보기 개수 (= 필요한 최소 단어 수)

const DEFAULT_WORDS = [
  {
    word: "Schadenfreude",
    lang: "독일어",
    ipa: "/ˈʃaːdn̩ˌfʁɔʏ̯də/",
    read: "샤덴프로이데",
    ko: "남의 불행을 보며 느끼는 은근한 기쁨"
  },
  {
    word: "benediction",
    lang: "영어",
    ipa: "/ˌbenɪˈdɪkʃn/",
    read: "베네딕션",
    ko: "헤어질 때 건네는 축복의 말"
  },
  {
    word: "ennui",
    lang: "프랑스어",
    ipa: "/ɑ̃.nɥi/",
    read: "앙뉘",
    ko: "이유 없이 가라앉는 나른한 권태"
  },
  {
    word: "木漏れ日 (komorebi)",
    lang: "일본어",
    ipa: "/ko.mo.ɾe.bi/",
    read: "코모레비",
    ko: "나뭇잎 사이로 부서져 내리는 햇살"
  },
  {
    word: "幽玄 (yūgen)",
    lang: "일본어",
    ipa: "/jɯː.ɡeɴ/",
    read: "유겐",
    ko: "말로 다 설명할 수 없는 그윽하고 깊은 아름다움"
  },
  {
    word: "petrichor",
    lang: "영어",
    ipa: "/ˈpetrɪkɔːr/",
    read: "페트리커",
    ko: "비가 내린 뒤 흙에서 피어오르는 냄새"
  },
  {
    word: "mellifluous",
    lang: "영어",
    ipa: "/məˈlɪfluəs/",
    read: "멜리플루어스",
    ko: "꿀이 흐르듯 부드럽고 달콤한 목소리"
  },
  {
    word: "dépaysement",
    lang: "프랑스어",
    ipa: "/de.pɛ.iz.mɑ̃/",
    read: "데페이즈망",
    ko: "낯선 곳에 와 있다는, 설렘 섞인 이질감"
  },
  {
    word: "retrouvailles",
    lang: "프랑스어",
    ipa: "/ʁə.tʁu.vaj/",
    read: "르트루바이",
    ko: "오래 떨어져 있던 사람과 다시 만나는 기쁨"
  },
  {
    word: "flânerie",
    lang: "프랑스어",
    ipa: "/flɑ.nə.ʁi/",
    read: "플라느리",
    ko: "목적 없이 거리를 거니는 느긋한 산책"
  }
];

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 한 줄을 정리한다. 단어와 뜻이 둘 다 있어야 쓸 수 있다. */
function normalizeWord(o) {
  if (!o || typeof o !== "object") return null;
  const s = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  const w = { word: s(o.word), lang: s(o.lang), ipa: s(o.ipa), read: s(o.read), ko: s(o.ko) };
  if (!w.word || !w.ko) return null;
  if (w.word.length > 60 || w.ko.length > 120) return null;
  return w;
}

/** 문제로 쓸 수 있는 줄만 남긴다. 뜻이 겹치면 보기가 헷갈리므로 뒤엣것을 버린다. */
function usableWords(list) {
  const out = [];
  const seenKo = new Set();
  const seenWord = new Set();
  for (const raw of list || []) {
    const w = normalizeWord(raw);
    if (!w || seenKo.has(w.ko) || seenWord.has(w.word)) continue;
    seenKo.add(w.ko);
    seenWord.add(w.word);
    out.push(w);
  }
  return out;
}

/** 실제로 문제를 낼 목록. 사용자 목록이 모자라면 기본 단어를 쓴다. */
function effectiveWords(list) {
  const mine = usableWords(list);
  return mine.length >= QUIZ_CHOICES ? mine : usableWords(DEFAULT_WORDS);
}

/**
 * 4지선다 한 문제.
 * @param {Array} list  저장된 단어 목록 (비어 있으면 기본 단어)
 * @param {string} avoid 직전에 나온 단어 — 연달아 같은 문제가 나오지 않게 한다
 */
function buildQuestion(list, avoid) {
  const pool = effectiveWords(list);
  if (pool.length < QUIZ_CHOICES) return null;

  let order = shuffled(pool.map((_, i) => i));
  if (avoid) {
    const others = order.filter((i) => pool[i].word !== avoid);
    if (others.length) order = others;
  }
  const idx = order[0];
  const distractors = shuffled(pool.map((_, i) => i).filter((i) => i !== idx))
    .slice(0, QUIZ_CHOICES - 1);
  const shown = shuffled([idx, ...distractors]);

  return {
    word: pool[idx],
    options: shown.map((i) => pool[i].ko),
    answer: shown.indexOf(idx)
  };
}
