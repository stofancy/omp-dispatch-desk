// 回复上方的标头：这一条回复是回答用户、把活交出去了，还是谁交回来了。只改显示，不进会话历史和模型上下文。
//
// 为什么由程序画：工具活动被隐藏时，派出和交回在屏幕上都看不见，几条回复连在一起分不清哪条是派出的确认、哪条是结果。
// 是谁叫醒了这一轮、这一轮把活交给了谁，程序都知道，不用模型自己写。
import { type Table, isDone, ownerOfReviewer } from "./table";

// 叫醒这一轮的东西
export type Trigger =
	| { kind: "job"; agent?: string; first: string; durationMs?: number } // 后台任务结束：子代理交回（agent 有值），或后台命令结束
	| { kind: "mail"; agent: string; first: string } // 子代理发来的消息
	| { kind: "stall"; agent: string; minutes: number } // 子代理很久没交回，程序叫醒主会话去看
	| { kind: "inbox"; reminders: number; others: number; who: string[] }; // 外部消息

interface Custom { role?: string; customType?: string; content?: unknown; timestamp?: number; details?: { jobs?: Array<{ agentId?: string; type?: string; durationMs?: number }> } }

const textOf = (content: unknown): string =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map(b => (b && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text ?? "") : "")).join("\n") : "";

// 交回内容的第一行：跳过 omp 包在外面的标签和说明
function firstLine(body: string): string {
	for (const raw of body.split("\n")) {
		const line = raw.replace(/[*`#>]/g, "").trim();
		if (line && !line.startsWith("<") && !/^(Background job|Resume your work|Incoming IRC message)/.test(line)) return line;
	}
	return "";
}

// 一条消息是不是叫醒这一轮的：是就返回它带来的触发（一条后台结果里可能有几个任务）
export function triggersOf(message: unknown): Trigger[] {
	const m = message as Custom;
	if (m?.role !== "custom") return [];
	const body = textOf(m.content);
	if (m.customType === "async-result") {
		const jobs = m.details?.jobs ?? [];
		// 几个任务合在一条里时，各自的第一行按 <task-result id> 找；只有一个时整段的第一行就是它的
		const sectionOf = (id?: string) => (id && jobs.length > 1 ? (new RegExp(`<task-result id="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</task-result>`).exec(body)?.[1] ?? "") : body);
		if (!jobs.length) return [{ kind: "job", first: firstLine(body) }];
		return jobs.map(j => ({ kind: "job", agent: j.type === "task" ? j.agentId : undefined, first: firstLine(sectionOf(j.agentId)), durationMs: j.durationMs }));
	}
	if (m.customType === "irc:incoming") {
		const agent = /from agent `([^`]+)`/.exec(body)?.[1];
		return agent ? [{ kind: "mail", agent, first: firstLine(body.replace(/^[\s\S]*?:\n\n/, "")) }] : [];
	}
	if (m.customType === "dispatch-desk-inbox") {
		const lines = body.split("\n").filter(l => l.startsWith("source="));
		const reminders = lines.filter(l => l.startsWith("source=reminder")).length;
		const who = [...new Set(lines.filter(l => !l.startsWith("source=reminder")).map(l => /\| who=([^|]+)/.exec(l)?.[1]?.trim() ?? "").filter(Boolean))];
		return [{ kind: "inbox", reminders, others: lines.length - reminders, who }];
	}
	// 插件自己送达的：被 omp 压着的交回、久未交回的提醒（正文格式见 index.ts）
	if (m.customType === "dispatch-desk-handback") {
		const agent = /agent:\/\/([^\s·)\]]+)/.exec(body)?.[1];
		return agent ? [{ kind: "job", agent, first: firstLine(body.slice(body.indexOf("\n") + 1)) }] : [];
	}
	if (m.customType === "dispatch-desk-stall") {
		const hit = /agent:\/\/([^\s·)\]]+)[^\n]*?(\d+) min/.exec(body);
		return hit ? [{ kind: "stall", agent: hit[1], minutes: Number(hit[2]) }] : [];
	}
	return [];
}

// 从请求的消息末尾往回找到上一条助手消息为止：中间的就是叫醒这一轮（或这一轮中途到）的消息
export function tailTriggers(messages: unknown[]): Array<{ at: number; triggers: Trigger[] }> {
	const out: Array<{ at: number; triggers: Trigger[] }> = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as Custom;
		if (m?.role === "assistant") break;
		const triggers = triggersOf(m);
		if (triggers.length && typeof m.timestamp === "number") out.unshift({ at: m.timestamp, triggers });
	}
	return out;
}

// 负责 agent 交回时第一行写明的种类（见负责人规则）、审查者的结论
const KIND = /^(不通过|通过|进展|等别人|要用户定|做完|待审查|卡住|不归我)/;

// 一段回复是不是一条交回，是的话是哪一种。「进展」不算：没人等的进展不值得为它叫醒主会话
// 调了任务表工具（任何一个 tasktable_*）就算这一轮记过账；帮手代记的算到它所属的负责 agent 名下
export const recorderOf = (agentId: string, toolName: string): string | undefined => (agentId && toolName.startsWith("tasktable_") ? agentId.split(".")[0] : undefined);
// 被中止或出错的回合不算交回
export const completedTurn = (stopReason?: string): boolean => stopReason !== "aborted" && stopReason !== "error";

export function handbackKind(text: string): string | undefined {
	const kind = KIND.exec(firstLine(text))?.[1];
	return kind === "进展" ? undefined : kind;
}

function duration(ms?: number): string {
	if (!ms || ms < 60_000) return "";
	const min = Math.round(ms / 60_000);
	return ` · 用时 ${min < 60 ? `${min} 分钟` : `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ""}`}`;
}

// 子代理是哪个任务的什么角色。关闭的任务也认：任务常在这一轮里刚被记成完成
function roleOf(l: Table, agent: string): { task?: string; reviewer: boolean } {
	const top = agent.split(".")[0];
	const taskOf = (name: string) => [...l.tasks.values()].filter(t => t.agent === name).sort((a, b) => Number(isDone(a.status)) - Number(isDone(b.status)))[0]?.name;
	const own = taskOf(top);
	if (own) return { task: own, reviewer: false };
	const owner = ownerOfReviewer(top);
	const reviewed = owner ? taskOf(owner) : undefined;
	return { task: reviewed, reviewer: !!reviewed };
}

// 一个触发 → 标头里的一段
function part(l: Table, t: Trigger): string {
	if (t.kind === "inbox") {
		const bits: string[] = [];
		if (t.others) bits.push(`📨 外部消息${t.who.length ? ` · ${t.who.slice(0, 2).join("、")}${t.who.length > 2 ? " 等" : ""}` : ` ${t.others} 条`}`);
		if (t.reminders) bits.push(`⏰ 提醒 ${t.reminders} 条`);
		return bits.join(SEP);
	}
	if (!t.agent) return "📥 后台命令结束";
	const { task, reviewer } = roleOf(l, t.agent);
	if (t.kind === "stall") return `⏱ 久未交回 · ${task ?? t.agent} · ${t.minutes} 分钟`;
	const kind = KIND.exec(t.first)?.[1];
	if (reviewer) return `🔍 审查 · ${task}${kind === "通过" ? " · ✅ 通过" : kind === "不通过" ? " · ❌ 不通过" : ""}`;
	const what = t.kind === "mail" ? "来信" : "交回";
	return `📥 ${what} · ${task ?? t.agent}${kind && kind !== "通过" && kind !== "不通过" ? ` · ${kind}` : ""}${t.kind === "job" ? duration(t.durationMs) : ""}`;
}

const SEP = "  ｜  ";

// 这一轮把活交给了谁 → 标头里的一段；没交出去返回空
function handed(l: Table, out: string[]): string {
	const owners = new Set<string>();
	const reviews = new Set<string>();
	for (const agent of out) {
		const { task, reviewer } = roleOf(l, agent);
		(reviewer ? reviews : owners).add(task ?? agent);
	}
	return [owners.size ? `📤 交出 · ${[...owners].join("、")}` : "", reviews.size ? `🔍 派审查 · ${[...reviews].join("、")}` : ""].filter(Boolean).join(SEP);
}

// 标头的文字。user：这一轮是用户发话引起的；out：这一轮里主会话派出或发过消息的子代理
export function headLabel(l: Table, user: boolean, triggers: Trigger[], out: string[]): string {
	const parts = [...new Set(triggers.map(t => part(l, t)).filter(Boolean))];
	const gave = handed(l, out);
	if (user) parts.unshift(gave || "💬 回答");
	else if (gave) parts.push(gave);
	return parts.length ? parts.join(SEP) : "🔔 被叫醒";
}

// 画成一行分割线：━━━ 标头 ━━━━━━（填到屏幕宽度）。width 是字符串在终端里占的列数
export function headLine(label: string, cols: number, width: (s: string) => number): string {
	const room = Math.max(40, Math.min(cols - 4, 120));
	let text = label;
	while (width(text) > room - 12 && text.length > 1) text = text.slice(0, -1);
	if (text !== label) text += "…";
	return `━━━ **${text}** ${"━".repeat(Math.max(3, room - width(text) - 5))}`;
}

// 插件自己送进会话的三种消息在屏幕上各画成一行：正文是给模型看的英文说明，用户要看再展开
export function rowFor(l: Table, customType: string, content: string): string | undefined {
	if (customType === "dispatch-desk-inbox") {
		const field = (line: string, key: string) => new RegExp(`(?:^|\\| )${key}=([^|]+)`).exec(line)?.[1]?.trim();
		const lines = content.split("\n").filter(s => s.startsWith("source="));
		const reminders = lines.filter(s => field(s, "source") === "reminder").map(s => field(s, "where") ?? "?");
		const others = lines
			.filter(s => field(s, "source") !== "reminder")
			.map(s => {
				const task = field(s, "task");
				return `${field(s, "who") ?? "?"} @ ${field(s, "where") ?? "?"}${task && !task.startsWith("?") ? ` → ${task}` : ""}`;
			});
		if (!others.length) return `⏰ 提醒 ${reminders.length} 条：${reminders.join("；")}`;
		return `📨 外部消息 ${lines.length} 条：${[...others, ...reminders.map(r => `提醒 ${r}`)].join("；")}`;
	}
	const t = triggersOf({ role: "custom", customType, content })[0];
	if (!t || t.kind === "inbox" || !t.agent) return undefined;
	const who = roleOf(l, t.agent).task ?? t.agent;
	if (customType === "dispatch-desk-handback") return `📥 ${who} 写好了交回，omp 还压着没送，程序代送`;
	if (t.kind === "stall") return `⏱ ${who} 已经 ${t.minutes} 分钟没交回，叫主会话去看一眼`;
	return undefined;
}
