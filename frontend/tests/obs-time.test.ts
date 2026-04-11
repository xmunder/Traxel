import { describe, expect, test } from 'vitest';
import {
	DISPLAY_TIMEZONE,
	formatBucketLabel,
	formatLastUpdated,
	formatTimestamp,
} from '../src/lib/obs-time';

// ─── DISPLAY_TIMEZONE constant ─────────────────────────────────────

describe('DISPLAY_TIMEZONE constant', () => {
	test('is set to America/Bogota', () => {
		expect(DISPLAY_TIMEZONE).toBe('America/Bogota');
	});
});

// ─── formatTimestamp ───────────────────────────────────────────────

describe('formatTimestamp: ISO → Bogotá display', () => {
	test('converts a UTC midnight timestamp to COT (UTC-5)', () => {
		// 2026-01-15T00:00:00Z in UTC → 2026-01-14 19:00:00 in America/Bogota
		const result = formatTimestamp('2026-01-15T00:00:00Z');
		expect(result).toBe('2026-01-14 19:00:00');
	});

	test('converts a UTC afternoon timestamp correctly', () => {
		// 2026-04-10T18:30:45Z → 2026-04-10 13:30:45 COT
		const result = formatTimestamp('2026-04-10T18:30:45Z');
		expect(result).toBe('2026-04-10 13:30:45');
	});

	test('handles timestamps already at COT midnight boundary', () => {
		// 2026-06-01T05:00:00Z = midnight COT
		const result = formatTimestamp('2026-06-01T05:00:00Z');
		expect(result).toBe('2026-06-01 00:00:00');
	});

	test('returns original string for unparseable input', () => {
		expect(formatTimestamp('not-a-date')).toBe('not-a-date');
	});

	test('returns original string for empty input', () => {
		expect(formatTimestamp('')).toBe('');
	});
});

// ─── formatLastUpdated ─────────────────────────────────────────────

describe('formatLastUpdated: Date → short COT display', () => {
	test('produces a time string with timezone abbreviation', () => {
		const date = new Date('2026-04-10T18:30:45Z');
		const result = formatLastUpdated(date);
		// Should contain 13:30:45 (COT = UTC-5) and a timezone indicator
		expect(result).toContain('13:30:45');
	});

	test('includes timezone name in output', () => {
		const date = new Date('2026-04-10T12:00:00Z');
		const result = formatLastUpdated(date);
		// ICU may render COT or "GMT-5" — either is acceptable
		expect(result).toMatch(/COT|GMT-5/);
	});
});

// ─── formatBucketLabel ─────────────────────────────────────────────

describe('formatBucketLabel: bucket → chart axis label', () => {
	test('converts UTC bucket to COT time-only by default', () => {
		// "2026-04-10T12:00" is treated as UTC → 07:00 COT
		const result = formatBucketLabel('2026-04-10T12:00');
		expect(result).toContain('07:00');
	});

	test('includes date when includeDate is true', () => {
		const result = formatBucketLabel('2026-04-10T12:00', true);
		expect(result).toContain('Apr');
		expect(result).toContain('10');
		expect(result).toContain('07:00');
	});

	test('handles bucket strings with trailing Z', () => {
		const result = formatBucketLabel('2026-04-10T12:00:00Z');
		expect(result).toContain('07:00');
	});

	test('returns original string for unparseable bucket', () => {
		expect(formatBucketLabel('bad-bucket')).toBe('bad-bucket');
	});

	test('returns original string for empty input', () => {
		expect(formatBucketLabel('')).toBe('');
	});
});
