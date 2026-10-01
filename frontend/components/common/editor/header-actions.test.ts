/**
 * Which header actions stay on the bar and which fall into "⋯".
 *
 * Nothing is hidden while everything fits; once it does not, one slot goes to
 * the "⋯" button and the least important actions are the ones that move, with
 * both lists keeping the order the surface gave.
 */

import { describe, it, expect } from 'bun:test';
import { ACTION_SLOT, actionWidth, splitActions, type HeaderAction } from './header-actions';

function action(id: string, priority?: number): HeaderAction {
	return { id, label: id, icon: 'lucide:copy', priority };
}

const ids = (list: HeaderAction[]) => list.map((entry) => entry.id);

describe('splitActions', () => {
	const actions = [action('a', 1), action('b', 5), action('c', 3), action('d', 5)];

	it('hides nothing when every action fits', () => {
		const { visible, overflow } = splitActions(actions, ACTION_SLOT * 4);
		expect(ids(visible)).toEqual(['a', 'b', 'c', 'd']);
		expect(overflow).toEqual([]);
	});

	it('keeps a slot for the menu and moves the least important actions into it', () => {
		const { visible, overflow } = splitActions(actions, ACTION_SLOT * 3);
		expect(ids(visible)).toEqual(['b', 'd']);
		expect(ids(overflow)).toEqual(['a', 'c']);
	});

	it('moves the later of two equals first', () => {
		const { visible } = splitActions([action('x'), action('y'), action('z')], ACTION_SLOT * 2);
		expect(ids(visible)).toEqual(['x']);
	});

	it('puts everything in the menu when only the menu fits', () => {
		const { visible, overflow } = splitActions(actions, ACTION_SLOT);
		expect(visible).toEqual([]);
		expect(ids(overflow)).toEqual(['a', 'b', 'c', 'd']);
	});

	it('counts the chevron of an action that opens a menu', () => {
		const menu: HeaderAction = { ...action('menu', 9), choices: [] };
		expect(actionWidth(menu)).toBeGreaterThan(ACTION_SLOT);
		const { visible, overflow } = splitActions([menu, action('b'), action('c')], 100);
		expect(ids(visible)).toEqual(['menu']);
		expect(ids(overflow)).toEqual(['b', 'c']);
	});

	it('has nothing to hide with no actions', () => {
		expect(splitActions([], 0)).toEqual({ visible: [], overflow: [] });
	});
});
