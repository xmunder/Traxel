import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'jsdom',
		include: ['tests/vectorize-runtime.smoke.test.ts'],
		exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
		testTimeout: 40000,
		hookTimeout: 200000,
	},
});
