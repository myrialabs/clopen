<script lang="ts">
	/**
	 * Clopen's chat, as one conversation — like Telegram. Everything the owner
	 * said and everything Clopen answered or sent (results, reminders, files),
	 * in order, with no "new chat" seams: Clopen still opens fresh chats behind
	 * the scenes for a new topic, but the owner only ever sees one
	 * conversation. While Clopen works, a quick first word shows, then the
	 * answer. What it needs from the owner sits just above the input.
	 *
	 * Messages sit in one centred column and group like Telegram's: one
	 * sender in a row reads as one block, Clopen's mark at its start. While
	 * Clopen works the timeline is also fetched every few seconds, so an
	 * answer shows even if its push was missed.
	 */
	import { onMount, tick } from 'svelte';
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import AssistantFile from './AssistantFile.svelte';
	import NeedsYouCard from './NeedsYouCard.svelte';
	import ws from '$frontend/utils/ws';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { openChat } from '$frontend/stores/ui/assistant-view.svelte';
	import { clickOutside } from '$frontend/utils/click-outside';

	interface Entry {
		id: string;
		at: string;
		from: 'owner' | 'clopen';
		text: string;
		files: Array<{ id: string; filename: string; mime: string; url: string }>;
		/** What the owner attached: a name, and where to see it when it was kept. */
		attached: Array<string | { name: string; mime?: string; url?: string; id?: string }>;
		kind: 'message' | 'update';
		/** Where the owner typed it. */
		source?: 'web' | 'telegram';
		/** Changed after sending; what it said before. */
		edited?: { before: string; at: string };
		/** Shown before its row arrived: the bytes of a picture, to preview it meanwhile. */
		previews?: Array<{ name: string; src: string | null }>;
	}

	interface Props {
		/** Which of Clopen's chats this shows. */
		chatId?: string;
		mobile?: boolean;
	}

	const { chatId = 'main', mobile = false }: Props = $props();

	let entries = $state<Entry[]>([]);
	let more = $state(false);
	let working = $state(false);
	let loading = $state(true);
	let text = $state('');
	let files = $state<Array<{ type: 'image' | 'document'; mediaType: string; data: string; title: string; preview: string | null }>>([]);
	let sending = $state(false);
	let scroller = $state<HTMLElement>();
	let fileInput = $state<HTMLInputElement>();
	/** Messages sent but not yet in the timeline (shown at once). */
	let pending = $state<Entry[]>([]);

	// Only what this chat is waiting on; the bell lists everything.
	const cards = $derived(assistantStore.needsYou.filter((item) => (item.chatId ?? 'main') === chatId).slice(0, 3));

	function nearBottom(): boolean {
		if (!scroller) return true;
		return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
	}

	async function scrollDown(force = false) {
		const stick = force || nearBottom();
		await tick();
		if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
	}

	/** A message this screen showed the moment it was sent has its row now — under the same id. */
	function arrived(item: Entry): boolean {
		return entries.some((entry) => entry.id === item.id);
	}

	async function load(initial = false) {
		const result = (await ws.http('assistant:timeline-get', { chatId, limit: Math.max(60, entries.length) }).catch(() => null)) as { entries: Entry[]; more: boolean; working: boolean } | null;
		if (!result) return;
		entries = result.entries;
		more = result.more;
		working = result.working;
		pending = pending.filter((entry) => !arrived(entry));
		loading = false;
		await scrollDown(initial);
	}

	async function loadOlder() {
		if (!entries.length) return;
		const before = entries[0].at;
		const height = scroller?.scrollHeight ?? 0;
		const result = (await ws.http('assistant:timeline-get', { chatId, before, limit: 60 }).catch(() => null)) as { entries: Entry[]; more: boolean } | null;
		if (!result) return;
		entries = [...result.entries, ...entries];
		more = result.more;
		await tick();
		if (scroller) scroller.scrollTop = scroller.scrollHeight - height;
	}

	// While Clopen works, look again every few seconds; once it is done, once more.
	$effect(() => {
		if (!working) return;
		const timer = setInterval(() => void load(), 4000);
		return () => {
			clearInterval(timer);
			setTimeout(() => void load(), 1500);
		};
	});

	onMount(() => {
		void load(true);
		const off = [
			ws.on('assistant:timeline', (data: { chatId: string; working: boolean }) => {
				if (data.chatId !== chatId) return;
				working = data.working;
				void load();
			}),
			ws.on('assistant:changed', (data: { scope: string }) => {
				if (data.scope === 'inbox') void load();
			})
		];
		return () => off.forEach((unsubscribe) => unsubscribe());
	});

	async function send() {
		const said = text.trim();
		if ((!said && !files.length) || sending) return;
		sending = true;
		const attachments = files.map(({ preview: _preview, ...file }) => file);
		// The id the server keeps the message under too: when its row arrives, it replaces this one.
		const id = crypto.randomUUID();
		pending = [...pending, { id, at: new Date().toISOString(), from: 'owner', text: said, files: [], attached: files.map((file) => file.title), previews: files.map((file) => ({ name: file.title, src: file.preview })), kind: 'message', source: 'web' }];
		text = '';
		files = [];
		working = true;
		await scrollDown(true);
		try {
			await ws.http('assistant:say', { chatId, id, text: said, ...(attachments.length ? { attachments } : {}) });
		} catch (error) {
			addNotification({ type: 'error', title: 'Not sent', message: error instanceof Error ? error.message : String(error) });
			text = said;
			pending = pending.filter((entry) => entry.id !== id);
		} finally {
			sending = false;
		}
	}

	async function stop() {
		await ws.http('assistant:timeline-stop', { chatId }).catch(() => null);
	}

	async function clear() {
		const confirmed = await showConfirm({ title: 'Clear the chat?', message: 'The messages disappear from here. Clopen still remembers everything.', confirmText: 'Clear', type: 'warning' });
		if (!confirmed) return;
		await ws.http('assistant:timeline-clear', { chatId });
		entries = [];
		pending = [];
	}

	async function attach(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		for (const file of Array.from(input.files ?? []).slice(0, 8)) {
			const data = await new Promise<string>((resolve) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
				reader.readAsDataURL(file);
			});
			const image = file.type.startsWith('image/');
			files = [...files, { type: image ? 'image' : 'document', mediaType: file.type || 'application/octet-stream', data, title: file.name, preview: image ? URL.createObjectURL(file) : null }];
		}
		input.value = '';
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !mobile) {
			event.preventDefault();
			void send();
		}
	}

	const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
	const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	const shown = $derived([...entries, ...pending]);

	let switcherOpen = $state(false);
	const chatTitle = $derived(assistantStore.chats.find((chat) => chat.id === chatId)?.title ?? 'Main');
	/** The floating buttons' own background, so they read over messages. */
	const floating =
		'border border-slate-200 dark:border-slate-700 bg-white/90 dark:bg-slate-800/90 backdrop-blur text-slate-500 dark:text-slate-300 shadow-sm cursor-pointer hover:bg-white dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-slate-100 transition-colors';

	async function newChat() {
		switcherOpen = false;
		const chat = await assistantStore.createChat();
		openChat(chat.id);
	}

	/** Attachments by name, counted — five photos from Telegram are all "photo.jpg". */
	type Kept = { name: string; mime?: string; url: string; id: string };

	/** Attachments that were kept and can be shown. */
	function keptFiles(entry: Entry): Kept[] {
		return entry.attached.filter((file): file is Kept => typeof file === 'object' && Boolean(file.url) && Boolean(file.id));
	}

	/** Attachments known only by name (older messages). */
	function namedOnly(entry: Entry): string[] {
		return entry.attached.filter((file) => typeof file === 'string' || !file.url).map((file) => (typeof file === 'string' ? file : file.name));
	}

	// ── Editing a sent message: a correction — shown edited, and Clopen acts on it ──
	let editingId = $state<string | null>(null);
	let editText = $state('');

	/** The owner's own words, once their row exists (a card answer is not edited). */
	function editable(entry: Entry): boolean {
		return entry.from === 'owner' && entry.kind === 'message' && !entry.id.startsWith('card:') && entries.some((row) => row.id === entry.id) && Boolean(entry.text);
	}

	function startEdit(entry: Entry) {
		editingId = entry.id;
		editText = entry.text;
	}

	async function saveEdit(entry: Entry) {
		const next = editText.trim();
		editingId = null;
		if (!next || next === entry.text) return;
		entries = entries.map((row) => (row.id === entry.id ? { ...row, text: next, edited: { before: row.edited?.before ?? row.text, at: new Date().toISOString() } } : row));
		await ws.http('assistant:message-edit', { id: entry.id, text: next }).catch((error) => {
			addNotification({ type: 'error', title: 'Not edited', message: error instanceof Error ? error.message : String(error) });
			void load();
		});
	}

	// ── A long press on a touch screen: the message's menu (no hover there to show the pencil) ──
	let pressMenu = $state<{ entry: Entry; x: number; y: number; at: number } | null>(null);
	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let pressStart: { x: number; y: number } | null = null;
	const PRESS_MS = 500;

	function pressDown(event: PointerEvent, entry: Entry) {
		if (event.pointerType !== 'touch' || editingId === entry.id) return;
		pressStart = { x: event.clientX, y: event.clientY };
		pressTimer = setTimeout(() => {
			pressTimer = null;
			pressMenu = { entry, x: Math.min(event.clientX, window.innerWidth - 168), y: Math.min(event.clientY, window.innerHeight - 96), at: Date.now() };
			navigator.vibrate?.(10);
		}, PRESS_MS);
	}

	function pressMove(event: PointerEvent) {
		if (pressTimer && pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) pressCancel();
	}

	function pressCancel() {
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = null;
		pressStart = null;
	}

	async function copyMessage(entry: Entry) {
		pressMenu = null;
		try {
			await navigator.clipboard.writeText(entry.text);
			addNotification({ type: 'success', title: 'Copied', message: '' });
		} catch {
			addNotification({ type: 'error', title: 'Could not copy', message: '' });
		}
	}

	function grouped(names: string[]): Array<{ name: string; count: number }> {
		const counts = new Map<string, number>();
		for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
		return [...counts].map(([name, count]) => ({ name, count }));
	}
	/** Same sender, a few minutes apart: one block. */
	const GROUP_MS = 5 * 60_000;
	const startsGroup = (index: number) =>
		index === 0 || shown[index - 1].from !== shown[index].from || new Date(shown[index].at).getTime() - new Date(shown[index - 1].at).getTime() > GROUP_MS || day(shown[index - 1].at) !== day(shown[index].at);
	const endsGroup = (index: number) => index === shown.length - 1 || startsGroup(index + 1);
</script>

{#snippet composer()}
	<div class="mx-auto w-full max-w-3xl space-y-2">
		{#if cards.length}
			<div class="flex flex-col gap-2">
				{#each cards as item (item.id)}<NeedsYouCard {item} compact />{/each}
			</div>
		{/if}
		{#if files.length}
			<div class="flex flex-wrap gap-2">
				{#each files as file, index (index)}
					<span class="relative inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300">
						{#if file.preview}<img src={file.preview} alt="" class="w-8 h-8 rounded object-cover" />{:else}<Icon name="lucide:file" class="w-4 h-4" />{/if}
						<span class="max-w-32 truncate">{file.title}</span>
						<button type="button" class="p-0 bg-transparent border-none cursor-pointer text-slate-400 hover:text-red-500" onclick={() => (files = files.filter((_, at) => at !== index))} aria-label="Remove"><Icon name="lucide:x" class="w-3.5 h-3.5" /></button>
					</span>
				{/each}
			</div>
		{/if}
		<!-- The project chat's own input shape: attach, text, and the same send and stop buttons. -->
		<div class="flex items-end gap-1 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-2 focus-within:border-violet-500/60">
			<input type="file" class="hidden" multiple accept="image/*,application/pdf,.txt,.md,.csv" bind:this={fileInput} onchange={attach} />
			<button type="button" class="w-9 h-9 mb-2 shrink-0 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg flex items-center justify-center bg-transparent border-none cursor-pointer transition-colors" onclick={() => fileInput?.click()} aria-label="Attach" title="Attach">
				<Icon name="lucide:paperclip" class="text-slate-600 dark:text-slate-400 w-4.5 h-4.5" />
			</button>
			<textarea
				class="flex-1 min-w-0 max-h-40 resize-none bg-transparent border-none outline-none text-sm py-4 px-1 text-slate-900 dark:text-slate-100 placeholder:text-slate-400"
				rows="1"
				placeholder="Message Clopen…"
				bind:value={text}
				onkeydown={keydown}
				oninput={(event) => {
					const area = event.currentTarget as HTMLTextAreaElement;
					area.style.height = 'auto';
					area.style.height = `${Math.min(area.scrollHeight, 160)}px`;
				}}
			></textarea>
			<!-- 6px below a 40px button in a 52px row: centred on one line, and on the last line when it grows. -->
			<div class="flex items-center flex-shrink-0 pr-1.5 pb-1.5">
				{#if working && !text.trim() && !files.length}
					<button type="button" class="w-10 h-10 bg-red-500 hover:bg-red-600 rounded-xl flex items-center justify-center border-none cursor-pointer transition-colors" onclick={stop} aria-label="Stop response" title="Stop">
						<Icon name="lucide:circle-stop" class="text-white w-5 h-5" />
					</button>
				{:else}
					<button
						type="button"
						class="w-10 h-10 rounded-xl flex items-center justify-center border-none cursor-pointer transition-colors disabled:cursor-not-allowed bg-violet-600 hover:bg-violet-700 disabled:bg-slate-300 dark:disabled:bg-slate-700"
						disabled={sending || (!text.trim() && !files.length)}
						onclick={send}
						aria-label="Send"
						title="Send"
					>
						<Icon name="lucide:send-horizontal" class="text-white w-5 h-5" />
					</button>
				{/if}
			</div>
		</div>
	</div>
{/snippet}

<div class="relative flex flex-col h-full min-h-0">
	<!-- Floating over the chat, round and on their own background: which chat this is (and the others), a new one, clear. -->
	<div class="absolute top-3 left-3 z-10" use:clickOutside={() => (switcherOpen = false)}>
		<button
			type="button"
			class="flex items-center gap-1.5 h-9 pl-3 pr-2.5 max-w-56 rounded-full {floating}"
			onclick={() => (switcherOpen = !switcherOpen)}
			aria-expanded={switcherOpen}
			title="Chats"
		>
			{#if working}<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>{/if}
			<span class="truncate text-sm font-medium text-slate-800 dark:text-slate-100">{chatTitle}</span>
			<Icon name="lucide:chevron-down" class="w-3.5 h-3.5 shrink-0" />
		</button>
		{#if switcherOpen}
			<div
				class="absolute left-0 top-full mt-1.5 w-60 max-h-80 overflow-y-auto py-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-xl origin-top-left"
				transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
			>
				{#each assistantStore.chats as chat (chat.id)}
					<button
						type="button"
						class="flex items-center gap-2 w-full px-3 py-2 text-left text-sm border-none cursor-pointer {chat.id === chatId ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300' : 'bg-transparent text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/60'}"
						onclick={() => {
							switcherOpen = false;
							openChat(chat.id);
						}}
					>
						<Icon name={chat.id === 'main' ? 'lucide:message-circle' : 'lucide:message-square'} class="w-4 h-4 shrink-0" />
						<span class="flex-1 truncate">{chat.title}</span>
						{#if chat.id === chatId}<Icon name="lucide:check" class="w-3.5 h-3.5 shrink-0" />{/if}
					</button>
				{/each}
				<div class="my-1 border-t border-slate-200 dark:border-slate-700"></div>
				<button type="button" class="flex items-center gap-2 w-full px-3 py-2 text-left text-sm border-none cursor-pointer bg-transparent text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/60" onclick={newChat}>
					<Icon name="lucide:plus" class="w-4 h-4 shrink-0" />
					New chat
				</button>
			</div>
		{/if}
	</div>
	<div class="absolute top-3 right-3 z-10 flex items-center gap-2">
		<button type="button" class="flex items-center justify-center w-9 h-9 rounded-full {floating}" onclick={newChat} title="New chat" aria-label="New chat">
			<Icon name="lucide:plus" class="w-4 h-4" />
		</button>
		{#if shown.length > 0}
			<button type="button" class="flex items-center justify-center w-9 h-9 rounded-full {floating}" onclick={clear} title="Clear chat" aria-label="Clear chat">
				<Icon name="lucide:eraser" class="w-4 h-4" />
			</button>
		{/if}
	</div>

	{#if !loading && shown.length === 0}
		<!-- Nothing said yet: the greeting and the input, together in the middle. -->
		<div class="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center gap-6 px-3 md:px-6 py-6">
			<div class="flex flex-col items-center text-center gap-2">
				<img src="/favicon.svg" alt="" class="w-12 h-12 rounded-2xl" />
				<p class="text-lg font-semibold text-slate-900 dark:text-slate-100">What should we get done?</p>
				<p class="text-sm text-slate-500">Ask anything. Clopen does the work.</p>
			</div>
			{@render composer()}
		</div>
	{:else}
		<div class="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 pt-14 pb-4" bind:this={scroller}>
			<div class="mx-auto w-full max-w-3xl">
				{#if more}
					<div class="flex justify-center pb-2">
						<button type="button" class="px-3 py-1 rounded-full text-xs text-slate-500 bg-slate-100 dark:bg-slate-800 border-none cursor-pointer hover:text-slate-800 dark:hover:text-slate-200" onclick={loadOlder}>Earlier messages</button>
					</div>
				{/if}
				{#if loading}
					<div class="space-y-3 py-4" aria-busy="true">
						{#each [0, 1, 2] as index (index)}
							<div class="flex {index % 2 ? 'justify-end' : 'justify-start'}"><div class="h-10 rounded-2xl bg-slate-200/60 dark:bg-slate-800/60 animate-pulse {index % 2 ? 'w-48' : 'w-72'}"></div></div>
						{/each}
					</div>
				{/if}

				{#each shown as entry, index (entry.id)}
					{@const first = startsGroup(index)}
					{@const last = endsGroup(index)}
					{@const mine = entry.from === 'owner'}
					{#if index === 0 || day(shown[index - 1].at) !== day(entry.at)}
						<div class="flex justify-center py-3"><span class="px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-2xs text-slate-500">{day(entry.at)}</span></div>
					{/if}
					{@const kept = keptFiles(entry)}
					{@const named = namedOnly(entry)}
					<div class="group/msg flex items-center gap-1.5 {mine ? 'justify-end' : 'justify-start'} {first ? 'mt-3' : 'mt-0.5'}">
						{#if mine && editable(entry) && editingId !== entry.id}
							<button
								type="button"
								class="flex pointer-coarse:hidden items-center justify-center w-7 h-7 rounded-full border-none bg-transparent text-slate-400 cursor-pointer opacity-0 group-hover/msg:opacity-100 focus:opacity-100 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700 dark:hover:text-slate-200 transition-opacity"
								onclick={() => startEdit(entry)}
								aria-label="Edit message"
								title="Edit"
							><Icon name="lucide:pencil" class="w-3.5 h-3.5" /></button>
						{/if}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							onpointerdown={(event) => pressDown(event, entry)}
							onpointermove={pressMove}
							onpointerup={pressCancel}
							onpointercancel={pressCancel}
							oncontextmenu={(event) => {
								if (pressMenu || pressTimer) event.preventDefault();
							}}
							class="max-w-[85%] md:max-w-[75%] px-3.5 py-2 text-sm break-words rounded-2xl [-webkit-touch-callout:none]
								{pressMenu?.entry.id === entry.id ? 'ring-2 ring-violet-400/60' : ''}
								{mine ? 'bg-violet-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700'}
								{mine && !first ? 'rounded-tr-md' : ''} {mine && !last ? 'rounded-br-md' : ''}
								{!mine && !first ? 'rounded-tl-md' : ''} {!mine && !last ? 'rounded-bl-md' : ''}
								{mine && last ? 'rounded-br-sm' : ''} {!mine && last ? 'rounded-bl-sm' : ''}
								{editingId === entry.id ? 'w-full' : ''}"
						>
							{#if entry.files.length}
								<div class="flex flex-col gap-1.5 mb-1.5">
									{#each entry.files as file (file.id)}<AssistantFile {file} compact={mobile} />{/each}
								</div>
							{/if}
							{#if kept.length}
								<!-- What the owner sent, visible — from Telegram or the web. -->
								<div class="grid gap-1 mb-1.5 {kept.length > 1 ? 'grid-cols-2' : ''}">
									{#each kept as file (file.id)}<AssistantFile file={{ url: file.url, filename: file.name, mime: file.mime ?? 'application/octet-stream' }} compact />{/each}
								</div>
							{/if}
							{#if entry.previews?.length}
								<div class="grid gap-1 mb-1.5 {entry.previews.length > 1 ? 'grid-cols-2' : ''}">
									{#each entry.previews as preview, at (at)}
										{#if preview.src}<img src={preview.src} alt={preview.name} class="rounded-lg max-h-40 object-cover" />{:else}<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/20 text-2xs"><Icon name="lucide:paperclip" class="w-3 h-3" />{preview.name}</span>{/if}
									{/each}
								</div>
							{:else if named.length}
								<div class="flex flex-wrap gap-1 mb-1">
									{#each grouped(named) as group (group.name)}<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/20 text-2xs"><Icon name="lucide:paperclip" class="w-3 h-3" />{group.name}{group.count > 1 ? ` ×${group.count}` : ''}</span>{/each}
								</div>
							{/if}
							{#if editingId === entry.id}
								<!-- svelte-ignore a11y_autofocus -->
								<textarea
									class="w-full min-h-16 resize-none rounded-lg bg-white/15 border-none outline-none p-2 text-sm text-white placeholder:text-white/60"
									bind:value={editText}
									autofocus
									onkeydown={(event) => {
										if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
											event.preventDefault();
											void saveEdit(entry);
										}
										if (event.key === 'Escape') editingId = null;
									}}
								></textarea>
								<div class="flex justify-end gap-1.5 mt-1.5">
									<button type="button" class="px-2.5 py-1 rounded-md text-xs bg-white/15 border-none text-white cursor-pointer hover:bg-white/25" onclick={() => (editingId = null)}>Cancel</button>
									<button type="button" class="px-2.5 py-1 rounded-md text-xs bg-white text-violet-700 border-none cursor-pointer font-medium disabled:opacity-60" disabled={!editText.trim()} onclick={() => saveEdit(entry)}>Save</button>
								</div>
							{:else if entry.text}
								{#if mine}<p class="whitespace-pre-wrap">{entry.text}</p>{:else}<Markdown content={entry.text} />{/if}
							{/if}
							<p class="-mb-0.5 flex items-center justify-end gap-1 text-3xs leading-4 {mine ? 'text-white/60' : 'text-slate-400'}">
								{#if entry.edited}<span title={`Before: ${entry.edited.before}`}>edited</span>{/if}
								{#if mine && entry.source === 'telegram'}<span title="Sent from Telegram" class="inline-flex"><Icon name="lucide:send" class="w-2.5 h-2.5" /></span>{/if}
								{time(entry.at)}
							</p>
						</div>
					</div>
				{/each}

				{#if working}
					<div class="flex mt-3">
						<div class="max-w-[75%] rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500">
							<span class="inline-flex gap-1" aria-label="Clopen is typing">
								<span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce"></span>
								<span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:120ms]"></span>
								<span class="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:240ms]"></span>
							</span>
						</div>
					</div>
				{/if}
			</div>
		</div>

		<div class="shrink-0 px-3 md:px-6 pb-3 pt-1">{@render composer()}</div>
	{/if}
</div>

{#if pressMenu}
	{@const target = pressMenu.entry}
	<!-- A long-pressed message's menu: what the pencil and text selection do with a mouse. -->
	<div
		class="fixed z-50 min-w-40 py-1 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-xl"
		style="left: {pressMenu.x}px; top: {pressMenu.y}px;"
		use:clickOutside={() => {
			// The finger lifting from the long press is not a tap outside.
			if (pressMenu && Date.now() - pressMenu.at > 400) pressMenu = null;
		}}
		transition:scale={{ duration: 120, start: 0.95, easing: cubicOut }}
		role="menu"
	>
		{#if target.from === 'owner' && editable(target)}
			<button
				type="button"
				role="menuitem"
				class="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm text-left text-slate-700 dark:text-slate-200 bg-transparent border-none cursor-pointer active:bg-violet-500/10"
				onclick={() => {
					pressMenu = null;
					startEdit(target);
				}}
			><Icon name="lucide:pencil" class="w-4 h-4" />Edit</button>
		{/if}
		{#if target.text}
			<button
				type="button"
				role="menuitem"
				class="flex items-center gap-2.5 w-full px-3.5 py-2.5 text-sm text-left text-slate-700 dark:text-slate-200 bg-transparent border-none cursor-pointer active:bg-violet-500/10"
				onclick={() => copyMessage(target)}
			><Icon name="lucide:copy" class="w-4 h-4" />Copy</button>
		{/if}
	</div>
{/if}
