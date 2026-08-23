import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.resolve(__dirname, '../../../assets_test/Logos/Adidas-logo-400x400.png');

test('flujo e2e: upload -> workspace -> comparación -> descarga', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: /convert pixels/i })).toBeVisible();
	await expect(page.getByRole('heading', { name: /drag and drop/i })).toBeVisible();
	await expect(page.getByText(/or select a local file/i)).toBeVisible();
	await expect(page.locator('body')).toContainText(/optimized for logos/i);

	await page.setInputFiles('[data-image-input]', fixturePath);

	await expect(page).toHaveURL(/\/workspace$/);
	await expect(page.locator('.workspace-review-header__brand')).toContainText(/traxel vector workspace/i);

	const originalImage = page.locator('[data-original-image]');
	const svgContainer = page.locator('[data-svg-container]');
	const downloadLink = page.locator('[data-download-link]');

	await expect(originalImage).toBeVisible();
	// The image is stored as a Blob in IndexedDB and rendered via a blob: URL.
	await expect(originalImage).toHaveAttribute('src', /blob:/);
	await expect(svgContainer.locator('svg')).toBeVisible();
	await expect(page.locator('[data-metadata-colors]')).not.toHaveText('—');
	await expect(page.locator('[data-metadata-paths]')).not.toHaveText('—');
	await expect(page.locator('[data-metadata-duration]')).toContainText('ms');

	const downloadPromise = page.waitForEvent('download');
	await downloadLink.click();
	const download = await downloadPromise;

	expect(download.suggestedFilename()).toMatch(/\.svg$/);
});

test('el flujo upload→workspace no escribe ni lee sessionStorage (evidencia runtime)', async ({ page }) => {
	// Track all sessionStorage writes during the entire upload→workspace flow.
	const sessionStorageWrites: { key: string; value: string }[] = [];
	const sessionStorageReads: string[] = [];

	await page.addInitScript(() => {
		const originalSetItem = Storage.prototype.setItem;
		const originalGetItem = Storage.prototype.getItem;

		Storage.prototype.setItem = function (key: string, value: string) {
			if (this === window.sessionStorage) {
				(window as typeof window & { __sessionStorageWrites?: { key: string; value: string }[] }).__sessionStorageWrites ??= [];
				(window as typeof window & { __sessionStorageWrites?: { key: string; value: string }[] }).__sessionStorageWrites!.push({ key, value });
			}
			originalSetItem.call(this, key, value);
		};

		Storage.prototype.getItem = function (key: string) {
			if (this === window.sessionStorage) {
				(window as typeof window & { __sessionStorageReads?: string[] }).__sessionStorageReads ??= [];
				(window as typeof window & { __sessionStorageReads?: string[] }).__sessionStorageReads!.push(key);
			}
			return originalGetItem.call(this, key);
		};
	});

	await page.goto('/');
	await page.setInputFiles('[data-image-input]', fixturePath);
	await expect(page).toHaveURL(/\/workspace$/);

	// Wait for workspace to render successfully.
	await expect(page.locator('[data-workspace-ready]')).toBeVisible();

	// Collect intercepted writes/reads from the upload page context.
	const writes = await page.evaluate(
		() => (window as typeof window & { __sessionStorageWrites?: { key: string; value: string }[] }).__sessionStorageWrites ?? [],
	);
	const reads = await page.evaluate(
		() => (window as typeof window & { __sessionStorageReads?: string[] }).__sessionStorageReads ?? [],
	);

	sessionStorageWrites.push(...writes);
	sessionStorageReads.push(...reads);

	// The upload→workspace flow MUST NOT use sessionStorage at all.
	expect(sessionStorageWrites).toHaveLength(0);
	expect(sessionStorageReads).toHaveLength(0);
});

test('evidencia runtime: si IndexedDB queda inaccesible, el fallback en memoria no sobrevive la navegación completa', async ({ page }) => {
	await page.addInitScript(() => {
		type Probe = { indexedDbDisabled: boolean };
		const PROBE_KEY = '__vectorizerIndexedDbFallbackProbe__';

		const readProbe = (): Probe => {
			const host = window as typeof window & { [PROBE_KEY]?: Probe };
			return host[PROBE_KEY] ?? { indexedDbDisabled: false };
		};

		const writeProbe = (probe: Probe): void => {
			const host = window as typeof window & { [PROBE_KEY]?: Probe };
			host[PROBE_KEY] = probe;
			try {
				window.name = JSON.stringify({ [PROBE_KEY]: probe });
			} catch {
				// Ignore serialization errors in the probe channel.
			}
		};

		const restoreProbeFromWindowName = (): void => {
			try {
				const parsed = JSON.parse(window.name || '{}') as { [PROBE_KEY]?: Probe };
				if (parsed[PROBE_KEY]) {
					writeProbe(parsed[PROBE_KEY]);
				}
			} catch {
				writeProbe(readProbe());
			}
		};

		restoreProbeFromWindowName();

		writeProbe({ indexedDbDisabled: true });
		Object.defineProperty(window, 'indexedDB', {
			value: undefined,
			configurable: true,
			writable: true,
		});
	});

	await page.goto('/');

	// Intercept the download triggered by the SVG fallback.
	const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });

	const vectorizeResponsePromise = page.waitForResponse(
		(response) => response.url().endsWith('/vectorize') && response.request().method() === 'POST',
	);
	await page.setInputFiles('[data-image-input]', fixturePath);
	const vectorizeResponse = await vectorizeResponsePromise;

	const probe = await page.evaluate(() => {
		const parsed = JSON.parse(window.name || '{}') as {
			__vectorizerIndexedDbFallbackProbe__?: { indexedDbDisabled: boolean };
		};
		return parsed.__vectorizerIndexedDbFallbackProbe__ ?? { indexedDbDisabled: false };
	});

	// MUST remain on "/" — no navigation to /workspace.
	await expect(page).not.toHaveURL(/\/workspace$/);
	await expect(page.getByRole('heading', { name: /convert pixels/i })).toBeVisible();

	// MUST trigger an automatic SVG download.
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/\.svg$/);

	expect(vectorizeResponse.status()).toBe(200);
	expect(probe.indexedDbDisabled).toBe(true);
});

test('edita, restaura y exporta la paleta sin re-vectorizar en un workspace angosto', async ({ page }) => {
	let vectorizeRequests = 0;
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().endsWith('/vectorize')) vectorizeRequests += 1;
	});

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/');
	await page.setInputFiles('[data-image-input]', fixturePath);
	await expect(page).toHaveURL(/\/workspace$/);

	const palette = page.getByRole('region', { name: 'Edit colors' });
	await expect(palette).toBeVisible();
	const hexInputs = palette.locator('[data-palette-hex]');
	await expect(hexInputs.first()).toBeVisible();
	const source = await hexInputs.first().getAttribute('data-source');
	expect(source).toMatch(/^#[0-9A-F]{6}$/);
	if (!source) throw new Error('The generated SVG did not expose an editable source color.');

	await hexInputs.first().focus();
	await hexInputs.first().fill('#123456');
	await expect(hexInputs.first()).toHaveAttribute('aria-invalid', 'false');
	await expect(page.locator('[data-svg-container] path[fill="#123456"]')).not.toHaveCount(0);
	await expect(page.locator('[data-persistence-status]')).toContainText('saved');
	expect(vectorizeRequests).toBe(1);

	const downloadPromise = page.waitForEvent('download');
	await page.locator('[data-download-link]').click();
	const download = await downloadPromise;
	const downloadedSvg = await download.createReadStream();
	let downloadedText = '';
	for await (const chunk of downloadedSvg) downloadedText += chunk.toString();
	expect(downloadedText).toContain('#123456');

	await page.reload();
	await expect(page.locator('[data-svg-container] path[fill="#123456"]')).not.toHaveCount(0);
	expect(vectorizeRequests).toBe(1);

	await page.getByRole('button', { name: `Reset ${source}` }).click();
	await expect(page.locator(`[data-svg-container] path[fill="${source}"]`)).not.toHaveCount(0);
	await page.getByRole('button', { name: 'Reset all colors' }).click();
	await expect(page.locator('[data-palette-hex]').first()).toHaveValue(source);

	const viewportHasNoHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
	expect(viewportHasNoHorizontalOverflow).toBe(true);
	await expect(page.locator('.workspace-review-panel__canvas')).toHaveCount(2);
	for (const canvas of await page.locator('.workspace-review-panel__canvas').all()) {
		await expect(canvas).toBeVisible();
	}
});
