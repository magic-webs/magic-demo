# Magic Browser Assistant

Ek web app jisme aap AI assistant se baat karte ho, aur wo ek **real browser** chalata hai jo aap usi tab mein live dekhte ho.

> “Open https://agent.magicwebs.ai, open pricing, scroll down and explain the plans” → assistant real Chrome mein click/scroll karta hai, har action verify karta hai, aur page par jo dikh raha hai uske basis par explain karta hai.

The browser is **our own self-hosted Chromium** (one isolated process per session, run by `worker/`). It never controls your personal Chrome profile, your mouse or your desktop. Browserbase is supported as an optional alternative.

---

## 1. Architecture (simple version)

```
 Your browser tab (Next.js UI)                         Convex (backend + DB, realtime)
 ┌───────────────┬─────────────┐  queries/mutations   ┌───────────────────────────────┐
 │ Live view     │ Chat (AI SDK│ ───────────────────▶ │ conversations, messages,       │
 │ (JPEG stream  │ useChat)    │ ◀─── live updates ── │ browserSessions, browserTabs,  │
 │  over WS)     │ Timeline    │                      │ agentRuns, actionLogs,         │
 └──────┬────────┴──────┬──────┘                      │ approvals, userSettings, usage │
        │               │ POST /api/chat (stream)     └───────────────▲───────────────┘
        │               ▼                                             │ every action is gated
        │   Next.js route handlers (thin, server-only)                │ + logged here
        │   ├─ AI SDK streamText ──▶ Vercel AI Gateway ──▶ model      │
        │   └─ tool layer ──▶ Playwright over CDP ────────────────────┘
        │                          │  (Bearer secret)
        │  signed, short-lived     ▼
        └──── live token ────▶ worker/  (Node service)
                               ├─ one Chromium process + temp profile per session
                               ├─ egress proxy: blocks localhost / LAN / metadata on every hop
                               ├─ CDP proxy for the app's Playwright
                               └─ screencast + takeover input over WebSocket
```

- **Convex** owns all durable state and checks ownership on every query/mutation (`convex/lib/access.ts`).
- **Next.js routes** (`app/api/*`) stream the chat and run the bounded agent loop. They call Convex *as the signed-in user*, so Convex re-checks ownership.
- **The worker** (`worker/`) hosts the real browsers. The app's Playwright connects to it over CDP with a server-only secret. The UI gets a per-tab, 10-minute signed token for the live stream, issued only after an ownership check. Input (takeover) tokens are only issued while the assistant is paused.
- **Vercel AI Gateway** handles every model call (`@ai-sdk/gateway`). The model ID is configurable (`AI_MODEL`).

**Agent loop (per user message):** authenticate → save the message → take the session lock → the model picks **one** tool → the Convex gate checks stop/pause/lock/idempotency → execute → observe and verify → log the result → repeat until done or blocked → stream a short answer based on observations.

---

## 2. Project structure

```
app/
  page.tsx                 workspace (sidebar, live browser, chat)
  signin/                  email + password sign-in (Convex Auth)
  sample/                  built-in fictional website (home, pricing, records, contact form)
  api/chat/route.ts        agent loop: AI SDK streamText + tools + limits + persistence
  api/browser/session      POST start / DELETE stop+release
  api/browser/live         per-tab live-view URLs/tokens (owner only)
  api/browser/control      address bar, back/forward, tabs, execute an approved action
  api/config               non-secret mode flags for honest UI labels
components/workspace/      browser-panel (live stream + takeover), chat-panel, timeline, approvals, settings
convex/                    schema, ownership helpers, runs, action gate, approvals, sessions, cleanup cron, tests
lib/agent/                 runtime (Convex + adapter glue), Zod tools, prompt, demo planner
lib/browser/
  cdp-adapter.ts           Playwright-over-CDP adapter (observe, refs, click, type, scroll, tabs, cursor)
  remote-providers.ts      self-hosted worker provider + optional Browserbase provider
  demo-adapter.ts          clearly-labelled simulation for running without any browser
  url-safety.ts, risk.ts   navigation checks, approval policy
  live-token.ts            signed live-view tokens (shared by app + worker)
worker/
  index.ts                 HTTP API + CDP proxy + live stream server
  sessions.ts              Chromium lifecycle, timeouts, allowlist guard
  egress-proxy.ts          per-session proxy that blocks private networks on every request
Dockerfile.worker          container for deploying the worker
tests/                     unit tests (URL safety, approval policy, demo adapter, worker security)
lib/voice/providers.ts     interfaces for the later voice/avatar phase (not wired)
```

---

## 3. Local setup (step by step)

Pehle ye install hona chahiye: **Node 22+**, **Bun** (`curl -fsSL https://bun.sh/install | bash`), and **Google Chrome**. Without Chrome, run `npx playwright-core install chromium`.

```bash
# 1) Dependencies (versions locked in bun.lock)
bun install

# 2) Convex backend — terminal 1 (pehli baar login/project select karwayega)
npx convex dev

# 3) Browser worker — terminal 2
bun run worker
#    → "Browser worker listening on http://127.0.0.1:8787 (chrome: …)"

# 4) App — terminal 3
bun run dev
#    → http://localhost:3000 kholo, account banao, chat karo
```

Teeno terminal chalte rehne chahiye. Agar worker band hai to app "The browser worker isn't reachable" bolega.

### `.env.local` (already set up on this machine)

Copy `.env.example` to `.env.local` and fill it in. Never paste keys into chat.

- `AI_GATEWAY_API_KEY`: vercel.com → your team → **AI Gateway → API Keys**. `AI_MODEL=anthropic/claude-haiku-5.5` (or `anthropic/claude-sonnet-5.5`).
- `BROWSER_WORKER_SECRET`: any long random string, shared by the app and the worker. Generate one:
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- `DEMO_SITE_URL=http://localhost:3000/sample` lets the self-hosted browser open the built-in sample site. Only `/sample` and `/_next` are allowed on that origin; `/api` etc. stay blocked.

**Auth keys (only once per Convex deployment):** Convex Auth needs a signing key pair on the deployment. This was already done for your dev deployment. For a new deployment (e.g. prod):

```bash
node -e 'import("jose").then(async({generateKeyPair,exportPKCS8,exportJWK})=>{const k=await generateKeyPair("RS256",{extractable:true});const p=await exportPKCS8(k.privateKey);const j=await exportJWK(k.publicKey);console.log("JWT_PRIVATE_KEY="+p.trimEnd().replace(/\n/g," "));console.log("JWKS="+JSON.stringify({keys:[{use:"sig",...j}]}))})' > .auth-keys.txt
npx convex env set "$(sed -n 1p .auth-keys.txt)"
npx convex env set "$(sed -n 2p .auth-keys.txt)"
npx convex env set SITE_URL http://localhost:3000
rm .auth-keys.txt
```

### Modes

| What's running/configured | Browser | AI |
|---|---|---|
| Worker + `BROWSER_WORKER_*` env | **Real self-hosted Chromium** with live stream ✅ | |
| Browserbase keys (and no worker env) | Real Browserbase Chromium | |
| Neither | **Demo browser (simulated)**: `/sample` only, labelled “not a remote browser” | |
| `AI_GATEWAY_API_KEY` | | Real model via AI Gateway ✅ |
| No Gateway key | | Keyword **demo planner**, not an AI (it says so) |

The header badges always show the current mode.

---

## 4. Environment variables: kaunsa variable kahan jaata hai

| Variable | Next.js app (`.env.local` / Vercel) | Worker | Convex deployment |
|---|---|---|---|
| `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL` | ✅ (auto) | — | — |
| `AI_GATEWAY_API_KEY`, `AI_MODEL` | ✅ | — | — |
| `BROWSER_WORKER_URL` | ✅ (how the server reaches the worker) | — | — |
| `BROWSER_WORKER_PUBLIC_URL` | ✅ if users reach the worker on a different URL (e.g. `https://browser.example.com`) | — | — |
| `BROWSER_WORKER_SECRET` | ✅ | ✅ (same value) | — |
| `WORKER_PORT`, `WORKER_HOST`, `WORKER_MAX_SESSIONS`, `WORKER_IDLE_SECONDS`, `BROWSER_EXECUTABLE_PATH`, `WORKER_NO_SANDBOX` | — | ✅ | — |
| `DEMO_SITE_URL`, `ALLOWED_DOMAINS`, `AGENT_*`, `BROWSER_*` limits | ✅ | — | — |
| `BROWSERBASE_*` (optional) | ✅ | — | optional (cleanup cron) |
| `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL` | — | — | ✅ (`npx convex env set`) |

Locally, `bun run worker` reads the same `.env.local`.

---

## 5. Tests and checks

```bash
bun run typecheck   # TypeScript
bun run lint        # ESLint (one pre-existing error in components/ui/carousel.tsx, unused)
bun run test        # Vitest: convex-test backend rules + unit/security tests (44 tests)
bun run build       # production build
```

**Automated tests** (no network):
- Ownership: user B can't read or act on user A's data. Stop blocks queued actions. Pause blocks changes. A new message supersedes the old run. Tool calls are idempotent.
- Approvals run once and only after approval. One live session per user. Ending a session releases the lock.
- URL safety, the approval policy, and the demo adapter.
- Worker security: live tokens can't be forged, tampered with or replayed after expiry. The egress proxy blocks private/metadata targets and CONNECT tunnels to them. Only the trusted `/sample` prefix gets an exception.

**Verified live on this machine** (real Chrome via the worker + Haiku 5.5 via AI Gateway):
- agent.magicwebs.ai → Pricing → scroll → plans explained from the real page.
- YouTube in a new tab, then switch back. The live stream follows the active tab.
- The labelled assistant cursor appears in the live stream before clicks.
- The prompt-injection text in the sample record was flagged and ignored.
- Security probe: localhost `/api`, the worker itself, `192.168.1.1`, `169.254.169.254`, in-page `fetch` to localhost, and **a public page redirecting to localhost** are all blocked. CDP without the secret is rejected.

---

## 6. Deployment

**Convex (production):**
```bash
npx convex deploy
npx convex env set --prod "JWT_PRIVATE_KEY=..."   # new key pair, NAME=VALUE form
npx convex env set --prod "JWKS=..."
npx convex env set --prod SITE_URL https://<your-app>.vercel.app
```

**Next.js on Vercel:**
1. Import the repo. Build command: `npx convex deploy --cmd 'bun run build'`, and add `CONVEX_DEPLOY_KEY` (Convex dashboard → Settings → Deploy keys).
2. Add the app env vars from §4. Set `BROWSER_WORKER_URL` to your worker's public `https://` URL. The live view then uses `wss://`.

**Worker (long-running container, NOT serverless):**
```bash
docker build -f Dockerfile.worker -t magic-browser-worker .
docker run -p 8787:8787 -e BROWSER_WORKER_SECRET=... magic-browser-worker
```
Deploy the same image on Fly.io, Railway, Render or a VPS, behind HTTPS (the host's TLS or a reverse proxy). Give it the same `BROWSER_WORKER_SECRET` as the app, and size it at roughly 300–500 MB of RAM per concurrent session (`WORKER_MAX_SESSIONS`).

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| “The browser worker isn't reachable” | Start `bun run worker`, and check `BROWSER_WORKER_URL` and the secret match. |
| Worker exits: “BROWSER_WORKER_SECRET must be set” | Add a 32+ character secret to `.env.local`. |
| “No Chrome/Chromium found” | Install Chrome, set `BROWSER_EXECUTABLE_PATH`, or run `npx playwright-core install chromium`. |
| Live view “disconnected” | The session expired or the worker restarted. Press Stop → Start session. |
| Session “expired” after restarting the worker | Expected: browsers live in the worker process. Start a new session. |
| “not on the allowed-domain list” | Add the domain in Settings (or `ALLOWED_DOMAINS`) and **start a new session**. |
| A page shows “Blocked by browser worker” | It (or a redirect) tried to reach a private/local address. This is intentional. |
| “already have a live browser session in another conversation” | One live session per user. Stop it in that conversation. |
| Replies say “Demo planner” | `AI_GATEWAY_API_KEY` is missing from the app env. Restart `bun run dev`. |
| Always redirected to `/signin` | Convex auth keys are missing. See “Auth keys”. |

---

## 8. Honest limitations

- **The worker keeps browsers in memory.** Restarting it ends all sessions (the app marks them expired and you can start a new one). Run a single worker instance, or add sticky routing before scaling out.
- **Network safety:** every browser request goes through the worker's egress proxy. The proxy resolves DNS itself, blocks private/loopback/link-local/metadata ranges and non-80/443 ports, and connects to the exact IP it checked. The domain allowlist applies to top-level navigations. Each tab's final URL is rechecked, and the browser is moved off a disallowed page. WebRTC and other non-proxied UDP aren't covered by the proxy (QUIC is disabled).
- **Live stream:** JPEG frames via CDP screencast, at about the page's repaint rate. Fine for watching; not video-smooth. Takeover sends mouse, wheel and basic keyboard input. IME and clipboard aren't supported.
- **Approval policy is heuristic** and errs toward asking. Approvals are bound to tab + URL + role + accessible name. If the page changes, nothing runs.
- **Haiku 5.5 is fast but sometimes needs a retry.** It once produced an over-long click label, which the tool layer now tolerates. For harder sites, try `AI_MODEL=anthropic/claude-sonnet-5.5`.
- **Not verified:** `Dockerfile.worker` hasn't been built here. The Browserbase provider hasn't been run against real Browserbase.
- **Voice / avatar** are not implemented. Interfaces are in `lib/voice/providers.ts`.
