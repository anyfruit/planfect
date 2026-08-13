#!/usr/bin/env python3
"""Create the App Store version, set What's New, attach the build, submit for review
(auto-release after approval). Idempotent-ish: reuses an existing version if present.
EDIT VERSION / BUILD_NO / WHATS_NEW below before each release."""
import os, time, pathlib, sys, json
import jwt, urllib.request

APP_ID = "6781118366"
VERSION = "1.0.4"
BUILD_NO = "13"
WHATS_NEW = {
    "zh-Hans": '• 回复不再丢了:等结果时连接断开(或切去别的 app),回来会自动把答案补上——以前只会让你重发\n• 排程过程实时可见:助手会告诉你它正在做什么(查日程、算路程、排进日历),回复也边写边出现\n• 备注终于会用了:说「给这条加个备注」,内容进备注栏,不再被塞进标题\n• 修好了头像改不了的问题;头像和资料现在秒开\n• 每个账号都有了好记的 Planfect ID(比如 kindmeadow11),加好友页一键复制\n• 首次打开会一次性问清权限:AI 使用、通知、Apple 日历同步',
    "en-US": '• Replies no longer get lost: if the connection drops (or you switch apps) while it is working, the answer is waiting when you come back instead of asking you to resend\n• Watch it work: the assistant says what it is doing (checking your schedule, working out travel time, adding to your calendar) and writes its reply as it goes\n• Notes finally work: “add a note to this” puts the text in the note field instead of the title\n• Fixed profile photos not saving; your photo and profile now open instantly\n• Every account gets a memorable Planfect ID (like kindmeadow11), with one-tap copy on the Add-friend screen\n• First launch asks about AI use, notifications, and Apple Calendar sync up front',
}

KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER = os.environ["ASC_ISSUER_ID"]
P8 = pathlib.Path.home() / f".appstoreconnect/private_keys/AuthKey_{KEY_ID}.p8"

def token():
    return jwt.encode(
        {"iss": ISSUER, "iat": int(time.time()) - 30, "exp": int(time.time()) + 1100, "aud": "appstoreconnect-v1"},
        P8.read_text(), algorithm="ES256", headers={"kid": KEY_ID})

def api(method, path, payload=None, ok404=False):
    req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com" + path,
        data=json.dumps(payload).encode() if payload else None, method=method,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        if ok404 and e.code == 404: return None
        print(f"HTTP {e.code} on {method} {path}\n{body[:1200]}", file=sys.stderr)
        raise

# 1. The processed build.
builds = api("GET", f"/v1/builds?filter[app]={APP_ID}&filter[version]={BUILD_NO}&limit=1")["data"]
if not builds: sys.exit(f"build {BUILD_NO} not found on ASC yet")
build = builds[0]
state = build["attributes"]["processingState"]
print("build:", build["id"], state)
if state != "VALID": sys.exit(f"build still {state} — run again once VALID")

# 2. Version 1.0.2 (reuse if it already exists).
vers = api("GET", f"/v1/apps/{APP_ID}/appStoreVersions?filter[versionString]={VERSION}&limit=1")["data"]
if vers:
    ver = vers[0]
    print("version exists:", ver["id"], ver["attributes"]["appStoreState"])
else:
    ver = api("POST", "/v1/appStoreVersions", {"data": {
        "type": "appStoreVersions",
        "attributes": {"platform": "IOS", "versionString": VERSION, "releaseType": "AFTER_APPROVAL"},
        "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]
    print("version created:", ver["id"])
VER_ID = ver["id"]

# 3. What's New per locale.
locs = api("GET", f"/v1/appStoreVersions/{VER_ID}/appStoreVersionLocalizations?limit=10")["data"]
for loc in locs:
    lc = loc["attributes"]["locale"]
    text = WHATS_NEW.get(lc) or WHATS_NEW.get("en-US")
    api("PATCH", f"/v1/appStoreVersionLocalizations/{loc['id']}",
        {"data": {"type": "appStoreVersionLocalizations", "id": loc["id"], "attributes": {"whatsNew": text}}})
    print("whatsNew set:", lc)

# 4. Attach the build.
api("PATCH", f"/v1/appStoreVersions/{VER_ID}/relationships/build",
    {"data": {"type": "builds", "id": build["id"]}})
print("build attached")

# 5. Review submission (create → add item → submit).
subs = api("GET", f"/v1/reviewSubmissions?filter[app]={APP_ID}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW&limit=5")
open_subs = (subs or {}).get("data", [])
if open_subs:
    sub = open_subs[0]
    print("reusing open review submission:", sub["id"], sub["attributes"]["state"])
else:
    sub = api("POST", "/v1/reviewSubmissions", {"data": {
        "type": "reviewSubmissions",
        "attributes": {"platform": "IOS"},
        "relationships": {"app": {"data": {"type": "apps", "id": APP_ID}}}}})["data"]
    print("review submission created:", sub["id"])
SUB_ID = sub["id"]

items = api("GET", f"/v1/reviewSubmissions/{SUB_ID}/items?limit=5")["data"]
if not items:
    api("POST", "/v1/reviewSubmissionItems", {"data": {
        "type": "reviewSubmissionItems",
        "relationships": {
            "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": SUB_ID}},
            "appStoreVersion": {"data": {"type": "appStoreVersions", "id": VER_ID}}}}})
    print("version added to submission")
else:
    print("submission already has", len(items), "item(s)")

api("PATCH", f"/v1/reviewSubmissions/{SUB_ID}",
    {"data": {"type": "reviewSubmissions", "id": SUB_ID, "attributes": {"submitted": True}}})
print("SUBMITTED for review ✅")

final = api("GET", f"/v1/appStoreVersions/{VER_ID}")["data"]["attributes"]
print("final state:", final["versionString"], final["appStoreState"])
