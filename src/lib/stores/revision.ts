import type { Cue, CueStatus, GlossaryTerm, TermRecheck } from "./subtitles";

/** 译员侧可以产生的状态；「已通过」只能由审校在当前术语下给出，永不接受回传 */
const TRANSLATOR_STATUSES: CueStatus[] = ["待译", "翻译中", "待审"];

/** 判定字幕是否引用某条术语：原文命中术语源词，且有版本戳或译文中出现过术语译法 */
export function cueReferencesTerm(cue: Cue, term: GlossaryTerm): boolean {
  if (!cue.source.includes(term.source)) return false;
  if (cue.termRevisions?.[term.id] !== undefined) return true;
  const translated = cue.translated.toLowerCase();
  return translated.includes(term.target.toLowerCase());
}

/** 引用判定：有版本戳，或译文中出现过新/旧任一译法；源语言轨（译文即原文）不参与术语译法联动 */
function references(cue: Cue, termId: string, source: string, targets: string[]): boolean {
  if (cue.translated === cue.source) return false;
  if (!cue.source.includes(source)) return false;
  if (cue.termRevisions?.[termId] !== undefined) return true;
  const translated = cue.translated.toLowerCase();
  return targets.some((target) => target.length > 0 && translated.includes(target.toLowerCase()));
}

export interface TermChangeResult {
  cues: Cue[];
  affectedIds: string[];
}

/**
 * 锁定术语译法变更：所有引用该术语的字幕（含审校已通过）一律转为「待复核」，
 * 并在字幕上记下具体是哪条术语、由什么旧译法改成什么新译法。
 */
export function applyTermTargetChange(cues: Cue[], prevTerm: GlossaryTerm, nextTerm: GlossaryTerm): TermChangeResult {
  const affectedIds: string[] = [];
  const nextCues = cues.map((cue) => {
    if (!references(cue, prevTerm.id, prevTerm.source, [prevTerm.target, nextTerm.target])) return cue;
    const recheck: TermRecheck = {
      termId: prevTerm.id,
      source: prevTerm.source,
      oldTarget: prevTerm.target,
      newTarget: nextTerm.target,
      termUpdatedAt: nextTerm.updatedAt,
      reason: `锁定术语「${prevTerm.source}」译法已由 ${prevTerm.target} 更新为 ${nextTerm.target}，引用字幕需重新确认`
    };
    affectedIds.push(cue.id);
    return {
      ...cue,
      status: "待复核" as CueStatus,
      termRechecks: [...(cue.termRechecks ?? []).filter((item) => item.termId !== prevTerm.id), recheck]
    };
  });
  return { cues: nextCues, affectedIds };
}

/**
 * 按当前术语表重算字幕的复核状态：凡是引用了已锁定术语、但译文依据的术语版本
 * 落后于当前版本的，都带着术语原因进入「待复核」。不会反向给出「已通过」。
 */
export function reconcileTermStatus(cue: Cue, terms: GlossaryTerm[]): { termRechecks: TermRecheck[]; status: CueStatus } {
  const pending: TermRecheck[] = [];
  for (const term of terms) {
    if (term.status !== "已锁定") continue;
    // 源语言轨（译文即原文）不随术语译法重新确认
    if (cue.translated === cue.source) continue;
    // 原文命中锁定术语：盖过当前版本戳才算已确认，缺戳或戳过期都要复核
    if (!cue.source.includes(term.source)) continue;
    const stampedAt = cue.termRevisions?.[term.id];
    if (stampedAt !== undefined && stampedAt >= term.updatedAt) continue;
    const prior = cue.termRechecks?.find((item) => item.termId === term.id);
    pending.push(prior ?? {
      termId: term.id,
      source: term.source,
      oldTarget: "",
      newTarget: term.target,
      termUpdatedAt: term.updatedAt,
      reason: `锁定术语「${term.source}」译法已更新为 ${term.target}，引用字幕需重新确认`
    });
  }
  if (pending.length) return { termRechecks: pending, status: "待复核" };
  return { termRechecks: [], status: cue.status };
}

/** 译员按新术语改好并提交审校时，给引用的锁定术语盖上当前版本戳，再重算复核状态 */
export function stampTermsOnSubmit(cue: Cue, terms: GlossaryTerm[]): Cue {
  const termRevisions = { ...(cue.termRevisions ?? {}) };
  for (const term of terms) {
    const hasPending = cue.termRechecks?.some((item) => item.termId === term.id) ?? false;
    // 提交即译员声明已按当前术语处理：原文命中的锁定术语、或本条待复核涉及的术语，一律盖当前版本戳
    if (term.status === "已锁定" && (cue.source.includes(term.source) || hasPending)) termRevisions[term.id] = term.updatedAt;
  }
  const stamped: Cue = { ...cue, termRevisions };
  const reconciled = reconcileTermStatus(stamped, terms);
  return {
    ...stamped,
    termRechecks: reconciled.termRechecks,
    status: reconciled.termRechecks.length ? "待复核" : "待审"
  };
}

export interface OfflineCuePatch {
  id: string;
  trackId?: string;
  start?: number;
  end?: number;
  source?: string;
  translated?: string;
  translator?: string;
  reviewerNote?: string;
  status?: CueStatus;
  baseVersion?: number;
  termRevisions?: Record<string, number>;
}

export interface OfflineMergeResult {
  cues: Cue[];
  merged: string[];
  skipped: string[];
  added: string[];
  forcedRecheck: string[];
}

function contentChanged(local: Cue, inc: OfflineCuePatch): boolean {
  return (inc.translated !== undefined && inc.translated !== local.translated)
    || (inc.source !== undefined && inc.source !== local.source)
    || (inc.start !== undefined && inc.start !== local.start)
    || (inc.end !== undefined && inc.end !== local.end);
}

/**
 * 合并译员离线贴回的校订结果：
 * - 译文只在离线条目的基线版本更新时覆盖（基线较新者为准），基线相同或更旧一律跳过；
 * - 审校状态、审校备注不接受回传，合并后按当前术语重算复核状态，过期的「已通过」盖不回来；
 * - 离线包里有、本地没有的字幕作为新条目加入，同样要过术语复核。
 */
export function mergeOfflineCues(local: Cue[], incoming: OfflineCuePatch[], terms: GlossaryTerm[]): OfflineMergeResult {
  const result: OfflineMergeResult = { cues: [], merged: [], skipped: [], added: [], forcedRecheck: [] };
  const localIds = new Set(local.map((cue) => cue.id));

  result.cues = local.map((cue) => {
    const inc = incoming.find((item) => item.id === cue.id);
    if (!inc) return cue;
    // 基线较新者为准：离线版本不新于本机基线，整段校订跳过，绝不覆盖
    if ((inc.baseVersion ?? 0) <= cue.baseVersion) {
      result.skipped.push(cue.id);
      return cue;
    }
    const merged: Cue = {
      ...cue,
      source: inc.source ?? cue.source,
      translated: inc.translated ?? cue.translated,
      start: inc.start ?? cue.start,
      end: inc.end ?? cue.end,
      translator: inc.translator ?? cue.translator,
      baseVersion: inc.baseVersion ?? cue.baseVersion,
      termRevisions: inc.termRevisions ?? cue.termRevisions
      // reviewerNote / status 不取离线包：审校意见与复核状态不接受回传
    };
    const rec = reconcileTermStatus(merged, terms);
    let status: CueStatus;
    if (rec.termRechecks.length) {
      status = "待复核";
      result.forcedRecheck.push(cue.id);
    } else if (contentChanged(cue, inc)) {
      status = "待审"; // 新译文必须重走审校，离线包里的「已通过」不作数
    } else {
      status = inc.status && TRANSLATOR_STATUSES.includes(inc.status) ? inc.status : cue.status;
    }
    result.merged.push(cue.id);
    return { ...merged, status, termRechecks: rec.termRechecks };
  });

  for (const inc of incoming) {
    if (localIds.has(inc.id)) continue;
    const base: Cue = {
      id: inc.id,
      trackId: inc.trackId ?? "",
      start: inc.start ?? 0,
      end: inc.end ?? Math.max(1, (inc.start ?? 0) + 2),
      source: inc.source ?? "",
      translated: inc.translated ?? "",
      status: "翻译中",
      translator: inc.translator ?? "离线译员",
      reviewerNote: "",
      baseVersion: inc.baseVersion ?? 1,
      termRevisions: inc.termRevisions ?? {}
    };
    const rec = reconcileTermStatus(base, terms);
    const status: CueStatus = rec.termRechecks.length
      ? "待复核"
      : inc.status && TRANSLATOR_STATUSES.includes(inc.status)
        ? inc.status
        : base.translated ? "待审" : "翻译中";
    result.cues.push({ ...base, status, termRechecks: rec.termRechecks });
    result.added.push(inc.id);
    if (rec.termRechecks.length) result.forcedRecheck.push(inc.id);
  }

  return result;
}

export interface SnapshotReevaluation {
  cueId: string;
  source: string;
  termId: string;
  termSource: string;
  oldTarget: string;
  newTarget: string;
}

/**
 * 冻结标版里的字幕保持当时状态不动；这里只对比标版冻结时的术语与当前术语，
 * 列出需要重新评估的条目。
 */
export function reevaluationsForSnapshot(
  snapshotCues: Cue[],
  frozenTerms: GlossaryTerm[],
  currentTerms: GlossaryTerm[]
): SnapshotReevaluation[] {
  const entries: SnapshotReevaluation[] = [];
  for (const cue of snapshotCues) {
    for (const term of currentTerms) {
      if (term.status !== "已锁定" || !cue.source.includes(term.source)) continue;
      const frozen = frozenTerms.find((item) => item.id === term.id);
      if (!frozen || frozen.target === term.target) continue;
      entries.push({
        cueId: cue.id,
        source: cue.source,
        termId: term.id,
        termSource: term.source,
        oldTarget: frozen.target,
        newTarget: term.target
      });
    }
  }
  return entries;
}
