import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const COMPONENTS_DIR = resolve(__dirname, '../src/components');

function readComponent(filename: string): string {
	return readFileSync(resolve(COMPONENTS_DIR, filename), 'utf-8');
}

describe('UploadZone.astro — accessibility improvements', () => {
	test('dropzone has role="group" for screen reader grouping', () => {
		const component = readComponent('UploadZone.astro');
		expect(component).toMatch(/data-dropzone[^>]*role\s*=\s*"group"/);
	});

	test('aria-describedby references only IDs that exist in the component', () => {
		const component = readComponent('UploadZone.astro');

		// Extract aria-describedby value
		const match = component.match(/aria-describedby\s*=\s*"([^"]+)"/);
		expect(match).not.toBeNull();

		const referencedIds = match![1].split(/\s+/);

		// Every referenced ID must exist as id="..." in the component
		for (const id of referencedIds) {
			expect(component).toContain(`id="${id}"`);
		}
	});

	test('hidden file input has an accessible label via aria-label or <label>', () => {
		const component = readComponent('UploadZone.astro');
		// Either aria-label on the input, or a <label for="image-input">
		const hasAriaLabel = /data-image-input[^>]*aria-label/.test(component);
		const hasLabelFor = /for\s*=\s*"image-input"/.test(component);
		expect(hasAriaLabel || hasLabelFor).toBe(true);
	});

	test('upload button has aria-label or descriptive text for its purpose', () => {
		const component = readComponent('UploadZone.astro');
		// The button should have clear text content (it already does: "Upload Image")
		expect(component).toMatch(/data-upload-trigger[^>]*>[\s\S]*?Upload/);
	});

	test('does not keep stale support-copy markup in the simplified card', () => {
		const component = readComponent('UploadZone.astro');
		expect(component).not.toContain('upload-support');
		expect(component).not.toContain('Supported Formats');
		expect(component).not.toContain('Optimized for logos');
		expect(component).not.toContain('Waiting for an image to vectorize.');
	});
});

describe('Preview.astro — heading levels and labeled regions', () => {
	test('uses h2 for panel/section headings (not h1 or h3 at top level)', () => {
		const component = readComponent('Preview.astro');
		// Should not have h1 (that's for the page level)
		expect(component).not.toMatch(/<h1[\s>]/);
		// Should have h2 for section-level headings
		expect(component).toMatch(/<h2[\s>]/);
	});

	test('provides a labeled palette region, reset-all control, and polite persistence status', () => {
		const component = readComponent('Preview.astro');
		expect(component).toMatch(/data-palette-panel[^>]*aria-labelledby="palette-heading"/);
		expect(component).toMatch(/id="palette-heading"[^>]*>\s*Edit colors/);
		expect(component).toMatch(/data-palette-reset-all[^>]*>\s*Reset all colors/);
		expect(component).toMatch(/data-persistence-status[^>]*aria-live="polite"/);
	});
});

describe('HeroArtwork.astro — decorative artwork accessibility', () => {
	test('marks the wrapper as aria-hidden and renders a non-interactive mesh', () => {
		const component = readComponent('HeroArtwork.astro');
		expect(component).toMatch(/class="mvp-upload-artwork"[^>]*aria-hidden="true"/);
		expect(component).toContain('data-hero-artwork');
		expect(component).toContain('data-hero-mesh');
		expect(component).toContain('<svg');
		expect(component).not.toContain('<canvas');
	});
});

describe('ObsLogin.astro — accessible form controls', () => {
	test('form inputs have associated labels', () => {
		const component = readComponent('ObsLogin.astro');
		// username input should have a label
		const hasUsernameLabel = /for\s*=\s*"obs-username"/.test(component) ||
			/data-obs-username[^>]*aria-label/.test(component);
		expect(hasUsernameLabel).toBe(true);
	});

	test('error message container has role="alert" for screen reader announcement', () => {
		const component = readComponent('ObsLogin.astro');
		expect(component).toMatch(/data-obs-login-error[^>]*role\s*=\s*"alert"/);
	});

	test('submit button has descriptive text', () => {
		const component = readComponent('ObsLogin.astro');
		expect(component).toMatch(/data-obs-login-submit[^>]*>[^<]*\S/);
	});
});
