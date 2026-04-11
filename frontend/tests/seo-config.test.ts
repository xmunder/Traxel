import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const ROOT_DIR = resolve(__dirname, '..');

function readFile(relativePath: string): string {
	return readFileSync(resolve(ROOT_DIR, relativePath), 'utf-8');
}

describe('astro.config.mjs — site and sitemap', () => {
	test('defines site property with production URL', () => {
		const config = readFile('astro.config.mjs');
		expect(config).toMatch(/site:\s*['"]https:\/\/tracelab\.app['"]/);
	});

	test('imports and uses @astrojs/sitemap integration', () => {
		const config = readFile('astro.config.mjs');
		expect(config).toMatch(/import\s+sitemap\s+from\s+['"]@astrojs\/sitemap['"]/);
		expect(config).toContain('sitemap(');
	});

	test('sitemap filter excludes /observability paths', () => {
		const config = readFile('astro.config.mjs');
		// The filter function should reference 'observability' to exclude those paths
		expect(config).toMatch(/observability/);
		// Should use the filter option of the sitemap integration
		expect(config).toMatch(/filter/);
	});
});

describe('package.json — sitemap dependency', () => {
	test('includes @astrojs/sitemap in dependencies', () => {
		const pkg = JSON.parse(readFile('package.json'));
		expect(pkg.dependencies['@astrojs/sitemap']).toBeDefined();
		// Should be a valid semver range
		expect(pkg.dependencies['@astrojs/sitemap']).toMatch(/^\^?\d+\.\d+/);
	});
});

describe('public/robots.txt — crawler directives', () => {
	test('exists and allows general crawling', () => {
		const robots = readFile('public/robots.txt');
		expect(robots).toMatch(/User-agent:\s*\*/i);
		expect(robots).toMatch(/Allow:\s*\//i);
	});

	test('disallows /observability/ path', () => {
		const robots = readFile('public/robots.txt');
		expect(robots).toMatch(/Disallow:\s*\/observability\//i);
	});

	test('references the sitemap URL', () => {
		const robots = readFile('public/robots.txt');
		expect(robots).toMatch(/Sitemap:\s*https:\/\/tracelab\.app\/sitemap-index\.xml/i);
	});

	test('does NOT disallow root or workspace (only meta tags handle those)', () => {
		const robots = readFile('public/robots.txt');
		// workspace is handled by meta noindex, not robots.txt
		expect(robots).not.toMatch(/Disallow:\s*\/workspace/i);
		// Root should definitely be allowed
		expect(robots).not.toMatch(/Disallow:\s*\/\s*$/m);
	});
});

describe('crawlability matrix — public vs protected pages', () => {
	test('home page (/) is crawlable: no noindex in robots, no Disallow in robots.txt', () => {
		const page = readFile('src/pages/index.astro');
		const robots = readFile('public/robots.txt');

		// Page should NOT set noindex
		expect(page).not.toMatch(/robots\s*=\s*"noindex/);
		// robots.txt should NOT disallow /
		expect(robots).not.toMatch(/Disallow:\s*\/\s*$/m);
	});

	test('workspace (/workspace) is NOT crawlable: page sets noindex,nofollow', () => {
		const page = readFile('src/pages/workspace.astro');

		expect(page).toMatch(/robots\s*=\s*"noindex,\s*nofollow"/);
	});

	test('observability (/observability) is NOT crawlable: page noindex + robots.txt Disallow', () => {
		const page = readFile('src/pages/observability.astro');
		const robots = readFile('public/robots.txt');

		expect(page).toMatch(/robots\s*=\s*"noindex,\s*nofollow"/);
		expect(robots).toMatch(/Disallow:\s*\/observability\//i);
	});

	test('observability dashboard (/observability/dashboard) is NOT crawlable: page noindex + robots.txt Disallow', () => {
		const page = readFile('src/pages/observability/dashboard.astro');
		const robots = readFile('public/robots.txt');

		expect(page).toMatch(/robots\s*=\s*"noindex,\s*nofollow"/);
		expect(robots).toMatch(/Disallow:\s*\/observability\//i);
	});

	test('sitemap config excludes observability paths but includes public pages', () => {
		const config = readFile('astro.config.mjs');

		// Filter should exclude observability
		expect(config).toMatch(/filter.*observability/s);
		// Should NOT exclude workspace or root (they use meta noindex)
		expect(config).not.toMatch(/filter.*workspace/s);
	});
});
