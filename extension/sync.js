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
 *   - 기기마다 따로 두는 것: 차단 켜기/끄기(enabled), 잠금(lockOn), 기기 이름,
 *     동기화 켜기/끄기(syncOn), 사이트 권한
 *
 * 동기화된 기기
 *   - 기기마다 한 칸(d_<기기번호>)에 "그 기기의 지금 차단·예외 목록"을 둔다.
 *   - 목록이 바뀌면 그 칸이 최신 상태로 덮어써진다. 쌓이지 않는다.
 *   - 사용자는 다른 기기의 칸을 지울 수 있고, 그 기기의 목록을 가져올 수 있다.
 *
 * 이전 목록 보관함 (v_<시각>)
 *   - 공유 차단·예외 목록이 바뀌기 "직전" 상태를 동기화 저장소에 남긴다.
 *     빈 기기가 목록을 올려도 그 전의 공유 목록이 기록에 남도록, 기준은 늘 "덮어쓰기 직전의 공유 목록"이다.
 *   - 직접 바꾼 경우와 다른 기기에서 받은 경우 모두 해당된다. 기록이 공유되므로
 *     바꾼 기기(올리는 기기)가 한 번만 쓴다.
 *   - 10분 안에 연달아 바뀐 건 하나로 묶는다 (묶음의 첫 변경 직전 상태만 남는다).
 *   - 최근 30개, 기록 전체 40KB 까지. 공유 목록이 커지면 오래된 기록부터 비켜 준다.
 *
 * 동기화하지 않는 것: 잠금 문제 단어(words) — 기기마다 따로.
 *   대신 사용자가 직접 올리고 직접 내려받는 "대표 단어 리스트"(rwm, rw0…)이 하나 있다 (common.js).
 *   이 파일은 단어 페이지에서만 쓰고 읽는다. 여기서는 건드리지 않는다.
 *
 * 이 기기 동기화 끄기 (syncOn = false)
 *   - 주고받기를 모두 멈춘다. 이 기기 칸에는 "동기화 끔" 표시만 한 번 남긴다.
 *   - 다시 켜면 처음 연결할 때처럼 10분 동안 양쪽 목록을 합친다.
 *
 * 용량 제한 (크롬 고정값)
 *   전체 100KB · 항목 하나당 8KB · 쓰기 분당 120회
 *   → 목록을 7.5KB 이하 조각(b0, b1… / a0…)으로 나눠 담는다.
 *   → 조각마다 개정 번호(r)를 붙여, 다른 기기에서 일부 조각만 먼저 도착한
 *     어중간한 상태는 적용하지 않는다.
 */

const SYNCED_KEYS = ["blocked", "allowed"];
const SYNC_SCHEMA = 2;
const CHUNK_BYTES = 7500;
const ITEM_LIMIT = 7800;        // 항목 하나당 8KB
const SYNC_BUDGET = 95 * 1024;  // 전체 100KB 에서 여유를 둔다
const PUSH_DELAY_MS = 1500;
/* 처음 연결한 뒤(또는 동기화를 다시 켠 뒤) 10분 동안은 다른 기기에서 온 목록을
 * "덮어쓰지 않고 합친다". 어느 쪽 목록도 사라지지 않게 하기 위함. */
const MERGE_WINDOW_MS = 10 * 60 * 1000;

/* 이전 목록 보관함 */
const VERSION_GROUP_MS = 10 * 60 * 1000; // 10분 안의 연속 변경은 하나로 묶는다
const VERSION_MAX = 30;
const VERSION_BUDGET = 40 * 1024;

/* 예전 버전이 남긴 키 — 올릴 때 정리한다 */
const LEGACY_KEY = /^(passHash|salt|hi|hn|h\d|blockPage)$/; // blockPage: 2.2.0 부터 문구 고정

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

  async function isOn() {
    const { syncOn = true } = await chrome.storage.local.get({ syncOn: true });
    return syncOn !== false;
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
    // 단어는 2.2.0 부터 동기화하지 않는다. w: 0 → 예전 단어 조각(w0…)은 올릴 때 지워진다
    return {
      items: {
        v: SYNC_SCHEMA,
        meta: { r: rev, b: b.count, a: a.count, w: 0, at: Date.now() },
        ...b.items,
        ...a.items
      },
      counts: { b: b.count, a: a.count, w: 0 }
    };
  }

  /** sync 전체 → 설정. 아직 비었거나 조각이 덜 도착했으면 null */
  function decode(all) {
    const m = all && all.meta;
    // v1(비밀번호를 같이 올리던 예전 형식)도 읽어준다 — 다음 push 때 정리된다
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
    if (!blocked || !allowed) return null;
    // 예전 버전이 올린 단어 조각(w…)은 읽지 않는다
    return {
      blocked: uniqSorted(blocked),
      allowed: uniqSorted(allowed),
      at: m.at
    };
  }

  /** 두 설정을 합친다: 목록은 합집합 */
  function merge(remote, local) {
    const out = {
      blocked: uniqSorted([...remote.blocked, ...(local.blocked || [])]),
      allowed: uniqSorted([...remote.allowed, ...(local.allowed || [])])
    };
    out.allowed = out.allowed.filter((d) => !out.blocked.includes(d));
    return out;
  }

  const pick = (s) => ({
    blocked: uniqSorted(s.blocked),
    allowed: uniqSorted(s.allowed)
  });

  const listsOf = (s) => ({ b: uniqSorted(s && s.blocked), a: uniqSorted(s && s.allowed) });

  /* ---------------- 이전 목록 보관함 ---------------- */

  /** 동기화 저장소의 기록들 (오래된 순). 각 {key, c, t, b, a} */
  function versionsIn(all) {
    const out = [];
    for (const [k, v] of Object.entries(all || {})) {
      if (!k.startsWith(VERSION_PREFIX) || !v || !Array.isArray(v.b) || !Array.isArray(v.a)) continue;
      out.push({ key: k, c: v.c || 0, t: v.t || v.c || 0, b: v.b, a: v.a });
    }
    return out.sort((x, y) => x.c - y.c);
  }

  /**
   * 공유 목록 cur 가 next 로 덮어써지기 직전에 부를 것.
   * 남길 기록과 지울 기록을 돌려준다 (쓰기는 부른 쪽이 한 번에 한다).
   */
  function versionPlan(all, cur, next, now = Date.now()) {
    const plan = { set: {}, remove: [] };
    if (!cur) return plan;                                   // 아직 공유 목록이 없음
    const before = listsOf(cur);
    const after = listsOf(next);
    if (same(before, after)) return plan;                    // 목록은 그대로
    if (!before.b.length && !before.a.length) return plan;   // 빈 상태는 되돌릴 가치가 없다

    const list = versionsIn(all);
    const last = list[list.length - 1];
    if (last && now - last.c < VERSION_GROUP_MS) return plan; // 10분 묶음 안
    if (last && same({ b: uniqSorted(last.b), a: uniqSorted(last.a) }, before)) return plan;

    const entry = { c: now, t: cur.at || now, b: before.b, a: before.a };
    const size = bytes(JSON.stringify(entry));
    if (size > ITEM_LIMIT) return plan;                      // 너무 긴 목록은 기록하지 못한다

    let total = list.reduce((n, v) => n + bytes(v.key) + bytes(JSON.stringify(all[v.key])), 0);
    let count = list.length;
    for (const v of list) {                                  // 오래된 것부터 비킨다
      if (count < VERSION_MAX && total + size <= VERSION_BUDGET) break;
      plan.remove.push(v.key);
      total -= bytes(v.key) + bytes(JSON.stringify(all[v.key]));
      count--;
    }
    plan.set[VERSION_PREFIX + now.toString(36)] = entry;
    return plan;
  }

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

  /* ---------------- 이 기기 칸 ---------------- */

  /**
   * 이 기기의 지금 차단·예외 목록을 d_<기기번호> 칸에 쓴다.
   * 내용(이름·목록·끔 여부)이 그대로면 쓰지 않으므로 시각도 그대로 남는다.
   */
  async function writeOwnEntry(lists, opts = {}) {
    const { deviceName, deviceId } = await chrome.storage.local.get({ deviceName: "", deviceId: "" });
    if (!deviceId) return;
    const key = DEVICE_PREFIX + deviceId;
    const entry = {
      d: deviceName || "이 기기",
      at: Date.now(),
      b: uniqSorted(lists.blocked),
      a: uniqSorted(lists.allowed)
    };
    if (opts.off) entry.off = true;

    const all = await chrome.storage.sync.get(null);
    const prev = all[key];
    if (prev && prev.d === entry.d && !!prev.off === !!entry.off &&
        same(uniqSorted(prev.b), entry.b) && same(uniqSorted(prev.a), entry.a)) {
      return; // 바뀐 게 없음
    }
    // 한 칸(8KB) 또는 전체 용량을 넘으면 칸을 남기지 못한다 — 차단은 그대로 동작
    const projected = { ...all, [key]: entry };
    if (bytes(JSON.stringify(entry)) > ITEM_LIMIT || sizeOf(projected) > SYNC_BUDGET) {
      await setStatus({ devOff: true });
      return;
    }
    await chrome.storage.sync.set({ [key]: entry });
    await setStatus({ devOff: false });
  }

  /* ---------------- 올리기 / 내려받기 ---------------- */

  async function push(local) {
    const all = await chrome.storage.sync.get(null);
    const cur = decode(all);
    const legacy = Object.keys(all).filter((k) => LEGACY_KEY.test(k));

    if (!cur || !same(pick(cur), pick(local)) || legacy.length || all.w0) {
      const { items, counts } = encode(local);
      // 목록이 줄어서 남게 된 예전 조각 + 예전 버전 잔재(단어 조각 포함) 정리
      const remove = Object.keys(all).filter((k) => {
        const m = /^([abw])(\d+)$/.exec(k);
        if (m) return Number(m[2]) >= (counts[m[1]] || 0);
        return LEGACY_KEY.test(k);
      });
      // 덮어쓰기 직전의 공유 목록을 이전 목록 보관함으로 남긴다
      const plan = versionPlan(all, cur, local);
      remove.push(...plan.remove);
      // 공유 목록이 우선 — 전체 용량을 넘으면 오래된 기록부터 더 비킨다
      const projected = { ...all, ...items, ...plan.set };
      for (const k of remove) delete projected[k];
      for (const v of versionsIn(projected)) {
        if (sizeOf(projected) <= SYNC_BUDGET) break;
        delete projected[v.key];
        if (plan.set[v.key]) delete plan.set[v.key];
        else remove.push(v.key);
      }
      await chrome.storage.sync.set({ ...items, ...plan.set });
      if (remove.length) await chrome.storage.sync.remove(remove);
      await setStatus({ at: Date.now(), error: "" });
    }
    await chrome.storage.local.set({ syncDirty: false });
    await writeOwnEntry(local);
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
    if (!(await isOn())) return false;
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
    else await writeOwnEntry(want); // 이 기기 칸도 지금 목록으로
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
      serial(async () => {
        if (!(await isOn())) return;
        await push(await chrome.storage.local.get(DEFAULTS));
      });
    }, PUSH_DELAY_MS);
  }

  /** 처음 연결하거나 동기화를 다시 켤 때: 서로의 목록을 합친다 (어느 쪽도 잃지 않도록) */
  async function firstLink() {
    await chrome.storage.local.set({
      syncLinked: true, syncDirty: false, syncMergeUntil: Date.now() + MERGE_WINDOW_MS
    });
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

  /** 동기화를 끈 순간: 이 기기 칸에 "동기화 끔" 만 남기고 멈춘다 */
  async function markOff() {
    await chrome.storage.local.set({ syncDirty: false });
    clearTimeout(timer);
    await writeOwnEntry(await chrome.storage.local.get(DEFAULTS), { off: true });
  }

  /** 같은 이름의 다른 기기가 있으면 이 기기 이름 뒤에 번호를 붙인다 */
  async function ensureUniqueName() {
    const { deviceName, deviceId } = await chrome.storage.local.get({ deviceName: "", deviceId: "" });
    if (!deviceName || !deviceId) return;
    const devices = devicesFrom(await chrome.storage.sync.get(null));
    const clash = devices.some((e) => e.d === deviceName && e.id !== deviceId);
    if (!clash) return;
    const taken = new Set(devices.map((e) => e.d));
    for (let n = 2; n < 30; n++) {
      const candidate = `${deviceName} ${n}`;
      if (!taken.has(candidate)) {
        await chrome.storage.local.set({ deviceName: candidate });
        return;
      }
    }
  }

  async function onStart() {
    if (!(await isOn())) return;
    const { syncLinked, syncDirty } = await chrome.storage.local.get({ syncLinked: false, syncDirty: false });
    await ensureUniqueName();
    if (!syncLinked) return firstLink();
    // 올리지 못한 변경이 남아 있으면 먼저 올리고, 아니면 다른 기기의 변경을 받는다
    if (syncDirty) return push(await chrome.storage.local.get(DEFAULTS));
    const pulled = await pull();
    // 예전 버전 잔재가 있거나 아직 한 번도 안 올렸다면 정리 겸 올린다
    const all = await chrome.storage.sync.get(null);
    if (!pulled && !all.meta) await push(await chrome.storage.local.get(DEFAULTS)); // 아직 아무도 안 올림
    else if (all.w0 || Object.keys(all).some((k) => LEGACY_KEY.test(k))) { // 예전 잔재·단어 조각 정리
      await push(await chrome.storage.local.get(DEFAULTS));
    }
  }

  function init() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        // 이 기기 동기화 켜기/끄기
        if ("syncOn" in changes) {
          const on = changes.syncOn.newValue !== false;
          serial(on ? firstLink : markOff);
          return;
        }
        // 이름이 바뀌면 이 기기 칸만 고친다
        if ("deviceName" in changes) {
          serial(async () => {
            if (await isOn()) await writeOwnEntry(await chrome.storage.local.get(DEFAULTS));
          });
        }
        const keys = SYNCED_KEYS.filter((k) => k in changes);
        if (!keys.length) return;
        if (keys.every((k) => lastApplied[k] === JSON.stringify(changes[k].newValue))) return; // 방금 내려받은 값
        isOn().then((on) => {
          if (!on) return; // 동기화를 끈 기기의 변경은 이 기기 안에만 남는다
          chrome.storage.local.set({ syncDirty: true });
          schedulePush();
        });
      } else if (area === "sync") {
        serial(pull);
      }
    });
    serial(onStart);
  }

  // push/pull/onStart 등은 테스트에서 직접 호출하려고 함께 내보낸다
  return { init, encode, decode, merge, push, pull, onStart, firstLink, markOff, writeOwnEntry,
           versionPlan, versionsIn };
})();
