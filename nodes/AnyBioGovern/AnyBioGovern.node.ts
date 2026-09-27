import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeExecutionHint,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import {
	applicationIdFrom,
	DEFAULT_BASE_URL,
	DEFAULT_HOLD_MESSAGE,
	DEFAULT_MAX_RETRIES,
	DEFAULT_TIMEOUT_MS,
	deriveTurnId,
	evaluateTurn,
	GATE_OUTPUT_INDEX,
	getDecision,
	GovernApiError,
	GovernNetworkError,
	HoldingLineMemory,
	isAutomationPaused,
	ModeMemory,
	REASONS,
	recordDisclosure,
	reportOutcome,
	type Decision,
	type GateResult,
	type RetryPolicy,
	type SendOnce,
} from '../shared/govern';

/** Where the holding-line memory lives in the node's static data. */
export const HOLDING_LINE_STATIC_KEY = 'holdingLineDecisionIds';
/** Where the mode memory (last seen mode per application and channel) lives in the node's static data. */
export const MODE_STATIC_KEY = 'governModes';

const CLIENT_HEADER = 'n8n-nodes-anybio/0.1.0';

const channelOptions = [
	{
		name: 'App Message',
		value: 'app_message',
		description: 'In-session: the patient is waiting in the app',
	},
	{ name: 'Email', value: 'email', description: 'Outbound' },
	{ name: 'SMS', value: 'sms', description: 'Outbound' },
	{ name: 'Voice', value: 'voice', description: 'Outbound' },
	{
		name: 'Web Chat',
		value: 'web_chat',
		description: 'In-session: the patient is waiting in the chat',
	},
];

/** One attempt through n8n's HTTP helper, authenticated by the credential. Never throws on an HTTP status. */
export function makeSendOnce(ctx: IExecuteFunctions, baseUrl: string, timeoutMs: number): SendOnce {
	return async (request) => {
		const headers: IDataObject = {
			Accept: 'application/json',
			'X-AnyBio-Govern-Client': CLIENT_HEADER,
		};
		if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
		const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'anyBioGovernApi', {
			method: request.method,
			baseURL: baseUrl,
			url: request.path,
			qs: request.query,
			body: request.body as IDataObject | undefined,
			json: true,
			headers,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: timeoutMs,
		})) as { statusCode: number; body: unknown; headers?: Record<string, unknown> };
		const retryAfter = response.headers?.['retry-after'];
		return {
			status: response.statusCode,
			body: response.body,
			retryAfter: typeof retryAfter === 'string' ? retryAfter : null,
		};
	};
}

/** The node's static data holds the decision ids whose holding line was armed. */
export function holdingLineMemory(ctx: IExecuteFunctions): HoldingLineMemory {
	const staticData = ctx.getWorkflowStaticData('node');
	if (!Array.isArray(staticData[HOLDING_LINE_STATIC_KEY])) staticData[HOLDING_LINE_STATIC_KEY] = [];
	return new HoldingLineMemory(staticData[HOLDING_LINE_STATIC_KEY] as string[]);
}

/**
 * The application the credential's key is bound to, as the mode memory keys
 * it: the credential's Application ID when set (the API refuses a key not
 * bound to it), otherwise the n8n credential's id. Null when neither is
 * known, and then nothing is remembered and every channel fails closed.
 */
export function modeMemoryApplication(
	ctx: IExecuteFunctions,
	applicationId: string | null,
): string | null {
	if (applicationId) return `app:${applicationId}`;
	const credentialId = ctx.getNode().credentials?.anyBioGovernApi?.id;
	return typeof credentialId === 'string' && credentialId !== '' ? `cred:${credentialId}` : null;
}

/** The node's static data holds the mode last seen per application and channel, beside the holding-line memory. */
export function modeMemory(ctx: IExecuteFunctions, application: string | null): ModeMemory {
	const staticData = ctx.getWorkflowStaticData('node');
	const current = staticData[MODE_STATIC_KEY];
	if (!current || typeof current !== 'object' || Array.isArray(current)) {
		staticData[MODE_STATIC_KEY] = {};
	}
	return new ModeMemory(staticData[MODE_STATIC_KEY] as Record<string, string>, application);
}

/**
 * The warning shown on the node's output when AnyBio refused the credential's
 * key (`client_misconfigured`) for one or more items of this execution. Counts
 * and reason codes only, never message text. Null when nothing was refused.
 */
export function misconfiguredKeyHint(refused: GateResult[]): NodeExecutionHint | null {
	if (refused.length === 0) return null;
	const delivered = refused.filter((result) => result.failOpen).length;
	const held = refused.length - delivered;
	const items = refused.length === 1 ? '1 item' : `${refused.length} items`;
	return {
		type: 'warning',
		location: 'outputPane',
		message:
			`AnyBio refused this credential's key (client_misconfigured) on ${items}, so no decision was recorded. ` +
			'Check the AnyBio Govern API credential: the Application Key, the Application ID and the environment. ' +
			`${delivered} went to Deliver without a decision (channel last seen in observe or off); ${held} held. ` +
			'This does not heal on its own.',
	};
}

/** Add the hint on n8n versions that support execution hints; older ones have no such call, and the run must not fail for it. */
export function addHint(ctx: IExecuteFunctions, hint: NodeExecutionHint | null): void {
	if (hint === null) return;
	const add = (ctx as Partial<Pick<IExecuteFunctions, 'addExecutionHints'>>).addExecutionHints;
	if (typeof add === 'function') add.call(ctx, hint);
}

function decisionJson(decision: Decision, environment: string): IDataObject {
	return {
		decisionId: decision.id,
		...decision,
		automationPaused: isAutomationPaused(decision.handoff),
		handoffId: decision.handoff?.id ?? null,
		environment,
	} as unknown as IDataObject;
}

export class AnyBioGovern implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AnyBio Govern',
		name: 'anyBioGovern',
		icon: { light: 'file:../../icons/anybio.svg', dark: 'file:../../icons/anybio.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Evaluate an AI draft under your AnyBio Govern policy before it reaches a patient, and write the record',
		defaults: {
			name: 'AnyBio Govern',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: `={{(($parameter["operation"] ?? "evaluate") === "evaluate") ? [{ "type": "main", "displayName": "Deliver" }, { "type": "main", "displayName": "Show Hold Text" }, { "type": "main", "displayName": "Send Nothing" }] : [{ "type": "main" }]}}`,
		credentials: [
			{
				name: 'anyBioGovernApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Evaluate',
						value: 'evaluate',
						description: 'Evaluate a draft and route it to Deliver, Show Hold Text or Send Nothing',
						action: 'Evaluate a draft',
					},
					{
						name: 'Get Decision',
						value: 'getDecision',
						description:
							'Read a decision and its review state, for a workflow that waits on a release',
						action: 'Get a decision',
					},
					{
						name: 'Record Disclosure',
						value: 'recordDisclosure',
						description: 'Record the AI-identity disclosure shown at the start of a conversation',
						action: 'Record a disclosure',
					},
					{
						name: 'Report Outcome',
						value: 'reportOutcome',
						description: 'Report what was delivered for a decision; the text is hashed locally',
						action: 'Report an outcome',
					},
				],
				default: 'evaluate',
			},

			// ---------------------------------------------------------------- evaluate
			{
				displayName:
					'Deliver carries the draft. Show Hold Text carries your hold message. Send Nothing carries no text: connect nothing that messages the patient to it.',
				name: 'evaluateNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { operation: ['evaluate'] } },
			},
			{
				displayName: 'Draft Text',
				name: 'draftText',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				description:
					'The message your AI step produced. It is never put in an error or a log by this node.',
				displayOptions: { show: { operation: ['evaluate'] } },
			},
			{
				displayName: 'Conversation ID',
				name: 'conversationId',
				type: 'string',
				required: true,
				default: '',
				description: 'Your identifier for the thread (at most 187 characters)',
				displayOptions: { show: { operation: ['evaluate', 'recordDisclosure'] } },
			},
			{
				displayName: 'Channel',
				name: 'channel',
				type: 'options',
				options: channelOptions,
				default: 'sms',
				description:
					'Where the message goes. Web Chat and App Message are in-session; SMS, Voice and Email are outbound.',
				displayOptions: { show: { operation: ['evaluate', 'recordDisclosure'] } },
			},
			{
				displayName: 'Audience',
				name: 'audience',
				type: 'options',
				options: [
					{ name: 'Patient', value: 'patient' },
					{ name: 'Clinician', value: 'clinician' },
				],
				default: 'patient',
				description: 'Who reads the message. SMS and Voice accept the patient audience only.',
				displayOptions: { show: { operation: ['evaluate'] } },
			},
			{
				displayName: 'Patient Reference',
				name: 'patientRef',
				type: 'string',
				default: '',
				description:
					'Your opaque patient identifier. The API stores only its SHA-256. Required for consent, opt-out, the cap and a hand-off to apply.',
				displayOptions: { show: { operation: ['evaluate'] } },
			},
			{
				displayName: 'Hold Message',
				name: 'holdMessage',
				type: 'string',
				typeOptions: { rows: 3 },
				default: DEFAULT_HOLD_MESSAGE,
				description:
					'The fixed text Show Hold Text carries: your holding line, written in advance by your clinical owner, saying a person will reply, when, and what to do if it is urgent. Never model-written.',
				displayOptions: { show: { operation: ['evaluate'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { operation: ['evaluate'] } },
				options: [
					{
						displayName: 'Disclosure Reference',
						name: 'disclosureRef',
						type: 'string',
						default: '',
						description:
							'The ref Record Disclosure returned for this conversation. Optional: the API derives it from the conversation ID.',
					},
					{
						displayName: 'Inbound Message',
						name: 'inboundMessage',
						type: 'string',
						typeOptions: { rows: 2 },
						default: '',
						description:
							"The patient's message this turn answers, for the red-flag screen. Requires Patient Reference.",
					},
					{
						displayName: 'Inbound Received At',
						name: 'inboundReceivedAt',
						type: 'dateTime',
						default: '',
						description: 'When the inbound message arrived. Default: now.',
					},
					{
						displayName: 'Model',
						name: 'model',
						type: 'string',
						default: '',
						placeholder: 'gpt-4o',
						description: 'The model that produced the draft, recorded as sent',
					},
					{
						displayName: 'Model Version',
						name: 'modelVersion',
						type: 'string',
						default: '',
						description: "That model's version, as the provider reported it",
					},
					{
						displayName: 'Turn ID',
						name: 'turnId',
						type: 'string',
						default: '',
						description:
							'Your identifier for this message and the idempotency key: a replay returns the stored decision. Default: derived from the workflow, the execution, this node and the item, so a retry of this node in the same execution replays. Map your own message ID to make a re-run execution replay too.',
					},
				],
			},

			// ---------------------------------------------------------------- report outcome
			{
				displayName: 'Decision ID',
				name: 'decisionId',
				type: 'string',
				required: true,
				default: '',
				description:
					'The decisionId the Evaluate operation returned. An item without one (the API was unreachable) is passed through unreported.',
				displayOptions: { show: { operation: ['reportOutcome', 'getDecision'] } },
			},
			{
				displayName: 'Delivered',
				name: 'delivered',
				type: 'boolean',
				default: true,
				description: 'Whether a message went out for this turn',
				displayOptions: { show: { operation: ['reportOutcome'] } },
			},
			{
				displayName: 'Delivered Text',
				name: 'deliveredText',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				description:
					'The text that went out. Hashed here with SHA-256; only the hash is sent to AnyBio.',
				displayOptions: { show: { operation: ['reportOutcome'], delivered: [true] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'outcomeFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { operation: ['reportOutcome'] } },
				options: [
					{
						displayName: 'Delivered At',
						name: 'deliveredAt',
						type: 'dateTime',
						default: '',
						description: 'When it went out. Default: now.',
					},
					{
						displayName: 'Delivery Reference',
						name: 'deliveryRef',
						type: 'string',
						default: '',
						description:
							'Your own reference for the delivery, for example the message ID on your channel',
					},
				],
			},

			// ---------------------------------------------------------------- record disclosure
			{
				displayName: 'Text Shown',
				name: 'textShown',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				description:
					'The AI-identity disclosure the patient was shown, verbatim (at most 2000 characters)',
				displayOptions: { show: { operation: ['recordDisclosure'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'disclosureFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { operation: ['recordDisclosure'] } },
				options: [
					{
						displayName: 'Shown At',
						name: 'at',
						type: 'dateTime',
						default: '',
						description: 'When it was shown. Default: now.',
					},
				],
			},

			// ---------------------------------------------------------------- every operation
			{
				displayName: 'Request Options',
				name: 'requestOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 5 },
						default: DEFAULT_MAX_RETRIES,
						description:
							'Retries after the first attempt, on 429, 5xx, timeouts and network failures. Never on another 4xx.',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeoutMs',
						type: 'number',
						typeOptions: { minValue: 500 },
						default: DEFAULT_TIMEOUT_MS,
						description: 'Per attempt',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;
		const credentials = await this.getCredentials('anyBioGovernApi');
		const baseUrl = (
			typeof credentials.baseUrl === 'string' && credentials.baseUrl.trim() !== ''
				? credentials.baseUrl.trim()
				: DEFAULT_BASE_URL
		).replace(/\/+$/, '');
		const environment =
			typeof credentials.environment === 'string' ? credentials.environment : 'sandbox';
		const applicationId = applicationIdFrom(credentials.applicationId);
		const memory = holdingLineMemory(this);
		const modes = modeMemory(this, modeMemoryApplication(this, applicationId));

		const gateOutputs: INodeExecutionData[][] = [[], [], []];
		const single: INodeExecutionData[] = [];
		const refused: GateResult[] = [];

		for (let i = 0; i < items.length; i++) {
			const requestOptions = this.getNodeParameter('requestOptions', i, {}) as {
				maxRetries?: number;
				timeoutMs?: number;
			};
			const policy: RetryPolicy = {
				maxRetries: requestOptions.maxRetries ?? DEFAULT_MAX_RETRIES,
				sleep: async (ms) => await sleep(ms),
			};
			const sendOnce = makeSendOnce(this, baseUrl, requestOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			try {
				if (operation === 'evaluate') {
					const additional = this.getNodeParameter('additionalFields', i, {}) as {
						turnId?: string;
						model?: string;
						modelVersion?: string;
						inboundMessage?: string;
						inboundReceivedAt?: string;
						disclosureRef?: string;
					};
					const workflowId = this.getWorkflow().id;
					const turnId =
						additional.turnId?.trim() ||
						deriveTurnId({
							workflowId: workflowId === undefined ? '' : String(workflowId),
							executionId: this.getExecutionId() ?? '',
							nodeName: this.getNode().name,
							itemIndex: i,
						});
					const inboundContent = additional.inboundMessage ?? '';
					const result = await evaluateTurn(
						sendOnce,
						policy,
						memory,
						{
							conversationId: this.getNodeParameter('conversationId', i) as string,
							turnId,
							channel: this.getNodeParameter('channel', i) as string,
							audience: this.getNodeParameter('audience', i) as string,
							draft: this.getNodeParameter('draftText', i) as string,
							patientRef: this.getNodeParameter('patientRef', i, '') as string,
							holdMessage: this.getNodeParameter('holdMessage', i, DEFAULT_HOLD_MESSAGE) as string,
							model: additional.model,
							modelVersion: additional.modelVersion,
							disclosureRef: additional.disclosureRef,
							applicationId,
							inbound:
								inboundContent.trim() !== ''
									? {
											content: inboundContent,
											receivedAt: additional.inboundReceivedAt?.trim()
												? new Date(additional.inboundReceivedAt).toISOString()
												: new Date().toISOString(),
										}
									: undefined,
						},
						modes,
					);
					if (result.decisionId === null && result.reasons.includes(REASONS.clientMisconfigured)) {
						refused.push(result);
					}
					gateOutputs[GATE_OUTPUT_INDEX[result.output]].push({
						json: { ...result, environment } as unknown as IDataObject,
						pairedItem: { item: i },
					});
				} else if (operation === 'reportOutcome') {
					const decisionId = (this.getNodeParameter('decisionId', i, '') as string) ?? '';
					if (decisionId.trim() === '') {
						// Nothing was recorded for this turn (the API was unreachable), so
						// there is no decision to report against. The SDK's ack() does the same.
						single.push({
							json: { reported: false, skipped: 'no_decision_id', decisionId: null, environment },
							pairedItem: { item: i },
						});
						continue;
					}
					const delivered = this.getNodeParameter('delivered', i, true) as boolean;
					const fields = this.getNodeParameter('outcomeFields', i, {}) as {
						deliveredAt?: string;
						deliveryRef?: string;
					};
					const decision = await reportOutcome(
						sendOnce,
						policy,
						memory,
						{
							decisionId,
							delivered,
							content: delivered
								? (this.getNodeParameter('deliveredText', i) as string)
								: undefined,
							deliveredAt: fields.deliveredAt?.trim()
								? new Date(fields.deliveredAt).toISOString()
								: undefined,
							deliveryRef: fields.deliveryRef,
						},
						modes,
					);
					single.push({
						json: { reported: true, ...decisionJson(decision, environment) },
						pairedItem: { item: i },
					});
				} else if (operation === 'recordDisclosure') {
					const fields = this.getNodeParameter('disclosureFields', i, {}) as { at?: string };
					const disclosure = await recordDisclosure(sendOnce, policy, {
						conversationId: this.getNodeParameter('conversationId', i) as string,
						channel: this.getNodeParameter('channel', i) as string,
						textShown: this.getNodeParameter('textShown', i) as string,
						at: fields.at?.trim() ? new Date(fields.at).toISOString() : undefined,
						applicationId,
					});
					single.push({
						json: { ...disclosure, environment } as unknown as IDataObject,
						pairedItem: { item: i },
					});
				} else if (operation === 'getDecision') {
					const decision = await getDecision(
						sendOnce,
						policy,
						memory,
						this.getNodeParameter('decisionId', i) as string,
						modes,
					);
					single.push({ json: decisionJson(decision, environment), pairedItem: { item: i } });
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${operation}`, {
						itemIndex: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					const failed: INodeExecutionData = {
						json: {
							error: (error as Error).message,
							...(operation === 'evaluate' ? { output: 'sendNothing', text: '' } : {}),
						},
						pairedItem: { item: i },
					};
					// Never the deliver output: an item that failed carries no decision.
					if (operation === 'evaluate') gateOutputs[GATE_OUTPUT_INDEX.sendNothing].push(failed);
					else single.push(failed);
					continue;
				}
				if (error instanceof GovernApiError) {
					throw new NodeApiError(
						this.getNode(),
						{ message: error.message, httpCode: String(error.status) } as JsonObject,
						{ message: error.message, httpCode: String(error.status), itemIndex: i },
					);
				}
				if (error instanceof GovernNetworkError) {
					throw new NodeApiError(this.getNode(), { message: error.message } as JsonObject, {
						message: error.message,
						itemIndex: i,
					});
				}
				throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex: i });
			}
		}

		addHint(this, misconfiguredKeyHint(refused));
		return operation === 'evaluate' ? gateOutputs : [single];
	}
}
