import { defineConfig } from '@playwright/test';

const frontendPort = 4411;
const backendPort = 8011;

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 60_000,
	expect: {
		timeout: 10_000,
	},
	fullyParallel: false,
	retries: 0,
	use: {
		baseURL: `http://127.0.0.1:${frontendPort}`,
		headless: true,
	},
	webServer: [
		{
			command: `uv run uvicorn src.main:app --host 127.0.0.1 --port ${backendPort}`,
			cwd: '../backend',
			url: `http://127.0.0.1:${backendPort}/docs`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			command: `pnpm dev --host 127.0.0.1 --port ${frontendPort}`,
			cwd: '.',
			url: `http://127.0.0.1:${frontendPort}`,
			reuseExistingServer: false,
			timeout: 120_000,
			env: {
				PUBLIC_BACKEND_ENDPOINT: `http://127.0.0.1:${backendPort}`,
			},
		},
	],
});
