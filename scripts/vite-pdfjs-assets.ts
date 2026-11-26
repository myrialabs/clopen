/**
 * Vite plugin: serve PDF.js's data files from `/vendor/pdfjs/`.
 *
 * The PDF viewer renders with PDF.js on every device (browsers' own viewers
 * don't exist on Android and show one page on iOS). PDF.js fetches some files
 * at runtime, only when a document needs them: CMaps for CJK text, the
 * standard fonts for PDFs that don't embed theirs, Wasm image decoders and an
 * ICC profile. They are copied into the build and served from node_modules
 * while developing, so both see the same URLs.
 */

import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';

export const PDFJS_ASSET_PATH = 'vendor/pdfjs';

const FOLDERS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

const TYPES: Record<string, string> = {
	'.bcmap': 'application/octet-stream',
	'.pfb': 'application/octet-stream',
	'.ttf': 'font/ttf',
	'.wasm': 'application/wasm',
	'.js': 'text/javascript',
	'.icc': 'application/vnd.iccprofile'
};

function pdfjsRoot(): string {
	const require = createRequire(import.meta.url);
	return dirname(require.resolve('pdfjs-dist/package.json'));
}

export function pdfjsAssets(): Plugin {
	let outDir = 'dist';
	return {
		name: 'clopen-pdfjs-assets',
		configResolved(config) {
			outDir = config.build.outDir;
		},
		configureServer(server) {
			const root = pdfjsRoot();
			const prefix = `/${PDFJS_ASSET_PATH}/`;
			server.middlewares.use((req, res, next) => {
				const url = req.url?.split('?')[0];
				if (!url?.startsWith(prefix)) return next();
				const relativePath = normalize(decodeURIComponent(url.slice(prefix.length)));
				const folder = relativePath.split(sep)[0];
				if (!FOLDERS.includes(folder) || relativePath.includes('..')) return next();
				const file = join(root, relativePath);
				if (!existsSync(file) || !statSync(file).isFile()) return next();
				res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
				createReadStream(file).pipe(res);
			});
		},
		writeBundle() {
			const root = pdfjsRoot();
			for (const folder of FOLDERS) {
				cpSync(join(root, folder), join(outDir, PDFJS_ASSET_PATH, folder), { recursive: true });
			}
		}
	};
}
