import { SimpleSlug, FullSlug, joinSegments, simplifySlug } from "../../util/path"
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

/**
 * Parses a wikilink like "[[People/Foo-Bar]]" or "[[People/Foo-Bar|Foo Bar]]"
 * into the slug part (SimpleSlug): "People/Foo-Bar"
 */
function extractSlug(wikilink: unknown): SimpleSlug | null {
  if (typeof wikilink !== "string") return null
  const match = wikilink.match(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/)
  if (!match) return null
  return simplifySlug(match[1].trim() as FullSlug)
}

export const FamilyIndex: QuartzEmitterPlugin = () => ({
  name: "FamilyIndex",
  async *emit(ctx, content) {
    const index: FamilyIndexMap = {}

    for (const [_tree, file] of content) {
      const fm = file.data.frontmatter
      if (!fm?.cr_id) continue

      const slug = file.data.slug!
      const simpleSlug = simplifySlug(slug)

      const name = (fm.name as string) ?? simpleSlug
      const aliases = Array.isArray(fm.aliases) ? (fm.aliases as string[]) : []
      const sex = fm.sex as string | undefined
      const born = fm.born != null ? String(fm.born) : undefined

      const fatherRaw = fm.father as string | undefined
      const motherRaw = fm.mother as string | undefined
      const father = fatherRaw ? extractSlug(fatherRaw) : null
      const mother = motherRaw ? extractSlug(motherRaw) : null

      const spouses: SimpleSlug[] = []
      for (let i = 1; i <= 5; i++) {
        const spouseRaw = fm[`spouse${i}`] as string | undefined
        if (spouseRaw) {
          const s = extractSlug(spouseRaw)
          if (s) spouses.push(s)
        }
      }

      const childrenRaw = fm.children as string[] | undefined
      const children: SimpleSlug[] = []
      if (Array.isArray(childrenRaw)) {
        for (const c of childrenRaw) {
          const s = extractSlug(c)
          if (s) children.push(s)
        }
      }

      index[simpleSlug] = {
        name,
        aliases,
        ...(sex !== undefined && { sex }),
        ...(born !== undefined && { born }),
        father,
        mother,
        spouses,
        children,
      }
    }

    const fp = joinSegments("static", "familyIndex") as FullSlug
    yield write({
      ctx,
      content: JSON.stringify(index),
      slug: fp,
      ext: ".json",
    })
  },
})
