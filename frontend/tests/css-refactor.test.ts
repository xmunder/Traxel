import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const STYLES_DIR = resolve(__dirname, '../src/styles');

function readCSS(filename: string): string {
	return readFileSync(resolve(STYLES_DIR, filename), 'utf-8');
}

describe('vectorizer.css — refactored to import shared layers', () => {
	test('imports tokens.css, base.css, and layout.css at the top', () => {
		const css = readCSS('vectorizer.css');
		const lines = css.split('\n').filter(l => l.trim().length > 0);

		// First non-comment lines should be @import statements
		const importLines = lines.filter(l => l.trim().startsWith('@import'));
		expect(importLines.length).toBeGreaterThanOrEqual(3);
		expect(css).toContain("@import './tokens.css'");
		expect(css).toContain("@import './base.css'");
		expect(css).toContain("@import './layout.css'");
	});

	test('does NOT re-declare :root tokens (extracted to tokens.css)', () => {
		const css = readCSS('vectorizer.css');

		// Should NOT have the standalone :root block with tokens
		// (it may still reference var(--lime) etc. — that's fine, just not re-declare them)
		expect(css).not.toMatch(/^:root\s*\{/m);
	});

	test('does NOT contain the box-sizing reset (extracted to base.css)', () => {
		const css = readCSS('vectorizer.css');

		expect(css).not.toMatch(/^\*\s*\{\s*\n\s*box-sizing/m);
	});

	test('does NOT contain the .sr-only class (extracted to base.css)', () => {
		const css = readCSS('vectorizer.css');

		expect(css).not.toMatch(/^\.sr-only\s*\{/m);
	});

	test('still contains .mvp-upload-body (page-specific)', () => {
		const css = readCSS('vectorizer.css');

		expect(css).toContain('.mvp-upload-body');
	});

	test('still contains .workspace-review-body (page-specific)', () => {
		const css = readCSS('vectorizer.css');

		expect(css).toContain('.workspace-review-body');
	});
});

describe('observability.css — refactored to import shared layers', () => {
	test('imports tokens.css, base.css, and layout.css at the top', () => {
		const css = readCSS('observability.css');

		expect(css).toContain("@import './tokens.css'");
		expect(css).toContain("@import './base.css'");
		expect(css).toContain("@import './layout.css'");
	});

	test('obs-body references var(--bg) token instead of hardcoding hex values', () => {
		const css = readCSS('observability.css');

		// .obs-body still exists for page-level background override
		expect(css).toContain('.obs-body');
		// Uses the shared token instead of hardcoding #0e0e0e
		expect(css).toContain('var(--bg)');
		// Does NOT hardcode the old hex color for background
		expect(css).not.toMatch(/\.obs-body\s*\{[^}]*#0e0e0e/);
		// Does NOT re-declare margin, color, font-family (now from base.css)
		expect(css).not.toMatch(/\.obs-body\s*\{[^}]*margin:\s*0/);
		expect(css).not.toMatch(/\.obs-body\s*\{[^}]*font-family/);
	});

	test('still contains .obs-login-shell (page-specific)', () => {
		const css = readCSS('observability.css');

		expect(css).toContain('.obs-login-shell');
	});
});
