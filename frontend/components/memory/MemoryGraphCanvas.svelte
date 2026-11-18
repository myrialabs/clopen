<script lang="ts">
	/**
	 * The graph itself — a calm constellation rather than a diagram, served the
	 * way a map is.
	 *
	 * ── Why hover state is NOT `$state` ────────────────────────────────────────
	 * Sigma calls its node/edge reducers synchronously from inside `setGraph()` and
	 * `refresh()`. If those reducers read reactive state, Svelte records it as a
	 * dependency of whatever effect triggered the render — so hovering a node made
	 * the graph-building effect re-run, rebuilding the graph and resetting the
	 * camera. Everything a reducer touches therefore lives in a plain variable.
	 * The rule to keep: a reducer must never read a rune.
	 *
	 * ── Tiles, not a graph ────────────────────────────────────────────────────
	 * The server cuts the persisted arrangement into square tiles (see
	 * `backend/memory/view.ts`), and this component asks for the ones on screen at
	 * the zoom level the camera is at — exactly what a map viewer does. Panning
	 * loads what comes into view, and zooming in asks for smaller tiles, so a part
	 * of the map that was folded into clusters at one zoom resolves into its
	 * memories at the next. Nothing has to be clicked open.
	 *
	 * The screen has a budget of marks, and the server only folds anything when
	 * what is on screen exceeds it — so a store that fits is drawn in full at every
	 * zoom. Positions are the server's and never change under the client between
	 * layout passes, which is why sigma is pinned to a fixed bounding box (the
	 * WORLD): without it, every tile that loaded would change the extent and the
	 * whole picture would shift under the camera.
	 *
	 * ── What is always drawn ──────────────────────────────────────────────────
	 * The selected memory, its connections and the search results are drawn on top
	 * of whatever the tiles say. They are what the user is looking for, and the
	 * tile around them may be folded or not loaded at all — without this, hovering
	 * a search result or highlighting a hit only worked when it happened to be on
	 * screen as itself.
	 *
	 * ── Why it looks the way it does ──────────────────────────────────────────
	 * Quiet at rest, informative on contact. Small nodes and hairline edges, so the
	 * structure is carried by the arrangement rather than by the ink; unfocused
	 * nodes dim but stay visible rather than vanishing; and NOTHING is labelled
	 * until it is pointed at.
	 */
	import { onDestroy, onMount, untrack } from 'svelte';
	import Sigma from 'sigma';
	import Graph from 'graphology';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import { debug } from '$shared/utils/logger';
	import type { IconName } from '$shared/types/ui/icons';
	import type { GraphTile, GraphTileNode, GraphViewMeta, GraphWorld } from '$shared/types/memory';

	interface Props {
		/** Currently inspected node — highlighted and always drawn. */
		selectedId: string | null;
		/** Ids matching the active search; everything else recedes. */
		highlightIds?: string[];
		/**
		 * Pixels at the bottom of this component covered by something else — the
		 * inspector sheet on a phone.
		 *
		 * The canvas SHRINKS by this much rather than the camera compensating for it.
		 * Sigma centres, fits and zooms relative to its own container, so telling it
		 * the truth about how big that container is fixes every one of those at once.
		 */
		bottomInset?: number;
		onSelect: (nodeId: string | null) => void;
		/** What the screen is showing, so the surrounding chrome can explain clusters. */
		onScene?: (scene: { marks: number; clusters: number }) => void;
	}

	const { selectedId, highlightIds = [], bottomInset = 0, onSelect, onScene }: Props = $props();

	/** A memory drawn on its own, or a cluster standing for a crowded cell. */
	interface DrawNode {
		id: string;
		label: string;
		community: number;
		/** Connections for a memory, members for a cluster; both drive size. */
		magnitude: number;
		kind: 'memory' | 'cluster';
		x: number;
		y: number;
		/** For a cluster: the largest radius, in pixels, that stays inside its cell. */
		room?: number;
		/**
		 * For a cluster: sigma's zoom scaling at the moment it was sized, so its
		 * on-screen radius is the one asked for at that zoom. See `zoomSizeRatio`.
		 */
		scale?: number;
	}

	interface DrawEdge {
		source: string;
		target: string;
		weight: number;
		/** One of the strongest links of either end — drawn at rest. See `markBackbone`. */
		backbone?: boolean;
	}

	/**
	 * Marks the screen draws at once — the budget the server shares between the
	 * tiles on screen. Set where a WebGL scene stays comfortable on a low-powered
	 * machine; below it, nothing is ever folded.
	 */
	const SCREEN_BUDGET = 12_000;
	/** A tile is drawn between half this and this many pixels across. */
	const TILE_PIXELS = 512;
	/** Most tiles one screen asks for; past it the next coarser level is used. */
	const MAX_TILES_ON_SCREEN = 48;
	/** Must match the server's `MAX_TILE_ZOOM`. */
	const MAX_TILE_ZOOM = 20;
	/** How far past the edge of the screen tiles are fetched, as a fraction of it. */
	const PREFETCH = 0.15;
	/** Camera movement settles for this long before tiles are fetched. */
	const LOAD_DEBOUNCE_MS = 140;
	/** Tiles kept in memory, most recent first. */
	const MAX_CACHED_TILES = 256;
	/** How close "go to this memory" brings the camera, as a share of the world. */
	const FOCUS_RATIO = 0.3;
	/** Cells per side a loaded tile is indexed at, to attach edges arriving from elsewhere. */
	const LOOKUP_CELLS = 32;

	let container: HTMLDivElement | null = null;
	let sigma: Sigma | null = null;
	let graph: Graph = new Graph({ type: 'undirected', multi: false });

	// ── Plain state: read by reducers, never reactive (see the note above) ──
	let focusId: string | null = null;
	let hoverId: string | null = null;
	let highlight = new Set<string>();
	let isDark = false;

	/** What the scene was built from, by id — read by the styling functions. */
	let nodeById = new Map<string, DrawNode>();
	/** The degree that counts as "fully connected" — the filter's, from the meta. */
	let degreeScale = 1;
	/**
	 * The map's typical spacing between neighbours, in pixels at camera ratio 1.
	 * Every memory is sized against it; see `nodeSize`.
	 */
	let unitPixels = 0;

	// ── Tiles ──
	let meta: GraphViewMeta | null = null;
	let world: GraphWorld | null = null;
	let epoch = -1;
	/** Everything a cached tile depends on besides its address. */
	let cacheIdentity = '';
	const cache = new Map<string, GraphTile>();
	/** Tile keys requested and not yet answered, so a newer load does not ask twice. */
	const inflight = new Set<string>();
	/** The zoom level the camera currently wants. */
	let wantedZ = 0;
	/** The cached tiles that cover what the camera wants — what the scene is built from. */
	let sourceKeys: string[] = [];
	/** What the drawn scene was built from; see `compose`. */
	let composedSignature = '';
	/** Moves whenever the pinned memories do, so `compose` knows its scene is stale. */
	let pinnedVersion = 0;
	let loadTimer: ReturnType<typeof setTimeout> | null = null;
	let pinnedNodes: GraphTileNode[] = [];
	let pinnedLinks: { source: string; target: string }[] = [];
	/** Set on an epoch change: the memory to keep under the camera once the new map lands. */
	let pendingAnchor: { id: string; ratio: number } | null = null;
	let composedOnce = false;

	/**
	 * The drawn id lists, cached rather than re-derived per frame.
	 *
	 * The emphasis animation repaints on every frame and has to tell sigma WHICH
	 * elements to reprocess — see `repaintDrawn`.
	 */
	let drawnNodeIds: string[] = [];
	let drawnEdgeIds: string[] = [];

	/**
	 * Emphasis, animated rather than switched.
	 *
	 * Reducers are pure and run per frame, so the only way to animate focus is to
	 * animate the NUMBER they read. `emphasis` rises toward 1 while something is
	 * focused and falls back to 0 when nothing is.
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
	 * It animates SIZE, not position: `x`/`y` are layout-impacting for sigma, so a
	 * positional animation would reprocess the whole scene every frame, while
	 * `size` goes through the same partial repaint hovering uses.
	 */
	let reveal = 1;
	let revealFrames = 0;

	/** Frames the entrance runs for, counted in frames so a slow machine still sees it. */
	const REVEAL_FRAMES = 36;
	/** Of the whole entrance, how much is spent staggering rather than growing. */
	const REVEAL_STAGGER = 0.55;
	/** Where in the entrance the edges start drawing in behind the nodes. */
	const EDGE_REVEAL_START = 0.35;

	/** Longest label the hover pill will show; the full text lives in the inspector. */
	const LABEL_MAX = 60;

	/**
	 * A community's colour, generated rather than picked from a list.
	 *
	 * The golden angle (137.5°) puts successive hues as far from every previous one
	 * as possible, so neighbouring indices are clearly distinct and it does not
	 * repeat until far more communities than the view can show. Saturation and
	 * lightness are fixed per theme, and the hue is quantized so a community keeps
	 * exactly the same colour between renders.
	 */
	const GOLDEN_ANGLE = 137.508;

	/**
	 * HSL to hex, because sigma cannot read HSL — an `hsl()` string silently parses
	 * to black.
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
	 * Dark wants the hues lower in lightness so the colour carries against slate;
	 * light wants them more saturated so they survive at small sizes on white.
	 */
	function communityColor(community: number, dark: boolean): string {
		// A negative hue silently parses to black.
		const index = Math.abs(community);
		const hue = Math.round((index * GOLDEN_ANGLE) % 360);
		// Two alternating lightness bands, so that even if two hues ever landed
		// close together they would still separate by brightness.
		const band = index % 2;
		return dark ? hslToHex(hue, 72, band ? 58 : 66) : hslToHex(hue, 78, band ? 44 : 52);
	}

	/**
	 * The neutrals, which have to move with the hues rather than against them.
	 * `dim` is what everything receding is mixed toward, so it decides how strongly
	 * a search or a hover can filter.
	 */
	const THEME = {
		light: {
			edge: '#dbe2ea',
			edgeCross: '#c3ccd8',
			edgeFocus: '#7c8ba1',
			dim: '#e6ebf1',
			hoverBg: '#ffffff',
			hoverBorder: '#e2e8f0',
			hoverText: '#0f172a'
		},
		dark: {
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

	function truncate(label: string): string {
		return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
	}

	function nodeColor(node: DrawNode): string {
		return communityColor(node.community, isDark);
	}

	/**
	 * Node radius, in screen pixels at camera ratio 1.
	 *
	 * SIZED BY THE ROOM IT HAS, not by a fixed pixel range. A fixed 2–9 px was
	 * wrong at both ends of the zoom: at the overview a few thousand memories sit
	 * a pixel or two apart, so every lobe drew as one solid blob, and zoomed in the
	 * same dots looked lost in the space between them. The layout reports the
	 * typical distance to a nearest neighbour (`meta.spacing`), and a memory is
	 * drawn at about a third of it — so dots never swallow each other, and as the
	 * camera zooms they grow with the map (`zoomSizeRatio`), the way objects on a
	 * map do, up to a ceiling.
	 *
	 * Within that, a memory is sized by its share of the filter's 95th-percentile
	 * degree — the busiest node that is not an outlier — from the server's whole
	 * filtered set, never from what is loaded.
	 *
	 * A cluster is sized by how many it stands for, but never past the room its
	 * cell has — which is what keeps neighbouring clusters from overlapping.
	 */
	function nodeSize(node: DrawNode): number {
		if (node.kind === 'cluster') {
			const wanted = 4 + 2.4 * Math.log2(Math.max(2, node.magnitude));
			return Math.max(3, Math.min(node.room ?? wanted, wanted)) * (node.scale ?? 1);
		}
		const share = degreeScale <= 1 ? 0 : Math.min(1, node.magnitude / degreeScale);
		const base = unitPixels > 0 ? unitPixels * NODE_ROOM_SHARE : MAX_NODE_PIXELS / 2;
		return Math.max(MIN_NODE_PIXELS, Math.min(MAX_NODE_PIXELS, base * (0.75 + 0.75 * Math.pow(share, 0.85))));
	}

	/** A memory's radius as a share of the distance to its nearest neighbour. */
	const NODE_ROOM_SHARE = 0.26;
	/** Floor, so the overview of a very large store is still dots, not dust. */
	const MIN_NODE_PIXELS = 1.4;
	/** Ceiling at ratio 1, for a small store where the room is large. */
	const MAX_NODE_PIXELS = 7;
	/**
	 * How far zooming in may grow a node: sizes follow the map down to this
	 * camera ratio and stop there, so a deep zoom does not draw discs the size of
	 * the screen.
	 */
	const MIN_SIZE_RATIO = 0.15;

	/**
	 * Edge colour, taken from the community it sits inside — so a lobe's internal
	 * structure is legible at a glance and the lines BETWEEN lobes stand out as the
	 * exceptions they are.
	 */
	function edgeColor(sourceId: string, targetId: string): string {
		const source = nodeById.get(sourceId);
		const target = nodeById.get(targetId);
		if (!source || !target) return palette().edge;
		// Translucent, both kinds. An opaque line between two lobes crosses every
		// lobe in its way, and drawn by the hundred they buried the nodes under a
		// grey mesh.
		if (source.community !== target.community) return withAlpha(palette().edgeCross, isDark ? 0.55 : 0.5);
		return withAlpha(communityColor(source.community, isDark), isDark ? 0.3 : 0.25);
	}

	/** Edge width, from how connected its busier end is — a hairline, slightly heavier toward hubs. */
	function edgeSize(sourceId: string, targetId: string): number {
		const source = nodeById.get(sourceId);
		const target = nodeById.get(targetId);
		const merged = source?.kind === 'cluster' || target?.kind === 'cluster';
		const magnitude = Math.max(
			source?.kind === 'memory' ? source.magnitude : 1,
			target?.kind === 'memory' ? target.magnitude : 1
		);
		const share = degreeScale <= 1 ? 0 : Math.min(1, magnitude / degreeScale);
		const width = 0.3 + 0.5 * Math.pow(share, 0.7);
		// A line into a cluster stands for many, so it can afford to be seen.
		return merged ? width * 1.6 : width;
	}

	/** Strongest links per memory drawn at rest. */
	const BACKBONE_PER_NODE = 2;

	/**
	 * Mark the links that are drawn when nothing is focused.
	 *
	 * All of them were, and a store with twenty-three thousand of them — most of
	 * them derived from shared subjects, chaining every member of a subject to its
	 * heaviest neighbours — drew as a hairball that hid the very nodes it was
	 * connecting. The colour of a lobe already says which memories belong
	 * together; the lines only need to show the skeleton.
	 *
	 * So each memory keeps its strongest few, preferring ones inside its own lobe,
	 * and an edge is drawn at rest when it is among either end's few. Every other
	 * edge is still in the graph — hover and selection light a memory's whole
	 * neighbourhood, and a search shows every edge between two hits.
	 */
	function markBackbone(nodes: Map<string, DrawNode>, edges: Map<string, DrawEdge>): void {
		const incident = new Map<string, DrawEdge[]>();
		for (const edge of edges.values()) {
			edge.backbone = false;
			for (const end of [edge.source, edge.target]) {
				const list = incident.get(end);
				if (list) list.push(edge);
				else incident.set(end, [edge]);
			}
		}
		for (const [id, list] of incident) {
			list.sort((a, b) => {
				const inA = nodes.get(a.source)?.community === nodes.get(a.target)?.community ? 1 : 0;
				const inB = nodes.get(b.source)?.community === nodes.get(b.target)?.community ? 1 : 0;
				if (inA !== inB) return inB - inA;
				if (b.weight !== a.weight) return b.weight - a.weight;
				const keyA = a.source === id ? a.target : a.source;
				const keyB = b.source === id ? b.target : b.source;
				return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
			});
			// A memory whose only links leave its lobe keeps those — it would
			// otherwise float unconnected.
			for (let i = 0; i < Math.min(BACKBONE_PER_NODE, list.length); i++) list[i].backbone = true;
		}
	}

	/** Hex with an alpha channel — the only transparent form sigma's parser reads. */
	function withAlpha(hex: string, alpha: number): string {
		const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
			.toString(16)
			.padStart(2, '0');
		return `${hex}${value}`;
	}

	/**
	 * Blend two hex colours, carrying the SOURCE's alpha through — dropping it made
	 * a translucent edge flash opaque at the start of every fade.
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

	// ── Coordinates ──────────────────────────────────────────────────────────

	/**
	 * A layout position in the camera's framed space.
	 *
	 * Computed from the world box rather than through sigma's conversions, and it
	 * has to be. `graphToViewport` reads the matrix sigma cached at its last
	 * render, and sigma skips computing that matrix while the graph is empty —
	 * which is exactly the moment the first framing happens, before any tile has
	 * arrived. The camera was framed through a matrix that had never been set and
	 * opened off-centre. Sigma normalises against the custom bounding box with
	 * this same formula, so the answer is identical without the dependency.
	 */
	function framedOf(point: { x: number; y: number }): { x: number; y: number } | null {
		if (!world) return null;
		const half = world.size / 2;
		const framed = {
			x: 0.5 + (point.x - (world.minX + half)) / world.size,
			y: 0.5 + (point.y - (world.minY + half)) / world.size
		};
		return Number.isFinite(framed.x) && Number.isFinite(framed.y) ? framed : null;
	}

	/** The inverse of `framedOf`. */
	function graphOf(framed: { x: number; y: number }): { x: number; y: number } {
		const size = world?.size ?? 1;
		const half = size / 2;
		return {
			x: (world?.minX ?? 0) + half + (framed.x - 0.5) * size,
			y: (world?.minY ?? 0) + half + (framed.y - 0.5) * size
		};
	}

	/**
	 * A viewport pixel in layout space. `viewportToFramedGraph` recomputes its
	 * matrix from the live camera on every call, so — unlike `graphToViewport` —
	 * it is safe at any moment.
	 */
	function viewportToLayout(point: { x: number; y: number }): { x: number; y: number } {
		return graphOf(sigma!.viewportToFramedGraph(point));
	}

	/** The rectangle of layout space the camera is showing. */
	function viewRect(): { minX: number; maxX: number; minY: number; maxY: number; width: number } | null {
		if (!sigma || !world) return null;
		const { width, height } = sigma.getDimensions();
		if (!(width > 0) || !(height > 0)) return null;
		const corners = [
			viewportToLayout({ x: 0, y: 0 }),
			viewportToLayout({ x: width, y: 0 }),
			viewportToLayout({ x: 0, y: height }),
			viewportToLayout({ x: width, y: height })
		];
		const xs = corners.map(corner => corner.x);
		const ys = corners.map(corner => corner.y);
		const rect = {
			minX: Math.min(...xs),
			maxX: Math.max(...xs),
			minY: Math.min(...ys),
			maxY: Math.max(...ys),
			width
		};
		return [rect.minX, rect.maxX, rect.minY, rect.maxY].every(Number.isFinite) && rect.maxX > rect.minX
			? rect
			: null;
	}

	/**
	 * The camera that frames what the filter matches.
	 *
	 * Ratio 1 shows the whole world, so a part of it is framed at its share of the
	 * world's side, with a little air around it.
	 */
	function fitState(): { x: number; y: number; ratio: number } | null {
		if (!world) return null;
		const extent = meta?.extent ?? {
			minX: world.minX,
			maxX: world.minX + world.size,
			minY: world.minY,
			maxY: world.minY + world.size
		};
		const centre = framedOf({ x: (extent.minX + extent.maxX) / 2, y: (extent.minY + extent.maxY) / 2 });
		if (!centre) return null;
		const span = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY, world.size * 0.02);
		const ratio = Math.min(1.2, Math.max(0.002, (span / world.size) * 1.1));
		return { x: centre.x, y: centre.y, ratio };
	}

	// ── Loading tiles ────────────────────────────────────────────────────────

	function tileKey(z: number, x: number, y: number): string {
		return `${z}:${x}:${y}`;
	}

	/**
	 * The zoom level for the current camera, and the tiles it needs.
	 *
	 * When everything the filter matches fits the screen's budget, that is ONE
	 * tile — the whole world at level 0 — fetched once and drawn at every zoom.
	 * Otherwise the level is the one at which a tile is drawn between half of
	 * `TILE_PIXELS` and `TILE_PIXELS` across, so the work on screen is about the
	 * same at every zoom, stepped coarser when a very large screen would need more
	 * tiles than one request should carry.
	 */
	function wantedTiles(): { z: number; tiles: { x: number; y: number }[] } | null {
		if (!world || !meta) return null;
		if (meta.total - meta.unplaced <= SCREEN_BUDGET) return { z: 0, tiles: [{ x: 0, y: 0 }] };

		const rect = viewRect();
		if (!rect) return null;
		const pixelsPerUnit = rect.width / (rect.maxX - rect.minX);
		const worldPixels = world.size * pixelsPerUnit;
		let z = Math.max(0, Math.min(MAX_TILE_ZOOM, Math.ceil(Math.log2(Math.max(1, worldPixels / TILE_PIXELS)))));

		const padX = (rect.maxX - rect.minX) * PREFETCH;
		const padY = (rect.maxY - rect.minY) * PREFETCH;
		const range = (level: number) => {
			const span = 2 ** level;
			const size = world!.size / span;
			const clamp = (value: number) => Math.max(0, Math.min(span - 1, Math.floor(value)));
			return {
				fromX: clamp((rect.minX - padX - world!.minX) / size),
				toX: clamp((rect.maxX + padX - world!.minX) / size),
				fromY: clamp((rect.minY - padY - world!.minY) / size),
				toY: clamp((rect.maxY + padY - world!.minY) / size)
			};
		};

		let bounds = range(z);
		while (z > 0 && (bounds.toX - bounds.fromX + 1) * (bounds.toY - bounds.fromY + 1) > MAX_TILES_ON_SCREEN) {
			z--;
			bounds = range(z);
		}

		const tiles: { x: number; y: number }[] = [];
		for (let x = bounds.fromX; x <= bounds.toX; x++) {
			for (let y = bounds.fromY; y <= bounds.toY; y++) tiles.push({ x, y });
		}
		return { z, tiles };
	}

	/**
	 * Which cached tiles can stand in for a wanted one, if any.
	 *
	 * The tile itself; or an ancestor that came back COMPLETE — every memory in
	 * it, nothing folded — since everything in this tile is in it too; or, zooming
	 * out, its four children when all of them are complete. This is the map
	 * viewer's overzoom, and it is what stopped zooming from refetching: a level
	 * change used to ask for every tile on screen again, megabytes of the same
	 * memories, while the camera was still moving.
	 */
	function sourcesFor(z: number, x: number, y: number): string[] | null {
		const own = tileKey(z, x, y);
		if (cache.has(own)) return [own];

		for (let level = z - 1, ax = x >> 1, ay = y >> 1; level >= 0; level--, ax >>= 1, ay >>= 1) {
			const key = tileKey(level, ax, ay);
			const tile = cache.get(key);
			if (tile) return tile.cells === 0 ? [key] : null;
		}

		const children = [
			tileKey(z + 1, 2 * x, 2 * y),
			tileKey(z + 1, 2 * x + 1, 2 * y),
			tileKey(z + 1, 2 * x, 2 * y + 1),
			tileKey(z + 1, 2 * x + 1, 2 * y + 1)
		];
		if (children.every(key => cache.get(key)?.cells === 0)) return children;
		return null;
	}

	function scheduleLoad(delay = LOAD_DEBOUNCE_MS): void {
		if (loadTimer) clearTimeout(loadTimer);
		loadTimer = setTimeout(() => {
			loadTimer = null;
			void load();
		}, delay);
	}

	/**
	 * Fetch whatever the camera needs that nothing cached can stand in for, then
	 * redraw.
	 *
	 * Overlapping loads are expected — the camera keeps moving while a request is
	 * out — so tiles already requested are not asked for twice, and every answer
	 * redraws from whatever the camera wants NOW rather than what it wanted when
	 * the request left.
	 */
	async function load(): Promise<void> {
		if (!sigma || !world || !meta) return;
		const wanted = wantedTiles();
		if (!wanted) return;
		wantedZ = wanted.z;

		const identity = cacheIdentity;
		const requestEpoch = epoch;
		// Keyed by what the tile depends on too, so a request made under an old
		// filter or epoch never stops the current one from being asked for.
		const flightKey = (key: string) => `${requestEpoch}|${identity}|${key}`;

		const sources = new Set<string>();
		const missing: { x: number; y: number }[] = [];
		let unresolved = false;
		for (const tile of wanted.tiles) {
			const found = sourcesFor(wanted.z, tile.x, tile.y);
			if (found) {
				for (const key of found) sources.add(key);
				continue;
			}
			unresolved = true;
			if (!inflight.has(flightKey(tileKey(wanted.z, tile.x, tile.y)))) missing.push(tile);
		}

		if (!unresolved) {
			sourceKeys = [...sources].sort();
			compose();
			return;
		}
		if (missing.length === 0) return;

		// What is already on screen is spent; the rest of the budget is what the new
		// tiles may share.
		let spent = 0;
		for (const key of sources) {
			const tile = cache.get(key);
			if (tile) spent += tile.nodes.length + tile.clusters.length;
		}
		const budget = Math.max(256, SCREEN_BUDGET - spent);

		const keys = missing.map(tile => flightKey(tileKey(wanted.z, tile.x, tile.y)));
		for (const key of keys) inflight.add(key);

		const response = await memoryGraphStore.fetchTiles({
			epoch: requestEpoch,
			z: wanted.z,
			tiles: missing,
			budget
		});
		for (const key of keys) inflight.delete(key);

		// A failed request is retried rather than leaving a hole in the map that
		// only moving the camera would fill.
		if (!response) {
			scheduleLoad(1_500);
			return;
		}
		// Stale: the store refetches the meta, and the change it makes asks for
		// tiles again. Superseded: whatever superseded it has its own load coming.
		if (response.stale || identity !== cacheIdentity || requestEpoch !== epoch) return;

		for (const tile of response.tiles) cache.set(tileKey(tile.z, tile.x, tile.y), tile);
		// Anything asked for and not answered is cached as empty, so it is not asked
		// for again on every camera move.
		for (const tile of missing) {
			const key = tileKey(wanted.z, tile.x, tile.y);
			if (!cache.has(key)) {
				cache.set(key, { z: wanted.z, x: tile.x, y: tile.y, cells: 0, nodes: [], clusters: [], edges: [], cellEdges: [] });
			}
		}
		trimCache();
		// Resolve again from the camera as it is now, which may have moved on.
		void load();
	}

	/** Keep the cache bounded, never dropping what is on screen. */
	function trimCache(): void {
		if (cache.size <= MAX_CACHED_TILES) return;
		const keep = new Set(sourceKeys);
		for (const key of cache.keys()) {
			if (cache.size <= MAX_CACHED_TILES) break;
			if (!keep.has(key)) cache.delete(key);
		}
	}

	// ── Building the scene ───────────────────────────────────────────────────

	/**
	 * Turn the tiles on screen, plus what is pinned, into one scene.
	 *
	 * Edges arrive naming where their far end IS rather than which mark stands for
	 * it, because that depends on what is loaded: the memory itself when its tile
	 * is drawn in full, the cluster it is folded into when it is not, or nothing
	 * when it is off screen. Each loaded tile is indexed by cell so the far end can
	 * be found in constant time.
	 *
	 * Skipped when nothing it reads has changed. Every camera stop resolves the
	 * tiles again, and rebuilding an identical scene of thousands of nodes and
	 * edges each time was most of what made panning and zooming hitch.
	 */
	function compose(): void {
		if (!sigma || !world || sourceKeys.length === 0) return;

		const tiles = sourceKeys.map(key => cache.get(key)).filter((tile): tile is GraphTile => tile !== undefined);
		// A source evicted or cleared since it was resolved: the scene on screen
		// stays until `load` has resolved the camera again. Drawing what is left
		// would flash the gap — or, after a clear, an empty map.
		if (tiles.length !== sourceKeys.length) return;
		const folded = tiles.some(tile => tile.cells > 0);
		const ratio = sigma.getCamera().ratio;
		// Cluster sizes follow the zoom, so a scene with clusters is also stale when
		// the zoom has moved far enough to matter.
		const signature = `${cacheIdentity}|${epoch}|${sourceKeys.join(',')}|${pinnedVersion}|${
			folded ? Math.round(Math.log2(ratio) * 4) : ''
		}`;
		if (signature === composedSignature) return;
		composedSignature = signature;

		const rect = viewRect();
		const pixelsPerUnit = rect ? rect.width / (rect.maxX - rect.minX) : 1;
		const sizeFactor = zoomSizeRatio(ratio);
		unitPixels = measureUnitPixels();
		const tileSizeOf = (z: number) => world!.size / 2 ** z;

		const nodes = new Map<string, DrawNode>();
		const lookup = new Map<string, { cells: number; marks: Map<string, string> }>();
		const levels = new Set<number>();
		let clusters = 0;

		for (const tile of tiles) {
			const tileSize = tileSizeOf(tile.z);
			const cells = tile.cells > 0 ? tile.cells : LOOKUP_CELLS;
			const marks = new Map<string, string>();
			const best = new Map<string, number>();
			const cellOf = (x: number, y: number): string => {
				const cx = Math.max(0, Math.min(cells - 1, Math.floor(((x - world!.minX) / tileSize - tile.x) * cells)));
				const cy = Math.max(0, Math.min(cells - 1, Math.floor(((y - world!.minY) / tileSize - tile.y) * cells)));
				return `${cx}:${cy}`;
			};

			for (const node of tile.nodes) {
				nodes.set(node.id, memoryNode(node));
				const cell = cellOf(node.x, node.y);
				// The best-connected memory in a cell answers for it, so an edge from a
				// folded tile lands on the hub of that patch rather than a leaf.
				if ((best.get(cell) ?? -1) < node.degree) {
					best.set(cell, node.degree);
					marks.set(cell, node.id);
				}
			}

			// Room for a cluster: under half its cell on screen, so neighbours cannot touch.
			const room = (tileSize / cells) * pixelsPerUnit * 0.45;
			for (const cluster of tile.clusters) {
				clusters++;
				nodes.set(cluster.id, {
					id: cluster.id,
					label: `${cluster.members} memories · ${cluster.label}`,
					community: cluster.community,
					magnitude: cluster.members,
					kind: 'cluster',
					x: cluster.x,
					y: cluster.y,
					room,
					scale: sizeFactor
				});
				marks.set(`${cluster.cellX - tile.x * cells}:${cluster.cellY - tile.y * cells}`, cluster.id);
			}
			lookup.set(tileKey(tile.z, tile.x, tile.y), { cells, marks });
			levels.add(tile.z);
		}
		// Finest first: where tiles of two levels overlap, the finer one is the more
		// precise answer.
		const byLevel = [...levels].sort((a, b) => b - a);

		/** Whatever stands for a layout position at the moment, if anything does. */
		const markAt = (x: number, y: number): string | null => {
			for (const z of byLevel) {
				const tileSize = tileSizeOf(z);
				const tx = Math.floor((x - world!.minX) / tileSize);
				const ty = Math.floor((y - world!.minY) / tileSize);
				const entry = lookup.get(tileKey(z, tx, ty));
				if (!entry) continue;
				const cx = Math.max(0, Math.min(entry.cells - 1, Math.floor(((x - world!.minX) / tileSize - tx) * entry.cells)));
				const cy = Math.max(0, Math.min(entry.cells - 1, Math.floor(((y - world!.minY) / tileSize - ty) * entry.cells)));
				const exact = entry.marks.get(`${cx}:${cy}`);
				if (exact) return exact;
				// The far end's cell was measured on another tile's grid, so its centre
				// can fall in an empty neighbour of the right cell here.
				for (let dx = -1; dx <= 1; dx++) {
					for (let dy = -1; dy <= 1; dy++) {
						const near = entry.marks.get(`${cx + dx}:${cy + dy}`);
						if (near) return near;
					}
				}
				return null;
			}
			return null;
		};

		const edges = new Map<string, DrawEdge>();
		const link = (source: string, target: string | null, weight: number): void => {
			if (!target || source === target || !nodes.has(source) || !nodes.has(target)) return;
			const key = source < target ? `${source}|${target}` : `${target}|${source}`;
			const existing = edges.get(key);
			if (existing) existing.weight = Math.max(existing.weight, weight);
			else edges.set(key, { source, target, weight });
		};

		// Pinned memories first, so the edges below can attach to them too.
		for (const node of pinnedNodes) if (!nodes.has(node.id)) nodes.set(node.id, memoryNode(node));

		for (const tile of tiles) {
			for (const edge of tile.edges) {
				link(edge.source, nodes.has(edge.target) ? edge.target : markAt(edge.targetX, edge.targetY), edge.weight);
			}
			if (tile.cells > 0) {
				const cellSize = tileSizeOf(tile.z) / tile.cells;
				for (const edge of tile.cellEdges) {
					link(
						edge.source,
						markAt(world.minX + (edge.targetCellX + 0.5) * cellSize, world.minY + (edge.targetCellY + 0.5) * cellSize),
						edge.weight
					);
				}
			}
		}
		for (const edge of pinnedLinks) link(edge.source, edge.target, 1);

		markBackbone(nodes, edges);
		applyScene(nodes, edges);
		onScene?.({ marks: nodes.size, clusters });
	}

	function memoryNode(node: GraphTileNode): DrawNode {
		return {
			id: node.id,
			label: node.label,
			community: node.community,
			magnitude: node.degree,
			kind: 'memory',
			x: node.x,
			y: node.y
		};
	}

	/**
	 * Sigma's size scaling at a camera ratio — see the `zoomToSizeRatioFunction`
	 * setting. Linear, so a node keeps its share of the space around it as the map
	 * zooms, until `MIN_SIZE_RATIO` stops the growth.
	 */
	function zoomSizeRatio(ratio: number): number {
		return Math.max(ratio, MIN_SIZE_RATIO);
	}

	/** The map's typical neighbour spacing in pixels at camera ratio 1, for the current viewport. */
	function measureUnitPixels(): number {
		const rect = viewRect();
		if (!rect || !sigma || !meta || !(meta.spacing > 0)) return 0;
		return meta.spacing * (rect.width / (rect.maxX - rect.minX)) * sigma.getCamera().ratio;
	}

	/**
	 * Bring the drawn graph to the scene, changing only what changed.
	 *
	 * Incremental on purpose. The scene is rebuilt every time a tile lands and every
	 * time a conversation records something while the view is open, and replacing
	 * the graph wholesale each time made hover flicker and replayed the entrance.
	 * Only a scene that is mostly new — the first one, or a jump to a far part of
	 * the map — is built as a fresh graph, because one `setGraph` is cheaper than
	 * thousands of individual insertions.
	 */
	function applyScene(nodes: Map<string, DrawNode>, edges: Map<string, DrawEdge>): void {
		if (!sigma) return;
		nodeById = nodes;

		let kept = 0;
		graph.forEachNode(id => {
			if (nodes.has(id)) kept++;
		});
		const fresh = graph.order === 0 || kept < Math.max(nodes.size, graph.order) * 0.5;

		guardRepaint(() => {
			if (fresh) {
				const next = new Graph({ type: 'undirected', multi: false });
				for (const node of nodes.values()) next.addNode(node.id, attributesOf(node));
				for (const edge of edges.values()) {
					next.addUndirectedEdge(edge.source, edge.target, edgeAttributesOf(edge));
				}
				graph = next;
				if (!composedOnce) {
					composedOnce = true;
					assignRevealDelays(graph);
					startReveal();
				}
				sigma!.setGraph(graph);
				return;
			}

			let structural = false;
			const doomed: string[] = [];
			graph.forEachNode(id => {
				if (!nodes.has(id)) doomed.push(id);
			});
			for (const id of doomed) graph.dropNode(id);
			if (doomed.length > 0) structural = true;

			for (const node of nodes.values()) {
				const attributes = attributesOf(node);
				if (!graph.hasNode(node.id)) {
					graph.addNode(node.id, attributes);
					structural = true;
					continue;
				}
				const current = graph.getNodeAttributes(node.id);
				if (
					current.x !== attributes.x ||
					current.y !== attributes.y ||
					current.size !== attributes.size ||
					current.color !== attributes.color ||
					current.label !== attributes.label
				) {
					graph.mergeNodeAttributes(node.id, attributes);
				}
			}

			const stale: string[] = [];
			graph.forEachEdge((edge, _attributes, source, target) => {
				const key = source < target ? `${source}|${target}` : `${target}|${source}`;
				if (!edges.has(key)) stale.push(edge);
			});
			for (const edge of stale) graph.dropEdge(edge);
			if (stale.length > 0) structural = true;

			for (const edge of edges.values()) {
				if (graph.hasEdge(edge.source, edge.target)) {
					// Whether it is drawn at rest depends on its neighbours' other links,
					// which a tile landing can change without touching this edge.
					const existing = graph.edge(edge.source, edge.target) as string;
					if (graph.getEdgeAttribute(existing, 'backbone') !== !!edge.backbone) {
						graph.setEdgeAttribute(existing, 'backbone', !!edge.backbone);
					}
					continue;
				}
				graph.addUndirectedEdge(edge.source, edge.target, edgeAttributesOf(edge));
				structural = true;
			}

			// Settle sigma's index NOW. It indexes added nodes and edges on its next
			// scheduled frame, and the emphasis loop repaints with indexation skipped —
			// so a frame landing in between asked sigma to repaint an edge it had not
			// indexed yet, and it threw `edge "…" can't be repaint`. One full refresh
			// per structural change, never per frame.
			if (structural) sigma!.refresh();
		});

		cacheDrawnIds();
		if (pendingAnchor) settleAnchor();
	}

	function attributesOf(node: DrawNode): Record<string, unknown> {
		return {
			x: node.x,
			y: node.y,
			size: nodeSize(node),
			label: truncate(node.label),
			color: nodeColor(node),
			kind: node.kind,
			// Overwritten by `assignRevealDelays` on the first scene.
			delay: 0
		};
	}

	function edgeAttributesOf(edge: DrawEdge): Record<string, unknown> {
		return {
			size: edgeSize(edge.source, edge.target),
			color: edgeColor(edge.source, edge.target),
			backbone: !!edge.backbone
		};
	}

	/**
	 * Give every node the moment it should appear, radial from the centre of the
	 * arrangement, so the graph opens outward — what emerges first is the dense
	 * middle the layout put there.
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
		// Ease-out cubic: quick to appear, gentle to settle.
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
		drawnNodeIds = graph.nodes();
		drawnEdgeIds = graph.edges();
	}

	// ── The map changing under the camera ────────────────────────────────────

	/**
	 * Take in a new meta: a new world, a new filter, or simply "something changed".
	 *
	 * A new EPOCH means the map itself was redrawn — a cold layout pass, or the
	 * world growing — and every cached tile and the camera's coordinates refer to
	 * the old one. The camera is carried across by keeping one memory where it was:
	 * the selected one, or failing that the one nearest the middle of the screen.
	 * The pass aligns a new arrangement onto the old one, so this is usually a
	 * nudge, but it is correct even when it is not.
	 */
	function applyMeta(next: GraphViewMeta | null, identity: string): void {
		meta = next;
		degreeScale = next?.degreeScale ?? 1;
		if (!sigma) return;

		if (!next || !next.world) {
			world = null;
			epoch = next?.epoch ?? -1;
			cache.clear();
			cacheIdentity = identity;
			applyScene(new Map(), new Map());
			return;
		}

		const previous = world;
		const moved =
			next.epoch !== epoch ||
			!previous ||
			previous.minX !== next.world.minX ||
			previous.minY !== next.world.minY ||
			previous.size !== next.world.size;

		if (moved) {
			const camera = sigma.getCamera();
			const anchorId = previous ? currentAnchor() : null;
			const ratio = previous ? camera.ratio * (previous.size / next.world.size) : null;

			world = next.world;
			epoch = next.epoch;
			cache.clear();
			sigma.setCustomBBox({
				x: [next.world.minX, next.world.minX + next.world.size],
				y: [next.world.minY, next.world.minY + next.world.size]
			});
			sigma.refresh();

			if (anchorId && ratio !== null) {
				pendingAnchor = { id: anchorId, ratio };
				camera.setState({ ratio: Math.min(1.2, Math.max(0.002, ratio)) });
			} else {
				const fit = fitState();
				if (fit) camera.setState(fit);
			}
		}

		if (identity !== cacheIdentity) {
			cache.clear();
			cacheIdentity = identity;
		}
		scheduleLoad(0);
	}

	/** The memory the user is looking at: the selection, or the one nearest the centre. */
	function currentAnchor(): string | null {
		if (focusId && graph.hasNode(focusId)) return focusId;
		if (!sigma) return null;
		const { width, height } = sigma.getDimensions();
		const centre = viewportToLayout({ x: width / 2, y: height / 2 });
		let best: string | null = null;
		let bestDistance = Infinity;
		graph.forEachNode((id, attributes) => {
			if (attributes.kind !== 'memory') return;
			const distance = Math.hypot((attributes.x as number) - centre.x, (attributes.y as number) - centre.y);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = id;
			}
		});
		return best;
	}

	/** Once the new map has the anchor, put it back under the camera. */
	function settleAnchor(): void {
		const anchor = pendingAnchor;
		if (!anchor || !sigma) return;
		pendingAnchor = null;
		void (async () => {
			let position: { x: number; y: number } | null = graph.hasNode(anchor.id)
				? (graph.getNodeAttributes(anchor.id) as { x: number; y: number })
				: null;
			if (!position) {
				const [found] = await memoryGraphStore.locate([anchor.id]);
				position = found ?? null;
			}
			const framed = position ? framedOf(position) : null;
			if (!framed || !sigma) return;
			sigma.getCamera().setState({ x: framed.x, y: framed.y });
		})();
	}

	// ── Animation ────────────────────────────────────────────────────────────

	/**
	 * Redraw what is already on screen, without touching the graph — a PARTIAL
	 * refresh with indexation skipped. A full refresh here re-indexed the whole
	 * graph sixty times a second while hovering.
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
	 * One loop, because two would each repaint the same scene in the same frame.
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
	 * What the view is currently emphasising. Hover WINS over selection: it is the
	 * transient gesture, and answering it immediately is the point.
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

	/**
	 * Re-derive every appearance attribute in place — on a theme flip or a new size
	 * scale. Positions are not touched. Both loops are BULK updates: per-attribute
	 * setters made sigma re-run a reducer per attribute per element.
	 */
	function repaint(): void {
		if (!sigma) return;
		guardRepaint(() => {
			graph.updateEachNodeAttributes(
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

			graph.updateEachEdgeAttributes(
				(_id, attributes, source, target) => ({
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
	 * A throw during render in Svelte 5 has no boundary above it and takes the
	 * whole workspace down; the remedy for every failure here is a full refresh.
	 */
	function guardRepaint(paint: () => void): void {
		try {
			paint();
		} catch (error) {
			debug.warn('memory', 'Memory graph repaint fell back to a full refresh', error);
			sigma?.refresh();
		}
	}

	/** Zoom into a cluster: the next level down resolves it into its memories. */
	function openCluster(id: string): void {
		if (!sigma || !graph.hasNode(id)) return;
		const position = graph.getNodeAttributes(id) as { x: number; y: number };
		const framed = framedOf(position);
		if (!framed) return;
		const camera = sigma.getCamera();
		void camera.animate({ x: framed.x, y: framed.y, ratio: Math.max(0.002, camera.ratio / 3) }, { duration: 350 });
	}

	onMount(() => {
		if (!container) return;

		isDark = themeStore.isDark;

		sigma = new Sigma(graph, container, {
			renderEdgeLabels: false,
			defaultEdgeType: 'line',
			// Deep enough to reach single memories in a very large store; the tiles,
			// not the camera, decide how much is drawn at any depth.
			minCameraRatio: 0.002,
			maxCameraRatio: 3,
			// Nodes grow a little as you zoom in, as they always did, but not without
			// bound — the camera now goes hundreds of times deeper than it used to.
			zoomToSizeRatioFunction: zoomSizeRatio,
			// No captions at rest. The hover pill names one thing at a time, which is
			// what naming is for over a picture whose value is its shape.
			renderLabels: false,
			/**
			 * Sigma clamps every edge up to this, and it defaults to 1.7px — thicker
			 * than the widest edge this view asks for.
			 */
			minEdgeThickness: 0.4,

			/** A theme-following hover pill instead of sigma's hardcoded white box. */
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
				// `areNeighbors` THROWS on an unknown key, and sigma can render one frame
				// against a graph this component has already changed.
				const isAdjacent =
					!!anchor && graph.hasNode(anchor) && graph.hasNode(id) && graph.areNeighbors(anchor, id);
				const isHit = highlight.has(id);
				const own = nodeEmphasis.get(id) ?? 0;

				// Growth follows this node's own emphasis, so the node being left
				// shrinks while the node being entered grows.
				let size = data.size as number;
				if (own > 0) {
					size *= 1 + 1.2 * own;
					result.zIndex = 2;
				} else if (isHit) {
					result.zIndex = 1;
				}

				if (reveal < 1) size *= revealOf((data.delay as number) ?? 0);
				result.size = size;

				const recedes = (anchor && !isAdjacent && id !== anchor) || (!anchor && highlight.size > 0 && !isHit);
				if (recedes) result.color = mix(data.color as string, colors.dim, emphasis);
				return result;
			},

			edgeReducer: (id, data) => {
				const result = { ...data } as Record<string, unknown>;

				// At rest only the backbone is drawn; a focused memory's whole
				// neighbourhood and every link between two search hits come back. See
				// `markBackbone`. `extremities` throws for an edge no longer in the graph.
				if (!data.backbone && graph.hasEdge(id)) {
					const [source, target] = graph.extremities(id);
					const anchor = anchorId();
					const focused = !!anchor && (source === anchor || target === anchor);
					const between = highlight.size > 0 && highlight.has(source) && highlight.has(target);
					if (!focused && !between) {
						result.hidden = true;
						return result;
					}
				}

				// Edges draw in behind the nodes they connect, by receding from the
				// colour everything else recedes to — sigma clamps thin edges, so
				// animating the width would stop being visible almost immediately.
				if (reveal < 1) {
					const progress = Math.min(
						1,
						Math.max(0, (reveal - EDGE_REVEAL_START) / (1 - EDGE_REVEAL_START))
					);
					result.color = mix(data.color as string, palette().dim, 1 - progress);
					if (progress <= 0.001) return result;
				}

				if (emphasis <= 0.001) return result;

				// `extremities` throws rather than returning null for an edge that is
				// no longer in the graph.
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
						// Kept, not hidden — the surrounding structure is context.
						result.color = mix(base, colors.dim, emphasis);
					}
					return result;
				}

				// A search with nothing hovered: an edge survives only when BOTH ends
				// are hits, or the neighbourhood the search filtered away comes back.
				if (highlight.size > 0 && !(highlight.has(source) && highlight.has(target))) {
					result.color = mix(base, colors.dim, emphasis);
				}
				return result;
			}
		});

		sigma.on('clickNode', ({ node }) => {
			if (graph.hasNode(node) && graph.getNodeAttribute(node, 'kind') === 'cluster') {
				openCluster(node);
				return;
			}
			onSelect(node);
		});
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
		// The camera is the map's request: wherever it settles is what to load.
		sigma.getCamera().on('updated', () => scheduleLoad());
	});

	onDestroy(() => {
		if (emphasisFrame !== null) cancelAnimationFrame(emphasisFrame);
		if (loadTimer) clearTimeout(loadTimer);
		sigma?.kill();
		sigma = null;
	});

	// What the map covers, and whether what it says changed. Read here and handed
	// to plain code: nothing below may register a dependency by accident.
	$effect(() => {
		const next = memoryGraphStore.meta;
		const identity = `${memoryGraphStore.filterKey}|${memoryGraphStore.revision}`;
		untrack(() => applyMeta(next, identity));
	});

	// Theme changes repaint in place; they must never rebuild or reload.
	$effect(() => {
		const dark = themeStore.isDark;
		untrack(() => {
			if (dark === isDark) return;
			isDark = dark;
			repaint();
		});
	});

	// Selection and search update the plain mirrors and ask for a repaint.
	$effect(() => {
		const nextFocus = selectedId;
		const nextHighlight = new Set(highlightIds);
		untrack(() => {
			focusId = nextFocus;
			highlight = nextHighlight;
			setAnchor();
		});
	});

	// The selection, its connections and the search results are drawn whatever
	// the tiles say, so a change to them is a change to the scene.
	$effect(() => {
		const nodes = memoryGraphStore.pinned;
		const links = memoryGraphStore.pinnedEdges;
		untrack(() => {
			pinnedNodes = nodes;
			pinnedLinks = links;
			pinnedVersion++;
			if (sigma && world) compose();
		});
	});

	// Hovering a search result hovers its node. Reading the store HERE is safe —
	// it is the reducers that must never touch a rune, and this is an effect.
	$effect(() => {
		const hovered = memoryGraphStore.hoveredId;
		untrack(() => setHovered(hovered));
	});

	// The drawable area changed, so sigma's idea of its own size is stale, and so
	// is the set of tiles on screen.
	$effect(() => {
		void bottomInset;
		untrack(() => resize());
	});

	/**
	 * Hover a node from outside the canvas — driven by the search results list, so
	 * that pointing at a result does exactly what pointing at its node does.
	 */
	function setHovered(nodeId: string | null): void {
		const next = nodeId && graph.hasNode(nodeId) ? nodeId : null;
		if (hoverId === next) return;
		hoverId = next;
		// `setAnchor` populates the per-node emphasis that GROWS the hovered node;
		// without it hovering a result dimmed the graph and lifted nothing.
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
	 * Only refreshes when the container really did change size — the divider drag
	 * calls this on every pointer move.
	 */
	export function resize(): void {
		if (!sigma) return;
		const before = sigma.getDimensions();
		sigma.resize();
		const after = sigma.getDimensions();
		if (before.width === after.width && before.height === after.height) return;
		sigma.refresh();
		// Node sizes are measured against the viewport, so they move with it.
		unitPixels = measureUnitPixels();
		repaint();
		scheduleLoad();
	}

	export function zoomIn(): void {
		void sigma?.getCamera().animatedZoom({ duration: 200 });
	}

	export function zoomOut(): void {
		void sigma?.getCamera().animatedUnzoom({ duration: 200 });
	}

	/** Frame what the filter matches. */
	export function resetView(): void {
		const fit = fitState();
		if (fit) void sigma?.getCamera().animate(fit, { duration: 300 });
	}

	/**
	 * Bring the camera to a memory — used when a search result, a connection or a
	 * history step is chosen.
	 *
	 * Works whether or not the memory is drawn: its position comes from the graph
	 * when it is, and from the server when it is not, and the tiles around it load
	 * as the camera arrives.
	 */
	export async function focusNode(nodeId: string): Promise<void> {
		if (!sigma) return;
		let position: { x: number; y: number } | null = graph.hasNode(nodeId)
			? (graph.getNodeAttributes(nodeId) as { x: number; y: number })
			: (pinnedNodes.find(node => node.id === nodeId) ?? null);
		if (!position) {
			const [found] = await memoryGraphStore.locate([nodeId]);
			position = found ?? null;
		}
		if (!position || !sigma) return;
		const framed = framedOf(position);
		if (!framed) return;
		const camera = sigma.getCamera();
		void camera.animate(
			{ x: framed.x, y: framed.y, ratio: Math.min(camera.ratio, FOCUS_RATIO) },
			{ duration: 400 }
		);
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
