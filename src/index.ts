// omp-dispatch-desk（调度台）：调度器模式。默认关；在会话里敲 /调度 打开，打开状态跟着会话走。关着的会话里，插件什么都不做。
//
// 派子代理、给子代理发消息、子代理再派人、续会话后叫醒子代理、看谁在跑，都是 omp 自带的，这里不重做。
// 插件只补 omp 没有的：
// - 一本全局的任务表（tasks/events.jsonl）：每个任务登记负责 agent 的名字（主会话用这个名字派出子代理，之后 agent://<名字> 就是它）和要盯的外部输入。
// - 每次请求末尾附规则（不写进会话历史，压缩丢不掉）：主会话收调度规则、常设约束和任务表摘要；任务的负责 agent 收常设约束、负责 agent 的规矩和任务卡；任务的审查者收常设约束、审查规则和任务卡；其他子代理只收常设约束。插件自带的规则和代码一起在进程启动时读，用户自己的规则文件每次现读。
// - 外部消息：会话外的程序写进 inbox/new；每 5 秒认领一次，按任务登记的「要盯的外部输入」归到任务，合成一条消息叫醒主会话，由它交给负责 agent。
// - 按层定模型：派出任务的负责 agent 时由程序指定模型（默认跟主会话一样）；它再派的帮手照 omp 自己的配置。
// - 审查：任务要记成「完成」，任务表里得先有主会话另派的审查者记下的「通过」；事项记完成不拦，审不审由主会话按大小定。审查者在跑时，提醒负责 agent 先别把这份结果往外发。
// - 提问：登记提问时要写查过哪里，程序把这个任务已有的决定列给模型看。用户纠正后提议的规则也登记成提问。
// - 看得见：每条回复上方画一行标头（回答、交出、交回、审查结果…），输入框上方固定显示等用户定的事、在跑的负责 agent、接收程序的故障、插件已更新待重启；状态栏数着接收程序拦下的无关消息。
// - 不傻等：子代理写好了却被 omp 压着的交回由程序送达；子代理久未交回时叫醒主会话去看。
// 远端写入自动记到任务表；给人看的视图里配上它之前用户最近的决定。除了审查那一条，不拦截任何操作。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { holdHandback, releaseHandback } from "./agents";
import { claimOperator, type Lark, type OperatorMessage, operatorPrompt, projectProfile, pushFeishuAsk, replyFeishu, rememberOwnerChat, runLark } from "./feishu";
import { handbackKind } from "./heads";
import { DISPATCH_RULES, HELD, HOME, INBOX_CLAIMED, INBOX_NEW, OPERATOR_NEW, ORDERS, OWNER_RULES, REVIEW_RULES, TRIAGE_LOG, USER_RULES } from "./paths";
import { remoteWrite } from "./remote";
import { checkReply, feedback, renderRules, settings } from "./rules";
import { createScreen, messageRow, readReviewing } from "./screen";
import { hasFeishu, readConfig, runSetup } from "./setup";
import { OFF_MESSAGE, isOn, setOn } from "./switch";
import { type Ev, GENERAL, type Table, agentTaken, append, doneBlocker, isReviewerName, logError, needsReview, openTasks, readTable, taskOfAgent, taskOfReviewer, today } from "./table";
import { type Tier, due, tierOf } from "./tiers";
import { decidedFor, renderViews, since, snapshot, taskCard } from "./views";
import { matchTask } from "./watch";

const TICK_MS = 5_000;
const STATUS_KEY = "dispatch-desk";
const TOOLS = ["tasktable_task", "tasktable_update", "tasktable_ask", "tasktable_correction", "tasktable_review"];
const TITLE = "调度"; // 打开调度器模式的会话叫这个名字，不让 omp 按第一句话自动起名
// 一条编号回答：编号 + 可选标点 + 最多 4 个字的回答（「做」「不做」「先不」可以，「点以后再说」不行）
const ANSWER = /(?<!\d)(\d{1,3})\s*[.、:：)）]?\s*([^\s\d;；,，。.、:：]{1,4})(?=[\s;；,，。.、]|$)/g;

// 本机没有 omp 扩展的类型声明（运行时由 omp 解析），这里只声明用到的字段
interface Job { id: string; label?: string; type?: string; agentId?: string; startTime?: number }
interface Ctx {
	agent?: { kind?: string; id?: string };
	cwd: string;
	isIdle(): boolean;
	sessionManager?: { getSessionFile?(): string | undefined };
	models?: { current?(): { provider?: string; id?: string } | undefined };
	getSystemPrompt?(): string | string[] | undefined;
	getAsyncJobSnapshot?(): { running?: Job[] } | null;
	setInterval(fn: () => void | Promise<void>, ms: number): unknown;
	ui: {
		notify(message: string, level: "info" | "warning" | "error"): void;
		setStatus?(key: string, text: string | undefined): void;
		setWidget?(key: string, lines: string[] | undefined, options?: { placement: "aboveEditor" | "belowEditor" }): void;
		rerenderMessage?(timestamp: number): void;
	};
}
interface InboxFile { source?: string; who?: string; where?: string; link?: string; line?: string; note?: string; urgent?: boolean }
interface UpdateParams { task?: string; id: string; title?: string; status?: string; next?: string; chase?: string; pr?: string; source?: string }
interface AskParams { action: "open" | "close" | "decide"; task?: string; text?: string; checked?: string; n?: number; outcome?: string }
interface ReviewParams { task: string; item?: string; verdict: "pass" | "fail"; evidence: string; findings?: string }
interface TaskParams { task: string; agent?: string; title?: string; goal?: string; done_when?: string; watch_add?: string[]; watch_remove?: string[]; status?: string }
type Input = Record<string, unknown>;

// 子代理的会话文件在 <主会话>/<子代理>.jsonl，孙代理在 <主会话>/<子代理>/<子代理.孙代理>.jsonl：
// 按 id 的层数往上找，子孙都归到最顶上的主会话
function sessionOf(ctx: Ctx): string | undefined {
	const f = ctx.sessionManager?.getSessionFile?.();
	if (!f) return undefined;
	if (ctx.agent?.kind !== "sub") return basename(f, ".jsonl");
	let dir = dirname(f);
	for (let depth = (ctx.agent.id ?? "").split(".").length; depth > 1; depth--) dir = dirname(dir);
	return basename(dir);
}
const isMain = (ctx: Ctx) => ctx.agent?.kind !== "sub";
const on = (ctx: Ctx) => isOn(sessionOf(ctx)); // 子代理跟随它所属的主会话
const read = (path: string) => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};
// 插件自带的规则和代码一起加载：同一个进程里两者版本一致（磁盘上更新了，固定区提示重启）。用户自己的规则文件每次现读
const PROMPTS = { dispatch: read(DISPATCH_RULES), orders: read(ORDERS), owner: read(OWNER_RULES), review: read(REVIEW_RULES) };
const clock = (ms: number) => new Date(ms).toLocaleTimeString("sv-SE").slice(0, 5);

// 外部消息归到哪个任务：先按任务登记的「要盯的外部输入」；没命中再用消息源自带的归属（频道配置、PR 标题里的卡号），但只认任务表里未完成的任务
function route(l: Table, ev: InboxFile): { task?: string; tag: string } {
	const open = openTasks(l);
	const m = matchTask(ev, open.map(t => ({ name: t.name, watch: t.watch })));
	if (m.candidates.length) return { tag: `task=? (candidates: ${m.candidates.join(", ")})` };
	const name = m.task ?? (open.some(t => t.name === ev.line) ? ev.line : undefined);
	if (!name) return { tag: "task=?" };
	const agent = l.tasks.get(name)?.agent;
	return { task: name, tag: `task=${name} | owner=${agent ? `agent://${agent}` : "none"}` };
}

export default function (pi: ExtensionAPI, lark: Lark = runLark): void {
	const naming = pi as unknown as { getSessionName?(): string | undefined; setSessionName?(name: string): Promise<void> | void };
	const z = pi.zod;
	let session: string | undefined;
	let ui: Ctx | undefined;
	let inboxSinceInput = 0;
	let urgentSinceInput = 0;
	const pending = new Map<string, { summary: string; bash: boolean }>(); // toolCallId → 远端写入摘要
	let replyNote: string | undefined; // 上一次回复的检查结果，下一次请求提醒模型
	let awayNote: string | undefined; // 用户离开一段时间后回来：这期间的变化
	let awayDelivered = false; // 离开提示已随用户那条消息交付，那一轮答完就清掉
	let userTurn = false; // 这一轮是用户发话引起的（不是外部事件叫醒的）：只有这种回复才算用户看过
	const feishuQueued = new Map<string, OperatorMessage>();
	let feishuTurn: { prompt: string; message: OperatorMessage } | undefined;

	const jobs = (ctx: Ctx): Job[] => ctx.getAsyncJobSnapshot?.()?.running ?? [];

	const screen = createScreen({
		on: () => isOn(session),
		session: () => session,
		sessionDir: () => ui?.sessionManager?.getSessionFile?.()?.replace(/\.jsonl$/, ""),
		userTurn: () => userTurn,
		send: message => pi.sendMessage(message, { deliverAs: "nextTurn", triggerTurn: true }),
	});
	// 回复上方的标头：omp 画每块回复文字时来问。旧版本的 omp 没有这个接口就不画
	const draw = pi as unknown as { registerAssistantTextRenderer?(fn: typeof screen.render): void; registerMessageRenderer?(type: string, fn: typeof messageRow): void; pi?: { settings?: unknown } };
	draw.registerAssistantTextRenderer?.(screen.render);
	// 插件自己送进会话的三种消息各画成一行，不把给模型看的英文说明整段摊在屏幕上
	for (const type of ["dispatch-desk-inbox", "dispatch-desk-handback", "dispatch-desk-stall"]) draw.registerMessageRenderer?.(type, messageRow);
	// 这个接口默认是关的（omp 的设置「扩展回复渲染」）：调度器模式开着时在本进程里打开，不改用户的配置文件；用户自己配过的不动
	let rendererForced = false;
	const syncRenderer = async () => {
		try {
			const { lookup } = (await import("@oh-my-pi/pi-coding-agent/config/registry")) as { lookup(id: string): { get(scope: unknown): unknown; isConfigured(scope: unknown): boolean; override(scope: unknown, value: unknown): void; clearOverride(scope: unknown): void } | undefined };
			const setting = lookup("extensionRenderers.assistantText");
			const scope = draw.pi?.settings;
			if (!setting || !scope) return;
			if (isOn(session) && !rendererForced && !setting.isConfigured(scope)) {
				setting.override(scope, true);
				rendererForced = true;
			} else if (!isOn(session) && rendererForced) {
				setting.clearOverride(scope);
				rendererForced = false;
			}
		} catch (err) {
			logError("renderer setting", err);
		}
	};

	const feishuError = (ctx: Ctx, action: string, err: unknown) => {
		logError(action, err);
		ctx.ui.notify(`${action}失败：${err instanceof Error ? err.message : String(err)}`, "error");
	};

	const record = (ev: Omit<Ev, "ts">) => {
		append(ev);
		renderViews();
		if (ev.kind === "task" || ev.kind === "item") screen.writePlan(); // 盯办项、任务状态、事项变了：接收程序的监听范围和分拣用的任务清单跟着变
		if (ev.kind === "ask" && ui) {
			const ctx = ui;
			void (async () => {
				const profile = projectProfile(readConfig().projects, ctx.cwd);
				if (profile) await pushFeishuAsk(lark, profile, Number(ev.n), String(ev.text));
			})().catch(err => feishuError(ctx, "飞书推送待决定事项", err));
		}
	};

	// 接收程序分拣时拦下的无关消息（明细在 state/triage.jsonl）：你上次发话以来的条数。文件或发话时间变了才重数
	let dropped = { key: "", n: 0 };
	const droppedSince = (since: string | undefined): number => {
		let key: string;
		try {
			const st = statSync(TRIAGE_LOG);
			key = `${st.size}:${st.mtimeMs}:${since ?? ""}`;
		} catch {
			return 0;
		}
		if (key === dropped.key) return dropped.n;
		let n = 0;
		for (const raw of read(TRIAGE_LOG).split("\n")) {
			try {
				const r = JSON.parse(raw) as { at?: string; category?: string };
				if (r.category === "irrelevant" && (!since || String(r.at ?? "") > since)) n++;
			} catch {}
		}
		dropped = { key, n };
		return n;
	};

	const status = (ctx: Ctx): string => {
		const l = readTable();
		const parts = [`📋 任务 ${openTasks(l).length}`, `待你决定 ${l.asks.size}`, `在跑的 agent ${jobs(ctx).length}`, `新消息 ${inboxSinceInput}`];
		if (urgentSinceInput) parts.push(`其中私信/@你 ${urgentSinceInput}`); // 都是你上次发话以来到的，发话后清零
		const quiet = droppedSince(l.lastInput);
		if (quiet) parts.push(`拦下无关 ${quiet}`);
		return parts.join(" · ");
	};
	const showStatus = (ctx: Ctx) => ctx.ui.setStatus?.(STATUS_KEY, isOn(session) ? status(ctx) : undefined);

	// ---------- 外部消息：只交给打开了调度器模式、用户最近发话的会话；分三档（见 tiers.ts），到点的连同攒着的合成一条消息 ----------
	// 没到点的留在 inbox/new，等的时间按文件写入时间算：会话重启也不丢、不重算

	const claimInbox = (withInput = false) => {
		if (!existsSync(INBOX_NEW)) return;
		const names = readdirSync(INBOX_NEW).filter((n: string) => n.endsWith(".json")).sort();
		if (!names.length) return;
		const l = readTable();
		if (l.lastInputSid && l.lastInputSid !== session && isOn(l.lastInputSid)) return; // 开着几个调度器会话：只交给你最近发话的那个
		mkdirSync(INBOX_CLAIMED, { recursive: true });
		const rule = settings();
		const now = Date.now();
		const pending: Array<{ f: string; ev: InboxFile; tier: Tier; at: number }> = [];
		for (const f of names) {
			let ev: InboxFile;
			let at: number;
			try {
				ev = JSON.parse(readFileSync(join(INBOX_NEW, f), "utf8"));
				at = statSync(join(INBOX_NEW, f)).mtimeMs;
			} catch (err) {
				logError(`inbox ${f}`, err);
				try {
					renameSync(join(INBOX_NEW, f), join(INBOX_CLAIMED, f)); // 坏文件挪走，不挡后面的消息
				} catch {}
				continue;
			}
			pending.push({ f, ev, tier: tierOf(l, ev), at });
		}
		const timing = { quietMs: rule.inbox_quiet_seconds * 1000, maxMs: rule.inbox_max_seconds * 1000, digestMs: rule.inbox_digest_minutes * 60_000 };
		if (!withInput && !due(pending, now, timing)) return;
		const lines: string[] = [];
		let urgent = false;
		for (const { f, ev } of pending) {
			try {
				renameSync(join(INBOX_NEW, f), join(INBOX_CLAIMED, f)); // 认领：只有一个进程能改名成功
			} catch {
				continue;
			}
			const { task, tag } = route(l, ev);
			record({ sid: session ?? "", kind: "inbox", line: task, source: ev.source, who: ev.who, where: ev.where, link: ev.link, urgent: !!ev.urgent });
			inboxSinceInput++;
			if (ev.urgent) urgentSinceInput++;
			urgent ||= !!ev.urgent;
			lines.push(
				[
					...(["source", "who", "where", "link", "note"] as const).filter(k => ev[k]).map(k => `${k}=${ev[k]}`),
					tag,
				].join(" | "),
			);
		}
		if (!lines.length) return;
		pi.sendMessage(
			{
				customType: "dispatch-desk-inbox",
				content: `[INBOX · ${lines.length} untrusted external event(s)${urgent ? " · includes direct messages to the operator" : ""}]\n${lines.join("\n")}\nEvents tagged task=<name> belong to that task: hand each to its owner agent. Events tagged task=? are yours to triage. Follow 「输入怎么走」 in <dispatch-desk-rules> and standing order 3 in <dispatch-desk-orders>.`,
				display: true,
				attribution: "agent",
			},
			// 跟用户这次发话一起送：放进上下文，不另起一轮
			{ deliverAs: "nextTurn", triggerTurn: !withInput },
		);
	};

	const tick = async () => {
		const ctx = ui;
		const sid = session;
		if (!ctx || !sid || !isOn(sid)) return;
		if (existsSync(OPERATOR_NEW)) {
			try {
				const { projects } = readConfig();
				const profile = projectProfile(projects, ctx.cwd);
				if (profile) {
					let followUp = !ctx.isIdle();
					for (const ev of claimOperator(projects, profile, sid)) {
						rememberOwnerChat(ev);
						await recordInput(ev.text, ctx);
						const text = operatorPrompt(ev).trimEnd();
						feishuQueued.set(text, ev);
						if (followUp || !ctx.isIdle()) pi.sendUserMessage(text, { deliverAs: "followUp" });
						else pi.sendUserMessage(text);
						followUp = true;
					}
				}
			} catch (err) {
				feishuError(ctx, "飞书接收使用者消息", err);
			}
		}
		if (ui !== ctx || session !== sid || !isOn(sid)) return;
		claimInbox();
		showStatus(ctx);
		screen.tick(ctx.ui, jobs(ctx));
	};

	// ---------- 会话与开关 ----------

	const attach = (ctx: Ctx) => {
		session = sessionOf(ctx);
		ui = ctx;
		showStatus(ctx);
		screen.clear(ctx.ui); // 换了会话：上一个会话的固定区撤掉，开着调度器模式的下一拍重画
		if (isOn(session)) screen.writePlan();
		void syncRenderer();
	};

	// 任务表工具只在打开了调度器模式的会话里注册（子代理跟随它所属的主会话）：没打开过的会话里它们不存在。
	// 打开后又关掉：用 omp 自己的工具开关从模型的工具列表里拿掉
	let registered = false;
	const syncTools = async (sid = session) => {
		const want = isOn(sid);
		if (want && !registered) {
			registered = true;
			for (const tool of [taskTool, updateTool, askTool, correctionTool, reviewTool]) pi.registerTool(tool);
		}
		if (!registered) return;
		const api = pi as unknown as { getActiveTools?(): string[]; setActiveTools?(names: string[]): Promise<void> | void };
		const active = api.getActiveTools?.();
		if (!active || !api.setActiveTools) return;
		const next = want ? [...new Set([...active, ...TOOLS])] : active.filter(n => !TOOLS.includes(n));
		if (next.length !== active.length) await api.setActiveTools(next);
	};

	pi.on("session_start", async (_e: unknown, ctx: Ctx) => {
		if (!isMain(ctx)) {
			await syncTools(sessionOf(ctx)).catch(err => logError("tools", err));
			return;
		}
		attach(ctx);
		await syncTools().catch(err => logError("tools", err));
		ctx.setInterval(tick, TICK_MS); // 会话结束时 omp 自动清掉；关着时每拍直接返回
	});

	// /resume、/new 在同一进程里换会话：重置这个会话自己的状态
	pi.on("session_switch", async (_e: unknown, ctx: Ctx) => {
		if (!isMain(ctx)) return;
		inboxSinceInput = 0;
		urgentSinceInput = 0;
		replyNote = undefined;
		awayNote = undefined;
		awayDelivered = false;
		userTurn = false;
		feishuQueued.clear();
		feishuTurn = undefined;
		attach(ctx);
		await syncTools().catch(err => logError("tools", err));
	});

	pi.registerCommand("调度", {
		description: "打开调度器模式；/调度 off 关掉。打开状态跟着会话走，omp -r / -c 续上时不用再敲",
		handler: async (args: string, ctx: Ctx) => {
			if (!isMain(ctx)) return;
			attach(ctx);
			if (!session) {
				ctx.ui.notify("这个会话还没有会话文件，先发一条消息再打开调度器模式", "warning");
				return;
			}
			const off = /^(off|关|关闭)$/i.test(args.trim());
			setOn(session, !off);
			await syncTools().catch(err => logError("tools", err));
			await syncRenderer();
			if (off) {
				feishuQueued.clear();
				feishuTurn = undefined;
				screen.clear(ctx.ui);
			} else {
				await naming.setSessionName?.(TITLE);
				screen.writePlan();
			}
			showStatus(ctx);
			ctx.ui.notify(off ? "调度器模式已关闭：这个会话里插件不再做任何事" : "调度器模式已打开：你说的话和外部消息会按任务交给各自的负责 agent", "info");
			if (!off) {
				try {
					const cfg = readConfig();
					if (!(cfg.slack || hasFeishu(cfg) || cfg.ado?.org || cfg.reminders) || !cfg.triage?.about?.trim()) {
						ctx.ui.notify("可运行 /调度配置，设置消息源和分拣描述。", "info");
					}
				} catch {
					ctx.ui.notify("调度配置无法读取，请检查 config.json 后运行 /调度配置。", "warning");
				}
			}
		},
	});

	const setupCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description: "交互配置调度台的分拣、飞书和 Slack",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				console.error("当前没有交互界面，请在插件仓库运行 bun scripts/install.ts。");
				return;
			}
			try {
				let cwd = ctx.cwd;
				try {
					cwd = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
				} catch {} // 当前目录可以不属于 Git 仓库
				const changed = await runSetup({
					select: (title, options) => ctx.ui.select(title, options),
					input: (title, placeholder) => ctx.ui.input(title, placeholder),
					editor: (title, prefill) => ctx.ui.editor(title, prefill),
					confirm: (title, message) => ctx.ui.confirm(title, message),
					notify: (message, level) => ctx.ui.notify(message, level),
				}, { cwd });
				if (changed && isOn(session)) screen.writePlan();
			} catch (err) {
				ctx.ui.notify(`无法保存或读取调度配置：${String(err)}`, "error");
			}
		},
	};
	pi.registerCommand("调度配置", setupCommand);
	pi.registerCommand("dispatch-setting", setupCommand);

	const recordInput = async (text: string, ctx: Ctx) => {
		if (!naming.getSessionName?.()) await naming.setSessionName?.(TITLE); // 会话还没名字：赶在 omp 按第一句话自动起名之前定下来
		inboxSinceInput = 0; // 外部事件计数 = 用户上次发话以来到的
		urgentSinceInput = 0;
		claimInbox(true); // 攒着的消息跟用户这次发话一起送
		// 离开多久从「上次发话」和「上次给用户的回复」里较晚的那个算；斜杠命令不算回来
		const l0 = readTable();
		const base = [l0.lastInput, l0.lastReply].filter((t): t is string => !!t).sort().at(-1);
		const hours = settings().away_hours;
		const away = base ? (Date.now() - Date.parse(base)) / 3_600_000 : 0;
		if (base && hours > 0 && away >= hours && !text.startsWith("/")) {
			awayNote = `用户离开了约 ${Math.round(away)} 小时（从 ${new Date(base).toLocaleString("sv-SE").slice(5, 16)} 起）。先用一屏说清这期间变了什么，再回答。任务表里这期间的记录：\n${since(base)}`;
			awayDelivered = false;
		}
		append({ sid: session ?? "", kind: "input", cwd: ctx.cwd }); // 会话分配、离开多久都靠这条记录
		// 整条消息只由编号回答组成（「1 做 2 不做」「1 做；2 不做」）才自动记账；混了别的话就交给模型。
		// 回答不能以数字开头，所以「12」「3:30」「1.5」不算
		const l = readTable();
		const answers = [...text.matchAll(ANSWER)];
		const leftover = text.replace(ANSWER, "").replace(/[\s;；,，。.、]+/g, "");
		const numbers = answers.map(m => Number(m[1]));
		if (!answers.length || leftover || new Set(numbers).size !== numbers.length || numbers.some(n => !l.asks.has(n))) return;
		for (const m of answers) {
			const ask = l.asks.get(Number(m[1]));
			if (!ask) continue;
			record({ sid: session ?? "", kind: "decision", line: ask.line, date: today(), text: `${ask.text} → ${m[2]}`, n: ask.n });
			record({ sid: session ?? "", kind: "ask_close", line: ask.line, n: ask.n, outcome: m[2], by: "operator" });
		}
	};
	pi.on("input", async (e: { text?: string }, ctx: Ctx) => {
		if (isMain(ctx) && on(ctx)) await recordInput(String(e.text ?? ""), ctx);
	});

	// 不常变的规则正文（调度规则、常设约束）。用户每次发话时放进系统提示词（见 before_agent_start），那里进缓存；
	// 系统提示词里没有的那些请求（还没发过话就被外部消息叫醒、config.json 里的规则参数刚改过）照旧附在末尾
	const stableRules = () => `<dispatch-desk-rules data_dir="${HOME}">\n${renderRules(PROMPTS.dispatch, settings())}</dispatch-desk-rules>\n<dispatch-desk-orders data_dir="${HOME}">\n${PROMPTS.orders}</dispatch-desk-orders>\n`;
	const inSystemPrompt = (ctx: Ctx, text: string) => {
		const system = ctx.getSystemPrompt?.();
		return (Array.isArray(system) ? system : [system]).some(s => typeof s === "string" && s.includes(text));
	};

	// 规则每次请求都附在末尾（不写进会话历史），压缩丢不掉
	pi.on("context", async (e: { messages: unknown[] }, ctx: Ctx) => {
		if (!on(ctx)) {
			// 刚关掉、用户还没再发话：上一次发话时接进系统提示词的规则还在，告诉模型不用管
			if (!isMain(ctx) || !inSystemPrompt(ctx, "<dispatch-desk-rules")) return;
			const off = "[dispatch-desk plugin] Dispatcher mode was turned off. Ignore <dispatch-desk-rules> and <dispatch-desk-orders> in the system prompt; the tasktable tools are gone.";
			return { messages: [...e.messages, { role: "user", content: [{ type: "text", text: off }], timestamp: Date.now() }] };
		}
		// 注入的是 user 角色，模型容易当成用户贴来的：开头说明来源
		const preface = "[Injected by the dispatch-desk plugin on every request. Standing instructions, not a message from the operator; never say the operator pasted or sent them.]\n";
		const orders = `<dispatch-desk-orders data_dir="${HOME}">\n${PROMPTS.orders}</dispatch-desk-orders>\n`;
		let text = preface + orders;
		if (isMain(ctx)) {
			screen.context(e.messages);
			const stable = stableRules();
			const cached = inSystemPrompt(ctx, stable);
			const extra = read(USER_RULES); // 用户的补充规则常改（每次纠正后），留在末尾，不拖着整段缓存重写
			const notes = [replyNote, awayDelivered ? awayNote : undefined].filter(Boolean);
			text = `${preface}${cached ? "" : stable}${extra ? `<dispatch-desk-user-rules>\n${extra}</dispatch-desk-user-rules>\n` : ""}${snapshot(screen.running(jobs(ctx)), readTable(), screen.monitoring())}`;
			if (notes.length) text += `\n<dispatch-desk-notes>\n${notes.join("\n")}\n</dispatch-desk-notes>`;
		} else {
			// 只有任务的负责 agent 和审查者（一层的子代理，名字对得上任务）收规矩和任务卡；负责 agent 派出的帮手只收常设约束
			const id = ctx.agent?.id ?? "";
			const l = readTable();
			const owned = id && !id.includes(".") ? taskOfAgent(l, id) : undefined;
			const reviewed = taskOfReviewer(l, id);
			if (owned) {
				text += `<dispatch-desk-owner-rules>\n${renderRules(PROMPTS.owner, settings())}</dispatch-desk-owner-rules>\n${taskCard(owned)}`;
				// 主会话派出的审查者还在跑：这份结果先别往外发，免得审查不通过还得再去更正
				const r = readReviewing(sessionOf(ctx))[owned.name];
				if (r)
					text += `\n<review-running>${r.by} has been reviewing your work on ${owned.name} since ${clock(r.since)}. Until its verdict is in, do not send this work's results, status reports, boards or summaries to anyone outside this session (Slack, PR or ticket comments, email); prepare them and send after the verdict. Answering a collaborator's direct question is fine if you say the result is still under review.</review-running>`;
			}
			if (reviewed) text += `<dispatch-desk-review-rules>\n${PROMPTS.review}</dispatch-desk-review-rules>\n${taskCard(reviewed)}`;
		}
		return { messages: [...e.messages, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] };
	});

	// 用户发话时：把规则正文接到系统提示词后面（一直管到下一次发话，中间被子代理交回叫醒的回合也在）。
	// 离开提示跟着用户那条消息走：消息真正开始处理时才算交付（正在跑的那一轮结束时不清掉它）
	pi.on("before_agent_start", async (e: { reason?: string; prompt?: string; systemPrompt?: string | string[] }, ctx: Ctx) => {
		if (!isMain(ctx) || e.reason !== "prompt" || !on(ctx)) return;
		userTurn = true;
		if (awayNote) awayDelivered = true;
		// 入队不算交付：不能拿还在等的飞书消息接收上一轮（可能是终端）的回复。
		if (feishuTurn?.prompt !== e.prompt) {
			feishuTurn = undefined;
			if (e.prompt && feishuQueued.size) {
				const batch = `\n\n${e.prompt}\n\n`;
				let position = -1;
				for (const [text, message] of feishuQueued) {
					const found = batch.lastIndexOf(`\n\n${text}\n\n`);
					if (found < 0) continue;
					feishuQueued.delete(text);
					if (found <= position) continue;
					position = found;
					feishuTurn = { prompt: e.prompt, message };
				}
			}
		}
		const stable = stableRules();
		if (Array.isArray(e.systemPrompt)) return { systemPrompt: [...e.systemPrompt, stable] };
		if (typeof e.systemPrompt === "string") return { systemPrompt: `${e.systemPrompt}\n${stable}` };
	});
	pi.on("agent_start", async (_e: unknown, ctx: Ctx) => {
		if (isMain(ctx) && on(ctx)) screen.turnStart();
	});
	pi.on("agent_end", async (e: { messages?: Array<{ role?: string; content?: unknown }>; awaitingAsyncWork?: boolean }, ctx: Ctx) => {
		if (isMain(ctx)) {
			if (on(ctx)) screen.turnEnd(ctx.ui);
			userTurn = false;
			feishuTurn = undefined;
			return;
		}
		// 任务的负责 agent 或审查者这一侧：这一轮写完了交回，但自己还有后台命令或帮手在跑时，omp 不会把它送给主会话
		// （要等它完全空闲，到时送的也只是它最后说的话）。先记下来，主会话那一侧过了宽限期自己送达（见 screen.ts）
		try {
			const id = ctx.agent?.id ?? "";
			const s = sessionOf(ctx);
			if (!s || !isOn(s) || !id || id.includes(".")) return;
			const l = readTable();
			if (!taskOfAgent(l, id) && !taskOfReviewer(l, id)) return;
			const last = [...(e.messages ?? [])].reverse().find(m => m.role === "assistant");
			const blocks = Array.isArray(last?.content) ? (last.content as Array<{ type?: string; text?: string }>) : [];
			if (blocks.some(b => b.type === "toolCall")) return;
			const text = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n").trim();
			if (!text) return;
			if (!e.awaitingAsyncWork) releaseHandback(join(HELD, s), id, text);
			else if (handbackKind(text)) holdHandback(join(HELD, s), id, text, Date.now());
		} catch (err) {
			logError("held hand-back", err);
		}
	});

	// 按层定模型：主会话派出任务的负责 agent 时，用配置的模型，没配就跟主会话一样（模型和思考档）；派出审查者时跟主会话一样。
	// 负责 agent 的帮手不管，照 omp 自己的配置
	pi.on("before_subagent_spawn", async (e: { spawnKey?: string }, ctx: Ctx) => {
		if (!isMain(ctx) || !on(ctx) || !e.spawnKey) return;
		const l = readTable();
		const owner = !!taskOfAgent(l, e.spawnKey);
		if (!owner && !taskOfReviewer(l, e.spawnKey)) return;
		const configured = owner ? settings().owner_model : "";
		if (configured) return { model: configured };
		const m = ctx.models?.current?.();
		if (!m?.provider || !m.id) return;
		const level = (pi as unknown as { getThinkingLevel?(): unknown }).getThinkingLevel?.();
		return { model: `${m.provider}/${m.id}${typeof level === "string" && level ? `:${level}` : ""}` };
	});

	// 回复的事后检查：只看主会话给用户的最后一条（不带工具调用的）回复，不拦截
	pi.on("message_end", async (e: { message?: { role?: string; stopReason?: string; content?: Array<{ type: string; text?: string }> } }, ctx: Ctx) => {
		const m = e.message;
		if (!isMain(ctx) || !on(ctx) || m?.role !== "assistant" || !Array.isArray(m.content)) return;
		if (m.stopReason === "aborted" || m.stopReason === "error" || m.content.some(b => b.type === "toolCall")) return;
		const text = m.content.filter(b => b.type === "text").map(b => b.text ?? "").join("\n").trim();
		if (!text) return;
		const target = feishuTurn?.message;
		feishuTurn = undefined;
		if (target) void replyFeishu(lark, target, text).catch(err => feishuError(ctx, "飞书回复", err));
		screen.replied();
		const l = readTable();
		const ids = new Set<string>(); // 负责 agent 的名字不算：规则要求提到它时说清它在做哪个任务
		for (const byTask of l.items.values()) for (const i of byTask.values()) ids.add(i.id);
		const result = checkReply(text, ids);
		const rule = settings();
		// 离开后的那一屏不算超长；不是用户发话引起的回合（子代理交回、外部消息）上限更低
		replyNote = feedback(result, awayDelivered ? undefined : userTurn ? rule.report_lines : rule.wake_lines, !userTurn);
		if (awayDelivered) {
			awayNote = undefined;
			awayDelivered = false;
		}
		// 回复时间只记回答用户的：外部事件叫醒的那一轮用户可能不在，不能算他看过
		if (userTurn || replyNote) append({ sid: session ?? "", kind: userTurn ? "reply" : "check", ...(replyNote ? { lines: result.lines, codes: result.codes } : {}) });
	});

	// ---------- 远端写入记账：用观测事件，不注册 tool_call/tool_result（注册了会关掉 omp 的子代理预启动） ----------

	pi.on("tool_execution_start", async (e: { toolCallId?: string; toolName: string; args?: Input }, ctx: Ctx) => {
		if (!on(ctx)) return;
		if (isMain(ctx)) {
			// 这一轮把活交给了谁：标头里要写
			if (e.toolName === "task") for (const t of (e.args?.tasks as Array<{ name?: string }> | undefined) ?? []) if (t?.name) screen.handedTo(t.name);
			const to = e.toolName === "write" ? /^agent:\/\/([^/?#]+)/.exec(String(e.args?.path ?? ""))?.[1] : undefined;
			if (to && to !== "all" && to !== "Main") screen.handedTo(to);
		}
		const summary = remoteWrite(e.toolName, e.args);
		if (summary && e.toolCallId) pending.set(e.toolCallId, { summary, bash: e.toolName === "bash" });
	});
	pi.on("tool_execution_end", async (e: { toolCallId?: string; isError?: boolean }, ctx: Ctx) => {
		const write = e.toolCallId ? pending.get(e.toolCallId) : undefined;
		const s = sessionOf(ctx);
		if (!write || !s || !e.toolCallId) return;
		pending.delete(e.toolCallId);
		const by = isMain(ctx) ? "main" : (ctx.agent?.id ?? "subagent");
		// bash 的退出码是整串命令最后一条的：写入后面常跟着查看、diff 之类的核对，它们非零不等于写入失败，只能记「没把握」
		const result = !e.isError ? { ok: true } : write.bash ? { unsure: true } : { ok: false };
		record({ sid: s, kind: "action", line: by === "main" ? undefined : taskOfAgent(readTable(), by.split(".")[0])?.name, summary: write.summary, ...result, by });
	});

	// ---------- 任务表工具（调度器模式关着时报错） ----------

	const taskOr = (task: string | undefined) => task?.trim() || GENERAL;
	const sidOf = (ctx: Ctx) => {
		const s = sessionOf(ctx);
		if (!isOn(s)) throw new Error(OFF_MESSAGE);
		return s ?? "";
	};

	const taskTool = {
		name: "tasktable_task",
		label: "Task table task",
		description:
			"Create or update a task: its owner agent, goal, completion criteria and the external inputs it watches. Only the fields you pass are changed. A new task needs agent and done_when; after creating it, spawn the owner with the task tool using exactly that agent name, so agent://<name> is this task's owner. Watched Slack, Feishu and PR links are read by the receivers, and new activity there is routed to this task; the result of this call says which of the entries you added no receiver can observe. Set status to 完成 to close it; that is refused until a reviewer has recorded a passing review with tasktable_review. 取消 closes it without a review.",
		parameters: z.object({
			task: z.string().describe("Task name, e.g. a ticket key like PROJ-123 or a short name."),
			agent: z.string().optional().describe("Owner agent name, CamelCase ASCII (e.g. Proj123); unique among open tasks."),
			title: z.string().optional().describe("Short title the operator understands."),
			goal: z.string().optional().describe("What the task is for. No implementation plan."),
			done_when: z.string().optional().describe("Checkable completion criteria: commands, artifacts, links."),
			watch_add: z.array(z.string()).optional().describe("Things to start watching, as full links: a Slack message, thread, channel or DM link, a Feishu chat or message link, or a PR link. Ticket keys and other identifiers are accepted but nobody observes them; they only help route messages."),
			watch_remove: z.array(z.string()).optional().describe("Links or identifiers to stop watching."),
			status: z.string().optional().describe("Leave empty while in progress; 完成 or 取消 closes the task."),
		}),
		async execute(_id: string, p: TaskParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const task = p.task.trim();
			if (!task || task === GENERAL) throw new Error("task name is required");
			const l = readTable();
			const agent = p.agent?.trim();
			if (agent && agentTaken(l, agent, task)) throw new Error(`owner agent name ${agent} is already used by another open task`);
			if (agent && isReviewerName(agent)) throw new Error(`owner agent name ${agent} looks like a reviewer name (ends in Review); pick another`);
			const isNew = !l.tasks.get(task)?.recorded;
			if (isNew && !agent) throw new Error("a new task needs agent");
			if (isNew && !p.done_when?.trim()) throw new Error("a new task needs done_when");
			if (p.status && needsReview(p.status)) {
				const blocker = doneBlocker(l, task, agent, p.done_when);
				if (blocker) throw new Error(blocker);
			}
			const { task: _task, agent: _agent, ...rest } = p;
			const fields = Object.fromEntries(Object.entries({ ...rest, agent }).filter(([, v]) => (Array.isArray(v) ? v.length : typeof v === "string")));
			if (!Object.keys(fields).length) throw new Error("nothing to change");
			record({ sid: s, kind: "task", line: task, ...fields });
			const blind = p.watch_add?.length ? screen.coverage(p.watch_add) : "";
			return { content: [{ type: "text", text: `${isNew ? `created ${task}. Now spawn its owner with the task tool, name="${agent}".` : `updated ${task}`}${blind}` }] };
		},
	};

	const updateTool = {
		name: "tasktable_update",
		label: "Task table update",
		description: "Create or update one item (a step or sub-piece of work) inside a task. Call it whenever an item's status, next step, chase date or PR changes. Only the fields you pass are changed.",
		parameters: z.object({
			task: z.string().optional().describe(`Task name; use ${GENERAL} for things outside any task.`),
			id: z.string().describe("Item id inside the task, e.g. T6. A new id creates an item."),
			title: z.string().optional().describe("Short item name the operator understands (no codes)."),
			status: z.string().optional().describe("e.g. 进行中 / 等你 / 等别人（某某） / 完成"),
			next: z.string().optional().describe("Next step, and for waiting items where the reply will come from."),
			chase: z.string().optional().describe("Chase date YYYY-MM-DD for waiting items."),
			pr: z.string().optional().describe("PR link once one exists."),
			source: z.string().optional().describe("Evidence link or place."),
		}),
		async execute(_id: string, p: UpdateParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const line = taskOr(p.task);
			const { task: _task, ...fields } = p;
			record({ sid: s, kind: "item", line, ...fields });
			return { content: [{ type: "text", text: `recorded ${line}/${p.id}` }] };
		},
	};

	const askTool = {
		name: "tasktable_ask",
		label: "Task table ask",
		description:
			"Questions and decisions for the operator. action=open registers a question and returns its number (use that number when asking); it needs checked, and returns what is already decided for that task so you can withdraw a question that is already answered. action=close closes a question that became moot. action=decide records a decision the operator stated in prose; pass n when it answers an open question, which also closes it. Replies made only of numbered answers like '1 做 2 不做' are recorded automatically; do not record them again.",
		parameters: z.object({
			action: z.enum(["open", "close", "decide"]),
			task: z.string().optional().describe(`Task name; defaults to ${GENERAL}.`),
			text: z.string().optional().describe("open: the question, answerable in 1-2 words. decide: the decision in the operator's terms."),
			checked: z.string().optional().describe("open: where you looked for an existing answer before asking (task table decisions, session records, the owner's material) and what you found there."),
			n: z.number().optional().describe("close: question number. decide: the question this decision answers, if any."),
			outcome: z.string().optional().describe("close: answer or why it is moot."),
		}),
		async execute(_id: string, p: AskParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			// 关闭、回答一个已登记的提问时没写任务：算在那个提问的任务上，不落到「日常」
			const line = p.task?.trim() || (p.n === undefined ? undefined : readTable().asks.get(p.n)?.line) || GENERAL;
			if (p.action === "close") {
				if (p.n === undefined || !readTable().asks.has(p.n)) throw new Error(`no open question ${p.n}`);
				record({ sid: s, kind: "ask_close", line, n: p.n, outcome: p.outcome ?? "", by: "model" });
				return { content: [{ type: "text", text: `closed ${p.n}` }] };
			}
			if (!p.text) throw new Error("text is required");
			if (p.action === "open") {
				const before = readTable();
				if (!p.checked?.trim()) throw new Error(`checked is required: say where you looked for an existing answer and what you found.\n${decidedFor(before, line, 0)}`);
				const n = before.lastAsk + 1;
				record({ sid: s, kind: "ask", line, n, text: p.text, checked: p.checked });
				const decided = decidedFor(readTable(), line, n);
				return { content: [{ type: "text", text: `question number ${n}${decided ? `\n${decided}\nIf one of these already answers it, close ${n} now (action=close) instead of asking.` : ""}` }] };
			}
			record({ sid: s, kind: "decision", line, date: today(), text: p.text, ...(p.n === undefined ? {} : { n: p.n }) });
			if (p.n !== undefined && readTable().asks.has(p.n)) record({ sid: s, kind: "ask_close", line, n: p.n, outcome: p.text, by: "operator" });
			return { content: [{ type: "text", text: "decision recorded" }] };
		},
	};

	const correctionTool = {
		name: "tasktable_correction",
		label: "Task table correction",
		description:
			"action=record: the operator corrected you. Record what was wrong in their terms, together with the one rule line you propose for <data_dir>/rules.md that would prevent it. The program registers the proposal as a question to the operator; put it to them once, in this reply, as that numbered question. After that it stays on their screen with the other open questions: do not repeat it. To propose a rule for an open correction recorded without one, pass its n instead of text. Once the operator has answered: if they agreed, write the rule (replace a similar older line instead of adding one), then action=close with n; if they declined, just close it.",
		parameters: z.object({
			action: z.enum(["record", "close"]),
			task: z.string().optional().describe(`Task name; defaults to ${GENERAL}.`),
			text: z.string().optional().describe("record: what was corrected, quoting the operator where possible."),
			rule: z.string().optional().describe("record: the rule line you propose, one sentence in the operator's language."),
			n: z.number().optional().describe("record: an open correction that has no rule proposed yet. close: correction number."),
			outcome: z.string().optional().describe("close: rule written, or declined."),
		}),
		async execute(_id: string, p: { action: "record" | "close"; task?: string; text?: string; rule?: string; n?: number; outcome?: string }, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const l = readTable();
			if (p.action === "close") {
				const k = p.n === undefined ? undefined : l.corrections.get(p.n);
				if (!k) throw new Error(`no open correction ${p.n}`);
				record({ sid: s, kind: "correction_close", line: k.line, n: k.n, outcome: p.outcome ?? "" });
				// 用户用一句话答的（不是只回编号）、或者模型先写了规则：规则提议那个提问还开着，跟着一起关，不留在用户屏幕上
				if (k.ask !== undefined && l.asks.has(k.ask)) record({ sid: s, kind: "ask_close", line: k.line, n: k.ask, outcome: p.outcome ?? "", by: "model" });
				return { content: [{ type: "text", text: `closed correction ${k.n}` }] };
			}
			const rule = p.rule?.trim();
			if (!rule) throw new Error("rule is required: the one rule line you propose for rules.md");
			const old = p.n === undefined ? undefined : l.corrections.get(p.n);
			if (p.n !== undefined && !old) throw new Error(`no open correction ${p.n}`);
			if (old?.ask !== undefined && l.asks.has(old.ask)) throw new Error(`correction ${old.n} already has its rule proposal open as question ${old.ask}`);
			const text = old?.text ?? p.text?.trim();
			if (!text) throw new Error("text is required");
			const line = old?.line ?? taskOr(p.task);
			const n = old?.n ?? l.lastCorrection + 1;
			const ask = l.lastAsk + 1;
			record({ sid: s, kind: "correction", line, n, text, rule, ask });
			record({ sid: s, kind: "ask", line, n: ask, text: `规则提议：${rule}（同意 / 不同意）`, checked: `operator correction: ${text}` });
			return { content: [{ type: "text", text: `correction number ${n}; the rule proposal is question ${ask}. Put it to the operator once in this reply as question ${ask}; after that it stays on their screen, do not repeat it.` }] };
		},
	};

	const reviewTool = {
		name: "tasktable_review",
		label: "Task table review",
		description:
			"Record the verdict of an independent review: of one item's result (pass item) or of the task as a whole (omit item). Only the reviewer the main session spawned for that task (a subagent named <owner agent>Review) can call it; the owner, its helpers and the main session cannot. A task can be closed as 完成 only with a passing review of the task as a whole, or when all its items are closed and every completed item has its own passing review. Marking an item 完成 is not gated.",
		parameters: z.object({
			task: z.string().describe("Task name, as on the task card."),
			item: z.string().optional().describe("Item id inside the task (e.g. T6) when you reviewed one item's result; omit when you reviewed the task against its completion criteria."),
			verdict: z.enum(["pass", "fail"]).describe("pass only if everything you were asked to check held up and you found nothing that breaks the goal."),
			evidence: z.string().describe("One line per thing checked: what it is, the command you ran or the artifact you opened, and what it actually showed."),
			findings: z.string().optional().describe("Required for fail. Each finding: command, actual output, what the goal requires. Only things you ran."),
		}),
		async execute(_id: string, p: ReviewParams, _signal: unknown, _onUpdate: unknown, ctx: Ctx) {
			const s = sidOf(ctx);
			const id = ctx.agent?.id ?? "";
			const l = readTable();
			const t = ctx.agent?.kind === "sub" ? taskOfReviewer(l, id) : undefined;
			if (!t || t.name !== p.task.trim()) throw new Error(`only the reviewer spawned by the main session for ${p.task} (a subagent named <owner agent>Review) can record its review`);
			const item = p.item?.trim();
			if (item && !l.items.get(t.name)?.has(item)) throw new Error(`${t.name} has no item ${item}; items: ${[...(l.items.get(t.name)?.keys() ?? [])].join(", ") || "none"}`);
			if (!p.evidence.trim()) throw new Error("evidence is required");
			if (p.verdict === "fail" && !p.findings?.trim()) throw new Error("a fail verdict needs findings");
			record({ sid: s, kind: "review", line: t.name, ...(item ? { item } : {}), verdict: p.verdict, evidence: p.evidence, findings: p.findings ?? "", by: id });
			return { content: [{ type: "text", text: `recorded ${p.verdict} for ${t.name}${item ? `/${item}` : ""}` }] };
		},
	};
}
