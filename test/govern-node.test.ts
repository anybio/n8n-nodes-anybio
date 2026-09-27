/**
 * The AnyBio Govern node end to end against a fake n8n context: the three
 * outputs, the holding line persisted in the workflow's static data across
 * executions, the default turn id, fail closed, observe failing open from the
 * remembered mode, and continueOnFail.
 */

import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	NodeExecutionHint,
} from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import {
	AnyBioGovern,
	HOLDING_LINE_STATIC_KEY,
	MODE_STATIC_KEY,
} from '../nodes/AnyBioGovern/AnyBioGovern.node';
import { deriveTurnId, sha256Hex } from '../nodes/shared/govern';
import { DECISION_ID, decisionView, DRAFT, failure, HOLD } from './helpers';

interface HttpCall {
	credential: string;
	method: string;
	baseURL: string;
	url: string;
	body: IDataObject | undefined;
	headers: IDataObject;
}

type HttpAnswer = { statusCode: number; body: unknown } | 'unreachable';

function context(options: {
	params: IDataObject | ((item: number) => IDataObject);
	items?: number;
	answer: (call: HttpCall) => HttpAnswer;
	staticData?: IDataObject;
	executionId?: string;
	continueOnFail?: boolean;
	/** The credential's Application ID; `''` leaves it unset. */
	applicationId?: string;
	/** The n8n credential's id on the node; `null` leaves it off. */
	credentialId?: string | null;
	/** Leave `addExecutionHints` off the context, as on an n8n version without execution hints. */
	noHints?: boolean;
}) {
	const calls: HttpCall[] = [];
	const hints: NodeExecutionHint[] = [];
	const staticData = options.staticData ?? {};
	const items: INodeExecutionData[] = Array.from({ length: options.items ?? 1 }, (_, i) => ({
		json: { i },
	}));
	const paramsFor = (i: number) =>
		typeof options.params === 'function' ? options.params(i) : options.params;
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, i: number, fallback?: unknown) => {
			const value = paramsFor(i)[name];
			return value === undefined ? fallback : value;
		},
		getCredentials: async () => ({
			apiKey: 'gk_sandbox_test_not_a_credential',
			baseUrl: 'https://govern.test/',
			environment: 'sandbox',
			applicationId: options.applicationId ?? '5F0E1D2C-3B4A-4968-8776-655443322110',
		}),
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => ({ id: 'wf-1', name: 'test', active: true }),
		getExecutionId: () => options.executionId ?? 'exec-1',
		getNode: () => ({
			id: 'node-1',
			name: 'AnyBio Govern',
			type: 'n8n-nodes-anybio.anyBioGovern',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
			credentials:
				options.credentialId === null
					? undefined
					: { anyBioGovernApi: { id: options.credentialId ?? 'cred-1', name: 'AnyBio' } },
		}),
		continueOnFail: () => options.continueOnFail === true,
		...(options.noHints
			? {}
			: { addExecutionHints: (...added: NodeExecutionHint[]) => hints.push(...added) }),
		helpers: {
			httpRequestWithAuthentication: async (credential: string, request: IDataObject) => {
				const call: HttpCall = {
					credential,
					method: request.method as string,
					baseURL: request.baseURL as string,
					url: request.url as string,
					body: request.body as IDataObject | undefined,
					headers: request.headers as IDataObject,
				};
				calls.push(call);
				const answer = options.answer(call);
				if (answer === 'unreachable') {
					// Shaped like a client error that carries the request, draft included.
					const error = new Error(
						`connect ECONNREFUSED ${JSON.stringify(request.body)}`,
					) as Error & {
						code: string;
					};
					error.code = 'ECONNREFUSED';
					throw error;
				}
				return { ...answer, headers: {} };
			},
		},
	};
	return { ctx: ctx as unknown as IExecuteFunctions, calls, staticData, hints };
}

const evaluateParams = (overrides: IDataObject = {}): IDataObject => ({
	operation: 'evaluate',
	draftText: DRAFT,
	conversationId: 'synthetic-conv-001',
	channel: 'sms',
	audience: 'patient',
	patientRef: 'synthetic-patient-001',
	holdMessage: HOLD,
	additionalFields: {},
	requestOptions: { maxRetries: 0 },
	...overrides,
});

const run = (ctx: IExecuteFunctions) => new AnyBioGovern().execute.call(ctx);

describe('AnyBio Govern: Evaluate', () => {
	it('routes allow to Deliver with the draft, and posts the contract body', async () => {
		const { ctx, calls } = context({
			params: evaluateParams(),
			answer: () => ({
				statusCode: 200,
				body: decisionView({ channel: 'sms', decision: 'allow' }),
			}),
		});
		const [deliver, hold, nothing] = await run(ctx);
		expect(deliver).toHaveLength(1);
		expect(hold).toHaveLength(0);
		expect(nothing).toHaveLength(0);
		expect(deliver![0]!.json).toMatchObject({
			output: 'deliver',
			text: DRAFT,
			decisionId: DECISION_ID,
			decision: 'allow',
			sendHoldingLine: false,
			showHoldText: false,
			environment: 'sandbox',
		});
		expect(deliver![0]!.pairedItem).toEqual({ item: 0 });
		expect(calls[0]).toMatchObject({
			credential: 'anyBioGovernApi',
			method: 'POST',
			baseURL: 'https://govern.test',
			url: '/api/v1/govern/evaluate',
		});
		expect(calls[0]!.body).toMatchObject({
			application_id: '5f0e1d2c-3b4a-4968-8776-655443322110',
			conversation_id: 'synthetic-conv-001',
			channel: 'sms',
			audience: 'patient',
			content: DRAFT,
			patient_ref: 'synthetic-patient-001',
		});
		const turnId = deriveTurnId({
			workflowId: 'wf-1',
			executionId: 'exec-1',
			nodeName: 'AnyBio Govern',
			itemIndex: 0,
		});
		expect(calls[0]!.body!.turn_id).toBe(turnId);
		expect(calls[0]!.headers['Idempotency-Key']).toBe(turnId);
	});

	it('an owed holding line goes to Show Hold Text once; the next execution sends nothing', async () => {
		const staticData: IDataObject = {};
		const view = decisionView({
			channel: 'sms',
			decision: 'hold',
			reasons: ['prohibited_claim'],
			stop_class: 'never_sendable',
			send_holding_line: true,
			review_state: 'pending',
		});
		const first = context({
			params: evaluateParams(),
			answer: () => ({ statusCode: 200, body: view }),
			staticData,
		});
		const [, holdFirst, nothingFirst] = await run(first.ctx);
		expect(holdFirst).toHaveLength(1);
		expect(nothingFirst).toHaveLength(0);
		expect(holdFirst![0]!.json).toMatchObject({
			text: HOLD,
			sendHoldingLine: true,
			stopClass: 'never_sendable',
		});
		expect(staticData[HOLDING_LINE_STATIC_KEY]).toEqual([DECISION_ID]);

		// A later execution reads the same decision (a replayed turn id): the memory is in static data.
		const second = context({
			params: evaluateParams({ additionalFields: { turnId: 'turn-1' } }),
			answer: () => ({ statusCode: 200, body: view }),
			staticData,
			executionId: 'exec-2',
		});
		const [deliver, hold, nothing] = await run(second.ctx);
		expect(deliver).toHaveLength(0);
		expect(hold).toHaveLength(0);
		expect(nothing).toHaveLength(1);
		expect(nothing![0]!.json).toMatchObject({ text: '', sendHoldingLine: false, held: true });
	});

	it('in session, every hold goes to Show Hold Text', async () => {
		const { ctx } = context({
			params: evaluateParams({ channel: 'web_chat' }),
			answer: () => ({
				statusCode: 200,
				body: decisionView({ decision: 'block', reasons: ['opted_out'] }),
			}),
		});
		const [, hold] = await run(ctx);
		expect(hold![0]!.json).toMatchObject({
			text: HOLD,
			showHoldText: true,
			sendHoldingLine: false,
		});
	});

	it('fails closed when the API is unreachable: Send Nothing on SMS, Show Hold Text in session, never Deliver, never the draft in an item', async () => {
		for (const [channel, index] of [
			['sms', 2],
			['web_chat', 1],
		] as const) {
			const { ctx, calls } = context({
				params: evaluateParams({ channel, requestOptions: { maxRetries: 1 } }),
				answer: () => 'unreachable',
			});
			const outputs = await run(ctx);
			expect(outputs[0], channel).toHaveLength(0);
			expect(outputs[index], channel).toHaveLength(1);
			const json = outputs[index]![0]!.json;
			expect(json).toMatchObject({
				degraded: true,
				decisionId: null,
				reasons: ['gate_unavailable'],
			});
			expect(JSON.stringify(outputs)).not.toContain('cures');
			expect(calls).toHaveLength(2);
		}
	});

	describe('when AnyBio cannot be reached, the mode remembered in static data decides', () => {
		const APP_KEY = 'app:5f0e1d2c-3b4a-4968-8776-655443322110';

		/** One execution that sees `mode` on `channel`, then one where the API is down, sharing static data. */
		async function seenThenDown(
			mode: 'observe' | 'enforce' | 'off' | null,
			channel: string,
			extra: {
				applicationId?: string;
				credentialId?: string | null;
				downChannel?: string;
				downAnswer?: HttpAnswer;
				noHints?: boolean;
			} = {},
		) {
			const { downAnswer, ...rest } = extra;
			const staticData: IDataObject = {};
			if (mode) {
				const first = context({
					params: evaluateParams({ channel }),
					answer: () => ({
						statusCode: mode === 'observe' ? 202 : 200,
						body: decisionView({
							channel,
							mode,
							status: mode === 'observe' ? 'pending' : 'decided',
						}),
					}),
					staticData,
					executionId: 'exec-1',
					...rest,
				});
				await run(first.ctx);
				expect(first.hints).toEqual([]);
			}
			const second = context({
				params: evaluateParams({ channel: extra.downChannel ?? channel }),
				answer: () => downAnswer ?? 'unreachable',
				staticData,
				executionId: 'exec-2',
				...rest,
			});
			return { outputs: await run(second.ctx), staticData, hints: second.hints };
		}

		const REFUSED: HttpAnswer = {
			statusCode: 401,
			body: { kind: 'UNAUTHORIZED_ERROR', error_message: 'invalid key' },
		};

		it('observe remembered: Deliver with the draft, marked failOpen, mode observe, gate_unavailable', async () => {
			for (const channel of ['sms', 'web_chat']) {
				const { outputs, staticData } = await seenThenDown('observe', channel);
				expect(staticData[MODE_STATIC_KEY], channel).toEqual({
					[`${APP_KEY}|${channel}`]: 'observe',
				});
				expect(outputs[0], channel).toHaveLength(1);
				expect(outputs[1], channel).toHaveLength(0);
				expect(outputs[2], channel).toHaveLength(0);
				expect(outputs[0]![0]!.json, channel).toMatchObject({
					output: 'deliver',
					text: DRAFT,
					failOpen: true,
					mode: 'observe',
					decision: 'allow',
					degraded: true,
					decisionId: null,
					reasons: ['gate_unavailable'],
					sendHoldingLine: false,
					environment: 'sandbox',
				});
			}
		});

		it('enforce remembered: holds by the channel rule, Send Nothing outbound and Show Hold Text in session', async () => {
			for (const [channel, index] of [
				['sms', 2],
				['web_chat', 1],
			] as const) {
				const { outputs, staticData } = await seenThenDown('enforce', channel);
				expect(staticData[MODE_STATIC_KEY], channel).toEqual({
					[`${APP_KEY}|${channel}`]: 'enforce',
				});
				expect(outputs[0], channel).toHaveLength(0);
				expect(outputs[index], channel).toHaveLength(1);
				expect(outputs[index]![0]!.json, channel).toMatchObject({
					failOpen: false,
					mode: 'enforce',
					decision: 'hold',
					text: index === 1 ? HOLD : '',
					reasons: ['gate_unavailable'],
				});
				expect(JSON.stringify(outputs), channel).not.toContain('cures');
			}
		});

		it('a channel never seen holds by the channel rule', async () => {
			for (const [channel, index] of [
				['sms', 2],
				['app_message', 1],
			] as const) {
				const { outputs } = await seenThenDown(null, channel);
				expect(outputs[0], channel).toHaveLength(0);
				expect(outputs[index]![0]!.json, channel).toMatchObject({
					failOpen: false,
					mode: 'enforce',
				});
			}
			// Observe on SMS does not open web chat.
			const { outputs } = await seenThenDown('observe', 'sms', { downChannel: 'web_chat' });
			expect(outputs[0]).toHaveLength(0);
			expect(outputs[1]![0]!.json).toMatchObject({ failOpen: false, text: HOLD });
		});

		it('keys on the credential when it has no Application ID, and remembers nothing with neither', async () => {
			const keyed = await seenThenDown('observe', 'sms', {
				applicationId: '',
				credentialId: 'cred-7',
			});
			expect(keyed.staticData[MODE_STATIC_KEY]).toEqual({ 'cred:cred-7|sms': 'observe' });
			expect(keyed.outputs[0]![0]!.json).toMatchObject({ failOpen: true });

			const anonymous = await seenThenDown('observe', 'sms', {
				applicationId: '',
				credentialId: null,
			});
			expect(anonymous.staticData[MODE_STATIC_KEY]).toEqual({});
			expect(anonymous.outputs[0]).toHaveLength(0);
			expect(anonymous.outputs[2]![0]!.json).toMatchObject({ failOpen: false });
		});

		it('off remembered: Deliver with the draft, marked failOpen, mode off, as the SDK', async () => {
			for (const channel of ['sms', 'web_chat']) {
				const { outputs, hints } = await seenThenDown('off', channel);
				expect(outputs[0], channel).toHaveLength(1);
				expect(outputs[0]![0]!.json, channel).toMatchObject({
					output: 'deliver',
					text: DRAFT,
					failOpen: true,
					mode: 'off',
					decision: 'allow',
					degraded: true,
					decisionId: null,
					reasons: ['gate_unavailable'],
				});
				// An outage is ours, not the workflow's: no misconfiguration warning.
				expect(hints, channel).toEqual([]);
			}
		});

		it('a refused key in observe or off: Deliver, failOpen, client_misconfigured, as the SDK', async () => {
			for (const mode of ['observe', 'off'] as const) {
				const { outputs } = await seenThenDown(mode, 'sms', { downAnswer: REFUSED });
				expect(outputs[0], mode).toHaveLength(1);
				expect(outputs[0]![0]!.json, mode).toMatchObject({
					output: 'deliver',
					text: DRAFT,
					failOpen: true,
					mode,
					decision: 'allow',
					degraded: true,
					decisionId: null,
					reasons: ['client_misconfigured'],
				});
			}
		});

		it('a refused key raises an n8n warning hint for the execution, with no message text', async () => {
			const open = await seenThenDown('observe', 'sms', { downAnswer: REFUSED });
			expect(open.hints).toHaveLength(1);
			expect(open.hints[0]).toMatchObject({ type: 'warning', location: 'outputPane' });
			expect(open.hints[0]!.message).toContain('client_misconfigured');
			expect(open.hints[0]!.message).toContain('1 went to Deliver without a decision');
			expect(open.hints[0]!.message).not.toContain('cures');
			expect(open.hints[0]!.message).not.toContain(HOLD);

			// Held (enforce, or never seen): the item holds and the warning still shows.
			for (const mode of ['enforce', null] as const) {
				const held = await seenThenDown(mode, 'sms', { downAnswer: REFUSED });
				expect(held.outputs[0], String(mode)).toHaveLength(0);
				expect(held.outputs[2]![0]!.json, String(mode)).toMatchObject({
					failOpen: false,
					reasons: ['client_misconfigured'],
				});
				expect(held.hints, String(mode)).toHaveLength(1);
				expect(held.hints[0]!.message, String(mode)).toContain('0 went to Deliver');
				expect(held.hints[0]!.message, String(mode)).toContain('1 held');
			}
		});

		it('one warning per execution, counting every refused item', async () => {
			const { ctx, hints } = context({
				items: 3,
				params: evaluateParams(),
				answer: () => REFUSED,
			});
			const outputs = await run(ctx);
			expect(outputs[2]).toHaveLength(3);
			expect(hints).toHaveLength(1);
			expect(hints[0]!.message).toContain('on 3 items');
		});

		it('an n8n without execution hints still routes a refused key, and does not fail the run', async () => {
			const { outputs } = await seenThenDown('observe', 'sms', {
				downAnswer: REFUSED,
				noHints: true,
			});
			expect(outputs[0]![0]!.json).toMatchObject({
				failOpen: true,
				reasons: ['client_misconfigured'],
			});
		});

		it('a Report Outcome for a fail-open item has no decision to report against and is passed through', async () => {
			const { ctx, calls } = context({
				params: {
					operation: 'reportOutcome',
					decisionId: '',
					delivered: true,
					deliveredText: DRAFT,
				},
				answer: () => 'unreachable',
			});
			const [out] = await run(ctx);
			expect(out![0]!.json).toMatchObject({ reported: false, skipped: 'no_decision_id' });
			expect(calls).toHaveLength(0);
		});
	});

	it('routes each item on its own, keeping item pairing', async () => {
		const { ctx } = context({
			items: 3,
			params: (i) => evaluateParams({ draftText: `${DRAFT} ${i}` }),
			answer: (call) => {
				const i = Number(String(call.body!.content).slice(-1));
				return {
					statusCode: 200,
					body: decisionView({
						channel: 'sms',
						decision: i === 1 ? 'hold' : 'allow',
						decision_id: `00000000-0000-4000-8000-00000000000${i}`,
						send_holding_line: i === 1,
						reasons: i === 1 ? ['prohibited_claim'] : [],
					}),
				};
			},
		});
		const [deliver, hold, nothing] = await run(ctx);
		expect(deliver!.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 2 }]);
		expect(hold!.map((item) => item.pairedItem)).toEqual([{ item: 1 }]);
		expect(nothing).toHaveLength(0);
	});

	it('a configuration error throws without the draft, and with continueOnFail lands on Send Nothing', async () => {
		const bad = evaluateParams({ additionalFields: { turnId: 'govern:reserved' } });
		const thrown = context({
			params: bad,
			answer: () => ({ statusCode: 200, body: decisionView() }),
		});
		const error = await failure(run(thrown.ctx));
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain('reserved');
		expect(error.message).not.toContain('cures');
		expect(thrown.calls).toHaveLength(0);

		const tolerated = context({
			params: bad,
			answer: () => ({ statusCode: 200, body: decisionView() }),
			continueOnFail: true,
		});
		const [deliver, hold, nothing] = await run(tolerated.ctx);
		expect(deliver).toHaveLength(0);
		expect(hold).toHaveLength(0);
		expect(nothing![0]!.json).toMatchObject({ output: 'sendNothing', text: '' });
	});
});

describe('AnyBio Govern: the other operations', () => {
	it('Report Outcome hashes the delivered text and marks the decision seen', async () => {
		const staticData: IDataObject = {};
		const { ctx, calls } = context({
			params: {
				operation: 'reportOutcome',
				decisionId: DECISION_ID,
				delivered: true,
				deliveredText: DRAFT,
				outcomeFields: { deliveryRef: 'SM-synthetic-1' },
				requestOptions: {},
			},
			answer: () => ({
				statusCode: 201,
				body: decisionView({ send_holding_line: true, decision: 'hold' }),
			}),
			staticData,
		});
		const [out] = await run(ctx);
		expect(out![0]!.json).toMatchObject({
			reported: true,
			decisionId: DECISION_ID,
			sendHoldingLine: false,
		});
		expect(calls[0]!.url).toBe(`/api/v1/govern/decisions/${DECISION_ID}/outcome`);
		expect(calls[0]!.body).toMatchObject({
			delivered: true,
			delivered_content_hash: sha256Hex(DRAFT),
		});
		expect(JSON.stringify(calls[0]!.body)).not.toContain('cures');
		expect(staticData[HOLDING_LINE_STATIC_KEY]).toEqual([DECISION_ID]);
	});

	it('Report Outcome passes an item with no decision id through unreported', async () => {
		const { ctx, calls } = context({
			params: { operation: 'reportOutcome', decisionId: '', delivered: false, requestOptions: {} },
			answer: () => ({ statusCode: 201, body: decisionView() }),
		});
		const [out] = await run(ctx);
		expect(out![0]!.json).toMatchObject({ reported: false, skipped: 'no_decision_id' });
		expect(calls).toHaveLength(0);
	});

	it('Record Disclosure posts the text shown and returns the ref', async () => {
		const { ctx, calls } = context({
			params: {
				operation: 'recordDisclosure',
				conversationId: 'synthetic-conv-001',
				channel: 'sms',
				textShown:
					'Synthetic program: replies come from an automated assistant; your care team reviews them.',
				disclosureFields: {},
				requestOptions: {},
			},
			answer: () => ({
				statusCode: 201,
				body: {
					ref: 'govern:app:conversation:synthetic-conv-001:disclosure',
					application_id: 'app',
					conversation_id: 'synthetic-conv-001',
					channel: 'sms',
					evidence_id: 'ev-1',
					recorded_at: '2026-09-26T00:00:00Z',
				},
			}),
		});
		const [out] = await run(ctx);
		expect(out![0]!.json).toMatchObject({
			created: true,
			ref: 'govern:app:conversation:synthetic-conv-001:disclosure',
		});
		expect(calls[0]!.url).toBe('/api/v1/govern/disclosures');
		expect(calls[0]!.body).toMatchObject({ conversation_id: 'synthetic-conv-001', channel: 'sms' });
	});

	it('Get Decision returns the review state and released content, and an API error names only the status', async () => {
		const released = context({
			params: { operation: 'getDecision', decisionId: DECISION_ID, requestOptions: {} },
			answer: () => ({
				statusCode: 200,
				body: decisionView({
					decision: 'hold',
					review_state: 'released',
					released_content: 'Reviewed reply.',
				}),
			}),
		});
		const [out] = await run(released.ctx);
		expect(out![0]!.json).toMatchObject({
			reviewState: 'released',
			releasedContent: 'Reviewed reply.',
		});
		expect(released.calls[0]).toMatchObject({
			method: 'GET',
			url: `/api/v1/govern/decisions/${DECISION_ID}`,
		});

		const missing = context({
			params: { operation: 'getDecision', decisionId: DECISION_ID, requestOptions: {} },
			answer: () => ({ statusCode: 404, body: { kind: 'not_found' } }),
		});
		const error = await failure(run(missing.ctx));
		expect(error.message).toContain('404');
	});
});
