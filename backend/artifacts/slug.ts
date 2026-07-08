/**
 * Slug helpers shared by the single-md artifact features. A slug is the machine
 * id that matches the on-disk file name and the frontmatter `name`: lowercase
 * ASCII alphanumerics and single hyphens, capped at 64.
 */

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
	return NAME_RE.test(slug) && slug.length <= 64;
}

/** Normalise an arbitrary string into a valid slug. */
export function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-')
		.slice(0, 64)
		.replace(/-+$/g, '');
	return slug || 'item';
}

/** Derive a slug that doesn't collide, using `exists` to probe taken slugs. */
export function uniqueSlug(base: string, exists: (slug: string) => boolean): string {
	const root = slugify(base);
	if (!exists(root)) return root;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${root}-${i}`.slice(0, 64).replace(/-+$/g, '');
		if (!exists(candidate)) return candidate;
	}
	return slugify(`${root}-${String(root.length)}-x`);
}
