"""定时轮询（建议每 5 分钟）：PR 有别人的新评论、review 或投票，就写成外部消息。只读。

看哪些 PR：你自己开着的，加上未完成任务登记要盯的（别人开的也算；插件写在 state/watch.json）。
GitHub 走 gh CLI；Azure DevOps 走 az CLI，只有 config.json 里配了 ado.org 才查。
一个 PR 第一次看到只记下当前位置。按 PR 标题开头的卡号归到一条线（config.json 的 line_pattern），没有卡号的用登记它的任务。
"""
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import quote

from inbox import CONFIG, health, line_of, load_state, save_state, watch_plan, write_event

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"  # Azure DevOps 的 AAD 资源 ID，固定值
VOTES = {10: "approved", 5: "approved with suggestions", 0: "no vote", -5: "waiting for author", -10: "rejected"}


TRANSIENT = ("EOF", "TLS handshake timeout", "error connecting", "Connection reset", "Connection aborted", "IncompleteRead", "RemoteDisconnected", "Certificate verification failed")
RETRY_WAIT = [3, 8]  # 本机网络间歇性把 HTTPS 响应截断（EOF / 握手超时 / 连接重置）：只对这类错误重试


def reason(stderr):
    """从 stderr 里挑出真正的原因。az 把 `ERROR: AADSTS…` 放在最前面，只取末尾会把它截掉，剩下一串没用的关联 ID 和登录命令。"""
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    for ln in lines:
        if ln.startswith("ERROR"):
            return ln[:300]
    for ln in reversed(lines):  # az 抛 Python 异常时，原因在最后一行含 Error/Exception 的那行
        if "Error" in ln or "Exception" in ln:
            return ln[:300]
    return stderr.strip()[-300:]


def run_json(args):
    attempt = 0
    while True:
        last = attempt == len(RETRY_WAIT)
        try:
            p = subprocess.run(args, capture_output=True, text=True, timeout=60)
        except subprocess.TimeoutExpired:
            if last:
                raise
        else:
            if not p.returncode:
                return json.loads(p.stdout or "null")
            if last or not any(t in p.stderr for t in TRANSIENT):
                raise RuntimeError(f"{args[0]} {args[1]} exit {p.returncode}: {reason(p.stderr)}")  # 认证过期、404 之类不是抖动，立刻照原样报
        time.sleep(RETRY_WAIT[attempt])
        attempt += 1


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def github(state, watched, failed):
    me = state.get("gh_me") or state.setdefault("gh_me", run_json(["gh", "api", "user"])["login"])
    seen = state.setdefault("gh", {})
    prs = run_json(["gh", "search", "prs", "--author=@me", "--state=open", "--limit", "50", "--json", "url,number,repository,title,updatedAt"])
    mine = {pr["url"].lower() for pr in prs}
    for w in watched:  # 任务登记的 PR：别人开的也看；关掉的不再看
        if f"https://github.com/{w['repo']}/pull/{w['number']}".lower() in mine:
            continue
        try:
            p = run_json(["gh", "api", f"repos/{w['repo']}/pulls/{w['number']}"])
        except Exception as exc:  # 一个 PR 读不了（没权限、链接写错）不影响别的
            failed.append(f"github {w['repo']}#{w['number']}: {exc}")
            continue
        if p.get("state") == "open":
            prs.append({"url": p["html_url"], "number": p["number"], "repository": {"nameWithOwner": w["repo"]}, "title": p["title"], "updatedAt": p["updated_at"], "task": w["task"]})
    for pr in prs:
        url, since = pr["url"], seen.get(pr["url"])
        line = line_of(pr["title"]) or pr.get("task")
        if since is None:
            seen[url] = iso_now()
            continue
        if pr["updatedAt"] <= since:
            continue
        repo, n = pr["repository"]["nameWithOwner"], pr["number"]
        where = f"{repo}#{n} {pr['title'][:60]}"
        hits = []
        for c in run_json(["gh", "api", f"repos/{repo}/issues/{n}/comments?since={since}&per_page=100"]):
            hits.append((c["created_at"], c["user"]["login"], c["html_url"], "comment", c.get("body")))
        for c in run_json(["gh", "api", f"repos/{repo}/pulls/{n}/comments?since={since}&per_page=100"]):
            hits.append((c["created_at"], c["user"]["login"], c["html_url"], "review comment", c.get("body")))
        for r in run_json(["gh", "api", f"repos/{repo}/pulls/{n}/reviews?per_page=100"]):
            hits.append((r.get("submitted_at") or "", r["user"]["login"], r["html_url"], f"review {r['state']}", r.get("body")))
        newest = since
        for at, who, link, kind, body in sorted(hits, key=lambda h: h[0]):
            if at <= since:
                continue
            newest = max(newest, at)
            if who != me:
                write_event("github", who, where, link, line=line, note=kind, text=body)
        seen[url] = max(newest, pr["updatedAt"])


def ado(state, org, watched, failed):
    base = f"https://dev.azure.com/{org}"
    rest = ["az", "rest", "--resource", ADO_RESOURCE, "--url"]
    me = state.get("ado_me") or state.setdefault("ado_me", run_json([*rest, f"https://vssps.dev.azure.com/{org}/_apis/connectionData"])["authenticatedUser"]["id"])
    seen = state.setdefault("ado", {})
    prs = run_json([*rest, f"{base}/_apis/git/pullrequests?searchCriteria.creatorId={me}&searchCriteria.status=active&api-version=7.1"])["value"]
    mine = {pr["pullRequestId"] for pr in prs}
    for w in watched:  # 任务登记的 PR：别人开的也看；不再 active 的不看
        if w["id"] in mine:
            continue
        try:
            p = run_json([*rest, f"{base}/{quote(w['project'])}/_apis/git/repositories/{quote(w['repo'])}/pullrequests/{w['id']}?api-version=7.1"])
        except Exception as exc:
            failed.append(f"ado {w['repo']}!{w['id']}: {exc}")
            continue
        if p.get("status") == "active":
            prs.append({**p, "task": w["task"]})
    for pr in prs:
        proj, repo, pid = pr["repository"]["project"]["name"], pr["repository"], pr["pullRequestId"]
        line = line_of(pr["title"]) or pr.get("task")
        key = f"{proj}/{repo['name']}/{pid}"
        link = f"{base}/{quote(proj)}/_git/{quote(repo['name'])}/pullrequest/{pid}"  # 项目名带空格时也是一个合法链接，才能和登记的盯办项对上
        where = f"{repo['name']}!{pid} {pr['title'][:60]}"
        votes = {r["displayName"]: r.get("vote", 0) for r in pr.get("reviewers", []) if r.get("id") != me}
        prev = seen.get(key)
        if prev is None:
            seen[key] = {"since": iso_now(), "votes": votes}
            continue
        for name, vote in votes.items():
            if prev["votes"].get(name, 0) != vote:
                write_event("ado", name, where, link, line=line, note=f"vote: {VOTES.get(vote, vote)}")
        since, newest = prev["since"], prev["since"]
        threads = run_json([*rest, f"{base}/{proj}/_apis/git/repositories/{repo['id']}/pullRequests/{pid}/threads?api-version=7.1"])["value"]
        for t in threads:
            for c in t.get("comments", []):
                at = (c.get("publishedDate") or "")[:19] + "Z"
                if at <= since or c.get("commentType") == "system":
                    continue
                newest = max(newest, at)
                if c.get("author", {}).get("id") != me:
                    write_event("ado", c["author"].get("displayName", "?"), where, f"{link}?discussionId={t['id']}", line=line, note="comment", text=c.get("content"))
        seen[key] = {"since": newest, "votes": votes}


def main():
    state = load_state("pr.json", {})
    plan = watch_plan()
    failed = []
    jobs = [("github", lambda: github(state, plan.get("github", []), failed))]
    if CONFIG.get("ado", {}).get("org"):
        jobs.append(("ado", lambda: ado(state, CONFIG["ado"]["org"], plan.get("ado", []), failed)))
    done = 0
    for name, job in jobs:
        try:
            job()
            done += 1
        except Exception as exc:  # 一边失败不影响另一边；游标只在成功的那边前进
            failed.append(f"{name}: {exc}")
    save_state("pr.json", state)
    # 有一边跑完就算跑过（partial）：读不了的那部分留在 error 里给人看
    health("pr-poll", "PR 轮询", 300, error="; ".join(failed) if failed else None, partial=done > 0)
    if failed:
        print(f"{time.strftime('%F %T')} pr poll failed: {'; '.join(failed)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
