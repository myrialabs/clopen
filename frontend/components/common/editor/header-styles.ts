/** Icon button in an editor header — every surface's actions use it. */
export const HEADER_BUTTON =
	'flex p-2 text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-all duration-200';

export const HEADER_ICON = 'w-4 h-4';

import type { HeaderTone } from './header-actions';

const BASE = 'flex shrink-0 p-2 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent';

/** A header action as a button: its tone, and the look of a toggle that is on. */
export function actionClass(tone: HeaderTone = 'default', active = false): string {
	switch (tone) {
		case 'success':
			return `${BASE} text-green-600 dark:text-green-400 hover:text-green-700 dark:hover:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/30`;
		case 'warning':
			return `${BASE} text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30`;
		case 'primary':
			return `${BASE} text-white bg-violet-600 hover:bg-violet-700`;
		case 'sky':
			return `${BASE} text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 hover:bg-sky-50 dark:hover:bg-sky-900/30`;
		default:
			return active
				? `${BASE} text-violet-600 dark:text-violet-400 bg-violet-100 dark:bg-violet-900/50`
				: `${BASE} text-slate-600 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30`;
	}
}
