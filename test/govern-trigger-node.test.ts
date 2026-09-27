/**
 * The AnyBio Govern Trigger node against a fake webhook context: a verified delivery
 * starts the workflow; an unsigned, stale or mis-signed one is answered 401
 * and starts nothing.
 */

import type { IDataObject, IWebhookFunctions } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { AnyBioGovernTrigger } from '../nodes/AnyBioGovernTrigger/AnyBioGovernTrigger.node';
import { signWebhookPayload } from '../nodes/shared/webhook';
import { DECISION_ID } from './helpers';

/** A synthetic signing secret: not a credential. */
const SIGNING_FIXTURE = `whsec_${'1'.repeat(48)}`;

const released = JSON.stringify({
	id: 'dlv-1',
	event: 'decision.released',
	created_at: '2026-09-26T00:00:00Z',
	attempt: 1,
	application_id: 'app',
	decision_id: DECISION_ID,
	conversation_id: 'synthetic-conv-001',
	turn_id: 'synthetic-turn-001',
	channel: 'sms',
	review_state: 'released',
	released_content: 'A synthetic reviewed reply.',
	reviewer: { role: 'clinician' },
	at: '2026-09-26T00:00:00Z',
});

const handoffOpened = (pauses: boolean) =>
	JSON.stringify({
		id: 'dlv-2',
		event: 'handoff.opened',
		handoff_id: 'h-1',
		decision_id: DECISION_ID,
		state: 'queued',
		version: 1,
		assigned: false,
		pauses_automation: pauses,
	});

function webhookContext(options: {
	body: string | undefined;
	headers: Record<string, string>;
	events?: string[];
	webhookOptions?: IDataObject;
	secret?: string;
	lazyRawBody?: boolean;
}) {
	const answer: { status?: number; body?: unknown } = {};
	const request: IDataObject = {};
	const raw = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8');
	if (options.lazyRawBody) {
		request.readRawBody = async () => {
			request.rawBody = raw;
		};
	} else {
		request.rawBody = raw;
	}
	const ctx = {
		getRequestObject: () => request,
		getResponseObject: () => ({
			status(code: number) {
				answer.status = code;
				return this;
			},
			json(body: unknown) {
				answer.body = body;
				return this;
			},
		}),
		getHeaderData: () =>
			Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v])),
		getCredentials: async () => ({
			webhookSecret: options.secret ?? SIGNING_FIXTURE,
			environment: 'sandbox',
		}),
		getNodeParameter: (name: string, fallback: unknown) => {
			if (name === 'events') {
				return (
					options.events ?? [
						'decision.released',
						'decision.rejected',
						'handoff.opened',
						'handoff.resolved',
					]
				);
			}
			if (name === 'options') return options.webhookOptions ?? {};
			return fallback;
		},
	};
	return { ctx: ctx as unknown as IWebhookFunctions, answer };
}

const signed = (
	body: string,
	timestamp = Math.floor(Date.now() / 1000),
	secret = SIGNING_FIXTURE,
) => ({
	'X-Govern-Timestamp': String(timestamp),
	'X-Govern-Signature': signWebhookPayload(secret, timestamp, body),
	'X-Govern-Event': JSON.parse(body).event,
	'X-Govern-Delivery': JSON.parse(body).id,
});

const run = (ctx: IWebhookFunctions) => new AnyBioGovernTrigger().webhook.call(ctx);

describe('AnyBio Govern Trigger', () => {
	it('starts the workflow on a verified release, with what to deliver', async () => {
		const { ctx, answer } = webhookContext({ body: released, headers: signed(released) });
		const result = await run(ctx);
		expect(answer.status).toBeUndefined();
		expect(result.workflowData![0]![0]!.json).toMatchObject({
			type: 'decision.released',
			decisionId: DECISION_ID,
			releasedContent: 'A synthetic reviewed reply.',
			environment: 'sandbox',
		});
	});

	it('reads the raw body when the server has not read it yet', async () => {
		const { ctx } = webhookContext({
			body: released,
			headers: signed(released),
			lazyRawBody: true,
		});
		const result = await run(ctx);
		expect(result.workflowData).toBeDefined();
	});

	it('answers 401 and starts nothing for an unsigned, stale or mis-signed delivery', async () => {
		const stale = Math.floor(Date.now() / 1000) - 3600;
		const cases: Record<string, Record<string, string>> = {
			unsigned: { 'X-Govern-Event': 'decision.released' },
			stale: signed(released, stale),
			'another secret': signed(released, undefined, `${SIGNING_FIXTURE}x`),
		};
		for (const [name, headers] of Object.entries(cases)) {
			const { ctx, answer } = webhookContext({ body: released, headers });
			const result = await run(ctx);
			expect(answer.status, name).toBe(401);
			expect(result, name).toEqual({ noWebhookResponse: true });
			expect(JSON.stringify(answer.body), name).not.toContain('synthetic reviewed reply');
		}
	});

	it('answers 500, not 401, when the credential has no signing secret', async () => {
		const { ctx, answer } = webhookContext({
			body: released,
			headers: signed(released),
			secret: '',
		});
		const result = await run(ctx);
		expect(answer.status).toBe(500);
		expect(result).toEqual({ noWebhookResponse: true });
	});

	it('acknowledges a verified event it was not asked for without starting the workflow', async () => {
		const { ctx, answer } = webhookContext({
			body: released,
			headers: signed(released),
			events: ['handoff.opened'],
		});
		const result = await run(ctx);
		expect(answer.status).toBe(200);
		expect(result).toEqual({ noWebhookResponse: true });
	});

	it('carries pausesAutomation and, when asked, starts only for hand-offs that pause automation', async () => {
		for (const pauses of [true, false]) {
			const body = handoffOpened(pauses);
			const { ctx } = webhookContext({
				body,
				headers: signed(body),
				webhookOptions: { onlyPausingAutomation: true },
			});
			const result = await run(ctx);
			if (pauses) {
				expect(result.workflowData![0]![0]!.json).toMatchObject({
					type: 'handoff.opened',
					pausesAutomation: true,
					automationPaused: true,
				});
			} else {
				expect(result).toEqual({ noWebhookResponse: true });
			}
		}
	});
});
