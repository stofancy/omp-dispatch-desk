/* 任务看板：只渲染 /data.json（由 scripts/board.ts 每次请求从任务表现算）。路由：#/ 总览，#/t/<任务名> 详情，#/s/<任务名> 一屏摘要（截图用）。 */
"use strict";

const KINDS = [
  ["you", "等你"], ["blocked", "卡住"], ["waiting", "等别人"], ["review", "待审查"],
  ["active", "进行中"], ["done", "完成"], ["cancelled", "取消"],
];
const LABEL = Object.fromEntries(KINDS);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const when = ts => (ts ? new Date(ts).toLocaleString("sv-SE").slice(5, 16) : "");
const link = s => (/^https?:\/\//.test(s ?? "") ? `<a href="${esc(s)}" target="_blank" rel="noreferrer">${esc(s.replace(/^https?:\/\/(www\.)?/, ""))}</a>` : esc(s));
const st = i => `<span class="st ${i.kind}">${esc(i.status || LABEL[i.kind])}</span>${i.waitingOn && !(i.status || "").includes(i.waitingOn) ? ` <span class="muted">等 ${esc(i.waitingOn)}</span>` : ""}`;
const enc = encodeURIComponent;
const isOpen = i => i.kind !== "done" && i.kind !== "cancelled";

// 给同事看的纯文本（Slack 能识别 *粗体* 和裸链接）：不带事项编号和 agent 名
function shareText(t, today) {
  const open = t.items.filter(isOpen);
  const n = k => open.filter(i => i.kind === k).length;
  const lines = [`*${t.title || t.name}*（${t.name}）`, `进度：事项 ${t.progress.closed}/${t.items.length} 已关闭；进行中 ${n("active")}，等别人 ${n("waiting")}，待审查 ${n("review")}，卡住 ${n("blocked")}`];
  const waits = open.filter(i => i.kind === "waiting");
  if (waits.length) lines.push("在等：", ...waits.map(i => `• ${i.title}：等 ${i.waitingOn || "（未写）"}${i.chase ? `，${i.chase} 再跟进` : ""}`));
  const doing = open.filter(i => i.kind === "active" || i.kind === "blocked" || i.kind === "you");
  if (doing.length) lines.push("下一步：", ...doing.map(i => `• ${i.title}${i.kind === "blocked" ? "（卡住）" : ""}${i.next ? `：${i.next}` : ""}`));
  const prs = [...new Set(t.items.map(i => i.pr).filter(Boolean))];
  if (prs.length) lines.push(`PR：${prs.join(" ")}`);
  lines.push(`（${today} 任务表）`);
  return lines.join("\n");
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const tip = document.getElementById("gen");
  tip.textContent = "已复制，可以粘进 Slack";
}
const chase = (c, today) => (c ? `<span class="${c <= today ? "due" : ""}">${esc(c)}</span>` : "");

function bar(t) {
  const total = t.items.length || 1;
  const segs = KINDS.filter(([k]) => t.counts[k]).map(([k, n]) => `<i class="k-${k}" style="width:${(t.counts[k] / total) * 100}%" title="${n} ${t.counts[k]}"></i>`).join("");
  return `<div class="bar">${segs}</div>`;
}
const legend = `<div class="legend">${KINDS.map(([k, n]) => `<span><i class="k-${k}"></i>${n}</span>`).join("")}</div>`;

const verdict = r => (r ? `<span class="${r.verdict === "pass" ? "ok" : "bad"}">${r.verdict === "pass" ? "通过" : "不通过"}</span> <span class="muted">${esc(r.by)} ${when(r.at)}</span>` : "");

function itemTable(items, today, withTask) {
  if (!items.length) return `<p class="muted">（无）</p>`;
  const head = `${withTask ? "<th>任务</th>" : ""}<th>#</th><th>事项</th><th>状态</th><th>下一步</th><th>催办</th><th>PR</th>${withTask ? "" : "<th>审查</th>"}`;
  const rows = items.map(i => `<tr>${withTask ? `<td><a href="#/t/${encodeURIComponent(i.task)}">${esc(i.task)}</a></td>` : ""}<td class="mono">${esc(i.id)}</td><td>${esc(i.title)}</td><td>${st(i)}</td><td>${esc(i.next)}</td><td class="mono">${chase(i.chase, today)}</td><td>${link(i.pr)}</td>${withTask ? "" : `<td>${verdict(i.review)}</td>`}</tr>`).join("");
  return `<div class="card flat"><table class="t"><tr>${head}</tr>${rows}</table></div>`;
}

function reviewBlock(title, r) {
  return `<div class="card flat" style="margin-bottom:12px"><h3>${esc(title)}：${verdict(r)}</h3><p class="kicker">核对过的</p><p style="white-space:pre-wrap">${esc(r.evidence || "（没写）")}</p>${r.findings ? `<p class="kicker">发现</p><p style="white-space:pre-wrap">${esc(r.findings)}</p>` : ""}</div>`;
}

function home(d) {
  const s = d.summary;
  const stat = (n, label, hot) => `<div class="stat${hot && n ? " hot" : ""}"><b>${n}</b><span>${label}</span></div>`;
  const cards = d.tasks.map(t => {
    const open = t.items.filter(i => i.kind !== "done" && i.kind !== "cancelled");
    const href = `#/t/${encodeURIComponent(t.name)}`;
    const prs = [...new Set(t.items.map(i => i.pr).filter(Boolean))];
    const tracked = open.filter(i => i.kind === "waiting" || i.kind === "you" || i.kind === "blocked" || i.chase)
      .sort((a, b) => (a.chase ?? "9999").localeCompare(b.chase ?? "9999"));
    return `<div class="card tcard">
      <h3><span class="name">${esc(t.name)} · ${esc(t.agent || "无负责 agent")}</span><a href="${href}">${esc(t.title || t.name)}</a></h3>
      ${bar(t)}
      <div class="meta">事项 ${t.progress.closed}/${t.items.length} 已关闭 · 未关闭 ${open.length}${t.counts.you ? ` · <b class="bad">等你 ${t.counts.you}</b>` : ""}${t.counts.blocked ? ` · <b class="bad">卡住 ${t.counts.blocked}</b>` : ""}${t.chaseDue ? ` · <span class="due">到期催办 ${t.chaseDue}</span>` : ""}${t.asks.length ? ` · 待决定 #${t.asks.join(" #")}` : ""}${t.tidy.length ? ` · <span class="mid">需要整理 ${t.tidy.length}</span>` : ""}</div>
      ${tracked.length ? `<ul class="tl">${tracked.map(i => `<li><span class="mono">${esc(i.id)}</span> ${st(i)}${i.chase ? ` · 催办 <span class="mono">${chase(i.chase, d.today)}</span>` : ""}${i.pr ? ` · ${link(i.pr)}` : ""}</li>`).join("")}</ul>` : ""}
      ${prs.length ? `<div class="meta">PR：${prs.map(link).join(" · ")}</div>` : ""}
      <div class="meta muted">最近更新 ${when(t.updated)} · <a href="${href}">详情 →</a> · <a href="#/s/${enc(t.name)}">摘要</a> · <button data-copy="${esc(t.name)}">复制给同事</button></div></div>`;
  }).join("");
  return `<p class="kicker">一句话</p>
    <h1 class="pg-title">${s.tasks} 个任务在跑，${s.you} 项等你，${s.chaseDue} 项今天该催，${s.asks} 个问题待决定</h1>
    <div class="stats">${stat(s.tasks, "未关闭任务")}${stat(s.items, "未关闭事项")}${stat(s.you, "等你", true)}${stat(s.blocked, "卡住", true)}${stat(s.chaseDue, "今天该催", true)}${stat(s.waiting, "等别人")}${stat(s.review, "待审查")}${stat(s.asks, "待决定", true)}</div>
    <div class="sec"><h2>待决定</h2><span class="kicker">${d.asks.length} 个</span></div>
    ${d.asks.length ? `<div class="card flat"><table class="t">${d.asks.map(a => `<tr><td class="mono">${a.n}</td><td><a href="#/t/${encodeURIComponent(a.line)}">${esc(a.line)}</a></td><td>${esc(a.text)}</td><td class="mono">${when(a.opened)}</td></tr>`).join("")}</table></div>` : `<p class="muted">（无）</p>`}
    <div class="sec"><h2>要你注意</h2><span class="kicker">等你 / 卡住 / 到期催办</span></div>
    ${itemTable(d.attention, d.today, true)}
    <div class="sec" id="tidy"><h2>需要整理</h2><span class="kicker">${d.tidy.length} 项 · 3 天没动 / 催办已过 / 等别人缺等谁或催办 / 标题重复</span></div>
    ${d.tidy.length ? `<div class="card flat"><table class="t"><tr><th>任务</th><th>#</th><th>事项</th><th>状态</th><th>原因</th><th>最后更新</th></tr>${d.tidy.map(i => `<tr><td><a href="#/t/${enc(i.task)}">${esc(i.task)}</a></td><td class="mono">${esc(i.id)}</td><td>${esc(i.title)}</td><td>${st(i)}</td><td class="mid">${i.reasons.map(esc).join("；")}</td><td class="mono">${when(i.updated)}${i.by ? ` · ${esc(i.by)}` : ""}</td></tr>`).join("")}</table></div>` : `<p class="muted">（无）</p>`}
    <div class="sec"><h2>任务</h2><span class="kicker">按最近更新排序</span></div>
    ${legend}<div class="cards" style="margin-top:12px">${cards}</div>
    <div class="sec"><h2>最近远端写入</h2><span class="kicker">最多 30 条</span></div>
    <ul class="tl card flat">${d.actions.map(a => `<li><span class="when">${when(a.ts)}</span>(${esc(a.line ?? "—")}) ${esc(a.type ? `${a.type} ${a.target ?? ""}` : a.summary)}</li>`).join("") || "<li>（无）</li>"}</ul>
    <details class="done"><summary>已关闭任务 ${d.closed.length} 个</summary><ul class="tl">${d.closed.map(t => `<li><span class="when">${when(t.updated)}</span>${esc(t.name)} ${esc(t.title)} · ${esc(t.status)}</li>`).join("")}</ul></details>`;
}

function evText(e) {
  switch (e.kind) {
    case "item": return `事项 ${e.id}${e.title ? ` ${e.title}` : ""}${e.state || e.status ? ` → ${e.status || e.state}` : ""}${e.waiting_on ? `（等 ${e.waiting_on}）` : ""}${e.next ? `；下一步：${e.next}` : ""}${e.by ? ` · ${e.by}` : ""}`;
    case "inbox": return `外部消息：${e.who ?? ""} @ ${e.where ?? ""}`;
    case "task": return `任务${e.status ? ` → ${e.status}` : " 登记/更新"}${e.agent ? `（负责 ${e.agent}）` : ""}`;
    case "decision": return `决定：${e.text}`;
    case "review": return `审查${e.item ? ` ${e.item}` : "整个任务"}：${e.verdict === "pass" ? "通过" : "不通过"}（${e.by}）`;
    case "ask": return `提问 #${e.n}：${e.text}`;
    case "ask_close": return `提问 #${e.n} 关闭${e.outcome ? `：${e.outcome}` : ""}`;
    case "action": return `远端写入：${e.type ? `${e.type} ${e.target ?? ""}` : e.summary}`;
    case "correction": return `纠正 #${e.n}：${e.text}`;
    default: return e.kind;
  }
}

function detail(d, name) {
  const t = d.tasks.find(x => x.name === name);
  if (!t) return `<p class="err">没有未关闭的任务「${esc(name)}」。</p><p><a href="#/">回总览</a></p>`;
  const open = t.items.filter(i => i.kind !== "done" && i.kind !== "cancelled");
  const closed = t.items.filter(i => i.kind === "done" || i.kind === "cancelled");
  return `<p class="kicker"><a href="#/">总览</a> / ${esc(t.name)}</p>
    <h1 class="pg-title">${esc(t.title || t.name)}</h1>
    <p class="pg-sub">状态：<b>${esc(t.status)}</b> · 负责 agent：<span class="mono">${esc(t.agent || "（无）")}</span> · 任务审查：${t.review ? (t.review.verdict === "pass" ? '<span class="ok">通过</span>' : '<span class="bad">不通过</span>') : "（无）"}</p>
    ${bar(t)}${legend}
    <div class="card" style="margin-top:16px"><h3>目标</h3><p>${esc(t.goal || "（无）")}</p><h3>完成判据</h3><p>${esc(t.doneWhen || "（无）")}</p>
    ${t.watch.length ? `<h3>盯的外部输入</h3><ul>${t.watch.map(w => `<li>${link(w)}</li>`).join("")}</ul>` : ""}</div>
    <div class="sec"><h2>未关闭事项</h2><span class="kicker">${open.length} 项 · <a href="#/s/${enc(t.name)}">一屏摘要</a> · <button data-copy="${esc(t.name)}">复制给同事</button></span></div>${itemTable(open, d.today)}
    <details class="done" style="margin-top:14px"><summary>已关闭事项 ${closed.length} 项</summary>${itemTable(closed, d.today)}</details>
    <div class="sec"><h2>事项历史</h2><span class="kicker">每项按时间倒序，带修改人</span></div>
    ${t.items.filter(i => t.history[i.id]?.length).map(i => `<details class="done hist"><summary><span class="mono">${esc(i.id)}</span> ${esc(i.title)} · 改过 ${t.history[i.id].length} 次 · 最近 ${when(i.updated)}</summary><ul class="tl">${t.history[i.id].map(e => `<li><span class="when">${when(e.ts)}</span>${esc(evText(e))}</li>`).join("")}</ul></details>`).join("") || `<p class="muted">（无）</p>`}
    <div class="sec"><h2>审查记录</h2><span class="kicker">每项只留最近一次</span></div>
    ${t.review ? reviewBlock("整个任务", t.review) : ""}${t.items.filter(i => i.review).map(i => reviewBlock(`${i.id} ${i.title}`, i.review)).join("") || (t.review ? "" : `<p class="muted">（无）</p>`)}
    <div class="sec"><h2>已定</h2><span class="kicker">${t.decisions.length} 条</span></div>
    <ul class="tl card flat">${t.decisions.map(x => `<li><span class="when">${esc(x.date)}</span>${esc(x.text)}</li>`).join("") || "<li>（无）</li>"}</ul>
    <div class="sec"><h2>时间线</h2><span class="kicker">最近 ${t.timeline.length} 条</span></div>
    <ul class="tl card flat">${t.timeline.map(e => `<li><span class="when">${when(e.ts)}</span>${esc(evText(e))}</li>`).join("")}</ul>`;
}

// 一屏摘要：固定宽度、无导航，适合截图发给同事
function summary(d, name) {
  const t = d.tasks.find(x => x.name === name);
  if (!t) return `<p class="err">没有未关闭的任务「${esc(name)}」。</p><p><a href="#/">回总览</a></p>`;
  const open = t.items.filter(isOpen);
  const text = shareText(t, d.today);
  return `<div class="shot card">
    <p class="kicker">${esc(t.name)} · 任务摘要</p>
    <h1 class="pg-title">${esc(t.title || t.name)}</h1>
    ${bar(t)}${legend}
    <p class="meta">事项 ${t.progress.closed}/${t.items.length} 已关闭 · 未关闭 ${open.length}</p>
    <table class="t">${open.map(i => `<tr><td>${esc(i.title)}</td><td>${st(i)}</td><td>${esc(i.next)}</td><td class="mono">${chase(i.chase, d.today)}</td></tr>`).join("")}</table>
    ${t.decisions.length ? `<h3 style="margin-top:14px">最近定下的</h3><ul class="tl">${t.decisions.slice(-3).reverse().map(x => `<li><span class="when">${esc(x.date)}</span>${esc(x.text)}</li>`).join("")}</ul>` : ""}
    <p class="muted mono" style="text-align:right;margin:10px 0 0">数据 ${esc(d.today)} · 生成 ${when(d.generated)}</p></div>
    <p class="noshot"><button data-copy="${esc(t.name)}">复制给同事</button> <a href="#/t/${enc(t.name)}">详情 →</a></p>
    <p class="kicker noshot">复制出去的文字</p><pre class="card flat noshot" id="share">${esc(text)}</pre>`;
}

let data;
async function render(keepScroll) {
  const app = document.getElementById("app");
  try {
    const res = await fetch("data.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    app.innerHTML = `<p class="err">读不到任务表数据：${esc(e.message)}</p>`;
    return;
  }
  document.getElementById("gen").textContent = `生成于 ${when(data.generated)}`;
  const m = location.hash.match(/^#\/([ts])\/(.+)$/);
  const y = window.scrollY;
  document.body.classList.toggle("shotmode", m?.[1] === "s");
  app.innerHTML = !m ? home(data) : m[1] === "s" ? summary(data, decodeURIComponent(m[2])) : detail(data, decodeURIComponent(m[2]));
  window.scrollTo(0, keepScroll ? y : 0);
}

document.addEventListener("click", e => {
  const name = e.target.closest?.("[data-copy]")?.dataset.copy;
  const t = name && data?.tasks.find(x => x.name === name);
  if (t) copy(shareText(t, data.today));
});
window.addEventListener("hashchange", () => render(false));

// 任务表一变就重画，保留滚动位置
let version;
setInterval(async () => {
  try {
    const v = await (await fetch("version", { cache: "no-store" })).text();
    if (version !== undefined && v !== version) render(true);
    version = v;
  } catch {}
}, 5000);
render(false);
