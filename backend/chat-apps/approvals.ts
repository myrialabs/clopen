/**
 * Approving chats. A pairing code proves WHO is pairing (a signed-in Clopen
 * user asked for it), not that an admin wants that person driving Clopen
 * from a chat app. So a member's chat starts pending, and an admin approves
 * or rejects it, from Settings → Chat Apps or from their own paired chat,
 * where the request arrives with buttons. An admin's own chat needs nobody's
 * approval.
 */

import { markdownToRuns } from '@myrialabs/chatkit';
import { channelLinkQueries, channelMessageQueries, type ChannelLinkRow } from '$backend/database/queries';
import { getUserById, type AuthUser } from '$backend/auth/auth-service';
import { debug } from '$shared/utils/logger';
import { channelRuntime } from './runtime';
import { notifyLinksChanged } from './link-events';
import { REPLIES, menuCard, textCard } from './messages';

export function statusForNewLink(user: AuthUser): 'approved' | 'pending' {
	return user.role === 'admin' ? 'approved' : 'pending';
}

/** Approved, switched-on chats of admins on this bot: where a request is announced. */
function adminChats(accountId: string): ChannelLinkRow[] {
	return channelLinkQueries
		.listByAccount(accountId)
		.filter((link) => channelLinkQueries.isActive(link) && getUserById(link.user_id)?.role === 'admin');
}

/** Tell the bot's admins, in their chats, that someone is waiting — with Approve and Reject. */
export async function announcePending(link: ChannelLinkRow): Promise<void> {
	const owner = getUserById(link.user_id);
	if (!owner) return;
	const who = `${owner.name}${link.display_name ? ` (${link.display_name})` : ''}`;
	const runs = markdownToRuns(`**🔐 ${who} wants to control Clopen from this bot.**\n\nApprove it here or in Clopen → Settings → Chat Apps.`);
	const choices = [
		{ label: '✅ Approve', action: 'chat.approve', args: { linkId: link.id } },
		{ label: '✕ Reject', action: 'chat.reject', args: { linkId: link.id } }
	];
	for (const admin of adminChats(link.account_id)) {
		try {
			const id = channelMessageQueries.create({ linkId: admin.id, kind: 'menu', platformMessageId: 'pending', payload: { choices } }).id;
			const sent = await channelRuntime.send(admin.account_id, admin.conversation_id, menuCard(id, runs, choices));
			if (sent.platform_message_id) channelMessageQueries.setPlatformMessage(id, sent.platform_message_id);
		} catch (error) {
			debug.warn('chat-apps', 'Announcing a chat waiting for approval failed:', error);
		}
	}
}

/** Approve a pending chat and tell it. Returns false when there was nothing to approve. */
export async function approveLink(linkId: string): Promise<boolean> {
	const link = channelLinkQueries.getById(linkId);
	if (!link || link.status === 'approved') return false;
	channelLinkQueries.approve(link.id);
	const owner = getUserById(link.user_id);
	await channelRuntime.syncChatMenu(link.account_id, link.conversation_id, owner?.role ?? null, { force: true });
	await channelRuntime.send(link.account_id, link.conversation_id, textCard(REPLIES.approved)).catch(() => {});
	notifyLinksChanged(link.user_id);
	return true;
}

/** Reject a pending chat: it is unlinked, and told so. */
export async function rejectLink(linkId: string): Promise<boolean> {
	const link = channelLinkQueries.getById(linkId);
	if (!link || link.status !== 'pending') return false;
	channelLinkQueries.remove(link.id);
	await channelRuntime.send(link.account_id, link.conversation_id, textCard(REPLIES.rejected)).catch(() => {});
	notifyLinksChanged(link.user_id);
	return true;
}
