import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOldBoard, isOldUnit, listenerPid, withoutPluginCron } from "./deploy";

const LIVE = `17 9 * * * $HOME/.local/bin/ado-ssh-key-rotate --check >> $HOME/.local/state/ado-ssh-key-rotate/cron.log 2>&1
PATH=/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin
# 调度台外部消息源（/r）：只读外部系统，只写 /d/inbox
*/5 * * * * cd /r/sources && flock -n /d/logs/slack.lock python3 slack_poll.py >> /d/logs/slack.log 2>&1
*/5 * * * * cd /r/sources && flock -n /d/logs/pr.lock python3 pr_poll.py >> /d/logs/pr.log 2>&1
*/5 * * * * cd /r/sources && flock -n /d/logs/reminders.lock python3 reminders_poll.py >> /d/logs/reminders.log 2>&1
*/10 * * * * cd /d/lines/NewPayment-Launch/tracker && flock -n /tmp/np_track.lock timeout 540 python3 np_track.py >> cron.log 2>&1
`;

test("只删插件的补读：手写行和说明行、安装程序的区块；别的条目逐字保留", () => {
	const { crontab, removed } = withoutPluginCron(LIVE);
	expect(removed.length).toBe(4);
	expect(crontab).toBe(`17 9 * * * $HOME/.local/bin/ado-ssh-key-rotate --check >> $HOME/.local/state/ado-ssh-key-rotate/cron.log 2>&1
PATH=/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin
*/10 * * * * cd /d/lines/NewPayment-Launch/tracker && flock -n /tmp/np_track.lock timeout 540 python3 np_track.py >> cron.log 2>&1
`);
	const block = withoutPluginCron("a\n# BEGIN omp-dispatch-desk\n*/5 * * * * x pr_poll.py\n# END omp-dispatch-desk\nb\n");
	expect(block.crontab).toBe("a\nb\n");
	expect(withoutPluginCron("a\n").removed).toEqual([]);
});

test("认出旧单元、端口上的 pid、手动起的旧看板", () => {
	expect(isOldUnit("[Unit]\nDescription=omp-dispatch-desk：Slack 实时推送写外部消息\n")).toBe(true);
	expect(isOldUnit("[Unit]\nDescription=ssh agent\n")).toBe(false);
	const ss = 'LISTEN 0 512 127.0.0.1:8768 0.0.0.0:* users:(("bun",pid=4242,fd=12))\nLISTEN 0 4096 127.0.0.1:87680 0.0.0.0:* users:(("x",pid=1,fd=3))';
	expect(listenerPid(ss, 8768)).toBe(4242);
	expect(listenerPid(ss, 8769)).toBeUndefined();
	const proc = mkdtempSync(join(tmpdir(), "proc-"));
	mkdirSync(join(proc, "4242"));
	writeFileSync(join(proc, "4242", "cmdline"), "/usr/bin/bun\0/r/scripts/board.ts\0");
	mkdirSync(join(proc, "7"));
	writeFileSync(join(proc, "7", "cmdline"), "python3\0-m\0http.server\0");
	expect(isOldBoard(4242, proc)).toBe(true);
	expect(isOldBoard(7, proc)).toBe(false);
	expect(isOldBoard(99, proc)).toBe(false);
});
