// 任务表的只读看板：每次请求从 tasks/events.jsonl 现折叠出 JSON，页面在 scripts/board/ 里渲染。
// 用法：bun scripts/board.ts [端口]，默认 127.0.0.1:8768。只读，不写数据目录。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENTS, type Ev, GENERAL, type Item, type Review, type Task, foldEvents, isDone, openTasks, today } from "../src/table";

// 状态是自由文本，这里粗分成几类供分组和计数；分不出的算进行中
export type Kind = "you" | "blocked" | "waiting" | "review" | "active" | "done" | "cancelled";
export function kindOf(status: string): Kind {
	const s = status.trim();
	if (/^(取消|cancelled)/i.test(s)) return "cancelled";
	if (isDone(s)) return "done";
	if (/卡住|blocked/i.test(s)) return "blocked";
	if (/等你|要用户定|待你|等 ?Parker/i.test(s)) return "you";
	if (/待审查|待验收|做完|审查/.test(s)) return "review";
	if (/等别人|等待|waiting/i.test(s)) return "waiting";
	return "active";
}

const TIMELINE_KINDS: Record<string, true> = { task: true, item: true, decision: true, review: true, ask: true, ask_close: true, action: true, correction: true };
const TIMELINE_MAX = 60;
const ACTIONS_MAX = 30;

const reviewOf = (r?: Review) => (r ? { verdict: r.verdict, by: r.by, at: r.at, evidence: r.evidence, findings: r.findings } : undefined);
const itemOf = (i: Item) => ({ id: i.id, title: i.title, status: i.status, kind: kindOf(i.status), next: i.next, chase: i.chase, pr: i.pr, source: i.source, updated: i.updated, review: reviewOf(i.review) });

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
