import { Buffer } from 'node:buffer';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { initVectorizerApp } from '../src/lib/vectorizer-app';
import { clearWorkspaceResult, readWorkspaceResult, saveWorkspaceResult } from '../src/lib/workspace-storage';

const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAMElEQVR4nGP8//8/AymAhYGBgYGREVOCkQGLQf//MzCRZDwDw6iGUQ1U08BIavIGAA1ICRvdFHblAAAAAElFTkSuQmCC';
const JPEG_BASE64 =
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAfEAACAQQDAQAAAAAAAAAAAAABAgMABAURIQYxQVH/xAAVAQEBAAAAAAAAAAAAAAAAAAAFBv/EABwRAAICAgMAAAAAAAAAAAAAAAABAhEDEiExQf/aAAwDAQACEQMRAD8AtNqLwXEmxLhV7bW0QpUe5LwR4XlSQOq5x3x3rHjM0u7Y3dW7R8h8fCt4dO1zM7WfPj9B1Fv8AFVnW3YhZQ0nCqQH0qfX1X0x0k9nO5cP/2Q==';

type MockResponse = {
	ok: boolean;
	status: number;
	body: unknown;
};

type DomContext = {
	window: Window & typeof globalThis;
	document: Document;
	input: HTMLInputElement;
	uploadTrigger: HTMLElement | null;
	status: HTMLElement | null;
	errorBox: HTMLElement | null;
	warning: HTMLElement | null;
	processingOverlay: HTMLElement | null;
	cleanup: () => void;
};

function createUploadMarkup(): string {
	return `
		<main data-vectorizer-app data-page="upload" data-endpoint="http://vectorizer.test/vectorize" data-workspace-path="/workspace" data-state="idle">
			<div data-processing-overlay hidden aria-hidden="true">
				<h3 data-processing-status>PROCESSING</h3>
				<p data-processing-message>Preparing vectorization...</p>
				<strong data-selected-file>No file selected.</strong>
			</div>
			<section data-warning>
				<strong>NON-BLOCKING NOTICE</strong>
				<span>Optimized for logos & icons. Complex photos may lose fidelity, but the upload flow stays available.</span>
			</section>
			<form data-upload-form>
				<input data-image-input type="file" />
				<div data-dropzone aria-busy="false"></div>
				<button type="button" data-upload-trigger>UPLOAD IMAGE</button>
				<span data-state-label>READY</span>
				<p data-state-copy>Waiting for an image to vectorize.</p>
				<p data-status>Waiting for an image to vectorize.</p>
				<p data-error hidden></p>
				<strong data-state-footer>STATE: IDLE</strong>
			</form>
		</main>
	`;
}

function createWorkspaceMarkup(): string {
	return `
		<main data-vectorizer-app data-page="workspace" data-state="idle">
			<strong data-state-footer>STATE: STANDBY</strong>
			<section data-warning>Best results still come from logos and icons.</section>
			<section data-workspace-empty hidden>
				<a href="/">RETURN TO PORTAL</a>
			</section>
			<section data-workspace-ready hidden>
				<h2 data-workspace-filename>Session asset ready.</h2>
				<span data-trace-quality>ULTRA</span>
				<span data-accuracy-index>98.4%</span>
				<span data-system-status>OPERATIONAL</span>
				<img data-original-image alt="original" />
				<div data-svg-container></div>
				<a data-download-link href="#" aria-disabled="true">DOWNLOAD_SVG_V1</a>
				<dd data-metadata-colors>—</dd>
				<dd data-metadata-paths>—</dd>
				<dd data-metadata-bezier>—</dd>
				<dd data-metadata-duration>—</dd>
				<ul data-log-list></ul>
			</section>
		</main>
	`;
}

function setupDom(markup: string, fetchMock: typeof fetch): DomContext {
	const dom = new JSDOM(markup, {
		url: 'http://vectorizer.test',
		pretendToBeVisual: true,
	});
	const native = {
		window: globalThis.window,
		document: globalThis.document,
		DOMParser: globalThis.DOMParser,
		HTMLElement: globalThis.HTMLElement,
		HTMLInputElement: globalThis.HTMLInputElement,
		HTMLImageElement: globalThis.HTMLImageElement,
		SVGElement: globalThis.SVGElement,
		Event: globalThis.Event,
		Blob: globalThis.Blob,
		File: globalThis.File,
		FileReader: globalThis.FileReader,
		FormData: globalThis.FormData,
		URL: globalThis.URL,
		CustomEvent: globalThis.CustomEvent,
		fetch: globalThis.fetch,
		sessionStorage: globalThis.sessionStorage,
	};
	const createObjectURL = vi.fn(() => 'blob:vectorizer-download');
	const revokeObjectURL = vi.fn();

	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		DOMParser: dom.window.DOMParser,
		HTMLElement: dom.window.HTMLElement,
		HTMLInputElement: dom.window.HTMLInputElement,
		HTMLImageElement: dom.window.HTMLImageElement,
		SVGElement: dom.window.SVGElement,
		Event: dom.window.Event,
		Blob,
		File,
		FileReader: dom.window.FileReader,
		FormData,
		CustomEvent: dom.window.CustomEvent,
		fetch: fetchMock,
		sessionStorage: dom.window.sessionStorage,
	});

	Object.defineProperty(dom.window, 'URL', {
		value: {
			...dom.window.URL,
			createObjectURL,
			revokeObjectURL,
		},
		configurable: true,
	});
	Object.defineProperty(globalThis, 'URL', {
		value: dom.window.URL,
		configurable: true,
	});

	initVectorizerApp();

	const cleanup = (): void => {
		dom.window.close();
		globalThis.window = native.window;
		globalThis.document = native.document;
		globalThis.DOMParser = native.DOMParser;
		globalThis.HTMLElement = native.HTMLElement;
		globalThis.HTMLInputElement = native.HTMLInputElement;
		globalThis.HTMLImageElement = native.HTMLImageElement;
		globalThis.SVGElement = native.SVGElement;
		globalThis.Event = native.Event;
		globalThis.Blob = native.Blob;
		globalThis.File = native.File;
		globalThis.FileReader = native.FileReader;
		globalThis.FormData = native.FormData;
		globalThis.CustomEvent = native.CustomEvent;
		globalThis.fetch = native.fetch;
		globalThis.sessionStorage = native.sessionStorage;
		Object.defineProperty(globalThis, 'URL', {
			value: native.URL,
			configurable: true,
			writable: true,
		});
	};

	return {
		window: dom.window as unknown as Window & typeof globalThis,
		document: dom.window.document,
		input: dom.window.document.querySelector('[data-image-input]') as HTMLInputElement,
		uploadTrigger: dom.window.document.querySelector('[data-upload-trigger]'),
		status: dom.window.document.querySelector('[data-status]'),
		errorBox: dom.window.document.querySelector('[data-error]'),
		warning: dom.window.document.querySelector('[data-warning]'),
		processingOverlay: dom.window.document.querySelector('[data-processing-overlay]'),
		cleanup,
	};
}

async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		try {
			await assertion();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	await assertion();
}

function buildFetchMock(...responses: MockResponse[]) {
	return vi.fn(async () => {
		const nextResponse = responses.shift();
		if (!nextResponse) {
			throw new Error('No mocked response available.');
		}

		return new Response(JSON.stringify(nextResponse.body), {
			status: nextResponse.status,
			headers: { 'content-type': 'application/json' },
		});
	});
}

async function uploadFile(context: DomContext, file: File): Promise<void> {
	Object.defineProperty(context.input, 'files', {
		value: [file],
		configurable: true,
	});
	context.input.dispatchEvent(new Event('change', { bubbles: true }));
	await Promise.resolve();
}

function createPngFile(name: string): File {
	return new File([Buffer.from(PNG_BASE64, 'base64')], name, { type: 'image/png' });
}

function createJpegFile(name: string): File {
	return new File([Buffer.from(JPEG_BASE64, 'base64')], name, { type: 'image/jpeg' });
}

afterEach(async () => {
	vi.restoreAllMocks();
	globalThis.sessionStorage?.clear();
	await clearWorkspaceResult();
});

describe('Session Storage Deprecation > Storage migration', () => {
	test('el flujo de upload no escribe en sessionStorage', async () => {
		const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
		const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');

		const fetchMock = buildFetchMock({
			ok: true,
			status: 200,
			body: {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
				metadata: { colors_detected: 2, paths_generated: 4, duration_ms: 8 },
			},
		});
		const context = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			await uploadFile(context, createPngFile('no-session.png'));

			await waitFor(async () => {
				expect(await readWorkspaceResult()).not.toBeNull();
			});

			// sessionStorage MUST NOT be written to at any point during the upload flow.
			expect(setItemSpy).not.toHaveBeenCalled();
			// sessionStorage MUST NOT be read from at any point during the upload flow.
			expect(getItemSpy).not.toHaveBeenCalled();
		} finally {
			context.cleanup();
		}
	});

	test('el flujo de workspace no lee de sessionStorage', async () => {
		const fetchMock = buildFetchMock({
			ok: true,
			status: 200,
			body: {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
				metadata: { colors_detected: 3, paths_generated: 6, duration_ms: 15 },
			},
		});
		const uploadContext = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			await uploadFile(uploadContext, createPngFile('ws-no-session.png'));

			await waitFor(async () => {
				expect(await readWorkspaceResult()).not.toBeNull();
			});
		} finally {
			uploadContext.cleanup();
		}

		const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');

		const workspaceContext = setupDom(createWorkspaceMarkup(), vi.fn() as unknown as typeof fetch);

		try {
			initVectorizerApp();

			await waitFor(() => {
				const ready = workspaceContext.document.querySelector<HTMLElement>('[data-workspace-ready]');
				expect(ready?.hidden).toBe(false);
			});

			// Workspace rendering MUST NOT read from sessionStorage at any point.
			expect(getItemSpy).not.toHaveBeenCalled();
		} finally {
			workspaceContext.cleanup();
		}
	});
});

describe('vectorizer app UI behavior', () => {
	test('el CTA principal abre el selector de archivo', async () => {
		const fetchMock = vi.fn();
		const context = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			const inputClickSpy = vi.spyOn(context.input, 'click').mockImplementation(() => undefined);

			context.uploadTrigger?.dispatchEvent(new context.window.MouseEvent('click', { bubbles: true }));

			expect(inputClickSpy).toHaveBeenCalledTimes(1);
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			context.cleanup();
		}
	});

	test('mantiene warning visible y guarda el resultado para el workspace', async () => {
		const fetchMock = buildFetchMock({
			ok: true,
			status: 200,
			body: {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#111111" d="M0 0H10V10H0Z"/></svg>',
				metadata: { colors_detected: 3, paths_generated: 1, duration_ms: 12 },
			},
		});
		const context = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			expect(context.warning?.textContent).toContain('Optimized for logos & icons');

			const navigationListener = vi.fn();
			const svgDownloadListener = vi.fn();
			context.window.addEventListener('vectorizer:navigate', navigationListener);
			context.window.addEventListener('vectorizer:svg-download', svgDownloadListener);

			await uploadFile(context, createJpegFile('photo.jpg'));
			expect(context.processingOverlay?.hidden).toBe(false);

			// In JSDOM (no real IndexedDB), the fallback path fires an SVG download.
			// In a real browser with IndexedDB, it would redirect to /workspace instead.
			await waitFor(() => {
				const isWorkspaceRedirect = context.status?.textContent?.includes('Redirecting to workspace');
				const isFallbackDownload = context.status?.textContent?.includes('Downloading SVG directly');
				expect(isWorkspaceRedirect || isFallbackDownload).toBe(true);
			});
			expect(context.processingOverlay?.hidden).toBe(true);

			// At least one success path must have been taken.
			const navigated = navigationListener.mock.calls.length > 0;
			const downloaded = svgDownloadListener.mock.calls.length > 0;
			expect(navigated || downloaded).toBe(true);

			// If IndexedDB succeeded, result must be stored; if memory fallback, result is also stored.
			const stored = await readWorkspaceResult();
			expect(stored).not.toBeNull();
			expect(stored?.filename).toBe('photo.jpg');
		} finally {
			context.cleanup();
		}
	});

	test('mapea un 400 del backend como error claro y no persiste workspace', async () => {
		const fetchMock = buildFetchMock({
			ok: false,
			status: 400,
			body: { detail: 'The uploaded file is not a decodable image.' },
		});
		const context = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			await uploadFile(context, createPngFile('broken.png'));

		await waitFor(() => {
				expect(context.errorBox?.textContent).toContain('The uploaded file is not a decodable image.');
			});

			expect(context.status?.textContent).toContain('Vectorization failed.');
			expect(await readWorkspaceResult()).toBeNull();
		} finally {
			context.cleanup();
		}
	});

	test('mapea un 500 del backend y limpia cualquier preview residual previa', async () => {
		const fetchMock = buildFetchMock({
			ok: false,
			status: 500,
			body: { detail: 'Internal Server Error' },
		});
		const context = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			await saveWorkspaceResult({
				filename: 'stale.png',
				originalFile: createPngFile('stale.png'),
				svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
				metadata: { colors_detected: 1, paths_generated: 1, duration_ms: 9 },
				storedAt: new Date().toISOString(),
			});

			await uploadFile(context, createPngFile('server-error.png'));

			await waitFor(() => {
				expect(context.errorBox?.textContent).toContain(
					'Vectorization could not be completed. Please try again in a few seconds.',
				);
			});

			expect(context.status?.textContent).toContain('Vectorization failed.');
			expect(await readWorkspaceResult()).toBeNull();

			const workspaceContext = setupDom(createWorkspaceMarkup(), vi.fn() as unknown as typeof fetch);

			try {
				initVectorizerApp();

				await waitFor(() => {
					const ready = workspaceContext.document.querySelector<HTMLElement>('[data-workspace-ready]');
					const empty = workspaceContext.document.querySelector<HTMLElement>('[data-workspace-empty]');

					expect(ready?.hidden).toBe(true);
					expect(empty?.hidden).toBe(false);
				});
				expect(workspaceContext.document.body.textContent).toContain('RETURN TO PORTAL');
			} finally {
				workspaceContext.cleanup();
			}
		} finally {
			context.cleanup();
		}
	});

	test('workspace muestra original, svg, metadata y descarga desde la sesión', async () => {
		const uploadFetchMock = buildFetchMock({
			ok: true,
			status: 200,
			body: {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#0000FF" d="M1 1H9V9H1Z"/></svg>',
				metadata: { colors_detected: 2, paths_generated: 2, duration_ms: 11 },
			},
		});
		const uploadContext = setupDom(createUploadMarkup(), uploadFetchMock as unknown as typeof fetch);

		try {
			await uploadFile(uploadContext, createPngFile('second.png'));
			await waitFor(async () => {
				expect(await readWorkspaceResult()).not.toBeNull();
			});

			const workspaceContext = setupDom(createWorkspaceMarkup(), vi.fn() as unknown as typeof fetch);

			try {
				initVectorizerApp();

				await waitFor(() => {
					const ready = workspaceContext.document.querySelector<HTMLElement>('[data-workspace-ready]');
					const empty = workspaceContext.document.querySelector<HTMLElement>('[data-workspace-empty]');
					const originalImage = workspaceContext.document.querySelector<HTMLImageElement>('[data-original-image]');
					const svgContainer = workspaceContext.document.querySelector<HTMLElement>('[data-svg-container]');
					const downloadLink = workspaceContext.document.querySelector<HTMLAnchorElement>('[data-download-link]');
					const colors = workspaceContext.document.querySelector<HTMLElement>('[data-metadata-colors]');
					const paths = workspaceContext.document.querySelector<HTMLElement>('[data-metadata-paths]');
					const bezier = workspaceContext.document.querySelector<HTMLElement>('[data-metadata-bezier]');
					const duration = workspaceContext.document.querySelector<HTMLElement>('[data-metadata-duration]');

					expect(ready?.hidden).toBe(false);
					expect(empty?.hidden).toBe(true);
					expect(originalImage?.getAttribute('src')).toContain('blob:');
					expect(svgContainer?.innerHTML).toContain('#0000FF');
					expect(downloadLink?.getAttribute('download')).toBe('second.svg');
					expect(downloadLink?.getAttribute('aria-disabled')).toBe('false');
					expect(colors?.textContent).toBe('2');
					expect(paths?.textContent).toBe('2');
					expect(bezier?.textContent).toBe('8');
					expect(duration?.textContent).toBe('11 ms');
				});
			} finally {
				workspaceContext.cleanup();
			}
		} finally {
			uploadContext.cleanup();
		}
	});

	test('workspace vacío muestra retorno al portal cuando no hay sesión', async () => {
		const context = setupDom(createWorkspaceMarkup(), vi.fn() as unknown as typeof fetch);

		try {
			await waitFor(() => {
				const ready = context.document.querySelector<HTMLElement>('[data-workspace-ready]');
				const empty = context.document.querySelector<HTMLElement>('[data-workspace-empty]');

				expect(ready?.hidden).toBe(true);
				expect(empty?.hidden).toBe(false);
			});
			expect(context.document.body.textContent).toContain('RETURN TO PORTAL');
		} finally {
			context.cleanup();
		}
	});

	test('cuando IndexedDB falla, permanece en "/" y dispara descarga automática del SVG', async () => {
		// Simulate IndexedDB unavailable so saveWorkspaceResult returns { persisted: 'memory' }.
		Object.defineProperty(globalThis, 'indexedDB', {
			value: undefined,
			configurable: true,
			writable: true,
		});

		const fetchMock = buildFetchMock({
			ok: true,
			status: 200,
			body: {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#FF0000"/></svg>',
				metadata: { colors_detected: 1, paths_generated: 2, duration_ms: 7 },
			},
		});
		const context = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			const navigationListener = vi.fn();
			const svgDownloadListener = vi.fn();
			context.window.addEventListener('vectorizer:navigate', navigationListener);
			context.window.addEventListener('vectorizer:svg-download', svgDownloadListener);

			await uploadFile(context, createPngFile('fallback-download.png'));

			await waitFor(() => {
				expect(context.status?.textContent).toContain('Downloading SVG directly');
			});

			// MUST NOT navigate to /workspace.
			expect(navigationListener).not.toHaveBeenCalled();

			// MUST dispatch the svg-download event so the browser triggers the download.
			expect(svgDownloadListener).toHaveBeenCalledTimes(1);

			// URL must remain at "/", not at "/workspace".
			expect(context.window.location.pathname).toBe('/');
		} finally {
			context.cleanup();
		}
	});

	test('drag & drop procesa el archivo soltado y dispara vectorización', async () => {
		const fetchMock = buildFetchMock({
			ok: true,
			status: 200,
			body: {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#00FF00"/></svg>',
				metadata: { colors_detected: 1, paths_generated: 3, duration_ms: 9 },
			},
		});
		const context = setupDom(createUploadMarkup(), fetchMock as unknown as typeof fetch);

		try {
			const dropzone = context.document.querySelector<HTMLElement>('[data-dropzone]');
			expect(dropzone).not.toBeNull();

			const file = createPngFile('drag-drop.png');

			// Simulate dragover — JSDOM does not implement DragEvent, use plain Event
			const dragoverEvent = new context.window.Event('dragover', { bubbles: true, cancelable: true });
			Object.defineProperty(dragoverEvent, 'preventDefault', { value: () => undefined });
			dropzone!.dispatchEvent(dragoverEvent);
			expect(dropzone!.dataset.dragging).toBe('true');

			// Simulate drop with a dataTransfer stub
			const dropEvent = new context.window.Event('drop', { bubbles: true, cancelable: true });
			Object.defineProperty(dropEvent, 'preventDefault', { value: () => undefined });
			Object.defineProperty(dropEvent, 'dataTransfer', {
				value: { files: [file] },
				configurable: true,
			});
			dropzone!.dispatchEvent(dropEvent);

			// dragging flag must clear immediately
			expect(dropzone!.dataset.dragging).toBe('false');

			// fetch must be called — the file was handed off to handleFile → vectorizeFile
			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});

			// Result must be stored in workspace storage
			await waitFor(async () => {
				expect(await readWorkspaceResult()).not.toBeNull();
			});

			const stored = await readWorkspaceResult();
			expect(stored?.filename).toBe('drag-drop.png');
		} finally {
			context.cleanup();
		}
	});

	test('drag & drop ignora el evento si ya hay una vectorización en curso', async () => {
		// First upload occupies state = 'uploading'
		let resolveFirst!: (v: Response) => void;
		const blockedFetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFirst = resolve;
				}),
		);

		const context = setupDom(createUploadMarkup(), blockedFetch as unknown as typeof fetch);

		try {
			// Start an upload that won't resolve yet
			await uploadFile(context, createPngFile('in-flight.png'));

			// Now simulate a drop while uploading
			const dropzone = context.document.querySelector<HTMLElement>('[data-dropzone]');
			const dropEvent = new context.window.Event('drop', { bubbles: true, cancelable: true });
			Object.defineProperty(dropEvent, 'preventDefault', { value: () => undefined });
			Object.defineProperty(dropEvent, 'dataTransfer', {
				value: { files: [createPngFile('dropped-while-busy.png')] },
				configurable: true,
			});
			dropzone!.dispatchEvent(dropEvent);

			// fetch must still have been called only once (the original upload)
			expect(blockedFetch).toHaveBeenCalledTimes(1);

			// Unblock the first fetch so cleanup works
			resolveFirst(
				new Response(
					JSON.stringify({
						svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect/></svg>',
						metadata: { colors_detected: 1, paths_generated: 1, duration_ms: 5 },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
			);
		} finally {
			context.cleanup();
		}
	});
});
