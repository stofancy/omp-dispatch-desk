import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { HOME, PLUGIN_ROOT } from "../src/paths";
import { hasFeishu, readConfig, runSetup, type SetupUI } from "../src/setup";
import { writeAtomic } from "../src/table";
import { DEFAULT_PORT, isOldBoard, isOldUnit, listenerPid, withoutPluginCron } from "./deploy";

const DRY = process.argv.includes("--dry-run");
const ROOT = realpathSync(PLUGIN_ROOT);
const DATA = resolve(HOME);
const UNIT_MARKER = "# 由 omp-dispatch-desk 安装程序管理\n";

function run(command: string, args: string[] = [], input?: string) {
	return spawnSync(command, args, {
		encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
		...(input === undefined ? {} : { input }),
	});
}

function checked(command: string, args: string[] = [], input?: string): string {
	const result = run(command, args, input);
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `${[command, ...args].join(" ")} 失败（${result.status}）`);
	return result.stdout;
}

async function install(rl?: Interface) {
	const packages = ["omp", "bun", "python3", "gh", "lark-cli"] as const;
	const binaries = Object.fromEntries(packages.map(command => [command, Bun.which(command)]));
	console.log("检查命令：");
	for (const command of packages) console.log(`  ${command}: ${binaries[command] ?? "未找到"}`);
	const { omp, bun, python3, gh, "lark-cli": lark } = binaries;
	if (!omp || !bun || !python3 || !gh) throw new Error("请先安装 omp、bun、python3、gh。");
	const stamp = new Date().toISOString().replace(/:/g, "-");
	const ask = async (title: string, message: string) => {
		console.log(`${title}：${message}`);
		return rl ? /^(y|yes)$/i.test((await rl.question("确认？[y/N] ")).trim()) : false;
	};

	const { name } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	const plugins = JSON.parse(checked(omp, ["plugin", "list", "--json"])) as { npm: Array<{ name: string; path: string }> };
	const linked = plugins.npm.some(p => p.name === name && existsSync(p.path) && realpathSync(p.path) === ROOT);
	if (linked) console.log(`omp 插件已链接，跳过：${ROOT}`);
	else if (await ask("链接 omp 插件", `omp plugin link ${ROOT}`)) checked(omp, ["plugin", "link", ROOT]);

	if (existsSync(DATA)) console.log(`数据目录已存在：${DATA}`);
	else if (await ask("创建数据目录", DATA)) mkdirSync(DATA, { recursive: true });
	else if (!DRY) return;

	if (DRY) console.log("跳过交互配置；按当前 config.json 预览部署。");
	else if (rl && await ask("配置调度台", "启动配置向导；保存前另行确认。")) {
		const terminal: SetupUI = {
			async select(title, options) {
				console.log(title);
				for (const [i, option] of options.entries()) console.log(`  ${i + 1}. ${option}`);
				for (;;) {
					const answer = (await rl.question("选择编号（回车取消）：")).trim();
					if (!answer) return;
					const index = Number(answer) - 1;
					if (Number.isInteger(index) && options[index] !== undefined) return options[index];
				}
			},
			input: title => rl.question(`${title}：`),
			async editor(title, prefill) {
				console.log(title);
				const dir = mkdtempSync(join(tmpdir(), "dispatch-desk-editor-"));
				try {
					const file = join(dir, "about.txt");
					writeFileSync(file, prefill ?? "");
					rl.pause();
					const editor = process.env.VISUAL || process.env.EDITOR || "vi";
					const result = spawnSync("sh", ["-c", `${editor} "$1"`, "editor", file], { stdio: "inherit" });
					if (result.error) throw result.error;
					if (result.status === 0) return readFileSync(file, "utf8");
				} finally {
					rl.resume();
					rmSync(dir, { recursive: true, force: true });
				}
			},
			confirm: ask,
			notify: message => console.log(message),
		};
		await runSetup(terminal);
	}

	const config = readConfig();
	if (hasFeishu(config) && !lark && !DRY) throw new Error("飞书已配置，请先安装 lark-cli 再部署。");
	const cronPaths = [dirname(omp), dirname(gh), dirname(python3), ...(lark ? [dirname(lark)] : []), "/usr/local/bin", "/usr/bin", "/bin"];
	const path = [...new Set(cronPaths)].join(":");
	const units = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");
	const unitQuote = (value: string) => JSON.stringify(value.replace(/%/g, "%%"));

	// 1. 统一常驻服务：看板、实时推送、定时补读都在 dispatch-desk.service 里
	const service = "dispatch-desk.service";
	const file = join(units, service);
	const oldUnit = existsSync(file) ? readFileSync(file, "utf8") : undefined;
	const unit = UNIT_MARKER + readFileSync(join(ROOT, "deploy", service), "utf8")
		.replace(/^(?:#[^\n]*\n)+/, "")
		.replace(/^\[Service\]$/m, () => `[Service]\nEnvironment=${unitQuote(`DISPATCH_DESK_HOME=${DATA}`)}\nEnvironment=${unitQuote(`PATH=${path}`)}`)
		.replace(/^ExecStart=<bun> <repo>\/(\S+)/m, (_full: string, script: string) => `ExecStart=${unitQuote(bun)} ${unitQuote(join(ROOT, script))}`);

	// 看板端口被手动起的旧看板占着：问过才结束它，不答或答否就不动，服务自己换端口
	const ss = run("ss", ["-ltnpH"]);
	const holder = ss.status === 0 ? listenerPid(ss.stdout, DEFAULT_PORT) : undefined;
	if (holder && isOldBoard(holder)) {
		if (await ask("结束旧看板", `进程 ${holder}（bun scripts/board.ts）占着 ${DEFAULT_PORT}。结束它，让常驻服务用 ${DEFAULT_PORT}？不结束的话服务换到下一个空端口，状态栏显示实际端口。`)) process.kill(holder, "SIGTERM");
	} else if (holder) console.log(`端口 ${DEFAULT_PORT} 被进程 ${holder} 占着（不是旧看板）：常驻服务会自己换端口。`);

	const backupInfo = oldUnit !== undefined && oldUnit !== unit ? `先备份旧文件到 ${join(DATA, `${service}.bak.${stamp}`)}。` : "";
	if (await ask("部署统一常驻服务", `${file}。${backupInfo}启用并重启 ${service}：\n${unit.trimEnd()}`)) {
		if (oldUnit !== unit) {
			if (oldUnit !== undefined) writeFileSync(join(DATA, `${service}.bak.${stamp}`), oldUnit, { mode: 0o600, flag: "wx" });
			mkdirSync(units, { recursive: true });
			writeAtomic(file, unit);
			checked("systemctl", ["--user", "daemon-reload"]);
		}
		checked("systemctl", ["--user", "enable", service]);
		checked("systemctl", ["--user", "restart", service]);
	}

	// 2. 旧的单独推送服务：并进统一服务后停用、删除（先备份）
	for (const old of ["dispatch-desk-slack.service", "dispatch-desk-feishu.service"]) {
		const oldFile = join(units, old);
		const text = existsSync(oldFile) ? readFileSync(oldFile, "utf8") : undefined;
		if (!text || !isOldUnit(text)) continue;
		const backup = join(DATA, `${old}.bak.${stamp}`);
		if (await ask("移除旧的推送服务", `已并进 ${service}。备份 ${oldFile} 到 ${backup}，停用并删除。`)) {
			writeFileSync(backup, text, { mode: 0o600, flag: "wx" });
			checked("systemctl", ["--user", "disable", "--now", old]);
			rmSync(oldFile);
			checked("systemctl", ["--user", "daemon-reload"]);
		}
	}

	// 3. 定时补读改由常驻服务跑：只删插件自己的 crontab 条目，其余原样保留
	const crontab = run("crontab", ["-l"]);
	if (crontab.error) throw crontab.error;
	if (crontab.status !== 0 && !crontab.stderr.includes("no crontab for")) throw new Error(crontab.stderr.trim());
	const oldCron = crontab.status === 0 ? crontab.stdout : "";
	const { crontab: newCron, removed } = withoutPluginCron(oldCron);
	const backup = join(DATA, `crontab.bak.${stamp}`);
	if (!removed.length) console.log("crontab 里没有插件的定时补读，跳过。");
	else if (await ask("移除 crontab 里的定时补读", `改由常驻服务跑。备份当前内容到 ${backup}，只删下列行，其余不动：\n${removed.join("\n")}`)) {
		writeFileSync(backup, oldCron, { mode: 0o600, flag: "wx" });
		checked("crontab", ["-"], newCron);
	}
	if (DRY) console.log("预览结束，未改动插件、配置、crontab 或 systemd。");
}

const rl = DRY ? undefined : createInterface({ input: process.stdin, output: process.stdout });
try {
	await install(rl);
} catch (err) {
	console.error(`安装未完成：${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
} finally {
	rl?.close();
}
