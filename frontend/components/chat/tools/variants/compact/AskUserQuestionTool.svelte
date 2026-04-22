<script lang="ts">
	import type { ToolUseBlock, AskUserQuestionInput } from '$shared/types/unified';
	import ws from '$frontend/utils/ws';
	import { currentSessionId } from '$frontend/stores/core/sessions.svelte';
	import { appState, updateSessionProcessState } from '$frontend/stores/core/app.svelte';
	import { debug } from '$shared/utils/logger';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as AskUserQuestionInput);
	const result = $derived(toolInput.result);

	function parseResultAnswers(content: string, questions: { question: string }[]): Record<string, string> {
		const answers: Record<string, string> = {};
		try {
			const json = JSON.parse(content);
			if (json?.answers && typeof json.answers === 'object') return json.answers;
		} catch { /* not JSON */ }
		for (let i = 0; i < questions.length; i++) {
			const q = questions[i].question;
			const searchStr = `"${q}"="`;
			const startIdx = content.indexOf(searchStr);
			if (startIdx === -1) continue;
			const answerStart = startIdx + searchStr.length;
			let answerEnd = -1;
			if (i < questions.length - 1) {
				answerEnd = content.indexOf(`", "${questions[i + 1].question}"="`, answerStart);
			}
			if (answerEnd === -1) answerEnd = content.indexOf('". You can now continue', answerStart);
			answers[q] = answerEnd !== -1 ? content.slice(answerStart, answerEnd) : content.slice(answerStart);
		}
		return answers;
	}

	const hasResult = $derived(!!result?.content);
	const parsedAnswers = $derived.by(() => {
		if (!result?.content) return {};
		return parseResultAnswers(result.content, input.questions);
	});
	const isError = $derived(hasResult && Object.keys(parsedAnswers).length === 0);
	const isAnswered = $derived(hasResult && !isError);

	let selections = $state<Record<number, Set<string>>>({});
	let customInputs = $state<Record<number, string>>({});
	let otherActive = $state<Record<number, boolean>>({});
	let isSubmitting = $state(false);
	let hasSubmitted = $state(false);
	const isInterrupted = $derived(toolInput.interrupted);

	$effect(() => {
		if (!input.questions) return;
		const init: Record<number, Set<string>> = {};
		const initCustom: Record<number, string> = {};
		const initOther: Record<number, boolean> = {};
		for (let i = 0; i < input.questions.length; i++) {
			init[i] = new Set();
			initCustom[i] = '';
			initOther[i] = false;
		}
		selections = init;
		customInputs = initCustom;
		otherActive = initOther;
	});

	function toggleSelection(questionIdx: number, label: string, isMultiSelect: boolean) {
		const current = selections[questionIdx] || new Set();
		if (isMultiSelect) {
			if (current.has(label)) current.delete(label); else current.add(label);
		} else {
			current.clear(); current.add(label);
			otherActive[questionIdx] = false;
			customInputs[questionIdx] = '';
		}
		selections[questionIdx] = new Set(current);
	}

	function toggleOther(questionIdx: number, isMultiSelect: boolean) {
		if (isMultiSelect) {
			otherActive[questionIdx] = !otherActive[questionIdx];
		} else {
			selections[questionIdx] = new Set();
			otherActive[questionIdx] = true;
		}
	}

	function isSelected(questionIdx: number, label: string): boolean {
		return selections[questionIdx]?.has(label) ?? false;
	}

	async function submitAnswers() {
		if (isSubmitting || hasSubmitted) return;
		isSubmitting = true;
		try {
			const answers: Record<string, string> = {};
			for (let i = 0; i < input.questions.length; i++) {
				const q = input.questions[i];
				const selected = selections[i] || new Set();
				const customText = customInputs[i]?.trim();
				const isOther = otherActive[i];
				if (q.multiSelect) {
					const parts = [...Array.from(selected), ...(isOther && customText ? [customText] : [])];
					answers[q.question] = parts.join(', ');
				} else {
					answers[q.question] = isOther && customText ? customText : Array.from(selected).join(', ');
				}
			}
			debug.log('chat', 'Submitting AskUserQuestion answers:', answers);
			ws.emit('chat:ask-user-answer', { chatSessionId: currentSessionId(), toolUseId: toolInput.id, answers });
			const sessId = currentSessionId();
			if (sessId) updateSessionProcessState(sessId, { isWaitingInput: false });
			appState.isWaitingInput = false;
			hasSubmitted = true;
		} catch (error) {
			debug.error('chat', 'Failed to submit answers:', error);
		} finally {
			isSubmitting = false;
		}
	}
</script>

{#if isError || isInterrupted}
	<div class="space-y-1.5">
		{#each input.questions as question}
			<div class="border-l-2 border-slate-300 dark:border-slate-600 pl-2 space-y-0.5">
				<div class="text-sm font-medium text-slate-600 dark:text-slate-400">{question.header}</div>
				<p class="text-sm text-slate-500 dark:text-slate-400">{question.question}</p>
			</div>
		{/each}
		<p class="text-sm text-slate-500 dark:text-slate-400 pl-2">
			{isError && result?.content ? result.content : 'Session ended before question was answered'}
		</p>
	</div>

{:else if isAnswered || hasSubmitted}
	<div class="space-y-2">
		{#each input.questions as question, idx}
			{@const answer = isAnswered
				? parsedAnswers[question.question]
				: (() => {
					const selected = selections[idx] || new Set();
					const customText = customInputs[idx]?.trim();
					const isOther = otherActive[idx];
					return question.multiSelect
						? [...Array.from(selected), ...(isOther && customText ? [customText] : [])].join(', ')
						: (isOther && customText ? customText : Array.from(selected).join(', '));
				})()}
			<div class="border-l-2 border-slate-300 dark:border-slate-600 pl-2.5 space-y-0.5">
				<div class="text-sm font-medium text-slate-600 dark:text-slate-400">{question.header}</div>
				<p class="text-sm text-slate-500 dark:text-slate-400">{question.question}</p>
				<p class="text-sm font-medium text-slate-700 dark:text-slate-300">{answer || 'No answer'}</p>
			</div>
		{/each}
	</div>

{:else}
	<div class="space-y-2">
		{#each input.questions as question, idx}
			<div class="border-l-2 border-slate-300 dark:border-slate-600 pl-2.5 space-y-1.5">
				<div class="text-sm font-semibold text-slate-700 dark:text-slate-300">{question.header}</div>
				<p class="text-sm text-slate-600 dark:text-slate-400">{question.question}</p>
				<div class="space-y-1">
					{#each question.options as option}
						<button
							class="w-full text-left flex items-start gap-2 px-2 py-1 rounded text-sm transition-colors
								{isSelected(idx, option.label)
									? 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
									: 'hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400'}"
							onclick={() => toggleSelection(idx, option.label, question.multiSelect)}
						>
							<div class="w-3 h-3 shrink-0 mt-1 rounded{question.multiSelect ? '' : '-full'} border flex items-center justify-center
								{isSelected(idx, option.label) ? 'border-slate-500 bg-slate-500' : 'border-slate-400'}">
								{#if isSelected(idx, option.label)}
									{#if question.multiSelect}
										<span class="text-white text-[8px] leading-none">✓</span>
									{:else}
										<div class="w-1.5 h-1.5 rounded-full bg-white"></div>
									{/if}
								{/if}
							</div>
							<div>
								<span class="font-medium">{option.label}</span>
								<span class="opacity-50">— {option.description}</span>
							</div>
						</button>
					{/each}
					<div
						class="w-full flex items-center gap-2 px-2 py-1 rounded text-sm transition-colors cursor-pointer
							{otherActive[idx] ? 'bg-slate-100 dark:bg-slate-700' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}"
						onclick={() => toggleOther(idx, question.multiSelect)}
						role="button"
						tabindex="-1"
					>
						<div class="w-3 h-3 shrink-0 rounded{question.multiSelect ? '' : '-full'} border flex items-center justify-center
							{otherActive[idx] ? 'border-slate-500 bg-slate-500' : 'border-slate-400'}">
							{#if otherActive[idx]}
								{#if question.multiSelect}
									<span class="text-white text-[8px] leading-none">✓</span>
								{:else}
									<div class="w-1.5 h-1.5 rounded-full bg-white"></div>
								{/if}
							{/if}
						</div>
						<input
							type="text"
							placeholder="Other..."
							class="flex-1 min-w-0 text-sm bg-transparent border-none outline-none text-slate-600 dark:text-slate-400"
							bind:value={customInputs[idx]}
							onclick={(e) => e.stopPropagation()}
							onfocus={() => { if (!question.multiSelect) selections[idx] = new Set(); otherActive[idx] = true; }}
						/>
					</div>
				</div>
				{#if question.multiSelect}
					<p class="text-xs text-slate-400 dark:text-slate-500 italic">Multiple selections allowed</p>
				{/if}
			</div>
		{/each}
		<button
			class="px-3 py-1 text-sm font-medium rounded bg-slate-700 hover:bg-slate-800 dark:bg-slate-600 dark:hover:bg-slate-500 text-white disabled:opacity-50"
			onclick={submitAnswers}
			disabled={isSubmitting}
		>
			{isSubmitting ? 'Submitting...' : 'Submit'}
		</button>
	</div>
{/if}
