import { expect, test } from "bun:test";
import { foldEvents } from "./table";
import { due, tierOf } from "./tiers";

let n = 0;
const ev = (kind: string, line: string, extra: Record<string, unknown> = {}, ts = new Date(Date.UTC(2026, 10, 18, 0, 0, n++)).toISOString()) => JSON.stringify({ ts, sid: "s", kind, line, ...extra });
const NOW = Date.UTC(2026, 10, 20);
const l = foldEvents([
	ev("task", "OPEN-1", { agent: "Open1", done_when: "x", watch_add: ["https://x.slack.com/archives/C1/p1700000000000100"] }),
	ev("task", "RECENT-1", { agent: "Recent1", done_when: "x", watch_add: ["https://x.slack.com/archives/C2/p1700000000000200"] }),
	ev("task", "RECENT-1", { status: "完成" }, new Date(NOW - 2 * 86_400_000).toISOString()),
	ev("task", "OLD-1", { agent: "Old1", done_when: "x", watch_add: ["https://x.slack.com/archives/C3/p1700000000000300"] }),
	ev("task", "OLD-1", { status: "完成" }, new Date(NOW - 10 * 86_400_000).toISOString()),
]);

test("分档：私信/@/提醒和未完成任务相关的马上送；已完成任务（不论多久）和没归属的攒着", () => {
	expect(tierOf(l, { urgent: true, link: "https://x.slack.com/archives/D9/p1700000000000900" })).toBe("high");
	expect(tierOf(l, { link: "https://x.slack.com/archives/C1/p1700000000000101?thread_ts=1700000000.000100" })).toBe("high");
	expect(tierOf(l, { line: "OPEN-1", link: "https://github.com/o/r/pull/1" })).toBe("high");
	expect(tierOf(l, { link: "https://x.slack.com/archives/C2/p1700000000000201?thread_ts=1700000000.000200" })).toBe("held");
	expect(tierOf(l, { link: "https://x.slack.com/archives/C8/p1700000000000800", note: "triage: unsure" })).toBe("held");
	expect(tierOf(l, { link: "https://x.slack.com/archives/C3/p1700000000000301?thread_ts=1700000000.000300", line: "OLD-1" })).toBe("held");
});

test("送的时机：马上送的停 1 分钟或最早等满 5 分钟就送；只有攒着的等满 30 分钟", () => {
	const t = { quietMs: 60_000, maxMs: 300_000, digestMs: 1_800_000 };
	expect(due([{ tier: "high", at: 0 }], 30_000, t)).toBe(false);
	expect(due([{ tier: "high", at: 0 }], 60_000, t)).toBe(true);
	expect(due([{ tier: "high", at: 0 }, { tier: "high", at: 250_000 }], 290_000, t)).toBe(false);
	expect(due([{ tier: "high", at: 0 }, { tier: "high", at: 280_000 }], 300_000, t)).toBe(true);
	expect(due([{ tier: "held", at: 0 }, { tier: "high", at: 100_000 }], 130_000, t)).toBe(false);
	expect(due([{ tier: "held", at: 0 }], 1_700_000, t)).toBe(false);
	expect(due([{ tier: "held", at: 0 }], 1_800_000, t)).toBe(true);
	expect(due([], 9e9, t)).toBe(false);
});
