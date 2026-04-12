<script lang="ts">
	import type { ToolUseBlock, AskUserQuestionInput } from '$shared/types/unified';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { currentSessionId } from '$frontend/stores/core/sessions.svelte';
	import { appState, updateSessionProcessState } from '$frontend/stores/core/app.svelte';
	import { debug } from '$shared/utils/logger';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as AskUserQuestionInput);
	const result = $derived(toolInput.result);

	// Parse answers from the result.content string using known question texts as anchors.
	// Format: User has answered your questions: "q1"="a1", "q2"="a2", ... . You can now continue...
	function parseResultAnswers(content: string, questions: { question: string }[]): Record<string, string> {
		const answers: Record<string, string> = {};

		// Try JSON parse first (future SDK versions might use JSON)
		try {
			const json = JSON.parse(content);
			if (json?.answers && typeof json.answers === 'object') return json.answers;
		} catch {
			// Not JSON — parse human-readable format
		}

		for (let i = 0; i < questions.length; i++) {
			const q = questions[i].question;
			const searchStr = `"${q}"="`;
			const startIdx = content.indexOf(searchStr);
			if (startIdx === -1) continue;

			const answerStart = startIdx + searchStr.length;

			let answerEnd = -1;

			if (i < questions.length - 1) {
				const nextQ = questions[i + 1].question;
				const nextMarker = `", "${nextQ}"="`;
				answerEnd = content.indexOf(nextMarker, answerStart);
			}

			if (answerEnd === -1) {
				const endMarker = '". You can now continue';
				answerEnd = content.indexOf(endMarker, answerStart);
			}

			answers[q] = answerEnd !== -1
				? content.slice(answerStart, answerEnd)
				: content.slice(answerStart);
		}

		return answers;
	}

	// Detect whether the tool has a result (answered or errored)
	const hasResult = $derived(!!result?.content);

	// Parse per-question answers from the result content
	let parsedAnswers = $derived.by(() => {
		if (!result?.content) return {};
		return parseResultAnswers(result.content, input.questions);
	});

	// Detect error: result exists but no answers could be parsed (error message instead of answer format)
	const isError = $derived(hasResult && Object.keys(parsedAnswers).length === 0);

	// Successfully answered: has result and parsed answers exist
	const isAnswered = $derived(hasResult && !isError);

	// Selection state per question
	let selections = $state<Record<number, Set<string>>>({});
	// Custom text input per question (for "Other" option)
	let customInputs = $state<Record<number, string>>({});
	// Track whether "Other" is the active selection per question
	let otherActive = $state<Record<number, boolean>>({});
	let isSubmitting = $state(false);
	let hasSubmitted = $state(false);

	// Tool was interrupted — set on ToolUseBlock directly
	const isInterrupted = $derived(toolInput.interrupted);

	// Initialize selections
	$effect(() => {
		if (!input.questions) return;
		const initial: Record<number, Set<string>> = {};
		const initialCustom: Record<number, string> = {};
		const initialOther: Record<number, boolean> = {};
		for (let i = 0; i < input.questions.length; i++) {
			initial[i] = new Set();
			initialCustom[i] = '';
			initialOther[i] = false;
		}
		selections = initial;
		customInputs = initialCustom;
		otherActive = initialOther;
	});

	function toggleSelection(questionIdx: number, label: string, isMultiSelect: boolean) {
		const current = selections[questionIdx] || new Set();
		if (isMultiSelect) {
			if (current.has(label)) {
				current.delete(label);
			} else {
				current.add(label);
			}
		} else {
			current.clear();
			current.add(label);
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
			const questions = input.questions;

			for (let i = 0; i < questions.length; i++) {
				const q = questions[i];
				const selected = selections[i] || new Set();
				const customText = customInputs[i]?.trim();
				const isOther = otherActive[i];

				if (q.multiSelect) {
					const parts: string[] = Array.from(selected);
					if (isOther && customText) {
						parts.push(customText);
					}
					answers[q.question] = parts.join(', ');
				} else {
					if (isOther && customText) {
						answers[q.question] = customText;
					} else if (selected.size > 0) {
						answers[q.question] = Array.from(selected).join(', ');
					} else {
						answers[q.question] = '';
					}
				}
			}

			debug.log('chat', 'Submitting AskUserQuestion answers:', answers);

			ws.emit('chat:ask-user-answer', {
				chatSessionId: currentSessionId(),
				toolUseId: toolInput.id,
				answers
			});

			// Clear waiting input status — SDK will resume processing
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
	<!-- Error/interrupted state — show questions as read-only with error indicator -->
	<div class="space-y-3">
		{#each input.questions as question}
			<div class="bg-white dark:bg-slate-800 rounded-lg border border-red-200/60 dark:border-red-800/40 p-4 space-y-2.5">
				<div class="flex items-center gap-2">
					<Icon name="lucide:circle-x" class="text-red-500 w-4 h-4 shrink-0" />
					<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700/50 text-slate-500 dark:text-slate-400">
						{question.header}
					</span>
				</div>
				<p class="text-sm text-slate-500 dark:text-slate-400">{question.question}</p>
			</div>
		{/each}
		{#if isError && result?.content}
			<p class="text-xs text-red-500 dark:text-red-400">{result.content}</p>
		{:else}
			<p class="text-xs text-red-500 dark:text-red-400">Session ended before question was answered</p>
		{/if}
	</div>

{:else if isAnswered}
	<!-- Answered state — each question in its own card -->
	<div class="space-y-3">
		{#each input.questions as question}
			<div class="bg-white dark:bg-slate-800 rounded-lg border border-slate-200/60 dark:border-slate-700/60 p-4 space-y-2.5">
				<div class="flex items-center gap-2">
					<Icon name="lucide:circle-check" class="text-green-500 w-4 h-4 shrink-0" />
					<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-800/50 text-blue-700 dark:text-blue-300">
						{question.header}
					</span>
				</div>
				<p class="text-sm font-medium text-slate-700 dark:text-slate-200">{question.question}</p>
				<p class="text-sm text-green-700 dark:text-green-300 font-medium">
					{parsedAnswers[question.question] || 'No answer'}
				</p>
			</div>
		{/each}
	</div>

{:else if hasSubmitted}
	<!-- Submitted state — each question in its own card with local answer -->
	<div class="space-y-3">
		{#each input.questions as question, idx}
			{@const selected = selections[idx] || new Set()}
			{@const customText = customInputs[idx]?.trim()}
			{@const isOther = otherActive[idx]}
			{@const localAnswer = question.multiSelect
				? [...Array.from(selected), ...(isOther && customText ? [customText] : [])].join(', ')
				: (isOther && customText ? customText : Array.from(selected).join(', '))
			}
			<div class="bg-white dark:bg-slate-800 rounded-lg border border-slate-200/60 dark:border-slate-700/60 p-4 space-y-2.5">
				<div class="flex items-center gap-2">
					<div class="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0"></div>
					<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-800/50 text-blue-700 dark:text-blue-300">
						{question.header}
					</span>
				</div>
				<p class="text-sm font-medium text-slate-700 dark:text-slate-200">{question.question}</p>
				<p class="text-sm text-slate-500 dark:text-slate-400">
					{localAnswer || 'No answer'}
				</p>
			</div>
		{/each}
	</div>

{:else}
	<!-- Interactive form — each question in its own card -->
	<div class="space-y-3">
		{#each input.questions as question, idx}
			<div class="bg-white dark:bg-slate-800 rounded-lg border border-slate-200/60 dark:border-slate-700/60 p-4 space-y-3">
				<!-- Question header badge -->
				<div class="flex items-center gap-2">
					<Icon name="lucide:message-circle-question-mark" class="text-blue-500 dark:text-blue-400 w-4 h-4 shrink-0" />
					<span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-800/50 text-blue-700 dark:text-blue-300">
						{question.header}
					</span>
				</div>

				<!-- Question text -->
				<p class="text-sm font-medium text-slate-700 dark:text-slate-200">{question.question}</p>

				<!-- Options -->
				<div class="space-y-1.5">
					{#each question.options as option}
						<button
							class="w-full text-left flex items-start gap-3 p-2.5 rounded-md border transition-colors
								{isSelected(idx, option.label)
									? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/30'
									: 'border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-slate-50 dark:hover:bg-slate-700/50'
								}"
							onclick={() => toggleSelection(idx, option.label, question.multiSelect)}
						>
							<div class="mt-0.5 shrink-0">
								{#if question.multiSelect}
									<div class="w-4 h-4 rounded border-2 flex items-center justify-center transition-colors
										{isSelected(idx, option.label)
											? 'border-blue-500 bg-blue-500'
											: 'border-slate-300 dark:border-slate-600'
										}"
									>
										{#if isSelected(idx, option.label)}
											<Icon name="lucide:check" class="text-white w-3 h-3" />
										{/if}
									</div>
								{:else}
									<div class="w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors
										{isSelected(idx, option.label)
											? 'border-blue-500'
											: 'border-slate-300 dark:border-slate-600'
										}"
									>
										{#if isSelected(idx, option.label)}
											<div class="w-2 h-2 rounded-full bg-blue-500"></div>
										{/if}
									</div>
								{/if}
							</div>
							<div class="min-w-0">
								<span class="text-sm font-medium text-slate-800 dark:text-slate-200">{option.label}</span>
								<span class="text-sm text-slate-500 dark:text-slate-400"> — {option.description}</span>
							</div>
						</button>
					{/each}

					<!-- "Other" custom input option -->
					<div
						class="flex items-start gap-3 p-2.5 rounded-md border transition-colors cursor-pointer
							{otherActive[idx]
								? 'border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/30'
								: 'border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-slate-50 dark:hover:bg-slate-700/50'
							}"
						onclick={() => toggleOther(idx, question.multiSelect)}
						role="button"
						tabindex="-1"
					>
						<div class="mt-0.5 shrink-0">
							{#if question.multiSelect}
								<div class="w-4 h-4 rounded border-2 flex items-center justify-center transition-colors
									{otherActive[idx]
										? 'border-blue-500 bg-blue-500'
										: 'border-slate-300 dark:border-slate-600'
									}"
								>
									{#if otherActive[idx]}
										<Icon name="lucide:check" class="text-white w-3 h-3" />
									{/if}
								</div>
							{:else}
								<div class="w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors
									{otherActive[idx]
										? 'border-blue-500'
										: 'border-slate-300 dark:border-slate-600'
									}"
								>
									{#if otherActive[idx]}
										<div class="w-2 h-2 rounded-full bg-blue-500"></div>
									{/if}
								</div>
							{/if}
						</div>
						<div class="flex-1 min-w-0">
							<input
								type="text"
								placeholder="Other (type your answer)..."
								class="w-full text-sm bg-transparent border-none outline-none text-slate-700 dark:text-slate-200 placeholder-slate-400"
								bind:value={customInputs[idx]}
								onclick={(e) => e.stopPropagation()}
								onfocus={() => {
									if (!question.multiSelect) {
										selections[idx] = new Set();
									}
									otherActive[idx] = true;
								}}
							/>
						</div>
					</div>
				</div>

				{#if question.multiSelect}
					<p class="text-xs text-slate-400 dark:text-slate-500 italic">Multiple selections allowed</p>
				{/if}
			</div>
		{/each}

		<!-- Submit button -->
		<div class="flex justify-end pt-1">
			<button
				class="px-4 py-1.5 text-sm font-medium rounded-md transition-colors
					bg-blue-600 hover:bg-blue-700 text-white
					disabled:opacity-50 disabled:cursor-not-allowed"
				onclick={submitAnswers}
				disabled={isSubmitting}
			>
				{#if isSubmitting}
					Submitting...
				{:else}
					Submit Answer
				{/if}
			</button>
		</div>
	</div>
{/if}
