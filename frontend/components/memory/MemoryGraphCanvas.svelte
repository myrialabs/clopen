<script lang="ts">
	/**
	 * The graph itself — a calm constellation rather than a diagram.
	 *
	 * ── Why hover state is NOT `$state` ────────────────────────────────────────
	 * Sigma calls its node/edge reducers synchronously from inside `setGraph()` and
	 * `refresh()`. If those reducers read reactive state, Svelte records it as a
	 * dependency of whatever effect triggered the render — so hovering a node made
	 * the graph-building effect re-run, rebuilding the graph, restarting the layout
	 * and resetting the camera. Everything a reducer touches therefore lives in a
	 * plain variable. The rule to keep: a reducer must never read a rune.
	 *
	 * ── Why it no longer computes a layout ────────────────────────────────────
	 * It used to run ForceAtlas2 on every open — several hundred iterations to
	 * arrive at the same arrangement it arrived at last time, thrown away when the
	 * modal closed. That was the bulk of what made opening the modal stutter: the
	 * open animation is two hundred milliseconds of this thread, and the build plus
	 * the first layout batches landed inside it.
	 *
	 * Positions now arrive with the data, computed once in the background (see
	 * `backend/memory/layout.ts`). The simulation still exists here, but only for
	 * nodes that have no position yet — memories written since the last pass — and
	 * it is a short settle of a handful of arrivals rather than a solve of
	 * everything.
	 *
	 * ── Two resolutions ───────────────────────────────────────────────────────
	 * Past a render budget the server merges memories that share a cell of the
	 * layout grid into one mark, so what is drawn stays bounded however much
	 * memory accumulates — but only where the dots would have overlapped anyway,
	 * and a cell holding one memory still arrives as that memory. Both shapes are
	 * normalised into `DrawNode` here, because everything below this — sizing,
	 * colouring, emphasis, hover — is the same work either way.
	 *
	 * ── Why it looks the way it does ──────────────────────────────────────────
	 * Quiet at rest, informative on contact. Small nodes and hairline edges, so the
	 * structure is carried by the arrangement rather than by the ink; unfocused
	 * nodes dim but stay visible rather than vanishing; and NOTHING is labelled
	 * until it is pointed at, at either resolution. Captions were tried for the
	 * merged marks on the theory that a crowd needs naming, and they reproduced the
	 * same overlapping text layer over a picture whose entire value is its shape.
	 */
	import { onDestroy, onMount } from 'svelte';
	import Sigma from 'sigma';
	import Graph from 'graphology';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import { debug } from '$shared/utils/logger';
	import type { IconName } from '$shared/types/ui/icons';
	import type { GraphView } from '$shared/types/memory';

	interface Props {
		/** Currently inspected node — highlighted and always labelled. */
		selectedId: string | null;
		/** Ids matching the active search; everything else recedes. */
		highlightIds?: string[];
		/**
		 * Pixels at the bottom of this component covered by something else — the
		 * inspector sheet on a phone.
		 *
		 * The canvas SHRINKS by this much rather than the camera compensating for it.
		 * Sigma centres, fits and zooms relative to its own container, so telling it
		 * the truth about how big that container is fixes every one of those at once;
		 * offsetting the camera afterwards would fix `focusNode` and leave `Fit` and
		 * the zoom controls still aiming at a point behind the sheet.
		 */
		bottomInset?: number;
		onSelect: (nodeId: string | null) => void;
	}

	const { selectedId, highlightIds = [], bottomInset = 0, onSelect }: Props = $props();

	/**
	 * One shape for both resolutions.
	 *
	 * A bin and a memory differ in what they MEAN, which is why the wire format
	 * keeps them apart, but they are drawn by the same code — so they are unified
	 * once, here, instead of every sizing and colouring function branching.
	 */
	interface DrawNode {
		id: string;
		label: string;
		community: number;
		/** Connections for a memory, members for a bin; both drive size. */
		magnitude: number;
		kind: 'episodic' | 'structural' | 'bin';
		/** From the persisted arrangement. Absent means "not placed yet". */
		x?: number;
		y?: number;
	}

	interface DrawEdge {
		source: string;
		target: string;
		weight: number;
	}

	interface Scene {
		level: 'flat' | 'binned';
		nodes: DrawNode[];
		edges: DrawEdge[];
	}

	let container: HTMLDivElement | null = null;
	let sigma: Sigma | null = null;
	let graph: Graph | null = null;
	let worker: Worker | null = null;

	// ── Plain state: read by reducers, never reactive (see the note above) ──
	let focusId: string | null = null;
	let hoverId: string | null = null;
	let highlight = new Set<string>();
	let isDark = false;
	let workerNodeIds: string[] = [];
	let renderedSignature = '';
	/** The arrangement currently drawn, tracked apart from the structure. */
	let renderedLayout = '';
	let framed = false;

	/**
	 * The drawn id lists, cached rather than re-derived per frame.
	 *
	 * The emphasis animation repaints on every frame and has to tell sigma WHICH
	 * elements to reprocess — see `repaintDrawn`. Asking graphology for them each
	 * time allocated two arrays of up to three thousand strings per frame for a
	 * list that only changes when the graph does.
	 */
	let drawnNodeIds: string[] = [];
	let drawnEdgeIds: string[] = [];

	/** Where the layout wants each node, as opposed to where it is drawn now. */
	const targets = new Map<string, { x: number; y: number }>();
	let tweenFrame: number | null = null;

	/**
	 * Above this many nodes the tween is skipped and positions are applied
	 * directly. Interpolating every node every frame is what makes the graph feel
	 * alive at normal sizes and what would make it crawl on a low-powered machine
	 * at large ones.
	 */
	const MAX_TWEENED_NODES = 1_200;
	/** Fraction of the remaining distance covered per frame — a soft ease-out. */
	const TWEEN_EASE = 0.16;

	/**
	 * Emphasis, animated rather than switched.
	 *
	 * Reducers are pure and run per frame, so the only way to animate focus is to
	 * animate the NUMBER they read. `emphasis` rises toward 1 while something is
	 * focused and falls back to 0 when nothing is, and every size and colour that
	 * responds to focus is interpolated by it. Without this, hovering snapped the
	 * whole canvas between two states — correct, and lifeless.
	 */
	let emphasis = 0;
	let emphasisTarget = 0;
	let emphasisFrame: number | null = null;
	const EMPHASIS_EASE = 0.22;

	/** Per-node emphasis, so a newly focused node grows while the previous shrinks. */
	const nodeEmphasis = new Map<string, number>();

	/**
	 * The entrance, 0 to 1 — nodes growing in, then the edges drawing between them.
	 *
	 * ── Why it animates SIZE and not position ────────────────────────────────
	 * The obvious entrance is the one this view used to have by accident: nodes
	 * drifting from a seed to where they belong. Two things rule it out now.
	 *
	 * Sigma renders with `autoRescale`, which normalises positions to their
	 * bounding box before drawing — so a uniform move toward the final layout is
	 * partly cancelled by the rescale, and a non-uniform one makes the whole graph
	 * breathe as its extent changes underneath the animation. And `x`/`y` are the
	 * attributes sigma treats as layout-impacting, so every frame of a positional
	 * animation forces it to reprocess the scene: rebuild the extent, the
	 * normalization and the program indexation for every element. That is the
	 * expensive shape this whole change exists to stop paying.
	 *
	 * `size` is neither. It is not in sigma's layout-impacting set, so the frames
	 * go through the same partial repaint that hovering already uses — the cost is
	 * one reducer pass over what is drawn, which is bounded by the render budget
	 * by construction. And a graph assembling itself out of nothing reads as the
	 * data arriving, which is what is actually happening.
	 */
	let reveal = 1;
	let revealFrames = 0;

	/**
	 * Frames the entrance runs for — roughly 600 ms, and deliberately counted in
	 * FRAMES rather than milliseconds. A machine that cannot keep 60 fps here is
	 * exactly the one where a wall-clock animation would skip most of itself and
	 * arrive as a flash; counting frames lets it play out slightly slower instead
	 * of not playing at all.
	 */
	const REVEAL_FRAMES = 36;
	/** Of the whole entrance, how much is spent staggering rather than growing. */
	const REVEAL_STAGGER = 0.55;
	/** Where in the entrance the edges start drawing in behind the nodes. */
	const EDGE_REVEAL_START = 0.35;

	/**
	 * Longest label the hover pill will show; the full text lives in the inspector.
	 *
	 * Roomier than it was, because this is no longer drawn on the canvas at rest —
	 * one pill under the cursor can afford a whole clause where a hundred competing
	 * labels could not.
	 */
	const LABEL_MAX = 60;

	/** Clear air between two marks, so they read as separate rather than tangent. */
	const MARK_GAP = 3;

	/**
	 * A community's colour, generated rather than picked from a list.
	 *
	 * A fixed palette of eight was wrong in a way that undermined the whole point
	 * of colouring by community: the ninth lobe wrapped around to the first, so two
	 * groups with nothing in common were drawn identically and the colour stopped
	 * meaning "these belong together". Real graphs produce well over eight
	 * communities.
	 *
	 * The golden angle (137.5°) is the standard trick for this — successive hues
	 * land as far from every previous one as possible, so even neighbouring indices
	 * are clearly distinct, and it does not repeat until far more communities than
	 * this view can render at once. Saturation and lightness are fixed per theme
	 * (hues that read on dark slate turn muddy on white), and the hue is quantized
	 * so a community keeps exactly the same colour between renders.
	 */
	const GOLDEN_ANGLE = 137.508;

	/**
	 * HSL to hex, because sigma cannot read HSL.
	 *
	 * Its WebGL programs need a numeric colour, and its parser understands hex and
	 * `rgb()/rgba()` only — an `hsl()` string is not rejected, it silently parses to
	 * zero, which is black. That is a whole graph of black dots with nothing in the
	 * console to explain it, so the conversion happens here rather than trusting the
	 * renderer to cope.
	 */
	function hslToHex(h: number, s: number, l: number): string {
		const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
		const channel = (n: number): string => {
			const k = (n + h / 30) % 12;
			const value = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
			return Math.round(255 * value)
				.toString(16)
				.padStart(2, '0');
		};
		return `#${channel(0)}${channel(8)}${channel(4)}`;
	}

	/**
	 * The two themes want opposite things from lightness, and both were previously
	 * pulled toward the middle.
	 *
	 * On DARK the hues sat at 70–78% lightness, which is pastel — near-white tints
	 * that glowed against the slate and washed the hue itself out, so the palette
	 * read as "pale" before it read as "green" or "blue". Pulling them down to
	 * 58–66% lets the colour carry, and it still clears the background by a mile.
	 *
	 * On LIGHT the problem was saturation, not lightness: 58% on a white field is
	 * closer to grey than to a colour, and once the nodes shrank there was too
	 * little ink left for a muted hue to survive. Higher saturation with a slightly
	 * lighter body reads as vivid without going neon.
	 */
	function communityColor(community: number, dark: boolean): string {
		// A community index is never negative in practice, but a modulo of one would
		// be — and a negative hue silently parses to black.
		const index = Math.abs(community);
		const hue = Math.round((index * GOLDEN_ANGLE) % 360);
		// Two alternating lightness bands, so that even if two hues ever landed
		// close together they would still separate by brightness.
		const band = index % 2;
		return dark ? hslToHex(hue, 72, band ? 58 : 66) : hslToHex(hue, 78, band ? 44 : 52);
	}

	/**
	 * The neutrals, which have to move with the hues rather than against them.
	 *
	 * `dim` in particular: it is the colour everything receding is mixed TOWARD, so
	 * it decides how strongly a search or a hover can filter. On dark it used to be
	 * lighter than several of the surfaces around it, which meant "dimmed" landed
	 * roughly where the undimmed hues now sit and the distinction stopped reading.
	 * Both themes push it further from the ink and closer to the background.
	 */
	const THEME = {
		light: {
			structural: '#8b9bb0',
			edge: '#dbe2ea',
			edgeCross: '#c3ccd8',
			edgeFocus: '#7c8ba1',
			dim: '#e6ebf1',
			hoverBg: '#ffffff',
			hoverBorder: '#e2e8f0',
			hoverText: '#0f172a'
		},
		dark: {
			structural: '#4e5d75',
			edge: '#1b2740',
			edgeCross: '#33415c',
			edgeFocus: '#7c8ba1',
			dim: '#1c2740',
			hoverBg: '#1e293b',
			hoverBorder: '#334155',
			hoverText: '#f1f5f9'
		}
	};

	const palette = () => (isDark ? THEME.dark : THEME.light);

	const view = $derived(memoryGraphStore.view);

	/**
	 * Flatten whichever resolution arrived into one drawable set.
	 *
	 * Kept a plain function rather than a `$derived` because the build effect is
	 * the only caller and it is keyed on the store's signature — deriving it would
	 * add a second reactive path to the same data with no second reader.
	 */
	function sceneOf(current: GraphView): Scene {
		// Both arrays, always, and in that order. A binned view is not an
		// alternative to a flat one — it IS the flat one everywhere the grid did not
		// have to merge, so the memories and the crowded marks are drawn together as
		// one picture rather than the client choosing between two.
		const nodes: DrawNode[] = current.nodes.map(node => ({
			id: node.id,
			label: node.label,
			community: node.community,
			magnitude: node.degree,
			kind: node.kind,
			...(node.x !== undefined && { x: node.x }),
			...(node.y !== undefined && { y: node.y })
		}));

		for (const bin of current.bins) {
			nodes.push({
				id: bin.id,
				label: bin.label,
				community: bin.community,
				magnitude: bin.members,
				kind: 'bin',
				x: bin.x,
				y: bin.y
			});
		}

		const edges: DrawEdge[] = current.edges.map(edge => ({
			source: edge.source,
			target: edge.target,
			weight: edge.weight
		}));

		for (const edge of current.binEdges) {
			edges.push({ source: edge.source, target: edge.target, weight: edge.weight });
		}

		return { level: current.level, nodes, edges };
	}

	function truncate(label: string): string {
		return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
	}

	function nodeColor(node: DrawNode): string {
		// Structural nodes stay neutral on purpose. They are scaffolding — the files
		// and symbols memories hang off — and giving them community hues too would
		// make the coloured lobes read as one undifferentiated field.
		if (node.kind === 'structural') return palette().structural;
		return communityColor(node.community, isDark);
	}

	/** Lookup and scales for node/edge styling, rebuilt whenever the scene is. */
	let nodeById = new Map<string, DrawNode>();
	let magnitudeScale = 1;
	/** Whether anything in the current scene stands for more than one memory. */
	let hasBins = false;

	/**
	 * How much a merged mark is shrunk so the map's ink fits its canvas.
	 *
	 * Relaxation can only separate marks that CAN be separated. Measured on a
	 * crowded map, pushing apart 241 large marks in a 600×400 canvas
	 * never converges — not because the solver is weak but because the circles do
	 * not fit, and a solver asked to fit them just oscillates. One scale factor
	 * over every mark keeps the RATIOS, which is what carries meaning here, and
	 * gives the relaxation a problem with an answer.
	 */
	let binScale = 1;

	/** Fraction of the canvas the marks may cover before they are scaled down. */
	const MAX_INK_COVERAGE = 0.2;

	/** Refresh what the styling functions read. Call before building a graph. */
	function indexScene(scene: Scene): void {
		nodeById = new Map(scene.nodes.map(node => [node.id, node]));
		magnitudeScale = scaleMagnitude(scene.nodes);
		hasBins = scene.nodes.some(node => node.kind === 'bin');
		binScale = hasBins ? inkScaleFor(scene) : 1;
	}

	/** One factor for every mark, from the room they would otherwise need. */
	function inkScaleFor(scene: Scene): number {
		if (!sigma) return 1;
		const { width, height } = sigma.getDimensions();
		const room = width * height * MAX_INK_COVERAGE;
		if (!Number.isFinite(room) || room <= 0) return 1;

		// Computed against the UNSCALED sizes, so the factor is derived from the
		// scene rather than from the last factor applied to it.
		const ink = scene.nodes.reduce((total, node) => {
			if (node.kind !== 'bin') return total;
			const radius = baseBinSize(node) + MARK_GAP;
			return total + Math.PI * radius * radius;
		}, 0);

		return ink > room ? Math.sqrt(room / ink) : 1;
	}

	/**
	 * The magnitude that counts as "fully connected" for sizing purposes.
	 *
	 * Normalising against the true maximum let one outlier flatten the whole view:
	 * a single hub with a hundred edges pushes every ordinary node's share below
	 * 0.05, so everything else renders at the floor and the only thing the sizes
	 * say is "there is one big node here". The 95th percentile is the busiest node
	 * that is not an outlier; anything beyond it simply clamps at the top of the
	 * range, which is the correct reading — past a point, more connected is more
	 * connected and the exact count stops mattering.
	 */
	function scaleMagnitude(nodes: DrawNode[]): number {
		if (nodes.length === 0) return 1;
		const sorted = nodes.map(node => node.magnitude).sort((a, b) => a - b);
		const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
		return Math.max(1, sorted[index]);
	}

	/**
	 * Node radius, in screen pixels, normalised across the view.
	 *
	 * Two things are being balanced here, and the earlier 4–22px range got both
	 * wrong. Sigma auto-rescales positions into the container, so the ABSOLUTE
	 * spread of the layout is invisible — the only thing that decides whether a
	 * graph reads as a constellation or as a set of clouds is the ratio between a
	 * node's pixel radius and the normalised distance to its neighbours. A 22px
	 * radius is roughly 4% of the canvas width for a single dot, so lobes merged
	 * into blobs before the layout ever got a say.
	 *
	 * The exponent is the second half. At 0.6 the curve was so flat that a degree-1
	 * leaf already sat near 6px and a degree-5 node near 9px — most of the graph was
	 * large, and "large" therefore meant nothing. At 0.85 the floor stays populated
	 * and only genuine hubs climb, which is what makes the skeleton visible.
	 *
	 * A merged mark is sized on a different scale entirely, because it stands in
	 * for a crowd rather than for one memory, and how big that crowd is is the one
	 * fact a
	 * merged mark exists to convey.
	 */
	function nodeSize(node: DrawNode): number {
		// Scaled HERE rather than after the fact, so a repaint — a theme flip, a
		// live update — recomputes the same size the layout was spread for. Applied
		// as a post-multiplier it would have been silently undone by the first
		// repaint, and the marks would drift back into each other.
		if (node.kind === 'bin') return Math.max(3, baseBinSize(node) * binScale);

		const share = magnitudeScale <= 1 ? 0 : Math.min(1, node.magnitude / magnitudeScale);
		const min = node.kind === 'structural' ? 1.5 : 2;
		const max = node.kind === 'structural' ? 6 : 9;
		return min + (max - min) * Math.pow(share, 0.85);
	}

	/** A mark's size before the ink scale — the size its membership asks for. */
	function baseBinSize(node: DrawNode): number {
		const share = magnitudeScale <= 1 ? 0 : Math.min(1, node.magnitude / magnitudeScale);
		return 8 + 22 * Math.pow(share, 0.6);
	}

	/**
	 * Edge colour, taken from the community it sits inside rather than one flat
	 * slate for the whole graph.
	 *
	 * With a single colour, the only thing an edge can say is that a connection
	 * exists — so a dense graph reads as a grey haze with coloured dots on top,
	 * and working out which lobe a line belongs to means tracing it. Inheriting
	 * the community's hue makes a lobe's internal structure legible at a glance
	 * and leaves the lines BETWEEN lobes visible as the exceptions they are.
	 */
	function edgeColor(sourceId: string, targetId: string): string {
		const source = nodeById.get(sourceId);
		const target = nodeById.get(targetId);
		if (!source || !target) return palette().edge;
		// A cross-community edge belongs to neither, and painting it as one of them
		// would imply a membership it does not have.
		if (source.community !== target.community) return palette().edgeCross;
		if (source.kind === 'structural' && target.kind === 'structural') return palette().edge;
		// Two corrections pulling against each other. Hairlines mean far more edges
		// are legible at once, which wants LESS alpha; but the hues also came down in
		// lightness on dark, which wants more of it back before a 0.4px line over
		// slate disappears entirely.
		return withAlpha(communityColor(source.community, isDark), isDark ? 0.45 : 0.35);
	}

	/**
	 * Edge width, from how connected its busier end is.
	 *
	 * A constant 0.7 meant a spoke off a forty-edge hub looked exactly like the
	 * single link a leaf has. Thicker toward the hubs is what makes the skeleton
	 * of a large graph readable before anything is hovered.
	 *
	 * The range is hairline on purpose, and it only became reachable once
	 * `minEdgeThickness` was lowered in the sigma settings: that floor defaults to
	 * 1.7px, which was silently clamping almost this entire scale up to one value.
	 * Every edge in the graph rendered at the same weight, and the width carried no
	 * information at all despite being computed.
	 */
	function edgeSize(sourceId: string, targetId: string): number {
		const magnitude = Math.max(
			nodeById.get(sourceId)?.magnitude ?? 1,
			nodeById.get(targetId)?.magnitude ?? 1
		);
		const share = magnitudeScale <= 1 ? 0 : Math.min(1, magnitude / magnitudeScale);
		const width = 0.25 + 0.95 * Math.pow(share, 0.7);
		// A line into a crowded mark stands for many, so it can afford to be seen.
		const merged = nodeById.get(sourceId)?.kind === 'bin' || nodeById.get(targetId)?.kind === 'bin';
		return merged ? width * 2.2 : width;
	}

	/** Hex with an alpha channel — the only transparent form sigma's parser reads. */
	function withAlpha(hex: string, alpha: number): string {
		const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
			.toString(16)
			.padStart(2, '0');
		return `${hex}${value}`;
	}

	/** FNV-1a — cheap, well-distributed, and short enough to read. */
	function hashOf(id: string): number {
		let hash = 2166136261;
		for (let i = 0; i < id.length; i++) {
			hash ^= id.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}
		return hash >>> 0;
	}

	/**
	 * Where a node starts when the server has no position for it.
	 *
	 * This used to mirror the backend's community-region seeding — the same spiral,
	 * the same sizing, reimplemented here. Two copies of an arrangement is one too
	 * many: they drifted apart, and the shape a node was given here was one the
	 * background pass would immediately overrule anyway.
	 *
	 * So the client no longer has an opinion about the macro arrangement. A node
	 * with no position gets dropped near the middle of whatever IS drawn, and
	 * either the short local settle or the next background pass puts it where it
	 * belongs — and in practice it almost never runs, because the server derives a
	 * position for an arrival from whatever it connects to before sending it (see
	 * `placeArrivals`).
	 */
	function seedPosition(node: DrawNode, centre: { x: number; y: number; spread: number }): { x: number; y: number } {
		const hash = hashOf(node.id);
		const jitterX = ((hash % 65536) / 65536 - 0.5) * 2;
		const jitterY = (((hash >>> 16) % 65536) / 65536 - 0.5) * 2;

		return {
			x: centre.x + jitterX * centre.spread,
			y: centre.y + jitterY * centre.spread
		};
	}

	/**
	 * The middle of what is already placed, and how far it reaches.
	 *
	 * Derived from the nodes the server DID place, so an arrival lands inside the
	 * picture rather than at an origin the arrangement may be nowhere near — the
	 * layout is no longer centred on (0, 0) now that components are packed.
	 */
	function drawnCentre(scene: Scene): { x: number; y: number; spread: number } {
		let sumX = 0;
		let sumY = 0;
		let count = 0;
		for (const node of scene.nodes) {
			if (node.x === undefined || node.y === undefined) continue;
			sumX += node.x;
			sumY += node.y;
			count++;
		}
		if (count === 0) return { x: 0, y: 0, spread: 300 };

		const x = sumX / count;
		const y = sumY / count;

		let furthest = 0;
		for (const node of scene.nodes) {
			if (node.x === undefined || node.y === undefined) continue;
			furthest = Math.max(furthest, Math.hypot(node.x - x, node.y - y));
		}
		// A fraction of the reach, so an unplaced node lands in the picture rather
		// than out on its rim where it would read as a component of its own.
		return { x, y, spread: Math.max(40, furthest * 0.25) };
	}

	function buildGraph(scene: Scene): void {
		if (!sigma) return;

		graph = new Graph({ type: 'undirected', multi: false });

		indexScene(scene);
		const centre = drawnCentre(scene);
		let unplaced = 0;

		for (const node of scene.nodes) {
			const placed = node.x !== undefined && node.y !== undefined;
			if (!placed) unplaced++;
			const seed = placed ? { x: node.x as number, y: node.y as number } : seedPosition(node, centre);
			graph.addNode(node.id, {
				x: seed.x,
				y: seed.y,
				size: nodeSize(node),
				label: truncate(node.label),
				color: nodeColor(node),
				kind: node.kind,
				// Overwritten by `assignRevealDelays` once every position is known.
				delay: 0
			});
		}

		for (const edge of scene.edges) {
			if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
			if (edge.source === edge.target) continue;
			if (graph.hasEdge(edge.source, edge.target)) continue;
			graph.addUndirectedEdge(edge.source, edge.target, {
				size: edgeSize(edge.source, edge.target),
				color: edgeColor(edge.source, edge.target)
			});
		}

		// A merged mark is drawn far larger than the dots it replaced, so it spills
		// over its neighbours — the centroid says where its memories are, not how
		// much room the mark standing for them needs.
		if (hasBins) spreadMarks(graph);

		assignRevealDelays(graph);

		// BEFORE `setGraph`, which renders synchronously. Armed afterwards, that
		// render would draw the finished graph for one frame and the entrance would
		// begin by shrinking it away again.
		//
		// A fresh picture gets an entrance; incremental updates deliberately do not.
		// Replaying it every time a conversation records a memory would make the
		// graph flinch at somebody who is reading it.
		startReveal();

		sigma.setGraph(graph);
		cacheDrawnIds();
		framed = false;

		// The simulation here is a COLD FALLBACK and nothing more: it runs only when
		// the server has placed nothing at all — a fresh install, or the first fetch
		// after the arrangement was dropped.
		//
		// It must never run otherwise, and that is not an optimisation. This worker
		// lays out the WHOLE scene with a single global gravity, which is exactly
		// the isotropic pull that puts every disconnected component at one radius —
		// the circle the backend arrangement exists to avoid. Running it because a
		// handful of newly recorded memories had no position yet threw away the
		// packed arrangement for all of them and drew a disc again.
		if (unplaced < scene.nodes.length) {
			stopLayout();
			framed = true;
			sigma.getCamera().animatedReset({ duration: 300 });
			return;
		}

		startLayout(scene);
	}

	/**
	 * Push overlapping marks apart, without losing where they came from.
	 *
	 * A merged mark is placed at the centroid of the memories it stands for, which
	 * answers "where are they" and says nothing about how much room the mark needs
	 * — and it is drawn far larger than the dots it replaced, because the size of
	 * the crowd is the point. In a dense middle those marks spill over each other
	 * and over the individual memories around them.
	 *
	 * Relaxation rather than a fresh layout: the centroids carry real information
	 * about which lobes sit near which, and re-solving would throw that away to
	 * fix a spacing problem. This only separates what collides and leaves
	 * everything else where the arrangement put it.
	 *
	 * ── Units, which are the whole difficulty ────────────────────────────────
	 * Sizes are SCREEN pixels and positions are graph space, and sigma rescales
	 * one into the other at render time — so "these two circles overlap" cannot be
	 * tested without knowing the mapping. It is recovered here from the extent of
	 * the marks against the container: the graph is fitted to the viewport, so one
	 * pixel is `span / viewport` in graph units.
	 */
	function spreadMarks(target: Graph): void {
		const order = target.order;
		if (!sigma || order < 2) return;

		const { width, height } = sigma.getDimensions();
		const viewport = Math.min(width, height);
		if (!Number.isFinite(viewport) || viewport <= 0) return;

		const ids = target.nodes();
		const xs = new Float64Array(order);
		const ys = new Float64Array(order);
		const radii = new Float64Array(order);

		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (let i = 0; i < order; i++) {
			const attributes = target.getNodeAttributes(ids[i]) as { x: number; y: number; size: number };
			xs[i] = attributes.x;
			ys[i] = attributes.y;
			minX = Math.min(minX, xs[i]);
			maxX = Math.max(maxX, xs[i]);
			minY = Math.min(minY, ys[i]);
			maxY = Math.max(maxY, ys[i]);
		}

		const span = Math.max(maxX - minX, maxY - minY);
		if (!Number.isFinite(span) || span <= 0) return;
		const perPixel = span / viewport;

		for (let i = 0; i < order; i++) {
			const size = target.getNodeAttribute(ids[i], 'size') as number;
			radii[i] = (size + MARK_GAP) * perPixel;
		}

		// Enough to resolve a crowded ring, few enough to stay imperceptible. The
		// pass is O(n²) and `n` is the community count, which the server caps —
		// measured at 28 ms for 241 marks, and it exits early the moment nothing
		// collides (8 passes for the ~100-lobe case this was reported on).
		const PASSES = 240;
		for (let pass = 0; pass < PASSES; pass++) {
			// Over-relaxed at first and settling toward an exact correction. Pushing
			// by exactly half the overlap converges very slowly in a crowd, because
			// every separation nudges both marks into their other neighbours;
			// overshooting early clears the crowd faster, and easing off stops it
			// oscillating once the arrangement is nearly right. Measured, the fixed
			// exact push left more overlaps after 900 passes than this does after 240.
			const relax = 1.4 - 0.4 * (pass / PASSES);
			let collided = false;

			for (let i = 0; i < order; i++) {
				for (let j = i + 1; j < order; j++) {
					const minimum = radii[i] + radii[j];
					let dx = xs[j] - xs[i];
					let dy = ys[j] - ys[i];

					// Compared squared first: the square root is the expensive part and
					// most pairs in a spread-out map are nowhere near touching.
					const squared = dx * dx + dy * dy;
					if (squared >= minimum * minimum) continue;
					let distance = Math.sqrt(squared);

					// Exactly coincident — two lobes whose members averaged to the same
					// point. Deterministic from the ids, so a reload separates them the
					// same way rather than picking a new direction each time.
					if (distance < 1e-9) {
						const angle = (hashOf(ids[i] + ids[j]) % 3600) / 3600 * Math.PI * 2;
						dx = Math.cos(angle);
						dy = Math.sin(angle);
						distance = 1;
					}

					const push = (relax * (minimum - distance)) / 2 / distance;
					xs[i] -= dx * push;
					ys[i] -= dy * push;
					xs[j] += dx * push;
					ys[j] += dy * push;
					collided = true;
				}
			}

			if (!collided) break;
		}

		for (let i = 0; i < order; i++) {
			target.setNodeAttribute(ids[i], 'x', xs[i]);
			target.setNodeAttribute(ids[i], 'y', ys[i]);
		}
	}

	/**
	 * Give every node the moment it should appear, as a node attribute.
	 *
	 * Radial from the centre of the arrangement, so the graph opens outward rather
	 * than all at once — which is both nicer to watch and more informative, since
	 * what emerges first is the dense middle the layout put there.
	 *
	 * Stored on the node instead of recomputed per frame because it never changes:
	 * the reducer runs for every element on every frame of the entrance, and a
	 * square root in there is a square root sixty times a second times the render
	 * budget. `repaint` never touches it — its update hints name only the three
	 * attributes it does write — so it survives a theme flip and a live update.
	 */
	function assignRevealDelays(target: Graph): void {
		const order = target.order;
		if (order === 0) return;

		let sumX = 0;
		let sumY = 0;
		target.forEachNode((_id, attributes) => {
			sumX += attributes.x as number;
			sumY += attributes.y as number;
		});
		const centreX = sumX / order;
		const centreY = sumY / order;

		let furthest = 0;
		const distances = new Map<string, number>();
		target.forEachNode((id, attributes) => {
			const dx = (attributes.x as number) - centreX;
			const dy = (attributes.y as number) - centreY;
			const distance = Math.sqrt(dx * dx + dy * dy);
			distances.set(id, distance);
			if (distance > furthest) furthest = distance;
		});

		target.updateEachNodeAttributes(
			(id, attributes) => ({
				...attributes,
				delay: furthest > 0 ? ((distances.get(id) ?? 0) / furthest) * REVEAL_STAGGER : 0
			}),
			{ attributes: ['delay'] }
		);
	}

	/** How far into its own growth a node is, given the entrance's progress. */
	function revealOf(delay: number): number {
		if (reveal >= 1) return 1;
		const span = Math.max(0.001, 1 - REVEAL_STAGGER);
		const progress = Math.min(1, Math.max(0, (reveal - delay) / span));
		// Ease-out cubic: quick to appear, gentle to settle. A linear grow reads as
		// mechanical at this duration.
		return 1 - Math.pow(1 - progress, 3);
	}

	/** Play the entrance from the beginning. */
	function startReveal(): void {
		reveal = 0;
		revealFrames = 0;
		startAnimation();
	}

	/** Remember what is drawn, so per-frame repaints do not re-derive it. */
	function cacheDrawnIds(): void {
		drawnNodeIds = graph ? graph.nodes() : [];
		drawnEdgeIds = graph ? graph.edges() : [];
	}

	function startLayout(scene: Scene, options?: { iterations?: number }): void {
		stopLayout();
		if (scene.nodes.length === 0) return;

		worker = new Worker(new URL('$frontend/services/memory/graph-layout.worker.ts', import.meta.url), {
			type: 'module'
		});

		// No progress is reported to the user. The layout IS the loading state — nodes
		// visibly drift into place — so a percentage on top of it was narrating
		// something already on screen, and it flashed on every incremental re-heat.
		worker.onmessage = (event: MessageEvent) => {
			const message = event.data as
				| { type: 'order'; ids: string[] }
				| { type: 'positions'; coords: Float32Array }
				| { type: 'done' };

			if (message.type === 'order') {
				workerNodeIds = message.ids;
				return;
			}
			if (message.type === 'positions') {
				applyPositions(message.coords);
				return;
			}
			if (message.type === 'done') {
				// Framed once per dataset. Refitting on every settle is what made the
				// view snap back whenever anything else changed — and now that the
				// graph updates live while the modal is open, that would happen every
				// time a conversation recorded something.
				if (!framed) {
					framed = true;
					sigma?.getCamera().animatedReset({ duration: 300 });
				}
				// Positions have stopped moving, so rebuild the indices the tween was
				// allowed to skip — hit detection reads them.
				sigma?.refresh();
			}
		};

		indexScene(scene);
		const centre = drawnCentre(scene);

		// Refining what the server already arranged rather than discovering it, so
		// these buy convergence instead of merely progress.
		const iterations =
			options?.iterations ??
			(scene.nodes.length > 1200 ? 260 : scene.nodes.length > 400 ? 500 : 900);

		worker.postMessage({
			type: 'start',
			nodes: scene.nodes.map(node => {
				// Positions already on screen are kept, so a graph that gains a few
				// nodes re-heats from where it is instead of being thrown back to its
				// seed and re-settling into a different pose.
				const existing = graph?.hasNode(node.id)
					? (graph.getNodeAttributes(node.id) as { x: number; y: number })
					: null;
				const seed = existing ?? seedPosition(node, centre);
				return { id: node.id, x: seed.x, y: seed.y, degree: node.magnitude };
			}),
			edges: scene.edges.map(edge => ({
				source: edge.source,
				target: edge.target,
				weight: edge.weight
			})),
			iterations
		});
	}

	/**
	 * Fold a batch of worker positions into the drawn graph.
	 *
	 * Written as ONE `updateEachNodeAttributes` rather than two
	 * `setNodeAttribute` calls per node, and the difference is not stylistic: sigma
	 * subscribes to graphology's per-attribute events, so the old form fired two
	 * events per node per batch and sigma answered each one by re-running its node
	 * reducer and marking the whole scene for reprocessing. At a thousand nodes
	 * that is two thousand reducer invocations to move a thousand dots. The bulk
	 * form emits a single event carrying which attributes changed.
	 */
	function applyPositions(coords: Float32Array): void {
		if (!graph) return;

		const tween = graph.order <= MAX_TWEENED_NODES;
		const incoming = new Map<string, { x: number; y: number }>();
		for (let i = 0; i < workerNodeIds.length; i++) {
			const id = workerNodeIds[i];
			if (!graph.hasNode(id)) continue;
			incoming.set(id, { x: coords[i * 2], y: coords[i * 2 + 1] });
		}

		if (tween) {
			for (const [id, position] of incoming) targets.set(id, position);
			startTween();
			return;
		}

		graph.updateEachNodeAttributes(
			(id, attributes) => {
				const position = incoming.get(id);
				return position ? { ...attributes, x: position.x, y: position.y } : attributes;
			},
			{ attributes: ['x', 'y'] }
		);
	}

	/**
	 * Ease every node toward its target position, one frame at a time.
	 *
	 * The worker emits a settled batch every dozen iterations, and applying those
	 * directly made the graph jump between poses. Interpolating turns the same
	 * data into motion, which is also what makes the layout legible — you can see
	 * clusters pulling apart instead of just arriving.
	 */
	function startTween(): void {
		if (tweenFrame !== null) return;

		const step = (): void => {
			tweenFrame = null;
			if (!graph || !sigma) return;

			let moving = false;
			graph.updateEachNodeAttributes(
				(id, attributes) => {
					const target = targets.get(id);
					if (!target) return attributes;

					const x = attributes.x as number;
					const y = attributes.y as number;
					const dx = target.x - x;
					const dy = target.y - y;

					// Snap once the remaining distance stops being visible, so the loop
					// terminates instead of chasing an asymptote forever.
					if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
						return { ...attributes, x: target.x, y: target.y };
					}

					moving = true;
					return { ...attributes, x: x + dx * TWEEN_EASE, y: y + dy * TWEEN_EASE };
				},
				{ attributes: ['x', 'y'] }
			);

			if (moving) tweenFrame = requestAnimationFrame(step);
			// The final frame leaves the indices stale — positions moved with
			// indexation skipped — so hit detection is restored once, at the end,
			// rather than rebuilt on every frame of the animation.
			else sigma.refresh();
		};

		tweenFrame = requestAnimationFrame(step);
	}

	function stopTween(): void {
		if (tweenFrame !== null) cancelAnimationFrame(tweenFrame);
		tweenFrame = null;
		targets.clear();
	}

	/**
	 * Redraw what is already on screen, without touching the graph.
	 *
	 * This is what the emphasis animation runs on every frame, and it is where the
	 * single most expensive mistake in this component lived: it used to call
	 * `sigma.refresh({ skipIndexation: true })`. That flag only applies to a
	 * PARTIAL refresh — with no `partialGraph`, sigma takes the full path, which
	 * clears every node and edge index and rebuilds them from scratch. Hovering a
	 * node therefore re-indexed the entire graph sixty times a second, and the flag
	 * that was supposed to prevent exactly that was being ignored because the call
	 * never named what it wanted refreshed.
	 */
	function repaintDrawn(): void {
		if (!sigma) return;
		guardRepaint(() =>
			sigma!.refresh({
				partialGraph: { nodes: drawnNodeIds, edges: drawnEdgeIds },
				skipIndexation: true
			})
		);
	}

	/**
	 * The one animation loop: the entrance, and the emphasis that follows focus.
	 *
	 * Deliberately ONE. Both animate numbers the reducers read and both finish by
	 * repainting everything drawn, so as two `requestAnimationFrame` loops they
	 * would each repaint the same scene in the same frame — twice the cost for one
	 * picture, and worst of all exactly while the graph is opening, which is when
	 * both are most likely to be running.
	 */
	function startAnimation(): void {
		if (emphasisFrame !== null) return;

		const step = (): void => {
			emphasisFrame = null;
			if (!sigma) return;

			let moving = false;

			if (reveal < 1) {
				revealFrames++;
				reveal = Math.min(1, revealFrames / REVEAL_FRAMES);
				moving = true;
			}

			const delta = emphasisTarget - emphasis;
			if (Math.abs(delta) > 0.005) {
				emphasis += delta * EMPHASIS_EASE;
				moving = true;
			} else {
				emphasis = emphasisTarget;
			}

			const anchor = anchorId();
			for (const [id, value] of nodeEmphasis) {
				const target = id === anchor ? 1 : 0;
				const remaining = target - value;
				if (Math.abs(remaining) > 0.005) {
					nodeEmphasis.set(id, value + remaining * EMPHASIS_EASE);
					moving = true;
				} else if (target === 0) {
					// Drop settled-at-zero entries so the map tracks only what is moving
					// or currently emphasised.
					nodeEmphasis.delete(id);
				} else {
					nodeEmphasis.set(id, target);
				}
			}
			if (anchor && !nodeEmphasis.has(anchor)) {
				nodeEmphasis.set(anchor, 0);
				moving = true;
			}

			repaintDrawn();
			if (moving) emphasisFrame = requestAnimationFrame(step);
		};

		emphasisFrame = requestAnimationFrame(step);
	}

	/**
	 * Blend two hex colours. Used to fade dimming in instead of applying it flat.
	 *
	 * The SOURCE's alpha is carried through, which it was not before, and the
	 * omission was visible. Edges are `#rrggbbaa`; this read the first six digits
	 * and returned six, so the moment `emphasis` crossed zero an edge jumped from
	 * translucent to fully opaque — a bright flash of the undimmed colour at the
	 * start of every fade, before the mix had moved far enough to darken it. It
	 * looked like the graph lighting up on its way to dimming.
	 */
	function mix(from: string, to: string, t: number): string {
		const alpha = from.length === 9 ? from.slice(7, 9) : '';
		if (t <= 0) return from;
		if (t >= 1) return `${to}${alpha}`;
		const parse = (hex: string): [number, number, number] => [
			parseInt(hex.slice(1, 3), 16),
			parseInt(hex.slice(3, 5), 16),
			parseInt(hex.slice(5, 7), 16)
		];
		const [r1, g1, b1] = parse(from);
		const [r2, g2, b2] = parse(to);
		const channel = (a: number, b: number) => Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
		return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}${alpha}`;
	}

	/**
	 * What the view is currently emphasising.
	 *
	 * Hover WINS over selection. Both are deliberate gestures, but hovering is
	 * transient and answering it immediately is the whole point — with selection
	 * taking precedence, pointing at a node did nothing at all whenever the
	 * inspector was open, which is most of the time while browsing search results.
	 * Leaving the node restores the selection, so nothing is lost.
	 */
	function anchorId(): string | null {
		return hoverId ?? focusId;
	}

	function setAnchor(): void {
		const anchor = anchorId();
		emphasisTarget = anchor || highlight.size > 0 ? 1 : 0;
		if (anchor && !nodeEmphasis.has(anchor)) nodeEmphasis.set(anchor, 0);
		startAnimation();
	}

	function stopLayout(): void {
		stopTween();
		stopLayoutWorker();
	}

	/**
	 * Stop the cold-fallback simulation, WITHOUT discarding the tween.
	 *
	 * Kept separate from `stopLayout` because the two answer different questions:
	 * one abandons the simulation, the other abandons where it was going too.
	 */
	function stopLayoutWorker(): void {
		if (!worker) return;
		worker.postMessage({ type: 'stop' });
		worker.terminate();
		worker = null;
		workerNodeIds = [];
	}

	/**
	 * Re-derive every appearance attribute in place — used on a theme flip and
	 * after an incremental update, never a rebuild. Positions are not touched.
	 *
	 * SIZES are recomputed, not just colours, because both scales are normalised
	 * against the view (see `scaleMagnitude`). A memory arriving with three edges
	 * changes what "well connected" means for everything already drawn, and
	 * leaving the old sizes in place meant the graph slowly drifted out of
	 * agreement with its own data between full rebuilds.
	 *
	 * LABELS are written here too, for the same reason sizes are: they are data,
	 * not decoration. Editing a memory's title left the old text attached to its
	 * node for the rest of the session, so the hover pill went on naming something
	 * the user had already renamed — the one place in this feature where an edit
	 * appeared not to have been saved.
	 *
	 * Both loops are BULK updates. Written as per-attribute setters they emitted
	 * three events per node and two per edge, each of which sigma answered by
	 * re-running a reducer — around twenty thousand of them for a graph this size,
	 * to change colours that a single pass could have carried.
	 */
	function repaint(scene: Scene): void {
		indexScene(scene);
		if (!graph || !sigma) return;

		// Guarded because of what a renderer invariant COSTS here, not because one
		// is expected. Sigma raises `can't be repaint` from inside the graphology
		// event this write emits — it fills its program index only on the frame
		// after a structural change — and a throw during render in Svelte 5 has no
		// boundary above it: it propagates out of the component tree and takes the
		// whole workspace down. A repaint is a frame; it is never worth a session.
		guardRepaint(() => {
			graph!.updateEachNodeAttributes(
				(id, attributes) => {
					const node = nodeById.get(id);
					if (!node) return attributes;
					return {
						...attributes,
						color: nodeColor(node),
						size: nodeSize(node),
						label: truncate(node.label)
					};
				},
				{ attributes: ['color', 'size', 'label'] }
			);

			graph!.updateEachEdgeAttributes(
				(id, attributes, source, target) => ({
					...attributes,
					color: edgeColor(source, target),
					size: edgeSize(source, target)
				}),
				{ attributes: ['color', 'size'] }
			);
		});
	}

	/**
	 * Run a repaint, and turn any renderer invariant it trips into a dropped frame.
	 *
	 * Every failure this can catch has the same remedy — sigma's view of the graph
	 * is behind the graph, and a full refresh rebuilds it — so the recovery is not
	 * a guess. What it buys is that the NEXT call shape nobody anticipated costs a
	 * frame instead of the workspace.
	 */
	function guardRepaint(paint: () => void): void {
		try {
			paint();
		} catch (error) {
			debug.warn('memory', 'Memory graph repaint fell back to a full refresh', error);
			sigma?.refresh();
		}
	}

	onMount(() => {
		if (!container) return;

		isDark = themeStore.isDark;

		sigma = new Sigma(new Graph(), container, {
			renderEdgeLabels: false,
			defaultEdgeType: 'line',
			minCameraRatio: 0.05,
			maxCameraRatio: 12,
			// No captions at rest, at EITHER resolution. Thinning them by size and by
			// grid cell was the earlier compromise and it still left text stacked over
			// itself wherever the graph was busy; drawing them only for the merged
			// marks looked reasonable in principle and, tried, produced the same
			// overlapping layer over a picture whose whole value is its shape. The
			// hover pill names one thing at a time, which is what naming is for here.
			renderLabels: false,
			/**
			 * Sigma clamps every edge up to this, and it defaults to 1.7px — which is
			 * thicker than the widest edge this view now asks for. Leaving it alone
			 * meant `edgeSize` was computed, passed in, and then thrown away.
			 */
			minEdgeThickness: 0.4,

			/**
			 * Sigma's stock hover renderer paints a hardcoded white box, which on a
			 * dark canvas is a bright bar across the graph. This one follows the
			 * theme and stays subtle.
			 */
			defaultDrawNodeHover: (context, data) => {
				const colors = palette();
				const label = typeof data.label === 'string' ? data.label : '';
				if (!label) return;

				context.font = '500 11px ui-sans-serif, system-ui, sans-serif';
				const width = context.measureText(label).width;
				const x = data.x + data.size + 6;
				const y = data.y + 4;

				context.fillStyle = colors.hoverBg;
				context.strokeStyle = colors.hoverBorder;
				context.lineWidth = 1;
				context.beginPath();
				context.roundRect(x - 5, y - 13, width + 10, 20, 6);
				context.fill();
				context.stroke();

				context.fillStyle = colors.hoverText;
				context.fillText(label, x, y);
			},

			// Reducers read ONLY plain variables. See the note at the top of the file.
			nodeReducer: (id, data) => {
				const result = { ...data } as Record<string, unknown>;
				const colors = palette();
				const anchor = anchorId();
				// `id` is checked as well as `anchor`, because sigma can render one
				// frame against a graph this component has already replaced — and
				// `areNeighbors` THROWS on an unknown key. See the edge reducer below,
				// where exactly that took the whole view down.
				const isAdjacent =
					!!anchor &&
					!!graph &&
					graph.hasNode(anchor) &&
					graph.hasNode(id) &&
					graph.areNeighbors(anchor, id);
				const isHit = highlight.has(id);
				const own = nodeEmphasis.get(id) ?? 0;

				// Growth follows this node's own emphasis, so the node being left
				// shrinks while the node being entered grows. The multiplier is larger
				// than it was because the nodes are smaller: 0.7 on a 22px hub was
				// obvious, 0.7 on a 2px leaf was not a gesture anyone could see.
				let size = data.size as number;
				if (own > 0) {
					size *= 1 + 1.2 * own;
					result.zIndex = 2;
				} else if (isHit) {
					result.zIndex = 1;
				}

				// The entrance multiplies whatever the emphasis decided, so a node
				// hovered mid-entrance grows from where it has got to rather than
				// snapping to full size and shrinking back.
				if (reveal < 1) size *= revealOf((data.delay as number) ?? 0);
				result.size = size;

				const recedes = (anchor && !isAdjacent && id !== anchor) || (!anchor && highlight.size > 0 && !isHit);
				if (recedes) result.color = mix(data.color as string, colors.dim, emphasis);
				return result;
			},

			edgeReducer: (id, data) => {
				const result = { ...data } as Record<string, unknown>;
				if (!graph) return result;

				// Edges draw in behind the nodes they connect, by receding from the
				// colour everything else recedes to rather than by thinning — sigma
				// clamps thin edges up to `minEdgeThickness`, so animating the width
				// toward zero would have stopped being visible almost immediately.
				if (reveal < 1) {
					const progress = Math.min(
						1,
						Math.max(0, (reveal - EDGE_REVEAL_START) / (1 - EDGE_REVEAL_START))
					);
					result.color = mix(data.color as string, palette().dim, 1 - progress);
					if (progress <= 0.001) return result;
				}

				if (emphasis <= 0.001) return result;

				// `extremities` throws rather than returning null, and sigma can call
				// this for an edge belonging to a graph this component has already
				// swapped out — any `setSetting` refreshes synchronously against
				// whichever graph sigma still holds, while this closure has moved on.
				// Svelte 5 has no boundary here, so that throw took the entire
				// workspace down rather than dropping a frame.
				if (!graph.hasEdge(id)) return result;

				const colors = palette();
				const [source, target] = graph.extremities(id);
				const anchor = anchorId();

				const base = result.color as string;

				if (anchor) {
					if (source === anchor || target === anchor) {
						result.color = mix(base, colors.edgeFocus, emphasis);
						result.size = (data.size as number) + 0.8 * emphasis;
					} else {
						// Kept, not hidden — the surrounding structure is context, and
						// blanking it made the canvas feel broken.
						result.color = mix(base, colors.dim, emphasis);
					}
					return result;
				}

				// A search with nothing hovered. The nodes already recede here; the edges
				// did not, because this reducer used to bail out as soon as there was no
				// anchor — so searching greyed out the dots and left the whole coloured
				// web behind them, which is most of the ink on the canvas.
				//
				// An edge survives only when BOTH ends are hits. One end being a result
				// makes it a link out into everything that was just excluded, and lighting
				// those would redraw the neighbourhood the search asked to filter away.
				if (highlight.size > 0 && !(highlight.has(source) && highlight.has(target))) {
					result.color = mix(base, colors.dim, emphasis);
				}
				return result;
			}
		});

		sigma.on('clickNode', ({ node }) => onSelect(node));
		// Clicking empty space clears the selection — the only way out of a focused
		// neighbourhood without hunting for a close button.
		sigma.on('clickStage', () => onSelect(null));
		sigma.on('enterNode', ({ node }) => {
			hoverId = node;
			setAnchor();
		});
		sigma.on('leaveNode', () => {
			hoverId = null;
			setAnchor();
		});
	});

	onDestroy(() => {
		if (emphasisFrame !== null) cancelAnimationFrame(emphasisFrame);
		stopLayout();
		sigma?.kill();
		sigma = null;
		graph = null;
	});

	// Rebuild ONLY when the dataset actually changed. The signature is computed by
	// the store when a response lands (see `signatureOf` there) rather than here:
	// it describes a FETCH, and hashing every label again inside a reactive effect
	// meant paying for it on any store write that happened to invalidate this.
	//
	// And when it HAS changed, prefer the incremental path. Memory is written while
	// the modal is open — that is the whole point of the live refresh — so a full
	// rebuild would reset the camera every time a conversation recorded something,
	// which reads as the view fighting the user. An attribute-only change lands on
	// the cheapest branch of all: no node churn means no re-heat, so a rename
	// repaints without moving anything.
	$effect(() => {
		const signature = memoryGraphStore.viewSignature;
		const layout = memoryGraphStore.layoutSignature;
		if (!sigma) return;
		if (signature === renderedSignature && layout === renderedLayout) return;

		renderedSignature = signature;
		renderedLayout = layout;
		buildGraph(sceneOf(view));
	});

	/**
	 * Hover a node from outside the canvas — driven by the search results list, so
	 * that pointing at a result does exactly what pointing at its node does.
	 *
	 * Writes the same plain variable sigma's own hover handler writes, never a rune
	 * (see the note at the top of this file). The rune is read by the effect that
	 * calls this, which is a different thing entirely: an effect may read state, a
	 * reducer may not.
	 */
	function setHovered(nodeId: string | null): void {
		const next = nodeId && graph?.hasNode(nodeId) ? nodeId : null;
		if (hoverId === next) return;
		hoverId = next;
		// `setAnchor` is the missing half, and without it this only did half the job.
		// The reducers dim everything away from the anchor as soon as `hoverId` is
		// set, but the GROWTH of the hovered node comes from `nodeEmphasis`, which
		// only `setAnchor` populates. Hovering a search result therefore dimmed the
		// graph without lifting anything out of it, which is exactly the difference
		// the user could see between this and hovering a node directly.
		setAnchor();
	}

	/** Canvas controls, declared once so the markup stays a loop. */
	const CONTROLS: { label: string; icon: IconName; action: () => void }[] = [
		{ label: 'Zoom in', icon: 'lucide:plus', action: () => zoomIn() },
		{ label: 'Zoom out', icon: 'lucide:minus', action: () => zoomOut() },
		{ label: 'Fit', icon: 'lucide:maximize', action: () => resetView() }
	];

	/**
	 * Re-measure after the surrounding layout changes (the inspector sliding in).
	 *
	 * The refresh is a FULL one, because a changed container changes the
	 * normalization every position is drawn through — but it only happens when the
	 * container really did change size. This used to refresh unconditionally, and
	 * with the divider drag calling it on every pointer move that was a complete
	 * re-index of the graph per mouse event.
	 */
	export function resize(): void {
		if (!sigma) return;
		const before = sigma.getDimensions();
		sigma.resize();
		const after = sigma.getDimensions();
		if (before.width === after.width && before.height === after.height) return;
		sigma.refresh();
	}

	export function zoomIn(): void {
		sigma?.getCamera().animatedZoom({ duration: 200 });
	}

	export function zoomOut(): void {
		sigma?.getCamera().animatedUnzoom({ duration: 200 });
	}

	export function resetView(): void {
		sigma?.getCamera().animatedReset({ duration: 300 });
	}

	/** Centre the camera on a node — used when a search result is chosen. */
	export function focusNode(nodeId: string): void {
		if (!sigma || !graph?.hasNode(nodeId)) return;
		const position = sigma.getNodeDisplayData(nodeId);
		if (!position) return;
		sigma.getCamera().animate({ x: position.x, y: position.y, ratio: 0.4 }, { duration: 400 });
	}
</script>

<div class="relative flex-1 min-h-0">
	<div
		bind:this={container}
		class="absolute inset-x-0 top-0 transition-[bottom] duration-200"
		style="bottom: {bottomInset}px"
	></div>

	<!-- Controls sit inside the canvas, the way a graph canvas is expected to
	     behave, rather than in the surrounding chrome. -->
	<div
		class="absolute bottom-3 left-3 flex flex-col rounded-lg overflow-hidden border
		       border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90
		       shadow-sm backdrop-blur-sm"
	>
		{#each CONTROLS as control, index (control.label)}
			<button
				onclick={control.action}
				class="flex p-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100
				       hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors
				       {index < 2 ? 'border-b border-slate-200 dark:border-slate-800' : ''}"
				aria-label={control.label}
				title={control.label}
			>
				<Icon name={control.icon} class="w-4 h-4" />
			</button>
		{/each}
	</div>
</div>
