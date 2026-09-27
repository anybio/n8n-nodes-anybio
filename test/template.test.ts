/**
 * The shipped template: Send Nothing never reaches a node that messages the
 * patient, the SMS node hangs only off Deliver and Show Hold Text, every
 * branch reports an outcome, the data is synthetic, and the layout follows
 * n8n's template submission guidelines (one yellow main note, neutral step
 * notes, a settings node the user edits, no credentials).
 */

import { describe, expect, it } from 'vitest';

import pkg from '../package.json';
import templateJson from '../templates/governed-symptom-follow-up-on-a-reading.json';

interface TemplateNode {
	name: string;
	type: string;
	parameters: Record<string, unknown>;
	credentials?: unknown;
}
interface Connection {
	node: string;
	type: string;
	index: number;
}
interface Template {
	nodes: TemplateNode[];
	connections: Record<string, Record<string, Connection[][]>>;
	pinData: Record<string, unknown>;
}

const template = templateJson as unknown as Template;
const raw = JSON.stringify(templateJson);

const byName = (name: string) => template.nodes.find((node) => node.name === name)!;

// n8n sticky note colors: 1 is the default yellow, 7 is neutral.
const YELLOW = 1;
const STICKY = 'n8n-nodes-base.stickyNote';
const SET = 'n8n-nodes-base.set';

interface Assignment {
	name: string;
	value: unknown;
}
const settingsNode = () => template.nodes.find((node) => node.type === SET)!;
const settingsValue = (field: string) =>
	(settingsNode().parameters.assignments as { assignments: Assignment[] }).assignments.find(
		(a) => a.name === field,
	)?.value;
const downstream = (name: string, output: number) =>
	(template.connections[name]?.main?.[output] ?? []).map((c) => c.node);

function reachable(from: string[]): Set<string> {
	const seen = new Set<string>();
	const queue = [...from];
	while (queue.length > 0) {
		const name = queue.shift()!;
		if (seen.has(name)) continue;
		seen.add(name);
		for (const outputs of Object.values(template.connections[name] ?? {})) {
			for (const output of outputs) for (const c of output) queue.push(c.node);
		}
	}
	return seen;
}

describe('the template', () => {
	it('uses this package for the AnyBio Govern nodes', () => {
		const ours = template.nodes.filter((node) => node.type.startsWith(`${pkg.name}.`));
		expect(ours.map((node) => node.type)).toEqual(
			expect.arrayContaining([`${pkg.name}.anyBioGovern`]),
		);
		expect(byName('AnyBio Govern').parameters.operation).toBe('evaluate');
		expect(byName('AnyBio Govern').parameters.channel).toBe(
			"={{ $('Your settings').item.json.channel }}",
		);
		expect(settingsValue('channel')).toBe('sms');
	});

	it('sends SMS only from Deliver and Show Hold Text; Send Nothing reaches no messaging node', () => {
		expect(downstream('AnyBio Govern', 0)).toEqual(['Send SMS']);
		expect(downstream('AnyBio Govern', 1)).toEqual(['Send SMS']);
		const afterNothing = reachable(downstream('AnyBio Govern', 2));
		for (const name of afterNothing) {
			expect(byName(name).type, name).toBe(`${pkg.name}.anyBioGovern`);
		}
		expect(afterNothing.has('Send SMS')).toBe(false);
	});

	it('reports an outcome on every branch', () => {
		expect(downstream('Send SMS', 0)).toEqual(['Report Delivered']);
		expect(byName('Report Delivered').parameters).toMatchObject({
			operation: 'reportOutcome',
			delivered: true,
		});
		expect(downstream('AnyBio Govern', 2)).toEqual(['Report Not Sent']);
		expect(byName('Report Not Sent').parameters).toMatchObject({
			operation: 'reportOutcome',
			delivered: false,
		});
	});

	it('carries synthetic data only: fictional 555-01xx numbers and synthetic identifiers', () => {
		const phones = raw.match(/\+1\d{10}/g) ?? [];
		expect(phones.length).toBeGreaterThan(0);
		for (const phone of phones) expect(phone).toMatch(/^\+1\d{3}55501\d{2}$/);
		expect(JSON.stringify(template.pinData)).toContain('synthetic-patient-001');
		expect(raw).not.toMatch(/gk_[A-Za-z0-9]/);
		expect(raw).not.toMatch(/whsec_[A-Za-z0-9]/);
	});

	it('has exactly one yellow main note carrying the full description and the self-hosted disclaimer', () => {
		const stickies = template.nodes.filter((node) => node.type === STICKY);
		const yellow = stickies.filter((node) => (node.parameters.color ?? YELLOW) === YELLOW);
		expect(yellow).toHaveLength(1);
		const content = String(yellow[0].parameters.content);
		for (const heading of [
			"### Who's it for",
			'### How it works',
			'### How to set up',
			'### Requirements',
			'### How to customize the workflow',
		]) {
			expect(content).toContain(heading);
		}
		expect(content).toMatch(/self-hosted n8n only/i);
		expect(content).toMatch(/not available on n8n Cloud/);
		for (const credential of ['AnyBio Govern API', 'OpenAI', 'Twilio']) {
			expect(content).toContain(credential);
		}
	});

	it('colors every step note neutral, never yellow', () => {
		const steps = template.nodes.filter(
			(node) => node.type === STICKY && node.name !== 'About this template',
		);
		expect(steps.length).toBeGreaterThan(0);
		for (const note of steps) {
			expect(note.parameters.color, note.name).toBeDefined();
			expect(note.parameters.color, note.name).not.toBe(YELLOW);
		}
	});

	it('groups the values a user edits in a Set node the other nodes read', () => {
		const settings = settingsNode();
		expect(settings).toBeDefined();
		expect(settings.name).toBe('Your settings');
		expect(downstream('Reading In', 0)).toEqual(['Your settings']);
		expect(downstream('Your settings', 0)).toEqual(['Record Disclosure']);
		const hold = String(byName('AnyBio Govern').parameters.holdMessage);
		expect(hold.startsWith('=')).toBe(true);
		expect(hold).toContain("$('Your settings')");
		expect(hold).toContain('holdMessage');
		expect(String(settingsValue('holdMessage')).length).toBeGreaterThan(0);
	});

	it('carries no credentials and no API keys in any node', () => {
		for (const node of template.nodes) {
			expect(node.credentials, node.name).toBeUndefined();
		}
		expect(raw).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
		expect(raw).not.toMatch(/"(apiKey|authorization|token|password)"\s*:/i);
	});

	it('contains no phone number outside the fictional 555-01xx range', () => {
		const candidates = raw.match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
		expect(candidates.length).toBeGreaterThan(0);
		for (const candidate of candidates) {
			const digits = candidate.replace(/\D/g, '');
			if (digits.length < 10) continue;
			const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
			// NANP reserves NXX-555-0100 to NXX-555-0199 for fictional use.
			expect(national, candidate).toMatch(/^\d{3}55501\d{2}$/);
		}
	});
});
