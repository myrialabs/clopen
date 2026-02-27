<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	interface ConsoleMessage {
		id: string;
		type: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'clear';
		text: string;
		args?: any[];
		location?: {
			url: string;
			lineNumber: number;
			columnNumber: number;
		};
		stackTrace?: string;
		timestamp: number;
	}

	let {
		isOpen = $bindable(false),
		messages = $bindable<ConsoleMessage[]>([]),
		onClear = () => {},
		onExecuteCommand = (command: string) => {},
		onToggleLogging = (enabled: boolean) => {},
		isLoggingEnabled = $bindable(true)
	}: {
		isOpen: boolean;
		messages: ConsoleMessage[];
		onClear: () => void;
		onExecuteCommand: (command: string) => void;
		onToggleLogging: (enabled: boolean) => void;
		isLoggingEnabled: boolean;
	} = $props();

	let consoleContainer = $state<HTMLDivElement | undefined>();
	let commandInput = $state('');
	let filterLevel = $state<'all' | 'log' | 'info' | 'warn' | 'error'>('all');
	let searchQuery = $state('');
	let isAutoScroll = $state(true);
	let commandHistory = $state<string[]>([]);
	let historyIndex = $state(-1);

	// Filter messages based on level and search query
	const filteredMessages = $derived.by(() => {
		let filtered = messages;

		// Filter by level
		if (filterLevel !== 'all') {
			filtered = filtered.filter(msg => msg.type === filterLevel);
		}

		// Filter by search query
		if (searchQuery.trim()) {
			const query = searchQuery.toLowerCase();
			filtered = filtered.filter(msg => 
				msg.text.toLowerCase().includes(query) ||
				msg.args?.some((arg: any) => String(arg).toLowerCase().includes(query)) ||
				msg.location?.url.toLowerCase().includes(query)
			);
		}

		return filtered;
	});

	// Count messages by type for badges
	const messageCounts = $derived.by(() => {
		const counts = { log: 0, info: 0, warn: 0, error: 0, debug: 0, trace: 0 };
		messages.forEach(msg => {
			if (msg.type in counts) {
				counts[msg.type as keyof typeof counts]++;
			}
		});
		return counts;
	});

	function formatTimestamp(timestamp: number): string {
		const date = new Date(timestamp);
		return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
	}

	function formatArgs(args?: any[]): any[] {
		if (!args || args.length === 0) return [];
		return args;
	}

	function formatValue(value: any, depth: number = 0, maxDepth: number = 10): { display: string, type: string, expandable: boolean, fullContent?: string, preview?: string, structure?: any } {
		// Prevent infinite recursion
		if (depth > maxDepth) {
			return { display: '[Max depth reached]', type: 'unknown', expandable: false };
		}

		// Handle null and undefined
		if (value === null) {
			return { display: 'null', type: 'null', expandable: false };
		}
		if (value === undefined) {
			return { display: 'undefined', type: 'undefined', expandable: false };
		}
		
		// Handle primitives
		if (typeof value === 'string') {
			return { display: `"${value}"`, type: 'string', expandable: false };
		}
		if (typeof value === 'number') {
			return { display: String(value), type: 'number', expandable: false };
		}
		if (typeof value === 'boolean') {
			return { display: String(value), type: 'boolean', expandable: false };
		}
		if (typeof value === 'bigint') {
			return { display: String(value) + 'n', type: 'bigint', expandable: false };
		}
		if (typeof value === 'symbol') {
			return { display: String(value), type: 'symbol', expandable: false };
		}
		
		// Handle functions
		if (typeof value === 'function') {
			const funcStr = value.toString();
			const funcName = value.name || 'anonymous';
			const params = funcStr.match(/\(([^)]*)\)/) || ['', ''];
			const preview = `ƒ ${funcName}(${params[1]})`;
			return { 
				display: preview, 
				type: 'function', 
				expandable: true,
				fullContent: funcStr,
				preview: preview
			};
		}
		
		// Handle arrays - DevTools style
		if (Array.isArray(value)) {
			if (value.length === 0) {
				return { display: '[]', type: 'array', expandable: false };
			}
			
			const preview = `(${value.length}) [${value.map((item, i) => {
				if (i >= 3) return null;
				if (typeof item === 'string') return `"${item}"`;
				if (typeof item === 'object' && item !== null) {
					if (Array.isArray(item)) return `Array(${item.length})`;
					return '{...}';
				}
				return String(item);
			}).filter(Boolean).join(', ')}${value.length > 3 ? ', ...' : ''}]`;
			
			// Create structure for nested expansion
			const structure = value.map((item, index) => ({
				key: String(index),
				value: item,
				formatted: formatValue(item, depth + 1, maxDepth),
				type: Array.isArray(item) ? 'array' : typeof item
			}));
			
			return {
				display: `Array${preview}`,
				type: 'array',
				expandable: true,
				preview: `Array${preview}`,
				structure: structure
			};
		}
		
		// Handle objects - DevTools style
		if (typeof value === 'object') {
			// Handle Error objects
			if (value instanceof Error) {
				const errorStructure = [
					{ key: 'name', value: value.name, formatted: formatValue(value.name, depth + 1, maxDepth), type: 'string' },
					{ key: 'message', value: value.message, formatted: formatValue(value.message, depth + 1, maxDepth), type: 'string' }
				];
				if (value.stack) {
					errorStructure.push({ key: 'stack', value: value.stack, formatted: formatValue(value.stack, depth + 1, maxDepth), type: 'string' });
				}
				
				return {
					display: `${value.name}: ${value.message}`,
					type: 'error',
					expandable: true,
					preview: `${value.name}: ${value.message}`,
					structure: errorStructure
				};
			}
			
			// Handle Date objects
			if (value instanceof Date) {
				const dateStr = value.toString();
				const structure = [
					{ key: 'toString()', value: dateStr, formatted: formatValue(dateStr, depth + 1, maxDepth), type: 'string' },
					{ key: 'toISOString()', value: value.toISOString(), formatted: formatValue(value.toISOString(), depth + 1, maxDepth), type: 'string' },
					{ key: 'getTime()', value: value.getTime(), formatted: formatValue(value.getTime(), depth + 1, maxDepth), type: 'number' }
				];
				return { 
					display: dateStr, 
					type: 'date', 
					expandable: true,
					preview: dateStr,
					structure: structure 
				};
			}
			
			// Handle RegExp objects
			if (value instanceof RegExp) {
				const regexStr = value.toString();
				const structure = [
					{ key: 'source', value: value.source, formatted: formatValue(value.source, depth + 1, maxDepth), type: 'string' },
					{ key: 'flags', value: value.flags, formatted: formatValue(value.flags, depth + 1, maxDepth), type: 'string' },
					{ key: 'global', value: value.global, formatted: formatValue(value.global, depth + 1, maxDepth), type: 'boolean' },
					{ key: 'ignoreCase', value: value.ignoreCase, formatted: formatValue(value.ignoreCase, depth + 1, maxDepth), type: 'boolean' },
					{ key: 'multiline', value: value.multiline, formatted: formatValue(value.multiline, depth + 1, maxDepth), type: 'boolean' }
				];
				return { 
					display: regexStr, 
					type: 'regexp', 
					expandable: true,
					preview: regexStr,
					structure: structure 
				};
			}
			
			// Handle regular objects
			const keys = Object.keys(value);
			const descriptors = Object.getOwnPropertyDescriptors(value);
			
			if (keys.length === 0) {
				return { display: '{}', type: 'object', expandable: false };
			}
			
			// Create preview like DevTools - show first few properties
			const previewProps = keys.slice(0, 5).map(key => {
				const val = value[key];
				if (typeof val === 'string') return `${key}: "${val}"`;
				if (typeof val === 'object' && val !== null) {
					if (Array.isArray(val)) return `${key}: Array(${val.length})`;
					return `${key}: {...}`;
				}
				return `${key}: ${String(val)}`;
			});
			const preview = `{${previewProps.join(', ')}${keys.length > 5 ? `, ...${keys.length - 5} more` : ''}}`;
			
			// Create complete structure for expansion
			const structure = keys.map(key => {
				const descriptor = descriptors[key];
				const val = value[key];
				return {
					key: key,
					value: val,
					formatted: formatValue(val, depth + 1, maxDepth),
					type: Array.isArray(val) ? 'array' : typeof val,
					writable: descriptor.writable !== false,
					enumerable: descriptor.enumerable !== false,
					configurable: descriptor.configurable !== false
				};
			});
			
			// Get constructor name for better object identification
			const constructorName = value.constructor ? value.constructor.name : 'Object';
			const objectDisplay = constructorName === 'Object' ? preview : `${constructorName} ${preview}`;
			
			return {
				display: objectDisplay,
				type: 'object',
				expandable: true,
				preview: objectDisplay,
				structure: structure
			};
		}
		
		return { display: String(value), type: 'unknown', expandable: false };
	}

	// DevTools-style color scheme
	function getDevToolsColors(type: string, theme: 'light' | 'dark' = 'dark'): string {
		if (theme === 'light') {
			switch (type) {
				case 'string': return 'color: #c41230;'; // DevTools red for strings
				case 'number': return 'color: #1976d2;'; // DevTools blue for numbers  
				case 'boolean': return 'color: #9c27b0;'; // DevTools purple for booleans
				case 'null': return 'color: #808080;'; // DevTools gray for null
				case 'undefined': return 'color: #808080;'; // DevTools gray for undefined
				case 'function': return 'color: #795548;'; // DevTools brown for functions
				case 'object': return 'color: #333;'; // DevTools dark for objects
				case 'array': return 'color: #333;'; // DevTools dark for arrays
				case 'error': return 'color: #d32f2f;'; // DevTools red for errors
				case 'key': return 'color: #881391;'; // DevTools purple for keys
				default: return 'color: #333;';
			}
		} else {
			switch (type) {
				case 'string': return 'color: #f28b54;'; // DevTools light orange for strings
				case 'number': return 'color: #9c27b0;'; // DevTools blue for numbers
				case 'boolean': return 'color: #9c27b0;'; // DevTools purple for booleans
				case 'null': return 'color: #808080;'; // DevTools gray for null
				case 'undefined': return 'color: #808080;'; // DevTools gray for undefined
				case 'function': return 'color: #5db0d7;'; // DevTools cyan for functions
				case 'object': return 'color: #e8eaed;'; // DevTools light for objects
				case 'array': return 'color: #e8eaed;'; // DevTools light for arrays
				case 'error': return 'color: #f28b54;'; // DevTools orange for errors
				case 'key': return 'color: #9c27b0;'; // DevTools purple for keys
				default: return 'color: #e8eaed;';
			}
		}
	}

	// Store for expanded state of tree nodes
	let expandedNodes = $state(new Set<string>());
	
	function toggleNode(nodeId: string) {
		if (expandedNodes.has(nodeId)) {
			expandedNodes.delete(nodeId);
		} else {
			expandedNodes.add(nodeId);
		}
		expandedNodes = new Set(expandedNodes); // Trigger reactivity
	}
	
	function generateNodeId(): string {
		return `node-${Math.random().toString(36).substr(2, 9)}`;
	}

	function getMessageColors(type: ConsoleMessage['type']): { bg: string, border: string, text: string, icon: string } {
		switch (type) {
			case 'error': 
				return { 
					bg: 'bg-red-50/80 dark:bg-red-950/30', 
					border: 'border-l-red-500', 
					text: 'text-red-800 dark:text-red-200',
					icon: 'text-red-600 dark:text-red-400'
				};
			case 'warn': 
				return { 
					bg: 'bg-yellow-50/80 dark:bg-yellow-950/30', 
					border: 'border-l-yellow-500', 
					text: 'text-yellow-800 dark:text-yellow-200',
					icon: 'text-yellow-600 dark:text-yellow-400'
				};
			case 'info': 
				return { 
					bg: 'bg-violet-50/80 dark:bg-violet-950/30', 
					border: 'border-l-blue-500', 
					text: 'text-violet-800 dark:text-violet-200',
					icon: 'text-violet-600 dark:text-violet-400'
				};
			case 'debug': 
				return { 
					bg: 'bg-purple-50/80 dark:bg-purple-950/30', 
					border: 'border-l-purple-500', 
					text: 'text-purple-800 dark:text-purple-200',
					icon: 'text-purple-600 dark:text-purple-400'
				};
			case 'trace': 
				return { 
					bg: 'bg-green-50/80 dark:bg-green-950/30', 
					border: 'border-l-green-500', 
					text: 'text-green-800 dark:text-green-200',
					icon: 'text-green-600 dark:text-green-400'
				};
			case 'clear': 
				return { 
					bg: 'bg-slate-50/80 dark:bg-slate-900/30', 
					border: 'border-l-slate-400', 
					text: 'text-slate-600 dark:text-slate-400',
					icon: 'text-slate-500 dark:text-slate-400'
				};
			default: 
				return { 
					bg: 'bg-transparent hover:bg-slate-50/50 dark:hover:bg-slate-800/50', 
					border: 'border-l-transparent', 
					text: 'text-slate-900 dark:text-slate-100',
					icon: 'text-slate-600 dark:text-slate-400'
				};
		}
	}

	function getValueTypeColor(type: string): string {
		switch (type) {
			case 'string': return 'text-green-600 dark:text-green-400';
			case 'number': return 'text-violet-600 dark:text-violet-400';
			case 'boolean': return 'text-purple-600 dark:text-purple-400';
			case 'null': return 'text-gray-500 dark:text-gray-400';
			case 'undefined': return 'text-gray-500 dark:text-gray-400';
			case 'function': return 'text-cyan-600 dark:text-cyan-400';
			case 'object': return 'text-orange-600 dark:text-orange-400';
			case 'array': return 'text-violet-600 dark:text-violet-400';
			case 'error': return 'text-red-600 dark:text-red-400';
			case 'date': return 'text-pink-600 dark:text-pink-400';
			case 'regexp': return 'text-yellow-600 dark:text-yellow-400';
			case 'symbol': return 'text-violet-600 dark:text-violet-400';
			default: return 'text-slate-700 dark:text-slate-300';
		}
	}

	function handleCommandSubmit(e: Event) {
		e.preventDefault();
		const command = commandInput.trim();
		if (!command) return;

		// Add to history
		commandHistory.unshift(command);
		if (commandHistory.length > 50) {
			commandHistory = commandHistory.slice(0, 50);
		}
		historyIndex = -1;

		// Execute command
		onExecuteCommand(command);
		commandInput = '';
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (historyIndex < commandHistory.length - 1) {
				historyIndex++;
				commandInput = commandHistory[historyIndex] || '';
			}
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (historyIndex > 0) {
				historyIndex--;
				commandInput = commandHistory[historyIndex] || '';
			} else if (historyIndex === 0) {
				historyIndex = -1;
				commandInput = '';
			}
		}
	}

	function scrollToBottom() {
		if (consoleContainer && isAutoScroll) {
			consoleContainer.scrollTop = consoleContainer.scrollHeight;
		}
	}

	function toggleAutoScroll() {
		isAutoScroll = !isAutoScroll;
		if (isAutoScroll) {
			scrollToBottom();
		}
	}

	// Auto-scroll when new messages arrive
	$effect(() => {
		if (messages.length > 0) {
			setTimeout(scrollToBottom, 50);
		}
	});

	// Handle scroll to detect if user scrolled up
	function handleScroll() {
		if (!consoleContainer) return;
		
		const { scrollTop, scrollHeight, clientHeight } = consoleContainer;
		const isAtBottom = scrollTop + clientHeight >= scrollHeight - 10;
		
		if (!isAtBottom && isAutoScroll) {
			isAutoScroll = false;
		} else if (isAtBottom && !isAutoScroll) {
			isAutoScroll = true;
		}
	}

</script>

{#if isOpen}
	<div 
		class="h-full flex flex-col bg-white dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700"
		in:fly={{ x: 300, duration: 300, easing: cubicOut }}
		out:fly={{ x: 300, duration: 250, easing: cubicOut }}
	>
		<!-- DevTools-style Header -->
		<div class="flex-shrink-0 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
			<!-- Toolbar -->
			<div class="flex items-center justify-between px-3 py-2">
				<div class="flex items-center gap-3">
					<!-- Clear button (DevTools style) -->
					<button
						onclick={onClear}
						class="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
						title="Clear console"
					>
						<Icon name="lucide:ban" class="w-4 h-4 text-gray-600 dark:text-gray-400" />
					</button>
					
					<!-- Filter buttons (DevTools style) -->
					<div class="flex items-center gap-1">
						<button
							onclick={() => filterLevel = 'all'}
							class="px-2 py-1 text-xs font-medium rounded {filterLevel === 'all' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'} transition-colors"
						>
							All
						</button>
						{#if messageCounts.error > 0}
							<button
								onclick={() => filterLevel = 'error'}
								class="px-2 py-1 text-xs font-medium rounded flex items-center gap-1 {filterLevel === 'error' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'} transition-colors"
							>
								<span class="text-red-500">✕</span>
								{messageCounts.error}
							</button>
						{/if}
						{#if messageCounts.warn > 0}
							<button
								onclick={() => filterLevel = 'warn'}
								class="px-2 py-1 text-xs font-medium rounded flex items-center gap-1 {filterLevel === 'warn' ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'} transition-colors"
							>
								<span class="text-yellow-500">⚠</span>
								{messageCounts.warn}
							</button>
						{/if}
						{#if messageCounts.info > 0}
							<button
								onclick={() => filterLevel = 'info'}
								class="px-2 py-1 text-xs font-medium rounded flex items-center gap-1 {filterLevel === 'info' ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'} transition-colors"
							>
								<span class="text-violet-500">ℹ</span>
								{messageCounts.info}
							</button>
						{/if}
						{#if messageCounts.log > 0}
							<button
								onclick={() => filterLevel = 'log'}
								class="px-2 py-1 text-xs font-medium rounded flex items-center gap-1 {filterLevel === 'log' ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'} transition-colors"
							>
								{messageCounts.log}
							</button>
						{/if}
					</div>
				</div>
				
				<div class="flex items-center gap-2">
					<!-- Search -->
					<div class="relative">
						<Icon name="lucide:search" class="absolute left-2.5 top-1/2 transform -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
						<input
							type="text"
							bind:value={searchQuery}
							placeholder="Filter"
							class="pl-8 pr-3 py-1 text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 w-40"
						/>
					</div>
					
					<!-- Settings toggle -->
					<button
						onclick={() => onToggleLogging(!isLoggingEnabled)}
						class="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
						title={isLoggingEnabled ? 'Disable logging' : 'Enable logging'}
					>
						<Icon 
							name={isLoggingEnabled ? 'lucide:pause' : 'lucide:play'} 
							class="w-4 h-4 {isLoggingEnabled ? 'text-gray-600 dark:text-gray-400' : 'text-gray-400'}" 
						/>
					</button>
					
					<!-- Close -->
					<button
						onclick={() => isOpen = false}
						class="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
						title="Close console"
					>
						<Icon name="lucide:x" class="w-4 h-4 text-gray-600 dark:text-gray-400" />
					</button>
				</div>
			</div>
		</div>

		<!-- Console Messages (DevTools style) -->
		<div 
			bind:this={consoleContainer}
			onscroll={handleScroll}
			role="log"
			class="flex-1 overflow-y-auto bg-white dark:bg-gray-900 font-mono text-sm"
		>
			{#if filteredMessages.length === 0}
				<div class="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
					{#if messages.length === 0}
						<div class="text-center">
							<div class="text-4xl mb-2 opacity-20">⚡</div>
							<p class="text-sm">Console is empty</p>
						</div>
					{:else}
						<div class="text-center">
							<div class="text-4xl mb-2 opacity-20">🔍</div>
							<p class="text-sm">No messages match your filter</p>
						</div>
					{/if}
				</div>
			{:else}
				{#each filteredMessages as message (message.id)}
					{@const colors = getMessageColors(message.type)}
					<div class="flex items-start px-3 border-b border-gray-100 dark:border-gray-800 {colors.bg} {colors.border} border-l-2 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors group">
						<!-- Message content -->
						<div class="flex-1 min-w-0 py-2 pr-3">
							<!-- Message text -->
							<div class="break-all">
								{message.text}
							</div>
							
							<!-- Arguments (DevTools style) -->
							{#if message.args && message.args.length > 0}
								{#each formatArgs(message.args) as arg, index}
									{@const formatted = formatValue(arg)}
									{@const nodeId = generateNodeId()}
									<div class="ml-1 font-mono text-sm">
										{#if !formatted.expandable}
											<span style={getDevToolsColors(formatted.type, 'dark')} class="break-all">{formatted.display}</span>
										{:else if formatted.type === 'function' && formatted.fullContent}
											<div class="flex items-start cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150 px-1 py-0.5 rounded">
												<button
													type="button"
													onclick={() => toggleNode(nodeId)}
													class="inline-block w-3 h-3 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none mr-1 mt-0.5 flex-shrink-0 hover:text-slate-700 dark:hover:text-slate-300 font-mono"
												>
													{expandedNodes.has(nodeId) ? '▼' : '▶'}
												</button>
												<span style={getDevToolsColors('function', 'dark')} class="italic break-all">{formatted.display}</span>
												{#if expandedNodes.has(nodeId)}
													<div class="pl-2 border-l border-dotted border-slate-300 dark:border-slate-600">
														<pre class="text-xs p-2 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 overflow-x-auto text-slate-800 dark:text-slate-200" style="white-space: pre-wrap; word-break: break-all;">{formatted.fullContent}</pre>
													</div>
												{/if}
											</div>
										{:else if formatted.structure}
											<div class="flex items-start cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150 px-1 py-0.5 rounded">
												<button
													type="button"
													onclick={() => toggleNode(nodeId)}
													class="inline-block w-3 h-3 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none mr-1 mt-0.5 flex-shrink-0 hover:text-slate-700 dark:hover:text-slate-300 font-mono"
												>
													{expandedNodes.has(nodeId) ? '▼' : '▶'}
												</button>
												<span style={getDevToolsColors(formatted.type, 'dark')} class="break-all">{formatted.display}</span>
												{#if expandedNodes.has(nodeId)}
													<div class="pl-2 border-l border-dotted border-slate-300 dark:border-slate-600">
														{#each formatted.structure as item}
															{@const keyStyle = formatted.type === 'array' ? getDevToolsColors('number', 'dark') : getDevToolsColors('key', 'dark')}
															{@const subNodeId = generateNodeId()}
															<div class="flex items-start hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150 px-1 py-0.5 rounded ml-3">
																{#if item.formatted.expandable && item.formatted.structure}
																	<button
																		type="button"
																		onclick={() => toggleNode(subNodeId)}
																		class="inline-block w-3 h-3 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none mr-1 mt-0.5 flex-shrink-0 hover:text-slate-700 dark:hover:text-slate-300 font-mono"
																	>
																		{expandedNodes.has(subNodeId) ? '▼' : '▶'}
																	</button>
																{/if}
																<span style={keyStyle} class="font-medium mr-1">{item.key}:</span>
																<span style={getDevToolsColors(item.formatted.type, 'dark')} class="break-all">{item.formatted.display}</span>
																{#if item.formatted.expandable && item.formatted.structure && expandedNodes.has(subNodeId)}
																	<div class="pl-2 border-l border-dotted border-slate-300 dark:border-slate-600">
																		{#each item.formatted.structure as subItem}
																			<div class="ml-3">
																				<span style={getDevToolsColors('key', 'dark')} class="font-medium mr-1">{subItem.key}:</span>
																				<span style={getDevToolsColors(subItem.formatted.type, 'dark')} class="break-all">{subItem.formatted.display}</span>
																			</div>
																		{/each}
																	</div>
																{/if}
															</div>
														{/each}
													</div>
												{/if}
											</div>
										{:else}
											<span style={getDevToolsColors(formatted.type, 'dark')} class="break-all">{formatted.display}</span>
										{/if}
									</div>
								{/each}
							{/if}
							
							<!-- Location info -->
							{#if message.location}
								<div class="mt-1 text-xs text-gray-500 dark:text-gray-400">
									<button 
										type="button"
										class="hover:underline cursor-pointer text-left"
										title="Go to source"
										onclick={() => {}}
									>
										{message.location.url.split('/').pop()}:{message.location.lineNumber}:{message.location.columnNumber}
									</button>
								</div>
							{/if}
							
							<!-- Stack trace -->
							{#if message.stackTrace}
								<details class="mt-2">
									<summary class="cursor-pointer text-gray-500 dark:text-gray-400 text-xs hover:text-gray-700 dark:hover:text-gray-300 select-none">
										Show stack trace
									</summary>
									<pre class="mt-2 p-3 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-700 dark:text-gray-300 overflow-x-auto border-l-2 border-gray-300 dark:border-gray-600">{message.stackTrace}</pre>
								</details>
							{/if}
						</div>
						
						<!-- Actions (shown on hover) -->
						<div class="opacity-0 group-hover:opacity-100 transition-opacity p-2 flex-shrink-0">
							<button
								onclick={() => {
									const text = message.text + (message.args && message.args.length > 0 ? ' ' + message.args.map(arg => String(arg)).join(' ') : '');
									navigator.clipboard.writeText(text);
								}}
								class="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
								title="Copy to clipboard"
							>
								<Icon name="lucide:copy" class="w-3 h-3" />
							</button>
						</div>
					</div>
				{/each}
			{/if}
		</div>
		
		<!-- Command Input (DevTools style) -->
		<div class="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
			<form onsubmit={handleCommandSubmit} class="flex items-start px-3 py-2">
				<!-- Prompt indicator -->
				<div class="flex items-center mt-1 mr-2 text-violet-600 dark:text-violet-400 font-mono font-bold">
					&gt;
				</div>
				
				<!-- Input area -->
				<div class="flex-1 min-h-6">
					<input
						type="text"
						bind:value={commandInput}
						onkeydown={handleKeyDown}
						placeholder="Type JavaScript expression..."
						class="w-full bg-transparent text-sm font-mono text-gray-900 dark:text-gray-100 outline-none placeholder-gray-500 dark:placeholder-gray-400 resize-none"
						style="font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', 'Fira Mono', 'Droid Sans Mono', 'Source Code Pro', monospace;"
					/>
				</div>
				
				<!-- Execute button (only shown when typing) -->
				{#if commandInput.trim()}
					<button
						type="submit"
						class="ml-2 px-2 py-1 text-xs bg-violet-600 text-white rounded hover:bg-violet-700 transition-colors"
						title="Execute (Enter)"
					>
						Execute
					</button>
				{/if}
			</form>
			
			<!-- Help text -->
			{#if !commandInput.trim()}
				<div class="px-3 pb-2 text-xs text-gray-500 dark:text-gray-400">
					Tip: Use ↑/↓ for command history
				</div>
			{/if}
		</div>
	</div>
{/if}