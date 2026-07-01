<script lang="ts">
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { taskClientStore, type TrelloBoard, type TrelloCard } from '$frontend/stores/features/task-client.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import CardDetailModal from './CardDetailModal.svelte';
	import { debug } from '$shared/utils/logger';


	interface TaskProvider {
		id: string;
		name: string;
		description: string;
		icon: IconName;
		color: string;
		available: boolean;
	}

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	const providers: TaskProvider[] = [
		{
			id: 'trello',
			name: 'Trello',
			description: 'Trello boards and cards',
			icon: 'lucide:trello',
			color: '#0052CC',
			available: true
		},
		{
			id: 'github',
			name: 'GitHub Issues',
			description: 'GitHub issues and pull requests',
			icon: 'lucide:github',
			color: '#24292e',
			available: false
		},
		{
			id: 'linear',
			name: 'Linear',
			description: 'Linear issues and projects',
			icon: 'lucide:zap',
			color: '#5E6AD2',
			available: false
		},
		{
			id: 'jira',
			name: 'Jira',
			description: 'Atlassian Jira projects',
			icon: 'lucide:layout-dashboard',
			color: '#0065FF',
			available: false
		}
	];

	let selectedProviderId = $state<string>('trello');
	const selectedProvider = $derived(providers.find((p) => p.id === selectedProviderId) ?? providers[0]);

	// Add/Edit account form
	let showAddForm = $state(false);
	let editingAccountId = $state<string | null>(null);
	let addApiKey = $state('');
	let addToken = $state('');
	let addName = $state('');
	let addLoading = $state(false);
	let addError = $state<string | null>(null);

	// Masking & Edit state for sensitive credentials
	let isEditingApiKey = $state(false);
	let isEditingToken = $state(false);
	let tempApiKey = $state('');
	let tempToken = $state('');

	// Trello view state
	type TrelloView = 'accounts' | 'boards' | 'board';
	let trelloView = $state<TrelloView>('accounts');

	function selectProvider(id: string) {
		selectedProviderId = id;
		showAddForm = false;
		editingAccountId = null;
		addError = null;
	}

	function openAddForm() {
		showAddForm = true;
		editingAccountId = null;
		addName = '';
		addApiKey = '';
		addToken = '';
		isEditingApiKey = false;
		isEditingToken = false;
		tempApiKey = '';
		tempToken = '';
		addError = null;
	}

	function openEditForm(account: typeof taskClientStore.accounts[0]) {
		showAddForm = true;
		editingAccountId = account.id;
		addName = account.displayName;
		addApiKey = account.apiKey;
		addToken = account.token;
		isEditingApiKey = false;
		isEditingToken = false;
		tempApiKey = '';
		tempToken = '';
		addError = null;
	}

	function cancelAdd() {
		showAddForm = false;
		editingAccountId = null;
		addApiKey = '';
		addToken = '';
		addName = '';
		isEditingApiKey = false;
		isEditingToken = false;
		tempApiKey = '';
		tempToken = '';
		addError = null;
	}

	async function confirmAdd() {
		if (!addApiKey.trim() || !addToken.trim()) {
			addError = 'API Key and Token are required.';
			return;
		}
		addLoading = true;
		addError = null;
		try {
			const account = await taskClientStore.addAccount(addApiKey.trim(), addToken.trim(), addName.trim());
			if (editingAccountId && editingAccountId !== account.id) {
				taskClientStore.removeAccount(editingAccountId);
			}
			showAddForm = false;
			editingAccountId = null;
			addApiKey = '';
			addToken = '';
			addName = '';
		} catch (e) {
			addError = e instanceof Error ? e.message : 'Failed to connect account.';
		} finally {
			addLoading = false;
		}
	}

	async function selectAccountAndLoad(id: string) {
		taskClientStore.selectAccount(id);
		trelloView = 'boards';
		// loadBoards is triggered inside selectAccount
	}

	async function openBoard(boardId: string) {
		trelloView = 'board';
		await taskClientStore.selectBoard(boardId);
	}

	async function selectRecentBoardAndLoad(boardId: string, accountId: string) {
		trelloView = 'board';
		await taskClientStore.selectRecentBoard(boardId, accountId);
	}

	function backToBoards() {
		trelloView = 'boards';
	}

	function backToAccounts() {
		trelloView = 'accounts';
	}

	const groupedWorkspaces = $derived.by(() => {
		const orgMap = new Map<string | null, { name: string; boards: typeof taskClientStore.boards }>();
		
		// Initialize org map with known organizations to preserve order
		for (const org of taskClientStore.organizations) {
			orgMap.set(org.id, { name: org.displayName, boards: [] });
		}
		
		// Personal boards organization
		orgMap.set(null, { name: 'Personal Boards', boards: [] });
		
		// Distribute boards into organizations
		for (const board of taskClientStore.boards) {
			const orgId = board.idOrganization || null;
			if (!orgMap.has(orgId)) {
				orgMap.set(orgId, { name: orgId === null ? 'Personal Boards' : 'Other Workspace', boards: [] });
			}
			orgMap.get(orgId)!.boards.push(board);
		}
		
		// Filter out organizations that have no boards
		const groups: { id: string | null; name: string; boards: typeof taskClientStore.boards }[] = [];
		
		// Check organizations in list order
		for (const org of taskClientStore.organizations) {
			const group = orgMap.get(org.id);
			if (group && group.boards.length > 0) {
				groups.push({ id: org.id, name: group.name, boards: group.boards });
			}
		}
		
		// Append personal boards if there are any
		const personalGroup = orgMap.get(null);
		if (personalGroup && personalGroup.boards.length > 0) {
			groups.push({ id: null, name: personalGroup.name, boards: personalGroup.boards });
		}
		
		// If there are other workspaces not in the list but have boards, add them too
		for (const [orgId, group] of orgMap.entries()) {
			if (orgId !== null && !taskClientStore.organizations.some(org => org.id === orgId)) {
				if (group.boards.length > 0) {
					groups.push({ id: orgId, name: group.name, boards: group.boards });
				}
			}
		}
		
		return groups;
	});

	const starredBoards = $derived.by(() => {
		return taskClientStore.boards.filter((b) =>
			taskClientStore.boardStars.some((s) => s.idBoard === b.id)
		);
	});

	// Drag-and-drop state
	let draggedCardId = $state<string | null>(null);
	let draggingId = $state<string | null>(null);
	let activeDropListId = $state<string | null>(null);
	let activeDropIndex = $state<number | null>(null);

	function handleDragStart(e: DragEvent, cardId: string) {
		draggedCardId = cardId;
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', cardId);
			e.dataTransfer.effectAllowed = 'move';
		}
		// Delay hiding the card so the browser has time to capture the drag image
		setTimeout(() => {
			draggingId = cardId;
		}, 0);
	}

	function handleDragOver(e: DragEvent, listId: string) {
		e.preventDefault();
		if (e.dataTransfer) {
			e.dataTransfer.dropEffect = 'move';
		}
		if (activeDropListId !== listId) {
			activeDropListId = listId;
		}

		// Calculate index where we are currently hovering
		const targetEl = e.target as HTMLElement;
		const container = targetEl.closest('.cards-list-container') as HTMLElement;
		if (!container) return;

		const y = e.clientY;
		const cardElements = [...container.querySelectorAll('[data-card-id]')];
		
		let closestIndex = cardElements.length;
		for (let i = 0; i < cardElements.length; i++) {
			const box = cardElements[i].getBoundingClientRect();
			const center = box.top + box.height / 2;
			if (y < center) {
				closestIndex = i;
				break;
			}
		}
		
		activeDropIndex = closestIndex;
	}

	function handleDragEnd() {
		activeDropListId = null;
		activeDropIndex = null;
		draggedCardId = null;
		draggingId = null;
	}

	function getTargetPosition(e: DragEvent, targetListId: string, dragCardId: string): number {
		const targetEl = e.target as HTMLElement;
		const container = targetEl.closest('.cards-list-container') as HTMLElement;
		if (!container) return 16384;

		const y = e.clientY;
		const cardElements = [...container.querySelectorAll('[data-card-id]')];
		
		let closestIndex = cardElements.length;
		for (let i = 0; i < cardElements.length; i++) {
			const box = cardElements[i].getBoundingClientRect();
			const center = box.top + box.height / 2;
			if (y < center) {
				closestIndex = i;
				break;
			}
		}

		const listCards = taskClientStore.getCardsForList(targetListId).filter(c => c.id !== dragCardId);
		
		if (listCards.length === 0) {
			return 16384;
		}
		
		if (closestIndex === 0) {
			return listCards[0].pos / 2;
		}
		
		if (closestIndex >= listCards.length) {
			return listCards[listCards.length - 1].pos + 16384;
		}
		
		const prevCard = listCards[closestIndex - 1];
		const nextCard = listCards[closestIndex];
		return (prevCard.pos + nextCard.pos) / 2;
	}

	async function handleDrop(e: DragEvent, targetListId: string) {
		e.preventDefault();
		const cardId = e.dataTransfer?.getData('text/plain') || draggedCardId || draggingId;
		activeDropListId = null;
		activeDropIndex = null;
		draggedCardId = null;
		draggingId = null;
		if (!cardId) return;
		const targetPos = getTargetPosition(e, targetListId, cardId);
		await taskClientStore.moveCard(cardId, targetListId, targetPos);
	}

	// Create card state
	let addingCardListId = $state<string | null>(null);
	let newCardName = $state('');
	let addCardLoading = $state(false);

	function startAddCard(listId: string) {
		addingCardListId = listId;
		newCardName = '';
	}

	function cancelAddCard() {
		addingCardListId = null;
		newCardName = '';
	}

	async function submitNewCard(listId: string) {
		if (!newCardName.trim() || addCardLoading) return;
		addCardLoading = true;
		try {
			await taskClientStore.createCard(listId, newCardName);
			newCardName = '';
		} catch (e) {
			// error is handled in store
		} finally {
			addCardLoading = false;
		}
	}

	function handleAddCardKeydown(e: KeyboardEvent, listId: string) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			submitNewCard(listId);
		} else if (e.key === 'Escape') {
			cancelAddCard();
		}
	}

	function focusOnMount(node: HTMLTextAreaElement) {
		node.focus();
	}

	// List actions state
	let activeListActionsMenuId = $state<string | null>(null);

	function toggleListActionsMenu(listId: string) {
		if (activeListActionsMenuId === listId) {
			activeListActionsMenuId = null;
		} else {
			activeListActionsMenuId = listId;
		}
	}

	function closeListActionsMenu() {
		activeListActionsMenuId = null;
	}

	function triggerAddCardFromMenu(listId: string) {
		closeListActionsMenu();
		startAddCard(listId);
	}

	async function triggerArchiveList(listId: string) {
		closeListActionsMenu();
		await taskClientStore.archiveList(listId);
	}

	async function triggerArchiveAllCards(listId: string) {
		closeListActionsMenu();
		await taskClientStore.archiveAllCards(listId);
	}

	// Active card details modal state
	let activeDetailCardId = $state<string | null>(null);
	let isDetailModalOpen = $state(false);
	let expandedChecklists = $state<Record<string, boolean>>({});
	let showCardChecklists = $state<Record<string, boolean>>({});
	let initialSection = $state<'labels' | 'members' | 'dates' | null>(null);

	// Inline editing state
	let editingCardId = $state<string | null>(null);
	let editingCardTitle = $state('');
	let isCancelling = false;
	let editingCardRect = $state<{ top: number; left: number; width: number; height: number } | null>(null);
	let editingCardSide = $state<'left' | 'right'>('right');
	let copiedLink = $state(false);

	let activePopover = $state<'actions' | 'labels' | 'members' | 'dates' | null>(null);
	let searchLabelQuery = $state('');
	let searchMemberQuery = $state('');

	// Labels popover sub-states
	let labelsPopoverMode = $state<'list' | 'create' | 'edit'>('list');
	let editingLabelId = $state<string | null>(null);
	let labelFormName = $state('');
	let labelFormColor = $state('green');
	const labelColors = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'sky', 'lime', 'pink', 'black'];

	let hasStartDate = $state(false);
	let hasDueDate = $state(false);
	let startDateVal = $state('');
	let dueDateVal = $state('');

	// Dates popover sub-states (mirroring CardDetailModal)
	let calendarYear = $state(new Date().getFullYear());
	let calendarMonth = $state(new Date().getMonth());
	let activeDateField = $state<'start' | 'due'>('due');
	let recurringVal = $state('Never');
	let dueReminderVal = $state(-1);

	const initDates = (card: TrelloCard) => {
		if (card.start) {
			hasStartDate = true;
			const d = new Date(card.start);
			const tzoffset = d.getTimezoneOffset() * 60000;
			startDateVal = (new Date(d.getTime() - tzoffset)).toISOString().slice(0, 16);
		} else {
			hasStartDate = false;
			startDateVal = '';
		}

		if (card.due) {
			hasDueDate = true;
			const d = new Date(card.due);
			const tzoffset = d.getTimezoneOffset() * 60000;
			dueDateVal = (new Date(d.getTime() - tzoffset)).toISOString().slice(0, 16);
		} else {
			hasDueDate = false;
			dueDateVal = '';
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
	};

	const startInlineEdit = (card: TrelloCard, event: MouseEvent) => {
		editingCardId = card.id;
		editingCardTitle = card.name;
		isCancelling = false;
		copiedLink = false;
		activePopover = 'actions';

		const button = event.currentTarget as HTMLElement;
		const cardEl = button.closest('[data-card-id]') as HTMLElement;
		if (cardEl) {
			const rect = cardEl.getBoundingClientRect();
			editingCardRect = {
				top: rect.top,
				left: rect.left,
				width: rect.width,
				height: rect.height
			};

			const actionWidth = 256;
			const gap = 8;
			const spaceRight = window.innerWidth - rect.right;
			editingCardSide = spaceRight < (actionWidth + gap) ? 'left' : 'right';
		} else {
			editingCardRect = null;
			editingCardSide = 'right';
		}
	};

	const cancelInlineEdit = () => {
		isCancelling = true;
		editingCardId = null;
		editingCardTitle = '';
		editingCardRect = null;
		activePopover = null;
	};

	const saveInlineEdit = async (cardId: string) => {
		if (isCancelling) {
			isCancelling = false;
			return;
		}
		if (editingCardId !== cardId) return;

		const name = editingCardTitle.trim();
		editingCardId = null;
		editingCardTitle = '';
		editingCardRect = null;
		activePopover = null;

		if (!name) return;

		const card = taskClientStore.cards.find((c) => c.id === cardId);
		if (card && name === card.name) {
			return;
		}

		try {
			await taskClientStore.updateCardName(cardId, name);
		} catch (e) {
			debug.error('task-client', 'Failed to save card title inline:', e);
		}
	};

	const handleInlineEditKeyDown = (e: KeyboardEvent, cardId: string) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			saveInlineEdit(cardId);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelInlineEdit();
		}
	};

	const focusTextarea = (el: HTMLTextAreaElement) => {
		el.focus();
		el.select();
	};

	const handleWindowMouseDown = (e: MouseEvent) => {
		if (!editingCardId) return;

		const target = e.target as HTMLElement;
		const clickedCard = target.closest(`[data-card-id="${editingCardId}"]`);
		const clickedDropdown = target.closest('.quick-actions-dropdown');
		const clickedFloatingCard = target.closest('.floating-card-edit-container');

		if (!clickedCard && !clickedDropdown && !clickedFloatingCard) {
			saveInlineEdit(editingCardId);
		}
	};

	const startCreateLabel = () => {
		labelsPopoverMode = 'create';
		editingLabelId = null;
		labelFormName = '';
		labelFormColor = 'green';
	};

	const startEditLabel = (labelId: string, name: string, color: string) => {
		labelsPopoverMode = 'edit';
		editingLabelId = labelId;
		labelFormName = name;
		labelFormColor = color;
	};

	const handleSaveLabelInline = async () => {
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
			debug.error('task-client', 'Failed to save label inline:', err);
		}
	};

	const handleDeleteLabelInline = async (labelId: string) => {
		try {
			await taskClientStore.deleteLabel(labelId);
			labelsPopoverMode = 'list';
			editingLabelId = null;
			labelFormName = '';
		} catch (err) {
			debug.error('task-client', 'Failed to delete label inline:', err);
		}
	};

	const handleToggleLabel = async (cardId: string, labelId: string) => {
		const card = taskClientStore.cards.find(c => c.id === cardId);
		if (!card) return;

		const isAssigned = card.labels.some(l => l.id === labelId);
		try {
			if (isAssigned) {
				await taskClientStore.removeLabelFromCard(cardId, labelId);
			} else {
				await taskClientStore.addLabelToCard(cardId, labelId);
			}
		} catch (e) {
			debug.error('task-client', 'Failed to toggle label inline:', e);
		}
	};

	const handleToggleMember = async (cardId: string, memberId: string) => {
		const card = taskClientStore.cards.find(c => c.id === cardId);
		if (!card) return;

		const isAssigned = card.members.some(m => m.id === memberId);
		try {
			if (isAssigned) {
				await taskClientStore.removeMemberFromCard(cardId, memberId);
			} else {
				await taskClientStore.addMemberToCard(cardId, memberId);
			}
		} catch (e) {
			debug.error('task-client', 'Failed to toggle member inline:', e);
		}
	};

	const monthNames = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	const prevMonth = () => {
		if (calendarMonth === 0) {
			calendarMonth = 11;
			calendarYear -= 1;
		} else {
			calendarMonth -= 1;
		}
	};

	const nextMonth = () => {
		if (calendarMonth === 11) {
			calendarMonth = 0;
			calendarYear += 1;
		} else {
			calendarMonth += 1;
		}
	};

	const prevYear = () => {
		calendarYear -= 1;
	};

	const nextYear = () => {
		calendarYear += 1;
	};

	const selectCalendarDay = (day: number, month: number, year: number) => {
		const pad = (n: number) => String(n).padStart(2, '0');
		const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
		
		if (activeDateField === 'start') {
			hasStartDate = true;
			const existingTime = startDateVal ? startDateVal.split('T')[1] : '09:00';
			startDateVal = `${dateStr}T${existingTime}`;
		} else {
			hasDueDate = true;
			const existingTime = dueDateVal ? dueDateVal.split('T')[1] : '12:00';
			dueDateVal = `${dateStr}T${existingTime}`;
		}
	};

	const isCellSelected = (day: number, month: number, year: number) => {
		const val = activeDateField === 'start' ? startDateVal : dueDateVal;
		if (!val) return false;
		const d = new Date(val);
		return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
	};

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
		const d = dueDateVal ? new Date(dueDateVal) : new Date();
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
		const d = dueDateVal ? new Date(dueDateVal) : new Date();
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
		const d = dueDateVal ? new Date(dueDateVal) : new Date();
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

	const handleSaveDatesInline = async (cardId: string) => {
		try {
			const startStr = hasStartDate && startDateVal ? new Date(startDateVal).toISOString() : null;
			const dueStr = hasDueDate && dueDateVal ? new Date(dueDateVal).toISOString() : null;
			await taskClientStore.updateCardDates(cardId, startStr, dueStr, dueReminderVal);
			localStorage.setItem(`clopen_trello_card_recurring_${cardId}`, recurringVal);
			cancelInlineEdit();
		} catch (e) {
			debug.error('task-client', 'Failed to save dates inline:', e);
		}
	};

	const handleRemoveDatesInline = async (cardId: string) => {
		try {
			await taskClientStore.updateCardDates(cardId, null, null, -1);
			localStorage.removeItem(`clopen_trello_card_recurring_${cardId}`);
			cancelInlineEdit();
		} catch (e) {
			debug.error('task-client', 'Failed to remove dates inline:', e);
		}
	};

	const handleQuickEditAction = async (
		action: 'open' | 'labels' | 'members' | 'dates' | 'move' | 'copy' | 'copy-link' | 'mirror' | 'archive',
		cardId: string
	) => {
		const card = taskClientStore.cards.find(c => c.id === cardId);
		if (!card) return;

		if (action === 'copy-link') {
			try {
				await navigator.clipboard.writeText(card.url);
				copiedLink = true;
				setTimeout(() => { copiedLink = false; }, 1500);
			} catch (e) {
				debug.error('task-client', 'Failed to copy card link:', e);
			}
			return;
		} else if (action === 'mirror') {
			try {
				await navigator.clipboard.writeText(`[${card.name}](${card.url})`);
				copiedLink = true;
				setTimeout(() => { copiedLink = false; }, 1500);
			} catch (e) {
				debug.error('task-client', 'Failed to mirror card:', e);
			}
			return;
		}

		if (action === 'labels') {
			searchLabelQuery = '';
			activePopover = 'labels';
		} else if (action === 'members') {
			searchMemberQuery = '';
			activePopover = 'members';
		} else if (action === 'dates') {
			initDates(card);
			activePopover = 'dates';
		} else {
			cancelInlineEdit();

			if (action === 'open') {
				activeDetailCardId = card.id;
				initialSection = null;
				isDetailModalOpen = true;
			} else if (action === 'move') {
				activeDetailCardId = card.id;
				initialSection = null;
				isDetailModalOpen = true;
			} else if (action === 'copy') {
				try {
					await taskClientStore.createCard(card.idList, `${card.name} (Copy)`);
				} catch (e) {
					debug.error('task-client', 'Failed to copy card:', e);
				}
			} else if (action === 'archive') {
				try {
					await taskClientStore.archiveCard(card.id);
				} catch (e) {
					debug.error('task-client', 'Failed to archive card:', e);
				}
			}
		}
	};

	function formatCardDates(start: string | null, due: string | null): string {
		if (!due) return '';
		const formatOption = (d: string) => {
			const date = new Date(d);
			return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		};
		const dueStr = formatOption(due);
		if (!start) return dueStr;
		const startStr = formatOption(start);
		return `${startStr} - ${dueStr}`;
	}

	function getDueDateBadgeClass(card: any): string {
		if (!card.due) return '';
		if (card.dueComplete) {
			return 'bg-green-500 border-green-500 text-white hover:bg-green-600';
		}
		const dueTime = new Date(card.due).getTime();
		const nowTime = Date.now();
		const diffHrs = (dueTime - nowTime) / (1000 * 60 * 60);
		if (diffHrs < 0) {
			return 'bg-red-500 border-red-500 text-white hover:bg-red-600';
		}
		if (diffHrs < 24) {
			return 'bg-[#f2d600] border-[#d8be00]/50 text-slate-900 font-semibold hover:bg-yellow-400';
		}
		return 'bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700/80 border-transparent text-slate-500 dark:text-slate-400';
	}

	const handleCardClick = (e: MouseEvent, cardId: string) => {
		if (editingCardId === cardId) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		console.log('handleCardClick triggered for cardId:', cardId, 'button:', e.button);
		if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			activeDetailCardId = cardId;
			isDetailModalOpen = true;
			console.log('isDetailModalOpen set to true, activeDetailCardId:', cardId);
		}
	};

	const handleWindowKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape') {
			if (editingCardId) {
				cancelInlineEdit();
				e.preventDefault();
				e.stopPropagation();
			} else if (taskClientStore.error) {
				taskClientStore.error = null;
			}
		}
	};
</script>

<svelte:window onkeydown={handleWindowKeyDown} onmousedown={handleWindowMouseDown} />

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="task-client-title"
	className="flex flex-col w-full max-w-[90vw] h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		<div class="flex flex-1 min-h-0">
			<!-- Left sidebar: provider list -->
			<aside class="flex flex-col w-64 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800">
				<header class="flex items-center justify-between py-3 px-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
					<h2 id="task-client-title" class="text-sm font-bold text-slate-900 dark:text-slate-100 m-0">Task Client</h2>
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 bg-transparent border-none rounded-lg text-slate-400 cursor-pointer transition-all hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
						onclick={onClose}
						aria-label="Close"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</header>

				<div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
					<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
						Connect accounts and configure providers for your task management.
					</p>
				</div>

				<div class="flex-1 overflow-y-auto p-3">
					<div class="grid grid-cols-2 gap-2">
						{#each providers as provider}
							<button
								type="button"
								onclick={() => selectProvider(provider.id)}
								class="relative flex flex-col items-start gap-2 p-3 rounded-xl border text-left transition-all cursor-pointer
									{selectedProviderId === provider.id
										? 'border-violet-500 bg-violet-500/8 dark:bg-violet-500/10'
										: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60'}
									{!provider.available ? 'opacity-50' : ''}"
							>
								{#if !provider.available}
									<span class="absolute top-1.5 right-1.5 text-[9px] px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-slate-400 font-medium">Soon</span>
								{/if}
								<div
									class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
									style="background-color: {provider.color}20; color: {provider.color}"
								>
									<Icon name={provider.icon} class="w-4 h-4" />
								</div>
								<div class="min-w-0 w-full">
									<div class="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{provider.name}</div>
									{#if provider.id === 'trello'}
										<div class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
											{taskClientStore.accounts.length} account{taskClientStore.accounts.length !== 1 ? 's' : ''}
										</div>
									{:else}
										<div class="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">0 accounts</div>
									{/if}
								</div>
							</button>
						{/each}
					</div>
				</div>
			</aside>

			<!-- Right panel -->
			<main class="flex-1 flex flex-col min-w-0 bg-slate-50 dark:bg-slate-950 relative">
				<!-- Provider header -->
				<div class="px-6 py-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
					<div class="flex items-center gap-3">
						<div
							class="w-10 h-10 rounded-xl flex items-center justify-center"
							style="background-color: {selectedProvider.color}20; color: {selectedProvider.color}"
						>
							<Icon name={selectedProvider.icon} class="w-5 h-5" />
						</div>
						<div class="flex-1 min-w-0">
							<h3 class="text-base font-bold text-slate-900 dark:text-slate-100">{selectedProvider.name}</h3>
							<p class="text-xs text-slate-500 dark:text-slate-400">{selectedProvider.description}</p>
						</div>
					</div>
				</div>

				<!-- Floating pill tab bar - bottom center -->
				{#if selectedProviderId === 'trello'}
					<div class="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 bg-slate-900/95 backdrop-blur-md rounded-2xl px-1.5 py-1.5 border border-slate-700/60 shadow-2xl">
						<!-- Account tab -->
						<button
							type="button"
							onclick={backToAccounts}
							class="relative flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer border-none {trelloView === 'accounts' ? 'bg-slate-800 text-slate-100' : 'bg-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'}"
						>
							<Icon name="lucide:user" class="w-3.5 h-3.5" />
							Account
							{#if trelloView === 'accounts'}
								<span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-4 h-[2px] rounded-full bg-blue-500"></span>
							{/if}
						</button>

						<!-- Board tab (shown when past accounts view) -->
						{#if trelloView === 'boards' || trelloView === 'board'}
							<button
								type="button"
								onclick={backToBoards}
								class="relative flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer border-none {trelloView === 'boards' ? 'bg-slate-800 text-slate-100' : 'bg-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'}"
							>
								<Icon name="lucide:layout-dashboard" class="w-3.5 h-3.5" />
								Board
								{#if trelloView === 'boards'}
									<span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-4 h-[2px] rounded-full bg-blue-500"></span>
								{/if}
							</button>
						{/if}

						<!-- Active board name tab -->
						{#if trelloView === 'board' && taskClientStore.selectedBoard}
							<button
								type="button"
								class="relative flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold cursor-pointer border-none bg-slate-800 text-slate-100 max-w-36"
								disabled
							>
								<Icon name="lucide:trello" class="w-3.5 h-3.5 shrink-0" />
								<span class="truncate">{taskClientStore.selectedBoard.name}</span>
								<span class="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-4 h-[2px] rounded-full bg-blue-500"></span>
							</button>

							<!-- Switch boards -->
							<button
								type="button"
								onclick={backToBoards}
								class="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer border-none bg-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/60"
							>
								<Icon name="lucide:arrow-left-right" class="w-3.5 h-3.5" />
								Switch boards
							</button>
						{/if}
					</div>
				{/if}

				<!-- Trello content -->
				{#if selectedProviderId === 'trello'}
					{#if trelloView === 'accounts'}
						<!-- Accounts list -->
						<div class="flex-1 overflow-y-auto p-6">
							<div class="max-w-xl mx-auto w-full flex flex-col gap-6">
							{#if taskClientStore.recentBoards.length > 0}
								<div class="mb-6">
									<h4 class="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">Recent Boards</h4>
									<div class="grid grid-cols-2 gap-3">
										{#each taskClientStore.recentBoards as board}
											<button
												type="button"
												onclick={() => selectRecentBoardAndLoad(board.id, board.accountId)}
												class="relative flex flex-col items-start gap-1 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-violet-400 dark:hover:border-violet-500/60 hover:shadow-md hover:shadow-violet-500/5 transition-all text-left cursor-pointer group overflow-hidden"
											>
												<div
													class="absolute inset-0 opacity-5 dark:opacity-10 pointer-events-none transition-opacity group-hover:opacity-10 dark:group-hover:opacity-15"
													style="background-color: {board.prefs?.backgroundColor ?? '#0052CC'}; background-image: {board.prefs?.backgroundImage ? `url(${board.prefs.backgroundImage})` : 'none'}; background-size: cover; background-position: center;"
												></div>
												
												<div class="flex items-center gap-2 z-10 w-full min-w-0">
													<div class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {board.prefs?.backgroundColor ?? '#0052CC'}"></div>
													<span class="text-xs font-bold text-slate-800 dark:text-slate-100 truncate flex-1">{board.name}</span>
												</div>
												
												<div class="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 z-10 truncate w-full mt-1.5 pl-4">
													<Icon name="lucide:user" class="w-3 h-3 shrink-0" />
													<span class="truncate">{board.accountName}</span>
												</div>
											</button>
										{/each}
									</div>
								</div>
							{/if}

							<!-- Section header -->
							<div class="flex items-center justify-between mb-4">
								<div>
									<h4 class="text-sm font-bold text-slate-800 dark:text-slate-100">Connected Accounts</h4>
									<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Click an account to browse its boards</p>
								</div>
								{#if taskClientStore.accounts.length > 0}
									<span class="text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2.5 py-1 rounded-full">
										{taskClientStore.accounts.length} connected
									</span>
								{/if}
							</div>

							{#if taskClientStore.accounts.length > 0}
								<div class="grid grid-cols-1 gap-3">
									{#each taskClientStore.accounts as account}
										<div class="group relative">
											<!-- Main card button -->
											<button
												type="button"
												onclick={() => selectAccountAndLoad(account.id)}
												class="w-full flex items-center gap-4 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-violet-400 dark:hover:border-violet-500/60 hover:shadow-md hover:shadow-violet-500/5 transition-all text-left cursor-pointer"
											>
												<!-- Avatar -->
												<div class="relative shrink-0">
													{#if account.me?.avatarUrl}
														<img src="{account.me.avatarUrl}/50.png" alt={account.displayName} class="w-10 h-10 rounded-full object-cover ring-2 ring-slate-200 dark:ring-slate-700" />
													{:else}
														<div class="w-10 h-10 rounded-full bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center ring-2 ring-violet-500/20">
															<Icon name="lucide:user" class="w-5 h-5 text-white" />
														</div>
													{/if}
													<!-- Online indicator -->
													<span class="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 rounded-full ring-2 ring-white dark:ring-slate-900"></span>
												</div>

												<!-- Info -->
												<div class="flex-1 min-w-0">
													<div class="flex items-center gap-2">
														<span class="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{account.displayName}</span>
														<span class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">Connected</span>
													</div>
													{#if account.me?.username}
														<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">@{account.me.username}</div>
													{/if}
												</div>

												<!-- Spacing placeholder for Arrow & Action buttons -->
												<div class="w-18 h-8 shrink-0 flex items-center justify-end">
													<!-- Arrow (fades out on hover) -->
													<Icon name="lucide:arrow-right" class="w-4 h-4 text-slate-300 dark:text-slate-600 group-hover:opacity-0 group-hover:scale-75 transition-all duration-200 shrink-0" />
												</div>
											</button>

											<!-- Actions container - appears on hover, perfectly aligned over the arrow -->
											<div class="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100 flex items-center gap-1.5 transition-all duration-200 z-10">
												<!-- Edit button -->
												<button
													type="button"
													onclick={(e) => { e.stopPropagation(); openEditForm(account); }}
													aria-label="Edit account"
													class="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 transition-all duration-200 border-none cursor-pointer"
												>
													<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
												</button>

												<!-- Delete button -->
												<button
													type="button"
													onclick={(e) => { e.stopPropagation(); taskClientStore.removeAccount(account.id); }}
													aria-label="Remove account"
													class="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-red-500/10 hover:text-red-500 transition-all duration-200 border-none cursor-pointer"
												>
													<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
												</button>
											</div>
										</div>
									{/each}
								</div>
							{:else if !showAddForm}
								<!-- Empty state -->
								<div class="flex flex-col items-center justify-center py-16 text-center">
									<div class="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800/60 flex items-center justify-center mb-4">
										<Icon name="lucide:trello" class="w-8 h-8 text-slate-400" />
									</div>
									<p class="text-sm font-semibold text-slate-700 dark:text-slate-300">No accounts connected</p>
									<p class="text-xs text-slate-400 dark:text-slate-500 mt-1">Add your Trello account to get started</p>
								</div>
							{/if}

							<!-- Add Account button (always visible below cards) -->
							{#if !showAddForm}
								<div class="mt-4">
									<button
										type="button"
										onclick={openAddForm}
										class="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 text-sm text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/5 hover:border-violet-400 dark:hover:border-violet-500/50 transition-all cursor-pointer bg-transparent"
									>
										<Icon name="lucide:plus" class="w-4 h-4" />
										<span>Add Account</span>
									</button>
								</div>
							{/if}

							<!-- Add/Edit account form -->
							{#if showAddForm}
								<div class="mt-4 p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col gap-3">
									<h5 class="text-xs font-bold text-slate-800 dark:text-slate-200 m-0">
										{editingAccountId ? 'Edit Account' : 'Connect Account'}
									</h5>

									<div class="text-xs text-slate-500 dark:text-slate-400 space-y-1.5">
										<p class="m-0">
											1. Get your <strong>API Key</strong> from
											<a href="https://trello.com/power-ups/admin" target="_blank" rel="noopener noreferrer" class="text-violet-600 hover:underline">trello.com/power-ups/admin</a>.
										</p>
										<p class="m-0">
											2. After entering your API Key below, click the authorization button to generate a token with <strong>Read & Write</strong> permissions (required for Trello stars & edit capabilities):
										</p>
									</div>

									<!-- Display Name Input -->
									<div class="flex flex-col gap-1.5">
										<label for="trello-display-name" class="text-xs font-semibold text-slate-600 dark:text-slate-400">
											Display Name (optional)
										</label>
										<input id="trello-display-name" type="text" placeholder="e.g. My Work Account" bind:value={addName} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition" />
									</div>

									<!-- API Key Input -->
									{#if editingAccountId}
										{#if !isEditingApiKey}
											<div class="flex flex-col gap-1.5">
												<label class="text-xs font-semibold text-slate-600 dark:text-slate-400">
													API Key
												</label>
												<div class="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-slate-800 dark:text-slate-200 font-mono text-sm h-9">
													<span>••••••••{addApiKey.slice(-4)}</span>
													<button
														type="button"
														onclick={() => { isEditingApiKey = true; tempApiKey = ''; }}
														class="text-xs font-bold text-violet-600 dark:text-violet-400 hover:text-violet-700 hover:underline border-none bg-transparent cursor-pointer"
													>
														Change
													</button>
												</div>
											</div>
										{:else}
											<div class="flex flex-col gap-1.5">
												<label for="trello-api-key" class="text-xs font-semibold text-slate-600 dark:text-slate-400">
													New API Key
												</label>
												<div class="flex items-center gap-2">
													<input
														id="trello-api-key"
														type="text"
														placeholder="Enter new Trello API Key"
														bind:value={tempApiKey}
														class="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition font-mono"
													/>
													<button
														type="button"
														onclick={() => { if (tempApiKey.trim()) { addApiKey = tempApiKey.trim(); isEditingApiKey = false; } }}
														class="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold cursor-pointer border-none transition-colors shrink-0"
													>
														Save
													</button>
													<button
														type="button"
														onclick={() => { isEditingApiKey = false; }}
														class="px-3.5 py-2 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-semibold cursor-pointer bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
													>
														Cancel
													</button>
												</div>
											</div>
										{/if}
									{:else}
										<div class="flex flex-col gap-1.5">
											<label for="trello-api-key" class="text-xs font-semibold text-slate-600 dark:text-slate-400">
												API Key
											</label>
											<input id="trello-api-key" type="text" placeholder="Enter Trello API Key" bind:value={addApiKey} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition font-mono" />
										</div>
									{/if}
									
									{#if addApiKey.trim()}
										<a
											href="https://trello.com/1/authorize?expiration=never&name=Clopen&scope=read,write&response_type=token&key={addApiKey.trim()}"
											target="_blank"
											rel="noopener noreferrer"
											class="flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400 hover:bg-violet-500/15 text-xs font-semibold text-center transition decoration-none border border-violet-500/20"
										>
											<Icon name="lucide:key-round" class="w-3.5 h-3.5" />
											Authorize Token (Read & Write)
										</a>
									{:else}
										<div class="text-[10px] text-slate-400 bg-slate-50 dark:bg-slate-800/40 p-2.5 rounded-xl border border-slate-200/50 dark:border-slate-800 flex items-center gap-1.5">
											<Icon name="lucide:info" class="w-3.5 h-3.5 shrink-0 text-slate-400" />
											<span>Enter your API Key first to display the token authorization link.</span>
										</div>
									{/if}

									<!-- Token Input -->
									{#if editingAccountId}
										{#if !isEditingToken}
											<div class="flex flex-col gap-1.5">
												<label class="text-xs font-semibold text-slate-600 dark:text-slate-400">
													Token
												</label>
												<div class="flex items-center justify-between px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 text-slate-800 dark:text-slate-200 font-mono text-sm h-9">
													<span>••••••••{addToken.slice(-4)}</span>
													<button
														type="button"
														onclick={() => { isEditingToken = true; tempToken = ''; }}
														class="text-xs font-bold text-violet-600 dark:text-violet-400 hover:text-violet-700 hover:underline border-none bg-transparent cursor-pointer"
													>
														Change
													</button>
												</div>
											</div>
										{:else}
											<div class="flex flex-col gap-1.5">
												<label for="trello-token" class="text-xs font-semibold text-slate-600 dark:text-slate-400">
													New Token
												</label>
												<div class="flex items-center gap-2">
													<input
														id="trello-token"
														type="password"
														placeholder="Enter new Trello Token"
														bind:value={tempToken}
														class="flex-1 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition font-mono"
													/>
													<button
														type="button"
														onclick={() => { if (tempToken.trim()) { addToken = tempToken.trim(); isEditingToken = false; } }}
														class="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold cursor-pointer border-none transition-colors shrink-0"
													>
														Save
													</button>
													<button
														type="button"
														onclick={() => { isEditingToken = false; }}
														class="px-3.5 py-2 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-semibold cursor-pointer bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
													>
														Cancel
													</button>
												</div>
											</div>
										{/if}
									{:else}
										<div class="flex flex-col gap-1.5">
											<label for="trello-token" class="text-xs font-semibold text-slate-600 dark:text-slate-400">
												Token
											</label>
											<input id="trello-token" type="password" placeholder="Enter Trello Token" bind:value={addToken} class="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500 transition font-mono" />
										</div>
									{/if}
									{#if addError}
										<p class="text-xs text-red-500">{addError}</p>
									{/if}
									<div class="flex gap-2 justify-end">
										<button type="button" onclick={cancelAdd} disabled={addLoading} class="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer bg-transparent disabled:opacity-50">Cancel</button>
										<button type="button" onclick={confirmAdd} disabled={addLoading} class="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-medium transition cursor-pointer border-none disabled:opacity-50">
											{#if addLoading}
												<Icon name="lucide:loader" class="w-3 h-3 animate-spin" /> {editingAccountId ? 'Updating…' : 'Connecting…'}
											{:else}
												{editingAccountId ? 'Update Account' : 'Connect Account'}
											{/if}
										</button>
									</div>
								</div>
							{/if}
							</div>
						</div>

					{:else if trelloView === 'boards'}
						<!-- Boards list -->
						{#if taskClientStore.loadingBoards}
							<div class="flex-1 flex flex-col items-center justify-center p-6 gap-3 text-slate-500 dark:text-slate-400">
								<Icon name="lucide:loader" class="w-6 h-6 animate-spin text-violet-500" />
								<span class="text-sm font-semibold">Loading boards…</span>
							</div>
						{:else}
							<div class="flex-1 overflow-y-auto p-6">
								{#snippet boardCard(board: TrelloBoard)}
									<div
										role="button"
										tabindex="0"
										onclick={() => openBoard(board.id)}
										onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBoard(board.id); } }}
										class="relative flex flex-col justify-end w-full h-24 p-3.5 rounded-xl hover:shadow-md transition-all text-left cursor-pointer group overflow-hidden border-none text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
										style="background-color: {board.prefs?.backgroundColor ?? '#0052CC'}; background-image: {board.prefs?.backgroundImage ? `url(${board.prefs.backgroundImage})` : 'none'}; background-size: cover; background-position: center;"
									>
										<div class="absolute inset-0 bg-gradient-to-t from-black/50 via-black/20 to-black/10 group-hover:from-black/60 group-hover:via-black/35 group-hover:to-black/20 transition-all duration-200"></div>
										
										<!-- Star Toggle Button -->
										<button
											type="button"
											onclick={(e) => {
												e.stopPropagation();
												taskClientStore.toggleBoardStar(board.id);
											}}
											class="absolute top-2.5 right-2.5 z-20 flex items-center justify-center w-7 h-7 rounded-lg text-white hover:bg-white/20 transition-all cursor-pointer border-none bg-transparent"
											aria-label={taskClientStore.boardStars.some(s => s.idBoard === board.id) ? "Unstar board" : "Star board"}
										>
											<Icon
												name="lucide:star"
												class="w-4 h-4 transition-all {taskClientStore.boardStars.some(s => s.idBoard === board.id) ? 'text-amber-400 fill-amber-400 opacity-100 scale-110' : 'text-white opacity-0 group-hover:opacity-100 hover:scale-110'}"
											/>
										</button>

										<div class="relative z-10 w-full min-w-0">
											<div class="text-sm font-bold line-clamp-2 leading-tight drop-shadow-sm">{board.name}</div>
											{#if board.desc}
												<div class="text-[10px] text-white/80 line-clamp-1 mt-0.5 font-normal leading-normal">{board.desc}</div>
											{/if}
										</div>
									</div>
								{/snippet}

								{#if taskClientStore.boards.length === 0}
									<div class="flex flex-col items-center justify-center py-16 text-center">
										<div class="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800/60 flex items-center justify-center mb-4">
											<Icon name="lucide:trello" class="w-8 h-8 text-slate-400" />
										</div>
										<p class="text-sm font-semibold text-slate-700 dark:text-slate-300">No boards found</p>
									</div>
								{:else}
									<div class="flex flex-col gap-6">
										{#if starredBoards.length > 0}
											<div>
												<!-- Starred Boards Header -->
												<div class="flex items-center gap-2 mb-3 px-1">
													<div class="w-6 h-6 rounded-lg bg-amber-500/10 dark:bg-amber-500/20 flex items-center justify-center text-amber-500">
														<Icon name="lucide:star" class="w-3.5 h-3.5 fill-amber-500" />
													</div>
													<h4 class="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Starred Boards</h4>
													<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200/50 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400">{starredBoards.length}</span>
												</div>
												
												<!-- Starred Boards Grid -->
												<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
													{#each starredBoards as board}
														{@render boardCard(board)}
													{/each}
												</div>
											</div>
										{/if}

										{#each groupedWorkspaces as group}
											<div>
												<!-- Workspace Header -->
												<div class="flex items-center gap-2 mb-3 px-1">
													<div class="w-6 h-6 rounded-lg bg-slate-200/50 dark:bg-slate-800/40 flex items-center justify-center text-slate-500 dark:text-slate-400">
														<Icon name="lucide:briefcase" class="w-3.5 h-3.5" />
													</div>
													<h4 class="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{group.name}</h4>
													<span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-200/50 dark:bg-slate-800/40 text-slate-500 dark:text-slate-400">{group.boards.length}</span>
												</div>
												
												<!-- Boards Grid -->
												<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
													{#each group.boards as board}
														{@render boardCard(board)}
													{/each}
												</div>
											</div>
										{/each}
									</div>
								{/if}
							</div>
						{/if}

					{:else if trelloView === 'board'}
						<!-- Board kanban view wrapper -->
						<div
							class="flex-1 flex flex-col min-h-0 relative"
							style="background-color: {taskClientStore.selectedBoard?.prefs?.backgroundColor ?? '#0052CC'}; background-image: {taskClientStore.selectedBoard?.prefs?.backgroundImage ? `url(${taskClientStore.selectedBoard.prefs.backgroundImage})` : 'none'}; background-size: cover; background-position: center;"
						>
							{#if taskClientStore.loadingCards}
								<div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white bg-black/25 backdrop-blur-xs">
									<div class="p-4 rounded-2xl bg-slate-900/60 backdrop-blur-md border border-slate-700/30 flex items-center gap-3 shadow-2xl">
										<Icon name="lucide:loader" class="w-5 h-5 animate-spin text-violet-400" />
										<span class="text-sm font-semibold">Loading board…</span>
									</div>
								</div>
							{/if}

							<div class="flex-1 overflow-x-auto p-4 pb-20">
								<div class="flex gap-3 items-start h-full min-w-max">
									{#each taskClientStore.lists as list}
										{@const listCards = taskClientStore.getCardsForList(list.id)}
										{@const visibleCards = listCards.filter(c => c.id !== draggingId)}
										<div
											class="flex flex-col w-64 shrink-0 rounded-xl border transition-all max-h-full
												{activeDropListId === list.id
													? 'border-violet-500 bg-violet-50/50 dark:bg-violet-950/20 shadow-md ring-2 ring-violet-500/10'
													: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'}"
											ondragover={(e) => handleDragOver(e, list.id)}
											ondrop={(e) => handleDrop(e, list.id)}
										>
											<div class="relative flex items-center justify-between px-3 py-2 shrink-0 rounded-t-xl">
												<div class="flex items-center gap-1.5 min-w-0">
													<h5 class="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider truncate">{list.name}</h5>
													<span class="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800 rounded-full px-1.5 py-0.5 shrink-0">{listCards.length}</span>
												</div>
												<button
													type="button"
													onclick={() => toggleListActionsMenu(list.id)}
													class="flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors border-none bg-transparent cursor-pointer shrink-0"
													aria-label="List actions"
												>
													<Icon name="lucide:ellipsis" class="w-3.5 h-3.5" />
												</button>

												<!-- Dropdown Actions Menu -->
												{#if activeListActionsMenuId === list.id}
													<!-- Transparent click-outside backdrop overlay -->
													<button
														type="button"
														class="fixed inset-0 z-40 bg-transparent cursor-default border-none w-full h-full"
														onclick={closeListActionsMenu}
														aria-label="Close menu"
													></button>

													<div
														class="absolute -right-52 top-full mt-1.5 z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl p-2.5 text-left flex flex-col w-60"
													>
														<!-- Menu Header -->
														<div class="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800 mb-2 shrink-0">
															<span class="text-xs font-bold text-slate-500 dark:text-slate-400">List actions</span>
															<button
																type="button"
																onclick={closeListActionsMenu}
																class="flex items-center justify-center w-5 h-5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 border-none bg-transparent cursor-pointer"
															>
																<Icon name="lucide:x" class="w-3.5 h-3.5" />
															</button>
														</div>

														<!-- Action Links -->
														<div class="flex flex-col gap-0.5 text-xs text-slate-700 dark:text-slate-300">
															<button
																type="button"
																onclick={() => triggerAddCardFromMenu(list.id)}
																class="w-full text-left px-2 py-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer border-none bg-transparent"
															>
																Add card
															</button>

															<hr class="border-slate-100 dark:border-slate-800 my-1" />

															<!-- Archive Options -->
															<button
																type="button"
																onclick={() => triggerArchiveList(list.id)}
																class="w-full text-left px-2 py-1.5 rounded hover:bg-red-500/10 hover:text-red-500 transition cursor-pointer border-none bg-transparent"
															>
																Archive this list
															</button>
															<button
																type="button"
																onclick={() => triggerArchiveAllCards(list.id)}
																class="w-full text-left px-2 py-1.5 rounded hover:bg-red-500/10 hover:text-red-500 transition cursor-pointer border-none bg-transparent"
															>
																Archive all cards in this list
															</button>
														</div>
													</div>
												{/if}
											</div>
											{#if visibleCards.length > 0 || activeDropListId === list.id || addingCardListId === list.id}
												<div class="flex-1 overflow-y-auto p-2 flex flex-col gap-2 cards-list-container">
													{#each visibleCards as card, idx}
														{@const cardChecklists = taskClientStore.boardChecklists.filter(cl => cl.idCard === card.id)}
														<!-- Visual drag placeholder slot before the card -->
														{#if activeDropListId === list.id && activeDropIndex === idx}
															<div class="h-16 rounded-lg border-2 border-dashed border-violet-400 dark:border-violet-800/85 bg-violet-500/5 transition-all shrink-0"></div>
														{/if}

														<a
															href={card.url}
															target="_blank"
															rel="noopener noreferrer"
															onclick={(e) => handleCardClick(e, card.id)}
															draggable={editingCardId !== card.id}
															ondragstart={(e) => handleDragStart(e, card.id)}
															ondragend={handleDragEnd}
															data-card-id={card.id}
															class="relative block p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm transition-all cursor-pointer active:cursor-grabbing group {editingCardId === card.id ? 'opacity-0 pointer-events-none' : ''}"
														>
															<!-- Edit Button (Pencil Icon) -->
															{#if editingCardId !== card.id}
																<button
																	type="button"
																	onclick={(e) => {
																		e.stopPropagation();
																		e.preventDefault();
																		startInlineEdit(card, e);
																	}}
																	class="absolute top-2 right-2 w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 flex items-center justify-center border border-slate-200/50 dark:border-slate-700/50 cursor-pointer shadow-xs z-10 opacity-0 group-hover:opacity-100 transition-opacity"
																	title="Quick edit card"
																>
																	<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
																</button>
															{/if}
															<!-- Labels -->
															{#if card.labels.length > 0}
																<div class="flex flex-wrap gap-1 mb-2">
																	{#each card.labels as label}
																		{@const labelColorMap: Record<string, string> = {
																			'green': '#61bd4f', 'yellow': '#f2d600', 'orange': '#ff9f1a',
																			'red': '#eb5a46', 'purple': '#c377e0', 'blue': '#0079bf',
																			'sky': '#00c2e0', 'lime': '#51e898', 'pink': '#ff78cb', 'black': '#344563'
																		}}
																		{@const bg = labelColorMap[label.color] ?? label.color ?? '#6b7280'}
																		<button
																			type="button"
																			onclick={(e) => {
																				e.stopPropagation();
																				e.preventDefault();
																				taskClientStore.toggleLabelsExpanded();
																			}}
																			class="transition-all cursor-pointer shadow-xs shrink-0 select-none border-none
																				{taskClientStore.labelsExpanded
																					? 'inline-flex items-center justify-center min-w-[40px] h-4 text-[9px] font-bold px-1.5 rounded text-white leading-none hover:brightness-110 active:scale-95'
																					: 'inline-block w-10 h-2 rounded hover:brightness-110 active:scale-95'}
																				{taskClientStore.colorblindMode ? `colorblind-pattern-${label.color}` : ''}"
																			style="background-color: {bg}"
																			title={label.name || label.color}
																		>
																			{#if taskClientStore.labelsExpanded}
																				{label.name || ''}
																			{/if}
																		</button>
																	{/each}
																</div>
															{/if}

															<!-- Title -->
															<div class="flex items-start mb-2 min-w-0 pr-6 w-full">
																<button
																	type="button"
																	class="flex items-center justify-center rounded-full border shrink-0 mt-0.5 transition-all duration-200 ease-in-out overflow-hidden
																		{card.dueComplete
																			? 'w-4 h-4 bg-green-500 border-green-500 text-white hover:bg-green-600 hover:border-green-600 opacity-100 mr-2'
																			: 'w-0 h-4 border-slate-300 dark:border-slate-600 text-transparent hover:text-slate-400 dark:hover:text-slate-500 hover:border-slate-400 dark:hover:border-slate-500 hover:bg-slate-50 dark:hover:bg-slate-700 bg-transparent opacity-0 mr-0 group-hover:opacity-100 group-hover:w-4 group-hover:mr-2'}"
																	title={card.dueComplete ? "Mark incomplete" : "Mark complete"}
																	onclick={(e) => {
																		e.stopPropagation();
																		e.preventDefault();
																		taskClientStore.toggleDueComplete(card.id, !card.dueComplete);
																	}}
																>
																	<Icon name="lucide:check" class="w-2.5 h-2.5 stroke-[3]" />
																</button>
																<p class="text-[13px] font-medium leading-snug flex-1 {card.dueComplete ? 'line-through text-slate-400 dark:text-slate-500' : 'text-slate-800 dark:text-slate-200'}">{card.name}</p>
															</div>

															<!-- Bottom row: badges + avatars -->
															<div class="flex items-center justify-between gap-1 mt-1">
																<div class="flex items-center gap-1.5 flex-wrap">
																	<!-- Due date -->
																	{#if card.due}
																		<span class="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-transparent transition-all {getDueDateBadgeClass(card)}">
																			<Icon name="lucide:clock" class="w-3.5 h-3.5 shrink-0" />
																			<span>{formatCardDates(card.start, card.due)}</span>
																		</span>
																	{/if}

																	<!-- Description -->
																	{#if card.badges?.description || card.desc}
																		<span class="flex items-center text-slate-400 dark:text-slate-500 py-0.5" title="This card has a description.">
																			<Icon name="lucide:align-left" class="w-3.5 h-3.5" />
																		</span>
																	{/if}

																	<!-- Checklist -->
																	{#if card.badges?.checkItems > 0}
																		<button
																			type="button"
																			class="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded transition-all cursor-pointer select-none active:scale-95 border
																				{showCardChecklists[card.id]
																					? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-semibold border-blue-200 dark:border-blue-800/80 shadow-xs'
																					: card.badges.checkItemsChecked === card.badges.checkItems
																						? 'bg-green-100 border-green-200/50 dark:bg-green-900/40 dark:border-green-800/30 text-green-600 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/60 hover:border-green-300 dark:hover:border-green-800'
																						: 'border-transparent text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 hover:border-slate-300 dark:hover:border-slate-700'}"
																			onclick={(e) => {
																				e.stopPropagation();
																				e.preventDefault();
																				showCardChecklists[card.id] = !showCardChecklists[card.id];
																			}}
																		>
																			<Icon name="lucide:square-check" class="w-3 h-3" />
																			<span>{card.badges.checkItemsChecked}/{card.badges.checkItems}</span>
																		</button>
																	{/if}

																	<!-- Subscribed/watch -->
																	{#if card.badges?.subscribed}
																		<span class="flex items-center text-slate-400 dark:text-slate-500 py-0.5" title="You are watching this card.">
																			<Icon name="lucide:eye" class="w-3.5 h-3.5" />
																		</span>
																	{/if}

																	<!-- Attachments -->
																	{#if card.badges?.attachments > 0}
																		<span class="flex items-center gap-0.5 text-[10px] text-slate-400">
																			<Icon name="lucide:paperclip" class="w-3.5 h-3.5" />
																			<span>{card.badges.attachments}</span>
																		</span>
																	{/if}

																	<!-- Comments -->
																	{#if card.badges?.comments > 0}
																		<span class="flex items-center gap-0.5 text-[10px] text-slate-400">
																			<Icon name="lucide:message-square" class="w-3.5 h-3.5" />
																			<span>{card.badges.comments}</span>
																		</span>
																	{/if}
																</div>

																<!-- Member avatars -->
																{#if card.members?.length > 0}
																	<div class="flex items-center -space-x-1.5 shrink-0">
																		{#each card.members.slice(0, 3) as member}
																			{#if member.avatarUrl}
																				<img
																					src="{member.avatarUrl}/30.png"
																					alt={member.fullName}
																					title={member.fullName}
																					class="w-6 h-6 rounded-full border-2 border-white dark:border-slate-800 object-cover"
																				/>
																			{:else}
																				<div class="w-6 h-6 rounded-full border-2 border-white dark:border-slate-800 bg-violet-500 flex items-center justify-center text-[9px] font-bold text-white" title={member.fullName}>
																					{member.fullName.charAt(0).toUpperCase()}
																				</div>
																			{/if}
																		{/each}
																		{#if card.members.length > 3}
																			<div class="w-6 h-6 rounded-full border-2 border-white dark:border-slate-800 bg-slate-300 dark:bg-slate-600 flex items-center justify-center text-[9px] font-bold text-slate-600 dark:text-slate-300">
																				+{card.members.length - 3}
																			</div>
																		{/if}
																	</div>
																{/if}
															</div>

															<!-- Checklists Accordions -->
															{#if showCardChecklists[card.id] && cardChecklists.length > 0}
																<div class="border-t border-slate-100 dark:border-slate-700/60 mt-2 pt-2 flex flex-col gap-1">
																	{#each cardChecklists as checklist}
																		{@const isExpanded = expandedChecklists[checklist.id] ?? false}
																		<div class="flex flex-col">
																			<button
																				type="button"
																				class="flex items-center justify-between w-full text-left text-[11px] font-semibold py-1 px-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800/80 transition-colors group/header text-slate-600 dark:text-slate-400"
																				onclick={(e) => {
																					e.stopPropagation();
																					e.preventDefault();
																					expandedChecklists[checklist.id] = !expandedChecklists[checklist.id];
																				}}
																			>
																				<div class="flex items-center gap-1 min-w-0">
																					<Icon
																						name={isExpanded ? "lucide:chevron-down" : "lucide:chevron-right"}
																						class="w-3.5 h-3.5 shrink-0 text-slate-400"
																					/>
																					<span class="truncate">{checklist.name}</span>
																				</div>
																				<span class="text-[10px] text-slate-400 font-medium shrink-0 ml-2">
																					{checklist.checkItems?.filter(i => i.state === 'complete').length ?? 0}/{checklist.checkItems?.length ?? 0}
																				</span>
																			</button>
																			{#if isExpanded && checklist.checkItems && checklist.checkItems.length > 0}
																				<div class="flex flex-col gap-1 pl-4 pr-1 py-1">
																					{#each checklist.checkItems as item}
																						{@const isItemComplete = item.state === 'complete'}
																						<button
																							type="button"
																							class="flex items-center gap-1.5 text-left text-[11px] py-0.5 w-full hover:bg-slate-50 dark:hover:bg-slate-700/50 rounded transition-colors group/item"
																							onclick={(e) => {
																								e.stopPropagation();
																								e.preventDefault();
																								const newState = isItemComplete ? 'incomplete' : 'complete';
																								taskClientStore.updateCheckItemState(card.id, checklist.id, item.id, newState);
																							}}
																						>
																							<div class="flex items-center justify-center w-3.5 h-3.5 rounded border shrink-0 transition-all
																								{isItemComplete
																									? 'bg-blue-500 border-blue-500 text-white dark:bg-blue-600 dark:border-blue-600'
																									: 'border-slate-300 dark:border-slate-600 bg-transparent text-transparent group-hover/item:border-slate-400 group-hover/item:dark:border-slate-500'}"
																							>
																								{#if isItemComplete}
																									<Icon name="lucide:check" class="w-2.5 h-2.5 stroke-[3]" />
																								{/if}
																							</div>
																							<span class="truncate leading-tight flex-1 {isItemComplete ? 'line-through text-slate-400 dark:text-slate-500' : 'text-slate-700 dark:text-slate-300'}">
																								{item.name}
																							</span>
																						</button>
																					{/each}
																				</div>
																			{/if}
																		</div>
																	{/each}
																</div>
															{/if}
														</a>
													{/each}

													<!-- Visual drag placeholder slot at the end of list -->
													{#if activeDropListId === list.id && activeDropIndex === visibleCards.length}
														<div class="h-16 rounded-lg border-2 border-dashed border-violet-400 dark:border-violet-800/85 bg-violet-500/5 transition-all shrink-0"></div>
													{/if}

													<!-- Add Card Input Form -->
													{#if addingCardListId === list.id}
														<div class="flex flex-col gap-2 p-2.5 rounded-lg border border-violet-200 dark:border-violet-800 bg-white dark:bg-slate-900 shadow-sm shrink-0">
															<textarea
																use:focusOnMount
																bind:value={newCardName}
																placeholder="Enter a title for this card..."
																class="w-full text-[13px] bg-transparent border-none resize-none text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none leading-snug p-0"
																rows="2"
																disabled={addCardLoading}
																onkeydown={(e) => handleAddCardKeydown(e, list.id)}
															></textarea>
															<div class="flex items-center gap-1.5 mt-1 shrink-0">
																<button
																	type="button"
																	onclick={() => submitNewCard(list.id)}
																	disabled={addCardLoading || !newCardName.trim()}
																	class="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-violet-600 hover:bg-violet-700 text-white font-medium transition cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
																>
																	{#if addCardLoading}
																		<Icon name="lucide:loader" class="w-3 h-3 animate-spin" />
																	{/if}
																	Add card
																</button>
																<button
																	type="button"
																	onclick={cancelAddCard}
																	disabled={addCardLoading}
																	class="flex items-center justify-center w-7 h-7 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer border-none bg-transparent"
																	aria-label="Cancel"
																>
																	<Icon name="lucide:x" class="w-4 h-4" />
																</button>
															</div>
														</div>
													{/if}
												</div>
											{/if}

											<!-- Add card button footer -->
											{#if addingCardListId !== list.id}
												<div class="p-2 shrink-0 rounded-b-xl">
													<button
														type="button"
														onclick={() => startAddCard(list.id)}
														class="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-500/5 dark:hover:bg-violet-500/8 transition rounded-lg cursor-pointer bg-transparent border-none"
													>
														<div class="flex items-center gap-1.5">
															<Icon name="lucide:plus" class="w-3.5 h-3.5" />
															<span>Add a card</span>
														</div>
														<Icon name="lucide:square-plus" class="w-3.5 h-3.5 opacity-60 hover:opacity-100 transition-opacity" />
													</button>
												</div>
											{/if}
										</div>
									{/each}
									{#if taskClientStore.lists.length === 0}
										<div class="flex items-center justify-center w-full text-slate-500 dark:text-slate-400">
											<p class="text-sm">No lists in this board</p>
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/if}

				{:else}
					<!-- Coming soon for other providers -->
					<div class="flex-1 flex flex-col items-center justify-center gap-3 p-6">
						<div
							class="w-16 h-16 rounded-2xl flex items-center justify-center"
							style="background-color: {selectedProvider.color}15; color: {selectedProvider.color}"
						>
							<Icon name={selectedProvider.icon} class="w-8 h-8" />
						</div>
						<h4 class="text-base font-semibold text-slate-800 dark:text-slate-200">{selectedProvider.name}</h4>
						<p class="text-sm text-slate-500 dark:text-slate-400 text-center max-w-xs">
							{selectedProvider.name} integration is coming soon.
						</p>
						<span class="text-xs px-3 py-1.5 bg-slate-100 dark:bg-slate-800 rounded-full text-slate-500 dark:text-slate-400 font-medium">Coming Soon</span>
					</div>
				{/if}
			</main>
		</div>

		<CardDetailModal
			cardId={activeDetailCardId}
			isOpen={isDetailModalOpen}
			initialSection={initialSection}
			onClose={() => {
				isDetailModalOpen = false;
				activeDetailCardId = null;
				initialSection = null;
			}}
		/>

		{#if editingCardId && editingCardRect}
			{@const card = taskClientStore.cards.find(c => c.id === editingCardId)}
			<!-- Backdrop overlay -->
			<button
				type="button"
				class="fixed inset-0 z-[300] bg-black/60 cursor-default border-none w-full h-full animate-in fade-in duration-150"
				onclick={cancelInlineEdit}
				aria-label="Close inline edit"
			></button>

			<!-- Floating Card Edit Container (Left side / over the card) -->
			<div
				class="fixed z-[310] flex flex-col pointer-events-auto floating-card-edit-container"
				style="
					top: {editingCardRect.top}px;
					left: {editingCardRect.left}px;
					width: {editingCardRect.width}px;
				"
			>
				<div class="bg-white dark:bg-slate-800 p-2.5 rounded-lg border border-slate-200/80 dark:border-slate-700/80 shadow-2xl flex flex-col gap-1.5">
					<!-- Re-render the labels above the title -->
					{#if card && card.labels.length > 0}
						<div class="flex flex-wrap gap-1 mb-1.5 select-none">
							{#each card.labels as label}
								{@const labelColorMap: Record<string, string> = {
									'green': '#61bd4f', 'yellow': '#f2d600', 'orange': '#ff9f1a',
									'red': '#eb5a46', 'purple': '#c377e0', 'blue': '#0079bf',
									'sky': '#00c2e0', 'lime': '#51e898', 'pink': '#ff78cb', 'black': '#344563'
								}}
								{@const bg = labelColorMap[label.color] ?? label.color ?? '#6b7280'}
								<span
									style="background-color: {bg}"
									class="inline-block w-10 h-2 rounded {taskClientStore.colorblindMode ? `colorblind-pattern-${label.color}` : ''}"
									title={label.name || label.color}
								></span>
							{/each}
						</div>
					{/if}

					<textarea
						bind:value={editingCardTitle}
						use:focusTextarea
						class="w-full bg-transparent border-none outline-none text-[13px] font-medium leading-snug text-slate-800 dark:text-slate-200 resize-none p-0 focus:ring-0 focus:outline-none"
						rows="3"
						onkeydown={(e) => handleInlineEditKeyDown(e, editingCardId!)}
					></textarea>
				</div>

				<button
					type="button"
					onclick={() => saveInlineEdit(editingCardId!)}
					class="mt-2 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-lg shadow-md transition-colors cursor-pointer border-none self-start"
				>
					Save
				</button>
			</div>

			<!-- Quick edit actions panel -->
			{#if activePopover}
				{#if activePopover === 'actions'}
					<!-- Stack of individual floaty buttons next to card -->
					<div
						class="fixed z-[310] flex flex-col gap-1.5 quick-actions-dropdown"
						style="
							top: {editingCardRect.top}px;
							left: {editingCardSide === 'right' ? editingCardRect.left + editingCardRect.width + 8 : Math.max(8, editingCardRect.left - 150 - 8)}px;
							width: 150px;
						"
					>
						<button
							type="button"
							onclick={() => handleQuickEditAction('open', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:external-link" class="w-3.5 h-3.5 text-slate-400" />
							<span>Open card</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('labels', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:tag" class="w-3.5 h-3.5 text-slate-400" />
							<span>Edit labels</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('members', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:users" class="w-3.5 h-3.5 text-slate-400" />
							<span>Change members</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('dates', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:clock" class="w-3.5 h-3.5 text-slate-400" />
							<span>Edit dates</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('move', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:arrow-right" class="w-3.5 h-3.5 text-slate-400" />
							<span>Move</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('copy', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:copy" class="w-3.5 h-3.5 text-slate-400" />
							<span>Copy card</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('copy-link', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name={copiedLink ? "lucide:check" : "lucide:link"} class="w-3.5 h-3.5 {copiedLink ? 'text-emerald-500' : 'text-slate-400'}" />
							<span>{copiedLink ? 'Copied!' : 'Copy link'}</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('mirror', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:copy-plus" class="w-3.5 h-3.5 text-slate-400" />
							<span>Mirror</span>
						</button>
						<button
							type="button"
							onclick={() => handleQuickEditAction('archive', editingCardId!)}
							class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-red-400 bg-slate-800 hover:bg-red-950/30 rounded-md border-none cursor-pointer transition-all hover:translate-x-1 duration-150 shadow-md"
						>
							<Icon name="lucide:archive" class="w-3.5 h-3.5 text-red-400" />
							<span>Archive</span>
						</button>
					</div>
				{:else}
					<!-- Sub-popover settings card (e.g. edit labels checklist/dates picker/members selector) -->
					<div
						class="fixed z-[310] flex flex-col gap-3 bg-slate-800 backdrop-blur-md p-3.5 rounded-xl border border-slate-700/80 shadow-2xl quick-actions-dropdown text-slate-200"
						style="
							top: {Math.max(16, Math.min(editingCardRect.top, window.innerHeight - (activePopover === 'dates' ? 490 : 380)))}px;
							left: {editingCardSide === 'right' ? editingCardRect.left + editingCardRect.width + 8 : Math.max(8, editingCardRect.left - 256 - 8)}px;
							width: 256px;
						"
					>
						{#if activePopover === 'labels'}
					{@const card = taskClientStore.cards.find(c => c.id === editingCardId)}
					{@const filteredLabels = taskClientStore.boardLabels.filter(label => 
						!searchLabelQuery.trim() || 
						(label.name || label.color).toLowerCase().includes(searchLabelQuery.toLowerCase())
					)}
					<!-- Header -->
					<div class="flex items-center justify-between border-b border-slate-800 pb-2 mb-1 shrink-0">
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={() => { 
									if (labelsPopoverMode === 'list') {
										activePopover = 'actions';
									} else {
										labelsPopoverMode = 'list';
									}
								}}
								class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-800 transition-colors flex items-center justify-center"
								title="Back"
							>
								<Icon name="lucide:chevron-left" class="w-4 h-4" />
							</button>
							<span class="text-xs font-bold text-slate-200">
								{#if labelsPopoverMode === 'list'}
									Labels
								{:else if labelsPopoverMode === 'create'}
									Create label
								{:else if labelsPopoverMode === 'edit'}
									Change label
								{/if}
							</span>
						</div>
						<button
							type="button"
							onclick={cancelInlineEdit}
							class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-800 transition-colors flex items-center justify-center"
							aria-label="Close labels popover"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>

					{#if labelsPopoverMode === 'list'}
						<!-- Search box -->
						<div class="relative shrink-0">
							<input
								type="text"
								placeholder="Search labels..."
								bind:value={searchLabelQuery}
								class="w-full bg-slate-900 border border-slate-700 focus:border-slate-600 text-slate-200 rounded px-2.5 py-1.5 text-xs placeholder-slate-500 focus:outline-none focus:ring-0"
							/>
						</div>

						<!-- Labels List -->
						<div class="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1">
							{#if filteredLabels.length === 0}
								<div class="text-slate-500 text-xs py-2 text-center">No labels found</div>
							{:else}
								{#each filteredLabels as label}
									{@const isAssigned = card?.labels.some(l => l.id === label.id)}
									{@const labelColorMap: Record<string, string> = {
										'green': '#61bd4f', 'yellow': '#f2d600', 'orange': '#ff9f1a',
										'red': '#eb5a46', 'purple': '#c377e0', 'blue': '#0079bf',
										'sky': '#00c2e0', 'lime': '#51e898', 'pink': '#ff78cb', 'black': '#344563'
									}}
									{@const bg = labelColorMap[label.color] ?? label.color ?? '#6b7280'}
									<div class="flex items-center gap-2 group/row w-full">
										<!-- Toggle checkbox -->
										<button
											type="button"
											onclick={() => handleToggleLabel(editingCardId!, label.id)}
											class="flex items-center justify-center w-5 h-5 rounded border transition cursor-pointer shrink-0
												{isAssigned 
													? 'border-violet-500 bg-slate-900 text-violet-400' 
													: 'border-slate-700 bg-slate-900 text-transparent hover:border-slate-500'}"
										>
											{#if isAssigned}
												<Icon name="lucide:check" class="w-3.5 h-3.5 stroke-[3]" />
											{/if}
										</button>

										<!-- Colored label bar -->
										<button
											type="button"
											onclick={() => handleToggleLabel(editingCardId!, label.id)}
											style="background-color: {bg};"
											class="flex-1 flex items-center text-left px-3 h-8 rounded-lg text-white font-bold text-xs transition cursor-pointer min-w-0 select-none shadow-sm hover:brightness-110 active:brightness-95 {taskClientStore.colorblindMode ? `colorblind-pattern-${label.color}` : ''}"
										>
											<span class="truncate pr-1">{label.name || ''}</span>
										</button>

										<!-- Edit pencil button -->
										<button
											type="button"
											onclick={() => startEditLabel(label.id, label.name, label.color)}
											class="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition cursor-pointer shrink-0 border-none bg-transparent"
											title="Edit label"
										>
											<Icon name="lucide:pencil" class="w-3.5 h-3.5" />
										</button>
									</div>
								{/each}
							{/if}
						</div>

						<!-- Action buttons -->
						<div class="flex flex-col gap-2 pt-2 border-t border-slate-800 shrink-0">
							<button
								type="button"
								onclick={startCreateLabel}
								class="w-full py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-300 font-semibold rounded text-xs transition cursor-pointer text-center"
							>
								Create a new label
							</button>
							<button
								type="button"
								onclick={() => taskClientStore.toggleColorblindMode()}
								class="w-full py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-slate-300 font-semibold rounded text-xs transition cursor-pointer text-center"
							>
								{taskClientStore.colorblindMode ? 'Disable' : 'Enable'} colorblind friendly mode
							</button>
						</div>
					{:else if labelsPopoverMode === 'create' || labelsPopoverMode === 'edit'}
						<!-- Title / Name Input -->
						<div class="flex flex-col gap-1.5 text-xs shrink-0">
							<label for="inline-label-name-input" class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Title</label>
							<input
								id="inline-label-name-input"
								type="text"
								placeholder="Label title..."
								bind:value={labelFormName}
								class="w-full bg-slate-900 border border-slate-700 focus:border-slate-600 text-slate-200 rounded px-2.5 py-1.5 text-xs focus:outline-none focus:ring-0"
							/>
						</div>

						<!-- Color Selector Grid -->
						<div class="flex flex-col gap-1.5 text-xs shrink-0">
							<span class="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Select a color</span>
							<div class="grid grid-cols-5 gap-2">
								{#each labelColors as color}
									{@const labelColorMap: Record<string, string> = {
										'green': '#61bd4f', 'yellow': '#f2d600', 'orange': '#ff9f1a',
										'red': '#eb5a46', 'purple': '#c377e0', 'blue': '#0079bf',
										'sky': '#00c2e0', 'lime': '#51e898', 'pink': '#ff78cb', 'black': '#344563'
									}}
									{@const bg = labelColorMap[color] ?? color}
									{@const isSelected = labelFormColor === color}
									<button
										type="button"
										onclick={() => { labelFormColor = color; }}
										style="background-color: {bg};"
										class="w-10 h-8 rounded relative transition-transform cursor-pointer shadow-sm hover:scale-105 active:scale-95 flex items-center justify-center border-none
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
						<div class="flex items-center gap-2 pt-2 border-t border-slate-800 shrink-0">
							{#if labelsPopoverMode === 'create'}
								<button
									type="button"
									onclick={handleSaveLabelInline}
									class="flex-1 py-1.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded text-xs transition cursor-pointer border-none"
								>
									Create
								</button>
							{:else}
								<button
									type="button"
									onclick={handleSaveLabelInline}
									class="flex-1 py-1.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded text-xs transition cursor-pointer border-none"
								>
									Save
								</button>
								<button
									type="button"
									onclick={() => handleDeleteLabelInline(editingLabelId!)}
									class="flex-1 py-1.5 bg-red-600 hover:bg-red-700 text-white font-semibold rounded text-xs transition cursor-pointer border-none"
								>
									Delete
								</button>
							{/if}
						</div>
					{/if}
				{:else if activePopover === 'members'}
					{@const card = taskClientStore.cards.find(c => c.id === editingCardId)}
					{@const filteredMembers = taskClientStore.boardMembers.filter(m => 
						!searchMemberQuery.trim() || 
						m.fullName.toLowerCase().includes(searchMemberQuery.toLowerCase()) ||
						m.username?.toLowerCase().includes(searchMemberQuery.toLowerCase())
					)}
					<!-- Header -->
					<div class="flex items-center justify-between border-b border-slate-800 pb-2 mb-1 shrink-0">
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={() => { activePopover = 'actions'; }}
								class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-800 transition-colors flex items-center justify-center"
								title="Back"
							>
								<Icon name="lucide:chevron-left" class="w-4 h-4" />
							</button>
							<span class="text-xs font-bold text-slate-200">Members</span>
						</div>
						<button
							type="button"
							onclick={cancelInlineEdit}
							class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-800 transition-colors flex items-center justify-center"
							aria-label="Close members popover"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>

					<!-- Search box -->
					<div class="relative shrink-0">
						<input
							type="text"
							placeholder="Search members..."
							bind:value={searchMemberQuery}
							class="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-violet-500 placeholder-slate-500"
						/>
					</div>

					<!-- Members List -->
					<div class="flex flex-col gap-1 max-h-60 overflow-y-auto pr-1">
						{#if filteredMembers.length === 0}
							<div class="text-slate-500 text-xs py-2 text-center">No members found</div>
						{:else}
							{#each filteredMembers as member}
								{@const isAssigned = card?.members.some(m => m.id === member.id)}
								<button
									type="button"
									onclick={() => handleToggleMember(editingCardId!, member.id)}
									class="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-slate-800 transition cursor-pointer border-none bg-transparent w-full text-left {isAssigned ? 'bg-slate-800/50' : ''}"
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
				{:else if activePopover === 'dates'}
					<!-- Header -->
					<div class="flex items-center justify-between border-b border-slate-800 pb-2 mb-1 shrink-0">
						<div class="flex items-center gap-1">
							<button
								type="button"
								onclick={() => { activePopover = 'actions'; }}
								class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-800 transition-colors flex items-center justify-center"
								title="Back"
							>
								<Icon name="lucide:chevron-left" class="w-4 h-4" />
							</button>
							<span class="text-xs font-bold text-slate-200">Dates</span>
						</div>
						<button
							type="button"
							onclick={cancelInlineEdit}
							class="text-slate-400 hover:text-slate-200 bg-transparent border-none cursor-pointer p-0.5 rounded hover:bg-slate-800 transition-colors flex items-center justify-center"
							aria-label="Close dates popover"
						>
							<Icon name="lucide:x" class="w-3.5 h-3.5" />
						</button>
					</div>

					<!-- Calendar month/year navigation -->
					<div class="flex items-center justify-between text-xs text-slate-200 font-semibold bg-slate-900/50 py-1 px-1.5 rounded border border-slate-800 shrink-0">
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
					<div class="grid grid-cols-7 text-center text-[10px] font-bold text-slate-500 select-none shrink-0">
						<span>Su</span>
						<span>Mo</span>
						<span>Tu</span>
						<span>We</span>
						<span>Th</span>
						<span>Fr</span>
						<span>Sa</span>
					</div>

					<!-- Day cells grid -->
					<div class="grid grid-cols-7 gap-1 text-center text-xs shrink-0">
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

					<!-- Scrollable options list -->
					<div class="flex flex-col gap-3 overflow-y-auto pr-1 max-h-56">
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
									bind:value={startDateVal}
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
									bind:value={dueDateVal}
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
					</div>

					<!-- Actions -->
					<div class="flex gap-2 text-[10px] mt-1 shrink-0 pt-2 border-t border-slate-800">
						<button
							type="button"
							onclick={() => handleSaveDatesInline(editingCardId!)}
							class="flex-1 py-1.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded transition cursor-pointer border-none"
						>
							Save
						</button>
						<button
							type="button"
							onclick={() => handleRemoveDatesInline(editingCardId!)}
							class="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-750 text-slate-300 font-semibold rounded transition cursor-pointer"
						>
							Remove
						</button>
					</div>
				{/if}
			</div>
		{/if}
	{/if}
{/if}



		{#if taskClientStore.error}

			<!-- Backdrop -->
			<button
				type="button"
				class="fixed inset-0 z-[400] bg-slate-950/60 backdrop-blur-sm cursor-default border-none w-full h-full animate-in fade-in duration-200"
				onclick={() => taskClientStore.error = null}
				aria-label="Close error message"
			></button>

			<!-- Modal box -->
			<div class="fixed inset-0 z-[410] pointer-events-none flex items-center justify-center p-4">
				<div class="pointer-events-auto w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-200">
					<div class="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 mb-4 border border-red-500/20">
						<Icon name="lucide:triangle-alert" class="w-6 h-6 animate-pulse" />
					</div>
					
					<h3 class="text-base font-bold text-slate-100 mb-2">An Error Occurred</h3>
					
					<p class="text-sm text-slate-400 mb-6 break-words leading-relaxed max-w-full">
						{taskClientStore.error}
					</p>
					
					<button
						type="button"
						onclick={() => taskClientStore.error = null}
						class="w-full py-2.5 px-4 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition-colors cursor-pointer border-none text-sm focus:outline-none focus:ring-2 focus:ring-red-500/50"
					>
						Dismiss
					</button>
				</div>
			</div>
		{/if}
	{/snippet}
</Modal>
