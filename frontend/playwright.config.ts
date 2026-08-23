import { defineConfig } from '@playwright/test';

const frontendPort = 4411;
const configuredBackendPort = 8011;
const unconfiguredBackendPort = 8012;
const smokeTopology = process.env.TRAXEL_E2E_TOPOLOGY === 'smoke';

const gracefulShutdown = {
	signal: 'SIGTERM' as const,
	timeout: 10_000,
};

const backendServer = (mode: 'configured' | 'unconfigured' | 'smoke', port: number) => ({
	name: `${mode} backend`,
	command: `node tests/e2e/server-wrapper.mjs ${mode} ${port}`,
	cwd: '.',
	port,
	reuseExistingServer: false,
	timeout: 120_000,
	gracefulShutdown,
});

const frontendServer = {
	name: 'frontend',
	command: `node node_modules/astro/bin/astro.mjs dev --host 127.0.0.1 --port ${frontendPort}`,
	cwd: '.',
	env: {
		PUBLIC_BACKEND_ENDPOINT: `http://127.0.0.1:${configuredBackendPort}`,
	},
	port: frontendPort,
	reuseExistingServer: false,
	timeout: 120_000,
	gracefulShutdown,
};

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
	webServer: smokeTopology
		? [backendServer('smoke', configuredBackendPort), frontendServer]
		: [
				backendServer('configured', configuredBackendPort),
				backendServer('unconfigured', unconfiguredBackendPort),
				frontendServer,
			],
});
