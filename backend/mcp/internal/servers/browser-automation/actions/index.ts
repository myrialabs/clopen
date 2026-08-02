/**
 * Action registry — the single source of truth.
 *
 * The tool's schema, its documentation and the runner's dispatch table are all
 * derived from this list, so an action cannot exist in one and be missing from
 * another.
 */

import type { ActionDef } from './types';
import { tabActions } from './tabs';
import { navigationActions } from './navigation';
import { inputActions } from './input';
import { inspectActions } from './inspect';
import { consoleActions } from './console';

/** Grouped for the documentation; order is the order an agent meets them. */
export const ACTION_GROUPS: Array<{ title: string; actions: ActionDef[] }> = [
	{ title: 'Tabs & viewport', actions: tabActions },
	{ title: 'Navigation & waiting', actions: navigationActions },
	{ title: 'Input (mouse, keyboard, touch)', actions: inputActions },
	{ title: 'Inspection', actions: inspectActions },
	{ title: 'Console', actions: consoleActions }
];

export const ALL_ACTIONS: ActionDef[] = ACTION_GROUPS.flatMap((group) => group.actions);

export const ACTIONS_BY_TYPE: Map<string, ActionDef> = new Map(
	ALL_ACTIONS.map((action) => [action.type, action])
);

export type { ActionContext, ActionDef, ActionOutput } from './types';
