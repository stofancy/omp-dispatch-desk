import { expect, test } from "bun:test";
import { type Task, foldEvents } from "./table";
import { correctionLine, decidedFor, renderTask, snapshot, taskCard } from "./views";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 1, minute)).toISOString();
const ev = (minute: number, kind: string, line: string | undefined, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: at(minute), sid: "s", kind, line, ...extra });

test("远端写入和用户决定的配对只在给人看的任务视图里：之前 30 分钟内这个任务的决定最多两条、近的在前，没有就注明；给模型的摘要里不配", () => {
	const l = foldEvents([
		ev(0, "task", "A", { agent: "TaskA", done_when: "x" }),
		ev(0, "decision", "A", { text: "更早的决定" }),
		ev(1, "decision", "A", { text: "推不推到 PR 分支 → 推" }),
		ev(2, "decision", "A", { text: "每日总结 → 改" }),
		ev(3, "action", "A", { summary: "git push: one", by: "TaskA" }),
		ev(40, "decision", "B", { text: "别的任务的决定" }),
		ev(41, "action", "A", { summary: "git push: two", by: "TaskA" }),
	]);
	const view = renderTask(l, l.tasks.get("A")!, []);
	expect(view).toContain("git push: one (by TaskA) ← 之前你的决定：1 分钟前「每日总结 → 改」；2 分钟前「推不推到 PR 分支 → 推」");
	expect(view).toContain("git push: two (by TaskA) ← 之前 30 分钟内没有你对这个任务的决定");
	const text = snapshot([], l);
	expect(text).toContain("git push: two (by TaskA)");
	expect(text).not.toContain("←");
});

test("摘要超长时省掉的是放不下的事项和用户决定：待决定的事、每个任务和负责 agent、远端写入、在跑的 agent 都还在", () => {
	const long = "很长的决定".repeat(60);
	const events = [ev(0, "task", "A", { agent: "TaskA", done_when: "x" }), ev(0, "task", "B", { agent: "TaskB", done_when: "x" }), ev(1, "ask", "A", { n: 7, text: "要不要发" }), ev(2, "action", "A", { summary: "slack write: hello", by: "TaskA" })];
	for (let i = 0; i < 30; i++) events.push(ev(3, "decision", "A", { text: `${i} ${long}` }), ev(3, "item", "A", { id: `T${i}`, title: "事项", status: "进行中", next: long }));
	const text = snapshot(["TaskA"], foldEvents(events));
	expect(text).toContain("more not shown; read the full board)");
	expect(text).not.toContain("[T29]");
	expect(text).toContain("[7] (A) 要不要发");
	expect(text).toContain("B | owner agent://TaskB");
	expect(text).toContain("slack write: hello");
	expect(text).toContain("Agents running (1): TaskA");
	expect(text.length).toBeLessThan(5000);
});

test("只有一条用户决定时，摘要里也有它", () => {
	expect(snapshot([], foldEvents([ev(0, "task", "A", { agent: "TaskA", done_when: "x" }), ev(1, "decision", "A", { text: "只有这一条" })]))).toContain("只有这一条");
});

test("登记提问时列给模型看的：这个任务已有的决定和别的没答的提问，不含别的任务的、不含刚登记的这一条", () => {
	const l = foldEvents([
		ev(0, "decision", "A", { text: "列顺序 → 已定" }),
		ev(1, "decision", "B", { text: "别的任务" }),
		ev(2, "ask", "A", { n: 3, text: "旧问题" }),
		ev(3, "ask", "A", { n: 4, text: "刚登记的" }),
	]);
	const text = decidedFor(l, "A", 4);
	expect(text).toContain("列顺序 → 已定");
	expect(text).toContain("[3] 旧问题");
	expect(text).not.toContain("别的任务");
	expect(text).not.toContain("刚登记的");
	expect(decidedFor(l, "C", 0)).toBe("");
});

test("摘要里：坏了的接收程序分两段，新出现的让模型说一次、说过的叫它别重复；任务有几项没人盯写在任务那一行；在跑的 agent 带着跑了多久", () => {
	const l = foldEvents([ev(0, "task", "A", { agent: "TaskA", done_when: "x", watch_add: ["OPS-1", "https://github.com/o/r/pull/1"] })]);
	const text = snapshot(['TaskA (A, running 16 min, last step "Waiting for upload" since 3 min ago)'], l, {
		faults: [
			{ text: "Slack 实时推送已 15 小时没正常工作", fresh: true },
			{ text: "提醒有一部分一直读不到（x）", fresh: false },
		],
		unobserved: watch => watch.filter(w => !w.startsWith("http")).length,
	});
	expect(text).toContain("(NEW: tell the operator once, in your next reply; do not try to fix them):\n- Slack 实时推送已 15 小时没正常工作\nReceivers still not working");
	expect(text).toContain("do not repeat it, except when you say you are waiting for something that arrives through one of them):\n- 提醒有一部分一直读不到（x）");
	expect(text).toContain("| watching 2 (1 of them no source can observe) |");
	expect(text).toContain('Agents running (1): TaskA (A, running 16 min, last step "Waiting for upload" since 3 min ago)');
	expect(snapshot([], l)).not.toContain("Receivers");
});

test("纠正走到哪一步，摘要里就说哪一步：规则提议还在等用户时叫模型别重复；用户答了让它按回答写规则再关；旧的没提议过的叫它补一个提议", () => {
	const l = foldEvents([
		ev(0, "correction", "A", { n: 1, text: "旧纠正" }),
		ev(1, "correction", "A", { n: 2, text: "别把测试时限当成发消息的时间", rule: "时限只管做事", ask: 5 }),
		ev(1, "ask", "A", { n: 5, text: "规则提议：时限只管做事（同意 / 不同意）" }),
		ev(2, "correction", "A", { n: 3, text: "草稿太正式", rule: "草稿写成口语", ask: 6 }),
		ev(2, "ask", "A", { n: 6, text: "规则提议：草稿写成口语（同意 / 不同意）" }),
		ev(3, "decision", "A", { n: 6, text: "规则提议：草稿写成口语（同意 / 不同意） → 同意" }),
		ev(3, "ask_close", "A", { n: 6, outcome: "同意", by: "operator" }),
	]);
	expect(correctionLine(l, l.corrections.get(1)!)).toContain("no rule proposed yet: call tasktable_correction action=record with n=1");
	expect(correctionLine(l, l.corrections.get(2)!)).toContain("rule proposed as question 5; it is on the operator's screen, do not repeat it");
	const answered = correctionLine(l, l.corrections.get(3)!);
	expect(answered).toContain("question 6 is closed: 规则提议：草稿写成口语（同意 / 不同意） → 同意");
	expect(answered).toContain("tasktable_correction close n=3");
	expect(snapshot([], l)).toContain("Open corrections:\n- [1] (A) 旧纠正");
});

test("负责 agent 的任务卡末尾附要它补写的事项（最多 3 条）和没记任务表的交回", () => {
	const l = foldEvents([
		JSON.stringify({ ts: "2026-11-01T00:00:00Z", sid: "s", kind: "task", line: "PROJ-7", agent: "Proj7", done_when: "x" }),
		...["T1", "T2", "T3", "T4"].map(id => JSON.stringify({ ts: "2026-11-01T00:00:00Z", sid: "s", kind: "item", line: "PROJ-7", id, title: id, status: "进行中" })),
		JSON.stringify({ ts: "2026-11-01T00:00:01Z", sid: "s", kind: "unrecorded", line: "PROJ-7", agent: "Proj7", handback: "做完" }),
	]);
	const card = taskCard(l.tasks.get("PROJ-7") as Task, l);
	expect(card).toContain("交回「做完」时没有更新任务表");
	expect(card).toContain("另有 1 项见看板");
	expect(card.match(/^- \[T\d\]/gm)?.length).toBe(3);
	expect(taskCard(l.tasks.get("PROJ-7") as Task)).not.toContain("补写");
});
