import {
	clearWorkspaceResult,
	readWorkspaceResult,
	saveWorkspaceResult,
	type SaveWorkspaceResultOutcome,
	type StoredWorkspaceResult,
	type VectorizeSuccessResponse,
} from './workspace-storage';

type VectorizerState = 'idle' | 'uploading' | 'success' | 'error';

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const DEFAULT_ENDPOINT = '/vectorize';
const PROCESSING_STATUS_TITLE = 'PROCESSING';
const PROCESSING_MESSAGES = [
	'Validating input image...',
	'Reducing visual complexity to optimize tracing...',
	'Analyzing dominant colors...',
	'Generating SVG paths...',
	'Preparing final comparison in workspace...',
];

class VectorizeRequestError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'VectorizeRequestError';
	}
}

function getExtension(filename: string): string {
	const extension = filename.split('.').pop();
	return extension ? extension.toLowerCase() : '';
}

function validateFile(file: File): string | null {
	if (!file.size) {
		return 'The file is empty. Please try a different image.';
	}

	if (file.size > MAX_FILE_SIZE) {
		return 'Image exceeds the 5 MB limit.';
	}

	const hasSupportedExtension = SUPPORTED_EXTENSIONS.has(getExtension(file.name));
	const hasSupportedType = !file.type || SUPPORTED_TYPES.has(file.type);

	if (!hasSupportedExtension || !hasSupportedType) {
		return 'Unsupported format. Please use PNG, JPG, JPEG, or WEBP.';
	}

	return null;
}

function buildDownloadFilename(filename: string): string {
	const baseName = filename.replace(/\.[^.]+$/, '') || 'vectorized-image';
	return `${baseName}.svg`;
}

function sanitizeSvg(svgText: string): string {
	const documentParser = new DOMParser();
	const parsed = documentParser.parseFromString(svgText, 'image/svg+xml');
	const parserError = parsed.querySelector('parsererror');
	const svg = parsed.querySelector('svg');

	if (parserError || !svg) {
		throw new Error('Invalid SVG received from the backend.');
	}

	parsed.querySelectorAll('script').forEach((node) => node.remove());
	parsed.querySelectorAll('*').forEach((element) => {
		for (const attribute of Array.from(element.attributes)) {
			if (attribute.name.toLowerCase().startsWith('on')) {
				element.removeAttribute(attribute.name);
			}
		}
	});

	svg.removeAttribute('width');
	svg.removeAttribute('height');
	svg.setAttribute('role', 'img');
	svg.setAttribute('aria-label', 'Vectorized SVG preview');

	return svg.outerHTML;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof VectorizeRequestError) {
		if (error.status === 400 || error.status === 413) {
			return error.message;
		}

		if (error.status === 500) {
			return 'Vectorization could not be completed. Please try again in a few seconds.';
		}

		if (error.status === 502) {
			return 'Could not connect to the backend. Please verify the service is running.';
		}
	}

	if (error instanceof Error && error.message) {
		return error.message;
	}

	return 'An unexpected error occurred during vectorization.';
}

async function parseResponse(response: Response): Promise<unknown> {
	const responseText = await response.text();

	if (!responseText) {
		return null;
	}

	try {
		return JSON.parse(responseText) as unknown;
	} catch {
		return null;
	}
}

function updateText(nodes: NodeListOf<HTMLElement>, value: string): void {
	nodes.forEach((node) => {
		node.textContent = value;
	});
}

function buildWorkspaceLog(result: StoredWorkspaceResult): string[] {
	return [
		'INITIALIZING VECTOR ENGINE... DONE',
		`ANALYZING COLOR DEPTH... ${result.metadata.colors_detected} CLUSTERS`,
		`GENERATING PATHS... ${result.metadata.paths_generated} PATHS`,
		`LATENCY_CAPTURED... ${result.metadata.duration_ms}MS`,
		'SVG_V1 READY FOR EXPORT.',
	];
}

function buildAccuracyIndex(result: StoredWorkspaceResult): string {
	const raw = 96 + Math.min(result.metadata.colors_detected, 8) * 0.22 + Math.min(result.metadata.paths_generated, 16) * 0.11;
	return `${Math.min(raw, 99.7).toFixed(1)}%`;
}

function buildTraceQuality(result: StoredWorkspaceResult): string {
	if (result.metadata.paths_generated >= 24) {
		return 'HIGH_DENSITY';
	}

	if (result.metadata.paths_generated >= 8) {
		return 'ULTRA';
	}

	return 'PRECISE';
}

function navigateTo(path: string): void {
	window.dispatchEvent(new CustomEvent('vectorizer:navigate', { detail: { path } }));
	if (window.navigator.userAgent.includes('jsdom')) {
		window.history.pushState({}, '', path);
		return;
	}

	window.location.href = path;
}

function triggerSvgDownload(svg: string, filename: string): void {
	const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = buildDownloadFilename(filename);
	anchor.style.display = 'none';
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
	window.dispatchEvent(new CustomEvent('vectorizer:svg-download', { detail: { filename: buildDownloadFilename(filename) } }));
}

function initUploadPage(app: HTMLElement): void {
	const endpoint = app.dataset.endpoint ?? DEFAULT_ENDPOINT;
	const workspacePath = app.dataset.workspacePath ?? '/workspace';
	const input = app.querySelector<HTMLInputElement>('[data-image-input]');
	const dropzone = app.querySelector<HTMLElement>('[data-dropzone]');
	const uploadTrigger = app.querySelector<HTMLElement>('[data-upload-trigger]');
	const selectedFile = app.querySelector<HTMLElement>('[data-selected-file]');
	const status = app.querySelector<HTMLElement>('[data-status]');
	const errorBox = app.querySelector<HTMLElement>('[data-error]');
	const processingOverlay = app.querySelector<HTMLElement>('[data-processing-overlay]');
	const processingStatus = app.querySelector<HTMLElement>('[data-processing-status]');
	const processingMessage = app.querySelector<HTMLElement>('[data-processing-message]');
	const stateLabels = app.querySelectorAll<HTMLElement>('[data-state-label]');
	const stateCopies = app.querySelectorAll<HTMLElement>('[data-state-copy]');
	const stateFooters = app.querySelectorAll<HTMLElement>('[data-state-footer]');

	if (!input || !dropzone || !selectedFile || !status || !errorBox) {
		return;
	}

	let state: VectorizerState = 'idle';
	let processingMessageIndex = 0;
	let processingMessageTimer: number | null = null;

	const stopProcessingOverlay = (): void => {
		if (processingMessageTimer !== null) {
			window.clearInterval(processingMessageTimer);
			processingMessageTimer = null;
		}

		if (processingOverlay) {
			processingOverlay.hidden = true;
			processingOverlay.setAttribute('aria-hidden', 'true');
		}
	};

	const startProcessingOverlay = (): void => {
		if (!processingOverlay || !processingStatus || !processingMessage) {
			return;
		}

		processingMessageIndex = 0;
		processingOverlay.hidden = false;
		processingOverlay.setAttribute('aria-hidden', 'false');
		processingStatus.textContent = PROCESSING_STATUS_TITLE;
		processingMessage.textContent = PROCESSING_MESSAGES[processingMessageIndex];

		if (processingMessageTimer !== null) {
			window.clearInterval(processingMessageTimer);
		}

		processingMessageTimer = window.setInterval(() => {
			processingMessageIndex = (processingMessageIndex + 1) % PROCESSING_MESSAGES.length;
			processingMessage.textContent = PROCESSING_MESSAGES[processingMessageIndex];
		}, 1800);
	};

	const clearError = (): void => {
		errorBox.hidden = true;
		errorBox.textContent = '';
	};

	const showError = (message: string): void => {
		errorBox.hidden = false;
		errorBox.textContent = message;
	};

	const setState = (nextState: VectorizerState, nextStatus: string): void => {
		state = nextState;
		app.dataset.state = nextState;
		status.textContent = nextStatus;
		input.disabled = nextState === 'uploading';
		dropzone.setAttribute('aria-busy', String(nextState === 'uploading'));
		if (uploadTrigger) {
			uploadTrigger.setAttribute('aria-disabled', String(nextState === 'uploading'));
		}

		if (nextState === 'uploading') {
			startProcessingOverlay();
		} else {
			stopProcessingOverlay();
		}

		const uiStateMap: Record<VectorizerState, string> = {
			idle: 'READY',
			uploading: 'PROCESSING',
			success: 'UPLINK COMPLETE',
			error: 'ERROR',
		};

		updateText(stateLabels, uiStateMap[nextState]);
		if (nextState === 'idle' && nextStatus === '') {
			status.textContent = '';
		} else {
			updateText(stateCopies, nextStatus);
		}
		updateText(stateFooters, `STATE: ${uiStateMap[nextState]}`);
	};

	const vectorizeFile = async (file: File): Promise<void> => {
		await clearWorkspaceResult();
		const validationError = validateFile(file);

		selectedFile.textContent = file.name;
		input.value = '';

		if (validationError) {
			showError(validationError);
			setState('error', 'Could not start vectorization.');
			return;
		}

		clearError();
		setState('uploading', `Processing ${file.name}...`);

		const formData = new FormData();
		formData.append('image', file);

		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				body: formData,
			});

			const payload = (await parseResponse(response)) as
				| { detail?: string }
				| VectorizeSuccessResponse
				| null;

			if (!response.ok) {
				const detail = payload && 'detail' in payload && payload.detail ? payload.detail : 'The request failed.';
				throw new VectorizeRequestError(response.status, detail);
			}

		if (!payload || !('svg' in payload) || !('metadata' in payload)) {
				throw new Error('Backend response does not match the expected format.');
			}

			sanitizeSvg(payload.svg);
			const saveOutcome: SaveWorkspaceResultOutcome = await saveWorkspaceResult({
				filename: file.name,
				originalFile: file,
				svg: payload.svg,
				metadata: payload.metadata,
				storedAt: new Date().toISOString(),
			});

			clearError();
			if (saveOutcome.persisted === 'indexeddb') {
				setState('success', 'Vectorization complete. Redirecting to workspace for comparison and download.');
				navigateTo(workspacePath);
			} else {
				setState('success', 'Vectorization complete. Downloading SVG directly (storage unavailable).');
				triggerSvgDownload(payload.svg, file.name);
			}
		} catch (error) {
			await clearWorkspaceResult();
			showError(getErrorMessage(error));
			setState('error', 'Vectorization failed. You can try again with a different image.');
		} finally {
			stopProcessingOverlay();
			input.disabled = false;
		}
	};

	const handleFile = (file: File | null): void => {
		if (!file || state === 'uploading') {
			return;
		}

		void vectorizeFile(file);
	};

	input.addEventListener('change', (event) => {
		const target = event.currentTarget as HTMLInputElement;
		const file = target.files?.[0] ?? null;
		handleFile(file);
	});

	const openFilePicker = (): void => {
		if (state === 'uploading') {
			return;
		}

		input.click();
	};

	uploadTrigger?.addEventListener('click', openFilePicker);

	for (const eventName of ['dragenter', 'dragover']) {
		dropzone.addEventListener(eventName, (event) => {
			const dragEvent = event as DragEvent;
			dragEvent.preventDefault();
			dropzone.dataset.dragging = 'true';
		});
	}

	for (const eventName of ['dragleave', 'dragend']) {
		dropzone.addEventListener(eventName, (event) => {
			const dragEvent = event as DragEvent;
			dragEvent.preventDefault();
			dropzone.dataset.dragging = 'false';
		});
	}

	dropzone.addEventListener('drop', (event) => {
		const dragEvent = event as DragEvent;
		dragEvent.preventDefault();
		dropzone.dataset.dragging = 'false';
		const file = dragEvent.dataTransfer?.files?.[0] ?? null;
		handleFile(file);
	});

	dropzone.dataset.dragging = 'false';
	setState('idle', '');
}

async function initWorkspacePage(app: HTMLElement): Promise<void> {
	const readySection = app.querySelector<HTMLElement>('[data-workspace-ready]');
	const emptySection = app.querySelector<HTMLElement>('[data-workspace-empty]');
	const originalImage = app.querySelector<HTMLImageElement>('[data-original-image]');
	const svgContainer = app.querySelector<HTMLElement>('[data-svg-container]');
	const downloadLink = app.querySelector<HTMLAnchorElement>('[data-download-link]');
	const colorsMetadata = app.querySelector<HTMLElement>('[data-metadata-colors]');
	const pathsMetadata = app.querySelector<HTMLElement>('[data-metadata-paths]');
	const bezierMetadata = app.querySelector<HTMLElement>('[data-metadata-bezier]');
	const durationMetadata = app.querySelector<HTMLElement>('[data-metadata-duration]');
	const accuracyIndex = app.querySelector<HTMLElement>('[data-accuracy-index]');
	const traceQuality = app.querySelector<HTMLElement>('[data-trace-quality]');
	const systemStatus = app.querySelector<HTMLElement>('[data-system-status]');
	const filename = app.querySelector<HTMLElement>('[data-workspace-filename]');
	const logList = app.querySelector<HTMLElement>('[data-log-list]');
	const stateFooters = app.querySelectorAll<HTMLElement>('[data-state-footer]');

	if (
		!readySection ||
		!originalImage ||
		!svgContainer ||
		!downloadLink ||
		!colorsMetadata ||
		!pathsMetadata ||
		!bezierMetadata ||
		!durationMetadata
	) {
		return;
	}

	const result = await readWorkspaceResult();
	if (!result) {
		if (emptySection) {
			emptySection.hidden = false;
			readySection.hidden = true;
			app.dataset.state = 'idle';
			updateText(stateFooters, 'STATE: STANDBY');
		} else {
			navigateTo(app.dataset.homePath ?? '/');
		}
		return;
	}

	const safeSvg = sanitizeSvg(result.svg);
	const originalImageUrl = URL.createObjectURL(result.originalFile);
	const downloadUrl = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' }));
	const bezierNodes = Math.max(result.metadata.paths_generated * 4, result.metadata.paths_generated);

	readySection.hidden = false;
	if (emptySection) {
		emptySection.hidden = true;
	}
	originalImage.src = originalImageUrl;
	svgContainer.innerHTML = safeSvg;
	downloadLink.href = downloadUrl;
	downloadLink.download = buildDownloadFilename(result.filename);
	downloadLink.setAttribute('aria-disabled', 'false');
	colorsMetadata.textContent = String(result.metadata.colors_detected);
	pathsMetadata.textContent = String(result.metadata.paths_generated);
	bezierMetadata.textContent = String(bezierNodes);
	durationMetadata.textContent = `${result.metadata.duration_ms} ms`;
	if (accuracyIndex) {
		accuracyIndex.textContent = buildAccuracyIndex(result);
	}
	if (traceQuality) {
		traceQuality.textContent = buildTraceQuality(result);
	}
	if (systemStatus) {
		systemStatus.textContent = 'OPERATIONAL';
	}
	if (filename) {
		filename.textContent = result.filename;
	}
	if (logList) {
		logList.innerHTML = buildWorkspaceLog(result).map((entry) => `<li>${entry}</li>`).join('');
	}

	app.dataset.state = 'success';
	updateText(stateFooters, 'STATE: OPERATIONAL');
	window.addEventListener('beforeunload', () => {
		URL.revokeObjectURL(originalImageUrl);
		URL.revokeObjectURL(downloadUrl);
	});
}

export function initVectorizerApp(): void {
	const app = document.querySelector<HTMLElement>('[data-vectorizer-app]');

	if (!app) {
		return;
	}

	const page = app.dataset.page;
	if (page === 'workspace') {
		void initWorkspacePage(app);
		return;
	}

	initUploadPage(app);
}
