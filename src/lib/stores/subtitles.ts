import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import {
  applyTermTargetChange,
  mergeOfflineCues,
  reevaluationsForSnapshot,
  stampTermsOnSubmit
} from "./revision";
import type { OfflineCuePatch, SnapshotReevaluation } from "./revision";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回" | "待复核";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

/** termId -> 该字幕译文当前依据的术语版本（updatedAt），落后于术语当前版本即需重新确认 */
export type TermRevisions = Record<string, number>;

export interface TermRecheck {
  termId: string;
  source: string;
  oldTarget: string;
  newTarget: string;
  termUpdatedAt: number;
  reason: string;
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
  /** 译文内容基线版本号，离线合并时以基线较新的一方为准 */
  baseVersion: number;
  termRevisions?: TermRevisions;
  termRechecks?: TermRecheck[];
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
  /** 术语译法当前版本时间戳，译法一更新即递增 */
  updatedAt: number;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定" | "术语更新" | "离线合并";
  detail: string;
  actor: string;
  time: string;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
  /** 冻结时的术语表，用于对照列出需要重新评估的条目 */
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

export interface OfflineBundle {
  exportedAt: string;
  translator: string;
  cues: OfflineCuePatch[];
}

const KEY = "pair-wise-yf-51/subtitles-v2";
// 术语种子固定版本戳，保证初始数据一致
const TERM_V0 = Date.parse("2026-09-20T09:00:00.000Z");
const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", baseVersion: 1 },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", baseVersion: 1, termRevisions: { g1: TERM_V0, g2: TERM_V0 } },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", baseVersion: 1, termRevisions: { g1: TERM_V0 } },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", baseVersion: 1 }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员", updatedAt: TERM_V0 },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员", updatedAt: TERM_V0 },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚", updatedAt: TERM_V0 }
];
const initial = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
export const tracks = writable<Track[]>(initial?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(initial?.cues ?? seedCues);
export const terms = writable<GlossaryTerm[]>(initial?.terms ?? seedTerms);
export const reviewEvents = writable<ReviewEvent[]>(initial?.events ?? []);
export const snapshots = writable<Snapshot[]>(initial?.snapshots ?? []);
export const conflicts = writable<TimelineConflict[]>([{ id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");
export const lastMergeReport = writable<string>("");

function persist() {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify({ tracks: get(tracks), cues: get(cues), terms: get(terms), events: get(reviewEvents), snapshots: get(snapshots) }));
}
[tracks, cues, terms, reviewEvents, snapshots].forEach((store) => store.subscribe(persist));

function appendEvent(cueId: string, action: ReviewEvent["action"], detail: string, actor?: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId, action, detail, actor: actor ?? get(reviewer), time: new Date().toISOString() }, ...items]);
}

const CONTENT_KEYS: (keyof Cue)[] = ["source", "translated", "start", "end"];

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  cues.update((items) => items.map((cue) => {
    if (cue.id !== id) return cue;
    const bumped = CONTENT_KEYS.some((key) => key in patch && patch[key] !== undefined && patch[key] !== cue[key]);
    return { ...cue, ...patch, baseVersion: bumped ? cue.baseVersion + 1 : cue.baseVersion };
  }));
  if (log) appendEvent(id, "退回修改", "编辑字幕内容或时间码");
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
  const first = { ...cue, end: middle, translated: `${cue.translated}`, status: "翻译中" as CueStatus };
  const second: Cue = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译" as CueStatus, baseVersion: cue.baseVersion + 1 };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : item));
  selectedCueId.set(second.id);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中", baseVersion: item.baseVersion + 1 } : item));
}

export function setCueStatus(id: string, status: CueStatus) {
  cues.update((items) => items.map((cue) => {
    if (cue.id !== id) return cue;
    // 提交审校 = 译员声明已按当前术语处理：盖版本戳，再由术语决定是否还要复核
    return status === "待审" ? stampTermsOnSubmit(cue, get(terms)) : { ...cue, status };
  }));
  const cue = get(cues).find((item) => item.id === id);
  if (status === "待审") {
    appendEvent(id, "提交审校", cue?.status === "待复核" ? "提交后仍有术语更新待复核" : (cue?.translated ?? ""));
  } else {
    appendEvent(id, status === "已通过" ? "审校通过" : "退回修改", cue?.translated ?? "");
  }
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  // 术语更新尚未重新确认的字幕不允许通过，避免「改了术语但照旧通过」
  if (approved && (cue.termRechecks?.length ?? 0) > 0) return;
  updateCue(id, { status: approved ? "已通过" : "退回", reviewerNote: note });
  appendEvent(id, approved ? "审校通过" : "退回修改", note || cue.translated);
}

export function lockTerm(id: string) {
  terms.update((items) => items.map((term) => term.id === id ? { ...term, status: "已锁定", owner: "术语管理员" } : term));
  const term = get(terms).find((item) => item.id === id);
  appendEvent(get(selectedCueId), "术语锁定", `${term?.source} → ${term?.target}`, "术语管理员");
}

/** 术语管理员修改锁定术语译法：引用该术语的字幕（含已通过）全部转「待复核」并写明原因 */
export function updateTermTarget(id: string, target: string) {
  const prevTerm = get(terms).find((item) => item.id === id);
  if (!prevTerm || prevTerm.target === target) return;
  const nextTerm: GlossaryTerm = { ...prevTerm, target, status: "已锁定", updatedAt: Date.now() };
  const { cues: nextCues, affectedIds } = applyTermTargetChange(get(cues), prevTerm, nextTerm);
  cues.set(nextCues);
  terms.update((items) => items.map((term) => term.id === id ? nextTerm : term));
  appendEvent("", "术语更新",
    `「${prevTerm.source}」译法 ${prevTerm.target} → ${target}，${affectedIds.length} 条引用字幕转为待复核：${affectedIds.join("、") || "无"}`,
    "术语管理员");
}

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  // 冻结标版：字幕与当时术语原样保留，后续术语变化不改动它
  snapshots.update((items) => [{
    id: crypto.randomUUID(),
    name,
    time: new Date().toISOString(),
    cues: structuredClone(get(cues)),
    terms: structuredClone(get(terms))
  }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (snapshot) cues.set(structuredClone(snapshot.cues));
}

/** 冻结标版不动，只返回其中需要按当前术语重新评估的条目 */
export function snapshotReevaluations(snapshot: Snapshot): SnapshotReevaluation[] {
  return reevaluationsForSnapshot(snapshot.cues, snapshot.terms, get(terms));
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  conflicts.update((items) => items.map((item) => item.id === id ? { ...item, status: resolution } : item));
  if (resolution === "采用协作版本") {
    const conflict = get(conflicts).find((item) => item.id === id);
    if (conflict) updateCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd });
  }
}

/** 译员离线前导出校订包 */
export function buildOfflineBundle(): OfflineBundle {
  return {
    exportedAt: new Date().toISOString(),
    translator: "林岚",
    cues: get(cues)
      .filter((cue) => cue.trackId !== "zh")
      .map((cue) => ({
        id: cue.id,
        trackId: cue.trackId,
        start: cue.start,
        end: cue.end,
        source: cue.source,
        translated: cue.translated,
        translator: cue.translator,
        status: cue.status,
        baseVersion: cue.baseVersion,
        termRevisions: cue.termRevisions
      }))
  };
}

export interface MergeReport {
  text: string;
  merged: string[];
  skipped: string[];
  added: string[];
  forcedRecheck: string[];
}

/**
 * 合并译员贴回的离线校订结果：
 * 译文按基线较新的版本为准；审校状态与备注不回传，复核状态按当前术语重算。
 */
export function mergeOfflineBundle(bundle: OfflineBundle): MergeReport {
  const result = mergeOfflineCues(get(cues), bundle.cues ?? [], get(terms));
  cues.set(result.cues);
  const text = `合并 ${bundle.translator} 的离线校订：采用 ${result.merged.length} 条，新增 ${result.added.length} 条，基线不新而跳过 ${result.skipped.length} 条，其中 ${result.forcedRecheck.length} 条因术语更新转待复核。`;
  lastMergeReport.set(text);
  appendEvent("", "离线合并", text, bundle.translator);
  return { text, ...result };
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));
