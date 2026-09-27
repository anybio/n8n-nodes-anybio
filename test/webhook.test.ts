/**
 * Webhook signature verification, checked against `@anybio/govern` 0.2.1
 * `src/webhook.ts` in both directions: what the SDK signs verifies here, and
 * what this module signs verifies in the SDK. Unsigned, stale and tampered
 * deliveries are refused.
 */

import {
	GovernWebhookError as SdkWebhookError,
	parseEvent as sdkParseEvent,
	signWebhookPayload as sdkSign,
	verifyWebhookSignature as sdkVerify,
} from '@anybio/govern';
import { describe, expect, it } from 'vitest';

import { GovernConfigError } from '../nodes/shared/govern';
import {
	GovernWebhookError,
	handleWebhook,
	parseEvent,
	signWebhookPayload,
	verifyWebhookSignature,
} from '../nodes/shared/webhook';
import { DECISION_ID } from './helpers';

/** A synthetic signing secret: not a credential. */
const SIGNING_FIXTURE = `whsec_${'0'.repeat(48)}`;
const NOW = 1_790_000_000;
const now = () => NOW;
const BODY = JSON.stringify({
	id: 'dlv-1',
	event: 'decision.released',
	created_at: '2026-09-26T00:00:00Z',
	attempt: 1,
	application_id: '5f0e1d2c-3b4a-4968-8776-655443322110',
	decision_id: DECISION_ID,
	conversation_id: 'synthetic-conv-001',
	turn_id: 'synthetic-turn-001',
	channel: 'sms',
	review_state: 'released',
	released_with: 'original',
	released_content: 'A synthetic reviewed reply.',
	reviewer: { role: 'clinician' },
	stop_class: 'uncertain',
	at: '2026-09-26T00:00:00Z',
});

function headers(signature: string, timestamp = NOW) {
	return {
		'X-Govern-Timestamp': String(timestamp),
		'X-Govern-Signature': signature,
		'X-Govern-Event': 'decision.released',
		'X-Govern-Delivery': 'dlv-1',
	};
}

describe('signature: the same recipe as the SDK', () => {
	it('signs byte for byte as the SDK signs', async () => {
		expect(signWebhookPayload(SIGNING_FIXTURE, NOW, BODY)).toBe(
			await sdkSign(SIGNING_FIXTURE, NOW, BODY),
		);
		const unicode = '{"released_content":"Tomá tu presión \u{1F4AA}"}';
		expect(signWebhookPayload(SIGNING_FIXTURE, NOW, unicode)).toBe(
			await sdkSign(SIGNING_FIXTURE, NOW, unicode),
		);
	});

	it('verifies what the SDK signs, and the SDK verifies what this signs', async () => {
		const bySdk = await sdkSign(SIGNING_FIXTURE, NOW, BODY);
		expect(
			verifyWebhookSignature(Buffer.from(BODY), headers(bySdk), SIGNING_FIXTURE, { now }).body,
		).toBe(BODY);
		const byNode = signWebhookPayload(SIGNING_FIXTURE, NOW, BODY);
		await expect(sdkVerify(BODY, headers(byNode), SIGNING_FIXTURE, { now })).resolves.toMatchObject(
			{
				body: BODY,
			},
		);
	});

	it('accepts any v1 candidate in a list, as the SDK does', () => {
		const good = signWebhookPayload(SIGNING_FIXTURE, NOW, BODY);
		const header = `v1=${'0'.repeat(64)}, ${good}`;
		expect(() =>
			verifyWebhookSignature(BODY, headers(header), SIGNING_FIXTURE, { now }),
		).not.toThrow();
	});
});

describe('refusals match the SDK', () => {
	const good = () => signWebhookPayload(SIGNING_FIXTURE, NOW, BODY);
	const cases: { name: string; body: string; headers: Record<string, string> }[] = [
		{ name: 'unsigned', body: BODY, headers: { 'X-Govern-Timestamp': String(NOW) } },
		{ name: 'no timestamp', body: BODY, headers: { 'X-Govern-Signature': 'v1=abc' } },
		{
			name: 'a timestamp that is not an integer',
			body: BODY,
			headers: headers('v1=abc', Number.NaN),
		},
		{
			name: 'stale (six minutes old)',
			body: BODY,
			headers: headers(signWebhookPayload(SIGNING_FIXTURE, NOW - 360, BODY), NOW - 360),
		},
		{
			name: 'from the future (six minutes ahead)',
			body: BODY,
			headers: headers(signWebhookPayload(SIGNING_FIXTURE, NOW + 360, BODY), NOW + 360),
		},
		{ name: 'a tampered body', body: BODY.replace('original', 'rewritten'), headers: headers('') },
		{
			name: 'another secret',
			body: BODY,
			headers: headers(signWebhookPayload(`${SIGNING_FIXTURE}x`, NOW, BODY)),
		},
		{ name: 'a v0 scheme', body: BODY, headers: headers('') },
	];
	for (const c of cases) {
		it(`refuses ${c.name}`, async () => {
			const hdrs = { ...c.headers };
			if (c.name === 'a tampered body') hdrs['X-Govern-Signature'] = good();
			if (c.name === 'a v0 scheme') hdrs['X-Govern-Signature'] = good().replace('v1=', 'v0=');
			expect(() => verifyWebhookSignature(c.body, hdrs, SIGNING_FIXTURE, { now })).toThrow(
				GovernWebhookError,
			);
			await expect(sdkVerify(c.body, hdrs, SIGNING_FIXTURE, { now })).rejects.toBeInstanceOf(
				SdkWebhookError,
			);
		});
	}

	it('accepts a delivery at the edge of the window, and any age with tolerance 0', async () => {
		const edge = headers(signWebhookPayload(SIGNING_FIXTURE, NOW - 300, BODY), NOW - 300);
		expect(() => verifyWebhookSignature(BODY, edge, SIGNING_FIXTURE, { now })).not.toThrow();
		const old = headers(signWebhookPayload(SIGNING_FIXTURE, NOW - 86_400, BODY), NOW - 86_400);
		expect(() =>
			verifyWebhookSignature(BODY, old, SIGNING_FIXTURE, { now, toleranceSeconds: 0 }),
		).not.toThrow();
		await expect(
			sdkVerify(BODY, old, SIGNING_FIXTURE, { now, toleranceSeconds: 0 }),
		).resolves.toBeTruthy();
	});

	it('refuses its own configuration, not the delivery: no secret, a negative tolerance, no raw body', () => {
		const sig = headers(good());
		expect(() => verifyWebhookSignature(BODY, sig, '', { now })).toThrow(GovernConfigError);
		expect(() =>
			verifyWebhookSignature(BODY, sig, SIGNING_FIXTURE, { now, toleranceSeconds: -1 }),
		).toThrow(GovernConfigError);
		expect(() => verifyWebhookSignature(undefined, sig, SIGNING_FIXTURE, { now })).toThrow(
			GovernConfigError,
		);
		expect(() => verifyWebhookSignature(JSON.parse(BODY), sig, SIGNING_FIXTURE, { now })).toThrow(
			GovernConfigError,
		);
	});
});

describe('events', () => {
	it('parses a verified release with what to deliver', () => {
		const event = handleWebhook(
			BODY,
			headers(signWebhookPayload(SIGNING_FIXTURE, NOW, BODY)),
			SIGNING_FIXTURE,
			{
				now,
			},
		);
		expect(event).toMatchObject({
			type: 'decision.released',
			deliveryId: 'dlv-1',
			decisionId: DECISION_ID,
			reviewState: 'released',
			reviewerRole: 'clinician',
			releasedContent: 'A synthetic reviewed reply.',
			stopClass: 'uncertain',
		});
	});

	it('refuses a verified body that is not a JSON object', () => {
		for (const body of ['not json', '[1,2]']) {
			const sig = headers(signWebhookPayload(SIGNING_FIXTURE, NOW, body));
			expect(() => handleWebhook(body, sig, SIGNING_FIXTURE, { now })).toThrow(GovernWebhookError);
		}
	});

	it('reads the same fields the SDK reads, on every event', () => {
		const handoff = {
			id: 'dlv-2',
			handoff_id: '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a',
			decision_id: DECISION_ID,
			patient_ref_hash: 'ab'.repeat(32),
			state: 'queued',
			version: 1,
			queue_label: 'Care companion follow-up',
			assigned: false,
		};
		for (const event of [
			'handoff.opened',
			'handoff.claimed',
			'handoff.resolved',
			'handoff.resumed',
		]) {
			for (const pauses of [true, false, undefined]) {
				const raw: Record<string, unknown> = { ...handoff, event };
				if (pauses !== undefined) raw.pauses_automation = pauses;
				const ours = parseEvent(raw, null);
				const sdk = sdkParseEvent(raw, null) as unknown as Record<string, unknown>;
				expect(ours.type).toBe(sdk.type);
				expect(ours.handoffId).toBe(sdk.handoffId);
				expect(ours.state).toBe(sdk.state);
				expect(ours.version).toBe(sdk.version);
				expect(ours.assigned).toBe(sdk.assigned);
				expect(ours.pausesAutomation).toBe(sdk.pausesAutomation);
				// The helper's paused rule: paused while pausing and not resumed.
				expect(ours.automationPaused).toBe(pauses !== false && event !== 'handoff.resumed');
			}
		}
		for (const event of ['decision.released', 'decision.rejected']) {
			const raw = { ...JSON.parse(BODY), event, stop_class: 'something_new', model: 'gpt-4o' };
			const ours = parseEvent(raw, null);
			const sdk = sdkParseEvent(raw, null) as unknown as Record<string, unknown>;
			expect(ours.stopClass).toBe(sdk.stopClass);
			expect(ours.releasedContent).toBe(sdk.releasedContent);
			expect(ours.model).toBe(sdk.model);
			expect(ours.reviewState).toBe(sdk.reviewState);
		}
		expect(parseEvent({ id: 'x', event: 'future.event' }, null).type).toBe('unknown');
	});
});
