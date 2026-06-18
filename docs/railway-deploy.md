# Railway deploy — support page + dashboard

Two small services. **Prerequisite: `railway login`** (browser auth — must be done by the account owner;
Claude can't log in for you). After that, Claude runs the rest.

## 1. Support page → becomes the App Store "技术支持网址"

Public, static, zero-dependency (`support-site/`).

```bash
cd support-site
railway init            # create a new Railway project/service
railway variables --set "SUPPORT_EMAIL=<your real support email>"
railway up              # deploy
railway domain          # generate a public URL  → paste this into App Store Connect
```

The support email is injected at runtime from `SUPPORT_EMAIL`, so it never lives in the repo.

## 2. Developer dashboard (password-protected)

`dashboard/` (Next.js). It uses the Supabase **service-role key** and shows all usage/cost data, so it
**must** stay behind the password gate (`dashboard/middleware.ts`, HTTP Basic Auth, fail-closed in prod).

```bash
cd dashboard
railway init
railway variables --set "SUPABASE_URL=https://piyfhwmrumbexofbjqyu.supabase.co" \
                  --set "SUPABASE_SERVICE_ROLE_KEY=<service role key — from ~/.planfect-deploy.env, NOT the repo>" \
                  --set "DASHBOARD_PASSWORD=<choose a strong password>" \
                  --set "NODE_ENV=production"
railway up
railway domain          # public URL; opening it prompts for user "admin" + your password
```

Notes:
- Without `DASHBOARD_PASSWORD`, the production deploy returns 503 (locked) rather than exposing data.
- Default Basic-Auth user is `admin`; override with `DASHBOARD_USER`.
- Secrets live only in Railway's env (consistent with the repo rule: keys never in git).
