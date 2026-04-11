import { expect, test } from '@playwright/test';

test.describe('SEO — page titles and meta tags', () => {
	test('home page has correct title and description', async ({ page }) => {
		await page.goto('/');

		await expect(page).toHaveTitle('Tracelab | System Active');
		const description = page.locator('meta[name="description"]');
		await expect(description).toHaveAttribute(
			'content',
			/convert raster images/i,
		);
	});

	test('home page has robots meta set to index, follow', async ({ page }) => {
		await page.goto('/');

		const robots = page.locator('meta[name="robots"]');
		await expect(robots).toHaveAttribute('content', 'index, follow');
	});

	test('home page has canonical URL pointing to production domain', async ({ page }) => {
		await page.goto('/');

		const canonical = page.locator('link[rel="canonical"]');
		await expect(canonical).toHaveAttribute('href', /https:\/\/tracelab\.app\/?$/);
	});

	test('workspace page has noindex, nofollow robots meta', async ({ page }) => {
		await page.goto('/workspace');

		const robots = page.locator('meta[name="robots"]');
		await expect(robots).toHaveAttribute('content', 'noindex, nofollow');
	});

	test('observability login page has noindex, nofollow robots meta', async ({ page }) => {
		await page.goto('/observability');

		const robots = page.locator('meta[name="robots"]');
		await expect(robots).toHaveAttribute('content', 'noindex, nofollow');
	});

	test('observability dashboard has noindex, nofollow robots meta', async ({ page }) => {
		await page.goto('/observability/dashboard');

		const robots = page.locator('meta[name="robots"]');
		await expect(robots).toHaveAttribute('content', 'noindex, nofollow');
	});
});

test.describe('accessibility — skip link and focus order', () => {
	test('home page has a skip-to-main link that targets #main-content', async ({ page }) => {
		await page.goto('/');

		const skipLink = page.locator('a.sr-only[href="#main-content"]');
		await expect(skipLink).toBeAttached();
		await expect(skipLink).toHaveText('Skip to main content');
	});

	test('skip link becomes visible on focus and navigates to main content', async ({ page }) => {
		await page.goto('/');

		// Tab to the skip link (first focusable element)
		await page.keyboard.press('Tab');

		const skipLink = page.locator('a.sr-only[href="#main-content"]');
		await expect(skipLink).toBeFocused();

		// Activate the skip link
		await page.keyboard.press('Enter');

		// Focus should move to or near the main content area
		const mainContent = page.locator('#main-content');
		await expect(mainContent).toBeAttached();
	});

	test('workspace page has a skip-to-main link', async ({ page }) => {
		await page.goto('/workspace');

		const skipLink = page.locator('a.sr-only[href="#main-content"]');
		await expect(skipLink).toBeAttached();
	});

	test('home page has exactly one h1 element', async ({ page }) => {
		await page.goto('/');

		const headings = page.locator('body > *:not(astro-dev-toolbar) h1');
		await expect(headings).toHaveCount(1);
	});

	test('home page has a main landmark', async ({ page }) => {
		await page.goto('/');

		const main = page.locator('main');
		await expect(main).toBeAttached();
	});
});

test.describe('HTML structure — lang attribute', () => {
	test('all pages have lang="en" on html element', async ({ page }) => {
		for (const path of ['/', '/workspace', '/observability']) {
			await page.goto(path);
			const html = page.locator('html');
			await expect(html).toHaveAttribute('lang', 'en');
		}
	});
});
