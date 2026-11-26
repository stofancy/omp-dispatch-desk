// 外部消息源共用：数据目录、配置、写外部消息。和 inbox.py 保持同一套文件名规则，两边写同一条消息只进一次。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.DISPATCH_DESK_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "dispatch-desk");
const INBOX = join(HOME, "inbox");

export interface Secret { file: string; json_key?: string }
export interface SlackConfig { domain: string; me: string; user_token: Secret; app_token: Secret; channels: Record<string, { name: string; line?: string }> }
export interface FeishuAccount { profile: string; bot: boolean; poll: boolean }
export interface FeishuConfig { accounts: FeishuAccount[] }
export interface Config { slack?: SlackConfig; feishu?: FeishuConfig; triage?: { about?: string; model?: string; command?: string }; reminders?: { file?: string } }

export const config: Config = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8"));

const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
export function readSecret(s: Secret): string {
	const raw = readFileSync(expand(s.file), "utf8");
	return (s.json_key ? JSON.parse(raw)[s.json_key] : raw).trim();
}

export interface InboxEvent { source: string; who: string; where: string; link: string; line?: string; note?: string; urgent?: boolean; text?: string; parent?: string }

interface OperatorEvent {
	source: "feishu";
	profile: string;
	chat_id: string;
	chat_type: "p2p" | "group";
	chat_name: string;
	message_id: string;
	text: string;
	link: string;
	at: string;
}

function writeInboxEvent(inbox: string, ev: InboxEvent | OperatorEvent, key: string, orderNs: bigint): boolean {
	const suffix = `${ev.source}-${key}`;
	const seen = (dir: string) => existsSync(dir) && readdirSync(dir).some(f => f.endsWith(`-${suffix}.json`));
	if (seen(join(inbox, "new")) || seen(join(inbox, "claimed"))) return false;
	const name = `${String(orderNs).padStart(19, "0")}-${suffix}.json`;
	mkdirSync(join(inbox, "new"), { recursive: true });
	const tmp = join(inbox, `.${name}.tmp`);
	const body = "message_id" in ev ? ev : Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined && v !== ""));
	writeFileSync(tmp, JSON.stringify(body));
	renameSync(tmp, join(inbox, "new", name)); // 先写临时文件再改名，插件不会读到半个文件
	return true;
}

// 文件名由 key 决定：同一条消息不论实时推送还是轮询补读，都只进一次。返回 false 表示已有
export function writeEvent(ev: InboxEvent, key: string, orderNs: bigint): boolean {
	return writeInboxEvent(INBOX, ev, key, orderNs);
}

export function writeOperatorEvent(ev: OperatorEvent, orderNs: bigint): boolean {
	return writeInboxEvent(join(INBOX, "operator"), ev, ev.message_id, orderNs);
}

// 记一笔这个程序的工作状态（和 inbox.py 的 health 同一种文件）：成功时记时间并清掉上次的错，失败时保留上次成功的时间
export function writeHealth(key: string, label: string, everyS: number, error?: string): void {
	const dir = join(HOME, "state", "health");
	const path = join(dir, `${key}.json`);
	let okAt: string | undefined;
	if (error === undefined) okAt = new Date().toISOString();
	else {
		try {
			okAt = JSON.parse(readFileSync(path, "utf8")).ok_at;
		} catch {}
	}
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${key}.json.tmp`);
	writeFileSync(tmp, JSON.stringify({ label, every_s: everyS, ok_at: okAt, ...(error === undefined ? {} : { error: error.slice(0, 300), error_at: new Date().toISOString() }) }));
	renameSync(tmp, path);
}

// 未完成任务登记的盯办项（插件写在 state/watch.json），文件变了才重读。
export interface SlackWatch { channels: Map<string, string>; threads: Map<string, string> }
interface ChatWatch { slack: SlackWatch; feishu: Map<string, string | undefined> }
let watchCache: { mtime: number; watch: ChatWatch } | undefined;
function chatWatch(): ChatWatch {
	const path = join(HOME, "state", "watch.json");
	let mtime = 0;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {}
	if (watchCache?.mtime === mtime) return watchCache.watch;
	const watch: ChatWatch = { slack: { channels: new Map(), threads: new Map() }, feishu: new Map() };
	try {
		const plan = JSON.parse(readFileSync(path, "utf8"));
		for (const w of (plan.slack ?? []) as Array<{ task: string; channel: string; thread?: string }>) {
			if (w.thread) watch.slack.threads.set(`${w.channel}:${w.thread}`, w.task);
			else watch.slack.channels.set(w.channel, w.task);
		}
		for (const w of (plan.feishu ?? []) as Array<{ task: string; chat: string; whole?: boolean }>) {
			// 单条消息登记也要读会话，但只有整个会话登记才带任务名。
			if (w.whole === true) watch.feishu.set(w.chat, w.task);
			else if (!watch.feishu.has(w.chat)) watch.feishu.set(w.chat, undefined);
		}
	} catch {
		// 没有这个文件，或正在写：当作没有登记
	}
	watchCache = { mtime, watch };
	return watch;
}

export function slackWatch(): SlackWatch {
	return chatWatch().slack;
}

export function feishuWatch(): ReadonlyMap<string, string | undefined> {
	return chatWatch().feishu;
}
