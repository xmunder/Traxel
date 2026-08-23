// Backend session-cookie flow for the observability panel.

export function obsNavigateTo(path: string): void {
	window.dispatchEvent(new window.CustomEvent('obs:navigate', { detail: { path } }));
	if (window.navigator.userAgent.includes('jsdom')) {
		window.history.pushState({}, '', path);
		return;
	}
	window.location.href = path;
}

export function loginErrorForStatus(status: number): string {
	if (status === 401 || status === 403) return 'Invalid credentials. Please try again.';
	if (status === 503) return 'Observability panel is not configured on the server.';
	return `Authentication failed (HTTP ${status}). Please try again.`;
}

export async function hasSession(endpoint: string): Promise<boolean> {
	try {
		const response = await fetch(`${endpoint}/obs/session`, { credentials: 'include' });
		return response.ok;
	} catch {
		return false;
	}
}

export function initObsLogin(): void {
	const form = document.querySelector<HTMLFormElement>('[data-obs-login-form]');
	const usernameInput = document.querySelector<HTMLInputElement>('[data-obs-username]');
	const passwordInput = document.querySelector<HTMLInputElement>('[data-obs-password]');
	const errorBox = document.querySelector<HTMLElement>('[data-obs-login-error]');
	const submitButton = document.querySelector<HTMLButtonElement>('[data-obs-login-submit]');
	if (!form || !usernameInput || !passwordInput) return;

	const endpoint = document.querySelector<HTMLElement>('[data-obs-login]')?.dataset.obsEndpoint ?? 'http://127.0.0.1:8000';
	const showError = (message: string): void => {
		if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; }
	};
	const hideError = (): void => {
		if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
	};

	form.addEventListener('submit', (event: Event) => {
		event.preventDefault();
		const username = usernameInput.value.trim();
		const password = passwordInput.value;
		if (!username || !password) { showError('Username and password are required.'); return; }
		hideError();
		if (submitButton) submitButton.disabled = true;
		fetch(`${endpoint}/obs/login`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password }),
		})
			.then((response) => {
				if (response.ok) { obsNavigateTo('/observability/dashboard'); return; }
				showError(loginErrorForStatus(response.status));
				if (submitButton) submitButton.disabled = false;
			})
			.catch(() => {
				showError('Could not reach the server. Please check your connection.');
				if (submitButton) submitButton.disabled = false;
			});
	});
}
