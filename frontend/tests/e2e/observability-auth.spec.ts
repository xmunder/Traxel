import { expect, test } from '@playwright/test';

/** Base URL of the backend server as declared in playwright.config.ts. */
const UNCONFIGURED_BACKEND_BASE_URL = 'http://127.0.0.1:8012';
const E2E_USERNAME = 'e2e-admin';
const E2E_SECRET = 'e2e-secret';

test.describe('observability: login page', () => {
	test('shows login form at /observability', async ({ page }) => {
		await page.goto('/observability');

		// Login form must be visible
		await expect(page.locator('[data-obs-login-form]')).toBeVisible();
		await expect(page.locator('[data-obs-username]')).toBeVisible();
		await expect(page.locator('[data-obs-password]')).toBeVisible();
		await expect(page.locator('[data-obs-login-submit]')).toBeVisible();
	});

	test('shows validation error when submitting empty username', async ({ page }) => {
		await page.goto('/observability');

		// Fill only password, leave username empty
		await page.fill('[data-obs-password]', 'secret');
		await page.click('[data-obs-login-submit]');

		const errorBox = page.locator('[data-obs-login-error]');
		await expect(errorBox).toBeVisible();
		await expect(errorBox).toContainText(/required/i);
	});

	test('shows validation error when submitting empty password', async ({ page }) => {
		await page.goto('/observability');

		// Fill only username, leave password empty
		await page.fill('[data-obs-username]', 'admin');
		await page.click('[data-obs-login-submit]');

		const errorBox = page.locator('[data-obs-login-error]');
		await expect(errorBox).toBeVisible();
		await expect(errorBox).toContainText(/required/i);
	});

	test('logs in with a session cookie, accesses the dashboard, and logs out', async ({ page }) => {
		await page.goto('/observability');
		await page.fill('[data-obs-username]', E2E_USERNAME);
		await page.fill('[data-obs-password]', E2E_SECRET);
		await page.click('[data-obs-login-submit]');

		await expect(page).toHaveURL(/\/observability\/dashboard$/);
		await expect(page.locator('[data-obs-dashboard]')).toBeVisible();
		await expect(page.locator('[data-obs-logout]')).toBeVisible();

		await page.click('[data-obs-logout]');
		await expect(page).toHaveURL(/\/observability$/);
		await expect(page.locator('[data-obs-login-form]')).toBeVisible();
	});
});

test.describe('observability: protected API without credentials configured', () => {
	test('returns 503 when OBS_USERNAME/OBS_SECRET are not set on the server', async () => {
		// Per design, the endpoint must return 503 (not 401) when creds are unset.
		//
		// /obs/summary lives on the backend, not the Astro dev server. The absolute
		// URL keeps the request independent of Playwright's frontend baseURL.
		const response = await fetch(`${UNCONFIGURED_BACKEND_BASE_URL}/obs/summary`);

		// 503 = feature not configured; 401 = creds wrong but feature configured.
		expect(response.status).toBe(503);
	});
});
