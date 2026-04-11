// obs-chart.ts — Chart.js wrapper for the observability timeseries chart.

import Chart from 'chart.js/auto';
import { formatBucketLabel } from './obs-time';

export type ObsChartInstance = Chart;

export type ObsBucket = {
	bucket: string;
	count: number;
	status_counts?: Record<string, number>;
	count_2xx?: number;
	count_3xx?: number;
	count_4xx?: number;
	count_5xx?: number;
};

export type BrushSelection = { fromIndex: number; toIndex: number };
type BrushCallback = (selection: BrushSelection) => void;

/** WeakMap to associate brush callbacks with chart instances. */
const brushCallbacks = new WeakMap<Chart, BrushCallback>();

/**
 * Register a callback that fires when the user brush-selects a range on the chart.
 * The callback receives the start and end bucket indices.
 */
export function setOnBrushSelect(chart: Chart, callback: BrushCallback): void {
	brushCallbacks.set(chart, callback);
}

/**
 * Programmatically trigger the brush selection callback for the given chart.
 * Useful for testing and for the internal mouse-event handler.
 */
export function triggerBrushSelect(chart: Chart, fromIndex: number, toIndex: number): void {
	const cb = brushCallbacks.get(chart);
	if (cb) {
		const lo = Math.min(fromIndex, toIndex);
		const hi = Math.max(fromIndex, toIndex);
		cb({ fromIndex: lo, toIndex: hi });
	}
}

function clampIndex(index: number, labelsCount: number): number {
	return Math.max(0, Math.min(labelsCount - 1, index));
}

function indexFromClientX(canvas: HTMLCanvasElement, clientX: number, labelsCount: number): number {
	const rect = canvas.getBoundingClientRect();
	const width = rect.width || canvas.width || 1;
	const relativeX = Math.max(0, Math.min(width, clientX - rect.left));
	const bucketWidth = width / Math.max(labelsCount, 1);
	return clampIndex(Math.floor(relativeX / Math.max(bucketWidth, 1)), labelsCount);
}

/**
 * Bind real mouse drag interactions to the chart canvas so users can select
 * a time interval directly on the histogram.
 */
export function bindBrushInteraction(
	chart: Chart,
	canvas: HTMLCanvasElement,
	overlay?: HTMLElement | null,
): void {
	let dragging = false;
	let startX = 0;

	const showOverlay = (fromPx: number, toPx: number): void => {
		if (!overlay) return;
		overlay.hidden = false;
		overlay.style.left = `${Math.min(fromPx, toPx)}px`;
		overlay.style.width = `${Math.abs(toPx - fromPx)}px`;
	};

	const hideOverlay = (): void => {
		if (!overlay) return;
		overlay.hidden = true;
		overlay.style.left = '0px';
		overlay.style.width = '0px';
	};

	canvas.addEventListener('mousedown', (event: MouseEvent) => {
		const labelsCount = chart.data.labels?.length ?? 0;
		if (labelsCount < 2) return;
		dragging = true;
		startX = event.clientX;
		showOverlay(event.offsetX, event.offsetX);
	});

	canvas.addEventListener('mousemove', (event: MouseEvent) => {
		if (!dragging) return;
		showOverlay(startX - canvas.getBoundingClientRect().left, event.offsetX);
	});

	const finishBrush = (event: MouseEvent): void => {
		if (!dragging) return;
		dragging = false;
		const labelsCount = chart.data.labels?.length ?? 0;
		if (labelsCount < 2) {
			hideOverlay();
			return;
		}
		const fromIndex = indexFromClientX(canvas, startX, labelsCount);
		const toIndex = indexFromClientX(canvas, event.clientX, labelsCount);
		hideOverlay();
		if (fromIndex === toIndex) return;
		triggerBrushSelect(chart, fromIndex, toIndex);
	};

	canvas.addEventListener('mouseup', finishBrush);
	canvas.addEventListener('mouseleave', () => {
		if (dragging) {
			dragging = false;
			hideOverlay();
		}
	});
}

/**
 * Initialises a bar chart on the given canvas element.
 * Returns the Chart instance (caller owns its lifecycle).
 */
export function initObsChart(canvas: HTMLCanvasElement): Chart {
	return new Chart(canvas, {
		type: 'bar',
		data: {
			labels: [],
			datasets: [
				{
					label: 'Requests',
					data: [],
					backgroundColor: 'rgba(99, 102, 241, 0.6)',
					borderColor: 'rgba(99, 102, 241, 1)',
					borderWidth: 1,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			plugins: {
				legend: { display: false },
			},
			scales: {
				y: {
					beginAtZero: true,
				},
			},
		},
	});
}

/** Status family color palette for stacked chart datasets. */
const STATUS_COLORS: Record<string, { bg: string; border: string }> = {
	'2xx': { bg: 'rgba(0, 160, 80, 0.6)', border: 'rgba(0, 160, 80, 1)' },
	'3xx': { bg: 'rgba(0, 100, 220, 0.6)', border: 'rgba(0, 100, 220, 1)' },
	'4xx': { bg: 'rgba(200, 140, 0, 0.6)', border: 'rgba(200, 140, 0, 1)' },
	'5xx': { bg: 'rgba(200, 60, 60, 0.6)', border: 'rgba(200, 60, 60, 1)' },
};

function colorForStatus(code: string): { bg: string; border: string } {
	const numeric = Number.parseInt(code, 10);
	if (Number.isNaN(numeric)) {
		return { bg: 'rgba(99, 102, 241, 0.6)', border: 'rgba(99, 102, 241, 1)' };
	}
	if (numeric >= 500) return { bg: 'rgba(200, 60, 60, 0.6)', border: 'rgba(200, 60, 60, 1)' };
	if (numeric >= 400) return { bg: 'rgba(200, 140, 0, 0.6)', border: 'rgba(200, 140, 0, 1)' };
	if (numeric >= 300) return { bg: 'rgba(0, 100, 220, 0.6)', border: 'rgba(0, 100, 220, 1)' };
	if (numeric >= 200) return { bg: 'rgba(0, 160, 80, 0.6)', border: 'rgba(0, 160, 80, 1)' };
	return { bg: 'rgba(99, 102, 241, 0.6)', border: 'rgba(99, 102, 241, 1)' };
}

/**
 * Checks whether the bucket array contains status-family breakdown fields.
 */
function hasStatusBreakdown(buckets: ObsBucket[]): boolean {
	return buckets.length > 0 && buckets[0].count_2xx !== undefined;
}

function hasExactStatusBreakdown(buckets: ObsBucket[]): boolean {
	return buckets.some((bucket) => !!bucket.status_counts && Object.keys(bucket.status_counts).length > 0);
}

/**
 * Updates the chart with new time-series buckets and calls chart.update().
 * When buckets include count_2xx/3xx/4xx/5xx fields, creates 4 stacked datasets.
 * Otherwise falls back to a single "Requests" dataset.
 * Passing an empty array clears the chart.
 */
export function updateObsChart(chart: Chart, buckets: ObsBucket[]): void {
	(chart.data.labels as string[]) = buckets.map((b) => formatBucketLabel(b.bucket));

	if (hasExactStatusBreakdown(buckets)) {
		const statuses = Array.from(
			new Set(
				buckets.flatMap((bucket) => Object.keys(bucket.status_counts ?? {})),
			),
		).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));

		chart.data.datasets = statuses.map((status) => {
			const colors = colorForStatus(status);
			return {
				label: status,
				data: buckets.map((bucket) => bucket.status_counts?.[status] ?? 0),
				backgroundColor: colors.bg,
				borderColor: colors.border,
				borderWidth: 1,
			};
		});
	} else if (hasStatusBreakdown(buckets)) {
		const families = ['2xx', '3xx', '4xx', '5xx'] as const;
		chart.data.datasets = families.map((family) => ({
			label: family,
			data: buckets.map((b) => b[`count_${family}`] ?? 0),
			backgroundColor: STATUS_COLORS[family].bg,
			borderColor: STATUS_COLORS[family].border,
			borderWidth: 1,
		}));
	} else {
		// Single dataset fallback — legacy buckets without breakdown
		chart.data.datasets = [
			{
				label: 'Requests',
				data: buckets.map((b) => b.count),
				backgroundColor: 'rgba(99, 102, 241, 0.6)',
				borderColor: 'rgba(99, 102, 241, 1)',
				borderWidth: 1,
			},
		];
	}

	chart.update();
}
