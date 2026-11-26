import { expect, test } from "bun:test";
import { buildBoard, kindOf } from "./board";

let n = 0;
const ev = (kind: string, line: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ts: new Date(Date.UTC(2026, 10, 18, 0, 0, n++)).toISOString(), sid: "s", kind, line, ...extra });

test("自由文本状态粗分成几类", () => {
	expect(kindOf("完成")).toBe("done");
	expect(kindOf("取消")).toBe("cancelled");
	expect(kindOf("等你")).toBe("you");
	expect(kindOf("要用户定")).toBe("you");
	expect(kindOf("卡住")).toBe("blocked");
	expect(kindOf("等别人（Carlos）")).toBe("waiting");
	expect(kindOf("做完（待主会话验收）")).toBe("review");
	expect(kindOf("待审查")).toBe("review");
	expect(kindOf("进行中（每天）")).toBe("active");
});

test("看板：只列未关闭任务，进度和到期催办按事项算，日常有未关闭事项时也列出", () => {
	const d = buildBoard(
		[
			ev("task", "PROJ-1", { title: "修登录", agent: "Proj1", done_when: "测试通过" }),
			ev("item", "PROJ-1", { id: "T1", title: "改代码", status: "完成" }),
			ev("item", "PROJ-1", { id: "T2", title: "等评审", status: "等别人（Bo）", chase: "2026-11-20" }),
			ev("item", "PROJ-1", { id: "T3", title: "选方案", status: "等你" }),
			ev("ask", "PROJ-1", { n: 4, text: "选 A 还是 B" }),
			ev("decision", "PROJ-1", { date: "2026-11-18", text: "用 A" }),
			ev("task", "PROJ-2", { title: "旧任务", agent: "Proj2", done_when: "x", status: "完成" }),
			ev("item", "日常", { id: "T1", title: "杂事", status: "进行中" }),
			"{半行",
		],
		"2026-11-21",
	);
	expect(d.tasks.map(t => t.name).sort()).toEqual(["PROJ-1", "日常"]);
	expect(d.closed.map(t => t.name)).toEqual(["PROJ-2"]);
	const p = d.tasks.find(t => t.name === "PROJ-1");
	expect(p?.progress).toEqual({ done: 1, closed: 1, total: 3 });
	expect(p?.chaseDue).toBe(1);
	expect(p?.asks).toEqual([4]);
	expect(p?.decisions).toEqual([{ date: "2026-11-18", text: "用 A" }]);
	expect(d.summary).toMatchObject({ tasks: 1, items: 3, you: 1, waiting: 1, chaseDue: 1, asks: 1 });
	expect(d.attention.map(i => `${i.task}/${i.id}`).sort()).toEqual(["PROJ-1/T2", "PROJ-1/T3"]);
});
