# Memory Graph embedding artifact

Local embedding weights for [Clopen](https://clopen.myrialabs.dev)'s Memory Graph.

This directory holds **release assets, not a package**. Clopen downloads these
files from a GitHub release into `~/.clopen/stack/embedding/<version>/` and reads
them directly; nothing here is imported or published to npm.

## Why it exists

Clopen's Memory Graph retrieves memories with BM25 and vector similarity
together. The vector half has to work with no API key, no network call at query
time and no native binary — so it uses a *static* embedding model, where
inference is a token → vector lookup plus mean pooling rather than a neural
forward pass.

The upstream model is [`minishlab/potion-multilingual-128M`](https://huggingface.co/minishlab/potion-multilingual-128M)
(MIT), a [Model2Vec](https://github.com/MinishLab/model2vec) distillation of
`BAAI/bge-m3` covering 101 languages. Published, its lookup table is
500,353 × 256 float32 — 512 MB, far too heavy to hand to every user.

These files are that table reduced ~12×: non-Latin-script tokens dropped, the
150,000 highest-frequency survivors kept, each row quantized to int8 with its own
scale. On a 32-document / 35-query Indonesian→English retrieval set it holds
recall@3 at 91% against the full model's 94%.

## Cutting a release

```sh
bun scripts/build-embedding-artifact.ts          # build into model/
bun scripts/build-embedding-artifact.ts --install  # …and install locally for dev
```

The script prints the `EMBEDDING_ASSETS` block (file names, SHA-256, sizes).
Paste it into `backend/memory/embedding/paths.ts`, then upload the four files in
`model/` to a GitHub release tagged `embedding-v<version>`.

Until those checksums are pinned the runtime refuses to download — verifying
against an empty hash would be verification theatre — and retrieval stays lexical.

## Contents

| File | Purpose |
| --- | --- |
| `model.bin` | int8 lookup table — magic `CLPEMB\0`, `rows` u32, `dim` u32, `scales` f32[rows], `quant` i8[rows × dim], little-endian |
| `tokenizer.json` | Unigram tokenizer rebuilt over the pruned vocabulary, so token ids index rows directly |
| `tokenizer_config.json` | Upstream tokenizer configuration |
| `manifest.json` | Row/dimension counts, quantization scheme and provenance |

## Licensing

MIT, matching the upstream model weights.
