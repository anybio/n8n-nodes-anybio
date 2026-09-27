/**
 * Govern webhook verification and parsing: a port of `src/webhook.ts` in
 * `@anybio/govern` 0.2.1.
 *
 * The recipe, from the sender: `X-Govern-Timestamp` is the unix time of the
 * attempt in seconds; `X-Govern-Signature` is `v1=` followed by the lowercase
 * hex of `HMAC-SHA256(secret, "{timestamp}.{body}")` where `body` is the exact
 * bytes of the request body. Verify the raw body before parsing it: a body
 * that has been through `JSON.parse` and `JSON.stringify` is not the bytes
 * that were signed.
 */

import { createHmac } from 'crypto';

import { GovernConfigError, toStopClass, type StopClass } from './govern';

export const WEBHOOK_HEADERS = {
	timestamp: 'x-govern-timestamp',
	signature: 'x-govern-signature',
	event: 'x-govern-event',
	delivery: 'x-govern-delivery',
} as const;

export const WEBHOOK_EVENTS = {
	decisionReleased: 'decision.released',
	decisionRejected: 'decision.rejected',
	handoffOpened: 'handoff.opened',
	handoffClaimed: 'handoff.claimed',
	handoffResolved: 'handoff.resolved',
	handoffResumed: 'handoff.resumed',
} as const;

export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A delivery that did not verify: answer 401 and start nothing. */
export class GovernWebhookError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GovernWebhookError';
	}
}

export type HeaderRecord = Record<string, string | string[] | undefined>;

export interface WebhookOptions {
	/** Default 300. 0 disables the check on purpose; a negative or non-finite value is refused. */
	toleranceSeconds?: number;
	/** Current unix time in seconds; for tests. */
	now?: () => number;
}

export interface VerifiedWebhook {
	timestamp: number;
	event: string | null;
	deliveryId: string | null;
	body: string;
}

function header(headers: HeaderRecord, name: string): string | null {
	const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
	if (!key) return null;
	const value = headers[key];
	if (Array.isArray(value)) return value[0] ?? null;
	return value ?? null;
}

function requireSecret(secret: unknown): string {
	if (typeof secret !== 'string' || secret.trim() === '') {
		throw new GovernConfigError(
			"A webhook signing secret is required. Add the application's signing secret (whsec_...) to the AnyBio Govern credential; an empty one cannot verify anything.",
		);
	}
	return secret;
}

function toBytes(body: unknown): Buffer {
	if (typeof body === 'string') return Buffer.from(body, 'utf8');
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof Uint8Array) return Buffer.from(body);
	if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
	throw new GovernConfigError(
		'The raw request body is not available, so there is nothing a signature can be checked against. A parsed body is not the bytes that were signed.',
	);
}

/** The sender's recipe, for tests and for a local mock sender. */
export function signWebhookPayload(
	secret: string,
	timestamp: number,
	body: string | Buffer,
): string {
	requireSecret(secret);
	const mac = createHmac('sha256', secret);
	mac.update(`${timestamp}.`, 'utf8');
	mac.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
	return `v1=${mac.digest('hex')}`;
}

/** Constant-time string comparison; lengths are compared first, then every character. As the SDK. */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Verify the signature and timestamp. Throws `GovernWebhookError` when the
 * delivery fails to verify (unsigned, stale, or signed with another secret),
 * and `GovernConfigError` when the node's own configuration cannot verify
 * anything.
 */
export function verifyWebhookSignature(
	rawBody: unknown,
	headers: HeaderRecord,
	secret: string,
	options: WebhookOptions = {},
): VerifiedWebhook {
	requireSecret(secret);
	const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
	if (!Number.isFinite(tolerance) || tolerance < 0) {
		throw new GovernConfigError(
			'Timestamp Tolerance must be a finite number of seconds, zero or more. Use 0 to accept a delivery of any age on purpose.',
		);
	}
	const bodyBytes = toBytes(rawBody);
	const timestampHeader = header(headers, WEBHOOK_HEADERS.timestamp);
	const signatureHeader = header(headers, WEBHOOK_HEADERS.signature);
	if (!timestampHeader || !signatureHeader) {
		throw new GovernWebhookError('missing X-Govern-Timestamp or X-Govern-Signature header');
	}
	const timestamp = Number(timestampHeader.trim());
	if (!Number.isInteger(timestamp)) {
		throw new GovernWebhookError('X-Govern-Timestamp is not an integer');
	}
	if (tolerance > 0) {
		const now = options.now ? options.now() : Math.floor(Date.now() / 1000);
		if (!Number.isFinite(now)) {
			throw new GovernConfigError(
				'The clock must return the current unix time in seconds as a finite number.',
			);
		}
		if (Math.abs(now - timestamp) > tolerance) {
			throw new GovernWebhookError('X-Govern-Timestamp is outside the accepted window');
		}
	}
	const expected = signWebhookPayload(secret, timestamp, bodyBytes);
	const candidates = signatureHeader
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter((s) => s.startsWith('v1='));
	const matched = candidates.some((candidate) => timingSafeEqual(candidate, expected));
	if (!matched) throw new GovernWebhookError('webhook signature does not match');
	return {
		timestamp,
		event: header(headers, WEBHOOK_HEADERS.event),
		deliveryId: header(headers, WEBHOOK_HEADERS.delivery),
		body: bodyBytes.toString('utf8'),
	};
}

export interface WebhookEvent {
	/** `decision.released`, `decision.rejected`, `handoff.*`, or `unknown`. */
	type: string;
	/** The event name the sender used. */
	event: string;
	deliveryId: string;
	attempt: number;
	createdAt: string;
	applicationId: string;
	at: string;
	decisionId: string | null;
	// Decision events
	conversationId: string | null;
	turnId: string | null;
	channel: string | null;
	reviewState: 'released' | 'rejected' | null;
	reviewerRole: string | null;
	/** On `decision.released`: the text a reviewer released, to deliver. */
	releasedContent: string | null;
	releasedWith: string | null;
	model: string | null;
	modelVersion: string | null;
	stopClass: StopClass | null;
	// Hand-off events
	handoffId: string | null;
	patientRefHash: string | null;
	state: string | null;
	version: number | null;
	queueLabel: string | null;
	assigned: boolean | null;
	dueAt: string | null;
	resolvedAt: string | null;
	/** Whether this hand-off pauses automated messaging to the patient. Absent reads as true, as in the SDK. */
	pausesAutomation: boolean | null;
	/**
	 * The helper's paused rule applied to this event: `pausesAutomation` and
	 * not resumed. The event does not carry `automation_resumed_at`; the pause
	 * ends at `handoff.resumed`, so that event reads false.
	 */
	automationPaused: boolean | null;
}

const s = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const n = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `SDK: parseEvent`, flattened into one shape so a workflow reads the same fields on every event. */
export function parseEvent(raw: Record<string, unknown>, headerEvent: string | null): WebhookEvent {
	const event = s(raw.event) ?? headerEvent ?? 'unknown';
	const base: WebhookEvent = {
		type: 'unknown',
		event,
		deliveryId: s(raw.id) ?? '',
		attempt: n(raw.attempt) ?? 1,
		createdAt: s(raw.created_at) ?? '',
		applicationId: s(raw.application_id) ?? '',
		at: s(raw.at) ?? '',
		decisionId: s(raw.decision_id),
		conversationId: null,
		turnId: null,
		channel: null,
		reviewState: null,
		reviewerRole: null,
		releasedContent: null,
		releasedWith: null,
		model: null,
		modelVersion: null,
		stopClass: null,
		handoffId: null,
		patientRefHash: null,
		state: null,
		version: null,
		queueLabel: null,
		assigned: null,
		dueAt: null,
		resolvedAt: null,
		pausesAutomation: null,
		automationPaused: null,
	};
	switch (event) {
		case WEBHOOK_EVENTS.decisionReleased:
		case WEBHOOK_EVENTS.decisionRejected: {
			const reviewer =
				raw.reviewer && typeof raw.reviewer === 'object'
					? (raw.reviewer as Record<string, unknown>)
					: {};
			const released = event === WEBHOOK_EVENTS.decisionReleased;
			return {
				...base,
				type: event,
				decisionId: s(raw.decision_id) ?? '',
				conversationId: s(raw.conversation_id) ?? '',
				turnId: s(raw.turn_id) ?? '',
				channel: s(raw.channel) ?? '',
				reviewState: released ? 'released' : 'rejected',
				reviewerRole: s(reviewer.role),
				releasedContent: released ? s(raw.released_content) : null,
				releasedWith: s(raw.released_with),
				model: s(raw.model),
				modelVersion: s(raw.model_version),
				stopClass: toStopClass(raw.stop_class),
			};
		}
		case WEBHOOK_EVENTS.handoffOpened:
		case WEBHOOK_EVENTS.handoffClaimed:
		case WEBHOOK_EVENTS.handoffResolved:
		case WEBHOOK_EVENTS.handoffResumed: {
			const pausesAutomation = raw.pauses_automation !== false;
			const resumed =
				event === WEBHOOK_EVENTS.handoffResumed ||
				(raw.automation_resumed_at !== undefined && raw.automation_resumed_at !== null);
			return {
				...base,
				type: event,
				handoffId: s(raw.handoff_id) ?? '',
				patientRefHash: s(raw.patient_ref_hash),
				state: s(raw.state) ?? '',
				version: n(raw.version) ?? 0,
				queueLabel: s(raw.queue_label),
				assigned: raw.assigned === true,
				dueAt: s(raw.due_at),
				resolvedAt: s(raw.resolved_at),
				pausesAutomation,
				automationPaused: pausesAutomation && !resumed,
			};
		}
		default:
			return base;
	}
}

/** Verify a delivery and return the event. */
export function handleWebhook(
	rawBody: unknown,
	headers: HeaderRecord,
	secret: string,
	options: WebhookOptions = {},
): WebhookEvent {
	const verified = verifyWebhookSignature(rawBody, headers, secret, options);
	let parsed: unknown = null;
	let parseFailed = false;
	try {
		parsed = JSON.parse(verified.body);
	} catch {
		parseFailed = true;
	}
	if (parseFailed) throw new GovernWebhookError('webhook body is not JSON');
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new GovernWebhookError('webhook body is not a JSON object');
	}
	const event = parseEvent(parsed as Record<string, unknown>, verified.event);
	if (!event.deliveryId && verified.deliveryId) event.deliveryId = verified.deliveryId;
	return event;
}
