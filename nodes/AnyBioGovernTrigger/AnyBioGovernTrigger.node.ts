import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { GovernConfigError } from '../shared/govern';
import {
	DEFAULT_TOLERANCE_SECONDS,
	GovernWebhookError,
	handleWebhook,
	WEBHOOK_EVENTS,
	type HeaderRecord,
	type WebhookEvent,
} from '../shared/webhook';

type RawBodyRequest = {
	rawBody?: unknown;
	readRawBody?: () => Promise<void>;
};

export interface TriggerFilter {
	events: string[];
	onlyPausingAutomation: boolean;
}

/** Whether a verified event is one this trigger starts the workflow for. */
export function eventSelected(event: WebhookEvent, filter: TriggerFilter): boolean {
	if (!filter.events.includes(event.type)) return false;
	if (filter.onlyPausingAutomation && event.type.startsWith('handoff.')) {
		return event.automationPaused === true;
	}
	return true;
}

export class AnyBioGovernTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'AnyBio Govern Trigger',
		name: 'anyBioGovernTrigger',
		icon: { light: 'file:../../icons/anybio.svg', dark: 'file:../../icons/anybio.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow on a signed AnyBio Govern webhook: a hold released or rejected, a hand-off opened, claimed, resolved or resumed',
		defaults: {
			name: 'AnyBio Govern Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'anyBioGovernApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				// A 2xx is all the sender reads; answer with an empty body.
				responseData: 'noData',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					"Register this node's Production URL as the application's webhook URL in the AnyBio console (an application key cannot change it). Every delivery is verified against the Webhook Signing Secret on the credential; an unsigned or stale one is refused with 401.",
				name: 'registrationNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{
						name: 'Automation Resumed',
						value: WEBHOOK_EVENTS.handoffResumed,
						description: 'A person released the pause on automated messaging for the patient',
					},
					{
						name: 'Hand-Off Claimed',
						value: WEBHOOK_EVENTS.handoffClaimed,
						description: 'A member of your team took the hand-off',
					},
					{
						name: 'Hand-Off Opened',
						value: WEBHOOK_EVENTS.handoffOpened,
						description: 'A red flag or a hold opened a hand-off for a patient',
					},
					{
						name: 'Hand-Off Resolved',
						value: WEBHOOK_EVENTS.handoffResolved,
						description: 'A member of your team resolved the hand-off',
					},
					{
						name: 'Hold Rejected',
						value: WEBHOOK_EVENTS.decisionRejected,
						description: 'A reviewer rejected a held draft; nothing is released',
					},
					{
						name: 'Hold Released',
						value: WEBHOOK_EVENTS.decisionReleased,
						description: 'A reviewer released a held draft; releasedContent is what to deliver',
					},
				],
				default: [
					WEBHOOK_EVENTS.decisionReleased,
					WEBHOOK_EVENTS.decisionRejected,
					WEBHOOK_EVENTS.handoffOpened,
					WEBHOOK_EVENTS.handoffResolved,
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Only Hand-Offs That Pause Automation',
						name: 'onlyPausingAutomation',
						type: 'boolean',
						default: false,
						description:
							'Whether to start the workflow for a hand-off event only while it pauses automated messaging to the patient (pausesAutomation and not resumed). Decision events are unaffected.',
					},
					{
						displayName: 'Timestamp Tolerance (Seconds)',
						name: 'toleranceSeconds',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: DEFAULT_TOLERANCE_SECONDS,
						description:
							'Refuse a delivery whose X-Govern-Timestamp is further than this from now, to bound replay. 0 accepts any age.',
					},
				],
			},
		],
	};

	// The webhook URL is a property of the Govern application, and only an
	// organization admin can change it; the application key this node holds
	// is refused on the management routes. So there is nothing for these
	// methods to register or remove: the URL is registered in the console, and
	// the node reports it as present so n8n activates the workflow.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject() as unknown as RawBodyRequest;
		const response = this.getResponseObject();
		const credentials = await this.getCredentials('anyBioGovernApi');
		const secret = typeof credentials.webhookSecret === 'string' ? credentials.webhookSecret : '';
		const environment =
			typeof credentials.environment === 'string' ? credentials.environment : 'sandbox';
		const options = this.getNodeParameter('options', {}) as {
			onlyPausingAutomation?: boolean;
			toleranceSeconds?: number;
		};
		const events = this.getNodeParameter('events', []) as string[];

		if (request.rawBody === undefined && typeof request.readRawBody === 'function') {
			await request.readRawBody();
		}

		let event: WebhookEvent | null = null;
		let refusal: { status: number; error: string } | null = null;
		try {
			event = handleWebhook(request.rawBody, this.getHeaderData() as HeaderRecord, secret, {
				toleranceSeconds: options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS,
			});
		} catch (error) {
			if (error instanceof GovernWebhookError) {
				refusal = { status: 401, error: error.message };
			} else if (error instanceof GovernConfigError) {
				// The node cannot verify anything as configured: ours to fix, not the sender's.
				refusal = { status: 500, error: 'webhook receiver is not configured to verify deliveries' };
			} else {
				refusal = { status: 500, error: 'webhook receiver failed' };
			}
		}

		if (refusal !== null || event === null) {
			const answer = refusal ?? { status: 500, error: 'webhook receiver failed' };
			response.status(answer.status).json({ error: answer.error });
			return { noWebhookResponse: true };
		}

		if (
			!eventSelected(event, {
				events,
				onlyPausingAutomation: options.onlyPausingAutomation === true,
			})
		) {
			// Verified but not selected: acknowledge so the sender does not retry.
			response.status(200).json({ received: true, started: false });
			return { noWebhookResponse: true };
		}

		return {
			workflowData: [[{ json: { ...event, environment } as unknown as IDataObject }]],
		};
	}
}
