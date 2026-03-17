import type { FamilyEntry, FamilyIndexMap } from "../../plugins/emitters/familyIndex"
import {
  SimulationNodeDatum,
  SimulationLinkDatum,
  Simulation,
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  forceY,
  zoomIdentity,
  select,
  drag,
  zoom,
} from "d3"
import { Text, Graphics, Application, Container, Circle } from "pixi.js"
import { Group as TweenGroup, Tween as Tweened } from "@tweenjs/tween.js"
import { registerEscapeHandler, removeAllChildren } from "./util"
import {
  FullSlug,
  SimpleSlug,
  getFullSlug,
  resolveRelative,
  simplifySlug,
  pathToRoot,
} from "../../util/path"
import { FamilyGraphConfig } from "../FamilyGraph"
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string"

interface GraphSnapshot {
  c: string
  d: number
  r: string
  l: string
  n: boolean
  h: boolean
  z: [number, number, number]
  hd?: string[]
  p: [string, number, number][]
}

interface NodeSnapshot {
  positions: [string, number, number][]
  hidden: string[]
  zoom: [number, number, number]
}

let familyDataPromise: Promise<FamilyIndexMap> | null = null
function getFamilyData(): Promise<FamilyIndexMap> {
  if (!familyDataPromise) {
    const slug = getFullSlug(window)
    const base = pathToRoot(slug)
    const url = new URL(
      (base ? base + "/" : "") + "static/familyIndex.json",
      window.location.href,
    )
    familyDataPromise = fetch(url.toString()).then((r) => r.json())
  }
  return familyDataPromise
}

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

type FamilyLinkType = "parent-child" | "spouse"
type FamilySimpleLinkData = {
  source: SimpleSlug
  target: SimpleSlug
  type: FamilyLinkType
}

function buildFamilyLinks(
  data: FamilyIndexMap,
  neighbourhood: Set<SimpleSlug>,
): FamilySimpleLinkData[] {
  const links: FamilySimpleLinkData[] = []
  const seen = new Set<string>()
  for (const slug of neighbourhood) {
    const entry = data[slug]
    if (!entry) continue
    for (const parent of [entry.father, entry.mother]) {
      if (parent && neighbourhood.has(parent)) {
        const key = `pc:${parent}:${slug}`
        if (!seen.has(key)) {
          seen.add(key)
          links.push({ source: parent, target: slug, type: "parent-child" })
        }
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

function computeGenerations(
  data: FamilyIndexMap,
  center: SimpleSlug,
  neighbourhood: Set<SimpleSlug>,
): Map<SimpleSlug, number> {
  const gens = new Map<SimpleSlug, number>()
  gens.set(center, 0)
  const queue: SimpleSlug[] = [center]
  while (queue.length > 0) {
    const slug = queue.shift()!
    const gen = gens.get(slug)!
    const entry = data[slug]
    if (!entry) continue
    for (const parent of [entry.father, entry.mother]) {
      if (parent && neighbourhood.has(parent) && !gens.has(parent)) {
        gens.set(parent, gen - 1)
        queue.push(parent)
      }
    }
    for (const child of entry.children) {
      if (neighbourhood.has(child) && !gens.has(child)) {
        gens.set(child, gen + 1)
        queue.push(child)
      }
    }
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
  spouseSet: Set<SimpleSlug>,
  css: Record<string, string>,
): string {
  if (slug === center) return css["--secondary"]
  if (spouseSet.has(slug)) return css["--family-spouse"]
  const gen = gens.get(slug) ?? 0
  if (gen < 0) return css["--tertiary"]
  if (gen > 0) return css["--family-descendant"]
  return css["--gray"]
}

function drawDashedLine(
  gfx: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  opts: {
    alpha: number
    width: number
    color: string
    dashLength: number
    gapLength: number
  },
) {
  const dx = x2 - x1
  const dy = y2 - y1
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist === 0) return
  const ux = dx / dist
  const uy = dy / dist
  let pos = 0
  let drawing = true
  while (pos < dist) {
    const segLen = drawing ? opts.dashLength : opts.gapLength
    const next = Math.min(pos + segLen, dist)
    if (drawing) {
      gfx.moveTo(x1 + ux * pos, y1 + uy * pos)
      gfx
        .lineTo(x1 + ux * next, y1 + uy * next)
        .stroke({ alpha: opts.alpha, width: opts.width, color: opts.color })
    }
    pos = next
    drawing = !drawing
  }
}

type GraphicsInfo = {
  color: string
  gfx: Graphics
  alpha: number
  active: boolean
}

type NodeData = {
  id: SimpleSlug
  text: string
} & SimulationNodeDatum

type FamilyLinkData = {
  source: NodeData
  target: NodeData
  type: FamilyLinkType
} & SimulationLinkDatum<NodeData>

type FamilyLinkRenderData = GraphicsInfo & {
  simulationData: FamilyLinkData
}

type NodeRenderData = GraphicsInfo & {
  simulationData: NodeData
  label: Text
  selRing: Graphics
}

type TweenNode = {
  update: (time: number) => void
  stop: () => void
}

type GraphHandle = {
  cleanup: () => void
  fitToView: () => void
  resetView: () => void
  applyLayout: (name: string) => void
  setShowNames: (on: boolean) => void
  setHebrew: (on: boolean) => void
  refreshTheme: () => void
  getSnapshot: () => NodeSnapshot
  restoreSnapshot: (snap: NodeSnapshot) => void
}

let lastClickTime = 0
let lastClickTarget: string | null = null

async function renderFamilyGraph(
  graph: HTMLElement,
  fullSlug: FullSlug,
  isGlobal: boolean,
  options?: {
    center?: SimpleSlug
    depth?: number
    direction?: Direction
    onRecenter?: (newCenter: SimpleSlug) => void
    onShare?: () => void
  },
): Promise<GraphHandle> {
  const slug = simplifySlug(fullSlug)
  const center = options?.center ?? slug
  const familyData = await getFamilyData()
  const entry = familyData[center]
  if (!entry) {
    return { cleanup: () => {}, fitToView: () => {}, resetView: () => {}, applyLayout: () => {}, setShowNames: () => {}, setHebrew: () => {}, refreshTheme: () => {}, getSnapshot: () => ({ positions: [], hidden: [], zoom: [0, 0, 1] }), restoreSnapshot: () => {} }
  }

  removeAllChildren(graph)

  const cfg = JSON.parse(graph.dataset["cfg"]!) as FamilyGraphConfig
  const {
    drag: enableDrag,
    zoom: enableZoom,
    depth: cfgDepth,
    direction: cfgDirection,
    scale,
    repelForce,
    centerForce,
    linkDistance,
    fontSize,
    opacityScale,
    focusOnHover,
  } = cfg

  const depth = options?.depth ?? cfgDepth
  const direction = options?.direction ?? cfgDirection

  const neighbourhood = buildFamilyNeighbourhood(familyData, center, depth, direction)
  const links = buildFamilyLinks(familyData, neighbourhood)
  const gens = computeGenerations(familyData, center, neighbourhood)
  const spouseSet = new Set<SimpleSlug>((familyData[center] as FamilyEntry).spouses ?? [])

  const nodes = [...neighbourhood].map((id) => ({
    id,
    text: (familyData[id] as FamilyEntry)?.name ?? id,
  }))

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const graphLinks: FamilyLinkData[] = links.map((l) => ({
    source: nodeMap.get(l.source)!,
    target: nodeMap.get(l.target)!,
    type: l.type,
  }))

  const graphData = { nodes, links: graphLinks }

  let width = graph.offsetWidth
  let height = Math.max(graph.offsetHeight, 250)
  const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0
  const hitPadding = isTouchDevice ? 8 : 0

  const genMap = gens
  const simulation = forceSimulation<NodeData>(graphData.nodes)
    .force("charge", forceManyBody().strength(-100 * repelForce))
    .force("center", forceCenter().strength(centerForce))
    .force(
      "link",
      forceLink(graphData.links)
        .id((d) => (d as NodeData).id)
        .distance((l) => ((l as FamilyLinkData).type === "spouse" ? 20 : linkDistance)),
    )
    .force("collide", forceCollide<NodeData>((n) => nodeRadius(n)).iterations(3))
    .force(
      "generation",
      forceY<NodeData>((d) => (genMap.get(d.id) ?? 0) * 120).strength(0.15),
    )

  const cssVars = [
    "--secondary",
    "--tertiary",
    "--gray",
    "--light",
    "--lightgray",
    "--dark",
    "--darkgray",
    "--bodyFont",
    "--family-descendant",
    "--family-spouse",
  ] as const
  const computedStyleMap = cssVars.reduce(
    (acc, key) => {
      acc[key] = getComputedStyle(document.documentElement).getPropertyValue(key).trim()
      return acc
    },
    {} as Record<(typeof cssVars)[number], string>,
  )

  const color = (d: NodeData) =>
    nodeColor(d.id, center, gens, spouseSet, computedStyleMap)

  function nodeRadius(d: NodeData) {
    const numLinks = graphData.links.filter(
      (l) => l.source.id === d.id || l.target.id === d.id,
    ).length
    return 2 + Math.sqrt(numLinks)
  }

  const tweens = new Map<string, TweenNode>()
  let hoveredNodeId: string | null = null
  const linkRenderData: FamilyLinkRenderData[] = []
  const nodeRenderData: NodeRenderData[] = []
  const selectedNodes = new Set<string>()

  function hitTestNode(screenX: number, screenY: number): string | null {
    const rect = app.canvas.getBoundingClientRect()
    const canvasX = screenX - rect.left
    const canvasY = screenY - rect.top
    const stageX = (canvasX - currentTransform.x) / currentTransform.k
    const stageY = (canvasY - currentTransform.y) / currentTransform.k
    const simX = stageX - width / 2
    const simY = stageY - height / 2
    let bestId: string | null = null
    let bestDist = Infinity
    const touchSlop = isTouchDevice ? 20 : 8
    for (const n of nodeRenderData) {
      if (hiddenNodes?.has(n.simulationData.id)) continue
      const nx = n.simulationData.x ?? 0
      const ny = n.simulationData.y ?? 0
      const dx = simX - nx
      const dy = simY - ny
      const dist = Math.sqrt(dx * dx + dy * dy)
      const r = nodeRadius(n.simulationData) + touchSlop
      if (dist < r && dist < bestDist) {
        bestDist = dist
        bestId = n.simulationData.id
      }
    }
    return bestId
  }

  function updateHoverInfo(newHoveredId: string | null) {
    hoveredNodeId = newHoveredId

    if (newHoveredId === null) {
      for (const n of nodeRenderData) n.active = false
      for (const l of linkRenderData) l.active = false
    } else {
      const hoveredNeighbours = new Set<string>()
      for (const l of linkRenderData) {
        const linkData = l.simulationData
        if (linkData.source.id === newHoveredId || linkData.target.id === newHoveredId) {
          hoveredNeighbours.add(linkData.source.id)
          hoveredNeighbours.add(linkData.target.id)
        }
        l.active = linkData.source.id === newHoveredId || linkData.target.id === newHoveredId
      }
      for (const n of nodeRenderData) {
        n.active = hoveredNeighbours.has(n.simulationData.id)
      }
    }
  }

  let dragStartTime = 0
  let dragging = false
  let dragStartPos = { x: 0, y: 0 }
  let lastDragEvent: { ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean } | null = null

  function renderLinks() {
    tweens.get("link")?.stop()
    const tweenGroup = new TweenGroup()
    for (const l of linkRenderData) {
      const alpha = hoveredNodeId ? (l.active ? 1 : 0.2) : 1
      l.color = l.active ? computedStyleMap["--gray"] : computedStyleMap["--lightgray"]
      tweenGroup.add(new Tweened<FamilyLinkRenderData>(l).to({ alpha }, 200))
    }
    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("link", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
    })
  }

  function renderLabels() {
    tweens.get("label")?.stop()
    const tweenGroup = new TweenGroup()
    const defaultScale = 1 / scale
    const activeScale = defaultScale * 1.1
    for (const n of nodeRenderData) {
      const nodeId = n.simulationData.id
      if (hoveredNodeId === nodeId) {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            { alpha: 1, scale: { x: activeScale, y: activeScale } },
            100,
          ),
        )
      } else {
        tweenGroup.add(
          new Tweened<Text>(n.label).to(
            { alpha: n.label.alpha, scale: { x: defaultScale, y: defaultScale } },
            100,
          ),
        )
      }
    }
    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("label", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
    })
  }

  function renderNodes() {
    tweens.get("hover")?.stop()
    const tweenGroup = new TweenGroup()
    for (const n of nodeRenderData) {
      const alpha =
        hoveredNodeId !== null && focusOnHover ? (n.active ? 1 : 0.2) : 1
      tweenGroup.add(new Tweened<Graphics>(n.gfx, tweenGroup).to({ alpha }, 200))
    }
    tweenGroup.getAll().forEach((tw) => tw.start())
    tweens.set("hover", {
      update: tweenGroup.update.bind(tweenGroup),
      stop() {
        tweenGroup.getAll().forEach((tw) => tw.stop())
      },
    })
  }

  function renderPixiFromD3() {
    renderNodes()
    renderLinks()
    renderLabels()
  }

  tweens.forEach((t) => t.stop())
  tweens.clear()

  const app = new Application()
  await app.init({
    width,
    height,
    antialias: true,
    autoStart: false,
    autoDensity: true,
    backgroundAlpha: 0,
    preference: "webgpu",
    resolution: window.devicePixelRatio,
    eventMode: "static",
  })
  graph.appendChild(app.canvas)

  const stage = app.stage
  stage.interactive = false

  let resizeTimer: ReturnType<typeof setTimeout> | null = null
  let resizeObserver: ResizeObserver | null = null
  if (isGlobal) {
    resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        const newW = graph.offsetWidth
        const newH = Math.max(graph.offsetHeight, 250)
        if (newW === width && newH === height) return
        width = newW
        height = newH
        app.renderer.resize(width, height)
        zoomBehavior.extent([
          [0, 0],
          [width, height],
        ])
        renderPixiFromD3()
      }, 150)
    })
    resizeObserver.observe(graph)
  }

  const labelsContainer = new Container<Text>({ zIndex: 3, isRenderGroup: true })
  const selectionRingContainer = new Container<Graphics>({ zIndex: 2.5, isRenderGroup: true })
  const nodesContainer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true })
  const linkContainer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true })
  const selRectGfx = new Graphics({ zIndex: 4, interactive: false, eventMode: "none" })
  stage.addChild(nodesContainer, labelsContainer, linkContainer, selectionRingContainer, selRectGfx)

  for (const n of graphData.nodes) {
    const nodeId = n.id
    const label = new Text({
      interactive: false,
      eventMode: "none",
      text: n.text,
      alpha: 0,
      anchor: { x: 0.5, y: 1.2 },
      style: {
        fontSize: fontSize * 15,
        fill: computedStyleMap["--dark"],
        fontFamily: computedStyleMap["--bodyFont"],
      },
      resolution: window.devicePixelRatio * 4,
    })
    label.scale.set(1 / scale)

    let oldLabelOpacity = 0
    const gfx = new Graphics({
      interactive: true,
      label: nodeId,
      eventMode: "static",
      hitArea: new Circle(0, 0, nodeRadius(n) + hitPadding),
      cursor: "pointer",
    })
      .circle(0, 0, nodeRadius(n))
      .fill({ color: color(n) })
      .on("pointerover", (e) => {
        updateHoverInfo(e.target.label)
        oldLabelOpacity = label.alpha
        if (!dragging) renderPixiFromD3()
      })
      .on("pointerleave", () => {
        updateHoverInfo(null)
        label.alpha = oldLabelOpacity
        if (!dragging) renderPixiFromD3()
      })

    const selRing = new Graphics({ interactive: false, eventMode: "none", visible: false })
    selRing.circle(0, 0, nodeRadius(n) + 3).stroke({ width: 2, color: computedStyleMap["--secondary"] })

    nodesContainer.addChild(gfx)
    labelsContainer.addChild(label)
    selectionRingContainer.addChild(selRing)

    nodeRenderData.push({
      simulationData: n,
      gfx,
      label,
      selRing,
      color: color(n),
      alpha: 1,
      active: false,
    })
  }

  for (const l of graphData.links) {
    const gfx = new Graphics({ interactive: false, eventMode: "none" })
    linkContainer.addChild(gfx)
    linkRenderData.push({
      simulationData: l,
      gfx,
      color: computedStyleMap["--lightgray"],
      alpha: 1,
      active: false,
    })
  }

  const onRecenter = options?.onRecenter
  const onShare = options?.onShare

  let currentTransform = zoomIdentity

  type InitDragPos = { x: number; y: number; fx: number | null; fy: number | null }
  let groupDragInitials = new Map<string, InitDragPos>()

  function clearSelection() {
    selectedNodes.clear()
  }

  function toStageCoords(screenX: number, screenY: number) {
    return {
      x: (screenX - currentTransform.x) / currentTransform.k,
      y: (screenY - currentTransform.y) / currentTransform.k,
    }
  }

  let rectSelecting = false
  let rectStart = { x: 0, y: 0 }

  function onRectMouseDown(e: MouseEvent) {
    if (!e.shiftKey || hoveredNodeId) return
    e.preventDefault()
    e.stopPropagation()
    rectSelecting = true
    const rect = app.canvas.getBoundingClientRect()
    rectStart = toStageCoords(e.clientX - rect.left, e.clientY - rect.top)
  }

  function onRectMouseMove(e: MouseEvent) {
    if (!rectSelecting) return
    const rect = app.canvas.getBoundingClientRect()
    const cur = toStageCoords(e.clientX - rect.left, e.clientY - rect.top)
    const x = Math.min(rectStart.x, cur.x)
    const y = Math.min(rectStart.y, cur.y)
    const w = Math.abs(cur.x - rectStart.x)
    const h = Math.abs(cur.y - rectStart.y)
    selRectGfx.clear()
    selRectGfx.rect(x, y, w, h)
      .stroke({ width: 1.5 / currentTransform.k, color: computedStyleMap["--secondary"], alpha: 0.8 })
      .fill({ color: computedStyleMap["--secondary"], alpha: 0.1 })
  }

  function onRectMouseUp(e: MouseEvent) {
    if (!rectSelecting) return
    rectSelecting = false
    const rect = app.canvas.getBoundingClientRect()
    const cur = toStageCoords(e.clientX - rect.left, e.clientY - rect.top)
    const x1 = Math.min(rectStart.x, cur.x)
    const y1 = Math.min(rectStart.y, cur.y)
    const x2 = Math.max(rectStart.x, cur.x)
    const y2 = Math.max(rectStart.y, cur.y)
    selRectGfx.clear()

    if (Math.abs(x2 - x1) < 3 && Math.abs(y2 - y1) < 3) return

    if (!e.shiftKey) selectedNodes.clear()
    for (const n of nodeRenderData) {
      const nx = (n.simulationData.x ?? 0) + width / 2
      const ny = (n.simulationData.y ?? 0) + height / 2
      if (nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2 && !hiddenNodes.has(n.simulationData.id)) {
        selectedNodes.add(n.simulationData.id)
      }
    }
  }

  app.canvas.addEventListener("mousedown", onRectMouseDown, true)
  window.addEventListener("mousemove", onRectMouseMove)
  window.addEventListener("mouseup", onRectMouseUp)

  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressFired = false

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
  }

  if (enableDrag) {
    select<HTMLCanvasElement, NodeData | undefined>(app.canvas).call(
      drag<HTMLCanvasElement, NodeData | undefined>()
        .container(() => app.canvas)
        .subject((event) => {
          if (rectSelecting) return undefined
          if (isTouchDevice && event.sourceEvent) {
            const touch = (event.sourceEvent as TouchEvent).touches?.[0]
              ?? (event.sourceEvent as PointerEvent)
            const cx = touch.clientX
            const cy = touch.clientY
            if (cx != null && cy != null) {
              const id = hitTestNode(cx, cy)
              if (id) {
                updateHoverInfo(id)
                return graphData.nodes.find((n) => n.id === id)
              }
            }
          }
          return graphData.nodes.find((n) => n.id === hoveredNodeId)
        })
        .on("start", function dragstarted(event) {
          if (!event.subject) return
          const shiftKey = !!event.sourceEvent?.shiftKey
          const subjectId = event.subject.id as string

          if (!event.active) simulation.alphaTarget(0.05).restart()
          event.subject.fx = event.subject.x
          event.subject.fy = event.subject.y

          groupDragInitials.clear()
          const isGroupDrag = selectedNodes.has(subjectId) && selectedNodes.size > 0
          const dragSet = isGroupDrag ? selectedNodes : new Set([subjectId])

          for (const nid of dragSet) {
            const nd = graphData.nodes.find((n) => n.id === nid)
            if (nd) {
              nd.fx = nd.x
              nd.fy = nd.y
              groupDragInitials.set(nid, { x: nd.x!, y: nd.y!, fx: nd.fx!, fy: nd.fy! })
            }
          }

          dragStartTime = Date.now()
          dragStartPos = { x: event.x, y: event.y }
          dragging = true
          longPressFired = false
          cancelLongPress()

          if (isTouchDevice) {
            const se = event.sourceEvent as PointerEvent
            const sx = se?.clientX ?? 0
            const sy = se?.clientY ?? 0
            longPressTimer = setTimeout(() => {
              longPressFired = true
              dragging = false
              simulation.alphaTarget(0)
              showContextMenu(subjectId, sx, sy)
              longPressTimer = null
            }, 600)
          }
        })
        .on("drag", function dragged(event) {
          if (!event.subject) return
          if (longPressFired) return
          lastDragEvent = {
            ctrlKey: event.sourceEvent?.ctrlKey,
            metaKey: event.sourceEvent?.metaKey,
            shiftKey: event.sourceEvent?.shiftKey,
          }
          const dx = (event.x - dragStartPos.x) / currentTransform.k
          const dy = (event.y - dragStartPos.y) / currentTransform.k
          const rawDist = Math.sqrt(dx * dx + dy * dy)
          if (rawDist > 3) cancelLongPress()
          for (const [nid, init] of groupDragInitials) {
            const nd = graphData.nodes.find((n) => n.id === nid)
            if (nd) {
              nd.fx = init.x + dx
              nd.fy = init.y + dy
            }
          }
        })
        .on("end", function dragended(event) {
          if (!event.subject) return
          if (!event.active) simulation.alphaTarget(0)
          cancelLongPress()
          dragging = false
          if (longPressFired) {
            longPressFired = false
            groupDragInitials.clear()
            lastDragEvent = null
            return
          }
          const dxTotal = event.x - dragStartPos.x
          const dyTotal = event.y - dragStartPos.y
          const dist = Math.sqrt(dxTotal * dxTotal + dyTotal * dyTotal)
          const shiftKey = !!(lastDragEvent?.shiftKey || event.sourceEvent?.shiftKey)

          if (dist < 5) {
            const nid = event.subject.id as string
            if (shiftKey || isTouchDevice) {
              if (selectedNodes.has(nid)) selectedNodes.delete(nid)
              else selectedNodes.add(nid)
            } else {
              clearSelection()
              selectedNodes.add(nid)
            }
          }
          if (isTouchDevice) {
            updateHoverInfo(null)
            renderPixiFromD3()
          }
          groupDragInitials.clear()
          lastDragEvent = null
        }),
    )
  } else {
    for (const node of nodeRenderData) {
      node.gfx.on("click", (e: any) => {
        const nid = node.simulationData.id
        if (e?.shiftKey || isTouchDevice) {
          if (selectedNodes.has(nid)) selectedNodes.delete(nid)
          else selectedNodes.add(nid)
        } else {
          clearSelection()
          selectedNodes.add(nid)
        }
      })
    }
  }

  const hiddenNodes = new Set<string>()

  function hideNode(nodeId: string) {
    hiddenNodes.add(nodeId)
    selectedNodes.delete(nodeId)
    hideDisconnected()
    for (const h of hiddenNodes) selectedNodes.delete(h)
    applyVisibility()
  }

  function hideDisconnected() {
    const reachable = new Set<string>()
    const queue = [center as string]
    reachable.add(center)
    while (queue.length > 0) {
      const cur = queue.shift()!
      for (const l of graphData.links) {
        const src = l.source.id as string
        const tgt = l.target.id as string
        let neighbour: string | null = null
        if (src === cur) neighbour = tgt
        else if (tgt === cur) neighbour = src
        if (neighbour && !reachable.has(neighbour) && !hiddenNodes.has(neighbour)) {
          reachable.add(neighbour)
          queue.push(neighbour)
        }
      }
    }
    for (const n of nodeRenderData) {
      const id = n.simulationData.id as string
      if (!reachable.has(id) && id !== center) {
        hiddenNodes.add(id)
      }
    }
  }

  function showAllLinks(targetNodeId: string) {
    const fe = familyData[targetNodeId as SimpleSlug] as FamilyEntry | undefined
    if (!fe) return
    const rels: { id: SimpleSlug; type: FamilyLinkType; asSource: boolean }[] = []
    if (fe.father) rels.push({ id: fe.father, type: "parent-child", asSource: true })
    if (fe.mother) rels.push({ id: fe.mother, type: "parent-child", asSource: true })
    for (const sp of fe.spouses) rels.push({ id: sp, type: "spouse", asSource: false })
    for (const ch of fe.children) rels.push({ id: ch, type: "parent-child", asSource: false })
    expandRelatives(targetNodeId, rels)
  }

  function applyVisibility() {
    for (const n of nodeRenderData) {
      const hidden = hiddenNodes.has(n.simulationData.id)
      n.gfx.visible = !hidden
      n.label.visible = !hidden
      if (hidden) n.selRing.visible = false
    }
    for (const l of linkRenderData) {
      const srcHidden = hiddenNodes.has(l.simulationData.source.id)
      const tgtHidden = hiddenNodes.has(l.simulationData.target.id)
      l.gfx.visible = !srcHidden && !tgtHidden
    }
  }

  let contextMenu: HTMLDivElement | null = null

  function closeContextMenu() {
    if (contextMenu) {
      contextMenu.remove()
      contextMenu = null
    }
    if (dismissHandler) {
      document.removeEventListener("pointerdown", dismissHandler)
      dismissHandler = null
    }
  }

  function expandRelatives(targetNodeId: string, relatives: { id: SimpleSlug; type: FamilyLinkType; asSource: boolean }[]) {
    const tSlug = targetNodeId as SimpleSlug
    const targetGen = gens.get(tSlug) ?? 0
    const newNodeIds: SimpleSlug[] = []

    const parents: typeof relatives = []
    const children: typeof relatives = []
    const spouses: typeof relatives = []
    for (const rel of relatives) {
      if (!familyData[rel.id]) continue
      if (rel.asSource) parents.push(rel)
      else if (rel.type === "spouse") spouses.push(rel)
      else children.push(rel)
    }

    const anchorNode = nodeRenderData.find((r) => r.simulationData.id === tSlug)
    const ax = anchorNode?.simulationData.x ?? 0
    const ay = anchorNode?.simulationData.y ?? 0
    const gap = 60 / Math.max(currentTransform.k, 0.1)

    function placeGroup(group: typeof relatives, baseX: number, baseY: number) {
      const count = group.length
      const totalW = (count - 1) * gap
      let x = baseX - totalW / 2
      for (const rel of group) {
        assignNewNode(rel, x, baseY)
        x += gap
      }
    }

    function assignNewNode(rel: typeof relatives[0], px: number, py: number) {
      hiddenNodes.delete(rel.id)
      if (!nodeMap.has(rel.id)) {
        if (rel.asSource) gens.set(rel.id, targetGen - 1)
        else if (rel.type === "spouse") gens.set(rel.id, targetGen)
        else gens.set(rel.id, targetGen + 1)

        const newFe = familyData[rel.id] as FamilyEntry
        const n: NodeData = { id: rel.id, text: newFe?.name ?? rel.id, x: px, y: py }
        n.fx = px
        n.fy = py
        graphData.nodes.push(n)
        nodeMap.set(rel.id, n)
        neighbourhood.add(rel.id)
        newNodeIds.push(rel.id)
      }
    }

    placeGroup(parents, ax, ay - gap)
    placeGroup(children, ax, ay + gap)
    const spouseStartX = ax + gap * (spouses.length > 1 ? 1 : 0.8)
    placeGroup(spouses, spouseStartX, ay)

    function addLinkIfMissing(src: SimpleSlug, tgt: SimpleSlug, type: FamilyLinkType) {
      const exists = graphData.links.some(
        (l) => (l.source.id === src && l.target.id === tgt) || (l.source.id === tgt && l.target.id === src),
      )
      if (!exists && nodeMap.get(src) && nodeMap.get(tgt)) {
        const ld: FamilyLinkData = { source: nodeMap.get(src)!, target: nodeMap.get(tgt)!, type }
        graphData.links.push(ld)
        const gfx = new Graphics({ interactive: false, eventMode: "none" })
        linkContainer.addChild(gfx)
        linkRenderData.push({ simulationData: ld, gfx, color: computedStyleMap["--lightgray"], alpha: 1, active: false })
      }
    }

    for (const rel of relatives) {
      if (!familyData[rel.id]) continue
      const src = rel.type === "parent-child" ? (rel.asSource ? rel.id : tSlug) : tSlug
      const tgt = rel.type === "parent-child" ? (rel.asSource ? tSlug : rel.id) : rel.id
      addLinkIfMissing(src as SimpleSlug, tgt as SimpleSlug, rel.type)
    }

    const targetFe = familyData[tSlug] as FamilyEntry | undefined
    if (targetFe) {
      const allSpouseIds = (targetFe.spouses ?? []).filter(
        (sp) => nodeMap.has(sp) && !hiddenNodes.has(sp),
      )
      const allChildIds = (targetFe.children ?? []).filter(
        (ch) => nodeMap.has(ch) && !hiddenNodes.has(ch),
      )
      for (const spId of allSpouseIds) {
        const spFe = familyData[spId] as FamilyEntry | undefined
        if (!spFe) continue
        for (const chId of allChildIds) {
          if (spFe.children.includes(chId)) {
            addLinkIfMissing(spId, chId, "parent-child")
          }
        }
      }
    }

    for (const nid of newNodeIds) {
      const n = nodeMap.get(nid)!
      const nColor = nodeColor(nid, center, gens, spouseSet, computedStyleMap)
      const r = nodeRadius(n)
      const label = new Text({
        interactive: false, eventMode: "none", text: n.text,
        alpha: showNames ? 1 : 0, anchor: { x: 0.5, y: 1.2 },
        style: { fontSize: fontSize * 15, fill: computedStyleMap["--dark"], fontFamily: computedStyleMap["--bodyFont"] },
        resolution: window.devicePixelRatio * 4,
      })
      label.scale.set(1 / scale)
      const nodeGfx = new Graphics({ interactive: true, label: nid, eventMode: "static", hitArea: new Circle(0, 0, r + hitPadding), cursor: "pointer" })
        .circle(0, 0, r).fill({ color: nColor })
        .on("pointerover", () => { updateHoverInfo(nid); if (!dragging) renderPixiFromD3() })
        .on("pointerleave", () => { updateHoverInfo(null); if (!dragging) renderPixiFromD3() })
      const selRing = new Graphics({ interactive: false, eventMode: "none", visible: false })
      selRing.circle(0, 0, r + 3).stroke({ width: 2, color: computedStyleMap["--secondary"] })
      nodesContainer.addChild(nodeGfx)
      labelsContainer.addChild(label)
      selectionRingContainer.addChild(selRing)
      nodeRenderData.push({ simulationData: n, gfx: nodeGfx, label, selRing, color: nColor, alpha: 1, active: false })
    }

    if (newNodeIds.length > 0) {
      simulation.nodes(graphData.nodes)
    }

    simulation.force(
      "link",
      forceLink(graphData.links)
        .id((d) => (d as NodeData).id)
        .distance((l) => ((l as FamilyLinkData).type === "spouse" ? 20 : linkDistance)),
    )

    hiddenNodes.delete(targetNodeId)
    simulation.alpha(0.3).restart()
    applyVisibility()
  }

  function showParents(targetNodeId: string) {
    const fe = familyData[targetNodeId as SimpleSlug] as FamilyEntry | undefined
    if (!fe) return
    const rels: { id: SimpleSlug; type: FamilyLinkType; asSource: boolean }[] = []
    if (fe.father) rels.push({ id: fe.father, type: "parent-child", asSource: true })
    if (fe.mother) rels.push({ id: fe.mother, type: "parent-child", asSource: true })
    expandRelatives(targetNodeId, rels)
  }

  function showChildren(targetNodeId: string) {
    const fe = familyData[targetNodeId as SimpleSlug] as FamilyEntry | undefined
    if (!fe) return
    const rels: { id: SimpleSlug; type: FamilyLinkType; asSource: boolean }[] = []
    for (const ch of fe.children) rels.push({ id: ch, type: "parent-child", asSource: false })
    expandRelatives(targetNodeId, rels)
  }

  function showSiblings(targetNodeId: string) {
    const fe = familyData[targetNodeId as SimpleSlug] as FamilyEntry | undefined
    if (!fe) return
    showParents(targetNodeId)
    for (const parentSlug of [fe.father, fe.mother]) {
      if (!parentSlug || !familyData[parentSlug]) continue
      const parentEntry = familyData[parentSlug] as FamilyEntry
      const sibRels: { id: SimpleSlug; type: FamilyLinkType; asSource: boolean }[] = []
      for (const sib of parentEntry.children) {
        sibRels.push({ id: sib, type: "parent-child", asSource: false })
      }
      expandRelatives(parentSlug, sibRels)
    }
  }

  let dismissHandler: ((e: PointerEvent) => void) | null = null

  function showContextMenu(nodeId: string, clientX: number, clientY: number) {
    closeContextMenu()
    const menu = document.createElement("div")
    menu.className = "family-graph-context-menu"
    menu.style.position = "fixed"
    menu.style.left = `${clientX}px`
    menu.style.top = `${clientY}px`

    const menuItem = (label: string, action: () => void) => {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.textContent = label
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation()
        e.preventDefault()
        action()
        closeContextMenu()
      })
      menu.appendChild(btn)
    }

    const divider = () => {
      const hr = document.createElement("hr")
      hr.className = "context-menu-divider"
      menu.appendChild(hr)
    }

    if (isGlobal) {
      menuItem("Focus on node", () => onRecenter?.(nodeId as SimpleSlug))
    }
    menuItem("Open page", () => {
      const targ = resolveRelative(fullSlug, nodeId)
      window.spaNavigate(new URL(targ, window.location.toString()))
    })
    divider()
    menuItem("Show all links", () => showAllLinks(nodeId))
    menuItem("Show parents", () => showParents(nodeId))
    menuItem("Show children", () => showChildren(nodeId))
    menuItem("Show siblings", () => showSiblings(nodeId))
    divider()
    menuItem("Hide node", () => hideNode(nodeId))
    if (isGlobal && onShare) {
      divider()
      menuItem("Share this view", () => onShare())
    }

    document.body.appendChild(menu)
    contextMenu = menu

    dismissHandler = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) {
        closeContextMenu()
      }
    }
    setTimeout(() => {
      document.addEventListener("pointerdown", dismissHandler!)
    }, 100)
  }

  app.canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    if (hoveredNodeId) {
      showContextMenu(hoveredNodeId, e.clientX, e.clientY)
    }
  })

  app.canvas.addEventListener("click", (e) => {
    const nodeUnderClick = isTouchDevice ? hitTestNode(e.clientX, e.clientY) : hoveredNodeId
    if (!nodeUnderClick && selectedNodes.size > 0) {
      clearSelection()
      if (isTouchDevice) {
        updateHoverInfo(null)
        renderPixiFromD3()
      }
    }
  })

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedNodes.size > 0) {
        for (const nid of [...selectedNodes]) {
          if (nid !== center) hideNode(nid)
        }
      }
    }
  }
  document.addEventListener("keydown", onKeyDown)

  let showNames = false
  let suppressZoomHandler = false

  const zoomBehavior = zoom<HTMLCanvasElement, NodeData>()
    .filter((event) => {
      if (event.type === "wheel") return true
      if (event.shiftKey && !hoveredNodeId) return false
      return true
    })
    .extent([
      [0, 0],
      [width, height],
    ])
    .scaleExtent([0.05, 4])
    .on("zoom", ({ transform }) => {
      if (suppressZoomHandler) return
      currentTransform = transform
      stage.scale.set(transform.k, transform.k)
      stage.position.set(transform.x, transform.y)
      if (!showNames) {
        const scaleOpacity = Math.max((transform.k * opacityScale - 1) / 3.75, 0)
        const activeNodes = nodeRenderData.filter((n) => n.active).flatMap((n) => n.label)
        for (const label of labelsContainer.children) {
          if (!activeNodes.includes(label as Text)) {
            ;(label as Text).alpha = scaleOpacity
          }
        }
      }
    })
  const canvasSelection = select<HTMLCanvasElement, NodeData>(app.canvas)
  if (enableZoom) {
    canvasSelection.call(zoomBehavior)
  }

  let stopAnimation = false
  function animate(time: number) {
    if (stopAnimation) return
    for (const n of nodeRenderData) {
      const { x, y } = n.simulationData
      if (x == null || y == null) continue
      n.gfx.position.set(x + width / 2, y + height / 2)
      if (n.label) n.label.position.set(x + width / 2, y + height / 2)
      n.selRing.position.set(x + width / 2, y + height / 2)
      n.selRing.visible = selectedNodes.has(n.simulationData.id)
    }

    for (const l of linkRenderData) {
      const linkData = l.simulationData
      l.gfx.clear()
      const x1 = linkData.source.x! + width / 2
      const y1 = linkData.source.y! + height / 2
      const x2 = linkData.target.x! + width / 2
      const y2 = linkData.target.y! + height / 2
      if (linkData.type === "spouse") {
        drawDashedLine(l.gfx, x1, y1, x2, y2, {
          alpha: l.alpha,
          width: 1,
          color: l.color,
          dashLength: 4,
          gapLength: 3,
        })
      } else {
        l.gfx.moveTo(x1, y1)
        l.gfx.lineTo(x2, y2).stroke({ alpha: l.alpha, width: 1, color: l.color })
      }
    }

    tweens.forEach((t) => t.update(time))
    app.renderer.render(stage)
    requestAnimationFrame(animate)
  }

  requestAnimationFrame(animate)

  function computeFitTransform(): typeof zoomIdentity | null {
    const padding = 50
    const usableW = Math.max(width - padding * 2, 50)
    const usableH = Math.max(height - padding * 2, 50)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    let validCount = 0
    for (const n of nodeRenderData) {
      const sx = n.simulationData.x
      const sy = n.simulationData.y
      if (sx == null || sy == null) continue
      validCount++
      const nx = sx + width / 2
      const ny = sy + height / 2

      if (showNames) {
        const lbl = n.label
        const lblW = (lbl.width * lbl.scale.x) / 2
        const lblH = lbl.height * lbl.scale.y
        if (nx - lblW < minX) minX = nx - lblW
        if (nx + lblW > maxX) maxX = nx + lblW
        if (ny - lblH < minY) minY = ny - lblH
        if (ny > maxY) maxY = ny
      } else {
        if (nx < minX) minX = nx
        if (nx > maxX) maxX = nx
        if (ny < minY) minY = ny
        if (ny > maxY) maxY = ny
      }
    }
    if (validCount === 0) return null
    const bw = maxX - minX || 1
    const bh = maxY - minY || 1
    const k = Math.max(Math.min(usableW / bw, usableH / bh, 2), 0.05)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const tx = width / 2 - cx * k
    const ty = height / 2 - cy * k
    return zoomIdentity.translate(tx, ty).scale(k)
  }

  function applyTransform(t: typeof zoomIdentity) {
    currentTransform = t
    stage.scale.set(t.k, t.k)
    stage.position.set(t.x, t.y)
    for (const n of nodeRenderData) {
      n.label.scale.set(1 / (scale * t.k))
    }
    suppressZoomHandler = true
    canvasSelection.call(zoomBehavior.transform, t)
    suppressZoomHandler = false
  }

  function anchorAllNodes() {
    for (const n of graphData.nodes) {
      if (n.x != null && n.y != null && !hiddenNodes.has(n.id)) {
        n.fx = n.x
        n.fy = n.y
      }
    }
  }

  function fitToView() {
    if (!enableZoom || graphData.nodes.length === 0) return
    const t = computeFitTransform()
    if (t) applyTransform(t)
    anchorAllNodes()
  }

  // ── Shared layout helpers ──────────────────────────────────────

  type LayoutUnit = NodeData[]

  function buildLayoutData() {
    const visibleNodes = graphData.nodes.filter((n) => !hiddenNodes.has(n.id))
    const genGroups = new Map<number, NodeData[]>()
    for (const n of visibleNodes) {
      const g = gens.get(n.id as SimpleSlug) ?? 0
      if (!genGroups.has(g)) genGroups.set(g, [])
      genGroups.get(g)!.push(n)
    }
    const sortedGens = [...genGroups.keys()].sort((a, b) => a - b)

    const spousePairs = new Map<string, string>()
    const childrenOf = new Map<string, string[]>()
    const parentsOf = new Map<string, string[]>()
    for (const n of visibleNodes) {
      const fe = familyData[n.id as SimpleSlug] as FamilyEntry | undefined
      if (!fe) continue
      for (const sp of fe.spouses) {
        if (!hiddenNodes.has(sp) && nodeMap.has(sp) && !spousePairs.has(n.id) && !spousePairs.has(sp)) {
          spousePairs.set(n.id, sp)
        }
      }
      for (const child of fe.children) {
        if (!hiddenNodes.has(child) && nodeMap.has(child)) {
          if (!childrenOf.has(n.id)) childrenOf.set(n.id, [])
          childrenOf.get(n.id)!.push(child)
        }
      }
      for (const p of [fe.father, fe.mother]) {
        if (p && !hiddenNodes.has(p) && nodeMap.has(p)) {
          if (!parentsOf.has(n.id)) parentsOf.set(n.id, [])
          parentsOf.get(n.id)!.push(p)
        }
      }
    }

    const genUnits = new Map<number, LayoutUnit[]>()
    for (const gen of sortedGens) {
      const row = genGroups.get(gen)!
      const units: LayoutUnit[] = []
      const placed = new Set<string>()
      for (const n of row) {
        if (placed.has(n.id)) continue
        const sp = spousePairs.get(n.id)
        if (sp && row.some((m) => m.id === sp)) {
          units.push([n, nodeMap.get(sp)!])
          placed.add(n.id)
          placed.add(sp)
        } else {
          const rev = [...spousePairs.entries()].find(([, v]) => v === n.id)?.[0]
          if (rev && row.some((m) => m.id === rev)) continue
          units.push([n])
          placed.add(n.id)
        }
      }
      genUnits.set(gen, units)
    }

    return { visibleNodes, sortedGens, genUnits, childrenOf, parentsOf, spousePairs }
  }

  const H_SPACING = 120
  const SPOUSE_GAP = 40
  const V_SPACING = 120

  function unitLeft(u: LayoutUnit, posX: Map<string, number>) {
    return Math.min(...u.map((n) => posX.get(n.id) ?? 0))
  }
  function unitRight(u: LayoutUnit, posX: Map<string, number>) {
    return Math.max(...u.map((n) => posX.get(n.id) ?? 0))
  }
  function shiftUnit(u: LayoutUnit, dx: number, posX: Map<string, number>) {
    for (const n of u) posX.set(n.id, (posX.get(n.id) ?? 0) + dx)
  }
  function unitCenter(u: LayoutUnit, posX: Map<string, number>) {
    return u.reduce((s, n) => s + (posX.get(n.id) ?? 0), 0) / u.length
  }

  function placeUnit(u: LayoutUnit, cx: number, posX: Map<string, number>) {
    if (u.length === 2) {
      posX.set(u[0].id, cx - SPOUSE_GAP / 2)
      posX.set(u[1].id, cx + SPOUSE_GAP / 2)
    } else {
      posX.set(u[0].id, cx)
    }
  }

  function resolveOverlaps(units: LayoutUnit[], posX: Map<string, number>) {
    if (units.length < 2) return
    units.sort((a, b) => unitLeft(a, posX) - unitLeft(b, posX))
    for (let i = 1; i < units.length; i++) {
      const overlap = unitRight(units[i - 1], posX) + H_SPACING - unitLeft(units[i], posX)
      if (overlap > 0) shiftUnit(units[i], overlap, posX)
    }
    const totalCenter = (unitLeft(units[0], posX) + unitRight(units[units.length - 1], posX)) / 2
    for (const u of units) shiftUnit(u, -totalCenter, posX)
  }

  function avgNeighborX(
    unit: LayoutUnit,
    neighborMap: Map<string, string[]>,
    posX: Map<string, number>,
  ): number | null {
    const xs: number[] = []
    for (const n of unit) {
      for (const nb of neighborMap.get(n.id) ?? []) {
        const px = posX.get(nb)
        if (px != null) xs.push(px)
      }
    }
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
  }

  function applyPositions(
    visibleNodes: NodeData[],
    sortedGens: number[],
    posX: Map<string, number>,
  ) {
    const minGen = sortedGens[0] ?? 0
    for (const n of visibleNodes) {
      const g = gens.get(n.id as SimpleSlug) ?? 0
      n.fx = posX.get(n.id) ?? 0
      n.fy = (g - minGen) * V_SPACING
      n.x = n.fx
      n.y = n.fy
    }
    simulation.alpha(0.3).restart()
    const t = computeFitTransform()
    if (t) applyTransform(t)
  }

  // ── Layout: Force (default D3 simulation) ────────────────────

  function layoutForce() {
    for (const n of graphData.nodes) {
      n.fx = null
      n.fy = null
    }
    clearSelection()
    simulation.alpha(0.3).restart()
    applyTransform(zoomIdentity)
  }

  // ── Layout: Layered (Sugiyama with iterative crossing min) ───

  function layoutLayered() {
    const data = buildLayoutData()
    if (data.visibleNodes.length === 0) return
    const { visibleNodes, sortedGens, genUnits, childrenOf, parentsOf } = data
    const posX = new Map<string, number>()

    // Initial top-down placement sorted by parent barycenter
    for (const gen of sortedGens) {
      const units = genUnits.get(gen)!
      units.sort((a, b) => {
        const ax = avgNeighborX(a, parentsOf, posX)
        const bx = avgNeighborX(b, parentsOf, posX)
        if (ax !== null && bx !== null) return ax - bx
        if (ax !== null) return -1
        if (bx !== null) return 1
        return 0
      })
      let totalW = 0
      for (const u of units) totalW += u.length === 2 ? SPOUSE_GAP : 0
      totalW += (units.length - 1) * H_SPACING
      let x = -totalW / 2
      for (const unit of units) {
        placeUnit(unit, x + (unit.length === 2 ? SPOUSE_GAP / 2 : 0), posX)
        x += (unit.length === 2 ? SPOUSE_GAP : 0) + H_SPACING
      }
    }

    // 4 iterations of alternating up/down sweeps for crossing minimization
    for (let iter = 0; iter < 4; iter++) {
      // Bottom-up: center parents above children
      for (const gen of [...sortedGens].reverse()) {
        const units = genUnits.get(gen)!
        for (const unit of units) {
          const cx = avgNeighborX(unit, childrenOf, posX)
          if (cx !== null) shiftUnit(unit, cx - unitCenter(unit, posX), posX)
        }
        resolveOverlaps(units, posX)
      }
      // Top-down: center children under parents
      for (const gen of sortedGens) {
        const units = genUnits.get(gen)!
        for (const unit of units) {
          const px = avgNeighborX(unit, parentsOf, posX)
          if (px !== null) shiftUnit(unit, px - unitCenter(unit, posX), posX)
        }
        resolveOverlaps(units, posX)
      }
    }

    applyPositions(visibleNodes, sortedGens, posX)
    anchorAllNodes()
  }

  // ── Layout: Compact (recursive subtree width allocation) ─────

  function layoutCompact() {
    const data = buildLayoutData()
    if (data.visibleNodes.length === 0) return
    const { visibleNodes, sortedGens, genUnits, childrenOf } = data
    const posX = new Map<string, number>()

    // Map each child unit to its parent unit
    const unitChildUnits = new Map<LayoutUnit, LayoutUnit[]>()
    const claimed = new Set<LayoutUnit>()
    for (const gen of sortedGens) {
      const nextUnits = genUnits.get(gen + 1)
      if (!nextUnits) continue
      for (const pUnit of genUnits.get(gen)!) {
        const children: LayoutUnit[] = []
        for (const p of pUnit) {
          for (const childId of childrenOf.get(p.id) ?? []) {
            const cu = nextUnits.find((u) => u.some((m) => m.id === childId))
            if (cu && !claimed.has(cu) && !children.includes(cu)) {
              children.push(cu)
              claimed.add(cu)
            }
          }
        }
        unitChildUnits.set(pUnit, children)
      }
    }

    // Compute subtree widths (bottom-up)
    const subtreeW = new Map<LayoutUnit, number>()
    for (const gen of [...sortedGens].reverse()) {
      for (const unit of genUnits.get(gen)!) {
        const children = unitChildUnits.get(unit) ?? []
        const childW = children.reduce((s, cu) => s + (subtreeW.get(cu) ?? 1), 0)
        subtreeW.set(unit, Math.max(1, childW))
      }
    }

    // Position recursively (top-down)
    function positionSubtree(unit: LayoutUnit, cx: number) {
      placeUnit(unit, cx, posX)
      const children = unitChildUnits.get(unit) ?? []
      if (children.length === 0) return
      const totalChildW = children.reduce((s, cu) => s + (subtreeW.get(cu) ?? 1), 0)
      let x = cx - (totalChildW * H_SPACING) / 2
      for (const cu of children) {
        const w = (subtreeW.get(cu) ?? 1) * H_SPACING
        positionSubtree(cu, x + w / 2)
        x += w
      }
    }

    // Start from top generation
    const topUnits = genUnits.get(sortedGens[0]) ?? []
    const totalTopW = topUnits.reduce((s, u) => s + (subtreeW.get(u) ?? 1), 0)
    let topX = -(totalTopW * H_SPACING) / 2
    for (const unit of topUnits) {
      const w = (subtreeW.get(unit) ?? 1) * H_SPACING
      positionSubtree(unit, topX + w / 2)
      topX += w
    }

    // Place any orphan units (units not claimed by any parent, in lower generations)
    for (const gen of sortedGens) {
      for (const unit of genUnits.get(gen)!) {
        if (!posX.has(unit[0].id)) {
          placeUnit(unit, 0, posX)
        }
      }
      resolveOverlaps(genUnits.get(gen)!, posX)
    }

    applyPositions(visibleNodes, sortedGens, posX)
    anchorAllNodes()
  }

  // ── Layout: Horizontal (left-to-right tree) ──────────────────

  function layoutHorizontal() {
    const data = buildLayoutData()
    if (data.visibleNodes.length === 0) return
    const { visibleNodes, sortedGens, genUnits, childrenOf, parentsOf } = data
    const posY = new Map<string, number>()

    for (const gen of sortedGens) {
      const units = genUnits.get(gen)!
      units.sort((a, b) => {
        const ax = avgNeighborX(a, parentsOf, posY)
        const bx = avgNeighborX(b, parentsOf, posY)
        if (ax !== null && bx !== null) return ax - bx
        if (ax !== null) return -1
        if (bx !== null) return 1
        return 0
      })
      let totalW = 0
      for (const u of units) totalW += u.length === 2 ? SPOUSE_GAP : 0
      totalW += (units.length - 1) * H_SPACING
      let y = -totalW / 2
      for (const unit of units) {
        if (unit.length === 2) {
          posY.set(unit[0].id, y)
          posY.set(unit[1].id, y + SPOUSE_GAP)
          y += SPOUSE_GAP + H_SPACING
        } else {
          posY.set(unit[0].id, y)
          y += H_SPACING
        }
      }
    }

    for (let iter = 0; iter < 4; iter++) {
      for (const gen of [...sortedGens].reverse()) {
        const units = genUnits.get(gen)!
        for (const unit of units) {
          const cx = avgNeighborX(unit, childrenOf, posY)
          if (cx !== null) {
            const uc = unit.reduce((s, n) => s + (posY.get(n.id) ?? 0), 0) / unit.length
            for (const n of unit) posY.set(n.id, (posY.get(n.id) ?? 0) + (cx - uc))
          }
        }
        resolveOverlaps(units, posY)
      }
      for (const gen of sortedGens) {
        const units = genUnits.get(gen)!
        for (const unit of units) {
          const px = avgNeighborX(unit, parentsOf, posY)
          if (px !== null) {
            const uc = unit.reduce((s, n) => s + (posY.get(n.id) ?? 0), 0) / unit.length
            for (const n of unit) posY.set(n.id, (posY.get(n.id) ?? 0) + (px - uc))
          }
        }
        resolveOverlaps(units, posY)
      }
    }

    const minGen = sortedGens[0] ?? 0
    for (const n of visibleNodes) {
      const g = gens.get(n.id as SimpleSlug) ?? 0
      n.fx = (g - minGen) * V_SPACING
      n.fy = posY.get(n.id) ?? 0
      n.x = n.fx
      n.y = n.fy
    }
    simulation.alpha(0.3).restart()
    const t = computeFitTransform()
    if (t) applyTransform(t)
    anchorAllNodes()
  }

  // ── Layout: Radial (concentric rings by generation) ──────────

  function layoutRadial() {
    const data = buildLayoutData()
    if (data.visibleNodes.length === 0) return
    const { visibleNodes, sortedGens, genUnits, childrenOf, parentsOf } = data

    const centerGen = gens.get(center) ?? 0
    const ringSpacing = 140

    const angularPos = new Map<string, number>()

    const gensSorted = [...sortedGens].sort((a, b) => Math.abs(a - centerGen) - Math.abs(b - centerGen))

    for (const gen of gensSorted) {
      const units = genUnits.get(gen)!

      units.sort((a, b) => {
        const ax = avgNeighborX(a, parentsOf, angularPos) ?? avgNeighborX(a, childrenOf, angularPos)
        const bx = avgNeighborX(b, parentsOf, angularPos) ?? avgNeighborX(b, childrenOf, angularPos)
        if (ax !== null && bx !== null) return ax - bx
        if (ax !== null) return -1
        if (bx !== null) return 1
        return 0
      })

      const nodeCount = units.reduce((s, u) => s + u.length, 0)
      if (gen === centerGen && nodeCount <= 2) {
        let angle = 0
        for (const unit of units) {
          for (const n of unit) {
            angularPos.set(n.id, angle)
            angle += (2 * Math.PI) / Math.max(nodeCount, 1)
          }
        }
      } else {
        const totalSlots = Math.max(nodeCount, 6)
        const sliceSize = (2 * Math.PI) / totalSlots
        let idx = 0
        for (const unit of units) {
          for (const n of unit) {
            angularPos.set(n.id, idx * sliceSize)
            idx++
          }
        }
      }
    }

    for (let iter = 0; iter < 3; iter++) {
      for (const gen of sortedGens) {
        if (gen === centerGen) continue
        const units = genUnits.get(gen)!
        for (const unit of units) {
          const parentAngle = avgNeighborX(unit, parentsOf, angularPos)
          const childAngle = avgNeighborX(unit, childrenOf, angularPos)
          const target = parentAngle ?? childAngle
          if (target !== null) {
            const uc = unit.reduce((s, n) => s + (angularPos.get(n.id) ?? 0), 0) / unit.length
            const shift = target - uc
            for (const n of unit) angularPos.set(n.id, (angularPos.get(n.id) ?? 0) + shift)
          }
        }
      }
    }

    for (const n of visibleNodes) {
      const g = gens.get(n.id as SimpleSlug) ?? 0
      const ring = Math.abs(g - centerGen)
      const angle = angularPos.get(n.id) ?? 0
      if (ring === 0) {
        n.fx = 0
        n.fy = 0
      } else {
        const r = ring * ringSpacing
        n.fx = r * Math.cos(angle - Math.PI / 2)
        n.fy = r * Math.sin(angle - Math.PI / 2)
      }
      n.x = n.fx
      n.y = n.fy
    }
    simulation.alpha(0.3).restart()
    const t = computeFitTransform()
    if (t) applyTransform(t)
    anchorAllNodes()
  }

  function resetView() {
    if (!enableZoom) return
    hiddenNodes.clear()
    clearSelection()
    applyVisibility()
    for (const n of nodeRenderData) {
      n.simulationData.fx = null
      n.simulationData.fy = null
    }
    simulation.alpha(0.3).restart()
    applyTransform(zoomIdentity)
  }

  function setShowNames(on: boolean) {
    showNames = on
    for (const label of labelsContainer.children) {
      ;(label as Text).alpha = on ? 1 : 0
    }
  }

  let hebrewMode = false

  function setHebrew(on: boolean) {
    hebrewMode = on
    for (const n of nodeRenderData) {
      const fe = familyData[n.simulationData.id] as FamilyEntry | undefined
      if (on && fe?.hebrewName) {
        n.label.text = fe.hebrewName
        n.simulationData.text = fe.hebrewName
      } else {
        const engName = fe?.name ?? n.simulationData.id
        n.label.text = engName
        n.simulationData.text = engName
      }
    }
  }

  return {
    cleanup: () => {
      closeContextMenu()
      stopAnimation = true
      resizeObserver?.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      document.removeEventListener("keydown", onKeyDown)
      app.canvas.removeEventListener("mousedown", onRectMouseDown, true)
      window.removeEventListener("mousemove", onRectMouseMove)
      window.removeEventListener("mouseup", onRectMouseUp)
      app.destroy()
    },
    fitToView,
    resetView,
    applyLayout: (name: string) => {
      if (name === "layered") layoutLayered()
      else if (name === "compact") layoutCompact()
      else if (name === "horizontal") layoutHorizontal()
      else if (name === "radial") layoutRadial()
      else layoutForce()
    },
    setShowNames,
    setHebrew,
    refreshTheme: () => {
      for (const key of cssVars) {
        computedStyleMap[key] = getComputedStyle(document.documentElement).getPropertyValue(key).trim()
      }
      for (const n of nodeRenderData) {
        const newColor = color(n.simulationData)
        n.color = newColor
        n.gfx.clear().circle(0, 0, nodeRadius(n.simulationData)).fill({ color: newColor })
        n.label.style.fill = computedStyleMap["--dark"]
        n.selRing.clear().circle(0, 0, nodeRadius(n.simulationData) + 3)
          .stroke({ width: 2, color: computedStyleMap["--secondary"] })
      }
      for (const l of linkRenderData) {
        l.color = computedStyleMap["--lightgray"]
      }
    },
    getSnapshot: (): NodeSnapshot => {
      const positions: [string, number, number][] = []
      for (const n of nodeRenderData) {
        if (hiddenNodes.has(n.simulationData.id)) continue
        const x = n.simulationData.x ?? 0
        const y = n.simulationData.y ?? 0
        positions.push([n.simulationData.id, Math.round(x), Math.round(y)])
      }
      return {
        positions,
        hidden: [...hiddenNodes],
        zoom: [
          Math.round(currentTransform.x),
          Math.round(currentTransform.y),
          Math.round(currentTransform.k * 1000) / 1000,
        ],
      }
    },
    restoreSnapshot: (snap: NodeSnapshot) => {
      for (const id of snap.hidden) {
        hiddenNodes.add(id)
      }

      const newNodeIds: SimpleSlug[] = []
      for (const [id, x, y] of snap.positions) {
        const slug = id as SimpleSlug
        if (nodeMap.has(slug)) continue
        const fe = familyData[slug] as FamilyEntry | undefined
        if (!fe) continue

        const gen = computeGenerations(familyData, center, new Set([center, slug])).get(slug) ?? 0
        gens.set(slug, gen)

        const n: NodeData = { id: slug, text: fe.name ?? slug, x, y }
        n.fx = x
        n.fy = y
        graphData.nodes.push(n)
        nodeMap.set(slug, n)
        neighbourhood.add(slug)
        newNodeIds.push(slug)
      }

      if (newNodeIds.length > 0) {
        const allVisible = new Set(snap.positions.map(([id]) => id as SimpleSlug))
        for (const nid of newNodeIds) {
          const fe = familyData[nid] as FamilyEntry | undefined
          if (!fe) continue
          for (const parent of [fe.father, fe.mother]) {
            if (parent && allVisible.has(parent) && nodeMap.has(parent)) {
              const exists = graphData.links.some(
                (l) => (l.source.id === parent && l.target.id === nid) || (l.source.id === nid && l.target.id === parent),
              )
              if (!exists) {
                const ld: FamilyLinkData = { source: nodeMap.get(parent)!, target: nodeMap.get(nid)!, type: "parent-child" }
                graphData.links.push(ld)
                const gfx = new Graphics({ interactive: false, eventMode: "none" })
                linkContainer.addChild(gfx)
                linkRenderData.push({ simulationData: ld, gfx, color: computedStyleMap["--lightgray"], alpha: 1, active: false })
              }
            }
          }
          for (const sp of fe.spouses) {
            if (allVisible.has(sp) && nodeMap.has(sp)) {
              const exists = graphData.links.some(
                (l) => (l.source.id === sp && l.target.id === nid) || (l.source.id === nid && l.target.id === sp),
              )
              if (!exists) {
                const ld: FamilyLinkData = { source: nodeMap.get(nid)!, target: nodeMap.get(sp)!, type: "spouse" }
                graphData.links.push(ld)
                const gfx = new Graphics({ interactive: false, eventMode: "none" })
                linkContainer.addChild(gfx)
                linkRenderData.push({ simulationData: ld, gfx, color: computedStyleMap["--lightgray"], alpha: 1, active: false })
              }
            }
          }
          for (const ch of fe.children) {
            if (allVisible.has(ch) && nodeMap.has(ch)) {
              const exists = graphData.links.some(
                (l) => (l.source.id === nid && l.target.id === ch) || (l.source.id === ch && l.target.id === nid),
              )
              if (!exists) {
                const ld: FamilyLinkData = { source: nodeMap.get(nid)!, target: nodeMap.get(ch)!, type: "parent-child" }
                graphData.links.push(ld)
                const gfx = new Graphics({ interactive: false, eventMode: "none" })
                linkContainer.addChild(gfx)
                linkRenderData.push({ simulationData: ld, gfx, color: computedStyleMap["--lightgray"], alpha: 1, active: false })
              }
            }
          }
        }

        for (const nid of newNodeIds) {
          const n = nodeMap.get(nid)!
          const fe = familyData[nid] as FamilyEntry | undefined
          const displayText = hebrewMode && fe?.hebrewName ? fe.hebrewName : (fe?.name ?? nid)
          const nColor = nodeColor(nid, center, gens, spouseSet, computedStyleMap)
          const r = nodeRadius(n)
          const labelAlpha = showNames ? 1 : 0
          const label = new Text({
            interactive: false, eventMode: "none", text: displayText,
            alpha: labelAlpha, anchor: { x: 0.5, y: 1.2 },
            style: { fontSize: fontSize * 15, fill: computedStyleMap["--dark"], fontFamily: computedStyleMap["--bodyFont"] },
            resolution: window.devicePixelRatio * 4,
          })
          label.scale.set(1 / scale)
          n.text = displayText
          let oldLabelOpacity = labelAlpha
          const nodeGfx = new Graphics({ interactive: true, label: nid, eventMode: "static", hitArea: new Circle(0, 0, r + hitPadding), cursor: "pointer" })
            .circle(0, 0, r).fill({ color: nColor })
            .on("pointerover", () => { updateHoverInfo(nid); oldLabelOpacity = label.alpha; if (!dragging) renderPixiFromD3() })
            .on("pointerleave", () => { updateHoverInfo(null); label.alpha = oldLabelOpacity; if (!dragging) renderPixiFromD3() })
          const selRing = new Graphics({ interactive: false, eventMode: "none", visible: false })
          selRing.circle(0, 0, r + 3).stroke({ width: 2, color: computedStyleMap["--secondary"] })
          nodesContainer.addChild(nodeGfx)
          labelsContainer.addChild(label)
          selectionRingContainer.addChild(selRing)
          nodeRenderData.push({ simulationData: n, gfx: nodeGfx, label, selRing, color: nColor, alpha: 1, active: false })
        }

        simulation.nodes(graphData.nodes)
        simulation.force(
          "link",
          forceLink(graphData.links)
            .id((d) => (d as NodeData).id)
            .distance((l) => ((l as FamilyLinkData).type === "spouse" ? 20 : linkDistance)),
        )
      }

      applyVisibility()
      for (const [id, x, y] of snap.positions) {
        const nd = graphData.nodes.find((n) => n.id === id)
        if (nd) {
          nd.x = x
          nd.y = y
          nd.fx = x
          nd.fy = y
        }
      }
      simulation.alpha(0).stop()
      const [zx, zy, zk] = snap.zoom
      const t = zoomIdentity.translate(zx, zy).scale(zk)
      applyTransform(t)
    },
  }
}

let localGraphHandles: GraphHandle[] = []
let globalGraphHandles: GraphHandle[] = []

function cleanupLocalGraphs() {
  for (const h of localGraphHandles) h.cleanup()
  localGraphHandles = []
}

function cleanupGlobalGraphs() {
  for (const h of globalGraphHandles) h.cleanup()
  globalGraphHandles = []
}

document.addEventListener("nav", async (e: CustomEventMap["nav"]) => {
  const slug = e.detail.url
  const familyData = await getFamilyData()
  const currentSlug = simplifySlug(slug)

  const localContainers = document.getElementsByClassName("family-graph-container")
  for (const container of localContainers) {
    const parent = (container as HTMLElement).closest(".family-graph") as HTMLElement
    if (!familyData[currentSlug]) {
      if (parent) parent.style.display = "none"
    } else {
      if (parent) parent.style.display = ""
    }
  }

  async function renderLocalGraph() {
    cleanupLocalGraphs()
    const localGraphContainers = document.getElementsByClassName("family-graph-container")
    for (const container of localGraphContainers) {
      if (familyData[currentSlug]) {
        localGraphHandles.push(
          await renderFamilyGraph(container as HTMLElement, slug, false),
        )
      }
    }
  }

  await renderLocalGraph()

  const handleThemeChange = () => {
    void renderLocalGraph()
  }
  document.addEventListener("themechange", handleThemeChange)
  window.addCleanup(() => {
    document.removeEventListener("themechange", handleThemeChange)
  })

  const containers = [...document.getElementsByClassName("global-graph-outer")] as HTMLElement[]

  let currentDepth = 2
  let currentDirection: Direction = "both"
  let currentCenter: SimpleSlug = currentSlug
  let currentShowNames = false
  let currentHebrew = false
  let currentLayout = "force"

  function showToast(message: string) {
    const existing = document.querySelector(".graph-toast")
    if (existing) existing.remove()
    const toast = document.createElement("div")
    toast.className = "graph-toast"
    toast.textContent = message
    document.body.appendChild(toast)
    requestAnimationFrame(() => toast.classList.add("visible"))
    setTimeout(() => {
      toast.classList.remove("visible")
      setTimeout(() => toast.remove(), 300)
    }, 2000)
  }

  function copyToClipboard(text: string): boolean {
    try {
      const ta = document.createElement("textarea")
      ta.value = text
      ta.style.position = "fixed"
      ta.style.left = "-9999px"
      ta.style.top = "-9999px"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      ta.setSelectionRange(0, text.length)
      const ok = document.execCommand("copy")
      ta.remove()
      return ok
    } catch {
      return false
    }
  }

  function shareOrCopy(shareUrl: string) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(shareUrl).then(
        () => showToast("Link copied to clipboard"),
        () => {
          if (copyToClipboard(shareUrl)) showToast("Link copied to clipboard")
          else showUrlDialog(shareUrl)
        },
      )
    } else if (copyToClipboard(shareUrl)) {
      showToast("Link copied to clipboard")
    } else {
      showUrlDialog(shareUrl)
    }
  }

  function showUrlDialog(shareUrl: string) {
    const existing = document.querySelector(".graph-share-dialog")
    if (existing) existing.remove()
    const overlay = document.createElement("div")
    overlay.className = "graph-share-dialog"
    const box = document.createElement("div")
    box.className = "graph-share-dialog-box"
    const label = document.createElement("p")
    label.textContent = "Copy this link:"
    const input = document.createElement("input")
    input.type = "text"
    input.value = shareUrl
    input.readOnly = true
    input.addEventListener("focus", () => input.select())
    const closeBtn = document.createElement("button")
    closeBtn.type = "button"
    closeBtn.textContent = "Close"
    closeBtn.addEventListener("click", () => overlay.remove())
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove()
    })
    box.appendChild(label)
    box.appendChild(input)
    box.appendChild(closeBtn)
    overlay.appendChild(box)
    document.body.appendChild(overlay)
    input.focus()
    input.select()
  }

  function captureAndShare() {
    const snap = globalGraphHandles[0]?.getSnapshot()
    if (!snap) return
    const state: GraphSnapshot = {
      c: currentCenter,
      d: currentDepth,
      r: currentDirection === "up" ? "u" : currentDirection === "down" ? "d" : "b",
      l: currentLayout,
      n: currentShowNames,
      h: currentHebrew,
      z: snap.zoom,
      p: snap.positions,
    }
    if (snap.hidden.length > 0) state.hd = snap.hidden
    const compressed = compressToEncodedURIComponent(JSON.stringify(state))
    const url = new URL(window.location.href)
    url.hash = "g=" + compressed
    const shareUrl = url.toString()
    history.replaceState(null, "", url.toString())

    const isTouch = "ontouchstart" in window
    if (isTouch && navigator.share) {
      navigator.share({ title: "Family Graph", url: shareUrl }).catch(() => {
        shareOrCopy(shareUrl)
      })
    } else {
      shareOrCopy(shareUrl)
    }
  }

  function parseHashState(): GraphSnapshot | null {
    const hash = window.location.hash
    if (!hash.startsWith("#g=")) return null
    try {
      const json = decompressFromEncodedURIComponent(hash.slice(3))
      if (!json) return null
      return JSON.parse(json) as GraphSnapshot
    } catch {
      return null
    }
  }

  function syncShowNames() {
    if (currentShowNames) {
      for (const h of globalGraphHandles) h.setShowNames(true)
    }
  }

  function syncHebrew() {
    if (currentHebrew) {
      for (const h of globalGraphHandles) h.setHebrew(true)
    }
  }

  async function recenterGraph(newCenter: SimpleSlug) {
    currentCenter = newCenter
    cleanupGlobalGraphs()
    for (const container of containers) {
      if (!container.classList.contains("active")) continue
      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      if (graphContainer && familyData[newCenter]) {
        globalGraphHandles.push(
          await renderFamilyGraph(graphContainer, slug, true, {
            center: newCenter,
            depth: currentDepth,
            direction: currentDirection,
            onRecenter: recenterGraph,
            onShare: captureAndShare,
          }),
        )
      }
    }
    syncShowNames()
    syncHebrew()
    updateSheetSummary()
  }

  async function rebuildGraph() {
    cleanupGlobalGraphs()
    for (const container of containers) {
      if (!container.classList.contains("active")) continue
      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      if (graphContainer && familyData[currentCenter]) {
        globalGraphHandles.push(
          await renderFamilyGraph(graphContainer, slug, true, {
            center: currentCenter,
            depth: currentDepth,
            direction: currentDirection,
            onRecenter: recenterGraph,
            onShare: captureAndShare,
          }),
        )
      }
    }
    syncShowNames()
    syncHebrew()
    updateSheetSummary()
  }

  const isMobile = window.matchMedia("(max-width: 768px)").matches

  function updateSheetSummary() {
    for (const container of containers) {
      const nameEl = container.querySelector(".sheet-summary-name")
      const infoEl = container.querySelector(".sheet-summary-info")
      if (nameEl) {
        const entry = familyData[currentCenter] as FamilyEntry | undefined
        nameEl.textContent = entry?.name ?? String(currentCenter)
      }
      if (infoEl) {
        const depthLabel = currentDepth >= 999 ? "All" : String(currentDepth)
        const layoutSel = container.querySelector(".layout-select") as HTMLSelectElement | null
        const layoutLabel = layoutSel?.selectedOptions[0]?.text ?? "Force"
        infoEl.textContent = `Depth ${depthLabel} · ${layoutLabel}`
      }
    }
  }

  function initBottomSheet(toolbar: HTMLElement) {
    if (!isMobile) return
    toolbar.classList.add("sheet-minimized")
    updateSheetSummary()

    const handle = toolbar.querySelector(".sheet-handle") as HTMLElement | null
    if (!handle) return

    let sheetState: "minimized" | "expanded" | "hidden" = "minimized"
    let touchStartY = 0
    let touchDeltaY = 0

    function setSheetState(state: "minimized" | "expanded" | "hidden") {
      sheetState = state
      toolbar.classList.remove("sheet-minimized", "sheet-expanded", "sheet-hidden")
      toolbar.classList.add(`sheet-${state}`)
      if (state === "minimized") updateSheetSummary()
    }

    const graphContainer = toolbar.closest(".global-graph-outer")?.querySelector(".global-graph-container")
    graphContainer?.addEventListener("click", () => {
      if (sheetState === "expanded") {
        setSheetState("minimized")
      }
    })

    handle.addEventListener("click", () => {
      if (sheetState === "minimized") setSheetState("expanded")
      else if (sheetState === "expanded") setSheetState("minimized")
      else setSheetState("minimized")
    })

    toolbar.addEventListener("touchstart", (e) => {
      const target = e.target as HTMLElement
      if (target.closest(".sheet-controls")) return
      if (e.touches.length !== 1) return
      touchStartY = e.touches[0].clientY
      touchDeltaY = 0
    }, { passive: true })

    toolbar.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return
      touchDeltaY = e.touches[0].clientY - touchStartY
    }, { passive: true })

    toolbar.addEventListener("touchend", () => {
      if (Math.abs(touchDeltaY) < 30) return
      if (touchDeltaY < 0) {
        if (sheetState === "hidden") setSheetState("minimized")
        else if (sheetState === "minimized") setSheetState("expanded")
      } else {
        if (sheetState === "expanded") setSheetState("minimized")
        else if (sheetState === "minimized") setSheetState("hidden")
      }
      touchDeltaY = 0
    }, { passive: true })
  }

  let toolbarAbort: AbortController | null = null

  async function renderGlobalGraph(snapshot?: GraphSnapshot | null) {
    if (toolbarAbort) toolbarAbort.abort()
    toolbarAbort = new AbortController()
    const signal = toolbarAbort.signal

    const restoring = snapshot != null
    if (restoring) {
      currentCenter = snapshot.c as SimpleSlug
      currentDepth = snapshot.d
      currentDirection = snapshot.r === "u" ? "up" : snapshot.r === "d" ? "down" : "both"
      currentLayout = snapshot.l || "force"
      currentShowNames = snapshot.n
      currentHebrew = snapshot.h
    } else {
      currentCenter = currentSlug
      currentDepth = 2
      currentDirection = "both"
      currentLayout = "force"
      currentShowNames = false
      currentHebrew = false
    }

    const depthSel = containers[0]?.querySelector(".family-depth") as HTMLSelectElement
    if (depthSel) depthSel.value = String(currentDepth >= 999 ? 999 : currentDepth)
    const dirBtns = containers[0]?.querySelectorAll(".dir-btn")
    dirBtns?.forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-dir") === currentDirection)
    })
    const showNamesCb = containers[0]?.querySelector(".show-names-cb") as HTMLInputElement
    if (showNamesCb) showNamesCb.checked = currentShowNames
    const hebrewCbReset = containers[0]?.querySelector(".hebrew-names-cb") as HTMLInputElement
    if (hebrewCbReset) hebrewCbReset.checked = currentHebrew
    const layoutSel = containers[0]?.querySelector(".layout-select") as HTMLSelectElement
    if (layoutSel) layoutSel.value = currentLayout

    for (const container of containers) {
      container.classList.add("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) sidebar.style.zIndex = "1"

      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      registerEscapeHandler(container, hideGlobalGraph)

      const closeBtn = container.querySelector(".graph-close-btn")
      closeBtn?.addEventListener("click", hideGlobalGraph, { signal })

      const searchInput = container.querySelector(".family-search") as HTMLInputElement
      let resultsDiv: HTMLDivElement | null = null

      if (searchInput) {
        searchInput.value = ""
        searchInput.addEventListener("input", () => {
          const q = searchInput.value.trim().toLowerCase()
          if (!q) {
            if (resultsDiv) {
              resultsDiv.remove()
              resultsDiv = null
            }
            return
          }
          const matches = Object.entries(familyData)
            .filter(([_, e]) => {
              const name = (e as FamilyEntry).name?.toLowerCase() ?? ""
              const aliases = ((e as FamilyEntry).aliases ?? []).join(" ").toLowerCase()
              return name.includes(q) || aliases.includes(q)
            })
            .slice(0, 8)

          if (!resultsDiv) {
            resultsDiv = document.createElement("div")
            resultsDiv.className = "family-search-results"
            searchInput.parentElement?.appendChild(resultsDiv)
          }
          resultsDiv.innerHTML = ""
          resultsDiv.classList.add("active")
          for (const [s, ent] of matches) {
            const item = document.createElement("button")
            item.type = "button"
            item.textContent = (ent as FamilyEntry).name ?? s
            item.addEventListener("click", () => {
              void recenterGraph(s as SimpleSlug)
              if (resultsDiv) {
                resultsDiv.classList.remove("active")
                resultsDiv.innerHTML = ""
              }
              searchInput.value = ""
            })
            resultsDiv.appendChild(item)
          }
        }, { signal })
        searchInput.addEventListener("blur", () => {
          setTimeout(() => {
            if (resultsDiv) resultsDiv.classList.remove("active")
          }, 150)
        }, { signal })
        searchInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Escape") {
            if (resultsDiv) resultsDiv.classList.remove("active")
            searchInput.blur()
          }
        }, { signal })
      }

      const depthSelect = container.querySelector(".family-depth") as HTMLSelectElement
      if (depthSelect) {
        depthSelect.addEventListener("change", () => {
          currentDepth = parseInt(depthSelect.value, 10)
          void rebuildGraph()
        }, { signal })
      }

      const dirButtons = container.querySelectorAll(".dir-btn")
      dirButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const dir = btn.getAttribute("data-dir") as Direction
          currentDirection = dir
          dirButtons.forEach((b) => b.classList.toggle("active", b.getAttribute("data-dir") === dir))
          void rebuildGraph()
        }, { signal })
      })

      const showNamesCb = container.querySelector(".show-names-cb") as HTMLInputElement
      showNamesCb?.addEventListener("change", () => {
        currentShowNames = showNamesCb.checked
        for (const h of globalGraphHandles) h.setShowNames(showNamesCb.checked)
      }, { signal })

      const hebrewCb = container.querySelector(".hebrew-names-cb") as HTMLInputElement
      hebrewCb?.addEventListener("change", () => {
        currentHebrew = hebrewCb.checked
        for (const h of globalGraphHandles) h.setHebrew(hebrewCb.checked)
      }, { signal })

      const fitBtn = container.querySelector(".fit-btn")
      fitBtn?.addEventListener("click", () => {
        for (const h of globalGraphHandles) h.fitToView()
      }, { signal })

      const layoutSelect = container.querySelector(".layout-select") as HTMLSelectElement | null
      layoutSelect?.addEventListener("change", () => {
        currentLayout = layoutSelect.value
        for (const h of globalGraphHandles) h.applyLayout(layoutSelect.value)
      }, { signal })

      const resetBtn = container.querySelector(".reset-btn")
      resetBtn?.addEventListener("click", () => {
        for (const h of globalGraphHandles) h.resetView()
      }, { signal })

      const shareBtn = container.querySelector(".share-btn")
      shareBtn?.addEventListener("click", () => captureAndShare(), { signal })

      const themeBtn = container.querySelector(".theme-btn")
      themeBtn?.addEventListener("click", () => {
        const current = document.documentElement.getAttribute("saved-theme")
        const newTheme = current === "dark" ? "light" : "dark"
        document.documentElement.setAttribute("saved-theme", newTheme)
        localStorage.setItem("theme", newTheme)
        document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: newTheme } }))
        for (const h of globalGraphHandles) h.refreshTheme()
      }, { signal })

      const toolbar = container.querySelector(".global-graph-toolbar") as HTMLElement | null
      if (toolbar) initBottomSheet(toolbar)

      if (graphContainer && familyData[currentCenter]) {
        globalGraphHandles.push(
          await renderFamilyGraph(graphContainer, slug, true, {
            center: currentCenter,
            depth: currentDepth,
            direction: currentDirection,
            onRecenter: recenterGraph,
            onShare: captureAndShare,
          }),
        )
      }

      updateSheetSummary()
    }

    if (restoring) {
      if (currentLayout !== "force") {
        for (const h of globalGraphHandles) h.applyLayout(currentLayout)
      }
      syncShowNames()
      syncHebrew()
      const nodeSnap: NodeSnapshot = {
        positions: snapshot.p,
        hidden: snapshot.hd ?? [],
        zoom: snapshot.z,
      }
      for (const h of globalGraphHandles) h.restoreSnapshot(nodeSnap)
      history.replaceState(null, "", window.location.pathname + window.location.search)
    }
  }

  function hideGlobalGraph() {
    if (toolbarAbort) {
      toolbarAbort.abort()
      toolbarAbort = null
    }
    cleanupGlobalGraphs()
    for (const container of containers) {
      container.classList.remove("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) sidebar.style.zIndex = ""
      const toolbar = container.querySelector(".global-graph-toolbar") as HTMLElement | null
      if (toolbar) {
        toolbar.classList.remove("sheet-minimized", "sheet-expanded", "sheet-hidden")
      }
    }
  }

  async function shortcutHandler(e: HTMLElementEventMap["keydown"]) {
    if (e.key === "g" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      const anyOpen = containers.some((c) => c.classList.contains("active"))
      anyOpen ? hideGlobalGraph() : renderGlobalGraph()
    }
  }

  const containerIcons = document.getElementsByClassName("global-graph-icon")
  Array.from(containerIcons).forEach((icon) => {
    const handler = () => void renderGlobalGraph()
    icon.addEventListener("click", handler)
    window.addCleanup(() => icon.removeEventListener("click", handler))
  })

  document.addEventListener("keydown", shortcutHandler)
  window.addCleanup(() => {
    document.removeEventListener("keydown", shortcutHandler)
    cleanupLocalGraphs()
    cleanupGlobalGraphs()
  })

  const hashState = parseHashState()
  if (hashState) {
    void renderGlobalGraph(hashState)
  }
})
