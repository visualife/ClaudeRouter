import type { Agent, Effort, Model } from '../types'

// The mascot a subagent wears: Explore scouts, Plan plans, research reads, the rest build
export function roleOf(subagentType: string, text: string): Agent['role'] {
  if (/explore/i.test(subagentType)) return 'scout'
  if (/plan/i.test(subagentType)) return 'planner'
  if (/\b(research|investigat\w*|verify|trace|review|audit)\b/i.test(text)) return 'researcher'
  return 'builder'
}

// Local heuristics only: no model is called to decide. Counts keyword hits per tier,
// prompt length, the subagent's type and the tools this turn has used.
export type RouteInput = {
  text: string
  tools: readonly string[]
  subagentType?: string
  current?: Model | null
  // Where flagship creative work goes (/clauderouter creative); opus when unset
  creative?: CreativeMode
}

// ponytail: fixed constant; move to $.state config if tuning is wanted
export const HYSTERESIS = 0.08

export type RoutePick = { model: Model; effort: Effort; conf: number }

const HEAVY = /\b(plan|architect\w*|design|debug\w*|trace|root cause|refactor\w*|migrat\w*|security|race|deadlock|trade-?offs?|investigat\w*|why|performance|optimi[sz]e\w*|across|system)\b/gi
const MID = /\b(write|implement\w*|fix\w*|test\w*|fixtures?|review\w*|add|update|build)\b/gi
const LIGHT = /\b(list|read|show|rename|print|count|find|grep|format|typo|log|open|which|where|summari[sz]e)\b/gi
const DEEP = /\b(plan|architect\w*)\b/i

// Creative work, in English and French. Judgement, taste and voice matter more than speed here, so it gets a strong
// model at a high effort, scaled to the case:
//  - flagship: the work a brand lives with (identity, naming, taglines, manifesto, art direction, campaign concepts,
//    key visuals, logo concepts, scripts). The strongest model at the highest effort.
//  - craft: everyday copy and visual briefs (product pages, newsletters, posts, image prompts, photo briefs). Opus, high.
//  - bulk: volume or adaptation (a catalogue of product sheets, translations, meta descriptions, alt text). Sonnet, high.
// Bare "copy", "design", "script", "naming" and "positionnement" are left out on purpose: "copy the file", "naming
// conventions", "a bash script" and CSS positioning are not creative work.
const W = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'iu')
const FLAGSHIP = W([
  'art direct(?:ion|or)s?', 'direct(?:ion|eur|rice) artistique', 'creative direct(?:ion|or)', 'direction cr[ée]ative',
  'creative briefs?', 'briefs? cr[ée]atifs?', 'mood ?boards?', 'planches? de tendances?',
  'brand (?:identity|platform|strategy|story|book|guidelines|naming|names?|positioning|manifesto|universe|concepts?|voice)',
  'identit[ée] (?:visuelle|de marque)', 'plateforme de marque', 'charte graphique', 'univers de marque', 'r[ée]cit de marque',
  'brand naming', 'naming (?:for|pour|of|de|du|ideas|options|session)', 'noms? de (?:marque|domaine|produit|gamme)', 'product names?',
  'manifest[oe]s?', 'taglines?', 'slogans?', 'signature de marque', 'positioning statement', 'positionnement (?:de (?:la )?marque|strat[ée]gique)',
  'value proposition', 'proposition de valeur', 'big idea', 'campaign (?:concepts?|ideas?|platform)', 'concepts? (?:de campagne|cr[ée]atifs?)',
  'creative concepts?', 'key visuals?', 'visuels? cl[ée]s?', 'hero (?:section|copy|headline|visual)s?',
  'logo (?:concepts?|design|direction|ideas?|exploration|redesign)', 'concepts? de logo', 'refonte (?:du|de mon|de notre) logo',
  '(?:design|create|draw|sketch|cr[ée]e|dessine|imagine) (?:a|an|the|my|our|un|une|le|mon|notre) (?:new |nouveau )?logo',
  'storyboards?', 'shot lists?', 'd[ée]coupage technique', '(?:video|ad|film|commercial|tv|radio|brand film) scripts?',
  'scripts? (?:vid[ée]o|pub|publicitaire)', 'voice-?overs?', 'color palettes?', 'palettes? de couleurs?',
  'font pairings?', 'type (?:pairing|system)s?', 'design critique', 'critique (?:this|my|the|de|du|ma|mon|cette|ce) (?:design|visual|visuel|logo|layout|maquette|affiche|poster|landing)',
].join('|'))
const CRAFT = W([
  'copywrit\\w*', '(?:ad|sales|marketing|web|website|landing|email|ux|product|brand) copy', 'copy (?:for|of) (?:the|a|an|our|my)',
  'rewrite the copy', 'headlines?', 'landing pages?', 'product (?:descriptions?|pages?)', 'newsletters?', 'subject lines?',
  'email sequences?', 'cold emails?', 'captions?', 'tone of voice', 'blog posts?', 'press releases?', 'call to action',
  'accroches?', 'fiches? produits?', 'r[ée]daction', 'r[ée]dige\\w*', 'page d.accueil', 'ton de voix', 'texte (?:de|pour) (?:la|le|les|une?|notre|ma|mon)',
  'storytelling', 'about page', 'page [àa] propos', '(?:instagram|linkedin|facebook|tiktok|social) (?:posts?|captions?|carousels?|reels?|bios?)',
  'ad creatives?', 'banni[èe]res?', 'affiches?', 'posters?', 'flyers?', 'brochures?', 'image prompts?', 'prompts? (?:image|midjourney|magnific|flux)',
  'midjourney', 'photo (?:direction|briefs?|shoots?)', 'direction photo', 'shootings?', 'product photography', 'photographie produit', 'lighting setups?',
].join('|'))
// Volume or adaptation. Turns craft into bulk; turns flagship into craft (a translated manifesto still needs care).
const BULK = W([
  'translat\\w*', 'tradu\\w*', 'locali[sz]\\w*', 'adapt\\w* (?:to|for|en|pour|au|aux)', 'bulk', 'batch', 'en masse', 'en lot',
  'csv', 'xlsx', 'spreadsheet', 'tableur', 'catalogu?e', '(?:\\d{2,}|all|every|each|tou(?:te)?s les|chaque) (?:\\S+ ){0,3}(?:products?|produits?|fiches?|skus?|descriptions?|pages?|articles?)',
].join('|'))
// Creative only in volume: production text no one writes one by one
const BULK_ONLY = W(['meta (?:descriptions?|titles?)', 'alt[- ]?texts?', 'textes? alternatifs?', 'balises? (?:title|meta|alt)', 'seo titles?'].join('|'))

export type Creative = 'flagship' | 'craft' | 'bulk'
// The model flagship creative work goes to. off: creative prompts are routed like any other.
export type CreativeMode = 'opus' | 'fable' | 'off'

export function creativeOf(text: string): Creative | null {
  const bulk = BULK.test(text)
  if (FLAGSHIP.test(text)) return bulk ? 'craft' : 'flagship'
  if (CRAFT.test(text)) return bulk ? 'bulk' : 'craft'
  return BULK_ONLY.test(text) ? 'bulk' : null
}
export const isCopy = (text: string): boolean => creativeOf(text) !== null

// Creative work is set to its case's tier whoever picked (the rules or Jev). An Explore subagent only reads: left alone.
export function creativeFloor(pick: RoutePick, input: RouteInput, mode: CreativeMode = input.creative ?? 'opus'): RoutePick {
  const kind = mode === 'off' || input.subagentType === 'Explore' ? null : creativeOf(input.text)
  if (!kind) return pick
  const conf = Math.max(pick.conf, 0.9)
  if (kind === 'flagship') return mode === 'fable' ? { model: 'fable', effort: 'high', conf } : { model: 'opus', effort: 'xhigh', conf }
  if (kind === 'craft') return { model: 'opus', effort: pick.model === 'opus' && pick.effort === 'xhigh' ? 'xhigh' : 'high', conf }
  return { model: 'sonnet', effort: 'high', conf }
}
// Kept from 0.4: the copy floor is the creative floor
export const copyFloor = creativeFloor

const EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const SEARCH = ['Glob', 'Grep', 'Read']
// The tiers the router scores by itself. Fable is never picked automatically: the user chooses it.
export type Auto = 'haiku' | 'sonnet' | 'opus'
const FAMILIES: Auto[] = ['haiku', 'sonnet', 'opus']
const KNOWN: Model[] = [...FAMILIES, 'fable']
export const isAuto = (m: Model | null | undefined): m is Auto => m === 'haiku' || m === 'sonnet' || m === 'opus'

// Full ids for a model that cannot be derived from the running id: versions differ per family
export const MODEL_IDS: Record<Model, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  // Newest Fable. A session already on another Fable (5.1, 5) keeps its own id: idFor only uses this when switching in.
  fable: 'claude-fable-5-2',
}

// The model family a full model id belongs to, or null when it names none
export function familyOf(id: string): Model | null {
  const lower = id.toLowerCase()
  return KNOWN.find(f => lower.includes(f)) ?? null
}

// The full model id for a family. The running id is kept when it already is that family. Between haiku, sonnet
// and opus the family word is swapped, so the version suffix is kept. Anything else (Fable, an unknown id) uses
// the known id: swapping a word in a Fable id would invent an id that does not exist.
export function idFor(family: Model, running: string): string {
  if (familyOf(running) === family) return running
  const swap = isAuto(family) && isAuto(familyOf(running))
  return swap ? running.replace(/haiku|sonnet|opus/, family) : MODEL_IDS[family]
}

const hits = (text: string, re: RegExp, cap: number) => Math.min(cap, (text.match(re) ?? []).length)

// Scores each tier and picks the highest; a tie, or no signal at all, stays on sonnet
export function pickRoute(input: RouteInput): RoutePick {
  const { text, tools } = input
  const heavy = hits(text, HEAVY, 3)
  const score = { haiku: hits(text, LIGHT, 2), sonnet: 0.5 + hits(text, MID, 2), opus: heavy }

  if (text.length > 400) score.opus += 1
  else if (text.length < 60 && heavy === 0) score.haiku += 1
  if (input.subagentType === 'Explore') score.haiku += 2
  if (input.subagentType === 'Plan') score.opus += 2
  if (heavy === 0 && tools.length > 0 && tools.every(t => SEARCH.includes(t))) score.haiku += 1
  if (tools.some(t => EDITS.includes(t))) score.sonnet += 1
  if (tools.includes('Bash') && tools.filter(t => EDITS.includes(t)).length >= 3) score.opus += 1

  const ranked = FAMILIES.map(m => [m, score[m]] as const).sort((a, b) => b[1] - a[1])
  const [top, second] = ranked
  let model: Auto = top && second && top[1] > second[1] ? top[0] : 'sonnet'
  // Hysteresis: stay on the current model unless the new one beats it by more than HYSTERESIS (softmax share).
  // Only for tiers the router scores: Fable has no score, so it never takes part.
  const total = FAMILIES.reduce((s, m) => s + Math.exp(score[m]), 0)
  const share = (m: Auto) => Math.exp(score[m]) / total
  const cur = isAuto(input.current) ? input.current : null
  if (cur && cur !== model && share(model) - share(cur) <= HYSTERESIS) model = cur
  const effort: Effort =
    model === 'haiku' ? 'low'
    : model === 'sonnet' ? (score.sonnet >= 2 ? 'medium' : 'low')
    : DEEP.test(text) || input.subagentType === 'Plan' ? 'xhigh'
    : heavy >= 2 ? 'high'
    : 'medium'
  // Confidence from the margin over the runner-up, kept to 0.50–0.99
  const margin = (top?.[1] ?? 0) - (second?.[1] ?? 0)
  const conf = Math.min(0.99, Math.max(0.5, 0.5 + 0.5 * (1 - Math.exp(-margin))))

  return creativeFloor({ model, effort, conf: Math.round(conf * 100) / 100 }, input)
}

// The effort for a tier chosen by something other than pickRoute (Jev): the same ladder, without the scores
export function effortFor(model: Model, text: string, subagentType?: string): Effort {
  if (model === 'haiku') return 'low'
  if (model === 'sonnet') return 'medium'
  return DEEP.test(text) || subagentType === 'Plan' ? 'xhigh' : 'high'
}

// The signals behind a pick, as the band's dim second line: “excerpt” · kw:debug · len 212 · tools Bash·Edit
export function whyOf(input: RouteInput): string {
  const kind = creativeOf(input.text)
  const kw = kind ? { flagship: 'creative', craft: 'copy', bulk: 'copy·bulk' }[kind] : (input.text.match(HEAVY) ?? input.text.match(MID) ?? input.text.match(LIGHT) ?? [])[0]?.toLowerCase()
  const excerpt = input.text.replace(/\s+/g, ' ').trim().slice(0, 40)
  const tools = [...new Set(input.tools)].slice(-3)
  return [
    excerpt ? `“${excerpt}${input.text.length > 40 ? '…' : ''}”` : '',
    input.subagentType ? `agent:${input.subagentType}` : '',
    kw ? `kw:${kw}` : '',
    `len ${input.text.length}`,
    tools.length > 0 ? `tools ${tools.join('·')}` : 'no tools',
  ]
    .filter(Boolean)
    .join(' · ')
}
