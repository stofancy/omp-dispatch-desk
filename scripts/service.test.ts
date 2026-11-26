import { expect, test } from "bun:test";
import { claimPort, pollers } from "./deploy";

const inUse = () => Object.assign(new Error("in use"), { code: "EADDRINUSE" });

test("端口空着就占；被本插件的服务占着就复用；被别人占着就往后换；都占满报错", async () => {
	expect(await claimPort(8768, 3, p => `s${p}`, async () => false)).toEqual({ port: 8768, server: "s8768" });
	const busy = new Set([8768]);
	const serve = (p: number) => {
		if (busy.has(p)) throw inUse();
		return `s${p}`;
	};
	expect(await claimPort(8768, 3, serve, async () => true)).toEqual({ port: 8768 });
	expect(await claimPort(8768, 3, serve, async () => false)).toEqual({ port: 8769, server: "s8769" });
	busy.add(8769).add(8770);
	await expect(claimPort(8768, 3, serve, async () => false)).rejects.toThrow("8768–8770");
});

test("补读和原来 cron 里的一致", () => {
	expect(pollers({})).toEqual(["pr"]);
	expect(pollers({ reminders: {}, slack: { domain: "", me: "", user_token: { file: "" }, app_token: { file: "" }, channels: {} } })).toEqual(["pr", "reminders", "slack"]);
});
