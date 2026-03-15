# Family Tree Graph View — Design Spec

## Overview

A family-tree-focused graph view for the Charted Roots Quartz website. Replaces the default Quartz graph with a family-aware version that filters to family relationships only, styles edges by relationship type, and provides search, depth, and direction controls. The original Graph component remains in the codebase for easy swap-back.

## Goals

- Show family relationships (parent-child, spouse) with distinct visual styles
- Provide search to find and center on any person (English or Hebrew name)
- Let the user control how many generations are visible and in which direction
- Maintain the look, feel, and responsiveness of the existing Quartz graph (D3 + Pixi.js)

## Architecture

### New Files

| File | Type | Purpose |
|---|---|---|
| `quartz/plugins/emitters/familyIndex.tsx` | Emitter plugin | Scans person note frontmatter at build time, emits `static/familyIndex.json` |
| `quartz/components/FamilyGraph.tsx` | Component | TSX shell — renders container divs, toolbar HTML, passes config as data attributes |
| `quartz/components/scripts/familygraph.inline.ts` | Client script | D3 + Pixi.js rendering, forked from `graph.inline.ts` |
| `quartz/components/styles/familygraph.scss` | Styles | Toolbar, search dropdown, edge legend |

### Config Changes

**`quartz.layout.ts`** (component swap):
- Replace `Component.Graph()` with `Component.FamilyGraph()` in `defaultContentPageLayout.right` (line 44)
- The original `Graph.tsx` stays in the codebase — swapping back is a one-line change

**`quartz.config.ts`** (plugin registration):
- Add `Plugin.FamilyIndex()` to the plugins list

**`quartz/components/index.ts`** (component export):
- Export `FamilyGraph` so it's available as `Component.FamilyGraph()`

### Data Flow

```
Build time:  person note frontmatter → FamilyIndex plugin → static/familyIndex.json
Runtime:     familygraph.inline.ts fetches familyIndex.json → builds D3 graph → Pixi.js renders
```

## Family Index

### Emitter Plugin: `FamilyIndex`

Iterates over all content files at build time. For each file whose frontmatter contains a `cr_id` field (person notes only), it extracts relationship fields and emits a single JSON file.

**Output:** `static/familyIndex.json`

### Schema

```json
{
  "People/Elie-Patan": {
    "name": "Elie Patan",
    "aliases": ["אלי פטאן"],
    "sex": "male",
    "born": "1928-05-29",
    "father": "People/Ezra-Patan",
    "mother": "People/Victoria-Sasson-Patan",
    "spouses": ["People/Mary-Abada-Patan"],
    "children": ["People/Sami-Patan", "People/Ezra-Cesy-Patan", "People/Aviva-Vicky-Patan-Gal"]
  }
}
```

### Field Details

- **Key**: slug derived from file path (e.g. `People/Elie-Patan`)
- **name**: from `name:` frontmatter
- **aliases**: from `aliases:` frontmatter (array of strings, may be empty). Used for Hebrew name search.
- **sex**: from `sex:` frontmatter. Omitted if unknown.
- **born**: from `born:` frontmatter. Omitted if unknown.
- **father / mother**: slug extracted from `father:` / `mother:` wikilink. `null` if absent.
- **spouses**: array of slugs extracted from `spouse1:`, `spouse2:`, etc. Empty array if none.
- **children**: array of slugs extracted from `children:` list. Empty array if none.

### Wikilink Extraction

Frontmatter values like `"[[People/Ezra-Patan]]"` are parsed to extract the slug `People/Ezra-Patan`. The existing Quartz slug utilities handle normalization.

### Filtering

Only entries with a `cr_id` frontmatter field are included. Place notes, Family notes, and landing pages are excluded.

### Orphan References

If a frontmatter field references a person whose note does not exist (e.g. `father: "[[People/Unknown-Person]]"` but no `Unknown-Person.md` file), the link is omitted from the index. No stub nodes are created. BFS traversal simply skips links to slugs not present in the index.

### Estimated Size

~80-100KB for 960 people (compact — no text content, just relationship pointers).

## FamilyGraph Component

### TSX Shell: `FamilyGraph.tsx`

Same pattern as `Graph.tsx`. Renders:
- A sidebar container (`.family-graph-container`) with `data-cfg` for local config
- A global graph icon button (same SVG as current)
- A global graph overlay container with toolbar HTML and graph container

### Config Interface

```typescript
interface FamilyGraphConfig {
  drag: boolean
  zoom: boolean
  depth: number          // default generations to show
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
```

Default config:
- `localGraph`: `{ depth: 1, direction: "both" }`
- `globalGraph`: `{ depth: 2, direction: "both" }`

## Rendering Contexts

### Sidebar (Local Graph)

- Same size as current graph: 250px tall box in the sidebar
- Shows the current page's person and their immediate family (default depth 1, direction both)
- No toolbar controls
- **Click** a node → SPA navigation to that person's page (same as current graph)
- Global graph icon → opens full-screen explorer
- **Non-person pages**: when the current page is not a person (e.g. index, Places, Families), the sidebar graph is hidden. The component checks whether the current slug exists in `familyIndex.json`; if not, it renders nothing.

### Full-Screen Explorer (Global Graph)

- Modal overlay, same as current global graph (80vw × 80vh, backdrop blur)
- Centered on the same person the sidebar was showing
- **Click** a node → recenters the graph on that person (stays in explorer)
- **Double-click** a node → SPA navigation to that person's page (closes explorer)
- **Escape** or click outside → closes explorer

### Floating Toolbar

Positioned at the top of the full-screen explorer overlay. Contains:

1. **Search box**: text input with dropdown results (max 8). Substring match on `name` and `aliases`. Selecting a result recenters the graph. Escape or blur clears/closes.

2. **Depth control**: stepper or small dropdown. Values: 1, 2, 3, 4, 5. Default: 2. Changes apply immediately.

3. **Direction toggle**: three buttons — Ancestors ↑ / Descendants ↓ / Both ↕. Default: Both. Changes apply immediately.

## Graph Rendering

### Engine

Fork of `graph.inline.ts`. Same D3 force simulation + Pixi.js rendering pipeline, same drag/zoom/hover infrastructure.

### Data Loading

Instead of fetching `contentIndex.json`, the family graph fetches `familyIndex.json`. The fetch URL is built the same way as the existing content index fetch — using the site's base path (e.g. `pathToRoot(slug) + "static/familyIndex.json"`) so it works correctly under GitHub Pages subpath deployment (`/gal-roots/`). It builds nodes and links from the typed relationship data rather than generic link arrays.

### Node Appearance

Circles, same as current graph. Color depends on relationship to the centered person:

| Relationship | Color |
|---|---|
| Centered person | `--secondary` (existing highlight) |
| Direct ancestors (parents, grandparents, ...) | `--tertiary` (existing) |
| Direct descendants (children, grandchildren, ...) | `--family-descendant` (new CSS variable, green tone) |
| Spouses | `--family-spouse` (new CSS variable, pink/rose tone) |
| Other visible relatives | `--gray` (existing) |

Node radius scales with number of connections (same formula as current graph).

Labels appear on zoom and hover (same behavior as current graph).

### Edge Styles

Two types:

| Relationship | Style | Color |
|---|---|---|
| Parent → Child | Solid line | `--gray` |
| Spouse | Dashed line | `--family-spouse` |

### Force Simulation

Same forces as current graph with two additions and one removal:

- **Spouse attraction**: slightly shorter `linkDistance` for spouse edges, pulling couples closer together
- **Generational bias**: a mild `forceY` nudge based on generation depth from the centered person. Parents tend upward, children tend downward. Not a strict hierarchy — just a gentle tendency to make the layout feel tree-like.
- **No radial layout**: the current global graph uses `enableRadial` to arrange nodes in a circle. The family graph does not use this — the generational `forceY` bias replaces it as the structural hint. The `enableRadial` config option is not included in `FamilyGraphConfig`.

### Hover Behavior

Same as current graph: hovering a node highlights its immediate edges and connected neighbors, dims everything else. Labels become fully visible on hover.

### Depth/Direction Traversal

Starting from the centered person, BFS through the family index:

- **Ancestors (↑)**: follows `father` and `mother` links upward only
- **Descendants (↓)**: follows `children` links downward only
- **Both (↕)**: follows parents, children, and spouses in all directions

**Spouse inclusion rule**: spouses of any person in the visible set are always included, regardless of direction. This ensures you see couples, not lone parents.

Depth is counted in generations: depth 1 = immediate family, depth 2 = grandparents/grandchildren, etc.

When depth or direction changes, the graph smoothly transitions: new nodes fade in, removed nodes fade out, simulation re-stabilizes.

## Sibling Handling

Siblings are not explicitly linked. They are connected implicitly through shared parent nodes. The force layout naturally clusters children of the same parents together. No separate "sibling edge" type.

## CSS Variables

Two new CSS variables added to the theme:

```scss
// Light mode
--family-descendant: #5a8a5a;  // green tone for descendants
--family-spouse: #c76b8f;      // pink/rose tone for spouses

// Dark mode
--family-descendant: #7ab37a;  // brighter green for dark backgrounds
--family-spouse: #e08aaa;      // brighter pink for dark backgrounds
```

These are defined in the family graph stylesheet. Light/dark variants follow the same pattern as existing Quartz theme variables, toggled by the `[saved-theme="dark"]` selector.

## Non-Goals

- No photo thumbnails on nodes (keep it clean like the current graph)
- No printing/export
- No editing relationships from the graph
- No timeline or chronological layout
- No explicit sibling edges
