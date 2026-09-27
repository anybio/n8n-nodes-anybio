/**
 * The channel rule, ported from `@anybio/govern` 0.2.1 `test/channel-rule.test.ts`
 * and checked against the SDK itself on every case.
 *
 * For the patient audience, in-session channels (`web_chat`, `app_message`)
 * show the hold text on every hold; outbound channels (`sms`, `voice`,
 * `email`) and any value this version does not know follow `sendHoldingLine`
 * and hand over nothing when it is false. A clinician hold shows the hold text
 * on every channel. The node adds the output each case lands on.
 */

import { Govern, isInSessionChannel as sdkIsInSessionChannel } from '@anybio/govern';
import { describe, expect, it } from 'vitest';

import {
	evaluateTurn,
	IN_SESSION_CHANNELS,
	isInSessionChannel,
	type GateResult,
} from '../nodes/shared/govern';
import {
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

const UNKNOWN = 'carrier_pigeon';
const IN_SESSION = ['web_chat', 'app_message'];
const OUTBOUND = ['sms', 'voice', 'email', UNKNOWN];
const ALL = [...IN_SESSION, ...OUTBOUND];

/** The four holds every channel is checked against. `null` is the API unreachable. */
const HOLDS: Record<string, (channel: string) => WireDecision | null> = {
	'a normal hold with send_holding_line true': (channel) =>
		decisionView({
			channel,
			decision: 'hold',
			reasons: ['prohibited_claim'],
			stop_class: 'never_sendable',
			send_holding_line: true,
			review_state: 'pending',
		}),
	'the API unreachable': () => null,
	patient_state_unavailable: (channel) =>
		decisionView({
			channel,
			status: 'unavailable',
			decision: 'hold',
			reasons: ['gate_unavailable', 'patient_state_unavailable'],
			stop_class: 'uncertain',
			policy: null,
			send_holding_line: false,
		}),
	'a released hold': (channel) =>
		decisionView({
			channel,
			decision: 'hold',
			reasons: ['prohibited_claim'],
			stop_class: 'uncertain',
			review_state: 'released',
			released_content: 'Reviewed reply.',
			// A server that says otherwise is overruled: a released hold owes no holding line.
			send_holding_line: true,
		}),
};

const OWES_HOLDING_LINE: Record<string, boolean> = {
	'a normal hold with send_holding_line true': true,
	'the API unreachable': false,
	patient_state_unavailable: false,
	'a released hold': false,
};

function nodeGate(view: WireDecision | null) {
	const { sendOnce, calls } = sendMock(() => (view === null ? unreachable() : ok(view)));
	const { policy } = noSleepPolicy(0);
	const memory = freshMemory();
	const run = (channel: string, audience: string, turnId = 'turn-1'): Promise<GateResult> =>
		evaluateTurn(sendOnce, policy, memory, {
			conversationId: 'conv-1',
			turnId,
			channel,
			audience,
			draft: DRAFT,
			patientRef: 'p-1',
			holdMessage: HOLD,
		});
	return { run, calls };
}

function sdkGovern(view: WireDecision | null) {
	const fetchImpl: typeof fetch = async () => {
		if (view === null) throw new TypeError('fetch failed');
		return new Response(JSON.stringify(view), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	};
	return new Govern({
		apiKey: 'gk_sandbox_test_not_a_credential',
		application: 'care-companion',
		baseUrl: 'https://govern.test',
		fetch: fetchImpl,
		holdMessage: HOLD,
		maxRetries: 0,
	});
}

describe('isInSessionChannel', () => {
	it('classifies web_chat and app_message as in-session, and everything else as outbound, as the SDK does', () => {
		expect(IN_SESSION_CHANNELS).toEqual(['web_chat', 'app_message']);
		for (const channel of IN_SESSION) expect(isInSessionChannel(channel), channel).toBe(true);
		for (const channel of OUTBOUND) expect(isInSessionChannel(channel), channel).toBe(false);
		for (const value of [undefined, null, 7, '', 'WEB_CHAT', ' web_chat', UNKNOWN, ...ALL]) {
			expect(isInSessionChannel(value)).toBe(sdkIsInSessionChannel(value));
		}
	});
});

describe('evaluate: the hold text by channel', () => {
	for (const channel of ALL) {
		const inSession = isInSessionChannel(channel);
		for (const [name, build] of Object.entries(HOLDS)) {
			const owed = OWES_HOLDING_LINE[name]!;
			const shows = inSession || owed;
			it(`${channel}: ${name} ${shows ? 'goes to Show Hold Text' : 'goes to Send Nothing'}`, async () => {
				const view = build(channel);
				const reply = await nodeGate(view).run(channel, 'patient');
				expect(reply.held).toBe(true);
				expect(reply.sendHoldingLine).toBe(owed);
				expect(reply.showHoldText).toBe(shows);
				expect(reply.text).toBe(shows ? HOLD : '');
				expect(reply.text).not.toContain('cures');
				expect(reply.degraded).toBe(view === null);
				expect(reply.output).toBe(shows ? 'showHoldText' : 'sendNothing');
				if (view === null) {
					expect(reply.decisionId).toBeNull();
					expect(reply.reasons).toEqual(['gate_unavailable']);
				}

				const sdk = await sdkGovern(view).guard(() => DRAFT, {
					conversationId: 'conv-1',
					turnId: 'turn-1',
					channel: channel as never,
					audience: 'patient',
					patientRef: 'p-1',
				});
				expect({
					held: reply.held,
					sendHoldingLine: reply.sendHoldingLine,
					showHoldText: reply.showHoldText,
					text: reply.text,
					decision: reply.decision,
					stopClass: reply.stopClass,
					degraded: reply.degraded,
					decisionId: reply.decisionId,
					reasons: reply.reasons,
				}).toEqual({
					held: sdk.held,
					sendHoldingLine: sdk.sendHoldingLine,
					showHoldText: sdk.showHoldText,
					text: sdk.text,
					decision: sdk.decision,
					stopClass: sdk.stopClass,
					degraded: sdk.degraded,
					decisionId: sdk.decisionId,
					reasons: sdk.reasons,
				});
			});
		}
	}

	it('a replayed turn shows the hold text again in session, and nothing more on an outbound channel', async () => {
		for (const channel of ALL) {
			const gate = nodeGate(HOLDS['a normal hold with send_holding_line true']!(channel));
			const first = await gate.run(channel, 'patient');
			const replay = await gate.run(channel, 'patient');
			expect(first.sendHoldingLine, channel).toBe(true);
			expect(first.showHoldText, channel).toBe(true);
			expect(first.output, channel).toBe('showHoldText');
			// The one-per-decision dedup is on the holding line only.
			expect(replay.sendHoldingLine, channel).toBe(false);
			expect(replay.showHoldText, channel).toBe(isInSessionChannel(channel));
			expect(replay.text, channel).toBe(isInSessionChannel(channel) ? HOLD : '');
			expect(replay.output, channel).toBe(
				isInSessionChannel(channel) ? 'showHoldText' : 'sendNothing',
			);
			// Replays carry the same idempotency key, so the API returns the stored decision.
			expect(gate.calls.map((c) => c.idempotencyKey)).toEqual(['turn-1', 'turn-1']);
		}
	});

	it('an allow is untouched on every channel: Deliver, showHoldText false, text the draft', async () => {
		for (const channel of ALL) {
			const reply = await nodeGate(decisionView({ channel, decision: 'allow' })).run(
				channel,
				'patient',
			);
			expect(reply.showHoldText).toBe(false);
			expect(reply.text).toBe(DRAFT);
			expect(reply.output).toBe('deliver');
		}
	});
});

describe('evaluate: a clinician hold shows its notice on every channel', () => {
	const CLINICIAN_HOLDS = ['a normal hold with send_holding_line true', 'the API unreachable'];
	for (const channel of ['email', 'web_chat', 'app_message', UNKNOWN]) {
		for (const name of CLINICIAN_HOLDS) {
			it(`${channel}: ${name} goes to Show Hold Text for a clinician`, async () => {
				const built = HOLDS[name]!(channel);
				const view = built === null ? null : { ...built, audience: 'clinician' };
				const reply = await nodeGate(view).run(channel, 'clinician');
				expect(reply.held).toBe(true);
				expect(reply.sendHoldingLine).toBe(false);
				expect(reply.showHoldText).toBe(true);
				expect(reply.text).toBe(HOLD);
				expect(reply.degraded).toBe(view === null);
				expect(reply.output).toBe('showHoldText');

				const sdk = await sdkGovern(view).guard(() => DRAFT, {
					conversationId: 'conv-1',
					turnId: 'turn-1',
					channel: channel as never,
					audience: 'clinician',
				});
				expect([reply.sendHoldingLine, reply.showHoldText, reply.text]).toEqual([
					sdk.sendHoldingLine,
					sdk.showHoldText,
					sdk.text,
				]);
			});
		}
	}
});
