/**
 * task-client store — Trello integration with accounts, boards, lists, cards.
 */

import { debug } from '$shared/utils/logger';

export interface TrelloAccount {
	id: string;
	displayName: string;
	apiKey: string;
	token: string;
	me?: TrelloMember;
}

export interface TrelloMember {
	id: string;
	fullName: string;
	username: string;
	avatarUrl: string | null;
}

export interface TrelloBoard {
	id: string;
	name: string;
	desc: string;
	closed: boolean;
	url: string;
	idOrganization?: string | null;
	prefs?: {
		backgroundColor?: string;
		backgroundImage?: string;
	};
}

export interface TrelloOrganization {
	id: string;
	name: string;
	displayName: string;
}

export interface TrelloBoardStar {
	id: string;
	idBoard: string;
	pos: number;
}

export interface TrelloLabel {
	id: string;
	idBoard: string;
	name: string;
	color: string;
}


export interface RecentBoard {
	id: string;
	name: string;
	accountId: string;
	accountName: string;
	prefs?: {
		backgroundColor?: string;
		backgroundImage?: string;
	};
	lastOpened: number;
}


export interface TrelloList {
	id: string;
	name: string;
	closed: boolean;
	idBoard: string;
	pos: number;
}

export interface TrelloCard {
	id: string;
	idShort?: number;
	shortLink?: string;
	name: string;
	desc: string;
	closed: boolean;
	idList: string;
	idBoard: string;
	due: string | null;
	dueComplete: boolean;
	dueReminder?: number | null;
	start: string | null;
	url: string;
	labels: { id: string; name: string; color: string }[];
	members: { id: string; fullName: string; username?: string; avatarUrl: string | null }[];
	pos: number;
	badges: {
		checkItems: number;
		checkItemsChecked: number;
		attachments: number;
		description: boolean;
		subscribed: boolean;
		comments: number;
	};
}

export interface TrelloCheckItem {
	id: string;
	idChecklist: string;
	name: string;
	state: 'complete' | 'incomplete';
	pos: number;
}

export interface TrelloChecklist {
	id: string;
	name: string;
	idCard: string;
	pos: number;
	checkItems: TrelloCheckItem[];
}

export interface TrelloAction {
	id: string;
	idMemberCreator: string;
	data: {
		text?: string;
		card?: { id: string; name: string; idList?: string };
		list?: { id: string; name: string };
		listBefore?: { id: string; name: string };
		listAfter?: { id: string; name: string };
	};
	type: string;
	date: string;
	memberCreator: {
		id: string;
		fullName: string;
		username: string;
		avatarUrl: string | null;
	};
}


function trelloBase(apiKey: string, token: string) {
	return `https://api.trello.com/1`;
}

async function trelloFetch<T>(
	apiKey: string,
	token: string,
	path: string,
	options: RequestInit = {}
): Promise<T> {
	const sep = path.includes('?') ? '&' : '?';
	const url = `https://api.trello.com/1${path}${sep}key=${apiKey}&token=${token}`;
	const res = await fetch(url, options);
	if (!res.ok) {
		const text = await res.text().catch(() => res.statusText);
		throw new Error(`Trello API error ${res.status}: ${text}`);
	}
	return res.json() as Promise<T>;
}

function createTaskClientStore() {
	// Persisted accounts
	let accounts = $state<TrelloAccount[]>(loadAccounts());
	let selectedAccountId = $state<string | null>(loadSelectedAccountId() ?? accounts[0]?.id ?? null);

	// Per-account data
	let boards = $state<TrelloBoard[]>([]);
	let organizations = $state<TrelloOrganization[]>([]);
	let starredBoardIds = $state<string[]>(selectedAccountId ? loadStarredBoardIdsForAccount(selectedAccountId) : []);
	let selectedBoardId = $state<string | null>(loadSelectedBoardId());
	let lists = $state<TrelloList[]>([]);
	let cards = $state<TrelloCard[]>([]);

	// Loading states
	let loadingBoards = $state(false);
	let loadingCards = $state(false);
	let error = $state<string | null>(null);

	// Board checklists, labels & members
	let boardChecklists = $state<TrelloChecklist[]>([]);
	let boardLabels = $state<TrelloLabel[]>([]);
	let boardMembers = $state<{ id: string; fullName: string; username?: string; avatarUrl: string | null }[]>([]);

	// Active card details
	let activeCardId = $state<string | null>(loadActiveCardId());
	const activeCardChecklists = $derived(boardChecklists.filter((cl) => cl.idCard === activeCardId));
	let activeCardActions = $state<TrelloAction[]>([]);
	let activeCardAttachments = $state<{ id: string; name: string; url: string; date: string; mimeType: string; bytes?: number; previews: { url: string; width: number; height: number }[] }[]>([]);
	let loadingDetails = $state(false);

	// Recent boards
	let recentBoards = $state<RecentBoard[]>(loadRecentBoards());

	// Colorblind mode
	let colorblindMode = $state(
		typeof localStorage !== 'undefined' &&
		localStorage.getItem('clopen:task-client:colorblind-mode') === 'true'
	);

	function toggleColorblindMode() {
		colorblindMode = !colorblindMode;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('clopen:task-client:colorblind-mode', String(colorblindMode));
		}
	}

	// Labels expanded
	let labelsExpanded = $state(
		typeof localStorage !== 'undefined' &&
		localStorage.getItem('clopen:task-client:labels-expanded') === 'true'
	);

	function toggleLabelsExpanded() {
		labelsExpanded = !labelsExpanded;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('clopen:task-client:labels-expanded', String(labelsExpanded));
		}
	}


	function loadRecentBoards(): RecentBoard[] {
		if (typeof localStorage === 'undefined') return [];
		try {
			return JSON.parse(localStorage.getItem('clopen:task-client:recent-boards') ?? '[]');
		} catch {
			return [];
		}
	}

	function saveRecentBoards(list: RecentBoard[]) {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem('clopen:task-client:recent-boards', JSON.stringify(list));
	}

	function addToRecentBoards(rb: Omit<RecentBoard, 'lastOpened'>) {
		const newRb: RecentBoard = { ...rb, lastOpened: Date.now() };
		const filtered = recentBoards.filter((b) => b.id !== rb.id);
		recentBoards = [newRb, ...filtered].slice(0, 4); // Keep at most 4 recent boards
		saveRecentBoards(recentBoards);
	}

	function loadSelectedAccountId(): string | null {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem('clopen:task-client:selected-account-id');
	}

	function loadSelectedBoardId(): string | null {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem('clopen:task-client:selected-board-id');
	}

	function loadActiveCardId(): string | null {
		if (typeof localStorage === 'undefined') return null;
		return localStorage.getItem('clopen:task-client:active-card-id');
	}

	function loadAccounts(): TrelloAccount[] {
		if (typeof localStorage === 'undefined') return [];
		try {
			return JSON.parse(localStorage.getItem('clopen:task-client:accounts') ?? '[]');
		} catch {
			return [];
		}
	}

	function saveAccounts(list: TrelloAccount[]) {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem('clopen:task-client:accounts', JSON.stringify(list));
	}

	function loadBoardStars(): Record<string, string[]> {
		if (typeof localStorage === 'undefined') return {};
		try {
			return JSON.parse(localStorage.getItem('clopen:task-client:board-stars') ?? '{}');
		} catch {
			return {};
		}
	}

	function saveBoardStars(stars: Record<string, string[]>) {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem('clopen:task-client:board-stars', JSON.stringify(stars));
	}

	function loadStarredBoardIdsForAccount(accountId: string): string[] {
		const allStars = loadBoardStars();
		return allStars[accountId] ?? [];
	}

	async function addAccount(apiKey: string, token: string, displayName?: string): Promise<TrelloAccount> {
		const me = await trelloFetch<TrelloMember>(apiKey, token, '/members/me?fields=id,fullName,username,avatarUrl');
		const account: TrelloAccount = {
			id: me.id,
			displayName: displayName?.trim() || me.fullName,
			apiKey,
			token,
			me
		};
		// Replace if same id, otherwise append
		const existing = accounts.findIndex((a) => a.id === account.id);
		if (existing >= 0) {
			accounts[existing] = account;
		} else {
			accounts.push(account);
		}
		saveAccounts(accounts);
		selectedAccountId = account.id;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('clopen:task-client:selected-account-id', account.id);
		}
		starredBoardIds = loadStarredBoardIdsForAccount(account.id);
		return account;
	}

	function removeAccount(id: string) {
		const idx = accounts.findIndex((a) => a.id === id);
		if (idx >= 0) accounts.splice(idx, 1);
		saveAccounts(accounts);
		
		// Clean up recent boards belonging to the removed account
		recentBoards = recentBoards.filter((b) => b.accountId !== id);
		saveRecentBoards(recentBoards);

		// Clean up board stars belonging to the removed account
		const stars = loadBoardStars();
		delete stars[id];
		saveBoardStars(stars);

		if (selectedAccountId === id) {
			selectedAccountId = accounts[0]?.id ?? null;
			if (typeof localStorage !== 'undefined') {
				if (selectedAccountId) {
					localStorage.setItem('clopen:task-client:selected-account-id', selectedAccountId);
				} else {
					localStorage.removeItem('clopen:task-client:selected-account-id');
				}
				localStorage.removeItem('clopen:task-client:selected-board-id');
				localStorage.removeItem('clopen:task-client:active-card-id');
			}
			starredBoardIds = selectedAccountId ? loadStarredBoardIdsForAccount(selectedAccountId) : [];
			boards = [];
			selectedBoardId = null;
			activeCardId = null;
			lists = [];
			cards = [];
		}
	}

	function selectAccount(id: string) {
		selectedAccountId = id;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('clopen:task-client:selected-account-id', id);
			localStorage.removeItem('clopen:task-client:selected-board-id');
			localStorage.removeItem('clopen:task-client:active-card-id');
		}
		starredBoardIds = loadStarredBoardIdsForAccount(id);
		boards = [];
		selectedBoardId = null;
		activeCardId = null;
		lists = [];
		cards = [];
		error = null;
		loadBoards().catch((e) => {
			debug.error('task-client', 'loadBoards failed:', e);
			error = e instanceof Error ? e.message : String(e);
		});
	}

	async function loadBoards(): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		loadingBoards = true;
		error = null;
		try {
			const [fetchedBoards, fetchedOrgs] = await Promise.all([
				trelloFetch<TrelloBoard[]>(
					account.apiKey,
					account.token,
					'/members/me/boards?filter=open&fields=id,name,desc,closed,url,prefs,idOrganization'
				),
				trelloFetch<TrelloOrganization[]>(
					account.apiKey,
					account.token,
					'/members/me/organizations?fields=id,name,displayName'
				)
			]);
			boards = fetchedBoards;
			organizations = fetchedOrgs;
		} finally {
			loadingBoards = false;
		}
	}

	async function selectBoard(boardId: string | null): Promise<void> {
		selectedBoardId = boardId;
		if (typeof localStorage !== 'undefined') {
			if (boardId) {
				localStorage.setItem('clopen:task-client:selected-board-id', boardId);
			} else {
				localStorage.removeItem('clopen:task-client:selected-board-id');
				localStorage.removeItem('clopen:task-client:active-card-id');
			}
		}
		if (!boardId) {
			lists = [];
			cards = [];
			boardChecklists = [];
			boardLabels = [];
			boardMembers = [];
			activeCardId = null;
			return;
		}
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		loadingCards = true;
		error = null;
		try {
			const [fetchedLists, fetchedCards, fetchedChecklists, fetchedLabels, fetchedMembers] = await Promise.all([
				trelloFetch<TrelloList[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/lists?filter=open&fields=id,name,closed,idBoard,pos`
				),
				trelloFetch<TrelloCard[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/cards?filter=open&fields=id,idShort,shortLink,name,desc,closed,idList,idBoard,due,dueComplete,dueReminder,start,url,labels,badges,pos&members=true&member_fields=id,fullName,username,avatarUrl`
				),
				trelloFetch<TrelloChecklist[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/checklists?checkItems=all`
				).catch((e) => {
					debug.error('task-client', 'Failed to prefetch board checklists, defaulting to empty:', e);
					return [];
				}),
				trelloFetch<TrelloLabel[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/labels?fields=all&limit=1000`
				).catch((e) => {
					debug.error('task-client', 'Failed to prefetch board labels, defaulting to empty:', e);
					return [];
				}),
				trelloFetch<{ id: string; fullName: string; username?: string; avatarUrl: string | null }[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/members?fields=id,fullName,username,avatarUrl`
				).catch((e) => {
					debug.error('task-client', 'Failed to prefetch board members, defaulting to empty:', e);
					return [];
				})
			]);
			lists = fetchedLists.sort((a, b) => a.pos - b.pos);
			cards = fetchedCards.sort((a, b) => a.pos - b.pos);
			
			for (const cl of fetchedChecklists) {
				if (cl.checkItems) {
					cl.checkItems.sort((a, b) => a.pos - b.pos);
				}
			}
			boardChecklists = fetchedChecklists;
			boardLabels = fetchedLabels;
			boardMembers = fetchedMembers;

			// Save to recent boards
			const board = boards.find((b) => b.id === boardId);
			if (board) {
				addToRecentBoards({
					id: board.id,
					name: board.name,
					accountId: account.id,
					accountName: account.displayName,
					prefs: board.prefs
				});
			}
		} finally {
			loadingCards = false;
		}
	}

	async function selectRecentBoard(boardId: string, accountId: string): Promise<void> {
		selectedAccountId = accountId;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('clopen:task-client:selected-account-id', accountId);
			localStorage.setItem('clopen:task-client:selected-board-id', boardId);
		}
		starredBoardIds = loadStarredBoardIdsForAccount(accountId);
		selectedBoardId = boardId;
		const account = accounts.find((a) => a.id === accountId);
		if (!account) return;
		loadingCards = true;
		error = null;
		try {
			const [fetchedLists, fetchedCards, fetchedBoards, fetchedOrgs, fetchedChecklists, fetchedLabels, fetchedMembers] = await Promise.all([
				trelloFetch<TrelloList[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/lists?filter=open&fields=id,name,closed,idBoard,pos`
				),
				trelloFetch<TrelloCard[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/cards?filter=open&fields=id,idShort,shortLink,name,desc,closed,idList,idBoard,due,dueComplete,dueReminder,start,url,labels,badges,pos&members=true&member_fields=id,fullName,username,avatarUrl`
				),
				trelloFetch<TrelloBoard[]>(
					account.apiKey,
					account.token,
					'/members/me/boards?filter=open&fields=id,name,desc,closed,url,prefs,idOrganization'
				),
				trelloFetch<TrelloOrganization[]>(
					account.apiKey,
					account.token,
					'/members/me/organizations?fields=id,name,displayName'
				),
				trelloFetch<TrelloChecklist[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/checklists?checkItems=all`
				).catch((e) => {
					debug.error('task-client', 'Failed to prefetch board checklists, defaulting to empty:', e);
					return [];
				}),
				trelloFetch<TrelloLabel[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/labels?fields=all&limit=1000`
				).catch((e) => {
					debug.error('task-client', 'Failed to prefetch board labels, defaulting to empty:', e);
					return [];
				}),
				trelloFetch<{ id: string; fullName: string; username?: string; avatarUrl: string | null }[]>(
					account.apiKey,
					account.token,
					`/boards/${boardId}/members?fields=id,fullName,username,avatarUrl`
				).catch((e) => {
					debug.error('task-client', 'Failed to prefetch board members, defaulting to empty:', e);
					return [];
				})
			]);
			lists = fetchedLists.sort((a, b) => a.pos - b.pos);
			cards = fetchedCards.sort((a, b) => a.pos - b.pos);
			boards = fetchedBoards;
			organizations = fetchedOrgs;

			for (const cl of fetchedChecklists) {
				if (cl.checkItems) {
					cl.checkItems.sort((a, b) => a.pos - b.pos);
				}
			}
			boardChecklists = fetchedChecklists;
			boardLabels = fetchedLabels;
			boardMembers = fetchedMembers;

			// Save/update to recent boards
			const board = boards.find((b) => b.id === boardId);
			if (board) {
				addToRecentBoards({
					id: board.id,
					name: board.name,
					accountId: account.id,
					accountName: account.displayName,
					prefs: board.prefs
				});
			}
		} finally {
			loadingCards = false;
		}
	}

	function toggleBoardStar(boardId: string): void {
		if (!selectedAccountId) return;
		
		const stars = loadBoardStars();
		const current = stars[selectedAccountId] ?? [];
		let updated: string[];
		if (current.includes(boardId)) {
			updated = current.filter((id) => id !== boardId);
		} else {
			updated = [...current, boardId];
		}
		stars[selectedAccountId] = updated;
		saveBoardStars(stars);
		starredBoardIds = updated;
	}


	async function moveCard(cardId: string, targetListId: string, targetPos: number): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		if (cardIdx === -1) return;

		const originalListId = cards[cardIdx].idList;
		const originalPos = cards[cardIdx].pos;
		if (originalListId === targetListId && originalPos === targetPos) return;

		// Optimistic update
		cards[cardIdx] = { ...cards[cardIdx], idList: targetListId, pos: targetPos };
		cards = cards.sort((a, b) => a.pos - b.pos);
		error = null;

		try {
			await trelloFetch<TrelloCard>(
				account.apiKey,
				account.token,
				`/cards/${cardId}?idList=${targetListId}&pos=${targetPos}`,
				{ method: 'PUT' }
			);
		} catch (e) {
			debug.error('task-client', 'moveCard failed, reverting:', e);
			// Revert on error
			const revertIdx = cards.findIndex((c) => c.id === cardId);
			if (revertIdx !== -1) {
				cards[revertIdx] = { ...cards[revertIdx], idList: originalListId, pos: originalPos };
				cards = cards.sort((a, b) => a.pos - b.pos);
			}
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function createCard(listId: string, name: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		error = null;
		try {
			const newCard = await trelloFetch<any>(
				account.apiKey,
				account.token,
				'/cards',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						idList: listId,
						name: name.trim()
					})
				}
			);
			
			// Normalize/ensure all expected fields are present
			const normalizedCard: TrelloCard = {
				id: newCard.id,
				name: newCard.name || '',
				desc: newCard.desc || '',
				closed: newCard.closed ?? false,
				idList: newCard.idList,
				idBoard: newCard.idBoard,
				due: newCard.due || null,
				dueComplete: newCard.dueComplete ?? false,
				dueReminder: newCard.dueReminder ?? null,
				start: newCard.start || null,
				url: newCard.url || `https://trello.com/c/${newCard.id}`,
				labels: newCard.labels || [],
				members: newCard.members || [],
				pos: newCard.pos ?? 16384,
				badges: newCard.badges || {
					checkItems: 0,
					checkItemsChecked: 0,
					attachments: 0,
					description: false,
					subscribed: false,
					comments: 0
				}
			};
			
			cards.push(normalizedCard);
			cards = cards.sort((a, b) => a.pos - b.pos);
		} catch (e) {
			debug.error('task-client', 'createCard failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function archiveList(listId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		error = null;
		try {
			await trelloFetch<TrelloList>(
				account.apiKey,
				account.token,
				`/lists/${listId}?closed=true`,
				{ method: 'PUT' }
			);
			lists = lists.filter((l) => l.id !== listId);
			cards = cards.filter((c) => c.idList !== listId);
		} catch (e) {
			debug.error('task-client', 'archiveList failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function archiveAllCards(listId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		error = null;
		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/lists/${listId}/archiveAllCards`,
				{ method: 'POST' }
			);
			cards = cards.filter((c) => c.idList !== listId);
		} catch (e) {
			debug.error('task-client', 'archiveAllCards failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}


	async function fetchCardDetails(cardId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		activeCardId = cardId;
		boardChecklists = boardChecklists.filter((cl) => cl.idCard !== cardId);
		activeCardActions = [];
		loadingDetails = true;
		error = null;

		try {
			const [checklistsData, actionsData, attachmentsData] = await Promise.all([
				trelloFetch<TrelloChecklist[]>(
					account.apiKey,
					account.token,
					`/cards/${cardId}/checklists`
				),
				trelloFetch<TrelloAction[]>(
					account.apiKey,
					account.token,
					`/cards/${cardId}/actions?filter=commentCard,createCard,updateCard,addChecklistToCard,updateCheckItemStateOnCard&limit=50`
				),
				trelloFetch<{ id: string; name: string; url: string; date: string; mimeType: string; bytes?: number; previews: { url: string; width: number; height: number }[] }[]>(
					account.apiKey,
					account.token,
					`/cards/${cardId}/attachments`
				).catch(() => [])
			]);
			for (const cl of checklistsData) {
				if (cl.checkItems) {
					cl.checkItems.sort((a, b) => a.pos - b.pos);
				}
			}
			boardChecklists = boardChecklists.filter((cl) => cl.idCard !== cardId).concat(checklistsData);
			activeCardActions = actionsData;
			activeCardAttachments = attachmentsData;
		} catch (e) {
			debug.error('task-client', 'fetchCardDetails failed:', e);
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loadingDetails = false;
		}
	}

	async function updateCardDescription(cardId: string, desc: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		let originalDesc = '';
		if (cardIdx !== -1) {
			originalDesc = cards[cardIdx].desc;
			cards[cardIdx].desc = desc;
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ desc })
				}
			);
		} catch (e) {
			debug.error('task-client', 'updateCardDescription failed, reverting:', e);
			if (cardIdx !== -1) {
				cards[cardIdx].desc = originalDesc;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateCardName(cardId: string, name: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		let originalName = '';
		if (cardIdx !== -1) {
			originalName = cards[cardIdx].name;
			cards[cardIdx].name = name;
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name })
				}
			);
		} catch (e) {
			debug.error('task-client', 'updateCardName failed, reverting:', e);
			if (cardIdx !== -1) {
				cards[cardIdx].name = originalName;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateCheckItemState(
		cardId: string,
		checklistId: string,
		checkItemId: string,
		state: 'complete' | 'incomplete'
	): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const clIdx = boardChecklists.findIndex((cl) => cl.id === checklistId);
		let originalState: 'complete' | 'incomplete' = 'incomplete';
		if (clIdx !== -1) {
			const itemIdx = boardChecklists[clIdx].checkItems.findIndex((item) => item.id === checkItemId);
			if (itemIdx !== -1) {
				originalState = boardChecklists[clIdx].checkItems[itemIdx].state;
				boardChecklists[clIdx].checkItems[itemIdx].state = state;
			}
		}

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		let originalCheckItemsChecked = 0;
		if (cardIdx !== -1) {
			originalCheckItemsChecked = cards[cardIdx].badges.checkItemsChecked;
			if (state === 'complete' && originalState === 'incomplete') {
				cards[cardIdx].badges.checkItemsChecked += 1;
			} else if (state === 'incomplete' && originalState === 'complete') {
				cards[cardIdx].badges.checkItemsChecked -= 1;
			}
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/checkItem/${checkItemId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ state })
				}
			);
		} catch (e) {
			debug.error('task-client', 'updateCheckItemState failed, reverting:', e);
			if (clIdx !== -1) {
				const itemIdx = boardChecklists[clIdx].checkItems.findIndex((item) => item.id === checkItemId);
				if (itemIdx !== -1) {
					boardChecklists[clIdx].checkItems[itemIdx].state = originalState;
				}
			}
			if (cardIdx !== -1) {
				cards[cardIdx].badges.checkItemsChecked = originalCheckItemsChecked;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function addCheckItem(checklistId: string, name: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		try {
			const newItem = await trelloFetch<TrelloCheckItem>(
				account.apiKey,
				account.token,
				`/checklists/${checklistId}/checkItems`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: name.trim() })
				}
			);
			
			const clIdx = boardChecklists.findIndex((cl) => cl.id === checklistId);
			if (clIdx !== -1) {
				boardChecklists[clIdx].checkItems.push(newItem);
				const cardIdx = cards.findIndex((c) => c.id === boardChecklists[clIdx].idCard);
				if (cardIdx !== -1) {
					cards[cardIdx].badges.checkItems += 1;
				}
			}
		} catch (e) {
			debug.error('task-client', 'addCheckItem failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function addComment(cardId: string, text: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		try {
			const newAction = await trelloFetch<TrelloAction>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/actions/comments?text=${encodeURIComponent(text.trim())}`,
				{
					method: 'POST'
				}
			);
			activeCardActions.unshift(newAction);
			
			const cardIdx = cards.findIndex((c) => c.id === cardId);
			if (cardIdx !== -1) {
				cards[cardIdx].badges.comments += 1;
			}
		} catch (e) {
			debug.error('task-client', 'addComment failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function toggleDueComplete(cardId: string, complete: boolean): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		let original = false;
		let originalDue: string | null = null;
		const nowStr = new Date().toISOString();

		if (cardIdx !== -1) {
			original = cards[cardIdx].dueComplete;
			originalDue = cards[cardIdx].due;
			cards[cardIdx].dueComplete = complete;
			if (complete && !cards[cardIdx].due) {
				cards[cardIdx].due = nowStr;
			}
		}

		try {
			const body: any = { dueComplete: complete };
			if (complete && originalDue === null) {
				body.due = nowStr;
			}
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				}
			);
		} catch (e) {
			debug.error('task-client', 'toggleDueComplete failed, reverting:', e);
			if (cardIdx !== -1) {
				cards[cardIdx].dueComplete = original;
				cards[cardIdx].due = originalDue;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function addChecklist(cardId: string, name: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		try {
			const newChecklist = await trelloFetch<TrelloChecklist>(
				account.apiKey,
				account.token,
				`/checklists?idCard=${cardId}&name=${encodeURIComponent(name.trim())}`,
				{ method: 'POST' }
			);
			boardChecklists.push(newChecklist);
		} catch (e) {
			debug.error('task-client', 'addChecklist failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function deleteChecklist(checklistId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const clIdx = boardChecklists.findIndex((cl) => cl.id === checklistId);
		let checklist: TrelloChecklist | null = null;
		if (clIdx !== -1) {
			checklist = boardChecklists[clIdx];
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/checklists/${checklistId}`,
				{ method: 'DELETE' }
			);
			boardChecklists = boardChecklists.filter((cl) => cl.id !== checklistId);
			if (checklist) {
				const numItems = checklist.checkItems.length;
				const numChecked = checklist.checkItems.filter((item) => item.state === 'complete').length;
				const cardIdx = cards.findIndex((c) => c.id === checklist!.idCard);
				if (cardIdx !== -1) {
					cards[cardIdx].badges.checkItems = Math.max(0, cards[cardIdx].badges.checkItems - numItems);
					cards[cardIdx].badges.checkItemsChecked = Math.max(0, cards[cardIdx].badges.checkItemsChecked - numChecked);
				}
			}
		} catch (e) {
			debug.error('task-client', 'deleteChecklist failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function deleteCheckItem(cardId: string, checklistId: string, itemId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const clIdx = boardChecklists.findIndex((cl) => cl.id === checklistId);
		let removedItem: TrelloCheckItem | null = null;
		if (clIdx !== -1) {
			const originalItems = boardChecklists[clIdx].checkItems;
			const found = originalItems.find(item => item.id === itemId);
			if (found) {
				removedItem = found;
			}
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/checkItem/${itemId}`,
				{ method: 'DELETE' }
			);
			if (clIdx !== -1 && removedItem) {
				boardChecklists[clIdx].checkItems = boardChecklists[clIdx].checkItems.filter((item) => item.id !== itemId);
				const cardIdx = cards.findIndex((c) => c.id === cardId);
				if (cardIdx !== -1) {
					cards[cardIdx].badges.checkItems = Math.max(0, cards[cardIdx].badges.checkItems - 1);
					if (removedItem.state === 'complete') {
						cards[cardIdx].badges.checkItemsChecked = Math.max(0, cards[cardIdx].badges.checkItemsChecked - 1);
					}
				}
			}
		} catch (e) {
			debug.error('task-client', 'deleteCheckItem failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function deleteComment(cardId: string, actionId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/actions/${actionId}`,
				{ method: 'DELETE' }
			);
			activeCardActions = activeCardActions.filter((a) => a.id !== actionId);
			const cardIdx = cards.findIndex((c) => c.id === cardId);
			if (cardIdx !== -1) {
				cards[cardIdx].badges.comments = Math.max(0, cards[cardIdx].badges.comments - 1);
			}
		} catch (e) {
			debug.error('task-client', 'deleteComment failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateComment(actionId: string, text: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		try {
			const updatedAction = await trelloFetch<TrelloAction>(
				account.apiKey,
				account.token,
				`/actions/${actionId}/text?text=${encodeURIComponent(text.trim())}`,
				{ method: 'PUT' }
			);
			const idx = activeCardActions.findIndex((a) => a.id === actionId);
			if (idx !== -1) {
				activeCardActions[idx] = updatedAction;
			}
		} catch (e) {
			debug.error('task-client', 'updateComment failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateCardDates(
		cardId: string,
		start: string | null,
		due: string | null,
		dueReminder: number | null = null
	): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		let originalStart: string | null = null;
		let originalDue: string | null = null;
		let originalDueReminder: number | null = null;
		if (cardIdx !== -1) {
			originalStart = cards[cardIdx].start;
			originalDue = cards[cardIdx].due;
			originalDueReminder = cards[cardIdx].dueReminder ?? null;
			cards[cardIdx].start = start;
			cards[cardIdx].due = due;
			cards[cardIdx].dueReminder = dueReminder;
		}

		try {
			const queryParams = new URLSearchParams();
			const reminderVal = dueReminder !== null ? dueReminder : -1;
			queryParams.append('dueReminder', String(reminderVal));

			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}?${queryParams.toString()}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ start, due })
				}
			);
		} catch (e) {
			debug.error('task-client', 'updateCardDates failed, reverting:', e);
			if (cardIdx !== -1) {
				cards[cardIdx].start = originalStart;
				cards[cardIdx].due = originalDue;
				cards[cardIdx].dueReminder = originalDueReminder;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function addLabelToCard(cardId: string, labelId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		if (cardIdx === -1) return;

		const label = boardLabels.find((l) => l.id === labelId);
		if (!label) return;

		const originalLabels = [...cards[cardIdx].labels];
		cards[cardIdx].labels.push({ id: label.id, name: label.name, color: label.color });

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/idLabels`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: labelId })
				}
			);
		} catch (e) {
			debug.error('task-client', 'addLabelToCard failed, reverting:', e);
			if (cardIdx !== -1) {
				cards[cardIdx].labels = originalLabels;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function removeLabelFromCard(cardId: string, labelId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const cardIdx = cards.findIndex((c) => c.id === cardId);
		if (cardIdx === -1) return;

		const originalLabels = [...cards[cardIdx].labels];
		cards[cardIdx].labels = cards[cardIdx].labels.filter((l) => l.id !== labelId);

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/idLabels/${labelId}`,
				{ method: 'DELETE' }
			);
		} catch (e) {
			debug.error('task-client', 'removeLabelFromCard failed, reverting:', e);
			if (cardIdx !== -1) {
				cards[cardIdx].labels = originalLabels;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function createLabel(name: string, color: string): Promise<TrelloLabel> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account || !selectedBoardId) throw new Error('No active board');

		try {
			const newLabel = await trelloFetch<TrelloLabel>(
				account.apiKey,
				account.token,
				`/labels?name=${encodeURIComponent(name.trim())}&color=${color}&idBoard=${selectedBoardId}`,
				{ method: 'POST' }
			);
			boardLabels.push(newLabel);
			return newLabel;
		} catch (e) {
			debug.error('task-client', 'createLabel failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateLabel(labelId: string, name: string, color: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const labelIdx = boardLabels.findIndex((l) => l.id === labelId);
		if (labelIdx === -1) return;

		const originalName = boardLabels[labelIdx].name;
		const originalColor = boardLabels[labelIdx].color;
		boardLabels[labelIdx].name = name;
		boardLabels[labelIdx].color = color;

		const originalCardsLabels = cards.map((c) => ({ cardId: c.id, labels: [...c.labels] }));
		for (const card of cards) {
			const lIdx = card.labels.findIndex((l) => l.id === labelId);
			if (lIdx !== -1) {
				card.labels[lIdx].name = name;
				card.labels[lIdx].color = color;
			}
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/labels/${labelId}?name=${encodeURIComponent(name.trim())}&color=${color}`,
				{ method: 'PUT' }
			);
		} catch (e) {
			debug.error('task-client', 'updateLabel failed, reverting:', e);
			if (labelIdx !== -1) {
				boardLabels[labelIdx].name = originalName;
				boardLabels[labelIdx].color = originalColor;
			}
			for (const orig of originalCardsLabels) {
				const cIdx = cards.findIndex((c) => c.id === orig.cardId);
				if (cIdx !== -1) {
					cards[cIdx].labels = orig.labels;
				}
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function deleteLabel(labelId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const labelIdx = boardLabels.findIndex((l) => l.id === labelId);
		if (labelIdx === -1) return;

		const originalLabel = boardLabels[labelIdx];
		const originalCardsLabels = cards.map((c) => ({ cardId: c.id, labels: [...c.labels] }));

		boardLabels = boardLabels.filter((l) => l.id !== labelId);
		for (const card of cards) {
			card.labels = card.labels.filter((l) => l.id !== labelId);
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/labels/${labelId}`,
				{ method: 'DELETE' }
			);
		} catch (e) {
			debug.error('task-client', 'deleteLabel failed, reverting:', e);
			boardLabels.push(originalLabel);
			for (const orig of originalCardsLabels) {
				const cIdx = cards.findIndex((c) => c.id === orig.cardId);
				if (cIdx !== -1) {
					cards[cIdx].labels = orig.labels;
				}
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function archiveCard(cardId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ closed: true })
				}
			);
			cards = cards.filter((c) => c.id !== cardId);
		} catch (e) {
			debug.error('task-client', 'archiveCard failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function deleteCard(cardId: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}`,
				{ method: 'DELETE' }
			);
			cards = cards.filter((c) => c.id !== cardId);
		} catch (e) {
			debug.error('task-client', 'deleteCard failed:', e);
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateChecklistName(checklistId: string, name: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const clIdx = boardChecklists.findIndex((cl) => cl.id === checklistId);
		let originalName = '';
		if (clIdx !== -1) {
			originalName = boardChecklists[clIdx].name;
			boardChecklists[clIdx].name = name;
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/checklists/${checklistId}?name=${encodeURIComponent(name.trim())}`,
				{ method: 'PUT' }
			);
		} catch (e) {
			debug.error('task-client', 'updateChecklistName failed, reverting:', e);
			if (clIdx !== -1) {
				boardChecklists[clIdx].name = originalName;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateCheckItemName(
		cardId: string,
		checklistId: string,
		itemId: string,
		name: string
	): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const clIdx = boardChecklists.findIndex((cl) => cl.id === checklistId);
		let originalName = '';
		if (clIdx !== -1) {
			const itemIdx = boardChecklists[clIdx].checkItems.findIndex((item) => item.id === itemId);
			if (itemIdx !== -1) {
				originalName = boardChecklists[clIdx].checkItems[itemIdx].name;
				boardChecklists[clIdx].checkItems[itemIdx].name = name;
			}
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/checkItem/${itemId}`,
				{
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name })
				}
			);
		} catch (e) {
			debug.error('task-client', 'updateCheckItemName failed, reverting:', e);
			if (clIdx !== -1) {
				const itemIdx = boardChecklists[clIdx].checkItems.findIndex((item) => item.id === itemId);
				if (itemIdx !== -1) {
					boardChecklists[clIdx].checkItems[itemIdx].name = originalName;
				}
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	async function updateListName(listId: string, name: string): Promise<void> {
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;

		const listIdx = lists.findIndex((l) => l.id === listId);
		let originalName = '';
		if (listIdx !== -1) {
			originalName = lists[listIdx].name;
			lists[listIdx].name = name;
		}

		try {
			await trelloFetch<any>(
				account.apiKey,
				account.token,
				`/lists/${listId}?name=${encodeURIComponent(name.trim())}`,
				{ method: 'PUT' }
			);
		} catch (e) {
			debug.error('task-client', 'updateListName failed, reverting:', e);
			if (listIdx !== -1) {
				lists[listIdx].name = originalName;
			}
			error = e instanceof Error ? e.message : String(e);
			throw e;
		}
	}

	function getCardsForList(listId: string): TrelloCard[] {
		return cards.filter((c) => c.idList === listId);
	}

	async function fetchBoardChecklists(): Promise<TrelloChecklist[]> {
		if (!selectedAccountId || !selectedBoardId) return [];
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return [];
		try {
			return await trelloFetch<TrelloChecklist[]>(
				account.apiKey,
				account.token,
				`/boards/${selectedBoardId}/checklists?checkItems=all`
			);
		} catch (e) {
			debug.error('task-client', 'Failed to fetch board checklists:', e);
			return [];
		}
	}

	async function addMemberToCard(cardId: string, memberId: string): Promise<void> {
		if (!selectedAccountId) return;
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		const cardIdx = cards.findIndex((c) => c.id === cardId);
		if (cardIdx === -1) return;
		const member = boardMembers.find((m) => m.id === memberId);
		if (!member) return;
		// Optimistic update
		const originalMembers = [...cards[cardIdx].members];
		cards[cardIdx].members = [...originalMembers, { id: member.id, fullName: member.fullName, username: member.username, avatarUrl: member.avatarUrl }];
		try {
			const allMemberIds = cards[cardIdx].members.map((m) => m.id);
			await trelloFetch<unknown>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/idMembers`,
				{ method: 'PUT', body: JSON.stringify({ value: allMemberIds.join(',') }), headers: { 'Content-Type': 'application/json' } }
			);
		} catch (e) {
			debug.error('task-client', 'addMemberToCard failed, reverting:', e);
			cards[cardIdx].members = originalMembers;
			throw e;
		}
	}

	async function removeMemberFromCard(cardId: string, memberId: string): Promise<void> {
		if (!selectedAccountId) return;
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		const cardIdx = cards.findIndex((c) => c.id === cardId);
		if (cardIdx === -1) return;
		// Optimistic update
		const originalMembers = [...cards[cardIdx].members];
		cards[cardIdx].members = originalMembers.filter((m) => m.id !== memberId);
		try {
			await trelloFetch<unknown>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/idMembers/${memberId}`,
				{ method: 'DELETE' }
			);
		} catch (e) {
			debug.error('task-client', 'removeMemberFromCard failed, reverting:', e);
			cards[cardIdx].members = originalMembers;
			throw e;
		}
	}

	async function addAttachmentFile(cardId: string, file: File): Promise<{ id: string; name: string; url: string; date: string; mimeType: string; bytes?: number; previews: { url: string; width: number; height: number }[] } | undefined> {
		if (!selectedAccountId) return;
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		const cardIdx = cards.findIndex((c) => c.id === cardId);
		// Optimistic badge update
		if (cardIdx !== -1) cards[cardIdx].badges.attachments++;
		try {
			const form = new FormData();
			form.append('file', file);
			form.append('name', file.name);
			const sep = '?';
			const url = `https://api.trello.com/1/cards/${cardId}/attachments${sep}key=${account.apiKey}&token=${account.token}`;
			const res = await fetch(url, { method: 'POST', body: form });
			if (!res.ok) {
				const text = await res.text().catch(() => res.statusText);
				throw new Error(`Trello API error ${res.status}: ${text}`);
			}
			const created = await res.json() as { id: string; name: string; url: string; date: string; mimeType: string; bytes?: number; previews: { url: string; width: number; height: number }[] };
			if (activeCardId === cardId) activeCardAttachments = [created, ...activeCardAttachments];
			return created;
		} catch (e) {
			if (cardIdx !== -1) cards[cardIdx].badges.attachments = Math.max(0, cards[cardIdx].badges.attachments - 1);
			debug.error('task-client', 'addAttachmentFile failed:', e);
			throw e;
		}
	}

	async function addAttachmentUrl(cardId: string, url: string, name?: string): Promise<void> {
		if (!selectedAccountId) return;
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		const cardIdx = cards.findIndex((c) => c.id === cardId);
		// Optimistic badge update
		if (cardIdx !== -1) cards[cardIdx].badges.attachments++;
		try {
			const created = await trelloFetch<{ id: string; name: string; url: string; date: string; mimeType: string; bytes?: number; previews: { url: string; width: number; height: number }[] }>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/attachments`,
				{ method: 'POST', body: JSON.stringify({ url, name: name || url }), headers: { 'Content-Type': 'application/json' } }
			);
			if (activeCardId === cardId) activeCardAttachments = [created, ...activeCardAttachments];
		} catch (e) {
			if (cardIdx !== -1) cards[cardIdx].badges.attachments = Math.max(0, cards[cardIdx].badges.attachments - 1);
			debug.error('task-client', 'addAttachmentUrl failed:', e);
			throw e;
		}
	}

	async function deleteAttachment(cardId: string, attachmentId: string): Promise<void> {
		if (!selectedAccountId) return;
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		const cardIdx = cards.findIndex((c) => c.id === cardId);
		const originalAttachments = [...activeCardAttachments];
		// Optimistic remove
		activeCardAttachments = activeCardAttachments.filter((a) => a.id !== attachmentId);
		if (cardIdx !== -1) cards[cardIdx].badges.attachments = Math.max(0, cards[cardIdx].badges.attachments - 1);
		try {
			await trelloFetch<unknown>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/attachments/${attachmentId}`,
				{ method: 'DELETE' }
			);
		} catch (e) {
			activeCardAttachments = originalAttachments;
			if (cardIdx !== -1) cards[cardIdx].badges.attachments++;
			debug.error('task-client', 'deleteAttachment failed:', e);
			throw e;
		}
	}

	async function renameAttachment(cardId: string, attachmentId: string, name: string): Promise<void> {
		if (!selectedAccountId) return;
		const account = accounts.find((a) => a.id === selectedAccountId);
		if (!account) return;
		const originalName = activeCardAttachments.find((a) => a.id === attachmentId)?.name ?? '';
		// Optimistic update
		activeCardAttachments = activeCardAttachments.map((a) => a.id === attachmentId ? { ...a, name } : a);
		try {
			await trelloFetch<unknown>(
				account.apiKey,
				account.token,
				`/cards/${cardId}/attachments/${attachmentId}`,
				{ method: 'PUT', body: JSON.stringify({ name }), headers: { 'Content-Type': 'application/json' } }
			);
		} catch (e) {
			activeCardAttachments = activeCardAttachments.map((a) => a.id === attachmentId ? { ...a, name: originalName } : a);
			debug.error('task-client', 'renameAttachment failed:', e);
			throw e;
		}
	}

	// Auto-load boards and cards if we have saved account/board IDs on start
	if (typeof window !== 'undefined') {
		setTimeout(() => {
			if (selectedAccountId) {
				loadBoards().then(() => {
					if (selectedBoardId) {
						selectBoard(selectedBoardId).catch((e) => {
							debug.error('task-client', 'Auto-load cards failed:', e);
						});
					}
				}).catch((e) => {
					debug.error('task-client', 'Auto-load boards failed:', e);
				});
			}
		}, 0);
	}

	return {
		get accounts() { return accounts; },
		get selectedAccountId() { return selectedAccountId; },
		get selectedAccount() { return accounts.find((a) => a.id === selectedAccountId) ?? null; },
		get boards() { return boards; },
		get selectedBoardId() { return selectedBoardId; },
		get selectedBoard() { return boards.find((b) => b.id === selectedBoardId) ?? null; },
		get organizations() { return organizations; },
		get lists() { return lists; },
		get cards() { return cards; },
		get boardChecklists() { return boardChecklists; },
		get boardLabels() { return boardLabels; },
		get loadingBoards() { return loadingBoards; },
		get loadingCards() { return loadingCards; },
		get error() { return error; },
		set error(val: string | null) { error = val; },
		get activeCardId() { return activeCardId; },
		set activeCardId(val: string | null) {
			activeCardId = val;
			if (typeof localStorage !== 'undefined') {
				if (val) {
					localStorage.setItem('clopen:task-client:active-card-id', val);
				} else {
					localStorage.removeItem('clopen:task-client:active-card-id');
				}
			}
		},
		get activeCardChecklists() { return activeCardChecklists; },
		get activeCardActions() { return activeCardActions; },
		get activeCardAttachments() { return activeCardAttachments; },
		get loadingDetails() { return loadingDetails; },
		get recentBoards() { return recentBoards; },
		get boardStars() { return starredBoardIds.map((id) => ({ id, idBoard: id, pos: 0 })); },
		get colorblindMode() { return colorblindMode; },
		toggleColorblindMode,
		get labelsExpanded() { return labelsExpanded; },
		toggleLabelsExpanded,
		addAccount,
		removeAccount,
		selectAccount,
		loadBoards,
		selectBoard,
		selectRecentBoard,
		toggleBoardStar,
		getCardsForList,
		moveCard,
		createCard,
		archiveList,
		archiveAllCards,
		fetchCardDetails,
		updateCardDescription,
		updateCardName,
		updateCheckItemState,
		addCheckItem,
		addComment,
		toggleDueComplete,
		addChecklist,
		deleteChecklist,
		deleteCheckItem,
		deleteComment,
		updateComment,
		updateCardDates,
		archiveCard,
		deleteCard,
		updateChecklistName,
		updateCheckItemName,
		updateListName,
		fetchBoardChecklists,
		addLabelToCard,
		removeLabelFromCard,
		createLabel,
		updateLabel,
		deleteLabel,
		get boardMembers() { return boardMembers; },
		addMemberToCard,
		removeMemberFromCard,
		addAttachmentFile,
		addAttachmentUrl,
		deleteAttachment,
		renameAttachment
	};
}

export const taskClientStore = createTaskClientStore();
