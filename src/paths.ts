// 数据目录：任务表、外部消息。和代码分开。
// 默认 $XDG_DATA_HOME/dispatch-desk（通常是 ~/.local/share/dispatch-desk），可用 DISPATCH_DESK_HOME 覆盖。
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = process.env.DISPATCH_DESK_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "dispatch-desk");

export const TASKS = join(HOME, "tasks"); // tasks/events.jsonl、views/：全局唯一一份任务表
export const INBOX_NEW = join(HOME, "inbox/new");
export const INBOX_CLAIMED = join(HOME, "inbox/claimed");
export const OPERATOR_NEW = join(HOME, "inbox/operator/new");
export const OPERATOR_CLAIMED = join(HOME, "inbox/operator/claimed");
export const ERRLOG = join(HOME, "logs/extension-errors.log");
export const USER_RULES = join(HOME, "rules.md"); // 用户自己的补充规则，接在插件规则后面
export const CONFIG = join(HOME, "config.json"); // 规则参数（rules 段）和外部事件源的配置
export const DISPATCH_STATE = join(HOME, "state/dispatch"); // 调度器模式的开关：每个打开的主会话一个文件
export const FEISHU_OWNER_CHAT = join(HOME, "state/feishu-owner-chat.json");

export const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url)); // 插件自己的目录：代码和自带的规则
const prompt = (name: string) => join(PLUGIN_ROOT, "prompts", name);
export const DISPATCH_RULES = prompt("调度规则.md");
export const OWNER_RULES = prompt("负责人规则.md");
export const REVIEW_RULES = prompt("审查规则.md");
export const ORDERS = prompt("常设约束.md");
export const HEALTH = join(HOME, "state/health"); // 每个接收程序一个文件：最后一次成功的时间、最近的错
export const WATCH_PLAN = join(HOME, "state/watch.json"); // 未完成任务登记的、接收程序读得到的盯办项：补读和实时推送照它定范围
export const HEADS = join(HOME, "state/heads"); // 每个会话一个文件：回复上方画过的标头，续会话时照原样画回去
export const HELD = join(HOME, "state/held"); // 每个主会话一个目录：子代理写好了、omp 还压着没送的交回
export const REVIEWING = join(HOME, "state/reviewing"); // 每个主会话一个文件：哪些任务正在被审查，负责 agent 据此先不把结果发出去
export const TRIAGE_LOG = join(HOME, "state/triage.jsonl"); // 接收程序分拣过的消息：拦下的只记在这里，不进收件箱
export const SERVICE_STATE = join(HOME, "state/service.json"); // 常驻服务写的实际端口和 pid：状态栏和看板链接用它
