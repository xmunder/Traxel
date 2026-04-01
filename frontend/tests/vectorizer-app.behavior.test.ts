import { Buffer } from 'node:buffer';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { initVectorizerApp } from '../src/lib/vectorizer-app';

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
	status: HTMLElement;
	errorBox: HTMLElement;
	previewSection: HTMLElement;
	originalImage: HTMLImageElement;
	svgContainer: HTMLElement;
	downloadLink: HTMLAnchorElement;
	warning: HTMLElement;
	cleanup: () => void;
};

function createMarkup(): string {
	return `
		<main data-vectorizer-app data-endpoint="http://vectorizer.test/vectorize" data-state="idle">
			<section>
				<label data-dropzone aria-busy="false">
					<input data-image-input type="file" />
				</label>
				<span data-selected-file>Ningún archivo seleccionado.</span>
				<p data-status>Esperando una imagen para vectorizar.</p>
				<p data-error hidden></p>
			</section>
			<aside data-warning>
				<strong>Importante:</strong> esta herramienta está optimizada para logos e íconos.
				En imágenes complejas o fotografías el resultado puede no quedar ideal, pero el flujo no se bloquea.
			</aside>
			<section data-preview-section hidden>
				<div data-preview-canvas></div>
				<div data-preview-canvas></div>
				<img data-original-image alt="Preview de la imagen original" />
				<div data-svg-container></div>
				<a data-download-link href="#" aria-disabled="true">Descargar SVG</a>
				<dd data-metadata-colors>—</dd>
				<dd data-metadata-paths>—</dd>
				<dd data-metadata-duration>—</dd>
				<span data-zoom-label>100%</span>
				<button type="button" data-zoom-in>+</button>
				<button type="button" data-zoom-out>-</button>
			</section>
		</main>
	`;
}

function setupDom(fetchMock: typeof fetch): DomContext {
	const dom = new JSDOM(createMarkup(), {
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
		FormData: globalThis.FormData,
		URL: globalThis.URL,
		fetch: globalThis.fetch,
	};
	const objectUrls: string[] = [];
	const createObjectURL = vi.fn(() => {
		const nextUrl = `blob:vectorizer-${objectUrls.length + 1}`;
		objectUrls.push(nextUrl);
		return nextUrl;
	});
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
		FormData,
		fetch: fetchMock,
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
		Object.assign(globalThis, native);
	};

	return {
		window: dom.window as unknown as Window & typeof globalThis,
		document: dom.window.document,
		input: dom.window.document.querySelector('[data-image-input]')!,
		status: dom.window.document.querySelector('[data-status]')!,
		errorBox: dom.window.document.querySelector('[data-error]')!,
		previewSection: dom.window.document.querySelector('[data-preview-section]')!,
		originalImage: dom.window.document.querySelector('[data-original-image]')!,
		svgContainer: dom.window.document.querySelector('[data-svg-container]')!,
		downloadLink: dom.window.document.querySelector('[data-download-link]')!,
		warning: dom.window.document.querySelector('[data-warning]')!,
		cleanup,
	};
}

async function waitFor(assertion: () => void, timeoutMs = 5_000): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		try {
			assertion();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	assertion();
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

afterEach(() => {
	vi.restoreAllMocks();
});

describe('vectorizer app UI behavior', () => {
	test('mantiene warning visible con fotografía válida y sin detección automática en UI', async () => {
		const fetchMock = buildFetchMock({
			ok: true,
			status: 200,
			body: {
				svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#111111" d="M0 0H10V10H0Z"/></svg>',
				metadata: { colors_detected: 3, paths_generated: 1, duration_ms: 12 },
			},
		});
		const context = setupDom(fetchMock as unknown as typeof fetch);

		try {
			expect(context.warning.textContent).toContain('esta herramienta está optimizada para logos e íconos');
			expect(context.document.body.textContent).not.toContain('detección automática');

			await uploadFile(context, createJpegFile('photo.jpg'));

			await waitFor(() => {
				expect(context.status.textContent).toContain('Vectorización lista.');
			});

			expect(context.warning.textContent).toContain('fotografías el resultado puede no quedar ideal');
			expect(context.document.body.textContent).not.toContain('foto detectada');
			expect(context.previewSection.hidden).toBe(false);
		} finally {
			context.cleanup();
		}
	});

	test('mapea un 400 del backend como error claro por archivo inválido y no muestra preview', async () => {
		const fetchMock = buildFetchMock({
			ok: false,
			status: 400,
			body: { detail: 'The uploaded file is not a decodable image.' },
		});
		const context = setupDom(fetchMock as unknown as typeof fetch);

		try {
			await uploadFile(context, createPngFile('broken.png'));

			await waitFor(() => {
				expect(context.errorBox.textContent).toContain('The uploaded file is not a decodable image.');
			});

			expect(context.status.textContent).toContain('La vectorización falló.');
			expect(context.previewSection.hidden).toBe(true);
			expect(context.svgContainer.innerHTML).toBe('');
			expect(context.originalImage.getAttribute('src')).toBeNull();
			expect(context.downloadLink.getAttribute('aria-disabled')).toBe('true');
		} finally {
			context.cleanup();
		}
	});

	test('mapea un 500 del backend sin dejar preview ni descarga residual', async () => {
		const fetchMock = buildFetchMock(
			{
				ok: true,
				status: 200,
				body: {
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#FF0000" d="M0 0H10V10H0Z"/></svg>',
					metadata: { colors_detected: 1, paths_generated: 1, duration_ms: 9 },
				},
			},
			{
				ok: false,
				status: 500,
				body: { detail: 'Vectorization failed unexpectedly.' },
			},
		);
		const context = setupDom(fetchMock as unknown as typeof fetch);

		try {
			await uploadFile(context, createPngFile('first.png'));
			await waitFor(() => {
				expect(context.previewSection.hidden).toBe(false);
			});

			await uploadFile(context, createPngFile('second.png'));
			await waitFor(() => {
				expect(context.errorBox.textContent).toContain('No se pudo completar la vectorización.');
			});

			expect(context.previewSection.hidden).toBe(true);
			expect(context.svgContainer.innerHTML).toBe('');
			expect(context.originalImage.getAttribute('src')).toBeNull();
			expect(context.downloadLink.getAttribute('aria-disabled')).toBe('true');
		} finally {
			context.cleanup();
		}
	});

	test('reemplaza la preview al subir una nueva imagen válida', async () => {
		const fetchMock = buildFetchMock(
			{
				ok: true,
				status: 200,
				body: {
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#FF0000" d="M0 0H10V10H0Z"/></svg>',
					metadata: { colors_detected: 1, paths_generated: 1, duration_ms: 8 },
				},
			},
			{
				ok: true,
				status: 200,
				body: {
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path fill="#0000FF" d="M1 1H9V9H1Z"/></svg>',
					metadata: { colors_detected: 2, paths_generated: 2, duration_ms: 11 },
				},
			},
		);
		const context = setupDom(fetchMock as unknown as typeof fetch);

		try {
			await uploadFile(context, createPngFile('first.png'));
			await waitFor(() => {
				expect(context.status.textContent).toContain('Vectorización lista.');
			});

			const firstOriginalUrl = context.originalImage.getAttribute('src');
			const firstDownloadUrl = context.downloadLink.getAttribute('href');
			expect(context.svgContainer.innerHTML).toContain('#FF0000');

			await uploadFile(context, createPngFile('second.png'));
			await waitFor(() => {
				expect(context.svgContainer.innerHTML).toContain('#0000FF');
			});

			expect(context.svgContainer.innerHTML).not.toContain('#FF0000');
			expect(context.originalImage.getAttribute('src')).not.toBe(firstOriginalUrl);
			expect(context.downloadLink.getAttribute('href')).not.toBe(firstDownloadUrl);
			expect(context.downloadLink.getAttribute('download')).toBe('second.svg');
		} finally {
			context.cleanup();
		}
	});
});
