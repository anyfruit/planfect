// Shared APNs push sender. Signs an ES256 provider JWT from the APNs auth key (.p8, stored
// base64 in the APNS_PRIVATE_KEY_B64 secret) and POSTs to APNs over HTTP/2 for each of the
// recipient's device tokens. Best-effort: never throws into the caller; prunes dead tokens.

import { type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

declare const Deno: { env: { get(k: string): string | undefined } };

let _cached: { token: string; at: number } | null = null;

/** A provider JWT, cached ~50 min (APNs accepts them up to 1h). null if APNs isn't configured. */
async function providerToken(): Promise<string | null> {
  const keyId = Deno.env.get('APNS_KEY_ID');
  const teamId = Deno.env.get('APNS_TEAM_ID');
  const b64 = Deno.env.get('APNS_PRIVATE_KEY_B64');
  if (!keyId || !teamId || !b64) return null;

  const now = Math.floor(Date.now() / 1000);
  if (_cached && now - _cached.at < 3000) return _cached.token;

  const key = await importP8(atob(b64));
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat: now }));
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${payload}`),
  );
  const token = `${header}.${payload}.${b64urlBytes(new Uint8Array(sig))}`;
  _cached = { token, at: now };
  return token;
}

async function importP8(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlBytes(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Push to every device a user has registered. No-op when APNs isn't configured or they have none. */
export async function sendPush(db: SupabaseClient, userId: string, title: string, body: string): Promise<void> {
  try {
    const jwt = await providerToken();
    if (!jwt) return;
    const { data: tokens } = await db.from('device_tokens').select('token').eq('user_id', userId);
    if (!tokens?.length) return;

    const host = Deno.env.get('APNS_HOST') ?? 'https://api.push.apple.com';   // sandbox: api.sandbox.push.apple.com
    const bundle = Deno.env.get('APNS_BUNDLE_ID') ?? 'com.planfect.app';
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' } });

    for (const t of tokens) {
      const tok = (t as { token: string }).token;
      try {
        const res = await fetch(`${host}/3/device/${tok}`, {
          method: 'POST',
          headers: {
            authorization: `bearer ${jwt}`,
            'apns-topic': bundle,
            'apns-push-type': 'alert',
            'content-type': 'application/json',
          },
          body: payload,
        });
        if (res.status === 410 || res.status === 400) {
          await db.from('device_tokens').delete().eq('user_id', userId).eq('token', tok);   // dead token
        }
      } catch (_) { /* per-device best-effort */ }
    }
  } catch (_) { /* never fail the caller on push */ }
}
