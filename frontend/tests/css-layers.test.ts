import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const STYLES_DIR = resolve(__dirname, '../src/styles');

function readCSS(filename: string): string {
	return readFileSync(resolve(STYLES_DIR, filename), 'utf-8');
}

describe('CSS layer architecture — tokens, base, layout', () => {
	test('tokens.css defines all shared design tokens on :root', () => {
		const css = readCSS('tokens.css');

		// Core color tokens from the vectorizer design system
		expect(css).toContain('--bg:');
		expect(css).toContain('--panel:');
		expect(css).toContain('--text:');
		expect(css).toContain('--muted:');
		expect(css).toContain('--lime:');
		expect(css).toContain('--border:');
		expect(css).toContain('--border-soft:');
		expect(css).toContain('color-scheme: dark');
	});

	test('base.css defines box-sizing reset and body base styles', () => {
		const css = readCSS('base.css');

		expect(css).toContain('box-sizing: border-box');
		expect(css).toContain('margin: 0');
		expect(css).toContain('.sr-only');
	});

	test('layout.css defines the skip-to-main focus style', () => {
		const css = readCSS('layout.css');

		expect(css).toContain('.sr-only:focus');
	});

	test('tokens.css does NOT contain component-specific classes', () => {
		const css = readCSS('tokens.css');

		expect(css).not.toContain('.mvp-upload');
		expect(css).not.toContain('.workspace-review');
		expect(css).not.toContain('.obs-');
	});

	test('base.css does NOT contain page-specific body classes', () => {
		const css = readCSS('base.css');

		expect(css).not.toContain('.mvp-upload-body');
		expect(css).not.toContain('.workspace-review-body');
		expect(css).not.toContain('.obs-body');
	});

	test('layout.css defines :focus-visible outline for interactive elements', () => {
		const css = readCSS('layout.css');
		expect(css).toContain(':focus-visible');
		expect(css).toContain('outline');
	});

	test('page-level CSS files do NOT re-declare .sr-only or :focus-visible (centralized in shared layers)', () => {
		const vecCSS = readCSS('vectorizer.css');
		const obsCSS = readCSS('observability.css');

		// .sr-only must NOT appear as a standalone rule (scoped references like .foo .sr-only are OK)
		expect(vecCSS).not.toMatch(/^\.sr-only\s*\{/m);
		expect(obsCSS).not.toMatch(/^\.sr-only\s*\{/m);

		// :focus-visible must NOT be re-declared at page level
		expect(vecCSS).not.toMatch(/^:focus-visible\s*\{/m);
		expect(obsCSS).not.toMatch(/^:focus-visible\s*\{/m);
	});
});
