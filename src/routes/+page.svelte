<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import { activeCues, activeTrackId, conflicts, createSnapshot, cues, exportBaseline, lockTerm, mergeNext, mergeOffline, nudgeCue, resolveConflict, restoreSnapshot, reviewCue, reviewEvents, reviewer, selectedCueId, setCueStatus, snapshots, snapshotReeval, splitCue, termName, terms, tracks, updateCue, updateTermTarget } from "$lib/stores/subtitles";
  import type { Cue, MergeResult } from "$lib/stores/subtitles";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const item: Cue = { id: crypto.randomUUID(), trackId: $activeTrackId, start, end: start + Number(formData.get("duration") ?? 2.5), source: String(formData.get("source") ?? ""), translated: String(formData.get("translated") ?? ""), status: "翻译中", translator: "当前译者", reviewerNote: "", baselineAt: Date.now(), pendingTermIds: [] };
      cues.update((items) => [...items, item]);
      selectedCueId.set(item.id);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  let reviewNote = $state("");
  let onlyPending = $state(false);
  let termDrafts = $state<Record<string, string>>({});
  let offlineText = $state("");
  let mergeResult = $state<MergeResult | { error: string } | null>(null);
  const pendingCount = $derived($cues.filter((cue) => cue.pendingTermIds.length > 0).length);
  const visibleCues = $derived($activeCues.filter((cue) => !onlyPending || cue.pendingTermIds.length > 0 || cue.status === "待重审"));

  function termNames(ids: string[]): string {
    return ids.map(termName).join("、");
  }

  function applyMerge() {
    mergeResult = mergeOffline(offlineText);
  }

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m") mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>多语言字幕时间轴协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本快照</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>多语种轨道、术语锁定与审校反馈在同一时间轴协作。</p></div><div class="header-actions"><select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>需重新确认</span><b class={pendingCount ? "metric-warn" : ""}>{pendingCount}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>拖动或点击选择，所有修改保存到浏览器本地</small></div><div class="head-actions"><label class="filter"><input type="checkbox" bind:checked={onlyPending} />只看需重新评估</label><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each visibleCues as cue}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p>{#if cue.pendingTermIds.length > 0}<small class="term-flags">需重新确认：{termNames(cue.pendingTermIds)}</small>{/if}</div>
                <span class={`chip ${cue.status}`}>{cue.status}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
            {#if !visibleCues.length}<p class="empty-hint">没有需要重新评估的字幕。</p>{/if}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${selected.status}`}>{selected.status}</span>{/if}</div>
          {#if selected}
            {#if selected.pendingTermIds.length > 0}<div class="term-notice">该字幕因术语译法变更需重新确认：{termNames(selected.pendingTermIds)}</div>{/if}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>修改锁定术语译法后，引用它的字幕需重新确认</small></div>
          {#each $terms as term}
            <div class="term">
              <span class="term-row"><b>{term.source}</b><span class="term-arrow">→</span><input class="input term-target" value={term.target} oninput={(event) => termDrafts[term.id] = event.currentTarget.value} /></span>
              <span class="term-actions">
                <button class="btn btn-sm" onclick={() => updateTermTarget(term.id, termDrafts[term.id] ?? term.target)}>更新译法</button>
                <button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => lockTerm(term.id)}>{term.status}</button>
              </span>
            </div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突</h2></div>
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>离线校订回传</h2><small>译文以较新基线为准，复核状态跟着术语走</small></div>
          <div class="actions"><button class="btn btn-sm" onclick={() => { offlineText = exportBaseline(); mergeResult = null; }}>复制当前基线</button><button class="btn btn-sm variant-filled-primary" onclick={applyMerge}>合并回传结果</button></div>
          <textarea class="textarea merge-input" bind:value={offlineText} placeholder="粘贴译员离线校订后的字幕 JSON…"></textarea>
          {#if mergeResult}
            {#if "error" in mergeResult}<p class="merge-error">{mergeResult.error}</p>{:else}<p class="merge-ok">合并完成：{mergeResult.merged} 条取较新译文，{mergeResult.flagged} 条需重新确认，{mergeResult.kept} 条保留本地{#if mergeResult.added}，新增 {mergeResult.added} 条{/if}。</p>{/if}
          {/if}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
      <section class="panel"><div class="panel-head"><h2>版本快照</h2><small>冻结标版按当时术语留着</small></div><div class="events">{#each $snapshots as item}{@const reeval = snapshotReeval(item, $terms)}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · {new Date(item.time).toLocaleString("zh-CN")}</p>{#if reeval.length}<p class="reeval-head">需重新评估 {reeval.length} 条：</p><ul class="reeval-list">{#each reeval as r}<li>《{r.cue.source.slice(0, 14)}…》引用「{r.term.source}」：{r.frozen} → {r.current}</li>{/each}</ul>{:else}<small class="reeval-none">术语无变动，无需重新评估</small>{/if}<button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
    </div>
  </main>
</div>
