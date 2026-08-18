import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(process.cwd(), '..');
const imagePath = resolve(projectRoot, 'assets_test/Logos/youtube-logo-vector-400x400.png');
const docsImages = resolve(projectRoot, 'docs/images');
const framesDir = '/tmp/opencode/traxel-readme-frames';

const summary = {
		total_requests: 128,
		total_errors: 7,
		status_counts: { '200': 104, '400': 12, '404': 5, '500': 7 },
		path_counts: { '/health': 72, '/vectorize': 49, other: 7 },
		requests_buffer_size: 128,
		errors_buffer_size: 7,
};

const requests = {
	items: [
		{
			timestamp: '2026-08-18T12:00:00Z',
			method: 'POST',
			path: '/vectorize',
			status_code: 200,
			duration_ms: 184,
			message: 'OK',
		},
	],
	total: 1,
};

const errors = {
	items: [
		{
			timestamp: '2026-08-18T11:58:00Z',
			method: 'POST',
			path: '/vectorize',
			error_type: 'ValidationError',
			error_detail: 'The uploaded file is not a decodable image.',
		},
	],
	total: 1,
};

const timeseries = {
	buckets: [
		{ bucket: '2026-08-18T11:00', count: 20, count_2xx: 17, count_4xx: 2, count_5xx: 1 },
		{ bucket: '2026-08-18T12:00', count: 31, count_2xx: 26, count_4xx: 3, count_5xx: 2 },
	],
	range: '12h',
	bucket_width: '1h',
	total: 51,
};

test('captures current README product evidence', async ({ page }) => {
	expect(existsSync(imagePath)).toBe(true);
	mkdirSync(docsImages, { recursive: true });
	mkdirSync(framesDir, { recursive: true });
	await page.setViewportSize({ width: 1440, height: 1000 });

	await page.route('**/vectorize', async (route) => {
		await new Promise((resolveRequest) => setTimeout(resolveRequest, 1_400));
		await route.continue();
	});

	await page.goto('/');
	await page.evaluate(() => {
		document.documentElement.style.zoom = '0.88';
	});
	await page.screenshot({ path: resolve(docsImages, 'traxel-home-hero.png'), fullPage: false });
	await page.screenshot({ path: resolve(framesDir, 'frame-01.png'), fullPage: false });
	await page.evaluate(() => {
		document.documentElement.style.zoom = '';
	});

	await page.setInputFiles('[data-image-input]', imagePath);
	await expect(page.locator('[data-processing-overlay]')).toBeVisible();
	await page.screenshot({ path: resolve(docsImages, 'traxel-processing-state.png'), fullPage: true });
	await page.screenshot({ path: resolve(framesDir, 'frame-02.png'), fullPage: true });

	await expect(page).toHaveURL(/\/workspace$/);
	await expect(page.locator('[data-svg-container]')).toBeVisible();
	await page.screenshot({ path: resolve(docsImages, 'traxel-workspace.png'), fullPage: true });
	await page.screenshot({ path: resolve(framesDir, 'frame-03.png'), fullPage: true });

	await page.route('**/obs/summary**', (route) => route.fulfill({ status: 200, json: summary }));
	await page.route('**/obs/requests**', (route) => route.fulfill({ status: 200, json: requests }));
	await page.route('**/obs/errors**', (route) => route.fulfill({ status: 200, json: errors }));
	await page.route('**/obs/timeseries**', (route) => route.fulfill({ status: 200, json: timeseries }));

	await page.goto('/observability');
	await page.fill('[data-obs-username]', 'demo');
	await page.fill('[data-obs-password]', 'demo');
	await page.click('[data-obs-login-submit]');
	await expect(page).toHaveURL(/\/observability\/dashboard$/);
	await expect(page.locator('[data-obs-dashboard]')).toBeVisible();
	await expect(page.locator('[data-obs-total-requests]')).toHaveText('128');
	await expect(page.locator('[data-obs-requests] .obs-table')).toBeVisible();
	await expect(page.locator('[data-obs-errors] .obs-table')).toBeVisible();
	await page.waitForTimeout(1_500);
	await page.screenshot({ path: resolve(docsImages, 'traxel-observability-dashboard.png'), fullPage: true });
});
