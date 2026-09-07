<script lang="ts">
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import {
		notesState,
		currentNote,
		deleteNote,
		queueNoteSave,
		flushNoteSave,
		uploadNoteImage,
		deleteNoteImage,
		resolveNoteImageUrl
	} from '$frontend/stores/features/notes.svelte';
	import NoteToolbar from './NoteToolbar.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { debug } from '$shared/utils/logger';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { untrack } from 'svelte';
	import { formatRelativeTime } from '$frontend/utils/format';
	import DOMPurify from 'dompurify';

	let title = $state('');
	let content = $state('');
	// Kept only so the note-switch effect can refuse to swap the editor out from
	// under a write that is still in the air.
	const isSaving = $derived(notesState.saveStatus === 'saving');
	let isDragging = $state(false);
	let editorEl: HTMLDivElement | null = $state(null);
	let editorWrapperEl: HTMLDivElement | null = $state(null);
	let fileInputEl: HTMLInputElement | null = $state(null);
	let deleteDialogOpen = $state(false);

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

	const SANITIZE_ADD_TAGS = ['u'];
	const SANITIZE_ADD_ATTR = ['data-pending-id', 'data-image-id'];
	const PERM_IMAGE_RE = /\/api\/notes\/images\/([A-Za-z0-9-]+)/;

	function sanitizeHtml(dirty: string): string {
		return DOMPurify.sanitize(dirty || '', {
			ADD_TAGS: SANITIZE_ADD_TAGS,
			ADD_ATTR: SANITIZE_ADD_ATTR,
			ALLOW_DATA_ATTR: true
		});
	}

	function escapeAttr(value: string): string {
		return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	}

	/**
	 * Convert display HTML into persistable HTML.
	 *
	 * On screen an attachment is a `blob:` object URL, because the bytes are
	 * fetched with an auth header rather than addressed by a credential-bearing
	 * URL. Those URLs die with the tab, so `data-image-id` — not `src` — is the
	 * identity that gets written back as a stable `/api/notes/images/<id>` path.
	 * An image still waiting to upload has no id yet and must not be persisted.
	 */
	function toStoredHtml(displayHtml: string): string {
		const host = document.createElement('div');
		host.innerHTML = sanitizeHtml(displayHtml);
		for (const node of host.querySelectorAll('img')) {
			const el = node as HTMLImageElement;
			if (el.getAttribute('data-pending-id')) {
				el.remove();
				continue;
			}
			const id = el.getAttribute('data-image-id') || (el.getAttribute('src') || '').match(PERM_IMAGE_RE)?.[1];
			if (!id) {
				el.remove();
				continue;
			}
			el.setAttribute('data-image-id', id);
			el.setAttribute('src', `/api/notes/images/${id}`);
		}
		return host.innerHTML;
	}

	/**
	 * Convert stored HTML into display HTML.
	 *
	 * Drops `blob:`/`data:` references a previous session left behind (they point
	 * at nothing now) and normalises every attachment to its `data-image-id`.
	 * The bytes arrive afterwards through `attachImageBlobs`, which needs the
	 * nodes to be in the document first.
	 */
	function hydrateToDisplay(storedHtml: string): string {
		const host = document.createElement('div');
		host.innerHTML = sanitizeHtml(storedHtml);
		for (const node of host.querySelectorAll('img')) {
			const el = node as HTMLImageElement;
			const src = el.getAttribute('src') || '';
			const id = el.getAttribute('data-image-id') || src.match(PERM_IMAGE_RE)?.[1];
			if (!id) {
				el.remove();
				continue;
			}
			el.setAttribute('data-image-id', id);
			el.removeAttribute('src');
		}
		return host.innerHTML;
	}

	/**
	 * Swap each attachment placeholder for its fetched object URL.
	 *
	 * Runs after the HTML is in the DOM and is generation-guarded by the note id:
	 * a slow image belonging to a note the user has already navigated away from
	 * must not paint into the editor showing a different note.
	 */
	async function attachImageBlobs(el: HTMLDivElement, noteId: string | null): Promise<void> {
		const targets = Array.from(el.querySelectorAll('img[data-image-id]')) as HTMLImageElement[];
		await Promise.all(
			targets.map(async (img) => {
				const id = img.getAttribute('data-image-id');
				if (!id || img.src.startsWith('blob:')) return;
				const url = await resolveNoteImageUrl(id);
				if (!url || lastNoteId !== noteId || !el.contains(img)) return;
				img.src = url;
			})
		);
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
		// The editor element only exists while a note is selected, so on the run
		// that first sees a new note `bind:this` has not fired yet. Claiming the
		// note as synced here would make the next run (the one that does have the
		// element) exit on the id check, leaving the note's content unpainted.
		if (noteId !== null && !el) return;
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
				void attachImageBlobs(el, noteId);
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

	$effect(() => {
		const el = editorEl;
		if (!el) return;
		const reposition = () => updateImageOverlayPos();
		el.addEventListener('scroll', reposition, { passive: true });
		window.addEventListener('resize', reposition);
		return () => {
			el.removeEventListener('scroll', reposition);
			window.removeEventListener('resize', reposition);
		};
	});

	// Keep content in sync when user types in contenteditable
	function handleEditorInput(): void {
		if (editorEl) content = editorEl.innerHTML;
		updateImageOverlayPos();
		scheduleSave();
	}

	const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
	const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

	let selectedImageEl: HTMLImageElement | null = $state(null);
	let selectedImagePendingId: string | null = $state(null);
	let selectedImageId: string | null = $state(null);
	let imageContextMenu: { x: number; y: number; target: HTMLImageElement } | null = $state(null);
	/**
	 * Where to float the remove button, relative to the editor's wrapper.
	 *
	 * It has to be an overlay rather than a node next to the image: anything
	 * inserted inside the contenteditable becomes part of the note's HTML and
	 * would be saved along with it. Null while nothing is selected, or while the
	 * selected image is scrolled out of view.
	 */
	let imageOverlayPos: { x: number; y: number } | null = $state(null);

	function updateImageOverlayPos(): void {
		const wrapper = editorWrapperEl;
		if (!selectedImageEl || !wrapper) {
			imageOverlayPos = null;
			return;
		}
		const wrapperRect = wrapper.getBoundingClientRect();
		const imgRect = selectedImageEl.getBoundingClientRect();
		const top = imgRect.top - wrapperRect.top;
		if (imgRect.bottom < wrapperRect.top || imgRect.top > wrapperRect.bottom) {
			imageOverlayPos = null;
			return;
		}
		imageOverlayPos = { x: imgRect.right - wrapperRect.left - 30, y: top + 6 };
	}

	function clearImageSelection(): void {
		if (selectedImageEl) selectedImageEl.classList.remove('ring-2', 'ring-violet-500');
		selectedImageEl = null;
		selectedImagePendingId = null;
		selectedImageId = null;
		imageOverlayPos = null;
	}

	/**
	 * Mark an image as the selection target.
	 *
	 * Identity comes from the data attributes only: an uploaded attachment is
	 * displayed as an object URL, so nothing about the image id can be read back
	 * out of `src`.
	 */
	function selectImage(img: HTMLImageElement): void {
		if (selectedImageEl) selectedImageEl.classList.remove('ring-2', 'ring-violet-500');
		selectedImageEl = img;
		img.classList.add('ring-2', 'ring-violet-500');
		selectedImagePendingId = img.getAttribute('data-pending-id');
		selectedImageId = img.getAttribute('data-image-id');
		updateImageOverlayPos();
	}

	function handleImageContextMenu(e: MouseEvent): void {
		const target = e.target as HTMLElement;
		if (target.tagName === 'IMG' && editorEl?.contains(target)) {
			e.preventDefault();
			imageContextMenu = { x: e.clientX, y: e.clientY, target: target as HTMLImageElement };
			selectImage(target as HTMLImageElement);
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
		scheduleSave();
	}

	function handleEditorClick(e: MouseEvent): void {
		const target = e.target as HTMLElement;
		closeImageContextMenu();
		if (target.tagName === 'IMG') {
			e.preventDefault();
			selectImage(target as HTMLImageElement);
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

	const IMAGE_STYLE =
		'max-width:400px;width:auto;height:auto;max-height:380px;object-fit:contain;display:block;border-radius:6px;margin:8px 0;cursor:pointer;';

	function insertImageAtCursor(previewUrl: string, pendingId: string, fileName: string): void {
		// A file name is user data and reaches other project members through the
		// saved note, so it is escaped before it becomes an attribute value.
		const imgHtml = `<img src="${previewUrl}" data-pending-id="${pendingId}" alt="${escapeAttr(fileName)}" style="${IMAGE_STYLE}" title="Right-click for size options, click to select" />`;
		if (!editorEl) {
			content = content + `<p>${imgHtml}</p>`;
			return;
		}
		editorEl.focus();
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
			let swapped = false;
			if (img) {
				// Take the canonical id first: the note must be persistable even if
				// re-fetching the stored copy fails, and the local preview still
				// shows the right pixels until it arrives.
				img.removeAttribute('data-pending-id');
				img.setAttribute('data-image-id', image.id);
				content = toStoredHtml(editorEl?.innerHTML ?? '');
				scheduleSave();
				const url = await resolveNoteImageUrl(image.id);
				if (url) {
					img.src = url;
					swapped = true;
				}
			}
			// Revoking the local preview while it is still the element's `src`
			// would turn a successful upload into a broken image on screen.
			if (swapped || !img) URL.revokeObjectURL(item.previewUrl);
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
			scheduleSave();
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

	/**
	 * Hand the current title and body to the store's debounced writer.
	 *
	 * Called on every edit. The store coalesces the burst into one request and
	 * flushes on blur, note switch and unload, so there is nothing for the user
	 * to press and nothing to lose by closing the panel mid-sentence.
	 */
	async function handleDelete(): Promise<void> {
		const note = selectedNote;
		deleteDialogOpen = false;
		if (!note) return;
		try {
			await deleteNote(note.id);
			for (const p of pendingImages) URL.revokeObjectURL(p.previewUrl);
			pendingImages = [];
			pendingUploads.clear();
		} catch (error) {
			addNotification({
				type: 'error',
				title: 'Delete Failed',
				message: error instanceof Error ? error.message : String(error),
				duration: 3000
			});
		}
	}

	function scheduleSave(): void {
		const noteId = selectedNote?.id;
		if (!noteId) return;
		queueNoteSave(noteId, {
			title: title.trim() || null,
			content: toStoredHtml(editorEl ? editorEl.innerHTML : content)
		});
	}

	async function handleDeleteImage(imageId: string): Promise<void> {
		if (!selectedNote) return;
		try {
			await deleteNoteImage(imageId, selectedNote.id);
			if (editorEl) {
				const img = editorEl.querySelector(`img[data-image-id="${imageId}"]`) as HTMLImageElement | null;
				if (img) img.remove();
				content = toStoredHtml(editorEl.innerHTML);
				scheduleSave();
			}
		} catch (error) {
			addNotification({ type: 'error', title: 'Failed', message: String(error), duration: 3000 });
		}
	}

	// Global notes do not need a project, so only the project scope is blocked by
	// the absence of one.
	const needsProject = $derived(notesState.scope === 'project' && !projectState.currentProject);

	/**
	 * One line of meta beside the title.
	 *
	 * The write state and the note's age share a slot because they answer the
	 * same question — is what I see on screen what is stored — and only one of
	 * them is ever the interesting answer.
	 */
	// Both blocks of this pane are containers in their own right, so the border,
	// radius and background are declared once instead of drifting apart.
	const SURFACE =
		'rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm';

	const saveLabel = $derived.by(() => {
		switch (notesState.saveStatus) {
			case 'pending':
			case 'saving':
				return { text: 'Saving…', tone: 'text-slate-400', spin: true, icon: null };
			case 'error':
				return {
					text: 'Not saved',
					tone: 'text-red-600 dark:text-red-400',
					spin: false,
					icon: 'lucide:triangle-alert' as const
				};
			default: {
				const updated = selectedNote ? formatRelativeTime(selectedNote.updated_at) : '';
				return {
					text: updated ? `Updated ${updated}` : '',
					tone: 'text-slate-400 dark:text-slate-500',
					spin: false,
					icon: null
				};
			}
		}
	});
</script>

<!-- Two surfaces, not one: the title bar and the editor each sit on their own
     container, the way DB Client stacks its action bar above the panel it acts
     on. Running them together made the toolbar read as part of the title, and
     leaving the title on bare background made it read as floating chrome. -->
<div class="flex flex-col h-full min-h-0 gap-2 p-3">
	{#if needsProject}
		<div class="{SURFACE} flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400 text-sm p-6">
			<Icon name="lucide:sticky-note" class="w-10 h-10 opacity-30" />
			<span>Select a project to create notes</span>
		</div>
	{:else if !selectedNote}
		<div class="{SURFACE} flex-1 flex flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-400 text-sm p-6">
			<Icon name="lucide:sticky-note" class="w-10 h-10 opacity-30" />
			<span>Select a note, or create one with New</span>
		</div>
	{:else}
		<input bind:this={fileInputEl} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple onchange={handleFileInputChange} class="hidden" />

		<!-- Title row: the note's name, its state, and its one action. There is no
		     Save — the store writes on a debounce, so a button here would only be
		     a no-op the user felt obliged to press. -->
		<div class="{SURFACE} flex items-center gap-2 px-3 py-1.5 shrink-0">
			<input
				type="text"
				bind:value={title}
				oninput={scheduleSave}
				onblur={() => void flushNoteSave()}
				placeholder="Title"
				aria-label="Note title"
				autocomplete="off"
				spellcheck="false"
				class="flex-1 min-w-0 px-1 py-1 text-base font-semibold bg-transparent outline-none text-slate-900 dark:text-slate-100 placeholder:text-slate-400 placeholder:font-normal"
			/>
			<span
				class="hidden sm:flex items-center gap-1.5 shrink-0 text-xs {saveLabel.tone}"
				aria-live="polite"
			>
				{#if saveLabel.spin}
					<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
				{:else if saveLabel.icon}
					<Icon name={saveLabel.icon} class="w-3.5 h-3.5" />
				{/if}
				{saveLabel.text}
			</span>
			<button
				type="button"
				onclick={() => (deleteDialogOpen = true)}
				title="Delete note"
				aria-label="Delete note"
				class="flex items-center justify-center w-8 h-8 shrink-0 rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-500/10 transition-colors"
			>
				<Icon name="lucide:trash-2" class="w-4 h-4" />
			</button>
		</div>

		<div class="{SURFACE} flex-1 min-h-0 flex flex-col overflow-hidden">
			<NoteToolbar editor={editorEl} onUploadClick={() => fileInputEl?.click()} />

			<!-- WYSIWYG Editor - drag & drop directly on board -->
			<div bind:this={editorWrapperEl} class="relative flex-1 flex flex-col min-h-0 overflow-hidden">
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
				onblur={() => void flushNoteSave()}
				onclick={handleEditorClick}
				onkeydown={handleEditorKeydown}
				oncontextmenu={handleImageContextMenu}
				onpaste={handlePaste}
				ondragover={handleDragOver}
				ondragleave={handleDragLeave}
				ondrop={handleDrop}
			></div>

			{#if imageOverlayPos}
				<button
					type="button"
					onclick={handleDeleteSelectedImage}
					title="Remove image"
					aria-label="Remove image"
					class="absolute z-20 flex items-center justify-center w-6 h-6 rounded-full bg-slate-900/80 text-white hover:bg-red-600 transition-colors"
					style="left: {imageOverlayPos.x}px; top: {imageOverlayPos.y}px"
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
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
	{/if}
</div>

<Dialog
	bind:isOpen={deleteDialogOpen}
	onClose={() => (deleteDialogOpen = false)}
	title="Delete note"
	type="warning"
	message="This note and every image attached to it will be deleted. This cannot be undone."
	confirmText="Delete"
	onConfirm={handleDelete}
/>

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
