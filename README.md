# Planfect

[![CI](https://github.com/anyfruit/planfect/actions/workflows/ci.yml/badge.svg)](https://github.com/anyfruit/planfect/actions/workflows/ci.yml)
&nbsp;·&nbsp; iOS 17+ · SwiftUI · Supabase · Deno/TypeScript · OpenAI · Google Maps · EN / 中文

**An AI day planner you talk to.** Tell it your plans — by text or voice, one line or a whole
afternoon at once — and it builds your day around your routine, commute, and habits: it picks
sensible times, adds **real travel time so you arrive on time**, **looks up real event times on the
web**, learns your preferences, flags conflicts, reminds you, and shows what's next on a
home-screen widget.

▶︎ **[Try the live demo — no install needed →](https://planfect-support-production.up.railway.app/showcase)**
It runs the *real* planner (real web lookups, real Google Maps travel times, real timezone-aware
scheduling) — type a plan and watch it schedule.

---

## Status

✅ **Built and submitted to the App Store** (in review; release in progress).

- **Backend — live** on Supabase (project `piyfhwmrumbexofbjqyu`): full schema + Row-Level Security
  and three Deno Edge Functions (`plan`, `plan-demo`, `insights`).
- **iOS app — built:** a complete native SwiftUI client — chat planner, day/week/month timetable,
  insights charts, profile, and an offline onboarding — with a **WidgetKit** home/lock-screen widget,
  **Sign in with Apple**, **Apple Calendar** sync, local notifications, voice input, and `.ics`/`.json`
  export. Archived and uploaded to App Store Connect (v1.0).
- **Live on the web:** a public, no-account demo of the real planner, a support page, and a bilingual
  case-study page (all on Railway), plus a password-gated **analytics dashboard** (Next.js) for
  usage / cost / model metrics.
- **Tested:** the platform-independent backend logic (`server/`) is unit-tested — **29 tests**, no
  network or keys required — and CI runs the suite on every push.

> Planfect Pro / billing is a **dormant skeleton** (see [Security & billing](#security--billing)) —
> everything is currently free.

## What it does

Four surfaces in the app:

- **Chat** — talk to the planner in natural language (*"dentist Friday 3pm, groceries, finish the
  report this week"*, or a voice brain-dump of a whole day). When a detail is genuinely ambiguous it
  asks a quick **multiple-choice question with an "Other" free-text option**, then confirms exactly
  what it scheduled in a **tap-to-edit receipt**.
- **Schedule** — your day as a list, your week as a timeline grid, your month as a calendar; tap any
  block to edit, complete, or reschedule.
- **Insights** — where your time goes by category (donut + per-day bars via Swift Charts), with an
  optional **AI read** of your week.
- **Profile** — routine (work / sleep / meals), Home/Work places, recurring habits, learned
  preferences, reminders, calendar sync, export, timezone.

…plus a **home / lock-screen widget** that shows what's next and advances itself at task boundaries.

Under the hood the planner:

- schedules tasks into your **free time around a soft routine** (work, sleep, meals), in your timezone;
- adds **real travel time** (Google Maps) and places the commute **before** a fixed event — you leave
  early and arrive on time, not the activity pushed later;
- **looks up real event times on the web** (a match, a showtime, store hours) and schedules around the
  actual time, converting timezones when the event is elsewhere;
- **learns durable preferences** and sets up **recurring habits** that auto-fill weeks ahead;
- handles a **multi-task brain-dump in one shot**, and only asks when it's genuinely unsure.

## Architecture

```
   iOS app  (SwiftUI · WidgetKit · EventKit · Swift Charts)
       │  HTTPS, user JWT (anon key only — RLS-guarded)
       ▼
   Supabase Edge Functions  (Deno / TypeScript)
     • /plan        the planner agent           (JWT-gated)
     • /plan-demo   same planner, public,        (no auth, writes nothing → powers the live demo)
     • /insights    AI time analysis             (JWT-gated)
       │
   ┌───┴───────────────┬──────────────────────────┐
   ▼                   ▼                          ▼
 OpenAI            Google Maps               Postgres + RLS
 (LLM tool-call    (Routes + Geocoding)      tasks · time_blocks · routines ·
  + web search)                              preferences · recurring_tasks · locations · …
```

- **The AI key and the maps key never ship in the app.** Every model/maps call goes through an Edge
  Function; the app holds only the RLS-guarded anon key. This is the single most important security
  decision.
- **The scheduling + agent logic is platform-independent** (`server/`, pure TypeScript, unit-tested on
  Node) and runs verbatim inside the Deno Edge Functions — a future Android app reuses it and only
  re-implements the UI.
- **Providers are abstractions:** the LLM sits behind one `PlannerLLM` interface (OpenAI / Anthropic /
  Qwen / MiniMax — switch via config), and maps behind a `MapsProvider` interface.

## The planner agent

[`server/planner.ts`](server/planner.ts) is a provider-agnostic **tool-calling loop**: it calls the
model, the model calls server-side tools, and it returns one of three results — a **scheduled
receipt**, a set of **clarifying questions** (the loop short-circuits, hands tappable cards back to the
app, then resumes with the answer), or a plain **message**. The tools:

| Tool | What it does |
|---|---|
| `schedule_tasks` | Place one or many tasks around routine + existing blocks; create the task and its time-blocks (with commute & buffer). The main write. |
| `ask_user_questions` | Ask 1–3 multiple-choice questions when a detail is genuinely ambiguous (rendered as cards + an "Other" free-text option). |
| `estimate_commute` | Real travel time / mode between two places (Google Routes); inserted **before** the task. |
| `geocode_place` | Resolve a place to coordinates + address (Google Geocoding). |
| `web_search` | Look up a real, time-sensitive fact (event / show / broadcast time, store hours). |
| `get_schedule` | Read existing blocks to find free slots and avoid conflicts. |
| `set_routine` | Add / update / delete a background routine (work / sleep / meal / commute). |
| `set_recurring` | Create / delete a repeating habit (e.g. gym Mon/Wed/Fri 7am); auto-placed weeks ahead. |
| `remember_preference` | Persist a durable planning preference across conversations. |
| `update_task` | Move / resize / complete / delete an existing scheduled task. |

The pure placement engine ([`server/scheduling/`](server/scheduling)) is **timezone- and DST-aware**
and unit-tested, including the "leave early, arrive on time" commute logic. Full write-up in
[`docs/AI_PLANNING.md`](docs/AI_PLANNING.md).

## Tech stack

| Layer | Choice |
|---|---|
| iOS app | Native **SwiftUI** (iOS 17+), **WidgetKit**, **EventKit**, **Swift Charts**, Sign in with Apple, Speech; project generated with **XcodeGen** |
| Backend | **Supabase** — Postgres + Auth + **Edge Functions** (Deno / TypeScript) |
| Data | Postgres with **Row-Level Security** — each user can only ever read/write their own rows |
| AI | **OpenAI** by default behind a `PlannerLLM` abstraction (Anthropic / Qwen / MiniMax drop in via config); LLM tool-calling + web search |
| Maps | **Google Maps** — Routes + Geocoding, server-side, behind a `MapsProvider` abstraction |
| Aux services | A **Next.js** admin dashboard + a zero-dependency **Node** support / showcase site, both on **Railway** |
| Quality | Node's built-in test runner (zero deps), CI on every push; fully bilingual (English / 简体中文) |

Rationale for each choice is recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Security & billing

- **No secret ever lives in the repo.** Provider and service-role keys are **Supabase secrets**, read
  from `Deno.env` inside Edge Functions only; the iOS app ships just the anon key (RLS-guarded). See
  [`.env.example`](.env.example).
- **RLS everywhere** — every user-data table has an owner-only policy; analytics tables are written by
  the service role and readable only by admins.
- **The public demo** (`/plan-demo`) runs the real planner but **writes nothing** and reads no real
  user's data; it's rate-limited per IP (and the showcase caps turns per device).
- **Billing is dormant** — a freemium skeleton exists (`BILLING_ENFORCED` gate,
  `FREE_MONTHLY_AI_UNITS`, `profiles.is_pro`) but is switched off; no StoreKit / RevenueCat purchase
  flow is wired yet.

## Repo layout

```
planfect/
├── server/                   # Platform-independent backend logic (TypeScript, unit-tested on Node)
│   ├── scheduling/           #   timezone-aware free-slot + placement engine (routines, commute-before)
│   ├── llm/                  #   PlannerLLM contract, the 10 planner tools, provider adapters, mock
│   ├── maps/                 #   MapsProvider interface
│   ├── planner.ts            #   the agent tool-calling loop
│   ├── usage.ts              #   usage events + cost estimation (dashboard data)
│   └── demo/planDemo.ts      #   runnable end-to-end demo (Node, no keys)
├── supabase/
│   ├── schema.sql            # App schema + Row-Level Security
│   ├── analytics.sql         # usage_events / app_events + dashboard views
│   ├── migrations/           # ordered schema history (category, preferences, recurring_tasks, is_pro)
│   └── functions/
│       ├── plan/             #   the planner Edge Function (wires server/ → Supabase + OpenAI + Google Maps)
│       ├── plan-demo/        #   public, no-auth, no-DB demo of the planner
│       └── insights/         #   AI time-analysis
├── ios/
│   ├── Planfect/             # SwiftUI app (Chat · Schedule · Insights · Profile · Onboarding · Services)
│   ├── PlanfectWidget/       # WidgetKit home/lock-screen widget (shares an App Group with the app)
│   └── project.yml           # XcodeGen project spec
├── dashboard/                # Next.js admin dashboard (usage / cost / model comparison) — Basic-Auth gated
├── support-site/             # Zero-dep Node site: /support, /privacy, /showcase (+ the live demo)
├── docs/                     # Design docs + ADRs (see index below)
└── .github/workflows/ci.yml  # Runs the server + dashboard tests on every push
```

## Run it

**Backend logic — no Mac, no keys, no Supabase:**

```bash
npm test                                                  # 29 unit tests (Node ≥ 22, built-in runner)
node --experimental-strip-types server/demo/planDemo.ts   # end-to-end planner demo (mock LLM + maps)
```

**iOS app — macOS + Xcode:**

```bash
cd ios && xcodegen generate          # generate Planfect.xcodeproj from project.yml
# open Planfect.xcodeproj and run on an iPhone simulator — no signing identity needed for the sim
```

**Edge Functions — Supabase CLI:**

```bash
supabase functions deploy plan       --project-ref <ref>
supabase functions deploy plan-demo  --no-verify-jwt --project-ref <ref>   # public endpoint
supabase functions deploy insights   --project-ref <ref>
```

## Docs

`docs/` holds the design record (intent + decisions). The product has since moved past several of
these documents — this README and the [live showcase](https://planfect-support-production.up.railway.app/showcase)
reflect the current state.

- **Start here:** [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) &nbsp;·&nbsp; **How it fits together:** [ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **The data:** [DATA_MODEL.md](docs/DATA_MODEL.md) + [schema.sql](supabase/schema.sql)
- **The AI brain:** [AI_PLANNING.md](docs/AI_PLANNING.md) &nbsp;·&nbsp; [AI_PROVIDERS.md](docs/AI_PROVIDERS.md)
- **Dashboard:** [DASHBOARD.md](docs/DASHBOARD.md) &nbsp;·&nbsp; **Deploy (Railway):** [railway-deploy.md](docs/railway-deploy.md)
- **App Store copy:** [app-store-listing.md](docs/app-store-listing.md) &nbsp;·&nbsp; **Decisions (ADRs):** [DECISIONS.md](docs/DECISIONS.md)
- **中文:** [项目进度](docs/PROJECT_STATUS.zh.md) &nbsp;·&nbsp; [上手 / 继续指南](docs/SETUP.zh.md)

## Recent updates

_2026-07-18_

- **Overnight context reset.** The chat thread used to live forever — the only trims were the
  server's 40-message tail cap and a manual "New chat", so weeks-old turns (stale dates, an old
  fabricated refusal) kept poisoning the model. Now, crossing 4 AM local time after the last
  exchange clears the LLM history (checked on app open and before each send): the visible
  transcript stays, a subtle "新的一天 / New day" divider marks the seam, and preferences /
  routine / schedule are unaffected (they live server-side). DEBUG hook `PLANFECT_STALE_CHAT=1`
  forces it for testing; verified in the simulator.
- **Agent observability in the dashboard.** Every `/plan` request now logs one `plan_turn`
  app_event (result type, model steps, integrity-nudge count, end-to-end ms, errors — fire-and-
  forget), and the dashboard grew a "🔍 Agent observability" section: turns/day with outcome mix
  and p95 latency, per-model step latency + prompt-cache hit rate (surfaced immediately: M3 is
  p50 3.5s / p95 7.2s with only 60% cache hit), and update_task edit reliability with top errors.
- **kimi-k2.6-nothink: the fast Kimi.** k2.6 burns ~1000 reasoning tokens per step (~8 s); Kimi's
  `thinking: {type: "disabled"}` flag cuts the same model to **~1.3–2.3 s/step at half a cent a
  turn** with correct results on both the incident scenario and a 3-task brain-dump (natural
  time-of-day picks intact). The adapter maps a `-nothink` model-name suffix to that flag, and the
  dashboard switcher now lists it as the recommended fast option (k3 stays as a ~30 s quality
  benchmark; `reasoning_effort` only supports "max" today).
- **Kimi (Moonshot) wired in as a fifth provider.** `createPlanner('kimi')` hits the
  OpenAI-compatible `api.moonshot.cn/v1` (mainland key), with `KIMI_API_KEY` set as a Supabase
  secret and `kimi-k2.6` / `kimi-k3` priced in [usage.ts](server/usage.ts) and selectable from the
  dashboard's model switcher. E2E-tested against the real API with the planner loop + scheduling
  engine on the incident scenario ("周一五点有面试", today anchored Sat 7/18): k2.6 scheduled it
  correctly (Mon 17:00) in one step, ~7.8 s, $0.0034/turn; k3 also correct but ~29 s — k2.6 is the
  usable default, k3 a quality benchmark. Production stays on MiniMax-M3 until switched in the
  dashboard.

- **Integrity guard now catches fabricated "system down" refusals (deployed).** A user asked for
  "周一五点有面试" and the planner replied it *couldn't* — "目前系统对周一的更新没有反应,等系统恢复
  正常再处理?" — without attempting a single tool call (the same request then succeeded seconds
  later; `app_events`/`usage_events` confirmed no write was ever tried). The existing integrity
  check only bounced false *success* claims, so [planner.ts](server/planner.ts) gained the mirror
  image: a final reply matching `claimsSystemFailure` (加不了 / 改不动 / 系统没反应 / "not
  responding" / "try later") with **zero write attempts** that turn gets one corrective step —
  honest failure reports after a real attempt pass through untouched. The system prompt also states
  outright that the system is never down and each new message is a fresh request. +3 unit tests (44
  pass); `/plan` redeployed.
- **Chat: copy, resend, retry, and a jump-to-latest that survives long scrollback.** Long-press any
  bubble to copy it; long-press your own to resend it verbatim — no more retyping a failed message.
  A failed turn now renders with a Retry button that re-runs the request (safe: history only
  advances on success). And the jump-to-latest button — shipped in build 11 but reported "missing" —
  actually vanished whenever you scrolled far up: the bottom sentinel that measured "at bottom" sat
  inside a `LazyVStack`, got lazily unloaded, and its preference reverted to the default `true`. The
  measurement now lives on the never-unloaded content container ([ChatView.swift](ios/Planfect/Chat/ChatView.swift)).
- **Week view opens where the events are, and dates are readable in Chinese.** The week grid always
  opened at 12 AM (the `scrollTo` in a bare `onAppear` ran before layout and blocks load async — it
  now defers a tick and re-anchors when the earliest hour changes; empty weeks open at 7 AM), and
  the column headers rendered "1…" because `.dateTime.day()` localizes to "19日" in zh and truncated
  in the 24 pt circle — now a bare day number in week *and* month views
  ([TimelineViews.swift](ios/Planfect/Schedule/TimelineViews.swift)).
- **Settings discoverability.** A one-time dismissible "Good to know / 小提示" card at the top of
  Profile spells out what's tunable (app language, voice-input language, wake/sleep/meal times,
  reminders, calendar sync), and the onboarding how-to gained the same pointer.
- **No more phantom "已取消" alerts.** Opening the Friends tab (or Schedule/Insights) could pop an
  error alert saying just "已取消"/"cancelled" — that was SwiftUI cancelling an in-flight load when
  the tab switched, and the `NSURLErrorCancelled` surfacing as if it were a real failure. A shared
  `Error.uiMessage` helper ([ErrorPresentation.swift](ios/Planfect/Shared/ErrorPresentation.swift))
  now swallows cancellation errors (`CancellationError`, `NSURLErrorCancelled`,
  `NSUserCancelledError`) across every alert-driven catch site; real errors still surface unchanged.

_2026-07-11_

- **v1.0.2 (build 11) shipped to the App Store — widget upgrade included.** The widget now shows a
  **live progress bar** for the plan in progress (WidgetKit `timerInterval`, no timeline churn), a
  new **systemLarge all-day agenda** with a done-count header, a **lock-screen progress ring**
  (done/total today with remaining in the center), and day-aware labels — a late-evening "Next"
  pointing at tomorrow now reads "周二 9:00" instead of masquerading as today; "N left today" counts
  only today. Release automation now lives entirely in CLI: ASC-API-created provisioning profiles
  (app + widget) with the imported distribution cert, manual-signing export, `altool` upload, and an
  API script that creates the version, writes bilingual release notes, attaches the build, and
  submits for review with auto-release on approval. This build also carries the Calendar-sync and
  integrity-check fixes below to real users.

_2026-07-05_

- **"排好了 ✅" must now be true: an integrity check bounces success claims with no actual write.**
  A user confirmed a duration card, got "Golf practice 今天 3:00–4:00pm ✅" — and the Schedule tab
  stayed empty: the model had skipped the tool call entirely. `runPlanner` now tracks whether ANY
  write landed in the turn (placed `schedule_tasks` items, or `ok:true` from
  `update_task`/`set_recurring`/`set_routine`); a final reply that *claims* a calendar change
  (✅/已安排/排好/改到/scheduled/booked/…) with no write gets bounced back once with an automated
  integrity note — the model then really schedules it (receipt and all) or answers honestly.
  Unit-tested with the mock planner (fires once, never on real writes).

- **Apple Calendar mirror now follows edits, deletes, and notes.** The reconcile logic was fine but
  only ran on `scheduled` responses and after opening the Schedule tab — a chat edit ("改到3点",
  delete) came back as a plain message and Apple Calendar kept the old time until the next tab
  visit; user notes never synced at all. The chat now refreshes mirrors (reminders + calendar) after
  message-type turns too, and mirrored events carry the block's note (compared in the diff, so
  editing a note updates Calendar).

- **~35% smaller prompt + capped thread = faster, cheaper turns, verified by eval.** The system
  prompt went 6.7k → 4.4k tokens with every rule kept (the eval suite gates it: 23/24 before, 23/24
  after, and the one flaky boundary case got an explicit rule — a stated day-part now overrides the
  activity's natural window). The replayed chat history is capped server-side at the last 40
  messages (cut at a user-turn boundary), so weeks-old threads stop costing ~30k input tokens per
  step and can't feed the model stale task ids. Friend lookups joined the parallel context batch and
  per-task analytics writes are fire-and-forget.

- **Single occurrences of a recurring habit are now editable in chat ("下周三那次健身取消").**
  Occurrence blocks materialized from a recurring rule have no `tasks` row, so the calendar list
  showed them with **no id at all** — the model literally could not move, complete, or cancel one,
  the same dead end just fixed for one-off tasks. Now task-less blocks (recurring occurrences,
  friend-shared plans) carry a `[block:UUID]` tag; `update_task` resolves either id kind and edits
  exactly that one block — the rule and all other weeks stay, and `materializeRecurring`'s
  `materialized_until` invariant guarantees a deleted/moved occurrence is never resurrected (same
  honesty + `current_tasks` self-heal + `app_events` logging as task edits). Also anchored Mon–Sun
  **week arithmetic in the prompt** (pre-computed "next week starts …" dates, like 明天/后天):
  MiniMax-M3 had resolved 再下周三 said on a Sunday to the wrong week; the two new pinned-Sunday
  eval scenarios (`EVAL_ONLY=wednesday`) now pass 2/2, and the live flow confirms create → move one
  → cancel one → no resurrection, with absolute dates in every receipt.

- **"改不了也删不掉" fixed: update_task is now honest, self-healing, and observable (from a real
  user report).** A user asked to move an interview from 3:30 to 3:00 — the assistant claimed
  success, then spent four turns inventing excuses ("no permission") while the calendar never
  changed. Root cause chain: in a weeks-long thread the model reused a **stale [task:id] from an
  old turn**; the handler then reported "ok" even when a write **matched zero rows or errored**
  (PostgREST treats both as bland success), so the model's false "已调到 ✅" entered the thread and
  it kept believing itself. Fixes: every `update_task` write now checks the DB error **and** the
  affected-row count (no more silent no-ops); any failure returns `current_tasks` — the live ids +
  times — so the model retries with the right id **in the same turn**; `schedule_tasks` returns each
  new `task_id` so same-turn follow-up edits never depend on old context; decorated ids
  (`task:UUID`) and a string-encoded `changes` are tolerated; the prompt forbids claiming success
  without `ok:true` and warns that ids from earlier turns go stale. Every edit attempt is logged to
  `app_events` (`planner_update_task`, args + result), so the next report is a query, not an
  archaeology dig. Verified end-to-end against the deployed function (schedule → move → delete all
  land in the DB), plus contract checks for the stale-id / decorated-id / string-changes /
  empty-changes paths.

_2026-06-26_

- **Per-event timezones + scheduling-accuracy fixes (from real user reports).** A traveling user
  saw plans drift: times were rendered in the device's *current* zone, and the model would sometimes
  "helpfully" shift an explicit clock time. Now every block carries its own IANA zone (`time_blocks.tz`),
  set from where the user **is when they plan** (the app sends `device_timezone` each request; the
  planner can override per-task for a future trip). The app — day list, week timeline, receipt card,
  notifications, and the home-screen widget — renders each plan at the **wall-clock it was planned in**
  (with a small "PDT"-style tag when it isn't the device's zone), so "3pm in LA" keeps showing 3pm
  after you fly home. The system prompt now forbids ever converting a stated clock time. Plus three
  agent fixes the reports surfaced: **(1)** correcting an item's time updates *that* item (and recomputes
  anything "after" it from its real end, no more overlaps); **(2)** "do X after Y" anchors on Y's actual
  end instead of a guessed slot; **(3)** bulk edits ("shift everything an hour", "全部改成…") iterate
  `update_task` per item instead of refusing. A pinned/explicit time now never silently slides — it
  lands exactly where asked or reports the conflict — and moving a task carries its commute/buffer
  with it (no orphaned blocks). A friend's schedule renders in **their** planned zone too — the
  `friend_schedule` RPC now returns `tz`, blurred by tier like the title/category (close friends only,
  never for a private block). Server tests 37/37; app + widget build clean.

_2026-06-24_

- **In-app AI data-use consent (App Review 5.1.1(i) / 5.1.2(i)).** Before any text reaches the
  third-party AI, the app now shows a one-time in-app disclosure + consent: **what** is sent (your
  messages plus the task / routine / schedule context), **who** it goes to (OpenAI, or MiniMax in
  mainland China; addresses → Google Maps), and what we **never** do (no ads, no cross-app tracking,
  no selling) — with a Privacy Policy link and an **Agree & Continue** gate that blocks every
  send / answer until accepted (a privacy policy alone is not sufficient, per Apple). The privacy
  policy now names each provider and confirms equivalent protection. Bilingual (EN / 中文).

_2026-06-23_

- **App Review 2.1 fix — onboarding now follows the device language.** The 1.0 submission was held
  under Guideline 2.1: the onboarding flow still rendered in Chinese on an English-language device
  while the rest of the app was already localized. Every onboarding string moved to
  `String(localized:)` with matching zh-Hans translations, and the weekday pickers now use the
  locale's own standalone symbols — so onboarding shows English on English devices and Chinese on
  Chinese ones, consistent with the rest of the app. Shipped in **build 7** and resubmitted for review.

_2026-06-22_

- **Friends — phases 2 & 3 (shared calendars, collaborative plans, push).** A friend's calendar is
  now viewable, **blurred server-side by tier** — regular friends see only busy/free, close friends
  see specifics, and any plan can be set **Private** to force "Busy" even for close friends (a
  security-definer `friend_schedule` RPC is the only authorized read path; the owner's own RLS still
  hides the rows). Tell the planner a plan is **"with @friend"** and it double-books both calendars
  via a shared `shared_event_id` — permissioned so only friends who marked you Close qualify, and
  proven additive (eval 22/22, no regression to existing scheduling). Plus **push notifications**
  (APNs): friend requests / accepts and collaborative plans fire an instant push, signed with an
  ES256 provider JWT from the team's APNs key. Shipped in build 6.
- **Friends — phase 1.** Profiles gain a unique **@username**, an editable **display name**, and an
  uploadable **avatar**. A new **Friends tab** finds people by @username, sends / accepts requests,
  and grades each friend **Regular** or **Close** — single-directional, so *you* control per-friend
  what they're allowed (Close will see specifics and be able to schedule with you; Regular only sees
  when you're busy). Backed by a directed-edge `friendships` model, a service-role `friends` Edge
  Function that keeps both sides consistent, and an `avatars` storage bucket. Cross-calendar
  visibility (blurred by tier) and collaborative scheduling land in the next phases.
- **Apple Calendar sync (app → calendar).** Plans now sync into a dedicated **Planfect** calendar,
  reconciled — create / move / delete — against a `planfect://block/<id>` marker stamped on each
  event. Edits and deletions in the app flow to Apple Calendar, while your personal events are never
  read or touched; the planner also excludes its own calendar when reading "busy" so it never plans
  around itself. (Pull-back from Apple Calendar → app is the next phase; the id markers are already in
  place for it.)
- **Instant in-app language switch.** Settings gains an **App Language** picker (Auto / English / 中文)
  that re-skins the whole app immediately — no relaunch. A `Bundle.main` reclass redirects every
  localized lookup to the chosen `.lproj` at runtime, and the view tree re-renders keyed on the
  language while the one-time startup `.task` stays put.
- **Jump to latest in chat.** A floating ⌄ button appears when you scroll up in a conversation —
  tap it to snap back to the newest message (tapping the Chat tab still jumps to the top, as before).
- **The keyboard no longer traps you.** Swipe down in the conversation to dismiss the keyboard, and
  switching tabs now force-drops it — so a stuck keyboard can't cover the tab bar and pin you to Chat.
- **Voice input on the "Other" answer.** The free-text "Other…" option on a question card gets the
  same mic + dictation as the chat box, so you can speak a custom answer instead of typing it.

_2026-06-21_

- **Commute shows the real travel mode.** The receipt no longer always reads "transit" with a walking
  icon — `estimate_commute` and `schedule_tasks` now thread the actual mode (e.g. driving for an
  airport run) into the commute block and the receipt's label + glyph.
- **Tentative holds for undecided details.** When you clearly mean to do something but a detail is
  still open (*"fine dining on the 28th, haven't picked where"*), the planner blocks a tentative slot
  to refine later — instead of asking which place or scheduling nothing.
- **No more chat freeze.** Sending a new message (or answering late) while a question card was still
  pending left a malformed tool-call thread the model rejects, which could brick the conversation; the
  backend now repairs the thread and the UI locks a superseded card.
- **MiniMax (M3) wired as a provider.** Added `minimax` to the pluggable LLM layer — OpenAI-compatible,
  so it reuses the existing adapter — as a domestic-China option. M3 is a reasoning model (its `<think>`
  chain-of-thought is stripped), roughly 7× cheaper per token than the GPT-4.1 tier, and validated
  end-to-end (chat + tool-calling). Flip via `ACTIVE_LLM_PROVIDER=minimax` + `PLANNER_MODEL=MiniMax-M3`.
- **Dashboard → control panel.** The developer dashboard gains a per-surface **model switcher** (app
  vs demo): pick `gpt` / `claude` / `MiniMax` from a dropdown and the live planner switches within
  ~20s, **no redeploy** — backed by a new `runtime_config` table the edge functions read (falling back
  to OpenAI if the chosen provider's key isn't configured).
- **Explicit times schedule directly.** An explicitly-stated clock time with no day (e.g. "下午3点开会")
  now lands on the obvious day (today, or tomorrow if it already passed) with a one-line confirm,
  instead of an unnecessary yes/no question.
- **Prompt-eval harness.** [`server/eval/promptEval.ts`](server/eval/promptEval.ts) drives the real
  planner over a fixed scenario suite (deterministic pinned clock) and scores each result against an
  expected behavior — so prompt changes are *measured* (pass-rate per model) instead of eyeballed.
  Runs against any provider via `EVAL_PROVIDER`/`EVAL_MODEL`.
- **Day-parts schedule directly (prompt).** A bare day-part with no day (e.g. "下午健身" late at night)
  now lands on the soonest valid day as a tap-to-edit receipt instead of a yes/no question — a gap the
  harness caught across every model. The suite is now **22 scenarios** (incl. adversarial: a boundary
  guardrail, past-time, relative dates); `gpt-5.1-chat` passes **22/22**.
- **Build 3 → TestFlight.** v1.0 (build 3) uploaded to App Store Connect carrying the commute-icon +
  chat-freeze iOS fixes (the prompt/commute-mode backend changes were already live on the Edge Functions).
  Repeatable now via [`ios/deploy-testflight.sh`](ios/deploy-testflight.sh) — bumps the build, archives,
  re-signs with an ASC-API-managed distribution cert + profiles (no Xcode GUI, no cloud signing), uploads.
- **Notes: voice input + AI tidy.** A task's note (tap a block → Notes) gains a 🎙️ **Dictate** button
  (on-device speech, reusing the chat's recognizer) and a ✨ **Tidy up** button that reorganizes a
  run-on note into clean bullet points — preserving every detail — via a new `note-tidy` Edge Function
  (cheap `gpt-4.1-mini`). The cleaned text lands in the editable field; you review and Save.

## Author & license

Designed and built end-to-end by **Kejing Yan (闫可菁)** — [LinkedIn](https://linkedin.com/in/kejing-yan)
· [GitHub](https://github.com/anyfruit).

© 2026 Kejing Yan. **All rights reserved** — this repository is published for portfolio and
demonstration purposes only and is **not** open source. See [LICENSE](LICENSE).
