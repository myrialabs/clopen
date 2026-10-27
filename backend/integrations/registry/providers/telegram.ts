/**
 * Telegram — the first chat app.
 *
 * ONE FIELD: the bot token. A bot is the account; WHO it talks to is not a
 * property of the credential. Each Clopen user pairs their own chat with the
 * bot from Settings → Chat Apps, so one admin-connected bot serves every
 * member without anyone pasting a token twice.
 *
 * The webhook secret is GENERATED rather than asked for. Telegram has no
 * console where a user would find one — Clopen picks it and tells Telegram in
 * `setWebhook`, and Telegram echoes it back verbatim on every delivery. That
 * echo is also what tells two connected bots' deliveries apart at the one
 * shared hook URL.
 *
 * ONE capability: `control`. A paired chat is a remote control for Clopen
 * (sessions, projects, files, skills, models, engine accounts: the whole
 * control catalog in `backend/control/`), and the questions and answers it
 * gets are part of that conversation, not a separate notification mode to
 * switch on. Offering two capabilities for one bot only produced a bot
 * that could ping you but not be answered.
 *
 * Deliveries are gated on `control`, not on `inbound-events`: a button press
 * IS the channel working, and a further toggle to receive replies would be a
 * trap.
 */

import { defineProvider } from '../define';

export default defineProvider({
	id: 'telegram',
	name: 'Telegram',
	category: 'chat',
	description:
		'Control Clopen from Telegram: chat with any session (or none, from Home), send and get files, run your skills, switch projects and models, and answer questions or continue from any earlier message.',
	docsUrl: 'https://t.me/BotFather',
	authMethod: 'api-key',
	capabilities: ['control'],
	credentialFields: [
		{
			name: 'botToken',
			label: 'Bot token',
			placeholder: '123456789:AA…',
			help: 'Message @BotFather on Telegram, send /newbot, and paste the token it replies with. Each member then links their own chat from Settings → Chat Apps.',
			isSecret: true,
			isRequired: true
		}
	],
	generatedCredentials: ['webhookSecret'],
	webhook: {
		scheme: 'header-token',
		signatureHeader: 'x-telegram-bot-api-secret-token',
		secretField: 'webhookSecret',
		capabilities: ['control']
	}
});
