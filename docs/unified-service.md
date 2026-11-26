# 插件统一常驻服务

## 为什么

原来插件在本机起了几样东西，各管各的：Slack 实时推送是一个 systemd 单元，Slack、PR、提醒三个补读是 cron 每 5 分钟跑一次，看板要手动 `bun run board`。端口、pid、日志散在各处，看板不随机器起来，开了几个会话就可能起几个看板。

现在只留一个常驻服务：一个进程、一个 systemd 单元 `dispatch-desk.service`。

## 结构

- 入口 `sources/service.ts`，单元模板 `deploy/dispatch-desk.service`，由 `bun scripts/install.ts` 渲染安装。
- 里面放：看板 HTTP（`scripts/board.ts` 的 `boardResponse`）、Slack 实时推送（`slack_socket.ts` 的 `runSlackSocket`）、飞书推送（`feishu_socket.ts` 的 `runFeishuSocket`）、定时补读（每 5 分钟调一次 `<源>_poll.py`）。
- 各部分出错互不拖累，各写各的健康文件 `state/health/<名>.json`；服务自己每 30 秒写 `state/health/service.json`。
- 服务把 pid 和实际端口写进 `state/service.json`，提供 `/health`，回答 `{app:"dispatch-desk", pid, started}`。插件状态栏读 `service.json` 显示看板地址。
- 端口默认 8768。被占时先问 `/health`：是本插件的服务就复用，不起第二个；不是就往后换（最多试 20 个），记下实际端口。服务从不结束别的进程。
- 补读的锁和日志沿用线上 cron 的路径：`<数据目录>/logs/<源>.lock`、`logs/<源>.log`。迁移期间旧 cron 还在也不会双跑。一次补读最多跑 270 秒。

## 迁移

线上 crontab 的补读是手写的三行（slack、pr、reminders），没有安装程序的 BEGIN/END 标记；同一份 crontab 里还有 `ado-ssh-key-rotate`、`np_track` 和 `PATH=`，这些不归插件，一律不动。

`bun scripts/install.ts` 按下面顺序做，每一步先显示内容并问「确认？」，不答或答否就跳过：

1. 看板端口被手动起的旧看板（本用户、命令行含 `scripts/board.ts`）占着：问要不要结束它。不结束，服务换端口。
2. 装 `dispatch-desk.service`，启用并重启。
3. 停用并删除旧的 `dispatch-desk-slack.service`（和飞书单元，若有），先备份成 `<数据目录>/dispatch-desk-slack.service.bak.<时间戳>`。
4. 从 crontab 删掉插件自己的条目（手写的补读行、上面那行说明、安装程序的区块），先把整份备份成 `<数据目录>/crontab.bak.<时间戳>`。其余条目逐字保留。

`--dry-run` 只预览，不改任何东西。

## 回退

- crontab：`crontab <数据目录>/crontab.bak.<时间戳>`，整份恢复。
- 旧推送单元：`cp <数据目录>/dispatch-desk-slack.service.bak.<时间戳> ~/.config/systemd/user/dispatch-desk-slack.service`，`systemctl --user daemon-reload && systemctl --user enable --now dispatch-desk-slack`。
- 停新服务：`systemctl --user disable --now dispatch-desk`。

## 风险和对策

1. 切换单元时 Slack 推送断约 10 秒：这期间的消息由补读兜底，最多晚 5 分钟，不丢。
2. 8768 被旧看板或别的程序占着：只在安装时、问过才结束旧看板；默认不结束，服务换端口，状态栏显示实际端口。最坏暂时有两个看板。
3. 进程卡住没退出，`Restart=always` 不会触发：服务和各部分都写心跳，插件在会话里（`src/health.ts`）发现超过 3 个周期没更新就在状态栏报故障，并提醒主会话一次。systemd 的 WatchdogSec 先不做。
4. 补读搬进进程后没有 cron 这层独立保险：靠第 3 条报警。不保留 cron 作后备，避免重复调度。
