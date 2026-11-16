/**
 * Dialogs and the clipboard — the two things a page hands to the user rather
 * than handling itself.
 *
 * Both used to be out of the agent's reach. A page's alert() went to whoever
 * was watching the panel, and until someone clicked OK every action against
 * the tab hung. The clipboard was the viewer's device, which the agent cannot
 * see. They are the agent's now, exactly as they would be a person's.
 */

import { z } from 'zod';
import type { ActionDef, TablessActionContext } from './types';
import { commonFields } from './shared';

/** Long dialog text is quoted in full in the report; the summary only needs a gist. */
function gist(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export const dialog: ActionDef = {
	type: 'dialog',
	kind: 'control',
	activity: 'Answering a dialog',
	doc: `dialog {response, text?} — answer the alert / confirm / prompt / beforeunload the page has open.
  The report says when one opens and quotes it; the page runs nothing until it is answered, so decide as the user would.
  response: accept (OK, Leave) | dismiss (Cancel, Stay). text: the answer to a prompt.`,
	schema: z.object({
		type: z.literal('dialog'),
		response: z.enum(['accept', 'dismiss']).describe('accept = OK / Leave; dismiss = Cancel / Stay.'),
		text: z.string().optional().describe('Text for a prompt() dialog.'),
		...commonFields
	}),
	run: async (args, ctx) => {
		const answered = await ctx.service.respondToTabDialog(ctx.tab.id, args.response === 'accept', args.text);
		if (!answered) throw new Error('No dialog is open on this tab');

		const verb = args.response === 'accept' ? 'accepted' : 'dismissed';
		return { summary: `${verb} ${answered.type} "${gist(answered.message)}"` };
	}
};

export const clipboard: ActionDef = {
	type: 'clipboard',
	kind: 'control',
	activity: 'Using the clipboard',
	doc: `clipboard {text?} — read the clipboard, or set it with text.
  One clipboard is shared by the page, you and the user's device: after clicking a page's "Copy" button, read the copied value here instead of pasting it somewhere to look at it.`,
	schema: z.object({
		type: z.literal('clipboard'),
		text: z.string().optional().describe('Set the clipboard to this. Omit to read it.'),
		...commonFields
	}),
	needsTab: false,
	run: async (args, ctx: TablessActionContext) => {
		if (typeof args.text === 'string') {
			ctx.service.setClipboardText(args.text, 'agent');
			return { summary: `clipboard set (${args.text.length} char(s))` };
		}

		const text = ctx.service.getClipboardText();
		if (!text) return { summary: 'clipboard is empty' };
		return { summary: `clipboard holds ${text.length} char(s)`, detail: text };
	}
};

export const dialogActions: ActionDef[] = [dialog, clipboard];
