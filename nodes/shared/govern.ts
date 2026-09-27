/**
 * The Govern contract as the n8n nodes apply it.
 *
 * A port of the parts of `@anybio/govern` 0.2.1 the nodes need, with no
 * runtime dependency: verified n8n community nodes may not carry any. The
 * rules here (the channel rule, the once-per-decision holding line, the
 * decision mapping, the retry policy) mirror `src/client.ts`, `src/types.ts`
 * and `src/http.ts` of that release, and the tests in `test/` run the same
 * cases that package's `channel-rule`, `holding-line`, `guard` and `degrade`
 * tests run.
 *
 * Nothing in this module logs, and no error it raises carries message text:
 * not the draft, not the inbound, not the hold message.
 */

import { createHash } from 'crypto';

export const DEFAULT_BASE_URL = 'https://api.anybio.io';
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RETRIES = 2;

/** What the patient sees on a hold when the workflow does not supply its own holding line. Same text as the SDK. */
export const DEFAULT_HOLD_MESSAGE =
	'Thanks for your message. A person from our team will review it and follow up with you shortly.';

/** Turn ids starting with this are the API's own; the API refuses one from a caller. */
export const RESERVED_TURN_ID_PREFIX = 'govern:';
/** Longest `conversation_id` the API accepts, in code points. */
export const MAX_CONVERSATION_ID_CHARS = 187;
/** Longest `turn_id` the API accepts, in code points. */
export const MAX_TURN_ID_CHARS = 206;
/** How many decision ids the holding-line memory keeps. The SDK's bound. */
export const HOLDING_LINE_MEMORY_MAX = 10_000;
/** How many (application, channel) pairs the mode memory keeps. */
export const MODE_MEMORY_MAX = 1_000;

export const GOVERN_PATHS = {
	evaluate: '/api/v1/govern/evaluate',
	decision: (id: string) => `/api/v1/govern/decisions/${encodeURIComponent(id)}`,
	outcome: (id: string) => `/api/v1/govern/decisions/${encodeURIComponent(id)}/outcome`,
	disclosures: '/api/v1/govern/disclosures',
	webhookDeliveries: '/api/v1/govern/webhook-deliveries',
} as const;

export type Channel = 'sms' | 'app_message' | 'web_chat' | 'voice' | 'email';
export type Audience = 'patient' | 'clinician';
export type Mode = 'off' | 'observe' | 'enforce';
export type DecisionVerdict = 'allow' | 'hold' | 'block' | 'route_to_human';
export type StopClass = 'never_sendable' | 'uncertain';

export const CHANNELS: readonly Channel[] = ['sms', 'app_message', 'web_chat', 'voice', 'email'];
export const AUDIENCES: readonly Audience[] = ['patient', 'clinician'];

/**
 * The in-session channels: the patient opened the session and is waiting in
 * it, so a reply there answers them. Every other channel is outbound.
 */
export const IN_SESSION_CHANNELS: readonly Channel[] = ['web_chat', 'app_message'];

/**
 * Whether a channel is in-session (`web_chat`, `app_message`). Everything else,
 * `sms`, `voice`, `email` and any value this version does not know, is
 * outbound, and an unknown channel fails closed that way.
 */
export function isInSessionChannel(channel: unknown): boolean {
	return (
		typeof channel === 'string' && (IN_SESSION_CHANNELS as readonly string[]).includes(channel)
	);
}

/** Reason codes. Safe to log; never patient text. */
export const REASONS = {
	gateUnavailable: 'gate_unavailable',
	optedOut: 'opted_out',
	consentMissing: 'consent_missing',
	consentRevoked: 'consent_revoked',
	frequencyCap: 'frequency_cap',
	patientStateUnavailable: 'patient_state_unavailable',
	/** Node-side, as in the SDK: the API answered and refused the call, and would refuse it again. */
	clientMisconfigured: 'client_misconfigured',
	/** Node-side, as in the SDK: the server sent a decision value this version does not know. */
	unknownDecision: 'unknown_decision',
} as const;

/** Reasons on which the contract says another message is the wrong thing, not merely an unnecessary one. */
const NO_HOLDING_LINE: ReadonlySet<string> = new Set([
	REASONS.optedOut,
	REASONS.consentMissing,
	REASONS.consentRevoked,
	REASONS.frequencyCap,
	REASONS.patientStateUnavailable,
]);

const KNOWN_VERDICTS: ReadonlySet<string> = new Set(['allow', 'hold', 'block', 'route_to_human']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 408 and 429 mean "later", not "no". */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429]);

// ---------------------------------------------------------------------------
// Errors. Messages carry status codes and reason codes, never message text.
// ---------------------------------------------------------------------------

/** The call cannot be made as configured: the workflow's to fix, and never degraded into a hold. */
export class GovernConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GovernConfigError';
	}
}

/** The API answered with a non-2xx status. */
export class GovernApiError extends Error {
	readonly status: number;
	readonly kind: string | null;
	readonly retryable: boolean;

	constructor(status: number, kind: string | null, serverMessage: string | null) {
		const detail = [kind, serverMessage].filter((part) => typeof part === 'string' && part !== '');
		super(
			`AnyBio Govern API answered ${status}${detail.length > 0 ? `: ${detail.join(': ')}` : ''}`,
		);
		this.name = 'GovernApiError';
		this.status = status;
		this.kind = kind;
		this.retryable = status === 429 || status >= 500;
	}
}

/** No response arrived: a timeout, a refused connection, a DNS failure. */
export class GovernNetworkError extends Error {
	readonly code: string | null;

	constructor(code: string | null) {
		super(`AnyBio Govern API could not be reached${code ? ` (${code})` : ''}; no response arrived`);
		this.name = 'GovernNetworkError';
		this.code = code;
	}
}

/**
 * Did the API answer, and refuse the call in a way that asking again will not
 * change? The SDK's rule: a 4xx other than 408 and 429.
 */
export function isClientMisconfiguration(error: unknown): boolean {
	if (!(error instanceof GovernApiError)) return false;
	if (error.status < 400 || error.status >= 500) return false;
	return !TRANSIENT_HTTP_STATUSES.has(error.status);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TransportRequest {
	method: 'GET' | 'POST';
	path: string;
	query?: Record<string, string>;
	body?: Record<string, unknown>;
	idempotencyKey?: string;
}

export interface TransportResponse {
	status: number;
	body: unknown;
	/** The `Retry-After` header, when there was one. */
	retryAfter?: string | null;
}

/**
 * One attempt. Resolves with the status and parsed body for any HTTP answer,
 * including a 4xx or 5xx; rejects only when no answer arrived. The rejection
 * is replaced by a `GovernNetworkError` here, so whatever the HTTP client
 * attached to it (its request options, the body with the draft in it) never
 * reaches an error message.
 */
export type SendOnce = (request: TransportRequest) => Promise<TransportResponse>;

export interface RetryPolicy {
	maxRetries: number;
	sleep: (ms: number) => Promise<void>;
	random?: () => number;
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 5_000;
const RETRY_AFTER_MAX_MS = 30_000;

/** Full-jitter exponential backoff, as the SDK: uniform in [0, min(5 s, 250 ms * 2^(attempt-1))]. */
export function backoff(attempt: number, random: () => number = Math.random): number {
	const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
	return Math.round(random() * ceiling);
}

/** `Retry-After` as seconds or an HTTP date, clamped to [0, 30 s]. */
export function parseRetryAfter(
	header: string | null | undefined,
	nowMs: number = Date.now(),
): number | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, RETRY_AFTER_MAX_MS);
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return null;
	return Math.max(0, Math.min(at - nowMs, RETRY_AFTER_MAX_MS));
}

function networkCode(error: unknown): string | null {
	if (error && typeof error === 'object') {
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
	}
	return null;
}

function readServerError(body: unknown): { kind: string | null; message: string | null } {
	if (!body || typeof body !== 'object') return { kind: null, message: null };
	const parsed = body as Record<string, unknown>;
	const kind = typeof parsed.kind === 'string' ? parsed.kind : null;
	const message =
		typeof parsed.error_message === 'string'
			? parsed.error_message
			: typeof parsed.error === 'string'
				? parsed.error
				: typeof parsed.message === 'string'
					? parsed.message
					: null;
	return { kind, message };
}

/**
 * Send with the SDK's retry policy: retries on 429 (honouring `Retry-After`),
 * 5xx, timeouts and network failures; never on any other 4xx.
 */
export async function send(
	sendOnce: SendOnce,
	request: TransportRequest,
	policy: RetryPolicy,
): Promise<TransportResponse> {
	const attempts = Math.max(0, policy.maxRetries) + 1;
	let lastError: Error = new GovernNetworkError(null);
	for (let attempt = 1; attempt <= attempts; attempt++) {
		let response: TransportResponse | null = null;
		let transportFailure: unknown = null;
		try {
			response = await sendOnce(request);
		} catch (error) {
			transportFailure = error;
		}
		if (response === null) {
			lastError = new GovernNetworkError(networkCode(transportFailure));
			if (attempt < attempts) {
				await policy.sleep(backoff(attempt, policy.random));
				continue;
			}
			throw lastError;
		}
		if (response.status >= 200 && response.status < 300) return response;
		const { kind, message } = readServerError(response.body);
		const failure = new GovernApiError(response.status, kind, message);
		lastError = failure;
		if (failure.retryable && attempt < attempts) {
			const retryAfterMs =
				response.status === 429 ? parseRetryAfter(response.retryAfter ?? null) : null;
			await policy.sleep(retryAfterMs ?? backoff(attempt, policy.random));
			continue;
		}
		throw failure;
	}
	throw lastError;
}

// ---------------------------------------------------------------------------
// Validation (checked here, as the SDK does, so the field is named)
// ---------------------------------------------------------------------------

function codePoints(value: string): number {
	return [...value].length;
}

export function requireText(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new GovernConfigError(`${name} is required and must be a non-empty string.`);
	}
	return value;
}

export function requireConversationId(value: unknown, name = 'Conversation ID'): string {
	const text = requireText(value, name);
	if (codePoints(text.trim()) > MAX_CONVERSATION_ID_CHARS) {
		throw new GovernConfigError(
			`${name} must be at most ${MAX_CONVERSATION_ID_CHARS} characters. The API composes the conversation's disclosure reference from it, and that reference is bounded.`,
		);
	}
	return text;
}

export function requireTurnId(value: unknown, name = 'Turn ID'): string {
	const text = requireText(value, name);
	const trimmed = text.trim();
	if (trimmed.startsWith(RESERVED_TURN_ID_PREFIX)) {
		throw new GovernConfigError(
			`${name} must not start with "${RESERVED_TURN_ID_PREFIX}", which is reserved for the rows the API writes itself.`,
		);
	}
	if (codePoints(trimmed) > MAX_TURN_ID_CHARS) {
		throw new GovernConfigError(
			`${name} must be at most ${MAX_TURN_ID_CHARS} characters. The API composes the turn's reference from it, and that reference is bounded.`,
		);
	}
	return text;
}

export function applicationIdFrom(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return UUID.test(trimmed) ? trimmed.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Hashing and identifiers
// ---------------------------------------------------------------------------

/** SHA-256 over the UTF-8 bytes of `text`, lowercase hex: the outcome hash the API expects. */
export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface TurnIdSource {
	workflowId: string;
	executionId: string;
	nodeName: string;
	itemIndex: number;
}

/**
 * The default turn id: derived from the workflow, the execution, the node and
 * the item, so a node that is re-run within the same execution (Retry On
 * Fail) replays the stored decision instead of evaluating a second turn. It is
 * never in the reserved `govern:` range and always inside the length bound.
 */
export function deriveTurnId(source: TurnIdSource): string {
	const material = [
		source.workflowId,
		source.executionId,
		source.nodeName,
		String(source.itemIndex),
	].join('\u0000');
	return `n8n-${sha256Hex(material).slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface InboundFlag {
	ruleId: string;
	category: string;
}

export interface HandoffRef {
	id: string;
	state: string;
	version: number;
	queueLabel: string;
	assignedTo: string | null;
	dueAt: string | null;
	escalationDueAt: string | null;
	resolvedAt: string | null;
	automationResumedAt: string | null;
	pausesAutomation: boolean;
}

export interface Outcome {
	delivered: boolean;
	deliveredAt: string;
	deliveredContentHash: string | null;
	deliveryRef: string | null;
	recordedAt: string;
	hashMatchesRelease: boolean | null;
}

export interface Decision {
	id: string | null;
	status: string;
	decision: DecisionVerdict;
	mode: Mode;
	channel: string;
	audience: string;
	conversationId: string;
	turnId: string;
	wouldHave: string | null;
	policy: { id: string; name: string; version: number } | null;
	reasons: string[];
	rationale: string | null;
	detectedClaims: string[];
	disclosureRequired: boolean;
	reviewUrl: string | null;
	reviewState: string | null;
	deliverableContent: string | null;
	releasedContent: string | null;
	stopClass: StopClass | null;
	sendHoldingLine: boolean;
	model: string | null;
	modelVersion: string | null;
	createdAt: string | null;
	decidedAt: string | null;
	reviewedAt: string | null;
	outcome: Outcome | null;
	routeToHuman: boolean;
	wouldHaveRouted: boolean;
	inboundFlags: InboundFlag[];
	handoff: HandoffRef | null;
	unknownDecision: string | null;
	accepted: boolean;
	degraded: boolean;
	/** The API's own `send_holding_line`, unfiltered. */
	apiSendHoldingLine: boolean;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A class this version does not know reads as `uncertain`, the releasable one, as in the SDK. */
export function toStopClass(value: unknown): StopClass | null {
	if (value === null || value === undefined) return null;
	return value === 'never_sendable' ? 'never_sendable' : 'uncertain';
}

function toInboundFlags(value: unknown): InboundFlag[] {
	if (!Array.isArray(value)) return [];
	const out: InboundFlag[] = [];
	for (const item of value) {
		if (item && typeof item === 'object') {
			const flag = item as Record<string, unknown>;
			out.push({ ruleId: str(flag.rule_id) ?? '', category: str(flag.category) ?? '' });
		}
	}
	return out;
}

export function toHandoffRef(value: unknown): HandoffRef | null {
	if (!value || typeof value !== 'object') return null;
	const h = value as Record<string, unknown>;
	if (typeof h.id !== 'string') return null;
	return {
		id: h.id,
		state: str(h.state) ?? '',
		version: typeof h.version === 'number' ? h.version : 0,
		queueLabel: str(h.queue_label) ?? '',
		assignedTo: str(h.assigned_to),
		dueAt: str(h.due_at),
		escalationDueAt: str(h.escalation_due_at),
		resolvedAt: str(h.resolved_at),
		automationResumedAt: str(h.automation_resumed_at),
		// Absent only from a server that predates the field, where every open
		// hand-off paused automation.
		pausesAutomation: h.pauses_automation !== false,
	};
}

/**
 * Whether automated messaging to this hand-off's patient is paused now: the
 * API's rule, `pauses_automation && automation_resumed_at == null`. Reads a
 * `HandoffRef` or a wire row; a wire row without `pauses_automation` reads as
 * paused while it is not resumed.
 */
export function isAutomationPaused(
	handoff: HandoffRef | Record<string, unknown> | null | undefined,
): boolean {
	if (!handoff) return false;
	if ('pausesAutomation' in handoff) {
		const ref = handoff as HandoffRef;
		return ref.pausesAutomation && ref.automationResumedAt == null;
	}
	const wire = handoff as { pauses_automation?: unknown; automation_resumed_at?: unknown };
	return wire.pauses_automation !== false && wire.automation_resumed_at == null;
}

function toOutcome(value: unknown): Outcome | null {
	if (!value || typeof value !== 'object') return null;
	const o = value as Record<string, unknown>;
	return {
		delivered: o.delivered === true,
		deliveredAt: str(o.delivered_at) ?? '',
		deliveredContentHash: str(o.delivered_content_hash),
		deliveryRef: str(o.delivery_ref),
		recordedAt: str(o.recorded_at) ?? '',
		hashMatchesRelease: typeof o.hash_matches_release === 'boolean' ? o.hash_matches_release : null,
	};
}

/** The wire decision view as the node presents it. Unknown verdicts normalise fail closed in enforce. */
export function toDecision(wireValue: unknown, accepted: boolean): Decision {
	const wire = (wireValue && typeof wireValue === 'object' ? wireValue : {}) as Record<
		string,
		unknown
	>;
	const rawVerdict = String(wire.decision);
	const known = KNOWN_VERDICTS.has(rawVerdict);
	const mode = (str(wire.mode) ?? 'enforce') as Mode;
	const failOpen = mode === 'observe' || mode === 'off';
	const decision: DecisionVerdict = known
		? (rawVerdict as DecisionVerdict)
		: failOpen
			? 'allow'
			: 'hold';
	const policy =
		wire.policy && typeof wire.policy === 'object'
			? (wire.policy as { id: string; name: string; version: number })
			: null;
	const audience = str(wire.audience) ?? '';
	return {
		id: str(wire.decision_id),
		status: str(wire.status) ?? '',
		decision,
		mode,
		channel: str(wire.channel) ?? '',
		audience,
		conversationId: str(wire.conversation_id) ?? '',
		turnId: str(wire.turn_id) ?? '',
		wouldHave: str(wire.would_have),
		policy: policy ? { id: policy.id, name: policy.name, version: policy.version } : null,
		reasons: Array.isArray(wire.reasons) ? wire.reasons.filter((r) => typeof r === 'string') : [],
		rationale: str(wire.rationale),
		detectedClaims: Array.isArray(wire.detected_claims)
			? wire.detected_claims.filter((c) => typeof c === 'string')
			: [],
		disclosureRequired: wire.disclosure_required === true,
		reviewUrl: str(wire.review_url),
		reviewState: str(wire.review_state),
		// A patient audience never receives text from this field, whatever the server sends.
		deliverableContent: audience === 'clinician' ? str(wire.deliverable_content) : null,
		releasedContent: str(wire.released_content),
		stopClass: toStopClass(wire.stop_class),
		sendHoldingLine: wire.send_holding_line === true,
		model: str(wire.model),
		modelVersion: str(wire.model_version),
		createdAt: str(wire.created_at),
		decidedAt: str(wire.decided_at),
		reviewedAt: str(wire.reviewed_at),
		outcome: toOutcome(wire.outcome),
		routeToHuman: wire.route_to_human === true,
		wouldHaveRouted: wire.would_have_routed === true,
		inboundFlags: toInboundFlags(wire.inbound_flags),
		handoff: toHandoffRef(wire.handoff),
		unknownDecision: known ? null : rawVerdict,
		accepted,
		degraded: !known,
		apiSendHoldingLine: wire.send_holding_line === true,
	};
}

/** The API's conditions for a holding line, checked again on this side. */
export function holdingLineApplies(decision: Decision): boolean {
	if (decision.decision === 'allow') return false;
	if (decision.audience !== 'patient') return false;
	if (decision.reviewState === 'released' || decision.reviewState === 'rejected') return false;
	return !decision.reasons.some((reason) => NO_HOLDING_LINE.has(reason));
}

// ---------------------------------------------------------------------------
// The holding-line memory
// ---------------------------------------------------------------------------

/**
 * Decision ids whose holding line has already been armed. Backed by a plain
 * string array so it can live in the workflow's static data; insertion
 * ordered, and the oldest id is evicted past the bound, as in the SDK.
 */
export class HoldingLineMemory {
	private readonly index: Set<string>;

	constructor(
		private readonly ids: string[],
		private readonly max: number = HOLDING_LINE_MEMORY_MAX,
	) {
		this.index = new Set(ids);
	}

	has(id: string): boolean {
		return this.index.has(id);
	}

	add(id: string): void {
		if (this.index.has(id)) {
			const at = this.ids.indexOf(id);
			if (at !== -1) this.ids.splice(at, 1);
		}
		this.ids.push(id);
		this.index.add(id);
		if (this.ids.length > this.max) {
			for (const evicted of this.ids.splice(0, this.ids.length - this.max)) {
				this.index.delete(evicted);
			}
		}
	}

	get size(): number {
		return this.ids.length;
	}
}

// ---------------------------------------------------------------------------
// The mode memory
// ---------------------------------------------------------------------------

const MODES: ReadonlySet<string> = new Set(['off', 'observe', 'enforce']);

/**
 * The mode last seen per application and channel, learned from every decision
 * the API returns. `SDK: Govern.modes`, `lastKnownMode`, `rememberMode`; the
 * SDK keys on the channel alone because one client is one application, and a
 * node can be pointed at another application by its credential, so here the
 * key carries the application too.
 *
 * Backed by a plain object so it can live in the workflow's static data;
 * insertion ordered (a re-learned pair moves to the end), and the oldest pair
 * is evicted past the bound. An application of `null` has no identity to key
 * on: nothing is learned or recalled for it, so every channel reads as never
 * seen, which fails closed.
 */
export class ModeMemory {
	constructor(
		private readonly entries: Record<string, string>,
		private readonly application: string | null,
		private readonly max: number = MODE_MEMORY_MAX,
	) {}

	private key(channel: string): string | null {
		return this.application === null ? null : `${this.application}|${channel}`;
	}

	/** The mode last seen for this application and channel, or undefined when never seen. */
	lastKnownMode(channel: string): Mode | undefined {
		const key = this.key(channel);
		if (key === null) return undefined;
		const mode = this.entries[key];
		return typeof mode === 'string' && MODES.has(mode) ? (mode as Mode) : undefined;
	}

	remember(channel: string, mode: Mode): void {
		const key = this.key(channel);
		if (key === null || channel === '' || !MODES.has(mode)) return;
		delete this.entries[key];
		this.entries[key] = mode;
		const keys = Object.keys(this.entries);
		for (const evicted of keys.slice(0, Math.max(0, keys.length - this.max))) {
			delete this.entries[evicted];
		}
	}

	get size(): number {
		return Object.keys(this.entries).length;
	}
}

/** A memory that learns nothing: every channel reads as never seen, so an outage fails closed. */
export function emptyModeMemory(): ModeMemory {
	return new ModeMemory({}, null);
}

/**
 * Every decision the API returns passes through here: the channel's mode is
 * learned, and the holding line is armed at most once per decision id. The
 * first read that carries the flag arms it; every later read answers false.
 * An outcome report (`arm: false`) never arms it but counts as having seen the
 * decision. `SDK: Govern.read`.
 */
export function readDecision(
	decision: Decision,
	memory: HoldingLineMemory,
	options: { arm: boolean } = { arm: true },
	modes: ModeMemory = emptyModeMemory(),
): Decision {
	// SDK: `this.modes.set(decision.channel, decision.mode)`.
	modes.remember(decision.channel, decision.mode);
	const id = decision.id;
	if (!decision.sendHoldingLine || !id) return decision;
	const eligible = options.arm && holdingLineApplies(decision) && !memory.has(id);
	memory.add(id);
	return eligible ? decision : { ...decision, sendHoldingLine: false };
}

// ---------------------------------------------------------------------------
// The gate: evaluate one turn and say which output it goes to
// ---------------------------------------------------------------------------

export type GateOutput = 'deliver' | 'showHoldText' | 'sendNothing';

export const GATE_OUTPUT_INDEX: Record<GateOutput, number> = {
	deliver: 0,
	showHoldText: 1,
	sendNothing: 2,
};

export interface EvaluateInput {
	conversationId: string;
	turnId: string;
	channel: string;
	audience: string;
	draft: string;
	patientRef?: string;
	model?: string;
	modelVersion?: string;
	inbound?: { content: string; receivedAt: string };
	disclosureRef?: string;
	applicationId?: string | null;
	holdMessage: string;
}

export interface GateResult {
	output: GateOutput;
	/** On deliver: the draft (or a clinician substitution). On show hold text: the hold message. On send nothing: empty. */
	text: string;
	decisionId: string | null;
	decision: DecisionVerdict;
	mode: Mode;
	status: string | null;
	degraded: boolean;
	/**
	 * True only when no decision was returned (AnyBio could not be reached, or
	 * refused the key) and the channel was last seen in observe or off, so the
	 * draft went to Deliver without a decision. There is no decision id and
	 * nothing was recorded for the turn.
	 */
	failOpen: boolean;
	held: boolean;
	reasons: string[];
	sendHoldingLine: boolean;
	showHoldText: boolean;
	stopClass: StopClass | null;
	routeToHuman: boolean;
	handoff: HandoffRef | null;
	handoffId: string | null;
	automationPaused: boolean;
	inboundFlags: InboundFlag[];
	wouldHave: string | null;
	accepted: boolean;
	disclosureRequired: boolean;
	reviewUrl: string | null;
	conversationId: string;
	turnId: string;
	channel: string;
	audience: string;
}

export function buildEvaluateBody(input: EvaluateInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		conversation_id: input.conversationId,
		turn_id: input.turnId,
		channel: input.channel,
		audience: input.audience,
		content: input.draft,
	};
	if (input.applicationId) body.application_id = input.applicationId;
	const patientRef = input.patientRef?.trim();
	if (patientRef) body.patient_ref = patientRef;
	const disclosureRef = input.disclosureRef?.trim();
	if (disclosureRef) body.disclosure = { established: true, ref: disclosureRef };
	if (input.inbound && input.inbound.content.trim() !== '') {
		body.inbound = { content: input.inbound.content, received_at: input.inbound.receivedAt };
	}
	// Blank is absent: the API refuses a blank identifier with a 400.
	const model = input.model?.trim();
	if (model) body.model = model;
	const modelVersion = input.modelVersion?.trim();
	if (modelVersion) body.model_version = modelVersion;
	return body;
}

/**
 * Evaluate one turn and route it. `SDK: Govern.guard`, less the draft
 * function and the automatic outcome report.
 *
 * When no decision comes back, the mode last seen for this application and
 * channel decides, exactly as in the SDK: a channel last seen in observe or
 * off never blocks, so the draft goes to Deliver flagged `failOpen` and
 * `degraded`, with the remembered mode and the cause as the only reason
 * (`gate_unavailable` for an outage, `client_misconfigured` for a refused or
 * misconfigured key); enforce, or a channel never seen, fails closed with the
 * same reason.
 *
 * Throws `GovernConfigError` for a call that cannot be made as configured
 * (the identifiers, an empty draft); every other failure becomes a hold, or,
 * in observe or off, the fail-open delivery above.
 */
export async function evaluateTurn(
	sendOnce: SendOnce,
	policy: RetryPolicy,
	memory: HoldingLineMemory,
	input: EvaluateInput,
	modes: ModeMemory = emptyModeMemory(),
): Promise<GateResult> {
	requireConversationId(input.conversationId);
	requireTurnId(input.turnId);
	requireText(input.draft, 'Draft Text');
	requireText(input.channel, 'Channel');
	requireText(input.audience, 'Audience');
	if (input.inbound && input.inbound.content.trim() !== '' && !input.patientRef?.trim()) {
		throw new GovernConfigError(
			'Patient Reference is required when an inbound message is sent: the hand-off a red flag opens is keyed on it.',
		);
	}

	let record: Decision | null = null;
	let degradeCause: string = REASONS.gateUnavailable;
	let failure: unknown = null;
	try {
		const response = await send(
			sendOnce,
			{
				method: 'POST',
				path: GOVERN_PATHS.evaluate,
				body: buildEvaluateBody(input),
				idempotencyKey: input.turnId,
			},
			policy,
		);
		record = readDecision(
			toDecision(response.body, response.status === 202),
			memory,
			{ arm: true },
			modes,
		);
	} catch (error) {
		failure = error;
	}
	if (failure !== null) {
		degradeCause = isClientMisconfiguration(failure)
			? REASONS.clientMisconfigured
			: REASONS.gateUnavailable;
	}

	let decision: DecisionVerdict;
	let reasons: string[];
	let mode: Mode;
	let text: string;
	let failOpen = false;
	// SDK: `const learned = this.modes.get(ctx.channel)`, read only on failure.
	const learned = record ? undefined : modes.lastKnownMode(input.channel);
	if (record) {
		decision = record.decision;
		mode = record.mode;
		reasons = record.unknownDecision
			? [...record.reasons, REASONS.unknownDecision]
			: [...record.reasons];
		if (decision === 'allow') {
			text =
				record.audience === 'clinician' && record.deliverableContent
					? record.deliverableContent
					: input.draft;
		} else {
			// hold, block, route_to_human as a decision value, or an unknown value
			// normalised to hold: nothing but the hold message goes out.
			text = input.holdMessage;
		}
	} else if (learned !== undefined && learned !== 'enforce') {
		// SDK: `mode = learned ?? this.assumeMode`, then its final branch,
		// `decision = "allow"; text = draft; reasons = [degradeCause]`, taken for
		// every mode but enforce and for either cause. Observe and off never
		// block, so an outage or a refused key does not block either. Nothing is
		// recorded.
		failOpen = true;
		decision = 'allow';
		mode = learned;
		reasons = [degradeCause];
		text = input.draft;
	} else {
		// SDK: `else if (mode === "enforce")`, fail closed. A channel never seen
		// is enforce, the SDK's default `assumeMode`. Only the reason says whose
		// problem it is.
		decision = 'hold';
		mode = 'enforce';
		reasons = [degradeCause];
		text = input.holdMessage;
	}

	const held = decision !== 'allow';
	// Only the API can say a holding line is owed: only the API read the
	// patient's state. A node-side fail-closed hold read nothing.
	const sendHoldingLine = held && record !== null && record.sendHoldingLine;
	// The channel rule is about contacting the patient, so it applies to the
	// patient audience only; a clinician hold always shows its notice.
	const showHoldText =
		held && (input.audience !== 'patient' || isInSessionChannel(input.channel) || sendHoldingLine);
	if (held && !showHoldText) text = '';
	const output: GateOutput = !held ? 'deliver' : showHoldText ? 'showHoldText' : 'sendNothing';
	const handoff = record?.handoff ?? null;

	return {
		output,
		text,
		decisionId: record?.id ?? null,
		decision,
		mode,
		status: record?.status ?? null,
		degraded: record ? record.degraded : true,
		failOpen,
		held,
		reasons,
		sendHoldingLine,
		showHoldText,
		stopClass: record?.stopClass ?? null,
		routeToHuman: record ? record.routeToHuman || record.decision === 'route_to_human' : false,
		handoff,
		handoffId: handoff?.id ?? null,
		automationPaused: isAutomationPaused(handoff),
		inboundFlags: record?.inboundFlags ?? [],
		wouldHave: record?.wouldHave ?? null,
		accepted: record?.accepted ?? false,
		disclosureRequired: record?.disclosureRequired ?? false,
		reviewUrl: record?.reviewUrl ?? null,
		conversationId: input.conversationId,
		turnId: input.turnId,
		channel: input.channel,
		audience: input.audience,
	};
}

// ---------------------------------------------------------------------------
// The other operations
// ---------------------------------------------------------------------------

export interface ReportOutcomeInput {
	decisionId: string;
	delivered: boolean;
	/** The text that went out. Hashed here; only the hash is sent. */
	content?: string;
	deliveredAt?: string;
	deliveryRef?: string;
}

/** The outcome body. The delivered text is hashed locally with SHA-256 and never sent. */
export function buildOutcomeBody(input: ReportOutcomeInput, now: () => Date = () => new Date()) {
	const body: Record<string, unknown> = {
		delivered: input.delivered,
		delivered_at: input.deliveredAt?.trim() || now().toISOString(),
	};
	if (input.delivered) {
		if (typeof input.content !== 'string') {
			throw new GovernConfigError(
				'Delivered Text is required when Delivered is on: it is hashed locally and only the hash is sent.',
			);
		}
		body.delivered_content_hash = sha256Hex(input.content);
	}
	const deliveryRef = input.deliveryRef?.trim();
	if (deliveryRef) body.delivery_ref = deliveryRef;
	return body;
}

export async function reportOutcome(
	sendOnce: SendOnce,
	policy: RetryPolicy,
	memory: HoldingLineMemory,
	input: ReportOutcomeInput,
	modes: ModeMemory = emptyModeMemory(),
): Promise<Decision> {
	const decisionId = requireText(input.decisionId, 'Decision ID').trim();
	const body = buildOutcomeBody(input);
	const response = await send(
		sendOnce,
		{ method: 'POST', path: GOVERN_PATHS.outcome(decisionId), body },
		policy,
	);
	// An outcome is reported after something went out, so it never arms a
	// holding line; it does count as having seen the decision.
	return readDecision(toDecision(response.body, false), memory, { arm: false }, modes);
}

export async function getDecision(
	sendOnce: SendOnce,
	policy: RetryPolicy,
	memory: HoldingLineMemory,
	decisionId: string,
	modes: ModeMemory = emptyModeMemory(),
): Promise<Decision> {
	const id = requireText(decisionId, 'Decision ID').trim();
	const response = await send(sendOnce, { method: 'GET', path: GOVERN_PATHS.decision(id) }, policy);
	return readDecision(toDecision(response.body, false), memory, { arm: true }, modes);
}

export interface RecordDisclosureInput {
	conversationId: string;
	channel: string;
	textShown: string;
	at?: string;
	applicationId?: string | null;
}

export interface Disclosure {
	ref: string;
	applicationId: string;
	conversationId: string;
	channel: string;
	evidenceId: string;
	recordedAt: string;
	created: boolean;
}

export async function recordDisclosure(
	sendOnce: SendOnce,
	policy: RetryPolicy,
	input: RecordDisclosureInput,
	now: () => Date = () => new Date(),
): Promise<Disclosure> {
	requireConversationId(input.conversationId);
	requireText(input.textShown, 'Text Shown');
	requireText(input.channel, 'Channel');
	const body: Record<string, unknown> = {
		conversation_id: input.conversationId,
		channel: input.channel,
		text_shown: input.textShown,
		at: input.at?.trim() || now().toISOString(),
	};
	if (input.applicationId) body.application_id = input.applicationId;
	const response = await send(
		sendOnce,
		{ method: 'POST', path: GOVERN_PATHS.disclosures, body },
		policy,
	);
	const view = (response.body ?? {}) as Record<string, unknown>;
	return {
		ref: str(view.ref) ?? '',
		applicationId: str(view.application_id) ?? '',
		conversationId: str(view.conversation_id) ?? '',
		channel: str(view.channel) ?? '',
		evidenceId: str(view.evidence_id) ?? '',
		recordedAt: str(view.recorded_at) ?? '',
		created: response.status === 201,
	};
}
