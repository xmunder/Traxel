// obs-auth.ts — sessionStorage-based HTTP Basic credential manager
// for the observability panel.  Uses sessionStorage so creds are
// automatically cleared when the tab closes.

const STORAGE_KEY = 'obs-creds';

/**
 * Navigate to a path.
 * In JSDOM (tests): dispatches `obs:navigate` CustomEvent + pushState so we
 * never touch window.location (which JSDOM disallows redefining).
 * In a real browser: sets window.location.href.
 */
export function obsNavigateTo(path: string): void {
	window.dispatchEvent(new window.CustomEvent('obs:navigate', { detail: { path } }));
	if (window.navigator.userAgent.includes('jsdom')) {
		window.history.pushState({}, '', path);
		return;
	}
	window.location.href = path;
}

export type ObsCredentials = {
	username: string;
	password: string;
};

/** Encode credentials as a Basic auth header value. */
export function encodeBasic(username: string, password: string): string {
	return `Basic ${btoa(`${username}:${password}`)}`;
}

/** Persist credentials to sessionStorage. */
export function saveCredentials(creds: ObsCredentials): void {
	sessionStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

/** Retrieve credentials from sessionStorage, or null if absent. */
export function loadCredentials(): ObsCredentials | null {
	const raw = sessionStorage.getItem(STORAGE_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			'username' in parsed &&
			'password' in parsed &&
			typeof (parsed as Record<string, unknown>).username === 'string' &&
			typeof (parsed as Record<string, unknown>).password === 'string'
		) {
			return parsed as ObsCredentials;
		}
		return null;
	} catch {
		return null;
	}
}

/** Remove stored credentials (e.g. on auth failure). */
export function clearCredentials(): void {
	sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Redirect to the login page if no credentials are stored.
 * Must be called on protected pages before fetching any data.
 */
export function requireAuth(loginPath = '/observability'): ObsCredentials {
	const creds = loadCredentials();
	if (!creds) {
		obsNavigateTo(loginPath);
		// Return a dummy value — page is already navigating away.
		// This path is only reached in test environments.
		return { username: '', password: '' };
	}
	return creds;
}

// ---------------------------------------------------------------------------
// Login page initialiser
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status code returned during login verification to a
 * human-readable error message shown on the login form.
 */
export function loginErrorForStatus(status: number): string {
	if (status === 401 || status === 403) {
		return 'Invalid credentials. Please try again.';
	}
	if (status === 503) {
		return 'Observability panel is not configured on the server.';
	}
	return `Authentication failed (HTTP ${status}). Please try again.`;
}

export function initObsLogin(): void {
	// If we already have valid creds stored, go straight to the dashboard.
	const existing = loadCredentials();
	if (existing) {
		obsNavigateTo('/observability/dashboard');
		return;
	}

	const form = document.querySelector<HTMLFormElement>('[data-obs-login-form]');
	const usernameInput = document.querySelector<HTMLInputElement>('[data-obs-username]');
	const passwordInput = document.querySelector<HTMLInputElement>('[data-obs-password]');
	const errorBox = document.querySelector<HTMLElement>('[data-obs-login-error]');
	const submitButton = document.querySelector<HTMLButtonElement>('[data-obs-login-submit]');

	if (!form || !usernameInput || !passwordInput) {
		return;
	}

	// Resolve the backend endpoint from the login container's data attribute.
	// Falls back to the default backend address if the attribute is absent.
	const loginContainer = document.querySelector<HTMLElement>('[data-obs-login]');
	const endpoint = loginContainer?.dataset.obsEndpoint ?? 'http://127.0.0.1:8000';

	const showError = (message: string): void => {
		if (errorBox) {
			errorBox.textContent = message;
			errorBox.hidden = false;
		}
	};

	const hideError = (): void => {
		if (errorBox) {
			errorBox.hidden = true;
			errorBox.textContent = '';
		}
	};

	form.addEventListener('submit', (event: Event) => {
		event.preventDefault();

		const username = usernameInput.value.trim();
		const password = passwordInput.value;

		if (!username || !password) {
			showError('Username and password are required.');
			return;
		}

		hideError();

		if (submitButton) {
			submitButton.disabled = true;
		}

		// Verify credentials against the backend before storing or navigating.
		// Only a successful (2xx) response grants access to the dashboard.
		const authHeader = encodeBasic(username, password);

		fetch(`${endpoint}/obs/summary`, {
			headers: { Authorization: authHeader },
		})
			.then((response) => {
				if (response.ok) {
					// Credentials are valid — persist and enter the dashboard.
					saveCredentials({ username, password });
					obsNavigateTo('/observability/dashboard');
				} else {
					// Auth or server error — stay on login, show feedback.
					showError(loginErrorForStatus(response.status));
					if (submitButton) {
						submitButton.disabled = false;
					}
				}
			})
			.catch(() => {
				showError('Could not reach the server. Please check your connection.');
				if (submitButton) {
					submitButton.disabled = false;
				}
			});
	});
}
