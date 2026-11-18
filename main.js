"use strict";

/**
 * 笔记（Notes）— PI-Desktop 插件主进程
 *
 * 视图：contributes.views[0] → views/index.html（右侧工作面板）
 * 数据：pi.plugin.getDataPath() 下的 notes.json + snapshots/ 自动快照
 *
 * 为什么用原生 node:fs：宿主的 pi.fs 网关拒绝一切落在 PI-Desktop 数据目录里的
 * 路径，而插件私有目录正在其中；同时便签需要无授权弹窗、无 scope 摩擦地连续写。
 * 因此这里只碰自己的数据目录：路径由 getDataPath() 给出，本文件不拼接任何其他
 * 位置，也不接受面板传来的路径参数——面板只能传来标题、正文和 id。
 *
 * 面板永远拿到的是副本：读接口不回传内部的活跃对象，写接口按 id 合并单条笔记，
 * 未知字段一律丢弃。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PLUGIN_ID = "io.github.g1oow.sidebar-note";
const VIEW_ID = "note";
const COMMAND_ID = "note.open";

const NOTES_FILE = "notes.json";
const SNAPSHOT_DIR = "snapshots";
const MAX_SNAPSHOTS = 5;
const MAX_NOTES = 5000;
const MAX_TITLE = 200;
const MAX_BODY = 200000;
const WRITE_DEBOUNCE_MS = 250;
const SNAPSHOT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const TRASH_TTL_MS = 60 * 1000;
const MAX_COPY_CHARS = 400000;

const SCOPES = new Set(["inbox", "project", "all"]);

let dataDir = null;
let store = { schema: 1, updatedAt: null, notes: [] };
let writeTimer = null;
let lastSnapshotAt = 0;
const trash = new Map();

// ── 小工具 ──────────────────────────────────────────────────────────────────

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function log(message) {
  console.log(`[${PLUGIN_ID}] ${message}`);
}

function nowIso() {
  return new Date().toISOString();
}

function clampText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\r\n?/g, "\n");
  return text.length > max ? text.slice(0, max) : text;
}

/** 工作区路径 → 稳定的项目键：小写入、正斜杠、去掉尾部分隔符。 */
function normalizeProjectKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return key === "/" ? "" : key;
}

/** 摘要展示用：去掉标题井号、列表符号、任务框、引用符与常见行内标记。 */
function plainLine(line) {
  return String(line || "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/\[([^\]]*)\]\([^)\s]+\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.*?)\1/g, "$2")
    .trim();
}

/** 摘要用的“可见行”：跳过代码围栏整段，其余行去掉标记后返回。 */
function visibleLines(text) {
  const out = [];
  let inFence = false;
  for (const line of String(text || "").split("\n")) {
    if (/^\s{0,3}(```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const plain = plainLine(line);
    if (plain) out.push(plain);
  }
  return out;
}

function firstLine(text) {
  const lines = visibleLines(text);
  return lines.length ? lines[0] : "";
}

function excerptOf(title, body) {
  const seen = new Set([plainLine(title)]);
  const parts = [];
  for (const plain of visibleLines(body)) {
    if (seen.has(plain)) continue;
    seen.add(plain);
    parts.push(plain);
    if (parts.join(" ").length > 160) break;
  }
  return parts.join(" ").slice(0, 160);
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

function notesFile() {
  return path.join(dataDir, NOTES_FILE);
}

function snapshotDir() {
  return path.join(dataDir, SNAPSHOT_DIR);
}

function sanitizeNote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : null;
  if (!id) return null;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  return {
    id,
    title: clampText(raw.title, MAX_TITLE),
    body: clampText(raw.body, MAX_BODY),
    projectKey: normalizeProjectKey(raw.projectKey),
    projectName: typeof raw.projectName === "string" ? raw.projectName.slice(0, 120) : "",
    pinned: raw.pinned === true,
    createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt,
  };
}

function normalizeStore(raw) {
  const notes = Array.isArray(raw?.notes) ? raw.notes.map(sanitizeNote).filter(Boolean) : [];
  return {
    schema: 1,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null,
    notes: notes.slice(0, MAX_NOTES),
  };
}

function readJson(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return null;
  return JSON.parse(text);
}

function listSnapshots() {
  try {
    return fs
      .readdirSync(snapshotDir())
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** notes.json 读不出来时退回最近一份可用快照，绝不静默清空用户笔记。 */
function restoreFromSnapshots() {
  for (const name of listSnapshots()) {
    try {
      const parsed = readJson(path.join(snapshotDir(), name));
      const restored = normalizeStore(parsed);
      log(`notes.json unreadable, restored ${restored.notes.length} note(s) from ${name}`);
      return restored;
    } catch {
      /* 换下一份 */
    }
  }
  return null;
}

function loadStore() {
  try {
    const parsed = readJson(notesFile());
    store = normalizeStore(parsed);
  } catch (error) {
    const restored = error?.code === "ENOENT" ? null : restoreFromSnapshots();
    store = restored || normalizeStore(null);
    if (!restored && error?.code !== "ENOENT") {
      log(`notes.json unreadable and no snapshot available: ${error?.message || error}`);
    }
  }
  if (store.notes.length) {
    const newest = store.notes.reduce(
      (latest, note) => (note.updatedAt > latest ? note.updatedAt : latest),
      store.notes[0].updatedAt,
    );
    lastSnapshotAt = Date.parse(newest) || 0;
  }
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeSnapshot(force) {
  const stamp = Date.now();
  if (!force && stamp - lastSnapshotAt < SNAPSHOT_MIN_INTERVAL_MS) return;
  try {
    fs.mkdirSync(snapshotDir(), { recursive: true });
    const name = `${new Date(stamp).toISOString().replace(/[:.]/g, "-")}.json`;
    atomicWrite(path.join(snapshotDir(), name), JSON.stringify(store, null, 2));
    lastSnapshotAt = stamp;
    const names = listSnapshots();
    for (const stale of names.slice(MAX_SNAPSHOTS)) {
      try {
        fs.unlinkSync(path.join(snapshotDir(), stale));
      } catch {
        /* 清理失败不影响保存 */
      }
    }
  } catch (error) {
    log(`snapshot failed: ${error?.message || error}`);
  }
}

function persistNow(options) {
  if (!dataDir) return;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (options?.snapshot !== false) writeSnapshot(options?.forceSnapshot === true);
    store.updatedAt = nowIso();
    atomicWrite(notesFile(), JSON.stringify(store, null, 2));
  } catch (error) {
    log(`save failed: ${error?.message || error}`);
    throw fail("UNSUPPORTED", `笔记保存失败：${error?.message || error}`);
  }
}

function schedulePersist() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      persistNow({});
    } catch {
      /* 已在 persistNow 里记日志 */
    }
  }, WRITE_DEBOUNCE_MS);
}

function flushPersist() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  persistNow({});
}

// ── 查询 ────────────────────────────────────────────────────────────────────

async function currentProject() {
  try {
    const workspace = await pi.workspace.get();
    if (!workspace || typeof workspace !== "object") return { key: "", name: "" };
    const roots = Array.isArray(workspace.roots) ? workspace.roots : [];
    const primary = roots.find((root) => root && root.primary === true && typeof root.path === "string");
    const rawPath = primary?.path || workspace.path || "";
    const name =
      (typeof workspace.name === "string" && workspace.name) ||
      (rawPath ? path.basename(String(rawPath).replace(/[\\/]+$/, "")) : "");
    return { key: normalizeProjectKey(rawPath), name };
  } catch {
    return { key: "", name: "" };
  }
}

function findNote(id) {
  return store.notes.find((note) => note.id === id) || null;
}

function matchesQuery(note, needle) {
  if (!needle) return true;
  return (
    note.title.toLowerCase().includes(needle) || note.body.toLowerCase().includes(needle)
  );
}

function metaOf(note) {
  return {
    id: note.id,
    title: note.title,
    displayTitle: note.title.trim() || firstLine(note.body) || "",
    excerpt: excerptOf(note.title, note.body),
    projectKey: note.projectKey,
    projectName: note.projectName,
    pinned: note.pinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    size: note.body.length,
  };
}

function sortNotes(notes) {
  return notes.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
}

function projectIndex() {
  const byKey = new Map();
  for (const note of store.notes) {
    if (!note.projectKey) continue;
    const entry = byKey.get(note.projectKey) || {
      key: note.projectKey,
      name: note.projectName || note.projectKey,
      count: 0,
    };
    entry.count += 1;
    if (!entry.name && note.projectName) entry.name = note.projectName;
    byKey.set(note.projectKey, entry);
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listNotes(payload) {
  const scope = SCOPES.has(payload?.scope) ? payload.scope : "project";
  const query = typeof payload?.query === "string" ? payload.query.trim().toLowerCase() : "";
  const project = await currentProject();
  const effectiveScope = scope === "project" && !project.key ? "inbox" : scope;

  let pool;
  if (effectiveScope === "inbox") pool = store.notes.filter((note) => !note.projectKey);
  else if (effectiveScope === "project") pool = store.notes.filter((note) => note.projectKey === project.key);
  else pool = store.notes;

  const items = sortNotes(pool.filter((note) => matchesQuery(note, query))).map(metaOf);
  const counts = {
    inbox: store.notes.filter((note) => !note.projectKey).length,
    project: project.key
      ? store.notes.filter((note) => note.projectKey === project.key).length
      : 0,
    all: store.notes.length,
  };

  return {
    scope: effectiveScope,
    requestedScope: scope,
    query,
    items,
    counts,
    project,
    hasProject: Boolean(project.key),
    projects: projectIndex(),
    limits: { notes: MAX_NOTES, title: MAX_TITLE, body: MAX_BODY, total: store.notes.length },
  };
}

function readNote(payload) {
  const note = findNote(String(payload?.id || ""));
  if (!note) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  return { note: { ...note } };
}

async function createNote(payload) {
  if (store.notes.length >= MAX_NOTES) {
    throw fail("LIMIT_EXCEEDED", `笔记数量已达上限（${MAX_NOTES} 条）。`);
  }
  const scope = SCOPES.has(payload?.scope) ? payload.scope : "project";
  const project = scope === "inbox" ? { key: "", name: "" } : await currentProject();
  const stamp = nowIso();
  const note = {
    id: crypto.randomUUID(),
    title: clampText(payload?.title, MAX_TITLE),
    body: clampText(payload?.body, MAX_BODY),
    projectKey: project.key,
    projectName: project.name,
    pinned: false,
    createdAt: stamp,
    updatedAt: stamp,
  };
  store.notes.unshift(note);
  schedulePersist();
  return { note: { ...note } };
}

function saveNote(payload) {
  const note = findNote(String(payload?.id || ""));
  if (!note) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  const title = clampText(payload?.title, MAX_TITLE);
  const body = clampText(payload?.body, MAX_BODY);
  if (title === note.title && body === note.body) {
    return { id: note.id, updatedAt: note.updatedAt, unchanged: true };
  }
  note.title = title;
  note.body = body;
  note.updatedAt = nowIso();
  schedulePersist();
  return {
    id: note.id,
    updatedAt: note.updatedAt,
    unchanged: false,
    meta: metaOf(note),
  };
}

function pinNote(payload) {
  const note = findNote(String(payload?.id || ""));
  if (!note) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  note.pinned = payload?.pinned === true;
  note.updatedAt = nowIso();
  schedulePersist();
  return { id: note.id, pinned: note.pinned, updatedAt: note.updatedAt, meta: metaOf(note) };
}

function deleteNote(payload) {
  const id = String(payload?.id || "");
  const index = store.notes.findIndex((note) => note.id === id);
  if (index < 0) throw fail("NOT_FOUND", "这条笔记不存在或已被删除。");
  const [note] = store.notes.splice(index, 1);
  trash.set(id, { note, at: Date.now() });
  schedulePersist();
  return { id, meta: metaOf(note) };
}

function undoDelete(payload) {
  const id = String(payload?.id || "");
  const entry = trash.get(id);
  if (!entry) throw fail("NOT_FOUND", "没有可撤销的删除。");
  if (Date.now() - entry.at > TRASH_TTL_MS) {
    trash.delete(id);
    throw fail("TIMEOUT", "撤销窗口已过期。");
  }
  trash.delete(id);
  store.notes.push(entry.note);
  entry.note.updatedAt = nowIso();
  schedulePersist();
  return { id, meta: metaOf(entry.note) };
}

async function copyText(payload) {
  const text = clampText(payload?.text, MAX_COPY_CHARS);
  if (!text) throw fail("INVALID_ARGUMENT", "没有可复制的内容。");
  await pi.clipboard.writeText(text);
  return { copied: text.length };
}

async function onPanelInvoke(channel, payload) {
  try {
    switch (channel) {
      case "note:list":
        return await listNotes(payload);
      case "note:read":
        return readNote(payload);
      case "note:create":
        return await createNote(payload);
      case "note:save":
        return saveNote(payload);
      case "note:pin":
        return pinNote(payload);
      case "note:delete":
        return deleteNote(payload);
      case "note:undoDelete":
        return undoDelete(payload);
      case "note:copy":
        return await copyText(payload);
      default:
        throw fail("UNSUPPORTED", `未知通道：${String(channel)}`);
    }
  } catch (error) {
    log(`panel call ${String(channel)} failed: ${error?.code || ""} ${error?.message || error}`);
    throw error;
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

function commandTitle(locale) {
  return String(locale || "").toLowerCase().startsWith("zh") ? "笔记：打开笔记" : "Notes: Open notes";
}

async function openView() {
  try {
    await pi.ui.revealView({ viewId: VIEW_ID });
  } catch (error) {
    await pi.ui.showToast(
      error?.message || "无法打开笔记：请先打开一个会话，再从工作面板的“新建”菜单里选择“笔记”。",
      "warn",
    );
  }
}

async function onLoad() {
  try {
    dataDir = await pi.plugin.getDataPath();
    fs.mkdirSync(dataDir, { recursive: true });
    loadStore();
  } catch (error) {
    dataDir = null;
    log(`data directory unavailable: ${error?.message || error}`);
  }

  let locale = "en";
  try {
    locale = await pi.app.getLocale();
  } catch {
    /* 保持英文 */
  }

  await pi.commands.register({
    id: COMMAND_ID,
    title: commandTitle(locale),
    keywords: ["note", "notes", "笔记", "memo"],
    run: openView,
  });
}

function onUnload() {
  try {
    flushPersist();
  } catch {
    /* unload 是尽力而为，失败已记日志 */
  }
  trash.clear();
  try {
    pi.commands.unregister(COMMAND_ID);
  } catch {
    /* 宿主卸载时会自行清理 */
  }
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
};