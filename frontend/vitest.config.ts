import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'jsdom',
		include: ['tests/**/*.test.ts'],
		exclude: ['tests/e2e/**', 'tests/vectorize-runtime.smoke.test.ts', 'node_modules/**', 'dist/**'],
	},
});
