"""定时补读（建议每 5 分钟）：给 slack_socket.ts 兜底，把推送断线期间漏掉的、别人发的新消息写成外部消息。只读 Slack。

读哪些地方：config.json 里 slack.channels 的频道，加上未完成任务登记要盯的频道、私信和 thread（插件写在 state/watch.json）。
一个地方第一次读只记下当前位置，不回放历史。私信和 @ 到你的消息标为紧急。同一条消息推送已经写过的不会重复。
配置里没归到任务（没写 line）的频道，配了 triage 时不紧急的消息先分拣：无关的只记进 state/triage.jsonl，不送；推送把这类消息留给这里。
"""
import gzip
import http.client
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from inbox import CONFIG, TRIAGE, health, load_state, log_triage, read_secret, save_state, seen, triage, triage_reason, watch_plan, write_event

SLACK = CONFIG["slack"]
ME = SLACK["me"]
TOKEN = read_secret(SLACK["user_token"])
RETRY_WAIT = [3, 10]  # 网络不稳时大的响应常被中途截断（IncompleteRead）或超时：同一个请求隔几秒再试，最多三次


def fetch(req):
    with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
        return json.loads(gzip.decompress(raw) if res.headers.get("Content-Encoding") == "gzip" else raw)


def api(method, **params):
    # 要 gzip：#team 7 天一页 50 条不压缩约 200 KB，这台机器上几乎每次被截断；压缩后约 35 KB
    req = urllib.request.Request(f"https://slack.com/api/{method}?{urllib.parse.urlencode(params)}",
                                 headers={"Authorization": f"Bearer {TOKEN}", "Accept-Encoding": "gzip"})
    for wait in RETRY_WAIT:
        try:
            data = fetch(req)
            break
        except urllib.error.HTTPError:
            raise  # HTTP 错误（限流、权限）不是网络抖动，照原样报
        except (http.client.HTTPException, OSError, EOFError):
            time.sleep(wait)
    else:
        try:
            data = fetch(req)
        except (http.client.HTTPException, OSError, EOFError):
            RETRY_WAIT.clear()  # 三次都失败，网络多半整个不通：这次运行剩下的请求只试一次，免得一次运行拖到几十分钟
            raise
    if not data.get("ok"):
        raise RuntimeError(f"{method}: {data.get('error')}")
    return data


def display_name(uid, users):
    if uid not in users:
        try:
            p = api("users.info", user=uid)["user"]
            users[uid] = p.get("real_name") or p.get("name") or uid
        except Exception:
            return uid
    return users[uid]


def place_name(ch, users):
    """频道或私信给人看的名字，和用户名共用一个缓存；查不到就用 ID。"""
    if ch not in users:
        try:
            c = api("conversations.info", channel=ch)["channel"]
            users[ch] = f"DM {display_name(c['user'], users)}" if c.get("is_im") else "group DM" if c.get("is_mpim") else f"#{c.get('name', ch)}"
        except Exception:
            return ch
    return users[ch]


def readable(text, users):
    """把 <@U…> 换成人名：分拣的模型才知道说的是谁。"""
    return re.sub(r"<@([A-Z0-9]+)>", lambda x: "@" + display_name(x.group(1), users), text or "")


THREAD_WINDOW = 7 * 86400  # 整个频道在读时，只看最近 7 天发起的 thread 里的新回复；更早的 thread 要单独登记


def history(ch, oldest):
    """翻页读完 oldest 之后的全部顶层消息：只读第一页会在消息多时永久漏掉。
    每页 50 条：大频道 7 天一页 200 条有几百 KB，网络不稳时几乎每次都被截断；页小了，截断也只重下这一页。"""
    cursor = None
    while True:
        page = api("conversations.history", channel=ch, oldest=oldest, limit=50, **({"cursor": cursor} if cursor else {}))
        yield from page.get("messages", [])
        cursor = page.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            return


def main():
    cursors = load_state("slack-cursor.json", {})
    users = load_state("slack-users.json", {})
    now = f"{time.time():.6f}"
    found = []
    failed = []
    plan = watch_plan().get("slack", [])
    channels = dict(SLACK["channels"])
    for w in plan:  # 任务登记的整个频道或私信：和配置里的频道一样读。配置里没归到任务的频道被任务登记了，就算那个任务的，不再分拣
        if w.get("thread"):
            continue
        if w["channel"] not in channels:
            channels[w["channel"]] = {"name": place_name(w["channel"], users), "line": w["task"]}
        elif not channels[w["channel"]].get("line"):
            channels[w["channel"]] = {**channels[w["channel"]], "line": w["task"]}
    # 整个频道在读时，任务登记过的单条 thread 里的消息直接归那个任务、不分拣：不靠下面单读 thread 那一遍（刚登记的 thread 第一次只记位置，单读也可能失败）
    threads = {(w["channel"], w["thread"]): w["task"] for w in plan if w.get("thread")}

    def linked(meta, ch, thread):
        task = threads.get((ch, thread))
        return {**meta, "line": task} if task and not meta.get("line") else meta

    # 一个地方整个读完才收下它的消息：中途失败的游标不动、下次重读，读到一半的这次不处理，免得拦下的消息下次又分拣一遍
    for ch, meta in channels.items():
        if ch not in cursors:
            cursors[ch] = now  # 第一次只记位置
            continue
        cur = float(cursors[ch])
        newest = cur
        got = []
        try:
            for m in history(ch, f"{cur - THREAD_WINDOW:.6f}"):
                ts = float(m["ts"])
                newest = max(newest, ts)
                here = linked(meta, ch, m.get("thread_ts") or m["ts"])  # 广播到频道的 thread 回复归它所在的 thread
                if ts > cur and m.get("user") != ME and m.get("subtype") in (None, "thread_broadcast"):
                    got.append((ch, here, m, None, None))
                if float(m.get("latest_reply", 0)) > cur:
                    for r in api("conversations.replies", channel=ch, ts=m["ts"], oldest=cursors[ch], limit=200).get("messages", []):
                        rts = float(r["ts"])
                        newest = max(newest, rts)
                        if r["ts"] != m["ts"] and rts > cur and r.get("user") != ME:
                            got.append((ch, here, r, m["ts"], m))
        except Exception as exc:  # 一个地方读不了不影响别的；它的游标不动，下次重读
            failed.append(f"{meta['name']}: {exc}")
            continue
        found += got
        cursors[ch] = f"{newest:.6f}"
    for w in plan:  # 任务登记的单条 thread。所在频道已经整个在读也照读：早于 7 天的 thread 上面读不到，重复的写不进去
        if not w.get("thread"):
            continue
        ch, parent, key = w["channel"], w["thread"], f"{w['channel']}:{w['thread']}"
        if key not in cursors:
            cursors[key] = now
            continue
        cur = float(cursors[key])
        newest = cur
        meta = {"name": place_name(ch, users), "line": w["task"]}
        got = []
        top = None
        try:
            for r in api("conversations.replies", channel=ch, ts=parent, oldest=cursors[key], limit=200).get("messages", []):
                rts = float(r["ts"])
                newest = max(newest, rts)
                if r["ts"] == parent:
                    top = r  # Slack 每页都带着父帖：送的时候附上它的第一行
                elif rts > cur and r.get("user") != ME:
                    got.append((ch, meta, r, parent, top))
        except Exception as exc:
            failed.append(f"thread in {meta['name']}: {exc}")
            continue
        found += got
        cursors[key] = f"{newest:.6f}"
    # 同一条消息可能两处都读到（整个频道在读，它所在的 thread 又单独登记了）：留归了任务的那份
    unique = {}
    for h in found:
        k = (h[0], h[2]["ts"])
        if k not in unique or (h[1].get("line") and not unique[k][1].get("line")):
            unique[k] = h
    pending = []
    for ch, meta, m, parent, top in sorted(unique.values(), key=lambda h: float(h[2]["ts"])):
        key = f"{ch}-{m['ts']}"
        if seen("slack", key):
            continue  # 推送已经写过
        if (ch.startswith("D") or meta["name"] == "group DM") and m.get("bot_id"):
            print(f"{time.strftime('%F %T')} dropped bot DM {key}")  # 日历、DX 这类 bot 发的私信和群私信不送，只记一行
            continue
        urgent = ch.startswith("D") or f"<@{ME}>" in m.get("text", "")
        pending.append({"key": key, "m": m, "top": top, "urgent": urgent, "line": None if urgent else meta.get("line"),
                        "who": display_name(m.get("user", "?"), users), "where": meta["name"] + (" (thread reply)" if parent else ""),
                        "link": f"https://{SLACK['domain']}.slack.com/archives/{ch}/p{m['ts'].replace('.', '')}" + (f"?thread_ts={parent}" if parent else "")})
    # 配置里没归到任务的频道：不紧急的先分拣（配了 triage 段就算开，空的也算，和推送那边一致）。分拣不了就全部送，宁可多打扰也不漏
    sort = [e for e in pending if TRIAGE is not None and not e["urgent"] and not e["line"]]
    if sort:
        items = [{"who": e["who"], "where": e["where"], "text": readable(e["m"].get("text"), users)[:800],
                  **({"thread": f"{display_name(e['top'].get('user', '?'), users)}: {readable(e['top'].get('text'), users)[:300]}"} if e["top"] else {})} for e in sort]
        try:
            for e, (category, task, summary, reason) in zip(sort, triage(items, watch_plan().get("tasks", []))):
                e.update(category=category, task=task, summary=summary, reason=reason)
        except Exception as exc:
            failed.append(f"triage failed, sent everything: {exc}")
            for e in sort:
                e.update(category="unsorted", task=None, summary="", reason="")
        log_triage([{k: e[k] for k in ("category", "task", "who", "where", "link", "summary", "reason")} for e in sort])
    # 分拣说归某个任务也只写进说明，不替主会话定归属：猜错了会反复叫醒那个任务的负责 agent
    written = 0
    for e in pending:
        if e.get("category") == "irrelevant":
            continue
        top = e["top"]
        written += write_event("slack", e["who"], e["where"], e["link"], line=e["line"], urgent=e["urgent"], key=e["key"], order_ns=int(float(e["m"]["ts"]) * 1e9),
                               note="triage failed, not sorted" if e.get("category") == "unsorted" else None, triage=triage_reason(e),
                               text=readable(e["m"].get("text"), users),
                               parent=top and f"{display_name(top.get('user', '?'), users)}: {readable(top.get('text'), users)}")
    # 不再登记的地方把游标丢掉：以后重新登记时从那一刻读起，不回放中间这段。配置里的频道一直留着
    live = set(channels) | {f"{w['channel']}:{w['thread']}" for w in plan if w.get("thread")}
    cursors = {k: v for k, v in cursors.items() if k in live}
    # 游标在消息写完之后才保存：中途失败下次会重读，宁可重复不丢
    save_state("slack-users.json", users)
    save_state("slack-cursor.json", cursors)
    dropped = sum(e.get("category") == "irrelevant" for e in pending)
    if written or dropped:
        print(f"{time.strftime('%F %T')} wrote {written}, dropped {dropped} as irrelevant")
    return failed


if __name__ == "__main__":
    try:
        failed = main()
    except Exception as exc:
        health("slack-poll", "Slack 定时补读", 300, error=exc)
        print(f"{time.strftime('%F %T')} slack poll failed: {exc}", file=sys.stderr)
        sys.exit(1)
    health("slack-poll", "Slack 定时补读", 300, error="; ".join(failed) if failed else None, partial=True)
    if failed:
        print(f"{time.strftime('%F %T')} slack poll: {'; '.join(failed)}", file=sys.stderr)
        sys.exit(1)
