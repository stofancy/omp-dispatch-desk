import { expect, test } from "bun:test";
import { agentTaken, tidyItems, doneBlocker, foldEvents, isReviewerName, needsReview, openTasks, taskOfAgent, taskOfReviewer } from "./table";

let n = 0;
const ev = (kind: string, line: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 18, 0, 0, n++)).toISOString(), sid: "s", kind, line, ...extra });

test("任务记录：后写的字段覆盖先写的，没传的保留；盯的外部输入可加可减", () => {
	const l = foldEvents([
		ev("task", "PROJ-1", { agent: "Proj1", goal: "修登录", done_when: "bun test 通过", watch_add: ["https://x.slack.com/archives/C1/p1700000000000100", "PROJ-1"] }),
		ev("task", "PROJ-1", { goal: "修登录和登出", watch_add: ["https://github.com/o/r/pull/7"], watch_remove: ["PROJ-1"] }),
	]);
	expect(l.tasks.get("PROJ-1")).toMatchObject({
		recorded: true,
		agent: "Proj1",
		goal: "修登录和登出",
		doneWhen: "bun test 通过",
		watch: ["https://x.slack.com/archives/C1/p1700000000000100", "https://github.com/o/r/pull/7"],
	});
});

test("未完成的任务：登记过的算；只有事项的旧任务有未完成事项才算；日常和已完成的不算", () => {
	const l = foldEvents([
		ev("task", "A", { agent: "TaskA", done_when: "x" }),
		ev("task", "B", { agent: "TaskB", done_when: "x" }),
		ev("task", "B", { status: "完成" }),
		ev("item", "OLD-1", { id: "T1", status: "进行中" }),
		ev("item", "OLD-2", { id: "T1", status: "完成" }),
		ev("item", "日常", { id: "T1", status: "进行中" }),
	]);
	expect(openTasks(l).map(t => t.name).sort()).toEqual(["A", "OLD-1"]);
	expect(l.tasks.get("OLD-1")?.recorded).toBe(false);
});

test("子代理的名字对到任务：登记的名字精确比较；旧任务按任务名比较；已完成的任务对不上", () => {
	const l = foldEvents([
		ev("task", "注意力统计", { agent: "AttnStats", done_when: "x" }),
		ev("item", "OLD-12", { id: "T1", status: "进行中" }),
		ev("task", "DONE", { agent: "DoneOne", done_when: "x", status: "完成" }),
	]);
	expect(taskOfAgent(l, "AttnStats")?.name).toBe("注意力统计");
	expect(taskOfAgent(l, "attnstats")).toBeUndefined();
	expect(taskOfAgent(l, "Old12")?.name).toBe("OLD-12");
	expect(taskOfAgent(l, "DoneOne")).toBeUndefined();
	expect(taskOfAgent(l, "Stranger")).toBeUndefined();
});

test("负责 agent 的名字：别的未完成任务在用就算被占；自己的、已完成任务的不算", () => {
	const l = foldEvents([ev("task", "A", { agent: "Shared", done_when: "x" }), ev("task", "B", { agent: "Old", done_when: "x", status: "取消" })]);
	expect(agentTaken(l, "Shared", "C")).toBe(true);
	expect(agentTaken(l, "Shared", "A")).toBe(false);
	expect(agentTaken(l, "Old", "C")).toBe(false);
});

test("审查者的名字对到它审的任务：带序号、被 omp 加了后缀的都认；负责 agent、它的帮手、已完成任务的审查者不认", () => {
	const l = foldEvents([
		ev("task", "PROJ-1", { agent: "Proj1", done_when: "x" }),
		ev("item", "OLD-12", { id: "T1", status: "进行中" }),
		ev("task", "DONE", { agent: "DoneOne", done_when: "x", status: "完成" }),
	]);
	for (const id of ["Proj1Review", "Proj1Review2", "Proj1Review-2"]) expect(taskOfReviewer(l, id)?.name).toBe("PROJ-1");
	expect(taskOfReviewer(l, "Old12Review")?.name).toBe("OLD-12");
	for (const id of ["Proj1", "Proj1.Proj1Review", "DoneOneReview", "StrangerReview", ""]) expect(taskOfReviewer(l, id)).toBeUndefined();
	expect(["Proj1Review", "XReview3", "XReview-2"].map(isReviewerName)).toEqual([true, true, true]);
	expect(["Proj1", "Reviewer", "ReviewBot"].map(isReviewerName)).toEqual([false, false, false]);
});

test("记成完成之前：没登记负责 agent 或判据的不行；没审查、最近一次不通过的不行；最近一次通过才行", () => {
	const base = ev("task", "A", { agent: "TaskA", done_when: "x" });
	const pass = ev("review", "A", { verdict: "pass", by: "TaskAReview", evidence: "e" });
	const fail = ev("review", "A", { verdict: "fail", by: "TaskAReview2", evidence: "e", findings: "f" });
	const blocker = (events: string[], name = "A") => doneBlocker(foldEvents(events), name);
	expect(blocker([ev("item", "OLD", { id: "T1", status: "进行中" })], "OLD")).toContain("no owner agent or no done_when");
	expect(blocker([base])).toContain('no passing review of the task as a whole (latest: none)');
	expect(blocker([base])).toContain('name="TaskAReview"');
	expect(blocker([base, pass, fail])).toContain("latest: fail by TaskAReview2");
	expect(blocker([base, fail, pass])).toBeUndefined();
});

test("重新打开的任务：之前的通过不算数，再完成要重新审", () => {
	const l = foldEvents([
		ev("task", "A", { agent: "TaskA", done_when: "x" }),
		ev("review", "A", { verdict: "pass", by: "TaskAReview", evidence: "e" }),
		ev("task", "A", { status: "完成" }),
		ev("task", "A", { status: "进行中" }),
	]);
	expect(doneBlocker(l, "A")).toContain("latest: none");
});

test("事项的审查记在事项上，不算整个任务的；重新打开的事项，之前的通过不算数", () => {
	const events = [
		ev("task", "A", { agent: "TaskA", done_when: "x" }),
		ev("item", "A", { id: "T1", status: "待审查" }),
		ev("review", "A", { item: "T1", verdict: "pass", by: "TaskAReview", evidence: "e" }),
		ev("item", "A", { id: "T1", status: "完成" }),
	];
	const l = foldEvents(events);
	expect(l.items.get("A")?.get("T1")?.review?.verdict).toBe("pass");
	expect(l.tasks.get("A")?.review).toBeUndefined();
	expect(foldEvents([...events, ev("item", "A", { id: "T1", status: "进行中" })]).items.get("A")?.get("T1")?.review).toBeUndefined();
});

test("任务下的事项都关闭了、完成的过了审查：任务可以直接记完成；还有没关闭的事项就要整个任务的审查", () => {
	const events = [
		ev("task", "A", { agent: "TaskA", done_when: "x" }),
		ev("item", "A", { id: "T1", status: "待审查" }),
		ev("item", "A", { id: "T2", status: "进行中" }),
		ev("review", "A", { item: "T1", verdict: "pass", by: "TaskAReview", evidence: "e" }),
		ev("item", "A", { id: "T1", status: "完成" }),
	];
	expect(doneBlocker(foldEvents(events), "A")).toContain("its items are not all closed with a passing review each");
	const closed = [...events, ev("item", "A", { id: "T2", status: "取消" })];
	expect(doneBlocker(foldEvents(closed), "A")).toBeUndefined();
	// 全是取消的、没有一项审过：不算
	expect(doneBlocker(foldEvents([ev("task", "B", { agent: "TaskB", done_when: "x" }), ev("item", "B", { id: "T1", status: "取消" })]), "B")).toContain("no passing review");
	// 有一项是完成但没审过（这道关卡之前记的）：不算
	expect(doneBlocker(foldEvents([ev("task", "C", { agent: "TaskC", done_when: "x" }), ev("item", "C", { id: "T0", status: "完成" }), ev("item", "C", { id: "T1", status: "待审查" }), ev("review", "C", { item: "T1", verdict: "pass", by: "TaskCReview", evidence: "e" }), ev("item", "C", { id: "T1", status: "完成" })]), "C")).toContain("no passing review");
	// 任务记完成后又打开：事项各自审过不算，要整个任务重新审
	const reopened = [...closed, ev("task", "A", { status: "完成" }), ev("task", "A", { status: "进行中" })];
	expect(doneBlocker(foldEvents(reopened), "A")).toContain("a reopened task needs a new review of the task as a whole");
	expect(doneBlocker(foldEvents([...reopened, ev("review", "A", { verdict: "pass", by: "TaskAReview2", evidence: "e" })]), "A")).toBeUndefined();
});

test("哪些状态要先有通过的审查：完成类的要，取消和进行中的不用", () => {
	expect(["完成", "done", "已完成", "merged"].map(needsReview)).toEqual([true, true, true, true]);
	expect(["取消", "cancelled", "进行中", ""].map(needsReview)).toEqual([false, false, false, false]);
});

test("事项的 state、waiting_on、by 折叠进事项；只给 state 时 status 跟着变", () => {
	const l = foldEvents([
		ev("item", "PROJ-9", { id: "T1", title: "等审", status: "进行中" }),
		ev("item", "PROJ-9", { id: "T1", state: "完成", by: "Proj9" }),
		ev("item", "PROJ-9", { id: "T2", state: "等别人", status: "待 Bo 审 ADR", waiting_on: "Bo" }),
	]);
	expect(l.items.get("PROJ-9")?.get("T1")).toMatchObject({ state: "完成", status: "完成", by: "Proj9" });
	expect(l.items.get("PROJ-9")?.get("T2")).toMatchObject({ state: "等别人", status: "待 Bo 审 ADR", waiting_on: "Bo" });
});

test("交回没记任务表：记下；之后这个任务有事项更新就清掉。需要整理按原因列出", () => {
	const l = foldEvents([
		ev("item", "PROJ-8", { id: "T1", title: "等审", state: "等别人", status: "等别人" }),
		ev("unrecorded", "PROJ-8", { agent: "Proj8", handback: "做完" }),
	]);
	expect(l.unrecorded.get("PROJ-8")).toMatchObject({ agent: "Proj8", handback: "做完" });
	expect(tidyItems(l, "PROJ-8", "2026-11-30")[0].reasons).toEqual(expect.arrayContaining(["等别人但没写催办日期", "没写等谁"]));
	const l2 = foldEvents([ev("unrecorded", "PROJ-8", { agent: "Proj8", handback: "做完" }), ev("item", "PROJ-8", { id: "T1", next: "x", by: "main" })]);
	expect(l2.unrecorded.has("PROJ-8")).toBe(true);
	const l3 = foldEvents([ev("unrecorded", "PROJ-8", { agent: "Proj8", handback: "做完" }), ev("item", "PROJ-8", { id: "T1", next: "x", by: "Proj8.Helper" })]);
	expect(l3.unrecorded.has("PROJ-8")).toBe(false);
});
