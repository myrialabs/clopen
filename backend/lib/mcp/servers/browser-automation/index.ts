/**
 * Browser Automation - Custom MCP Server
 *
 * Provides comprehensive browser automation tools for AI-driven testing and exploration.
 */

import { z } from "zod";
import { defineServer } from "../helper";

// Import handlers
import { listTabsHandler, switchTabHandler, openNewTabHandler, closeTabHandler, navigateHandler, setViewportHandler } from "./browser";
import { actionsHandler } from "./actions";
import { getConsoleLogsHandler, clearConsoleLogsHandler, executeConsoleHandler, takeScreenshotHandler, analyzeDomHandler } from "./inspection";

export default defineServer({
	name: "browser-automation",
	version: "1.0.0",
	tools: {
		// ============================================================================
		// Browser Tab Management
		// ============================================================================
		"list_tabs": {
			description: `List all open browser tabs with metadata.

WHEN TO USE:
- Start of session to see available tabs
- Before switching tabs
- Verify tab state after open/close operations

OUTPUT: Formatted text with tab index, ID, title, URL, and active indicator (*). Example:
[1] tab-abc123 * Google Search - https://google.com
[2] tab-def456   Calculator - https://calculator.net

Use exact tab ID from output with switch_tab or close_tab - not the index number.`,
			handler: listTabsHandler
		},

		"switch_tab": {
			description: `Switch browser focus to different tab.

WHEN TO USE:
- Multi-tab workflows
- Comparing content across tabs
- Managing multiple sessions

OUTPUT: Confirmation with switched tab's ID, title, and URL.

Tab ID must be obtained from list_tabs. After switching, previous tab's context is lost - take new screenshot or analyze_dom if needed.`,
			schema: {
				tabId: z.string().min(1).describe("Tab ID obtained from list_tabs output (e.g., 'tab-abc123')")
			},
			handler: switchTabHandler
		},

		"open_new_tab": {
			description: `Create new browser tab with optional URL and viewport configuration.

WHEN TO USE:
- Starting fresh session
- Opening multiple pages for comparison
- Separating workflows
- Testing risky actions in isolation
- Testing responsive designs across devices

OUTPUT: Tab ID, title, and URL of newly created tab. New tab automatically becomes active.

Automatically creates session. New tab is immediately active - no need to switch_tab. If URL provided, waits for page load.

VIEWPORT MODES:
- desktop: 1920x1080 (default rotation: landscape) - For testing full desktop layouts
- laptop: 1280x800 (default, default rotation: landscape) - Most common desktop viewport
- tablet: 820x1050 (default rotation: portrait) - iPad-like tablet viewport
- mobile: 393x740 (default rotation: portrait) - Modern smartphone viewport

ROTATION:
- portrait: Standard vertical orientation (default for tablet/mobile)
- landscape: Horizontal orientation (default for desktop/laptop)
- Omit rotation to use device-appropriate default`,
			schema: {
				url: z.string().url().optional().describe("Initial URL with protocol (http:// or https://). Omit for blank tab."),
				deviceSize: z.enum(['desktop', 'laptop', 'tablet', 'mobile']).optional().default('laptop').describe("Viewport device size (default: laptop). Choose based on testing needs."),
				rotation: z.enum(['portrait', 'landscape']).optional().describe("Screen orientation. If omitted, uses device-appropriate default: landscape for desktop/laptop, portrait for tablet/mobile.")
			},
			handler: openNewTabHandler
		},

		"close_tab": {
			description: `Close tab by ID and cleanup session.

WHEN TO USE:
- Cleanup after completing task
- Managing memory/resources
- Closing tabs no longer needed

OUTPUT: Confirmation message. If closed tab was active, automatically switches to another tab and returns new active tab info.

Cannot close last remaining tab (will error). If tab was active, focus moves to another tab - check list_tabs after.`,
			schema: {
				tabId: z.string().min(1).describe("Tab ID obtained from list_tabs output (e.g., 'tab-abc123')")
			},
			handler: closeTabHandler
		},

		"set_viewport": {
			description: `Change viewport settings (device size and rotation) for active tab.

WHEN TO USE:
- Testing responsive designs across devices
- Switching between mobile and desktop views
- Testing different screen orientations
- Simulating different device types

OUTPUT: Confirmation with tab ID and new viewport settings.

VIEWPORT MODES:
- desktop: 1920x1080 - For testing full desktop layouts
- laptop: 1280x800 - Most common desktop viewport
- tablet: 820x1050 - iPad-like tablet viewport
- mobile: 393x740 - Modern smartphone viewport

ROTATION:
- portrait: Standard vertical orientation
- landscape: Horizontal orientation (width and height swapped)

The viewport change is applied immediately to the active tab. If testing multiple viewports, consider taking screenshots before and after to compare layouts.`,
			schema: {
				deviceSize: z.enum(['desktop', 'laptop', 'tablet', 'mobile']).optional().describe("Viewport device size. Omit to keep current device size."),
				rotation: z.enum(['portrait', 'landscape']).optional().describe("Screen orientation. Omit to keep current rotation.")
			},
			handler: setViewportHandler
		},

		// ============================================================================
		// Navigation
		// ============================================================================
		"navigate": {
			description: `Navigate to URL and wait for page load.

PRIMARY USE: Following links when you have href URL (more efficient than clicking coordinates).

WHEN TO USE:
- Following links from analyze_dom.navigation.links (use href directly)
- Moving to known URLs
- Multi-page information extraction workflow
- Refreshing with new parameters

WHEN TO AVOID:
- Don't have URL (must use take_screenshot + click instead)
- Testing click interactions (use actions for actual click testing)

EFFICIENT WORKFLOW:

Information extraction across pages:
→ navigate(page1)
→ analyze_dom(['navigation', 'content'])
→ Find link: {text: "Pricing", href: "https://example.com/pricing"}
→ navigate(href) ← USE THIS, not click coordinates!
→ analyze_dom(['content'])
→ Extract information

Why navigate > click for links:
- Faster: direct URL navigation
- More reliable: no coordinate dependency
- Cleaner: no need for screenshot
- Better for information tasks

Example - Multi-page extraction:
Task: "Find pricing at loom.com"
→ navigate("https://www.loom.com")
→ analyze_dom(['navigation'])
→ Found: {text: "Pricing", href: "https://www.loom.com/pricing"}
→ navigate("https://www.loom.com/pricing") ← Efficient!
→ analyze_dom(['content'])
→ Extract pricing info

OUTPUT: Final URL after all redirects complete.

After navigate, page is completely new:
- Previous analyze_dom data is invalid - re-run on new page
- Pattern for information: navigate → analyze_dom
- Pattern for interaction: navigate → take_screenshot → actions

Session state (cookies, localStorage) preserved. Timeout 30 seconds. Handles redirects automatically.`,
			schema: {
				url: z.string().url().describe("Target URL with protocol (http:// or https://). Redirects handled automatically.")
			},
			handler: navigateHandler
		},

		// ============================================================================
		// Browser Actions
		// ============================================================================
		"actions": {
			description: `Execute browser interactions in sequence. Each action completes before next begins.

MANDATORY PLANNING PROTOCOL:

BEFORE executing ANY action sequence, you MUST follow this protocol:

1. STATE THE GOAL
   Write down the exact outcome you want to achieve.
   Example: "Enter formula (8 × 5) + (12 ÷ 3) - 7 into calculator"
   Example: "Fill login form with username and password, then submit"
   Example: "Navigate through multi-step checkout process"

2. PLAN THE SEQUENCE
   List each action and its expected result/state after execution.
   IMPORTANT: Write this planning EVEN for TYPE actions - always document your plan.

   Example (Calculator):
   Action 1: Click "(" → Display shows "("
   Action 2: Click "8" → Display shows "(8"
   Action 3: Click "×" → Display shows "(8×"
   Action 4: Click "5" → Display shows "(8×5"
   Action 5: Click ")" → Display shows "(8×5)"
   Action 6: Click "+" → Display shows "(8×5)+"
   ... continue for each step

   Example (Form):
   Action 1: Click username field → Field focused
   Action 2: Type "user@example.com" → Username entered
   Action 3: Click password field → Password field focused
   Action 4: Type "password123" → Password entered (hidden)
   Action 5: Click submit button → Form submitted

   Example (Calculator with TYPE):
   Action 1: Click input field → Field focused
   Action 2: Type "(15*8)/(4+2)" → Formula entered
   Action 3: Click "=" → Result calculated

3. VERIFY THE LOGIC
   Trace through the sequence mentally:
   - Does each action move toward the goal?
   - What is the state after each action?
   - Are there dependencies between actions?
   - Could any action produce unintended results?
   - Is this the most efficient approach?

4. EFFICIENT ALTERNATIVES:
   Before using click sequences, verify:
   - Can I TYPE instead of clicking individual buttons?
   - Can I NAVIGATE instead of clicking coordinates?
   - Is there a simpler single-action approach?

   PREFER:
   - TYPE over click sequence (for formulas, text input)
   - NAVIGATE over click coordinates (for links)
   - Single action over multiple actions (when possible)

   Example - Calculator:
   INCORRECT: Click "(" → "1" → "5" → "×" → "8" → ")" → "/" → "(" → "4" → "+" → "2" → ")" → "=" (13 actions)
   CORRECT: If input field exists, type "(15*8)/(4+2)" then click "=" (2 actions)

5. EXECUTE ONLY AFTER VERIFICATION
   Build the action array only after steps 1-4 are complete and verified.

6. VERIFY RESULT AFTER EXECUTION
   After complex sequences complete:
   - Check if result matches your planned input/goal
   - If mismatch detected (e.g., planned sin(45) but got sin(42)):
     * Acknowledge: "Planned [X] but result shows [Y]"
     * Explain likely cause (wrong coordinate, button misidentification, etc.)
     * Decide: Continue with corrected understanding OR re-execute if critical
   - For calculator/form tasks, verify the final input/output matches expectation

This protocol applies to ALL sequential actions: calculators, forms, navigation, games, automation workflows, etc.

COMMON MISTAKES TO AVOID:

Mistake: Not closing parentheses/brackets before next operation
Example: Click "√" → "64" → "+" results in √(64+...) instead of √64 +
Fix: Plan to close grouping before continuing: "√" → "64" → ")" → "+"

Mistake: Wrong order in multi-step forms
Example: Type in all fields → click submits → data goes to wrong inputs
Fix: Click field → type → click next field → type (interleave click and type)

Mistake: Not verifying state between dependent actions
Example: Click modal button → immediately click behind it → clicks wrong element
Fix: Add wait after modal opens, verify state, then continue

PURPOSE: Perform user-like actions (clicking, typing, scrolling) for INTERACTION TASKS.

TASK CLASSIFICATION:

INTERACTION TASKS (use actions):
- UI testing, automation testing
- Form filling that requires interaction
- Button clicking, element interaction
→ Workflow: take_screenshot → PLAN → VERIFY → actions

INFORMATION TASKS (DON'T use actions for navigation):
- Reading content, extracting information
- Following links to other pages
→ Workflow: analyze_dom → navigate (use href, NOT click)

WHEN TO USE:
- After take_screenshot when you have coordinates
- Clicking buttons, typing in forms, scrolling
- Testing interactions, automating workflows
- Solving obstacles (captcha, modals)

WHEN TO AVOID:
- Information extraction (use analyze_dom instead)
- Following links to navigate (use navigate with href from analyze_dom, not click coordinates)
- Reading text content (analyze_dom.content is faster)

COORDINATE SOURCE:

Coordinates come from AI vision analysis of screenshots, NOT from analyze_dom.

Process for getting coordinates:
1. Call take_screenshot to capture current page
2. Use AI vision to identify element positions in screenshot
3. Determine pixel coordinates (x, y) from visual analysis
4. Apply PLANNING PROTOCOL before building actions
5. Use verified coordinates in actions

Example - Click "Login" button:
Task: Click button labeled "Login"
→ take_screenshot (capture page)
→ AI vision: "Login button at x=1200, y=45"
→ PLAN: Click button → form appears
→ VERIFY: Single click achieves goal
→ Execute: {type: "click", x: 1200, y: 45}

Example - Sequential actions with planning:
Task: Calculate (15 × 8) / (4 + 2) - 3²

APPROACH A - If input field exists (PREFERRED):
→ take_screenshot
→ PLAN: Type formula directly, then calculate
→ VERIFY: Input field accepts text → yes
→ Execute: [
    {click input field x:640, y:311},
    {type "(15*8)/(4+2)-3^2"},
    {click equals x:913, y:479}
  ]

APPROACH B - If must use buttons:
→ take_screenshot
→ PLAN: Each button click in exact order
   "(": x:672,y:320 → display "("
   "1": x:672,y:449 → display "(1"
   "5": x:730,y:405 → display "(15"
   ... (continue for all 15+ buttons)
→ VERIFY: Sequence produces correct formula
→ Execute: [full button sequence with waits]

Example - Form filling with planning:
Task: Fill and submit login form
→ take_screenshot
→ PLAN:
   1. Click username field → focused
   2. Type email → entered
   3. Click password field → focused
   4. Type password → entered (hidden)
   5. Click submit → form submitted
→ VERIFY: Each field gets correct data in correct order
→ Execute: [
    {click x:640, y:300},
    {type "user@example.com"},
    {click x:640, y:380},
    {type "password123"},
    {click x:640, y:450}
  ]

ACTION TYPES:

click {x, y, click?: "left"/"right"/"middle"}
  Click at coordinates from screenshot AI vision analysis

type {text?: "string", key?: "Enter", clearFirst?: true}
  text: String to type (click input field first)
  key: Special key (Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, etc)
  clearFirst: true (default) removes existing text

move {x, y, steps?: 1}
  Move mouse to coordinates from screenshot (hover effects, tooltips)

scroll {deltaX?: 0, deltaY: 500}
  deltaY positive=down, negative=up

wait {delay: milliseconds}
  Pause between actions (use between dependent actions)

extract_data {selector: "CSS selector"}
  Extract text/value from DOM (use after actions complete)

OUTPUT:
- Success: "Successfully performed N action(s) in sequence"
- With extraction: Returns extracted text/value
- Error: Descriptive message if action fails

For complex sequences (>10 actions):
- Consider breaking into smaller batches (5-8 actions per batch)
- Take screenshot between batches to verify partial results
- Adjust if needed before continuing

Obstacle handling (captcha, modal, popup):
- NEVER stop or ask user - solve automatically
- Workflow: take_screenshot → identify → solve/dismiss → verify → continue
- If fails after attempts: report failure, proceed if possible`,
			schema: {
				actions: z.array(
					z.discriminatedUnion("type", [
						z.object({
							type: z.literal("click"),
							x: z.number().describe("X coordinate from screenshot AI vision"),
							y: z.number().describe("Y coordinate from screenshot AI vision"),
							click: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default: left)")
						}),
						z.object({
							type: z.literal("type"),
							text: z.string().optional().describe("Text to type into focused element"),
							key: z.string().optional().describe("Special key (Enter, Tab, Escape, ArrowDown, Backspace, etc)"),
							clearFirst: z.boolean().optional().describe("Clear field before typing (default: true)")
						}),
						z.object({
							type: z.literal("move"),
							x: z.number().describe("X coordinate from screenshot AI vision"),
							y: z.number().describe("Y coordinate from screenshot AI vision"),
							steps: z.number().optional().describe("Steps for smooth movement (default: 1)")
						}),
						z.object({
							type: z.literal("scroll"),
							deltaX: z.number().optional().describe("Horizontal pixels (positive=right, negative=left)"),
							deltaY: z.number().optional().describe("Vertical pixels (positive=down, negative=up)"),
							smooth: z.boolean().optional().describe("Smooth animation (default: false)")
						}),
						z.object({
							type: z.literal("wait"),
							delay: z.number().describe("Wait duration in milliseconds before next action")
						}),
						z.object({
							type: z.literal("extract_data"),
							selector: z.string().describe("CSS selector (e.g., '#username') or element ID to extract data from")
						})
					])
				).min(1).describe("Actions to execute in sequence. Apply PLANNING PROTOCOL before building this array.")
			},
			handler: actionsHandler
		},

		// ============================================================================
		// Page Inspection
		// ============================================================================
		"analyze_dom": {
			description: `Extract page information - text content, links, structure, and page metadata.

PRIMARY USE CASES:

1. WEBSITE EXPLORATION/CLONING
   Task keywords: "explore website", "clone website", "analyze site", "jelajahi website", "get all pages"
   → Use ONLY analyze_dom + navigate (NO screenshot needed)
   → Workflow: analyze_dom → navigate(href) → analyze_dom → repeat

   Example: "Clone example-company.com"
   CORRECT: analyze_dom → get links → navigate to each page → analyze_dom each page
   INCORRECT: analyze_dom → take_screenshot (expensive, unnecessary)

2. INFORMATION EXTRACTION
   Task keywords: "find", "read", "get", "extract", "search content"
   → Use analyze_dom for content, navigate for links
   → NO screenshot needed unless visual-only content

3. CONTENT RESEARCH
   Task keywords: "what does page say", "get article", "find documentation"
   → analyze_dom is PRIMARY method
   → Much faster and cheaper than screenshot

TASK CLASSIFICATION:

INFORMATION EXTRACTION TASKS (reading, finding, extracting, exploring):
→ PRIMARY: analyze_dom (fast, efficient, no screenshot needed)
→ SECONDARY: navigate (if need to follow links - use href, not click)
→ AVOID: take_screenshot (expensive, unnecessary for text content)

Examples:
- "Explore website and all pages" → analyze_dom + navigate only
- "Clone website structure" → analyze_dom + navigate only
- "Find pricing information" → analyze_dom.content
- "Get all navigation links" → analyze_dom.navigation.links
- "Read article summary" → analyze_dom.structure + content
- "Find documentation URL" → analyze_dom.navigation.links → navigate(href)

INTERACTION TASKS (clicking, typing, testing):
→ PRIMARY: take_screenshot (for coordinates)
→ SECONDARY: actions (execute interactions)
→ SUPPORT: analyze_dom (context only)

Examples:
- "Click login button" → take_screenshot → actions
- "Fill form" → analyze_dom (optional context) → take_screenshot → actions

WHEN TO USE:
- Read page content (text, headings, paragraphs)
- Get all links with URLs (for navigation)
- Understand page structure and hierarchy
- Extract form metadata
- Check page properties (iframes, captcha)

WHEN TO SKIP:
- Need pixel coordinates for clicking (use take_screenshot instead)
- Already have page information and unchanged

EFFICIENT INFORMATION EXTRACTION WORKFLOW:

Step 1: navigate to target page
Step 2: analyze_dom (get content, links, structure)
Step 3: If need more pages:
  - Find link in navigation.links (has href)
  - Use navigate(href) - NOT click coordinates
  - Repeat analyze_dom
Step 4: Extract and return information - DONE

NO screenshot needed for information tasks!

Example - "Explore/clone website example-company.com":
→ open_new_tab("https://example-company.com")
→ analyze_dom(['navigation', 'structure', 'content']) - get ALL page info
→ Find links: About, Products, Blog, Contact (in navigation.links)
→ navigate("https://example-company.com/about")
→ analyze_dom(['structure', 'content']) - get About page info
→ navigate("https://example-company.com/products")
→ analyze_dom(['structure', 'content']) - get Products page info
→ Continue for all pages
→ DONE (NO screenshot needed at all!)

Example - "Find pricing information at loom.com":
→ open_new_tab("https://www.loom.com")
→ analyze_dom(['navigation', 'content'])
→ Find pricing link: {text: "Pricing", href: "https://www.loom.com/pricing"}
→ navigate("https://www.loom.com/pricing")
→ analyze_dom(['content', 'structure'])
→ Extract pricing from content.paragraphs
→ DONE (no screenshot used!)

OUTPUT STRUCTURE:

navigation: {links: [{text, href}]}
  - ALL links on page (not just nav menu) - comprehensive extraction
  - Deduplicated by href
  - Use href with navigate tool (efficient)
  - Avoid clicking coordinates for navigation

structure: {headings: [{level, text, id}], sections: [{heading, summary}]}
  - Page organization and hierarchy

content: {paragraphs: [strings]}
  - Text content from various elements (p, div, li, td, span)
  - Deduplicated, up to 100 text items
  - Primary source for information extraction

forms: [{formId, action, fields: [{label, type, name, placeholder, required, currentValue}]}]
  - Form structure metadata

summary: {url, title, hasIframes, hasCaptcha, scrollableHeight, viewportHeight}
  - Page metadata
  - hasIframes/hasCaptcha: may need take_screenshot

IMPORTANT:

analyze_dom is PRIMARY method for information extraction tasks.
Use navigate + analyze_dom workflow - more efficient than screenshot + click.
Result becomes stale after navigation - re-run on new pages.`,
			schema: {
				include: z.array(z.enum(['navigation', 'structure', 'content', 'forms', 'summary'])).optional().describe("Sections to return. Omit for all. Use ['navigation', 'content'] for most reading tasks.")
			},
			handler: analyzeDomHandler
		},

		"take_screenshot": {
			description: `Capture viewport screenshot for visual analysis and coordinate determination.

TASK CLASSIFICATION:

Ask yourself: Is this an INTERACTION task or INFORMATION task?

INTERACTION TASKS (clicking, typing, testing):
→ USE: take_screenshot (get coordinates via AI vision)
→ Keywords: "click", "fill form", "type", "test UI", "automate interaction", "submit"
→ THEN: Apply PLANNING PROTOCOL before actions (see actions tool)

INFORMATION TASKS (reading, finding, exploring):
→ DO NOT USE: take_screenshot (expensive, unnecessary)
→ Keywords: "explore", "clone", "jelajahi", "find", "read", "get", "extract", "analyze"
→ USE INSTEAD: analyze_dom (10x faster, much cheaper)

WHEN TO USE:
- Need pixel coordinates for clicking/typing (analyze_dom has no coordinates)
- Visual-only content (calculator displays, canvas, images, charts)
- Iframe content (hasIframes=true - analyze_dom can't see inside)
- Obstacles (captcha, popups, modals)
- UI/visual verification (styling, layout, colors)
- Before/after visual comparison

WHEN TO SKIP:
- Website exploration/cloning (use analyze_dom + navigate only)
- Reading page content (analyze_dom.content is faster)
- Getting links for navigation (analyze_dom.navigation.links)
- Scrolling to "see more content" (analyze_dom already gets all DOM content)
- Information extraction tasks (use analyze_dom instead)
- Navigation (use navigate with href, not click coordinates)
- Already have recent screenshot and page unchanged

Cost consideration:
- Screenshot is EXPENSIVE (image encoding, AI vision processing)
- analyze_dom is CHEAP (text extraction, no image processing)
- Rule: If task is reading/extracting information → use analyze_dom, NOT screenshot

COMMON MISTAKES:

Mistake: Using screenshot for website exploration
Example: "Explore website" → take_screenshot → scroll → screenshot → scroll → screenshot
Fix: Use analyze_dom + navigate only (no screenshot needed)

Mistake: Screenshot to "see" text content
Example: Want to read page → take_screenshot
Fix: analyze_dom.content gives you all text directly

Mistake: Screenshot + scroll to see full page
Example: take_screenshot → scroll → screenshot → scroll
Fix: analyze_dom gets entire DOM at once, no scrolling needed

OUTPUT:
PNG image (base64 encoded) showing visible viewport.

WORKFLOW AFTER SCREENSHOT:

After taking screenshot for interaction tasks:
1. AI vision: Analyze screenshot to identify element positions
2. Determine pixel coordinates (x, y) for target elements
3. Apply PLANNING PROTOCOL (see actions tool) before executing:
   - STATE THE GOAL
   - PLAN THE SEQUENCE (what happens after each action)
   - VERIFY THE LOGIC
   - EFFICIENT ALTERNATIVES
   - VERIFY RESULT after execution
4. Execute actions only after verification

Example (INCORRECT) - Website exploration:

Task: "Explore example-company.com and all pages"
INCORRECT approach (expensive, slow, unnecessary):
→ open_new_tab
→ take_screenshot (not needed)
→ scroll → take_screenshot (repeat 5 times)
→ navigate to /about
→ take_screenshot (not needed)
→ scroll → take_screenshot
Total: 10+ screenshots, very expensive!

CORRECT approach (fast, efficient):
→ open_new_tab
→ analyze_dom (get all content + links)
→ navigate to /about
→ analyze_dom (get all content)
→ Continue for other pages
Total: 0 screenshots, 10x faster!

Example (CORRECT) - Button interaction:

Task: "Click the login button"
→ take_screenshot (need coordinates for interaction)
→ AI vision: "Login button at x=1200, y=45"
→ PLAN: Click button → login form appears
→ VERIFY: Single action achieves goal
→ actions([{click, x:1200, y:45}])

Example (CORRECT) - Sequential calculator actions:

Task: Enter calculator formula (15 × 8) / (4 + 2)
→ take_screenshot (need coordinates for interaction)
→ AI vision: Identify all needed buttons and their positions
→ CHECK: Is there an input field? If yes, TYPE is more efficient!
→ If TYPE available:
   PLAN: Click input → type formula → calculate
   actions([{click x:640,y:311}, {type "(15*8)/(4+2)"}, {click x:913,y:479}])
→ If must use buttons:
   PLAN each click: "(" at x:672,y:320 → "1" at x:672,y:449 → ...
   VERIFY: Sequence produces correct formula in correct order
   actions([full sequence with verification])

Example (CORRECT) - Form filling:

Task: "Fill login form"
→ take_screenshot (need coordinates for interaction)
→ AI vision: username x:640,y:300; password x:640,y:380; submit x:640,y:450
→ PLAN:
   1. Click username → focus
   2. Type email → entered
   3. Click password → focus
   4. Type password → entered
   5. Click submit → submitted
→ VERIFY: Correct order, correct data, correct targets
→ VERIFY RESULT: After execution, confirm form was filled correctly
→ actions([sequence])

OBSTACLE HANDLING:

When encountering obstacles (captcha, modals, popups, challenges):
- DO NOT stop or ask user
- Attempt to solve/dismiss automatically using AI vision
- Continue original task after resolving

Captcha workflow:
1. take_screenshot → identify captcha type
2. PLAN solution based on type:
   - Checkbox: click checkbox, wait, verify
   - Image selection: identify matching images, click sequence, verify
   - Text/math: solve, input, submit
3. Execute solution
4. take_screenshot (verify passed)
5. Continue task

Modal/popup workflow:
1. take_screenshot → identify modal/popup
2. Find close button or dismiss action
3. actions([click dismiss])
4. Continue task

IMPORTANT:
- Coordinates from AI vision are pixel positions in screenshot
- Can see inside iframes (unlike analyze_dom)
- Always apply PLANNING PROTOCOL before executing sequential actions
- When obstacles appear: solve automatically, never stop
- After actions: take new screenshot to verify or find new elements`,
			handler: takeScreenshotHandler
		},

		"get_console_logs": {
			description: `Retrieve browser console logs for debugging.

WHEN TO USE:
- Debug JavaScript errors after actions fail
- Monitor API calls or script execution
- Detect client-side errors not visible in UI
- Investigate unexpected behavior

OUTPUT: Formatted text, most recent first:
[2024-01-27 10:30:45] ERROR: Uncaught TypeError: Cannot read property 'value' of null
[2024-01-27 10:30:44] WARN: Deprecated API usage

Logs captured from browser console only - not backend logs. Default 20 entries, max 100. Logs persist until cleared or tab closed.`,
			schema: {
				limit: z.number().min(1).max(100).optional().default(20).describe("Maximum number of log entries to return (min: 1, max: 100, default: 20)")
			},
			handler: getConsoleLogsHandler
		},

		"clear_console_logs": {
			description: `Clear console logs from backend storage.

WHEN TO USE:
- Before important actions to isolate new logs
- Clean slate for debugging specific operations

OUTPUT: Success confirmation.

Only clears backend storage, not browser console. Use before actions for clean debugging context.`,
			handler: clearConsoleLogsHandler
		},

		"execute_console": {
			description: `Execute JavaScript in browser console.

WHEN TO USE:
- Extract dynamic data not in DOM (computed styles, variables, runtime state)
- Access browser APIs (localStorage, sessionStorage)
- Debug page behavior
- Verify JavaScript context

COMMON COMMANDS:
- document.title
- window.location.href
- localStorage.getItem("key")
- document.querySelector("#id").value
- Array.from(document.querySelectorAll(".item")).map(el => el.textContent)

OUTPUT: Execution result as JSON string, or error message.

Has full access to page context. Return value must be JSON-serializable. Use for extraction/debugging, not complex automation.`,
			schema: {
				command: z.string().min(1).describe("JavaScript expression or statement to execute (e.g., 'document.title', 'window.location.href', 'localStorage.getItem(\"key\")')")
			},
			handler: executeConsoleHandler
		},

	}
});
