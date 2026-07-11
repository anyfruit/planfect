# App Store release flow (fully CLI — no Xcode GUI)

Proven end-to-end on **v1.0.2 (build 11)**, 2026-07-11. Everything runs with the ASC API key;
credentials come from `~/.planfect-deploy.env` (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_DIST_CERT_ID`,
`DIST_P12_PASS`) plus `~/.appstoreconnect/` (the `AuthKey_<id>.p8` under `private_keys/`, and
`PlanfectDistribution.p12`).

```bash
set -a; source ~/.planfect-deploy.env; set +a
cd ios

# 0. Bump MARKETING_VERSION + CURRENT_PROJECT_VERSION (BOTH targets) in project.yml, then:
xcodegen generate

# 1. One-time per machine: distribution cert into the login keychain
security import ~/.appstoreconnect/PlanfectDistribution.p12 \
  -k ~/Library/Keychains/login.keychain-db -P "$DIST_P12_PASS" -T /usr/bin/codesign

# 2. One-time per cert renewal: App Store profiles for app + widget (installed for Xcode)
python3 tools/release/make_profiles.py

# 3. Archive (device build; automatic signing works here — dev cert)
xcodebuild archive -project Planfect.xcodeproj -scheme Planfect \
  -destination 'generic/platform=iOS' -archivePath build/Planfect-<ver>.xcarchive \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8 \
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"

# 4. Export the ipa with MANUAL signing (cloud/automatic store signing fails: the API key
#    lacks cloud-signing permission — that's why ExportOptionsManual.plist pins the profiles)
xcodebuild -exportArchive -archivePath build/Planfect-<ver>.xcarchive \
  -exportOptionsPlist tools/release/ExportOptionsManual.plist -exportPath build/export-<ver>

# 5. Upload (altool still ships with Xcode 26 and takes the API key directly)
xcrun altool --upload-app -f build/export-<ver>/Planfect.ipa -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

# 6. Wait for the build to turn VALID (5–30 min), then create the version, set bilingual
#    What's New, attach the build, and submit for review (auto-release on approval).
#    EDIT the VERSION/BUILD_NO/WHATS_NEW constants at the top first:
python3 tools/release/submit_version.py
```

`asc.py` is a tiny curl-style helper for ad-hoc ASC API calls:
`python3 tools/release/asc.py GET "/v1/builds?filter[app]=6781118366&limit=3"`.

Gotchas hit the first time (already baked into the steps above):

- **"No signing certificate iOS Distribution"** → the p12 wasn't imported (step 1).
- **"Cloud signing permission error"** → don't use automatic signing at export; use the manual
  plist (step 4).
- **Old "iOS Team Store Provisioning Profile" lacks push / the new cert** → regenerate with
  `make_profiles.py` (step 2); profiles auto-include the bundle ids' capabilities.
- The app id on ASC is `6781118366`; team `9K59GFVLS5`.
