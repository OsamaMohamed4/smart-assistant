# Smart Assistant

Multi-tenant Arabic (Saudi) AI voice call-center platform. Each tenant ("company")
gets an AI phone agent that answers inbound calls, runs outbound campaigns, and
is configured entirely from a web admin — no code per tenant.

Production: Railway → `sermad.up.railway.app`

---

## Architecture

```
Landline / DID
      │
      ▼
   3CX PBX ──────► SIP Trunk ──────► Vapi ───────► this server
                                      │              (webhooks, KB tool)
                                      ├─ STT   Google Gemini 2.5 Flash (ar)
                                      ├─ LLM   OpenAI gpt-4.1
                                      └─ TTS   ElevenLabs turbo v2.5
```

Vapi owns the realtime media pipeline. This server owns tenants, prompts,
knowledge bases, campaigns, call records, and the admin UI. Twilio was removed
in July 2026 — do not reintroduce it.

**Stack:** Node 20 + Express 5 · PostgreSQL (pgvector) · React 19 + Vite +
Tailwind · BullMQ/Redis (optional) · Prometheus.

### Layout

| Path | What lives there |
|---|---|
| `server.js` | HTTP routes, Vapi sync, admin API. The monolith, ~2.4k lines. |
| `db.js` | Driver selector — `DB_DRIVER=postgres` or sqlite. |
| `db-postgres.js` / `db-sqlite.js` | Prepared statements per driver. **Keep in sync.** |
| `db-pg-schema.js` | Postgres DDL. |
| `lib/migrations-pg.js` | Idempotent Postgres migrations (FKs, added columns). |
| `lib/` | auth, rls, rag, pii, ssrf, queue, metrics, secrets, logger… |
| `routes/` | auth, clients, campaigns, evals, webhook. |
| `services/` | call-events, campaigns, retention, usage, evals, outbound-webhook. |
| `admin-src/` | React admin SPA → built into `public/admin/`. |
| `scripts/` | Test suites, benchmarks, RLS migration tooling. |

### Two front doors

- `/admin` — superadmin, sees every company.
- `/c/<companyId>` — a tenant's own workspace, same SPA pinned to one company.

---

## Local development

```bash
npm install
cp .env_example .env        # fill in the API keys
npm run dev                 # NOT `npm start` — see below
```

`npm run dev` passes `--use-system-ca`, required on Windows where AV TLS
inspection otherwise breaks the OpenAI connection. Without it you get a
misleading `Connection error`.

Defaults to SQLite (`data.db`). To develop against Postgres:

```bash
docker run -d --name sa-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=satest \
  -p 5445:5432 pgvector/pgvector:pg16
DB_DRIVER=postgres DATABASE_URL=postgres://postgres:test@localhost:5445/satest npm run dev
```

---

## Tests

Everything below runs in CI on every push. Nothing here needs network access
except the smoke suite.

```bash
npm run test:unit      # validation, secrets, authz, PDPL — no DB needed
npm run test:smoke     # end-to-end, 34 checks, boots a real server
npm run test:pg        # migrations + RLS  (needs DATABASE_URL)
```

| Suite | Proves |
|---|---|
| `test-validation.js` | Zod request schemas reject bad payloads |
| `test-secrets.js` | Boot fails fast on a missing production secret |
| `test-authz.js` | Tenant authorization, cap escalation, SSRF, timezone, model resolution |
| `test-pii.js` | Encryption round-trip, log redaction, retention windows |
| `test-pdpl.js` | Crypto primitives |
| `test-migrations-pg.js` | Foreign keys, cascade deletes, orphan cleanup, idempotency |
| `test-rls.js` | Postgres row-level security policies isolate tenants |
| `test-rls-adoption.js` | Request-context propagation + superadmin/system bypass |
| `test-queue.js` | BullMQ durability, retries, DLQ, crash recovery (needs Redis) |

---

## Tenant isolation

Two independent layers, because either alone has failed before:

1. **Application** — `requireCompanyAccess` / `userCanAccessCompany` on every
   tenant route.
2. **Database** — PostgreSQL Row-Level Security. Each request runs inside an
   `AsyncLocalStorage` context; every query issues
   `SET LOCAL app.current_company`. A query that forgets its `WHERE company_id`
   returns **zero rows** rather than another tenant's data.

Superadmins and system paths (webhooks, workers) set `app.bypass_rls` instead.

Enable/disable:

```bash
RLS_ENABLED=1                     # app sends tenant context
node scripts/rls-migrate.js       # turn the policies on
node scripts/rls-rollback.js      # turn them off (~10s, no restart)
```

`GET /health` reports `rls.armed` and `rls.tables_enforced`.

---

## Environment variables

### Required in production
| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | LLM + embeddings |
| `VAPI_API_KEY` | Assistant sync, outbound calls |
| `ELEVENLABS_API_KEY` | TTS |
| `VAPI_WEBHOOK_SECRET` | Verifies inbound Vapi webhooks |
| `DATABASE_URL` + `DB_DRIVER=postgres` | Database |
| `COOKIE_SECURE=true` | `__Host-` session cookie |
| `NODE_ENV=production` | Enables fail-closed behaviour |

Boot **refuses to start** in production if a required secret is missing
(`lib/secrets.js`). `SKIP_SECRET_CHECK=1` bypasses, for emergencies only.

### Security / compliance
| Var | Default | Purpose |
|---|---|---|
| `METRICS_TOKEN` | — | Bearer token for `/metrics`. **Without it `/metrics` returns 503 in production.** |
| `RLS_ENABLED` | off | Send tenant context on every query |
| `DATA_ENCRYPTION_KEY` | — | 32 bytes (hex64/base64). Encrypts `calls.caller_number`, `campaign_contacts.phone`. **Do not set until backups are verified — losing this key loses the data.** |
| `LOG_REDACT_PII` | on | Mask phone numbers in logs. Set `0` only to debug. |
| `RETENTION_DAYS_CALLS` / `_CHATS` / `_AUDIT` / `_WEBHOOKS` | off | Delete records older than N days. Unset = keep forever. |
| `TRUST_PROXY` | 1 on Railway | Proxy hops in front of Node — wrong value breaks rate limiting |

### Behaviour
| Var | Default | Purpose |
|---|---|---|
| `EXTRA_VOICE_IDS` | — | Comma-separated ElevenLabs voice ids to allow beyond the built-in catalog |
| `TRANSCRIBER_JSON` | Gemini 2.5 Flash / Arabic | Full Vapi transcriber object — for A/B testing STT |
| `ENDPOINT_NOPUNCT_S` | `1.0` | Endpointing wait when no punctuation arrives. **Largest single latency knob.** |
| `ENDPOINT_PUNCT_S` / `ENDPOINT_NUMBER_S` | `0.1` / `0.4` | Other endpointing waits |
| `EMBED_MODEL` | `text-embedding-3-large` | Changing this requires `node scripts/reembed.js` |
| `REDIS_URL` | — | Enables durable BullMQ queues; without it workers use in-process timers |
| `TZ_OFFSET_HOURS` | `3` | Saudi UTC+3, used for spoken `{{date}}`/`{{time}}` |

> **Single instance only.** The company cache, rate limiter, and the fallback
> campaign timer are all in-process. Do not scale beyond one replica without
> `REDIS_URL` and moving the rate limiter to a shared store.

---

## Deploying

Railway auto-deploys from `main`. Then:

1. `curl -s https://sermad.up.railway.app/health` — check `version`, `db: ok`.
2. **Re-sync each company** from the admin (or `POST /api/companies/:id/sync-vapi`).
   Assistant-level settings — prompt, voice, endpointing — live on the persisted
   Vapi assistant, so **a deploy alone changes nothing about live calls.**
3. `node scripts/profile-calls.js` to confirm turn latency.

Boot-time Postgres migrations are idempotent and log what they did.

---

## Operations

| Task | How |
|---|---|
| Health | `GET /health` (db, webhook backlog, RLS, backup) |
| Liveness | `GET /livez` |
| Metrics | `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` |
| Call latency profile | `node scripts/profile-calls.js` |
| Retrieval benchmark | `node scripts/bench-retrieval.js` |
| Backfill missed calls | `GET /api/_admin/sync-calls` (superadmin) |
| Webhook debugging | `GET /api/_debug/recent-webhooks` (superadmin) |

---

## Known limitations

Tracked honestly rather than hidden:

- **Backups are not configured** (`/health` → `backup: off`). Highest residual risk.
- **Single instance** — see the box above.
- `/api/conversations` loads all rows then filters in JS; fine at current scale,
  needs SQL-side pagination beyond ~10 tenants.
- `whatsapp_sessions.customer_phone` and `calls.transcript` are **not** encrypted:
  both are queried by value and would need a blind index first. See `lib/pii.js`.
- No billing/metering, no SSO, two roles only (superadmin/client).
