# Company Publishing Pipeline — analysis & design

Design only. No code changed. Target: one company (`co-xjdidl`), local tunnel,
existing ElevenLabs workspace.

---

## 1. Current publishing flow

`POST /api/companies/:id/sync-voice` — [server.js:1341](../server.js#L1341)

```
loadCompany(id)
  → ?force=1 clears elevenlabs_agent_id (recovery when deleted in dashboard)
  → getActiveScenarioForCompany  → 409 NO_ACTIVE_SCENARIO if absent/empty
  → composeSystemPrompt(company, scenario.instructionPrompt)
        fillGlobals({{agent_name}},{{date}},{{time}})
      + KB chunks baked inline, capped at KB_INJECT_CAP, priority-sorted
      + END_CALL_TOOL_RULE
  → voice settings: settings.voiceId ?? DEFAULT_VOICE_ID, clamped
        stability .8, similarity .8, speed VOICE_SPEED_DEFAULT
  → resolveAgentModel(company) → { model, temperature, maxTokens }
  → transferNumber = settings.transferPhoneNumber if /^\+[0-9]{8,15}$/
  → wantsKbTool = countCompanyChunks > 0
  → voice.syncAgent(...) → { agentId, agentIdInbound, toolId }
  → setCompanySynced / setCompanyInboundAssistant / setCompanyKbTool
  → invalidateCache, audit('voice.publish')
```

**Properties that matter for this work:**

| | |
|---|---|
| Error model | ONE `try/catch` around the whole provider call. Any failure → HTTP 500, nothing recorded about *which* step failed |
| State | `last_synced_at` is the only marker. There is no `published` / `failed` state |
| Partial success | Not represented. If the KB tool is created and the agent PATCH then fails, the tool id is never persisted → next publish creates a **duplicate tool** |
| Phone | **Not part of publish at all.** Separate route + separate script |
| Idempotency | Good at the agent/tool level (`upsertAgent` verify→recover-by-name→PATCH/POST), absent at the pipeline level |

## 2. Current ElevenLabs provisioning flow

Two separate entry points, neither wired into publish:

- `POST /api/companies/:id/import-phone` — [server.js:1464](../server.js#L1464) → `voice.importPhoneNumber` → `claimPhoneOwnership` (transactional, releases prior owner, audits `releasedFrom`)
- `scripts/elevenlabs-provision.js` — CLI equivalent + 3CX instructions

`importPhoneNumber` is already idempotent: list → PATCH existing → POST → on 409 re-list → PATCH, else `PHONE_NUMBER_TAKEN`.

## 3. Current company model

```
companies: id, name, language, voice_id, phone_number, system_prompt(legacy),
           kb_text(legacy), user_id, last_synced_at, settings(JSON TEXT),
           voice_provider, elevenlabs_agent_id, elevenlabs_agent_id_inbound,
           elevenlabs_phone_number_id, elevenlabs_kb_tool_id, elevenlabs_synced_at
```

`settings` JSON, validated by `settingsBody` — **voice/cost tuning only**:
`voiceId, model, temperature, maxTokens, stability, similarityBoost, voiceSpeed,
dailyMessageCap, dailyOutboundCap, transferPhoneNumber, webhookUrl, webhookSecret`.

**There is no business profile.** Working hours, services, business rules and
communication style exist only as free prose inside `scenarios.instruction_prompt`.

`co-xjdidl.settings` is currently `NULL`.

## 4. Current feature configuration

**None.** Two capabilities are attached implicitly, inferred from data:

| Capability | Trigger | Result |
|---|---|---|
| Human transfer | `settings.transferPhoneNumber` is valid E.164 | `transfer_to_number` system tool |
| KB search | `countCompanyChunks > 0` **and** `PUBLIC_BASE_URL` set | `search_knowledge_base` webhook tool |

No registry, no per-company toggles, no UI. `elevenlabs_kb_tool_id` is a **single
column** — the schema can hold exactly one webhook tool per company.

## 5. Current KB / RAG flow

```
upload → ingestDocument: extractText → chunkText → embedBatch(OpenAI)
       → insertChunk(company_id, document_id, chunk_index, text, embedding)
```

Two consumers:
1. **Static bake** — `composeSystemPrompt` inlines chunks up to `KB_INJECT_CAP`
2. **Live tool** — `retrieve()`: semantic + Arabic-aware keyword leg, fused by RRF, optional `llmRerank`

`kb_chunks` is a `FORCE ROW LEVEL SECURITY` table. The KB tool route narrows
`req.dbContext` from system-bypass to the one company before retrieving, so
Postgres itself refuses another tenant's rows.

> **We deliberately do NOT use ElevenLabs' native Knowledge Base / RAG** (which
> the tutorial uses). Ours is tenant-scoped under RLS and Arabic-tuned. Moving to
> theirs would put customer documents in a store with no per-tenant policy.
> This design keeps ours.

## 6. Current tool architecture

One webhook tool + up to two system tools.

```
buildKbToolConfig({companyId, publicBaseUrl}) → {
  type: 'webhook', name: 'search_knowledge_base',
  response_timeout_secs: 10,
  api_schema: {
    url: `${base}/webhook/elevenlabs/tools/kb`,
    method: 'POST',
    request_headers: { 'X-Company-Token': mintCompanyToken(companyId) },
    request_body_schema: {
      query:           { model-authored, the ONLY one },
      agent_id:        { constant_value: '{{system__agent_id}}' },
      conversation_id: { constant_value: '{{system__conversation_id}}' },
    }
  }
}
```

**Auth chain, already proven and worth reusing verbatim:**

1. `X-Company-Token` = `${companyId}.${base64url(HMAC-SHA256(companyId, TOOL_SECRET))}`, compared with `timingSafeEqual`
2. `agent_id` is filled by the *provider*, not the model → cross-checked with `uniqueCompanyId`, which refuses ambiguous ownership
3. `req.dbContext` narrowed to that company → RLS backstop
4. Per-tenant daily cap via `kbSearchAllowed`

Lifecycle: `POST /v1/convai/tools` → id stored → `PATCH /v1/convai/tools/{id}`,
404 → recreate. Referenced from the agent by `tool_ids`.

## 7. Current webhook architecture

| Endpoint | Auth | Notes |
|---|---|---|
| `/webhook/elevenlabs` | HMAC `elevenlabs-signature` | inbox `UNIQUE(provider,event_id)`, key is `"<type>:<conversation_id>"` |
| `/webhook/elevenlabs/init` | header `x-elevenlabs-init-token` | provider does **not** sign this one (verified 2026-09-19) |
| `/webhook/elevenlabs/tools/kb` | `X-Company-Token` | synchronous, answers the model directly |

Company resolution order, everywhere: `agent_id` → dialled `phone_number` → refuse.
A `company_id` in the payload is **logged and ignored**.

## 8. Current phone / SIP provisioning

One ElevenLabs phone-number resource per company carrying both directions
(`inbound_trunk_config` + `outbound_trunk_config`). Ownership enforced by partial
unique indexes on `companies.phone_number` and `elevenlabs_phone_number_id`.
Verified live for `co-xjdidl`: `phnum_7401…`, udp, `allowed_addresses:[165.232.38.127]`.

## 9. What from the tutorial we already have

| Tutorial idea | Status here |
|---|---|
| Structured production prompt (role/rules/steps/skills) | Operator-authored in the scenario; we do not generate it |
| First message, not interruptible | `first_message` + `first_message_inbound` per scenario |
| Language configuration | `conversation_config.agent.language` (bare ISO) |
| Knowledge base / RAG | **Ours**, better isolated than theirs |
| Tools / function calling | Mechanism present; exactly one tool today |
| Data collection | `DATA_COLLECTION` — 9 Arabic fields, live-verified accepted |
| Post-call processing | Full inbox → normalize → upsert → lead scoring → customer webhook |
| Conversation-initiation client data | Implemented incl. the `enable_…_from_webhook` flag |
| Security settings / overrides | `platform_settings.overrides` pre-enabled |
| Phone integration | SIP trunk, done properly (no number purchased) |
| Testing | `eval_questions` / `eval_runs` + draft tester + `elevenlabs-selftest.js` |

**Not adopted, deliberately:** ElevenLabs native KB (isolation), expressive/v3
voices + audio tags (our voice is pinned and quality-tuned — a separate decision),
Make.com (our backend is the source of truth).

## 10. What is missing

1. Feature registry — no concept of a capability
2. Per-company feature toggles + per-feature config
3. Business profile fields (description, hours, services, rules, style, languages)
4. Multi-tool storage — schema holds ONE tool id
5. Business action tables (appointments, tickets, requests, customers, messages)
6. Integration credential storage (encrypted, per company)
7. Publish pipeline: step tracking, partial-failure reporting, published state
8. Post-publish validation
9. Per-feature cost caps & audit for business actions

---

## 11. Implementation plan

### 11.1 Feature registry — configuration-driven

`services/features/registry.js`. Each feature is a **declaration**, not a branch:

```js
{
  key: 'appointment_booking',
  labelAr: 'حجز المواعيد',
  kind: 'webhook',                 // 'webhook' | 'system' | 'internal'
  toolName: 'book_appointment',
  descriptionAr: '…متى يستدعيها النموذج…',
  requires: [],                    // e.g. ['integration:calendar']
  configSchema: zod,               // per-company config, validated
  bodySchema: zod,                 // what the MODEL may send — validated server-side
  handler: async ({ companyId, args, ctx }) => ({ ok, result }),
  dailyCapKey: 'dailyAppointmentCap',
}
```

Publish iterates enabled features → builds one webhook tool per feature →
`tool_ids` on the agent. Adding a feature = adding a registry entry + handler.

### 11.2 Proposed feature set (client list → capabilities)

The client's 10 items collapse to 9 capabilities; two pairs genuinely overlap:

| # | Client item | Feature key | Notes |
|---|---|---|---|
| 1 | *(existing)* | `knowledge_base` | today implicit → becomes explicit |
| 2 | تحويل المكالمات | `call_transfer` | already a system tool; becomes a toggle |
| 3 | حجز المواعيد | `appointment_booking` | new table |
| 4 | استقبال الطلبات | `service_request` | `tickets.kind='request'` |
| 5 | فتح البلاغات | `ticket_create` | `tickets.kind='ticket'` |
| 6 | تحديث بيانات العملاء | `customer_update` | new table |
| 7 | إرسال الرسائل | `send_message` | **highest risk** — cost + abuse |
| 8 | الربط مع أنظمة الشركة + تبادل البيانات | `system_lookup` | read via configured integration |
| 9 | تنفيذ الإجراءات المحددة + التدفقات التشغيلية | `workflow_action` | named, per-company configured actions |

### 11.3 Tool endpoint — one route, feature-dispatched

```
POST /webhook/elevenlabs/tools/:feature
```

Reuses the KB auth chain **unchanged**, then adds two server-side gates:

```
verifyCompanyToken(X-Company-Token)     → companyId        (never from body)
uniqueCompanyId(agent_id)               → must equal companyId, else 403
featureEnabled(companyId, :feature)     → else 403         ← re-checked EVERY call
req.dbContext = {bypass:false, companyId}                  ← RLS backstop
checkAndBumpUsage(companyId, `action_${feature}`, cap)     → else soft-refuse
bodySchema.parse(req.body)              → reject model-authored garbage
handler({companyId, args, ctx})
audit(req, `action.${feature}`, …)
```

> Re-checking `featureEnabled` at **invocation** time is what makes "when disabled,
> the agent must not be able to invoke it" actually true. Republishing removes the
> tool from the agent, but a stale agent version could still call — the backend
> refuses regardless.

### 11.4 Publish pipeline

`services/publish/pipeline.js` — ordered steps, each `{key, required, run}`:

```
 1 validate.company        required   name, language, voice resolvable
 2 validate.scenario       required   active scenario + non-empty prompt
 3 validate.features       required   enabled features have valid config
 4 validate.integrations   optional   reachability/SSRF check on configured URLs
 5 kb.index                optional   report chunk count (never auto-embeds — costs money)
 6 agent.upsert            required   buildAgentConfig + upsertAgentTolerant
 7 tools.sync              required   per enabled feature: create/patch, prune removed
 8 agent.attachTools       required   tool_ids ← synced tool ids
 9 webhooks.verify         required   init flag true; workspace webhooks registered
10 phone.attach            optional   bind number → agent if one is imported
11 verify.readback         required   GET agent; assert flags/tools/language
```

Each step returns `{key, status:'ok'|'skipped'|'failed', detail, ms}`. The whole
run is persisted. **Company is marked `published` only if every `required` step
returned ok.** Failure preserves prior successful configuration — no rollback of
already-correct resources, because every step is an upsert.

### 11.5 Idempotency & retry

| Resource | Stable key | Re-run behaviour |
|---|---|---|
| Agent | name `smart-assistant:<companyId>` | verify id → recover by name → PATCH |
| Feature tool | `company_tools(company_id, feature_key)` | PATCH stored id; 404 → recreate |
| Removed feature | row absent from enabled set | **prune**: delete tool, drop from `tool_ids` |
| Phone | E.164 number | list → PATCH; 409 → re-list → PATCH |
| Publish run | new row each attempt | history preserved for diagnosis |

The current duplicate-tool bug is fixed by persisting tool ids **per step**, inside
the step, rather than only after the whole provider call succeeds.

---

## 12. Database changes

All additive. No drops, no retypes.

```sql
-- per-company capability toggles + config
CREATE TABLE company_features (
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  config      TEXT,                      -- JSON, validated by registry schema
  updated_at  TEXT,
  PRIMARY KEY (company_id, feature_key)
);

-- ElevenLabs tool id per feature. Replaces the single elevenlabs_kb_tool_id
-- column as the source of truth; the column is backfilled and left in place.
CREATE TABLE company_tools (
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_key         TEXT NOT NULL,
  elevenlabs_tool_id  TEXT NOT NULL,
  config_hash         TEXT,              -- skip PATCH when unchanged
  synced_at           TEXT,
  PRIMARY KEY (company_id, feature_key)
);

-- publish history / step results
CREATE TABLE company_publish_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  TEXT NOT NULL,
  status      TEXT NOT NULL,             -- running | published | failed
  steps       TEXT,                      -- JSON array of step results
  error       TEXT,
  started_at  TEXT, finished_at TEXT
);

-- business actions
CREATE TABLE appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL, call_id TEXT, conversation_id TEXT,
  customer_name TEXT, customer_phone TEXT,
  service TEXT, starts_at TEXT, duration_min INTEGER,
  status TEXT NOT NULL DEFAULT 'requested',
  notes TEXT, external_ref TEXT, created_at TEXT
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL, call_id TEXT, conversation_id TEXT,
  kind TEXT NOT NULL,                    -- ticket | request | report
  customer_name TEXT, customer_phone TEXT,
  category TEXT, priority TEXT, subject TEXT, body TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  external_ref TEXT, created_at TEXT
);

CREATE TABLE customer_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL, phone TEXT NOT NULL,
  name TEXT, email TEXT, attributes TEXT, updated_at TEXT
);
CREATE UNIQUE INDEX uq_customer_company_phone
  ON customer_profiles(company_id, phone);

CREATE TABLE outbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL, call_id TEXT,
  channel TEXT NOT NULL, to_address TEXT NOT NULL,
  body TEXT, status TEXT NOT NULL DEFAULT 'queued',
  provider_ref TEXT, error TEXT, created_at TEXT
);

CREATE TABLE integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- crm | calendar | webhook | workflow
  name TEXT NOT NULL,
  config TEXT,                           -- JSON; secrets ENCRYPTED via lib/secrets
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT, updated_at TEXT
);

-- business profile (JSON) on companies
ALTER TABLE companies ADD COLUMN business_profile TEXT;
ALTER TABLE companies ADD COLUMN publish_status   TEXT;   -- null|published|failed
ALTER TABLE companies ADD COLUMN published_at     TEXT;
```

**RLS:** every new tenant table must be added to `TENANT_TABLES` in
[lib/rls.js](../lib/rls.js) — `company_features, company_tools, appointments,
tickets, customer_profiles, outbound_messages, integrations`. Missing one means
Postgres does **not** isolate it. `company_publish_runs` is operational, treated
like `webhook_events` (platform table, bypass-only).

**Both drivers:** every statement added to `db-sqlite.js` *and* `db-postgres.js` —
the parity test (`both DB drivers expose the SAME statement catalog`) enforces it.

---

## 13. API / tool contracts

Model-authored fields are marked ⚠. Everything else is `constant_value` filled by
the provider, or derived server-side.

```
book_appointment       ⚠ customer_name, ⚠ service, ⚠ preferred_datetime, ⚠ notes
                       → { ok, appointment_id, confirmed_at, message_ar }
create_ticket          ⚠ kind, ⚠ subject, ⚠ body, ⚠ category, ⚠ priority
                       → { ok, ticket_id, message_ar }
submit_request         ⚠ subject, ⚠ body            → { ok, request_id, message_ar }
update_customer        ⚠ field, ⚠ value             → { ok, updated, message_ar }
send_message           ⚠ template_key, ⚠ variables  → { ok, queued, message_ar }
lookup_data            ⚠ query_key, ⚠ identifier    → { ok, data, message_ar }
run_workflow           ⚠ action_key, ⚠ params       → { ok, result, message_ar }
search_knowledge_base  ⚠ query                      → { result }        (unchanged)
```

Every tool additionally receives, as constants:
`agent_id: {{system__agent_id}}`, `conversation_id: {{system__conversation_id}}`.

**Hard rules**
- The customer's phone comes from the **call**, never from the model. The model may not name a different customer.
- `send_message` sends only **pre-approved templates** with variable substitution. Free-text sending from the model is not offered.
- `run_workflow` / `lookup_data` only reach URLs stored in `integrations`, re-validated with `assertSafeUrl` at call time (DNS-rebinding safe, already used by the outgoing webhook).
- Every tool returns `message_ar` — a short factual sentence the agent can speak. Handlers return **facts**, never behavioural instructions.

---

## 14. Exact sequence when "Publish Company" is clicked

```
POST /api/companies/:id/publish        (sync-voice kept as an alias)
 │
 ├─ 01 validate.company       name/language/voice resolvable
 ├─ 02 validate.scenario      active scenario, non-empty instruction_prompt
 ├─ 03 validate.features      every enabled feature's config parses
 ├─ 04 validate.integrations  each enabled integration URL passes assertSafeUrl
 ├─ 05 kb.index               count chunks; report (no silent embedding spend)
 ├─ 06 agent.upsert           buildAgentConfig(+business facts block, §15)
 │                            → upsertAgentTolerant → persist agentId NOW
 ├─ 07 tools.sync             for each enabled webhook feature:
 │                              upsert tool → persist company_tools row NOW
 │                            prune tools for features no longer enabled
 ├─ 08 agent.attachTools      PATCH agent tool_ids = synced ids
 ├─ 09 webhooks.verify        GET /v1/convai/settings: post_call_webhook_id set,
 │                            init webhook url + header present
 ├─ 10 phone.attach           if elevenlabs_phone_number_id → bind to agent
 ├─ 11 verify.readback        GET agent → assert:
 │                              enable_…_from_webhook === true
 │                              tool_ids ⊇ enabled webhook features
 │                              language starts with company language
 │                              data_collection non-empty
 │
 └─ all required ok → publish_status='published', published_at=now
    any required failed → publish_status='failed', steps[] returned to UI
```

Response shape (drives the UI):

```json
{ "status":"failed",
  "steps":[{"key":"agent.upsert","status":"ok","ms":812},
           {"key":"tools.sync","status":"failed",
            "detail":"[422] api_schema.url: invalid"}],
  "agentId":"agent_…", "published":false }
```

## 15. Failure / retry / idempotency strategy

- **Persist inside the step, not after the run.** The current duplicate-tool risk exists precisely because ids are stored only after everything succeeds.
- **Retry = re-run the whole pipeline.** Steps that are already correct no-op (`config_hash` match → skip PATCH).
- **No rollback.** Rolling back a correct agent because a later step failed would take a working line down. Prior state is preserved; the failed step is named.
- **Pruning is explicit**, and only for features that are disabled — never "tools I don't recognise", so a tool added by hand in the dashboard is not silently deleted.
- **Concurrency:** one in-flight run per company (advisory lock / `status='running'` guard) so two admins clicking Publish cannot interleave tool writes.

---

## Open decisions — need your call before coding

**D1 — Generated prompt vs. operator wording.** Your standing rule is *never add
default/cushion text to the user's prompts*. Rendering business profile fields
into the system prompt technically adds text. Proposal: append only a **structured
facts block** (hours, services, rules) in the same delimited way the KB block is
already appended — data, never behavioural wording — and show a live preview.
Tool-usage behaviour continues to come from capability attachment, not prose.
*Confirm, or keep the prompt 100% operator-authored.*

**D2 — Admin UI source.** You said the UI should follow the screenshots, but the
screenshots provided are a **MASAR AI marketing site** (hero, sectors, security,
dashboard mock, case studies). Only the first image lists the feature set
(ينفذ / يتكامل). There is no admin-dashboard screenshot. Proposal: build the
toggles in the existing admin style (Scenarios-page conventions). *Send the
dashboard screenshots if they exist.*

**D3 — Feature collapsing.** 10 client items → 9 capabilities; `تنفيذ الإجراءات
المحددة` + `التدفقات التشغيلية` merge into `workflow_action`, and `الربط مع
أنظمة الشركة` + `تبادل البيانات` merge into `system_lookup` + the `integrations`
registry. *Confirm the merge, or keep them separate as distinct tool names.*

**D4 — `send_message` scope.** Templates-only is proposed (cost + abuse control).
Free-text sending from the model is not offered. *Confirm.*

**D5 — Phasing.** This is large. Suggested order, each independently testable on
`co-xjdidl`:

| Phase | Content |
|---|---|
| A | Pipeline + step reporting + `publish_status`, **no new features** — fixes the duplicate-tool bug and gives a real deployment UX |
| B | Feature registry + `company_features` + `company_tools` + multi-tool publish, with `knowledge_base` and `call_transfer` migrated into it (zero new business logic) |
| C | `appointment_booking` + `ticket_create` + `service_request` — self-contained, no external systems |
| D | `customer_update`, `send_message` |
| E | `integrations`, `system_lookup`, `workflow_action` |

Phase A alone is worth shipping: it fixes a real defect and needs no new tables
beyond `company_publish_runs`.
