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
}

type TweenNode = {
  update: (time: number) => void
  stop: () => void
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
  },
): Promise<() => void> {
  const slug = simplifySlug(fullSlug)
  const center = options?.center ?? slug
  const familyData = await getFamilyData()
  const entry = familyData[center]
  if (!entry) {
    return () => {}
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

  const width = graph.offsetWidth
  const height = Math.max(graph.offsetHeight, 250)

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
  let lastDragEvent: { ctrlKey: boolean; metaKey: boolean } | null = null

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

  const labelsContainer = new Container<Text>({ zIndex: 3, isRenderGroup: true })
  const nodesContainer = new Container<Graphics>({ zIndex: 2, isRenderGroup: true })
  const linkContainer = new Container<Graphics>({ zIndex: 1, isRenderGroup: true })
  stage.addChild(nodesContainer, labelsContainer, linkContainer)

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
      hitArea: new Circle(0, 0, nodeRadius(n)),
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

    nodesContainer.addChild(gfx)
    labelsContainer.addChild(label)

    nodeRenderData.push({
      simulationData: n,
      gfx,
      label,
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

  const handleNodeAction = (nodeId: string, modKey: boolean) => {
    const targ = resolveRelative(fullSlug, nodeId)
    if (isGlobal) {
      if (modKey) {
        window.spaNavigate(new URL(targ, window.location.toString()))
      } else {
        onRecenter?.(nodeId as SimpleSlug)
      }
    } else {
      window.spaNavigate(new URL(targ, window.location.toString()))
    }
  }

  let currentTransform = zoomIdentity
  if (enableDrag) {
    select<HTMLCanvasElement, NodeData | undefined>(app.canvas).call(
      drag<HTMLCanvasElement, NodeData | undefined>()
        .container(() => app.canvas)
        .subject(() => graphData.nodes.find((n) => n.id === hoveredNodeId))
        .on("start", function dragstarted(event) {
          if (!event.active) simulation.alphaTarget(0.05).restart()
          event.subject.fx = event.subject.x
          event.subject.fy = event.subject.y
          ;(event.subject as NodeData & { __initialDragPos?: object }).__initialDragPos = {
            x: event.subject.x,
            y: event.subject.y,
            fx: event.subject.fx,
            fy: event.subject.fy,
          }
          dragStartTime = Date.now()
          dragStartPos = { x: event.x, y: event.y }
          dragging = true
        })
        .on("drag", function dragged(event) {
          lastDragEvent = { ctrlKey: event.sourceEvent?.ctrlKey, metaKey: event.sourceEvent?.metaKey }
          const initPos = (event.subject as NodeData & { __initialDragPos?: { x: number; y: number; fx: number; fy: number } })
            .__initialDragPos
          if (initPos) {
            event.subject.fx = initPos.x + (event.x - initPos.x) / currentTransform.k
            event.subject.fy = initPos.y + (event.y - initPos.y) / currentTransform.k
          }
        })
        .on("end", function dragended(event) {
          if (!event.active) simulation.alphaTarget(0)
          dragging = false
          const dx = event.x - dragStartPos.x
          const dy = event.y - dragStartPos.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < 5) {
            const modKey = !!(lastDragEvent?.ctrlKey || lastDragEvent?.metaKey || event.sourceEvent?.ctrlKey || event.sourceEvent?.metaKey)
            handleNodeAction(event.subject.id, modKey)
          }
          lastDragEvent = null
        }),
    )
  } else {
    for (const node of nodeRenderData) {
      node.gfx.on("click", (e: any) => {
        const modKey = !!(e?.ctrlKey || e?.metaKey)
        handleNodeAction(node.simulationData.id, modKey)
      })
    }
  }

  const zoomBehavior = zoom<HTMLCanvasElement, NodeData>()
    .extent([
      [0, 0],
      [width, height],
    ])
    .scaleExtent([0.25, 4])
    .on("zoom", ({ transform }) => {
      currentTransform = transform
      stage.scale.set(transform.k, transform.k)
      stage.position.set(transform.x, transform.y)
          const scaleOpacity = Math.max((transform.k * opacityScale - 1) / 3.75, 0)
          const activeNodes = nodeRenderData.filter((n) => n.active).flatMap((n) => n.label)
          for (const label of labelsContainer.children) {
            if (!activeNodes.includes(label as Text)) {
              ;(label as Text).alpha = scaleOpacity
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
      if (!x || !y) continue
      n.gfx.position.set(x + width / 2, y + height / 2)
      if (n.label) n.label.position.set(x + width / 2, y + height / 2)
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

  function fitToView() {
    if (!enableZoom || graphData.nodes.length === 0) return
    const padding = 50
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const n of graphData.nodes) {
      if (n.x == null || n.y == null) continue
      const nx = n.x + width / 2
      const ny = n.y + height / 2
      if (nx < minX) minX = nx
      if (nx > maxX) maxX = nx
      if (ny < minY) minY = ny
      if (ny > maxY) maxY = ny
    }
    const bw = maxX - minX || 1
    const bh = maxY - minY || 1
    const k = Math.min((width - padding * 2) / bw, (height - padding * 2) / bh, 2)
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const tx = width / 2 - cx * k
    const ty = height / 2 - cy * k
    const fitTransform = zoomIdentity.translate(tx, ty).scale(k)
    currentTransform = fitTransform
    stage.scale.set(k, k)
    stage.position.set(tx, ty)
    for (const n of nodeRenderData) {
      n.label.scale.set(1 / (scale * k))
    }
    canvasSelection.call(zoomBehavior.transform, fitTransform)
  }

  return {
    cleanup: () => {
      stopAnimation = true
      app.destroy()
    },
    fitToView,
  }
}

type GraphHandle = { cleanup: () => void; fitToView: () => void }

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
          }),
        )
      }
    }
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
          }),
        )
      }
    }
  }

  async function renderGlobalGraph() {
    currentCenter = currentSlug
    currentDepth = 2
    currentDirection = "both"

    const depthSel = containers[0]?.querySelector(".family-depth") as HTMLSelectElement
    if (depthSel) {
      depthSel.value = "2"
      currentDepth = 2
    }
    const dirBtns = containers[0]?.querySelectorAll(".dir-btn")
    dirBtns?.forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-dir") === "both")
    })

    for (const container of containers) {
      container.classList.add("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) sidebar.style.zIndex = "1"

      const graphContainer = container.querySelector(".global-graph-container") as HTMLElement
      registerEscapeHandler(container, hideGlobalGraph)

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
        })
        searchInput.addEventListener("blur", () => {
          setTimeout(() => {
            if (resultsDiv) resultsDiv.classList.remove("active")
          }, 150)
        })
        searchInput.addEventListener("keydown", (ev) => {
          if (ev.key === "Escape") {
            if (resultsDiv) resultsDiv.classList.remove("active")
            searchInput.blur()
          }
        })
      }

      const depthSelect = container.querySelector(".family-depth") as HTMLSelectElement
      if (depthSelect) {
        depthSelect.addEventListener("change", () => {
          currentDepth = parseInt(depthSelect.value, 10)
          void rebuildGraph()
        })
      }

      const dirButtons = container.querySelectorAll(".dir-btn")
      dirButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const dir = btn.getAttribute("data-dir") as Direction
          currentDirection = dir
          dirButtons.forEach((b) => b.classList.toggle("active", b.getAttribute("data-dir") === dir))
          void rebuildGraph()
        })
      })

      const fitBtn = container.querySelector(".fit-btn")
      fitBtn?.addEventListener("click", () => {
        for (const h of globalGraphHandles) h.fitToView()
      })

      if (graphContainer && familyData[currentCenter]) {
        globalGraphHandles.push(
          await renderFamilyGraph(graphContainer, slug, true, {
            center: currentCenter,
            depth: currentDepth,
            direction: currentDirection,
            onRecenter: recenterGraph,
          }),
        )
      }
    }
  }

  function hideGlobalGraph() {
    cleanupGlobalGraphs()
    for (const container of containers) {
      container.classList.remove("active")
      const sidebar = container.closest(".sidebar") as HTMLElement
      if (sidebar) sidebar.style.zIndex = ""
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
})
