import { Buffer } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { initVectorizerApp } from '../src/lib/vectorizer-app';
import { clearWorkspaceResult, readWorkspaceResult } from '../src/lib/workspace-storage';

const FRONTEND_URL = 'http://127.0.0.1:4321';
const BACKEND_URL = 'http://127.0.0.1:8000/vectorize';
const SMOKE_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAMElEQVR4nGP8//8/AymAhYGBgYGREVOCkQGLQf//MzCRZDwDw6iGUQ1U08BIavIGAA1ICRvdFHblAAAAAElFTkSuQmCC';

let backendServer: ChildProcessWithoutNullStreams | null = null;
let frontendServer: ChildProcessWithoutNullStreams | null = null;

type FakeRecordStore = Map<string, unknown>;

function createFakeIndexedDb() {
	const databases = new Map<string, { stores: Map<string, FakeRecordStore> }>();

	class FakeIDBDatabase {
		name: string;
		stores: Map<string, FakeRecordStore>;
		objectStoreNames: { contains: (name: string) => boolean };

		constructor(name: string) {
			this.name = name;
			this.stores = databases.get(name)?.stores ?? new Map();
			databases.set(name, { stores: this.stores });
			this.objectStoreNames = {
				contains: (storeName: string) => this.stores.has(storeName),
			};
		}

		createObjectStore(storeName: string) {
			if (!this.stores.has(storeName)) this.stores.set(storeName, new Map());
			return this.stores.get(storeName)!;
		}

		transaction(storeName: string) {
			if (!this.stores.has(storeName)) this.stores.set(storeName, new Map());
			const store = this.stores.get(storeName)!;
			const transaction = {
				error: null,
				onerror: null as ((this: unknown) => void) | null,
				oncomplete: null as ((this: unknown) => void) | null,
				onabort: null as ((this: unknown) => void) | null,
				objectStore: () => ({
					put(value: unknown, key: string) {
						const request = { result: undefined as unknown, error: null as unknown, onsuccess: null as ((this: unknown) => void) | null, onerror: null as ((this: unknown) => void) | null };
						queueMicrotask(() => {
							store.set(key, value);
							request.result = key;
							request.onsuccess?.call(request);
							transaction.oncomplete?.call(transaction);
						});
						return request;
					},
					get(key: string) {
						const request = { result: undefined as unknown, error: null as unknown, onsuccess: null as ((this: unknown) => void) | null, onerror: null as ((this: unknown) => void) | null };
						queueMicrotask(() => {
							request.result = store.get(key);
							request.onsuccess?.call(request);
							transaction.oncomplete?.call(transaction);
						});
						return request;
					},
					delete(key: string) {
						const request = { result: undefined as unknown, error: null as unknown, onsuccess: null as ((this: unknown) => void) | null, onerror: null as ((this: unknown) => void) | null };
						queueMicrotask(() => {
							store.delete(key);
							request.result = undefined;
							request.onsuccess?.call(request);
							transaction.oncomplete?.call(transaction);
						});
						return request;
					},
				}),
			};
			return transaction;
		}

		close() {
			return undefined;
		}
	}

	return {
		open(name: string) {
			const request = {
				result: undefined as unknown,
				error: null as unknown,
				onsuccess: null as ((this: unknown) => void) | null,
				onerror: null as ((this: unknown) => void) | null,
				onupgradeneeded: null as ((this: unknown) => void) | null,
				onblocked: null as ((this: unknown) => void) | null,
			};
			queueMicrotask(() => {
				const db = new FakeIDBDatabase(name);
				request.result = db;
				if (!db.objectStoreNames.contains('workspace-results')) {
					request.onupgradeneeded?.call(request);
				}
				request.onsuccess?.call(request);
			});
			return request;
		},
	};
}

const fakeIndexedDb = createFakeIndexedDb();

function startServer(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
	return spawn(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: 'pipe',
	});
}

async function waitForUrl(url: string, timeoutMs = 120_000): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		try {
			const response = await fetch(url);
			if (response.ok) {
				return;
			}
		} catch {
			// Retry until timeout.
		}

		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error(`Timed out waiting for ${url}`);
}

async function waitFor(condition: () => boolean | void | Promise<boolean | void>, timeoutMs = 15_000): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		try {
			const result = await condition();
			if (result !== false) {
				return;
			}
		} catch {
			// Retry until timeout.
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	await condition();
}

function stopServer(server: ChildProcessWithoutNullStreams | null): void {
	if (!server || server.killed) {
		return;
	}

	server.kill('SIGTERM');
}

function bindDom(dom: JSDOM, fetchImpl: typeof fetch): void {
	const { window } = dom;
	const NativeBlob = globalThis.Blob;
	const NativeFile = globalThis.File;
	const NativeFormData = globalThis.FormData;
	const NativeURL = globalThis.URL;

	Object.assign(globalThis, {
		window,
		document: window.document,
		DOMParser: window.DOMParser,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLImageElement: window.HTMLImageElement,
		SVGElement: window.SVGElement,
		Event: window.Event,
		CustomEvent: window.CustomEvent,
		Blob: NativeBlob,
		File: NativeFile,
		FileReader: window.FileReader,
		FormData: NativeFormData,
		indexedDB: fakeIndexedDb,
		fetch: fetchImpl,
		sessionStorage: window.sessionStorage,
	});

	Object.defineProperty(window, 'indexedDB', {
		value: fakeIndexedDb,
		configurable: true,
	});

	Object.defineProperty(window.URL, 'createObjectURL', {
		value: vi.fn(() => 'blob:vectorizer-smoke'),
		configurable: true,
	});
	Object.defineProperty(window.URL, 'revokeObjectURL', {
		value: () => undefined,
		configurable: true,
	});
	Object.defineProperty(globalThis, 'URL', {
		value: window.URL ?? NativeURL,
		configurable: true,
	});
}

beforeAll(async () => {
	backendServer = startServer(
		'uv',
		['run', 'uvicorn', 'src.main:app', '--host', '127.0.0.1', '--port', '8000'],
		{
			cwd: '/home/msi/dev/vectorizer/backend',
		},
	);
	frontendServer = startServer('pnpm', ['dev', '--host', '127.0.0.1', '--port', '4321'], {
		cwd: '/home/msi/dev/vectorizer/frontend',
		env: {
			PUBLIC_VECTORIZE_ENDPOINT: BACKEND_URL,
		},
	});

	await Promise.all([waitForUrl('http://127.0.0.1:8000/docs'), waitForUrl(FRONTEND_URL)]);
}, 180_000);

afterAll(() => {
	stopServer(frontendServer);
	stopServer(backendServer);
});

afterAll(async () => {
	await clearWorkspaceResult();
});

describe('frontend runtime smoke', () => {
	test(
		'carga imagen desde / y muestra comparación completa en /workspace',
		async () => {
			const uploadHtml = await fetch(FRONTEND_URL).then(async (response) => response.text());
			const uploadDom = new JSDOM(uploadHtml, {
				url: FRONTEND_URL,
				pretendToBeVisual: true,
			});

			bindDom(uploadDom, fetch);
			initVectorizerApp();

			expect(uploadDom.window.document.body.textContent).toContain('Optimized for logos');

			const input = uploadDom.window.document.querySelector<HTMLInputElement>('[data-image-input]');
			const status = uploadDom.window.document.querySelector<HTMLElement>('[data-status]');

			expect(input).not.toBeNull();
			expect(status).not.toBeNull();

			const file = new File([Buffer.from(SMOKE_PNG_BASE64, 'base64')], 'smoke-logo.png', {
				type: 'image/png',
			});

			Object.defineProperty(input!, 'files', {
				value: [file],
				configurable: true,
			});
			input!.dispatchEvent(new uploadDom.window.Event('change', { bubbles: true }));

			await waitFor(() => status!.textContent?.includes('Redirecting to workspace') ?? false);

			await waitFor(async () => {
				const current = await readWorkspaceResult();
				expect(current).not.toBeNull();
			});

			const stored = await readWorkspaceResult();
			expect(stored).not.toBeNull();

			const workspaceHtml = await fetch(`${FRONTEND_URL}/workspace`).then(async (response) => response.text());
			const workspaceDom = new JSDOM(workspaceHtml, {
				url: `${FRONTEND_URL}/workspace`,
				pretendToBeVisual: true,
			});

			bindDom(workspaceDom, fetch);

			initVectorizerApp();

			await waitFor(() => {
				const ready = workspaceDom.window.document.querySelector<HTMLElement>('[data-workspace-ready]');
				const originalImage = workspaceDom.window.document.querySelector<HTMLImageElement>('[data-original-image]');
				const svgContainer = workspaceDom.window.document.querySelector<HTMLElement>('[data-svg-container]');
				const downloadLink = workspaceDom.window.document.querySelector<HTMLAnchorElement>('[data-download-link]');
				const colors = workspaceDom.window.document.querySelector<HTMLElement>('[data-metadata-colors]');
				const paths = workspaceDom.window.document.querySelector<HTMLElement>('[data-metadata-paths]');
				const duration = workspaceDom.window.document.querySelector<HTMLElement>('[data-metadata-duration]');

				expect(ready?.hidden).toBe(false);
				expect(originalImage?.getAttribute('src')).toContain('blob:');
				expect(svgContainer?.innerHTML).toContain('<svg');
				expect(downloadLink?.getAttribute('aria-disabled')).toBe('false');
				expect(downloadLink?.getAttribute('download')).toBe('smoke-logo.svg');
				expect(colors?.textContent).not.toBe('—');
				expect(paths?.textContent).not.toBe('—');
				expect(duration?.textContent).toContain('ms');
			});

			uploadDom.window.close();
			workspaceDom.window.close();
		},
		60_000,
	);
});
