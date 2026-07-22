# Executive-Report — deployment & conventions

Spyne Executive Report: a dashboard (`index.html`) plus live metric APIs
(`api/*.js`) that pull from Google Sheets, a Freshdesk proxy, the CSM dashboard,
and Metabase. Runs as a **Type B containerised app on Spyne AWS** — ECS Fargate
behind an ALB, served at **https://Executive-Report.spyne.ai**.

Keep the rules below when changing anything; they are what make it deployable.

## Runtime server
- `server.js` (Express) serves `index.html` at `/` and mounts the API handlers
  at `/api/metrics`, `/api/health`, `/api/delivery`, `/api/support`.
- The `api/*.js` files are Express-compatible `(req, res)` handlers reused
  unchanged. They read Metabase config from `process.env` — `server.js`
  populates those from `APP_SECRETS` at startup (see below).
- Listens on `PORT` (default **8080**). Start with `npm start`.

## 1. Docker
- Multi-stage `Dockerfile` on `node:20-slim`.
- Install with **`npm ci`** against the committed `package-lock.json` — never
  `npm install` in the image.
- **Do NOT set any `ENV` in the Dockerfile**, including `NODE_ENV`. All config
  is injected at runtime by ECS.

## 2. .dockerignore
- Must exclude at least `node_modules`, `.next`, `.git`, `.env*` (also `.vercel`
  and `email/`). Without it, `COPY . .` ships Mac-built `node_modules` into the
  Linux image and the build breaks.

## 3. /health
- `GET /health` returns `{ status, service, timestamp }` where `service` is
  `process.env.NAME`.
- It MUST stay **outside any auth middleware** and never redirect. The ALB
  target-group check hits it; a redirect to a sign-in page reads as unhealthy
  and ECS kills the task in a loop (looks exactly like a crash).
- It does no external I/O, so it stays fast and independent of upstream
  services. (Note: `/api/health` is a *different* thing — the CSM RAG metric.)

## 4. Runtime config — `APP_SECRETS`
- All runtime secrets come from ONE env var, **`APP_SECRETS`**, a JSON string.
- `server.js` parses it at startup and **fails fast** (exit 1, clear message
  naming the missing key) if it is unset, malformed, or missing a required key.
- **Never hardcode a production fallback.**
- Required keys today:
  - `METABASE_API_KEY`
  - `METABASE_BASE_URL`  (e.g. `https://metabase.spyne.ai`)
  - `METABASE_DATABASE_ID`  (e.g. `363`)
  Example: `APP_SECRETS='{"METABASE_API_KEY":"…","METABASE_BASE_URL":"https://metabase.spyne.ai","METABASE_DATABASE_ID":"363"}'`
- Add new runtime secrets by adding a key to `APP_SECRETS` and listing it in
  `REQUIRED_KEYS` in `server.js` — not as a separate env var.
- **Auth:** this app currently has **no sign-in / auth middleware**, so `/health`
  is trivially unauthenticated. If Google sign-in is ever added, also set
  `AUTH_URL=https://Executive-Report.spyne.ai` or Google rejects the redirect,
  and keep `/health` outside the auth guard.

## Pipeline
- The AWS pipeline builds from the **`aws-prod`** branch.
- Non-secret upstreams (Google Sheets CSV exports, `dilipticket.vercel.app`,
  the CSM dashboard, the public Supabase RoI endpoint) are hardcoded URLs and
  need outbound internet from the Fargate task.

## Scheduled jobs (not part of the container)
- `email/` holds the daily email + Slack screenshot jobs, run by GitHub Actions
  (`.github/workflows/*`), independent of this web container.
