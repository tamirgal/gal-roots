# Family Tree Graph View — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the default Quartz graph view with a family-tree-focused version that shows typed relationships, supports search, and provides depth/direction controls.

**Architecture:** A new `FamilyIndex` emitter plugin emits `static/familyIndex.json` with typed family relationships extracted from person note frontmatter. A new `FamilyGraph` component (TSX + Pixi.js/D3) replaces the default `Graph` in the layout and consumes this data. The original `Graph` stays in the codebase.

**Tech Stack:** TypeScript, D3.js (force simulation), Pixi.js (WebGPU/WebGL rendering), Quartz plugin system

**Spec:** `docs/superpowers/specs/2026-03-15-family-graph-design.md`

---

## Task 1: FamilyIndex Emitter Plugin

Create the build-time plugin that scans person note frontmatter and emits `static/familyIndex.json`.

**Files:**
- Create: `website/quartz/plugins/emitters/familyIndex.tsx`
- Modify: `website/quartz/plugins/emitters/index.ts` (add export)

**Step 1: Create the emitter plugin**

Create `website/quartz/plugins/emitters/familyIndex.tsx`:

```typescript
import { FullSlug, SimpleSlug, joinSegments, simplifySlug } from "../../util/path"
import { QuartzEmitterPlugin } from "../types"
import { write } from "./helpers"

export interface FamilyEntry {
  name: string
  aliases: string[]
  sex?: string
  born?: string
  father: SimpleSlug | null
  mother: SimpleSlug | null
  spouses: SimpleSlug[]
  children: SimpleSlug[]
}

export type FamilyIndexMap = Record<SimpleSlug, FamilyEntry>

function extractSlug(wikilink: unknown): SimpleSlug | null {
  if (typeof wikilink !== "string") return null
  const match = wikilink.match(/\[\[([^\]|]+)/)
  if (!match) return null
  return simplifySlug(match[1].trim() as FullSlug)
}

export const FamilyIndex: QuartzEmitterPlugin = () => ({
  name: "FamilyIndex",
  async *emit(ctx, content) {
    const familyIndex: FamilyIndexMap = {}

    for (const [_tree, file] of content) {
      const fm = file.data.frontmatter
      if (!fm || !fm["cr_id"]) continue

      const slug = simplifySlug(file.data.slug!)
      const name = (fm["name"] as string) ?? slug
      const aliases = (fm["aliases"] as string[]) ?? []
      const sex = fm["sex"] as string | undefined
      const born = fm["born"] as string | undefined

      const father = extractSlug(fm["father"])
      const mother = extractSlug(fm["mother"])

      const spouses: SimpleSlug[] = []
      for (let i = 1; i <= 5; i++) {
        const sp = extractSlug(fm[`spouse${i}`])
        if (sp) spouses.push(sp)
      }

      const childrenRaw = fm["children"]
      const children: SimpleSlug[] = []
      if (Array.isArray(childrenRaw)) {
        for (const c of childrenRaw) {
          const cs = extractSlug(c)
          if (cs) children.push(cs)
        }
      }

      familyIndex[slug] = { name, aliases, sex, born, father, mother, spouses, children }
    }

    const fp = joinSegments("static", "familyIndex") as FullSlug
    yield write({
      ctx,
      content: JSON.stringify(familyIndex),
      slug: fp,
      ext: ".json",
    })
  },
})
```

**Step 2: Export from emitters index**

Modify `website/quartz/plugins/emitters/index.ts` — add this line:

```typescript
export { FamilyIndex } from "./familyIndex"
```

**Step 3: Register in quartz.config.ts**

Modify `website/quartz.config.ts` — add `Plugin.FamilyIndex()` to the `emitters` array, after `Plugin.ContentIndex(...)`:

```typescript
Plugin.FamilyIndex(),
```

**Step 4: Build and verify the index is emitted**

Run:
```bash
cd ~/git/gal-roots/website && node quartz/bootstrap-cli.mjs build 2>&1 | tail -3
```
Expected: build succeeds, no errors.

Then verify the JSON file exists and has content:
```bash
cat website/public/static/familyIndex.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{len(d)} entries'); e=list(d.values())[0]; print(json.dumps(e,indent=2))"
```
Expected: ~960 entries, a valid family entry with name, father, mother, spouses, children.

**Step 5: Commit**

```bash
git add website/quartz/plugins/emitters/familyIndex.tsx website/quartz/plugins/emitters/index.ts website/quartz.config.ts
git commit -m "feat: add FamilyIndex emitter plugin"
```

---

## Task 2: FamilyGraph Component Shell

Create the TSX component and SCSS styles. This is the HTML structure only — no rendering logic yet.

**Files:**
- Create: `website/quartz/components/FamilyGraph.tsx`
- Create: `website/quartz/components/styles/familygraph.scss`
- Modify: `website/quartz/components/index.ts` (add export)

**Step 1: Create the TSX component**

Create `website/quartz/components/FamilyGraph.tsx`:

```typescript
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
// @ts-ignore
import script from "./scripts/familygraph.inline"
import style from "./styles/familygraph.scss"
import { i18n } from "../i18n"
import { classNames } from "../util/lang"

export interface FamilyGraphConfig {
  drag: boolean
  zoom: boolean
  depth: number
  direction: "up" | "down" | "both"
  scale: number
  repelForce: number
  centerForce: number
  linkDistance: number
  fontSize: number
  opacityScale: number
  focusOnHover: boolean
}

interface FamilyGraphOptions {
  localGraph: Partial<FamilyGraphConfig>
  globalGraph: Partial<FamilyGraphConfig>
}

const defaultOptions: FamilyGraphOptions = {
  localGraph: {
    drag: true,
    zoom: true,
    depth: 1,
    direction: "both",
    scale: 1.1,
    repelForce: 0.5,
    centerForce: 0.3,
    linkDistance: 30,
    fontSize: 0.6,
    opacityScale: 1,
    focusOnHover: false,
  },
  globalGraph: {
    drag: true,
    zoom: true,
    depth: 2,
    direction: "both",
    scale: 0.9,
    repelForce: 0.5,
    centerForce: 0.2,
    linkDistance: 30,
    fontSize: 0.6,
    opacityScale: 1,
    focusOnHover: true,
  },
}

export default ((opts?: Partial<FamilyGraphOptions>) => {
  const FamilyGraph: QuartzComponent = ({ displayClass, cfg }: QuartzComponentProps) => {
    const localGraph = { ...defaultOptions.localGraph, ...opts?.localGraph }
    const globalGraph = { ...defaultOptions.globalGraph, ...opts?.globalGraph }
    return (
      <div class={classNames(displayClass, "family-graph")}>
        <h3>{i18n(cfg.locale).components.graph.title}</h3>
        <div class="family-graph-outer">
          <div class="family-graph-container" data-cfg={JSON.stringify(localGraph)}></div>
          <button class="global-graph-icon" aria-label="Family Tree Explorer">
            <svg
              version="1.1"
              xmlns="http://www.w3.org/2000/svg"
              xmlnsXlink="http://www.w3.org/1999/xlink"
              x="0px"
              y="0px"
              viewBox="0 0 55 55"
              fill="currentColor"
              xmlSpace="preserve"
            >
              <path
                d="M49,0c-3.309,0-6,2.691-6,6c0,1.035,0.263,2.009,0.726,2.86l-9.829,9.829C32.542,17.634,30.846,17,29,17
                s-3.542,0.634-4.898,1.688l-7.669-7.669C16.785,10.424,17,9.74,17,9c0-2.206-1.794-4-4-4S9,6.794,9,9s1.794,4,4,4
                c0.74,0,1.424-0.215,2.019-0.567l7.669,7.669C21.634,21.458,21,23.154,21,25s0.634,3.542,1.688,4.897L10.024,42.562
                C8.958,41.595,7.549,41,6,41c-3.309,0-6,2.691-6,6s2.691,6,6,6s6-2.691,6-6c0-1.035-0.263-2.009-0.726-2.86l12.829-12.829
                c1.106,0.86,2.44,1.436,3.898,1.619v10.16c-2.833,0.478-5,2.942-5,5.91c0,3.309,2.691,6,6,6s6-2.691,6-6c0-2.967-2.167-5.431-5-5.91
                v-10.16c1.458-0.183,2.792-0.759,3.898-1.619l7.669,7.669C41.215,39.576,41,40.26,41,41c0,2.206,1.794,4,4,4s4-1.794,4-4
                s-1.794-4-4-4c-0.74,0-1.424,0.215-2.019,0.567l-7.669-7.669C36.366,28.542,37,26.846,37,25s-0.634-3.542-1.688-4.897l9.665-9.665
                C46.042,11.405,47.451,12,49,12c3.309,0,6-2.691,6-6S52.309,0,49,0z M11,9c0-1.103,0.897-2,2-2s2,0.897,2,2s-0.897,2-2,2
                S11,10.103,11,9z M6,51c-2.206,0-4-1.794-4-4s1.794-4,4-4s4,1.794,4,4S8.206,51,6,51z M33,49c0,2.206-1.794,4-4,4s-4-1.794-4-4
                s1.794-4,4-4S33,46.794,33,49z M29,31c-3.309,0-6-2.691-6-6s2.691-6,6-6s6,2.691,6,6S32.309,31,29,31z M47,41c0,1.103-0.897,2-2,2
                s-2-0.897-2-2s0.897-2,2-2S47,39.897,47,41z M49,10c-2.206,0-4-1.794-4-4s1.794-4,4-4s4,1.794,4,4S51.206,10,49,10z"
              />
            </svg>
          </button>
        </div>
        <div class="global-graph-outer">
          <div class="global-graph-toolbar">
            <input
              type="text"
              class="family-search"
              placeholder="Search person..."
              aria-label="Search family tree"
            />
            <div class="family-controls">
              <label>
                Depth
                <select class="family-depth">
                  <option value="1">1</option>
                  <option value="2" selected>2</option>
                  <option value="3">3</option>
                  <option value="4">4</option>
                  <option value="5">5</option>
                </select>
              </label>
              <div class="family-direction" role="group" aria-label="Direction">
                <button class="dir-btn" data-dir="up" title="Ancestors">↑</button>
                <button class="dir-btn active" data-dir="both" title="Both">↕</button>
                <button class="dir-btn" data-dir="down" title="Descendants">↓</button>
              </div>
            </div>
          </div>
          <div class="global-graph-container" data-cfg={JSON.stringify(globalGraph)}></div>
        </div>
      </div>
    )
  }

  FamilyGraph.css = style
  FamilyGraph.afterDOMLoaded = script

  return FamilyGraph
}) satisfies QuartzComponentConstructor
```

**Step 2: Create the SCSS styles**

Create `website/quartz/components/styles/familygraph.scss`:

```scss
@use "../../styles/variables.scss" as *;

:root {
  --family-descendant: #5a8a5a;
  --family-spouse: #c76b8f;
}

[saved-theme="dark"] {
  --family-descendant: #7ab37a;
  --family-spouse: #e08aaa;
}

.family-graph {
  & > h3 {
    font-size: 1rem;
    margin: 0;
  }

  & > .family-graph-outer {
    border-radius: 5px;
    border: 1px solid var(--lightgray);
    box-sizing: border-box;
    height: 250px;
    margin: 0.5em 0;
    position: relative;
    overflow: hidden;

    & > .global-graph-icon {
      cursor: pointer;
      background: none;
      border: none;
      color: var(--dark);
      opacity: 0.5;
      width: 24px;
      height: 24px;
      position: absolute;
      padding: 0.2rem;
      margin: 0.3rem;
      top: 0;
      right: 0;
      border-radius: 4px;
      background-color: transparent;
      transition: background-color 0.5s ease;
      &:hover {
        background-color: var(--lightgray);
      }
    }
  }

  & > .global-graph-outer {
    position: fixed;
    z-index: 9999;
    left: 0;
    top: 0;
    width: 100vw;
    height: 100%;
    backdrop-filter: blur(4px);
    display: none;
    overflow: hidden;

    &.active {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    & > .global-graph-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      background: var(--light);
      border: 1px solid var(--lightgray);
      border-radius: 5px;
      margin-top: calc(10vh + 8px);
      z-index: 10000;
      width: fit-content;
      max-width: 80vw;
      flex-shrink: 0;

      .family-search {
        padding: 4px 8px;
        border: 1px solid var(--lightgray);
        border-radius: 4px;
        background: var(--light);
        color: var(--dark);
        font-size: 0.85rem;
        width: 180px;
        outline: none;
        &:focus {
          border-color: var(--secondary);
        }
      }

      .family-controls {
        display: flex;
        align-items: center;
        gap: 10px;

        label {
          font-size: 0.8rem;
          color: var(--darkgray);
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .family-depth {
          padding: 2px 4px;
          border: 1px solid var(--lightgray);
          border-radius: 4px;
          background: var(--light);
          color: var(--dark);
          font-size: 0.8rem;
        }

        .family-direction {
          display: flex;
          gap: 2px;

          .dir-btn {
            padding: 2px 8px;
            border: 1px solid var(--lightgray);
            border-radius: 4px;
            background: var(--light);
            color: var(--darkgray);
            cursor: pointer;
            font-size: 0.85rem;
            transition: all 0.15s ease;

            &.active {
              background: var(--secondary);
              color: var(--light);
              border-color: var(--secondary);
            }

            &:hover:not(.active) {
              background: var(--lightgray);
            }
          }
        }
      }
    }

    & > .global-graph-container {
      border: 1px solid var(--lightgray);
      background-color: var(--light);
      border-radius: 5px;
      box-sizing: border-box;
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      height: 80vh;
      width: 80vw;

      @media all and not ($desktop) {
        width: 90%;
      }
    }
  }

  .family-search-results {
    position: absolute;
    top: 100%;
    left: 0;
    width: 180px;
    max-height: 250px;
    overflow-y: auto;
    background: var(--light);
    border: 1px solid var(--lightgray);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    z-index: 10001;
    display: none;

    &.active {
      display: block;
    }

    .search-result-item {
      padding: 6px 10px;
      cursor: pointer;
      font-size: 0.8rem;
      color: var(--dark);
      border-bottom: 1px solid var(--lightgray);

      &:last-child {
        border-bottom: none;
      }

      &:hover,
      &.focused {
        background: var(--lightgray);
      }
    }
  }
}
```

**Step 3: Export from components index**

Modify `website/quartz/components/index.ts` — add import and export:

After the existing `import Graph from "./Graph"` line, add:
```typescript
import FamilyGraph from "./FamilyGraph"
```

In the export block, after `Graph,` add:
```typescript
FamilyGraph,
```

**Step 4: Create a placeholder inline script**

Create `website/quartz/components/scripts/familygraph.inline.ts` with a minimal placeholder so the build doesn't fail:

```typescript
document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  // placeholder — full implementation in Task 3
})
```

**Step 5: Build to verify TSX/SCSS compiles**

Run:
```bash
cd ~/git/gal-roots/website && node quartz/bootstrap-cli.mjs build 2>&1 | tail -3
```
Expected: build succeeds.

**Step 6: Commit**

```bash
git add website/quartz/components/FamilyGraph.tsx website/quartz/components/styles/familygraph.scss website/quartz/components/scripts/familygraph.inline.ts website/quartz/components/index.ts
git commit -m "feat: add FamilyGraph component shell and styles"
```

---

## Task 3: Family Graph Rendering Script

The main implementation — fork `graph.inline.ts` and modify for family-specific data, edge styles, toolbar interaction, and dual click behavior.

**Files:**
- Modify: `website/quartz/components/scripts/familygraph.inline.ts` (replace placeholder)

This is the largest task. The script is ~500 lines. Key differences from the original `graph.inline.ts`:

**Step 1: Write the data loading and traversal logic**

Replace the placeholder in `website/quartz/components/scripts/familygraph.inline.ts`. The full script follows the structure of `graph.inline.ts` (reference: `website/quartz/components/scripts/graph.inline.ts`) with these changes:

**Data loading:** Instead of `await fetchData` (which loads `contentIndex.json`), fetch `familyIndex.json`:

```typescript
import type { FamilyEntry, FamilyIndexMap } from "../../plugins/emitters/familyIndex"
// ...

const baseUrl = document.body.dataset.slug
  ? new URL(document.location.href).pathname.replace(/[^/]*$/, "")
  : "/"
const familyIndexUrl = `${baseUrl}static/familyIndex.json`
let familyDataPromise: Promise<FamilyIndexMap> | null = null
function getFamilyData(): Promise<FamilyIndexMap> {
  if (!familyDataPromise) {
    familyDataPromise = fetch(familyIndexUrl).then((r) => r.json())
  }
  return familyDataPromise
}
```

**BFS traversal** — new function that replaces the generic neighbourhood computation:

```typescript
type Direction = "up" | "down" | "both"

function buildFamilyNeighbourhood(
  data: FamilyIndexMap,
  center: SimpleSlug,
  depth: number,
  direction: Direction,
): Set<SimpleSlug> {
  const visited = new Set<SimpleSlug>()
  const queue: { slug: SimpleSlug; gen: number }[] = [{ slug: center, gen: 0 }]
  visited.add(center)

  while (queue.length > 0) {
    const { slug, gen } = queue.shift()!
    if (gen >= depth) continue
    const entry = data[slug]
    if (!entry) continue

    const neighbours: SimpleSlug[] = []

    if (direction === "up" || direction === "both") {
      if (entry.father && data[entry.father]) neighbours.push(entry.father)
      if (entry.mother && data[entry.mother]) neighbours.push(entry.mother)
    }

    if (direction === "down" || direction === "both") {
      for (const child of entry.children) {
        if (data[child]) neighbours.push(child)
      }
    }

    // spouses are always included
    for (const sp of entry.spouses) {
      if (data[sp]) neighbours.push(sp)
    }

    for (const n of neighbours) {
      if (!visited.has(n)) {
        visited.add(n)
        queue.push({ slug: n, gen: gen + 1 })
      }
    }
  }

  return visited
}
```

**Link building** — builds typed links from the family index:

```typescript
type FamilyLinkType = "parent-child" | "spouse"

type FamilyLinkData = {
  source: SimpleSlug
  target: SimpleSlug
  type: FamilyLinkType
}

function buildFamilyLinks(data: FamilyIndexMap, neighbourhood: Set<SimpleSlug>): FamilyLinkData[] {
  const links: FamilyLinkData[] = []
  const seen = new Set<string>()

  for (const slug of neighbourhood) {
    const entry = data[slug]
    if (!entry) continue

    if (entry.father && neighbourhood.has(entry.father)) {
      const key = `pc:${entry.father}:${slug}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push({ source: entry.father, target: slug, type: "parent-child" })
      }
    }

    if (entry.mother && neighbourhood.has(entry.mother)) {
      const key = `pc:${entry.mother}:${slug}`
      if (!seen.has(key)) {
        seen.add(key)
        links.push({ source: entry.mother, target: slug, type: "parent-child" })
      }
    }

    for (const sp of entry.spouses) {
      if (neighbourhood.has(sp)) {
        const canonical = [slug, sp].sort().join(":")
        const key = `sp:${canonical}`
        if (!seen.has(key)) {
          seen.add(key)
          links.push({ source: slug, target: sp, type: "spouse" })
        }
      }
    }
  }

  return links
}
```

**Node coloring** — based on relationship to center:

```typescript
function computeGenerations(
  data: FamilyIndexMap,
  center: SimpleSlug,
  neighbourhood: Set<SimpleSlug>,
): Map<SimpleSlug, number> {
  // BFS from center, tracking generation depth (negative = ancestor, positive = descendant)
  const gens = new Map<SimpleSlug, number>()
  gens.set(center, 0)
  const queue: SimpleSlug[] = [center]

  while (queue.length > 0) {
    const slug = queue.shift()!
    const gen = gens.get(slug)!
    const entry = data[slug]
    if (!entry) continue

    // parents = gen - 1
    for (const parent of [entry.father, entry.mother]) {
      if (parent && neighbourhood.has(parent) && !gens.has(parent)) {
        gens.set(parent, gen - 1)
        queue.push(parent)
      }
    }

    // children = gen + 1
    for (const child of entry.children) {
      if (neighbourhood.has(child) && !gens.has(child)) {
        gens.set(child, gen + 1)
        queue.push(child)
      }
    }

    // spouses = same gen
    for (const sp of entry.spouses) {
      if (neighbourhood.has(sp) && !gens.has(sp)) {
        gens.set(sp, gen)
        queue.push(sp)
      }
    }
  }

  return gens
}

function nodeColor(
  slug: SimpleSlug,
  center: SimpleSlug,
  gens: Map<SimpleSlug, number>,
  spouseSlugs: Set<SimpleSlug>,
  css: Record<string, string>,
): string {
  if (slug === center) return css["--secondary"]
  const gen = gens.get(slug) ?? 0
  if (spouseSlugs.has(slug)) return css["--family-spouse"]
  if (gen < 0) return css["--tertiary"]
  if (gen > 0) return css["--family-descendant"]
  return css["--gray"]
}
```

**Step 2: Write the renderFamilyGraph function**

This follows the exact same pattern as the existing `renderGraph` function in `graph.inline.ts`. Copy the full structure (Pixi app init, containers, node/link creation loop, force simulation, drag, zoom, hover, animation loop) and modify:

1. Replace `data` loading with `getFamilyData()`
2. Replace neighbourhood computation with `buildFamilyNeighbourhood()`
3. Replace link extraction with `buildFamilyLinks()`
4. Color nodes using `nodeColor()`
5. Style links: spouse edges use dashed pattern, parent-child use solid
6. Add `forceY` for generational bias: `forceY((d) => genMap.get(d.id)! * 60).strength(0.15)`
7. Add shorter `linkDistance` for spouse links
8. In the sidebar (depth >= 0): click navigates (same as original)
9. In the global graph (depth < 0 OR isGlobal flag): click recenters, double-click navigates

For link rendering, the key difference is dashed vs solid:

```typescript
// In the animation loop, when drawing links:
for (const l of linkRenderData) {
  const linkData = l.simulationData
  l.gfx.clear()
  if (l.linkType === "spouse") {
    // dashed line
    drawDashedLine(l.gfx, 
      linkData.source.x! + width / 2, linkData.source.y! + height / 2,
      linkData.target.x! + width / 2, linkData.target.y! + height / 2,
      { alpha: l.alpha, width: 1.5, color: l.color, dashLength: 6, gapLength: 4 }
    )
  } else {
    l.gfx.moveTo(linkData.source.x! + width / 2, linkData.source.y! + height / 2)
    l.gfx
      .lineTo(linkData.target.x! + width / 2, linkData.target.y! + height / 2)
      .stroke({ alpha: l.alpha, width: 1, color: l.color })
  }
}
```

Helper for dashed lines (Pixi.js doesn't have native dash support):

```typescript
function drawDashedLine(
  gfx: Graphics,
  x1: number, y1: number, x2: number, y2: number,
  opts: { alpha: number; width: number; color: string; dashLength: number; gapLength: number },
) {
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.sqrt(dx * dx + dy * dy)
  const ux = dx / dist
  const uy = dy / dist
  let pos = 0
  let drawing = true

  gfx.moveTo(x1, y1)
  while (pos < dist) {
    const segLen = drawing ? opts.dashLength : opts.gapLength
    const next = Math.min(pos + segLen, dist)
    const nx = x1 + ux * next
    const ny = y1 + uy * next
    if (drawing) {
      gfx.moveTo(x1 + ux * pos, y1 + uy * pos)
      gfx.lineTo(nx, ny).stroke({ alpha: opts.alpha, width: opts.width, color: opts.color })
    }
    pos = next
    drawing = !drawing
  }
}
```

**Step 3: Wire up the toolbar (global graph only)**

In the global graph event handler section:

```typescript
// Search
const searchInput = container.querySelector(".family-search") as HTMLInputElement
const searchWrapper = searchInput?.parentElement
let resultsContainer: HTMLDivElement | null = null

if (searchInput && searchWrapper) {
  searchWrapper.style.position = "relative"
  resultsContainer = document.createElement("div")
  resultsContainer.className = "family-search-results"
  searchWrapper.appendChild(resultsContainer)

  searchInput.addEventListener("input", () => {
    const term = searchInput.value.toLowerCase().trim()
    if (!term) {
      resultsContainer!.classList.remove("active")
      return
    }

    const matches = Object.entries(familyData)
      .filter(([_, entry]) =>
        entry.name.toLowerCase().includes(term) ||
        entry.aliases.some((a) => a.includes(term))
      )
      .slice(0, 8)

    resultsContainer!.innerHTML = matches
      .map(([slug, entry]) => `<div class="search-result-item" data-slug="${slug}">${entry.name}</div>`)
      .join("")
    resultsContainer!.classList.add("active")

    resultsContainer!.querySelectorAll(".search-result-item").forEach((el) => {
      el.addEventListener("click", () => {
        const targetSlug = (el as HTMLElement).dataset.slug as SimpleSlug
        recenterGraph(targetSlug)
        searchInput.value = ""
        resultsContainer!.classList.remove("active")
      })
    })
  })
}

// Depth control
const depthSelect = container.querySelector(".family-depth") as HTMLSelectElement
depthSelect?.addEventListener("change", () => {
  currentDepth = parseInt(depthSelect.value)
  rebuildGraph()
})

// Direction toggle
const dirButtons = container.querySelectorAll(".dir-btn")
dirButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    dirButtons.forEach((b) => b.classList.remove("active"))
    btn.classList.add("active")
    currentDirection = (btn as HTMLElement).dataset.dir as Direction
    rebuildGraph()
  })
})
```

The `recenterGraph(slug)` and `rebuildGraph()` functions destroy the current Pixi app and re-call `renderFamilyGraph()` with the new center/depth/direction. Same pattern as the theme change handler in the original graph.

**Step 4: Handle non-person pages**

At the top of the nav event handler, check if the current slug is in the family index:

```typescript
const familyData = await getFamilyData()
const currentSlug = simplifySlug(slug)

// Hide sidebar graph on non-person pages
const sidebarContainers = document.getElementsByClassName("family-graph-container")
for (const container of sidebarContainers) {
  const parent = container.closest(".family-graph") as HTMLElement
  if (!familyData[currentSlug]) {
    if (parent) parent.style.display = "none"
    return
  } else {
    if (parent) parent.style.display = ""
  }
}
```

**Step 5: Handle theme changes**

Same pattern as original graph — re-render on `themechange`:

```typescript
const handleThemeChange = () => {
  void renderLocalFamilyGraph()
}
document.addEventListener("themechange", handleThemeChange)
window.addCleanup(() => document.removeEventListener("themechange", handleThemeChange))
```

**Step 6: Build and visually verify**

First, swap to FamilyGraph in the layout. Modify `website/quartz.layout.ts` line 44:

Change:
```typescript
Component.Graph(),
```
To:
```typescript
Component.FamilyGraph(),
```

Then build and preview:
```bash
cd ~/git/gal-roots && bash scripts/build_website.sh 2>&1 | tail -5
cd website/public && npx serve@14 -p 9090
```

Open http://localhost:9090/People/Elie-Patan and verify:
- Sidebar shows a family graph (not the generic link graph)
- Nodes are connected by family relationships
- Spouse edges are dashed
- Clicking the global icon opens the explorer
- Search works
- Depth/direction controls work
- Click recenters in explorer, double-click navigates
- Sidebar click navigates
- Non-person pages (e.g. http://localhost:9090/) hide the sidebar graph

**Step 7: Commit**

```bash
git add website/quartz/components/scripts/familygraph.inline.ts website/quartz.layout.ts
git commit -m "feat: implement family graph rendering with search and controls"
```

---

## Task 4: Inject familyIndex fetch into page resources

The current `fetchData` global is set up in `renderPage.tsx` and points to `contentIndex.json`. The family graph needs its own fetch. Rather than modifying `renderPage.tsx`, the family graph script builds the URL from `document.location` (see Task 3 Step 1). However, for consistency with how Quartz handles the base URL (especially under `/gal-roots/` subpath), it's safer to inject the URL via a data attribute.

**Files:**
- Modify: `website/quartz/components/FamilyGraph.tsx`

**Step 1: Pass the family index path via data attribute**

In `FamilyGraph.tsx`, modify the containers to include a data attribute for the base path. The component receives `fileData` from props — use it to compute the path:

Add to the component function, after the config destructuring:
```typescript
const FamilyGraph: QuartzComponent = ({ displayClass, cfg, fileData }: QuartzComponentProps) => {
```

No further changes needed — the inline script derives the URL from `document.location.pathname` which already includes the `/gal-roots/` base path.

**Step 2: Verify subpath works**

Build and check that `familyIndex.json` is fetched correctly by checking the browser console at http://localhost:9090/People/Elie-Patan — no 404 on the fetch.

**Step 3: Commit** (if any changes were needed)

```bash
git add website/quartz/components/FamilyGraph.tsx
git commit -m "fix: ensure familyIndex fetch works under subpath deployment"
```

---

## Task 5: Full Build and Smoke Test

**Files:** None (verification only)

**Step 1: Full build from clean state**

```bash
cd ~/git/gal-roots && bash scripts/build_website.sh 2>&1 | tail -5
```
Expected: build succeeds, ~3970+ files emitted.

**Step 2: Verify familyIndex.json**

```bash
python3 -c "import json; d=json.load(open('website/public/static/familyIndex.json')); print(f'{len(d)} people'); e=d.get('People/Elie-Patan',{}); print(json.dumps(e,indent=2,ensure_ascii=False))"
```
Expected: ~960 people, Elie Patan entry with correct family data.

**Step 3: Visual smoke test**

```bash
cd ~/git/gal-roots/website/public && npx serve@14 -p 9090
```

Check these pages:
- `http://localhost:9090/People/Elie-Patan` — sidebar graph shows, family connections visible
- `http://localhost:9090/` — no sidebar graph (non-person page)
- `http://localhost:9090/People/Joseph-Goldstein-Gal` — open global graph, search "תמיר", verify Tamir Gal appears
- Global graph: change depth to 3, verify more nodes appear
- Global graph: toggle direction to ↑ (ancestors only), verify only ancestors shown

**Step 4: Commit everything**

```bash
git add -A
git commit -m "feat: complete family tree graph view"
```

**Step 5: Push**

```bash
git push
```
