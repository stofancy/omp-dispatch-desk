// 规则的可调参数（数据目录 config.json 的 rules 段），以及回复的事后检查。
// 参数由程序填进规则文本，模型不用自己读配置。
import { existsSync, readFileSync } from "node:fs";
import { logError } from "./table";
import { CONFIG } from "./paths";

export interface RuleSettings {
	language: string; // 对用户用的语言；空 = 用户自己用的语言
	report_lines: number; // 汇报默认行数上限
	wake_lines: number; // 不是用户发话引起的回合（子代理交回、外部消息叫醒）的回复行数上限
	max_asks: number; // 一次最多问几件
	away_hours: number; // 用户隔多久再发话算「离开后回来」；0 = 不提示
	cold_read: boolean; // 对外消息发出前冷读
	owner_model: string; // 任务的负责 agent 用什么模型（模型名或 @角色）；空 = 跟主会话一样
	stall_minutes: number; // 子代理多久没交回就叫醒主会话去看一眼（之后每次翻倍）；0 = 不叫
	inbox_quiet_seconds: number; // 马上送的消息：对方停这么久没再发就送
	inbox_max_seconds: number; // 马上送的消息：对方一直在发，最多等这么久
	inbox_digest_minutes: number; // 攒着的消息：没有马上送的、用户也没说话，最晚等这么久单独送
}

const DEFAULTS: RuleSettings = {
	language: "",
	report_lines: 15,
	wake_lines: 5,
	max_asks: 3,
	away_hours: 2,
	cold_read: true,
	owner_model: "",
	stall_minutes: 15,
	inbox_quiet_seconds: 60,
	inbox_max_seconds: 300,
	inbox_digest_minutes: 30,
};
type NumKey = { [K in keyof RuleSettings]: RuleSettings[K] extends number ? K : never }[keyof RuleSettings];

// config.json 和外部事件源共用，写错一处不能让主会话丢掉规则：读不了或类型不对就用默认值
export function settings(): RuleSettings {
	let raw: Record<string, unknown> = {};
	try {
		if (existsSync(CONFIG)) raw = (JSON.parse(readFileSync(CONFIG, "utf8")) as { rules?: Record<string, unknown> }).rules ?? {};
	} catch (err) {
		logError("config.json", err);
	}
	const num = (k: NumKey) => (Number.isFinite(raw[k]) && (raw[k] as number) >= 0 ? (raw[k] as number) : DEFAULTS[k]);
	return {
		language: typeof raw.language === "string" ? raw.language : DEFAULTS.language,
		report_lines: num("report_lines"),
		wake_lines: num("wake_lines"),
		max_asks: num("max_asks"),
		away_hours: num("away_hours"),
		cold_read: typeof raw.cold_read === "boolean" ? raw.cold_read : DEFAULTS.cold_read,
		owner_model: typeof raw.owner_model === "string" ? raw.owner_model.trim() : DEFAULTS.owner_model,
		stall_minutes: num("stall_minutes"),
		inbox_quiet_seconds: num("inbox_quiet_seconds"),
		inbox_max_seconds: num("inbox_max_seconds"),
		inbox_digest_minutes: num("inbox_digest_minutes"),
	};
}

export function renderRules(template: string, s: RuleSettings): string {
	const values: Record<string, string> = {
		language: s.language || "用户自己用的语言",
		report_lines: String(s.report_lines),
		wake_lines: String(s.wake_lines),
		max_asks: String(s.max_asks),
		cold_read: s.cold_read
			? "\n- 发给别人的消息，发出前用 `completion()` 低档单次调用冷读：只给原文和读者角色，让它答「这是什么、要我做什么、哪句看不懂」；答不上来就重写。"
			: "",
	};
	return template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
}

// ---------- 回复的事后检查：不拦截，只在下一次请求里提醒模型 ----------

const SHA = /(?<![A-Za-z0-9])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![A-Za-z0-9])/g;
// 像代号的才查：带字母也带数字（T6、Q-07），纯数字不算（编号提问「1. …」本身要用）
const looksLikeCode = (s: string) => /^[A-Za-z]{1,4}-?\d+$/.test(s);

export interface ReplyCheck { lines: number; codes: string[] }

// 代码块、行内代码、链接里的不算；边界只看 ASCII，中文里紧挨汉字的「T6已完成」也要查到
export function checkReply(text: string, codes: Iterable<string>): ReplyCheck {
	const body = text
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "")
		.replace(/https?:\/\/\S+/g, "");
	const lines = body.split("\n").filter(l => l.trim()).length;
	const found = new Set<string>();
	for (const code of codes) {
		if (!looksLikeCode(code)) continue;
		const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`).test(body)) found.add(code);
	}
	for (const m of body.matchAll(SHA)) found.add(m[0]);
	return { lines, codes: [...found] };
}

// woken：这一轮不是用户发话引起的（子代理交回、外部消息叫醒）
export function feedback(c: ReplyCheck, maxLines: number | undefined, woken = false): string | undefined {
	const parts: string[] = [];
	if (maxLines !== undefined && c.lines > maxLines) {
		parts.push(
			woken
				? `上一次回复不是用户发话引起的（子代理交回或外部消息叫醒），有 ${c.lines} 行，超过这种回合的上限 ${maxLines} 行：用户没在等的进展只记任务表，攒到他下次发话再报，这种回合只留要他定的事和他在等的答复`
				: `上一次回复有 ${c.lines} 行，超过默认上限 ${maxLines} 行（用户要细节时除外）`,
		);
	}
	if (c.codes.length) parts.push(`上一次回复出现了裸代号：${c.codes.join("、")}，应换成人能看懂的名字`);
	return parts.length ? `${parts.join("；")}。` : undefined;
}
