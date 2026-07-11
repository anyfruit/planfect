#!/usr/bin/env python3
"""Tiny ASC API helper: asc.py <METHOD> <PATH> [json-payload]  — prints the JSON response."""
import os, time, pathlib, sys, json
import jwt, urllib.request

KEY_ID = os.environ["ASC_KEY_ID"]
ISSUER = os.environ["ASC_ISSUER_ID"]
P8 = pathlib.Path.home() / f".appstoreconnect/private_keys/AuthKey_{KEY_ID}.p8"

token = jwt.encode(
    {"iss": ISSUER, "iat": int(time.time()) - 30, "exp": int(time.time()) + 1100, "aud": "appstoreconnect-v1"},
    P8.read_text(), algorithm="ES256", headers={"kid": KEY_ID})

method, path = sys.argv[1], sys.argv[2]
payload = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
req = urllib.request.Request(
    "https://api.appstoreconnect.apple.com" + path,
    data=json.dumps(payload).encode() if payload else None, method=method,
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req) as r:
        body = r.read().decode()
        print(body if body else "{}")
except urllib.error.HTTPError as e:
    print(json.dumps({"http_error": e.code, "body": e.read().decode()[:1500]}))
    sys.exit(1)
