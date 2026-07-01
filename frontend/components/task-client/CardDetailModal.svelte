<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { taskClientStore, type TrelloChecklist } from '$frontend/stores/features/task-client.svelte';
	import { debug } from '$shared/utils/logger';
	import { marked } from 'marked';
	import RichTextEditor from './RichTextEditor.svelte';
	import { untrack } from 'svelte';
	import { formatFileSize } from '$frontend/utils/format';

	interface Props {
		cardId: string | null;
		isOpen: boolean;
		onClose: () => void;
		initialSection?: 'labels' | 'members' | 'dates' | null;
	}

	let { cardId, isOpen, onClose, initialSection = null }: Props = $props();

	let datesBtnEl = $state<HTMLButtonElement | null>(null);
	let datesBadgeBtnEl = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		if (isOpen && cardId) {
			if (initialSection === 'labels') {
				showLabelsPopover = true;
			} else if (initialSection === 'members') {
				showMembersPopover = true;
			} else if (initialSection === 'dates') {
				setTimeout(() => {
					const triggerEl = datesBadgeBtnEl || datesBtnEl;
					if (triggerEl) {
						datesPopoverSource = datesBadgeBtnEl ? 'badge' : 'button';
						updatePopoverPosition(triggerEl, 520);
					} else {
						popoverLeft = window.innerWidth / 2 - 144;
						popoverTop = window.innerHeight / 2 - 260;
					}
					showDatesPopover = true;
				}, 50);
			}
		} else {
			showLabelsPopover = false;
			showMembersPopover = false;
			showDatesPopover = false;
		}
	});

	// Component States
	let isEditingDesc = $state(false);
	let editDescVal = $state('');
	let newCheckItemVals = $state<Record<string, string>>({});
	let activeAddCheckItemId = $state<string | null>(null);
	let commentVal = $state('');
	let isWritingComment = $state(false);
	let editCommentHTML = $state('');
	let showActivityDetails = $state(false);

	const isCommentEmpty = $derived.by(() => {
		if (!editCommentHTML) return true;
		const text = editCommentHTML.replace(/<[^>]*>/g, '').trim();
		return text.length === 0 && !editCommentHTML.includes('<img');
	});

	// Get current active card from store list
	const card = $derived(
		cardId ? taskClientStore.cards.find((c) => c.id === cardId) : null
	);

	// Get list details
	const list = $derived(
		card ? taskClientStore.lists.find((l) => l.id === card.idList) : null
	);

	$effect(() => {
		console.log('CardDetailModal state changed - isOpen:', isOpen, 'cardId:', cardId, 'resolved card:', card);
	});

	// Load card details when card changes
	$effect(() => {
		if (isOpen && cardId) {
			untrack(() => {
				taskClientStore.fetchCardDetails(cardId);
				if (card) {
					editDescVal = card.desc || '';
				}
			});
			isEditingDesc = false;
			isWritingComment = false;
			editCommentHTML = '';
			activeAddCheckItemId = null;
			newCheckItemVals = {};
			commentVal = '';
		}
	});

	// Actions handlers
	async function handleToggleDueComplete() {
		if (!card) return;
		try {
			await taskClientStore.toggleDueComplete(card.id, !card.dueComplete);
		} catch (e) {
			debug.error('task-client', 'Failed to toggle completion:', e);
		}
	}

	let editDescHTML = $state('');

	const mentionOptions = $derived.by(() => {
		const list: { id: string; fullName: string; username: string; avatarUrl: string | null; isSpecial: boolean }[] = [
			{
				id: 'card',
				fullName: 'All members on the card',
				username: 'card',
				avatarUrl: null,
				isSpecial: true
			},
			{
				id: 'board',
				fullName: 'All members on the board',
				username: 'board',
				avatarUrl: null,
				isSpecial: true
			}
		];
		
		if (card && card.members) {
			for (const m of card.members) {
				list.unshift({
					id: m.id,
					fullName: m.fullName,
					username: m.username || m.fullName.toLowerCase().replace(/\s+/g, ''),
					avatarUrl: m.avatarUrl,
					isSpecial: false
				});
			}
		}
		return list;
	});

	function highlightCode(line: string, lang: string): string {
		if (!line) return '<br>';
		
		const l = lang ? lang.toLowerCase() : '';
		
		// Default patterns anchored to start of string
		let keywords = /^\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|export|from|class|extends|new|this|typeof|instanceof|in|of|as|async|await|try|catch|finally|throw|default|null|undefined|true|false)\b/;
		let builtins = /^\b(console|window|document|process|global|Math|JSON|Object|Array|String|Number|Boolean|Map|Set|Promise|Error)\b/;
		let comments = /^\/\/.*|^\/\*.*?\*\//;
		let strings = /^"(\\.|[^"\\])*"|^'(\\.|[^'\\])*'|^`(\\.|[^`\\])*`/;
		let numbers = /^\b\d+(\.\d+)?\b/;
		let functions = /^\b[a-zA-Z_]\w*(?=\s*\()/;
		
		if (l === 'python' || l === 'py') {
			keywords = /^\b(def|class|return|if|elif|else|for|while|break|continue|import|from|as|in|is|and|or|not|lambda|try|except|finally|raise|assert|pass|global|nonlocal|with|yield|None|True|False)\b/;
			builtins = /^\b(print|len|range|str|int|float|list|dict|set|tuple|type|abs|max|min|sum|open|enumerate|zip)\b/;
			comments = /^#.*/;
			strings = /^f?"(\\.|[^"\\])*"|^f?'(\\.|[^'\\])*'/;
		} else if (l === 'rust' || l === 'rs') {
			keywords = /^\b(fn|let|mut|const|static|impl|struct|enum|trait|use|mod|pub|return|if|else|loop|while|for|in|match|break|continue|async|await|type|as|ref|self|Self|true|false)\b/;
			builtins = /^\b(println|format|vec|panic|Option|Some|None|Result|Ok|Err|String|Box|Rc|Arc)\b/;
			comments = /^\/\/.*|^\/\*.*?\*\//;
			strings = /^"(\\.|[^"\\])*"|^'(\\.|[^'\\])*'/;
		} else if (l === 'go') {
			keywords = /^\b(func|var|const|type|struct|interface|package|import|return|if|else|switch|case|default|select|for|range|break|continue|go|chan|defer|fallthrough|map|nil|true|false)\b/;
			builtins = /^\b(fmt|Println|Printf|Print|make|new|len|cap|append|panic|recover|string|int|float64|bool|error)\b/;
			comments = /^\/\/.*|^\/\*.*?\*\//;
			strings = /^"(\\.|[^"\\])*"|^`[^`]*`/;
		} else if (l === 'sql') {
			keywords = /^\b(SELECT|FROM|WHERE|INSERT|INTO|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|INNER|LEFT|RIGHT|OUTER|ON|AND|OR|NOT|IN|LIKE|IS|NULL|TRUE|FALSE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|UNION|ALL|AS)\b/i;
			builtins = /^\b(COUNT|SUM|AVG|MIN|MAX|COALESCE|CONCAT|NOW|DATE|TIME)\b/i;
			comments = /^--.*/;
			strings = /^'(\\.|[^'\\])*'/;
		} else if (l === 'css' || l === 'scss') {
			keywords = /^\b(important|media|keyframes|import|include|mixin|extend)\b/;
			comments = /^\/\*[\s\S]*?\*\/|^\/\/.*/;
			strings = /^"(\\.|[^"\\])*"|^'(\\.|[^'\\])*'/;
		}
		
		const isHtml = l === 'html' || l === 'xml';
		const htmlTagPattern = /^<\/?[a-zA-Z0-9_:-]+(?:\s+[a-zA-Z0-9_:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*\s*\/?>/;
		const htmlCommentPattern = /^<!--[\s\S]*?-->/;
		
		let html = '';
		let index = 0;
		
		const escapeHtml = (text: string) => {
			return text
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#039;');
		};
		
		const highlightHtmlTag = (tag: string): string => {
			let res = '';
			let idx = 0;
			const tagHeadMatch = tag.match(/^<\/?([a-zA-Z0-9_:-]+)/);
			if (tagHeadMatch) {
				const tagText = tag.startsWith('</') ? '</' : '<';
				res += `<span class="token-operator">${escapeHtml(tagText)}</span>`;
				res += `<span class="token-keyword">${tagHeadMatch[1]}</span>`;
				idx = tagHeadMatch[0].length;
			}
			
			while (idx < tag.length) {
				const sub = tag.slice(idx);
				
				if (sub.startsWith('/>')) {
					res += `<span class="token-operator">/&gt;</span>`;
					break;
				}
				if (sub.startsWith('>')) {
					res += `<span class="token-operator">&gt;</span>`;
					break;
				}
				
				const attrMatch = sub.match(/^\s+([a-zA-Z0-9_:-]+)/);
				if (attrMatch) {
					res += ` <span class="token-builtin">${attrMatch[1]}</span>`;
					idx += attrMatch[0].length;
					continue;
				}
				
				const eqValMatch = sub.match(/^\s*=\s*("[^"]*"|'[^']*')/);
				if (eqValMatch) {
					const eqIdx = eqValMatch[0].indexOf('=');
					res += escapeHtml(eqValMatch[0].slice(0, eqIdx + 1));
					res += `<span class="token-string">${escapeHtml(eqValMatch[1])}</span>`;
					idx += eqValMatch[0].length;
					continue;
				}
				
				res += escapeHtml(tag[idx]);
				idx++;
			}
			return res;
		};
		
		while (index < line.length) {
			const substring = line.slice(index);
			
			if (isHtml) {
				const commentMatch = substring.match(htmlCommentPattern);
				if (commentMatch) {
					html += `<span class="token-comment">${escapeHtml(commentMatch[0])}</span>`;
					index += commentMatch[0].length;
					continue;
				}
				const tagMatch = substring.match(htmlTagPattern);
				if (tagMatch) {
					html += highlightHtmlTag(tagMatch[0]);
					index += tagMatch[0].length;
					continue;
				}
			}
			
			if (l === 'css' || l === 'scss') {
				const propMatch = substring.match(/^\b([a-zA-Z-]+)(?=\s*:)/);
				if (propMatch) {
					html += `<span class="token-builtin">${escapeHtml(propMatch[0])}</span>`;
					index += propMatch[0].length;
					continue;
				}
			}
			
			let stringMatch = substring.match(strings);
			if (stringMatch) {
				html += `<span class="token-string">${escapeHtml(stringMatch[0])}</span>`;
				index += stringMatch[0].length;
				continue;
			}
			
			let commentMatch = substring.match(comments);
			if (commentMatch) {
				html += `<span class="token-comment">${escapeHtml(commentMatch[0])}</span>`;
				index += commentMatch[0].length;
				continue;
			}
			
			let kwMatch = substring.match(keywords);
			if (kwMatch) {
				html += `<span class="token-keyword">${escapeHtml(kwMatch[0])}</span>`;
				index += kwMatch[0].length;
				continue;
			}
			
			let biMatch = substring.match(builtins);
			if (biMatch) {
				html += `<span class="token-builtin">${escapeHtml(biMatch[0])}</span>`;
				index += biMatch[0].length;
				continue;
			}
			
			let fnMatch = substring.match(functions);
			if (fnMatch) {
				html += `<span class="token-function">${escapeHtml(fnMatch[0])}</span>`;
				index += fnMatch[0].length;
				continue;
			}
			
			let numMatch = substring.match(numbers);
			if (numMatch) {
				html += `<span class="token-number">${escapeHtml(numMatch[0])}</span>`;
				index += numMatch[0].length;
				continue;
			}
			
			html += escapeHtml(line[index]);
			index++;
		}
		
		return html;
	}

	function renderMarkdownWithMentions(markdown: string, isEditor = false): string {
		if (!markdown) return '';
		if (typeof document === 'undefined') return marked.parse(markdown) as string;
		
		const html = marked.parse(markdown) as string;
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');

		// Wrap lines inside pre code blocks with div elements for line numbering support
		const preElements = doc.querySelectorAll('pre');
		for (const pre of preElements) {
			const code = pre.querySelector('code');
			if (code) {
				const langClass = Array.from(code.classList).find(c => c.startsWith('language-'));
				const lang = langClass ? langClass.replace('language-', '') : '';
				const text = code.textContent || '';
				const lines = text.split(/\r?\n/);
				if (lines.length > 1 && lines[lines.length - 1] === '') {
					lines.pop();
				}
				code.innerHTML = lines.map(line => `<div>${highlightCode(line, lang)}</div>`).join('');
			}
		}

		function processNode(node: Node) {
			if (node.nodeType === Node.ELEMENT_NODE) {
				const tag = (node as HTMLElement).tagName.toUpperCase();
				if (tag === 'PRE' || tag === 'CODE' || tag === 'A') {
					return;
				}
				const children = Array.from(node.childNodes);
				for (const child of children) {
					processNode(child);
				}
			} else if (node.nodeType === Node.TEXT_NODE) {
				const text = node.textContent || '';
				const mentionRegex = /(?:\b|^)@(card|board|\w+)/g;
				if (mentionRegex.test(text)) {
					const fragment = document.createDocumentFragment();
					let lastIndex = 0;
					mentionRegex.lastIndex = 0;
					
					let match;
					while ((match = mentionRegex.exec(text)) !== null) {
						if (match.index > lastIndex) {
							fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
						}
						
						const span = document.createElement('span');
						span.className = 'bg-violet-600/20 text-violet-400 font-semibold px-1.5 py-0.5 rounded mx-0.5 inline-block';
						if (isEditor) {
							span.contentEditable = 'false';
							span.className += ' select-all';
						}
						span.textContent = match[0].trim();
						fragment.appendChild(span);
						
						lastIndex = mentionRegex.lastIndex;
					}
					
					if (lastIndex < text.length) {
						fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
					}
					
					node.parentNode?.replaceChild(fragment, node);
				}
			}
		}

		processNode(doc.body);
		return doc.body.innerHTML;
	}

	function htmlToMarkdown(html: string): string {
		if (typeof document === 'undefined') return html;
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');

		function nodeToMarkdown(node: Node): string {
			if (node.nodeType === Node.TEXT_NODE) {
				return node.textContent || '';
			}
			if (node.nodeType !== Node.ELEMENT_NODE) {
				return '';
			}

			const el = node as HTMLElement;
			const tagName = el.tagName.toUpperCase();

			// Process children first, except for PRE
			let childrenMd = '';
			if (tagName !== 'PRE') {
				for (let i = 0; i < el.childNodes.length; i++) {
					childrenMd += nodeToMarkdown(el.childNodes[i]);
				}
			}

			switch (tagName) {
				case 'H1': return `# ${childrenMd}\n\n`;
				case 'H2': return `## ${childrenMd}\n\n`;
				case 'H3': return `### ${childrenMd}\n\n`;
				case 'STRONG':
				case 'B': return `**${childrenMd}**`;
				case 'EM':
				case 'I': return `*${childrenMd}*`;
				case 'STRIKE':
				case 'S':
				case 'DEL': return `~~${childrenMd}~~`;
				case 'CODE': return `\`${childrenMd}\``;
				case 'PRE': {
					const codeEl = el.querySelector('code');
					let lang = '';
					if (codeEl) {
						const classList = Array.from(codeEl.classList);
						const langClass = classList.find(cls => cls.startsWith('language-'));
						if (langClass) {
							lang = langClass.replace('language-', '');
						}
					}
					let textContent = '';
					const divs = el.querySelectorAll('code > div, pre > div');
					if (divs.length > 0) {
						textContent = Array.from(divs).map(d => d.textContent).join('\n');
					} else {
						textContent = el.textContent || '';
					}
					return `\n\`\`\`${lang}\n${textContent.trim()}\n\`\`\`\n\n`;
				}
				case 'A': return `[${childrenMd}](${el.getAttribute('href') || ''})`;
				case 'IMG': return `![image](${el.getAttribute('src') || ''})`;
				case 'P': return `${childrenMd}\n\n`;
				case 'BR': return '\n';
				case 'LI': {
					const parent = el.parentElement;
					if (parent && parent.tagName.toUpperCase() === 'OL') {
						const siblings = Array.from(parent.children);
						const index = siblings.indexOf(el) + 1;
						return `${index}. ${childrenMd}\n`;
					}
					return `- ${childrenMd}\n`;
				}
				case 'UL':
				case 'OL': return `${childrenMd}\n`;
				case 'DIV': return `${childrenMd}\n`;
				default: return childrenMd;
			}
		}

		let md = '';
		for (let i = 0; i < doc.body.childNodes.length; i++) {
			md += nodeToMarkdown(doc.body.childNodes[i]);
		}

		return md.trim();
	}

	async function handleSaveDesc() {
		if (!card) return;
		try {
			const markdown = htmlToMarkdown(editDescHTML);
			await taskClientStore.updateCardDescription(card.id, markdown);
			isEditingDesc = false;
			editDescHTML = '';
		} catch (e) {
			debug.error('task-client', 'Failed to update description:', e);
		}
	}

	function handleCancelDesc() {
		isEditingDesc = false;
		editDescHTML = '';
	}

	async function handleToggleCheckItem(checklistId: string, itemId: string, currentState: 'complete' | 'incomplete') {
		if (!card) return;
		const newState = currentState === 'complete' ? 'incomplete' : 'complete';
		try {
			await taskClientStore.updateCheckItemState(card.id, checklistId, itemId, newState);
		} catch (e) {
			debug.error('task-client', 'Failed to toggle check item:', e);
		}
	}

	async function handleAddCheckItem(checklistId: string) {
		const val = newCheckItemVals[checklistId];
		if (!val || !val.trim()) return;
		try {
			await taskClientStore.addCheckItem(checklistId, val.trim());
			newCheckItemVals[checklistId] = '';
			activeAddCheckItemId = null;
		} catch (e) {
			debug.error('task-client', 'Failed to add check item:', e);
		}
	}

	async function handleAddComment() {
		if (!card || isCommentEmpty) return;
		try {
			const markdown = htmlToMarkdown(editCommentHTML);
			if (!markdown.trim()) return;
			await taskClientStore.addComment(card.id, markdown);
			editCommentHTML = '';
			commentVal = '';
			isWritingComment = false;
		} catch (e) {
			debug.error('task-client', 'Failed to submit comment:', e);
		}
	}

	async function handleUploadImageForEditor(file: File): Promise<string> {
		if (!card) throw new Error('No active card');
		const created = await taskClientStore.addAttachmentFile(card.id, file);
		if (!created || !created.url) {
			throw new Error('Failed to upload image to Trello');
		}
		return created.url;
	}

	// Checklist actions
	let editingChecklistId = $state<string | null>(null);
	let editChecklistNameVal = $state('');

	function startEditChecklist(checklistId: string, currentName: string) {
		editingChecklistId = checklistId;
		editChecklistNameVal = currentName;
	}

	function cancelEditChecklist() {
		editingChecklistId = null;
		editChecklistNameVal = '';
	}

	async function handleSaveChecklistName(checklistId: string) {
		if (!editChecklistNameVal.trim() || editingChecklistId !== checklistId) return;
		try {
			await taskClientStore.updateChecklistName(checklistId, editChecklistNameVal.trim());
			editingChecklistId = null;
			editChecklistNameVal = '';
		} catch (e) {
			debug.error('task-client', 'Failed to update checklist name:', e);
		}
	}

	let editingCheckItemId = $state<string | null>(null);
	let editCheckItemNameVal = $state('');

	function startEditCheckItem(itemId: string, currentName: string) {
		editingCheckItemId = itemId;
		editCheckItemNameVal = currentName;
	}

	function cancelEditCheckItem() {
		editingCheckItemId = null;
		editCheckItemNameVal = '';
	}

	async function handleSaveCheckItemName(checklistId: string, itemId: string) {
		if (!card || !editCheckItemNameVal.trim() || editingCheckItemId !== itemId) return;
		try {
			await taskClientStore.updateCheckItemName(card.id, checklistId, itemId, editCheckItemNameVal.trim());
			editingCheckItemId = null;
			editCheckItemNameVal = '';
		} catch (e) {
			debug.error('task-client', 'Failed to update check item name:', e);
		}
	}

	async function handleDeleteChecklist(checklistId: string) {
		try {
			await taskClientStore.deleteChecklist(checklistId);
		} catch (e) {
			debug.error('task-client', 'Failed to delete checklist:', e);
		}
	}

	async function handleDeleteCheckItem(checklistId: string, itemId: string) {
		if (!card) return;
		try {
			await taskClientStore.deleteCheckItem(card.id, checklistId, itemId);
		} catch (e) {
			debug.error('task-client', 'Failed to delete check item:', e);
		}
	}

	let hideCheckedMap = $state<Record<string, boolean>>({});
	function toggleHideCheckedItems(checklistId: string) {
		hideCheckedMap[checklistId] = !hideCheckedMap[checklistId];
	}

	// Comment actions
	let editingCommentId = $state<string | null>(null);
	let editExistingCommentHTML = $state('');

	function startEditComment(actionId: string, currentText: string) {
		editingCommentId = actionId;
		editExistingCommentHTML = currentText ? renderMarkdownWithMentions(currentText, true) : '';
	}

	function cancelEditComment() {
		editingCommentId = null;
		editExistingCommentHTML = '';
	}

	async function handleSaveComment(actionId: string) {
		const markdown = htmlToMarkdown(editExistingCommentHTML);
		if (!markdown.trim()) return;
		try {
			await taskClientStore.updateComment(actionId, markdown.trim());
			editingCommentId = null;
			editExistingCommentHTML = '';
		} catch (e) {
			debug.error('task-client', 'Failed to update comment:', e);
		}
	}

	async function handleDeleteComment(actionId: string) {
		if (!card) return;
		if (confirm('Are you sure you want to delete this comment?')) {
			try {
				await taskClientStore.deleteComment(card.id, actionId);
			} catch (e) {
				debug.error('task-client', 'Failed to delete comment:', e);
			}
		}
	}

	// Create Checklist popover
	let showAddChecklistPopover = $state(false);
	let newChecklistName = $state('');
	let boardChecklists = $state<TrelloChecklist[]>([]);
	let loadingChecklists = $state(false);
	let selectedCopyChecklistId = $state('');
	let showCopyDropdown = $state(false);
	let isCreatingChecklist = $state(false);

	// Labels popover state
	let showLabelsPopover = $state(false);
	let labelsPopoverMode = $state<'list' | 'create' | 'edit'>('list');
	let searchLabelQuery = $state('');
	let editingLabelId = $state<string | null>(null);
	let labelFormName = $state('');
	let labelFormColor = $state('green');

	const filteredLabels = $derived(
		taskClientStore.boardLabels.filter(
			(label) =>
				!searchLabelQuery ||
				label.name.toLowerCase().includes(searchLabelQuery.toLowerCase())
		)
	);

	// Members popover state
	let showMembersPopover = $state(false);
	let searchMemberQuery = $state('');

	const filteredMembers = $derived(
		taskClientStore.boardMembers.filter(
			(m) =>
				!searchMemberQuery ||
				m.fullName.toLowerCase().includes(searchMemberQuery.toLowerCase()) ||
				(m.username ?? '').toLowerCase().includes(searchMemberQuery.toLowerCase())
		)
	);

	// Attachment popover state
	let showAttachmentPopover = $state(false);
	let attachLinkUrl = $state('');
	let attachLinkName = $state('');
	let isAttaching = $state(false);
	let attachFileInput: HTMLInputElement | undefined = $state();
	let openAttachmentMenuId = $state<string | null>(null);
	let editingAttachmentId = $state<string | null>(null);
	let editingAttachmentName = $state('');
	let commentSectionEl: HTMLDivElement | undefined = $state();
	let previewAttachment = $state<{ id: string; name: string; url: string; date: string; mimeType: string; bytes?: number; previews: { url: string; width: number; height: number }[] } | null>(null);
	const formattedPreviewDate = $derived(
		previewAttachment ? new Date(previewAttachment.date).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : ''
	);

	function handleWindowKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (previewAttachment) {
				e.preventDefault();
				e.stopPropagation();
				previewAttachment = null;
			}
		}
	}

	const filteredActions = $derived.by(() => {
		const allActions = taskClientStore.activeCardActions;
		if (showActivityDetails) {
			return allActions;
		}
		// Hide details: show all comments, and only the oldest non-comment action (creation/addition)
		const nonComments = allActions.filter(a => a.type !== 'commentCard');
		const oldestNonComment = nonComments.length > 0 ? nonComments[nonComments.length - 1] : null;

		return allActions.filter((action) => {
			if (action.type === 'commentCard') return true;
			if (oldestNonComment && action.id === oldestNonComment.id) return true;
			return false;
		});
	});

	const labelColorMap: Record<string, string> = {
		green: '#61bd4f',
		yellow: '#f2d600',
		orange: '#ff9f1a',
		red: '#eb5a46',
		purple: '#c377e0',
		blue: '#0079bf',
		sky: '#00c2e0',
		lime: '#51e898',
		pink: '#ff78cb',
		black: '#344563'
	};

	const labelColors = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'sky', 'lime', 'pink', 'black'];

	async function handleToggleLabelOnCard(labelId: string) {
		if (!card) return;
		const hasLabel = card.labels.some((l) => l.id === labelId);
		try {
			if (hasLabel) {
				await taskClientStore.removeLabelFromCard(card.id, labelId);
			} else {
				await taskClientStore.addLabelToCard(card.id, labelId);
			}
		} catch (err) {
			debug.error('task-client', 'Failed to toggle label:', err);
		}
	}

	async function handleSaveLabel() {
		if (!labelFormColor) return;
		try {
			if (labelsPopoverMode === 'create') {
				await taskClientStore.createLabel(labelFormName, labelFormColor);
			} else if (labelsPopoverMode === 'edit' && editingLabelId) {
				await taskClientStore.updateLabel(editingLabelId, labelFormName, labelFormColor);
			}
			labelsPopoverMode = 'list';
			editingLabelId = null;
			labelFormName = '';
		} catch (err) {
			debug.error('task-client', 'Failed to save label:', err);
		}
	}

	async function handleDeleteLabel(labelId: string) {
		try {
			await taskClientStore.deleteLabel(labelId);
			labelsPopoverMode = 'list';
			editingLabelId = null;
			labelFormName = '';
		} catch (err) {
			debug.error('task-client', 'Failed to delete label:', err);
		}
	}

	function startCreateLabel() {
		labelsPopoverMode = 'create';
		editingLabelId = null;
		labelFormName = '';
		labelFormColor = 'green';
	}

	function startEditLabel(labelId: string, name: string, color: string) {
		labelsPopoverMode = 'edit';
		editingLabelId = labelId;
		labelFormName = name;
		labelFormColor = color;
	}

	const selectedCopyChecklistLabel = $derived.by(() => {
		if (!selectedCopyChecklistId) return '(none)';
		const cl = boardChecklists.find((c) => c.id === selectedCopyChecklistId);
		if (!cl) return '(none)';
		const cardOfCl = taskClientStore.cards.find((c) => c.id === cl.idCard);
		const cardName = cardOfCl ? cardOfCl.name : 'Unknown Card';
		return `${cardName}: ${cl.name}`;
	});

	interface GroupedChecklist {
		cardId: string;
		cardName: string;
		checklists: TrelloChecklist[];
	}

	const groupedChecklists = $derived.by(() => {
		const groups: GroupedChecklist[] = [];
		for (const cl of boardChecklists) {
			const cardOfCl = taskClientStore.cards.find((c) => c.id === cl.idCard);
			const cardName = cardOfCl ? cardOfCl.name : 'Unknown Card';
			let group = groups.find((g) => g.cardId === cl.idCard);
			if (!group) {
				group = { cardId: cl.idCard, cardName, checklists: [] };
				groups.push(group);
			}
			group.checklists.push(cl);
		}
		return groups;
	});

	$effect(() => {
		if (showAddChecklistPopover) {
			loadingChecklists = true;
			selectedCopyChecklistId = '';
			showCopyDropdown = false;
			taskClientStore.fetchBoardChecklists().then((data) => {
				boardChecklists = data;
				loadingChecklists = false;
			}).catch((err) => {
				debug.error('task-client', 'Failed to fetch board checklists:', err);
				loadingChecklists = false;
			});
		}
	});

	async function handleCreateChecklist() {
		if (!card || !newChecklistName.trim() || isCreatingChecklist) return;
		isCreatingChecklist = true;
		try {
			const copyFromId = selectedCopyChecklistId;
			await taskClientStore.addChecklist(card.id, newChecklistName.trim());
			
			if (copyFromId) {
				const source = boardChecklists.find((cl) => cl.id === copyFromId);
				if (source && source.checkItems && source.checkItems.length > 0) {
					const lastCl = taskClientStore.activeCardChecklists[taskClientStore.activeCardChecklists.length - 1];
					if (lastCl) {
						const sortedItems = [...source.checkItems].sort((a, b) => a.pos - b.pos);
						for (const item of sortedItems) {
							await taskClientStore.addCheckItem(lastCl.id, item.name);
						}
					}
				}
			}
			
			newChecklistName = '';
			selectedCopyChecklistId = '';
			showAddChecklistPopover = false;
		} catch (e) {
			debug.error('task-client', 'Failed to create checklist:', e);
		} finally {
			isCreatingChecklist = false;
		}
	}

	// Due Date popover
	let showDatesPopover = $state(false);
	let datesPopoverSource = $state<'button' | 'badge'>('button');
	let hasStartDate = $state(false);
	let newStartDateVal = $state('');
	let hasDueDate = $state(false);
	let newDueDateVal = $state('');
	let dueReminderVal = $state<number>(-1);
	let recurringVal = $state<string>('Never');

	let calendarYear = $state(new Date().getFullYear());
	let calendarMonth = $state(new Date().getMonth());
	let activeDateField = $state<'start' | 'due'>('due');

	let popoverTop = $state(0);
	let popoverLeft = $state(0);

	function updatePopoverPosition(triggerElement: HTMLElement, popoverHeight = 520) {
		if (!triggerElement) return;
		const triggerRect = triggerElement.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// Calculate viewport-relative left
		let left = triggerRect.left;
		const popoverWidth = 288;
		if (left + popoverWidth > viewportWidth) {
			left = viewportWidth - popoverWidth - 16;
		}
		popoverLeft = Math.max(16, left);

		// Calculate viewport-relative top (flip up if it goes past the bottom boundary)
		if (triggerRect.bottom + popoverHeight > viewportHeight) {
			popoverTop = Math.max(16, triggerRect.top - popoverHeight - 8);
		} else {
			popoverTop = triggerRect.bottom + 8;
		}
	}

	const monthNames = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	function prevMonth() {
		if (calendarMonth === 0) {
			calendarMonth = 11;
			calendarYear -= 1;
		} else {
			calendarMonth -= 1;
		}
	}

	function nextMonth() {
		if (calendarMonth === 11) {
			calendarMonth = 0;
			calendarYear += 1;
		} else {
			calendarMonth += 1;
		}
	}

	function prevYear() {
		calendarYear -= 1;
	}

	function nextYear() {
		calendarYear += 1;
	}

	function selectCalendarDay(day: number, month: number, year: number) {
		const pad = (n: number) => String(n).padStart(2, '0');
		const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
		
		if (activeDateField === 'start') {
			hasStartDate = true;
			const existingTime = newStartDateVal ? newStartDateVal.split('T')[1] : '09:00';
			newStartDateVal = `${dateStr}T${existingTime}`;
		} else {
			hasDueDate = true;
			const existingTime = newDueDateVal ? newDueDateVal.split('T')[1] : '12:00';
			newDueDateVal = `${dateStr}T${existingTime}`;
		}
	}

	function isCellSelected(day: number, month: number, year: number) {
		const val = activeDateField === 'start' ? newStartDateVal : newDueDateVal;
		if (!val) return false;
		const d = new Date(val);
		return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
	}

	const calendarDays = $derived.by(() => {
		const firstDayIndex = new Date(calendarYear, calendarMonth, 1).getDay();
		const totalDays = new Date(calendarYear, calendarMonth + 1, 0).getDate();
		const prevMonthTotalDays = new Date(calendarYear, calendarMonth, 0).getDate();

		const cells = [];

		for (let i = firstDayIndex - 1; i >= 0; i--) {
			const d = prevMonthTotalDays - i;
			const m = calendarMonth === 0 ? 11 : calendarMonth - 1;
			const y = calendarMonth === 0 ? calendarYear - 1 : calendarYear;
			cells.push({ day: d, month: m, year: y, current: false });
		}

		for (let d = 1; d <= totalDays; d++) {
			cells.push({ day: d, month: calendarMonth, year: calendarYear, current: true });
		}

		const remaining = 42 - cells.length;
		for (let d = 1; d <= remaining; d++) {
			const m = calendarMonth === 11 ? 0 : calendarMonth + 1;
			const y = calendarMonth === 11 ? calendarYear + 1 : calendarYear;
			cells.push({ day: d, month: m, year: y, current: false });
		}

		return cells;
	});

	const recurringDayNumber = $derived.by(() => {
		const d = newDueDateVal ? new Date(newDueDateVal) : new Date();
		const dateNum = d.getDate();
		const suffix = (n: number) => {
			if (n > 3 && n < 21) return 'th';
			switch (n % 10) {
				case 1:  return "st";
				case 2:  return "nd";
				case 3:  return "rd";
				default: return "th";
			}
		};
		return `${dateNum}${suffix(dateNum)}`;
	});

	const recurringDayOfWeekDesc = $derived.by(() => {
		const d = newDueDateVal ? new Date(newDueDateVal) : new Date();
		const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		const dayName = daysOfWeek[d.getDay()];
		
		const dateNum = d.getDate();
		const occurrence = Math.ceil(dateNum / 7);
		
		const temp = new Date(d.getTime());
		temp.setDate(temp.getDate() + 7);
		const isLast = temp.getMonth() !== d.getMonth();
		
		const ordinals = ['first', 'second', 'third', 'fourth', 'fifth'];
		const occurrenceWord = ordinals[occurrence - 1] ?? 'first';
		
		if (isLast) {
			return `Monthly on the last ${dayName}`;
		}
		return `Monthly on the ${occurrenceWord} ${dayName}`;
	});

	const recurringYearlyDesc = $derived.by(() => {
		const d = newDueDateVal ? new Date(newDueDateVal) : new Date();
		const monthName = monthNames[d.getMonth()];
		const dateNum = d.getDate();
		const suffix = (n: number) => {
			if (n > 3 && n < 21) return 'th';
			switch (n % 10) {
				case 1:  return "st";
				case 2:  return "nd";
				case 3:  return "rd";
				default: return "th";
			}
		};
		return `Yearly on ${monthName} ${dateNum}${suffix(dateNum)}`;
	});

	$effect(() => {
		if (showDatesPopover && card) {
			if (card.start) {
				hasStartDate = true;
				const d = new Date(card.start);
				const tzoffset = d.getTimezoneOffset() * 60000;
				newStartDateVal = (new Date(d.getTime() - tzoffset)).toISOString().slice(0, 16);
			} else {
				hasStartDate = false;
				newStartDateVal = '';
			}

			if (card.due) {
				hasDueDate = true;
				const d = new Date(card.due);
				const tzoffset = d.getTimezoneOffset() * 60000;
				newDueDateVal = (new Date(d.getTime() - tzoffset)).toISOString().slice(0, 16);
			} else {
				hasDueDate = false;
				newDueDateVal = '';
			}

			if (card.dueReminder !== undefined) {
				dueReminderVal = card.dueReminder ?? -1;
			} else {
				dueReminderVal = -1;
			}

			const savedRecurring = localStorage.getItem(`clopen_trello_card_recurring_${card.id}`);
			recurringVal = savedRecurring || 'Never';

			const initialDate = card.due ? new Date(card.due) : (card.start ? new Date(card.start) : new Date());
			calendarYear = initialDate.getFullYear();
			calendarMonth = initialDate.getMonth();
			activeDateField = card.due ? 'due' : (card.start ? 'start' : 'due');
		}
	});

	async function handleSaveDates() {
		if (!card) return;
		try {
			const startStr = hasStartDate && newStartDateVal ? new Date(newStartDateVal).toISOString() : null;
			const dueStr = hasDueDate && newDueDateVal ? new Date(newDueDateVal).toISOString() : null;
			await taskClientStore.updateCardDates(card.id, startStr, dueStr, dueReminderVal);
			localStorage.setItem(`clopen_trello_card_recurring_${card.id}`, recurringVal);
			showDatesPopover = false;
		} catch (e) {
			debug.error('task-client', 'Failed to save dates:', e);
		}
	}

	async function handleRemoveDates() {
		if (!card) return;
		try {
			await taskClientStore.updateCardDates(card.id, null, null, -1);
			localStorage.removeItem(`clopen_trello_card_recurring_${card.id}`);
			showDatesPopover = false;
		} catch (e) {
			debug.error('task-client', 'Failed to remove dates:', e);
		}
	}



	// Card Actions
	async function handleArchiveCard() {
		if (!card) return;
		if (confirm('Are you sure you want to archive this card?')) {
			try {
				await taskClientStore.archiveCard(card.id);
				onClose();
			} catch (e) {
				debug.error('task-client', 'Failed to archive card:', e);
			}
		}
	}

	async function handleDeleteCard() {
		if (!card) return;
		if (confirm('Are you sure you want to permanently delete this card? This action cannot be undone.')) {
			try {
				await taskClientStore.deleteCard(card.id);
				onClose();
			} catch (e) {
				debug.error('task-client', 'Failed to delete card:', e);
			}
		}
	}

	// Calculate checklist metrics helper
	function getChecklistProgress(checkItems: any[] = []) {
		if (!checkItems || checkItems.length === 0) return { percent: 0, checked: 0, total: 0 };
		const checked = checkItems.filter((i) => i.state === 'complete').length;
		const total = checkItems.length;
		return {
			percent: Math.round((checked / total) * 100),
			checked,
			total
		};
	}

	// Format action content text based on its type
	function formatActionText(action: any) {
		const creator = action.memberCreator?.fullName || 'Someone';
		switch (action.type) {
			case 'createCard':
				return `${creator} created this card`;
			case 'updateCard':
				if (action.data?.listBefore && action.data?.listAfter) {
					return `${creator} moved this card from ${action.data.listBefore.name} to ${action.data.listAfter.name}`;
				}
				if (action.data?.listAfter) {
					return `${creator} added this card to ${action.data.listAfter.name}`;
				}
				if (action.data?.card?.closed !== undefined) {
					return `${creator} ${action.data.card.closed ? 'archived' : 'sent'} this card to the board`;
				}
				if (action.data?.card?.dueComplete !== undefined) {
					return `${creator} marked this card as ${action.data.card.dueComplete ? 'complete' : 'incomplete'}`;
				}
				if (action.data?.old?.due !== undefined || action.data?.card?.due !== undefined) {
					if (action.data.card.due) {
						const d = new Date(action.data.card.due).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
						if (action.data.old?.due) {
							return `${creator} changed the due date of this card to ${d}`;
						} else {
							return `${creator} set this card to be due ${d}`;
						}
					} else {
						return `${creator} removed the due date from this card`;
					}
				}
				return `${creator} updated this card`;
			case 'commentCard':
				return `${creator} commented`;
			case 'addChecklistToCard':
				return `${creator} added Checklist to this card`;
			case 'updateCheckItemStateOnCard':
				const state = action.data?.checkItem?.state;
				const itemName = action.data?.checkItem?.name || 'an item';
				if (state === 'complete') {
					return `${creator} completed ${itemName} on this card`;
				} else {
					return `${creator} marked ${itemName} as incomplete`;
				}
			default:
				return `${creator} performed an action`;
		}
	}

	// Due Date helpers
	function getDateBadgeInfo(startStr: string | null, dueStr: string | null, dueComplete: boolean) {
		const now = new Date();
		let formattedText = '';
		let badge = '';
		let badgeClass = '';

		const formatOptions: Intl.DateTimeFormatOptions = {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			hour12: true
		};

		if (startStr && dueStr) {
			const start = new Date(startStr);
			const due = new Date(dueStr);
			
			const formattedStart = start.toLocaleString('en-US', { month: 'short', day: 'numeric' });
			const formattedDue = due.toLocaleString('en-US', formatOptions);
			formattedText = `${formattedStart} - ${formattedDue}`;
		} else if (startStr) {
			const start = new Date(startStr);
			formattedText = `Starts ${start.toLocaleString('en-US', formatOptions)}`;
		} else if (dueStr) {
			const due = new Date(dueStr);
			formattedText = due.toLocaleString('en-US', formatOptions);
		}

		if (dueStr) {
			const due = new Date(dueStr);
			if (dueComplete) {
				badge = 'Complete';
				badgeClass = 'bg-green-600 text-white';
			} else if (due < now) {
				badge = 'Overdue';
				badgeClass = 'bg-red-500 text-white';
			} else {
				const diffMs = due.getTime() - now.getTime();
				const diffHrs = diffMs / (1000 * 60 * 60);
				if (diffHrs >= 0 && diffHrs <= 24) {
					badge = 'Due soon';
					badgeClass = 'bg-amber-500 text-slate-950';
				}
			}
		}

		return { formattedText, badge, badgeClass };
	}
</script>

<svelte:window onkeydown={handleWindowKeyDown} />

{#if isOpen && card}
	<!-- Backdrop overlay -->
	<div
		class="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
	>
		<!-- Click outside helper -->
		<button
			type="button"
			class="absolute inset-0 bg-transparent border-none w-full h-full cursor-default"
			onclick={onClose}
			aria-label="Close modal"
		></button>

		<!-- Modal Container -->
		<div class="relative w-full max-w-6xl h-[90dvh] max-h-[850px] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col z-10 overflow-hidden text-slate-100 modal-container-el">
			<!-- Header -->
			<header class="flex items-center justify-between px-6 py-4 border-b border-slate-800 shrink-0">
				<!-- List Name Dropdown Muted Indicator -->
				<div class="flex items-center gap-2">
					<div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-xs font-semibold text-slate-300">
						<span>{list?.name || 'List'}</span>
						<Icon name="lucide:chevron-down" class="w-3.5 h-3.5 opacity-60" />
					</div>
				</div>

				<!-- Right Controls -->
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors border-none bg-transparent cursor-pointer"
						aria-label="Watch card"
						title="Watch"
					>
						<Icon name="lucide:eye" class="w-4 h-4" />
					</button>
					<a
						href={card.url}
						target="_blank"
						rel="noopener noreferrer"
						class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
						title="Open in Trello"
					>
						<Icon name="lucide:arrow-up-right" class="w-4 h-4" />
					</a>
					<button
						type="button"
						onclick={onClose}
						class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors border-none bg-transparent cursor-pointer"
						aria-label="Close details"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
			</header>

			<!-- Loading details loader overlay -->
			{#if taskClientStore.loadingDetails}
				<div class="absolute inset-0 top-16 bg-slate-900/60 z-30 flex items-center justify-center gap-2.5 text-slate-400">
					<Icon name="lucide:loader" class="w-5 h-5 animate-spin text-violet-500" />
					<span class="text-sm">Loading details…</span>
				</div>
			{/if}

			<!-- Scrollable content area -->
			<div class="flex-1 overflow-y-auto md:overflow-hidden p-6 md:pr-0 flex flex-col md:flex-row gap-6 md:gap-0">
				<!-- Left main column -->
				<div class="flex-1 flex flex-col gap-6 md:overflow-y-auto md:h-full md:pr-6">
					<!-- Title with complete checkmark toggle -->
					<div class="flex items-start gap-3">
						<button
							type="button"
							onclick={handleToggleDueComplete}
							class="flex items-center justify-center w-6 h-6 rounded-full border hover:border-green-500 transition cursor-pointer shrink-0 mt-1
								{card.dueComplete ? 'bg-green-500 border-green-500' : 'bg-transparent border-slate-700'}"
							title={card.dueComplete ? 'Mark incomplete' : 'Mark complete'}
						>
							{#if card.dueComplete}
								<Icon name="lucide:check" class="w-3.5 h-3.5 text-white stroke-[3]" />
							{/if}
						</button>
						<div class="flex-1 min-w-0">
							<h2 class="text-xl font-bold text-slate-100 leading-tight m-0">{card.name}</h2>
						</div>
					</div>

					<!-- Quick buttons row with Popovers -->
					<div class="flex flex-wrap gap-2 text-xs relative">
						<!-- Labels Button (hidden if labels already shown below) -->
						{#if !(card.labels && card.labels.length > 0)}
						<div class="relative">
							<button
								type="button"
								onclick={() => { showLabelsPopover = !showLabelsPopover; showAddChecklistPopover = false; showDatesPopover = false; }}
								class="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-slate-300 hover:bg-slate-700 transition cursor-pointer
									{showLabelsPopover ? 'bg-slate-700 border-violet-500' : 'bg-slate-800 border-slate-700'}"
							>
								<Icon name="lucide:tag" class="w-3.5 h-3.5" />
								<span>Labels</span>
							</button>

							{#if showLabelsPopover}
								<button
									type="button"
									class="fixed inset-0 z-30 bg-transparent cursor-default border-none w-full h-full"
									onclick={() => showLabelsPopover = false}
									aria-label="Close labels popover"
								></button>

								<div class="absolute left-0 mt-2 z-40 w-72 p-4 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl flex flex-col gap-3">
									{@render labelsPopoverContent()}
								</div>
							{/if}
						</div>
						{/if}

						<!-- Dates Button (hidden if dates already shown below) -->
						{#if !(card.start || card.due)}
						<div>
							<button
								bind:this={datesBtnEl}
								type="button"
								onclick={(e) => {
									if (showDatesPopover && datesPopoverSource === 'button') {
										showDatesPopover = false;
									} else {
										datesPopoverSource = 'button';
										updatePopoverPosition(e.currentTarget as HTMLElement, 520);
										showDatesPopover = true;
									}
									showAddChecklistPopover = false;
								}}
								class="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-slate-300 hover:bg-slate-700 transition cursor-pointer
									{showDatesPopover && datesPopoverSource === 'button' ? 'bg-slate-700 border-violet-500' : 'bg-slate-800 border-slate-700'}"
							>
								<Icon name="lucide:clock" class="w-3.5 h-3.5" />
								<span>Dates</span>
							</button>
						</div>
						{/if}

						<!-- Checklist Button -->
						<div class="relative">
							<button
								type="button"
								onclick={() => { showAddChecklistPopover = !showAddChecklistPopover; showDatesPopover = false; }}
								class="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-slate-300 hover:bg-slate-700 transition cursor-pointer
									{showAddChecklistPopover ? 'bg-slate-700 border-violet-500' : 'bg-slate-800 border-slate-700'}"
							>
								<Icon name="lucide:square-check" class="w-3.5 h-3.5" />
								<span>Checklist</span>
							</button>

							{#if showAddChecklistPopover}
								<button
									type="button"
									class="fixed inset-0 z-30 bg-transparent cursor-default border-none w-full h-full"
									onclick={() => showAddChecklistPopover = false}
									aria-label="Close add checklist popover"
								></button>

								<div class="absolute left-0 mt-2 z-40 w-64 p-4 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl flex flex-col gap-3">
									<h4 class="text-xs font-bold text-slate-200 m-0">Add checklist</h4>
									<div class="flex flex-col gap-1">
										<label for="checklist-name-input" class="text-[10px] text-slate-400 font-semibold">Title</label>
										<input
											id="checklist-name-input"
											type="text"
											placeholder="Checklist"
											bind:value={newChecklistName}
											disabled={isCreatingChecklist}
											onkeydown={(e) => {
												if (e.key === 'Enter') handleCreateChecklist();
												if (e.key === 'Escape') showAddChecklistPopover = false;
											}}
											class="w-full px-2.5 py-1.5 rounded bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50"
										/>
									</div>

									<div class="flex flex-col gap-1 relative">
										<span class="text-[10px] text-slate-400 font-semibold select-none">Copy items from...</span>
										<button
											type="button"
											disabled={isCreatingChecklist}
											onclick={() => showCopyDropdown = !showCopyDropdown}
											class="w-full px-2.5 py-1.5 rounded bg-slate-900 border border-slate-700 text-slate-200 text-xs text-left flex items-center justify-between cursor-pointer focus:outline-none focus:ring-1 focus:ring-violet-500 animate-none disabled:opacity-50 disabled:cursor-not-allowed"
										>
											<span class="truncate">{selectedCopyChecklistLabel}</span>
											<Icon name="lucide:chevron-down" class="w-3.5 h-3.5 text-slate-400 shrink-0" />
										</button>

										{#if showCopyDropdown}
											<button
												type="button"
												class="fixed inset-0 z-40 bg-transparent cursor-default border-none w-full h-full"
												onclick={() => showCopyDropdown = false}
											></button>

											<div class="absolute left-0 right-0 top-full mt-1 z-50 max-h-48 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl py-1">
												<button
													type="button"
													onclick={() => {
														selectedCopyChecklistId = '';
														showCopyDropdown = false;
													}}
													class="w-full px-3 py-1.5 text-left text-xs hover:bg-slate-800 transition-colors border-none bg-transparent cursor-pointer flex items-center justify-between"
												>
													<span class={!selectedCopyChecklistId ? 'text-violet-400 font-medium' : 'text-slate-300'}>(none)</span>
												</button>

												{#if loadingChecklists}
													<div class="px-3 py-2 text-xs text-slate-500 text-center">Loading checklists...</div>
												{:else if groupedChecklists.length === 0}
													<div class="px-3 py-2 text-xs text-slate-500 text-center">No checklists on board</div>
												{:else}
													{#each groupedChecklists as group}
														<div class="first:mt-1">
															<span class="text-[10px] text-slate-400 font-semibold px-3 py-1 select-none block truncate">
																{group.cardName}
															</span>
															{#each group.checklists as cl}
																{@const isSelected = selectedCopyChecklistId === cl.id}
																<button
																	type="button"
																	onclick={() => {
																		selectedCopyChecklistId = cl.id;
																		showCopyDropdown = false;
																	}}
																	class="w-full pl-6 pr-3 py-1.5 text-left text-xs hover:bg-slate-800 {isSelected ? 'text-violet-400 font-medium' : 'text-slate-300'} transition-colors border-none bg-transparent cursor-pointer flex items-center justify-between"
																>
																	<span class="truncate">
																		{cl.name}
																	</span>
																</button>
															{/each}
														</div>
													{/each}
												{/if}
											</div>
										{/if}
									</div>

									<div class="text-[10px]">
										<button
											type="button"
											disabled={isCreatingChecklist || !newChecklistName.trim()}
											onclick={handleCreateChecklist}
											class="w-full py-1.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded transition cursor-pointer border-none flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
										>
											{#if isCreatingChecklist}
												<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
												<span>Adding...</span>
											{:else}
												<span>Add</span>
											{/if}
										</button>
									</div>
								</div>
							{/if}
						</div>

				<!-- Members Button (hidden if members already shown below) -->
				{#if !(card.members && card.members.length > 0)}
				<div class="relative">
					<button
						type="button"
						onclick={() => { showMembersPopover = !showMembersPopover; showLabelsPopover = false; showAddChecklistPopover = false; showDatesPopover = false; }}
						class="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-slate-300 hover:bg-slate-700 transition cursor-pointer
							{showMembersPopover ? 'bg-slate-700 border-violet-500' : 'bg-slate-800 border-slate-700'}"
					>
						<Icon name="lucide:user-plus" class="w-3.5 h-3.5" />
						<span>Members</span>
					</button>

					{#if showMembersPopover}
						<button
							type="button"
							class="fixed inset-0 z-30 bg-transparent cursor-default border-none w-full h-full"
							onclick={() => showMembersPopover = false}
							aria-label="Close members popover"
						></button>

						<div class="absolute left-0 mt-2 z-40 w-72 p-4 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl flex flex-col gap-3">
							<!-- Header -->
							<div class="flex items-center justify-between">
								<h4 class="text-xs font-bold text-slate-200 m-0">Members</h4>
								<button
									type="button"
									onclick={() => showMembersPopover = false}
									class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition border-none bg-transparent cursor-pointer"
									aria-label="Close members popover"
								>
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							</div>

							<!-- Search -->
							<input
								type="text"
								placeholder="Search members"
								bind:value={searchMemberQuery}
								class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-500"
							/>

							<!-- Board Members List -->
							<div class="flex flex-col gap-1">
								<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Board members</span>
								{#if filteredMembers.length === 0}
									<div class="text-slate-500 text-xs py-2 text-center">No members found</div>
								{:else}
									{#each filteredMembers as member}
										{@const isAssigned = card?.members.some(m => m.id === member.id)}
										<button
											type="button"
											onclick={async () => {
												if (isAssigned) {
													await taskClientStore.removeMemberFromCard(card.id, member.id);
												} else {
													await taskClientStore.addMemberToCard(card.id, member.id);
												}
											}}
											class="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-slate-800 transition cursor-pointer border-none bg-transparent w-full text-left
												{isAssigned ? 'bg-slate-800/60' : ''}"
										>
											<!-- Avatar -->
											{#if member.avatarUrl}
												<img
													src="{member.avatarUrl}/30.png"
													alt={member.fullName}
													class="w-7 h-7 rounded-full object-cover border border-slate-700 shrink-0"
												/>
											{:else}
												<div class="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-[11px] font-bold text-white border border-slate-700 shrink-0">
													{member.fullName.charAt(0).toUpperCase()}
												</div>
											{/if}
											<!-- Name -->
											<span class="flex-1 text-xs text-slate-200 truncate">{member.fullName}</span>
											<!-- Check if assigned -->
											{#if isAssigned}
												<div class="w-4 h-4 rounded-full bg-violet-600 flex items-center justify-center shrink-0">
													<Icon name="lucide:check" class="w-2.5 h-2.5 text-white stroke-[3]" />
												</div>
											{/if}
										</button>
									{/each}
								{/if}
							</div>
						</div>
					{/if}
				</div>
				{/if}

				<!-- Attachment Button -->
				<div class="relative">
					<!-- Hidden file input -->
					<input
						bind:this={attachFileInput}
						type="file"
						class="hidden"
						onchange={async (e) => {
							const file = (e.currentTarget as HTMLInputElement).files?.[0];
							if (!file) return;
							isAttaching = true;
							try {
								await taskClientStore.addAttachmentFile(card.id, file);
								showAttachmentPopover = false;
							} catch { /* error logged in store */ } finally {
								isAttaching = false;
								if (attachFileInput) attachFileInput.value = '';
							}
						}}
					/>

					<button
						type="button"
						onclick={() => { showAttachmentPopover = !showAttachmentPopover; showLabelsPopover = false; showAddChecklistPopover = false; showDatesPopover = false; showMembersPopover = false; }}
						class="flex items-center gap-1 px-3 py-1.5 rounded-lg border text-slate-300 hover:bg-slate-700 transition cursor-pointer
							{showAttachmentPopover ? 'bg-slate-700 border-violet-500' : 'bg-slate-800 border-slate-700'}"
					>
						<Icon name="lucide:paperclip" class="w-3.5 h-3.5" />
						<span>Attachment</span>
					</button>

					{#if showAttachmentPopover}
						<button
							type="button"
							class="fixed inset-0 z-30 bg-transparent cursor-default border-none w-full h-full"
							onclick={() => showAttachmentPopover = false}
							aria-label="Close attachment popover"
						></button>

						<div class="absolute left-0 mt-2 z-40 w-80 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl flex flex-col overflow-hidden">
							<!-- Header -->
							<div class="flex items-center justify-between px-4 py-3 border-b border-slate-800">
								<h4 class="text-xs font-bold text-slate-200 m-0">Attach</h4>
								<button
									type="button"
									onclick={() => showAttachmentPopover = false}
									class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition border-none bg-transparent cursor-pointer"
									aria-label="Close attachment popover"
								>
									<Icon name="lucide:x" class="w-3.5 h-3.5" />
								</button>
							</div>

							<div class="flex flex-col gap-4 p-4">
								<!-- File upload section -->
								<div class="flex flex-col gap-1.5">
									<span class="text-xs font-bold text-slate-200">Attach a file from your computer</span>
									<span class="text-[11px] text-slate-500">You can also drag and drop files to upload them.</span>
									<button
										type="button"
										disabled={isAttaching}
										onclick={() => attachFileInput?.click()}
										class="w-full py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-semibold transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
									>
										{#if isAttaching}
											<Icon name="lucide:loader" class="w-3.5 h-3.5 animate-spin" />
											<span>Uploading...</span>
										{:else}
											<span>Choose a file</span>
										{/if}
									</button>
								</div>

								<!-- Divider -->
								<div class="border-t border-slate-800"></div>

								<!-- Link section -->
								<div class="flex flex-col gap-3">
									<div class="flex flex-col gap-1">
										<label for="attach-url-input" class="text-xs font-bold text-slate-200">
											Search or paste a link <span class="text-red-400">*</span>
										</label>
										<input
											id="attach-url-input"
											type="url"
											placeholder="Find recent links or paste a new link"
											bind:value={attachLinkUrl}
											class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-500"
										/>
									</div>

									<div class="flex flex-col gap-1">
										<label for="attach-name-input" class="text-xs font-bold text-slate-200">Display text (optional)</label>
										<input
											id="attach-name-input"
											type="text"
											placeholder="Text to display"
											bind:value={attachLinkName}
											class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-500"
										/>
										<span class="text-[10px] text-slate-500">Give this link a title or description</span>
									</div>
								</div>

								<!-- Recently viewed boards -->
								{#if taskClientStore.recentBoards.length > 0}
									<div class="flex flex-col gap-1.5">
										<span class="text-xs font-bold text-slate-200">Recently viewed</span>
										<div class="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
											{#each taskClientStore.recentBoards.slice(0, 5) as board}
												<button
													type="button"
													onclick={() => {
														attachLinkUrl = `https://trello.com/b/${board.id}`;
														attachLinkName = attachLinkName || board.name;
													}}
													class="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-slate-800 transition cursor-pointer border-none bg-transparent text-left w-full"
												>
													<div class="w-7 h-5 rounded shrink-0 flex items-center justify-center" style="background-color: {board.prefs?.backgroundColor ?? '#0079bf'}">
														<Icon name="lucide:layout-dashboard" class="w-3 h-3 text-white/80" />
													</div>
													<div class="flex flex-col min-w-0">
														<span class="text-xs font-semibold text-slate-200 truncate">{board.name}</span>
														<span class="text-[10px] text-slate-500">{board.accountName}</span>
													</div>
												</button>
											{/each}
										</div>
									</div>
								{/if}
							</div>

							<!-- Footer -->
							<div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-800">
								<button
									type="button"
									onclick={() => { showAttachmentPopover = false; attachLinkUrl = ''; attachLinkName = ''; }}
									class="px-4 py-1.5 text-xs font-semibold text-slate-300 hover:text-slate-100 bg-transparent hover:bg-slate-800 rounded-lg transition cursor-pointer border-none"
								>
									Cancel
								</button>
								<button
									type="button"
									disabled={!attachLinkUrl.trim() || isAttaching}
									onclick={async () => {
										if (!attachLinkUrl.trim()) return;
										isAttaching = true;
										try {
											await taskClientStore.addAttachmentUrl(card.id, attachLinkUrl.trim(), attachLinkName.trim() || undefined);
											showAttachmentPopover = false;
											attachLinkUrl = '';
											attachLinkName = '';
										} catch { /* error logged in store */ } finally {
											isAttaching = false;
										}
									}}
									class="px-4 py-1.5 text-xs font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-lg transition cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
								>
									{#if isAttaching}
										<Icon name="lucide:loader" class="w-3 h-3 animate-spin" />
									{/if}
									Insert
								</button>
							</div>
						</div>
					{/if}
				</div>
					</div>

					<!-- Members and Labels row -->
					<div class="flex flex-wrap gap-6 border-b border-slate-800 pb-5">
						<!-- Members -->
						{#if card.members && card.members.length > 0}
							<div class="flex flex-col gap-1.5 relative">
								<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Members</span>
								<div class="flex items-center gap-1.5">
									{#each card.members as member}
										{#if member.avatarUrl}
											<img src="{member.avatarUrl}/30.png" alt={member.fullName} title={member.fullName} class="w-7 h-7 rounded-full object-cover border border-slate-700" />
										{:else}
											<div class="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-xs font-bold text-white border border-slate-700" title={member.fullName}>
												{member.fullName.charAt(0).toUpperCase()}
											</div>
										{/if}
									{/each}
									<button
										type="button"
										onclick={() => { showMembersPopover = !showMembersPopover; showLabelsPopover = false; showDatesPopover = false; }}
										class="flex items-center justify-center w-7 h-7 rounded-full border border-dashed hover:border-slate-500 text-slate-400 hover:text-slate-200 transition cursor-pointer bg-transparent
											{showMembersPopover ? 'border-violet-500' : 'border-slate-700'}"
									>
										<Icon name="lucide:plus" class="w-3.5 h-3.5" />
									</button>
								</div>

								{#if showMembersPopover}
									<button
										type="button"
										class="fixed inset-0 z-30 bg-transparent cursor-default border-none w-full h-full"
										onclick={() => showMembersPopover = false}
										aria-label="Close members popover"
									></button>
									<div class="absolute left-0 top-full mt-2 z-40 w-72 p-4 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl flex flex-col gap-3">
										<!-- Header -->
										<div class="flex items-center justify-between">
											<h4 class="text-xs font-bold text-slate-200 m-0">Members</h4>
											<button
												type="button"
												onclick={() => showMembersPopover = false}
												class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition border-none bg-transparent cursor-pointer"
												aria-label="Close members popover"
											>
												<Icon name="lucide:x" class="w-3.5 h-3.5" />
											</button>
										</div>
										<!-- Search -->
										<input
											type="text"
											placeholder="Search members"
											bind:value={searchMemberQuery}
											class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-500"
										/>
										<!-- Board Members List -->
										<div class="flex flex-col gap-1">
											<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Board members</span>
											{#if filteredMembers.length === 0}
												<div class="text-slate-500 text-xs py-2 text-center">No members found</div>
											{:else}
												{#each filteredMembers as member}
													{@const isAssigned = card?.members.some(m => m.id === member.id)}
													<button
														type="button"
														onclick={async () => {
															if (isAssigned) {
																await taskClientStore.removeMemberFromCard(card.id, member.id);
															} else {
																await taskClientStore.addMemberToCard(card.id, member.id);
															}
														}}
														class="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-slate-800 transition cursor-pointer border-none bg-transparent w-full text-left
															{isAssigned ? 'bg-slate-800/60' : ''}"
													>
														{#if member.avatarUrl}
															<img src="{member.avatarUrl}/30.png" alt={member.fullName} class="w-7 h-7 rounded-full object-cover border border-slate-700 shrink-0" />
														{:else}
															<div class="w-7 h-7 rounded-full bg-violet-600 flex items-center justify-center text-[11px] font-bold text-white border border-slate-700 shrink-0">
																{member.fullName.charAt(0).toUpperCase()}
															</div>
														{/if}
														<span class="flex-1 text-xs text-slate-200 truncate">{member.fullName}</span>
														{#if isAssigned}
															<div class="w-4 h-4 rounded-full bg-violet-600 flex items-center justify-center shrink-0">
																<Icon name="lucide:check" class="w-2.5 h-2.5 text-white stroke-[3]" />
															</div>
														{/if}
													</button>
												{/each}
											{/if}
										</div>
									</div>
								{/if}
							</div>
						{/if}

						<!-- Labels -->
						{#if card.labels && card.labels.length > 0}
							<div class="flex flex-col gap-1.5 relative">
								<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Labels</span>
								<div class="flex items-center gap-1.5 flex-wrap">
									{#each card.labels as label}
										{@const labelColorMap: Record<string, string> = {
											'green': '#61bd4f', 'yellow': '#f2d600', 'orange': '#ff9f1a',
											'red': '#eb5a46', 'purple': '#c377e0', 'blue': '#0079bf',
											'sky': '#00c2e0', 'lime': '#51e898', 'pink': '#ff78cb', 'black': '#344563'
										}}
										{@const bg = labelColorMap[label.color] ?? label.color ?? '#6b7280'}
										<span
											class="text-sm font-bold h-8 min-w-[48px] px-3 rounded flex items-center justify-center text-white shadow-sm
												{taskClientStore.colorblindMode ? `colorblind-pattern-${label.color}` : ''}"
											style="background-color: {bg}"
										>
											<span>{label.name || ''}</span>
										</span>
									{/each}
									<button
										type="button"
										onclick={() => { showLabelsPopover = !showLabelsPopover; showAddChecklistPopover = false; showDatesPopover = false; showMembersPopover = false; }}
										class="flex items-center justify-center w-8 h-8 rounded hover:bg-slate-700/80 border hover:border-slate-600 text-slate-400 hover:text-slate-200 transition cursor-pointer
											{showLabelsPopover ? 'bg-slate-700/80 border-violet-500' : 'bg-slate-800/80 border-slate-700/60'}"
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
									</button>
								</div>

								{#if showLabelsPopover}
									<button
										type="button"
										class="fixed inset-0 z-30 bg-transparent cursor-default border-none w-full h-full"
										onclick={() => showLabelsPopover = false}
										aria-label="Close labels popover"
									></button>
									<div class="absolute left-0 top-full mt-2 z-40 w-72 p-4 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl flex flex-col gap-3">
										{@render labelsPopoverContent()}
									</div>
								{/if}
							</div>
						{/if}

						<!-- Dates Section (if either start or due is set) -->
						{#if card.start || card.due}
							{@const dateInfo = getDateBadgeInfo(card.start, card.due, card.dueComplete)}
							<div class="flex flex-col gap-1.5">
								<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
									{card.start && card.due ? 'Dates' : (card.start ? 'Start date' : 'Due date')}
								</span>
								<div class="flex items-center">
									<!-- Clickable date badge button to open popover -->
									<button
										bind:this={datesBadgeBtnEl}
										type="button"
										onclick={(e) => {
											if (showDatesPopover && datesPopoverSource === 'badge') {
												showDatesPopover = false;
											} else {
												datesPopoverSource = 'badge';
												updatePopoverPosition(e.currentTarget as HTMLElement, 520);
												showDatesPopover = true;
											}
											showAddChecklistPopover = false;
										}}
										class="flex items-center bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/60 hover:border-slate-600 rounded-lg px-2.5 py-1.5 gap-2 text-xs text-slate-200 transition-colors cursor-pointer font-medium select-none"
									>
										<span>{dateInfo.formattedText}</span>
										{#if dateInfo.badge}
											<span class="px-1.5 py-0.5 rounded text-[9px] font-bold text-white uppercase tracking-wide {dateInfo.badgeClass}">
												{dateInfo.badge}
											</span>
										{/if}
										<Icon name="lucide:chevron-down" class="w-3.5 h-3.5 text-slate-400" />
									</button>
								</div>
							</div>
						{/if}
					</div>

					<!-- Description Section -->
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2 text-slate-200 font-bold text-sm">
								<Icon name="lucide:align-left" class="w-4 h-4 text-slate-400" />
								<span>Description</span>
							</div>
							{#if !isEditingDesc && card.desc}
								<button
									type="button"
									onclick={() => { isEditingDesc = true; editDescHTML = card.desc ? renderMarkdownWithMentions(card.desc, true) : ''; }}
									class="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded transition cursor-pointer border-none"
								>
									Edit
								</button>
							{/if}
						</div>

						{#if isEditingDesc}
							<div class="flex flex-col gap-2 mt-1 pl-6 relative">
								<RichTextEditor
									bind:html={editDescHTML}
									placeholder="Need formatting help? Type /help."
									showDirectLinkImage={true}
									showMarkdownIcon={true}
									enableCodeToolbar={true}
									mentionOptions={mentionOptions}
									onImageUpload={handleUploadImageForEditor}
								/>

								<div class="flex items-center gap-1.5 mt-2">
									<button
										type="button"
										onclick={handleSaveDesc}
										class="px-4 py-1.5 text-sm bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded-lg transition-colors cursor-pointer border-none"
									>
										Save
									</button>
									<button
										type="button"
										onclick={handleCancelDesc}
										class="px-3 py-1.5 text-sm bg-transparent hover:bg-slate-800 hover:text-slate-200 text-slate-400 font-semibold rounded-lg transition-colors cursor-pointer border-none"
									>
										Cancel
									</button>
								</div>
							</div>
						{:else}
							{#if card.desc}
								<div class="pl-6">
									<button
										type="button"
										onclick={() => { isEditingDesc = true; editDescHTML = card.desc ? renderMarkdownWithMentions(card.desc, true) : ''; }}
										class="w-full text-left bg-transparent hover:bg-slate-800/30 rounded-lg p-2 -ml-2 text-sm leading-relaxed text-slate-300 cursor-pointer transition-colors border-none markdown-preview-container"
									>
										{@html renderMarkdownWithMentions(card.desc, false)}
									</button>
								</div>
							{:else}
								<div class="pl-6">
									<button
										type="button"
										onclick={() => { isEditingDesc = true; editDescHTML = ''; }}
										class="w-full text-left bg-slate-800/20 hover:bg-slate-800/40 border border-slate-800/80 hover:border-slate-700 rounded-lg px-4 py-3 text-sm text-slate-400 hover:text-slate-300 cursor-pointer transition-colors select-none leading-relaxed min-h-[56px] border-solid"
									>
										Add a more detailed description...
									</button>
								</div>
							{/if}
						{/if}
					</div>

				<!-- Attachments Section -->
				{#if taskClientStore.activeCardAttachments.length > 0}
					<div class="flex flex-col gap-3">
						<!-- Header -->
						<div class="flex items-center justify-between">
							<div class="flex items-center gap-2 text-slate-200 font-bold text-sm">
								<Icon name="lucide:paperclip" class="w-4 h-4 text-slate-400" />
								<span>Attachments</span>
							</div>
							<!-- Add button opens attachment popover -->
							<button
								type="button"
								onclick={() => { showAttachmentPopover = !showAttachmentPopover; showLabelsPopover = false; showAddChecklistPopover = false; showDatesPopover = false; showMembersPopover = false; }}
								class="px-3 py-1 text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg transition cursor-pointer"
							>
								Add
							</button>
						</div>

						<!-- Attachment list -->
						<div class="flex flex-col gap-2 pl-6">
							{#each taskClientStore.activeCardAttachments as attachment}
								{@const isImage = attachment.mimeType?.startsWith('image/') || attachment.previews?.length > 0}
								{@const thumbUrl = attachment.previews?.find(p => p.width >= 150)?.url ?? attachment.previews?.[0]?.url}
								{@const addedDate = new Date(attachment.date)}
								{@const minutesAgo = Math.round((Date.now() - addedDate.getTime()) / 60000)}
								{@const timeLabel = minutesAgo < 1 ? 'Added just now' : minutesAgo < 60 ? `Added ${minutesAgo}m ago` : minutesAgo < 1440 ? `Added ${Math.round(minutesAgo/60)}h ago` : `Added ${addedDate.toLocaleDateString()}`}

								<div class="flex items-center gap-3 group py-1">
									<!-- Thumbnail -->
									<button
										type="button"
										onclick={() => { previewAttachment = attachment; }}
										class="w-16 h-12 rounded-lg border border-slate-700 bg-slate-800 flex items-center justify-center shrink-0 overflow-hidden hover:border-slate-600 transition cursor-pointer p-0"
									>
										{#if isImage && thumbUrl}
											<img src={thumbUrl} alt={attachment.name} class="w-full h-full object-cover" />
										{:else}
											<div class="flex flex-col items-center gap-0.5">
												<Icon name="lucide:file" class="w-5 h-5 text-slate-400" />
												<span class="text-[9px] text-slate-500 uppercase font-bold truncate max-w-[56px] px-1">
													{attachment.name.split('.').pop() ?? 'file'}
												</span>
											</div>
										{/if}
									</button>

									<!-- Info -->
									<div class="flex flex-col gap-0.5 flex-1 min-w-0">
										<button
											type="button"
											onclick={() => { previewAttachment = attachment; }}
											class="text-xs font-semibold text-slate-200 truncate hover:underline text-left cursor-pointer border-none bg-transparent p-0 m-0 w-fit max-w-full"
										>
											{attachment.name}
										</button>
										<span class="text-[11px] text-slate-500">{timeLabel}</span>
									</div>

									<!-- Actions -->
									<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition shrink-0 relative">
										<!-- External link -->
										<a
											href={attachment.url}
											target="_blank"
											rel="noopener noreferrer"
											class="flex items-center justify-center w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 transition"
											title="Open in browser"
										>
											<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
										</a>

										<!-- "..." menu button -->
										<button
											type="button"
											onclick={(e) => { e.stopPropagation(); openAttachmentMenuId = openAttachmentMenuId === attachment.id ? null : attachment.id; }}
											class="flex items-center justify-center w-7 h-7 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-slate-200 transition cursor-pointer
												{openAttachmentMenuId === attachment.id ? 'bg-slate-700 border-slate-600 text-slate-200' : ''}"
											title="More options"
										>
											<Icon name="lucide:ellipsis" class="w-3.5 h-3.5" />
										</button>

										<!-- Dropdown menu -->
										{#if openAttachmentMenuId === attachment.id}
											<button
												type="button"
												class="fixed inset-0 z-30 bg-transparent cursor-default border-none w-full h-full"
												onclick={() => { openAttachmentMenuId = null; editingAttachmentId = null; }}
												aria-label="Close attachment menu"
											></button>

											{#if editingAttachmentId === attachment.id}
												<!-- Edit attachment panel -->
												<div class="absolute right-0 top-full mt-1 z-40 w-72 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl p-4 flex flex-col gap-3">
													<div class="flex items-center gap-2">
														<button
															type="button"
															onclick={() => { editingAttachmentId = null; }}
															class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition border-none bg-transparent cursor-pointer shrink-0"
															aria-label="Back"
														>
															<Icon name="lucide:chevron-left" class="w-4 h-4" />
														</button>
														<span class="flex-1 text-center text-sm font-bold text-slate-200">Edit attachment</span>
														<button
															type="button"
															onclick={() => { openAttachmentMenuId = null; editingAttachmentId = null; }}
															class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition border-none bg-transparent cursor-pointer shrink-0"
															aria-label="Close"
														>
															<Icon name="lucide:x" class="w-4 h-4" />
														</button>
													</div>
													<div class="flex flex-col gap-1.5">
														<label class="text-xs font-bold text-slate-300">File name</label>
														<input
															type="text"
															bind:value={editingAttachmentName}
															class="w-full px-3 py-2.5 rounded-lg bg-slate-800 border-2 border-blue-500 text-slate-200 text-sm focus:outline-none"
														/>
													</div>
													<button
														type="button"
														onclick={async () => {
															if (!editingAttachmentName.trim()) return;
															await taskClientStore.renameAttachment(card.id, attachment.id, editingAttachmentName.trim());
															openAttachmentMenuId = null;
															editingAttachmentId = null;
														}}
														class="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition cursor-pointer border-none"
													>
														Update
													</button>
												</div>
											{:else}
												<!-- Menu list -->
												<div class="absolute right-0 top-full mt-1 z-40 w-44 rounded-xl border border-slate-700 bg-slate-900 shadow-2xl overflow-hidden py-1">
													<button
														type="button"
														onclick={() => { editingAttachmentId = attachment.id; editingAttachmentName = attachment.name; }}
														class="w-full text-left px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-800 transition cursor-pointer border-none bg-transparent"
													>
														Edit
													</button>
													<button
														type="button"
														onclick={() => {
															openAttachmentMenuId = null;
															editCommentHTML = `<a href="${attachment.url}">${attachment.name || attachment.url}</a>`;
															isWritingComment = true;
															setTimeout(() => commentSectionEl?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
														}}
														class="w-full text-left px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-800 transition cursor-pointer border-none bg-transparent"
													>
														Comment
													</button>
													<a
														href={attachment.url}
														download={attachment.name}
														onclick={() => openAttachmentMenuId = null}
														class="block w-full text-left px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-800 transition cursor-pointer no-underline"
													>
														Download
													</a>
													<button
														type="button"
														onclick={async () => { openAttachmentMenuId = null; await taskClientStore.deleteAttachment(card.id, attachment.id); }}
														class="w-full text-left px-4 py-2.5 text-sm text-red-400 hover:bg-slate-800 transition cursor-pointer border-none bg-transparent"
													>
														Remove
													</button>
												</div>
											{/if}
										{/if}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

					<!-- Checklists Section -->
					{#if taskClientStore.activeCardChecklists && taskClientStore.activeCardChecklists.length > 0}
						<div class="flex flex-col gap-6 mt-2">
							{#each taskClientStore.activeCardChecklists as checklist}
								{@const progress = getChecklistProgress(checklist.checkItems)}
								<div class="flex flex-col gap-3">
									<!-- Checklist Header -->
									<div class="flex items-center justify-between">
										<div class="flex items-center gap-2 text-slate-200 font-bold text-sm flex-1 min-w-0 mr-4">
											<Icon name="lucide:square-check" class="w-4 h-4 text-slate-400 shrink-0" />
											{#if editingChecklistId === checklist.id}
												<div class="flex-1">
													<input
														type="text"
														bind:value={editChecklistNameVal}
														onkeydown={(e) => {
															if (e.key === 'Enter') handleSaveChecklistName(checklist.id);
															if (e.key === 'Escape') cancelEditChecklist();
														}}
														onblur={() => handleSaveChecklistName(checklist.id)}
														autofocus
														class="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-sm font-semibold text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
													/>
												</div>
											{:else}
												<button
													type="button"
													onclick={() => startEditChecklist(checklist.id, checklist.name)}
													class="text-left font-bold text-slate-200 hover:text-slate-100 hover:bg-slate-800/50 px-1 rounded transition-colors cursor-pointer border-none bg-transparent m-0 truncate flex-1 leading-normal"
													title="Click to edit checklist title"
												>
													{checklist.name}
												</button>
											{/if}
										</div>
										<div class="flex items-center gap-2 shrink-0">
											{#if checklist.checkItems && checklist.checkItems.some((i) => i.state === 'complete')}
												<button
													type="button"
													onclick={() => toggleHideCheckedItems(checklist.id)}
													class="px-2.5 py-1 text-xs bg-slate-800/80 hover:bg-slate-700 text-slate-300 font-semibold rounded transition border border-slate-700/50 cursor-pointer"
												>
													{hideCheckedMap[checklist.id] ? 'Show checked items' : 'Hide checked items'}
												</button>
											{/if}
											<button
												type="button"
												onclick={() => handleDeleteChecklist(checklist.id)}
												class="px-2.5 py-1 text-xs bg-slate-800/80 hover:bg-red-950/20 border border-slate-700/50 hover:border-red-900/30 text-slate-300 hover:text-red-400 rounded transition cursor-pointer"
											>
												Delete
											</button>
										</div>
									</div>

									<!-- Checklist Progress Bar -->
									<div class="flex items-center gap-3">
										<span
											class="text-xs font-bold text-slate-500 w-8"
											class:text-green-500={progress.percent === 100}
										>
											{progress.percent}%
										</span>
										<div class="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
											<div
												class="h-full bg-violet-500 transition-all duration-300"
												class:bg-green-500={progress.percent === 100}
												style="width: {progress.percent}%"
											></div>
										</div>
									</div>

									<!-- Check Items list -->
									{#if checklist.checkItems && checklist.checkItems.length > 0}
										{@const displayedItems = hideCheckedMap[checklist.id]
											? checklist.checkItems.filter((i) => i.state !== 'complete')
											: checklist.checkItems}
										{#if displayedItems.length > 0}
											<div class="flex flex-col gap-1 pl-6">
												{#each displayedItems as item}
													<div class="group flex items-center justify-between gap-2.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800/30 px-1.5 rounded transition-colors">
														{#if editingCheckItemId === item.id}
															<div class="flex-grow flex flex-col gap-2 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800 max-w-lg">
																<textarea
																	bind:value={editCheckItemNameVal}
																	onkeydown={(e) => {
																		if (e.key === 'Enter' && !e.shiftKey) {
																			e.preventDefault();
																			handleSaveCheckItemName(checklist.id, item.id);
																		}
																		if (e.key === 'Escape') cancelEditCheckItem();
																	}}
																	autofocus
																	class="w-full min-h-14 p-2 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 resize-y leading-relaxed font-sans"
																></textarea>
																<div class="flex items-center justify-between gap-3 mt-0.5">
																	<div class="flex items-center gap-2">
																		<button
																			type="button"
																			onclick={() => handleSaveCheckItemName(checklist.id, item.id)}
																			class="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded-lg transition cursor-pointer border-none"
																		>
																			Save
																		</button>
																		<button
																			type="button"
																			onclick={cancelEditCheckItem}
																			class="px-2.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 font-semibold rounded-lg transition cursor-pointer bg-transparent border-none"
																		>
																			Cancel
																		</button>
																	</div>
																	<div class="flex items-center gap-2.5 text-[10px] text-slate-400">
																		<button type="button" class="flex items-center gap-1 bg-transparent hover:bg-slate-800 border-none text-slate-400 hover:text-slate-200 cursor-pointer py-1 px-1.5 rounded">
																			<Icon name="lucide:user-plus" class="w-3.5 h-3.5" />
																			<span>Assign</span>
																		</button>
																		<button type="button" class="flex items-center gap-1 bg-transparent hover:bg-slate-800 border-none text-slate-400 hover:text-slate-200 cursor-pointer py-1 px-1.5 rounded">
																			<Icon name="lucide:clock" class="w-3.5 h-3.5" />
																			<span>Due date</span>
																		</button>
																		<button type="button" class="bg-transparent hover:bg-slate-800 border-none text-slate-400 hover:text-slate-200 cursor-pointer p-1 rounded">
																			<Icon name="lucide:ellipsis" class="w-3.5 h-3.5" />
																		</button>
																	</div>
																</div>
															</div>
														{:else}
															<div class="flex items-center gap-2.5 flex-1 min-w-0">
																<input
																	type="checkbox"
																	checked={item.state === 'complete'}
																	onclick={() => handleToggleCheckItem(checklist.id, item.id, item.state)}
																	class="w-3.5 h-3.5 accent-green-500 rounded bg-slate-950 border border-slate-700 cursor-pointer shrink-0"
																/>
																<button
																	type="button"
																	onclick={() => startEditCheckItem(item.id, item.name)}
																	class="text-left leading-normal flex-1 break-words font-sans text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-800/50 px-1 rounded transition-colors cursor-pointer border-none bg-transparent m-0"
																	class:line-through={item.state === 'complete'}
																	class:text-slate-500={item.state === 'complete'}
																	title="Click to edit item name"
																>
																	{item.name}
																</button>
															</div>
															<button
																type="button"
																onclick={() => handleDeleteCheckItem(checklist.id, item.id)}
																class="text-slate-500 hover:text-red-400 p-0.5 rounded hover:bg-slate-850 cursor-pointer border-none bg-transparent opacity-0 group-hover:opacity-100 transition-opacity"
																title="Delete check item"
															>
																<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
															</button>
														{/if}
													</div>
												{/each}
											</div>
										{/if}
									{/if}

									<!-- Add Checklist item input form -->
									<div class="pl-6">
										{#if activeAddCheckItemId === checklist.id}
											<div class="flex flex-col gap-2 max-w-md">
												<input
													type="text"
													placeholder="Add an item"
													bind:value={newCheckItemVals[checklist.id]}
													onkeydown={(e) => {
														if (e.key === 'Enter') handleAddCheckItem(checklist.id);
														if (e.key === 'Escape') activeAddCheckItemId = null;
													}}
													class="w-full px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-violet-500"
												/>
												<div class="flex gap-2">
													<button
														type="button"
														onclick={() => handleAddCheckItem(checklist.id)}
														class="px-2.5 py-1 text-xs bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded transition cursor-pointer border-none"
													>
														Add
													</button>
													<button
														type="button"
														onclick={() => activeAddCheckItemId = null}
														class="px-2.5 py-1 text-xs bg-transparent hover:bg-slate-800 text-slate-400 hover:text-slate-200 font-semibold rounded transition cursor-pointer border border-slate-700"
													>
														Cancel
													</button>
												</div>
											</div>
										{:else}
											<button
												type="button"
												onclick={() => {
													activeAddCheckItemId = checklist.id;
													newCheckItemVals[checklist.id] = '';
												}}
												class="px-3 py-1.5 text-xs bg-slate-800/80 hover:bg-slate-800 text-slate-300 font-semibold rounded transition cursor-pointer border-none"
											>
												Add an item
											</button>
										{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Right activities / comments column -->
				<div bind:this={commentSectionEl} class="w-full md:w-[360px] md:shrink-0 border-t md:border-t-0 md:border-l border-slate-800 pt-6 md:pt-0 md:pl-6 flex flex-col md:h-full md:pr-0">
					<!-- Comments header -->
					<div class="flex items-center justify-between md:pr-6">
						<div class="flex items-center gap-2 text-slate-200 font-bold text-sm">
							<Icon name="lucide:message-square" class="w-4 h-4 text-slate-400" />
							<span>Comments and activity</span>
						</div>
						<button
							type="button"
							onclick={() => showActivityDetails = !showActivityDetails}
							class="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 font-semibold rounded transition cursor-pointer border-none"
						>
							{showActivityDetails ? 'Hide details' : 'Show details'}
						</button>
					</div>

					<!-- Activity feed list (scrollable) -->
					<div class="flex-1 overflow-y-auto flex flex-col gap-5 pt-1 md:pr-6">

					<!-- Write a comment input -->
					{#if isWritingComment}
						<div class="flex flex-col gap-2 animate-in fade-in duration-150 relative">
							<RichTextEditor
								bind:html={editCommentHTML}
								placeholder="Write a comment..."
								showDirectLinkImage={false}
								showMarkdownIcon={false}
								enableCodeToolbar={false}
								dropdownAlign="right"
								mentionOptions={mentionOptions}
								onImageUpload={handleUploadImageForEditor}
							/>
							<div class="flex items-center gap-1.5 select-none">
								<button
									type="button"
									onclick={handleAddComment}
									disabled={isCommentEmpty}
									class="px-4 py-1.5 text-sm bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded-lg transition-colors cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
								>
									Save
								</button>
								<button
									type="button"
									onclick={() => {
										isWritingComment = false;
										editCommentHTML = '';
									}}
									class="px-3 py-1.5 text-sm bg-transparent hover:bg-slate-800 hover:text-slate-200 text-slate-400 font-semibold rounded-lg transition-colors cursor-pointer border-none"
								>
									Cancel
								</button>
								
								<label class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 cursor-pointer ml-1 select-none">
									<input
										type="checkbox"
										checked={card.badges?.subscribed ?? false}
										disabled
										class="w-3.5 h-3.5 accent-violet-600 rounded bg-slate-900 border border-slate-700 cursor-not-allowed shrink-0"
									/>
									<span>Watch</span>
								</label>
							</div>
						</div>
					{:else}
						<button
							type="button"
							onclick={() => {
								isWritingComment = true;
								editCommentHTML = '';
							}}
							class="w-full text-left bg-slate-800/20 hover:bg-slate-800/40 border border-slate-800/80 hover:border-slate-700 rounded-lg px-4 py-3 text-xs text-slate-400 hover:text-slate-300 cursor-pointer transition-colors select-none leading-relaxed min-h-[44px] border-solid"
						>
							Write a comment...
						</button>
					{/if}

					<!-- Activity feed -->
					<div class="flex flex-col gap-4">
						{#each filteredActions as action}
							<div class="flex gap-2.5 items-start text-xs">
								<!-- Creator avatar -->
								{#if action.memberCreator?.avatarUrl}
									<img src="{action.memberCreator.avatarUrl}/30.png" alt="" class="w-6 h-6 rounded-full object-cover border border-slate-700 shrink-0 mt-0.5" />
								{:else}
									<div class="w-6 h-6 rounded-full bg-violet-600 flex items-center justify-center text-[10px] font-bold text-white border border-slate-700 shrink-0 mt-0.5">
										{action.memberCreator?.fullName.charAt(0).toUpperCase()}
									</div>
								{/if}

								<!-- Activity details -->
								<div class="flex-1 flex flex-col gap-1 min-w-0">
									<div class="text-slate-300">
										<span class="font-bold text-slate-200">{action.memberCreator?.fullName}</span>
										{#if action.type === 'commentCard'}
											<span>commented:</span>
										{:else}
											<span>{formatActionText(action).replace(action.memberCreator?.fullName || '', '').trim()}</span>
										{/if}
									</div>
									<div class="text-[10px] text-slate-500">
										{new Date(action.date).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
									</div>
									{#if action.type === 'commentCard' && action.data?.text}
										{#if editingCommentId === action.id}
											<div class="flex flex-col gap-2 mt-1">
												<RichTextEditor
													bind:html={editExistingCommentHTML}
													placeholder="Edit your comment..."
													showDirectLinkImage={false}
													showMarkdownIcon={false}
													enableCodeToolbar={false}
													dropdownAlign="right"
													mentionOptions={mentionOptions}
													onImageUpload={handleUploadImageForEditor}
												/>
												<div class="flex gap-2 text-[10px] mt-1.5 select-none">
													<button
														type="button"
														onclick={() => handleSaveComment(action.id)}
														class="px-2.5 py-1 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded transition cursor-pointer border-none"
													>
														Save
													</button>
													<button
														type="button"
														onclick={cancelEditComment}
														class="px-2.5 py-1 bg-transparent hover:bg-slate-800 text-slate-400 hover:text-slate-200 font-semibold rounded transition cursor-pointer border border-slate-700"
													>
														Cancel
													</button>
												</div>
											</div>
										{:else}
											<div class="mt-1 p-2 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 leading-relaxed font-sans max-w-full break-words markdown-preview-container">
												{@html renderMarkdownWithMentions(action.data.text || '', false)}
											</div>
											<div class="flex gap-2 text-[10px] text-slate-500 mt-0.5">
												<button
													type="button"
													onclick={() => startEditComment(action.id, action.data.text || '')}
													class="hover:text-slate-300 underline cursor-pointer border-none bg-transparent p-0"
												>
													Edit
												</button>
												<span>•</span>
												<button
													type="button"
													onclick={() => handleDeleteComment(action.id)}
													class="hover:text-red-400 underline cursor-pointer border-none bg-transparent p-0"
												>
													Delete
												</button>
											</div>
										{/if}
									{/if}
								</div>
							</div>
						{/each}

						{#if filteredActions.length === 0}
							<p class="text-xs text-slate-500 italic text-center py-4">No recent activity</p>
						{/if}
					</div>

					</div>

					<!-- Card Actions (Archive/Delete) -->
					<div class="flex flex-col gap-2 shrink-0 border-t border-slate-800 pt-4 md:pr-6">
						<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Card Actions</span>
						<div class="flex gap-2 text-xs">
							<button
								type="button"
								onclick={handleArchiveCard}
								class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg transition cursor-pointer"
								title="Archive this card"
							>
								<Icon name="lucide:archive" class="w-3.5 h-3.5" />
								<span>Archive</span>
							</button>
							<button
								type="button"
								onclick={handleDeleteCard}
								class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-red-950/20 hover:bg-red-950/40 border border-red-900/30 hover:border-red-900/50 text-red-400 rounded-lg transition cursor-pointer"
								title="Permanently delete card"
							>
								<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
								<span>Delete</span>
							</button>
						</div>
					</div>
				</div>
			</div>

		</div>
	</div>
	<!-- Popover rendered outside backdrop to avoid containing block offsets from filter/transform -->
	{#if showDatesPopover}
		<!-- Click outside handler overlay -->
		<button
			type="button"
			class="fixed inset-0 z-[205] bg-transparent cursor-default border-none w-full h-full"
			onclick={() => showDatesPopover = false}
			aria-label="Close dates picker"
		></button>

		<div 
			style="top: {popoverTop}px; left: {popoverLeft}px;"
			class="fixed z-[210]"
		>
			{@render datesPopoverContent()}
		</div>
	{/if}

	{#if previewAttachment}
		<!-- Backdrop block -->
		<button
			type="button"
			class="fixed inset-0 z-[250] bg-black/90 backdrop-blur-sm cursor-default border-none w-full h-full animate-in fade-in duration-200"
			onclick={() => previewAttachment = null}
			aria-label="Close attachment preview"
		></button>

		<!-- Close button in top-right of screen -->
		<button
			type="button"
			onclick={() => previewAttachment = null}
			class="fixed top-6 right-6 z-[260] p-2.5 rounded-full bg-slate-900/60 hover:bg-slate-800/80 transition text-slate-400 hover:text-slate-200 cursor-pointer border border-slate-700/50 animate-in fade-in zoom-in-95 duration-200"
			aria-label="Close"
		>
			<Icon name="lucide:x" class="w-5 h-5" />
		</button>

		<!-- Main Preview Content Area (Centered) -->
		<div class="fixed inset-0 z-[255] pointer-events-none flex items-center justify-center p-4">
			<div class="pointer-events-auto flex flex-col items-center justify-center max-w-full max-h-full">
				{#if previewAttachment.mimeType?.startsWith('image/') || previewAttachment.previews?.length > 0}
					<img
						src={previewAttachment.url}
						alt={previewAttachment.name}
						class="max-w-[90vw] max-h-[70vh] object-contain rounded-lg shadow-2xl border border-slate-800/50 animate-in fade-in zoom-in-95 duration-200"
					/>
				{:else}
					<div class="flex flex-col items-center gap-4 text-center animate-in fade-in zoom-in-95 duration-200">
						<span class="text-lg font-bold text-slate-100 max-w-md">There is no preview available for this attachment.</span>
						<a
							href={previewAttachment.url}
							download={previewAttachment.name}
							target="_blank"
							rel="noopener noreferrer"
							class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold text-sm transition cursor-pointer shadow-md no-underline flex items-center gap-2"
						>
							<Icon name="lucide:download" class="w-4 h-4" />
							Download
						</a>
					</div>
				{/if}
			</div>
		</div>

		<!-- Bottom Details Panel -->
		<div class="fixed bottom-0 left-0 right-0 z-[255] pointer-events-none flex flex-col items-center pb-8 px-4">
			<div class="pointer-events-auto flex flex-col items-center text-center max-w-2xl bg-slate-950/80 backdrop-blur-md px-6 py-4 rounded-2xl border border-slate-800/60 shadow-2xl animate-in slide-in-from-bottom duration-250">
				<h3 class="text-base font-bold text-slate-100 truncate max-w-md m-0 mb-1">{previewAttachment.name}</h3>
				<div class="text-xs text-slate-400 mb-4 flex items-center gap-1.5 justify-center">
					<span>Added {formattedPreviewDate}</span>
					{#if previewAttachment.bytes}
						<span>•</span>
						<span>{formatFileSize(previewAttachment.bytes)}</span>
					{/if}
				</div>

				<div class="flex items-center gap-6 text-sm">
					<a
						href={previewAttachment.url}
						target="_blank"
						rel="noopener noreferrer"
						class="flex items-center gap-2 text-slate-300 hover:text-slate-100 font-semibold no-underline transition"
					>
						<Icon name="lucide:external-link" class="w-4 h-4" />
						Open in new tab
					</a>
					<a
						href={previewAttachment.url}
						download={previewAttachment.name}
						target="_blank"
						rel="noopener noreferrer"
						class="flex items-center gap-2 text-slate-300 hover:text-slate-100 font-semibold no-underline transition"
					>
						<Icon name="lucide:download" class="w-4 h-4" />
						Download
					</a>
					<button
						type="button"
						onclick={async () => {
							if (previewAttachment) {
								const id = previewAttachment.id;
								previewAttachment = null;
								await taskClientStore.deleteAttachment(card.id, id);
							}
						}}
						class="flex items-center gap-2 text-slate-300 hover:text-red-400 font-semibold bg-transparent border-none cursor-pointer transition p-0"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
						Delete
					</button>
				</div>
			</div>
		</div>
	{/if}
{/if}

{#snippet datesPopoverContent()}
	<div class="w-72 p-4 rounded-xl border border-slate-700 bg-slate-950 shadow-2xl flex flex-col gap-3">
		<!-- Header -->
		<div class="flex items-center justify-between">
			<h4 class="text-xs font-bold text-slate-200 m-0">Dates</h4>
			<button
				type="button"
				onclick={() => showDatesPopover = false}
				class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-900 transition-colors"
			>
				<Icon name="lucide:x" class="w-3.5 h-3.5" />
			</button>
		</div>

		<!-- Calendar month/year navigation -->
		<div class="flex items-center justify-between text-xs text-slate-200 font-semibold bg-slate-900/50 py-1 px-1.5 rounded border border-slate-800">
			<div class="flex items-center gap-0.5">
				<button
					type="button"
					onclick={prevYear}
					class="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 cursor-pointer border-none bg-transparent"
					title="Previous year"
				>
					<Icon name="lucide:chevrons-left" class="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					onclick={prevMonth}
					class="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 cursor-pointer border-none bg-transparent"
					title="Previous month"
				>
					<Icon name="lucide:chevron-left" class="w-3.5 h-3.5" />
				</button>
			</div>
			
			<span class="select-none">{monthNames[calendarMonth]} {calendarYear}</span>

			<div class="flex items-center gap-0.5">
				<button
					type="button"
					onclick={nextMonth}
					class="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 cursor-pointer border-none bg-transparent"
					title="Next month"
				>
					<Icon name="lucide:chevron-right" class="w-3.5 h-3.5" />
				</button>
				<button
					type="button"
					onclick={nextYear}
					class="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200 cursor-pointer border-none bg-transparent"
					title="Next year"
				>
					<Icon name="lucide:chevrons-right" class="w-3.5 h-3.5" />
				</button>
			</div>
		</div>

		<!-- Weekday Headers -->
		<div class="grid grid-cols-7 text-center text-[10px] font-bold text-slate-500 select-none">
			<span>Su</span>
			<span>Mo</span>
			<span>Tu</span>
			<span>We</span>
			<span>Th</span>
			<span>Fr</span>
			<span>Sa</span>
		</div>

		<!-- Day cells grid -->
		<div class="grid grid-cols-7 gap-1 text-center text-xs">
			{#each calendarDays as cell}
				{@const isSelected = isCellSelected(cell.day, cell.month, cell.year)}
				<button
					type="button"
					onclick={() => selectCalendarDay(cell.day, cell.month, cell.year)}
					class="aspect-square flex items-center justify-center rounded-full text-xs cursor-pointer border-none transition-colors
						{cell.current ? 'text-slate-200' : 'text-slate-600'}
						{isSelected 
							? 'bg-violet-600 text-white font-bold' 
							: cell.current 
								? 'bg-transparent hover:bg-slate-800' 
								: 'bg-transparent hover:bg-slate-900/50'}"
				>
					{cell.day}
				</button>
			{/each}
		</div>

		<!-- Start date row -->
		<div class="flex flex-col gap-1">
			<span class="text-[10px] text-slate-400 font-semibold select-none">Start date</span>
			<div class="flex items-center gap-2">
				<input
					type="checkbox"
					bind:checked={hasStartDate}
					class="w-4 h-4 accent-violet-600 rounded bg-slate-900 border border-slate-700 cursor-pointer shrink-0"
				/>
				<input
					type="datetime-local"
					bind:value={newStartDateVal}
					disabled={!hasStartDate}
					onfocus={() => activeDateField = 'start'}
					class="flex-1 px-2.5 py-1.5 rounded bg-slate-900 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all
						{activeDateField === 'start' ? 'border border-violet-500 ring-1 ring-violet-500' : 'border border-slate-700'}"
				/>
			</div>
		</div>

		<!-- Due date row -->
		<div class="flex flex-col gap-1">
			<span class="text-[10px] text-slate-400 font-semibold select-none">Due date</span>
			<div class="flex items-center gap-2">
				<input
					type="checkbox"
					bind:checked={hasDueDate}
					class="w-4 h-4 accent-violet-600 rounded bg-slate-900 border border-slate-700 cursor-pointer shrink-0"
				/>
				<input
					type="datetime-local"
					bind:value={newDueDateVal}
					disabled={!hasDueDate}
					onfocus={() => activeDateField = 'due'}
					class="flex-1 px-2.5 py-1.5 rounded bg-slate-900 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all
						{activeDateField === 'due' ? 'border border-violet-500 ring-1 ring-violet-500' : 'border border-slate-700'}"
				/>
			</div>
		</div>

		<!-- Recurring -->
		<div class="flex flex-col gap-1">
			<span class="text-[10px] text-slate-400 font-semibold select-none">Recurring</span>
			<select
				bind:value={recurringVal}
				class="w-full px-2.5 py-1.5 rounded bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 cursor-pointer"
			>
				<option>Never</option>
				<option>Daily</option>
				<option>Monday to Friday</option>
				<option>Weekly</option>
				<option>Monthly on the {recurringDayNumber}</option>
				<option>{recurringDayOfWeekDesc}</option>
				<option>{recurringYearlyDesc}</option>
			</select>
		</div>

		<!-- Set due date reminder -->
		<div class="flex flex-col gap-1">
			<span class="text-[10px] text-slate-400 font-semibold select-none">Set due date reminder</span>
			<select
				bind:value={dueReminderVal}
				class="w-full px-2.5 py-1.5 rounded bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-violet-500 cursor-pointer"
			>
				<option value={-1}>None</option>
				<option value={0}>At time of due date</option>
				<option value={5}>5 Minutes before</option>
				<option value={10}>10 Minutes before</option>
				<option value={15}>15 Minutes before</option>
				<option value={60}>1 Hour before</option>
				<option value={120}>2 Hours before</option>
				<option value={1440}>1 Day before</option>
				<option value={2880}>2 Days before</option>
				<option value={10080}>1 Week before</option>
				<option value={20160}>2 Weeks before</option>
			</select>
		</div>

		<!-- Actions -->
		<div class="flex gap-2 text-[10px] mt-1">
			<button
				type="button"
				onclick={handleSaveDates}
				class="flex-1 py-1.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded transition cursor-pointer border-none"
			>
				Save
			</button>
			<button
				type="button"
				onclick={handleRemoveDates}
				class="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-semibold rounded transition cursor-pointer"
			>
				Remove
			</button>
		</div>
	</div>
{/snippet}

{#snippet labelsPopoverContent()}
	<!-- Header -->
	<div class="flex items-center justify-between border-b border-slate-800 pb-2 mb-1">
		{#if labelsPopoverMode === 'list'}
			<h4 class="text-xs font-bold text-slate-200 m-0">Labels</h4>
		{:else if labelsPopoverMode === 'create'}
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={() => { labelsPopoverMode = 'list'; }}
					class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-900 transition-colors"
					title="Back"
				>
					<Icon name="lucide:chevron-left" class="w-3.5 h-3.5" />
				</button>
				<h4 class="text-xs font-bold text-slate-200 m-0">Create label</h4>
			</div>
		{:else if labelsPopoverMode === 'edit'}
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={() => { labelsPopoverMode = 'list'; }}
					class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-900 transition-colors"
					title="Back"
				>
					<Icon name="lucide:chevron-left" class="w-3.5 h-3.5" />
				</button>
				<h4 class="text-xs font-bold text-slate-200 m-0">Change label</h4>
			</div>
		{/if}
		<button
			type="button"
			onclick={() => { showLabelsPopover = false; }}
			class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-900 transition-colors"
			aria-label="Close labels popover"
		>
			<Icon name="lucide:x" class="w-3.5 h-3.5" />
		</button>
	</div>

	{#if labelsPopoverMode === 'list'}
		<!-- Search box -->
		<div class="relative">
			<input
				type="text"
				placeholder="Search labels..."
				bind:value={searchLabelQuery}
				class="w-full bg-slate-900 border border-slate-800 focus:border-slate-700 text-slate-200 rounded px-2.5 py-1.5 text-xs placeholder-slate-500"
			/>
		</div>

		<!-- Labels List -->
		<div class="flex flex-col gap-1 max-h-56 overflow-y-auto pr-1">
			<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Labels</span>
			{#if filteredLabels.length === 0}
				<div class="text-slate-500 text-xs py-2 text-center">No labels found</div>
			{:else}
				{#each filteredLabels as label}
					{@const isAssigned = card?.labels.some(l => l.id === label.id)}
					{@const bg = labelColorMap[label.color] ?? label.color ?? '#6b7280'}
					<div class="flex items-center gap-2 group/row">
						<!-- Toggle checkbox -->
						<button
							type="button"
							onclick={() => handleToggleLabelOnCard(label.id)}
							class="flex items-center justify-center w-5 h-5 rounded border border-slate-700 bg-slate-900 hover:border-slate-500 transition cursor-pointer shrink-0"
						>
							{#if isAssigned}
								<Icon name="lucide:check" class="w-3.5 h-3.5 text-violet-500 font-bold" />
							{/if}
						</button>

						<!-- Colored label bar -->
						<button
							type="button"
							onclick={() => handleToggleLabelOnCard(label.id)}
							style="background-color: {bg};"
							class="flex-1 flex items-center text-left px-3 h-8 rounded text-white font-semibold text-xs transition cursor-pointer min-w-0 select-none shadow-sm hover:brightness-110 active:brightness-95
								{taskClientStore.colorblindMode ? `colorblind-pattern-${label.color}` : ''}"
						>
							<span class="truncate pr-1">{label.name || ''}</span>
						</button>

						<!-- Edit pencil button -->
						<button
							type="button"
							onclick={() => startEditLabel(label.id, label.name, label.color)}
							class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-900 rounded transition cursor-pointer shrink-0"
							title="Edit label"
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
						</button>
					</div>
				{/each}
			{/if}
		</div>

		<!-- Action buttons -->
		<div class="flex flex-col gap-2 pt-1 border-t border-slate-900">
			<button
				type="button"
				onclick={startCreateLabel}
				class="w-full py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 font-semibold rounded text-xs transition cursor-pointer text-center"
			>
				Create a new label
			</button>
			<button
				type="button"
				onclick={() => taskClientStore.toggleColorblindMode()}
				class="w-full py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 font-semibold rounded text-xs transition cursor-pointer text-center"
			>
				{taskClientStore.colorblindMode ? 'Disable' : 'Enable'} colorblind friendly mode
			</button>
		</div>

	{:else if labelsPopoverMode === 'create' || labelsPopoverMode === 'edit'}
		<!-- Title / Name Input -->
		<div class="flex flex-col gap-1.5">
			<label for="label-name-input" class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Title</label>
			<input
				id="label-name-input"
				type="text"
				placeholder="Label title..."
				bind:value={labelFormName}
				class="w-full bg-slate-900 border border-slate-800 focus:border-slate-700 text-slate-200 rounded px-2.5 py-1.5 text-xs"
			/>
		</div>

		<!-- Color Selector Grid -->
		<div class="flex flex-col gap-1.5">
			<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Select a color</span>
			<div class="grid grid-cols-5 gap-2">
				{#each labelColors as color}
					{@const bg = labelColorMap[color] ?? color}
					{@const isSelected = labelFormColor === color}
					<button
						type="button"
						onclick={() => { labelFormColor = color; }}
						style="background-color: {bg};"
						class="w-10 h-8 rounded relative transition-transform cursor-pointer shadow-sm hover:scale-105 active:scale-95 flex items-center justify-center
							{isSelected ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-slate-950' : ''}
							{taskClientStore.colorblindMode ? `colorblind-pattern-${color}` : ''}"
						title={color}
					>
						{#if isSelected}
							<Icon name="lucide:check" class="w-4 h-4 text-white drop-shadow" />
						{/if}
					</button>
				{/each}
			</div>
		</div>

		<!-- Form Actions -->
		<div class="flex items-center gap-2 pt-2 border-t border-slate-900">
			{#if labelsPopoverMode === 'create'}
				<button
					type="button"
					onclick={handleSaveLabel}
					class="flex-1 py-1.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded text-xs transition cursor-pointer border-none"
				>
					Create
				</button>
			{:else}
				<button
					type="button"
					onclick={handleSaveLabel}
					class="flex-1 py-1.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded text-xs transition cursor-pointer border-none"
				>
					Save
				</button>
				<button
					type="button"
					onclick={() => handleDeleteLabel(editingLabelId!)}
					class="flex-1 py-1.5 bg-red-600 hover:bg-red-700 text-white font-semibold rounded text-xs transition cursor-pointer border-none"
				>
					Delete
				</button>
			{/if}
		</div>
	{/if}
{/snippet}


<style>
	.markdown-preview-container :global(a) {
		color: #579dff !important;
		text-decoration: underline !important;
	}
	.markdown-preview-container :global(a:hover) {
		color: #85b8ff !important;
	}
	.markdown-preview-container :global(ul) {
		list-style-type: disc !important;
		padding-left: 1.25rem !important;
		margin-top: 0.5rem !important;
		margin-bottom: 0.5rem !important;
	}
	.markdown-preview-container :global(ol) {
		list-style-type: decimal !important;
		padding-left: 1.25rem !important;
		margin-top: 0.5rem !important;
		margin-bottom: 0.5rem !important;
	}
	.markdown-preview-container :global(li) {
		display: list-item !important;
		margin-top: 0.25rem !important;
		margin-bottom: 0.25rem !important;
	}
	.markdown-preview-container :global(strong) {
		font-weight: 700 !important;
		color: rgb(241 245 249) !important;
	}
	.markdown-preview-container :global(em) {
		font-style: italic !important;
	}
	.markdown-preview-container :global(h1) {
		font-size: 1.5rem !important;
		font-weight: 700 !important;
		margin-top: 1rem !important;
		margin-bottom: 0.5rem !important;
	}
	.markdown-preview-container :global(h2) {
		font-size: 1.25rem !important;
		font-weight: 700 !important;
		margin-top: 1rem !important;
		margin-bottom: 0.5rem !important;
	}
	.markdown-preview-container :global(h3) {
		font-size: 1.125rem !important;
		font-weight: 700 !important;
		margin-top: 1rem !important;
		margin-bottom: 0.5rem !important;
	}
	.markdown-preview-container :global(code) {
		background-color: rgb(15 23 42) !important;
		color: rgb(241 245 249) !important;
		padding: 0.125rem 0.25rem !important;
		border-radius: 0.25rem !important;
		font-family: monospace !important;
		font-size: 0.85em !important;
	}
	.markdown-preview-container :global(p) {
		margin-top: 0.5rem !important;
		margin-bottom: 0.5rem !important;
	}
	.markdown-preview-container :global(pre) {
		background-color: rgb(15 23 42) !important;
		color: rgb(241 245 249) !important;
		padding: 0.75rem 0.75rem 0.75rem 1.75rem !important;
		border-radius: 0.5rem !important;
		border: 1px solid rgb(51 65 85) !important;
		font-family: monospace !important;
		font-size: 0.875rem !important;
		margin: 1rem 0 !important;
		overflow-x: auto !important;
		position: relative !important;
	}
	.markdown-preview-container :global(pre)::before {
		content: "" !important;
		position: absolute !important;
		left: 0 !important;
		top: 0 !important;
		bottom: 0 !important;
		width: 1.75rem !important;
		background-color: rgba(30, 41, 59, 0.4) !important;
		border-right: 1px solid rgba(71, 85, 105, 0.4) !important;
		border-radius: 0.5rem 0 0 0.5rem !important;
		pointer-events: none !important;
	}
	.markdown-preview-container :global(pre code) {
		background-color: transparent !important;
		padding: 0 !important;
		border-radius: 0 !important;
		font-size: 1em !important;
		display: block !important;
		counter-reset: line !important;
	}
	.markdown-preview-container :global(pre code div) {
		position: relative !important;
		padding-left: 0.6rem !important;
	}
	.markdown-preview-container :global(pre code div)::before {
		counter-increment: line !important;
		content: counter(line) !important;
		position: absolute !important;
		top: 0 !important;
		bottom: 0 !important;
		left: -1.75rem !important;
		width: 1.75rem !important;
		display: inline-flex !important;
		align-items: center !important;
		justify-content: center !important;
		color: rgb(100 116 139) !important;
		font-size: 0.75rem !important;
		font-family: monospace !important;
		pointer-events: none !important;
		user-select: none !important;
	}
	.markdown-preview-container :global(blockquote) {
		border-left: 0.25rem solid rgb(139 92 246) !important;
		padding-left: 1rem !important;
		color: rgb(148 163 184) !important;
		margin: 0.5rem 0 !important;
		font-style: italic !important;
	}
	.markdown-preview-container :global(pre code .token-keyword) {
		color: #569cd6 !important;
		font-weight: 500;
	}
	.markdown-preview-container :global(pre code .token-string) {
		color: #80c990 !important;
	}
	.markdown-preview-container :global(pre code .token-comment) {
		color: #6a9955 !important;
		font-style: italic;
	}
	.markdown-preview-container :global(pre code .token-number) {
		color: #b5cea8 !important;
	}
	.markdown-preview-container :global(pre code .token-function) {
		color: #dcdcaa !important;
	}
	.markdown-preview-container :global(pre code .token-builtin) {
		color: #4fc1ff !important;
	}
	.markdown-preview-container :global(pre code .token-operator) {
		color: #d4d4d4 !important;
	}
</style>
