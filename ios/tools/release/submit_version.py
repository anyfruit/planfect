#!/usr/bin/env python3
"""Create the App Store version, set What's New, attach the build, submit for review
(auto-release after approval). Idempotent-ish: reuses an existing version if present.
EDIT VERSION / BUILD_NO / WHATS_NEW below before each release."""
import os, time, pathlib, sys, json
import jwt, urllib.request

APP_ID = "6781118366"
VERSION = "1.0.3"
BUILD_NO = "12"
WHATS_NEW = {
    "zh-Hans": (
        "• 对话升级：长按消息可复制或重新发送，发送失败一键重试；翻看历史时“回到最新”按钮不再消失\n"
        "• 周视图打开直接定位到你的日程，中文日期显示完整不再省略\n"
        "• 修复了好友页等偶发的“已取消”报错弹窗\n"
        "• “我的”页新增小提示：界面语言、语音识别语言、吃饭作息时间等都可以随时调整\n"
        "• 规划助手更可靠：不再偶发“系统没反应”之类的错误借口"
    ),
    "en-US": (
        "• Chat upgrades: long-press to copy or resend a message, one-tap retry on failures, and the jump-to-latest button no longer disappears in long conversations\n"
        "• Week view now opens right at your events, with dates fully readable in Chinese\n"
        "• Fixed occasional \"Cancelled\" error pop-ups on the Friends tab and elsewhere\n"
        "• A new tip in Profile shows everything you can tune — app language, voice-input language, meal and sleep times\n"
        "• A more reliable planner that never makes up \"system not responding\" excuses"
    ),
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
