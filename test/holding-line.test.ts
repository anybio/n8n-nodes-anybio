/**
 * The holding line, ported from `@anybio/govern` 0.2.1 `test/holding-line.test.ts`.
 * The SDK keeps its memory in the process; the node keeps it in the
 * workflow's static data (see `govern-node.test.ts` for that half).
 */

import { describe, expect, it } from 'vitest';

import {
	evaluateTurn,
	getDecision,
	HoldingLineMemory,
	reportOutcome,
	toDecision,
	type EvaluateInput,
} from '../nodes/shared/govern';
import {
	DECISION_ID,
	decisionView,
	DRAFT,
	freshMemory,
	HOLD,
	noSleepPolicy,
	ok,
	sendMock,
	unreachable,
	type WireDecision,
} from './helpers';

const input = (overrides: Partial<EvaluateInput> = {}): EvaluateInput => ({
	conversationId: 'conv-1',
	turnId: 'turn-1',
	channel: 'web_chat',
	audience: 'patient',
	draft: DRAFT,
	holdMessage: HOLD,
	...overrides,
});

/** A patient-audience hold the API says owes a holding line. */
const armedHold = (overrides: WireDecision = {}) =>
	decisionView({
		decision: 'hold',
		reasons: ['prohibited_claim'],
		stop_class: 'never_sendable',
		send_holding_line: true,
		review_state: 'pending',
		...overrides,
	});

const { policy } = noSleepPolicy(0);

describe('the holding line: at most one per decision', () => {
	it('the first hold arms it, with the stop class', async () => {
		const { sendOnce } = sendMock(() => ok(armedHold()));
		const reply = await evaluateTurn(sendOnce, policy, freshMemory(), input());
		expect(reply.held).toBe(true);
		expect(reply.text).toBe(HOLD);
		expect(reply.sendHoldingLine).toBe(true);
		expect(reply.stopClass).toBe('never_sendable');
	});

	it('a replayed turnId does not re-arm it', async () => {
		const { sendOnce } = sendMock(() => ok(armedHold()));
		const memory = freshMemory();
		const first = await evaluateTurn(sendOnce, policy, memory, input());
		const replay = await evaluateTurn(sendOnce, policy, memory, input());
		expect(first.sendHoldingLine).toBe(true);
		expect(replay.decisionId).toBe(DECISION_ID);
		expect(replay.held).toBe(true);
		expect(replay.sendHoldingLine).toBe(false);
	});

	it('evaluate sends model and modelVersion, and drops blanks', async () => {
		const { sendOnce, calls } = sendMock(() => ok(decisionView()));
		const memory = freshMemory();
		await evaluateTurn(
			sendOnce,
			policy,
			memory,
			input({ model: 'gpt-4o', modelVersion: 'gpt-4o-2024-08-06' }),
		);
		expect(calls[0]!.body).toMatchObject({ model: 'gpt-4o', model_version: 'gpt-4o-2024-08-06' });
		await evaluateTurn(
			sendOnce,
			policy,
			memory,
			input({ turnId: 'turn-2', model: '  ', modelVersion: '' }),
		);
		expect(calls.at(-1)!.body).not.toHaveProperty('model');
		expect(calls.at(-1)!.body).not.toHaveProperty('model_version');
	});

	it('a getDecision or an evaluate replay after the same hold does not re-arm it', async () => {
		const { sendOnce } = sendMock(() => ok(armedHold()));
		const memory = freshMemory();
		expect((await evaluateTurn(sendOnce, policy, memory, input())).sendHoldingLine).toBe(true);
		expect((await getDecision(sendOnce, policy, memory, DECISION_ID)).sendHoldingLine).toBe(false);
		expect((await evaluateTurn(sendOnce, policy, memory, input())).sendHoldingLine).toBe(false);
	});

	it('each new decision has its own answer', async () => {
		const { sendOnce } = sendMock([
			() => ok(armedHold()),
			() =>
				ok(armedHold({ decision_id: '1b7c8f1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f', turn_id: 'turn-2' })),
		]);
		const memory = freshMemory();
		expect((await evaluateTurn(sendOnce, policy, memory, input())).sendHoldingLine).toBe(true);
		expect(
			(await evaluateTurn(sendOnce, policy, memory, input({ turnId: 'turn-2' }))).sendHoldingLine,
		).toBe(true);
	});

	it('a released or rejected hold never arms it, even if a server says so', async () => {
		for (const review_state of ['released', 'rejected']) {
			const { sendOnce } = sendMock(() =>
				ok(armedHold({ review_state, released_content: 'reviewed' })),
			);
			const memory = freshMemory();
			expect((await getDecision(sendOnce, policy, memory, DECISION_ID)).sendHoldingLine).toBe(
				false,
			);
			expect((await evaluateTurn(sendOnce, policy, memory, input())).sendHoldingLine).toBe(false);
		}
	});

	it('patient_state_unavailable never arms it, and on an outbound channel nothing is handed over', async () => {
		const { sendOnce } = sendMock(() =>
			ok(
				armedHold({
					status: 'unavailable',
					reasons: ['gate_unavailable', 'patient_state_unavailable'],
					stop_class: 'uncertain',
					policy: null,
				}),
			),
		);
		const reply = await evaluateTurn(sendOnce, policy, freshMemory(), input({ channel: 'sms' }));
		expect(reply.held).toBe(true);
		expect(reply.sendHoldingLine).toBe(false);
		expect(reply.showHoldText).toBe(false);
		expect(reply.text).toBe('');
		expect(reply.output).toBe('sendNothing');
		expect(reply.reasons).toContain('patient_state_unavailable');
	});

	it('the stops that mean do-not-message never arm it', async () => {
		for (const reason of ['opted_out', 'consent_missing', 'consent_revoked', 'frequency_cap']) {
			const { sendOnce } = sendMock(() => ok(armedHold({ decision: 'block', reasons: [reason] })));
			const reply = await evaluateTurn(sendOnce, policy, freshMemory(), input({ channel: 'sms' }));
			expect(reply.sendHoldingLine, reason).toBe(false);
			expect(reply.output, reason).toBe('sendNothing');
		}
	});

	it('an allow, a clinician audience or an absent flag never arms it', async () => {
		const cases = [
			decisionView({ decision: 'allow', send_holding_line: true }),
			armedHold({ audience: 'clinician' }),
			decisionView({ decision: 'hold', reasons: ['review_required'] }),
		];
		for (const view of cases) {
			const { sendOnce } = sendMock(() => ok(view));
			const reply = await evaluateTurn(
				sendOnce,
				policy,
				freshMemory(),
				input({ audience: view.audience as string }),
			);
			expect(reply.sendHoldingLine).toBe(false);
		}
	});

	it('a node-side fail-closed hold does not arm it: no patient state was read', async () => {
		const { sendOnce } = sendMock(() => unreachable());
		const reply = await evaluateTurn(sendOnce, policy, freshMemory(), input());
		expect(reply.held).toBe(true);
		expect(reply.degraded).toBe(true);
		expect(reply.sendHoldingLine).toBe(false);
		expect(reply.stopClass).toBeNull();
	});

	it('an outcome report counts as having seen the decision', async () => {
		const { sendOnce } = sendMock(() => ok(armedHold(), 201));
		const memory = freshMemory();
		const reported = await reportOutcome(sendOnce, policy, memory, {
			decisionId: DECISION_ID,
			delivered: true,
			content: HOLD,
		});
		expect(reported.sendHoldingLine).toBe(false);
		expect((await getDecision(sendOnce, policy, memory, DECISION_ID)).sendHoldingLine).toBe(false);
	});

	it('the memory is bounded', async () => {
		const { sendOnce } = sendMock((request) => {
			const id = request.path.split('/').pop()!;
			return ok(armedHold({ decision_id: id }));
		});
		const memory = new HoldingLineMemory([]);
		const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
		expect((await getDecision(sendOnce, policy, memory, id(0))).sendHoldingLine).toBe(true);
		for (let n = 1; n <= 10_000; n++) await getDecision(sendOnce, policy, memory, id(n));
		expect(memory.size).toBe(10_000);
		// The oldest id was evicted, so it can arm again: the documented reason a
		// long-lived workflow records the send itself when it must be exact.
		expect((await getDecision(sendOnce, policy, memory, id(0))).sendHoldingLine).toBe(true);
	});
});

describe("the decision view's fields", () => {
	it('maps stop_class, model and model_version, and reads an unknown class as uncertain', () => {
		const first = toDecision(
			armedHold({ stop_class: 'uncertain', model: 'gpt-4o', model_version: 'gpt-4o-2024-08-06' }),
			false,
		);
		expect(first.stopClass).toBe('uncertain');
		expect(first.model).toBe('gpt-4o');
		expect(first.modelVersion).toBe('gpt-4o-2024-08-06');
		expect(toDecision(armedHold({ stop_class: 'some_future_class' }), false).stopClass).toBe(
			'uncertain',
		);
		const allowed = toDecision(decisionView(), false);
		expect(allowed.stopClass).toBeNull();
		expect(allowed.model).toBeNull();
		expect(allowed.sendHoldingLine).toBe(false);
	});

	it('an unknown decision value fails closed in enforce and open in observe, as in the SDK', async () => {
		const enforce = sendMock(() => ok(decisionView({ decision: 'escalate_somehow' })));
		const held = await evaluateTurn(
			enforce.sendOnce,
			policy,
			freshMemory(),
			input({ channel: 'sms' }),
		);
		expect(held.decision).toBe('hold');
		expect(held.reasons).toContain('unknown_decision');
		expect(held.output).toBe('sendNothing');
		const observe = sendMock(() =>
			ok(decisionView({ decision: 'escalate_somehow', mode: 'observe' }), 202),
		);
		const allowed = await evaluateTurn(observe.sendOnce, policy, freshMemory(), input());
		expect(allowed.decision).toBe('allow');
		expect(allowed.output).toBe('deliver');
		expect(allowed.accepted).toBe(true);
	});

	it('a patient audience never receives the clinician substitution', async () => {
		const { sendOnce } = sendMock(() =>
			ok(decisionView({ decision: 'allow', deliverable_content: 'rewritten' })),
		);
		const reply = await evaluateTurn(sendOnce, policy, freshMemory(), input());
		expect(reply.text).toBe(DRAFT);
		const clinician = sendMock(() =>
			ok(
				decisionView({
					decision: 'allow',
					audience: 'clinician',
					deliverable_content: 'rewritten',
				}),
			),
		);
		const forClinician = await evaluateTurn(
			clinician.sendOnce,
			policy,
			freshMemory(),
			input({ audience: 'clinician' }),
		);
		expect(forClinician.text).toBe('rewritten');
	});
});
