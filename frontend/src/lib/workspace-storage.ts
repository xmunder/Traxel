export type VectorizeMetadata = {
	colors_detected: number;
	paths_generated: number;
	duration_ms: number;
};

export type VectorizeSuccessResponse = {
	svg: string;
	metadata: VectorizeMetadata;
};

export type StoredWorkspaceResult = VectorizeSuccessResponse & {
	filename: string;
	originalFile: Blob;
	storedAt: string;
};

export class WorkspaceStorageError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.name = 'WorkspaceStorageError';
		if (options?.cause !== undefined) {
			(this as Error & { cause?: unknown }).cause = options.cause;
		}
	}
}

const DATABASE_NAME = 'vectorizer-workspace';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace-results';
const STORAGE_KEY = 'current';
const MEMORY_STORE_KEY = '__vectorizerWorkspaceMemoryStore';

type MemoryStoreHost = typeof globalThis & {
	[MEMORY_STORE_KEY]?: Map<string, StoredWorkspaceResult>;
};

function getMemoryStore(): Map<string, StoredWorkspaceResult> {
	const host = globalThis as MemoryStoreHost;
	if (!host[MEMORY_STORE_KEY]) {
		host[MEMORY_STORE_KEY] = new Map<string, StoredWorkspaceResult>();
	}

	return host[MEMORY_STORE_KEY];
}

function cloneForMemoryStore(result: StoredWorkspaceResult): StoredWorkspaceResult {
	return {
		...result,
		originalFile: result.originalFile.slice(0, result.originalFile.size, result.originalFile.type),
	};
}

function canUseIndexedDb(): boolean {
	return typeof indexedDB !== 'undefined';
}

function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

		request.onupgradeneeded = () => {
			const database = request.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME);
			}
		};

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('No se pudo abrir IndexedDB.'));
		request.onblocked = () => reject(new Error('IndexedDB está bloqueada.'));
	});
}

async function withObjectStore<T>(
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	const database = await openDatabase();

	return new Promise<T>((resolve, reject) => {
		const transaction = database.transaction(STORE_NAME, mode);
		const store = transaction.objectStore(STORE_NAME);
		const request = operation(store);

		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error('Falló la operación en IndexedDB.'));
		transaction.onerror = () => reject(transaction.error ?? new Error('Falló la transacción en IndexedDB.'));
		transaction.oncomplete = () => database.close();
		transaction.onabort = () => database.close();
	});
}

export type SaveWorkspaceResultOutcome = {
	/** The storage backend that successfully persisted the result. */
	persisted: 'indexeddb' | 'memory';
};

export async function saveWorkspaceResult(result: StoredWorkspaceResult): Promise<SaveWorkspaceResultOutcome> {
	if (!canUseIndexedDb()) {
		getMemoryStore().set(STORAGE_KEY, cloneForMemoryStore(result));
		return { persisted: 'memory' };
	}

	try {
		await withObjectStore('readwrite', (store) => store.put(result, STORAGE_KEY));
		return { persisted: 'indexeddb' };
	} catch {
		// IndexedDB exists but failed (e.g. quota exceeded, blocked, private browsing).
		// Fall back to in-memory store and signal the caller so they can degrade gracefully.
		getMemoryStore().set(STORAGE_KEY, cloneForMemoryStore(result));
		return { persisted: 'memory' };
	}
}

export async function clearWorkspaceResult(): Promise<void> {
	if (!canUseIndexedDb()) {
		getMemoryStore().delete(STORAGE_KEY);
		return;
	}

	try {
		await withObjectStore('readwrite', (store) => store.delete(STORAGE_KEY));
	} catch {
		// Ignorar fallos de limpieza para no romper el flujo del usuario.
	}
}

export async function readWorkspaceResult(): Promise<StoredWorkspaceResult | null> {
	if (!canUseIndexedDb()) {
		return getMemoryStore().get(STORAGE_KEY) ?? null;
	}

	try {
		const result = await withObjectStore<StoredWorkspaceResult | undefined>('readonly', (store) =>
			store.get(STORAGE_KEY),
		);
		return result ?? null;
	} catch {
		return null;
	}
}
