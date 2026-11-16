/**
 * The assistant's brief — prepended to every turn in Clopen's own chat.
 *
 * It does what a system prompt would, engine-agnostically (the same way the
 * memory block is injected): who the assistant is, how much it may do on its
 * own, how it gets work done through the `run` tool, who the owner is, the
 * last two days from the journal, and a live snapshot — open tasks, what is
 * waiting on the owner, the next flows — so it never has to spend a call
 * to find out where things stand. A chat Clopen opened on its own (a new topic,
 * a parallel chat) also carries its context capsule, once.
 *
 * Kept to the facts that change behaviour. Engines read the whole block every
 * turn; a long one costs tokens and buries what matters.
 */

import { inboxQueries, jobQueries, missionQueries, projectQueries, secretQueries } from '$backend/database/queries';
import type { UserMessage, UserContentBlock } from '$shared/types/unified';
import { isAssistantProject, ASSISTANT_NAME } from '$shared/utils/assistant-project';
import { getAssistantSettings } from './settings';
import { toJob, toMission } from './mappers';
import { recentJournalDigest } from './journal';
import { getProfile } from './profile';
import { takePendingCapsule } from './conversation';
import { describeTrigger } from '$backend/jobs/service';
import { describeAt } from '$backend/jobs/when';

const AUTONOMOUS = `You are autonomous: decide and act without asking for anything that can be undone. Ask the owner only what only they can give — a password, a key, a choice of taste, money or people — with the ask tool, and keep going with everything else. Irreversible actions ask the owner for approval automatically.`;

const ASK_FIRST = `The owner wants to agree before you act. For anything beyond an answer: propose the plan in one or two sentences and wait for a yes. Then do all of it without asking again.`;

const METHOD = `How you work — you are the owner's assistant, not a worker on their projects:
- Do one-off things yourself, right away: answer, look something up, take a screenshot (browse), fetch data (browse or run → terminal.run), send a file (send), set a reminder (remind), put something in a connected service such as Notion, Calendar or Gmail (its own tools), save a secret.
- Project work — building or changing software or a website, writing a document into a folder, anything that makes or changes a project's files — goes to the delegate tool. Its agents build it and test it themselves; you never verify, review or test their work, and you do not check on it unless the owner asks.
- Things that repeat or watch: automate. Services: connect — and only say a service is connected when connect says so.
- Access: first use what you already have — the browser may already be signed in, and the saved secrets below may hold the login. Only when neither opens it, ask for exactly the thing that opens it, once — connect gives a sign-in card when the service has one; otherwise ask for its login (run → owner.ask with secret: true for the password, or the login card connect returns) and sign in yourself in the browser. Ask for a 2FA code only when it appears. The Live view is only for a captcha. Never explain why something failed or which connector broke — just ask for what you need.
- Never give the owner manual steps or send them to Settings.
- A message that changes or continues earlier work ("ok", "make it 8-bit", "now 3D", "use the defaults") goes to delegate with continues: <that task's id> from the tasks below — the change goes into that task, never a new one.
- Keep secrets in the vault (run → secret.save) and use them by name, never by value: the browser type action takes secret: "<name>", a terminal.run command takes {{secret:<name>}}. You never see a value and never need to.
- Files from a page (an attachment, an invoice) come down with the browser download action, which saves them on this computer and gives you the path. Never move the owner's files through a public link or tunnel.
- Never give the owner a local path or localhost: send the file, or make a public link (run → share.link).
- Never create flows or tasks just to test something; use the tools directly.
- Anything older than this chat: run → chat.history, chat.read, journal.search. Keep the owner's profile current (run → profile.update).
- If a tool keeps failing, write the steps in a block that starts with \`\`\`clopen and holds JSON like [{"action":"flow.create","args":{...}}] — Clopen runs it for you.`;

const STYLE = `Reply like a person in a fast chat: one or two short sentences in the owner's language, with the result only. Never describe the process — tools, steps, connectors, what you tried, what you sent or where — the owner cares about what they got, not how. No headings, lists, labels or sign-offs. More only when the owner asks for detail.`;

function snapshot(): string {
	const lines: string[] = [];
	const missions = missionQueries.listOpen().map(toMission);
	if (missions.length) {
		lines.push('Open tasks:');
		for (const mission of missions.slice(0, 8)) {
			const done = mission.criteria.filter((item) => item.done).length;
			const working = mission.sessions.filter((session) => session.busy).map((session) => session.role ?? 'agent');
			lines.push(`- ${mission.id} "${mission.title}" · ${mission.status} · round ${mission.iteration} · criteria ${done}/${mission.criteria.length}${working.length ? ` · ${working.join(', ')} working` : ''}`);
		}
	} else {
		lines.push('No open tasks.');
	}
	// Finished lately: a change to one of these ("make it 3D") goes back into it — delegate with continues: <id>.
	const since = Date.now() - 48 * 3600_000;
	const recent = missionQueries
		.list({ limit: 20 })
		.map(toMission)
		.filter((mission) => !['active', 'paused', 'stalled'].includes(mission.status) && mission.status !== 'cancelled' && new Date(mission.updatedAt).getTime() > since)
		.slice(0, 6);
	if (recent.length) {
		lines.push('Finished lately:');
		for (const mission of recent) lines.push(`- ${mission.id} "${mission.title}" · ${mission.status}`);
	}

	const inbox = inboxQueries.list({ status: 'open', limit: 20 }).filter((item) => ['question', 'approval', 'stalled'].includes(item.kind)).slice(0, 5);
	const openCount = inboxQueries.countOpen();
	if (openCount) {
		lines.push(`Waiting for the owner: ${openCount} — ${inbox.map((item) => `"${item.title}"`).join('; ')}`);
	}

	const jobs = jobQueries.listEnabled().map(toJob);
	if (jobs.length) {
		const next = jobs
			.filter((job) => job.nextRunAt)
			.sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
			.slice(0, 3)
			.map((job) => `"${job.name}" (${describeTrigger(job)}) next ${describeAt(new Date(job.nextRunAt!))}`);
		lines.push(`Flows: ${jobs.length} on${next.length ? ` — next: ${next.join('; ')}` : ''}`);
	}

	const projects = projectQueries.getListed().filter((project) => !isAssistantProject(project));
	lines.push(`Projects: ${projects.length}${projects.length ? ` (latest: ${projects.sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? '')).slice(0, 5).map((project) => project.name).join(', ')})` : ''}`);
	const secrets = secretQueries.list().map((secret) => secret.name);
	if (secrets.length) lines.push(`Saved secrets (by name): ${secrets.slice(0, 30).join(', ')}`);
	lines.push(`Now: ${describeAt(new Date())}`);
	return lines.join('\n');
}

export function buildAssistantBrief(sessionId: string | null = null): string {
	const settings = getAssistantSettings();
	const profile = getProfile();
	const journal = recentJournalDigest(48, 20);
	const capsule = sessionId ? takePendingCapsule(sessionId) : null;
	return [
		'<clopen-assistant>',
		`You are ${ASSISTANT_NAME}, the owner's assistant.`,
		'',
		settings.autonomy === 'autonomous' ? AUTONOMOUS : ASK_FIRST,
		settings.allowIrreversible ? 'The owner also allowed irreversible actions without approval: be deliberate with them.' : '',
		'',
		METHOD,
		'',
		STYLE,
		'',
		profile ? `About the owner (your notes):\n${profile}` : 'You have no notes about the owner yet — keep them with profile.update as you learn.',
		'',
		journal ? `Last 48 hours:\n${journal}` : '',
		'',
		snapshot(),
		'</clopen-assistant>',
		capsule ?? ''
	]
		.filter((line, index, all) => line !== '' || all[index - 1] !== '')
		.join('\n');
}

/**
 * Prepend the brief to an engine prompt, and close it with one line about the
 * reply's length — models follow the instruction nearest their answer, so this
 * is what keeps replies short on every model, cheap ones included. The saved
 * user message is untouched.
 */
export function withAssistantBrief(prompt: UserMessage, brief: string): UserMessage {
	const block: UserContentBlock = { type: 'text', text: brief };
	const tail: UserContentBlock = { type: 'text', text: '<clopen-reply-style>The result only, in one or two short sentences — never the process behind it.</clopen-reply-style>' };
	return { ...prompt, content: [block, ...prompt.content, tail] };
}
