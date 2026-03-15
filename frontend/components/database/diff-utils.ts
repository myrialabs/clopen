export type AnyDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export const STATUS_CONFIG: Record<
	AnyDiffStatus,
	{ color: string; bg: string; rowBg: string; label: string; badge: string }
> = {
	added: {
		color: 'text-emerald-600 dark:text-emerald-400',
		bg: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/40',
		rowBg: 'bg-emerald-50/60 dark:bg-emerald-950/20',
		label: 'ADD',
		badge: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
	},
	removed: {
		color: 'text-red-500 dark:text-red-400',
		bg: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800/40',
		rowBg: 'bg-red-50/60 dark:bg-red-950/20',
		label: 'DEL',
		badge: 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400'
	},
	modified: {
		color: 'text-amber-600 dark:text-amber-400',
		bg: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/40',
		rowBg: 'bg-amber-50/60 dark:bg-amber-950/20',
		label: 'MOD',
		badge: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400'
	},
	unchanged: {
		color: 'text-slate-400',
		bg: 'bg-white dark:bg-slate-900/40 border-slate-200 dark:border-slate-800',
		rowBg: '',
		label: '',
		badge: 'bg-slate-100 dark:bg-slate-800 text-slate-500'
	}
};
