// 安装程序里不碰系统的那部分：算出新 crontab、认出占着看板端口的旧看板。单独放这里好测。
import { readFileSync } from "node:fs";
import type { Config } from "../sources/config";

export const APP = "dispatch-desk"; // 常驻服务 /health 回答里的标识：认自己的进程

export const DEFAULT_PORT = 8768; // 看板默认端口；被别的程序占着时常驻服务往后换

// 插件自己的 crontab 条目：安装程序标记的区块，加上手写的补读行（cd …/sources && … <源>_poll.py）和它上面那行说明。
// 别的条目（其他程序的定时任务、PATH= 等）原样保留
const BLOCK = /^# BEGIN omp-dispatch-desk\n[\s\S]*?^# END omp-dispatch-desk\n?/m;
const POLL_LINE = /\/sources && .*\b(slack|pr|reminders|feishu)_poll\.py\b/;
const COMMENT_LINE = /^# 调度台外部消息源/;

export function withoutPluginCron(crontab: string): { crontab: string; removed: string[] } {
	const removed: string[] = [];
	const block = BLOCK.exec(crontab)?.[0];
	if (block) removed.push(...block.trimEnd().split("\n"));
	const kept = crontab.replace(BLOCK, "").split("\n").filter(line => {
		const ours = POLL_LINE.test(line) || COMMENT_LINE.test(line);
		if (ours) removed.push(line);
		return !ours;
	});
	return { crontab: kept.join("\n"), removed };
}

// 旧的 systemd 单元：本插件的推送服务（安装程序装的带标记，早期手写的看 Description）
export const isOldUnit = (text: string) => /omp-dispatch-desk/.test(text);

// `ss -ltnpH` 的输出里，监听 port 的进程 pid
export function listenerPid(ssOutput: string, port: number): number | undefined {
	for (const line of ssOutput.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (!cols[3]?.endsWith(`:${port}`)) continue;
		const pid = /pid=(\d+)/.exec(line)?.[1];
		if (pid) return Number(pid);
	}
	return undefined;
}

// 这个进程是不是手动起的旧看板（bun scripts/board.ts）：读 /proc/<pid>/cmdline
export function isOldBoard(pid: number, proc = "/proc"): boolean {
	try {
		return readFileSync(`${proc}/${pid}/cmdline`, "utf8").split("\0").some(arg => arg.endsWith("scripts/board.ts"));
	} catch {
		return false;
	}
}

// 有哪些补读：和原来 cron 里的一致
export function pollers(cfg: Config): string[] {
	return ["pr", ...(cfg.reminders ? ["reminders"] : []), ...(cfg.slack ? ["slack"] : []), ...(cfg.feishu?.accounts?.some(a => a.poll) ? ["feishu"] : [])];
}

// 从 start 起找端口：空着就占；被本插件的另一个服务占着就复用（不起第二个看板）；被别的程序占着就试下一个
export async function claimPort<S>(start: number, tries: number, serve: (port: number) => S, ours: (port: number) => Promise<boolean>): Promise<{ port: number; server?: S }> {
	for (let port = start; port < start + tries; port++) {
		try {
			return { port, server: serve(port) };
		} catch (err) {
			if (!(err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE")) throw err;
			if (await ours(port)) return { port };
		}
	}
	throw new Error(`端口 ${start}–${start + tries - 1} 都被别的程序占着`);
}

// 这个端口上是不是本插件的服务：看 /health 的回答
export async function isOurs(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
		const body: unknown = await res.json();
		return !!body && typeof body === "object" && "app" in body && body.app === APP;
	} catch {
		return false;
	}
}

