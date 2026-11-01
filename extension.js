/* 기억 서재 자동 주입 v1.0.1
 * 기억 서재가 켜진 롤플레이 방에 {{기억}} 요약 항목을 넣고 기존 요약을 끈다.
 * 확장을 끄면(또는 기억 서재에서 그 방의 기억을 끄면) 이 확장이 끈 요약만 되살리고 넣은 항목을 지운다.
 * 무엇을 껐는지는 각 방의 메타데이터(memoryLibraryInject)에 적어 두므로, 확장이 꺼진 뒤에도 되돌릴 수 있다.
 */
const INJECT_ID = "memory-library-inject";
const META_KEY = "memoryLibraryInject";
const CONTENT = "{{기억}}"; // 기억이 비면 요약 칸 전체가 빠지도록 태그 없이 둔다
const TITLE = "기억 서재 (자동 주입)";
const MEMORY_MACRO = /\{\{\s*(?:기억|memory)\s*\}\}/i;
const POLL_MS = 20000;
const CHAT_KEY_POLL_MS = 3000;

const log = marinara.log;
let stopped = false;
let chain = Promise.resolve();          // 모든 작업을 한 줄로 세워 서로 겹치지 않게 한다
const managed = new Set();              // 이 확장이 손댄 방
const skipped = new Set();              // 이번 실행 동안 건너뛸 방(롤플레이 아님, 직접 {{기억}}을 넣어 둔 방 등)

/* ---------- 서버 ---------- */

async function api(method, path, body) {
  const init = { method, credentials: "same-origin", cache: "no-store", headers: {} };
  if (method !== "GET") {
    init.headers["x-marinara-csrf"] = "1";
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  const res = await marinara.fetch(path, init);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const chatUrl = (id) => `/api/chats/${encodeURIComponent(id)}`;
const parseMeta = (raw) => {
  if (raw && typeof raw === "object") return raw;
  try { return JSON.parse(raw || "{}") || {}; } catch { return {}; }
};

// 마리나라 shared/utils/chat-summary-entries.ts 의 fallbackId 와 같은 계산(요약이 옛 형식 문자열뿐인 방용)
function legacyId(content) {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `summary-legacy-${(hash >>> 0).toString(36)}`;
}

function entriesOf(meta) {
  const list = Array.isArray(meta.summaryEntries)
    ? meta.summaryEntries.filter((e) => e && typeof e.id === "string" && String(e.content || "").trim())
    : [];
  if (list.length) return list.map((e) => ({ id: e.id, content: String(e.content), enabled: e.enabled !== false }));
  const legacy = typeof meta.summary === "string" ? meta.summary.trim() : "";
  return legacy ? [{ id: legacyId(legacy), content: legacy, enabled: true }] : [];
}

const patchEntries = (id, body) => api("PATCH", `${chatUrl(id)}/summary-entries`, body);
const patchMeta = (id, patch) => api("PATCH", `${chatUrl(id)}/metadata`, patch);

async function saveManaged() {
  if (stopped) return; // 꺼진 뒤에는 확장 저장소에 접근할 수 없다
  try { await marinara.storage.patch({ rooms: [...managed] }); } catch (e) { log.warn("저장 실패", e); }
}

/* ---------- 방 단위 ---------- */

async function apply(id) {
  const chat = await api("GET", chatUrl(id));
  if (!chat) { skipped.add(id); return; } // 지워진 방
  if (chat.mode && chat.mode !== "roleplay") { skipped.add(id); return; } // 요약은 롤플레이 방에서만 들어간다
  const meta = parseMeta(chat.metadata);
  const entries = entriesOf(meta);

  const mine = entries.find((e) => e.id === INJECT_ID);
  if (mine) {
    // 이미 들어 있는 방은 다시 건드리지 않는다(이 확장이 넣은 항목의 내용만 최신 형식으로 맞춤)
    if (mine.content !== CONTENT) {
      await patchEntries(id, { operation: "replace", entry: { id: INJECT_ID, content: CONTENT, title: TITLE, origin: "manual", enabled: mine.enabled } });
    }
    if (!meta[META_KEY]) await patchMeta(id, { [META_KEY]: { disabledIds: [], at: new Date().toISOString() } });
    managed.add(id);
    await saveManaged();
    return;
  }
  if (entries.some((e) => e.id !== INJECT_ID && MEMORY_MACRO.test(e.content))) { skipped.add(id); return; } // 직접 넣어 둔 {{기억}}이 있으면 중복 방지

  const toDisable = entries.filter((e) => e.enabled).map((e) => e.id);
  // 무엇을 끄는지 먼저 적어 둔다(중간에 실패해도 되돌릴 수 있게)
  await patchMeta(id, { [META_KEY]: { disabledIds: toDisable, at: new Date().toISOString() } });
  managed.add(id);
  await saveManaged();
  try {
    if (toDisable.length) await patchEntries(id, { operation: "toggle", entryIds: toDisable, enabled: false });
    await patchEntries(id, { operation: "replace", entry: { id: INJECT_ID, content: CONTENT, title: TITLE, origin: "manual", enabled: true } });
    log.info(`적용: ${chat.name || id} (요약 ${toDisable.length}개 끔)`);
  } catch (error) {
    log.error(`적용 실패, 되돌림: ${id}`, error);
    await restore(id).catch(() => {});
    skipped.add(id);
  }
}

async function restore(id) {
  const chat = await api("GET", chatUrl(id));
  if (!chat) { managed.delete(id); await saveManaged(); return; }
  const meta = parseMeta(chat.metadata);
  const record = meta[META_KEY];
  const entries = entriesOf(meta);
  const byId = new Map(entries.map((e) => [e.id, e]));

  const back = [...new Set(Array.isArray(record?.disabledIds) ? record.disabledIds : [])]
    .filter((eid) => eid !== INJECT_ID && byId.has(eid) && !byId.get(eid).enabled);
  if (back.length) await patchEntries(id, { operation: "toggle", entryIds: back, enabled: true });
  if (byId.has(INJECT_ID)) await patchEntries(id, { operation: "delete", entryId: INJECT_ID });
  if (record != null) await patchMeta(id, { [META_KEY]: null });
  managed.delete(id);
  await saveManaged();
  log.info(`되돌림: ${chat.name || id} (요약 ${back.length}개 다시 켬)`);
}

/* ---------- 전체 맞추기 ---------- */

async function enabledRooms() {
  const status = await api("GET", "/api/memory-module/status");
  const chats = status?.settings?.chats;
  if (!chats || typeof chats !== "object") return null; // 기억 서재가 없거나 응답이 이상하면 아무것도 하지 않는다
  return new Set(Object.entries(chats).filter(([, v]) => v?.enabled === true).map(([k]) => k));
}

async function sync() {
  if (stopped) return;
  const enabled = await enabledRooms();
  if (!enabled || stopped) return;
  for (const id of enabled) {
    if (stopped) return;
    if (!managed.has(id) && !skipped.has(id)) await apply(id).catch((e) => log.warn(`적용 건너뜀: ${id}`, e));
  }
  for (const id of [...managed]) {
    if (stopped) return;
    if (!enabled.has(id)) await restore(id).catch((e) => log.warn(`되돌림 실패: ${id}`, e)); // 방에서 기억을 끄면 원래대로
  }
}

const queue = (task) => (chain = chain.then(task).catch((e) => log.warn(e)));

/* ---------- 시작 ---------- */

queue(async () => {
  const saved = await marinara.storage.get().catch(() => ({}));
  for (const id of Array.isArray(saved.rooms) ? saved.rooms : []) {
    // 지난번 끌 때 이미 되돌린 방은 기록만 남아 있을 수 있으니 실제 방 상태로 확인
    try {
      const chat = await api("GET", chatUrl(id));
      if (chat && parseMeta(chat.metadata)[META_KEY]) managed.add(id);
    } catch { managed.add(id); }
  }
  await saveManaged();
});
queue(sync);

let lastChat = (() => { try { return localStorage.getItem("marinara-active-chat-id") || ""; } catch { return ""; } })();
marinara.setInterval(() => {
  let now = "";
  try { now = localStorage.getItem("marinara-active-chat-id") || ""; } catch {}
  if (now !== lastChat) { lastChat = now; skipped.delete(now); queue(sync); }
}, CHAT_KEY_POLL_MS);
marinara.setInterval(() => { if (document.visibilityState === "visible") queue(sync); }, POLL_MS);
const onVisible = () => { if (document.visibilityState === "visible") queue(sync); };
document.addEventListener("visibilitychange", onVisible);

/* ---------- 끄기 ---------- */

marinara.onCleanup(async () => {
  document.removeEventListener("visibilitychange", onVisible);
  // 진행 중인 작업을 마저 끝낸 뒤 판단
  await chain.catch(() => {});
  // 화면 새로 그리기·업데이트로 다시 시작되는 경우엔 되돌리지 않는다. 정말 꺼졌을 때만 되돌린다.
  try {
    const list = await api("GET", "/api/personal-extensions/runtime/client");
    if (Array.isArray(list) && list.some((x) => x?.id === marinara.extension.id)) { stopped = true; return; }
  } catch { stopped = true; return; } // 확인이 안 되면 안전하게 아무것도 하지 않음
  stopped = true;
  for (const id of [...managed]) {
    try { await restore(id); } catch (e) { log.warn(`되돌림 실패: ${id}`, e); }
  }
});
