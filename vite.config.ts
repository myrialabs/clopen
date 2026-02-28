import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

const frontendPort = parseInt(process.env.PORT_FRONTEND || '9141');
const backendPort = parseInt(process.env.PORT_BACKEND || '9151');

export default defineConfig({
	plugins: [tailwindcss(), svelte()],
	publicDir: 'static',
	server: {
		port: frontendPort,
		strictPort: false,
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
	}
});
