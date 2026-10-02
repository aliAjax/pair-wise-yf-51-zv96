import assert from "node:assert/strict";
import * as store from "../src/lib/stores/subtitles";
import { get } from "svelte/store";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const find = (id: string) => get(store.cues).find((c) => c.id === id)!;
const findTerm = (id: string) => get(store.terms).find((t) => t.id === id)!;

check("初始状态：c2 待审、无待复核标记", () => {
  assert.equal(find("c2").status, "待审");
  assert.equal(find("c2").termRechecks, undefined);
});

check("术语管理员改锁定术语译法后，c2 转待复核并写明由 g1 引起；原语言轨 c1 不动", () => {
  store.updateTermTarget("g1", "tidal bore");
  const c2 = find("c2");
  assert.equal(c2.status, "待复核");
  assert.equal(c2.termRechecks?.[0].termId, "g1");
  assert.equal(c2.termRechecks?.[0].oldTarget, "tide");
  assert.equal(c2.termRechecks?.[0].newTarget, "tidal bore");
  assert.equal(find("c1").status, "已通过");
});

check("待复核期间审校通过被拒绝", () => {
  store.reviewCue("c2", true);
  assert.equal(find("c2").status, "待复核");
});

check("译员改好译文并提交：标记清除、进入待审、术语戳更新", () => {
  const g1At = findTerm("g1").updatedAt;
  store.updateCue("c2", { translated: "As the tidal bore recedes, the pier emerges again." });
  store.setCueStatus("c2", "待审");
  const c2 = find("c2");
  assert.equal(c2.status, "待审");
  assert.deepEqual(c2.termRechecks, []);
  assert.equal(c2.termRevisions?.g1, g1At);
});

check("审校通过后再次改同一术语，已通过的也被打回待复核", () => {
  store.reviewCue("c2", true);
  assert.equal(find("c2").status, "已通过");
  store.updateTermTarget("g1", "tidal current");
  assert.equal(find("c2").status, "待复核");
  assert.equal(find("c2").termRechecks?.[0].newTarget, "tidal current");
});

check("快照在改译前冻结：快照内字幕保持已通过，只列出待重新评估条目", () => {
  // 先恢复到已通过态再造一个干净快照
  store.updateCue("c2", { translated: "As the tidal current recedes, the pier emerges again." });
  store.setCueStatus("c2", "待审");
  store.reviewCue("c2", true);
  store.createSnapshot("冻结标版 A");
  const snap = get(store.snapshots)[0];
  const frozenC2 = snap.cues.find((c) => c.id === "c2")!;
  assert.equal(frozenC2.status, "已通过");
  assert.equal(snap.terms.find((t) => t.id === "g1")!.target, "tidal current");
  // 之后术语再变
  store.updateTermTarget("g1", "tide surge");
  // 快照内字幕仍是冻结时状态
  assert.equal(get(store.snapshots)[0].cues.find((c) => c.id === "c2")!.status, "已通过");
  const list = store.snapshotReevaluations(get(store.snapshots)[0]);
  const hit = list.find((e) => e.cueId === "c2" && e.termId === "g1");
  assert.ok(hit);
  assert.equal(hit!.oldTarget, "tidal current");
  assert.equal(hit!.newTarget, "tide surge");
});

check("离线包基线相同：贴回不覆盖本机译文/状态", () => {
  const localText = find("c2").translated;
  const localVersion = find("c2").baseVersion;
  const report = store.mergeOfflineBundle({
    exportedAt: new Date().toISOString(),
    translator: "林岚（离线）",
    cues: [{ id: "c2", translated: "STALE", status: "已通过", baseVersion: localVersion }]
  });
  assert.deepEqual(report.skipped, ["c2"]);
  assert.deepEqual(report.merged, []);
  assert.equal(find("c2").translated, localText);
  assert.equal(find("c2").status, "待复核"); // 术语引起的复核不被盖掉
});

check("离线包基线更新：采用新译文，夹带的已通过无效；术语戳旧 → 待复核；审校备注不回传", () => {
  const c2 = find("c2");
  store.reviewCue("c2", false, "术语再核"); // 本机有审校备注
  const noteBefore = find("c2").reviewerNote;
  const report = store.mergeOfflineBundle({
    exportedAt: new Date().toISOString(),
    translator: "林岚（离线）",
    cues: [{
      id: "c2",
      trackId: "en",
      start: c2.start, end: c2.end, source: c2.source,
      translated: "Offline newer translation with tide surge.",
      translator: "林岚",
      status: "已通过",
      baseVersion: c2.baseVersion + 1,
      termRevisions: c2.termRevisions
    }]
  });
  assert.deepEqual(report.merged, ["c2"]);
  assert.match(find("c2").translated, /Offline newer/);
  assert.equal(find("c2").status, "待复核");
  assert.deepEqual(find("c2").termRechecks?.[0] ? ["g1"] : [], ["g1"]);
  assert.equal(find("c2").reviewerNote, noteBefore);
});

check("离线译文术语戳是最新时：合并后待审，不接受回传的已通过", () => {
  const c2 = find("c2");
  const g1At = findTerm("g1").updatedAt;
  const report = store.mergeOfflineBundle({
    exportedAt: new Date().toISOString(),
    translator: "林岚（离线）",
    cues: [{
      id: "c2", trackId: "en", start: c2.start, end: c2.end, source: c2.source,
      translated: "Fresh offline text aligned with glossary.",
      translator: "林岚", status: "已通过",
      baseVersion: c2.baseVersion + 1,
      termRevisions: { ...c2.termRevisions, g1: g1At }
    }]
  });
  assert.deepEqual(report.forcedRecheck, []);
  assert.equal(find("c2").status, "待审");
});

console.log(`\n端到端全部通过：${passed} 项`);
