/**
 * The outcome hash, the default turn id, the retry policy and the rule that
 * no error carries message text.
 */

import { sha256Hex as sdkSha256Hex } from '@anybio/govern';
import { describe, expect, it } from 'vitest';

import {
	buildOutcomeBody,
	deriveTurnId,
	evaluateTurn,
	GovernApiError,
	GovernConfigError,
	GovernNetworkError,
	MAX_TURN_ID_CHARS,
	recordDisclosure,
	reportOutcome,
	requireTurnId,
	RESERVED_TURN_ID_PREFIX,
	send,
	sha256Hex,
} from '../nodes/shared/govern';
import {
	DECISION_ID,
	decisionView,
	DRAFT,
	failure,
	freshMemory,
	HOLD,
	noSleepPolicy,
	ok,
	sendMock,
	unreachable,
} from './helpers';

describe('the outcome hash', () => {
	it('is lowercase hex SHA-256 of the UTF-8 text, identical to the SDK', async () => {
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
		for (const text of [DRAFT, HOLD, '', 'Tomá tu presión \u{1F4AA}', 'line\nbreak']) {
			expect(sha256Hex(text)).toBe(await sdkSha256Hex(text));
		}
	});

	it('sends only the hash, never the text', async () => {
		const { sendOnce, calls } = sendMock(() => ok(decisionView({ decision: 'allow' }), 201));
		const { policy } = noSleepPolicy();
		await reportOutcome(sendOnce, policy, freshMemory(), {
			decisionId: DECISION_ID,
			delivered: true,
			content: DRAFT,
			deliveryRef: 'SM-synthetic-1',
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.path).toBe(`/api/v1/govern/decisions/${DECISION_ID}/outcome`);
		expect(calls[0]!.body).toMatchObject({
			delivered: true,
			delivered_content_hash: sha256Hex(DRAFT),
			delivery_ref: 'SM-synthetic-1',
		});
		expect(JSON.stringify(calls[0]!.body)).not.toContain('cures');
	});

	it('not delivered sends no hash; delivered without text is refused before any call', () => {
		const body = buildOutcomeBody({ decisionId: DECISION_ID, delivered: false, content: DRAFT });
		expect(body).not.toHaveProperty('delivered_content_hash');
		expect(body.delivered).toBe(false);
		expect(() => buildOutcomeBody({ decisionId: DECISION_ID, delivered: true })).toThrow(
			GovernConfigError,
		);
	});

	it('hashes an empty delivered text rather than dropping it', () => {
		expect(
			buildOutcomeBody({ decisionId: DECISION_ID, delivered: true, content: '' }),
		).toMatchObject({
			delivered_content_hash: sha256Hex(''),
		});
	});
});

describe('the default turn id', () => {
	const base = { workflowId: 'wf-1', executionId: '1001', nodeName: 'AnyBio Govern', itemIndex: 0 };

	it('is deterministic for the same execution and item, so a re-run of the node replays', () => {
		expect(deriveTurnId(base)).toBe(deriveTurnId({ ...base }));
	});

	it('differs by item, execution, node and workflow', () => {
		const ids = new Set([
			deriveTurnId(base),
			deriveTurnId({ ...base, itemIndex: 1 }),
			deriveTurnId({ ...base, executionId: '1002' }),
			deriveTurnId({ ...base, nodeName: 'AnyBio Govern1' }),
			deriveTurnId({ ...base, workflowId: 'wf-2' }),
		]);
		expect(ids.size).toBe(5);
	});

	it('is a valid turn id: outside the reserved prefix and inside the bound', () => {
		const id = deriveTurnId(base);
		expect(id).toMatch(/^n8n-[0-9a-f]{40}$/);
		expect(id.startsWith(RESERVED_TURN_ID_PREFIX)).toBe(false);
		expect(id.length).toBeLessThanOrEqual(MAX_TURN_ID_CHARS);
		expect(() => requireTurnId(id)).not.toThrow();
	});

	it('the idempotency key is the turn id on every attempt of a retried evaluate', async () => {
		const { sendOnce, calls } = sendMock([() => ok({}, 503), () => ok(decisionView())]);
		const { policy } = noSleepPolicy(2);
		const turnId = deriveTurnId(base);
		await evaluateTurn(sendOnce, policy, freshMemory(), {
			conversationId: 'conv-1',
			turnId,
			channel: 'sms',
			audience: 'patient',
			draft: DRAFT,
			holdMessage: HOLD,
		});
		expect(calls.map((c) => c.idempotencyKey)).toEqual([turnId, turnId]);
		expect(calls.map((c) => (c.body as Record<string, unknown>).turn_id)).toEqual([turnId, turnId]);
	});

	it('refuses a caller turn id in the reserved range or over the bound, and an over-long conversation id', async () => {
		const { sendOnce, calls } = sendMock(() => ok(decisionView()));
		const { policy } = noSleepPolicy();
		const run = (turnId: string, conversationId = 'conv-1') =>
			evaluateTurn(sendOnce, policy, freshMemory(), {
				conversationId,
				turnId,
				channel: 'sms',
				audience: 'patient',
				draft: DRAFT,
				holdMessage: HOLD,
			});
		await expect(run('govern:mine')).rejects.toBeInstanceOf(GovernConfigError);
		await expect(run('t'.repeat(MAX_TURN_ID_CHARS + 1))).rejects.toBeInstanceOf(GovernConfigError);
		await expect(run('turn-1', 'c'.repeat(188))).rejects.toBeInstanceOf(GovernConfigError);
		expect(calls).toHaveLength(0);
	});
});

describe('the retry policy, as the SDK', () => {
	it('retries 5xx, 429 and network failures, honouring Retry-After on a 429', async () => {
		const { sendOnce, calls } = sendMock([
			() => ok({}, 500),
			() => ({ status: 429, body: {}, retryAfter: '3' }),
			() => unreachable(),
			() => ok(decisionView()),
		]);
		const { policy, sleeps } = noSleepPolicy(3);
		const response = await send(sendOnce, { method: 'GET', path: '/x' }, policy);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(4);
		expect(sleeps[1]).toBe(3000);
	});

	it('never retries another 4xx', async () => {
		for (const status of [400, 401, 403, 404, 409, 422]) {
			const { sendOnce, calls } = sendMock(() => ok({ kind: 'invalid' }, status));
			const { policy } = noSleepPolicy(2);
			await expect(send(sendOnce, { method: 'GET', path: '/x' }, policy)).rejects.toBeInstanceOf(
				GovernApiError,
			);
			expect(calls, String(status)).toHaveLength(1);
		}
	});

	it('gives up after the retries with a network error that names only the code', async () => {
		const { sendOnce, calls } = sendMock(() => unreachable());
		const { policy } = noSleepPolicy(2);
		const failure = await send(
			sendOnce,
			{ method: 'POST', path: '/x', body: { content: DRAFT } },
			policy,
		).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(GovernNetworkError);
		expect((failure as Error).message).toContain('ECONNREFUSED');
		expect(calls).toHaveLength(3);
	});
});

describe('fail closed, and no message text in any error', () => {
	const fields = (channel: string) => ({
		conversationId: 'conv-1',
		turnId: 'turn-1',
		channel,
		audience: 'patient',
		draft: DRAFT,
		holdMessage: HOLD,
	});

	it('an unreachable API with no mode memory never puts the draft on Deliver, even after an observe turn', async () => {
		// No `ModeMemory` is passed, so nothing is learned and every channel reads
		// as never seen (enforce). The remembered-observe case is in
		// observe-fail-open.test.ts.
		const memory = freshMemory();
		const { policy } = noSleepPolicy(0);
		const observe = sendMock(() => ok(decisionView({ mode: 'observe', status: 'pending' }), 202));
		const seen = await evaluateTurn(observe.sendOnce, policy, memory, fields('sms'));
		expect(seen.output).toBe('deliver');
		const down = sendMock(() => unreachable());
		for (const channel of ['sms', 'voice', 'email', 'web_chat', 'app_message']) {
			const reply = await evaluateTurn(down.sendOnce, policy, memory, fields(channel));
			expect(reply.output, channel).not.toBe('deliver');
			expect(reply.text, channel).not.toContain('cures');
			expect(reply.mode, channel).toBe('enforce');
		}
	});

	it('a refused key holds with client_misconfigured, not gate_unavailable', async () => {
		const { sendOnce } = sendMock(() =>
			ok({ kind: 'forbidden', error: 'not an application key' }, 403),
		);
		const { policy } = noSleepPolicy(2);
		const reply = await evaluateTurn(sendOnce, policy, freshMemory(), fields('sms'));
		expect(reply.reasons).toEqual(['client_misconfigured']);
		expect(reply.output).toBe('sendNothing');
		expect(reply.degraded).toBe(true);
	});

	it('errors from every operation carry codes, never the draft or the disclosure text', async () => {
		const { policy } = noSleepPolicy(0);
		const bad = sendMock(() => ok({ kind: 'invalid', error: 'text_shown too long' }, 400));
		const disclosure = await failure(
			recordDisclosure(bad.sendOnce, policy, {
				conversationId: 'conv-1',
				channel: 'sms',
				textShown: DRAFT,
			}),
		);
		expect(disclosure).toBeInstanceOf(GovernApiError);
		expect(disclosure.message).toContain('400');
		expect(disclosure.message).not.toContain('cures');
		const down = sendMock(() => unreachable());
		const outcome = await failure(
			reportOutcome(down.sendOnce, policy, freshMemory(), {
				decisionId: DECISION_ID,
				delivered: true,
				content: DRAFT,
			}),
		);
		expect(outcome).toBeInstanceOf(GovernNetworkError);
		expect(outcome.message).not.toContain('cures');
		const empty = await failure(
			evaluateTurn(down.sendOnce, policy, freshMemory(), { ...fields('sms'), draft: '   ' }),
		);
		expect(empty).toBeInstanceOf(GovernConfigError);
	});
});
