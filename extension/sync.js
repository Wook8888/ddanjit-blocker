/* 딴짓 차단기 - 크롬 동기화 (백그라운드 서비스 워커에서 importScripts 로 불러온다)
 *
 * chrome.storage.sync 에 설정을 올려두면, 같은 구글 계정으로 로그인해 동기화를 켜 둔
 * 모든 크롬에 구글이 자동으로 퍼뜨려 준다. 별도 서버가 필요 없다.
 * 동기화가 꺼져 있으면 storage.sync 는 그냥 그 기기 안에 저장된다 (오류 없음).
 *
 * 구조
 *   - 실제 동작(차단 규칙·팝업)은 계속 storage.local 을 기준으로 한다.
 *   - 이 파일은 local ↔ sync 를 서로 맞춰주는 역할만 한다.
 *       local 이 바뀌면 → 잠깐 모았다가 sync 로 올림
 *       sync 가 바뀌면(다른 기기) → local 로 내려받음
 *   - 기기마다 따로 두는 것: 차단 켜기/끄기(enabled), 잠금(lockOn), 기기 이름, 사이트 권한
 *
 * 기록
 *   - 목록이 바뀔 때마다 "그 시점의 목록 전체"를 h0~h9 에 돌려 담는다 (최근 10개).
 *   - 같은 기기가 몇 분 안에 연달아 고친 것은 한 칸으로 묶는다.
 *   - 사용자가 기록에서 한 시점을 골라 그 상태로 통째로 되돌릴 수 있다.
 *
 * 용량 제한 (크롬 고정값)
 *   전체 100KB · 항목 하나당 8KB · 쓰기 분당 120회
 *   → 목록을 7.5KB 이하 조각(b0, b1… / a0… / w0…)으로 나눠 담는다.
 *   → 조각마다 개정 번호(r)를 붙여, 다른 기기에서 일부 조각만 먼저 도착한
 *     어중간한 상태는 적용하지 않는다.
 *   → 다 담고도 넘치면 오래된 기록부터 버린다.
 */

const SYNCED_KEYS = ["blocked", "allowed", "blockPage", "words"];
const SYNC_SCHEMA = 2;
const CHUNK_BYTES = 7500;
const ITEM_LIMIT = 7800;        // 항목 하나당 8KB
const SYNC_BUDGET = 90 * 1024;  // 전체 100KB 에서 여유를 둔다
const PUSH_DELAY_MS = 1500;
const COALESCE_MS = 5 * 60 * 1000; // 이 시간 안에 같은 기기가 한 변경은 한 칸으로 묶는다
/* 처음 연결한 뒤 10분 동안은 다른 기기에서 온 목록을 "덮어쓰지 않고 합친다".
 * 새 기기에 설치한 직후에는 크롬이 아직 다른 기기의 목록을 받아오기 전일 수 있어서,
 * 그 사이에 이 기기 목록이 먼저 올라가도 양쪽 어느 것도 사라지지 않게 하기 위함. */
const MERGE_WINDOW_MS = 10 * 60 * 1000;

const Sync = (() => {
  const enc = new TextEncoder();
  const bytes = (s) => enc.encode(s).length;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const uniqSorted = (arr) => [...new Set(arr || [])].sort();

  function sizeOf(obj) {
    let t = 0;
    for (const [k, v] of Object.entries(obj)) t += bytes(k) + bytes(JSON.stringify(v));
    return t;
  }

  /* ---------------- 조각 나누기 ---------------- */

  function chunk(prefix, list, rev) {
    const items = {};
    let cur = [];
    let curBytes = 0;
    let n = 0;
    const overhead = bytes(`${prefix}99{"r":"${rev}","d":[]}`);
    for (const d of list) {
      const add = bytes(JSON.stringify(d)) + 1;
      if (cur.length && overhead + curBytes + add > CHUNK_BYTES) {
        items[prefix + n++] = { r: rev, d: cur };
        cur = [];
        curBytes = 0;
      }
      cur.push(d);
      curBytes += add;
    }
    if (cur.length) items[prefix + n++] = { r: rev, d: cur };
    return { items, count: n };
  }

  /** 설정 → sync 에 쓸 항목들 */
  function encode(s) {
    const rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const b = chunk("b", uniqSorted(s.blocked), rev);
    const a = chunk("a", uniqSorted(s.allowed), rev);
    const w = chunk("w", s.words || [], rev); // 단어는 사용자가 정한 순서를 지킨다
    return {
      items: {
        v: SYNC_SCHEMA,
        meta: { r: rev, b: b.count, a: a.count, w: w.count, at: Date.now() },
        ...b.items,
        ...a.items,
        ...w.items,
        blockPage: s.blockPage
      },
      counts: { b: b.count, a: a.count, w: w.count }
    };
  }

  /** sync 전체 → 설정. 아직 비었거나 조각이 덜 도착했으면 null */
  function decode(all) {
    const m = all && all.meta;
    // v1(비밀번호를 같이 올리던 예전 형식)도 읽어준다 — 다음 push 때 v2 로 올라간다
    if (!m || (all.v !== SYNC_SCHEMA && all.v !== 1)) return null;
    const collect = (prefix, count) => {
      const out = [];
      for (let i = 0; i < (count || 0); i++) {
        const c = all[prefix + i];
        if (!c || c.r !== m.r) return null; // 조각이 섞여 있음 → 나머지가 올 때까지 기다린다
        out.push(...c.d);
      }
      return out;
    };
    const blocked = collect("b", m.b);
    const allowed = collect("a", m.a);
    const words = collect("w", m.w);
    if (!blocked || !allowed || !words) return null;
    return {
      blocked: uniqSorted(blocked),
      allowed: uniqSorted(allowed),
      blockPage: all.blockPage,
      words,
      at: m.at
    };
  }

  /** 두 설정을 합친다: 목록은 합집합, 문구·단어는 원격(먼저 연결된 기기) 우선 */
  function merge(remote, local) {
    const out = {
      blocked: uniqSorted([...remote.blocked, ...(local.blocked || [])]),
      allowed: uniqSorted([...remote.allowed, ...(local.allowed || [])]),
      blockPage: remote.blockPage || local.blockPage,
      words: (remote.words && remote.words.length) ? remote.words : (local.words || [])
    };
    out.allowed = out.allowed.filter((d) => !out.blocked.includes(d));
    return out;
  }

  const pick = (s) => ({
    blocked: uniqSorted(s.blocked),
    allowed: uniqSorted(s.allowed),
    blockPage: s.blockPage,
    words: s.words || []
  });

  /* ---------------- 상태 기록 ---------------- */

  async function setStatus(patch) {
    const { syncStatus = {} } = await chrome.storage.local.get("syncStatus");
    await chrome.storage.local.set({ syncStatus: { ...syncStatus, ...patch } });
  }

  function friendlyError(e) {
    const m = String((e && e.message) || e);
    if (/QUOTA_BYTES_PER_ITEM|QUOTA_BYTES|quota/i.test(m)) {
      return "크롬 동기화 용량(100KB)을 넘었습니다. 목록이 이 기기에만 저장됩니다.";
    }
    if (/MAX_WRITE_OPERATIONS/i.test(m)) {
      return "짧은 시간에 너무 자주 바뀌어 동기화를 잠시 미뤘습니다. 곧 다시 시도합니다.";
    }
    return "동기화 실패: " + m;
  }

  /* ---------------- 기록 ---------------- */

  /**
   * 이번 변경을 담을 기록 항목을 만든다.
   * 되돌리기가 아니고 같은 기기가 COALESCE_MS 안에 또 고친 것이라면,
   * 새 칸을 쓰지 않고 가장 최근 칸을 최신 상태로 덮어쓴다.
   */
  function makeSnapshot(all, local, dev, devId, revertFrom) {
    const entry = {
      at: Date.now(),
      d: dev || "이 기기",
      i: devId || "",
      b: uniqSorted(local.blocked),
      a: uniqSorted(local.allowed)
    };
    if (revertFrom) entry.r = revertFrom;
    if (bytes(JSON.stringify(entry)) > ITEM_LIMIT) return null; // 목록이 너무 길면 기록은 건너뛴다

    let hn = Math.min(Math.max(all.hn | 0, 0), HISTORY_MAX);
    let hi = Math.min(Math.max(all.hi | 0, 0), HISTORY_MAX - 1);
    const newest = hn ? all["h" + hi] : null;
    const coalesce =
      !revertFrom && newest && !newest.r &&
      (newest.i ? newest.i === entry.i : newest.d === entry.d) &&
      Date.now() - (newest.at || 0) < COALESCE_MS;

    if (!coalesce) {
      hi = hn ? (hi + 1) % HISTORY_MAX : 0;
      hn = Math.min(hn + 1, HISTORY_MAX);
    }
    return { items: { ["h" + hi]: entry, hi, hn }, hi, hn };
  }

  /* ---------------- 올리기 / 내려받기 ---------------- */

  async function push(local) {
    const { items: settings, counts } = encode(local);
    const all = await chrome.storage.sync.get(null);
    const cur = decode(all);
    if (cur && same(pick(cur), pick(local))) {
      await chrome.storage.local.set({ syncDirty: false });
      return; // 이미 같음
    }

    // 목록이 줄어서 남게 된 예전 조각 + v1 잔재(비밀번호) 정리
    const remove = Object.keys(all).filter((k) => {
      const m = /^([abw])(\d+)$/.exec(k);
      if (m) return Number(m[2]) >= (counts[m[1]] || 0);
      return k === "passHash" || k === "salt";
    });

    const write = { ...settings };
    const { deviceName, deviceId, revertFrom } = await chrome.storage.local.get({
      deviceName: "", deviceId: "", revertFrom: 0
    });

    const snap = makeSnapshot(all, local, deviceName, deviceId, revertFrom);
    // 목록이 너무 길어 한 칸(8KB)에 안 들어가면 기록을 남기지 못한다 — 사용자에게 알린다
    await setStatus({ histOff: !snap });
    if (snap) {
      Object.assign(write, snap.items);
      // 다 담고도 100KB 를 넘으면 오래된 기록부터 버린다
      const projected = { ...all };
      for (const k of remove) delete projected[k];
      Object.assign(projected, write);
      let hn = snap.hn;
      const hi = snap.hi;
      while (hn > 1 && sizeOf(projected) > SYNC_BUDGET) {
        const oldest = ((hi - (hn - 1)) % HISTORY_MAX + HISTORY_MAX) % HISTORY_MAX;
        delete projected["h" + oldest];
        remove.push("h" + oldest);
        hn -= 1;
        projected.hn = hn;
        write.hn = hn;
      }
    }

    await chrome.storage.sync.set(write);
    if (remove.length) await chrome.storage.sync.remove(remove);
    if (revertFrom) await chrome.storage.local.set({ revertFrom: 0 });
    await chrome.storage.local.set({ syncDirty: false });
    await setStatus({ at: Date.now(), error: "" });
  }

  /* sync → local 로 내려받아 쓴 값을 기억해 둔다.
   * storage.onChanged 는 set() 이 끝난 뒤 한 박자 늦게 오기 때문에 단순 플래그로는
   * 되돌려 올리기를 막을 수 없다. 대신 "방금 내려받은 값과 같은 변경"이면 무시한다. */
  let lastApplied = {};
  async function applyToLocal(values) {
    lastApplied = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, JSON.stringify(v)]));
    await chrome.storage.local.set(values);
  }

  async function pull() {
    // 이 기기에 아직 올리지 못한 변경이 있으면 그걸 우선한다 (곧 올라간다)
    const { syncDirty, syncMergeUntil } = await chrome.storage.local.get({ syncDirty: false, syncMergeUntil: 0 });
    if (syncDirty) return false;
    const remote = decode(await chrome.storage.sync.get(null));
    if (!remote) return false;
    const local = await chrome.storage.local.get(DEFAULTS);

    const merging = Date.now() < syncMergeUntil;
    const want = merging ? pick(merge(remote, local)) : pick(remote);

    if (!same(pick(local), want)) {
      await applyToLocal(want);
      await setStatus({ at: Date.now(), error: "" });
    }
    // 합친 결과가 원격과 다르면 다시 올려서 양쪽을 같게 만든다
    if (merging && !same(pick(remote), want)) await push(want);
    return true;
  }

  /* ---------------- 예약 · 직렬화 ---------------- */

  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = () => fn().catch(async (e) => {
      console.error("[딴짓 차단기] 동기화", e);
      await setStatus({ error: friendlyError(e) });
    });
    chain = chain.then(run, run);
    return chain;
  };

  let timer = null;
  function schedulePush() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      serial(async () => push(await chrome.storage.local.get(DEFAULTS)));
    }, PUSH_DELAY_MS);
  }

  /** 이 기기에서 처음 동기화를 시작할 때: 서로의 목록을 합친다 (어느 쪽도 잃지 않도록) */
  async function firstLink() {
    await chrome.storage.local.set({ syncLinked: true, syncMergeUntil: Date.now() + MERGE_WINDOW_MS });
    const local = await chrome.storage.local.get(DEFAULTS);
    const remote = decode(await chrome.storage.sync.get(null));
    if (remote) {
      const merged = merge(remote, local);
      await applyToLocal(merged);
      await push(merged);
    } else {
      await push(local);
    }
  }

  /** 기록에 같은 이름의 다른 기기가 있으면 이 기기 이름 뒤에 번호를 붙인다 */
  async function ensureUniqueName() {
    const { deviceName, deviceId } = await chrome.storage.local.get({ deviceName: "", deviceId: "" });
    if (!deviceName || !deviceId) return;
    const hist = historyFrom(await chrome.storage.sync.get(null));
    const clash = hist.some((e) => e.d === deviceName && e.i && e.i !== deviceId);
    if (!clash) return;
    const taken = new Set(hist.map((e) => e.d));
    for (let n = 2; n < 30; n++) {
      const candidate = `${deviceName} ${n}`;
      if (!taken.has(candidate)) {
        await chrome.storage.local.set({ deviceName: candidate });
        return;
      }
    }
  }

  async function onStart() {
    const { syncLinked, syncDirty } = await chrome.storage.local.get({ syncLinked: false, syncDirty: false });
    await ensureUniqueName();
    if (!syncLinked) return firstLink();
    // 올리지 못한 변경이 남아 있으면 먼저 올리고, 아니면 다른 기기의 변경을 받는다
    if (syncDirty) return push(await chrome.storage.local.get(DEFAULTS));
    await pull();
  }

  function init() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        const keys = SYNCED_KEYS.filter((k) => k in changes);
        if (!keys.length) return;
        if (keys.every((k) => lastApplied[k] === JSON.stringify(changes[k].newValue))) return; // 방금 내려받은 값
        chrome.storage.local.set({ syncDirty: true });
        schedulePush();
      } else if (area === "sync") {
        // 기록만 바뀐 경우에도 pull 은 안전하다 (같으면 아무것도 하지 않는다)
        serial(pull);
      }
    });
    serial(onStart);
  }

  // push/pull/onStart 은 테스트에서 직접 호출하려고 함께 내보낸다
  return { init, encode, decode, merge, makeSnapshot, push, pull, onStart, firstLink };
})();
