import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

const frontendPort = parseInt(process.env.CLOPEN_PORT_FRONTEND || '9151');
const backendPort = parseInt(process.env.CLOPEN_PORT_BACKEND || '9161');

export default defineConfig({
	plugins: [tailwindcss(), svelte()],
	publicDir: 'static',
	server: {
		port: frontendPort,
		strictPort: false,
		allowedHosts: true,
		proxy: {
			'/api': {
				target: `http://localhost:${backendPort}`,
				changeOrigin: true,
			},
			'/ws': {
				target: `ws://localhost:${backendPort}`,
				ws: true,
			},
		},
	},
	build: {
		outDir: 'dist',
		emptyOutDir: true,
		chunkSizeWarningLimit: 2500,
		rollupOptions: {
			input: {
				main: resolve(__dirname, 'index.html')
			},
			onwarn(warning, defaultHandler) {
				// Suppress mixed dynamic/static import warnings — intentional for circular dep avoidance
				if (warning.message?.includes('dynamic import will not move module')) return;
				// Suppress @__PURE__ annotation warnings from Svelte compiled output
				if (warning.message?.includes('contains an annotation that Rollup cannot interpret')) return;
				defaultHandler(warning);
			}
		}
	},
	resolve: {
		alias: {
			$backend: resolve(__dirname, './backend'),
			$frontend: resolve(__dirname, './frontend'),
			$shared: resolve(__dirname, './shared')
		}
	},
	optimizeDeps: {
		// The Wasm engine locates its .wasm binary relative to `import.meta.url`.
		// Pre-bundling rewrites that URL to the `.vite/deps` cache dir, where the
		// binary doesn't exist — the request 404s to Vite's SPA fallback (index.html)
		// instead of the wasm file. Excluding it keeps `import.meta.url` pointing at
		// its real location in node_modules.
		exclude: ['@myrialabs/zipkit']
	}
});
