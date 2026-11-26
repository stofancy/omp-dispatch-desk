// 任务表的只读看板：每次请求从 tasks/events.jsonl 现折叠出 JSON，页面在 scripts/board/ 里渲染。
// 用法：bun scripts/board.ts [端口]，默认 127.0.0.1:8768。只读，不写数据目录。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENTS, type Ev, GENERAL, type Item, type Review, type Task, foldEvents, isDone, openTasks, today } from "../src/table";

// 有结构化 state 的照 state 分类；旧数据只有自由文本 status，按写法粗分，分不出的算进行中
export type Kind = "you" | "blocked" | "waiting" | "review" | "active" | "done" | "cancelled";
const KIND_OF_STATE: Record<string, Kind> = { 进行中: "active", 等你: "you", 等别人: "waiting", 卡住: "blocked", 待审查: "review", 完成: "done", 取消: "cancelled" };
export function kindOf(status: string, state?: string): Kind {
	if (state && KIND_OF_STATE[state]) return KIND_OF_STATE[state];
	const s = status.trim();
	if (/^(取消|cancelled)/i.test(s)) return "cancelled";
	if (isDone(s)) return "done";
	if (/卡住|blocked/i.test(s)) return "blocked";
	if (/等你|要用户定|待你|等 ?Parker/i.test(s)) return "you";
	if (/待审查|待验收|做完|审查/.test(s)) return "review";
	if (/等别人|等待|waiting/i.test(s)) return "waiting";
	return "active";
}

// 旧数据没有 waiting_on：从「等别人（某某）」的括号里取
const waitingOf = (i: Item) => i.waiting_on || /^等别人（([^）]+)）/.exec(i.status)?.[1] || "";

const TIMELINE_KINDS: Record<string, true> = { task: true, item: true, decision: true, review: true, ask: true, ask_close: true, action: true, correction: true, inbox: true };
const TIMELINE_MAX = 60;
const ACTIONS_MAX = 30;
const HISTORY_MAX = 50;
const STALE_DAYS = 3;

const reviewOf = (r?: Review) => (r ? { verdict: r.verdict, by: r.by, at: r.at, evidence: r.evidence, findings: r.findings } : undefined);
export interface BoardItem { id: string; title: string; status: string; state?: string; kind: Kind; waitingOn: string; next?: string; chase?: string; pr?: string; source?: string; by?: string; updated: string; review?: Review }
const itemOf = (i: Item): BoardItem => ({ id: i.id, title: i.title, status: i.status, state: i.state, kind: kindOf(i.status, i.state), waitingOn: waitingOf(i), next: i.next, chase: i.chase, pr: i.pr, source: i.source, by: i.by, updated: i.updated, review: reviewOf(i.review) });

// 需要整理的事项：多久没动、催办过期、等别人没写催办日期、同任务里标题重复
export function tidyReasons(i: BoardItem, day: string, dupTitle: boolean): string[] {
	const out: string[] = [];
	const idle = Math.floor((Date.parse(`${day}T23:59:59`) - Date.parse(i.updated)) / 864e5);
	if (idle >= STALE_DAYS) out.push(`${idle} 天没更新`);
	if (i.chase && i.chase < day) out.push(`催办已过（${i.chase}）`);
	if (i.kind === "waiting" && !i.chase) out.push("等别人但没写催办日期");
	if (i.kind === "waiting" && !i.waitingOn) out.push("没写等谁");
	if (dupTitle) out.push("标题重复");
	return out;
}

function parse(lines: string[]): Ev[] {
	const out: Ev[] = [];
	for (const raw of lines) {
		if (!raw.trim()) continue;
		try {
			out.push(JSON.parse(raw));
		} catch {} // 并发追加时可能读到半行
	}
	return out;
}

export function buildBoard(lines: string[], day: string = today()) {
	const l = foldEvents(lines);
	const events = parse(lines);
	const last = new Map<string, string>(); // 任务 → 最后一次有事件的时间
	for (const e of events) if (e.line) last.set(e.line, e.ts);

	const taskOf = (t: Task) => {
		const items = [...(l.items.get(t.name)?.values() ?? [])].map(itemOf);
		const open = items.filter(i => i.kind !== "done" && i.kind !== "cancelled");
		const counts: Record<string, number> = {};
		for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
		const titles: Record<string, number> = {};
		for (const i of open) titles[i.title] = (titles[i.title] ?? 0) + 1;
		const history: Record<string, Ev[]> = {};
		for (const e of events) if (e.kind === "item" && e.line === t.name) (history[String(e.id)] ??= []).push(e);
		for (const id in history) history[id] = history[id].slice(-HISTORY_MAX).reverse();
		const tidy = open.map(i => ({ ...i, task: t.name, reasons: tidyReasons(i, day, titles[i.title] > 1) })).filter(i => i.reasons.length);
		return {
			name: t.name,
			title: t.title,
			agent: t.agent,
			goal: t.goal,
			doneWhen: t.doneWhen,
			status: t.status || "进行中",
			watch: t.watch,
			review: reviewOf(t.review),
			items,
			counts,
			progress: { done: counts.done ?? 0, closed: items.length - open.length, total: items.length },
			chaseDue: open.filter(i => i.chase && i.chase <= day).length,
			updated: last.get(t.name) ?? "",
			asks: [...l.asks.values()].filter(a => a.line === t.name).map(a => a.n),
			decisions: l.decisions.filter(d => d.line === t.name).map(d => ({ date: String(d.date ?? d.ts.slice(0, 10)), text: String(d.text ?? "") })),
			timeline: events.filter(e => e.line === t.name && TIMELINE_KINDS[e.kind]).slice(-TIMELINE_MAX).reverse(),
			history,
			tidy,
		};
	};

	const general = l.tasks.get(GENERAL);
	const generalOpen = general && [...(l.items.get(GENERAL)?.values() ?? [])].some(i => !isDone(i.status));
	const tasks = [...openTasks(l), ...(generalOpen ? [general] : [])].map(taskOf).sort((a, b) => b.updated.localeCompare(a.updated));
	const openItems = tasks.flatMap(t => t.items.filter(i => i.kind !== "done" && i.kind !== "cancelled").map(i => ({ ...i, task: t.name })));
	const count = (k: Kind) => openItems.filter(i => i.kind === k).length;

	return {
		generated: new Date().toISOString(),
		today: day,
		summary: {
			tasks: tasks.filter(t => t.name !== GENERAL).length,
			items: openItems.length,
			you: count("you"),
			blocked: count("blocked"),
			waiting: count("waiting"),
			review: count("review"),
			chaseDue: openItems.filter(i => i.chase && i.chase <= day).length,
			asks: l.asks.size,
		},
		asks: [...l.asks.values()].sort((a, b) => a.n - b.n),
		attention: openItems.filter(i => i.kind === "you" || i.kind === "blocked" || (i.chase && i.chase <= day)),
		tidy: tasks.flatMap(t => t.tidy),
		tasks,
		closed: [...l.tasks.values()].filter(t => t.name !== GENERAL && isDone(t.status)).map(t => ({ name: t.name, title: t.title, status: t.status, updated: last.get(t.name) ?? "" })).sort((a, b) => b.updated.localeCompare(a.updated)),
		actions: l.actions.filter(a => a.kind === "action").slice(-ACTIONS_MAX).reverse(),
	};
}

const STATIC = join(import.meta.dir, "board");
const FILES: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

if (import.meta.main) {
	const port = Number(process.argv[2] ?? 8768);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/version") return new Response(existsSync(EVENTS) ? String(statSync(EVENTS).mtimeMs) : "0", { headers: { "cache-control": "no-store" } }); // 页面轮询它，任务表一变就重画
			if (path === "/data.json") {
				const lines = existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").split("\n") : [];
				return Response.json(buildBoard(lines), { headers: { "cache-control": "no-store" } });
			}
			const file = FILES[path];
			if (!file) return new Response("not found", { status: 404 });
			return new Response(readFileSync(join(STATIC, file)), { headers: { "content-type": TYPES[file.split(".").pop() as string], "cache-control": "no-store" } });
		},
	});
	console.log(`任务看板：http://${server.hostname}:${server.port}/ （数据 ${EVENTS}）`);
}
