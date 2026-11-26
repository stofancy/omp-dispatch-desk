// 插件唯一的常驻服务：看板 HTTP、Slack／飞书实时推送、定时补读，一个进程、一个 systemd 单元（deploy/dispatch-desk.service）。
// 各部分互不拖累：一部分出错只记在它自己的健康文件里。实际端口和 pid 写在 state/service.json，插件的状态栏和链接读它。
// 进程卡住时 systemd 不会重启它：每 30 秒写一次自己的健康文件，插件在会话里发现超时就报故障（src/health.ts）。
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardResponse } from "../scripts/board";
import { APP, DEFAULT_PORT, claimPort, isOurs, pollers } from "../scripts/deploy";
import { HOME, config, writeHealth } from "./config";
import { runFeishuSocket, stopFeishuSocket } from "./feishu_socket";

export const SERVICE_STATE = join(HOME, "state", "service.json"); // 和 src/paths.ts 的 SERVICE_STATE 同一个文件
const PORT_TRIES = 20;
const POLL_S = 300; // 和补读脚本记健康状态用的周期一致
const POLL_TIMEOUT_S = 270; // 一次补读最多跑这么久，下一拍之前一定结束
const BEAT_S = 30;
const LOGS = join(HOME, "logs");

function writeState(state: Record<string, unknown>): void {
	mkdirSync(join(HOME, "state"), { recursive: true });
	const tmp = `${SERVICE_STATE}.tmp`;
	writeFileSync(tmp, JSON.stringify(state));
	renameSync(tmp, SERVICE_STATE);
}

const log = (msg: string) => console.log(`${new Date().toLocaleString("sv-SE")} ${msg}`);

// 一次补读：锁和日志沿用原来 cron 的路径（logs/<源>.lock、logs/<源>.log），迁移期间和旧 cron 同时在也不会双跑
function poll(name: string): void {
	mkdirSync(LOGS, { recursive: true });
	const out = openSync(join(LOGS, `${name}.log`), "a");
	const proc = Bun.spawn(["flock", "-n", join(LOGS, `${name}.lock`), "python3", `${name}_poll.py`], { cwd: import.meta.dir, stdout: out, stderr: out, env: { ...process.env, DISPATCH_DESK_HOME: HOME } });
	const kill = setTimeout(() => proc.kill(), POLL_TIMEOUT_S * 1000);
	proc.exited.finally(() => {
		clearTimeout(kill);
		closeSync(out);
	});
}

async function start(): Promise<void> {
	const started = new Date().toISOString();
	const fetchHandler = (req: Request) =>
		new URL(req.url).pathname === "/health" ? Response.json({ app: APP, pid: process.pid, started }) : (boardResponse(req) ?? new Response("not found", { status: 404 }));
	const { port, server } = await claimPort(DEFAULT_PORT, PORT_TRIES, p => Bun.serve({ hostname: "127.0.0.1", port: p, fetch: fetchHandler }), isOurs);
	writeState({ app: APP, pid: process.pid, port, started, board: server ? "own" : "reused" });
	log(server ? `看板 http://127.0.0.1:${port}/` : `端口 ${port} 上已有本插件的服务，看板复用它`);
	if (port !== DEFAULT_PORT) log(`${DEFAULT_PORT} 被别的程序占着，换到 ${port}`);

	const beat = () => writeHealth("service", "常驻服务", BEAT_S * 2);
	beat();
	setInterval(beat, BEAT_S * 1000);

	for (const name of pollers(config)) {
		poll(name);
		setInterval(() => poll(name), POLL_S * 1000);
	}

	if (config.slack) {
		// 动态导入：slack_socket 加载时就读令牌，没配 Slack 或令牌文件读不到会直接抛错，不能拖垮看板和补读
		import("./slack_socket")
			.then(m => m.runSlackSocket())
			.catch(err => {
				log(`Slack 实时推送起不来：${err}`);
				writeHealth("slack-socket", "Slack 实时推送", 60, String(err));
			});
	}
	const stop = () => {
		stopFeishuSocket();
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	runFeishuSocket().catch(err => log(`飞书推送退出：${err}`));
}

if (import.meta.main) await start();
