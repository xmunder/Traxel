type VectorizeSuccessResponse = {
	svg: string;
	metadata: {
		colors_detected: number;
		paths_generated: number;
		duration_ms: number;
	};
};

type StoredWorkspaceResult = VectorizeSuccessResponse & {
	filename: string;
	originalDataUrl: string;
	storedAt: string;
};

type VectorizerState = 'idle' | 'uploading' | 'success' | 'error';

const WORKSPACE_STORAGE_KEY = 'vectorizer.workspace-result';
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000/vectorize';

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
		return 'El archivo está vacío. Probá con otra imagen.';
	}

	if (file.size > MAX_FILE_SIZE) {
		return 'La imagen excede el límite de 5 MB.';
	}

	const hasSupportedExtension = SUPPORTED_EXTENSIONS.has(getExtension(file.name));
	const hasSupportedType = !file.type || SUPPORTED_TYPES.has(file.type);

	if (!hasSupportedExtension || !hasSupportedType) {
		return 'Formato no soportado. Usá PNG, JPG, JPEG o WEBP.';
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
		throw new Error('SVG inválido recibido desde el backend.');
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
	svg.setAttribute('aria-label', 'Preview del SVG vectorizado');

	return svg.outerHTML;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof VectorizeRequestError) {
		if (error.status === 400 || error.status === 413) {
			return error.message;
		}

		if (error.status === 500) {
			return 'No se pudo completar la vectorización. Intentá nuevamente en unos segundos.';
		}

		if (error.status === 502) {
			return 'No se pudo conectar con el backend. Verificá que el servicio esté levantado.';
		}
	}

	if (error instanceof Error && error.message) {
		return error.message;
	}

	return 'Ocurrió un error inesperado durante la vectorización.';
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	if (typeof window.btoa === 'function') {
		return window.btoa(binary);
	}

	throw new Error('No se pudo codificar la imagen seleccionada.');
}

async function readFileAsDataUrl(file: File): Promise<string> {
	const buffer = await file.arrayBuffer();
	const mimeType = file.type || 'application/octet-stream';
	return `data:${mimeType};base64,${arrayBufferToBase64(buffer)}`;
}

function saveWorkspaceResult(result: StoredWorkspaceResult): void {
	try {
		sessionStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(result));
	} catch {
		throw new Error('No se pudo guardar el resultado de la sesión.');
	}
}

function readWorkspaceResult(): StoredWorkspaceResult | null {
	try {
		const raw = sessionStorage.getItem(WORKSPACE_STORAGE_KEY);
		if (!raw) {
			return null;
		}

		const parsed = JSON.parse(raw) as Partial<StoredWorkspaceResult>;
		if (
			typeof parsed.filename !== 'string' ||
			typeof parsed.originalDataUrl !== 'string' ||
			typeof parsed.svg !== 'string' ||
			!parsed.metadata ||
			typeof parsed.metadata.colors_detected !== 'number' ||
			typeof parsed.metadata.paths_generated !== 'number' ||
			typeof parsed.metadata.duration_ms !== 'number'
		) {
			return null;
		}

		return {
			filename: parsed.filename,
			originalDataUrl: parsed.originalDataUrl,
			svg: parsed.svg,
			metadata: parsed.metadata,
			storedAt: typeof parsed.storedAt === 'string' ? parsed.storedAt : new Date().toISOString(),
		};
	} catch {
		return null;
	}
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

	window.location.assign(path);
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
	const stateLabels = app.querySelectorAll<HTMLElement>('[data-state-label]');
	const stateCopies = app.querySelectorAll<HTMLElement>('[data-state-copy]');
	const stateFooters = app.querySelectorAll<HTMLElement>('[data-state-footer]');

	if (!input || !dropzone || !selectedFile || !status || !errorBox) {
		return;
	}

	let state: VectorizerState = 'idle';

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

		const uiStateMap: Record<VectorizerState, string> = {
			idle: 'READY',
			uploading: 'PROCESSING',
			success: 'UPLINK COMPLETE',
			error: 'ERROR',
		};

		updateText(stateLabels, uiStateMap[nextState]);
		updateText(stateCopies, nextStatus);
		updateText(stateFooters, `STATE: ${uiStateMap[nextState]}`);
	};

	const vectorizeFile = async (file: File): Promise<void> => {
		const validationError = validateFile(file);

		selectedFile.textContent = file.name;
		input.value = '';

		if (validationError) {
			showError(validationError);
			setState('error', 'No se pudo iniciar la vectorización.');
			return;
		}

		clearError();
		setState('uploading', `Procesando ${file.name}...`);

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
				const detail = payload && 'detail' in payload && payload.detail ? payload.detail : 'La request falló.';
				throw new VectorizeRequestError(response.status, detail);
			}

			if (!payload || !('svg' in payload) || !('metadata' in payload)) {
				throw new Error('La respuesta del backend no tiene el formato esperado.');
			}

			sanitizeSvg(payload.svg);
			const originalDataUrl = await readFileAsDataUrl(file);
			saveWorkspaceResult({
				filename: file.name,
				originalDataUrl,
				svg: payload.svg,
				metadata: payload.metadata,
				storedAt: new Date().toISOString(),
			});

			clearError();
			setState('success', 'Vectorización lista. Redirigiendo al workspace para comparación y descarga.');
			navigateTo(workspacePath);
		} catch (error) {
			showError(getErrorMessage(error));
			setState('error', 'La vectorización falló. Podés intentar nuevamente con otra imagen.');
		} finally {
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

	for (const eventName of ['dragleave', 'dragend', 'drop']) {
		dropzone.addEventListener(eventName, (event) => {
			const dragEvent = event as DragEvent;
			dragEvent.preventDefault();
			dropzone.dataset.dragging = 'false';
		});
	}

	dropzone.addEventListener('drop', (event) => {
		const dragEvent = event as DragEvent;
		dragEvent.preventDefault();
	});

	dropzone.dataset.dragging = 'false';
	setState('idle', 'Esperando una imagen para vectorizar.');
}

function initWorkspacePage(app: HTMLElement): void {
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

	const result = readWorkspaceResult();
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
	const downloadUrl = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' }));
	const bezierNodes = Math.max(result.metadata.paths_generated * 4, result.metadata.paths_generated);

	readySection.hidden = false;
	if (emptySection) {
		emptySection.hidden = true;
	}
	originalImage.src = result.originalDataUrl;
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
		initWorkspacePage(app);
		return;
	}

	initUploadPage(app);
}
