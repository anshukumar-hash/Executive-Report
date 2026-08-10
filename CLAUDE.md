# Executive-Report — deployment & conventions

Spyne Executive Report: a dashboard (`index.html`) plus live metric APIs
(`api/*.js`) that pull from Google Sheets, a Freshdesk proxy, the CSM dashboard,
and Metabase. Runs as a **Type B containerised app on Spyne AWS** — ECS Fargate
behind an ALB, served at **https://executive-report.spyne.ai**.

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
- All runtime config comes from ONE env var, **`APP_SECRETS`**, a JSON string.
  `server.js` parses it once at startup and copies each key into `process.env`
  under its EXISTING env-var name (no new names invented).
- If `APP_SECRETS` is set but is **not valid JSON**, the process **fails fast**
  (exit 1, clear message). If a key listed in `REQUIRED_KEYS` is missing, it
  also fails fast naming that key. **Never hardcode a production fallback.**
- **Required keys today: NONE** (`REQUIRED_KEYS = []`). Every data source is a
  public URL — Google Sheets CSV, the Freshdesk proxy (`dilipticket.vercel.app`),
  the CSM dashboard, the public Supabase RoI endpoint, and Metabase **PUBLIC**
  question links. The app boots and serves correctly with no `APP_SECRETS` at all.
  - `api/delivery.js` accepts OPTIONAL overrides — `METABASE_BASE_URL` and the
    `METABASE_*_PUBLIC_UUID` values — which each have a working default, so they
    are not required. (`METABASE_API_KEY` / `METABASE_DATABASE_ID` are **not**
    used by any handler — delivery reads public links, no key needed.)
  - Pass an override only if a public link is re-shared, e.g.
    `APP_SECRETS='{"METABASE_IMAGE_PUBLIC_UUID":"…"}'`.
- Add a future mandatory secret by using its real env-var name as a key in
  `APP_SECRETS` **and** listing that name in `REQUIRED_KEYS` in `server.js`.
- **Auth:** this app has **no sign-in / auth middleware** and **no Google OAuth**,
  so `/health` is trivially unauthenticated and there is **no `AUTH_URL`** to set.
  If Google sign-in is ever added, set `AUTH_URL=https://executive-report.spyne.ai`
  and keep `/health` outside the auth guard.

## 5. Pipeline specs — `code-build.yaml` / `code-deploy.yaml`
- Both live at the repo root; the platform pipeline runs them (used as-is).
- `code-build.yaml` logs in to ECR, builds the image from the `Dockerfile`,
  pushes `:<commit>` and `:latest`, and writes `imagedefinitions.json`.
- `code-deploy.yaml` takes that `imagedefinitions.json` handoff to ECS.
- The pipeline builds from the **`aws-prod`** branch.
- Non-secret upstreams (Google Sheets CSV exports, `dilipticket.vercel.app`,
  the CSM dashboard, the public Supabase RoI endpoint) are hardcoded URLs and
  need outbound internet from the Fargate task.

## Note on the reference files
The migration reference `Dockerfile` and `app/health/route.ts` assumed a **Next.js**
app (`.next/standalone`, `npm run build`, App Router + TypeScript). This app is
static `index.html` + Node/Express `(req,res)` handlers, so those were adapted:
a plain multi-stage Express `Dockerfile` (`node:20-slim`, `npm ci`, no `ENV`,
port **8080**) and a `/health` route inside `server.js`. `code-build.yaml`,
`code-deploy.yaml`, and `.dockerignore` are used as provided.

## Scheduled jobs (not part of the container)
- `email/` holds the daily email + Slack screenshot jobs, run by GitHub Actions
  (`.github/workflows/*`), independent of this web container.
