<script lang="ts">
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { notesState, currentNote, createNote, updateNote, deleteNote, uploadNoteImage, deleteNoteImage } from '$frontend/stores/features/notes.svelte';
	import NoteToolbar from './NoteToolbar.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { debug } from '$shared/utils/logger';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { getNoteImageUrl } from '$frontend/stores/features/notes.svelte';
	import { untrack } from 'svelte';
	import DOMPurify from 'dompurify';

	let title = $state('');
	let content = $state('');
	let isSaving = $state(false);
	let isDragging = $state(false);
	let editorEl: HTMLDivElement | null = $state(null);
	let fileInputEl: HTMLInputElement | null = $state(null);

	interface PendingImage {
		id: string;
		file: File;
		name: string;
		previewUrl: string;
		size: number;
	}

	let pendingImages: PendingImage[] = $state([]);

	// In-flight background uploads keyed by pending image id.
	const pendingUploads = new Map<string, Promise<void>>();

	const selectedNote = $derived(currentNote.value);
	const isEditing = $derived(!!selectedNote);

	const SANITIZE_ADD_TAGS = ['u'];
	const SANITIZE_ADD_ATTR = ['data-pending-id', 'data-image-id'];
	const PERM_IMAGE_RE = /\/api\/notes\/images\/([A-Za-z0-9-]+)/;

	function sanitizeHtml(dirty: string): string {
		return DOMPurify.sanitize(dirty || '', {
			ADD_TAGS: SANITIZE_ADD_TAGS,
			ADD_ATTR: SANITIZE_ADD_ATTR,
			ALLOW_DATA_ATTR: true
		} as any) as unknown as string;
	}

	/**
	 * Convert display HTML into persistable HTML.
	 * Permanent storage must never contain temporary blob:/data: URLs or
	 * expiring ?token= credentials — images are referenced by stable
	 * `/api/notes/images/<id>` paths with a `data-image-id` attribute.
	 */
	function toStoredHtml(displayHtml: string): string {
		const host = document.createElement('div');
		host.innerHTML = sanitizeHtml(displayHtml);
		for (const node of host.querySelectorAll('img')) {
			const el = node as HTMLImageElement;
			const src = el.getAttribute('src') || '';
			if (src.startsWith('blob:') || src.startsWith('data:')) {
				el.remove();
				continue;
			}
			const m = src.match(PERM_IMAGE_RE);
			if (m) {
				if (!el.getAttribute('data-image-id')) el.setAttribute('data-image-id', m[1]);
				el.setAttribute('src', `/api/notes/images/${m[1]}`);
			} else if (!src) {
				el.remove();
			}
		}
		return host.innerHTML;
	}

	/**
	 * Convert stored HTML into display HTML: drop unrecoverable blob: refs
	 * left by older versions and attach a fresh auth token to each image.
	 */
	function hydrateToDisplay(storedHtml: string): string {
		const host = document.createElement('div');
		host.innerHTML = sanitizeHtml(storedHtml);
		for (const node of host.querySelectorAll('img')) {
			const el = node as HTMLImageElement;
			const src = el.getAttribute('src') || '';
			if (src.startsWith('blob:') || src.startsWith('data:')) {
				el.remove();
				continue;
			}
			const m = src.match(PERM_IMAGE_RE);
			if (m) {
				const id = el.getAttribute('data-image-id') || m[1];
				el.setAttribute('data-image-id', id);
				el.setAttribute('src', getNoteImageUrl(id));
			}
		}
		return host.innerHTML;
	}

	let lastNoteId: string | null = null;
	// Sync editor DOM only when switching notes (keyed by id). Never clobber
	// the editor on unrelated store updates (e.g. background image uploads)
	// or while a save is in progress.
	$effect(() => {
		const note = selectedNote;
		const el = editorEl;
		const saving = isSaving;
		const noteId = note?.id ?? null;
		if (saving) return;
		if (noteId === lastNoteId) return;
		lastNoteId = noteId;
		untrack(() => {
			if (note) {
				title = note.title ?? '';
				content = note.content ?? '';
			} else {
				title = '';
				content = '';
			}
			if (pendingImages.length > 0) {
				for (const p of pendingImages) URL.revokeObjectURL(p.previewUrl);
				pendingImages = [];
			}
			pendingUploads.clear();
			if (el) {
				const shown = hydrateToDisplay(note?.content ?? '');
				if (el.innerHTML !== shown) el.innerHTML = shown;
			}
		});
	});

	// Clear image selection when clicking outside editor
	$effect(() => {
		const el = editorEl;
		if (!el) return;
		const handler = (e: MouseEvent) => {
			if (!el.contains(e.target as Node)) {
				clearImageSelection();
				closeImageContextMenu();
			} else if ((e.target as HTMLElement).tagName !== 'IMG') {
				// Clicked inside editor but not on image - keep selection? clear context menu
				closeImageContextMenu();
			}
		};
		document.addEventListener('click', handler);
		return () => document.removeEventListener('click', handler);
	});

	// Keep content in sync when user types in contenteditable
	function handleEditorInput(): void {
		if (editorEl) content = editorEl.innerHTML;
	}

	const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
	const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

	let selectedImageEl: HTMLImageElement | null = $state(null);
	let selectedImagePendingId: string | null = $state(null);
	let selectedImageId: string | null = $state(null);
	let imageContextMenu: { x: number; y: number; target: HTMLImageElement } | null = $state(null);
	let imageOverlayPos: { x: number; y: number } | null = $state(null);

	function updateImageOverlayPos(): void {
		if (!selectedImageEl || !editorEl) {
			imageOverlayPos = null;
			return;
		}
		const editorRect = editorEl.parentElement?.getBoundingClientRect();
		const imgRect = selectedImageEl.getBoundingClientRect();
		if (!editorRect) {
			imageOverlayPos = null;
			return;
		}
		// Position delete button at top-right of image, inset 4px, adjusted to wrapper
		imageOverlayPos = {
			x: imgRect.right - editorRect.left - 28,
			y: imgRect.top - editorRect.top + 4
		};
	}

	function clearImageSelection(): void {
		if (selectedImageEl) selectedImageEl.classList.remove('ring-2', 'ring-violet-500');
		selectedImageEl = null;
		selectedImagePendingId = null;
		selectedImageId = null;
		imageOverlayPos = null;
	}

	function handleImageContextMenu(e: MouseEvent): void {
		const target = e.target as HTMLElement;
		if (target.tagName === 'IMG' && editorEl?.contains(target)) {
			e.preventDefault();
			imageContextMenu = { x: e.clientX, y: e.clientY, target: target as HTMLImageElement };
			// Also select the image
			if (selectedImageEl) selectedImageEl.classList.remove('ring-2', 'ring-violet-500');
			selectedImageEl = target as HTMLImageElement;
			selectedImageEl.classList.add('ring-2', 'ring-violet-500');
			selectedImagePendingId = selectedImageEl.getAttribute('data-pending-id');
			selectedImageId = selectedImageEl.getAttribute('data-image-id');
			if (!selectedImageId) {
				const src = selectedImageEl.getAttribute('src') || '';
				const m = src.match(/\/api\/notes\/images\/([^?]+)/);
				if (m) selectedImageId = m[1];
			}
			updateImageOverlayPos();
		} else {
			imageContextMenu = null;
		}
	}

	function closeImageContextMenu(): void {
		imageContextMenu = null;
	}

	function setImageSize(size: 'small' | 'medium' | 'large' | 'full' | 'original'): void {
		if (!imageContextMenu?.target) return;
		const img = imageContextMenu.target;
		// Reset
		img.style.width = '';
		img.style.maxWidth = '';
		img.style.height = 'auto';
		switch (size) {
			case 'small':
				img.style.maxWidth = '200px';
				img.style.width = '200px';
				break;
			case 'medium':
				img.style.maxWidth = '400px';
				img.style.width = 'auto';
				break;
			case 'large':
				img.style.maxWidth = '600px';
				img.style.width = 'auto';
				break;
			case 'full':
				img.style.maxWidth = '100%';
				img.style.width = '100%';
				break;
			case 'original':
				img.style.maxWidth = 'none';
				img.style.width = 'auto';
				break;
		}
		if (editorEl) content = editorEl.innerHTML;
		imageContextMenu = null;
	}

	function handleEditorClick(e: MouseEvent): void {
		const target = e.target as HTMLElement;
		closeImageContextMenu();
		if (target.tagName === 'IMG') {
			e.preventDefault();
			if (selectedImageEl) selectedImageEl.classList.remove('ring-2', 'ring-violet-500');
			selectedImageEl = target as HTMLImageElement;
			selectedImageEl.classList.add('ring-2', 'ring-violet-500');
			selectedImagePendingId = selectedImageEl.getAttribute('data-pending-id');
			selectedImageId = selectedImageEl.getAttribute('data-image-id') || (() => {
				const src = selectedImageEl?.getAttribute('src') || '';
				const m = src.match(/\/api\/notes\/images\/([^?]+)/);
				return m ? m[1] : null;
			})();
			if (!selectedImageId && !selectedImagePendingId) {
				const src = selectedImageEl.src;
				const m = src.match(/\/api\/notes\/images\/([^?/]+)/);
				if (m) selectedImageId = m[1];
			}
			updateImageOverlayPos();
		} else {
			clearImageSelection();
		}
	}

	function handleEditorKeydown(e: KeyboardEvent): void {
		if ((e.key === 'Delete' || e.key === 'Backspace') && selectedImageEl) {
			e.preventDefault();
			handleDeleteSelectedImage();
		} else if (e.key === 'Escape') {
			clearImageSelection();
		}
	}

	function handleDeleteSelectedImage(): void {
		if (!selectedImageEl) return;
		if (selectedImagePendingId) {
			const id = selectedImagePendingId;
			removePending(id);
		} else if (selectedImageId) {
			void handleDeleteImage(selectedImageId);
		} else {
			// Fallback: just remove the element
			selectedImageEl.remove();
			if (editorEl) content = editorEl.innerHTML;
		}
		clearImageSelection();
	}

	function insertImageAtCursor(previewUrl: string, pendingId: string, fileName: string): void {
		if (!editorEl) {
			content = content + `<p><img src="${previewUrl}" data-pending-id="${pendingId}" alt="${fileName}" style="max-width:400px;width:auto;height:auto;max-height:380px;object-fit:contain;display:block;border-radius:6px;margin:8px 0;cursor:pointer;" title="Right-click for size options, click to select" /></p>`;
			return;
		}
		editorEl.focus();
		const imgHtml = `<img src="${previewUrl}" data-pending-id="${pendingId}" alt="${fileName}" style="max-width:400px;width:auto;height:auto;max-height:380px;object-fit:contain;display:block;border-radius:6px;margin:8px 0;cursor:pointer;" title="Right-click for size options, click to select" />`;
		try {
			document.execCommand('insertHTML', false, imgHtml);
			content = editorEl.innerHTML;
		} catch {
			editorEl.innerHTML += imgHtml;
			content = editorEl.innerHTML;
		}
		const sel = window.getSelection();
		if (sel && editorEl) {
			sel.removeAllRanges();
			const range = document.createRange();
			range.selectNodeContents(editorEl);
			range.collapse(false);
			sel.addRange(range);
		}
	}

	async function uploadPending(pendingId: string, noteId: string): Promise<void> {
		const running = pendingUploads.get(pendingId);
		if (running) return running;
		const item = pendingImages.find((p) => p.id === pendingId);
		if (!item) return;
		const task = (async (): Promise<void> => {
			const { image } = await uploadNoteImage(noteId, item.file);
			const img = editorEl?.querySelector(`img[data-pending-id="${pendingId}"]`) as HTMLImageElement | null;
			if (img) {
				img.src = getNoteImageUrl(image.id);
				img.removeAttribute('data-pending-id');
				img.setAttribute('data-image-id', image.id);
				content = toStoredHtml(editorEl?.innerHTML ?? '');
			}
			URL.revokeObjectURL(item.previewUrl);
			pendingImages = pendingImages.filter((p) => p.id !== pendingId);
		})();
		pendingUploads.set(pendingId, task);
		try {
			await task;
		} finally {
			pendingUploads.delete(pendingId);
		}
	}

	async function processFiles(files: FileList | File[]): Promise<void> {
		const arr = Array.from(files);
		const targetNoteId = selectedNote?.id ?? null;
		for (const file of arr) {
			if (file.size > MAX_IMAGE_SIZE) {
				addNotification({ type: 'error', title: 'File Too Large', message: `${file.name} exceeds 10MB`, duration: 3000 });
				continue;
			}
			if (!ALLOWED_TYPES.has(file.type)) {
				addNotification({ type: 'error', title: 'Unsupported Type', message: `${file.name} is not supported (jpg/png/gif/webp only)`, duration: 3000 });
				continue;
			}
			const id = crypto.randomUUID();
			const previewUrl = URL.createObjectURL(file);
			pendingImages = [...pendingImages, { id, file, name: file.name, previewUrl, size: file.size }];
			insertImageAtCursor(previewUrl, id, file.name);
			// Upload immediately in the background so the editor swaps the
			// temporary blob preview for a permanent URL without waiting for Save.
			if (targetNoteId) {
				void uploadPending(id, targetNoteId).catch((error) => {
					debug.error('notes', 'Image upload failed:', error);
					const reason = error instanceof Error && error.message ? `: ${error.message}` : '';
					addNotification({ type: 'error', title: 'Upload Failed', message: `Failed to upload ${file.name}${reason}`, duration: 4000 });
				});
			}
		}
	}

	function removePending(id: string): void {
		const item = pendingImages.find((p) => p.id === id);
		if (item) URL.revokeObjectURL(item.previewUrl);
		pendingImages = pendingImages.filter((p) => p.id !== id);
		if (editorEl) {
			const img = editorEl.querySelector(`img[data-pending-id="${id}"]`) as HTMLImageElement | null;
			if (img) img.remove();
			content = editorEl.innerHTML;
		}
	}

	function handleDragOver(e: DragEvent): void {
		e.preventDefault();
		isDragging = true;
	}
	function handleDragLeave(e: DragEvent): void {
		e.preventDefault();
		isDragging = false;
	}
	async function handleDrop(e: DragEvent): Promise<void> {
		e.preventDefault();
		isDragging = false;
		if (e.dataTransfer?.files?.length) await processFiles(e.dataTransfer.files);
	}
	async function handlePaste(e: ClipboardEvent): Promise<void> {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (let i = 0; i < items.length; i++) {
			if (items[i].kind === 'file') {
				const f = items[i].getAsFile();
				if (f) files.push(f);
			}
		}
		if (files.length > 0) {
			e.preventDefault();
			await processFiles(files);
		}
	}
	function handleFileInputChange(e: Event): void {
		const input = e.target as HTMLInputElement;
		if (input.files?.length) void processFiles(input.files);
		input.value = '';
	}

	async function handleSave(): Promise<void> {
		const projectId = projectState.currentProject?.id;
		if (!projectId) {
			addNotification({ type: 'error', title: 'No Project', message: 'Select a project first', duration: 3000 });
			return;
		}
		// Get latest HTML from editor (display HTML: may hold blob previews + tokenized URLs)
		const displayHtml = sanitizeHtml(editorEl ? editorEl.innerHTML : content);
		// Check empty (strip tags); images also count as content
		const textOnly = displayHtml.replace(/<[^>]*>/g, '').trim();
		const editorHasImage = editorEl ? !!editorEl.querySelector('img') : false;
		if (!textOnly && !title.trim() && !editorHasImage && pendingImages.length === 0) {
			addNotification({ type: 'warning', title: 'Empty Note', message: 'Add title or content', duration: 3000 });
			return;
		}
		isSaving = true;
		try {
			let noteId = selectedNote?.id ?? null;
			if (!noteId) {
				// Never persist temporary blob previews: strip them for the initial create.
				const created = await createNote(projectId, title || null, toStoredHtml(displayHtml));
				noteId = created?.id ?? null;
			}
			if (!noteId) throw new Error('Failed to save note');

			// Upload anything still pending (e.g. pasted before any note existed),
			// then wait for background uploads so no blob: URL is ever persisted.
			if (pendingImages.length > 0) {
				for (const p of [...pendingImages]) {
					try {
						await uploadPending(p.id, noteId);
					} catch (error) {
						debug.error('notes', 'Image upload failed:', error);
						const reason = error instanceof Error && error.message ? `: ${error.message}` : '';
						addNotification({ type: 'error', title: 'Upload Failed', message: `Failed to upload ${p.name}${reason}`, duration: 4000 });
					}
				}
			}
			await Promise.allSettled([...pendingUploads.values()]);

			const finalStored = editorEl ? toStoredHtml(editorEl.innerHTML) : toStoredHtml(displayHtml);
			content = finalStored;
			await updateNote(noteId, { title: title || null, content: finalStored });
			if (editorEl && pendingImages.length === 0 && selectedNote?.id === noteId) {
				// Show canonical display HTML (fresh tokens); keep the editor
				// untouched when failed previews remain so the user can retry,
				// or when the user switched to another note mid-save.
				const shown = hydrateToDisplay(finalStored);
				if (editorEl.innerHTML !== shown) editorEl.innerHTML = shown;
			}
			addNotification({ type: 'success', title: 'Saved', message: 'Note saved', duration: 2000 });
		} catch (error) {
			debug.error('notes', 'Save failed:', error);
			addNotification({ type: 'error', title: 'Save Failed', message: error instanceof Error ? error.message : String(error), duration: 3000 });
		} finally {
			isSaving = false;
		}
	}

	async function handleDelete(): Promise<void> {
		if (!selectedNote) return;
		if (!confirm('Delete this note?')) return;
		try {
			await deleteNote(selectedNote.id);
			pendingImages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
			pendingImages = [];
			pendingUploads.clear();
			title = '';
			content = '';
			if (editorEl) editorEl.innerHTML = '';
		} catch (error) {
			addNotification({ type: 'error', title: 'Delete Failed', message: String(error), duration: 3000 });
		}
	}

	function handleCancel(): void {
		pendingImages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
		pendingImages = [];
		pendingUploads.clear();
		if (selectedNote) {
			title = selectedNote.title ?? '';
			const html = selectedNote.content ?? '';
			content = html;
			if (editorEl) editorEl.innerHTML = hydrateToDisplay(html);
		} else {
			title = '';
			content = '';
			if (editorEl) editorEl.innerHTML = '';
		}
	}

	async function handleDeleteImage(imageId: string): Promise<void> {
		if (!selectedNote) return;
		try {
			await deleteNoteImage(imageId, selectedNote.id);
			if (editorEl) {
				const img = editorEl.querySelector(`img[data-image-id="${imageId}"], img[src*="${imageId}"]`) as HTMLImageElement | null;
				if (img) img.remove();
				content = toStoredHtml(editorEl.innerHTML);
				await updateNote(selectedNote.id, { content });
			}
		} catch (error) {
			addNotification({ type: 'error', title: 'Failed', message: String(error), duration: 3000 });
		}
	}

	const hasProject = $derived(!!projectState.currentProject);
</script>

<div class="flex flex-col h-full bg-white dark:bg-slate-900">
	{#if !hasProject}
		<div class="flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400 text-sm p-6">
			<Icon name="lucide:sticky-note" class="w-10 h-10 opacity-30" />
			<span>Select a project to create notes</span>
		</div>
	{:else}
		<div class="flex-1 overflow-auto flex flex-col bg-white dark:bg-slate-900">
			<input bind:this={fileInputEl} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple onchange={handleFileInputChange} class="hidden" />
			<input
				type="text"
				bind:value={title}
				placeholder="Title"
				aria-label="Note title"
				autocomplete="off"
				spellcheck="false"
				class="w-full px-4 py-3 text-base font-semibold bg-transparent outline-none border-b border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 placeholder:font-normal shrink-0"
			/>
			<NoteToolbar editor={editorEl} onUploadClick={() => fileInputEl?.click()} />

			<!-- WYSIWYG Editor - drag & drop directly on board -->
			<div class="relative flex-1 flex flex-col min-h-[260px] overflow-hidden">
				<div
					bind:this={editorEl}
					contenteditable="true"
					spellcheck="false"
					role="textbox"
					aria-multiline="true"
					data-placeholder="Write your note... Use the toolbar for formatting."
					class="flex-1 w-full p-4 text-sm leading-relaxed bg-transparent outline-none overflow-auto prose prose-sm dark:prose-invert max-w-none
						focus:outline-none {isDragging ? 'ring-2 ring-violet-500/50 bg-violet-50/30 dark:bg-violet-950/20' : ''}
						[&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-slate-400 [&:empty:before]:pointer-events-none
						prose-headings:font-semibold prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
						prose-p:my-2 prose-ul:list-disc prose-ol:list-decimal prose-li:my-1
						prose-a:text-violet-600 dark:prose-a:text-violet-400 prose-a:underline
						prose-code:bg-slate-100 dark:prose-code:bg-slate-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono
						prose-pre:bg-slate-100 dark:prose-pre:bg-slate-800 prose-pre:p-3 prose-pre:rounded-lg prose-pre:overflow-auto
						prose-img:rounded-lg prose-img:my-2 prose-img:max-w-full prose-img:cursor-pointer hover:prose-img:ring-2 hover:prose-img:ring-violet-400"
					oninput={handleEditorInput}
					onclick={handleEditorClick}
					onkeydown={handleEditorKeydown}
					oncontextmenu={handleImageContextMenu}
					onpaste={handlePaste}
					ondragover={handleDragOver}
					ondragleave={handleDragLeave}
					ondrop={handleDrop}
				></div>
				{#if selectedImageEl}
					<div class="absolute bottom-2 right-2 flex items-center gap-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg px-2 py-1.5">
						<span class="text-xs text-slate-500 dark:text-slate-400">Image selected</span>
						<button type="button" onclick={handleDeleteSelectedImage} class="px-2.5 py-1 text-xs font-medium rounded-md bg-red-600 hover:bg-red-700 text-white flex items-center gap-1">
							<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
							Delete
						</button>
					</div>
				{/if}
				{#if imageContextMenu}
					<div
						class="fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 w-48 overflow-hidden"
						style="left: {imageContextMenu.x}px; top: {imageContextMenu.y}px"
						role="menu"
						onclick={(e) => e.stopPropagation()}
						onkeydown={(e) => e.stopPropagation()}
					>
						<div class="px-3 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Image Size</div>
						<button type="button" class="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200" onclick={() => setImageSize('small')}>Small — 200px</button>
						<button type="button" class="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200" onclick={() => setImageSize('medium')}>Medium — 400px</button>
						<button type="button" class="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200" onclick={() => setImageSize('large')}>Large — 600px</button>
						<button type="button" class="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200" onclick={() => setImageSize('full')}>Full width</button>
						<button type="button" class="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200" onclick={() => setImageSize('original')}>Original size</button>
						<div class="border-t border-slate-200 dark:border-slate-700 my-1"></div>
						<button type="button" class="w-full text-left px-3 py-1.5 text-sm hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600 dark:text-red-400" onclick={handleDeleteSelectedImage}>Delete image</button>
					</div>
				{/if}
			</div>

		</div>

		<div class="flex justify-between items-center p-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30">
			{#if isEditing}
				<button type="button" onclick={handleDelete} class="px-3 py-1.5 text-sm rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30" title="Delete note">
					<Icon name="lucide:trash-2" class="w-4 h-4 inline mr-1" />
					Delete
				</button>
			{:else}
				<span></span>
			{/if}
			<div class="flex gap-2">
				<button type="button" onclick={handleCancel} class="px-4 py-1.5 text-sm font-medium rounded-md border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700">
					Cancel
				</button>
				<button type="button" disabled={isSaving} onclick={handleSave} class="px-4 py-1.5 text-sm font-medium rounded-md bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50">
					{isSaving ? 'Saving...' : isEditing ? 'Save Changes' : 'Save'}
				</button>
			</div>
		</div>
	{/if}
</div>

<style>
	/* Ensure contenteditable placeholder and formatting look like editor */
	[contenteditable]:empty:before {
		content: attr(data-placeholder);
		color: rgb(148 163 184);
		pointer-events: none;
	}
	[contenteditable] :global(h1) { font-size: 1.5rem; font-weight: 700; margin: 0.75rem 0 0.5rem; }
	[contenteditable] :global(h2) { font-size: 1.25rem; font-weight: 600; margin: 0.75rem 0 0.5rem; }
	[contenteditable] :global(h3) { font-size: 1.1rem; font-weight: 600; margin: 0.5rem 0 0.25rem; }
	[contenteditable] :global(ul) { list-style: disc; padding-left: 1.5rem; margin: 0.5rem 0; }
	[contenteditable] :global(ol) { list-style: decimal; padding-left: 1.5rem; margin: 0.5rem 0; }
	[contenteditable] :global(a) { color: rgb(124 58 237); text-decoration: underline; }
	[contenteditable] :global(code) { background: rgb(241 245 249); padding: 0.15rem 0.3rem; border-radius: 4px; font-family: monospace; font-size: 0.85em; }
	:global(.dark) [contenteditable] :global(code) { background: rgb(30 41 59); }
	[contenteditable] :global(pre) { background: rgb(241 245 249); padding: 0.75rem; border-radius: 8px; overflow: auto; margin: 0.75rem 0; }
	:global(.dark) [contenteditable] :global(pre) { background: rgb(30 41 59); }
	[contenteditable] :global(img) { max-width: 100%; border-radius: 6px; margin: 8px 0; }
	[contenteditable] :global(u) { text-decoration: underline; }
	[contenteditable] :global(s), [contenteditable] :global(del) { text-decoration: line-through; }
</style>
