export type HexColor = `#${string}`;
export type PaletteEntry = {
	source: HexColor;
	current: HexColor;
	targetPathIndexes: number[];
};
export type EditableSvgDocument = {
	readonly originalSvg: string;
	readonly currentSvg: string;
	readonly entries: PaletteEntry[];
	replace(source: HexColor, next: string): boolean;
	reset(source: HexColor): void;
	resetAll(): void;
};

const SHORT_HEX_PATTERN = /^#([0-9a-f]{3})$/i;
const FULL_HEX_PATTERN = /^#[0-9a-f]{6}$/i;

export function normalizeHexColor(value: string): HexColor | null {
	const trimmed = value.trim();
	if (FULL_HEX_PATTERN.test(trimmed)) {
		return trimmed.toUpperCase() as HexColor;
	}

	const shorthand = SHORT_HEX_PATTERN.exec(trimmed);
	if (!shorthand) {
		return null;
	}

	return `#${[...shorthand[1]].map((character) => character.repeat(2)).join('').toUpperCase()}`;
}

function parseSvg(svg: string): XMLDocument {
	const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
	if (parsed.querySelector('parsererror') || !parsed.documentElement.matches('svg')) {
		throw new Error('Cannot edit an invalid SVG document.');
	}
	return parsed;
}

function serializeSvg(document: XMLDocument): string {
	return new XMLSerializer().serializeToString(document.documentElement);
}

export function createEditableSvgDocument(originalSvg: string, currentSvg: string): EditableSvgDocument {
	const original = parseSvg(originalSvg);
	const current = parseSvg(currentSvg);
	const originalPaths = Array.from(original.querySelectorAll('path'));
	const currentPaths = Array.from(current.querySelectorAll('path'));
	const entriesBySource = new Map<HexColor, PaletteEntry>();

	originalPaths.forEach((path, index) => {
		const source = normalizeHexColor(path.getAttribute('fill') ?? '');
		if (!source) return;

		const existing = entriesBySource.get(source);
		if (existing) {
			existing.targetPathIndexes.push(index);
			return;
		}

		entriesBySource.set(source, {
			source,
			current: normalizeHexColor(currentPaths[index]?.getAttribute('fill') ?? '') ?? source,
			targetPathIndexes: [index],
		});
	});

	const entries = Array.from(entriesBySource.values());
	let serializedCurrentSvg = serializeSvg(current);

	return {
		originalSvg,
		get currentSvg() {
			return serializedCurrentSvg;
		},
		entries,
		replace(source, next) {
			const canonicalNext = normalizeHexColor(next);
			const entry = entriesBySource.get(source);
			if (!entry || !canonicalNext) return false;

			for (const index of entry.targetPathIndexes) {
				currentPaths[index]?.setAttribute('fill', canonicalNext);
			}
			entry.current = canonicalNext;
			serializedCurrentSvg = serializeSvg(current);
			return true;
		},
		reset(source) {
			this.replace(source, source);
		},
		resetAll() {
			for (const entry of entries) {
				for (const index of entry.targetPathIndexes) {
					currentPaths[index]?.setAttribute('fill', entry.source);
				}
				entry.current = entry.source;
			}
			serializedCurrentSvg = originalSvg;
		},
	};
}
