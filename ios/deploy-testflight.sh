#!/usr/bin/env bash
# One-command TestFlight deploy for Planfect (app + widget).
#
# Why this exists: the machine has no Apple Distribution identity, and an App Store Connect API key
# CAN'T do *cloud* distribution signing (Apple gates that to the Account Holder / Xcode GUI). So we
# manage the signing assets ourselves over the ASC API — an Apple Distribution cert (created once,
# its private key saved as a .p12) plus App-Store provisioning profiles — and export with MANUAL
# signing. No Xcode GUI, no cloud signing, fully scriptable.
#
# One-time prerequisites (all OUTSIDE the repo):
#   ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8   ASC API key (App Manager or Admin)
#   ~/.appstoreconnect/PlanfectDistribution.p12               Apple Distribution cert + private key
#   ~/.planfect-deploy.env  with:  ASC_KEY_ID  ASC_ISSUER_ID  ASC_DIST_CERT_ID  DIST_P12_PASS
#
# Run:  ios/deploy-testflight.sh      (then commit ios/project.yml + ios/Planfect.xcodeproj)
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"   # → ios/

set -a; . "$HOME/.planfect-deploy.env"; set +a
: "${ASC_KEY_ID:?set ASC_KEY_ID in ~/.planfect-deploy.env}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID in ~/.planfect-deploy.env}"
: "${ASC_DIST_CERT_ID:?set ASC_DIST_CERT_ID in ~/.planfect-deploy.env}"
: "${DIST_P12_PASS:?set DIST_P12_PASS in ~/.planfect-deploy.env}"
KEYP="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
P12="$HOME/.appstoreconnect/PlanfectDistribution.p12"
SCHEME=Planfect
for f in "$KEYP" "$P12"; do [ -f "$f" ] || { echo "missing prerequisite: $f"; exit 1; }; done

echo "▸ bump build number"
CUR=$(grep -m1 'CURRENT_PROJECT_VERSION:' project.yml | sed -E 's/.*"([0-9]+)".*/\1/')
NEW=$((CUR + 1))
sed -i '' -E "s/(CURRENT_PROJECT_VERSION: )\"[0-9]+\"/\1\"$NEW\"/g" project.yml
echo "  build $CUR → $NEW"
xcodegen generate >/dev/null

echo "▸ import distribution cert into a dedicated deploy keychain"
KC="$HOME/Library/Keychains/planfect-deploy.keychain-db"; KCPW=planfectdeploy
security delete-keychain "$KC" 2>/dev/null || true
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings "$KC"             # no auto-lock
security unlock-keychain -p "$KCPW" "$KC"
security list-keychains -d user -s "$KC" "$HOME/Library/Keychains/login.keychain-db"
security import "$P12" -k "$KC" -P "$DIST_P12_PASS" -A -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null 2>&1
trap 'security list-keychains -d user -s "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1 || true' EXIT

echo "▸ ensure App Store provisioning profiles (App Store Connect API)"
python3 - "$KEYP" "$ASC_KEY_ID" "$ASC_ISSUER_ID" "$ASC_DIST_CERT_ID" <<'PY'
import sys, jwt, time, json, base64, os, urllib.request, urllib.error
KEYP, KID, ISS, CERT = sys.argv[1:5]; key = open(KEYP).read()
tok = lambda: jwt.encode({"iss": ISS, "iat": int(time.time()), "exp": int(time.time()) + 900,
                          "aud": "appstoreconnect-v1"}, key, algorithm="ES256", headers={"kid": KID})
def api(m, p, b=None):
    r = urllib.request.Request("https://api.appstoreconnect.apple.com" + p, method=m,
        headers={"Authorization": "Bearer " + tok(), "Content-Type": "application/json"})
    if b is not None: r.data = json.dumps(b).encode()
    try:
        with urllib.request.urlopen(r) as x:
            body = x.read(); return x.status, (json.loads(body) if body else {})  # DELETE → 204 no body
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read())
        except Exception: return e.code, {}
_, bd = api("GET", "/v1/bundleIds?limit=200")
bmap = {b["attributes"]["identifier"]: b["id"] for b in bd.get("data", [])}
targets = [("com.planfect.app", "Planfect AppStore CLI"),
           ("com.planfect.app.PlanfectWidget", "Planfect Widget AppStore CLI")]
names = {n for _, n in targets}
_, pd = api("GET", "/v1/profiles?limit=200")
for p in pd.get("data", []):
    if p["attributes"]["name"] in names: api("DELETE", "/v1/profiles/" + p["id"])
D = os.path.expanduser("~/Library/MobileDevice/Provisioning Profiles"); os.makedirs(D, exist_ok=True)
for bid, name in targets:
    assert bid in bmap, "missing bundleId " + bid
    st, d = api("POST", "/v1/profiles", {"data": {"type": "profiles",
        "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
        "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bmap[bid]}},
                          "certificates": {"data": [{"type": "certificates", "id": CERT}]}}}})
    assert st in (200, 201), json.dumps(d)[:500]
    a = d["data"]["attributes"]
    open(os.path.join(D, a["uuid"] + ".mobileprovision"), "wb").write(base64.b64decode(a["profileContent"]))
    print("  ✓", name)
PY

echo "▸ archive"
rm -rf .build/Planfect.xcarchive .build/export
xcodebuild archive -project Planfect.xcodeproj -scheme "$SCHEME" -destination 'generic/platform=iOS' \
  -archivePath .build/Planfect.xcarchive -derivedDataPath .build/dd -quiet \
  -allowProvisioningUpdates -authenticationKeyPath "$KEYP" \
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"

echo "▸ export (manual signing)"
xcodebuild -exportArchive -archivePath .build/Planfect.xcarchive -exportPath .build/export \
  -exportOptionsPlist ExportOptionsManual.plist
IPA=$(ls .build/export/*.ipa | head -1)

echo "▸ upload to TestFlight"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

echo "✅ build $NEW uploaded. Now: git add ios/project.yml ios/Planfect.xcodeproj/project.pbxproj && commit."
