// 工作区与会话中枢：为灵动岛提供「切换工作区 / 选择已有对话 / 新聊天」。
// 只读取 Harness 自己的注册表与控制器：workspaceRegistry、sessionController、sessionQuery。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_ROWS = 40;
const TITLE_CACHE = 120;
const STALE_MS = 15000;
const BLANK_TITLE = '新对话';

const normalize = value => String(value ?? '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

export class SessionHub {
  constructor(ctx, { dataDir, publish, seed, prefs }) {
    this.ctx = ctx;
    this.publish = publish;
    this.seed = seed;
    this.prefs = prefs;
    this.file = join(dataDir, 'hub.json');
    const saved = readJson(this.file) ?? {};
    this.workspaceId = typeof saved.workspaceId === 'string' ? saved.workspaceId : null;
    this.sessionId = typeof saved.sessionId === 'string' ? saved.sessionId : null;
    this.workspaces = [];
    this.summaries = [];
    this.rows = [];
    this.titles = new Map();
    this.preset = undefined;
    this.at = 0;
    this.version = 0;
    this.busy = null;
    this.note = '';
  }

  get enabled() { return this.prefs?.sessions !== false; }

  workspace() { return this.workspaces.find(w => w.id === this.workspaceId) ?? null; }

  titleOf(id) {
    const title = this.titles.get(id)?.title;
    return typeof title === 'string' && title.trim() ? title.trim() : BLANK_TITLE;
  }

  atOf(id) { return this.summaries.find(s => s.id === id)?.at ?? this.titles.get(id)?.at ?? 0; }
  runningOf(id) { return Boolean(this.summaries.find(s => s.id === id)?.running); }

  /** Refresh the workspace and session projection at most once per STALE_MS unless forced. */
  refresh(force = false) {
    if (!this.enabled) return Promise.resolve();
    const now = Date.now();
    if (!force && now - this.at < STALE_MS) return Promise.resolve();
    if (this.busy) return this.busy;
    this.busy = this.#load().finally(() => { this.busy = null; });
    return this.busy;
  }

  async #load() {
    try {
      const registry = this.ctx.get?.('workspaceRegistry');
      const controller = this.ctx.get?.('sessionController');
      const query = this.ctx.get?.('sessionQuery');
      const workspaces = (registry?.list?.() ?? []).map(w => ({
        id: String(w.id), title: String(w.title ?? ''), path: String(w.path ?? ''),
        members: new Set((Array.from(w.sessionIds ?? [])).map(String))
      }));
      this.workspaces = workspaces;
      if (!this.workspaceId || !workspaces.some(w => w.id === this.workspaceId)) this.workspaceId = workspaces[0]?.id ?? null;
      const listed = controller?.list ? await controller.list({}, AbortSignal.timeout(15000)) : null;
      const summaries = (listed?.items ?? [])
        .filter(s => s?.sessionId && s.origin !== 'subagent')
        .map(s => ({ id: String(s.sessionId), at: Number(s.updatedAt) || 0, running: Boolean(s.running), blank: Boolean(s.blank), cwd: typeof s.cwd === 'string' ? s.cwd : '' }));
      this.summaries = summaries;
      const ids = summaries.slice(0, TITLE_CACHE).map(s => s.id);
      if (query?.readTitleSnapshots && ids.length) {
        const results = await query.readTitleSnapshots(ids).catch(() => []);
        for (const result of results ?? []) {
          if (result?.status !== 'fulfilled') continue;
          const snapshot = result.value?.title;
          if (typeof snapshot?.title === 'string' && snapshot.title.trim()) this.titles.set(String(result.sessionId), { title: snapshot.title.trim(), at: Number(snapshot.updatedAt) || 0 });
        }
      }
      this.at = Date.now();
      this.version += 1;
      this.#rows();
    } catch (error) {
      this.note = `会话列表暂时读不到：${error?.message ?? error}`;
    }
  }

  #rows() {
    const ws = this.workspace();
    const owned = ws ? ws.members : new Set();
    const sameCwd = ws ? normalize(ws.path) : '';
    const rows = this.summaries
      .filter(s => !ws || owned.has(s.id) || (sameCwd && normalize(s.cwd) === sameCwd))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_ROWS)
      .map(s => ({ id: s.id, title: this.titleOf(s.id), at: s.at || this.titles.get(s.id)?.at || 0, running: s.running, blank: s.blank }));
    this.rows = rows;
  }

  /** Serializable projection for the island window. */
  view() {
    if (!this.enabled) return null;
    const details = this.prefs?.details !== false;
    const name = (value) => details ? value : '对话';
    const current = this.sessionId ? {
      id: this.sessionId,
      title: name(this.titleOf(this.sessionId)),
      at: this.atOf(this.sessionId),
      running: this.runningOf(this.sessionId)
    } : null;
    return {
      workspaces: this.workspaces.map(w => ({ id: w.id, title: details && w.title ? w.title : '工作区', path: details ? w.path : '' })),
      workspaceId: this.workspaceId,
      current,
      rows: this.rows.map(r => ({ id: r.id, title: name(r.title), at: r.at, running: r.running, blank: r.blank })),
      preset: this.preset ?? null,
      note: this.note,
      at: this.at
    };
  }

  #save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ workspaceId: this.workspaceId, sessionId: this.sessionId }, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch {}
  }

  async selectWorkspace(id) {
    const value = String(id ?? '');
    if (!this.workspaces.some(w => w.id === value)) return { ok: false, reason: '找不到这个工作区' };
    this.workspaceId = value;
    this.#save();
    await this.refresh(true);
    this.publish?.();
    return { ok: true, workspaceId: value };
  }

  async focus(sessionId) {
    const id = String(sessionId ?? '');
    if (!this.summaries.some(s => s.id === id)) return { ok: false, reason: '找不到这个对话，可能已归档' };
    this.sessionId = id;
    const owner = this.workspaces.find(w => w.members.has(id) || (w.path && normalize(w.path) === normalize(this.summaries.find(s => s.id === id)?.cwd)));
    if (owner) this.workspaceId = owner.id;
    this.#save();
    this.seed?.(id, { title: this.titleOf(id), running: this.runningOf(id) });
    this.publish?.();
    return { ok: true, sessionId: id };
  }

  /** The preset used by new chats: the roster's `standard`, else whatever the host calls 标准. */
  async standardPreset() {
    if (this.preset !== undefined) return this.preset;
    try {
      const roster = await this.ctx.get?.('agentPresets')?.list?.() ?? [];
      const hit = roster.find(p => String(p.id) === 'standard') ?? roster.find(p => /标准/.test(String(p.name ?? '')));
      this.preset = hit?.id ?? null;
    } catch { this.preset = null; }
    return this.preset;
  }

  async create() {
    const controller = this.ctx.get?.('sessionController');
    if (typeof controller?.create !== 'function') return { ok: false, reason: '当前 Harness 版本不支持新建会话' };
    const ws = this.workspace();
    const preset = await this.standardPreset();
    let value;
    try {
      value = await controller.create({ ...(ws ? { workspaceId: ws.id } : {}), ...(preset ? { agentPreset: preset } : {}) });
    } catch (error) {
      if (!ws) return { ok: false, reason: error?.message ?? '新建失败' };
      try { value = await controller.create({ cwd: ws.path, ...(preset ? { agentPreset: preset } : {}) }); }
      catch { return { ok: false, reason: error?.message ?? '新建失败' }; }
    }
    const id = String(value?.sessionId ?? '');
    if (!id) return { ok: false, reason: 'Harness 没有返回新会话' };
    this.sessionId = id;
    this.#save();
    this.seed?.(id, { title: BLANK_TITLE, running: false });
    await this.refresh(true);
    this.publish?.();
    return { ok: true, sessionId: id };
  }
}
