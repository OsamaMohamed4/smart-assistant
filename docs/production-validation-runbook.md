# Production validation runbook — ElevenLabs voice platform

First real production validation of the Vapi → ElevenLabs migration. Follow in
order; every step has a check that must pass before the next one.

Legend: **✅ verified** against the live ElevenLabs API on 2026-09-18 ·
**⚠️ UNVERIFIED** — no one has ever observed this work end to end, so treat a
failure here as expected-unknown, not as a regression.

---

## 0. Blockers — clear these first

| | |
|---|---|
| 🔴 **Billing** | The ElevenLabs workspace has an unresolved payment issue. Every conversation currently fails with `[payment_issue] There's an unresolved payment issue on this workspace`. **No call will connect until this is fixed.** Confirm by placing any test call from the ElevenLabs dashboard. |
| 🔴 **Webhook secret** | `ELEVENLABS_WEBHOOK_SECRET` must exist in Railway *before* this deploys. The boot-time secret check fails closed in production. |

---

## 1. Railway environment variables

**Required — the app refuses to boot in production without these:**

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | must start with `sk-` |
| `ELEVENLABS_API_KEY` | workspace key (Convai access) |
| `ELEVENLABS_WEBHOOK_SECRET` | signing secret of the **post-call** webhook (§2a), min 8 chars |
| `DATABASE_URL` | `postgres://…` (required because prod runs Postgres) |

**Set for this validation:**

| Variable | Value | Why |
|---|---|---|
| `ELEVENLABS_INIT_WEBHOOK_SECRET` | signing secret of the **initiation** webhook (§2b) | Each webhook is a separate workspace resource with its own secret. Unset ⇒ falls back to `ELEVENLABS_WEBHOOK_SECRET`, correct **only** if you registered both with the same value. |
| `PUBLIC_BASE_URL` | `https://<your-domain>` , no trailing slash | The in-call KB tool URL is baked into the agent at publish time. Auto-derived from `RAILWAY_PUBLIC_DOMAIN` if unset — set it explicitly if you use a custom domain. |

**Optional:**

| Variable | Default | Notes |
|---|---|---|
| `ELEVENLABS_TOOL_SECRET` | falls back to webhook secret | signs the per-company KB tool token |
| `ELEVENLABS_USD_PER_CREDIT` | unset | Unset ⇒ `calls.cost_usd` stays **null** and `calls.cost_credits` holds the real figure. The provider reports no fiat amount. Do not guess a rate. |
| `DAILY_KB_TOOL_CAP` | `1000` | per-company in-call KB searches per day |
| `DAILY_OUTBOUND_CAP` | `200` | per-company outbound calls per day |
| `SIP_TRUNK_ADDRESS` | — | default 3CX host for §5 |

**Check:** after deploy, `GET /health` → `{"ok":true,"driver":"postgres","db":"ok"}`.
Boot logs must show `migration: columns added` including `calls.cost_credits`,
and `migration: tenant-safety unique indexes added`.

> 🔴 If you see `migration: DUPLICATE phone ownership blocks tenant isolation`,
> two companies share a DID. The service stays up but the unique index is *not*
> installed. Fix the data before going live.

---

## 2. ElevenLabs webhook registration

### 2a. Post-call webhook
Dashboard → **Agents → Settings → Webhooks**.

- URL: `https://<your-domain>/webhook/elevenlabs`
- Events: `post_call_transcription` **and** `call_initiation_failure`
- **Send audio data: OFF.** ✅ Workspace currently reports `send_audio: false` — leave it. Our request body limit is 2 MB (`server.js:152`) and `post_call_audio` payloads exceed it.
- Copy the signing secret → `ELEVENLABS_WEBHOOK_SECRET`

### 2b. Conversation-initiation webhook
Same settings page, **Conversation initiation client data webhook**.

- URL: `https://<your-domain>/webhook/elevenlabs/init`
- Copy **its own** signing secret → `ELEVENLABS_INIT_WEBHOOK_SECRET`

✅ Both verified to be absent today: `GET /v1/convai/settings` returns
`conversation_initiation_client_data_webhook: null` and
`webhooks.post_call_webhook_id: null`. Neither exists yet — you are creating both.

---

## 3. Which secret belongs to which webhook

| Endpoint | Mechanism | Verifies against | If wrong |
|---|---|---|---|
| `POST /webhook/elevenlabs` | **HMAC** `elevenlabs-signature` | `ELEVENLABS_WEBHOOK_SECRET` | 401, call rows never written |
| `POST /webhook/elevenlabs/init` | **header** `x-elevenlabs-init-token` | `ELEVENLABS_INIT_WEBHOOK_SECRET`, else falls back to `ELEVENLABS_WEBHOOK_SECRET` | 401, **calls still connect but are depersonalised** |
| `POST /webhook/elevenlabs/tools/kb` | **header** `X-Company-Token` (minted per company) | `ELEVENLABS_TOOL_SECRET`, else the webhook secret | 401, agent loses KB access mid-call |

✅ **The initiation webhook is NOT HMAC-signed** — verified against the live API
on 2026-09-19. Its config (`PATCH /v1/convai/settings` →
`conversation_initiation_client_data_webhook`) accepts exactly `{url,
request_headers}`; a `secret` or `auth_method` field returns 200 and is silently
dropped. A constant header is the only authentication it can carry, so register
the webhook with `x-elevenlabs-init-token` set to the secret above. A genuine
HMAC signature is still accepted if the provider ever adds signing.

HMAC format (post-call): `elevenlabs-signature: t=<unix>,v0=<hex>` over
`` `${t}.${rawBody}` ``, 30-minute replay window.

⚠️ **The init 401 is silent from the caller's side.** The call connects and
sounds normal; the agent simply never receives `company_id`, `company_name` or
`caller_number`. §9 is the only way to catch it.

---

## 4. Re-publish every company (**mandatory**)

✅ `platform_settings.overrides.enable_conversation_initiation_client_data_from_webhook`
defaults to **`false`**, and every agent published before this release has it
`false`. **The initiation webhook will not fire for them at all** until re-synced.

Per company, either:
- Admin UI → **Scenarios → نشر**, or
- `POST /api/companies/:id/sync-voice` (add `?force=1` only if the agent was
  deleted from the ElevenLabs dashboard and updates keep failing)

**Check** — for each company, in the ElevenLabs dashboard open the agent →
**Security** tab → *Fetch initiation client data from a webhook* must be **on**.

Also confirm the publish log does **not** contain
`voice publish: KB tool skipped — PUBLIC_BASE_URL is not set`.

---

## 5. 3CX provisioning (per company)

```bash
node scripts/elevenlabs-provision.js --list

node scripts/elevenlabs-provision.js \
  --company <company-id> \
  --address <pbx-host-or-ip> \
  --username <sip-user> \
  --password '<sip-pass>' \
  [--transport tls] [--encryption allowed] [--allow 1.2.3.4,5.6.7.8]
```

| Value | Requirement |
|---|---|
| `--company` | existing company id; must already have an agent (publish first) |
| `--address` | bare hostname or IP of the 3CX PBX — **no `sip:` prefix**, rejected if present |
| `--username` / `--password` | digest auth. Preferred over IP allowlisting: a PBX on a dynamic address silently stops working the day its IP changes |
| `--transport` | ✅ one of `auto` `udp` `tcp` `tls` — default `tls` |
| `--encryption` | ✅ one of `disabled` `allowed` `required` — default `allowed` |
| `--allow` | optional comma-separated IP allowlist |

Credentials are never printed. The number imported is the company's **existing
3CX DID** — nothing is ever purchased from ElevenLabs.

✅ **Safe to re-run.** A duplicate import returns HTTP 409
`resource_already_exists`; the script now updates the existing record instead of
aborting, so re-running to rotate SIP credentials is a normal operation. Output
says `updated existing →` rather than `imported →`.

🔴 If it reports the number belongs to a **different ElevenLabs workspace**: a
number can only be registered once platform-wide. Release it there first.

### 3CX side
1. SIP trunk to `sip.rtc.elevenlabs.io:5061` (TLS; use `:5060` for TCP/UDP)
2. Inbound rule: DID → that trunk
3. INVITE must address the number — `sip:+9665XXXXXXXX@sip.rtc.elevenlabs.io`.
   A bare `sip:@host` with no user part is rejected
4. Codecs **G711 a-law/µ-law or G722 only** — remove G729 and Opus
5. Open RTP `10000–60000/udp` both directions
6. BYE must target the `Contact` header from the INVITE response, **not** the
   shared host — otherwise 481 and calls never hang up

⚠️ **UNVERIFIED end to end.** The payload schema is confirmed against the live
API, but no trunk has ever been created and no SIP call has ever traversed it.

---

## 6. Inbound test

1. From an ordinary mobile, dial the company's 3CX DID.
2. The agent should answer **in Saudi Arabic** and greet using the company's
   configured first message.
3. Ask a question that can only be answered from that company's uploaded
   knowledge base (see §11).
4. Hang up from the mobile.

**Pass:** call connects, greeting is the right company's, audio is two-way, the
line clears cleanly on hangup (no lingering channel — that symptom is the 3CX
BYE/481 problem in §5.6).

⚠️ **UNVERIFIED** — no inbound SIP call has ever completed on this stack.

---

## 7. Outbound test

Admin UI (Companies → outbound call), or:

```bash
curl -X POST https://<domain>/api/companies/<company-id>/outbound-call \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <authenticated session>' \
  -d '{"phoneNumber":"+9665XXXXXXXX"}'
```

Preconditions enforced by the API — each returns a distinct error:
- `NOT_PUBLISHED` (409) — company has no agent; do §4
- `NO_PHONE_NUMBER_ID` (503) — number not imported; do §5
- 429 — daily outbound cap reached

The call dials **from that company's own DID**. There is deliberately no
platform-wide fallback number.

**Pass:** the handset rings, shows the company's DID as caller ID, and the agent
speaks first.

⚠️ **UNVERIFIED** — `POST /v1/convai/sip-trunk/outbound-call` has had its
required fields confirmed (`agent_id`, `agent_phone_number_id`, `to_number`) but
has never been executed.

---

## 8. What to inspect after each call

**Railway logs** — expected lines, in order:

| Line | Meaning |
|---|---|
| `init webhook handled` `{companyId, agentId, calledNumber}` | personalization succeeded (inbound) |
| `kb tool handled` `{companyId, chars}` | agent searched the knowledge base |
| *(no)* `elevenlabs webhook: signature verification failed` | post-call delivery authenticated |

**Endpoints:**

```
GET /health                          → webhook_pending should return to 0
GET /api/companies/<id>/calls        → the call row
GET /api/calls/<call-id>             → transcript, summary, structured_data
GET /api/calls/<call-id>/recording   → audio (authenticated proxy)
```

On the call row check: `direction` correct, `caller_number` present,
`duration_sec` > 0, `transcript` non-empty, `ended_reason` sensible,
`has_recording = 1`, `cost_credits` populated, and `cost_usd` **null** unless
`ELEVENLABS_USD_PER_CREDIT` is set (that null is correct, not a bug).

> `GET /health` → `webhook_pending > 50` sets `degraded: "webhook backlog"`.
> Persistently non-zero means post-call events are failing to process.

---

## 9. Verify HMAC signatures are actually being verified

Superadmin only:

```
GET /api/_debug/recent-webhooks
```

Returns the last 10 attempts with headers masked, plus a fingerprint of both
configured secrets:

- `attempts[].verified` — **must be `true`**. `false` = signature rejected.
- `attempts[].path` — distinguishes `/elevenlabs` from `/elevenlabs/init`.
- `serverEnv` — fingerprint of the post-call secret.
- `initWebhookEnv` — fingerprint of the secret the **init** endpoint verifies
  against. `falls_back: true` means `ELEVENLABS_INIT_WEBHOOK_SECRET` is unset and
  the post-call secret is being used.

**Required result:** at least one attempt with `path: "/elevenlabs"` **and** one
with `path: "/elevenlabs/init"`, both `verified: true`.

If `verified: false`: compare `first8`/`last4`/`trimmed_length` against the
secret in the ElevenLabs dashboard. `has_whitespace: true` means the Railway
variable has a stray space or newline — the commonest cause.

⚠️ **This is the single most important check in this runbook.** Whether the
initiation webhook is signed at all in practice is the one assumption that could
not be verified without a live inbound call.

---

## 10. Verify tenant / company resolution

The company is resolved **server-side only**, from the ElevenLabs `agent_id` or
the dialled DID. `caller_id` is never used to choose a tenant, and a
`company_id` in the call payload is never trusted.

**Checks:**
1. The call row's `company_id` is the company that owns the DID you dialled.
2. Log shows `init webhook handled` with the **expected** `companyId`.
3. With two companies configured, run §6 against each DID and confirm each call
   lands under its own company in `GET /api/companies/<id>/calls` — and that
   neither appears under the other.

**Red flags in the logs:**

| Line | Meaning |
|---|---|
| `voice: ambiguous company ownership — refusing to attribute the call` | two companies claim one DID/agent. The call is left **unattributed** on purpose. Fix the data. |
| `init webhook: no company matched` `{agentId, calledNumber}` | DID or agent not mapped to any company. The call proceeds unpersonalised. |
| `voice: ignoring unverified company_id from call payload` | a payload claimed a tenant we could not confirm. Expected to be rare — investigate. |

---

## 11. Verify RAG / KB during a real call

1. Confirm the company has documents: Admin UI → that company → Knowledge base.
2. During §6, ask something answerable **only** from those documents (a specific
   price, project name or spec — not something the system prompt already knows).
3. Confirm the agent answers with the document's content.

**Check in logs:** `kb tool handled` `{companyId, chars}` — `companyId` must be
the calling company, and `chars` > 0.

**Failure modes:**

| Line | Cause |
|---|---|
| `kb tool: missing or invalid company token` | tool secret changed since publish — re-publish (§4) |
| `kb tool: agent/company mismatch — refusing` | agent belongs to a different company than the token |
| `kb tool: daily cap reached — refusing the search` | `DAILY_KB_TOOL_CAP` hit. The agent hears a normal "unavailable" sentence and carries on — no error surfaces to the caller |
| no `kb tool` line at all | tool not attached: check `PUBLIC_BASE_URL` was set at publish time, then re-publish |

Production runs Postgres with `FORCE ROW LEVEL SECURITY` on `kb_chunks`, so the
database itself refuses another tenant's rows even if a query forgot its filter.

---

## 12. Verify `call.completed` and customer webhook payloads

Opt-in per company via `settings.webhookUrl`, optionally `settings.webhookSecret`
(HMAC-SHA256 of the raw body in the `X-Signature` header). Fire-and-forget with
one retry; a broken customer endpoint never affects call processing.

Point `webhookUrl` at a request-capture endpoint and confirm the body:

```json
{
  "event": "call.completed",
  "company_id": "<id>",
  "sent_at": "<iso8601>",
  "call": {
    "id": "...", "direction": "inbound|outbound",
    "caller_number": "...", "duration_sec": 0,
    "started_at": "...", "ended_at": "...", "ended_reason": "...",
    "summary": "...", "transcript": "...",
    "recording_url": null,
    "has_recording": true
  }
}
```

> ⚠️ **Contract change to announce to existing integrators.**
> `recording_url` is now **`null`** for ElevenLabs calls, and a new
> `has_recording` boolean has been added. The provider serves audio only from an
> authenticated endpoint, so there is no link a receiver's server could fetch;
> the previous behaviour would have shipped an internal identifier dressed as a
> URL. Receivers that displayed `recording_url` must switch to `has_recording`
> and request audio through an authenticated channel.

CSV export (`GET /api/companies/<id>/calls.csv`) is unaffected: it emits a real
operator-openable proxy link, because the operator is authenticated.

---

## 13. Still unverified — expect surprises here

Ordered by how badly it hurts if the assumption is wrong.

| # | Unverified | Symptom | First check |
|---|---|---|---|
| 1 | **A real init delivery has never been observed.** ✅ The auth *mechanism* is now settled (header, not HMAC — see §3), but no genuine request from ElevenLabs has yet reached the endpoint. | Inbound calls connect and sound fine but are **depersonalised** — no company context | §9: an attempt with `path: "/elevenlabs/init"` and `verified: true` |
| 2 | **SIP trunk end to end.** Payload schema ✅ verified against the live validator; no trunk has ever been created and no SIP call has traversed one. | Inbound never reaches the agent; or calls don't hang up (481) | 3CX trunk status; §5 steps 3–6 |
| 3 | **Outbound call execution.** Required fields ✅ confirmed; endpoint never called. | Outbound fails at dial time | §7 error code |
| 4 | **A populated `cost`.** Both conversations on the account failed at 0s, so `cost` was null. Field *name* ✅ confirmed, and `cost_fiat` ✅ confirmed not to exist. | `cost_credits` null on a real completed call | §8 call row |
| 5 | **`post_call_audio` vs the 2 MB body cap.** Not triggered today because `send_audio: false`. | 413s on post-call delivery | keep audio OFF (§2a) |

**Verified and not a risk:** the `data_collection` schema (our exact payload was
accepted, HTTP 200), the SIP field names and enums, the agent override flags,
duplicate-import 409 handling, and the absence of `cost_fiat`.

---

## Rollback

No destructive migrations were applied — `calls.cost_credits` and
`calls.has_recording` are additive and nullable/defaulted, and no column was
dropped or retyped. Rolling the deploy back to the previous image leaves all
call data intact. The ElevenLabs-side webhooks and imported numbers persist
independently and can be deleted from the dashboard.
