#!/usr/bin/env python3
"""Create App Store version 1.0.2, set What's New, attach build 11, submit for review
(auto-release after approval). Idempotent-ish: reuses an existing 1.0.2 version if present."""
import os, time, pathlib, sys, json
import jwt, urllib.request

APP_ID = "6781118366"
VERSION = "1.0.2"
BUILD_NO = "11"
WHATS_NEW = {
    "zh-Hans": (
        "• 修改/删除日程更可靠了：对话里说“改到3点”“删掉”会立即生效，重复日程也能单独调整某一次\n"
        "• 对话中的改动和备注现在会实时同步到 Apple 日历\n"
        "• 回复速度明显更快\n"
        "• 小组件升级：进行中日程实时进度条、锁屏当日完成度圆环、新增大号全天视图"
    ),
    "en-US": (
        "• Editing and deleting plans in chat is far more reliable — including a single occurrence of a repeating habit\n"
        "• Chat edits and notes now sync to Apple Calendar instantly\n"
        "• Noticeably faster replies\n"
        "• Widget upgrades: live progress for the current plan, a lock-screen daily progress ring, and a new large all-day view"
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

# 1. The processed build 11.
builds = api("GET", f"/v1/builds?filter[app]={APP_ID}&filter[version]={BUILD_NO}&limit=1")["data"]
if not builds: sys.exit("build 11 not found on ASC yet")
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
