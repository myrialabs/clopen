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
	 * ── Why it looks the way it does ──────────────────────────────────────────
	 * Quiet at rest, informative on contact. Small nodes and hairline edges, so the
	 * structure is carried by the arrangement rather than by the ink; unfocused
	 * nodes dim but stay visible rather than vanishing; and NOTHING is labelled
	 * until it is pointed at.
	 *
	 * That last one used to be a matter of degree — labels were thinned by size and
	 * by a grid, which still left full sentences drawn over each other wherever the
	 * graph was busy, and reading them as a layer of noise on top of the shape. They
	 * are now off entirely (`renderLabels: false`) and only the hover pill remains.
	 * Sigma draws that from `renderHighlightedNodes`, which is independent of the
	 * label layer, so turning labels off costs nothing on contact. Nodes still carry
	 * a `label` attribute because the hover renderer reads it.
	 */
	import { onDestroy, onMount } from 'svelte';
	import Sigma from 'sigma';
	import Graph from 'graphology';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { GraphView, GraphViewNode } from '$shared/types/memory';

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
	let framed = false;

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
	 * Longest label the hover pill will show; the full text lives in the inspector.
	 *
	 * Roomier than it was, because this is no longer drawn on the canvas at rest —
	 * one pill under the cursor can afford a whole clause where a hundred competing
	 * labels could not.
	 */
	const LABEL_MAX = 60;

	/**
	 * Lobe palettes, per theme. A single palette for both was the earlier mistake:
	 * hues that read on dark slate turn muddy on white, and the greys used for
	 * structural nodes disappeared entirely.
	 */
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
		const hue = Math.round((community * GOLDEN_ANGLE) % 360);
		// Two alternating lightness bands, so that even if two hues ever landed
		// close together they would still separate by brightness.
		const band = community % 2;
		return dark
			? hslToHex(hue, 72, band ? 58 : 66)
			: hslToHex(hue, 78, band ? 44 : 52);
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

	function truncate(label: string): string {
		return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
	}

	function nodeColor(node: GraphViewNode): string {
		// Structural nodes stay neutral on purpose. They are scaffolding — the files
		// and symbols memories hang off — and giving them community hues too would
		// make the coloured lobes read as one undifferentiated field.
		if (node.kind === 'structural') return palette().structural;
		return communityColor(node.community, isDark);
	}

	/** Lookup and scale for node/edge styling, rebuilt whenever the view is. */
	let nodeById = new Map<string, GraphViewNode>();
	let degreeScale = 1;

	/** Refresh what the styling functions read. Call before building a graph. */
	function indexView(current: GraphView): void {
		nodeById = new Map(current.nodes.map(node => [node.id, node]));
		degreeScale = scaleDegree(current.nodes);
	}

	/**
	 * The degree that counts as "fully connected" for sizing purposes.
	 *
	 * Normalising against the true maximum let one outlier flatten the whole view:
	 * a single hub with a hundred edges pushes every ordinary node's share below
	 * 0.05, so everything else renders at the floor and the only thing the sizes
	 * say is "there is one big node here". The 95th percentile is the busiest node
	 * that is not an outlier; anything beyond it simply clamps at the top of the
	 * range, which is the correct reading — past a point, more connected is more
	 * connected and the exact count stops mattering.
	 */
	function scaleDegree(nodes: GraphViewNode[]): number {
		if (nodes.length === 0) return 1;
		const sorted = nodes.map(node => node.degree).sort((a, b) => a - b);
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
	 */
	function nodeSize(node: GraphViewNode): number {
		const min = node.kind === 'structural' ? 1.5 : 2;
		const max = node.kind === 'structural' ? 6 : 9;
		const share = degreeScale <= 1 ? 0 : Math.min(1, node.degree / degreeScale);
		return min + (max - min) * Math.pow(share, 0.85);
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
		const degree = Math.max(nodeById.get(sourceId)?.degree ?? 1, nodeById.get(targetId)?.degree ?? 1);
		const share = degreeScale <= 1 ? 0 : Math.min(1, degree / degreeScale);
		return 0.25 + 0.95 * Math.pow(share, 0.7);
	}

	/** Hex with an alpha channel — the only transparent form sigma's parser reads. */
	function withAlpha(hex: string, alpha: number): string {
		const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
			.toString(16)
			.padStart(2, '0');
		return `${hex}${value}`;
	}

	function signatureOf(current: GraphView): string {
		return `${current.nodes.length}:${current.edges.length}:${current.nodes.map(n => n.id).join(',')}`;
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
	 * Where a node starts before the layout has an opinion.
	 *
	 * This has now been wrong twice, in opposite directions, and the reason is
	 * worth stating because it explains what the seed is actually for.
	 *
	 * FIRST it was a ring: every node placed on a circle by index. Deterministic,
	 * which was the real requirement — reloading a graph should settle into a
	 * familiar shape — but a ring is a very strong prior, and ForceAtlas2 never
	 * escapes it. Every node starts equidistant from the centre and gravity pulls
	 * inward uniformly, so every graph converged on the same disc regardless of its
	 * edges. The view was circular because it had been told to be.
	 *
	 * THEN it was a hash scatter: deterministic and shapeless, which fixed the
	 * circle. But shapeless is not neutral either. Starting from noise, a force
	 * layout has to discover the community structure from scratch, and in a few
	 * hundred iterations over a graph this sparse it does not finish — it stops
	 * somewhere partway, which is the hairball. The giveaway was that toggling a
	 * filter repeatedly gradually improved the layout: each toggle re-heated from
	 * where it left off, so the iterations accumulated and the structure slowly
	 * emerged. The layout was never wrong, only unfinished.
	 *
	 * NOW the seed carries the answer the layout was searching for. Louvain
	 * communities are already computed server-side for the colouring, so each
	 * community is given its own region and nodes start scattered within it. The
	 * forces then refine a layout that is already structured instead of
	 * constructing one from noise, so the first frame the user sees is grouped.
	 *
	 * And the regions are SIZED BY MEMBERSHIP, not laid out uniformly, which is the
	 * third correction. A spiral of equal regions is still a disc, and it gave a
	 * forty-node community exactly as much room as a three-node one — both of which
	 * survived into the finished render as "always round" and "the big lobes are
	 * always the crowded ones". See `seedRing`.
	 *
	 * It stays fully deterministic: community index, community size and node id all
	 * are.
	 */
	function seedPosition(
		node: { id: string; community: number },
		communitySizes: Map<number, number>
	): { x: number; y: number } {
		const hash = hashOf(node.id);
		const jitterX = ((hash % 65536) / 65536 - 0.5) * 2;
		const jitterY = (((hash >>> 16) % 65536) / 65536 - 0.5) * 2;

		// A single community carries no positional information, so fall back to a
		// plain scatter rather than piling everything on one point.
		if (communitySizes.size <= 1) {
			return { x: jitterX * 300, y: jitterY * 300 };
		}

		const order = seedRing(communitySizes);
		const region = order.get(node.community);
		if (!region) return { x: jitterX * 300, y: jitterY * 300 };

		return {
			x: region.x + jitterX * region.radius,
			y: region.y + jitterY * region.radius
		};
	}

	/**
	 * Where each community's region sits, and how big it is.
	 *
	 * The earlier version put every community on one golden-angle spiral at
	 * `120·√(index+1)`, which is a disc by construction and gave a forty-node
	 * community exactly as much room as a three-node one. Both of those show up in
	 * the finished render: the silhouette was always round, and the large lobes were
	 * always the crowded ones.
	 *
	 * Now the radius of a region scales with √(members) — area proportional to
	 * size — and the regions are laid out largest-first on a spiral whose step
	 * accounts for the radii already placed. The result is a seed whose SHAPE
	 * follows the data, which matters because the forces refine the seed rather
	 * than replacing it: a graph with one dominant group and three small ones now
	 * starts, and therefore ends, looking like that.
	 *
	 * Fully deterministic — the ordering is by size then community index, both of
	 * which are stable for a given dataset, so reloading settles into the same pose.
	 */
	function seedRing(communitySizes: Map<number, number>): Map<number, { x: number; y: number; radius: number }> {
		const ordered = [...communitySizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);

		/** Pixels of region radius per √member. Tuned against real graphs. */
		const SCALE = 26;
		/** Empty space between regions, as a fraction of the radius. */
		const GAP = 0.5;

		const regions = new Map<number, { x: number; y: number; radius: number }>();
		let placedRadius = 0;

		ordered.forEach(([community, size], index) => {
			const radius = Math.max(40, SCALE * Math.sqrt(size));
			// The largest community takes the centre; the rest spiral outward at the
			// golden angle, which spaces them evenly without ever putting two adjacent.
			const angle = index * GOLDEN_ANGLE * (Math.PI / 180);
			const distance = index === 0 ? 0 : placedRadius + radius * (1 + GAP);
			regions.set(community, {
				x: Math.cos(angle) * distance,
				y: Math.sin(angle) * distance,
				radius
			});
			// Grow the ring by a fraction of what was just placed, so successive
			// regions climb outward instead of stacking on one circle.
			placedRadius += radius * 0.55;
		});

		return regions;
	}

	/** How many nodes each community holds, in the current view. */
	function communitySizesOf(current: GraphView): Map<number, number> {
		const sizes = new Map<number, number>();
		for (const node of current.nodes) {
			sizes.set(node.community, (sizes.get(node.community) ?? 0) + 1);
		}
		return sizes;
	}

	function buildGraph(current: GraphView): void {
		if (!sigma) return;

		graph = new Graph({ type: 'undirected', multi: false });

		indexView(current);
		const communitySizes = communitySizesOf(current);
		current.nodes.forEach(node => {
			const seed = seedPosition(node, communitySizes);
			graph!.addNode(node.id, {
				x: seed.x,
				y: seed.y,
				size: nodeSize(node),
				label: truncate(node.label),
				color: nodeColor(node),
				kind: node.kind
			});
		});

		for (const edge of current.edges) {
			if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
			if (edge.source === edge.target) continue;
			if (graph.hasEdge(edge.source, edge.target)) continue;
			graph.addUndirectedEdge(edge.source, edge.target, {
				size: edgeSize(edge.source, edge.target),
				color: edgeColor(edge.source, edge.target)
			});
		}

		sigma.setGraph(graph);
		framed = false;
		startLayout(current);
	}

	function startLayout(current: GraphView, options?: { iterations?: number }): void {
		stopLayout();
		if (current.nodes.length === 0) return;

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
				if (!graph) return;

				const tween = graph.order <= MAX_TWEENED_NODES;
				for (let i = 0; i < workerNodeIds.length; i++) {
					const id = workerNodeIds[i];
					if (!graph.hasNode(id)) continue;
					const x = message.coords[i * 2];
					const y = message.coords[i * 2 + 1];

					if (tween) {
						targets.set(id, { x, y });
					} else {
						graph.setNodeAttribute(id, 'x', x);
						graph.setNodeAttribute(id, 'y', y);
					}
				}
				if (tween) startTween();
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
			}
		};

		indexView(current);
		const communitySizes = communitySizesOf(current);

		// Seeded from the community structure, the layout is refining rather than
		// discovering, so these buy convergence instead of merely progress.
		const iterations =
			options?.iterations ??
			(current.nodes.length > 1200 ? 260 : current.nodes.length > 400 ? 500 : 900);

		worker.postMessage({
			type: 'start',
			nodes: current.nodes.map(node => {
				// Positions already on screen are kept, so a graph that gains a few
				// nodes re-heats from where it is instead of being thrown back to its
				// seed and re-settling into a different pose.
				const existing = graph?.hasNode(node.id)
					? (graph.getNodeAttributes(node.id) as { x: number; y: number })
					: null;
				const seed = existing ?? seedPosition(node, communitySizes);
				return { id: node.id, x: seed.x, y: seed.y, degree: node.degree };
			}),
			edges: current.edges.map(edge => ({ source: edge.source, target: edge.target, weight: edge.weight })),
			iterations
		});
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
			for (const [id, target] of targets) {
				if (!graph.hasNode(id)) continue;
				const x = graph.getNodeAttribute(id, 'x') as number;
				const y = graph.getNodeAttribute(id, 'y') as number;
				const dx = target.x - x;
				const dy = target.y - y;

				// Snap once the remaining distance stops being visible, so the loop
				// terminates instead of chasing an asymptote forever.
				if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
					graph.setNodeAttribute(id, 'x', target.x);
					graph.setNodeAttribute(id, 'y', target.y);
					continue;
				}

				graph.setNodeAttribute(id, 'x', x + dx * TWEEN_EASE);
				graph.setNodeAttribute(id, 'y', y + dy * TWEEN_EASE);
				moving = true;
			}

			sigma.refresh({ skipIndexation: true });
			if (moving) tweenFrame = requestAnimationFrame(step);
		};

		tweenFrame = requestAnimationFrame(step);
	}

	function stopTween(): void {
		if (tweenFrame !== null) cancelAnimationFrame(tweenFrame);
		tweenFrame = null;
		targets.clear();
	}

	/**
	 * Ease `emphasis` and every node's own emphasis toward their targets, so
	 * focusing and unfocusing are transitions rather than switches.
	 */
	function startEmphasisTween(): void {
		if (emphasisFrame !== null) return;

		const step = (): void => {
			emphasisFrame = null;
			if (!sigma) return;

			let moving = false;

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

			sigma.refresh({ skipIndexation: true });
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

	/** Point the emphasis animation at a new focus and start it running. */
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
		startEmphasisTween();
	}

	function stopLayout(): void {
		stopTween();
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
	 * against the view (see `scaleDegree`). A memory arriving with three edges
	 * changes what "well connected" means for everything already drawn, and
	 * leaving the old sizes in place meant the graph slowly drifted out of
	 * agreement with its own data between full rebuilds.
	 *
	 * And edges are painted from `edgeColor`, which is what they were meant to
	 * have all along. This used to flatten every edge to a single slate — undoing
	 * `syncEdges` a line after it ran, so the community hues survived exactly
	 * until the first live update and then vanished for the rest of the session.
	 */
	function repaint(current: GraphView): void {
		indexView(current);
		if (!graph || !sigma) return;
		for (const node of current.nodes) {
			if (!graph.hasNode(node.id)) continue;
			graph.setNodeAttribute(node.id, 'color', nodeColor(node));
			graph.setNodeAttribute(node.id, 'size', nodeSize(node));
		}
		graph.forEachEdge((edge, _attributes, source, target) => {
			graph!.setEdgeAttribute(edge, 'color', edgeColor(source, target));
			graph!.setEdgeAttribute(edge, 'size', edgeSize(source, target));
		});
		sigma.refresh({ skipIndexation: true });
	}

	onMount(() => {
		if (!container) return;

		isDark = themeStore.isDark;

		sigma = new Sigma(new Graph(), container, {
			renderEdgeLabels: false,
			defaultEdgeType: 'line',
			minCameraRatio: 0.05,
			maxCameraRatio: 12,
			// No labels at rest — only the hover pill below. Thinning them by size and
			// by grid cell was the earlier compromise and it still left text stacked
			// over itself wherever the graph was busy.
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
				const isAdjacent = !!anchor && !!graph && graph.hasNode(anchor) && graph.areNeighbors(anchor, id);
				const isHit = highlight.has(id);
				const own = nodeEmphasis.get(id) ?? 0;

				// Growth follows this node's own emphasis, so the node being left
				// shrinks while the node being entered grows. The multiplier is larger
				// than it was because the nodes are smaller: 0.7 on a 22px hub was
				// obvious, 0.7 on a 2px leaf was not a gesture anyone could see.
				if (own > 0) {
					result.size = (data.size as number) * (1 + 1.2 * own);
					result.zIndex = 2;
				} else if (isHit) {
					result.zIndex = 1;
				}

				const recedes = (anchor && !isAdjacent && id !== anchor) || (!anchor && highlight.size > 0 && !isHit);
				if (recedes) result.color = mix(data.color as string, colors.dim, emphasis);
				return result;
			},

			edgeReducer: (id, data) => {
				const result = { ...data } as Record<string, unknown>;
				if (!graph || emphasis <= 0.001) return result;

				const colors = palette();
				const [source, target] = graph.extremities(id);
				const anchor = anchorId();

				if (anchor) {
					if (source === anchor || target === anchor) {
						result.color = mix(data.color as string, colors.edgeFocus, emphasis);
						result.size = (data.size as number) + 0.8 * emphasis;
					} else {
						// Kept, not hidden — the surrounding structure is context, and
						// blanking it made the canvas feel broken.
						result.color = mix(data.color as string, colors.dim, emphasis);
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
					result.color = mix(data.color as string, colors.dim, emphasis);
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

	// Rebuild ONLY when the dataset actually changed. Without the signature guard,
	// any store write (a refetch returning identical data) would restart the layout.
	//
	// And when it HAS changed, prefer the incremental path. Memory is written while
	// the modal is open — that is the whole point of the live refresh — so a full
	// rebuild would reset the camera and re-run a 400-iteration layout every time a
	// conversation recorded something, which reads as the view fighting the user.
	$effect(() => {
		const current = view;
		if (!sigma) return;

		const signature = signatureOf(current);
		if (signature === renderedSignature) return;

		const incremental = graph !== null && renderedSignature !== '' && applyIncremental(current);
		renderedSignature = signature;
		if (!incremental) buildGraph(current);
	});

	// Theme changes repaint in place; they must never rebuild or re-layout.
	$effect(() => {
		const dark = themeStore.isDark;
		if (dark === isDark) return;
		isDark = dark;
		repaint(view);
	});

	// Selection/search only update the plain mirrors and ask for a repaint.
	$effect(() => {
		focusId = selectedId;
		highlight = new Set(highlightIds);
		setAnchor();
	});

	// Hovering a search result hovers its node. Reading the store HERE is safe —
	// it is the reducers that must never touch a rune, and this is an effect.
	$effect(() => {
		setHovered(memoryGraphStore.hoveredId);
	});

	// The drawable area changed, so sigma's idea of its own size is stale and every
	// camera operation would be computed against the wrong rectangle.
	$effect(() => {
		void bottomInset;
		sigma?.resize();
	});

	/**
	 * Fold a changed dataset into the graph already on screen.
	 *
	 * Returns false when the change is too large to be worth patching, in which
	 * case the caller falls back to a full rebuild. The threshold exists because
	 * beyond a certain churn the incremental path costs more than it saves and the
	 * layout would be re-heated so hard that positions become meaningless anyway —
	 * switching projects, for instance, shares almost nothing with what was drawn.
	 *
	 * The camera is deliberately NOT touched. Somebody is looking at this.
	 */
	function applyIncremental(current: GraphView): boolean {
		if (!graph || !sigma) return false;

		const incoming = new Set(current.nodes.map(node => node.id));
		const existing = new Set(graph.nodes());

		const added = current.nodes.filter(node => !existing.has(node.id));
		const removed = [...existing].filter(id => !incoming.has(id));

		// More than a third of the view turning over is a different graph, not an
		// update to this one.
		const churn = added.length + removed.length;
		if (existing.size > 0 && churn > Math.max(30, existing.size * 0.34)) return false;
		if (churn === 0) {
			// Only edges or attributes moved — repaint without disturbing anything.
			syncEdges(current);
			repaint(current);
			return true;
		}

		for (const id of removed) {
			if (graph.hasNode(id)) graph.dropNode(id);
			targets.delete(id);
		}

		indexView(current);
		const communitySizes = communitySizesOf(current);
		for (const node of added) {
			// New nodes enter near the centroid of what they connect to, so an
			// arriving memory appears next to its subject rather than flying in from
			// a corner of the seed field.
			const anchors = current.edges
				.filter(edge => edge.source === node.id || edge.target === node.id)
				.map(edge => (edge.source === node.id ? edge.target : edge.source))
				.filter(id => graph!.hasNode(id))
				.map(id => graph!.getNodeAttributes(id) as { x: number; y: number });

			const seed = anchors.length
				? {
						x: anchors.reduce((sum, a) => sum + a.x, 0) / anchors.length,
						y: anchors.reduce((sum, a) => sum + a.y, 0) / anchors.length
					}
				: seedPosition(node, communitySizes);

			graph.addNode(node.id, {
				x: seed.x,
				y: seed.y,
				size: nodeSize(node),
				label: truncate(node.label),
				color: nodeColor(node),
				kind: node.kind
			});
		}

		syncEdges(current);
		repaint(current);
		// Re-heat briefly rather than re-solving: enough for the new nodes to find a
		// place, not enough to rearrange the graph the user is reading. Safe to do
		// with the same settings as a cold run now that the layout is a single phase —
		// what is on screen is already at equilibrium for them, so this nudges the
		// arrivals into place instead of restarting anything. Somebody is looking at
		// this.
		startLayout(current, { iterations: 90 });
		return true;
	}

	/** Bring the drawn edge set in line with the data, in place. */
	function syncEdges(current: GraphView): void {
		if (!graph) return;

		const wanted = new Set<string>();
		for (const edge of current.edges) {
			if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
			if (edge.source === edge.target) continue;
			if (!graph.hasEdge(edge.source, edge.target)) {
				graph.addUndirectedEdge(edge.source, edge.target, {
				size: edgeSize(edge.source, edge.target),
				color: edgeColor(edge.source, edge.target)
			});
			}
			wanted.add(graph.edge(edge.source, edge.target) as string);
		}
		for (const key of graph.edges()) {
			if (!wanted.has(key)) graph.dropEdge(key);
		}
	}

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

	/** Re-measure after the surrounding layout changes (the inspector sliding in). */
	export function resize(): void {
		sigma?.resize();
		sigma?.refresh({ skipIndexation: true });
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
