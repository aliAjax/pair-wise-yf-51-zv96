import assert from "node:assert/strict";
import {
  applyTermTargetChange,
  cueReferencesTerm,
  mergeOfflineCues,
  reevaluationsForSnapshot,
  reconcileTermStatus,
  stampTermsOnSubmit
} from "../src/lib/stores/revision";
import type { Cue, GlossaryTerm } from "../src/lib/stores/subtitles";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const T0 = 1000;
const T1 = 2000;
const termTide = (updatedAt: number, target = "tide"): GlossaryTerm => ({ id: "g1", source: "潮汐", target, status: "已锁定", owner: "术语管理员", updatedAt });
const mkCue = (patch: Partial<Cue> = {}): Cue => ({
  id: "c2", trackId: "en", start: 0, end: 2.8,
  source: "潮汐退去后，码头重新露出水面。",
  translated: "As the tide recedes, the pier emerges again.",
  status: "待审", translator: "林岚", reviewerNote: "", baseVersion: 1, ...patch
});

// 1. 引用判定
check("译文中含旧译法即视为引用", () => {
  assert.equal(cueReferencesTerm(mkCue(), termTide(T0)), true);
});
check("译文与版本戳都不命中则不引用", () => {
  const cue = mkCue({ translated: "nothing here" });
  assert.equal(cueReferencesTerm(cue, termTide(T0)), false);
});
check("有版本戳即算引用（即使译文已改掉词面）", () => {
  const cue = mkCue({ translated: "x", termRevisions: { g1: T0 } });
  assert.equal(cueReferencesTerm(cue, termTide(T0)), true);
});

// 2. 术语改译联动：待审、已通过都要重新确认，并写明原因
check("术语改译后，已通过字幕也转待复核并记录术语原因", () => {
  const approved = mkCue({ status: "已通过", reviewerNote: "之前通过" });
  const { cues: out, affectedIds } = applyTermTargetChange([approved], termTide(T0, "tide"), termTide(T1, "tidal bore"));
  assert.deepEqual(affectedIds, ["c2"]);
  assert.equal(out[0].status, "待复核");
  assert.equal(out[0].reviewerNote, "之前通过"); // 审校意见保留
  assert.equal(out[0].termRechecks?.[0].termId, "g1");
  assert.equal(out[0].termRechecks?.[0].oldTarget, "tide");
  assert.equal(out[0].termRechecks?.[0].newTarget, "tidal bore");
  assert.match(out[0].termRechecks?.[0].reason, /潮汐/);
});
check("不引用该术语的字幕不受影响", () => {
  const other = mkCue({ id: "x", source: "无关句子", translated: "unrelated", status: "已通过" });
  const { cues: out, affectedIds } = applyTermTargetChange([other], termTide(T0), termTide(T1, "tidal bore"));
  assert.deepEqual(affectedIds, []);
  assert.equal(out[0].status, "已通过");
});
check("源语言轨（译文即原文）不随译法更新翻案", () => {
  const sourceCue = mkCue({ trackId: "zh", translated: "潮汐退去后，码头重新露出水面。", status: "已通过" });
  const { cues: out, affectedIds } = applyTermTargetChange([sourceCue], termTide(T0), termTide(T1, "tidal bore"));
  assert.deepEqual(affectedIds, []);
  assert.equal(out[0].status, "已通过");
});

// 3. 译员按新术语改好并提交：盖章后复核清除
check("提交审校时按当前术语盖戳，待复核清除", () => {
  const { cues: out } = applyTermTargetChange([mkCue({ status: "已通过" })], termTide(T0), termTide(T1, "tidal bore"));
  const fixed = { ...out[0], translated: "As the tidal bore recedes, the pier emerges again." };
  const submitted = stampTermsOnSubmit(fixed, [termTide(T1, "tidal bore")]);
  assert.equal(submitted.status, "待审");
  assert.deepEqual(submitted.termRechecks, []);
  assert.equal(submitted.termRevisions.g1, T1);
});
check("译文没跟上新术语也能提交，但仍留待复核（版本戳已盖表示已阅）", () => {
  // 盖戳意味着译员声明依据当前术语；若确实没改，提交后版本戳=新版本，复核清除
  const { cues: out } = applyTermTargetChange([mkCue({ status: "已通过" })], termTide(T0), termTide(T1, "tidal bore"));
  const submitted = stampTermsOnSubmit(out[0], [termTide(T1, "tidal bore")]);
  assert.equal(submitted.termRevisions.g1, T1);
  assert.equal(submitted.status, "待审");
});

// 4. reconcile：离线合并后按当前术语重算
check("版本戳落后于术语当前版本时强制待复核", () => {
  const cue = mkCue({ status: "已通过", termRevisions: { g1: T0 } });
  const rec = reconcileTermStatus(cue, [termTide(T1, "tidal bore")]);
  assert.equal(rec.status, "待复核");
  assert.equal(rec.termRechecks[0].newTarget, "tidal bore");
});
check("版本戳已是最新时状态不动，不会凭空翻案", () => {
  const cue = mkCue({ status: "已通过", termRevisions: { g1: T1 } });
  const rec = reconcileTermStatus(cue, [termTide(T1, "tidal bore")]);
  assert.equal(rec.status, "已通过");
  assert.deepEqual(rec.termRechecks, []);
});
check("建议态（未锁定）术语不触发复核", () => {
  const cue = mkCue({ status: "待审" });
  const rec = reconcileTermStatus(cue, [{ ...termTide(T1), status: "建议" }]);
  assert.equal(rec.status, "待审");
});

// 5. 离线合并
const baseCue = mkCue({ status: "已通过", termRevisions: { g1: T0 }, reviewerNote: "审校意见保留" });

check("基线更新：采用离线新译文，但旧术语戳导致转待复核，回传的已通过盖不回来", () => {
  const inc = [{ id: "c2", translated: "As the tidal bore recedes ...", status: "已通过", baseVersion: 2, termRevisions: { g1: T0 } }];
  const r = mergeOfflineCues([baseCue], inc, [termTide(T1, "tidal bore")]);
  assert.deepEqual(r.merged, ["c2"]);
  assert.match(r.cues[0].translated, /tidal bore/);
  assert.equal(r.cues[0].baseVersion, 2);
  assert.equal(r.cues[0].status, "待复核");
  assert.deepEqual(r.forcedRecheck, ["c2"]);
  assert.equal(r.cues[0].reviewerNote, "审校意见保留"); // 备注不回传覆盖
});
check("基线相同：译文不被覆盖（避免贴回把本地改好的盖回去）", () => {
  const inc = [{ id: "c2", translated: "STALE OFFLINE TEXT", status: "已通过", baseVersion: 1 }];
  const r = mergeOfflineCues([baseCue], inc, [termTide(T0)]);
  assert.deepEqual(r.skipped, ["c2"]);
  assert.match(r.cues[0].translated, /pier emerges/);
  assert.equal(r.cues[0].status, "已通过");
});
check("基线更旧：整段跳过", () => {
  const inc = [{ id: "c2", translated: "OLD", baseVersion: 0 }];
  const r = mergeOfflineCues([baseCue], inc, [termTide(T0)]);
  assert.deepEqual(r.skipped, ["c2"]);
});
check("基线更新且术语已是最新：译文采用并重走待审，不接受回传的已通过", () => {
  const cue = mkCue({ status: "翻译中", baseVersion: 3, termRevisions: { g1: T1 } });
  const inc = [{ id: "c2", translated: "new translation", status: "已通过", baseVersion: 4, termRevisions: { g1: T1 } }];
  const r = mergeOfflineCues([cue], inc, [termTide(T1, "tidal bore")]);
  assert.equal(r.cues[0].status, "待审");
  assert.deepEqual(r.forcedRecheck, []);
});
check("离线包中的新字幕被加入，引用旧术语也要复核", () => {
  const inc = [{ id: "c9", trackId: "en", source: "潮水来了", translated: "the tide comes", status: "已通过", baseVersion: 1, termRevisions: {} }];
  const r = mergeOfflineCues([baseCue], inc, [{ ...termTide(T1, "tidal bore"), source: "潮水" }]);
  assert.deepEqual(r.added, ["c9"]);
  assert.equal(r.cues.find((c) => c.id === "c9")?.status, "待复核");
});

// 6. 冻结标版：内容不动，只列出需重新评估条目
check("快照按当时术语冻结，只输出待重新评估清单", () => {
  const frozenTerms = [termTide(T0, "tide")];
  const snapCues = [mkCue({ status: "已通过" })];
  const list = reevaluationsForSnapshot(snapCues, frozenTerms, [termTide(T1, "tidal bore")]);
  assert.equal(list.length, 1);
  assert.equal(list[0].cueId, "c2");
  assert.equal(list[0].oldTarget, "tide");
  assert.equal(list[0].newTarget, "tidal bore");
  // 快照字幕对象本身不被改动
  assert.equal(snapCues[0].status, "已通过");
});
check("标版后术语无变化则没有重新评估条目", () => {
  const frozenTerms = [termTide(T1, "tidal bore")];
  const list = reevaluationsForSnapshot([mkCue()], frozenTerms, [termTide(T1, "tidal bore")]);
  assert.deepEqual(list, []);
});

console.log(`\n全部通过：${passed} 项`);
