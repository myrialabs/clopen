/**
 * The tool description.
 *
 * MCP ships this text on every request, so it is written to earn its tokens:
 * the operating rules first, then the four workflows that cover almost all
 * real use, then a reference generated from the action registry itself — which
 * is why it can never document an action that no longer exists.
 */

import { ACTION_GROUPS } from './actions/index';

const PREAMBLE = `Drive the built-in preview browser: tabs, navigation, input, and reading the page.

Everything is one call. Pass an array of actions and they run in order, which is what makes this fast — one round trip instead of one per click.

HOW TO USE IT WELL

1. Batch. Put every step you can predict into one call: open_tab → wait_for → click → type → click → screenshot is a single call, not six. Split only where the next step depends on something you must read first.
2. Target by selector or text, not coordinates. Elements are resolved in every frame, scrolled into view, and aimed at their centre — coordinates go stale the moment the page reflows. Use \`find\` when you are unsure what to name; use x/y only for canvases and images.
3. Read with analyze_dom, not screenshots. Text, links and structure come back as text, for the whole document, at a fraction of the cost. Screenshot when the answer is visual: canvas, charts, layout, iframes, captchas.
4. Navigate by URL. If analyze_dom gave you an href, \`navigate\` to it. Clicking a link to move around is slower and fails more.
5. Synchronise with wait_for, not wait. wait_for returns the instant the condition holds; a fixed delay is either too short (the batch fails) or too long (every run pays for it).
6. Failure stops the batch. Anything after a failed action is skipped and reported as skipped. Mark a step \`optional: true\` when it may legitimately not apply — dismissing a cookie banner that might not be there — or set onError:"continue" for genuinely independent steps.
7. Obstacles are yours to clear. Captcha, modal, cookie wall: solve or dismiss it and carry on. Do not stop to ask.
8. Check the report. Every action reports its own outcome, and the report ends with the tab and URL you left behind. If a result contradicts your plan, say so and re-plan rather than continuing on the assumption it worked.

WORKFLOWS

Read a page / explore a site
  [{navigate}, {analyze_dom, include:["navigation","content"]}]
  then navigate to hrefs you found. No screenshots.

Fill a form
  [{find, text:"Email"}] → then one batch:
  [{type, selector:"#email", text:"…"}, {type, selector:"#password", text:"…"}, {click, selector:"button[type=submit]"}, {wait_for, urlContains:"/dashboard"}]

Check a layout on mobile
  [{set_viewport, deviceSize:"mobile"}, {wait_for, state:"networkIdle"}, {screenshot}]

Debug a page that misbehaves
  [{clear_console}, {click, selector:"#save"}, {wait, ms:500}, {console_logs, level:"error"}]`;

const OUTRO = `NOTES

- Coordinates are in the page's own viewport (CSS pixels), the same space a screenshot is captured in.
- Selectors are searched in every frame, so an element inside an iframe is addressed the same way as one in the main document.
- A tab opened, switched to or closed mid-batch becomes the target for the actions that follow it.
- You never have to open a tab first. On an empty browser the first action that needs a tab gets a blank one opened for it, and the report says so — \`navigate\` alone is a fine way to start.
- The user can interrupt at any time; the batch stops and the report says how far it got.`;

function renderReference(): string {
	const sections = ACTION_GROUPS.map((group) => {
		const entries = group.actions.map((action) => `- ${action.doc}`).join('\n');
		return `${group.title}\n${entries}`;
	});

	return `ACTIONS\n\n${sections.join('\n\n')}`;
}

export const actionsToolDescription = [PREAMBLE, renderReference(), OUTRO].join('\n\n');
