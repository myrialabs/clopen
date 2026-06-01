<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import ConnectionList from './sidebar/ConnectionList.svelte';
	import SchemaTree from './sidebar/SchemaTree.svelte';
	import SchemaTreeContextMenu from './sidebar/SchemaTreeContextMenu.svelte';
	import type { ContextMenuItem } from './sidebar/context-menu-types';
	import ConfirmDestructive from './shared/ConfirmDestructive.svelte';
	import ConfirmTyped from './shared/ConfirmTyped.svelte';
	import Checkbox from './shared/Checkbox.svelte';
	import QueryEditor from './main/QueryEditor.svelte';
	import DataGrid from './main/DataGrid.svelte';
	import StructureManager from './main/StructureManager.svelte';
	import OverviewPanel from './main/OverviewPanel.svelte';
	import TableDesigner from './main/TableDesigner.svelte';
	import ExportModal from './main/ExportModal.svelte';
	import ImportModal from './main/ImportModal.svelte';
	import { dbClientStore, type DbClientView } from '$frontend/stores/features/db-client.svelte';
	import { debug } from '$shared/utils/logger';
	import type { DbClientSchemaNode } from '$shared/types/db-client';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	let isMobileMenuOpen = $state(false);
	let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);

	const isMobile = $derived(windowWidth < 768);
	const activeConnection = $derived(dbClientStore.activeConnection);
	const view = $derived(activeConnection ? dbClientStore.getView(activeConnection.id) : null);
	const activeView = $derived(view?.activeView ?? 'structure');
	const activeObject = $derived(view?.activeObject ?? null);
	const isFormOpen = $derived(dbClientStore.isFormOpen);

	let menuOpen = $state(false);
	let menuItems = $state<ContextMenuItem[]>([]);
	let menuX = $state(0);
	let menuY = $state(0);
	let menuNode = $state<DbClientSchemaNode | null>(null);

	let renameOpen = $state(false);
	let renameValue = $state('');
	let renameTarget = $state<{ name: string; database?: string } | null>(null);
	let confirmTruncate = $state(false);
	let confirmDrop = $state(false);
	let confirmDropTarget = $state<{ name: string; database?: string } | null>(null);
	let createTableOpen = $state(false);
	let createTableDb = $state<string | undefined>(undefined);
	let createViewOpen = $state(false);
	let createViewName = $state('');
	let createViewQuery = $state('');
	let createViewDb = $state<string | undefined>(undefined);
	let exportOpen = $state(false);
	let exportPreselect = $state<string[]>([]);
	let importOpen = $state(false);

	let confirmReset = $state(false);
	let confirmDropDatabase = $state(false);
	let confirmEmptyDatabase = $state(false);
	let confirmFlushDatabase = $state(false);
	let dbActionTarget = $state<{ name: string; scope?: string } | null>(null);

	let renameDbOpen = $state(false);
	let renameDbValue = $state('');
	let renameDbTarget = $state<string | null>(null);

	let duplicateOpen = $state(false);
	let duplicateName = $state('');
	let duplicateWithData = $state(true);
	let duplicateSource = $state<{ name: string; database?: string } | null>(null);

	const driver = $derived(activeConnection?.driver);
	const canDropDatabase = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'mongodb');
	const canRenameDatabase = $derived(driver === 'postgres' || driver === 'mysql');
	const canEmptyDatabase = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'sqlite' || driver === 'mongodb');
	const canFlushDatabase = $derived(driver === 'redis');
	const canResetTable = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'sqlite' || driver === 'mongodb');
	const canDuplicateTable = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'sqlite' || driver === 'mongodb');
	const canCopyCreate = $derived(driver === 'mysql' || driver === 'postgres' || driver === 'sqlite');

	// The database currently in scope: the one opened in the sidebar (tree
	// drivers) or the connection's fixed database. Single source of truth so
	// overview and database-level actions never target the parent by mistake.
	const scopeDb = $derived(
		activeConnection
			? (dbClientStore.openedDatabase[activeConnection.id] ?? activeConnection.database ?? undefined)
			: undefined
	);

	// True when the sidebar shows the database list (connection has no fixed
	// database and none is opened yet). At this level there is no table context,
	// so the Data/Structure tabs are meaningless.
	const useDatabaseTree = $derived(
		!!activeConnection && !activeConnection.database && (driver === 'mysql' || driver === 'postgres' || driver === 'mongodb')
	);
	const atConnectionScope = $derived(
		useDatabaseTree && !!activeConnection && (dbClientStore.openedDatabase[activeConnection.id] ?? null) === null
	);

	const canNavBack = $derived(dbClientStore.canNavBack(activeConnection?.id));
	const canNavForward = $derived(dbClientStore.canNavForward(activeConnection?.id));

	$effect(() => {
		if (isOpen) {
			dbClientStore.list().catch((err) => {
				debug.error('db-client', 'failed to load connections on modal open:', err);
			});
		}
	});

	// Data and Structure need a table in scope; bounce back to Overview when we
	// step up to the connection (database-list) level while on one of them.
	// Declared before the recorder so the correction lands before we snapshot.
	$effect(() => {
		if (atConnectionScope && activeConnection && (activeView === 'data' || activeView === 'structure')) {
			dbClientStore.setView(activeConnection.id, 'overview');
		}
	});

	// Record every navigation (view / object / database change) so the
	// back/forward buttons can replay it. Reading the deriveds registers deps.
	$effect(() => {
		if (!activeConnection) return;
		void activeView;
		void activeObject;
		void scopeDb;
		dbClientStore.recordNav(activeConnection.id);
	});

	function handleResize(): void {
		windowWidth = window.innerWidth;
		if (!isMobile) isMobileMenuOpen = false;
	}

	function onConnectionPicked(): void {
		if (isMobile) isMobileMenuOpen = false;
	}

	function backToConnections(): void {
		dbClientStore.setActive(null);
	}

	function quoteIdent(name: string): string {
		if (!activeConnection) return name;
		switch (activeConnection.driver) {
			case 'mysql': return '`' + name.replace(/`/g, '``') + '`';
			case 'postgres':
			case 'sqlite': return '"' + name.replace(/"/g, '""') + '"';
			default: return name;
		}
	}

	function itemsForNode(node: DbClientSchemaNode): ContextMenuItem[] {
		switch (node.type) {
			case 'database': {
				const items: ContextMenuItem[] = [
					{ id: 'open-db', label: 'Open' },
					{ id: 'sep0', label: '', separator: true },
					{ id: 'refresh', label: 'Refresh' },
					{ id: 'sep1', label: '', separator: true },
					{ id: 'new-table', label: 'New table…' },
					{ id: 'new-view', label: 'New view…' }
				];
				if (canEmptyDatabase || canRenameDatabase || canDropDatabase) {
					items.push({ id: 'sep2', label: '', separator: true });
				}
				if (canEmptyDatabase) items.push({ id: 'empty-database', label: 'Empty database…', danger: true });
				if (canRenameDatabase) items.push({ id: 'rename-database', label: 'Rename database…' });
				if (canDropDatabase) items.push({ id: 'drop-database', label: 'Drop database…', danger: true });
				return items;
			}
			case 'table':
			case 'collection': {
				const items: ContextMenuItem[] = [
					{ id: 'open-data', label: 'Open data' },
					{ id: 'open-structure', label: 'Open structure' },
					{ id: 'new-query', label: 'Query (SELECT *)' },
					{ id: 'sep1', label: '', separator: true },
					{ id: 'copy-name', label: 'Copy name' }
				];
				if (canCopyCreate) items.push({ id: 'copy-create', label: 'Copy CREATE statement' });
				items.push({ id: 'export-object', label: 'Export…' });
				if (canDuplicateTable) items.push({ id: 'duplicate', label: 'Duplicate…' });
				items.push({ id: 'sep2', label: '', separator: true });
				items.push({ id: 'rename', label: 'Rename…' });
				items.push({ id: 'truncate', label: 'Truncate', danger: true });
				if (canResetTable) items.push({ id: 'reset', label: 'Reset (empty + reset counter)', danger: true });
				items.push({ id: 'drop', label: 'Drop', danger: true });
				return items;
			}
			case 'view': {
				const items: ContextMenuItem[] = [
					{ id: 'open-query', label: 'Query view' },
					{ id: 'sep1', label: '', separator: true },
					{ id: 'copy-name', label: 'Copy name' }
				];
				if (canCopyCreate) items.push({ id: 'copy-create', label: 'Copy CREATE statement' });
				items.push({ id: 'sep2', label: '', separator: true });
				items.push({ id: 'drop', label: 'Drop', danger: true });
				return items;
			}
			case 'index':
				return [{ id: 'drop-index', label: 'Drop index', danger: true }];
			default:
				return [{ id: 'copy-name', label: 'Copy name' }, { id: 'refresh', label: 'Refresh' }];
		}
	}

	function scopeMenuItems(): ContextMenuItem[] {
		const items: ContextMenuItem[] = [];
		if (canEmptyDatabase) items.push({ id: 'empty-scope', label: 'Empty database…', danger: true });
		if (canFlushDatabase) items.push({ id: 'flush-scope', label: 'Flush database (FLUSHDB)…', danger: true });
		if (canRenameDatabase) items.push({ id: 'rename-scope', label: 'Rename database…' });
		if (canDropDatabase) items.push({ id: 'drop-scope', label: 'Drop database…', danger: true });
		return items;
	}

	function onContextMenu(e: MouseEvent, node: DbClientSchemaNode): void {
		menuNode = node;
		menuItems = itemsForNode(node);
		menuX = e.clientX;
		menuY = e.clientY;
		menuOpen = true;
	}

	function onScopeMenu(e: MouseEvent): void {
		const items = scopeMenuItems();
		if (items.length === 0) return;
		menuNode = null;
		menuItems = items;
		menuX = e.clientX;
		menuY = e.clientY;
		menuOpen = true;
	}

	async function copyToClipboard(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
		} catch (e) {
			debug.error('db-client', 'clipboard write failed:', e);
		}
	}

	function nodeDb(node: DbClientSchemaNode): string | undefined {
		const meta = node.meta as { database?: string } | undefined;
		return meta?.database;
	}

	let schemaRefreshKey = $state(0);

	async function onMenuSelect(id: string): Promise<void> {
		const conn = activeConnection;
		if (!conn) return;

		// Scope-level actions (header ⋯ menu) operate on the open database.
		switch (id) {
			case 'empty-scope':
				if (!scopeDb) return;
				// Confirm against the database name — that's what gets emptied.
				dbActionTarget = { name: scopeDb, scope: scopeDb };
				confirmEmptyDatabase = true;
				return;
			case 'flush-scope':
				dbActionTarget = { name: conn.name, scope: scopeDb };
				confirmFlushDatabase = true;
				return;
			case 'rename-scope':
				if (!scopeDb) return;
				renameDbTarget = scopeDb;
				renameDbValue = scopeDb;
				renameDbOpen = true;
				return;
			case 'drop-scope':
				if (!scopeDb) return;
				// Real database name is required for the drop and the typed confirm.
				dbActionTarget = { name: scopeDb, scope: scopeDb };
				confirmDropDatabase = true;
				return;
		}

		const node = menuNode;
		if (!node) return;
		const db = nodeDb(node);
		switch (id) {
			case 'open-db':
				schemaRefreshKey++;
				break;
			case 'refresh':
				dbClientStore.requestSchemaReload();
				break;
			case 'new-table':
				createTableDb = node.type === 'database' ? node.name : db;
				createTableOpen = true;
				break;
			case 'new-view':
				createViewDb = node.type === 'database' ? node.name : db;
				createViewName = '';
				createViewQuery = 'SELECT 1';
				createViewOpen = true;
				break;
			case 'open-data':
				dbClientStore.setActiveObject(conn.id, { name: node.name, type: node.type, database: db });
				dbClientStore.setView(conn.id, 'data');
				break;
			case 'open-structure':
				dbClientStore.setActiveObject(conn.id, { name: node.name, type: node.type, database: db });
				dbClientStore.setView(conn.id, 'structure');
				break;
			case 'new-query':
				dbClientStore.setQueryText(conn.id, `SELECT * FROM ${quoteIdent(node.name)} LIMIT 100`);
				dbClientStore.setView(conn.id, 'query');
				break;
			case 'open-query':
				dbClientStore.setQueryText(conn.id, `SELECT * FROM ${quoteIdent(node.name)}`);
				dbClientStore.setView(conn.id, 'query');
				break;
			case 'rename':
				renameTarget = { name: node.name, database: db };
				renameValue = node.name;
				renameOpen = true;
				break;
			case 'truncate':
				confirmDropTarget = { name: node.name, database: db };
				confirmTruncate = true;
				break;
			case 'drop':
				confirmDropTarget = { name: node.name, database: db };
				confirmDrop = true;
				break;
			case 'reset':
				confirmDropTarget = { name: node.name, database: db };
				confirmReset = true;
				break;
			case 'duplicate':
				duplicateSource = { name: node.name, database: db };
				duplicateName = `${node.name}_copy`;
				duplicateWithData = true;
				duplicateOpen = true;
				break;
			case 'copy-name':
				await copyToClipboard(node.name);
				break;
			case 'copy-create': {
				try {
					const stmt = await dbClientStore.getCreateStatement(conn.id, node.name, node.type, { database: db });
					await copyToClipboard(stmt);
				} catch (e) {
					debug.error('db-client', 'copy create statement failed:', e);
				}
				break;
			}
			case 'export-object':
				exportPreselect = [node.name];
				exportOpen = true;
				break;
			case 'empty-database':
				dbActionTarget = { name: node.name, scope: node.name };
				confirmEmptyDatabase = true;
				break;
			case 'rename-database':
				renameDbTarget = node.name;
				renameDbValue = node.name;
				renameDbOpen = true;
				break;
			case 'drop-database':
				dbActionTarget = { name: node.name, scope: node.name };
				confirmDropDatabase = true;
				break;
			case 'drop-index': {
				const tableName = (node.meta as { tableName?: string } | undefined)?.tableName;
				if (tableName) {
					try {
						await dbClientStore.dropIndex(conn.id, tableName, node.name, { database: db });
						dbClientStore.requestSchemaReload();
					} catch (e) {
						debug.error('db-client', 'drop-index failed:', e);
					}
				}
				break;
			}
		}
	}

	async function doRename(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !renameTarget || !renameValue) return;
		try {
			await dbClientStore.renameTable(conn.id, renameTarget.name, renameValue, { database: renameTarget.database });
			if (activeObject && activeObject.name === renameTarget.name && (activeObject.database ?? undefined) === (renameTarget.database ?? undefined)) {
				dbClientStore.setActiveObject(conn.id, { ...activeObject, name: renameValue });
			}
			dbClientStore.requestSchemaReload();
		} catch (e) {
			debug.error('db-client', 'rename failed:', e);
		}
		renameTarget = null;
	}

	async function doTruncate(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !confirmDropTarget) return;
		try {
			await dbClientStore.truncateTable(conn.id, confirmDropTarget.name, { database: confirmDropTarget.database });
			dbClientStore.touchData();
		} catch (e) {
			debug.error('db-client', 'truncate failed:', e);
		}
	}

	async function doDrop(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !confirmDropTarget) return;
		try {
			await dbClientStore.dropTable(conn.id, confirmDropTarget.name, { database: confirmDropTarget.database });
			if (activeObject?.name === confirmDropTarget.name) {
				dbClientStore.setActiveObject(conn.id, null);
			}
			dbClientStore.requestSchemaReload();
		} catch (e) {
			debug.error('db-client', 'drop failed:', e);
		}
	}

	async function doReset(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !confirmDropTarget) return;
		try {
			await dbClientStore.resetTable(conn.id, confirmDropTarget.name, { database: confirmDropTarget.database });
			dbClientStore.touchData();
		} catch (e) {
			debug.error('db-client', 'reset table failed:', e);
		}
	}

	async function doDuplicate(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !duplicateSource || !duplicateName.trim()) return;
		try {
			await dbClientStore.duplicateTable(conn.id, duplicateSource.name, duplicateName.trim(), {
				database: duplicateSource.database,
				withData: duplicateWithData
			});
			dbClientStore.requestSchemaReload();
		} catch (e) {
			debug.error('db-client', 'duplicate table failed:', e);
		}
		duplicateSource = null;
	}

	async function doDropDatabase(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !dbActionTarget) return;
		try {
			const dropped = dbActionTarget.name;
			await dbClientStore.dropDatabase(conn.id, dropped);
			if (activeObject?.database === dropped) {
				dbClientStore.setActiveObject(conn.id, null);
			}
			// If we dropped the database we were browsing, step back to the
			// database list so we don't query a database that no longer exists.
			if (dbClientStore.openedDatabase[conn.id] === dropped) {
				dbClientStore.setOpenedDatabase(conn.id, null);
			}
			dbClientStore.requestSchemaReload();
		} catch (e) {
			debug.error('db-client', 'drop database failed:', e);
		}
		dbActionTarget = null;
	}

	async function doEmptyDatabase(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !dbActionTarget) return;
		try {
			await dbClientStore.resetDatabase(conn.id, { database: dbActionTarget.scope });
			dbClientStore.requestSchemaReload();
			dbClientStore.touchData();
		} catch (e) {
			debug.error('db-client', 'empty database failed:', e);
		}
		dbActionTarget = null;
	}

	async function doFlushDatabase(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !dbActionTarget) return;
		try {
			await dbClientStore.flushDatabase(conn.id);
			dbClientStore.requestSchemaReload();
			dbClientStore.touchData();
		} catch (e) {
			debug.error('db-client', 'flush database failed:', e);
		}
		dbActionTarget = null;
	}

	async function doRenameDatabase(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !renameDbTarget || !renameDbValue.trim()) return;
		try {
			const oldName = renameDbTarget;
			const newName = renameDbValue.trim();
			await dbClientStore.renameDatabase(conn.id, oldName, newName);
			if (activeObject?.database === oldName) {
				dbClientStore.setActiveObject(conn.id, null);
			}
			// Follow the rename: if we were browsing it, open the new name so its
			// (preserved) data stays visible instead of the now-missing old name.
			if (dbClientStore.openedDatabase[conn.id] === oldName) {
				dbClientStore.setOpenedDatabase(conn.id, newName);
			}
			dbClientStore.requestSchemaReload();
		} catch (e) {
			debug.error('db-client', 'rename database failed:', e);
		}
		renameDbTarget = null;
	}

	async function doCreateTable(payload: { name: string; columns: { name: string; type: string; nullable: boolean; default: string; primary: boolean; unique: boolean; autoIncrement: boolean }[] }): Promise<void> {
		const conn = activeConnection;
		if (!conn) return;
		await dbClientStore.createTable(conn.id, {
			name: payload.name,
			columns: payload.columns.map((c) => ({
				name: c.name,
				type: c.type,
				nullable: c.nullable,
				default: c.default || null,
				primary: c.primary,
				unique: c.unique,
				autoIncrement: c.autoIncrement
			}))
		}, { database: createTableDb });
		dbClientStore.requestSchemaReload();
	}

	async function doCreateView(): Promise<void> {
		const conn = activeConnection;
		if (!conn || !createViewName || !createViewQuery) return;
		try {
			await ws_createView(conn.id);
			dbClientStore.requestSchemaReload();
		} catch (e) {
			debug.error('db-client', 'create view failed:', e);
		}
	}

	async function ws_createView(connId: string): Promise<void> {
		const ws = (await import('$frontend/utils/ws')).default;
		await ws.http('db-client:structure:create-view', {
			connectionId: connId,
			name: createViewName,
			query: createViewQuery,
			database: createViewDb
		});
	}

	const VIEW_DEFS: { id: DbClientView; label: string; icon: IconName }[] = [
		{ id: 'overview', label: 'Overview', icon: 'lucide:info' },
		{ id: 'query', label: 'Query', icon: 'lucide:code' },
		{ id: 'data', label: 'Data', icon: 'lucide:table' },
		{ id: 'structure', label: 'Structure', icon: 'lucide:layout-list' }
	];

	// At connection scope (no table context) Data/Structure are hidden.
	const visibleViews = $derived(
		atConnectionScope ? VIEW_DEFS.filter((v) => v.id === 'overview' || v.id === 'query') : VIEW_DEFS
	);

	function pickView(v: DbClientView): void {
		if (!activeConnection) return;
		dbClientStore.setView(activeConnection.id, v);
	}

	const showSchemaTree = $derived(!!activeConnection && !isFormOpen);

	const activeObjectIcon = $derived<IconName>(
		activeObject?.type === 'view'
			? 'lucide:eye'
			: activeObject?.type === 'collection'
				? 'lucide:layers'
				: activeObject?.type === 'key'
					? 'lucide:key'
					: 'lucide:table'
	);
</script>

<svelte:window on:resize={handleResize} />

<Modal
	bind:isOpen
	{onClose}
	bare
	mobileFullscreen
	ariaLabelledBy="db-client-title"
	className="flex flex-col w-full max-w-[90vw] h-[85dvh] max-h-[900px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]"
>
	{#snippet children()}
		{#if isMobile}
			<header class="flex items-center justify-between py-3 px-4 border-b border-slate-200 dark:border-slate-800">
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={() => (isMobileMenuOpen = !isMobileMenuOpen)}
					aria-label="Toggle menu"
				>
					<Icon name={isMobileMenuOpen ? 'lucide:arrow-left' : 'lucide:menu'} class="w-5 h-5" />
				</button>
				<h2 id="db-client-title" class="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100 m-0">DB Client</h2>
				<button
					type="button"
					class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
					onclick={onClose}
					aria-label="Close"
				>
					<Icon name="lucide:x" class="w-5 h-5" />
				</button>
			</header>
		{/if}

		<div class="flex flex-1 min-h-0 relative">
			<aside
				class="flex flex-col w-72 shrink-0 bg-white dark:bg-slate-900/98 border-r border-slate-200 dark:border-slate-800
					{isMobile
					? 'absolute left-0 top-0 bottom-0 z-30 w-80 bg-white dark:bg-slate-900 shadow-[4px_0_20px_rgba(0,0,0,0.15)] dark:shadow-[4px_0_20px_rgba(0,0,0,0.3)] transition-transform duration-250 ease-out'
					: ''}
					{isMobile && !isMobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}"
			>
				{#if !isMobile}
					<header class="flex items-center justify-between py-1.5 px-4 pl-6 border-b border-slate-200 dark:border-slate-800 shrink-0">
						<div class="flex items-center gap-2.5 text-md font-bold text-slate-900 dark:text-slate-100">
							<span>DB Client</span>
						</div>
						<button
							type="button"
							class="flex items-center justify-center w-9 h-9 bg-transparent border-none rounded-lg text-slate-500 cursor-pointer transition-all duration-150 hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
							onclick={onClose}
							aria-label="Close"
						>
							<Icon name="lucide:x" class="w-5 h-5" />
						</button>
					</header>
				{/if}

				<div class="flex flex-col min-h-0 flex-1">
					{#if showSchemaTree && activeConnection}
						<div class="flex flex-col min-h-0 flex-1">
							{#key schemaRefreshKey}
								<SchemaTree
									connectionId={activeConnection.id}
									{onContextMenu}
									{onScopeMenu}
									onBackToConnections={backToConnections}
									onCreateTable={(db) => { createTableDb = db; createTableOpen = true; }}
								/>
							{/key}
						</div>
						<div class="flex items-center gap-1 px-2 py-1.5 border-t border-slate-200 dark:border-slate-800 shrink-0">
							<button
								type="button"
								class="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
								onclick={() => (importOpen = true)}
								title="Import"
							>
								<Icon name="lucide:upload" class="w-4 h-4" />
								<span>Import</span>
							</button>
							<button
								type="button"
								class="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60 transition-colors"
								onclick={() => (exportOpen = true)}
								title="Export"
							>
								<Icon name="lucide:download" class="w-4 h-4" />
								<span>Export</span>
							</button>
						</div>
					{:else}
						<div class="flex-1 min-h-0">
							<ConnectionList onSelect={onConnectionPicked} />
						</div>
					{/if}
				</div>
			</aside>

			{#if isMobile && isMobileMenuOpen}
				<button
					type="button"
					class="absolute inset-0 z-[25] bg-black/40 border-none p-0 cursor-default"
					onclick={() => (isMobileMenuOpen = false)}
					aria-label="Close menu"
				></button>
			{/if}

			<main class="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-50 dark:bg-slate-950">
				{#if activeConnection}
					<div class="flex-1 min-h-0 px-3 pt-3 pb-3 flex flex-col gap-2">
						<!-- block 1: header -->
						<div class="flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shrink-0">
							<div class="flex items-center gap-1 shrink-0">
								{#each visibleViews as v (v.id)}
									<button
										type="button"
										class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors
											{activeView === v.id
												? 'bg-violet-500/10 text-violet-700 dark:text-violet-300 font-semibold'
												: 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
										onclick={() => pickView(v.id)}
									>
										<Icon name={v.icon} class="w-4 h-4" />
										{v.label}
									</button>
								{/each}
							</div>
							<div class="flex-1 min-w-0"></div>
							{#if activeObject}
								<div class="flex items-center gap-1.5 shrink-0 text-sm font-semibold text-slate-700 dark:text-slate-200">
									<Icon name={activeObjectIcon} class="w-4 h-4 text-slate-400 dark:text-slate-500 shrink-0" />
									<span class="truncate max-w-[240px]">{activeObject.name}</span>
								</div>
							{/if}
							<div class="flex items-center gap-0.5 shrink-0 pl-1">
								<button
									type="button"
									class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
									onclick={() => activeConnection && dbClientStore.navBack(activeConnection.id)}
									disabled={!canNavBack}
									title="Back"
									aria-label="Back"
								>
									<Icon name="lucide:arrow-left" class="w-4 h-4" />
								</button>
								<button
									type="button"
									class="flex items-center justify-center w-7 h-7 rounded-md text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
									onclick={() => activeConnection && dbClientStore.navForward(activeConnection.id)}
									disabled={!canNavForward}
									title="Forward"
									aria-label="Forward"
								>
									<Icon name="lucide:arrow-right" class="w-4 h-4" />
								</button>
							</div>
						</div>

						<!-- block 2: content -->
						<div class="flex-1 min-h-0 flex flex-col bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
							{#if activeView === 'overview'}
								<OverviewPanel
									connectionId={activeConnection.id}
									database={scopeDb}
								/>
							{:else if activeView === 'query'}
								<QueryEditor
									connectionId={activeConnection.id}
									driver={activeConnection.driver}
									database={activeConnection.database ?? undefined}
								/>
							{:else if activeView === 'data'}
								{#if activeObject}
									<DataGrid
										connectionId={activeConnection.id}
										driver={activeConnection.driver}
										objectName={activeObject.name}
										database={activeObject.database}
										schema={activeObject.schema}
										filter={activeObject.filter ?? null}
									/>
								{:else}
									<div class="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-600">
										<div class="flex flex-col items-center gap-3 text-center px-6">
											<Icon name="lucide:table" class="w-10 h-10 opacity-40" />
											<div class="text-sm font-medium text-slate-500 dark:text-slate-400">
												Select a table or collection from the sidebar to view its data.
											</div>
										</div>
									</div>
								{/if}
							{:else if activeView === 'structure'}
								{#if activeObject}
									<StructureManager
										connectionId={activeConnection.id}
										driver={activeConnection.driver}
										objectName={activeObject.name}
										database={activeObject.database}
										schema={activeObject.schema}
									/>
								{:else}
									<div class="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-600">
										<div class="flex flex-col items-center gap-3 text-center px-6">
											<Icon name="lucide:settings" class="w-10 h-10 opacity-40" />
											<div class="text-sm font-medium text-slate-500 dark:text-slate-400">
												Select a table from the sidebar to inspect its structure.
											</div>
										</div>
									</div>
								{/if}
							{/if}
						</div>
					</div>
				{:else}
					<div class="flex-1 min-h-0 p-3 flex flex-col">
						<div class="flex-1 flex items-center justify-center bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 text-slate-400 dark:text-slate-600">
							<div class="flex flex-col items-center gap-3 text-center px-6">
								<Icon name="lucide:mouse-pointer-click" class="w-10 h-10 opacity-40" />
								<div class="text-sm font-medium text-slate-500 dark:text-slate-400">
									Select a connection to begin
								</div>
							</div>
						</div>
					</div>
				{/if}
			</main>
		</div>
	{/snippet}
</Modal>

{#if menuOpen}
	<SchemaTreeContextMenu
		items={menuItems}
		x={menuX}
		y={menuY}
		onSelect={onMenuSelect}
		onClose={() => (menuOpen = false)}
	/>
{/if}

<Dialog
	bind:isOpen={renameOpen}
	onClose={() => (renameOpen = false)}
	title="Rename"
	type="info"
	bind:inputValue={renameValue}
	confirmText="Rename"
	onConfirm={doRename}
/>

<ConfirmDestructive
	bind:isOpen={confirmTruncate}
	title="Truncate?"
	message={`Remove all rows from "${confirmDropTarget?.name ?? ''}"? This cannot be undone.`}
	confirmText="Truncate"
	onConfirm={doTruncate}
	onClose={() => (confirmTruncate = false)}
/>

<ConfirmDestructive
	bind:isOpen={confirmDrop}
	title="Drop?"
	message={`Permanently drop "${confirmDropTarget?.name ?? ''}"? This cannot be undone.`}
	confirmText="Drop"
	onConfirm={doDrop}
	onClose={() => (confirmDrop = false)}
/>

<ConfirmDestructive
	bind:isOpen={confirmReset}
	title="Reset?"
	message={`Remove all rows from "${confirmDropTarget?.name ?? ''}" and reset its auto-increment counter? This cannot be undone.`}
	confirmText="Reset"
	onConfirm={doReset}
	onClose={() => (confirmReset = false)}
/>

<ConfirmDestructive
	bind:isOpen={confirmFlushDatabase}
	title="Flush database?"
	message={`Delete every key in this Redis database? This cannot be undone.`}
	confirmText="Flush"
	onConfirm={doFlushDatabase}
	onClose={() => (confirmFlushDatabase = false)}
/>

<ConfirmTyped
	bind:isOpen={confirmEmptyDatabase}
	title="Empty database?"
	message={`This deletes all rows from every table in "${dbActionTarget?.name ?? ''}". The schema is kept, but the data cannot be recovered.`}
	expected={dbActionTarget?.name ?? ''}
	confirmText="Empty database"
	onConfirm={doEmptyDatabase}
	onClose={() => (confirmEmptyDatabase = false)}
/>

<ConfirmTyped
	bind:isOpen={confirmDropDatabase}
	title="Drop database?"
	message={`This permanently drops the database "${dbActionTarget?.name ?? ''}" and everything in it. This cannot be undone.`}
	expected={dbActionTarget?.name ?? ''}
	confirmText="Drop database"
	onConfirm={doDropDatabase}
	onClose={() => (confirmDropDatabase = false)}
/>

<Dialog
	bind:isOpen={renameDbOpen}
	onClose={() => (renameDbOpen = false)}
	title="Rename database"
	type="info"
	bind:inputValue={renameDbValue}
	confirmText="Rename"
	onConfirm={doRenameDatabase}
/>

{#if activeConnection}
	<Modal
		bind:isOpen={duplicateOpen}
		onClose={() => (duplicateOpen = false)}
		title="Duplicate"
		size="md"
	>
		{#snippet children()}
			<div class="space-y-3">
				<div>
					<label for="dup-name" class="text-xs font-medium text-slate-700 dark:text-slate-300">New name</label>
					<input
						id="dup-name"
						type="text"
						class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
						bind:value={duplicateName}
					/>
				</div>
				<label class="inline-flex items-center gap-1.5 text-sm cursor-pointer">
					<Checkbox bind:checked={duplicateWithData} ariaLabel="Copy data" /> Copy data
				</label>
			</div>
		{/snippet}
		{#snippet footer()}
			<Button variant="outline" size="sm" onclick={() => (duplicateOpen = false)}>Cancel</Button>
			<Button variant="primary" size="sm" onclick={async () => { await doDuplicate(); duplicateOpen = false; }} disabled={!duplicateName.trim()}>Duplicate</Button>
		{/snippet}
	</Modal>
{/if}

{#if activeConnection}
	<TableDesigner
		bind:isOpen={createTableOpen}
		driver={activeConnection.driver}
		mode="create-table"
		onSubmit={doCreateTable}
		onClose={() => (createTableOpen = false)}
	/>
	<ExportModal
		bind:isOpen={exportOpen}
		connectionId={activeConnection.id}
		driver={activeConnection.driver}
		database={activeConnection.database ?? undefined}
		initialSelection={exportPreselect}
		onClose={() => (exportOpen = false)}
	/>
	<ImportModal
		bind:isOpen={importOpen}
		connectionId={activeConnection.id}
		driver={activeConnection.driver}
		database={activeConnection.database ?? undefined}
		onClose={() => (importOpen = false)}
		onImported={() => dbClientStore.requestSchemaReload()}
	/>
{/if}

<Modal
	bind:isOpen={createViewOpen}
	onClose={() => (createViewOpen = false)}
	title="Create view"
	size="md"
>
	{#snippet children()}
		<div class="space-y-3">
			<div>
				<label for="view-name" class="text-xs font-medium text-slate-700 dark:text-slate-300">View name</label>
				<input
					id="view-name"
					type="text"
					class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
					bind:value={createViewName}
				/>
			</div>
			<div>
				<label for="view-query" class="text-xs font-medium text-slate-700 dark:text-slate-300">Query</label>
				<textarea
					id="view-query"
					rows="6"
					class="w-full mt-1 px-2 py-1.5 text-sm bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded"
					bind:value={createViewQuery}
				></textarea>
			</div>
		</div>
	{/snippet}
	{#snippet footer()}
		<Button variant="outline" size="sm" onclick={() => (createViewOpen = false)}>Cancel</Button>
		<Button variant="primary" size="sm" onclick={async () => { await doCreateView(); createViewOpen = false; }} disabled={!createViewName || !createViewQuery}>Create</Button>
	{/snippet}
</Modal>
