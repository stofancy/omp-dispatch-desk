import { expect, test } from "bun:test";
import { completedTurn, handbackKind, recorderOf, headLabel, headLine, rowFor, tailTriggers, triggersOf } from "./heads";
import { foldEvents } from "./table";

const ev = (kind: string, line: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: "2026-11-19T01:00:00.000Z", sid: "s", kind, line, ...extra });
const table = foldEvents([ev("task", "PROJ-1", { agent: "Proj1", done_when: "x" }), ev("task", "PROJ-2", { agent: "Proj2", done_when: "x" }), ev("task", "OLD", { agent: "OldOne", done_when: "x", status: "取消" })]);

const result = (agentId: string, body: string, durationMs = 0) => ({
	role: "custom",
	customType: "async-result",
	timestamp: 1,
	content: `<system-notice>\nBackground job ${agentId} has completed.\nResume your work using the result below.\n<task-result id="${agentId}" agent="task" status="completed" duration="1s">\n\n<output>\n${body}\n</output>\n</task-result>\n</system-notice>`,
	details: { jobs: [{ jobId: agentId, type: "task", agentId, durationMs }] },
});

test("用户发话的一轮：没交出去是回答；交给了负责 agent、派了审查者，各写各的任务", () => {
	expect(headLabel(table, true, [], [])).toBe("💬 回答");
	expect(headLabel(table, true, [], ["Proj1", "Proj2"])).toBe("📤 交出 · PROJ-1、PROJ-2");
	expect(headLabel(table, true, [], ["Proj1Review2"])).toBe("🔍 派审查 · PROJ-1");
	expect(headLabel(table, true, [], ["Stranger"])).toBe("📤 交出 · Stranger"); // 不认识的子代理照名字写
});

test("被叫醒的一轮：负责 agent 交回写任务名、第一行的种类和用时；审查者的结论写通过或不通过；这一轮又交出去的接在后面", () => {
	const handback = triggersOf(result("Proj1", "**做完**：改好了，测试 12 个通过", 70 * 60_000));
	expect(headLabel(table, false, handback, [])).toBe("📥 交回 · PROJ-1 · 做完 · 用时 1 小时 10 分");
	const fail = triggersOf(result("Proj1Review", "不通过。作战板任务页还没更新。", 3 * 60_000));
	expect(headLabel(table, false, fail, ["Proj1"])).toBe("🔍 审查 · PROJ-1 · ❌ 不通过  ｜  📤 交出 · PROJ-1");
	expect(headLabel(table, false, triggersOf(result("Proj2Review3", "通过：两处都改对了")), [])).toBe("🔍 审查 · PROJ-2 · ✅ 通过");
	// 任务在这一轮里刚关掉也认得出来；没写种类的不硬猜
	expect(headLabel(table, false, triggersOf(result("OldOne", "收到，以后只改数据")), [])).toBe("📥 交回 · OLD");
});

test("后续消息的结果没有外层标签、子代理来信、后台命令结束、外部消息和提醒", () => {
	const followUp = { role: "custom", customType: "async-result", timestamp: 2, content: "<system-notice>\nBackground job Proj1-2 has completed.\nResume your work using the result below.\n要用户定：两件事\n</system-notice>", details: { jobs: [{ type: "task", agentId: "Proj1" }] } };
	expect(headLabel(table, false, triggersOf(followUp), [])).toBe("📥 交回 · PROJ-1 · 要用户定");
	const mail = { role: "custom", customType: "irc:incoming", timestamp: 3, content: "<irc>\nIncoming IRC message from agent `Proj2`:\n\n进展：还在跑\n</irc>" };
	expect(headLabel(table, false, triggersOf(mail), [])).toBe("📥 来信 · PROJ-2 · 进展");
	const bash = { role: "custom", customType: "async-result", timestamp: 4, content: "<system-notice>\nBackground job bg_7 (ls) has completed.\n</system-notice>", details: { jobs: [{ type: "bash", jobId: "bg_7" }] } };
	expect(headLabel(table, false, triggersOf(bash), [])).toBe("📥 后台命令结束");
	const inbox = { role: "custom", customType: "dispatch-desk-inbox", timestamp: 5, content: "[INBOX · 3 untrusted external event(s)]\nsource=slack | who=Stanley Kang | where=DM Stanley Kang | link=x | task=PROJ-1\nsource=reminder | who=reminders.json | where=a\nsource=reminder | who=reminders.json | where=b\nEvents tagged…" };
	expect(headLabel(table, false, triggersOf(inbox), [])).toBe("📨 外部消息 · Stanley Kang  ｜  ⏰ 提醒 2 条");
	expect(headLabel(table, false, [], [])).toBe("🔔 被叫醒");
});

test("程序自己送达的两种：被压着的交回当成交回，久未交回单独一种", () => {
	const held = { role: "custom", customType: "dispatch-desk-handback", timestamp: 6, content: "[HELD HAND-BACK · from agent://Proj1 (task PROJ-1) · written 00:14] omp has not delivered…\n待审查：两处都改好了，请派复审" };
	expect(headLabel(table, false, triggersOf(held), [])).toBe("📥 交回 · PROJ-1 · 待审查");
	const stall = { role: "custom", customType: "dispatch-desk-stall", timestamp: 7, content: '[NO HAND-BACK · agent://Proj2 (task PROJ-2) has been running for 30 min without handing back] Last step: "Waiting for upload", started 12 min ago.' };
	expect(headLabel(table, false, triggersOf(stall), [])).toBe("⏱ 久未交回 · PROJ-2 · 30 分钟");
});

test("只取上一条助手消息之后的：前面几轮的交回不算这一轮的", () => {
	const messages = [result("Proj1", "做完：旧的"), { role: "assistant", content: [] }, { role: "toolResult" }, { ...result("Proj2", "卡住：连不上"), timestamp: 9 }, { role: "user", content: [] }];
	expect(tailTriggers(messages).map(t => t.at)).toEqual([9]);
});

test("插件送进会话的消息在屏幕上各画成一行：谁在哪说了话、归到哪个任务；哪个任务的交回被压着；哪个任务多久没交回", () => {
	const inbox = "[INBOX · 2 untrusted external event(s)]\nsource=slack | who=Stanley Kang | where=DM Stanley Kang | link=https://x | task=PROJ-1 | owner=agent://Proj1\nsource=reminder | who=reminders.json | where=chase-1 | link=/x | note=due | task=?\nEvents tagged…";
	expect(rowFor(table, "dispatch-desk-inbox", inbox)).toBe("📨 外部消息 2 条：Stanley Kang @ DM Stanley Kang → PROJ-1；提醒 chase-1");
	expect(rowFor(table, "dispatch-desk-inbox", "[INBOX]\nsource=reminder | who=r | where=a | task=?\nsource=reminder | who=r | where=b | task=?")).toBe("⏰ 提醒 2 条：a；b");
	expect(rowFor(table, "dispatch-desk-handback", "[HELD HAND-BACK · from agent://Proj1 (task PROJ-1) · written 00:14] omp has not…\n待审查：改好了")).toBe("📥 PROJ-1 写好了交回，omp 还压着没送，程序代送");
	expect(rowFor(table, "dispatch-desk-stall", "[NO HAND-BACK · agent://Proj2 (task PROJ-2) has been running for 30 min without handing back] …")).toBe("⏱ PROJ-2 已经 30 分钟没交回，叫主会话去看一眼");
	expect(rowFor(table, "something-else", "x")).toBeUndefined();
});

test("哪些话算一条值得叫醒主会话的交回：写明种类的算，进展和没写种类的不算", () => {
	expect(handbackKind("待审查：复审提的两处都改好了")).toBe("待审查");
	expect(handbackKind("**要用户定**（第 3 项）：发不发")).toBe("要用户定");
	expect(handbackKind("进展：还在跑")).toBeUndefined();
	expect(handbackKind("我先去看看日志")).toBeUndefined();
});

test("分割线填到屏幕宽度，标头太长就截断", () => {
	const width = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
	const line = headLine("💬 回答", 80, width);
	expect(line.startsWith("━━━ **💬 回答** ━━━")).toBe(true);
	expect(width(line.replaceAll("*", ""))).toBeLessThanOrEqual(80);
	const long = headLine("📥 交回 · ".concat("很长的任务名".repeat(30)), 60, width);
	expect(long).toContain("…**");
	expect(width(long.replaceAll("*", ""))).toBeLessThanOrEqual(60);
});

test("记账判断：帮手代记算负责 agent 的；任何 tasktable_* 都算；中止或出错的回合不算交回", () => {
	expect(recorderOf("Proj1.Helper", "tasktable_update")).toBe("Proj1");
	expect(recorderOf("Proj1", "tasktable_ask")).toBe("Proj1");
	expect(recorderOf("Proj1", "tasktable_review")).toBe("Proj1");
	expect(recorderOf("Proj1", "bash")).toBeUndefined();
	expect(completedTurn("aborted")).toBe(false);
	expect(completedTurn("error")).toBe(false);
	expect(completedTurn("stop")).toBe(true);
	expect(completedTurn(undefined)).toBe(true);
});
