import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { buildHeadMeta, type HeadMetaInput } from '../src/lib/head-meta';

describe('buildHeadMeta — SEO and robots meta generation', () => {
	const baseInput: HeadMetaInput = {
		title: 'Traxel | System Active',
		description: 'Convert raster images to clean, editable SVG files.',
		canonicalBase: 'https://tracelab.app',
		pathname: '/',
		robots: 'index, follow',
	};

	test('generates full SEO meta for the public home page', () => {
		const meta = buildHeadMeta(baseInput);

		expect(meta.title).toBe('Traxel | System Active');
		expect(meta.description).toBe('Convert raster images to clean, editable SVG files.');
		expect(meta.canonical).toBe('https://tracelab.app/');
		expect(meta.robots).toBe('index, follow');
	});

	test('generates noindex,nofollow for protected pages', () => {
		const meta = buildHeadMeta({
			...baseInput,
			title: 'Traxel — Comparison Workspace',
			pathname: '/workspace',
			robots: 'noindex, nofollow',
		});

		expect(meta.title).toBe('Traxel — Comparison Workspace');
		expect(meta.canonical).toBe('https://tracelab.app/workspace');
		expect(meta.robots).toBe('noindex, nofollow');
	});

	test('omits description from output when not provided', () => {
		const meta = buildHeadMeta({
			title: 'Traxel — Observability',
			canonicalBase: 'https://tracelab.app',
			pathname: '/observability',
			robots: 'noindex, nofollow',
		});

		expect(meta.description).toBeUndefined();
		expect(meta.robots).toBe('noindex, nofollow');
	});

	test('handles trailing slash on canonicalBase correctly', () => {
		const meta = buildHeadMeta({
			...baseInput,
			canonicalBase: 'https://tracelab.app/',
			pathname: '/workspace',
		});

		// Should NOT produce double slash
		expect(meta.canonical).toBe('https://tracelab.app/workspace');
	});

	test('defaults robots to index, follow when omitted', () => {
		const meta = buildHeadMeta({
			title: 'Traxel',
			canonicalBase: 'https://tracelab.app',
			pathname: '/',
		});

		expect(meta.robots).toBe('index, follow');
	});

	test('generates distinct canonical URLs for each observability page', () => {
		const loginMeta = buildHeadMeta({
			...baseInput,
			title: 'Traxel — Observability',
			pathname: '/observability',
			robots: 'noindex, nofollow',
		});
		const dashboardMeta = buildHeadMeta({
			...baseInput,
			title: 'Traxel — Dashboard',
			pathname: '/observability/dashboard',
			robots: 'noindex, nofollow',
		});

		expect(loginMeta.canonical).toBe('https://tracelab.app/observability');
		expect(dashboardMeta.canonical).toBe('https://tracelab.app/observability/dashboard');
		expect(loginMeta.canonical).not.toBe(dashboardMeta.canonical);
	});

	test('preserves exact title string without transformation', () => {
		const meta = buildHeadMeta({
			...baseInput,
			title: 'Custom — Special Title',
		});

		expect(meta.title).toBe('Custom — Special Title');
	});
});

describe('BaseLayout.astro — structural contract', () => {
	const layout = readFileSync(
		resolve(__dirname, '../src/layouts/BaseLayout.astro'),
		'utf-8',
	);

	test('renders skip-to-main-content link targeting #main-content', () => {
		expect(layout).toContain('href="#main-content"');
		expect(layout).toContain('Skip to main content');
		expect(layout).toContain('class="sr-only"');
	});

	test('includes meta robots tag from buildHeadMeta output', () => {
		expect(layout).toMatch(/<meta\s+name="robots"\s+content=\{meta\.robots\}/);
	});

	test('includes canonical link from buildHeadMeta output', () => {
		expect(layout).toMatch(/<link\s+rel="canonical"\s+href=\{meta\.canonical\}/);
	});

	test('conditionally renders description meta only when provided', () => {
		// Should use conditional rendering — not always render
		expect(layout).toMatch(/meta\.description\s*&&/);
		expect(layout).toMatch(/<meta\s+name="description"\s+content=\{meta\.description\}/);
	});

	test('sets lang="en" on html element', () => {
		expect(layout).toMatch(/<html[^>]+lang="en"/);
	});
});
