/**
 * Tool description. The agent reads this once per session, so it has to explain
 * not just the actions but WHEN reaching for the graph beats guessing — and, just
 * as importantly, that it does not have to write anything.
 */

export const memoryToolDescription = `Query and curate Clopen's Memory Graph — a persistent store of what has been decided, tried and learned across past sessions of this workspace, plus a map of the codebase those memories attach to. It is shared by every AI engine and survives session switches, so a memory written months ago by a different model is still here.

YOU DO NOT NEED TO RECORD ANYTHING. Memories are written automatically from each finished conversation turn, including anything the user asks you to remember — saying "remember that I prefer X" is enough on its own, and there is deliberately no action here that stores a new memory. That is one write path rather than two, so what ends up in the graph is predictable. This tool is for reading it and for correcting what is already there.

Reach for it when:
- you are about to make an architectural choice, and an earlier session may already have made it (and rejected alternatives you are about to re-propose)
- something is failing in a way that feels like it has failed before
- you need to know why code looks the way it does, when the code itself does not say
- the user refers to a past discussion, decision or preference
- you want to know what a file or module is connected to before changing it
- a memory you were shown is wrong, out of date, or filed under the wrong kind

Relevant memories are already prepended to each turn automatically, so this tool is for going DEEPER than that: following up on something you have just discovered, asking about another project, or walking the graph. It is not a substitute for reading what you were given.

Actions:
- recall — natural-language search across memories and code entities. Runs keyword and semantic search together and expands into the graph, so it finds paraphrases as well as exact names. Use scope "all" to search every project, which is how you find that a problem was already solved in another repository.
- neighbours — walk outward from a node returned by recall. This is where the graph earns its keep: the memory you need is often adjacent to your match rather than being it.
- timeline — recent memories in order, for "what have we been doing here".
- update — correct a memory in place. Prefer this whenever an existing memory is nearly right: it keeps the node's connections and its history, where retiring it and letting a new one be written loses both.
- link — connect two nodes. Use "supersedes" when a memory replaces an older one and "contradicts" when two disagree and you cannot tell which is right.
- forget — archive a memory that was never true. It is retired from search, not deleted, so the reasoning trail survives and the user can restore it.
- restore — bring an archived memory back, when it was retired in error.
- stats — size and composition of the graph.

Forgetting and superseding are different claims and worth getting right. "forget" says a memory was WRONG. "supersedes" says it was true and has since been REPLACED — the old one stops being recalled but stays one hop from the new one, so the history of a decision remains answerable. Reach for supersedes whenever something changed rather than was mistaken.

Batch independent operations into one call. Each memory returned carries an id, its kind, how it was found, and how confident the writer was — treat low confidence as a lead, not a fact, and trust the current code over any memory that disagrees with it.`;
