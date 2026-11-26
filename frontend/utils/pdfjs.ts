/**
 * PDF.js, loaded the first time a PDF is shown.
 *
 * Every PDF preview renders with PDF.js rather than the browser's viewer in an
 * iframe: Android browsers have no viewer and download the file instead, and
 * iOS shows only the first page. The legacy build is used because it carries
 * the polyfills older mobile browsers need. It is a large library, so it stays
 * out of the main bundle until a PDF is opened.
 */

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let loading: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
	loading ??= (async () => {
		const [pdfjs, worker] = await Promise.all([
			import('pdfjs-dist/legacy/build/pdf.mjs'),
			import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
		]);
		pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
		return pdfjs;
	})().catch((error) => {
		// A failed chunk load (offline, a deploy in between) can be retried.
		loading = null;
		throw error;
	});
	return loading;
}

/** Where the data files PDF.js fetches on demand are served (scripts/vite-pdfjs-assets.ts). */
const ASSETS = `${import.meta.env.BASE_URL}vendor/pdfjs/`;

export const PDFJS_DOCUMENT_OPTIONS = {
	cMapUrl: `${ASSETS}cmaps/`,
	cMapPacked: true,
	standardFontDataUrl: `${ASSETS}standard_fonts/`,
	wasmUrl: `${ASSETS}wasm/`,
	iccUrl: `${ASSETS}iccs/`,
	enableXfa: false
} as const;
