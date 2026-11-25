"""每 5 分钟以各账号的用户身份补读飞书，只写本机收件箱和游标。"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from inbox import CONFIG, TRIAGE, health, load_state, log_triage, save_state, seen, triage, triage_reason, watch_plan, write_event

LARK_ENV = {**os.environ, "LARKSUITE_CLI_NO_UPDATE_NOTIFIER": "1", "TZ": "UTC"}


def lark(profile, *args):
    res = subprocess.run(["lark-cli", "--profile", profile, *args], env=LARK_ENV,
                         capture_output=True, text=True, timeout=30)
    if res.returncode:
        detail = (res.stderr or res.stdout).strip()
        try:
            detail = json.loads(detail)["error"]["message"]
        except (ValueError, KeyError):
            pass
        raise RuntimeError(detail or f"lark-cli exit {res.returncode}")
    return json.loads(res.stdout)


def profile_identity(profile):
    try:
        status = lark(profile, "auth", "status", "--json")
        status = status.get("data", status)
        me = (status.get("identities", {}).get("user") or {}).get("openId")
        if me:
            return me, status["appId"]
    except (RuntimeError, ValueError):
        pass
    config = json.loads((Path.home() / ".lark-cli/config.json").read_text())
    for app in config["apps"]:
        if (app.get("name") or app["appId"]) == profile and app.get("users"):
            if me := app["users"][0].get("userOpenId"):
                return me, app["appId"]
    raise RuntimeError("没有找到用户 open_id")


def read_im(profile, *args):
    return lark(profile, "im", *args, "--as", "user", "--format", "json")["data"]


def pages(profile, field, *args):
    token = []
    while True:
        data = read_im(profile, *args, *token)
        yield from data[field]
        if not data.get("has_more"):
            return
        token = ["--page-token", data["page_token"]]


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def created(message):
    # CLI 按 TZ 渲染到分钟；固定用 UTC，游标不受本机时区切换影响。
    return int(datetime.strptime(message["create_time"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp())


def chat_messages(messages):
    for message in messages:
        yield message, None
        for reply in message.get("thread_replies") or []:
            yield reply, message


def sender_name(sender):
    return sender.get("name") or sender["id"]


def poll_account(account, plan, now, failed):
    profile = account["profile"]
    me, app_id = profile_identity(profile)
    ignored_senders = {me}
    if account.get("bot") is True:
        bot = lark(profile, "api", "GET", "/open-apis/bot/v3/info", "--as", "bot", "--format", "json")["data"]
        ignored_senders.update((app_id, bot["open_id"]))
    name = f"feishu-cursor-{quote(profile, safe='')}.json"
    state = load_state(name, {})
    watched = {}
    for w in plan.get("feishu", []):
        if w.get("whole") is True:
            watched[w["chat"]] = w["task"]
        else:
            watched.setdefault(w["chat"], None)
    chats = {c["chat_id"]: c for c in pages(profile, "chats", "+chat-list", "--types", "p2p,group", "--page-size", "100")}
    targets = {ch for ch, chat in chats.items() if chat["chat_mode"] == "p2p" or ch in watched}
    old_chats = state.get("chats", {})
    cursors = {}
    pending = {}
    roots = {}

    def collect(ch, m, top=None, mention=False):
        sender = m.get("sender") or {}
        if not sender.get("id") or sender["id"] in ignored_senders or m.get("msg_type") == "system" or m.get("deleted"):
            return
        key = m["message_id"]
        if seen("feishu", key):
            return
        chat = chats.get(ch, {})
        # 私聊里应用（通知机器人）发来的不算发给你的私信：不标紧急，按普通消息走分拣
        direct = (chat.get("chat_mode") or m.get("chat_type")) == "p2p" and sender.get("sender_type") != "app"
        urgent = direct or mention or any(x.get("id") == me for x in m.get("mentions") or [])
        if key in pending:
            if urgent:
                pending[key].update(urgent=True, line=None)
            return
        who = sender_name(sender)
        root = m.get("root_id") or (top and top["message_id"])
        is_reply = root and root != key
        place = f"私聊 {who}" if direct else (chat.get("name") or m.get("chat_name") or ch)
        pending[key] = {"key": key, "chat": ch, "root": root if is_reply else None, "message": m, "time": created(m),
                        "who": who, "where": place + (" (thread reply)" if is_reply else ""), "urgent": urgent,
                        "line": None if urgent else watched.get(ch),
                        "link": m.get("message_app_link") or f"https://applink.feishu.cn/client/chat/open?openChatId={ch}"}
        if top:
            roots[top["message_id"]] = top

    for ch in sorted(targets):
        old = old_chats.get(ch)
        if old is None:
            cursors[ch] = {"start": now}  # 第一次只记位置
            continue
        cursors[ch] = old
        start = old["start"]
        try:
            messages = list(pages(profile, "messages", "+chat-messages-list", "--chat-id", ch,
                                  "--start", iso(start), "--order", "asc", "--page-size", "50", "--no-reactions"))
        except Exception as exc:
            failed.append(f"{profile}/{chats[ch].get('name') or ch}：{exc}")
            continue
        newest = start
        ignored = set(old.get("ignored", []))
        kept = {}
        for m, top in chat_messages(messages):
            ts = created(m)
            newest = max(newest, ts)
            key = m["message_id"]
            if key in ignored:
                kept[key] = ts
            else:
                collect(ch, m, top)
        # CLI 只返回分钟，留一分钟重叠；重叠内已拦下的消息无需再分拣。
        start = max(start, newest - 60)
        cursors[ch] = {"start": start, "ignored": [key for key, ts in kept.items() if ts + 60 > start]}

    mention_start = state.get("mentions")
    if mention_start is None:
        mention_start = now
    elif mention_start < now:
        try:
            mentions = list(pages(profile, "messages", "+messages-search", "--query", "", "--is-at-me", "--start",
                                  iso(mention_start), "--end", iso(now), "--page-size", "50", "--no-reactions"))
            for m in mentions:
                # 搜索把 @所有人 也算作 @我：只收点名到你的，@所有人 照它所在会话的规则走
                if any(x.get("id") == me for x in m.get("mentions") or []):
                    collect(m["chat_id"], m, mention=True)
            mention_start = max(mention_start, now - 60)
        except Exception as exc:
            failed.append(f"{profile}/@我：{exc}")

    sort = [e for e in pending.values() if TRIAGE is not None and not e["urgent"] and not e["line"] and e["chat"] not in watched]
    missing = sorted({e["root"] for e in sort if e["root"] and e["root"] not in roots})
    for offset in range(0, len(missing), 50):
        try:
            data = read_im(profile, "+messages-mget", "--message-ids", ",".join(missing[offset:offset + 50]), "--no-reactions")
            roots.update((m["message_id"], m) for m in data["messages"])
        except Exception as exc:
            failed.append(f"{profile}/话题根消息：{exc}")
    if sort:
        items = []
        for e in sort:
            item = {"who": e["who"], "where": e["where"], "text": (e["message"].get("content") or "")[:800]}
            if top := roots.get(e["root"]):
                item["thread"] = (top.get("content") or "")[:300]
            items.append(item)
        try:
            results = triage(items, plan.get("tasks", []))
        except Exception as exc:
            failed.append(f"{profile}/分拣失败，全部送出：{exc}")
            results = [("unsorted", None, "", "")] * len(sort)
        for e, (category, task, summary, reason) in zip(sort, results):
            e.update(category=category, task=task, summary=summary, reason=reason)
        log_triage([{k: e[k] for k in ("category", "task", "who", "where", "link", "summary", "reason")} for e in sort])

    written = dropped = 0
    for e in pending.values():
        category = e.get("category")
        if category == "irrelevant":
            cursor = cursors[e["chat"]]
            if e["time"] + 60 > cursor["start"]:
                cursor["ignored"].append(e["key"])
            dropped += 1
            continue
        # 分拣的猜测只写进说明，不替主会话定归属。
        top = roots.get(e["root"]) if e["root"] else None
        written += write_event("feishu", e["who"], e["where"], e["link"], line=e["line"], urgent=e["urgent"], key=e["key"], order_ns=e["time"] * 10**9,
                               note="triage failed, not sorted" if category == "unsorted" else None, triage=triage_reason(e),
                               text=e["message"].get("content"), parent=top and top.get("content"))
    save_state(name, {"chats": cursors, "mentions": mention_start})
    if written or dropped:
        print(f"{time.strftime('%F %T')} {profile} 写入 {written} 条，分拣拦下 {dropped} 条")


def main():
    accounts = [a for a in CONFIG.get("feishu", {}).get("accounts", []) if a.get("poll") is True]
    if not accounts:
        return 0
    plan = watch_plan()
    now = int(time.time())
    failed = []
    completed = 0
    for account in accounts:
        try:
            poll_account(account, plan, now, failed)
        except Exception as exc:
            failed.append(f"{account['profile']}：{exc}")
        else:
            completed += 1
    error = "；".join(failed) or None
    health("feishu-poll", "飞书补读", 300, error=error, partial=completed > 0)
    if error:
        print(f"{time.strftime('%F %T')} 飞书补读：{error}", file=sys.stderr)
    return int(bool(error))


if __name__ == "__main__":
    sys.exit(main())
