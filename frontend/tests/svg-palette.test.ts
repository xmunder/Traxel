import { describe, expect, test } from 'vitest';

import { createEditableSvgDocument, normalizeHexColor } from '../src/lib/svg-palette';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#f00"/><path fill="#00FF00"/><path fill="#FF0000"/><rect fill="#123456"/><path fill="none"/></svg>';

describe('SVG palette', () => {
	test('normalizes shorthand hex colors to canonical uppercase values', () => {
		expect(normalizeHexColor('#a3f')).toBe('#AA33FF');
	});

	test('normalizes full hex colors and rejects incomplete values', () => {
		expect(normalizeHexColor(' #12abEF ')).toBe('#12ABEF');
		expect(normalizeHexColor('#12ab')).toBeNull();
	});

	test('extracts distinct direct path fills in first-seen order with path ordinal bindings', () => {
		const document = createEditableSvgDocument(SVG, SVG);

		expect(document.entries).toEqual([
			{ source: '#FF0000', current: '#FF0000', targetPathIndexes: [0, 2] },
			{ source: '#00FF00', current: '#00FF00', targetPathIndexes: [1] },
		]);
	});

	test('replaces every bound path while preserving independent rows when replacements converge', () => {
		const document = createEditableSvgDocument(SVG, SVG);

		expect(document.replace('#FF0000', '#123456')).toBe(true);
		expect(document.replace('#00FF00', '#123456')).toBe(true);
		expect(document.entries.map(({ source, current }) => ({ source, current }))).toEqual([
			{ source: '#FF0000', current: '#123456' },
			{ source: '#00FF00', current: '#123456' },
		]);
		const parsed = new DOMParser().parseFromString(document.currentSvg, 'image/svg+xml');
		expect(Array.from(parsed.querySelectorAll('path')).map((path) => path.getAttribute('fill'))).toEqual([
			'#123456', '#123456', '#123456', 'none',
		]);
	});

	test('does not mutate the document or replacement when a hex value is invalid', () => {
		const document = createEditableSvgDocument(SVG, SVG);
		const before = document.currentSvg;

		expect(document.replace('#FF0000', '#12')).toBe(false);
		expect(document.currentSvg).toBe(before);
		expect(document.entries[0].current).toBe('#FF0000');
	});

	test('resets one source independently and then restores every source', () => {
		const document = createEditableSvgDocument(SVG, SVG);
		document.replace('#FF0000', '#111111');
		document.replace('#00FF00', '#222222');

		document.reset('#FF0000');
		expect(document.entries.map((entry) => entry.current)).toEqual(['#FF0000', '#222222']);

		document.resetAll();
		expect(document.entries.map((entry) => entry.current)).toEqual(['#FF0000', '#00FF00']);
		expect(document.currentSvg).toBe(document.originalSvg);
	});

	test('restores replacement values from a previously edited SVG', () => {
		const current = SVG.replaceAll('#f00', '#112233').replace('#FF0000', '#112233');
		const document = createEditableSvgDocument(SVG, current);

		expect(document.entries.map((entry) => entry.current)).toEqual(['#112233', '#00FF00']);
		document.reset('#FF0000');
		expect(document.entries[0].current).toBe('#FF0000');
	});

	test('rejects malformed documents instead of producing an empty editable palette', () => {
		expect(() => createEditableSvgDocument('<not-svg/>', '<not-svg/>')).toThrow(
			'Cannot edit an invalid SVG document.',
		);
	});
});
