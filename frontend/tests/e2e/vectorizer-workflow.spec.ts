import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.resolve(__dirname, '../../../assets_test/Logos/Adidas-logo-400x400.png');

test('flujo e2e: upload -> workspace -> comparación -> descarga', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: /convert pixels/i })).toBeVisible();
	await expect(page.locator('[data-warning]')).toContainText(/optimized for logos/i);

	await page.setInputFiles('[data-image-input]', fixturePath);

	await expect(page).toHaveURL(/\/workspace$/);
	await expect(page.getByText(/comparison workspace/i)).toBeVisible();

	const originalImage = page.locator('[data-original-image]');
	const svgContainer = page.locator('[data-svg-container]');
	const downloadLink = page.locator('[data-download-link]');

	await expect(originalImage).toBeVisible();
	await expect(originalImage).toHaveAttribute('src', /data:image/);
	await expect(svgContainer.locator('svg')).toBeVisible();
	await expect(page.locator('[data-metadata-colors]')).not.toHaveText('—');
	await expect(page.locator('[data-metadata-paths]')).not.toHaveText('—');
	await expect(page.locator('[data-metadata-duration]')).toContainText('ms');

	const downloadPromise = page.waitForEvent('download');
	await downloadLink.click();
	const download = await downloadPromise;

	expect(download.suggestedFilename()).toMatch(/\.svg$/);
});
