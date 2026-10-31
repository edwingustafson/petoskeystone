# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`petoskeystone` is a Node.js CLI that procedurally generates images of Petoskey stones (fossil coral *Hexagonaria percarinata*): stylized or photo-real (`raw` / `tumbled` / `polished`), seamless tiles or stone silhouettes, output as PNG / JPEG / JPEG XL / AVIF.

## Commands

TypeScript `.mts` runs directly on Node ≥ 23.6 (built-in type stripping). There is no build step.

```sh
node src/cli.mts --help                      # run the CLI (also: npm start -- <args>)
npm run typecheck                            # tsc --noEmit (TypeScript 7)
npm test                                     # node --test "test/**/*.test.mts"
node --test test/generate.test.mts           # a single test file
node --test --test-name-pattern="seamless" "test/**/*.test.mts"   # tests matching a name
npm run examples                             # regenerate examples/*.jpg and examples/contact-sheet.jpg
```

To check a visual change, render small (for example `--size 700x700 --cell-size 140 --seed 7`) and look at the output image, comparing it against photos of real stones. Tests only check correctness, not appearance.

## Architecture

Pipeline: `cli.mts` → `options.mts` (parse + validate) → `generate.mts` → `render/parallel.mts` → `encode.mts`.

- **Internal resolution.** Everything renders at `width × supersample` by `height × supersample`, and `cellSize` is scaled by the same factor. `encode.mts` downsamples with sharp; for `--repeat` it wrap-pads first, so the resize kernel doesn't make a seam.
- **Determinism is load-bearing.** Worker threads don't receive rendered state; each one rebuilds the same `RenderContext` from the options (`render/context.mts` `createRenderContext`), then renders the row bands it is given. All randomness must therefore come from the seed through `createRng(seed, label)` / `seedInt` (`rng.mts`) with a unique label. Never use `Math.random`. Tests assert byte-identical output for 1 and 4 threads.
- **Tileability.** With `--repeat`, the `Domain` is periodic. All noise must come from `noise.mts` (`noiseLayer` / `fbm` take the domain and wrap their lattice), and anything that reads neighbouring pixels must wrap. Silhouettes are never periodic.
- **Geometry** (`layout.mts`, `fields.mts`):
  - Corallite centers start as a hex lattice, then are jittered and Lloyd-relaxed, with capped per-cell weights. The cells form a **power diagram**, so distances are `|p−s|² − w`.
  - Periodic copies of points are added near the edges.
  - `fields.mts` precomputes per-bucket candidate lists (bounded by the sampled max nearest-seed distance). For each pixel it returns cell id, exact wall (bisector) distance, radius, normalized radius `t`, and angle.
- **Anatomy** (`corallite.mts`). Per-cell traits plus per-pixel masks (`wall`, `septa`, `diss`, `eye`, `radial`), shared by both renderers.
- **Renderers** (`render/`). Both are factories that return row-band functions.
  - Stylized has one phase.
  - Realistic has two: `surface` (albedo + height into shared buffers), then `shade` (normals + lighting). Shading reads neighbouring rows' heights, so there is a barrier between the phases.
  - `render/bands.mts` maps phases to renderers; `render/parallel.mts` hands out row chunks to workers over `SharedArrayBuffer`s, or renders in-process when `threads === 1`.
  - Each finish is defined only by its parameter set in `FINISH_PARAMS` (`render/realistic.mts`); tune looks there.
- **Silhouettes** (`shape.mts`). The anti-aliased coverage mask is drawn with `@napi-rs/canvas` at full resolution. The distance field (used for dome height) and the shadow mask are computed at about 768 px and upsampled bilinearly. Compositing over shadow and background happens in `generate.mts`.
- **Encoding.** sharp handles PNG, JPEG and AVIF. Prebuilt sharp lacks libjxl, so JPEG XL falls back to the `@jsquash/jxl` WASM encoder (`jxlBackend()`).

### Adding a CLI option

1. Add it in `options.mts`: `ARG_SPEC`, `HELP`, the `Options` type, and `resolveOptions` (validation errors throw `UsageError`, which exits with code 2).
2. If renderers need it, add it to the `RenderOptions` `Pick` in `render/context.mts`.
3. Add it to `baseOptions` in `test/helpers.mts`.

Config files (`--config`) use the same keys as the flags.

## Conventions

- The user prefers `const` and array lambdas (`map` / `filter` / `reduce`). The exception is per-pixel hot loops, which use plain indexed `for` loops over typed arrays and reuse mutable sample objects (`newSample`, `newMasks`) to avoid allocating per pixel.
- Colors are mixed in linear light (`palette.mts`); convert to 8-bit with `toSrgb8`.
- Text files in this project are UTF-8 **without** a BOM. This overrides the user's global BOM preference, which they decided doesn't suit this project.
- Keep the current library stack (`sharp`, `@napi-rs/canvas`) unless there's a compelling reason to change.
