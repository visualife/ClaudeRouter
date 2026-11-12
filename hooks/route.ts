import type { Agent, Effort, Model } from '../types'

// The mascot a subagent wears: Explore scouts, Plan plans, research reads, the rest build
export function roleOf(subagentType: string, text: string): Agent['role'] {
  if (/explore/i.test(subagentType)) return 'scout'
  if (/plan|architect/i.test(subagentType)) return 'planner'
  if (/\b(research|investigat\w*|verify|trace|review|audit)\b/i.test(text)) return 'researcher'
  return 'builder'
}

// Built-in Plan, or a custom planner / architect agent (also as a plugin's "plugin:planner"): the only subagents that may use Opus
export const isPlanner = (subagentType?: string) => !!subagentType && /(?:^|:)(?:plan|planner|architect)$/i.test(subagentType)

// Local heuristics only: no model is called to decide. Counts keyword hits per tier,
// prompt length, the subagent's type and the tools this turn has used.
export type RouteInput = {
  text: string
  tools: readonly string[]
  subagentType?: string
  current?: Model | null
  // Where flagship creative work goes (/clauderouter creative); opus when unset
  creative?: CreativeMode
  // The route the previous main-thread turn ended on. A short prompt with no signal of its own ("yes go ahead",
  // "oui vas-y", "continue") carries on with it instead of being scored as a light request.
  prev?: { model: Model; effort: Effort } | null
}

// ponytail: fixed constant; move to $.state config if tuning is wanted
export const HYSTERESIS = 0.08

export type RoutePick = { model: Model; effort: Effort; conf: number }

// Strong signals of hard work: each one counts
const HEAVY = /\b(plan|architect\w*|debug\w*|trace|root cause|refactor\w*|migrat\w*|security|deadlock|trade-?offs?|investigat\w*)\b/gi
// Everyday words that only hint at it ("the design system", "file system", "why not"). Alone they count for half,
// so "update the design system tokens" stays on Sonnet; beside a strong signal ("debug why ...") they count in full.
const HEAVY_WEAK = /\b(design|race|why|performance|optimi[sz]e\w*|across|system)\b/gi
const MID = /\b(write|implement\w*|fix\w*|test\w*|fixtures?|review\w*|add|update|build)\b/gi
const LIGHT = /\b(list|read|show|rename|print|count|find|grep|format|typo|log|open|which|where|summari[sz]e)\b/gi
const DEEP = /\b(plan|planifi\w*|architect\w*)\b/i
// The same tiers in French. \b stops at an accented letter, so these use the letter-aware boundaries of W below.
// Words the English lists already catch (architecture, migration, refactorise, optimise, teste) are not repeated.
const G = (body: string) => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'giu')
const HEAVY_FR = G(['planifi\\p{L}*', 'd[ée]bogu?\\p{L}*', 'débug\\p{L}*', 'cause racine', 'refonte', 'migr(?:e|es|er|ez|ons)', 's[ée]curit[ée]', 'diagnostiqu\\p{L}*'].join('|'))
const HEAVY_WEAK_FR = G(['pourquoi', 'conception', 'concevoir', 'syst[èe]mes?', 'performances', 'optimisation\\p{L}*'].join('|'))
const MID_FR = G([
  '[ée]cri(?:s|re|vez|t)', 'implément\\p{L}*', 'corrig\\p{L}*', 'r[ée]par(?:e|er|es|ez|ons)', 'ajout\\p{L}*', 'met(?:s|tre|tez)? [àa] jour', 'mise [àa] jour',
  'construi\\p{L}*', 'cr[ée](?:e|er|es|ez|ons)', 'modifi\\p{L}*', 'int[èe]gr(?:e|er|es|ez|ons|ation)', 'd[ée]velopp\\p{L}*',
].join('|'))
// Kept to forms English does not share: "ou" (or), "resume", "listen" and "Montreal" must not count as lookups
const LIGHT_FR = G(['liste[srz]?', 'lis', 'lire', 'montre[srz]?', 'renomm\\p{L}*', 'trouve\\p{L}*', 'cherche\\p{L}*', 'formate\\p{L}*', 'ouvre\\p{L}*', 'où', 'résum\\p{L}*', 'resum(?:er|ez)'].join('|'))
// Subagent types that only run something and report: test-runner, linter, formatter. Whole name parts only, so
// "information-gatherer" is not a formatter.
const RUNNER = /(?:^|[-_:\s])(?:runner|lint(?:er)?|format(?:ter)?)(?:$|[-_:\s])/i
// A prompt shorter than this with no keyword is a nudge ("yes", "continue"), not a task
export const SHORT = 60

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
  'ad creatives?', 'banni[èe]res?',
  // "affiche" is also the verb (display): "affiche les fichiers", "affiche-moi les logs" are not poster briefs
  'affiches?(?!-| (?:le|la|les|l[’\']|moi|nous|tout|tous|toutes|ce|ces|cette|un|une|des|du)(?![\\p{L}]))', 'posters?', 'flyers?', 'brochures?', 'image prompts?', 'prompts? (?:image|midjourney|magnific|flux)',
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

const count = (text: string, ...res: RegExp[]) => res.reduce((n, re) => n + (text.match(re) ?? []).length, 0)

// The keyword signals of a prompt, English and French together, each capped
function signalsOf(text: string) {
  const strong = count(text, HEAVY, HEAVY_FR)
  const weak = count(text, HEAVY_WEAK, HEAVY_WEAK_FR)
  return {
    heavy: Math.min(3, strong + (strong > 0 ? weak : weak / 2)),
    mid: Math.min(2, count(text, MID, MID_FR)),
    light: Math.min(2, count(text, LIGHT, LIGHT_FR)),
  }
}

// True when a main-thread prompt says nothing about the work ("yes go ahead", "oui vas-y", "continue") and a
// previous turn exists to carry on from. It used to score as a short light request: Haiku at low effort, for the
// turn that runs the plan just approved. Fable is never carried: the router does not pick it by itself.
export function carriesOn(input: RouteInput): boolean {
  if (!input.prev || !isAuto(input.prev.model) || input.subagentType || input.text.length >= SHORT) return false
  const s = signalsOf(input.text)
  return s.heavy + s.mid + s.light === 0 && creativeOf(input.text) === null
}

// Scores each tier and picks the highest; a tie, or no signal at all, stays on sonnet
export function pickRoute(input: RouteInput): RoutePick {
  const { text, tools } = input
  if (carriesOn(input) && input.prev) return { model: input.prev.model, effort: input.prev.effort, conf: 0.6 }
  const { heavy, mid, light } = signalsOf(text)
  const score = { haiku: light, sonnet: 0.5 + mid, opus: heavy }

  if (text.length > 400) score.opus += 1
  else if (text.length < SHORT && heavy === 0) score.haiku += 1
  if (input.subagentType === 'Explore') score.haiku += 2
  // A runner outweighs the "test" and "build" in its own brief, which would otherwise read as Sonnet work
  if (input.subagentType && RUNNER.test(input.subagentType)) score.haiku += 3
  if (isPlanner(input.subagentType)) score.opus += 2
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
    // Sonnet runs at its stock level, medium. Low only when the prompt reads as a lookup and nothing else: an
    // unrecognised prompt (a French one, before 0.4.4) used to run at low.
    : model === 'sonnet' ? (light > 0 && mid === 0 && heavy === 0 ? 'low' : 'medium')
    : DEEP.test(text) || isPlanner(input.subagentType) ? 'xhigh'
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
  return DEEP.test(text) || isPlanner(subagentType) ? 'xhigh' : 'high'
}

// The signals behind a pick, as the band's dim second line: “excerpt” · kw:debug · len 212 · tools Bash·Edit
export function whyOf(input: RouteInput): string {
  const kind = creativeOf(input.text)
  const kw = kind ? { flagship: 'creative', craft: 'copy', bulk: 'copy·bulk' }[kind] : (input.text.match(HEAVY) ?? input.text.match(HEAVY_WEAK) ?? input.text.match(MID) ?? input.text.match(LIGHT) ?? [])[0]?.toLowerCase()
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
