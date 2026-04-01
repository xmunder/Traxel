type VectorizeSuccessResponse = {
	svg: string;
	metadata: {
		colors_detected: number;
		paths_generated: number;
		duration_ms: number;
	};
};

type VectorizerState = 'idle' | 'uploading' | 'success' | 'error';

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8000/vectorize';
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

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

export function initVectorizerApp(): void {
	const app = document.querySelector<HTMLElement>('[data-vectorizer-app]');

	if (!app) {
		return;
	}

	const endpoint = app.dataset.endpoint ?? DEFAULT_ENDPOINT;
	const input = app.querySelector<HTMLInputElement>('[data-image-input]');
	const dropzone = app.querySelector<HTMLElement>('[data-dropzone]');
	const selectedFile = app.querySelector<HTMLElement>('[data-selected-file]');
	const status = app.querySelector<HTMLElement>('[data-status]');
	const errorBox = app.querySelector<HTMLElement>('[data-error]');
	const previewSection = app.querySelector<HTMLElement>('[data-preview-section]');
	const originalImage = app.querySelector<HTMLImageElement>('[data-original-image]');
	const svgContainer = app.querySelector<HTMLElement>('[data-svg-container]');
	const downloadLink = app.querySelector<HTMLAnchorElement>('[data-download-link]');
	const colorsMetadata = app.querySelector<HTMLElement>('[data-metadata-colors]');
	const pathsMetadata = app.querySelector<HTMLElement>('[data-metadata-paths]');
	const durationMetadata = app.querySelector<HTMLElement>('[data-metadata-duration]');
	const zoomLabel = app.querySelector<HTMLElement>('[data-zoom-label]');
	const zoomInButton = app.querySelector<HTMLButtonElement>('[data-zoom-in]');
	const zoomOutButton = app.querySelector<HTMLButtonElement>('[data-zoom-out]');
	const previewCanvases = Array.from(app.querySelectorAll<HTMLElement>('[data-preview-canvas]'));

	if (
		!input ||
		!dropzone ||
		!selectedFile ||
		!status ||
		!errorBox ||
		!previewSection ||
		!originalImage ||
		!svgContainer ||
		!downloadLink ||
		!colorsMetadata ||
		!pathsMetadata ||
		!durationMetadata ||
		!zoomLabel ||
		!zoomInButton ||
		!zoomOutButton
	) {
		return;
	}

	let state: VectorizerState = 'idle';
	let currentOriginalUrl: string | null = null;
	let currentDownloadUrl: string | null = null;
	let zoom = 1;

	const cleanupUrls = (): void => {
		if (currentOriginalUrl) {
			URL.revokeObjectURL(currentOriginalUrl);
			currentOriginalUrl = null;
		}

		if (currentDownloadUrl) {
			URL.revokeObjectURL(currentDownloadUrl);
			currentDownloadUrl = null;
		}
	};

	const updateZoom = (): void => {
		zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
		previewCanvases.forEach((canvas) => {
			canvas.style.setProperty('--preview-scale', zoom.toString());
		});
		zoomInButton.disabled = zoom >= MAX_ZOOM;
		zoomOutButton.disabled = zoom <= MIN_ZOOM;
	};

	const setState = (nextState: VectorizerState, nextStatus: string): void => {
		state = nextState;
		app.dataset.state = nextState;
		status.textContent = nextStatus;
		input.disabled = nextState === 'uploading';
		dropzone.setAttribute('aria-busy', String(nextState === 'uploading'));
	};

	const resetResult = (): void => {
		cleanupUrls();
		previewSection.hidden = true;
		originalImage.removeAttribute('src');
		svgContainer.innerHTML = '';
		downloadLink.href = '#';
		downloadLink.setAttribute('aria-disabled', 'true');
		colorsMetadata.textContent = '—';
		pathsMetadata.textContent = '—';
		durationMetadata.textContent = '—';
		zoom = 1;
		updateZoom();
	};

	const clearError = (): void => {
		errorBox.hidden = true;
		errorBox.textContent = '';
	};

	const showError = (message: string): void => {
		errorBox.hidden = false;
		errorBox.textContent = message;
	};

	const renderSuccess = (file: File, payload: VectorizeSuccessResponse): void => {
		const safeSvg = sanitizeSvg(payload.svg);
		const svgBlob = new Blob([payload.svg], { type: 'image/svg+xml;charset=utf-8' });

		cleanupUrls();

		currentOriginalUrl = URL.createObjectURL(file);
		currentDownloadUrl = URL.createObjectURL(svgBlob);

		originalImage.src = currentOriginalUrl;
		svgContainer.innerHTML = safeSvg;
		downloadLink.href = currentDownloadUrl;
		downloadLink.download = buildDownloadFilename(file.name);
		downloadLink.setAttribute('aria-disabled', 'false');
		colorsMetadata.textContent = String(payload.metadata.colors_detected);
		pathsMetadata.textContent = String(payload.metadata.paths_generated);
		durationMetadata.textContent = `${payload.metadata.duration_ms} ms`;
		previewSection.hidden = false;
		zoom = 1;
		updateZoom();
	};

	const vectorizeFile = async (file: File): Promise<void> => {
		const validationError = validateFile(file);

		selectedFile.textContent = file.name;
		input.value = '';

		if (validationError) {
			resetResult();
			showError(validationError);
			setState('error', 'No se pudo iniciar la vectorización.');
			return;
		}

		clearError();
		resetResult();
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

			renderSuccess(file, payload as VectorizeSuccessResponse);
			clearError();
			setState('success', 'Vectorización lista. Ya podés revisar y descargar el SVG.');
		} catch (error) {
			resetResult();
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

	dropzone.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}

		event.preventDefault();
		input.click();
	});

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
		const file = dragEvent.dataTransfer?.files?.[0] ?? null;
		handleFile(file);
	});

	zoomInButton.addEventListener('click', () => {
		zoom = Math.min(MAX_ZOOM, Number((zoom + ZOOM_STEP).toFixed(2)));
		updateZoom();
	});

	zoomOutButton.addEventListener('click', () => {
		zoom = Math.max(MIN_ZOOM, Number((zoom - ZOOM_STEP).toFixed(2)));
		updateZoom();
	});

	window.addEventListener('beforeunload', cleanupUrls);
	dropzone.dataset.dragging = 'false';
	updateZoom();
}
