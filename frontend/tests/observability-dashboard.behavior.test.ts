import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';

// ─── Shared test utilities ─────────────────────────────────────────

type MockCredentials = { username: string; password: string } | null;

function buildSessionStorage(initial: MockCredentials = null) {
	const store = new Map<string, string>();
	if (initial) {
		store.set('obs-creds', JSON.stringify(initial));
	}
	return {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => { store.set(key, value); },
		removeItem: (key: string) => { store.delete(key); },
		clear: () => store.clear(),
	};
}

/**
 * Wire a listener that captures the last `obs:navigate` event path.
 * Returns a ref object { value: '' } that gets updated whenever
 * the obs-auth/obs-dashboard modules call obsNavigateTo().
 * This avoids any attempt to redefine window.location (disallowed in JSDOM).
 */
function captureNavigation(domWindow: Window): { value: string } {
	const ref = { value: '' };
	domWindow.addEventListener('obs:navigate', (e: Event) => {
		const detail = (e as CustomEvent<{ path: string }>).detail;
		ref.value = detail.path;
	});
	return ref;
}

function setupDom(html: string, sessionInitial: MockCredentials = null) {
	const dom = new JSDOM(html, { url: 'http://tracelab.test' });
	const native = {
		window: globalThis.window,
		document: globalThis.document,
		sessionStorage: globalThis.sessionStorage,
	};

	const sessionStorage = buildSessionStorage(sessionInitial);

	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		sessionStorage,
	});

	// Capture navigation events instead of redefining window.location.
	// obsNavigateTo() dispatches 'obs:navigate' + history.pushState in JSDOM.
	const navigatedTo = captureNavigation(dom.window as unknown as Window);

	const cleanup = () => {
		dom.window.close();
		Object.assign(globalThis, native);
	};

	return { dom, cleanup, sessionStorage, navigatedTo };
}

// ─── obs-auth tests ────────────────────────────────────────────────

describe('obs-auth: credential management', () => {
	afterEach(() => {
		vi.resetModules();
	});

	test('saveCredentials persists to sessionStorage', async () => {
		const { cleanup, sessionStorage } = setupDom('<html><body></body></html>');
		try {
			const { saveCredentials } = await import('../src/lib/obs-auth');
			saveCredentials({ username: 'admin', password: 'secret' });
			const raw = sessionStorage.getItem('obs-creds');
			expect(raw).not.toBeNull();
			const parsed = JSON.parse(raw!);
			expect(parsed).toEqual({ username: 'admin', password: 'secret' });
		} finally {
			cleanup();
		}
	});

	test('loadCredentials returns null when nothing stored', async () => {
		const { cleanup } = setupDom('<html><body></body></html>');
		try {
			const { loadCredentials } = await import('../src/lib/obs-auth');
			expect(loadCredentials()).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('loadCredentials returns stored credentials', async () => {
		const { cleanup } = setupDom(
			'<html><body></body></html>',
			{ username: 'admin', password: 'pass123' },
		);
		try {
			const { loadCredentials } = await import('../src/lib/obs-auth');
			const creds = loadCredentials();
			expect(creds).toEqual({ username: 'admin', password: 'pass123' });
		} finally {
			cleanup();
		}
	});

	test('clearCredentials removes stored credentials', async () => {
		const { cleanup, sessionStorage } = setupDom(
			'<html><body></body></html>',
			{ username: 'admin', password: 'pass' },
		);
		try {
			const { clearCredentials, loadCredentials } = await import('../src/lib/obs-auth');
			clearCredentials();
			expect(loadCredentials()).toBeNull();
			expect(sessionStorage.getItem('obs-creds')).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('encodeBasic produces correct Basic auth header', async () => {
		const { cleanup } = setupDom('<html><body></body></html>');
		try {
			const { encodeBasic } = await import('../src/lib/obs-auth');
			const header = encodeBasic('admin', 'secret');
			expect(header).toBe(`Basic ${btoa('admin:secret')}`);
		} finally {
			cleanup();
		}
	});

	test('loginErrorForStatus returns correct message for 401', async () => {
		const { cleanup } = setupDom('<html><body></body></html>');
		try {
			const { loginErrorForStatus } = await import('../src/lib/obs-auth');
			expect(loginErrorForStatus(401)).toContain('Invalid credentials');
		} finally {
			cleanup();
		}
	});

	test('loginErrorForStatus returns correct message for 403', async () => {
		const { cleanup } = setupDom('<html><body></body></html>');
		try {
			const { loginErrorForStatus } = await import('../src/lib/obs-auth');
			expect(loginErrorForStatus(403)).toContain('Invalid credentials');
		} finally {
			cleanup();
		}
	});

	test('loginErrorForStatus returns not-configured message for 503', async () => {
		const { cleanup } = setupDom('<html><body></body></html>');
		try {
			const { loginErrorForStatus } = await import('../src/lib/obs-auth');
			expect(loginErrorForStatus(503)).toContain('not configured');
		} finally {
			cleanup();
		}
	});

	test('loginErrorForStatus returns generic message for unexpected status', async () => {
		const { cleanup } = setupDom('<html><body></body></html>');
		try {
			const { loginErrorForStatus } = await import('../src/lib/obs-auth');
			const msg = loginErrorForStatus(500);
			expect(msg).toContain('500');
		} finally {
			cleanup();
		}
	});
});

// ─── initObsLogin tests ────────────────────────────────────────────

describe('initObsLogin: login flow', () => {
	// Include data-obs-login with data-obs-endpoint so the code can resolve
	// the verify URL without relying on a real network address.
	const LOGIN_HTML = `
		<html><body>
			<div data-obs-login data-obs-endpoint="http://api.test">
				<form data-obs-login-form>
					<input data-obs-username type="text" />
					<input data-obs-password type="password" />
					<p data-obs-login-error hidden></p>
					<button data-obs-login-submit type="submit">Login</button>
				</form>
			</div>
		</body></html>
	`;

	afterEach(() => {
		vi.resetModules();
	});

	test('shows validation error when username is empty', async () => {
		const { dom, cleanup } = setupDom(LOGIN_HTML);
		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			passwordInput!.value = 'secret';

			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			const errorBox = dom.window.document.querySelector<HTMLElement>('[data-obs-login-error]');
			expect(errorBox?.hidden).toBe(false);
			expect(errorBox?.textContent).toContain('required');
		} finally {
			cleanup();
		}
	});

	test('redirects to dashboard after successful credential verification', async () => {
		const { dom, cleanup, navigatedTo } = setupDom(LOGIN_HTML);
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const usernameInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-username]');
			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			usernameInput!.value = 'admin';
			passwordInput!.value = 'secret';

			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			// Wait for the async fetch + then() chain to settle.
			await new Promise((r) => setTimeout(r, 50));

			expect(fetchMock).toHaveBeenCalledOnce();
			expect(fetchMock.mock.calls[0][0]).toContain('/obs/summary');
			expect(navigatedTo.value).toBe('/observability/dashboard');
		} finally {
			cleanup();
		}
	});

	test('saves credentials only after successful verification', async () => {
		const { dom, cleanup, sessionStorage } = setupDom(LOGIN_HTML);
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const usernameInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-username]');
			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			usernameInput!.value = 'admin';
			passwordInput!.value = 'mypassword';

			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			// Credentials must NOT be stored before the fetch resolves.
			expect(sessionStorage.getItem('obs-creds')).toBeNull();

			await new Promise((r) => setTimeout(r, 50));

			const raw = sessionStorage.getItem('obs-creds');
			expect(raw).not.toBeNull();
			expect(JSON.parse(raw!)).toEqual({ username: 'admin', password: 'mypassword' });
		} finally {
			cleanup();
		}
	});

	test('stays on login and shows error on 401 response', async () => {
		const { dom, cleanup, sessionStorage, navigatedTo } = setupDom(LOGIN_HTML);
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 }),
		);
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const usernameInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-username]');
			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			usernameInput!.value = 'admin';
			passwordInput!.value = 'wrongpassword';

			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			// Must NOT have navigated away.
			expect(navigatedTo.value).not.toBe('/observability/dashboard');
			// Must NOT have persisted credentials.
			expect(sessionStorage.getItem('obs-creds')).toBeNull();
			// Must show error message.
			const errorBox = dom.window.document.querySelector<HTMLElement>('[data-obs-login-error]');
			expect(errorBox?.hidden).toBe(false);
			expect(errorBox?.textContent).toContain('Invalid credentials');
		} finally {
			cleanup();
		}
	});

	test('stays on login and shows error on 403 response', async () => {
		const { dom, cleanup, sessionStorage, navigatedTo } = setupDom(LOGIN_HTML);
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ detail: 'Forbidden' }), { status: 403 }),
		);
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const usernameInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-username]');
			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			usernameInput!.value = 'admin';
			passwordInput!.value = 'wrongpassword';

			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			expect(navigatedTo.value).not.toBe('/observability/dashboard');
			expect(sessionStorage.getItem('obs-creds')).toBeNull();
			const errorBox = dom.window.document.querySelector<HTMLElement>('[data-obs-login-error]');
			expect(errorBox?.hidden).toBe(false);
			expect(errorBox?.textContent).toContain('Invalid credentials');
		} finally {
			cleanup();
		}
	});

	test('stays on login and shows error on 503 response', async () => {
		const { dom, cleanup, sessionStorage, navigatedTo } = setupDom(LOGIN_HTML);
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ detail: 'Service unavailable' }), { status: 503 }),
		);
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const usernameInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-username]');
			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			usernameInput!.value = 'admin';
			passwordInput!.value = 'anypassword';

			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			expect(navigatedTo.value).not.toBe('/observability/dashboard');
			expect(sessionStorage.getItem('obs-creds')).toBeNull();
			const errorBox = dom.window.document.querySelector<HTMLElement>('[data-obs-login-error]');
			expect(errorBox?.hidden).toBe(false);
			expect(errorBox?.textContent).toContain('not configured');
		} finally {
			cleanup();
		}
	});

	test('stays on login and shows error when network request fails', async () => {
		const { dom, cleanup, sessionStorage, navigatedTo } = setupDom(LOGIN_HTML);
		const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const usernameInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-username]');
			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			usernameInput!.value = 'admin';
			passwordInput!.value = 'secret';

			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			expect(navigatedTo.value).not.toBe('/observability/dashboard');
			expect(sessionStorage.getItem('obs-creds')).toBeNull();
			const errorBox = dom.window.document.querySelector<HTMLElement>('[data-obs-login-error]');
			expect(errorBox?.hidden).toBe(false);
			expect(errorBox?.textContent).toContain('Could not reach');
		} finally {
			cleanup();
		}
	});

	test('re-enables submit button after failed verification', async () => {
		const { dom, cleanup } = setupDom(LOGIN_HTML);
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ detail: 'Unauthorized' }), { status: 401 }),
		);
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();

			const usernameInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-username]');
			const passwordInput = dom.window.document.querySelector<HTMLInputElement>('[data-obs-password]');
			usernameInput!.value = 'admin';
			passwordInput!.value = 'wrongpassword';

			const submitBtn = dom.window.document.querySelector<HTMLButtonElement>('[data-obs-login-submit]');
			const form = dom.window.document.querySelector<HTMLFormElement>('[data-obs-login-form]');
			form!.dispatchEvent(new dom.window.Event('submit', { bubbles: true }));

			// Button should be disabled while the request is in-flight.
			expect(submitBtn?.disabled).toBe(true);

			await new Promise((r) => setTimeout(r, 50));

			// Button must be re-enabled so the user can retry.
			expect(submitBtn?.disabled).toBe(false);
		} finally {
			cleanup();
		}
	});

	test('redirects to dashboard immediately if credentials already stored', async () => {
		const { navigatedTo, cleanup } = setupDom(
			LOGIN_HTML,
			{ username: 'admin', password: 'existing' },
		);
		try {
			const { initObsLogin } = await import('../src/lib/obs-auth');
			initObsLogin();
			expect(navigatedTo.value).toBe('/observability/dashboard');
		} finally {
			cleanup();
		}
	});
});

// ─── obs-dashboard fetch and render tests ─────────────────────────

describe('obs-dashboard: fetch data and render', () => {
	const DASHBOARD_HTML = `
		<html><body>
			<div data-obs-dashboard data-endpoint="http://api.test">
				<div data-obs-error hidden></div>
				<span data-obs-total-requests>—</span>
				<span data-obs-total-errors>—</span>
				<span data-obs-buffer-requests>—</span>
				<span data-obs-buffer-errors>—</span>
				<span data-obs-last-updated>—</span>
				<div data-obs-requests></div>
				<div data-obs-errors></div>
				<input type="checkbox" data-obs-refresh-toggle />
				<button data-obs-logout>Logout</button>
			</div>
		</body></html>
	`;

	const SUMMARY = {
		total_requests: 42,
		total_errors: 3,
		status_counts: { '200': 39, '400': 3 },
		path_counts: { '/vectorize': 30, 'other': 12 },
		requests_buffer_size: 42,
		errors_buffer_size: 3,
	};

	const REQUESTS_RESPONSE = {
		items: [
			{ timestamp: '2026-01-01T00:00:00Z', method: 'GET', path: '/health', status_code: 200, duration_ms: 5, message: 'OK' },
		],
		total: 1,
	};

	const ERRORS_RESPONSE = {
		items: [
			{ timestamp: '2026-01-01T00:01:00Z', method: 'POST', path: '/vectorize', error_type: 'IOError', error_detail: 'disk full' },
		],
		total: 1,
	};

	function buildFetch(responses: Record<string, unknown>) {
		return vi.fn(async (url: string) => {
			const key = Object.keys(responses).find((k) => url.includes(k));
			if (!key) throw new Error(`Unexpected fetch to ${url}`);
			return new Response(JSON.stringify(responses[key]), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
	}

	afterEach(() => {
		vi.resetModules();
	});

	test('renders summary cards with API data', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({ '/obs/summary': SUMMARY, '/obs/requests': REQUESTS_RESPONSE, '/obs/errors': ERRORS_RESPONSE });
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			// Wait for async fetch
			await new Promise((r) => setTimeout(r, 50));

			expect(dom.window.document.querySelector('[data-obs-total-requests]')?.textContent).toBe('42');
			expect(dom.window.document.querySelector('[data-obs-total-errors]')?.textContent).toBe('3');
		} finally {
			cleanup();
		}
	});

	test('renders requests table rows', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({ '/obs/summary': SUMMARY, '/obs/requests': REQUESTS_RESPONSE, '/obs/errors': ERRORS_RESPONSE });
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			const table = dom.window.document.querySelector('[data-obs-requests] table');
			expect(table).not.toBeNull();
			const rows = table?.querySelectorAll('tbody tr');
			expect(rows?.length).toBeGreaterThanOrEqual(1);
		} finally {
			cleanup();
		}
	});

	test('requests table includes Message column with HTTP reason phrase', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({ '/obs/summary': SUMMARY, '/obs/requests': REQUESTS_RESPONSE, '/obs/errors': ERRORS_RESPONSE });
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			const table = dom.window.document.querySelector('[data-obs-requests] table');
			expect(table).not.toBeNull();

			// Verify header includes Message column
			const headers = table?.querySelectorAll('thead th');
			const headerTexts = Array.from(headers ?? []).map((h) => h.textContent);
			expect(headerTexts).toContain('Message');

			// Verify first row contains the message value "OK"
			const firstRow = table?.querySelector('tbody tr');
			expect(firstRow?.innerHTML).toContain('OK');
		} finally {
			cleanup();
		}
	});

	test('renders errors table rows', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({ '/obs/summary': SUMMARY, '/obs/requests': REQUESTS_RESPONSE, '/obs/errors': ERRORS_RESPONSE });
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			const table = dom.window.document.querySelector('[data-obs-errors] table');
			expect(table).not.toBeNull();
		} finally {
			cleanup();
		}
	});

	test('shows error banner when fetch fails', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = vi.fn().mockRejectedValue(new Error('Network down'));
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			const errorBanner = dom.window.document.querySelector<HTMLElement>('[data-obs-error]');
			expect(errorBanner?.hidden).toBe(false);
			expect(errorBanner?.textContent).toContain('Failed to load');
		} finally {
			cleanup();
		}
	});

	test('clears credentials and redirects on 401 response', async () => {
		const { cleanup, sessionStorage, navigatedTo } = setupDom(
			DASHBOARD_HTML,
			{ username: 'admin', password: 'wrongpass' },
		);
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ detail: 'Unauthorized' }), {
				status: 401,
				headers: { 'content-type': 'application/json' },
			}),
		);
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			expect(sessionStorage.getItem('obs-creds')).toBeNull();
			expect(navigatedTo.value).toBe('/observability');
		} finally {
			cleanup();
		}
	});

	test('logout button clears credentials and redirects', async () => {
		const { dom, cleanup, sessionStorage, navigatedTo } = setupDom(
			DASHBOARD_HTML,
			{ username: 'admin', password: 'pass' },
		);
		const fetchMock = buildFetch({ '/obs/summary': SUMMARY, '/obs/requests': REQUESTS_RESPONSE, '/obs/errors': ERRORS_RESPONSE });
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			const logoutBtn = dom.window.document.querySelector<HTMLButtonElement>('[data-obs-logout]');
			logoutBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

			expect(sessionStorage.getItem('obs-creds')).toBeNull();
			expect(navigatedTo.value).toBe('/observability');
		} finally {
			cleanup();
		}
	});
});

// ─── obs-chart tests ───────────────────────────────────────────────

// vi.mock is hoisted — use vi.hoisted() to share mutable refs between the
// factory closure and individual test bodies.
const chartMocks = vi.hoisted(() => ({
	updateFn: vi.fn(),
	destroyFn: vi.fn(),
}));

vi.mock('chart.js/auto', () => {
	const Chart = vi.fn().mockImplementation(function(this: Record<string, unknown>, _canvas: unknown, _config: unknown) {
		this.data = { labels: [] as string[], datasets: [{ data: [] as number[] }] };
		this.update = chartMocks.updateFn;
		this.destroy = chartMocks.destroyFn;
	});
	return { default: Chart };
});

describe('obs-chart: Chart.js wrapper', () => {
	beforeEach(() => {
		chartMocks.updateFn.mockReset();
		chartMocks.destroyFn.mockReset();
	});

	afterEach(() => {
		vi.resetModules();
	});

	function buildCanvasMock() {
		const ctx = {
			clearRect: vi.fn(),
			fillRect: vi.fn(),
			canvas: {} as HTMLCanvasElement,
		};
		const canvas = {
			getContext: vi.fn().mockReturnValue(ctx),
			width: 800,
			height: 300,
		} as unknown as HTMLCanvasElement;
		return canvas;
	}

	test('initObsChart returns a chart instance', async () => {
		const canvas = buildCanvasMock();
		const { initObsChart } = await import('../src/lib/obs-chart');
		const chart = initObsChart(canvas);

		expect(chart).toBeDefined();
		expect(typeof chart.update).toBe('function');
		expect(typeof chart.destroy).toBe('function');
	});

	test('updateObsChart sets labels and data', async () => {
		const canvas = buildCanvasMock();
		const { initObsChart, updateObsChart } = await import('../src/lib/obs-chart');
		const chart = initObsChart(canvas);

		updateObsChart(chart, [
			{ bucket: '2026-04-10T12:00', count: 5 },
			{ bucket: '2026-04-10T12:01', count: 3 },
		]);

		expect((chart as unknown as { data: { labels: string[] } }).data.labels).toHaveLength(2);
		expect((chart as unknown as { data: { datasets: Array<{ data: number[] }> } }).data.datasets[0].data).toEqual([5, 3]);
		expect(chartMocks.updateFn).toHaveBeenCalledOnce();
	});

	test('updateObsChart with empty buckets clears the chart', async () => {
		const canvas = buildCanvasMock();
		const { initObsChart, updateObsChart } = await import('../src/lib/obs-chart');
		const chart = initObsChart(canvas);

		updateObsChart(chart, []);

		expect((chart as unknown as { data: { labels: string[] } }).data.labels).toHaveLength(0);
		expect((chart as unknown as { data: { datasets: Array<{ data: number[] }> } }).data.datasets[0].data).toHaveLength(0);
		expect(chartMocks.updateFn).toHaveBeenCalledOnce();
	});
});

// ─── obs-dashboard: filter selects and auto-refresh select ────────

describe('obs-dashboard: filter selects and auto-refresh select', () => {
	const DASHBOARD_WITH_FILTERS_HTML = `
		<html><body>
			<div data-obs-dashboard data-endpoint="http://api.test">
				<div data-obs-error hidden></div>
				<canvas data-obs-chart></canvas>
				<span data-obs-total-requests>—</span>
				<span data-obs-total-errors>—</span>
				<span data-obs-buffer-requests>—</span>
				<span data-obs-buffer-errors>—</span>
				<span data-obs-last-updated>—</span>
				<select data-obs-range-select>
					<option value="12h" selected>12h</option>
					<option value="1h">1h</option>
					<option value="30m">30m</option>
				</select>
				<select data-obs-status-select>
					<option value="all" selected>All</option>
				</select>
				<select data-obs-refresh-select>
					<option value="0" selected>Off</option>
					<option value="5000">5s</option>
					<option value="30000">30s</option>
				</select>
				<div data-obs-requests></div>
				<div data-obs-errors></div>
				<button data-obs-logout>Logout</button>
			</div>
		</body></html>
	`;

	const SUMMARY = {
		total_requests: 10,
		total_errors: 0,
		status_counts: { '200': 10, '404': 2, '500': 1 },
		path_counts: { '/health': 10 },
		requests_buffer_size: 10,
		errors_buffer_size: 0,
		persisted_total: 10,
	};

	const TIMESERIES_RESPONSE = {
		buckets: [{ bucket: '2026-04-10T12:00', count: 13, status_counts: { '200': 10, '404': 2, '500': 1 } }],
		range: '12h',
		bucket_width: '1h',
		total: 13,
	};

	const REQUESTS_RESPONSE = { items: [], total: 0 };
	const ERRORS_RESPONSE = { items: [], total: 0 };

	function buildFetch(responses: Record<string, unknown>) {
		return vi.fn(async (url: string) => {
			const key = Object.keys(responses).find((k) => url.includes(k));
			if (!key) return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
			return new Response(JSON.stringify(responses[key]), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
	}

	afterEach(() => {
		vi.resetModules();
	});

	test('initObsDashboard fetches timeseries when obs-chart canvas is present', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			const timeseriesCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/timeseries'),
			);
			expect(timeseriesCall).toBeDefined();
		} finally {
			cleanup();
		}
	});

	test('range select change triggers re-fetch with new range param', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			fetchMock.mockClear();

			// Change range to 1h
			const rangeSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-range-select]');
			rangeSelect!.value = '1h';
			rangeSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			const summaryCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/summary'),
			);
			expect(summaryCall).toBeDefined();
			expect(summaryCall![0]).toContain('range=1h');
		} finally {
			cleanup();
		}
	});

	test('status select change triggers re-fetch with new status param', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			fetchMock.mockClear();

		const statusSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-status-select]');
		expect(Array.from(statusSelect!.options).map((opt) => opt.value)).toEqual(['all', '200', '404', '500']);
		statusSelect!.value = '500';
		statusSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			const summaryCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/summary'),
			);
			expect(summaryCall).toBeDefined();
			expect(summaryCall![0]).toContain('status=500');
		} finally {
			cleanup();
		}
	});

	test('auto-refresh select with 0 disables auto-refresh', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			fetchMock.mockClear();

			// Select 0 = off
			const refreshSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-refresh-select]');
			refreshSelect!.value = '0';
			refreshSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			// Should not fetch again automatically (no timer)
			await new Promise((r) => setTimeout(r, 100));
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});

	test('combined range + status filters send both params', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			// Set both filters
			const rangeSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-range-select]');
			const statusSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-status-select]');

			rangeSelect!.value = '30m';
			statusSelect!.value = '500';

			fetchMock.mockClear();

			// Trigger change on status (range already set)
			statusSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			const summaryCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/summary'),
			);
			expect(summaryCall).toBeDefined();
			expect(summaryCall![0]).toContain('range=30m');
			expect(summaryCall![0]).toContain('status=500');
		} finally {
			cleanup();
		}
	});

	test('timeseries data is included in fetch when chart canvas is present', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			// Verify timeseries call includes range from default select value (12h)
			const timeseriesCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/timeseries'),
			);
			expect(timeseriesCall).toBeDefined();
			expect(timeseriesCall![0]).toContain('range=12h');
		} finally {
			cleanup();
		}
	});

	test('status=all omits status param from query', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			// Default status is "all" — should NOT include status= in URL
			const summaryCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/summary'),
			);
			expect(summaryCall).toBeDefined();
			expect(summaryCall![0]).not.toContain('status=');
		} finally {
			cleanup();
		}
	});
});

// ─── buildFilterQuery pure function tests ─────────────────────────

describe('buildFilterQuery: query string builder', () => {
	test('returns empty string when no filters provided', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		expect(buildFilterQuery({})).toBe('');
	});

	test('builds range-only query string', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		expect(buildFilterQuery({ range: '1h' })).toBe('?range=1h');
	});

	test('builds status-only query string (non-all)', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		expect(buildFilterQuery({ status: '500' })).toBe('?status=500');
	});

	test('omits status when value is "all"', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		const qs = buildFilterQuery({ range: '12h', status: 'all' });
		expect(qs).toBe('?range=12h');
		expect(qs).not.toContain('status');
	});

	test('combines range and status params', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		const qs = buildFilterQuery({ range: '30m', status: '404' });
		expect(qs).toContain('range=30m');
		expect(qs).toContain('status=404');
	});
});

describe('obs-chart: brush selection callback', () => {
	beforeEach(() => {
		chartMocks.updateFn.mockReset();
		chartMocks.destroyFn.mockReset();
	});

	afterEach(() => {
		vi.resetModules();
	});

	function buildCanvasMock() {
		const ctx = {
			clearRect: vi.fn(),
			fillRect: vi.fn(),
			canvas: {} as HTMLCanvasElement,
		};
		return {
			getContext: vi.fn().mockReturnValue(ctx),
			width: 800,
			height: 300,
		} as unknown as HTMLCanvasElement;
	}

	test('setOnBrushSelect is exported and callable', async () => {
		const canvas = buildCanvasMock();
		const { initObsChart, setOnBrushSelect } = await import('../src/lib/obs-chart');
		const chart = initObsChart(canvas);

		const callback = vi.fn();
		setOnBrushSelect(chart, callback);

		expect(typeof setOnBrushSelect).toBe('function');
	});

	test('triggerBrushSelect invokes the registered callback', async () => {
		const canvas = buildCanvasMock();
		const { initObsChart, setOnBrushSelect, triggerBrushSelect } = await import('../src/lib/obs-chart');
		const chart = initObsChart(canvas);

		const callback = vi.fn();
		setOnBrushSelect(chart, callback);

		triggerBrushSelect(chart, 1, 3);

		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith({ fromIndex: 1, toIndex: 3 });
	});
});

// ─── obs-chart: stacked status breakdown datasets ─────────────────

describe('obs-chart: stacked status breakdown', () => {
	beforeEach(() => {
		chartMocks.updateFn.mockReset();
		chartMocks.destroyFn.mockReset();
	});

	afterEach(() => {
		vi.resetModules();
	});

	function buildCanvasMock() {
		const ctx = {
			clearRect: vi.fn(),
			fillRect: vi.fn(),
			canvas: {} as HTMLCanvasElement,
		};
		return {
			getContext: vi.fn().mockReturnValue(ctx),
			width: 800,
			height: 300,
		} as unknown as HTMLCanvasElement;
	}

	test('updateObsChart creates datasets per exact status code when breakdown present', async () => {
		const canvas = buildCanvasMock();
		const { initObsChart, updateObsChart } = await import('../src/lib/obs-chart');
		const chart = initObsChart(canvas);

		updateObsChart(chart, [
			{ bucket: '2026-04-10T12:00', count: 5, status_counts: { '200': 2, '201': 1, '404': 1, '500': 1 } },
			{ bucket: '2026-04-10T12:01', count: 2, status_counts: { '200': 2 } },
		]);

		const datasets = (chart as unknown as { data: { datasets: Array<{ data: number[]; label: string }> } }).data.datasets;
		expect(datasets.length).toBe(4);

		const d200 = datasets.find(d => d.label === '200');
		expect(d200).toBeDefined();
		expect(d200!.data).toEqual([2, 2]);

		const d201 = datasets.find(d => d.label === '201');
		expect(d201).toBeDefined();
		expect(d201!.data).toEqual([1, 0]);

		const d404 = datasets.find(d => d.label === '404');
		expect(d404).toBeDefined();
		expect(d404!.data).toEqual([1, 0]);

		const d500 = datasets.find(d => d.label === '500');
		expect(d500).toBeDefined();
		expect(d500!.data).toEqual([1, 0]);
	});

	test('updateObsChart falls back to single dataset when no breakdown fields', async () => {
		const canvas = buildCanvasMock();
		const { initObsChart, updateObsChart } = await import('../src/lib/obs-chart');
		const chart = initObsChart(canvas);

		updateObsChart(chart, [
			{ bucket: '2026-04-10T12:00', count: 5 },
		]);

		const datasets = (chart as unknown as { data: { datasets: Array<{ data: number[] }> } }).data.datasets;
		expect(datasets.length).toBe(1);
		expect(datasets[0].data).toEqual([5]);
	});
});

// ─── obs-dashboard: limit control tests ───────────────────────────

describe('obs-dashboard: limit control', () => {
	const DASHBOARD_LIMIT_HTML = `
		<html><body>
			<div data-obs-dashboard data-endpoint="http://api.test">
				<div data-obs-error hidden></div>
				<canvas data-obs-chart></canvas>
				<span data-obs-total-requests>—</span>
				<span data-obs-total-errors>—</span>
				<span data-obs-buffer-requests>—</span>
				<span data-obs-buffer-errors>—</span>
				<span data-obs-last-updated>—</span>
				<select data-obs-range-select>
					<option value="12h" selected>12h</option>
				</select>
				<select data-obs-status-select>
					<option value="all" selected>All</option>
				</select>
				<select data-obs-refresh-select>
					<option value="0" selected>Off</option>
				</select>
				<select data-obs-limit-select>
					<option value="20" selected>20</option>
					<option value="100">100</option>
					<option value="200">200</option>
				</select>
				<div data-obs-requests></div>
				<div data-obs-errors></div>
				<button data-obs-logout>Logout</button>
			</div>
		</body></html>
	`;

	const SUMMARY = {
		total_requests: 10,
		total_errors: 0,
		status_counts: { '200': 10 },
		path_counts: { '/health': 10 },
		requests_buffer_size: 10,
		errors_buffer_size: 0,
	};
	const TIMESERIES_RESPONSE = {
		buckets: [{ bucket: '2026-04-10T12:00', count: 10, status_counts: { '200': 10 } }],
		range: '12h',
		bucket_width: '1h',
		total: 10,
	};
	const REQUESTS_RESPONSE = { items: [], total: 0 };
	const ERRORS_RESPONSE = { items: [], total: 0 };

	function buildFetch(responses: Record<string, unknown>) {
		return vi.fn(async (url: string) => {
			const key = Object.keys(responses).find((k) => url.includes(k));
			if (!key) return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
			return new Response(JSON.stringify(responses[key]), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
	}

	afterEach(() => {
		vi.resetModules();
	});

	test('initial fetch includes limit param from limit select', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_LIMIT_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			const requestsCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/requests'),
			);
			expect(requestsCall).toBeDefined();
			expect(requestsCall![0]).toContain('limit=20');

			const errorsCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/errors'),
			);
			expect(errorsCall).toBeDefined();
			expect(errorsCall![0]).toContain('limit=20');
		} finally {
			cleanup();
		}
	});

	test('changing limit select triggers re-fetch with new limit', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_LIMIT_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			fetchMock.mockClear();

			const limitSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-limit-select]');
			limitSelect!.value = '100';
			limitSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			const requestsCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/requests'),
			);
			expect(requestsCall).toBeDefined();
			expect(requestsCall![0]).toContain('limit=100');

			const errorsCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/errors'),
			);
			expect(errorsCall).toBeDefined();
			expect(errorsCall![0]).toContain('limit=100');
		} finally {
			cleanup();
		}
	});
});

// ─── buildFilterQuery: limit parameter ────────────────────────────

describe('buildFilterQuery: limit parameter support', () => {
	test('includes limit when provided', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		const qs = buildFilterQuery({ range: '1h', limit: 20 });
		expect(qs).toContain('limit=20');
		expect(qs).toContain('range=1h');
	});

	test('omits limit when not provided', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		const qs = buildFilterQuery({ range: '1h' });
		expect(qs).not.toContain('limit');
	});
});

// ─── buildFilterQuery: from_ts/to_ts support ─────────────────────

describe('buildFilterQuery: from_ts/to_ts zoom parameters', () => {
	test('includes from_ts and to_ts when provided', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		const qs = buildFilterQuery({ range: '1h', from_ts: '2026-04-10T12:00:00Z', to_ts: '2026-04-10T13:00:00Z' });
		expect(qs).toContain('from_ts=');
		expect(qs).toContain('to_ts=');
		expect(qs).toContain('range=1h');
	});

	test('omits from_ts and to_ts when not provided', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		const qs = buildFilterQuery({ range: '1h' });
		expect(qs).not.toContain('from_ts');
		expect(qs).not.toContain('to_ts');
	});

	test('includes from_ts/to_ts alongside status and limit', async () => {
		const { buildFilterQuery } = await import('../src/lib/obs-dashboard');
		const qs = buildFilterQuery({
			range: '30m',
			status: '500',
			limit: 20,
			from_ts: '2026-04-10T12:00:00Z',
			to_ts: '2026-04-10T12:30:00Z',
		});
		expect(qs).toContain('range=30m');
		expect(qs).toContain('status=500');
		expect(qs).toContain('limit=20');
		expect(qs).toContain('from_ts=');
		expect(qs).toContain('to_ts=');
	});
});

// ─── obs-dashboard: brush zoom reset button ───────────────────────

describe('obs-dashboard: zoom reset button', () => {
	const DASHBOARD_ZOOM_HTML = `
		<html><body>
			<div data-obs-dashboard data-endpoint="http://api.test">
				<div data-obs-error hidden></div>
				<canvas data-obs-chart></canvas>
				<span data-obs-total-requests>—</span>
				<span data-obs-total-errors>—</span>
				<span data-obs-buffer-requests>—</span>
				<span data-obs-buffer-errors>—</span>
				<span data-obs-last-updated>—</span>
				<select data-obs-range-select>
					<option value="12h" selected>12h</option>
				</select>
				<select data-obs-status-select>
					<option value="all" selected>All</option>
				</select>
				<select data-obs-refresh-select>
					<option value="0" selected>Off</option>
				</select>
				<button data-obs-chart-reset hidden>Reset Zoom</button>
				<div data-obs-requests></div>
				<div data-obs-errors></div>
				<button data-obs-logout>Logout</button>
			</div>
		</body></html>
	`;

	const SUMMARY = {
		total_requests: 10,
		total_errors: 0,
		status_counts: { '200': 10 },
		path_counts: { '/health': 10 },
		requests_buffer_size: 10,
		errors_buffer_size: 0,
	};
	const TIMESERIES_RESPONSE = {
		buckets: [
			{ bucket: '2026-04-10T12:00', count: 5, status_counts: { '200': 5 } },
			{ bucket: '2026-04-10T13:00', count: 5, status_counts: { '200': 5 } },
		],
		range: '12h',
		bucket_width: '1h',
		total: 10,
	};
	const REQUESTS_RESPONSE = { items: [], total: 0 };
	const ERRORS_RESPONSE = { items: [], total: 0 };

	function buildFetch(responses: Record<string, unknown>) {
		return vi.fn(async (url: string) => {
			const key = Object.keys(responses).find((k) => url.includes(k));
			if (!key) return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
			return new Response(JSON.stringify(responses[key]), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
	}

	afterEach(() => {
		vi.resetModules();
	});

	test('reset zoom button is hidden initially', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_ZOOM_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			const resetBtn = dom.window.document.querySelector<HTMLButtonElement>('[data-obs-chart-reset]');
			expect(resetBtn).not.toBeNull();
			expect(resetBtn!.hidden).toBe(true);
		} finally {
			cleanup();
		}
	});

	test('clicking reset zoom button removes from_ts/to_ts from next fetch', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_ZOOM_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			fetchMock.mockClear();

			// Click reset zoom
			const resetBtn = dom.window.document.querySelector<HTMLButtonElement>('[data-obs-chart-reset]');
			resetBtn!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

			await new Promise((r) => setTimeout(r, 50));

			// After reset, fetch should NOT contain from_ts/to_ts
			const timeseriesCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/timeseries'),
			);
			if (timeseriesCall) {
				expect(timeseriesCall[0]).not.toContain('from_ts=');
				expect(timeseriesCall[0]).not.toContain('to_ts=');
			}

			// And reset button should be hidden again
			expect(resetBtn!.hidden).toBe(true);
		} finally {
			cleanup();
		}
	});

	test('brush selection on chart triggers fetch with from_ts/to_ts and shows reset button', async () => {
		const { dom, cleanup } = setupDom(DASHBOARD_ZOOM_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			const { triggerBrushSelect } = await import('../src/lib/obs-chart');
			initObsDashboard();

			await new Promise((r) => setTimeout(r, 50));

			fetchMock.mockClear();

			// Get the chart instance from the canvas — it's stored internally.
			// We need to trigger brush select on the chart. The dashboard wires the
			// callback during init, so triggerBrushSelect on the chart should work.
			// We find the chart via the Chart constructor mock.
			const ChartModule = await import('chart.js/auto');
			const ChartCtor = ChartModule.default as unknown as { mock: { instances: Array<unknown> } };
			const chartInstance = ChartCtor.mock.instances[ChartCtor.mock.instances.length - 1];

			triggerBrushSelect(chartInstance as import('chart.js/auto').default, 0, 1);

			await new Promise((r) => setTimeout(r, 50));

			// Verify fetch includes from_ts and to_ts
			const timeseriesCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/timeseries'),
			);
			expect(timeseriesCall).toBeDefined();
			expect(timeseriesCall![0]).toContain('from_ts=');
			expect(timeseriesCall![0]).toContain('to_ts=');

			// Reset button should be visible
			const resetBtn = dom.window.document.querySelector<HTMLButtonElement>('[data-obs-chart-reset]');
			expect(resetBtn!.hidden).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe('obs-dashboard: auto-refresh select behavior', () => {
	const DASHBOARD_WITH_FILTERS_HTML = `
		<html><body>
			<div data-obs-dashboard data-endpoint="http://api.test">
				<div data-obs-error hidden></div>
				<canvas data-obs-chart></canvas>
				<span data-obs-total-requests>—</span>
				<span data-obs-total-errors>—</span>
				<span data-obs-buffer-requests>—</span>
				<span data-obs-buffer-errors>—</span>
				<span data-obs-last-updated>—</span>
				<select data-obs-range-select>
					<option value="12h" selected>12h</option>
				</select>
				<select data-obs-status-select>
					<option value="all" selected>All</option>
				</select>
				<select data-obs-refresh-select>
					<option value="0" selected>Off</option>
					<option value="5000">5s</option>
					<option value="10000">10s</option>
					<option value="30000">30s</option>
					<option value="60000">1min</option>
				</select>
				<div data-obs-requests></div>
				<div data-obs-errors></div>
				<button data-obs-logout>Logout</button>
			</div>
		</body></html>
	`;

	const SUMMARY = {
		total_requests: 10,
		total_errors: 0,
		status_counts: { '200': 10 },
		path_counts: { '/health': 10 },
		requests_buffer_size: 10,
		errors_buffer_size: 0,
	};

	const TIMESERIES_RESPONSE = {
		buckets: [{ bucket: '2026-04-10T12:00', count: 10 }],
		range: '12h',
		bucket_width: '1h',
		total: 10,
	};

	const REQUESTS_RESPONSE = { items: [], total: 0 };
	const ERRORS_RESPONSE = { items: [], total: 0 };

	function buildFetch(responses: Record<string, unknown>) {
		return vi.fn(async (url: string) => {
			const key = Object.keys(responses).find((k) => url.includes(k));
			if (!key) return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
			return new Response(JSON.stringify(responses[key]), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
	}

	afterEach(() => {
		vi.resetModules();
		vi.useRealTimers();
	});

	test('selecting a positive interval starts auto-refresh polling', async () => {
		vi.useFakeTimers();

		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			// Let initial fetch resolve
			await vi.advanceTimersByTimeAsync(50);

			fetchMock.mockClear();

			// Enable auto-refresh at 5s
			const refreshSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-refresh-select]');
			refreshSelect!.value = '5000';
			refreshSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			// Advance timer by 5 seconds — should trigger one auto-refresh
			await vi.advanceTimersByTimeAsync(5000);

			// At least one fetch cycle should have occurred
			expect(fetchMock).toHaveBeenCalled();
			const summaryCall = fetchMock.mock.calls.find(
				(call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/obs/summary'),
			);
			expect(summaryCall).toBeDefined();
		} finally {
			cleanup();
		}
	});

	test('switching from positive interval to 0 stops polling', async () => {
		vi.useFakeTimers();

		const { dom, cleanup } = setupDom(DASHBOARD_WITH_FILTERS_HTML, { username: 'admin', password: 'pass' });
		const fetchMock = buildFetch({
			'/obs/summary': SUMMARY,
			'/obs/timeseries': TIMESERIES_RESPONSE,
			'/obs/requests': REQUESTS_RESPONSE,
			'/obs/errors': ERRORS_RESPONSE,
		});
		Object.assign(globalThis, { fetch: fetchMock });

		try {
			const { initObsDashboard } = await import('../src/lib/obs-dashboard');
			initObsDashboard();

			await vi.advanceTimersByTimeAsync(50);

			// Enable auto-refresh at 5s
			const refreshSelect = dom.window.document.querySelector<HTMLSelectElement>('[data-obs-refresh-select]');
			refreshSelect!.value = '5000';
			refreshSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			// Verify one tick fires
			await vi.advanceTimersByTimeAsync(5000);

			fetchMock.mockClear();

			// Now disable
			refreshSelect!.value = '0';
			refreshSelect!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

			// Advance another 10 seconds — should NOT trigger
			await vi.advanceTimersByTimeAsync(10000);

			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			cleanup();
		}
	});
});
