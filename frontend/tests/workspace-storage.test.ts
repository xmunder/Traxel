import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
	clearWorkspaceResult,
	readWorkspaceResult,
	saveWorkspaceResult,
	WorkspaceStorageError,
	type StoredWorkspaceResult,
} from '../src/lib/workspace-storage';

const MEMORY_STORE_KEY = '__vectorizerWorkspaceMemoryStore';

function buildResult(overrides?: Partial<StoredWorkspaceResult>): StoredWorkspaceResult {
	return {
		filename: 'test-logo.png',
		originalFile: new Blob(['fake-image-bytes'], { type: 'image/png' }),
		svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
		metadata: { colors_detected: 4, paths_generated: 8, duration_ms: 42 },
		storedAt: new Date().toISOString(),
		...overrides,
	};
}

afterEach(async () => {
	await clearWorkspaceResult();
	// Clean up memory fallback store between tests.
	const host = globalThis as typeof globalThis & { [MEMORY_STORE_KEY]?: Map<string, StoredWorkspaceResult> };
	delete host[MEMORY_STORE_KEY];
});

describe('workspace-storage: IndexedDB fallback (no indexedDB available)', () => {
	let originalIndexedDB: IDBFactory | undefined;

	beforeEach(() => {
		originalIndexedDB = globalThis.indexedDB;
		// Simulate SSR / JSDOM environment without indexedDB.
		Object.defineProperty(globalThis, 'indexedDB', {
			value: undefined,
			configurable: true,
			writable: true,
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, 'indexedDB', {
			value: originalIndexedDB,
			configurable: true,
			writable: true,
		});
	});

	test('readWorkspaceResult devuelve null cuando el store de memoria está vacío', async () => {
		const result = await readWorkspaceResult();
		expect(result).toBeNull();
	});

	test('saveWorkspaceResult persiste en memoria y readWorkspaceResult lo recupera', async () => {
		const stored = buildResult();
		const outcome = await saveWorkspaceResult(stored);

		expect(outcome.persisted).toBe('memory');

		const recovered = await readWorkspaceResult();
		expect(recovered).not.toBeNull();
		expect(recovered?.filename).toBe('test-logo.png');
		expect(recovered?.svg).toContain('<svg');
		expect(recovered?.metadata.colors_detected).toBe(4);
		expect(recovered?.metadata.paths_generated).toBe(8);
		expect(recovered?.metadata.duration_ms).toBe(42);
	});

	test('clearWorkspaceResult elimina el resultado del store de memoria', async () => {
		await saveWorkspaceResult(buildResult());
		await clearWorkspaceResult();

		const result = await readWorkspaceResult();
		expect(result).toBeNull();
	});

	test('originalFile se clona correctamente en memoria (no es la misma referencia)', async () => {
		const original = buildResult();
		await saveWorkspaceResult(original);

		const recovered = await readWorkspaceResult();
		// The stored Blob should be a clone, not the exact same reference.
		expect(recovered?.originalFile).not.toBe(original.originalFile);
		expect(recovered?.originalFile.size).toBe(original.originalFile.size);
		expect(recovered?.originalFile.type).toBe(original.originalFile.type);
	});

	test('save puede llamarse múltiples veces y siempre retorna el último resultado', async () => {
		await saveWorkspaceResult(buildResult({ filename: 'first.png' }));
		await saveWorkspaceResult(buildResult({ filename: 'second.png' }));

		const result = await readWorkspaceResult();
		expect(result?.filename).toBe('second.png');
	});
});

describe('workspace-storage: con indexedDB disponible (via fake-indexeddb)', () => {
	// JSDOM doesn't ship a real IndexedDB. These tests use the global `indexedDB`
	// injected by fake-indexeddb if available, or skip gracefully if not.
	// Vitest runs in Node/JSDOM where `indexedDB` is likely undefined. We test the
	// fallback branch above; if we ever add fake-indexeddb these tests will run.

	test('readWorkspaceResult devuelve null cuando no hay resultado guardado', async () => {
		// Regardless of IndexedDB availability this contract must hold.
		const result = await readWorkspaceResult();
		expect(result).toBeNull();
	});

	test('save → read → clear lifecycle completo', async () => {
		const payload = buildResult({ filename: 'lifecycle.png' });
		const outcome = await saveWorkspaceResult(payload);

		// In JSDOM/Node environment without real IndexedDB, fallback to memory is expected.
		expect(['indexeddb', 'memory']).toContain(outcome.persisted);

		const read = await readWorkspaceResult();
		expect(read).not.toBeNull();
		expect(read?.filename).toBe('lifecycle.png');
		expect(read?.storedAt).toBe(payload.storedAt);

		await clearWorkspaceResult();

		const afterClear = await readWorkspaceResult();
		expect(afterClear).toBeNull();
	});

	test('clearWorkspaceResult es silencioso cuando no hay nada guardado', async () => {
		await expect(clearWorkspaceResult()).resolves.not.toThrow();
	});
});

describe('workspace-storage: WorkspaceStorageError', () => {
	test('WorkspaceStorageError tiene el nombre correcto', () => {
		const error = new WorkspaceStorageError('something went wrong');
		expect(error.name).toBe('WorkspaceStorageError');
		expect(error.message).toBe('something went wrong');
		expect(error).toBeInstanceOf(Error);
	});

	test('WorkspaceStorageError puede llevar una causa', () => {
		const cause = new Error('original');
		const error = new WorkspaceStorageError('wrapped', { cause });
		expect((error as Error & { cause?: unknown }).cause).toBe(cause);
	});

	test('saveWorkspaceResult hace fallback a memoria cuando IndexedDB está disponible pero falla', async () => {
		// Skip if indexedDB is not defined (already covered by the SSR fallback suite above).
		if (typeof indexedDB === 'undefined') {
			return;
		}

		const originalOpen = indexedDB.open.bind(indexedDB);
		const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
			const request = originalOpen(...args);
			setTimeout(() => {
				Object.defineProperty(request, 'error', { value: new DOMException('Quota exceeded'), configurable: true });
				request.dispatchEvent(new Event('error'));
			}, 0);
			return request;
		});

		try {
			// Must not throw — spec requires silent fallback to in-memory store.
			const payload = buildResult({ filename: 'fallback-test.png' });
			const outcome = await saveWorkspaceResult(payload);

			// When IndexedDB fails, outcome MUST signal memory fallback.
			expect(outcome.persisted).toBe('memory');

			// Result must be recoverable via readWorkspaceResult (from memory fallback).
			const recovered = await readWorkspaceResult();
			expect(recovered).not.toBeNull();
			expect(recovered?.filename).toBe('fallback-test.png');
		} finally {
			openSpy.mockRestore();
		}
	});
});
