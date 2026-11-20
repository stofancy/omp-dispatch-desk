// 给人看的 Markdown 视图（tasks/views/），以及每次请求注入的任务表摘要和任务卡。都由程序生成。
import { join } from "node:path";
import { TASKS } from "./paths";
import { type Correction, type Ev, GENERAL, type Item, type Review, type Table, type Task, isDone, openItems, openTasks, readTable, today, writeAtomic } from "./table";

const SNAPSHOT_MAX = 4000; // 字符
const RECENT_DECISIONS = 10;
const RECENT_WRITES = 10;
const PAIR_WINDOW_MIN = 30; // 远端写入之前这么多分钟内有用户对这个任务的决定，才把两者配成一对

const cell = (s?: string) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const fileOf = (task: string) => `${task.replace(/[\\/:*?"<>|\s]+/g, "_")}.md`; // 只替换路径不安全的字符，中文任务名保留
const when = (ts: string) => new Date(ts).toLocaleString("sv-SE").slice(5, 16);
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);
const tail = (s: string, max: number) => (s.length > max ? `…${s.slice(-max)}` : s); // 决定的文本是「问题 → 回答」，回答在末尾
export const VIEWS = join(TASKS, "views");

const verdict = (r?: Review) => (r ? (r.verdict === "pass" ? "passed" : "failed") : "none");
const verdictZh = (r?: Review) => (r ? `${r.verdict === "pass" ? "通过" : "不通过"} ${when(r.at)}` : "");

// 摘要里每次请求都带，下一步只留开头；完整的在视图文件里
function itemLine(i: Item): string {
	const parts = [`[${i.id}] ${i.title}`, i.status];
	if (i.next) parts.push(`next: ${clip(i.next, 120)}`);
	if (i.chase) parts.push(`chase ${i.chase}`);
	if (i.pr) parts.push(`PR ${i.pr}`);
	if (i.review) parts.push(`review ${verdict(i.review)}`);
	return `- ${parts.join(" | ")}`;
}

// unobserved：这个任务登记的盯办项里，没有接收程序读得到的有几个
const taskHead = (t: Task, unobserved = 0) =>
	`${t.name}${t.title ? ` ${t.title}` : ""} | owner ${t.agent ? `agent://${t.agent}` : "none"} | watching ${t.watch.length}${unobserved ? ` (${unobserved} of them no source can observe)` : ""} | review ${verdict(t.review)}`;

// 远端写入对账，只放在任务视图里供人抽查：这次写入之前 30 分钟内，用户对这个任务最近的决定（最多两条）。
// 不放进给模型的摘要：批准常常早于 30 分钟，配不上是常态，模型会在每次汇报里解释一遍
function pairing(l: Table, a: Ev): string {
	if (a.kind !== "action") return "";
	const minutes = (d: Ev) => Math.round((Date.parse(a.ts) - Date.parse(d.ts)) / 60_000);
	const near = l.decisions.filter(d => d.ts <= a.ts && (!a.line || d.line === a.line) && minutes(d) <= PAIR_WINDOW_MIN).slice(-2).reverse();
	if (!near.length) return ` ← 之前 ${PAIR_WINDOW_MIN} 分钟内没有你对这个任务的决定`;
	return ` ← 之前你的决定：${near.map(d => `${minutes(d)} 分钟前「${tail(String(d.text), 80)}」`).join("；")}`;
}

// 纠正走到了哪一步。规则提议登记成提问后，用户在屏幕上看得到，模型不用在回复里再提；提问答了，按回答写规则再关掉
export function correctionLine(l: Table, k: Correction): string {
	const head = `[${k.n}] (${k.line}) ${k.text}`;
	if (k.ask === undefined) return `${head} — no rule proposed yet: call tasktable_correction action=record with n=${k.n} and the rule you propose`;
	if (l.asks.has(k.ask)) return `${head} — rule proposed as question ${k.ask}; it is on the operator's screen, do not repeat it`;
	const answer = l.decisions.findLast(d => d.n === k.ask);
	return `${head} — question ${k.ask} is closed${answer ? `: ${tail(String(answer.text), 160)}` : ""}. If the operator agreed, write the rule into rules.md (replace a similar older line instead of adding one), then tasktable_correction close n=${k.n}; otherwise just close it`;
}

function describeAction(l: Table, ev: Ev, paired: boolean): string {
	if (ev.kind === "inbox") return `${when(ev.ts)} inbox ${ev.source}: ${ev.who ?? ""} @ ${ev.where ?? ""}`;
	const status = ev.ok === false ? "FAILED " : ev.unsure ? "UNVERIFIED (command exited non-zero; check the real state) " : "";
	return `${when(ev.ts)} ${status}${ev.summary}${ev.by && ev.by !== "main" ? ` (by ${ev.by})` : ""}${paired ? pairing(l, ev) : ""}`;
}

const decisionLine = (d: Ev) => `- (${d.line}) ${String(d.date ?? d.ts.slice(0, 10))}: ${d.text}`;

export function renderViews(): void {
	const l = readTable();
	const asks = [...l.asks.values()].sort((a, b) => a.n - b.n);
	const out = ["# 总览（程序生成，勿手改）", "", `生成时间：${new Date().toLocaleString("sv-SE")}`, "", "## 待决定", ""];
	out.push(...(asks.length ? asks.map(a => `${a.n}. 〔${a.line}〕${a.text}`) : ["（无）"]), "");
	for (const name of [...l.tasks.keys()].sort()) {
		const t = l.tasks.get(name) as Task;
		const all = [...(l.items.get(name)?.values() ?? [])];
		const open = all.filter(i => !isDone(i.status));
		const done = isDone(t.status) ? `，${t.status}` : "";
		out.push(`## ${name}${t.title ? ` ${t.title}` : ""}（未完成事项 ${open.length} / 共 ${all.length}${done}）`, "");
		if (name !== GENERAL) out.push(`负责 agent：${t.agent || "（无）"}；盯的外部输入：${t.watch.length} 个`, "");
		out.push("| # | 事项 | 状态 | 下一步 | 催办 | PR |", "|---|---|---|---|---|---|");
		for (const i of open) out.push(`| ${i.id} | ${cell(i.title)} | ${cell(i.status)} | ${cell(i.next)} | ${cell(i.chase)} | ${cell(i.pr)} |`);
		out.push("");
		writeAtomic(join(VIEWS, fileOf(name)), renderTask(l, t, all));
	}
	out.push("## 待定的规则提议（用户纠正过、还没决定写不写成规则）", "");
	out.push(...(l.corrections.size ? [...l.corrections.values()].map(k => `${k.n}. 〔${k.line}〕${k.text}`) : ["（无）"]), "");
	out.push("## 最近动作（全部任务，最多 30 条；远端写入后面是它之前你对这个任务最近的一条决定）", "", ...l.actions.slice(-30).map(a => `- (${a.line ?? "—"}) ${describeAction(l, a, true)}`), "");
	writeAtomic(join(VIEWS, "总览.md"), out.join("\n"));
}

function reviewBlock(title: string, r: Review): string[] {
	const out = [`### ${title}：${r.verdict === "pass" ? "通过" : "不通过"}（${r.by}，${when(r.at)}）`, "", "核对过的：", "", r.evidence || "（没写）", ""];
	if (r.findings) out.push("发现：", "", r.findings, "");
	return out;
}

export function renderTask(l: Table, t: Task, all: Item[]): string {
	const out = [`# ${t.name}${t.title ? ` ${t.title}` : ""}（程序生成，勿手改）`, ""];
	if (t.name !== GENERAL) {
		out.push(`- 状态：${t.status || "进行中"}`, `- 负责 agent：${t.agent || "（无）"}`, `- 目标：${t.goal || "（无）"}`, `- 完成判据：${t.doneWhen || "（无）"}`, `- 盯的外部输入：${t.watch.length ? "" : "（无）"}`);
		out.push(...t.watch.map(w => `  - ${w}`), "");
	}
	out.push("## 事项", "", "| # | 事项 | 状态 | 下一步 | 催办 | PR | 来源 | 审查 |", "|---|---|---|---|---|---|---|---|");
	for (const i of all) out.push(`| ${i.id} | ${cell(i.title)} | ${cell(i.status)} | ${cell(i.next)} | ${cell(i.chase)} | ${cell(i.pr)} | ${cell(i.source)} | ${verdictZh(i.review)} |`);
	const reviewed = all.filter(i => i.review);
	if (t.review || reviewed.length) {
		out.push("", "## 审查记录（每项只留最近一次）", "");
		if (t.review) out.push(...reviewBlock("整个任务", t.review));
		for (const i of reviewed) out.push(...reviewBlock(`${i.id} ${i.title}`, i.review as Review));
	}
	out.push("", "## 已定", "");
	for (const d of l.decisions.filter(d => d.line === t.name)) out.push(`- ${String(d.date ?? d.ts.slice(0, 10))}：${d.text}`);
	out.push("", "## 最近动作（最多 30 条；远端写入后面是它之前 30 分钟内你对这个任务的决定）", "");
	for (const a of l.actions.filter(a => a.line === t.name).slice(-30)) out.push(`- ${describeAction(l, a, true)}`);
	return `${out.join("\n")}\n`;
}

const size = (lines: string[]) => lines.reduce((n, s) => n + s.length + 1, 0);

// 在预算内从头往后尽量多放；放不下的只说还有几行
function fit(lines: string[], budget: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (const line of lines) {
		if (used + line.length + 1 > budget) break;
		out.push(line);
		used += line.length + 1;
	}
	if (out.length < lines.length) out.push(`…(${lines.length - out.length} more not shown; read the full board)`);
	return out;
}

// 接收程序的故障和登记了却没人盯的盯办项：由调用方（知道本机配置的那一侧）算好传进来
export interface Monitoring {
	faults?: Array<{ text: string; fresh: boolean }>; // fresh：还没告诉过用户
	unobserved?: (watch: string[]) => number;
}

// 每次请求注入主会话的任务表摘要：不写进会话历史，所以压缩丢不掉；会话之外发生的事也在里面。
// 长度有上限。待决定的事、每个任务和它的负责 agent、远端写入、待定的纠正、在跑的 agent、接收程序的故障一定在；
// 事项和用户的决定在剩下的预算里尽量多放（完整的在视图文件里，登记提问时程序也会列出已有的决定）
export function snapshot(running: string[], l: Table = readTable(), monitoring: Monitoring = {}): string {
	const asks = [...l.asks.values()].sort((a, b) => a.n - b.n);
	const tasks = openTasks(l);
	const heads = tasks.map(t => taskHead(t, monitoring.unobserved?.(t.watch) ?? 0));
	const items = openItems(l);
	const names = new Set(tasks.map(t => t.name));
	const loose = items.filter(i => !names.has(i.line));
	const head = [
		`Today ${today()}. Full board: ${join(VIEWS, "总览.md")}; per task (goal, completion criteria, watched inputs, reviews): ${join(VIEWS, "<task>.md")}`,
		`Waiting on the operator (${asks.length}):`,
		...asks.map(a => `[${a.n}] (${a.line}) ${a.text}`),
	];
	const must: string[] = [];
	// 远端写入：用户上次发话之后的都列出来（至少最近 5 条：重启后靠它们防止重复做远端动作）
	const writes = l.actions.filter(a => a.kind === "action");
	const fresh = l.lastInput ? writes.filter(a => a.ts > (l.lastInput as string)).length : 0;
	const shown = writes.slice(-Math.min(RECENT_WRITES, Math.max(5, fresh)));
	if (shown.length) must.push("Remote writes recorded by the program (before redoing one, check its real state first):", ...shown.map(a => `- ${describeAction(l, a, false)}`));
	if (l.corrections.size) must.push("Open corrections:", ...[...l.corrections.values()].map(k => `- ${correctionLine(l, k)}`));
	if (running.length) must.push(`Agents running (${running.length}): ${running.join("; ")}`);
	// 故障用户在屏幕上看得到：新出现的让模型说一次，说过的不重复
	const unsaid = monitoring.faults?.filter(f => f.fresh) ?? [];
	const said = monitoring.faults?.filter(f => !f.fresh) ?? [];
	if (unsaid.length) must.push("Receivers that stopped working (NEW: tell the operator once, in your next reply; do not try to fix them):", ...unsaid.map(f => `- ${f.text}`));
	if (said.length) must.push("Receivers still not working (the operator has been told and sees them on screen; do not repeat it, except when you say you are waiting for something that arrives through one of them):", ...said.map(f => `- ${f.text}`));

	let budget = SNAPSHOT_MAX - size(head) - size(must) - size(heads);
	const work = [`Open tasks (${tasks.length}):`];
	// 事项的预算各任务平分，用不完的留给后面的：一个事项很多的任务不会把别的任务挤没
	const group = (lines: string[], share: number) => {
		const kept = fit(lines, share);
		budget -= size(kept);
		work.push(...kept);
	};
	tasks.forEach((t, n) => {
		work.push(heads[n]);
		group(items.filter(i => i.line === t.name).map(itemLine), Math.max(budget, 0) / (tasks.length - n));
	});
	if (loose.length) {
		work.push(`Open items outside any task (${loose.length}):`);
		group(loose.map(itemLine), budget);
	}
	const decisions = fit(l.decisions.slice(-RECENT_DECISIONS).reverse().map(d => clip(decisionLine(d), 200)), budget);
	const decided = decisions[0]?.startsWith("- ") ? ["Operator decisions (newest first; all of them are in the per-task views):", ...decisions] : []; // 一条都放不下就不占地方
	const text = [...head, ...work, ...must, ...decided].join("\n");
	return [
		`<tasktable-context source="dispatch-desk extension" from_operator="no">`,
		"Injected automatically on every request; NOT a message from the operator. Do not acknowledge, quote or summarise it unless the request needs these items.",
		text,
		"</tasktable-context>",
	].join("\n");
}

// 每次请求注入给任务的负责 agent：这个任务登记在任务表里的内容。压缩之后它也还看得到自己负责什么、盯着什么
export function taskCard(t: Task): string {
	return [
		`<task-card task="${t.name}">`,
		`任务：${t.name}${t.title ? ` ${t.title}` : ""}`,
		`目标：${t.goal || "（没登记）"}`,
		`完成判据：${t.doneWhen || "（没登记）"}`,
		`盯的外部输入：${t.watch.length ? t.watch.join("；") : "（无）"}`,
		"</task-card>",
	].join("\n");
}

// 登记提问时给模型看：这个任务已经定过什么、还有哪些没答的提问，免得把定过的事再问一遍
export function decidedFor(l: Table, task: string, exceptAsk: number): string {
	const decisions = l.decisions.filter(d => d.line === task).slice(-15);
	const open = [...l.asks.values()].filter(a => a.line === task && a.n !== exceptAsk);
	const out: string[] = [];
	if (decisions.length) out.push(`Operator decisions already on record for ${task} (latest ${decisions.length}):`, ...decisions.map(d => `- ${String(d.date ?? d.ts.slice(0, 10))}: ${tail(String(d.text), 160)}`));
	if (open.length) out.push(`Other open questions for ${task}:`, ...open.map(a => `- [${a.n}] ${clip(a.text, 160)}`));
	return out.join("\n");
}

// 某个时间点之后任务表里的变化：用户离开后回来时给模型看
export function since(ts: string): string {
	const l = readTable();
	const out: string[] = [];
	for (const byTask of l.items.values()) for (const i of byTask.values()) if (i.updated > ts) out.push(`(${i.line}) ${itemLine(i).slice(2)}`);
	for (const d of l.decisions) if (d.ts > ts) out.push(decisionLine(d));
	for (const a of l.actions) if (a.ts > ts) out.push(`- ${describeAction(l, a, false)}`);
	if (!out.length) return "（任务表里没有新记录；外部系统的变化要去查）";
	return out.length > 30 ? [`…前面还有 ${out.length - 30} 条，见 ${join(VIEWS, "总览.md")} 的「最近动作」`, ...out.slice(-30)].join("\n") : out.join("\n");
}
