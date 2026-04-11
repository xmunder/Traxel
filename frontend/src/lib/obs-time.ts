// obs-time.ts — Centralized timestamp formatting for the observability dashboard.
// All display timestamps are converted from UTC to America/Bogota (COT, UTC-5).
// Storage/API layer remains canonical UTC — this module is presentation-only.

/** The IANA timezone used for all dashboard display timestamps. */
export const DISPLAY_TIMEZONE = 'America/Bogota';

/**
 * Formats an ISO-8601 (or Date-parseable) timestamp string for display in
 * the configured dashboard timezone.
 *
 * Output: "2026-04-10 14:30:05" (24h, no seconds omitted, locale-neutral).
 *
 * Returns the original string unchanged if parsing fails, so the UI never
 * shows a blank cell due to a bad timestamp.
 */
export function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;

	return date.toLocaleString('sv-SE', {
		timeZone: DISPLAY_TIMEZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
}

/**
 * Formats a Date object (typically `new Date()`) as a short time string in
 * the dashboard timezone, suitable for "Last updated" labels.
 *
 * Output: "14:30:05 COT"
 */
export function formatLastUpdated(date: Date): string {
	return date.toLocaleString('en-US', {
		timeZone: DISPLAY_TIMEZONE,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
		timeZoneName: 'short',
	});
}

/**
 * Formats a bucket label (ISO-ish string like "2026-04-10T12:00") to a short
 * time-only label for chart axes.
 *
 * Output: "07:00" (or "Apr 10 07:00" when `includeDate` is true).
 *
 * Returns the original string if parsing fails.
 */
export function formatBucketLabel(bucket: string, includeDate = false): string {
	if (!bucket) return bucket;

	// Only attempt normalisation for strings that look like ISO date-time.
	// Bucket strings from the API are like "2026-04-10T12:00" — may lack seconds/timezone.
	const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
	if (!ISO_LIKE.test(bucket)) return bucket;

	const normalised = bucket.includes('Z') || bucket.includes('+') ? bucket : `${bucket}:00Z`;
	const date = new Date(normalised);
	if (Number.isNaN(date.getTime())) return bucket;

	if (includeDate) {
		return date.toLocaleString('en-US', {
			timeZone: DISPLAY_TIMEZONE,
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		});
	}

	return date.toLocaleString('en-US', {
		timeZone: DISPLAY_TIMEZONE,
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	});
}
