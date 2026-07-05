/**
 * Archive helpers shared by the file tree and compress dialog.
 *
 * Keeps the list of extract-able extensions and produce-able formats in one
 * place so the context menu, extraction naming, and the compress dialog stay in
 * sync with what the backend (`files:zip` / `files:extract`, backed by ZipKit)
 * actually supports.
 */

/** Container format the backend can produce, matching `CreateArchiveOptions`. */
export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'tar.zst' | '7z';

/** ZIP compression methods surfaced in the compress dialog. */
export type ZipMethod = 'store' | 'deflate' | 'zstd';

/**
 * Extensions Clopen offers "Extract Here" for. Compound extensions come first so
 * {@link stripArchiveExtension} strips `.tar.gz` before `.gz`.
 */
export const EXTRACTABLE_EXTENSIONS = [
	'.tar.gz',
	'.tar.zst',
	'.tar.xz',
	'.tar.bz2',
	'.tgz',
	'.tzst',
	'.txz',
	'.tbz2',
	'.tar',
	'.zip',
	'.7z',
	'.gz',
	'.zst',
	'.xz',
	'.bz2'
] as const;

/** Whether a filename looks like an archive Clopen can extract. */
export function isExtractableArchive(name: string): boolean {
	const lower = name.toLowerCase();
	return EXTRACTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Strip a known archive extension from a filename (for naming the output dir). */
export function stripArchiveExtension(name: string): string {
	const lower = name.toLowerCase();
	for (const ext of EXTRACTABLE_EXTENSIONS) {
		if (lower.endsWith(ext)) return name.slice(0, -ext.length);
	}
	return name;
}

/** Formats offered in the compress dialog, with the extension each produces. */
export const ARCHIVE_FORMATS: ReadonlyArray<{ value: ArchiveFormat; label: string; extension: string; encryptable: boolean }> = [
	{ value: 'zip', label: 'ZIP', extension: '.zip', encryptable: true },
	{ value: 'tar.gz', label: 'TAR.GZ', extension: '.tar.gz', encryptable: false },
	{ value: 'tar.zst', label: 'TAR.ZST', extension: '.tar.zst', encryptable: false },
	{ value: 'tar', label: 'TAR', extension: '.tar', encryptable: false },
	{ value: '7z', label: '7Z', extension: '.7z', encryptable: false }
];

/** The file extension produced for a given format. */
export function extensionFor(format: ArchiveFormat): string {
	return ARCHIVE_FORMATS.find((f) => f.value === format)?.extension ?? '.zip';
}
