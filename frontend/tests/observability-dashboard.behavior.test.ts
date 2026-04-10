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
			{ timestamp: '2026-01-01T00:00:00Z', method: 'GET', path: '/health', status_code: 200, duration_ms: 5 },
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
