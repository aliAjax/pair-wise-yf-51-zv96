import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回" | "待重审";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
  /** 基线版本时间戳：离线合并时以较新的译文为准 */
  baselineAt: number;
  /** 需重新确认的术语 ID（术语译法变更后，引用旧用法的字幕挂起） */
  pendingTermIds: string[];
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定" | "术语译法更新" | "离线合并";
  detail: string;
  actor: string;
  time: string;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
  /** 冻结标版：按当时术语留着，不随后续术语译法变动 */
  terms: GlossaryTerm[];
}

export interface TimelineConflict {
  id: string;
  cueId: string;
  message: string;
  remoteStart: number;
  remoteEnd: number;
  status: "待处理" | "采用本地" | "采用协作版本";
}

const KEY = "pair-wise-yf-51/subtitles-v1";
const SEED_AT = Date.now();
const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", baselineAt: SEED_AT, pendingTermIds: [] },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", baselineAt: SEED_AT, pendingTermIds: [] },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", baselineAt: SEED_AT, pendingTermIds: [] },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", baselineAt: SEED_AT, pendingTermIds: [] }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];

interface PersistShape {
  tracks?: Track[];
  cues?: Partial<Cue>[];
  terms?: GlossaryTerm[];
  events?: ReviewEvent[];
  snapshots?: Partial<Snapshot>[];
}

function migrate(raw: PersistShape | null) {
  if (!raw) return null;
  const cues: Cue[] = ((raw.cues ?? seedCues) as Cue[]).map((cue) => ({ ...cue, baselineAt: cue.baselineAt ?? SEED_AT, pendingTermIds: cue.pendingTermIds ?? [] }));
  const snapshots: Snapshot[] = ((raw.snapshots ?? []) as Snapshot[]).map((snap) => ({ ...snap, terms: snap.terms ?? (raw.terms ?? seedTerms) }));
  return {
    tracks: raw.tracks ?? seedTracks,
    cues,
    terms: raw.terms ?? seedTerms,
    events: raw.events ?? [],
    snapshots
  };
}

const initial = browser && localStorage.getItem(KEY) ? migrate(JSON.parse(localStorage.getItem(KEY)!)) : null;
export const tracks = writable<Track[]>(initial?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(initial?.cues ?? seedCues);
export const terms = writable<GlossaryTerm[]>(initial?.terms ?? seedTerms);
export const reviewEvents = writable<ReviewEvent[]>(initial?.events ?? []);
export const snapshots = writable<Snapshot[]>(initial?.snapshots ?? []);
export const conflicts = writable<TimelineConflict[]>([{ id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");

function persist() {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify({ tracks: get(tracks), cues: get(cues), terms: get(terms), events: get(reviewEvents), snapshots: get(snapshots) }));
}
[tracks, cues, terms, reviewEvents, snapshots].forEach((store) => store.subscribe(persist));

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: get(reviewer), time: new Date().toISOString() }, ...items]);
}

const now = () => Date.now();

/** 判断字幕是否仍未采用术语当前译法（原文引用了术语、译文非空且与原文不同、但未包含当前目标译法） */
function isPendingTerm(cue: Cue, term: GlossaryTerm): boolean {
  const text = cue.translated.trim();
  return text !== "" && text !== cue.source.trim() && cue.source.includes(term.source) && !text.includes(term.target);
}

/** 重算字幕的术语挂起列表：引用了术语但译文未采用当前译法的术语 */
function recomputeFlags(cue: Cue, list: GlossaryTerm[]): string[] {
  return list.filter((term) => isPendingTerm(cue, term)).map((term) => term.id);
}

export function termName(id: string): string {
  return get(terms).find((term) => term.id === id)?.source ?? id;
}

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  cues.update((items) => items.map((cue) => {
    if (cue.id !== id) return cue;
    const next = { ...cue, ...patch };
    if (patch.translated !== undefined || patch.source !== undefined) next.baselineAt = now();
    if (patch.translated !== undefined) {
      next.pendingTermIds = recomputeFlags(next, get(terms));
      if (next.pendingTermIds.length === 0 && cue.status === "待重审") next.status = "待审";
      else if (next.pendingTermIds.length > 0) next.status = "待重审";
    }
    return next;
  }));
  if (log) event(get(cues).find((cue) => cue.id === id), "退回修改", "编辑字幕内容或时间码");
}

export function nudgeCue(id: string, delta: number) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { start: Math.max(0, Number((cue.start + delta).toFixed(1))), end: Math.max(cue.start + 0.5, Number((cue.end + delta).toFixed(1))) });
}

export function splitCue(id: string) {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue || cue.end - cue.start < 1) return;
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  const first = { ...cue, end: middle, translated: `${cue.translated}`, status: "翻译中" as CueStatus, baselineAt: now(), pendingTermIds: [] };
  const second = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译" as CueStatus, baselineAt: now(), pendingTermIds: [] };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : [item]));
  selectedCueId.set(second.id);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中", baselineAt: now(), pendingTermIds: recomputeFlags({ ...item, translated: `${item.translated} ${next.translated}`.trim() }, get(terms)) } : item));
}

export function setCueStatus(id: string, status: CueStatus) {
  updateCue(id, { status });
  const cue = get(cues).find((item) => item.id === id);
  event(cue, status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", cue?.translated ?? "");
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { status: approved ? "已通过" : "退回", reviewerNote: note, pendingTermIds: approved ? [] : cue.pendingTermIds });
  event(cue, approved ? "审校通过" : "退回修改", note || cue.translated);
}

export function lockTerm(id: string) {
  terms.update((items) => items.map((term) => term.id === id ? { ...term, status: "已锁定", owner: "术语管理员" } : term));
  const term = get(terms).find((item) => item.id === id);
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  event(cue, "术语锁定", `${term?.source} → ${term?.target}`);
}

/** 术语译法更新：引用该术语的字幕（含已通过的）一律挂起重新确认，并写清由哪条术语引起 */
export function updateTermTarget(id: string, target: string) {
  const term = get(terms).find((item) => item.id === id);
  const nextTarget = target.trim();
  if (!term || nextTarget === "" || nextTarget === term.target) return;
  const oldTarget = term.target;
  terms.update((items) => items.map((item) => item.id === id ? { ...item, target: nextTarget } : item));
  const updated = get(terms).find((item) => item.id === id)!;
  const affected = get(cues).filter((cue) => cue.translated.includes(oldTarget) || isPendingTerm(cue, updated));
  if (affected.length) {
    cues.update((items) => items.map((cue) => {
      if (!affected.some((item) => item.id === cue.id)) return cue;
      const pending = Array.from(new Set([...cue.pendingTermIds, term.id]));
      return { ...cue, status: "待重审" as CueStatus, pendingTermIds: pending };
    }));
    for (const cue of affected) {
      event(cue, "术语译法更新", `术语「${term.source}」译法 ${oldTarget} → ${nextTarget}，引用旧用法，需重新确认`);
    }
  } else {
    event(undefined, "术语译法更新", `术语「${term.source}」译法 ${oldTarget} → ${nextTarget}，暂无字幕引用旧用法`);
  }
}

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  snapshots.update((items) => [{ id: crypto.randomUUID(), name, time: new Date().toISOString(), cues: structuredClone(get(cues)), terms: structuredClone(get(terms)) }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (snapshot) cues.set(structuredClone(snapshot.cues));
}

/** 冻结标版按当时术语留着；只列出因术语译法变更而需要重新评估的条目 */
export function snapshotReeval(snapshot: Snapshot, list: GlossaryTerm[] = get(terms)): { cue: Cue; term: GlossaryTerm; frozen: string; current: string }[] {
  const out: { cue: Cue; term: GlossaryTerm; frozen: string; current: string }[] = [];
  for (const cue of snapshot.cues) {
    for (const term of snapshot.terms) {
      const cur = list.find((item) => item.id === term.id);
      if (!cur || cur.target === term.target) continue;
      if (cue.source.includes(term.source) || cue.translated.includes(term.target) || cue.translated.includes(cur.target)) {
        out.push({ cue, term, frozen: term.target, current: cur.target });
      }
    }
  }
  return out;
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  conflicts.update((items) => items.map((item) => item.id === id ? { ...item, status: resolution } : item));
  if (resolution === "采用协作版本") {
    const conflict = get(conflicts).find((item) => item.id === id);
    if (conflict) updateCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd });
  }
}

export interface MergeResult {
  merged: number;
  kept: number;
  flagged: number;
  added: number;
}

/** 导出当前基线（供译员离线校订后回传） */
export function exportBaseline(): string {
  return JSON.stringify(get(cues).map((cue) => ({ id: cue.id, trackId: cue.trackId, source: cue.source, translated: cue.translated, status: cue.status, baselineAt: cue.baselineAt })), null, 2);
}

/**
 * 离线校订结果合并：
 * - 译文按基线较新的版本为准（baselineAt 较大者胜）
 * - 复核状态跟着术语走：术语未清零则强制待重审，回传不得盖回通过
 */
export function mergeOffline(raw: string): MergeResult | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "无法解析粘贴内容，请确认是离线校订的 JSON。" };
  }
  const remoteList = Array.isArray(parsed) ? parsed : (parsed as { cues?: unknown })?.cues;
  if (!Array.isArray(remoteList)) return { error: "粘贴内容缺少字幕数组（应为 JSON 数组或 { cues: [...] }）。" };
  const termsNow = get(terms);
  const local = get(cues);
  const remoteById = new Map<string, Record<string, unknown>>();
  for (const item of remoteList as unknown[]) {
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") remoteById.set((item as { id: string }).id, item as Record<string, unknown>);
  }
  let merged = 0;
  let kept = 0;
  let flagged = 0;
  let added = 0;
  const next: Cue[] = local.map((cue) => {
    const remote = remoteById.get(cue.id);
    if (!remote) return cue;
    const remoteAt = Number(remote.baselineAt ?? remote.updatedAt ?? 0);
    const remoteNewer = remoteAt >= cue.baselineAt;
    const translated = remoteNewer && typeof remote.translated === "string" ? remote.translated : cue.translated;
    const mergedCue: Cue = { ...cue, translated, baselineAt: remoteNewer ? remoteAt : cue.baselineAt };
    const pending = recomputeFlags(mergedCue, termsNow);
    let status: CueStatus;
    if (pending.length) {
      status = "待重审";
      flagged++;
    } else if (cue.status === "待重审") {
      status = "待审";
    } else if (remoteNewer) {
      status = (remote.status as CueStatus) === "已通过" ? "待审" : ((remote.status as CueStatus) ?? cue.status);
      merged++;
    } else {
      status = cue.status;
      kept++;
    }
    return { ...mergedCue, status, pendingTermIds: pending };
  });
  for (const item of remoteList as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || local.some((cue) => cue.id === r.id)) continue;
    const seed: Cue = {
      id: r.id,
      trackId: typeof r.trackId === "string" ? r.trackId : get(activeTrackId),
      start: Number(r.start ?? 0),
      end: Number(r.end ?? 2.5),
      source: typeof r.source === "string" ? r.source : "",
      translated: typeof r.translated === "string" ? r.translated : "",
      status: "翻译中",
      translator: "离线回传",
      reviewerNote: "",
      baselineAt: Number(r.baselineAt ?? now()),
      pendingTermIds: []
    };
    seed.pendingTermIds = recomputeFlags(seed, termsNow);
    if (seed.pendingTermIds.length) {
      seed.status = "待重审";
      flagged++;
    }
    next.push(seed);
    added++;
  }
  cues.set(next);
  event(undefined, "离线合并", `回传 ${remoteList.length} 条：${merged} 条取较新译文，${flagged} 条需重新确认，${kept} 条保留本地${added ? `，新增 ${added} 条` : ""}`);
  return { merged, kept, flagged, added };
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));
