<script lang="ts">
	// Single, shared markdown surface for the whole app. Renders content via renderMarkdown, wires
	// the data-md-* link clicks via dispatchMarkdownClick, and owns the markdown CSS. Visual scale is
	// selected with `variant`; consumers pass only their content and a couple of flags.
	import { onDestroy } from 'svelte';
	import {
		renderMarkdown,
		dispatchMarkdownClick,
		resolveLocalImageSrc
	} from '$frontend/utils/markdown-renderer';
	import { revealFile } from '$frontend/stores/ui/file-peek.svelte';
	import { initMonaco } from '$frontend/components/common/editor/monaco-loader';
	import { getThemeName, registerThemes } from '$frontend/components/common/editor/monaco-themes';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	interface Props {
		content: string;
		// Visual scale: 'chat' (message body), 'preview' (full file view), 'compact' (release notes).
		variant?: 'chat' | 'preview' | 'compact';
		// Raw inline HTML handling — see RenderMarkdownOptions. Default 'sanitize'.
		html?: 'sanitize' | 'escape';
		// Override the internal file-link action (e.g. resolve relative paths in a file preview).
		// Defaults to revealing the path in the Files panel, or a peek modal when it's hidden.
		onFileLink?: (path: string) => void;
		// Extra classes for the root element (layout utilities, etc.).
		class?: string;
	}

	const {
		content,
		variant = 'preview',
		html = 'sanitize',
		onFileLink,
		class: className = ''
	}: Props = $props();

	const rendered = $derived(renderMarkdown(content || '', { html }));

	let root: HTMLElement | null = $state(null);

	function handleClick(event: MouseEvent) {
		// Default file-link action: reveal in the Files panel, or open a peek modal
		// when that panel isn't part of the current layout.
		dispatchMarkdownClick(event, { onFileLink: onFileLink ?? revealFile });
	}

	// --- Local images ---
	// Images that point at a path on the backend's disk carry [data-md-local-src] instead of a src
	// (see resolveLocalImageSrc). Their bytes are read over the file WS API — the same channel the
	// media preview uses — and handed to the <img> as a blob URL, so they render identically for a
	// local browser and for someone viewing the workspace from another device.
	const localImageUrls = new Map<string, string>();
	const localImageLoads = new Map<string, Promise<string | null>>();
	const localImageFailures = new Set<string>();

	function loadLocalImage(path: string): Promise<string | null> {
		const cached = localImageUrls.get(path);
		if (cached) return Promise.resolve(cached);
		const inFlight = localImageLoads.get(path);
		if (inFlight) return inFlight;

		const load = (async () => {
			try {
				const response = await ws.http('files:read-content', { path });
				if (!response.content) return null;
				const binary = atob(response.content);
				const bytes = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				const blob = new Blob([bytes], {
					type: response.contentType || 'application/octet-stream'
				});
				const url = URL.createObjectURL(blob);
				localImageUrls.set(path, url);
				return url;
			} catch (err) {
				debug.error('file', 'Failed to load markdown image:', path, err);
				return null;
			} finally {
				localImageLoads.delete(path);
			}
		})();
		localImageLoads.set(path, load);
		return load;
	}

	$effect(() => {
		void rendered; // re-run when the rendered HTML changes
		const el = root;
		if (!el) return;

		const present = new Set<string>();
		for (const img of Array.from(el.querySelectorAll('img'))) {
			// Sanitized raw <img src="/Users/..."> goes through the same resolution, so inline HTML
			// in a file preview behaves like markdown image syntax.
			const path =
				img.getAttribute('data-md-local-src') || resolveLocalImageSrc(img.getAttribute('src') || '');
			if (!path) continue;
			// Stamp the resolved path so the next pass still recognizes the element after its src
			// has been swapped for a blob URL (matters for the raw-HTML case).
			img.setAttribute('data-md-local-src', path);
			present.add(path);
			// A failed read is remembered so a streaming message doesn't retry it on every chunk.
			if (localImageFailures.has(path)) continue;
			void loadLocalImage(path).then((url) => {
				if (!url) {
					localImageFailures.add(path);
					return;
				}
				if (img.isConnected) img.src = url;
			});
		}

		// Release blobs for images the current content no longer references.
		for (const [path, url] of localImageUrls) {
			if (present.has(path)) continue;
			URL.revokeObjectURL(url);
			localImageUrls.delete(path);
		}
	});

	onDestroy(() => {
		for (const url of localImageUrls.values()) URL.revokeObjectURL(url);
		localImageUrls.clear();
	});

	// Fence language → Monaco language id (aliases Monaco doesn't resolve itself).
	const MONACO_LANG: Record<string, string> = {
		js: 'javascript',
		jsx: 'javascript',
		ts: 'typescript',
		tsx: 'typescript',
		sh: 'shell',
		bash: 'shell',
		zsh: 'shell',
		py: 'python',
		rb: 'ruby',
		yml: 'yaml',
		md: 'markdown',
		rs: 'rust',
		kt: 'kotlin',
		cs: 'csharp',
		golang: 'go'
	};

	// Preview only: syntax-highlight fenced code blocks by reusing Monaco's tokenizer and theme, so
	// the colors match the code editor. Runs after render (colorize is async) and re-runs on theme or
	// content change. Monaco is loaded lazily and only when there is code to highlight.
	$effect(() => {
		if (variant !== 'preview') return;
		void rendered; // re-run when the rendered HTML changes
		const isDark = themeStore.isDark;
		const el = root;
		if (!el) return;

		const blocks = el.querySelectorAll('pre code[class*="language-"]');
		if (blocks.length === 0) return;

		let cancelled = false;
		(async () => {
			const monaco = await initMonaco();
			if (cancelled) return;
			registerThemes(monaco);
			monaco.editor.setTheme(getThemeName(isDark));
			for (const code of blocks) {
				const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
				if (!langClass) continue;
				const raw = langClass.slice('language-'.length);
				const lang = MONACO_LANG[raw] ?? raw;
				try {
					const highlighted = await monaco.editor.colorize(code.textContent ?? '', lang, {});
					if (cancelled) return;
					code.innerHTML = highlighted;
				} catch {
					/* leave the plain escaped code as-is */
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div bind:this={root} class={`markdown markdown-${variant} ${className}`} onclick={handleClick}>
	{@html rendered}
</div>

<style>
	/* ============================== chat variant ============================== */
	:global(.markdown-chat) {
		color: rgb(30 41 59);
		line-height: 1.5;
	}
	:global(.dark .markdown-chat) {
		color: rgb(226 232 240);
	}
	:global(.markdown-chat *:first-child) {
		margin-top: 0;
	}
	:global(.markdown-chat *:last-child) {
		margin-bottom: 0;
	}
	:global(.markdown-chat h1) {
		font-size: 1.5rem;
		font-weight: 700;
		margin-top: 1.5rem;
		margin-bottom: 1rem;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-chat h1) {
		color: rgb(241 245 249);
	}
	:global(.markdown-chat h2) {
		font-size: 1.25rem;
		font-weight: 700;
		margin-top: 1.25rem;
		margin-bottom: 0.75rem;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-chat h2) {
		color: rgb(241 245 249);
	}
	:global(.markdown-chat h3) {
		font-size: 1.125rem;
		font-weight: 700;
		margin-top: 1rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-chat h3) {
		color: rgb(241 245 249);
	}
	:global(.markdown-chat h4),
	:global(.markdown-chat h5),
	:global(.markdown-chat h6) {
		font-size: 1rem;
		font-weight: 700;
		margin-top: 0.75rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-chat h4),
	:global(.dark .markdown-chat h5),
	:global(.dark .markdown-chat h6) {
		color: rgb(241 245 249);
	}
	:global(.markdown-chat p) {
		margin-bottom: 1rem;
		line-height: 1.5;
	}
	:global(.markdown-chat a) {
		color: rgb(37 99 235);
		text-decoration: underline;
	}
	:global(.dark .markdown-chat a) {
		color: rgb(96 165 250);
	}
	:global(.markdown-chat a:hover) {
		color: rgb(29 78 216);
	}
	:global(.dark .markdown-chat a:hover) {
		color: rgb(147 197 253);
	}
	/* Internal file links (reveal in Files panel) — allow long absolute paths to wrap */
	:global(.markdown-chat a[data-md-file]) {
		cursor: pointer;
		word-break: break-all;
	}
	:global(.markdown-chat code) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		font-family: monospace;
		font-size: 0.875rem;
	}
	:global(.dark .markdown-chat code) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}
	:global(.markdown-chat pre) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.5rem 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin: 1rem 0;
		border: 1px solid rgb(226 232 240);
	}
	:global(.dark .markdown-chat pre) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
		border-color: rgb(51 65 85);
	}
	:global(.markdown-chat pre code) {
		background-color: transparent;
		padding: 0;
		border-radius: 0;
		border: 0;
		color: inherit;
	}
	:global(.markdown-chat strong) {
		font-weight: 700;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-chat strong) {
		color: rgb(241 245 249);
	}
	:global(.markdown-chat em) {
		font-style: italic;
		color: rgb(51 65 85);
	}
	:global(.dark .markdown-chat em) {
		color: rgb(203 213 225);
	}
	:global(.markdown-chat blockquote) {
		border-left: 0.25rem solid rgb(203 213 225);
		padding-left: 1rem;
		font-style: italic;
		color: rgb(100 116 139);
		margin: 1rem 0;
	}
	:global(.dark .markdown-chat blockquote) {
		border-left-color: rgb(100 116 139);
		color: rgb(148 163 184);
	}
	:global(.markdown-chat ul) {
		list-style-type: disc;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}
	:global(.markdown-chat ol) {
		list-style-type: decimal;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}
	:global(.markdown-chat li) {
		margin-bottom: 0.25rem;
	}
	:global(.markdown-chat hr) {
		border-color: rgb(226 232 240);
		margin: 1.5rem 0;
	}
	:global(.dark .markdown-chat hr) {
		border-color: rgb(51 65 85);
	}
	:global(.markdown-chat .table-responsive) {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		margin: 1rem 0;
		border-radius: 0.5rem;
		border: 1px solid rgb(226 232 240);
		scrollbar-width: thin;
		scrollbar-color: rgb(139 92 246 / 0.2) transparent;
	}
	:global(.dark .markdown-chat .table-responsive) {
		border-color: rgb(51 65 85);
	}
	:global(.markdown-chat .table-responsive::-webkit-scrollbar) {
		height: 0.375rem;
	}
	:global(.markdown-chat .table-responsive::-webkit-scrollbar-track) {
		background: transparent;
	}
	:global(.markdown-chat .table-responsive::-webkit-scrollbar-thumb) {
		background: rgb(139 92 246 / 0.2);
		border-radius: 0.25rem;
	}
	:global(.markdown-chat .table-responsive::-webkit-scrollbar-thumb:hover) {
		background: rgb(139 92 246 / 0.4);
	}
	:global(.markdown-chat table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	:global(.markdown-chat th),
	:global(.markdown-chat td) {
		border: 1px solid rgb(226 232 240);
		padding: 0.5rem 0.75rem;
		white-space: nowrap;
	}
	:global(.dark .markdown-chat th),
	:global(.dark .markdown-chat td) {
		border-color: rgb(51 65 85);
	}
	:global(.markdown-chat th) {
		background-color: rgb(248 250 252);
		font-weight: 600;
		text-align: left;
		color: rgb(51 65 85);
	}
	:global(.dark .markdown-chat th) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}
	:global(.markdown-chat tbody tr:nth-child(even)) {
		background-color: rgb(248 250 252);
	}
	:global(.dark .markdown-chat tbody tr:nth-child(even)) {
		background-color: rgb(30 41 59 / 0.5);
	}
	:global(.markdown-chat img) {
		max-width: 100%;
		height: auto;
		border-radius: 0.25rem;
		margin: 1rem 0;
	}

	/* ============================ preview variant ============================ */
	:global(.markdown-preview) {
		color: rgb(30 41 59);
		line-height: 1.6;
		font-size: 0.9rem;
	}
	:global(.dark .markdown-preview) {
		color: rgb(226 232 240);
	}
	:global(.markdown-preview *:first-child) {
		margin-top: 0;
	}
	:global(.markdown-preview *:last-child) {
		margin-bottom: 0;
	}
	:global(.markdown-preview h1) {
		font-size: 1.875rem;
		font-weight: 700;
		margin-top: 1.5rem;
		margin-bottom: 1rem;
		padding-bottom: 0.4rem;
		border-bottom: 1px solid rgb(226 232 240);
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-preview h1) {
		color: rgb(241 245 249);
		border-bottom-color: rgb(51 65 85);
	}
	:global(.markdown-preview h2) {
		font-size: 1.5rem;
		font-weight: 700;
		margin-top: 1.5rem;
		margin-bottom: 0.75rem;
		padding-bottom: 0.3rem;
		border-bottom: 1px solid rgb(226 232 240);
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-preview h2) {
		color: rgb(241 245 249);
		border-bottom-color: rgb(51 65 85);
	}
	:global(.markdown-preview h3) {
		font-size: 1.25rem;
		font-weight: 700;
		margin-top: 1.25rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-preview h3) {
		color: rgb(241 245 249);
	}
	:global(.markdown-preview h4),
	:global(.markdown-preview h5),
	:global(.markdown-preview h6) {
		font-size: 1rem;
		font-weight: 700;
		margin-top: 1rem;
		margin-bottom: 0.5rem;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-preview h4),
	:global(.dark .markdown-preview h5),
	:global(.dark .markdown-preview h6) {
		color: rgb(241 245 249);
	}
	:global(.markdown-preview p) {
		margin-bottom: 1rem;
	}
	:global(.markdown-preview a) {
		color: rgb(37 99 235);
		text-decoration: underline;
	}
	:global(.dark .markdown-preview a) {
		color: rgb(96 165 250);
	}
	:global(.markdown-preview a:hover) {
		color: rgb(29 78 216);
	}
	:global(.dark .markdown-preview a:hover) {
		color: rgb(147 197 253);
	}
	:global(.markdown-preview a[data-md-file]) {
		cursor: pointer;
		word-break: break-all;
	}
	:global(.markdown-preview code) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.125rem 0.375rem;
		border-radius: 0.25rem;
		font-family: 'SF Mono', Monaco, Consolas, monospace;
		font-size: 0.85em;
	}
	:global(.dark .markdown-preview code) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}
	:global(.markdown-preview pre) {
		background-color: rgb(248 250 252);
		color: rgb(51 65 85);
		padding: 0.75rem 1rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		margin: 1rem 0;
		border: 1px solid rgb(226 232 240);
		font-size: 0.85rem;
	}
	:global(.dark .markdown-preview pre) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
		border-color: rgb(51 65 85);
	}
	:global(.markdown-preview pre code) {
		background-color: transparent;
		padding: 0;
		border-radius: 0;
		color: inherit;
	}
	:global(.markdown-preview strong) {
		font-weight: 700;
		color: rgb(15 23 42);
	}
	:global(.dark .markdown-preview strong) {
		color: rgb(241 245 249);
	}
	:global(.markdown-preview em) {
		font-style: italic;
	}
	:global(.markdown-preview blockquote) {
		border-left: 0.25rem solid rgb(203 213 225);
		padding-left: 1rem;
		color: rgb(100 116 139);
		margin: 1rem 0;
	}
	:global(.dark .markdown-preview blockquote) {
		border-left-color: rgb(100 116 139);
		color: rgb(148 163 184);
	}
	:global(.markdown-preview ul) {
		list-style-type: disc;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}
	:global(.markdown-preview ol) {
		list-style-type: decimal;
		margin-left: 1.5rem;
		margin-bottom: 1rem;
	}
	:global(.markdown-preview li) {
		margin-bottom: 0.25rem;
	}
	:global(.markdown-preview li > ul),
	:global(.markdown-preview li > ol) {
		margin-bottom: 0.25rem;
	}
	:global(.markdown-preview hr) {
		border: 0;
		border-top: 3px solid rgb(226 232 240);
		margin: 1.5rem 0;
	}
	:global(.dark .markdown-preview hr) {
		border-top-color: rgb(51 65 85);
	}
	:global(.markdown-preview .table-responsive) {
		overflow-x: auto;
		margin: 1rem 0;
		border-radius: 0.5rem;
		border: 1px solid rgb(226 232 240);
	}
	:global(.dark .markdown-preview .table-responsive) {
		border-color: rgb(51 65 85);
	}
	:global(.markdown-preview table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}
	:global(.markdown-preview th),
	:global(.markdown-preview td) {
		border: 1px solid rgb(226 232 240);
		padding: 0.5rem 0.75rem;
	}
	:global(.dark .markdown-preview th),
	:global(.dark .markdown-preview td) {
		border-color: rgb(51 65 85);
	}
	:global(.markdown-preview th) {
		background-color: rgb(248 250 252);
		font-weight: 600;
		text-align: left;
		color: rgb(51 65 85);
	}
	:global(.dark .markdown-preview th) {
		background-color: rgb(30 41 59);
		color: rgb(203 213 225);
	}
	:global(.markdown-preview tbody tr:nth-child(even)) {
		background-color: rgb(248 250 252);
	}
	:global(.dark .markdown-preview tbody tr:nth-child(even)) {
		background-color: rgb(30 41 59 / 0.5);
	}
	:global(.markdown-preview img) {
		display: initial;
		max-width: 100%;
		height: auto;
		border-radius: 0.25rem;
		margin: 1rem 0;
	}
	:global(.markdown-preview input[type='checkbox']) {
		margin-right: 0.4rem;
	}

	/* ============================ compact variant ============================ */
	:global(.markdown-compact) {
		font-size: 0.75rem;
		line-height: 1.625;
		color: rgb(51 65 85);
	}
	:global(.dark .markdown-compact) {
		color: rgb(203 213 225);
	}
	:global(.markdown-compact h1),
	:global(.markdown-compact h2),
	:global(.markdown-compact h3) {
		font-weight: 600;
		margin-top: 0.75rem;
		margin-bottom: 0.375rem;
		font-size: inherit;
	}
	:global(.markdown-compact h1) {
		font-size: 1rem;
	}
	:global(.markdown-compact h2) {
		font-size: 0.875rem;
	}
	:global(.markdown-compact h3) {
		font-size: 0.8125rem;
	}
	:global(.markdown-compact ul),
	:global(.markdown-compact ol) {
		padding-left: 1.25rem;
		margin-top: 0.25rem;
		margin-bottom: 0.25rem;
		list-style-position: outside;
	}
	:global(.markdown-compact ul) {
		list-style-type: disc;
	}
	:global(.markdown-compact ol) {
		list-style-type: decimal;
	}
	:global(.markdown-compact li) {
		margin-bottom: 0.125rem;
	}
	:global(.markdown-compact p) {
		margin-top: 0.375rem;
		margin-bottom: 0.375rem;
	}
	:global(.markdown-compact code) {
		font-size: 0.75rem;
		padding: 0.125rem 0.25rem;
		border-radius: 0.25rem;
		background: rgb(148 163 184 / 0.15);
	}
	:global(.markdown-compact pre) {
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
		padding: 0.75rem;
		border-radius: 0.5rem;
		overflow-x: auto;
		background: rgb(148 163 184 / 0.1);
	}
	:global(.markdown-compact pre code) {
		padding: 0;
		background: none;
	}
	:global(.markdown-compact a) {
		color: rgb(139 92 246);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	:global(.markdown-compact a:hover) {
		color: rgb(124 58 237);
	}
	:global(.markdown-compact blockquote) {
		border-left: 2px solid rgb(148 163 184 / 0.3);
		padding-left: 0.75rem;
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
		color: rgb(100 116 139);
	}
	:global(.markdown-compact hr) {
		margin-top: 0.75rem;
		margin-bottom: 0.75rem;
		border-color: rgb(148 163 184 / 0.2);
	}
	:global(.markdown-compact img) {
		max-width: 100%;
		border-radius: 0.5rem;
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
	}
	:global(.markdown-compact .table-responsive) {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		margin-top: 0.5rem;
		margin-bottom: 0.5rem;
	}
	:global(.markdown-compact table) {
		width: 100%;
		border-collapse: collapse;
	}
	:global(.markdown-compact th),
	:global(.markdown-compact td) {
		padding: 0.375rem 0.5rem;
		border: 1px solid rgb(148 163 184 / 0.2);
		text-align: left;
	}
</style>
