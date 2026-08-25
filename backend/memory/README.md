# Memory Graph

Persistent memory for Clopen. One SQLite graph holding what past sessions decided
and what the codebase looks like, shared by every engine, retrieved locally with
no model call and no service to run.

Clopen otherwise forgets everything between sessions: each conversation re-derives
what was already settled, and switching engine loses it entirely.

---

## Table of Contents

- [The Shape of It](#the-shape-of-it)
- [Two Halves, One Store](#two-halves-one-store)
- [Reading: How Retrieval Works](#reading-how-retrieval-works)
- [Writing: How Memories Get In](#writing-how-memories-get-in)
- [Keeping the Graph Honest](#keeping-the-graph-honest)
- [The Embedding Artifact](#the-embedding-artifact)
- [Readiness and Setup](#readiness-and-setup)
- [Agent Access (MCP)](#agent-access-mcp)
- [Configuration](#configuration)
- [Schema](#schema)
- [File Map](#file-map)
- [Testing](#testing)
- [Design Decisions Worth Knowing](#design-decisions-worth-knowing)

---

## The Shape of It

```
    a turn finishes
          │
          ├── snapshot disk diff ──→ structural extraction ──┐
          │                                                  │
          └── transcript ──→ episodic extraction (model) ────┤
                                                             ▼
                                                      ┌─────────────┐
                                                      │ graph_nodes │
                                                      │ graph_edges │
                                                      └──────┬──────┘
                                                             │
                                          ┌──────────────────┴─────────┐
                                          ▼                            ▼
                                    graph_nodes_fts             graph_vectors
                                       (BM25)                   (int8, local)
                                          │                            │
                                          └────────── RRF ─────────────┘
                                                       │
                                            spreading activation, 1 hop
                                                       │
                                                       ▼
                                     injected into the next turn's prompt
```

Nothing on the read path calls a model or touches the network.

---

## Two Halves, One Store

| Kind | Holds | Written by |
| --- | --- | --- |
| `episodic` | decisions, patterns, failures, preferences, observations | a model reading each finished turn |
| `structural` | files, symbols, modules, dependencies | the snapshot service's disk diff |

They live in **one** graph, joined by an `about` edge. That join is the whole
point: asking "what touches this module" also surfaces the decisions made around
it, and asking "what did we decide about X" surfaces the code it governs.

Structural nodes come from the **disk diff**, not from tool calls, so a file
rewritten through Bash or a codemod is captured as reliably as one edited with an
edit tool.

Structural hits are deliberately excluded from the injected block — an agent can
read the repository itself. They earn their place by being the path retrieval
*travels* to reach the relevant episodic memories.

---

## Reading: How Retrieval Works

`retrieval.ts` runs two channels on every query and fuses them with Reciprocal
Rank Fusion, weighted by whether the query reads as an identifier or as prose.

- **BM25** (`graph_nodes_fts`) finds identifiers, paths and error strings.
- **Vector** (`graph_vectors`) finds paraphrases and cross-language matches.

Neither is a fallback for the other; they fail in different directions and each
corrects the other's characteristic misses. Results then spread one hop through
the graph, so a memory adjacent to the match is reachable.

### How much gets recalled

There is no setting for this, and its absence is deliberate. A character budget
overshot by 79% at its lowest setting; a fixed count cannot be right for both
"ok, continue" and a question the graph knows a great deal about.

Each turn keeps the hits that stay close to **its own** best match
(`RELATIVE_FLOOR` in `context.ts`) and takes only the top few when the scores
never fall away — a ranking that does not separate has not ranked anything. A
hard ceiling remains in code as a cost backstop, not as a control.

### Standing instructions

What the user has **stated** is selected structurally and sent every turn,
regardless of what was asked. It is not retrieved, because a rule like "never use
the agent tool" has no topical overlap with "analyse this project", and static
embeddings cannot represent negation — asking *"jangan gunakan agent tool"* once
returned *"requested use of agent tool"* as the top hit.

Measured: human-stated rules reached the prompt on 3 of 20 opportunities before
this existed, and 30 of 30 after.

### Cross-project recall

Every memory records **where it was learned** (`project_id`) and, separately,
**whether it applies anywhere** (`reach`). A Svelte gotcha debugged in one
project reaches the next project that hits it; "this project deploys to Fly.io"
stays put.

`reach` defaults to `here` and is widened only by the reclassification pass in
`judge.ts`. That asymmetry is intentional: a memory wrongly held back is
invisible until the pass reaches it, while one wrongly released is in every
prompt immediately — and only the first is recoverable by waiting.

---

## Writing: How Memories Get In

**Exactly one path creates memories:** the extraction that reads each finished
turn (`extract/episodic.ts`), scheduled by `extract/scheduler.ts`. It runs the
moment a turn ends, at most `MAX_CONCURRENT` at a time.

A person can also write one by hand through the composer (`compose.ts`) —
extraction can only record what a conversation happened to state, so a constraint
the user already knows has to be said out loud to an agent before it can be
remembered, usually after the mistake it would have prevented.

The MCP tool **cannot create a memory**. It can recall, correct, link, archive
and restore, but there is no `remember` action. Two creating paths meant the same
fact arriving by either route, phrased differently, with no way for an agent to
know which had already happened.

### The queue is a table

`memory_extraction_queue` is durable, not a `Map`. Extraction is the only write
path in the feature, so every way of losing an entry costs a conversation that
cannot be recovered — a failed model call, a restart, or a silent drop. Failures
retry with backoff; exhausted entries are marked `failed` and stay visible.

**One row per session**, enforced by a unique index. That is the "bank the oldest
boundary" rule expressed in the schema: a new turn in an already-queued session
merges into the existing row and keeps its `user_message_id`, because the
transcript runs from that message to the end of the chain.

### Secrets

`redact.ts` runs **before** the model sees the transcript. A summariser asked to
record what a turn established will happily quote the API key it was shown, and
by then the secret is in a durable, re-injected, instance-wide store.

---

## Keeping the Graph Honest

| Mechanism | File | What it does |
| --- | --- | --- |
| Belief revision | `revise.ts` | Records that two memories disagree (`contradicts`) |
| Read-time resolution | `context.ts` | Decides which is current, per turn |
| Structural invalidation | `invalidate.ts` | Sets `stale_at` when code a memory is `about` changes |
| Consolidation | `consolidate.ts` | Merges memories stating the same thing |
| Retention | `retention.ts` | Bounds growth; retires unreferenced code entities |
| Reach classification | `judge.ts` | Decides which memories travel between projects |
| Maintenance loop | `maintenance.ts` | Runs the above on a timer |

**Belief revision happens on the READ path.** The write path only notices and
records a disagreement; which memory is current is decided fresh each turn from
who asserted it and how recently, by a rule with no model in it.

Deciding at write time let one model reading one turn retire a rule permanently,
and it did — a task-local exception retired a hand-written standing prohibition
in half the runs of a scripted test, and once in a real graph.

---

## The Embedding Artifact

Semantic recall runs on a **static embedding table** (Model2Vec): embedding a
string is tokenize → look each token's row up → mean-pool → L2-normalize. No
forward pass, so no ONNX, no WASM, no native binary, no API key, no network call
at query time. A query costs ~0.05 ms.

The upstream model (`minishlab/potion-multilingual-128M`, MIT) is 512 MB.
Pruning non-Latin tokens, keeping the 150k most frequent and quantizing each row
to int8 brings it to **44 MB**, holding recall@3 at 91% against the full model's
94%.

It is **not in the repository** — it is weights, not code, and bundling it would
add 44 MB to every install whether or not memory is used. It downloads on demand
from a GitHub release into `~/.clopen/stack/embedding/<version>/`, checksum-
verified per file, written to a `.partial` directory that is renamed only once
complete.

> **Publishing a new artifact version:** see *Publishing the Memory Graph
> Embedding Artifact* in `MAINTAINERS.md`. The checksums in
> `embedding/paths.ts` and the files on the release must move together.

---

## Readiness and Setup

The artifact is a **prerequisite, not an enhancement**. `readiness.ts` splits the
two halves because they have different needs:

| Capability | Needs | Gated? |
| --- | --- | --- |
| **Recall** — injection, MCP `recall` | the embedding artifact | Yes, until installed |
| **Recording** — extraction | an extraction model | Runs during setup |

Recall is gated rather than degraded to BM25 alone: a lexical-only result set is
indistinguishable from a complete one to whatever consumes it, so an agent would
read "no shared keywords" as "nothing was decided" and act on it. The MCP tool
says so explicitly instead of returning an empty list.

Recording is deliberately **not** gated. The turns a user has while a 44 MB
download runs are usually the ones that establish a project; the indexer
backfills their vectors when the artifact lands, so nothing is lost.

**Nothing waits on a settings page.** The extraction model is chosen
automatically (`model.ts`) using the same rule as Settings → Model → Assistant —
the most capable model the default engine offers. It is picked at bootstrap and
again before the first extraction, because the engine catalog is often not loaded
at startup but certainly is by the time a turn has finished. An explicit choice
is never overwritten.

Failures retry with backoff (15s → 45s → 2m → 6m → 15m). A checksum mismatch or
an unpublished release stop instead, because waiting cannot turn the wrong bytes
into the right ones. `MemorySetupBanner.svelte` reports what is missing and
Settings → Infrastructure → Memory has a manual install.

---

## Agent Access (MCP)

One internal MCP server, one tool, eight actions — served over the existing
Streamable HTTP endpoint, so every engine that can consume an MCP URL reaches the
same store with no per-engine work.

| Action | Purpose |
| --- | --- |
| `recall` | Natural-language search; `scope: "all"` searches every project |
| `neighbours` | Walk outward from a node — often where the answer actually is |
| `timeline` | Recent memories in order |
| `update` | Correct a memory in place, keeping its edges and history |
| `link` | Connect two nodes (`supersedes`, `contradicts`, `about`, …) |
| `forget` | Archive a memory that was never true — retired, not deleted |
| `restore` | Undo a `forget` |
| `stats` | Size and composition |

`recall` answers with what **matches**, with expansion off (`expandHops: 0,
precise: true`). Expansion belongs to turn-start injection, where a weak lead is
still worth ranking and the agent never sees the ranking. Asked a direct
question, one hop turns three correct rows into sixty neighbours-of-neighbours
and an agent cannot tell which is which.

An agent's `update` is recorded as `source: 'agent'`. Recording it as the user's
would exempt the node from decay, eviction and consolidation, and advertise it to
every future turn as user-stated — a human's authority for a model's edit.

---

## Configuration

Split across two settings screens on purpose:

- **Settings → Model → Memory** — which model writes memories. The only place
  memory uses a model at all.
- **Settings → Infrastructure → Memory** — what memory does: master switch, record code, record
  memories, auto-recall.

Stored in the `settings` table via `config.ts`. Mutations are admin-only
(`backend/auth/permissions.ts`), matching skills and MCP servers: memory is
instance-global, so one member editing it changes what every agent is told.

Reads are open to any authenticated member — except the cross-project view, which
is admin-only. Memory spans the instance, so "every project at once" would show a
member repositories they have no access to.

---

## Schema

Created by migration `066_create_memory_graph.ts`.

```
graph_nodes              the memories and code entities
graph_edges              typed relations between them
graph_node_entities      subjects a memory is about (an ATTRIBUTE, not nodes)
graph_vectors            one int8 vector per node, 260 bytes at 256 dims
graph_nodes_fts          FTS5 mirror for BM25
memory_extraction_queue  durable queue of turns awaiting summarisation
```

`graph_nodes` groups its columns four ways:

| Group | Columns | Answers |
| --- | --- | --- |
| Identity | `digest`, `digest_version`, `entity_key` | Is this the same memory? |
| Standing | `weight`, `access_count`, `useful_count`, `unhelpful_count`, `pinned` | How much does it matter? |
| Authority & reach | `source`, `asserted_by`, `reach`, `reach_judged` | Whose claim, and where does it apply? |
| Lifecycle | `superseded_by`, `stale_at`, `archived_at` | Is it still current? |

Authority and reach are **four** columns rather than two, deliberately. Each
collapse produced a measured bug: `source` meaning both "which write path" and
"whose claim" let an inference retire what a person typed; `project_id` meaning
both "where learned" and "where it applies" made cross-project recall impossible.

### Relations

```
structural ↔ structural : imports | calls | defines | contains
episodic   ↔ episodic   : caused_by | supersedes | contradicts | generalizes
episodic   → structural : about        ← the bridge between both halves
any        ↔ any        : relates_to   (user-drawn only)
```

`relates_to` is **never** inferred. An automatic similarity linker used to write
it from vector neighbourhoods and fabricated most of the graph: against a corpus
of sentences all shaped "X is a project that does Y", every pair is similar in
shape rather than in subject, so 144 of one graph's 371 edges were pairings like
*"Vantum monorepo phase 1.8"* ↔ *"ChatKit runs on Node.js 18+"*. The fault was
never that they connected memories — it was that **cosine chose which**. Edges are
now derived at read time from the subjects extraction already recorded, and never
stored.

---

## File Map

```
config.ts        settings read/write
readiness.ts     can memory recall / record, and what is missing
model.ts         picks the extraction model when none is set
bootstrap.ts     startup; idempotent, also re-run after Clear All Data

retrieval.ts     BM25 + vector, RRF fusion, spreading activation
context.ts       builds the injected block; standing instructions
view.ts          graph serialization for the UI

extract/
  scheduler.ts   durable queue, retries, concurrency
  episodic.ts    model-driven summarisation of a finished turn
  structural.ts  file/symbol/dependency nodes from the disk diff
  languages.ts   per-language symbol extraction

embedding/
  paths.ts       version, pinned checksums, install location
  install.ts     on-demand download, verification, retry
  embedder.ts    int8 table loading, tokenize + mean-pool
  vector-cache.ts resident vector cache

revise.ts        contradictions, duplicates, entity linking
invalidate.ts    staleness when code changes
consolidate.ts   merges near-duplicates
retention.ts     the bound on growth
judge.ts         reach reclassification
maintenance.ts   the timer that runs the above
compose.ts       hand-written memories
redact.ts        secret removal before the model sees a transcript
indexer.ts       vector backfill
notify.ts        WebSocket broadcasts to open views
```

---

## Testing

Tests run against a real in-memory SQLite database with migration 066 applied,
because most of the behaviour under test **is** SQL — which rows a superseded node
disappears from, which subkinds decay, what retention may touch. A mocked query
layer would assert the test's idea of that SQL rather than the database's.

```bash
bun test backend/memory
```

> **Run test files individually when a result looks surprising.**
> `mock.module` in Bun is process-wide, so a mock in one file follows every file
> that runs after it, and `embedder.load()` in one test can make another test's
> gate pass for the wrong reason. Several files here mock `$backend/database`,
> which leaks into unrelated suites in a full run. Every file in this directory
> passes on its own; that is the signal to trust.

Tests needing the embedding artifact are skipped when it is absent
(`describeIfEmbedding`), so they neither fail nor silently pass on CI.

---

## Design Decisions Worth Knowing

Each of these was reversed at least once, and the reversal is the reason for the
current shape.

**Nothing is a node unless it is a claim.** Canonical entity nodes made 115 of one
graph's 208 episodic nodes bare technology names with empty bodies. A name cannot
agree or disagree with anything, and an empty body means no vector — so a stub
could never be found semantically while still being offered to the model as
something to adjudicate against. Subjects are now rows in `graph_node_entities`,
folded into the FTS text.

**Revision resolves at read time.** See [Keeping the Graph Honest](#keeping-the-graph-honest).

**Retrieval never calls a model.** This is what makes injection on *every* turn
affordable. The moment a read costs a model call, memory becomes something an
agent must decide to use, and it will forget to.

**The digest is SHA-256, not `Bun.hash`.** The hash is persisted as a node's
identity, so it must mean the same thing after a runtime upgrade. `Bun.hash`
documents no cross-version stability guarantee, and a seed change would not fail
loudly — it would silently re-duplicate every memory in the graph.

**The FTS mirror is deleted by rowid.** `graph_nodes_fts.node_id` is `UNINDEXED`,
so `DELETE ... WHERE node_id = ?` is a full scan of the content table — and that
runs on every upsert. One busy turn is roughly fifteen hundred full scans of a
table that only grows. `graph_nodes.fts_rowid` turns each into a primary-key
lookup.

**Bootstrap has no latch.** A `started` flag made `bootstrapMemoryGraph` a no-op
on its second call — which is the call that matters, because "Clear All Data"
re-runs it on the live process after wiping the settings table.
