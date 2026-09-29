# n8n-nodes-anybio

AnyBio community nodes for n8n: put AnyBio Govern between a workflow's AI step and the patient.

Maintained by AnyBio Engineering (platform@anybio.io), [developer.anybio.io](https://developer.anybio.io).

The **AnyBio Govern** node evaluates a draft under your Govern policy and routes it to one of three outputs, so a workflow branches without code: **Deliver**, **Show Hold Text** or **Send Nothing**. The record is written when the call returns. The **AnyBio Govern Trigger** node starts a workflow on a signed Govern webhook: a hold released or rejected, a hand-off opened, claimed, resolved or resumed.

The nodes follow the Govern contract (`/api/v1/govern`) and behave as the reference client `@anybio/govern` 0.2.1 does on the channel rule, the holding line and an unreachable API; the test suite runs the same cases against that package.

- [Install on self-hosted n8n](#install-on-self-hosted-n8n)
- [Credentials](#credentials)
- [AnyBio Govern](#anybio-govern)
- [The channel rule](#the-channel-rule)
- [The holding line](#the-holding-line)
- [When AnyBio cannot be reached](#when-anybio-cannot-be-reached)
- [AnyBio Govern Trigger](#anybio-govern-trigger)
- [Template: governed symptom follow-up on a reading](#template-governed-symptom-follow-up-on-a-reading)
- [The synthetic sandbox](#the-synthetic-sandbox)
- [Development](#development)
- [Releases](#releases)

## Install on self-hosted n8n

The package has no runtime dependencies. It needs a self-hosted n8n with community packages enabled; it was tested on n8n 2.40.7.

**From the editor.** Settings, Community Nodes, Install, then enter `n8n-nodes-anybio`.

**By hand** (queue mode, or an instance without the editor install):

```sh
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install n8n-nodes-anybio --omit=dev --omit=peer
# restart n8n
```

In the official Docker image `~/.n8n` is `/home/node/.n8n`. `--omit=peer` matters: `n8n-workflow` is provided by n8n itself, and installing it again pulls native build steps the image does not have.

**From a local build** (before the first npm release):

```sh
npm ci && npm run build && npm pack
cd ~/.n8n/nodes && npm install /path/to/n8n-nodes-anybio-0.1.0.tgz --omit=dev --omit=peer
```

## Credentials

One credential type, **AnyBio Govern API**, used by both nodes.

| Field | What it is |
|---|---|
| Environment | Sandbox (synthetic data only) or Production. An application key is bound to one application and one environment, so this labels every item the nodes emit; it does not change where requests go. |
| Application Key | The application key from the AnyBio console (`gk_...`). Sent only as `Authorization: Bearer`. |
| Application ID | Optional. The application's UUID; when set it is sent as `application_id`, and the API refuses a key that is not bound to it. |
| Base URL | Default `https://api.anybio.io`. Sandbox and production keys use the same host. |
| Webhook Signing Secret | For AnyBio Govern Trigger only: the application's `whsec_...` secret, shown once when the application is created or the secret is rotated. |

**Test** reads the application's webhook delivery log (`GET /api/v1/govern/webhook-deliveries`). It authenticates the key and writes nothing: testing a credential never creates a decision.

## AnyBio Govern

Four operations.

### Evaluate

`POST /api/v1/govern/evaluate`. In enforce the API decides inline (200); in observe it accepts the turn (202), the caller is told allow, and the gate's verdict lands on the record as `wouldHave`.

| Input | Notes |
|---|---|
| Draft Text | The message your AI step produced. Never put in an error or a log by the node. |
| Conversation ID | Your thread id, at most 187 characters. |
| Channel | SMS, Voice, Email (outbound) or Web Chat, App Message (in-session). |
| Audience | Patient or Clinician. SMS and Voice accept Patient only. |
| Patient Reference | Your opaque id; the API stores only its SHA-256. Consent, opt-out, the cap and hand-offs key on it. |
| Hold Message | The text Show Hold Text carries: your holding line (see below). |
| Turn ID (additional) | The idempotency key. Default: derived from the workflow, the execution, the node and the item (`n8n-` and 40 hex characters), so Retry On Fail within an execution replays the stored decision. A re-run execution has a new id: map your own message id here (the template uses the reading id) to make that replay too. |
| Model, Model Version (additional) | Recorded as sent; counted in the observe report. |
| Inbound Message, Inbound Received At (additional) | The patient's message this turn answers, for the red-flag screen. Requires Patient Reference. |
| Disclosure Reference (additional) | Optional; the API derives it from the conversation id. |

Three outputs:

| Output | When | `text` |
|---|---|---|
| **Deliver** | The decision is allow (including observe, and a channel that is off), or no decision came back (AnyBio unreachable, or the key refused) on a channel last seen in observe or off (`failOpen: true`, see [below](#when-anybio-cannot-be-reached)). | The draft, or for a clinician audience the gate's substitution when it returns one. A patient audience never receives rewritten text. |
| **Show Hold Text** | A hold or block where the hold message is to be shown now: every clinician hold; every patient hold on an in-session channel; a patient hold on an outbound channel when a holding line is owed. | The Hold Message. Never the draft. |
| **Send Nothing** | A hold or block on an outbound channel with no holding line owed, or no decision came back on an outbound channel last seen in enforce or never seen. | Empty. Connect nothing that messages the patient here. |

Every item carries: `output`, `text`, `decisionId`, `decision`, `mode`, `status`, `reasons` (codes, never text), `stopClass` (`never_sendable`, `uncertain` or null), `failOpen`, `held`, `sendHoldingLine`, `showHoldText`, `routeToHuman`, `handoff` and `handoffId`, `automationPaused`, `inboundFlags`, `wouldHave`, `accepted`, `disclosureRequired`, `reviewUrl`, `degraded`, `conversationId`, `turnId`, `channel`, `audience` and `environment`.

`routeToHuman` is independent of the output: an allowed draft can go to Deliver with `routeToHuman: true` (send it, and bring a person in). `automationPaused` applies the API's rule to the hand-off: `pauses_automation` and not yet resumed.

### Report Outcome

`POST /api/v1/govern/decisions/{id}/outcome`. Decision ID, Delivered, and the Delivered Text. The text is hashed in the node with SHA-256 and only the hash is sent, as the SDK does. One outcome per decision: the same report again is accepted, a different one is refused with 409. An item with no decision id (AnyBio was unreachable, so nothing was recorded) is passed through with `reported: false`.

### Record Disclosure

`POST /api/v1/govern/disclosures`. Conversation ID, Channel and the Text Shown, verbatim. Every patient-audience turn needs the AI-identity disclosure on record for its conversation, or the gate holds it with `disclosure_missing`. Once per conversation; a repeat returns the same evidence (`created: false`).

### Get Decision

`GET /api/v1/govern/decisions/{id}`: the decision with its current `reviewState` and, after a release, `releasedContent`. For a workflow that waits on a release by polling; AnyBio Govern Trigger is the push alternative.

Errors from any operation carry the HTTP status and the API's reason code, never message text. With **Continue On Fail**, an Evaluate item that failed goes to Send Nothing, never Deliver.

The node can also be attached to an AI Agent as a tool. As a tool it tells the agent the decision; it does not stand between the agent's reply and the patient. To gate what is sent, put AnyBio Govern inline, between the step that drafts and the step that sends.

## The channel rule

The rule is about contacting the patient, so it applies to the patient audience only.

- **In-session** (`web_chat`, `app_message`): the patient opened the session and is waiting in it. On every hold or block the hold text is the reply, including when AnyBio cannot be reached, and including on a replayed turn.
- **Outbound** (`sms`, `voice`, `email`, and any channel value this version does not know): a hold shows text only when `sendHoldingLine` is true. Otherwise nothing goes out.
- **Clinician audience**: every hold shows its notice, on every channel.

## The holding line

`send_holding_line` from the API means: this turn was stopped and the patient is waiting on a reply that is not coming, so send your holding line now. The holding line is fixed text your clinical owner wrote in advance, saying a person will reply, when, and what to do if it is urgent. It is never model-written, and AnyBio never sends it for you. Put it in **Hold Message**.

The API returns the flag on every read of a decision, so the node arms it **at most once per decision id**: the first read that carries it arms it, and every later read (a replayed turn, Get Decision, Report Outcome) answers false. The memory lives in the node's workflow static data and keeps the last 10,000 decision ids. It is never armed on an allow, on a released or rejected hold, or when the stop means this patient should not be messaged (`opted_out`, `consent_missing`, `consent_revoked`, `frequency_cap`) or nothing could be checked (`patient_state_unavailable`).

Two limits, stated plainly. n8n persists static data for production executions, not for manual test runs, so repeated test runs start with an empty memory. And two executions running at the same moment on the same decision read the memory before either saves it; a workflow that must be exact under that concurrency (queue mode with many workers) should record the send itself, keyed on the decision id, as the SDK documents for multi-process applications.

## When AnyBio cannot be reached

The node matches `@anybio/govern` 0.2.1 exactly here. There are two ways a turn can come back without a decision, and each carries its own reason:

- **Outage** (`gate_unavailable`): a timeout, a refused connection, a 5xx, a 408, or a 429 once the retries are spent (two by default, with jittered backoff; a 429 honours `Retry-After`). This heals on its own.
- **Refused or misconfigured key** (`client_misconfigured`): any other 4xx, such as a revoked key, a key not bound to the Application ID, or the wrong environment. This does not heal on its own and is the workflow's to fix.

What happens next depends on the mode the node last saw for the application and the channel, whichever the cause:

- **Last seen in observe or off:** the draft goes to **Deliver**, because observe and off never block a message. The item carries `failOpen: true`, `decision: "allow"`, the remembered `mode` (`"observe"` or `"off"`), `degraded: true`, `reasons: ["gate_unavailable"]` or `reasons: ["client_misconfigured"]`, and no decision id. Nothing was recorded for the turn, and Report Outcome passes it through unreported.
- **Last seen in enforce, or never seen:** fails closed. The node treats the turn as a hold with `mode: "enforce"`, the same reason, `degraded: true`, `failOpen: false` and no decision id. The channel rule decides the output: on an outbound channel the item goes to Send Nothing; in session it goes to Show Hold Text; for a clinician, Show Hold Text. No holding line is armed, because no patient state was read.

**A refused key is shown as a warning.** Whenever any item in an execution comes back `client_misconfigured`, the node adds one warning hint to that execution's output pane in n8n, saying how many items were refused, how many went to Deliver without a decision and how many held, and to check the credential (Application Key, Application ID, environment). The run does not fail, and the item keeps `client_misconfigured` in `reasons`, so a workflow can branch or alert on it. The warning carries counts and reason codes only, never message text. n8n versions without execution hints skip the warning and route the same way.

**How the mode is learned.** Every decision the API returns (Evaluate, Get Decision, Report Outcome) records its `mode` for its application and channel, and the latest one wins, so a channel moved from observe to enforce fails closed from its next decision on. The application is the credential's Application ID when it is set, otherwise the n8n credential. The memory lives in the node's workflow static data, beside the holding-line memory, and keeps the last 1,000 application and channel pairs.

**Limits.** n8n persists static data for production executions, not for manual test runs, so a test run starts with an empty memory and every channel reads as never seen: a turn without a decision during a test run always fails closed. The memory is per node, so two AnyBio Govern nodes learn separately. After an import or a new node, the first failure before any decision has been seen fails closed.

## AnyBio Govern Trigger

A webhook trigger. Govern sends a signed `POST` to the application's webhook URL when a reviewer releases or rejects a held decision and when a hand-off changes state.

**Registering the URL.** Copy the node's Production URL into the application's webhook URL in the AnyBio console. The application key cannot change it (the management routes need an organization admin), so the node does not register or remove it for you. The URL must be public `https`; AnyBio refuses private and loopback addresses.

**Verification.** Every delivery is verified before anything is parsed, exactly as `@anybio/govern` does: `X-Govern-Signature` must carry `v1=` and the lowercase hex HMAC-SHA256 of `"{X-Govern-Timestamp}.{raw body}"` under the credential's signing secret, compared in constant time, and the timestamp must be within five minutes (configurable; 0 accepts any age). An unsigned, stale, tampered or mis-signed delivery is answered 401 and starts nothing. A credential with no signing secret is answered 500: that is the receiver's configuration, not the sender's fault.

**Events.**

| Option | Event |
|---|---|
| Hold Released | `decision.released`: `releasedContent` is what to deliver |
| Hold Rejected | `decision.rejected`: nothing is released; `stopClass` says why |
| Hand-Off Opened | `handoff.opened` |
| Hand-Off Claimed | `handoff.claimed` |
| Hand-Off Resolved | `handoff.resolved` |
| Automation Resumed | `handoff.resumed` |

Hand-off events carry `pausesAutomation` (absent reads as true, as in the SDK) and `automationPaused`, the helper's rule applied to the event: pausing and not resumed. The option **Only Hand-Offs That Pause Automation** starts the workflow for a hand-off event only while it pauses automated messaging. A verified event you did not select is acknowledged with 200 so the sender does not retry. Every item carries `deliveryId` (the same id on every retry of one delivery) for your own de-duplication.

## Template: governed symptom follow-up on a reading

[`templates/governed-symptom-follow-up-on-a-reading.json`](templates/governed-symptom-follow-up-on-a-reading.json). Import it from the editor (Workflows, Import from File) or with `n8n import:workflow --input=...`.

Reading In (Webhook) → Record Disclosure → Draft Follow-up (LLM chain with a chat model) → **AnyBio Govern** (Evaluate, SMS, patient) → Deliver and Show Hold Text → Send SMS → Report Delivered; Send Nothing → Report Not Sent.

Sticky notes explain each step. The Webhook carries pinned synthetic test data, and every phone number in it is a fictional 555-01xx number. Set three credentials: AnyBio Govern (a sandbox key), your chat model, and your SMS provider.

## The synthetic sandbox

Use a sandbox application key with synthetic patients only: no PHI, no BAA. The sandbox runs on the same API host as production; the key decides the environment. Set the credential's Environment to Sandbox so every item says so.

## Development

```sh
npm ci
npm run build       # n8n-node build
npm test            # vitest: the channel rule, the holding line, an unreachable API, signatures, the node contexts, the template
npm run typecheck   # the tests, type-checked
npm run lint        # n8n-node lint, strict (n8n Cloud rules)
npm run dev         # n8n with this package loaded (needs Docker or Podman)
```

Source layout: `credentials/` (the credential), `nodes/AnyBioGovern`, `nodes/AnyBioGovernTrigger`, `nodes/shared/govern.ts` (the contract: channel rule, holding line, decision mapping, retries), `nodes/shared/webhook.ts` (signature verification), `test/`, `templates/`.

`@anybio/govern` is a devDependency only: the parity tests run the SDK and the node on the same cases. Nothing from it ships.

## Releases

Releases are published to npm from GitHub Actions with a provenance statement, from version tags only. To release, set the version in `package.json`, push a matching `v*.*.*` tag, and approve the run in the `npm-publish` environment. The workflow checks that the tag matches the version, then lints, builds, tests and publishes.

## License

MIT. See [LICENSE](LICENSE).
