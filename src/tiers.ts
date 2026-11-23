// 外部消息分两档：马上送（叫醒主会话）、攒着跟下一次一起送。bot 私信、分拣判无关的由消息源自己丢，到不了这里。
// 马上送：私信、@你、提醒（消息源标了 urgent），和未完成任务相关的（任务登记盯的地方、消息源标的任务）。
// 其余（分拣判相关或拿不准的、和已完成任务相关的、没归到任何任务的）攒着。
import { type Table, openTasks } from "./table";
import { type Message, matchTask } from "./watch";

export type Tier = "high" | "held";
export interface Timing { quietMs: number; maxMs: number; digestMs: number }

export function tierOf(l: Table, ev: Message & { line?: string; urgent?: boolean }): Tier {
	if (ev.urgent) return "high";
	const open = openTasks(l);
	const m = matchTask(ev, open.map(t => ({ name: t.name, watch: t.watch })));
	return m.task || m.candidates.length || open.some(t => t.name === ev.line) ? "high" : "held";
}

// 这一拍该不该送。at 是消息进收件箱的时间（ms）。有马上送的：对方停了 quiet 没再来，或最早那条已等了 max，就连同攒着的一起送；
// 只有攒着的：最早那条等满 digest 才单独送
export function due(pending: Array<{ tier: Tier; at: number }>, now: number, t: Timing): boolean {
	const high = pending.filter(p => p.tier === "high").map(p => p.at);
	if (high.length) return now - Math.max(...high) >= t.quietMs || now - Math.min(...high) >= t.maxMs;
	return pending.length > 0 && now - Math.min(...pending.map(p => p.at)) >= t.digestMs;
}
