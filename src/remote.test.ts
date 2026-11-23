import { expect, test } from "bun:test";
import { commands, receiptOf, resultText } from "./remote";

const SLACK_OK = '{"ok":true,"channel":"C0A82JJNUE5","ts":"1795144711.356319"}';
const run = (command: string, out: string, isError = false) => receiptOf("bash", { command }, out, isError);

test("grep、cat、写文件这类只提到方法名的命令不记", () => {
	expect(run("grep -n 'chat.postMessage' s.jsonl | head", "12: chat.postMessage")).toBeUndefined();
	expect(run("cat notes.md", "use slack-api.sh chat.postMessage")).toBeUndefined();
	expect(run("git worktree add -b f ../x main && python3 - <<'EOF'\nprint('chat.postMessage')\nEOF", "Preparing worktree\n")).toBeUndefined();
	expect(run("sed -i 's/a/b/' /tmp/t.txt", "")).toBeUndefined();
});

test("Slack：回执 ok:true 才记；ok:false、没有回执不记", () => {
	const a = run("$S --user chat.postMessage channel=C0A82JJNUE5 text=hi", SLACK_OK);
	expect(a).toEqual({ type: "slack.postMessage", target: "C0A82JJNUE5", link: "slack:C0A82JJNUE5/1795144711.356319" });
	expect(run("serko-slack-api chat.postMessage --json '{}'", '{"ok":false,"error":"msg_too_long"}')).toBeUndefined();
	expect(run("slack-api.sh chat.postMessage channel=C1 text=x", "")).toBeUndefined();
	expect(run("slack-api.sh chat.postMessage channel=C1 text=x >/dev/null", "")).toBeUndefined();
	expect(run("slack-api.sh reactions.add name=x", '{"ok":true}')?.type).toBe("slack.add");
	expect(run("slack-api.sh chat.delete channel=C1 ts=1.2", '{"ok":true,"channel":"C1","ts":"1.2"}')?.type).toBe("slack.delete");
	expect(run("slack-api.sh conversations.history channel=C1", SLACK_OK)).toBeUndefined();
});

test("git push：远端回执才记；被拒、dry-run、本地路径、静默、fetch 都不记", () => {
	const ok = "To https://github.com/o/r.git\n   1a2b3c4..5d6e7f8  fix -> fix\n";
	expect(run("git push origin fix", ok)).toEqual({ type: "git push", target: "https://github.com/o/r fix", link: "https://github.com/o/r" });
	expect(run("git push -u origin new", "To git@github.com:o/r.git\n * [new branch]      new -> new\n")?.type).toBe("git push");
	expect(run("git push origin main", "To https://dev.azure.com/s/p/_git/r\n ! [remote rejected] main -> main (denied)\nerror: failed to push some refs\n")).toBeUndefined();
	expect(run("git push --dry-run origin fix", ok)).toBeUndefined();
	expect(run("git push o HEAD:refs/heads/t", "To ../r.git\n * [new branch]      HEAD -> t\n")).toBeUndefined();
	expect(run("git push -q origin fix", "")).toBeUndefined();
	expect(run("git fetch origin", "From github.com:o/r\n   5497b75..4a4da17  main       -> origin/main\n")).toBeUndefined();
});

test("git push：SSH 写法（host:path、别名主机）算远端；本地路径正向识别", () => {
	expect(run("git push origin x", "To github.com:o/sol-tokenization-service.git\n   a1b2c3d..bd58e48  x -> x\n")?.type).toBe("git push");
	expect(run("git push origin x", "To github-personal:o/r.git\n * [new branch]      x -> x\n")?.type).toBe("git push");
	expect(run("git push o x", "To /tmp/r.git\n * [new branch]      x -> x\n")).toBeUndefined();
	expect(run("git push o x", "To file:///tmp/r.git\n * [new branch]      x -> x\n")).toBeUndefined();
});

test("Slack 多步上传：任何一步 ok:false 或最后不是 ok 就不记", () => {
	const c = "S=slack-api.sh; $S files.getUploadURLExternal; $S files.completeUploadExternal";
	expect(run(c, '{"ok":true,"upload_url":"u"}\n{"ok":false,"error":"invalid_arguments"}')).toBeUndefined();
	expect(run(c, '{"ok":false,"error":"x"}\n{"ok":true,"files":[]}')).toBeUndefined();
	expect(run(c, '{"ok":true,"upload_url":"u"}\n{"ok":true,"files":[{"id":"F1"}]}')?.type).toBe("slack.completeUploadExternal");
});

test("gh：建 PR、评论有地址才记；只读的 gh pr view 不记", () => {
	expect(run("gh pr create --fill", "https://github.com/o/r/pull/7\n")).toEqual({ type: "pr create", target: "https://github.com/o/r/pull/7", link: "https://github.com/o/r/pull/7" });
	expect(run("gh pr comment 7 -b hi", "https://github.com/o/r/pull/7#issuecomment-123\n")?.link).toBe("https://github.com/o/r/pull/7#issuecomment-123");
	expect(run("gh pr create --fill", "GraphQL: a pull request already exists")).toBeUndefined();
	expect(run("gh pr view 7", "title: x\nhttps://github.com/o/r/pull/7")).toBeUndefined();
	expect(run("gh api -X POST repos/o/r/issues/1/comments -f body=hi", '{"html_url":"https://github.com/o/r/issues/1#issuecomment-9","id":9}')?.type).toBe("gh api");
	expect(run("gh api repos/o/r/pulls/1", '{"html_url":"https://github.com/o/r/pull/1"}')).toBeUndefined();
});

test("MCP 写操作没报错才记；读操作不记", () => {
	expect(receiptOf("mcp__github_add_issue_comment", {}, "ok", false)?.type).toBe("mcp");
	expect(receiptOf("mcp__github_add_issue_comment", {}, "x", true)).toBeUndefined();
	expect(receiptOf("mcp__github_get_me", {}, "ok", false)).toBeUndefined();
});

test("resultText 取工具结果里的文本", () => {
	expect(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
	expect(resultText(undefined)).toBe("");
});

test("拆简单命令：引号、$( )、( ) 里面的分隔符不算；引号没配上时后面整段算一条", () => {
	expect(commands(`a 'x | y' | b "p; q $(c | d)" ; e && f`).map(s => s.trim()).filter(Boolean)).toEqual([`a 'x | y'`, `b "p; q $(c | d)"`, "e", "& f"]);
	expect(commands(`echo "it's fine" | wc -l`).map(s => s.trim())).toEqual([`echo "it's fine"`, "wc -l"]);
	expect(commands("echo don't | wc; ls")).toEqual(["echo don't | wc; ls"]);
});
