// obs-dashboard.ts — fetches /obs/* endpoints and wires the dashboard UI.

import { clearCredentials, encodeBasic, loadCredentials, obsNavigateTo, requireAuth } from './obs-auth';

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
};

export type ObsErrorItem = {
	timestamp: string;
	method: string;
	path: string;
	error_type: string;
	error_detail: string;
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
// Data mappers
// ---------------------------------------------------------------------------

export async function fetchDashboardData(
	endpoint: string,
	authHeader: string,
): Promise<{
	summary: ObsSummary;
	requests: ObsRequestItem[];
	errors: ObsErrorItem[];
}> {
	const [summaryData, requestsData, errorsData] = await Promise.all([
		fetchObs<ObsSummary>(`${endpoint}/obs/summary`, authHeader),
		fetchObs<{ items: ObsRequestItem[]; total: number }>(`${endpoint}/obs/requests`, authHeader),
		fetchObs<{ items: ObsErrorItem[]; total: number }>(`${endpoint}/obs/errors`, authHeader),
	]);

	return {
		summary: summaryData,
		requests: requestsData.items,
		errors: errorsData.items,
	};
}

// ---------------------------------------------------------------------------
// DOM rendering helpers
// ---------------------------------------------------------------------------

function setText(selector: string, value: string, root: ParentNode = document): void {
	const el = root.querySelector<HTMLElement>(selector);
	if (el) el.textContent = value;
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
			<td>${escapeHtml(item.timestamp)}</td>
			<td><span class="obs-method obs-method--${item.method.toLowerCase()}">${escapeHtml(item.method)}</span></td>
			<td>${escapeHtml(item.path)}</td>
			<td><span class="obs-status obs-status--${statusClass(item.status_code)}">${item.status_code}</span></td>
			<td>${item.duration_ms} ms</td>
		</tr>`,
		)
		.join('');

	container.innerHTML = `
		<table class="obs-table">
			<thead>
				<tr>
					<th>Timestamp</th>
					<th>Method</th>
					<th>Path</th>
					<th>Status</th>
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
			<td>${escapeHtml(item.timestamp)}</td>
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
					<th>Timestamp</th>
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
	const refreshToggle = document.querySelector<HTMLInputElement>('[data-obs-refresh-toggle]');
	const logoutButton = document.querySelector<HTMLButtonElement>('[data-obs-logout]');
	const lastUpdated = document.querySelector<HTMLElement>('[data-obs-last-updated]');

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

	const refresh = async (): Promise<void> => {
		try {
			const data = await fetchDashboardData(endpoint, authHeader);
			clearError();

			// Summary cards
			setText('[data-obs-total-requests]', String(data.summary.total_requests));
			setText('[data-obs-total-errors]', String(data.summary.total_errors));
			setText('[data-obs-buffer-requests]', String(data.summary.requests_buffer_size));
			setText('[data-obs-buffer-errors]', String(data.summary.errors_buffer_size));

			// Tables
			if (requestsContainer) renderRequestsTable(requestsContainer, data.requests);
			if (errorsContainer) renderErrorsTable(errorsContainer, data.errors);

			if (lastUpdated) {
				lastUpdated.textContent = new Date().toISOString();
			}
		} catch (err) {
			if (err instanceof Error && err.message !== 'Unauthorized') {
				showError(`Failed to load dashboard data: ${err.message}`);
			}
		}
	};

	const startAutoRefresh = (): void => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			void refresh();
		}, 30_000);
	};

	const stopAutoRefresh = (): void => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	};

	// Wire refresh toggle
	if (refreshToggle) {
		refreshToggle.addEventListener('change', () => {
			if (refreshToggle.checked) {
				startAutoRefresh();
			} else {
				stopAutoRefresh();
			}
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
