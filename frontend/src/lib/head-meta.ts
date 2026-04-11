/**
 * Pure function for generating head metadata.
 * Used by BaseLayout.astro to compute SEO/robots meta tags.
 */

export type HeadMetaInput = {
	title: string;
	description?: string;
	canonicalBase: string;
	pathname: string;
	robots?: string;
};

export type HeadMetaOutput = {
	title: string;
	description?: string;
	canonical: string;
	robots: string;
};

export function buildHeadMeta(input: HeadMetaInput): HeadMetaOutput {
	const base = input.canonicalBase.replace(/\/+$/, '');
	const canonical = `${base}${input.pathname}`;

	return {
		title: input.title,
		description: input.description,
		canonical,
		robots: input.robots ?? 'index, follow',
	};
}
