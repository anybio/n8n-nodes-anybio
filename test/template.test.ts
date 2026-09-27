/**
 * The shipped template: Send Nothing never reaches a node that messages the
 * patient, the SMS node hangs only off Deliver and Show Hold Text, every
 * branch reports an outcome, and the data is synthetic.
 */

import { describe, expect, it } from 'vitest';

import pkg from '../package.json';
import templateJson from '../templates/governed-symptom-follow-up-on-a-reading.json';

interface TemplateNode {
	name: string;
	type: string;
	parameters: Record<string, unknown>;
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
		expect(byName('AnyBio Govern').parameters.channel).toBe('sms');
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
		for (const phone of phones) expect(phone).toMatch(/^\+1555010\d{4}$/);
		expect(JSON.stringify(template.pinData)).toContain('synthetic-patient-001');
		expect(raw).not.toMatch(/gk_[A-Za-z0-9]/);
		expect(raw).not.toMatch(/whsec_[A-Za-z0-9]/);
	});
});
