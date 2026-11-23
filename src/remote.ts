// 对外动作记账：只看工具结果里对方回的成功回执，不看命令文本说了什么。拿不准的不记。
// 命令文本只用来分类（是推送、是哪个 Slack 方法），没有回执就不记；失败、被拒、本地路径都不记。
export interface Action {
	type: string; // slack.postMessage、git push、pr create、gh api、mcp …
	target: string; // 频道、仓库+分支、PR……
	link: string; // 回执里的链接；没有就空
}

// 把一行 shell 拆成简单命令：在引号、$( )、( ) 外面的 | ; && 换行处断开
export function commands(cmd: string): string[] {
	const out: string[] = [];
	const open: string[] = [];
	let start = 0;
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i];
		const top = open.at(-1);
		if (top === "'") {
			if (c === "'") open.pop();
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		const sub = c === "$" && cmd[i + 1] === "(";
		if (sub) i++;
		if (top === '"') {
			if (c === '"') open.pop();
			else if (sub) open.push("(");
		} else if (c === "'" || c === '"') open.push(c);
		else if (sub || c === "(") open.push("(");
		else if (c === ")" && top === "(") open.pop();
		else if (!open.length && (c === "|" || c === ";" || c === "\n" || (c === "&" && cmd[i + 1] === "&"))) {
			out.push(cmd.slice(start, i));
			start = i + 1;
		}
	}
	out.push(cmd.slice(start));
	return out;
}

const SLACK_METHOD = /\b(chat\.(?:postMessage|update|delete|scheduleMessage)|reactions\.(?:add|remove)|files\.(?:upload|completeUploadExternal))\b/;
const GIT_PUSH = /^[\s&]*(?:\w+=\S*\s+)*(?:(?:env|command|sudo)\s+)?(?:\S*\/)?git(?:\s+(?:-C\s+\S+|-c\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b(?!.*(?:--dry-run|\s-n\b))/;
const GH_WRITE = /^[\s&]*(?:\w+=\S*\s+)*(?:\S*\/)?gh\s+(pr|issue|release)\s+(create|edit|comment|merge|close|reopen|review|ready)\b/;
const GH_API = /^[\s&]*(?:\w+=\S*\s+)*(?:\S*\/)?gh\s+api\b.*(?:\s-X\s*(?:POST|PATCH|PUT|DELETE)\b|--method[\s=](?:POST|PATCH|PUT|DELETE)\b|\s(?:-f|-F|--field|--raw-field|--input)\s)/i;
const GH_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+(?:#(?:issuecomment|pullrequestreview|discussion_r)-?\d+)?/;
const GH_COMMENT_URL = /"html_url"\s*:\s*"(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+#(?:issuecomment|pullrequestreview|discussion_r)-?\d+)"/;

const noUserinfo = (u: string) => u.replace(/^(\w+:\/\/)[^/@\s]+@/, "$1");

// 输出里顶层的 JSON 对象（每个 { 到配平的 }），解析得了的才算
function jsonObjects(text: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (let i = text.indexOf("{"); i >= 0 && out.length < 20; i = text.indexOf("{", i + 1)) {
		let depth = 0;
		let inStr = false;
		for (let j = i; j < text.length; j++) {
			const c = text[j];
			if (inStr) {
				if (c === "\\") j++;
				else if (c === '"') inStr = false;
			} else if (c === '"') inStr = true;
			else if (c === "{") depth++;
			else if (c === "}" && --depth === 0) {
				try {
					const v = JSON.parse(text.slice(i, j + 1));
					if (v && typeof v === "object") out.push(v);
					i = j;
				} catch {}
				break;
			}
		}
	}
	return out;
}

function slackReceipt(cmd: string, out: string): Action | undefined {
	const method = SLACK_METHOD.exec(cmd)?.[1];
	if (!method) return undefined;
	const replies = jsonObjects(out).filter(o => typeof o.ok === "boolean");
	if (!replies.length || replies.some(o => o.ok === false || o.error) || replies.at(-1)?.ok !== true) return undefined; // 多步里任何一步失败都不算成功
	const ok = replies.findLast(o => typeof o.ts === "string") ?? replies.at(-1) ?? {};
	const channel = typeof ok.channel === "string" ? ok.channel : String(ok.channel && (ok.channel as { id?: string }).id ? (ok.channel as { id: string }).id : "");
	const ts = typeof ok.ts === "string" ? ok.ts : typeof ok.message_ts === "string" ? ok.message_ts : "";
	const permalink = /https:\/\/[\w.-]+\.slack\.com\/archives\/\w+\/p\d+\S*/.exec(out)?.[0] ?? "";
	return { type: `slack.${method.split(".")[1]}`, target: channel, link: permalink || (channel && ts ? `slack:${channel}/${ts}` : "") };
}

// 本地路径正向识别：/、./、../、file://、~ 开头；其余（host:path、ssh://、https://）都当远端
const LOCAL_PATH = /^(?:\/|\.\.?\/|file:\/\/|~)/;

function pushReceipt(out: string): Action | undefined {
	const to = /^To\s+(\S+)\s*$/m.exec(out)?.[1];
	if (!to || LOCAL_PATH.test(to)) return undefined; // 推到本地路径不算对外动作
	if (/^\s*!\s.*\[(?:remote )?rejected\]|^\s*!\s/m.test(out) || /\berror: failed to push\b/.test(out)) return undefined;
	const ok = /^\s*(?:[0-9a-f]{7,}\.{2,3}[0-9a-f]{7,}|\*\s+\[new (?:branch|tag)\]|\+\s+[0-9a-f]{7,}\.{3}[0-9a-f]{7,}|-\s+\[deleted\]).*?(?:->|\s)(\S+)\s*$/m.exec(out);
	if (!ok) return undefined;
	const ref = (/->\s*(\S+)\s*$/m.exec(ok[0]) ?? [])[1] ?? ok[1];
	const url = noUserinfo(to).replace(/\.git$/, "");
	return { type: "git push", target: `${url} ${ref}`, link: url };
}

function ghReceipt(simple: string, out: string): Action | undefined {
	const w = GH_WRITE.exec(simple);
	if (w) {
		const url = GH_URL.exec(out)?.[0];
		const done = /✓\s+(?:Merged|Closed|Reopened|Approved|Requested changes|Added a comment|Created|Edited)\b[^\n]*#(\d+)/.exec(out);
		if (url) return { type: `${w[1]} ${w[2]}`, target: url.replace(/#.*/, ""), link: url };
		if (done) return { type: `${w[1]} ${w[2]}`, target: `#${done[1]}`, link: "" };
		return undefined;
	}
	if (GH_API.test(simple)) {
		const url = GH_COMMENT_URL.exec(out)?.[1];
		if (url) return { type: "gh api", target: url.replace(/#.*/, ""), link: url };
	}
	return undefined;
}

// 一次 bash 调用：命令只用来分类，成立与否看输出里的回执
export function receiptOf(toolName: string, input: Record<string, unknown> | undefined, resultText: string, isError: boolean): Action | undefined {
	if (toolName === "bash") {
		const cmd = String(input?.command ?? "");
		const simples = commands(cmd);
		if (simples.some(c => GIT_PUSH.test(c))) {
			const a = pushReceipt(resultText);
			if (a) return a;
		}
		for (const c of simples) {
			const a = ghReceipt(c, resultText);
			if (a) return a;
		}
		return slackReceipt(cmd, resultText);
	}
	const path = String(input?.path ?? "");
	const mcp = toolName === "write" && path.startsWith("xd://mcp__") ? path.slice(5) : toolName.startsWith("mcp__") ? toolName : undefined;
	const op = mcp?.replace(/^mcp__[a-z0-9-]+?_/i, "");
	if (!mcp || !op || isError || MCP_READ.test(op) || !MCP_WRITE.test(op)) return undefined;
	return { type: "mcp", target: mcp, link: "" };
}

// 要不要在调用开始时先留着参数：只是省得对每个调用都存，不做判断
export const worthKeeping = (toolName: string, input: Record<string, unknown> | undefined): boolean =>
	toolName === "bash" ? /slack|push|\bgh\b/.test(String(input?.command ?? "")) : toolName.startsWith("mcp__") || String(input?.path ?? "").startsWith("xd://mcp__");

// MCP 工具名形如 mcp__<server>_<operation>；按操作名排除读操作，再认写操作
const MCP_READ = /^(get|list|search|read|query|fetch|discover|executeread)|(^|_)(read|get|list|search)$/i;
const MCP_WRITE = /(add|create|edit|update|delete|transition|merge|push|upsert|upload|link|write|destructive|send|post|reply)/i;

export function resultText(result: unknown): string {
	const c = (result as { content?: unknown } | undefined)?.content;
	return Array.isArray(c) ? c.map(x => String((x as { text?: unknown })?.text ?? "")).join("") : "";
}
