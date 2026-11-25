import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { handle as Handle } from "./feishu_socket";

let home: string;
let handle: typeof Handle;
const profile = "示例公司";
const identity = { owner: "ou_owner", bot: "ou_bot" };
const base = {
	chat_type: "p2p",
	chat_id: "oc_direct",
	sender_id: identity.owner,
	message_type: "text",
	content: "看一下进展",
	create_time: "1795219200000",
};
const bot = { id: identity.bot, key: "@_user_1", name: "调度机器人" };

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "dispatch-feishu-socket-"));
	writeFileSync(join(home, "config.json"), "{}");
	const previous = process.env.DISPATCH_DESK_HOME;
	process.env.DISPATCH_DESK_HOME = home;
	// 消息源在模块加载时读配置，测试先把路径指向临时目录。
	try {
		({ handle } = await import("./feishu_socket"));
	} finally {
		if (previous === undefined) delete process.env.DISPATCH_DESK_HOME;
		else process.env.DISPATCH_DESK_HOME = previous;
	}
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const consume = (message_id: string, event: Record<string, unknown> = {}) =>
	handle(JSON.stringify({ ...base, message_id, ...event }), profile, identity, async (ev) => ({
		who: "甲",
		chatName: ev.chat_type === "group" ? "示例群" : undefined,
	}));
const filename = (id: string) => `${base.create_time}000000-feishu-${id}.json`;
const operatorFile = (id: string) => join(home, "inbox", "operator", "new", filename(id));
const externalFile = (id: string) => join(home, "inbox", "new", filename(id));

test("使用者私聊机器人，写入完整的使用者输入", async () => {
	await consume("om_owner_p2p");
	expect(JSON.parse(readFileSync(operatorFile("om_owner_p2p"), "utf8"))).toEqual({
		source: "feishu", profile, chat_id: base.chat_id, chat_type: "p2p", chat_name: "",
		message_id: "om_owner_p2p", text: base.content,
		link: `https://applink.feishu.cn/client/chat/open?openChatId=${base.chat_id}`,
		at: new Date(Number(base.create_time)).toISOString(),
	});
	expect(await Bun.file(externalFile("om_owner_p2p")).exists()).toBe(false);
});

test("使用者在未登记的群里点名机器人，去掉机器人的占位并保留其他提及", async () => {
	await consume("om_owner_group", {
		chat_type: "group", chat_id: "oc_unwatched", content: "@_user_1 看一下 @_user_2 的进展",
		mentions: [bot, { id: "ou_other", key: "@_user_2", name: "甲" }],
	});
	expect(JSON.parse(readFileSync(operatorFile("om_owner_group"), "utf8"))).toMatchObject({
		chat_type: "group", chat_name: "示例群", text: "看一下 @_user_2 的进展",
	});
	await consume("om_owner_rendered", {
		chat_type: "group", chat_id: "oc_unwatched", content: "@调度机器人 看一下进展", mentions: [bot],
	});
	expect(JSON.parse(readFileSync(operatorFile("om_owner_rendered"), "utf8")).text).toBe("看一下进展");
});

test("他人私聊机器人，写入带原文的外部消息（插件送时再截短转义）", async () => {
	await consume("om_other_p2p", { sender_id: "ou_other" });
	expect(JSON.parse(readFileSync(externalFile("om_other_p2p"), "utf8"))).toEqual({
		source: "feishu", who: "甲", where: "机器人私聊 甲",
		link: `https://applink.feishu.cn/client/chat/open?openChatId=${base.chat_id}`, text: "看一下进展",
	});
	expect(await Bun.file(operatorFile("om_other_p2p")).exists()).toBe(false);
});

test("未登记群的普通消息不写入，点名机器人时写为外部消息", async () => {
	const event = { chat_type: "group", chat_id: "oc_unwatched", sender_id: "ou_other" };
	await consume("om_unwatched", event);
	expect(await Bun.file(externalFile("om_unwatched")).exists()).toBe(false);
	expect(await Bun.file(operatorFile("om_unwatched")).exists()).toBe(false);
	await consume("om_other_group", { ...event, mentions: [bot] });
	expect(JSON.parse(readFileSync(externalFile("om_other_group"), "utf8"))).toMatchObject({ where: "示例群" });
	expect(await Bun.file(operatorFile("om_other_group")).exists()).toBe(false);
});

test("同一个 message_id 在 new 或 claimed 里都不重写", async () => {
	const id = "om_repeated";
	const path = operatorFile(id);
	await consume(id);
	const first = readFileSync(path, "utf8");
	await consume(id, { create_time: "1795219201000", content: "不应覆盖" });
	const dir = join(home, "inbox", "operator");
	expect(readdirSync(join(dir, "new")).filter(f => f.endsWith(`-feishu-${id}.json`))).toEqual([filename(id)]);
	expect(readFileSync(path, "utf8")).toBe(first);
	mkdirSync(join(dir, "claimed"));
	renameSync(path, join(dir, "claimed", filename(id)));
	await consume(id);
	expect(await Bun.file(path).exists()).toBe(false);
});

test("任务登记的群消息按整群或单条登记决定是否带任务名", async () => {
	const state = join(home, "state");
	mkdirSync(state);
	writeFileSync(join(state, "watch.json"), JSON.stringify({ feishu: [
		{ chat: "oc_whole", task: "PROJ-1", whole: true },
		{ chat: "oc_whole", task: "PROJ-2" },
		{ chat: "oc_partial", task: "PROJ-2" },
	] }));
	const event = { chat_type: "group", sender_id: "ou_other", root_id: "om_root" };
	await consume("om_whole", { ...event, chat_id: "oc_whole" });
	await consume("om_partial", { ...event, chat_id: "oc_partial" });
	expect(JSON.parse(readFileSync(externalFile("om_whole"), "utf8"))).toMatchObject({ where: "示例群 (thread reply)", line: "PROJ-1" });
	expect(JSON.parse(readFileSync(externalFile("om_partial"), "utf8")).line).toBeUndefined();
});

test("使用者的非文本消息写占位", async () => {
	await consume("om_image", { message_type: "image", content: "资源元数据" });
	expect(JSON.parse(readFileSync(operatorFile("om_image"), "utf8")).text).toBe("[图片]");
});
