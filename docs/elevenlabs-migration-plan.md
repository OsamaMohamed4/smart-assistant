# Vapi → ElevenLabs Agents migration

Status: **implemented — Vapi fully removed from the codebase**
Date: 2026-09-15
Scope: replace Vapi as the voice-AI provider with ElevenLabs Agents, keep the existing
3CX numbers, keep inbound + outbound, keep every piece of business logic.

> This document was written as the pre-implementation plan and is retained as the
> migration record. §12 at the end states what was actually built, what differs from the
> plan, and what still needs a human before the first real call.

---

## 0. Verified ElevenLabs facts this plan is built on

Everything below was checked against the live ElevenLabs docs before writing (links at the
end). Nothing here is assumed.

| Capability | Endpoint / mechanism | Notes |
|---|---|---|
| Auth | `xi-api-key: <key>` header on `https://api.elevenlabs.io` | Single workspace key. Never goes to the browser. |
| Create agent | `POST /v1/convai/agents/create` | `{ name, conversation_config{agent{prompt{prompt,llm,temperature,max_tokens,tool_ids},first_message,language},tts{model_id,voice_id,stability,similarity_boost,speed},asr{...},turn{...},conversation{max_duration_seconds,...}}, platform_settings{...}, tags }` |
| Update agent | `PATCH /v1/convai/agents/{agent_id}` | Same body shape. |
| Get / list agents | `GET /v1/convai/agents/{id}`, `GET /v1/convai/agents` | Used for "stored id still exists?" recovery. |
| Webhook (server) tool | `POST /v1/convai/tools` → `{ id }` | `tool_config{type:'webhook',name,description,response_timeout_secs,api_schema{url,method,request_body_schema,request_headers}}`. Referenced from the agent via `prompt.tool_ids`. |
| System tools | inline in `prompt.tools` | `{type:'system',name:'end_call',params:{system_tool_type:'end_call'}}`, same for `transfer_to_number`. |
| Import a number (SIP) | `POST /v1/convai/phone-numbers` with `provider:'sip_trunk'` → `{ phone_number_id }` | Fields: `phone_number`, `label`, `agent_id?`, `inbound_trunk_config`, `outbound_trunk_config{address,transport,media_encryption,credentials,headers}`. |
| Assign agent to number | `PATCH /v1/convai/phone-numbers/{phone_number_id}` `{ agent_id }` | This is the inbound routing binding. |
| Outbound over SIP | `POST /v1/convai/sip-trunk/outbound-call` | `{ agent_id, agent_phone_number_id, to_number, conversation_initiation_client_data?, telephony_call_config? }` → `{ success, message, conversation_id, sip_call_id }`. |
| Inbound SIP target | `sip:+9665XXXXXXXX@sip.rtc.elevenlabs.io:5060` | The user-part **must** be present. TLS recommended, TCP/UDP supported. Codecs G711 8k or G722 16k. |
| Per-call personalization | conversation-initiation webhook | Fires for **SIP trunk** inbound (not just Twilio). Payload `{caller_id, called_number, agent_id, call_sid, conversation_id}` (+`call_id`, `sip_headers` on SIP). We reply `{type:'conversation_initiation_client_data', dynamic_variables, conversation_config_override}`. Response ≤ 256 KB. |
| Post-call webhook | `post_call_transcription`, `post_call_audio`, `call_initiation_failure` | Header `elevenlabs-signature: t=<unix>,v0=<hex>`; HMAC-SHA256 over `` `${t}.${rawBody}` ``; 30-minute tolerance. |
| Conversation read-back | `GET /v1/convai/conversations/{id}`, `GET /v1/convai/conversations/{id}/audio` | `metadata.phone_call{type,direction,external_number,agent_number,call_sid}`, `analysis{transcript_summary,data_collection_results,evaluation_criteria_results,call_successful}`. |
| Post-call structured data | `platform_settings.data_collection` (identifier → `{type,description}`), `platform_settings.evaluation.criteria` | Replaces Vapi `analysisPlan.structuredDataPlan` / `summaryPlan`. |
| Runtime overrides | `platform_settings.overrides.conversation_config_override.*` = `true` | Must be explicitly enabled per field before `first_message` / `prompt` / `voice_id` can be overridden per call. **This is a gotcha** — outbound per-contact first messages silently do nothing without it. |
| Dynamic variables | `{{var}}`; system vars `system__caller_id`, `system__called_number`, `system__conversation_id`, `system__agent_id`, `system__call_sid`, `system__time` | `secret__`-prefixed vars go only to tool headers, never to the LLM. Inbound custom `X-Foo-Bar` SIP headers arrive as `{{sip_foo_bar}}`. |

### Things ElevenLabs does **not** have that Vapi did

1. **No synchronous text-chat REST endpoint.** Vapi's `POST /chat` (used by
   `/api/v1/agent/chat` and `/api/companies/:id/assistant-chat`) has no ElevenLabs
   equivalent. "Custom Channel" is asynchronous — `202 Accepted` + a reply webhook.
   Decision below in §2.6.
2. **No `endCallPhrases`.** Vapi's provider-side "hang up when the caller says X" safety
   net doesn't exist. Replaced by the `end_call` system tool + the existing
   `END_CALL_TOOL_RULE` prompt block (which already instructs the model to call the tool).
3. ~~**No `messagePlan.idleMessages`.**~~ **Corrected 2026-10-03** — it does exist, as
   `conversation_config.turn.soft_timeout_config`: `{ timeout_seconds, message,
   additional_soft_timeout_messages[], randomize_fillers, use_llm_generated_message,
   max_soft_timeouts_per_generation, disable_until_first_user_message }`. Read off a
   live agent. It ships **disabled** (`timeout_seconds: -1`) and we leave it that way:
   `message` carries a provider default of `"Hhmmmm...yeah."` in English that cannot be
   cleared, and whether `use_llm_generated_message` truly suppresses it has not been
   confirmed on a real call. Speaking English filler into a Saudi call is a worse
   failure than having no filler, so this stays off until it is heard.
4. **One agent per phone number.** Same as Vapi. The inbound/outbound split still needs
   two agents when the scenario defines a separate inbound prompt.

---

## 1. Complete inventory of Vapi dependencies

### 1a. Runtime / backend

| File | Vapi dependency | Purpose | Replacement | Action |
|---|---|---|---|---|
| `server.js:35` | `require('./services/call-events').upsertVapiCall` | Admin backfill of missed calls | `voice.syncRecentCalls()` in the provider layer | **Replace** |
| `server.js:85` | `VAPI_TIMEOUT_MS` | HTTP timeout constant | `ELEVENLABS_TIMEOUT_MS` in `services/voice/elevenlabs.js` | **Move** |
| `server.js:96-107` | `TRANSCRIBER` / `TRANSCRIBER_JSON` (Vapi transcriber object) | STT provider selection | ElevenLabs `conversation_config.asr` (provider is ElevenLabs' own Scribe; no Google option) | **Rewrite** |
| `server.js:143-175` | CSP: `api.vapi.ai`, `*.vapi.ai`, `wss://*.vapi.ai`, `*.daily.co`, `'unsafe-eval'` | Was for the Vapi Web SDK | Nothing — the browser never talks to a voice provider (see §1c) | **Remove** |
| `server.js:178-182` | `req.rawBody` capture | Vapi HMAC verification | Still required — ElevenLabs HMAC also signs the raw body | **Keep** |
| `server.js:241-245` | CSRF skip for `/webhook/*` | Server-to-server | Still required | **Keep** |
| `server.js:322-445` | `POST /api/v1/agent/chat` → `https://api.vapi.ai/chat` | Public text-agent API (WhatsApp BSP) | Local OpenAI path via `composeSystemPrompt` + `retrieve` (§2.6) | **Rewrite** |
| `server.js:361-363` | `company.assistantId` gate ("not published to Vapi") | Publish check | `company.elevenlabsAgentId` via provider layer | **Replace** |
| `server.js:382,419-423` | `whatsapp_sessions.vapi_chat_id` | Text thread continuity | Local history from `chats` via `sql.getSession` | **Replace** |
| `server.js:583-603` | `upsertVapiAssistant()` | Create-or-update assistant | `elevenlabs.upsertAgent()` | **Replace** |
| `server.js:718-725` | `VOICE_SPEED_DEFAULT`, `VOICE_LATENCY_DEFAULT` | ElevenLabs voice pacing passed *through* Vapi | Now native `tts.speed`; `optimize_streaming_latency` is not part of the agent TTS config | **Adapt** |
| `server.js:754-832` | `POST /api/companies/:id/outbound-call` → `https://api.vapi.ai/call` | Manual outbound | `voice.startOutboundCall()` → `/v1/convai/sip-trunk/outbound-call` | **Replace** |
| `server.js:837-898` | `POST /api/companies/:id/assistant-chat` → Vapi `/chat` | Playground text chat | Local OpenAI path (§2.6) | **Rewrite** |
| `server.js:906` | `app.use('/webhook', webhookRoutes)` | Mount | Same mount, new routes | **Keep** |
| `server.js:918-940` | `GET /api/_admin/sync-calls` → `https://api.vapi.ai/call` | Backfill | `GET /v1/convai/conversations` | **Replace** |
| `server.js:996-1010` | `/api/_debug/recent-webhooks` + `VAPI_WEBHOOK_SECRET` diagnostics | Operator debugging | Same feature, `ELEVENLABS_WEBHOOK_SECRET` | **Adapt** |
| `server.js:1077-1081` | `settings.outboundPhoneNumberId` / `inboundPhoneNumberId` | Per-company Vapi number IDs | New company columns (§4) + kept for back-compat | **Migrate** |
| `server.js:1252-1296` | `GET /api/calls/:id` on-demand Vapi pull | Hydrate stub rows | `voice.fetchCall(providerCallId)` | **Replace** |
| `server.js:1315-1359` | `GET /api/calls/:id/recording` re-resolve from Vapi | Fresh presigned URL | `GET /v1/convai/conversations/{id}/audio` (returns bytes directly — simpler) | **Replace** |
| `server.js:1366-1636` | `POST /api/companies/:id/sync-vapi` (the whole assistant config) | Build assistant from scenario | `POST /api/companies/:id/sync-voice` → `elevenlabs.syncAgent()` | **Rewrite** |
| `server.js:1643-1675` | `POST /api/companies/:id/bind-phone` → `PATCH /phone-number/{id}` | Bind number → assistant | `PATCH /v1/convai/phone-numbers/{id}` `{agent_id}` | **Replace** |
| `services/call-events.js` (whole file) | `processVapiEvent`, `upsertVapiCall`, `matchCompanyForCall` | Event → `calls` row + campaign hook + outbound webhook | Split: provider-neutral `processCallEvent(normalized)` + `services/voice/elevenlabs.js#normalizeEvent` | **Refactor** |
| `routes/webhook.js` (whole file) | `POST /webhook/vapi`, `verifyVapiSignature`, `handleToolCalls` | Webhook + in-call KB tool | `POST /webhook/elevenlabs` (HMAC), `POST /webhook/elevenlabs/init` (personalization), `POST /webhook/elevenlabs/tools/kb` (RAG tool) | **Rewrite** |
| `services/campaigns.js:21,83-112,159,235` | `VAPI_TIMEOUT_MS`, `placeCall()` → `api.vapi.ai/call`, `VAPI_PHONE_NUMBER_ID` guards | Campaign dialer | `voice.startOutboundCall()` — one call site | **Replace** |
| `lib/secrets.js:17-20` | `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET` required | Boot gate | `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET` | **Replace** |
| `lib/master-prompt.js:44-60` | `END_CALL_TOOL_RULE` mentions "endCall" | Wires prompt → hang-up tool | Same block, tool renamed to `end_call` | **Adapt (text only)** |
| `lib/lead-scoring.js:10-19,53,98,218` | Reads `calls.structured_data` / `summary` / `ended_reason` produced by Vapi | Lead qualification | **Unchanged** — the adapter writes the same columns in the same shape | **Keep** |
| `services/campaign-report.js`, `routes/campaigns.js:163` | Comments + `structured_data` consumption | Reporting | **Unchanged** | **Keep (comment only)** |
| `services/usage.js:3`, `lib/tenant-context.js:5`, `lib/auth.js:143` | Comments only | — | — | **Comment only** |
| `summarize.js`, `lib/rag.js`, `lib/pii.js`, `lib/audit.js`, `services/outbound-webhook.js`, `services/retention.js`, `services/evals.js`, `lib/queue.js`, `lib/rls.js` | none | — | — | **Untouched** |

### 1b. Database

| File | Vapi dependency | Purpose | Replacement | Action |
|---|---|---|---|---|
| `db-pg-schema.js:37-38` | `companies.assistant_id`, `assistant_id_inbound` | Vapi assistant ids | New `elevenlabs_agent_id*` columns | **Add alongside, keep old** |
| `db-pg-schema.js:208` | `whatsapp_sessions.vapi_chat_id` | Vapi chat thread | Unused after §2.6; column retained | **Keep (dormant)** |
| `db-sqlite.js:591-596` | `companyByAssistantId`, `companyByPhoneNumberId` (reads `settings` JSON) | Company resolution for events | `companyByProviderAgentId`, `companyByProviderPhoneNumberId`, `companyByPhoneNumber` | **Add** |
| `db-sqlite.js:99` | `calls.id` = "vapi call id" | PK | Now holds the ElevenLabs `conversation_id`; historic rows keep Vapi ids | **Keep, add `provider` column** |
| `db-sqlite.js` migrations 8,12,17,20,22 | Historic | — | Never re-run; new migrations appended | **Keep** |
| `webhook_events.provider` | `'vapi'` literal in `routes/webhook.js:163` | Inbox partitioning | `'elevenlabs'` for new rows | **Additive** |

### 1c. Frontend

Audited every `.jsx` file. **There is no Vapi SDK, no Daily, and no WebRTC in the frontend.**
`package.json` and `package-lock.json` contain zero references; `node_modules/@vapi-ai` and
`node_modules/@daily-co` are *empty leftover directories* from a dependency removed earlier
and are not imported anywhere.

| File | Dependency | Purpose | Action |
|---|---|---|---|
| `admin-src/src/pages/PlaygroundPage.jsx:16-25,189,366-370` | Comments, "Vapi · منشور" badge, `dashboard.vapi.ai/assistants/{id}` deep link | UI labels only | **Relabel** → "ElevenLabs", link `elevenlabs.io/app/agents/{agent_id}` |
| `admin-src/src/lib/api.js:73` | `syncVapi()` → `POST /api/companies/:id/sync-vapi` | API client | **Rename** → `syncVoice()` → `/sync-voice` |
| `admin-src/src/pages/CompaniesPage.jsx:84,119,147,149` | `api.syncVapi`, "منشورة على Vapi", "عبر Twilio + Vapi" | Labels + call | **Relabel + rename** |
| `admin-src/src/pages/ScenariosPage.jsx:109,888,905,1233,1302-1315` | Out-of-sync copy, prompt-preview copy, inbound card copy, "معرّف الرقم الصادر (Vapi)" fields | Labels + the two phone-id inputs | **Relabel**; inputs now write the ElevenLabs `phone_number_id` |
| `admin-src/src/pages/CampaignsPage.jsx:38` | `not_published` message | Label | **Relabel** |
| `admin-src/src/components/companies/CompanyCard.jsx:85` | "منشور على Vapi" badge | Label | **Relabel** |
| `admin-src/src/components/companies/CompanyForm.jsx:44`, `App.jsx:118`, `Toast.jsx:14`, `CampaignReportPage.jsx:57`, `tailwind.config.mjs:12` | Comments only | — | **Comment only** |
| `public/admin/assets/index-*.js` | Built artifact | — | **Rebuilt by `npm run build:ui`** |

**Conclusion on the Playground:** it already works the right way — you type a phone number
and the platform rings it over the telephony stack; there is no browser microphone session.
That design carries over to ElevenLabs unchanged. We are **not** adding
`@elevenlabs/react`/WebRTC, because the Playground's whole point is to exercise the real
3CX→SIP→agent path. The browser never gets an API key.

### 1d. Configuration / docs / tests

| File | Dependency | Action |
|---|---|---|
| `.env`, `.env_example`, `.env.production.example` | `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_PHONE_NUMBER_ID`, `VAPI_PUBLIC_KEY`, `TRANSCRIBER_JSON` | **Replace** with the ElevenLabs set (§6) |
| `README.md` (8 refs) | Env table + architecture | **Update** |
| `docs/agent-http-api.md:87` | 409 error text | **Update** |
| `test-apis.js:75-83` | Vapi connectivity probe | **Replace** with `GET /v1/convai/agents` |
| `scripts/profile-calls.js` | Reads Vapi `performanceMetrics` | **Rewrite** against `GET /v1/convai/conversations` (or retire — EL exposes different metrics) |
| `scripts/smoke-test.js:26-27,115,233-247` | Fake Vapi env + `/webhook/vapi` payload | **Rewrite** for `/webhook/elevenlabs` + HMAC |
| `scripts/test-secrets.js:11-37` | Asserts `VAPI_*` required | **Update** |
| `scripts/test-campaign-worker.js:15-21,79-85,121-123` | Mocks `axios.post` to Vapi, `VAPI_PHONE_NUMBER_ID` | **Update** to mock the provider layer |
| `scripts/test-authz.js:180` | Comment | **Comment only** |

---

## 2. Proposed architecture

### 2.1 Layering

```
routes/webhook.js ──► services/voice/index.js ──► services/voice/elevenlabs.js ──► api.elevenlabs.io
server.js         ──►        (facade)                  (only file that knows
services/campaigns.js ──►                               ElevenLabs shapes)
                                  │
                                  ▼
                       services/call-events.js
                    (provider-neutral, unchanged logic)
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
        calls table        campaigns hook       outbound-webhook
        lead-scoring       usage/metrics        audit
```

New files:

- `services/voice/provider.js` — the interface contract + the normalized call-event shape.
  Pure JSDoc + validators, no network.
- `services/voice/elevenlabs.js` — the only place that knows ElevenLabs URLs and payloads.
- `services/voice/index.js` — facade. Resolves a company's provider
  (`company.voiceProvider`), returns the driver, re-exports the neutral helpers.

Everything else calls `require('./services/voice')` and never sees a provider name.

### 2.2 Provider interface

```js
// services/voice/provider.js
/**
 * @typedef {Object} NormalizedCallEvent
 * @property {'elevenlabs'|'vapi'} provider
 * @property {string}  providerCallId      // EL conversation_id
 * @property {string?} companyId           // resolved SERVER-SIDE, never from payload
 * @property {'inbound'|'outbound'} direction
 * @property {string?} callerNumber
 * @property {string?} destinationNumber
 * @property {string?} agentId
 * @property {string?} transcript          // flattened text
 * @property {string?} startedAt           // 'YYYY-MM-DD HH:MM:SS' UTC
 * @property {string?} endedAt
 * @property {number?} durationSec
 * @property {string?} endedReason
 * @property {string?} recordingUrl
 * @property {string?} summary
 * @property {object?} structuredData
 * @property {number?} costUsd
 * @property {object}  metadata
 */
```

Driver methods:

| Method | Used by |
|---|---|
| `syncAgent(company, scenario, composedPrompt, opts)` | `/api/companies/:id/sync-voice` |
| `bindPhoneNumber(company)` | `/api/companies/:id/bind-phone` |
| `startOutboundCall({ company, toNumber, variables, firstMessage })` | Playground + campaigns |
| `fetchCall(providerCallId)` | call detail hydration |
| `fetchRecording(providerCallId, range)` | recording proxy |
| `listRecentCalls(limit)` | admin backfill |
| `verifyWebhook(req)` | webhook route |
| `normalizeEvent(payload)` | webhook route |
| `resolveCompanyForEvent(normalized)` | webhook route |

### 2.3 Inbound flow

```
Customer dials the company's landline
        ↓
3CX PBX (number already owned by the company — unchanged)
        ↓  outbound route: match DID → SIP trunk "ElevenLabs"
SIP INVITE  sip:+9665XXXXXXXX@sip.rtc.elevenlabs.io:5060   (TLS 5061 preferred)
            Digest auth (username/password) or ACL on 3CX's public IP
        ↓
ElevenLabs matches the To user-part against the imported phone number
        ↓
phone_number.agent_id  →  Company X's agent          ◄── the tenant binding
        ↓
(optional) conversation-initiation webhook → POST /webhook/elevenlabs/init
        ↓  we look up company by called_number, return dynamic_variables
Agent converses; calls our KB tool when it needs facts
        ↓
POST /webhook/elevenlabs  (post_call_transcription, HMAC-signed)
        ↓
normalize → resolveCompany (agent_id → company) → processCallEvent
        ↓
calls row · summary · lead scoring · campaign hook · outbound webhook · metrics · audit
```

**Tenant resolution order for inbound (all server-side):**
1. `data.agent_id` → `companies.elevenlabs_agent_id` / `..._inbound` (authoritative).
2. `metadata.phone_call.agent_number` → `companies.phone_number` (survives agent churn —
   this is the ElevenLabs equivalent of the existing `phoneNumberId` fallback).
3. `conversation_initiation_client_data.dynamic_variables.company_id` — **only** accepted
   when it matches (1) or (2). Never trusted alone.

### 2.4 Outbound flow

```
Playground "Start Call"  /  campaign worker tick
        ↓
voice.startOutboundCall({ company, toNumber, variables, firstMessage })
        ↓
POST /v1/convai/sip-trunk/outbound-call
  { agent_id: company.elevenlabs_agent_id,
    agent_phone_number_id: company.elevenlabs_phone_number_id,   ◄── company's own 3CX DID
    to_number: "+9665...",
    conversation_initiation_client_data: {
      dynamic_variables: { customer_name, ... },
      conversation_config_override: { agent: { first_message } }  ◄── needs overrides enabled
    } }
        ↓
ElevenLabs places the INVITE to outbound_trunk_config.address  (3CX public FQDN/IP)
        ↓
3CX routes to the PSTN via the company's SIP trunk, CLI = the company's own number
        ↓
Customer's phone rings
        ↓
response { conversation_id } → insertOutboundCallStub  (unchanged code path)
```

`conversation_id` is returned synchronously, so `insertOutboundCallStub`,
`setContactCallId`, and the "appears in Conversations immediately" behaviour all work
exactly as today. `sip_call_id` is stored in `calls.provider_call_ref` for 3CX-side
correlation.

### 2.5 Company → agent mapping (multi-tenant, nothing hard-coded)

```
companies
  id                            'co-xxxx'            (existing)
  phone_number                  '+9665XXXXXXXX'      (existing — the 3CX DID)
  voice_provider                'elevenlabs'|'vapi'  (new, per company)
  elevenlabs_agent_id           'agent_...'          (new)
  elevenlabs_agent_id_inbound   'agent_...'|NULL     (new)
  elevenlabs_phone_number_id    'phnum_...'          (new)
  elevenlabs_kb_tool_id         'tool_...'|NULL      (new)
  elevenlabs_synced_at          timestamp            (new)
```

A → 3CX DID A → EL phone_number A → EL agent A. B → B → B → B. All rows, no constants.
`voice_provider` lets Company A cut over while Company B still runs on Vapi, which is what
makes a staged rollout possible.

### 2.6 Text-chat paths (the one real functional gap)

`POST /api/v1/agent/chat` (public, used by the WhatsApp BSP) and
`POST /api/companies/:id/assistant-chat` (Playground) both call Vapi's synchronous
`/chat`. **ElevenLabs has no synchronous text endpoint** — Custom Channel returns `202` and
replies later via webhook, which would break the public API contract those integrations
depend on.

Proposed: route both through the **existing local OpenAI path** —
`composeSystemPrompt(company, scenario.instructionPrompt)` + `retrieve()` + `askGPT()`.
This is already in the repo and already the single source of truth for the prompt
(`composeSystemPrompt` is what feeds the voice sync too), so:

- same scenario text, same globals, same RAG, same model resolution (`resolveAgentModel`);
- stays synchronous — `/api/v1/agent/chat` response shape is unchanged;
- thread continuity comes from `sql.getSession(session_id, company_id)` instead of
  `vapi_chat_id`; no new table.

Trade-off, stated plainly: if an operator edits the agent's LLM inside the ElevenLabs
dashboard, the text channel won't follow. Voice remains the source of truth for voice.
**This is the one place where I'd like your confirmation before implementing** — the
alternative is wiring Custom Channel and making the public API asynchronous, which changes
the contract for whoever consumes it today.

### 2.7 RAG / KB tool flow (tenant-safe)

```
Agent decides it needs a fact
        ↓
webhook tool "search_knowledge_base"  (one tool per company, created at sync)
  POST {PUBLIC_BASE_URL}/webhook/elevenlabs/tools/kb
  headers: { X-Company-Token: "<companyId>.<hmac_sha256(TOOL_SECRET, companyId)>" }   ◄── auth
  body:    { query: "<model-supplied>",
             agent_id: "{{system__agent_id}}",              ◄── filled by ElevenLabs
             conversation_id: "{{system__conversation_id}}" }
        ↓
our handler:
  1. parse + timing-safe verify X-Company-Token           → companyId  (authoritative)
  2. look up companies.elevenlabs_agent_id for companyId
  3. reject 403 if it doesn't match body.agent_id         (defense in depth)
  4. retrieve(companyId, query, { topK: 3 })              ← lib/rag.js UNCHANGED
  5. return the same capped plain text the Vapi handler returned
```

The model supplies **only** `query`. `companyId` is never taken from model output or from
an unauthenticated body field. This is strictly stronger than the current Vapi handler,
which derives the company from an unauthenticated `call.assistantId` in the body.

### 2.8 Prompts, scenarios, analysis

| Today (Vapi) | ElevenLabs equivalent |
|---|---|
| `cfg.model.messages[0].content` ← `composeSystemPrompt()` | `conversation_config.agent.prompt.prompt` ← **same function, unchanged** |
| `cfg.firstMessage` | `conversation_config.agent.first_message` |
| `cfg.model.{model,temperature,maxTokens}` | `agent.prompt.{llm,temperature,max_tokens}` (`resolveAgentModel()` reused; new `ELEVENLABS_LLM` mapping) |
| `voice.{voiceId,stability,similarityBoost,speed}` | `tts.{voice_id,stability,similarity_boost,speed}` (same values, same clamps) |
| `voice.model: eleven_turbo_v2_5` | `tts.model_id: eleven_turbo_v2_5` |
| `transcriber` (Google Gemini) | `asr.{quality,user_input_audio_format}` — **Gemini STT is not available**; ElevenLabs uses its own ASR |
| `tools: [{type:'endCall'}]` | `prompt.tools: [{type:'system',name:'end_call',params:{system_tool_type:'end_call'}}]` |
| `tools: [{type:'transferCall',destinations}]` | `{type:'system',name:'transfer_to_number',...}` + `settings.transferPhoneNumber` |
| `tools: [{type:'function', server:{url,secret}}]` | `POST /v1/convai/tools` → `prompt.tool_ids: [id]` |
| `analysisPlan.structuredDataPlan.schema.properties` | `platform_settings.data_collection` — **same 9 Arabic keys, same descriptions**, so `lib/lead-scoring.js` and the campaign report keep working untouched |
| `analysisPlan.summaryPlan.messages` (Arabic summary) | `platform_settings.evaluation` + our existing `summarize()` fallback |
| `endCallPhrases` | no equivalent → prompt rule only (already present) |
| `messagePlan.idleMessages` + `idleTimeoutSeconds: 15` | `turn.turn_timeout` (closest); rotating idle lines are lost |
| `silenceTimeoutSeconds: 30` | `turn.silence_end_call_timeout` |
| `startSpeakingPlan` / `stopSpeakingPlan` | `turn.turn_eagerness` (coarser) |
| `maxDurationSeconds: 600` | `conversation.max_duration_seconds: 600` |

`lib/master-prompt.js`, `lib/scenario-lint.js`, `lib/scenario-templates.js`, the scenario
editor, `fillGlobals`, `fillRuntimeVars` — **all unchanged**. Only the word `endCall` inside
`END_CALL_TOOL_RULE` becomes `end_call`.

### 2.9 Call-history flow

`services/call-events.js` keeps every line of business logic and loses every line of Vapi
parsing:

```js
// before: processVapiEvent(msg)                 ← parses Vapi envelope inline
// after:  processCallEvent(normalizedEvent)     ← provider-neutral
//         + normalizeEvent() lives in the driver
```

`upsertCall`, `setCallSummary`, `handleCallEnded`, `sendCallCompleted`, `encryptField`,
`runWithContext`, `drainWebhookInbox`, `startDrainTimer` — untouched. The drain reads
`webhook_events.provider` and dispatches to the right driver's `normalizeEvent`, so
**pending Vapi events already in the inbox still process correctly after deploy.**

---

## 3. Exactly which files will change

**New (5)**
```
services/voice/index.js
services/voice/provider.js
services/voice/elevenlabs.js
services/voice/vapi.js              ← existing Vapi code moved here verbatim, deleted in Phase 5
routes/webhook-elevenlabs.js        ← or folded into routes/webhook.js; decide at implementation
```

**Modified — backend (14)**
```
server.js                      CSP, sync route, outbound, chat, calls, recording, bind-phone, admin sync
services/call-events.js        refactor to provider-neutral
routes/webhook.js              new endpoints + HMAC
services/campaigns.js          placeCall → voice.startOutboundCall (1 call site)
lib/secrets.js                 env spec
lib/master-prompt.js           endCall → end_call (string only)
lib/schemas.js                 settings validation for the new ids
companies.js                   toCompany() exposes the new columns
db.js / db-sqlite.js / db-postgres.js / db-pg-schema.js / lib/migrations-pg.js   migrations + 3 new queries
summarize.js                   unchanged (listed for completeness — no change)
```

**Modified — frontend (7)**
```
admin-src/src/lib/api.js
admin-src/src/pages/PlaygroundPage.jsx
admin-src/src/pages/CompaniesPage.jsx
admin-src/src/pages/ScenariosPage.jsx
admin-src/src/pages/CampaignsPage.jsx
admin-src/src/components/companies/CompanyCard.jsx
+ rebuild public/admin/
```

**Modified — config/docs/tests (8)**
```
.env_example  .env.production.example  README.md  docs/agent-http-api.md
test-apis.js  scripts/smoke-test.js  scripts/test-secrets.js  scripts/test-campaign-worker.js
scripts/profile-calls.js  (rewrite or retire)
```

**Explicitly untouched**
```
lib/rag.js  lib/lead-scoring.js  lib/auth.js  lib/rls.js  lib/pii.js  lib/ssrf.js
lib/audit.js  lib/queue.js  lib/metrics.js  lib/retention.js  lib/crypto.js
lib/tenant-context.js  lib/validate.js  lib/backup.js  lib/monitoring.js  lib/logger.js
lib/scenario-lint.js  lib/scenario-templates.js  lib/db-pg.js
services/evals.js  services/retention.js  services/usage.js  services/outbound-webhook.js
services/campaign-report.js  routes/auth.js  routes/clients.js  routes/evals.js
routes/campaigns.js  (comment only)
```

---

## 4. Database migrations

**Nothing is dropped. No existing column changes type. No historical row is touched.**

### SQLite (`db-sqlite.js`, appended as migrations 23–25)

```sql
-- 23  companies_add_elevenlabs
ALTER TABLE companies ADD COLUMN voice_provider              TEXT;     -- NULL = legacy vapi
ALTER TABLE companies ADD COLUMN elevenlabs_agent_id         TEXT;
ALTER TABLE companies ADD COLUMN elevenlabs_agent_id_inbound TEXT;
ALTER TABLE companies ADD COLUMN elevenlabs_phone_number_id  TEXT;
ALTER TABLE companies ADD COLUMN elevenlabs_kb_tool_id       TEXT;
ALTER TABLE companies ADD COLUMN elevenlabs_synced_at        TEXT;

-- 24  calls_add_provider
ALTER TABLE calls ADD COLUMN provider          TEXT;   -- backfilled 'vapi' for existing rows
ALTER TABLE calls ADD COLUMN provider_call_ref TEXT;   -- EL sip_call_id, for 3CX correlation
UPDATE calls SET provider = 'vapi' WHERE provider IS NULL;
CREATE INDEX IF NOT EXISTS idx_calls_provider ON calls(provider);

-- 25  companies_phone_lookup
CREATE INDEX IF NOT EXISTS idx_companies_phone ON companies(phone_number);
CREATE INDEX IF NOT EXISTS idx_companies_el_agent ON companies(elevenlabs_agent_id);
```

### Postgres (`lib/migrations-pg.js` — `ADD_COLUMNS`, already idempotent + catalog-guarded)

```js
['companies', 'voice_provider',              'TEXT'],
['companies', 'elevenlabs_agent_id',         'TEXT'],
['companies', 'elevenlabs_agent_id_inbound', 'TEXT'],
['companies', 'elevenlabs_phone_number_id',  'TEXT'],
['companies', 'elevenlabs_kb_tool_id',       'TEXT'],
['companies', 'elevenlabs_synced_at',        'TEXT'],
['calls',     'provider',                    'TEXT'],
['calls',     'provider_call_ref',           'TEXT'],
```
plus a one-shot guarded backfill `UPDATE calls SET provider='vapi' WHERE provider IS NULL`
and the three indexes. `db-pg-schema.js` gets the same columns so fresh installs match.

**RLS:** no new tenant tables, so `lib/rls.js` and the policies need no change.

**Kept deliberately (removed only in Phase 5, and only if you approve):**
`companies.assistant_id`, `companies.assistant_id_inbound`, `whatsapp_sessions.vapi_chat_id`,
and every `calls` row whose `provider='vapi'`. Historic Vapi call data stays forever.

**New queries (3)** in both drivers:
`companyByProviderAgentId`, `companyByProviderPhoneNumberId`, `companyByPhoneNumber`.
The existing `companyByAssistantId` / `companyByPhoneNumberId` stay so the Vapi driver keeps
working during the dual-run.

---

## 5. How the existing 3CX numbers connect to ElevenLabs

No numbers are purchased from ElevenLabs. Each company's number stays a 3CX DID; ElevenLabs
only *imports* it as a `sip_trunk` phone number so it can be addressed and billed to an agent.

### One-time, per company (scripted — `scripts/elevenlabs-provision.js`)

```
POST /v1/convai/phone-numbers
{
  "phone_number": "+9665XXXXXXXX",          ← the company's existing 3CX DID
  "label": "smart-assistant:<companyId>",
  "provider": "sip_trunk",
  "agent_id": "<the company's agent>",
  "inbound_trunk_config": {
    "allowed_addresses": ["<3CX public IP>/32"],      // or digest credentials
    "media_encryption": "allowed"
  },
  "outbound_trunk_config": {
    "address": "pbx.company.example.com",             ← 3CX FQDN, no "sip:" prefix
    "transport": "tls",
    "media_encryption": "allowed",
    "credentials": { "username": "...", "password": "..." }
  }
}
→ { "phone_number_id": "phnum_..." }   → stored in companies.elevenlabs_phone_number_id
```

### 3CX side — inbound

1. Add a SIP trunk / "Generic SIP provider": host `sip.rtc.elevenlabs.io`, port `5061` (TLS)
   or `5060` (TCP), auth = the digest credentials above.
2. Inbound rule for DID `+9665XXXXXXXX` → route to that trunk.
3. 3CX must send `To: sip:+9665XXXXXXXX@sip.rtc.elevenlabs.io` — **the user-part is
   mandatory**; a bare `sip:@sip.rtc.elevenlabs.io` fails.
4. Codec list on the trunk: **G711 (a-law/µ-law) or G722 only**. Remove G729/Opus.
5. Optional: add `X-Company-Ref: <companyId>` as a custom outbound header — it arrives at
   the agent as `{{sip_company_ref}}` and gives us a third (still cross-checked)
   correlation signal.

### 3CX side — outbound

1. Allow inbound INVITEs from ElevenLabs on the same trunk (ACL the ElevenLabs egress, or
   require digest auth — digest is recommended, dynamic IPs otherwise).
2. Outbound rule: calls arriving on that trunk go out over the company's PSTN trunk with
   the caller ID set to the company's own DID.
3. Firewall: SIP `5060/tcp`, `5061/tls`, and RTP `10000–60000/udp` both ways.

### Rollout switch

`companies.voice_provider` per row. Flip one company, watch it, flip the next. The old Vapi
binding is untouched until you flip, so rollback is a single column update.

---

## 6. Environment variables

```bash
# ─── ElevenLabs Agents (voice) ───────────────────────────────────
ELEVENLABS_API_KEY=sk_...              # REQUIRED — TTS + Agents + SIP. Server only.
ELEVENLABS_WEBHOOK_SECRET=wsec_...     # REQUIRED — HMAC secret shown when you create the
                                       #            post-call webhook in the EL dashboard
ELEVENLABS_TOOL_SECRET=                # optional — signs the KB tool's X-Company-Token.
                                       #            Falls back to ELEVENLABS_WEBHOOK_SECRET.
ELEVENLABS_API_BASE=https://api.elevenlabs.io   # optional override
ELEVENLABS_LLM=gpt-4.1                 # optional — agent LLM; validated against GET /v1/convai/llm
ELEVENLABS_SIP_DOMAIN=sip.rtc.elevenlabs.io     # optional — enterprise static-IP variants
PUBLIC_BASE_URL=https://...            # already exists — needed for tool + init webhook URLs
```

Removed in Phase 5: `VAPI_API_KEY`, `VAPI_WEBHOOK_SECRET`, `VAPI_PHONE_NUMBER_ID`,
`VAPI_PUBLIC_KEY`, `TRANSCRIBER_JSON`, `VOICE_LATENCY_DEFAULT`, `ENDPOINT_*`.
`ELEVENLABS_VOICE_ID` stays ignored (code owns `DEFAULT_VOICE_ID`), `EXTRA_VOICE_IDS` and
`VOICE_SPEED_DEFAULT` keep working.

No key is ever sent to the browser. `VAPI_PUBLIC_KEY` was the only browser-facing one and it
is already unused.

---

## 7. Limitations and risks that could block or degrade this migration

| # | Issue | Impact | Mitigation |
|---|---|---|---|
| 1 | **No synchronous text chat on ElevenLabs** | `/api/v1/agent/chat` (WhatsApp BSP) and the Playground chat tab | Local OpenAI path, §2.6. **Needs your sign-off.** |
| 2 | **Gemini STT is gone.** Your memory pins `google/gemini-2.5-flash/Arabic` for Saudi Arabic accuracy — ElevenLabs Agents use their own ASR and there is no provider choice | Arabic recognition quality may shift, up or down | Must be A/B'd on real Saudi calls before full cutover. **Test with one company first.** |
| 3 | **`endCallPhrases` has no equivalent** | The provider-side hang-up safety net disappears; only the prompt rule remains | `END_CALL_TOOL_RULE` already instructs the model explicitly; add `turn.silence_end_call_timeout` as a backstop |
| 4 | **`messagePlan.idleMessages` has no equivalent** | The rotating Saudi check-in lines ("ألو أستاذي، معاي؟") are lost | Accept, or fold them into the scenario prompt |
| 5 | **Fine-grained endpointing is gone** (`onPunctuationSeconds` etc.) | Your measured 1501 ms endpointing tuning no longer applies | `turn.turn_eagerness` is the only knob; re-measure after cutover |
| 6 | **Overrides must be pre-enabled** | Outbound per-contact `first_message` and `{{customer_name}}` silently do nothing if `platform_settings.overrides` isn't set | Set them in `syncAgent()` — easy to miss, so it's an explicit test case |
| 7 | **3CX codec/transport mismatch** | Inbound calls fail or go one-way audio | G711/G722 only; TLS 1.2+; RTP 10000–60000 open |
| 8 | **3CX dynamic public IP** | ACL allowlisting breaks | Use digest auth, not ACL |
| 9 | **SIP BYE to the wrong host → 481** | Calls don't hang up cleanly | 3CX must send BYE to the `Contact` header from the INVITE response, not to `sip.rtc.elevenlabs.io` |
| 10 | **Concurrent-call limits are plan-dependent** | Campaign `max_concurrent` × companies could exceed the tier | Confirm your EL plan's concurrency; enable call queueing |
| 11 | **`data_collection` shape is thinly documented** | The 9 Arabic lead fields might not map 1:1 | **Resolved by live verification (2026-09-18): our exact payload was POSTed to `/v1/convai/agents/create` and accepted (HTTP 200), with all 9 keys stored verbatim and the remaining schema fields defaulted server-side.** Shape is identifier → `{type, description}`, locked by a test |
| 12 | **Recording delivery differs** | Vapi returned a presigned URL; EL returns bytes from `/audio` | The existing proxy endpoint already hides this from the frontend — it gets simpler, not harder |
| 13 | **Two agents per company** (inbound + outbound prompts) | 2× agent count, both need the overrides/tools config | `syncAgent()` builds both from one config object, as today |
| 14 | **Cost model changes** | `calls.cost_usd` semantics differ | **Corrected after live verification (2026-09-18): there is NO `cost_fiat` field — it does not exist in the API.** `metadata.cost` is billing CREDITS and is the only cost the provider reports. Credits are stored in the new `calls.cost_credits`; `cost_usd` stays null unless `ELEVENLABS_USD_PER_CREDIT` is set. Historic Vapi values are untouched |

---

## 8. Phased implementation plan

| Phase | Deliverable | Risk | Reversible? |
|---|---|---|---|
| **1 — Audit** | This document | none | n/a |
| **2 — Scaffolding** | `services/voice/{index,provider,vapi}.js`; existing Vapi code moved behind the facade **with zero behaviour change**; `services/call-events.js` refactored to `processCallEvent(normalized)` + a Vapi `normalizeEvent`. Existing tests must pass. | low | yes — pure refactor |
| **3 — Schema** | Migrations 23–25 + PG `ADD_COLUMNS` + 3 new queries + `toCompany()` exposure. Additive only. | low | yes — columns unused until Phase 4 |
| **4 — ElevenLabs driver** | `services/voice/elevenlabs.js`: `syncAgent`, `bindPhoneNumber`, `startOutboundCall`, `fetchCall`, `fetchRecording`, `listRecentCalls`, `verifyWebhook` (HMAC), `normalizeEvent`, `resolveCompanyForEvent`. Not wired to any route yet. | medium | yes — dead code until Phase 5 |
| **5 — Webhooks + tool** | `POST /webhook/elevenlabs`, `/webhook/elevenlabs/init`, `/webhook/elevenlabs/tools/kb`. `/webhook/vapi` stays live in parallel. | medium | yes — both endpoints coexist |
| **6 — Provisioning** | `scripts/elevenlabs-provision.js` (import DID → `phone_number_id` → bind agent) + `/api/companies/:id/sync-voice` + `bind-phone` routed through the facade. | medium | yes — `voice_provider` still `vapi` |
| **7 — Cut over company A** | Set `voice_provider='elevenlabs'` for one company. Run the full test matrix (§9). 3CX trunk configured. Company B stays on Vapi. | **high** | yes — one column update |
| **8 — Cut over the rest** | Per company, after A is stable. | medium | yes, per company |
| **9 — Vapi removal** | Delete `services/voice/vapi.js`, `/webhook/vapi`, `VAPI_*` env, CSP entries, `TRANSCRIBER_JSON`, stale `node_modules/@vapi-ai` + `@daily-co`, Vapi tests. **Historic `calls` rows and the `assistant_id` columns stay.** | low | yes via git |

Phases 2–6 are safe to merge and deploy while every company keeps running on Vapi. The only
irreversible-feeling moment is Phase 7, and even that is one `UPDATE companies SET
voice_provider='vapi'` away from rollback.

---

## 9. Test matrix (Phase 4 of your brief)

| # | Test | How |
|---|---|---|
| 1 | Company A inbound | Real call to A's 3CX DID → A's agent answers with A's scenario |
| 2 | Company B inbound | Same for B → B's agent, B's prompt, B's KB |
| 3 | Company A outbound | Playground call; CLI shows A's number |
| 4 | Company B outbound | Same for B |
| 5 | Unknown mapping | Post-call webhook with an unknown `agent_id` → row stored with `company_id=NULL`, no crash, warning logged |
| 6 | Call completion | `calls` row has `ended_at`, `duration_sec`, `ended_reason` |
| 7 | Transcript | Flattened EL transcript lands in `calls.transcript` |
| 8 | Recording | `/api/calls/:id/recording` streams audio, Range works, tenant-scoped |
| 9 | Summary | `analysis.transcript_summary` → `calls.summary`; `summarize()` fallback when short |
| 10 | RAG tool | Ask a KB-only fact mid-call; assert `retrieve()` hit + correct answer |
| 11 | Campaign call | Campaign dials, `campaign_contacts.call_id` = `conversation_id`, `handleCallEnded` resolves |
| 12 | Webhook verification | Valid HMAC → 200; tampered body → 401; timestamp >30 min → 401; missing header → 401 |
| 13 | Tenant isolation | KB tool token for A + `agent_id` of B → 403, zero rows leaked |
| 14 | Failure/retry | Kill processing mid-event → `webhook_events` row stays `pending` → `drainWebhookInbox` retries |
| 15 | Mixed-provider drain | A pending `provider='vapi'` inbox row still processes after deploy |
| 16 | Overrides | Outbound with `customer_name` → agent greets by name (catches risk #6) |

Automated where possible: `scripts/smoke-test.js` covers 5, 12, 14, 15;
`scripts/test-campaign-worker.js` covers 11 with the provider layer mocked.

---

## 12. As built

42 files changed, 6 added. Every automated check passes: **214 unit tests**
(`npm run test:unit`, including the 44 new ones in `scripts/test-voice.js`) and **38/38
smoke checks** (`node scripts/smoke-test.js`, which boots the real server and exercises
real HMAC verification).

### Differences from the plan

| Planned | Built | Why |
|---|---|---|
| Keep a `services/voice/vapi.js` driver through a staged rollout | **Not built.** Vapi removed in the same pass. | Requested explicitly after the rollback trade-off was stated. `voice_provider` still exists per company so a future provider is a column, not a rewrite. |
| Settings keep `outboundPhoneNumberId` + `inboundPhoneNumberId` | **One** `elevenlabs_phone_number_id`, in a column, superadmin-only | The same 3CX DID answers inbound and is the caller ID outbound, so the split had no meaning. A column gets an index for webhook tenant lookup; settings JSON does not. |
| `routes/webhook-elevenlabs.js` as a separate file | Folded into `routes/webhook.js` | Three endpoints, one mount point, ~200 lines. A second file bought nothing. |
| — | Added `POST /api/companies/:id/import-phone` | The provisioning script needed a server-side counterpart so an operator can import a DID without shell access. |
| — | Added a driver-parity test | Six statements were added to two hand-maintained catalogs. Drift there passes every SQLite test and then throws in production, which runs Postgres. |

### Two bugs found while migrating

1. **The in-call knowledge-base tool was never attached on Postgres.** The old line read
   `await sql.countCompanyChunks.get(c.id)?.n || 0`. Without parentheses this is
   `await (promise?.n)` → `undefined` → `0`, so `kbChunkCount > 0` was never true on the
   Postgres driver — i.e. in production. On SQLite `.get()` returns a row synchronously,
   so it worked in dev. Exactly the failure mode the README warns about. Fixed as
   `(await …)?.n || 0`.
2. **A late event with no direction would have relabelled an outbound call as inbound.**
   `calls.direction` is `NOT NULL`, so "the provider didn't say" could not travel through
   `excluded.direction`. Both drivers now read the parameter directly in the conflict
   branch. Caught by a test, not by review.

### What still needs a human

Nothing in this repo — the remaining work is account and PBX configuration:

1. Set `ELEVENLABS_WEBHOOK_SECRET` from the post-call webhook you create in the ElevenLabs
   dashboard, pointing at `https://<domain>/webhook/elevenlabs`. **Boot refuses to start
   in production without it**, by design.
2. Enable the conversation-initiation webhook per agent (Security tab → "Fetch initiation
   client data from a webhook") at `https://<domain>/webhook/elevenlabs/init`.
3. Run `node scripts/elevenlabs-provision.js --company <id> --address <3cx-host> …` per
   company, then the 3CX steps it prints.
4. **A/B the Arabic ASR before cutting over every tenant.** The Gemini-pinned Arabic
   transcriber is gone and has no equivalent (risk #2); this is the one item that could
   still send the migration backwards, and it can only be judged on real Saudi calls.

### Known behaviour change

Recordings for historical Vapi calls are no longer retrievable — `/api/calls/:id/recording`
serves the current provider only. Those rows stored expiring presigned URLs that had
already lapsed, so nothing retrievable was lost. **Transcripts, summaries, structured data
and every other field on historical calls are untouched.**

---

## Sources

- [SIP trunking](https://elevenlabs.io/docs/agents-platform/phone-numbers/sip-trunking)
- [Import phone number](https://elevenlabs.io/docs/api-reference/phone-numbers/create) · [Update phone number](https://elevenlabs.io/docs/api-reference/phone-numbers/update)
- [Outbound call via SIP trunk](https://elevenlabs.io/docs/api-reference/sip-trunk/outbound-call)
- [Create agent](https://elevenlabs.io/docs/api-reference/agents/create) · [Update agent](https://elevenlabs.io/docs/api-reference/agents/update)
- [Create tool](https://elevenlabs.io/docs/api-reference/tools/create) · [System tools](https://elevenlabs.io/docs/agents-platform/customization/tools/system-tools) · [Webhook tools](https://elevenlabs.io/docs/agents-platform/customization/tools/server-tools)
- [Post-call webhooks](https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks) · [Webhooks resource](https://elevenlabs.io/docs/eleven-api/resources/webhooks) · [Verification reference](https://github.com/hookdeck/webhook-skills/blob/main/skills/elevenlabs-webhooks/references/verification.md)
- [Personalization / conversation-initiation webhook](https://elevenlabs.io/docs/eleven-agents/customization/personalization) · [Overrides](https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides) · [Dynamic variables](https://elevenlabs.io/docs/eleven-agents/customization/personalization/dynamic-variables)
- [Get conversation](https://elevenlabs.io/docs/api-reference/conversations/get) · [Get conversation audio](https://elevenlabs.io/docs/api-reference/conversations/get-audio)
- [Data collection](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/data-collection) · [LLM models](https://elevenlabs.io/docs/eleven-agents/customization/llm) · [Custom Channel](https://elevenlabs.io/docs/eleven-agents/customization/integrations/custom_channel)
