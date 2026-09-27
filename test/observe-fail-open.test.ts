/**
 * When AnyBio cannot be reached, the mode last seen for the application and
 * channel decides. Ported from `@anybio/govern` 0.2.1 `test/guard.test.ts`
 * ("fails closed when the API is unreachable and the mode is unknown", "fails
 * closed when the last known mode for the channel is enforce", "fails open with
 * degraded: true when the last known mode for the channel is observe") and
 * `test/degrade.test.ts` ("still fails open in observe"), with the SDK run on
 * the same cases, including the two the SDK also fails open on: a channel
 * last seen off, and a refused or misconfigured key (`client_misconfigured`)
 * while the remembered mode is observe or off. The node matches the SDK
 * exactly on every sequence here.
 */

import { Govern } from '@anybio/govern';
import { describe, expect, it } from 'vitest';

import {
	emptyModeMemory,
	evaluateTurn,
	getDecision,
	ModeMemory,
	MODE_MEMORY_MAX,
	reportOutcome,
	type GateResult,
	type Mode,
	type SendOnce,
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
} from './helpers';

const APP = 'app:5f0e1d2c-3b4a-4968-8776-655443322110';

const fields = (channel: string, turnId = 'turn-2', audience = 'patient') => ({
	conversationId: 'conv-1',
	turnId,
	channel,
	audience,
	draft: DRAFT,
	patientRef: 'p-1',
	holdMessage: HOLD,
});

/** One gate with its holding-line memory and its mode memory, keyed on `application`. */
function gate(application: string | null = APP, entries: Record<string, string> = {}) {
	const memory = freshMemory();
	const modes = new ModeMemory(entries, application);
	const { policy } = noSleepPolicy(0);
	const turn = (sendOnce: SendOnce, channel: string, turnId?: string, audience?: string) =>
		evaluateTurn(sendOnce, policy, memory, fields(channel, turnId, audience), modes);
	return { memory, modes, policy, turn, entries };
}

const answering = (mode: Mode, channel: string, status = mode === 'observe' ? 202 : 200) =>
	sendMock(() =>
		ok(decisionView({ mode, channel, status: mode === 'observe' ? 'pending' : 'decided' }), status),
	).sendOnce;
const down = () => sendMock(() => unreachable()).sendOnce;
const refused = () =>
	sendMock(() => ok({ kind: 'UNAUTHORIZED_ERROR', error_message: 'no' }, 401)).sendOnce;
const gateDown = () =>
	sendMock(() => ok({ kind: 'SERVICE_UNAVAILABLE_ERROR', error_message: 'gate down' }, 503))
		.sendOnce;

/** The SDK on the same sequence: the first evaluate answers `first`, every later one fails as `failure`. */
async function sdkSecondTurn(
	first: { mode: Mode; status: number } | null,
	failure: 'unreachable' | number,
	options: { assumeMode?: 'enforce' | 'observe' } = {},
) {
	let evaluations = 0;
	const fetchImpl: typeof fetch = async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		const json = (status: number, body: unknown) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			});
		if (url.includes('/outcome')) {
			return json(201, decisionView({ mode: first?.mode ?? 'enforce', channel: 'web_chat' }));
		}
		evaluations += 1;
		if (evaluations === 1 && first) {
			return json(
				first.status,
				decisionView({
					mode: first.mode,
					channel: 'web_chat',
					status: first.mode === 'observe' ? 'pending' : 'decided',
				}),
			);
		}
		if (failure === 'unreachable') throw new TypeError('fetch failed');
		return json(failure, { kind: 'X', error_message: 'no' });
	};
	const govern = new Govern({
		apiKey: 'gk_sandbox_test_not_a_credential',
		application: 'care-companion',
		baseUrl: 'https://govern.test',
		fetch: fetchImpl,
		holdMessage: HOLD,
		maxRetries: 0,
		...options,
	});
	const ctx = {
		conversationId: 'conv-1',
		channel: 'web_chat' as const,
		audience: 'patient' as const,
	};
	if (first) await govern.guard(() => DRAFT, { ...ctx, turnId: 'turn-1' });
	return govern.guard(() => DRAFT, { ...ctx, turnId: 'turn-2' });
}

function expectFailOpen(
	reply: GateResult,
	mode: Mode = 'observe',
	reason: string = 'gate_unavailable',
) {
	expect(reply.output).toBe('deliver');
	expect(reply.failOpen).toBe(true);
	expect(reply.decision).toBe('allow');
	expect(reply.text).toBe(DRAFT);
	expect(reply.degraded).toBe(true);
	expect(reply.mode).toBe(mode);
	expect(reply.decisionId).toBeNull();
	expect(reply.reasons).toEqual([reason]);
	expect(reply.held).toBe(false);
	expect(reply.sendHoldingLine).toBe(false);
}

describe('as the SDK: the last known mode decides an outage', () => {
	it('fails closed when the API is unreachable and the channel was never seen (enforce)', async () => {
		const g = gate();
		const reply = await g.turn(down(), 'web_chat');
		expect(reply.output).toBe('showHoldText');
		expect(reply.failOpen).toBe(false);
		expect(reply.decision).toBe('hold');
		expect(reply.text).toBe(HOLD);
		expect(reply.degraded).toBe(true);
		expect(reply.decisionId).toBeNull();
		expect(reply.mode).toBe('enforce');
		expect(reply.reasons).toEqual(['gate_unavailable']);

		const sdk = await sdkSecondTurn(null, 'unreachable');
		expect([sdk.decision, sdk.text, sdk.mode, sdk.degraded, sdk.decisionId]).toEqual([
			reply.decision,
			reply.text,
			reply.mode,
			reply.degraded,
			reply.decisionId,
		]);
	});

	it('fails closed when the last known mode for the channel is enforce', async () => {
		const g = gate();
		await g.turn(answering('enforce', 'web_chat'), 'web_chat', 'turn-1');
		expect(g.modes.lastKnownMode('web_chat')).toBe('enforce');
		const reply = await g.turn(gateDown(), 'web_chat');
		expect(reply.output).toBe('showHoldText');
		expect(reply.decision).toBe('hold');
		expect(reply.text).toBe(HOLD);
		expect(reply.mode).toBe('enforce');
		expect(reply.failOpen).toBe(false);

		// The SDK told to assume observe still holds once it has learned enforce.
		const sdk = await sdkSecondTurn({ mode: 'enforce', status: 200 }, 503, {
			assumeMode: 'observe',
		});
		expect([sdk.decision, sdk.text, sdk.mode]).toEqual(['hold', HOLD, 'enforce']);
	});

	it('fails open with degraded: true when the last known mode for the channel is observe', async () => {
		const g = gate();
		const seen = await g.turn(answering('observe', 'web_chat'), 'web_chat', 'turn-1');
		expect(seen.output).toBe('deliver');
		expect(seen.failOpen).toBe(false);
		expect(g.modes.lastKnownMode('web_chat')).toBe('observe');
		for (const failure of [down(), gateDown()]) {
			expectFailOpen(await g.turn(failure, 'web_chat'));
		}

		for (const failure of ['unreachable', 503] as const) {
			const sdk = await sdkSecondTurn({ mode: 'observe', status: 202 }, failure);
			expect([sdk.decision, sdk.text, sdk.mode, sdk.degraded, sdk.decisionId, sdk.reasons]).toEqual(
				['allow', DRAFT, 'observe', true, null, ['gate_unavailable']],
			);
		}
	});

	it('fails open on every channel last seen in observe, in session and outbound alike', async () => {
		for (const channel of ['sms', 'voice', 'email', 'web_chat', 'app_message']) {
			const g = gate();
			await g.turn(answering('observe', channel), channel, 'turn-1');
			expectFailOpen(await g.turn(down(), channel));
		}
	});

	it('learns the mode from every decision it reads: Get Decision and Report Outcome too', async () => {
		const { policy } = noSleepPolicy(0);
		const readers = [
			(sendOnce: SendOnce, modes: ModeMemory) =>
				getDecision(sendOnce, policy, freshMemory(), DECISION_ID, modes),
			(sendOnce: SendOnce, modes: ModeMemory) =>
				reportOutcome(
					sendOnce,
					policy,
					freshMemory(),
					{ decisionId: DECISION_ID, delivered: false },
					modes,
				),
		];
		for (const read of readers) {
			const modes = new ModeMemory({}, APP);
			await read(answering('observe', 'sms', 200), modes);
			expect(modes.lastKnownMode('sms')).toBe('observe');
			const reply = await evaluateTurn(down(), policy, freshMemory(), fields('sms'), modes);
			expectFailOpen(reply);
		}
	});

	it('the latest decision wins: a channel moved back to enforce fails closed again', async () => {
		const g = gate();
		await g.turn(answering('observe', 'sms'), 'sms', 'turn-1');
		await g.turn(answering('enforce', 'sms'), 'sms', 'turn-2');
		const reply = await g.turn(down(), 'sms', 'turn-3');
		expect(reply.output).toBe('sendNothing');
		expect(reply.failOpen).toBe(false);
	});
});

describe('remembered per application and channel', () => {
	it('observe on one channel does not open another', async () => {
		const g = gate();
		await g.turn(answering('observe', 'sms'), 'sms', 'turn-1');
		const reply = await g.turn(down(), 'web_chat');
		expect(reply.output).toBe('showHoldText');
		expect(reply.failOpen).toBe(false);
	});

	it('observe for one application does not open the same channel of another', async () => {
		const entries: Record<string, string> = {};
		const a = gate(APP, entries);
		await a.turn(answering('observe', 'sms'), 'sms', 'turn-1');
		const b = gate('app:00000000-0000-4000-8000-000000000001', entries);
		const reply = await b.turn(down(), 'sms');
		expect(reply.output).toBe('sendNothing');
		expect(reply.failOpen).toBe(false);
		expect(a.modes.lastKnownMode('sms')).toBe('observe');
		expect(b.modes.lastKnownMode('sms')).toBeUndefined();
	});

	it('with no application identity nothing is remembered, so an outage fails closed', async () => {
		const g = gate(null);
		await g.turn(answering('observe', 'sms'), 'sms', 'turn-1');
		expect(g.modes.size).toBe(0);
		const reply = await g.turn(down(), 'sms');
		expect(reply.output).toBe('sendNothing');
	});

	it('without a mode memory (the default) every outage fails closed', async () => {
		const { policy } = noSleepPolicy(0);
		expect(emptyModeMemory().lastKnownMode('sms')).toBeUndefined();
		const reply = await evaluateTurn(down(), policy, freshMemory(), fields('sms'));
		expect(reply.output).toBe('sendNothing');
	});

	it('is bounded: the oldest pair is evicted, and a re-learned pair moves to the end', () => {
		const entries: Record<string, string> = {};
		const modes = new ModeMemory(entries, APP, 3);
		modes.remember('sms', 'observe');
		modes.remember('voice', 'observe');
		modes.remember('email', 'observe');
		modes.remember('sms', 'observe');
		modes.remember('web_chat', 'enforce');
		expect(modes.size).toBe(3);
		expect(modes.lastKnownMode('voice')).toBeUndefined();
		expect(Object.keys(entries)).toEqual([`${APP}|email`, `${APP}|sms`, `${APP}|web_chat`]);
		expect(MODE_MEMORY_MAX).toBe(1_000);
	});

	it('ignores a mode value it does not know, and a stored value it does not know reads as never seen', () => {
		const entries: Record<string, string> = { [`${APP}|sms`]: 'shadow' };
		const modes = new ModeMemory(entries, APP);
		expect(modes.lastKnownMode('sms')).toBeUndefined();
		modes.remember('voice', 'shadow' as Mode);
		expect(modes.lastKnownMode('voice')).toBeUndefined();
	});
});

/** The fields `guard` and the node both return, side by side. */
const sideBySide = (r: {
	decision: string;
	text: string;
	mode: string;
	degraded: boolean;
	decisionId: string | null;
	reasons: string[];
	held: boolean;
	sendHoldingLine: boolean;
	showHoldText: boolean;
}) => [
	r.decision,
	r.text,
	r.mode,
	r.degraded,
	r.decisionId,
	r.reasons,
	r.held,
	r.sendHoldingLine,
	r.showHoldText,
];

describe('as the SDK: a channel last seen off, and a refused key', () => {
	it('a channel last seen off fails open on an outage, as the SDK does', async () => {
		for (const [failure, sdkFailure] of [
			[down, 'unreachable'],
			[gateDown, 503],
		] as const) {
			const g = gate();
			const seen = await g.turn(answering('off', 'web_chat', 200), 'web_chat', 'turn-1');
			expect(seen.failOpen).toBe(false);
			expect(g.modes.lastKnownMode('web_chat')).toBe('off');
			const reply = await g.turn(failure(), 'web_chat');
			expectFailOpen(reply, 'off', 'gate_unavailable');

			const sdk = await sdkSecondTurn({ mode: 'off', status: 200 }, sdkFailure);
			expect(sideBySide(sdk)).toEqual(sideBySide(reply));
			expect(sdk.decision).toBe('allow');
		}
	});

	it('a channel last seen off fails open on every channel, in session and outbound alike', async () => {
		for (const channel of ['sms', 'voice', 'email', 'web_chat', 'app_message']) {
			const g = gate();
			await g.turn(answering('off', channel, 200), channel, 'turn-1');
			expectFailOpen(await g.turn(down(), channel), 'off');
		}
	});

	it('a refused key in observe fails open with client_misconfigured, as the SDK does', async () => {
		for (const status of [400, 401, 403, 404, 422]) {
			const g = gate();
			await g.turn(answering('observe', 'web_chat'), 'web_chat', 'turn-1');
			const reply = await g.turn(
				sendMock(() => ok({ kind: 'X', error_message: 'no' }, status)).sendOnce,
				'web_chat',
			);
			expectFailOpen(reply, 'observe', 'client_misconfigured');

			const sdk = await sdkSecondTurn({ mode: 'observe', status: 202 }, status);
			expect(sideBySide(sdk)).toEqual(sideBySide(reply));
		}
	});

	it('a refused key on a channel last seen off fails open with client_misconfigured, as the SDK does', async () => {
		const g = gate();
		await g.turn(answering('off', 'web_chat', 200), 'web_chat', 'turn-1');
		const reply = await g.turn(refused(), 'web_chat');
		expectFailOpen(reply, 'off', 'client_misconfigured');

		const sdk = await sdkSecondTurn({ mode: 'off', status: 200 }, 401);
		expect(sideBySide(sdk)).toEqual(sideBySide(reply));
	});

	it('a refused key in enforce, or on a channel never seen, holds with client_misconfigured, as the SDK does', async () => {
		const learned = gate();
		await learned.turn(answering('enforce', 'web_chat'), 'web_chat', 'turn-1');
		const unseen = gate();
		for (const [g, first] of [
			[learned, { mode: 'enforce' as Mode, status: 200 }],
			[unseen, null],
		] as const) {
			const reply = await g.turn(refused(), 'web_chat');
			expect(reply.output).toBe('showHoldText');
			expect(reply.failOpen).toBe(false);
			expect(reply.reasons).toEqual(['client_misconfigured']);

			const sdk = await sdkSecondTurn(first, 401);
			expect(sideBySide(sdk)).toEqual(sideBySide(reply));
		}
	});

	it('408 and 429 are not a misconfiguration: gate_unavailable, as the SDK', async () => {
		for (const status of [408, 429]) {
			const g = gate();
			await g.turn(answering('observe', 'web_chat'), 'web_chat', 'turn-1');
			const reply = await g.turn(
				sendMock(() => ok({ kind: 'X', error_message: 'later' }, status)).sendOnce,
				'web_chat',
			);
			expectFailOpen(reply, 'observe', 'gate_unavailable');
			const sdk = await sdkSecondTurn({ mode: 'observe', status: 202 }, status);
			expect(sideBySide(sdk)).toEqual(sideBySide(reply));
		}
	});
});
