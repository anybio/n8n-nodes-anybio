/**
 * Test fixtures. The decision view and the constants match
 * `@anybio/govern` 0.2.1 `test/helpers.ts`, so a case ported from there reads
 * the same here. Synthetic values only: no key here is a credential.
 */

import type {
	HoldingLineMemory as Memory,
	RetryPolicy,
	SendOnce,
	TransportRequest,
	TransportResponse,
} from '../nodes/shared/govern';
import { HoldingLineMemory } from '../nodes/shared/govern';

export const DECISION_ID = '0b7c8f1e-2a3b-4c5d-8e9f-0a1b2c3d4e5f';
/** The draft every test posts. Assertions check it never appears in an error or an outcome body. */
export const DRAFT =
	'Good news: this program cures high blood pressure, so you can stop your medication.';
export const HOLD = 'A person will follow up.';

export type WireDecision = Record<string, unknown>;

export function decisionView(overrides: WireDecision = {}): WireDecision {
	return {
		decision_id: DECISION_ID,
		status: 'decided',
		decision: 'allow',
		mode: 'enforce',
		channel: 'web_chat',
		audience: 'patient',
		conversation_id: 'conv-1',
		turn_id: 'turn-1',
		would_have: null,
		policy: { id: '7c6b5a49-3827-4165-9483-7261504f3e2d', name: 'synthetic', version: 1 },
		reasons: [],
		rationale: null,
		detected_claims: [],
		disclosure_required: false,
		review_url: null,
		review_state: null,
		deliverable_content: null,
		released_content: null,
		send_holding_line: false,
		created_at: '2026-09-16T00:00:00Z',
		decided_at: '2026-09-16T00:00:00Z',
		reviewed_at: null,
		outcome: null,
		route_to_human: false,
		would_have_routed: false,
		inbound_flags: [],
		handoff: null,
		webhook_deliveries: [],
		...overrides,
	};
}

export interface RecordedRequest extends TransportRequest {
	index: number;
}

export type Responder = (
	request: RecordedRequest,
) => TransportResponse | Promise<TransportResponse>;

/** A `SendOnce` that answers from responders in order (the last one repeats) and records every call. */
export function sendMock(responders: Responder | Responder[]) {
	const list = Array.isArray(responders) ? responders : [responders];
	const calls: RecordedRequest[] = [];
	const sendOnce: SendOnce = async (request) => {
		const call: RecordedRequest = { ...request, index: calls.length };
		calls.push(call);
		const responder = list[Math.min(call.index, list.length - 1)]!;
		return responder(call);
	};
	return { sendOnce, calls };
}

export const ok = (body: unknown, status = 200): TransportResponse => ({ status, body });

/** A transport failure: no answer arrived. */
export function unreachable(): never {
	const error = new Error('connect ECONNREFUSED') as Error & { code: string };
	error.code = 'ECONNREFUSED';
	throw error;
}

/** No waiting in tests; the delays asked for are recorded. */
export function noSleepPolicy(maxRetries = 0) {
	const sleeps: number[] = [];
	const policy: RetryPolicy = {
		maxRetries,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0.5,
	};
	return { policy, sleeps };
}

/** The error a promise rejects with; a promise that resolves fails the test. */
export async function failure(promise: Promise<unknown>): Promise<Error> {
	let caught: unknown = null;
	try {
		await promise;
	} catch (error) {
		caught = error;
	}
	if (caught === null) throw new Error('expected a rejection');
	return caught as Error;
}

export function freshMemory(): Memory {
	return new HoldingLineMemory([]);
}
