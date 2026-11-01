/* 기억 서재 자동 주입 v2.1.1
 *
 * 1) 프리셋: 모든 프리셋(마리나라 기본 제공 제외)에 {{기억}} 한 줄짜리 'Memory' 섹션을 자동으로 넣는다.
 *    위치 규칙(꺼진 섹션·꺼진 그룹은 없는 것으로 친다)
 *      ① Chat Summary / Chat History 마커 중 먼저 나오는 것 바로 위 (기억 서재 README 추천 위치)
 *      ② 둘 다 없으면 앞쪽 시스템 섹션 묶음의 끝 (마리나라가 요약을 붙이는 안전한 자리)
 *      ③ 첫 섹션부터 system 이 아니면 맨 위
 *    한 번 넣은 뒤에는 사용자가 옮겨도 다시 끌어오지 않는다. 다른 섹션에 {{기억}}이 이미 있으면 넣지 않는다.
 *    기억 서재가 꺼진 방에서는 {{기억}}이 빈 값이라 섹션 자체가 빠진다.
 * 2) 방(선택, 기본 켬): 기억 서재가 켜진 롤플레이 방의 마리나라 채팅 요약을 꺼서 중복을 막는다.
 *    무엇을 껐는지는 방 메타데이터(memoryLibraryInject)에 적어 두고, 기억을 끄거나 옵션·확장을 끄면 되살린다.
 * 확장을 끄면 넣은 섹션을 지우고 끈 요약을 되살린다.
 *
 * 주기적으로 서버를 훑지 않는다. 시작할 때 한 번 전체를 맞춘 뒤에는
 *   - 프리셋을 새로 만들거나 가져왔을 때(그 요청이 끝난 직후) 새 프리셋에만 넣고,
 *   - 기억 서재에서 방의 기억을 켜고 끌 때, 방을 옮길 때, 창으로 돌아올 때만 방 상태를 맞춘다.
 */
const SECTION_IDENT = "memory-library-section";
const SECTION_NAME = "📚 Memory"; // 프리셋 감싸기 형식이 XML이면 <memory>, 마크다운이면 ## Memory, 없음이면 그대로
const SECTION_CONTENT = "{{기억}}";
const META_KEY = "memoryLibraryInject";
const MEMORY_MACRO = /\{\{\s*(?:기억|memory)\s*\}\}/i;
const CHAT_KEY_POLL_MS = 3000; // 브라우저 안의 값만 읽음(서버 요청 아님)

const log = marinara.log;
let stopped = false;
let chain = Promise.resolve();
const managed = new Set();  // 요약을 꺼 둔 방
const skipped = new Set();  // 이번 실행 동안 건너뛸 방
let disableSummaries = true;
let lastPresetResult = "";
const knownPresetIds = new Set();
const stockPresetIds = new Set();

/* ---------- 서버 ---------- */

async function api(method, path, body) {
  const init = { method, credentials: "same-origin", cache: "no-store", headers: {} };
  if (method !== "GET") {
    init.headers["x-marinara-csrf"] = "1";
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const res = await marinara.fetch(path, init);
  if (res.status === 404) return null;
  if (!res.ok) { const err = new Error(`${method} ${path} → ${res.status}`); err.status = res.status; throw err; }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const truthy = (v) => v === true || v === "true";
const parseJson = (v, fallback = null) => {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(v || "null") ?? fallback; } catch { return fallback; }
};
const chatUrl = (id) => `/api/chats/${encodeURIComponent(id)}`;
const presetUrl = (id) => `/api/prompts/${encodeURIComponent(id)}`;

/* ---------- 프리셋 ---------- */

const isOurs = (sec) => sec?.identifier === SECTION_IDENT;
const markerType = (sec) => (truthy(sec?.isMarker) ? parseJson(sec?.markerConfig)?.type : null);

/** 새 섹션을 끼울 자리(우리 섹션을 뺀 순서 기준 인덱스)와 그룹 */
function placement(order, byId, groupOn) {
  const live = (sec) => sec && truthy(sec.enabled) && (!sec.groupId || groupOn(sec.groupId));
  const active = order.filter((id) => live(byId.get(id)));
  const target = active.find((id) => ["chat_summary", "chat_history"].includes(markerType(byId.get(id))));
  if (target) return { index: order.indexOf(target), groupId: byId.get(target).groupId || null };
  let lastSystem = null;
  for (const id of active) {
    if (byId.get(id).role !== "system") break;
    lastSystem = id;
  }
  if (lastSystem) return { index: order.indexOf(lastSystem) + 1, groupId: byId.get(lastSystem).groupId || null };
  return { index: 0, groupId: null };
}

async function syncPreset(presetId) {
  const full = await api("GET", `${presetUrl(presetId)}/full`);
  if (!full) return "none";
  const sections = Array.isArray(full.sections) ? full.sections : [];
  const ours = sections.filter(isOurs);
  const own = sections.some((s) => !isOurs(s) && truthy(s.enabled) && MEMORY_MACRO.test(String(s.content || "")));
  const sectionUrl = (s) => `${presetUrl(presetId)}/sections/${encodeURIComponent(s.id)}`;
  try {
    if (stopped || own) {
      for (const s of ours) await api("DELETE", sectionUrl(s));
      return stopped ? (ours.length ? "removed" : "none") : "own";
    }
    if (ours.length) {
      const [keep, ...extra] = ours;
      for (const s of extra) await api("DELETE", sectionUrl(s));
      if (keep.content !== SECTION_CONTENT || !truthy(keep.enabled) || keep.name !== SECTION_NAME) {
        await api("PATCH", sectionUrl(keep), { name: SECTION_NAME, content: SECTION_CONTENT, enabled: true });
        return "fixed";
      }
      return "kept";
    }
    // 새로 넣기: 자리를 먼저 계산(우리 섹션 없는 순서 기준)
    const byId = new Map(sections.map((s) => [s.id, s]));
    const groups = new Map((Array.isArray(full.groups) ? full.groups : []).map((g) => [g.id, g]));
    const groupOn = (gid) => { const g = groups.get(gid); return !g || truthy(g.enabled); };
    const order = (parseJson(full.preset?.sectionOrder, []) || []).filter((id) => byId.has(id));
    const { index, groupId } = placement(order, byId, groupOn);
    const created = await api("POST", `${presetUrl(presetId)}/sections`, {
      identifier: SECTION_IDENT, name: SECTION_NAME, content: SECTION_CONTENT, role: "system", enabled: true,
      isMarker: false, groupId, injectionPosition: "ordered",
    });
    if (created?.id) {
      const next = [...order];
      next.splice(Math.min(index, next.length), 0, created.id);
      await api("PUT", `${presetUrl(presetId)}/sections/reorder`, { sectionIds: next });
    }
    return "added";
  } catch (error) {
    if (error?.status === 409) { stockPresetIds.add(presetId); return "stock"; } // 기본 제공 프리셋은 수정 불가
    throw error;
  }
}

const LABEL = { added: "추가", kept: "들어 있음", fixed: "고침", own: "직접 넣은 {{기억}} 사용", stock: "기본 제공(건너뜀)", removed: "제거", none: "변경 없음", error: "실패" };

async function syncPresets(onlyNew = false) {
  const list = (await api("GET", "/api/prompts")) || [];
  const ids = (Array.isArray(list) ? list : []).map((p) => p?.id).filter(Boolean);
  const targets = onlyNew ? ids.filter((id) => !knownPresetIds.has(id)) : ids;
  knownPresetIds.clear();
  ids.forEach((id) => knownPresetIds.add(id));
  if (onlyNew && !targets.length) return {};
  const count = {};
  for (const preset of (Array.isArray(list) ? list : []).filter((p) => targets.includes(p?.id))) {
    const r = await syncPreset(preset.id).catch((e) => (log.warn(`프리셋 처리 실패: ${preset.name || preset.id}`, e), "error"));
    count[r] = (count[r] || 0) + 1;
  }
  const text = Object.entries(count).map(([k, n]) => `${LABEL[k] || k} ${n}`).join(" · ") || "프리셋 없음";
  lastPresetResult = onlyNew ? `새 프리셋 ${text}` : text;
  renderPanel();
  return count;
}

/* ---------- 방(마리나라 요약 끄기) ---------- */

function entriesOf(meta) {
  return (Array.isArray(meta.summaryEntries) ? meta.summaryEntries : [])
    .filter((e) => e && typeof e.id === "string")
    .map((e) => ({ id: e.id, enabled: e.enabled !== false }));
}
// 옛 형식(문자열 요약만 있는 방): 마리나라 chat-summary-entries.ts 의 fallbackId 와 같은 계산
function legacyId(content) {
  let hash = 2166136261;
  for (let i = 0; i < content.length; i += 1) { hash ^= content.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return `summary-legacy-${(hash >>> 0).toString(36)}`;
}
function summaryEntries(meta) {
  const list = entriesOf(meta);
  if (list.length) return list;
  const legacy = typeof meta.summary === "string" ? meta.summary.trim() : "";
  return legacy ? [{ id: legacyId(legacy), enabled: true }] : [];
}
const patchEntries = (id, body) => api("PATCH", `${chatUrl(id)}/summary-entries`, body);
const patchMeta = (id, patch) => api("PATCH", `${chatUrl(id)}/metadata`, patch);

async function saveRooms() {
  if (stopped) return;
  try { await marinara.storage.patch({ rooms: [...managed] }); } catch (e) { log.warn("저장 실패", e); }
}

async function apply(id) {
  const chat = await api("GET", chatUrl(id));
  if (!chat || (chat.mode && chat.mode !== "roleplay")) { skipped.add(id); return; }
  const meta = parseJson(chat.metadata, {}) || {};
  const prev = Array.isArray(meta[META_KEY]?.disabledIds) ? meta[META_KEY].disabledIds : [];
  const toDisable = summaryEntries(meta).filter((e) => e.enabled).map((e) => e.id);
  await patchMeta(id, { [META_KEY]: { disabledIds: [...new Set([...prev, ...toDisable])], at: new Date().toISOString() } });
  managed.add(id);
  await saveRooms();
  if (toDisable.length) await patchEntries(id, { operation: "toggle", entryIds: toDisable, enabled: false });
  log.info(`요약 끔: ${chat.name || id} (${toDisable.length}개)`);
}

async function restore(id) {
  const chat = await api("GET", chatUrl(id));
  if (!chat) { managed.delete(id); await saveRooms(); return; }
  const meta = parseJson(chat.metadata, {}) || {};
  const record = meta[META_KEY];
  const byId = new Map(summaryEntries(meta).map((e) => [e.id, e]));
  const back = [...new Set(Array.isArray(record?.disabledIds) ? record.disabledIds : [])]
    .filter((eid) => byId.has(eid) && !byId.get(eid).enabled);
  if (back.length) await patchEntries(id, { operation: "toggle", entryIds: back, enabled: true });
  if (record != null) await patchMeta(id, { [META_KEY]: null });
  managed.delete(id);
  await saveRooms();
  log.info(`요약 되살림: ${chat.name || id} (${back.length}개)`);
}

async function enabledRooms() {
  const status = await api("GET", "/api/memory-module/status");
  const chats = status?.settings?.chats;
  if (!chats || typeof chats !== "object") return null; // 기억 서재가 없거나 응답이 이상하면 아무것도 하지 않음
  return new Set(Object.entries(chats).filter(([, v]) => v?.enabled === true).map(([k]) => k));
}

async function syncRooms() {
  if (stopped) return;
  const enabled = await enabledRooms();
  if (!enabled || stopped) return;
  if (disableSummaries) {
    for (const id of enabled) {
      if (stopped) return;
      if (!managed.has(id) && !skipped.has(id)) await apply(id).catch((e) => log.warn(`요약 끄기 실패: ${id}`, e));
    }
  }
  for (const id of [...managed]) {
    if (stopped) return;
    if (!disableSummaries || !enabled.has(id)) await restore(id).catch((e) => log.warn(`되살리기 실패: ${id}`, e));
  }
}

const queue = (task) => (chain = chain.then(task).catch((e) => log.warn(e)));

/* ---------- 설정 화면 ---------- */

const ui = (() => {
  const style = document.createElement("style");
  style.textContent = `
.mlai-launch{position:fixed;right:16px;bottom:128px;z-index:60;width:36px;height:36px;border-radius:50%;
  border:1px solid var(--border,#8884);background:var(--card,#fff);color:var(--foreground,#222);display:grid;place-items:center;cursor:pointer;padding:0}
.mlai-launch svg{width:18px;height:18px}
.mlai-panel{position:fixed;right:16px;bottom:172px;z-index:61;width:min(340px,calc(100vw - 32px));max-height:calc(100vh - 200px);overflow:auto;
  background:var(--card,#fff);color:var(--foreground,#222);border:1px solid var(--border,#8884);border-radius:12px;padding:14px 16px;
  font-size:13px;line-height:1.55;box-shadow:0 8px 24px #0003}
.mlai-panel[hidden]{display:none}
.mlai-panel h3{margin:0 0 8px;font-size:14px}
.mlai-panel p{margin:6px 0;color:var(--muted-foreground,#666)}
.mlai-panel b{color:var(--foreground,#222)}
.mlai-panel label{display:flex;gap:8px;align-items:flex-start;margin:8px 0;color:var(--foreground,#222)}
.mlai-row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.mlai-row button{padding:5px 12px;border-radius:8px;border:1px solid var(--border,#8884);background:transparent;color:inherit;cursor:pointer}
.mlai-status{margin-top:8px;font-size:12px;color:var(--muted-foreground,#666)}`;
  document.head.appendChild(style);

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "mlai-launch";
  launcher.title = "기억 자동 주입";
  launcher.setAttribute("aria-label", "기억 자동 주입");
  launcher.setAttribute("data-drawer-launcher", "");
  launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 11h16M4 16h9"/><path d="M17 14v6M14.5 17.5 17 20l2.5-2.5"/></svg>';
  document.body.appendChild(launcher);

  const panel = document.createElement("div");
  panel.className = "mlai-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.innerHTML = `
<h3>기억 자동 주입</h3>
<p class="mlai-room"></p>
<p>모든 프리셋에 <b>📚 Memory</b> 섹션(<b>{{기억}}</b>)을 자동으로 넣습니다.</p>
<p>① Chat Summary·Chat History 마커 바로 위 (기억 서재 추천 위치)<br>② 마커가 없으면 앞쪽 시스템 프롬프트 끝<br>③ 그것도 없으면 맨 위</p>
<p>넣은 뒤 직접 옮긴 위치는 그대로 둡니다. 기억 서재가 꺼진 방에서는 비어서 빠집니다. 새로 만들거나 가져온 프리셋에는 그때 바로 넣습니다. 마리나라 기본 제공 프리셋은 수정할 수 없어 건너뜁니다.</p>
<label><input type="checkbox" class="mlai-sum"> <span>기억 서재가 켜진 방은 마리나라 채팅 요약 끄기<br><span style="color:var(--muted-foreground,#666)">같은 지난 이야기가 두 번 들어가는 것을 막습니다. 끄면 꺼 둔 요약을 다시 켭니다.</span></span></label>
<div class="mlai-row"><button type="button" class="mlai-recheck">프리셋 다시 확인</button><button type="button" class="mlai-close">닫기</button></div>
<div class="mlai-status"></div>`;
  document.body.appendChild(panel);
  return { style, launcher, panel };
})();

const $ = (sel) => ui.panel.querySelector(sel);
let lastChat = (() => { try { return localStorage.getItem("marinara-active-chat-id") || ""; } catch { return ""; } })();

async function renderPanel() {
  if (ui.panel.hidden) return;
  $(".mlai-sum").checked = disableSummaries;
  $(".mlai-status").textContent = lastPresetResult ? `프리셋: ${lastPresetResult}` : "";
  const id = lastChat;
  if (!id) { $(".mlai-room").textContent = "현재 방: 선택된 방 없음"; return; }
  let text = managed.has(id) ? "기억 사용 중 · 마리나라 요약 꺼 둠" : skipped.has(id) ? "롤플레이 방이 아니라 건너뜀" : "기억 서재 켜짐 여부 확인 전이거나 꺼짐";
  try {
    const chat = await api("GET", chatUrl(id));
    if (chat?.promptPresetId && stockPresetIds.has(chat.promptPresetId)) text += " · ⚠ 기본 제공 프리셋이라 기억이 들어가지 않아요";
  } catch {}
  $(".mlai-room").textContent = `현재 방: ${text}`;
}

ui.launcher.addEventListener("click", () => { ui.panel.hidden = !ui.panel.hidden; renderPanel(); });
$(".mlai-close").addEventListener("click", () => { ui.panel.hidden = true; });
$(".mlai-recheck").addEventListener("click", () => { $(".mlai-status").textContent = "확인하는 중…"; queue(() => syncPresets()); });
$(".mlai-sum").addEventListener("change", (e) => {
  const on = e.target.checked;
  queue(async () => {
    disableSummaries = on;
    await marinara.storage.patch({ disableSummaries: on });
    await syncRooms();
    renderPanel();
  });
});

/* ---------- 시작 ---------- */

queue(async () => {
  const saved = await marinara.storage.get().catch(() => ({}));
  if (typeof saved.disableSummaries === "boolean") disableSummaries = saved.disableSummaries;
  for (const id of Array.isArray(saved.rooms) ? saved.rooms : []) {
    // 지난번 끌 때 이미 되살린 방은 기록만 남아 있을 수 있으니 실제 방 상태로 확인
    try {
      const chat = await api("GET", chatUrl(id));
      if (chat && parseJson(chat.metadata, {})?.[META_KEY]) managed.add(id);
    } catch { managed.add(id); }
  }
  await saveRooms();
});
queue(() => syncPresets());
queue(syncRooms);

/* 마리나라 화면이 보내는 요청 중 '프리셋 생성·가져오기', '기억 켜기/끄기'가 끝났을 때만 반응한다. */
let debounceNew = 0, debounceRooms = 0;
const later = (timer, fn) => (marinara.clearTimeout(timer), marinara.setTimeout(fn, 1500));
const PRESET_CREATE = /^\/api\/(?:prompts\/?|prompts\/[^/]+\/duplicate|import\/.+)$/;
const MEMORY_TOGGLE = /^\/api\/memory-module\/chats\/[^/]+\/(?:enable|disable|start)$/;
const originalFetch = window.fetch;
let hookOn = true;
const hookedFetch = async function (input, init) {
  const res = await originalFetch.apply(this, arguments);
  if (!hookOn || !res.ok) return res;
  try {
    const method = String(init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    if (method !== "POST") return res;
    const path = new URL(typeof input === "string" ? input : input?.url || String(input), location.origin).pathname;
    if (PRESET_CREATE.test(path)) debounceNew = later(debounceNew, () => queue(() => syncPresets(true)));
    else if (MEMORY_TOGGLE.test(path)) debounceRooms = later(debounceRooms, () => { skipped.clear(); queue(syncRooms); });
  } catch {}
  return res;
};
window.fetch = hookedFetch;

marinara.setInterval(() => {
  let now = "";
  try { now = localStorage.getItem("marinara-active-chat-id") || ""; } catch {}
  if (now === lastChat) return;
  lastChat = now;
  skipped.delete(now);
  queue(syncRooms);
  renderPanel();
}, CHAT_KEY_POLL_MS);
const onVisible = () => { if (document.visibilityState === "visible") queue(syncRooms); };
document.addEventListener("visibilitychange", onVisible);

/* ---------- 끄기 ---------- */

marinara.onCleanup(async () => {
  document.removeEventListener("visibilitychange", onVisible);
  hookOn = false;
  if (window.fetch === hookedFetch) window.fetch = originalFetch; // 다른 확장이 그 위에 덧씌웠으면 그대로 두고 통과만 한다
  ui.launcher.remove(); ui.panel.remove(); ui.style.remove();
  await chain.catch(() => {});
  // 새로고침·업데이트로 다시 시작되는 경우엔 되돌리지 않는다. 정말 꺼졌을 때만 되돌린다.
  try {
    const list = await api("GET", "/api/personal-extensions/runtime/client");
    if (Array.isArray(list) && list.some((x) => x?.id === marinara.extension.id)) { stopped = true; return; }
  } catch { stopped = true; return; }
  stopped = true;
  for (const id of [...managed]) {
    try { await restore(id); } catch (e) { log.warn(`되살리기 실패: ${id}`, e); }
  }
  try { await syncPresets(); } catch (e) { log.warn("프리셋 정리 실패", e); } // stopped 상태라 넣은 섹션만 지운다
});
