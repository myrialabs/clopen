/**
 * Small display helpers shared by the assistant's views.
 */

import type { InboxKind, MissionStatus } from '$shared/types/assistant';
import type { IconName } from '$shared/types/ui/icons';

/** "in 5 min", "2 h ago" — coarse on purpose; exact times are in tooltips. */
export function relativeTime(iso: string | null | undefined): string {
	if (!iso) return '';
	const diff = new Date(iso).getTime() - Date.now();
	const abs = Math.abs(diff);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	const value = abs < hour ? `${Math.max(1, Math.round(abs / minute))} min` : abs < day ? `${Math.round(abs / hour)} h` : `${Math.round(abs / day)} d`;
	if (abs < minute) return diff >= 0 ? 'now' : 'just now';
	return diff >= 0 ? `in ${value}` : `${value} ago`;
}

export function taskStatusLabel(status: MissionStatus, busy: boolean): string {
	switch (status) {
		case 'active':
			return busy ? 'Working' : 'Checking';
		case 'paused':
			return 'Paused';
		case 'stalled':
			return 'Not finished';
		case 'completed':
			return 'Done';
		case 'failed':
			return 'Stopped';
		case 'cancelled':
			return 'Cancelled';
	}
}

/** Background class for the status dot. */
export function taskStatusTone(status: MissionStatus, busy: boolean): string {
	switch (status) {
		case 'active':
			return busy ? 'bg-emerald-500 animate-pulse' : 'bg-sky-500';
		case 'paused':
			return 'bg-slate-400';
		case 'stalled':
			return 'bg-amber-500';
		case 'completed':
			return 'bg-emerald-500';
		case 'failed':
			return 'bg-red-500';
		case 'cancelled':
			return 'bg-slate-300 dark:bg-slate-600';
	}
}

export const INBOX_KIND: Record<InboxKind, { label: string; icon: IconName; tone: string }> = {
	question: { label: 'Question', icon: 'lucide:message-circle-question-mark', tone: 'text-sky-600 dark:text-sky-400' },
	approval: { label: 'Approval', icon: 'lucide:shield-alert', tone: 'text-amber-600 dark:text-amber-400' },
	report: { label: 'Update', icon: 'lucide:clipboard-check', tone: 'text-emerald-600 dark:text-emerald-400' },
	learned: { label: 'Learned', icon: 'lucide:sparkles', tone: 'text-violet-600 dark:text-violet-400' },
	stalled: { label: 'Stuck', icon: 'lucide:triangle-alert', tone: 'text-amber-600 dark:text-amber-400' },
	suggestion: { label: 'Suggestion', icon: 'lucide:lightbulb', tone: 'text-violet-600 dark:text-violet-400' }
};
