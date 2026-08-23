import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const modes = new Set(['configured', 'unconfigured', 'smoke']);
const [mode, portValue] = process.argv.slice(2);
const port = Number(portValue);

if (!modes.has(mode) || !Number.isInteger(port) || port < 1 || port > 65_535) {
	console.error('Usage: node tests/e2e/server-wrapper.mjs <configured|unconfigured|smoke> <port>');
	process.exitCode = 2;
} else {
	const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
	const backendDir = resolve(frontendDir, '../backend');
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith('OBS_')),
	);
	let dataDir;

	if (mode === 'configured') {
		dataDir = await mkdtemp(join(tmpdir(), 'traxel-e2e-'));
		Object.assign(env, {
			OBS_USERNAME: 'e2e-admin',
			OBS_SECRET: 'e2e-secret',
			OBS_DB_PATH: join(dataDir, 'obs.db'),
		});
	} else {
		Object.assign(env, {
			OBS_USERNAME: '',
			OBS_SECRET: '',
			OBS_DB_PATH: '',
		});
	}

	let cleanupPromise;
	const cleanup = () => {
		cleanupPromise ??= dataDir
			? rm(dataDir, { recursive: true, force: true })
			: Promise.resolve();
		return cleanupPromise;
	};

	const child = spawn(
		resolve(backendDir, '.venv/bin/python'),
		['-m', 'uvicorn', 'src.main:app', '--host', '127.0.0.1', '--port', String(port)],
		{
			cwd: backendDir,
			env,
			stdio: 'inherit',
		},
	);

	let shuttingDown = false;
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
		process.on(signal, () => {
			if (shuttingDown) return;
			shuttingDown = true;
			child.kill(signal);
			setTimeout(() => child.kill('SIGKILL'), 8_000).unref();
		});
	}

	child.on('error', async (error) => {
		console.error(error);
		await cleanup();
		process.exitCode = 1;
	});

	child.on('exit', async (code, signal) => {
		await cleanup();
		process.exitCode = code ?? (signal ? 1 : 0);
	});
}
