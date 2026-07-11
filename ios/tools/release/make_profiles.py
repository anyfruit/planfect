#!/usr/bin/env python3
"""Create (or refresh) App Store provisioning profiles for the app + widget via the ASC API,
including the current Apple Distribution cert, and install them where Xcode looks.

Needs (from ~/.planfect-deploy.env): ASC_KEY_ID, ASC_ISSUER_ID, ASC_DIST_CERT_ID, and the
signing key at ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8. The distribution cert
itself must be in the login keychain (import ~/.appstoreconnect/PlanfectDistribution.p12 with
DIST_P12_PASS if a fresh machine). See ios/tools/release/README.md for the full release flow."""
import os, time, base64, pathlib, sys
import jwt, urllib.request, json

KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER = os.environ["ASC_ISSUER_ID"]
CERT_ID = os.environ["ASC_DIST_CERT_ID"]
P8 = pathlib.Path.home() / f".appstoreconnect/private_keys/AuthKey_{KEY_ID}.p8"

token = jwt.encode(
    {"iss": ISSUER, "iat": int(time.time()) - 30, "exp": int(time.time()) + 1100, "aud": "appstoreconnect-v1"},
    P8.read_text(), algorithm="ES256", headers={"kid": KEY_ID})

def api(method, path, payload=None):
    req = urllib.request.Request(
        "https://api.appstoreconnect.apple.com" + path,
        data=json.dumps(payload).encode() if payload else None, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r) if r.status != 204 else {}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"HTTP {e.code} on {method} {path}\n{body[:800]}", file=sys.stderr)
        raise

cert = api("GET", f"/v1/certificates/{CERT_ID}")["data"]["attributes"]
print("dist cert:", cert["name"], "expires", cert["expirationDate"])

bids = {}
for ident in ("com.planfect.app", "com.planfect.app.PlanfectWidget"):
    data = api("GET", f"/v1/bundleIds?filter[identifier]={ident}")["data"]
    exact = [d for d in data if d["attributes"]["identifier"] == ident]
    if not exact:
        sys.exit(f"bundle id {ident} not found")
    bids[ident] = exact[0]["id"]
    print("bundleId:", ident, "->", exact[0]["id"])

# Drop older API-created profiles with our names (name collisions 409), then create fresh ones.
existing = api("GET", "/v1/profiles?filter[profileType]=IOS_APP_STORE&limit=200")["data"]
for p in existing:
    if p["attributes"]["name"].startswith("Planfect AppStore "):
        api("DELETE", f"/v1/profiles/{p['id']}")
        print("deleted stale profile:", p["attributes"]["name"])

outdirs = [pathlib.Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
           pathlib.Path.home() / "Library/MobileDevice/Provisioning Profiles"]
for d in outdirs: d.mkdir(parents=True, exist_ok=True)

names = {}
for ident, bid in bids.items():
    name = f"Planfect AppStore {ident.split('.')[-1]}"
    payload = {"data": {"type": "profiles", "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
               "relationships": {
                   "bundleId": {"data": {"type": "bundleIds", "id": bid}},
                   "certificates": {"data": [{"type": "certificates", "id": CERT_ID}]}}}}
    prof = api("POST", "/v1/profiles", payload)["data"]
    content = base64.b64decode(prof["attributes"]["profileContent"])
    uuid = prof["attributes"]["uuid"]
    for d in outdirs:
        (d / f"{uuid}.mobileprovision").write_bytes(content)
    names[ident] = name
    print("created + installed:", name, uuid)

print(json.dumps(names))
