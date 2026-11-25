// 以各账号的 bot 身份接收使用者输入和任务登记的飞书群消息。
import type { Subprocess } from "bun";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config, feishuWatch, writeEvent, writeHealth, writeOperatorEvent, type FeishuAccount } from "./config";

interface FeishuMessage {
	message_id: string;
	chat_id: string;
	chat_type: "group" | "p2p";
	sender_id: string;
	message_type: string;
	content?: string;
	create_time: string;
	mentions?: { id: string; key?: string; name?: string }[];
	root_id?: string;
}
interface AuthStatus { identities?: { user?: { openId?: string } } }
interface MessageDetails { messages: { message_app_link?: string; sender?: { name?: string } }[] }
interface Identity { owner: string; bot: string }
interface MessageContext { link?: string; who?: string; chatName?: string }
type Route = { text: string } | { line?: string; urgent?: boolean };
interface Feed {
	account: FeishuAccount;
	identity?: Identity;
	names: Map<string, string>;
	child?: Subprocess<"pipe", "pipe", "pipe">;
	error?: string;
}

const EVENT = "im.message.receive_v1";
const READY = `[event] ready event_key=${EVENT}`;
const env = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1" };
const stop = new AbortController();
const feeds: Feed[] = (config.feishu?.accounts ?? []).filter(a => a.bot === true).map(account => ({ account, names: new Map(), error: "连接中" }));
const log = (msg: string) => console.log(`${new Date().toLocaleString("sv-SE")} ${msg}`);

function health(): void {
	const failed = feeds.filter(f => f.error).map(f => `${f.account.profile}：${f.error}`);
	writeHealth("feishu-socket", "飞书实时推送", 60, failed.length ? failed.join("；") : undefined);
}

function startConsumer(profile: string) {
	// 无界事件流把 stdin EOF 当成停止信号，不能关闭这个管道。
	return Bun.spawn(["lark-cli", "--profile", profile, "event", "consume", EVENT, "--as", "bot"], {
		env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
	});
}

async function lark<T>(profile: string, ...args: string[]): Promise<T> {
	const child = Bun.spawn(["lark-cli", "--profile", profile, ...args], {
		env, stdout: "pipe", stderr: "pipe", signal: stop.signal, timeout: 30_000,
	});
	const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (status !== 0) throw new Error(stderr.trim() || `lark-cli exit ${status}`);
	const json = JSON.parse(stdout);
	return json.data ?? json;
}

async function ownerId(profile: string): Promise<string> {
	try {
		const status = await lark<AuthStatus>(profile, "auth", "status", "--json");
		if (status.identities?.user?.openId) return status.identities.user.openId;
	} catch {
		// auth status 拿不到时，从本机 profile 配置取用户 ID。
	}
	const { apps } = JSON.parse(readFileSync(join(homedir(), ".lark-cli", "config.json"), "utf8"));
	for (const app of apps) {
		if ((app.name || app.appId) === profile && app.users?.[0]?.userOpenId) return app.users[0].userOpenId;
	}
	throw new Error("没有找到用户 open_id");
}

const nonText: Record<string, string> = {
	image: "图片", file: "文件", audio: "语音", media: "视频", sticker: "表情",
	post: "富文本", interactive: "卡片", share_chat: "群名片", share_user: "个人名片",
};

function routeEvent(ev: FeishuMessage, { owner, bot }: Identity, watch: ReadonlyMap<string, string | undefined>): Route | undefined {
	if (!ev.message_id || !ev.chat_id || !ev.sender_id || ev.sender_id === bot || ev.message_type === "system") return;
	const direct = ev.chat_type === "p2p";
	if (!direct && ev.chat_type !== "group") return;
	const toBot = ev.mentions?.filter(m => m.id === bot) ?? [];
	if (direct || toBot.length) {
		if (ev.sender_id !== owner) return {};
		if (ev.message_type !== "text") return { text: `[${nonText[ev.message_type] ?? "非文本消息"}]` };
		let text = ev.content ?? "";
		for (const { key, name } of toBot) {
			if (key && text.includes(key)) text = text.replace(key, "");
			// lark-cli 通常已经把占位渲染成 @显示名。
			else if (name) text = text.replace(`@${name}`, "");
		}
		return { text: text.trim() };
	}
	if (!watch.has(ev.chat_id) || ev.sender_id === owner) return;
	return { line: watch.get(ev.chat_id), urgent: ev.mentions?.some(m => m.id === owner) || undefined };
}

async function messageContext(feed: Feed, ev: FeishuMessage): Promise<MessageContext> {
	const { account: { profile }, names } = feed;
	let link: string | undefined;
	let who = names.get(ev.sender_id);
	try {
		const { messages } = await lark<MessageDetails>(profile, "im", "+messages-mget", "--as", "bot", "--message-ids", ev.message_id, "--no-reactions", "--format", "json");
		link = messages[0]?.message_app_link;
		who ??= messages[0]?.sender?.name;
	} catch {
		// bot 读不到消息时降为会话链接。
	}
	if (who) names.set(ev.sender_id, who);
	let chatName = names.get(ev.chat_id);
	if (ev.chat_type === "group" && chatName === undefined && !stop.signal.aborted) {
		try {
			chatName = (await lark<{ name?: string }>(profile, "im", "chats", "get", "--as", "bot", "--chat-id", ev.chat_id, "--format", "json")).name;
		} catch {}
		names.set(ev.chat_id, chatName ?? "");
	}
	return { who, link, chatName };
}

export async function handle(line: string, profile: string, identity: Identity, context: (ev: FeishuMessage) => Promise<MessageContext>): Promise<void> {
	const ev: FeishuMessage = JSON.parse(line);
	const route = routeEvent(ev, identity, feishuWatch());
	if (!route) return;
	const {
		link = `https://applink.feishu.cn/client/chat/open?openChatId=${ev.chat_id}`,
		who = ev.sender_id,
		chatName = "",
	} = await context(ev);
	if (stop.signal.aborted) return;

	const order = BigInt(ev.create_time) * 1_000_000n;
	if ("text" in route) {
		const { chat_type, chat_id, message_id, create_time } = ev;
		if (writeOperatorEvent({ source: "feishu", profile, chat_type, chat_id, chat_name: chatName, message_id, text: route.text, link, at: new Date(Number(create_time)).toISOString() }, order)) {
			log(`${profile} 写入使用者收件箱`);
		}
		return;
	}
	const place = ev.chat_type === "p2p" ? `机器人私聊 ${who}` : chatName || ev.chat_id;
	const where = place + (ev.root_id && ev.root_id !== ev.message_id ? " (thread reply)" : "");
	if (writeEvent({ source: "feishu", who, where, link, line: route.line, urgent: route.urgent, text: ev.content?.slice(0, 1000) }, ev.message_id, order)) {
		log(`写入收件箱 ${where}${route.urgent ? "（紧急）" : ""}`);
	}
}

async function* lines(stream: ReadableStream<Uint8Array<ArrayBuffer>>) {
	const decoder = new TextDecoder();
	let pending = "";
	for await (const chunk of stream) {
		pending += decoder.decode(chunk, { stream: true });
		let start = 0;
		for (let end; (end = pending.indexOf("\n", start)) !== -1; start = end + 1) {
			yield pending.slice(start, end).trimEnd();
		}
		pending = pending.slice(start);
	}
	pending += decoder.decode();
	if (pending) yield pending;
}

async function supervise(feed: Feed): Promise<void> {
	const { profile } = feed.account;
	let backoff = 1_000;
	while (!stop.signal.aborted) {
		let retry = backoff;
		try {
			if (!feed.identity) {
				const [owner, bot] = await Promise.all([
					ownerId(profile),
					lark<{ open_id: string }>(profile, "api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "json"),
				]);
				if (!bot.open_id) throw new Error("没有找到机器人 open_id");
				feed.identity = { owner, bot: bot.open_id };
			}
			const identity = feed.identity;
			if (stop.signal.aborted) return;
			const child = feed.child = startConsumer(profile);
			let diagnostics = "";
			const stderr = (async () => {
				for await (const line of lines(child.stderr)) {
					if (line.includes(READY)) {
						feed.error = undefined;
						backoff = retry = 1_000;
						health();
						log(`${profile} ${line}`);
					} else if (line.startsWith("[event] exited")) {
						log(`${profile} ${line}`);
					} else {
						diagnostics = `${diagnostics}\n${line}`.slice(-2_000);
					}
				}
			})();
			const resolveContext = (ev: FeishuMessage) => messageContext(feed, ev);
			const stdout = (async () => {
				for await (const line of lines(child.stdout)) {
					if (stop.signal.aborted || !line) continue;
					try {
						await handle(line, profile, identity, resolveContext);
					} catch (err) {
						log(`${profile} 处理事件失败：${err}`);
					}
				}
			})();
			const [code] = await Promise.all([child.exited, stderr, stdout]);
			if (code === 2 && diagnostics.includes("another event bus is already connected")) {
				retry = 300_000;
				throw new Error("another event bus is already connected");
			}
			throw new Error(`事件流退出 (${code})${diagnostics.trim() ? `：${diagnostics.trim()}` : ""}`);
		} catch (err) {
			if (stop.signal.aborted) return;
			feed.error = err instanceof Error ? err.message : String(err);
			health();
			log(`${profile} ${feed.error}；${retry / 1000} 秒后重连`);
		} finally {
			if (feed.child && feed.child.exitCode === null && feed.child.signalCode === null) {
				feed.child.kill("SIGTERM");
				await feed.child.exited;
			}
			feed.child = undefined;
		}
		backoff = Math.min(backoff * 2, 60_000);
		try {
			await delay(retry, undefined, { signal: stop.signal });
		} catch {
			return;
		}
	}
}

if (import.meta.main && feeds.length) {
	const shutdown = () => {
		stop.abort();
		for (const feed of feeds) feed.child?.kill("SIGTERM");
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	health();
	const beat = setInterval(health, 30_000);
	try {
		await Promise.all(feeds.map(supervise));
	} finally {
		clearInterval(beat);
	}
}
