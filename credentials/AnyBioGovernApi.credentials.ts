import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AnyBioGovernApi implements ICredentialType {
	name = 'anyBioGovernApi';

	displayName = 'AnyBio Govern API';

	icon: Icon = { light: 'file:../icons/anybio.svg', dark: 'file:../icons/anybio.dark.svg' };

	documentationUrl = 'https://github.com/anybio/n8n-nodes-anybio#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Environment',
			name: 'environment',
			type: 'options',
			options: [
				{
					name: 'Sandbox (Synthetic Data Only)',
					value: 'sandbox',
					description: 'A sandbox application key. Synthetic patients only: no PHI, no BAA.',
				},
				{
					name: 'Production',
					value: 'production',
					description: 'A production application key, under your agreement with AnyBio',
				},
			],
			default: 'sandbox',
			description:
				'Which environment the application key belongs to. The key itself is bound to one application and one environment, so this labels every item the nodes emit; it does not change where requests go.',
		},
		{
			displayName: 'Application Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'gk_...',
			description:
				'The application key from the AnyBio console. A server-side secret, sent only in the Authorization header.',
		},
		{
			displayName: 'Application ID',
			name: 'applicationId',
			type: 'string',
			default: '',
			placeholder: '00000000-0000-4000-8000-000000000000',
			description:
				'Optional. The application the key belongs to (a UUID). When set it is sent as application_id, and the API refuses a key that is not bound to it.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.anybio.io',
			description:
				'The AnyBio API. Sandbox and production keys both use https://api.anybio.io; change this only when AnyBio gives you another address.',
		},
		{
			displayName: 'Webhook Signing Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'whsec_...',
			description:
				"Used by the AnyBio Govern Trigger node only: the application's webhook signing secret, shown once when the application is created or the secret is rotated",
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// A read of the application's webhook delivery log: it authenticates the
	// key against the contract routes and writes nothing, so testing the
	// credential never creates a decision.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/api/v1/govern/webhook-deliveries',
			method: 'GET',
			qs: { status: 'delivered' },
		},
	};
}
