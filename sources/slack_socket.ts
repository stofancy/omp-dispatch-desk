// Slack 实时推送（Socket Mode）常驻进程：别人发来的相关消息写成外部消息文件。只读 Slack。
//
// 哪些消息算相关：config.json 里 slack.channels 列的频道；未完成任务登记要盯的频道、私信和 thread（state/watch.json）；
// 发给你的私信和群聊私信；任何频道里 @ 到你的消息。
// 私信和 @ 标为紧急（状态栏单独计数）。外部消息写「谁、在哪、链接」，加原文和 thread 父帖（插件送进主会话时截短、转义）。
// 配了 triage 时，配置里没归到任务（没写 line）的频道里不紧急的消息要先分拣：这里不写，留给 slack_poll.py（它读原文和 thread 的开头去分拣）。
// 断线期间的事件 Slack 不会补发，由 slack_poll.py 定时补读关注的地方；两边写同一条消息只进一次。
// 连接会悄悄死掉（切 VPN、机器休眠后进程和连接都还在，但再也收不到东西）：每 30 秒发一次心跳，90 秒没回音就重连。
import { config, readSecret, slackWatch, writeEvent, writeHealth } from "./config";

const slack = config.slack;
if (!slack) throw new Error("config.json 里没有 slack 配置");
const APP_TOKEN = readSecret(slack.app_token);
const USER_TOKEN = readSecret(slack.user_token);

interface SlackMessage { type?: string; subtype?: string; channel?: string; channel_type?: string; user?: string; bot_id?: string; text?: string; ts?: string; thread_ts?: string }
interface LookupBody { ok: boolean; user?: { real_name?: string; name?: string }; channel?: { name?: string } }
interface OpenBody { ok: boolean; url?: string; error?: string }
interface Envelope { type?: string; envelope_id?: string; reason?: string; payload?: { event?: SlackMessage } }

const log = (msg: string) => console.log(`${new Date().toLocaleString("sv-SE")} ${msg}`);
const names = new Map<string, string>();

// 用户名和频道名查一次就缓存；查不到就用 ID
async function lookup(method: "users.info" | "conversations.info", key: "user" | "channel", id: string): Promise<string> {
	const cached = names.get(id);
	if (cached) return cached;
	try {
		const res = await fetch(`https://slack.com/api/${method}?${key}=${id}`, { headers: { Authorization: `Bearer ${USER_TOKEN}` } });
		const body: LookupBody = await res.json();
		const name = body.ok ? body.user?.real_name || body.user?.name || (body.channel?.name ? `#${body.channel.name}` : undefined) : undefined;
		if (name) names.set(id, name);
		return name ?? id;
	} catch {
		return id;
	}
}

// thread 回复的父帖（谁: 原文），按 thread 缓存；读不到就不带
const parents = new Map<string, string>();
async function parentOf(channel: string, ts: string): Promise<string | undefined> {
	const key = `${channel}:${ts}`;
	const cached = parents.get(key);
	if (cached) return cached;
	try {
		const res = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${ts}&limit=1`, { headers: { Authorization: `Bearer ${USER_TOKEN}` } });
		const body: { ok: boolean; messages?: SlackMessage[] } = await res.json();
		const top = body.ok ? body.messages?.[0] : undefined;
		if (!top?.text) return undefined;
		const text = `${top.user ? await lookup("users.info", "user", top.user) : "?"}: ${top.text.slice(0, 1000)}`;
		parents.set(key, text);
		return text;
	} catch {
		return undefined;
	}
}

async function handle(ev: SlackMessage): Promise<void> {
	if (!slack || ev.type !== "message" || !ev.channel || !ev.ts || !ev.user || ev.user === slack.me) return;
	if (ev.subtype && ev.subtype !== "thread_broadcast") return;
	const watched = slack.channels[ev.channel];
	const direct = ev.channel_type === "im" || ev.channel_type === "mpim";
	if (direct && ev.bot_id) {
		log(`dropped bot DM ${ev.channel} ${ev.ts}`); // 日历、DX 这类 bot 的私信不送，只记一行
		return;
	}
	const mention = (ev.text ?? "").includes(`<@${slack.me}>`);
	const watch = slackWatch();
	const task = watch.channels.get(ev.channel) ?? watch.threads.get(`${ev.channel}:${ev.thread_ts ?? ev.ts}`);
	if (!watched && !direct && !mention && !task) return;
	if (watched && !watched.line && !direct && !mention && !task && config.triage) return;
	const who = await lookup("users.info", "user", ev.user);
	const reply = ev.thread_ts && ev.thread_ts !== ev.ts;
	const place = watched?.name ?? (ev.channel_type === "im" ? `DM ${who}` : direct ? "group DM" : await lookup("conversations.info", "channel", ev.channel));
	const link = `https://${slack.domain}.slack.com/archives/${ev.channel}/p${ev.ts.replace(".", "")}${reply ? `?thread_ts=${ev.thread_ts}` : ""}`;
	// 私信和 @ 你的消息不归线：送到你最近发过话的账本。原文和父帖第一行由插件截短、转义后送进主会话
	const event = {
		source: "slack",
		who,
		where: place + (reply ? " (thread reply)" : ""),
		link,
		line: direct || mention ? undefined : (watched?.line ?? task),
		urgent: direct || mention,
		text: ev.text?.slice(0, 1000),
		parent: reply ? await parentOf(ev.channel, ev.thread_ts!) : undefined,
	};
	const [sec, frac = ""] = ev.ts.split(".");
	if (writeEvent(event, `${ev.channel}-${ev.ts}`, BigInt(sec) * 1_000_000_000n + BigInt(frac.padEnd(9, "0").slice(0, 9)))) {
		log(`inbox ${event.where} from ${who}${event.urgent ? " (urgent)" : ""}`);
	}
}

async function openUrl(): Promise<string> {
	const res = await fetch("https://slack.com/api/apps.connections.open", { method: "POST", headers: { Authorization: `Bearer ${APP_TOKEN}` } });
	const body: OpenBody = await res.json();
	if (!body.ok || !body.url) throw new Error(`apps.connections.open: ${body.error ?? res.status}`);
	return body.url;
}

const PING_MS = 30_000;
const DEAD_MS = 90_000;
const health = (error?: string) => writeHealth("slack-socket", "Slack 实时推送", 60, error);

// 一次连接的生命周期；Slack 每隔几小时会主动要求重连，断开后由外层循环重连
async function connectOnce(): Promise<void> {
	const ws = new WebSocket(await openUrl());
	const { promise: closed, resolve } = Promise.withResolvers<void>();
	let alive = Date.now();
	const seen = () => {
		alive = Date.now();
	};
	ws.onmessage = m => {
		seen();
		const msg: Envelope = JSON.parse(String(m.data));
		if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id })); // 不确认 Slack 会重发
		if (msg.type === "hello") {
			log("connected");
			health();
		} else if (msg.type === "disconnect") {
			log(`disconnect requested: ${msg.reason}`);
			ws.close();
		} else if (msg.type === "events_api" && msg.payload?.event) {
			handle(msg.payload.event).catch(err => log(`handle failed: ${err}`));
		}
	};
	ws.addEventListener("pong", () => {
		seen();
		health();
	});
	const beat = setInterval(() => {
		if (Date.now() - alive > DEAD_MS) {
			log(`no heartbeat for ${Math.round((Date.now() - alive) / 1000)}s: reconnecting`);
			ws.terminate(); // 死连接上 close() 的握手等不到回应
			resolve();
		} else if (ws.readyState === WebSocket.OPEN) ws.ping();
	}, PING_MS);
	ws.onclose = () => resolve();
	ws.onerror = () => log("websocket error");
	await closed;
	clearInterval(beat);
}

for (;;) {
	try {
		await connectOnce();
	} catch (err) {
		log(`connect failed: ${err}`);
		health(String(err));
		await Bun.sleep(10_000);
	}
	await Bun.sleep(1000);
}
