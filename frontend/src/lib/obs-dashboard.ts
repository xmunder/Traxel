// obs-dashboard.ts — fetches /obs/* endpoints and wires the dashboard UI.

import { clearCredentials, encodeBasic, loadCredentials, obsNavigateTo, requireAuth } from './obs-auth';
import { bindBrushInteraction, type ObsBucket, initObsChart, setOnBrushSelect, updateObsChart } from './obs-chart';
import { formatLastUpdated, formatTimestamp } from './obs-time';

export type ObsSummary = {
	total_requests: number;
	total_errors: number;
	status_counts: Record<string, number>;
	path_counts: Record<string, number>;
	requests_buffer_size: number;
	errors_buffer_size: number;
};

export type ObsRequestItem = {
	timestamp: string;
	method: string;
	path: string;
	status_code: number;
	duration_ms: number;
	message: string;
};

export type ObsErrorItem = {
	timestamp: string;
	method: string;
	path: string;
	error_type: string;
	error_detail: string;
};

export type ObsTimeseriesResponse = {
	buckets: ObsBucket[];
	range: string;
	bucket_width: string;
	total: number;
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchObs<T>(url: string, authHeader: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			Authorization: authHeader,
		},
	});

	if (response.status === 401 || response.status === 403) {
		clearCredentials();
		obsNavigateTo('/observability');
		// Return dummy value — navigation already happening.
		throw new Error('Unauthorized');
	}

	if (!response.ok) {
		throw new Error(`Request to ${url} failed with status ${response.status}`);
	}

	return response.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Filter query builder (pure function — testable in isolation)
// ---------------------------------------------------------------------------

export type DashboardFilters = {
	range?: string;
	status?: string;
	limit?: number;
	from_ts?: string;
	to_ts?: string;
};

export function buildFilterQuery(filters: DashboardFilters): string {
	const params = new URLSearchParams();
	if (filters.range) params.set('range', filters.range);
	if (filters.status && filters.status !== 'all') params.set('status', filters.status);
	if (filters.limit) params.set('limit', String(filters.limit));
	if (filters.from_ts) params.set('from_ts', filters.from_ts);
	if (filters.to_ts) params.set('to_ts', filters.to_ts);
	const qs = params.toString();
	return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------------------
// Data mappers
// ---------------------------------------------------------------------------

export async function fetchDashboardData(
	endpoint: string,
	authHeader: string,
	filters: DashboardFilters = {},
): Promise<{
	summary: ObsSummary;
	requests: ObsRequestItem[];
	errors: ObsErrorItem[];
	timeseries?: ObsTimeseriesResponse;
}> {
	const qs = buildFilterQuery(filters);

	const fetches: [
		Promise<ObsSummary>,
		Promise<{ items: ObsRequestItem[]; total: number }>,
		Promise<{ items: ObsErrorItem[]; total: number }>,
		Promise<ObsTimeseriesResponse> | null,
	] = [
		fetchObs<ObsSummary>(`${endpoint}/obs/summary${qs}`, authHeader),
		fetchObs<{ items: ObsRequestItem[]; total: number }>(`${endpoint}/obs/requests${qs}`, authHeader),
		fetchObs<{ items: ObsErrorItem[]; total: number }>(`${endpoint}/obs/errors${qs}`, authHeader),
		null,
	];

	// Always fetch timeseries when filters are active (advanced mode)
	if (qs || filters.range) {
		fetches[3] = fetchObs<ObsTimeseriesResponse>(`${endpoint}/obs/timeseries${qs}`, authHeader);
	}

	const results = await Promise.all(
		fetches.filter((f): f is Promise<unknown> => f !== null),
	);

	const summaryData = results[0] as ObsSummary;
	const requestsData = results[1] as { items: ObsRequestItem[]; total: number };
	const errorsData = results[2] as { items: ObsErrorItem[]; total: number };
	const timeseriesData = results.length > 3 ? (results[3] as ObsTimeseriesResponse) : undefined;

	return {
		summary: summaryData,
		requests: requestsData.items,
		errors: errorsData.items,
		timeseries: timeseriesData,
	};
}

// ---------------------------------------------------------------------------
// DOM rendering helpers
// ---------------------------------------------------------------------------

function setText(selector: string, value: string, root: ParentNode = document): void {
	const el = root.querySelector<HTMLElement>(selector);
	if (el) el.textContent = value;
}

function updateStatusOptions(
	select: HTMLSelectElement | null,
	statusCounts: Record<string, number>,
	selectedValue?: string,
): void {
	if (!select) return;
	const current = selectedValue ?? select.value ?? 'all';
	const existingStatuses = Array.from(select.options)
		.map((option) => option.value)
		.filter((status) => /^\d{3}$/.test(status));
	const statuses = Array.from(new Set([...existingStatuses, ...Object.keys(statusCounts)]))
		.filter((status) => /^\d{3}$/.test(status))
		.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

	select.innerHTML = [
		'<option value="all">All</option>',
		...statuses.map((status) => `<option value="${status}">${status}</option>`),
	].join('');

	select.value = statuses.includes(current) || current === 'all' ? current : 'all';
}

function renderRequestsTable(
	container: HTMLElement,
	items: ObsRequestItem[],
): void {
	if (!items.length) {
		container.innerHTML = '<p class="obs-empty">No requests recorded yet.</p>';
		return;
	}

	const rows = items
		.map(
			(item) => `
		<tr>
			<td>${escapeHtml(formatTimestamp(item.timestamp))}</td>
			<td><span class="obs-method obs-method--${item.method.toLowerCase()}">${escapeHtml(item.method)}</span></td>
			<td>${escapeHtml(item.path)}</td>
			<td><span class="obs-status obs-status--${statusClass(item.status_code)}">${item.status_code}</span></td>
			<td>${escapeHtml(item.message || '')}</td>
			<td>${item.duration_ms} ms</td>
		</tr>`,
		)
		.join('');

	container.innerHTML = `
		<table class="obs-table">
			<thead>
				<tr>
					<th>Timestamp (COT)</th>
					<th>Method</th>
					<th>Path</th>
					<th>Status</th>
					<th>Message</th>
					<th>Duration</th>
				</tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>`;
}

function renderErrorsTable(
	container: HTMLElement,
	items: ObsErrorItem[],
): void {
	if (!items.length) {
		container.innerHTML = '<p class="obs-empty">No errors recorded.</p>';
		return;
	}

	const rows = items
		.map(
			(item) => `
		<tr>
			<td>${escapeHtml(formatTimestamp(item.timestamp))}</td>
			<td><span class="obs-method obs-method--${item.method.toLowerCase()}">${escapeHtml(item.method)}</span></td>
			<td>${escapeHtml(item.path)}</td>
			<td>${escapeHtml(item.error_type)}</td>
			<td class="obs-error-detail">${escapeHtml(item.error_detail)}</td>
		</tr>`,
		)
		.join('');

	container.innerHTML = `
		<table class="obs-table">
			<thead>
				<tr>
					<th>Timestamp (COT)</th>
					<th>Method</th>
					<th>Path</th>
					<th>Error Type</th>
					<th>Detail</th>
				</tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>`;
}

function statusClass(code: number): string {
	if (code >= 500) return '5xx';
	if (code >= 400) return '4xx';
	if (code >= 300) return '3xx';
	if (code >= 200) return '2xx';
	return 'other';
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Dashboard initialiser
// ---------------------------------------------------------------------------

export function initObsDashboard(): void {
	const creds = requireAuth();
	const authHeader = encodeBasic(creds.username, creds.password);

	const app = document.querySelector<HTMLElement>('[data-obs-dashboard]');
	if (!app) return;

	const endpoint = app.dataset.endpoint ?? 'http://127.0.0.1:8000';

	const errorBanner = document.querySelector<HTMLElement>('[data-obs-error]');
	const requestsContainer = document.querySelector<HTMLElement>('[data-obs-requests]');
	const errorsContainer = document.querySelector<HTMLElement>('[data-obs-errors]');
	const logoutButton = document.querySelector<HTMLButtonElement>('[data-obs-logout]');
	const lastUpdated = document.querySelector<HTMLElement>('[data-obs-last-updated]');

	// Advanced controls (may or may not be present)
	const chartCanvas = document.querySelector<HTMLCanvasElement>('[data-obs-chart]');
	const chartBrushOverlay = document.querySelector<HTMLElement>('[data-obs-chart-brush]');
	const rangeSelect = document.querySelector<HTMLSelectElement>('[data-obs-range-select]');
	const statusSelect = document.querySelector<HTMLSelectElement>('[data-obs-status-select]');
	const refreshSelect = document.querySelector<HTMLSelectElement>('[data-obs-refresh-select]');
	const limitSelect = document.querySelector<HTMLSelectElement>('[data-obs-limit-select]');
	const resetZoomButton = document.querySelector<HTMLButtonElement>('[data-obs-chart-reset]');

	// Legacy refresh toggle (backwards compat with old HTML)
	const refreshToggle = document.querySelector<HTMLInputElement>('[data-obs-refresh-toggle]');

	// Chart instance (created only if canvas exists)
	let chart: ReturnType<typeof initObsChart> | null = null;
	if (chartCanvas) {
		chart = initObsChart(chartCanvas);
		bindBrushInteraction(chart, chartCanvas, chartBrushOverlay);

		// Register brush selection callback: maps bucket indices to ISO timestamps
		setOnBrushSelect(chart, ({ fromIndex, toIndex }) => {
			if (lastBuckets.length === 0) return;
			const fromBucket = lastBuckets[Math.max(0, fromIndex)];
			const toBucket = lastBuckets[Math.min(lastBuckets.length - 1, toIndex)];
			if (!fromBucket || !toBucket) return;

			// Bucket labels are truncated ISO strings (e.g. "2026-04-10T12:00").
			// Append Z to ensure they parse as UTC.
			zoomFromTs = fromBucket.bucket.endsWith('Z') ? fromBucket.bucket : `${fromBucket.bucket}:00Z`;
			zoomToTs = toBucket.bucket.endsWith('Z') ? toBucket.bucket : `${toBucket.bucket}:00Z`;

			if (resetZoomButton) resetZoomButton.hidden = false;
			void refresh();
		});
	}

	// Zoom state: when set, from_ts/to_ts override the range_preset window
	let zoomFromTs: string | undefined;
	let zoomToTs: string | undefined;

	// Last received timeseries buckets — used to map brush indices to timestamps
	let lastBuckets: ObsBucket[] = [];

	// Determine whether we're in advanced mode (filters present)
	const isAdvancedMode = !!(chartCanvas || rangeSelect || statusSelect || refreshSelect);

	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	const showError = (message: string): void => {
		if (errorBanner) {
			errorBanner.textContent = message;
			errorBanner.hidden = false;
		}
	};

	const clearError = (): void => {
		if (errorBanner) {
			errorBanner.hidden = true;
			errorBanner.textContent = '';
		}
	};

	/** Build the current filter state from DOM selects. */
	const currentFilters = (): DashboardFilters => {
		const filters: DashboardFilters = {};
		if (rangeSelect) filters.range = rangeSelect.value;
		if (statusSelect) filters.status = statusSelect.value;
		if (limitSelect) {
			const limitVal = parseInt(limitSelect.value, 10);
			if (limitVal > 0) filters.limit = limitVal;
		}
		if (zoomFromTs) filters.from_ts = zoomFromTs;
		if (zoomToTs) filters.to_ts = zoomToTs;
		return filters;
	};

	const refresh = async (): Promise<void> => {
		try {
			const filters = isAdvancedMode ? currentFilters() : {};
			const data = await fetchDashboardData(endpoint, authHeader, filters);
			clearError();

			if (statusSelect) {
				updateStatusOptions(statusSelect, data.summary.status_counts, filters.status);
			}

			// Summary cards
			setText('[data-obs-total-requests]', String(data.summary.total_requests));
			setText('[data-obs-total-errors]', String(data.summary.total_errors));
			setText('[data-obs-buffer-requests]', String(data.summary.requests_buffer_size));
			setText('[data-obs-buffer-errors]', String(data.summary.errors_buffer_size));

			// Chart
			if (chart && data.timeseries) {
				updateObsChart(chart, data.timeseries.buckets);
				lastBuckets = data.timeseries.buckets;
			}

			// Tables
			if (requestsContainer) renderRequestsTable(requestsContainer, data.requests);
			if (errorsContainer) renderErrorsTable(errorsContainer, data.errors);

			if (lastUpdated) {
				lastUpdated.textContent = formatLastUpdated(new Date());
			}
		} catch (err) {
			if (err instanceof Error && err.message !== 'Unauthorized') {
				showError(`Failed to load dashboard data: ${err.message}`);
			}
		}
	};

	const startAutoRefresh = (intervalMs: number): void => {
		stopAutoRefresh();
		if (intervalMs <= 0) return;
		refreshTimer = setInterval(() => {
			void refresh();
		}, intervalMs);
	};

	const stopAutoRefresh = (): void => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	};

	// Wire range select
	if (rangeSelect) {
		rangeSelect.addEventListener('change', () => {
			void refresh();
		});
	}

	// Wire status select
	if (statusSelect) {
		statusSelect.addEventListener('change', () => {
			void refresh();
		});
	}

	// Wire limit select
	if (limitSelect) {
		limitSelect.addEventListener('change', () => {
			void refresh();
		});
	}

	// Wire auto-refresh select (advanced)
	if (refreshSelect) {
		refreshSelect.addEventListener('change', () => {
			const intervalMs = parseInt(refreshSelect.value, 10);
			if (intervalMs > 0) {
				startAutoRefresh(intervalMs);
			} else {
				stopAutoRefresh();
			}
		});
	}

	// Wire legacy refresh toggle (backwards compat)
	if (refreshToggle && !refreshSelect) {
		refreshToggle.addEventListener('change', () => {
			if (refreshToggle.checked) {
				startAutoRefresh(30_000);
			} else {
				stopAutoRefresh();
			}
		});
	}

	// Wire reset zoom button
	if (resetZoomButton) {
		resetZoomButton.addEventListener('click', () => {
			zoomFromTs = undefined;
			zoomToTs = undefined;
			resetZoomButton.hidden = true;
			void refresh();
		});
	}

	// Wire logout
	if (logoutButton) {
		logoutButton.addEventListener('click', () => {
			clearCredentials();
			obsNavigateTo('/observability');
		});
	}

	// Initial load
	void refresh();
}

// Re-export for tests
export { loadCredentials, clearCredentials };
