import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const PAGES_DIR = resolve(__dirname, '../src/pages');
const LAYOUTS_DIR = resolve(__dirname, '../src/layouts');

function readPage(filename: string): string {
	return readFileSync(resolve(PAGES_DIR, filename), 'utf-8');
}

describe('index.astro — BaseLayout integration and SEO', () => {
	test('imports and uses BaseLayout instead of inline <html>/<head>', () => {
		const page = readPage('index.astro');
		expect(page).toContain("import BaseLayout from '../layouts/BaseLayout.astro'");
		expect(page).toContain('<BaseLayout');
		// Should NOT have its own <html> or <head> tags
		expect(page).not.toMatch(/<html[\s>]/);
		expect(page).not.toMatch(/<head[\s>]/);
		expect(page).not.toMatch(/<\/html>/);
	});

	test('passes SEO props: title, description, pathname for public indexing', () => {
		const page = readPage('index.astro');
		// Should have title prop
		expect(page).toMatch(/title\s*=\s*"/);
		// Should have description for SEO
		expect(page).toMatch(/description\s*=\s*"/);
		// Should have pathname="/"
		expect(page).toMatch(/pathname\s*=\s*"\/"/);
		// Should NOT set noindex (public page)
		expect(page).not.toMatch(/robots\s*=\s*"noindex/);
	});

	test('has exactly one <h1> and it is the hero heading', () => {
		const page = readPage('index.astro');
		const h1Matches = page.match(/<h1[\s>]/g);
		expect(h1Matches).toHaveLength(1);
	});

	test('main content area has id="main-content" for skip link', () => {
		const page = readPage('index.astro');
		expect(page).toMatch(/id\s*=\s*"main-content"/);
	});

	test('preserves all data-* attributes required by vectorizer-app.ts', () => {
		const page = readPage('index.astro');
		expect(page).toContain('data-vectorizer-app');
		expect(page).toContain('data-page="upload"');
		expect(page).toContain('data-processing-overlay');
		// data-upload-form lives inside UploadZone.astro component, not the page itself
		expect(page).toContain('data-state="idle"');
	});
});

describe('workspace.astro — BaseLayout integration and noindex', () => {
	test('imports and uses BaseLayout instead of inline <html>/<head>', () => {
		const page = readPage('workspace.astro');
		expect(page).toContain("import BaseLayout from '../layouts/BaseLayout.astro'");
		expect(page).toContain('<BaseLayout');
		expect(page).not.toMatch(/<html[\s>]/);
		expect(page).not.toMatch(/<head[\s>]/);
	});

	test('sets noindex, nofollow robots directive for protected page', () => {
		const page = readPage('workspace.astro');
		expect(page).toMatch(/robots\s*=\s*"noindex,\s*nofollow"/);
	});

	test('has id="main-content" for skip link target', () => {
		const page = readPage('workspace.astro');
		expect(page).toMatch(/id\s*=\s*"main-content"/);
	});

	test('preserves data-vectorizer-app and workspace data attributes', () => {
		const page = readPage('workspace.astro');
		expect(page).toContain('data-vectorizer-app');
		expect(page).toContain('data-page="workspace"');
		expect(page).toContain('data-home-path');
	});
});

describe('observability.astro — BaseLayout integration and noindex', () => {
	test('imports and uses BaseLayout instead of inline <html>/<head>', () => {
		const page = readPage('observability.astro');
		expect(page).toContain("import BaseLayout from '../layouts/BaseLayout.astro'");
		expect(page).toContain('<BaseLayout');
		expect(page).not.toMatch(/<html[\s>]/);
		expect(page).not.toMatch(/<head[\s>]/);
	});

	test('sets noindex, nofollow robots directive', () => {
		const page = readPage('observability.astro');
		expect(page).toMatch(/robots\s*=\s*"noindex,\s*nofollow"/);
	});

	test('uses fonts="inter" (no Material Symbols needed)', () => {
		const page = readPage('observability.astro');
		expect(page).toMatch(/fonts\s*=\s*"inter"/);
	});

	test('wraps content in <main> with id="main-content"', () => {
		const page = readPage('observability.astro');
		expect(page).toMatch(/<main[\s][^>]*id\s*=\s*"main-content"/);
	});
});

describe('observability/dashboard.astro — BaseLayout integration and noindex', () => {
	test('imports and uses BaseLayout instead of inline <html>/<head>', () => {
		const page = readPage('observability/dashboard.astro');
		expect(page).toContain("import BaseLayout from '../../layouts/BaseLayout.astro'");
		expect(page).toContain('<BaseLayout');
		expect(page).not.toMatch(/<html[\s>]/);
		expect(page).not.toMatch(/<head[\s>]/);
	});

	test('sets noindex, nofollow robots directive', () => {
		const page = readPage('observability/dashboard.astro');
		expect(page).toMatch(/robots\s*=\s*"noindex,\s*nofollow"/);
	});

	test('uses fonts="inter" (no Material Symbols needed)', () => {
		const page = readPage('observability/dashboard.astro');
		expect(page).toMatch(/fonts\s*=\s*"inter"/);
	});

	test('wraps content in <main> with id="main-content"', () => {
		const page = readPage('observability/dashboard.astro');
		expect(page).toMatch(/<main[\s][^>]*id\s*=\s*"main-content"/);
	});

	test('preserves data-obs-dashboard and data-endpoint attributes', () => {
		const page = readPage('observability/dashboard.astro');
		expect(page).toContain('data-obs-dashboard');
		expect(page).toContain('data-endpoint');
	});
});

describe('selector regression — all data-* attributes required by JS runtime', () => {
	const COMPONENTS_DIR = resolve(__dirname, '../src/components');

	function readComponent(name: string): string {
		return readFileSync(resolve(COMPONENTS_DIR, name), 'utf-8');
	}

	test('index.astro + UploadZone.astro expose all selectors needed by vectorizer-app.ts (upload page)', () => {
		const page = readPage('index.astro');
		const upload = readComponent('UploadZone.astro');
		const combined = page + upload;

		// Root container and page identification
		expect(combined).toContain('data-vectorizer-app');
		expect(combined).toContain('data-page="upload"');
		expect(combined).toContain('data-endpoint');
		expect(combined).toContain('data-workspace-path');
		expect(combined).toContain('data-state=');

		// Upload form controls (live in UploadZone component)
		expect(combined).toContain('data-image-input');
		expect(combined).toContain('data-dropzone');
		expect(combined).toContain('data-upload-trigger');
		expect(combined).toContain('data-upload-form');

		// Processing overlay
		expect(combined).toContain('data-processing-overlay');
		expect(combined).toContain('data-processing-status');
		expect(combined).toContain('data-processing-message');
		expect(combined).toContain('data-selected-file');

		// State display elements
		expect(combined).toContain('data-status');
		expect(combined).toContain('data-error');
		expect(combined).toContain('data-state-copy');
		expect(combined).toContain('data-state-footer');
	});

	test('workspace.astro + Preview.astro expose all selectors needed by vectorizer-app.ts (workspace page)', () => {
		const page = readPage('workspace.astro');
		const preview = readComponent('Preview.astro');
		const combined = page + preview;

		// Root container and page identification
		expect(combined).toContain('data-vectorizer-app');
		expect(combined).toContain('data-page="workspace"');
		expect(combined).toContain('data-home-path');

		// Workspace sections
		expect(combined).toContain('data-workspace-ready');

		// Image comparison elements
		expect(combined).toContain('data-original-image');
		expect(combined).toContain('data-svg-container');
		expect(combined).toContain('data-download-link');

		// Metadata display
		expect(combined).toContain('data-metadata-colors');
		expect(combined).toContain('data-metadata-paths');
		expect(combined).toContain('data-metadata-duration');
		expect(combined).toContain('data-metadata-bezier');

		// Telemetry
		expect(combined).toContain('data-accuracy-index');
		expect(combined).toContain('data-trace-quality');
		expect(combined).toContain('data-system-status');
		expect(combined).toContain('data-workspace-filename');
		expect(combined).toContain('data-log-list');
		expect(combined).toContain('data-state-footer');
	});

	test('observability pages expose all selectors needed by obs-auth.ts and obs-dashboard.ts', () => {
		const loginPage = readPage('observability.astro');
		const dashboardPage = readPage('observability/dashboard.astro');
		const loginComponent = readComponent('ObsLogin.astro');
		const dashboardComponent = readComponent('ObsDashboard.astro');

		const loginCombined = loginPage + loginComponent;
		const dashCombined = dashboardPage + dashboardComponent;

		// Login page selectors
		expect(loginCombined).toContain('data-obs-login-form');
		expect(loginCombined).toContain('data-obs-username');
		expect(loginCombined).toContain('data-obs-password');
		expect(loginCombined).toContain('data-obs-login-submit');
		expect(loginCombined).toContain('data-obs-login-error');

		// Dashboard page selectors
		expect(dashCombined).toContain('data-obs-dashboard');
		expect(dashCombined).toContain('data-endpoint');
	});
});
