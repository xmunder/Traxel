import { Buffer } from 'node:buffer';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { initVectorizerApp } from '../src/lib/vectorizer-app';

const FRONTEND_URL = 'http://127.0.0.1:4321';
const BACKEND_URL = 'http://127.0.0.1:8000/vectorize';
const SMOKE_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAMElEQVR4nGP8//8/AymAhYGBgYGREVOCkQGLQf//MzCRZDwDw6iGUQ1U08BIavIGAA1ICRvdFHblAAAAAElFTkSuQmCC';

let backendServer: ChildProcessWithoutNullStreams | null = null;
let frontendServer: ChildProcessWithoutNullStreams | null = null;

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

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (condition()) {
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	throw new Error('Timed out waiting for DOM update.');
}

function stopServer(server: ChildProcessWithoutNullStreams | null): void {
	if (!server || server.killed) {
		return;
	}

	server.kill('SIGTERM');
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

describe('frontend runtime smoke', () => {
	test(
		'carga imagen, mantiene warning, llega a success, muestra preview y habilita descarga',
		async () => {
		const html = await fetch(FRONTEND_URL).then(async (response) => response.text());
		const dom = new JSDOM(html, {
			url: FRONTEND_URL,
			pretendToBeVisual: true,
		});

		const { window } = dom;
		const NativeBlob = globalThis.Blob;
		const NativeFile = globalThis.File;
		const NativeFormData = globalThis.FormData;
		const nativeFetch = globalThis.fetch;
		const createObjectURL = (() => {
			let sequence = 0;
			return () => `blob:vectorizer-${++sequence}`;
		})();

		Object.assign(globalThis, {
			window,
			document: window.document,
			DOMParser: window.DOMParser,
			HTMLElement: window.HTMLElement,
			HTMLInputElement: window.HTMLInputElement,
			HTMLImageElement: window.HTMLImageElement,
			SVGElement: window.SVGElement,
			Event: window.Event,
			Blob: NativeBlob,
			File: NativeFile,
			FormData: NativeFormData,
			fetch: nativeFetch,
		});

		Object.defineProperty(window.URL, 'createObjectURL', {
			value: createObjectURL,
			configurable: true,
		});
		Object.defineProperty(window.URL, 'revokeObjectURL', {
			value: () => undefined,
			configurable: true,
		});
		Object.defineProperty(globalThis, 'URL', {
			value: window.URL,
			configurable: true,
		});

		initVectorizerApp();

		expect(window.document.body.textContent).toContain('esta herramienta está optimizada para logos e íconos');

		const input = window.document.querySelector<HTMLInputElement>('[data-image-input]');
		const status = window.document.querySelector<HTMLElement>('[data-status]');
		const previewSection = window.document.querySelector<HTMLElement>('[data-preview-section]');
		const originalImage = window.document.querySelector<HTMLImageElement>('[data-original-image]');
		const svgContainer = window.document.querySelector<HTMLElement>('[data-svg-container]');
		const downloadLink = window.document.querySelector<HTMLAnchorElement>('[data-download-link]');

		expect(input).not.toBeNull();
		expect(status).not.toBeNull();
		expect(previewSection).not.toBeNull();
		expect(originalImage).not.toBeNull();
		expect(svgContainer).not.toBeNull();
		expect(downloadLink).not.toBeNull();

		const file = new NativeFile([Buffer.from(SMOKE_PNG_BASE64, 'base64')], 'smoke-logo.png', {
			type: 'image/png',
		});

		Object.defineProperty(input!, 'files', {
			value: [file],
			configurable: true,
		});
		input!.dispatchEvent(new window.Event('change', { bubbles: true }));

		await waitFor(() => status!.textContent?.includes('Vectorización lista.') ?? false);

		expect(status!.textContent).toContain('Vectorización lista.');
		expect(previewSection!.hidden).toBe(false);
		expect(originalImage!.getAttribute('src')).toContain('blob:vectorizer-');
		expect(svgContainer!.innerHTML).toContain('<svg');
		expect(downloadLink!.getAttribute('aria-disabled')).toBe('false');
		expect(downloadLink!.getAttribute('download')).toBe('smoke-logo.svg');
		expect(downloadLink!.getAttribute('href')).toContain('blob:vectorizer-');

			window.close();
		},
		30_000,
	);
});
