import type {
  ChatMetadata,
  GenerationType,
  Lorebook,
  TimedEffect,
  WorldInfoEntry,
} from '../types.ts'
import { escapeRegex, getStringHash } from '../util/hash.ts'
import { DEFAULT_DEPTH, DEFAULT_WEIGHT, WI_LOGIC, WI_POSITION } from './lorebook.ts'

export interface WorldInfoSettings {
  depth: number
  minActivations: number
  minActivationsDepthMax: number
  /** Percent of the prompt budget. */
  budget: number
  budgetCap: number
  includeNames: boolean
  recursive: boolean
  caseSensitive: boolean
  matchWholeWords: boolean
  /** 0 evenly, 1 character first, 2 global first. */
  characterStrategy: number
  useGroupScoring: boolean
  maxRecursionSteps: number
}

export const WORLD_INFO_DEFAULTS: WorldInfoSettings = {
  depth: 2,
  minActivations: 0,
  minActivationsDepthMax: 0,
  budget: 25,
  budgetCap: 0,
  includeNames: true,
  recursive: true,
  caseSensitive: false,
  matchWholeWords: true,
  characterStrategy: 1,
  useGroupScoring: false,
  maxRecursionSteps: 0,
}

export interface ScanEntry extends WorldInfoEntry {
  world: string
  decorators: string[]
  hash: number
}

export interface NamedLorebook {
  name: string
  book: Lorebook
}

export interface LorebookSources {
  global: NamedLorebook[]
  character: NamedLorebook[]
  chat: NamedLorebook | null
  persona: NamedLorebook | null
}

export interface GlobalScanData {
  personaDescription: string
  characterDescription: string
  characterPersonality: string
  characterDepthPrompt: string
  scenario: string
  creatorNotes: string
}

export interface ScanInput {
  /** Chat text to scan, newest first (`Name: message` when names are included). */
  messages: string[]
  entries: ScanEntry[]
  settings: WorldInfoSettings
  /** Prompt token budget (context minus response). */
  maxContext: number
  globalScanData: GlobalScanData
  /** Extension prompts marked as scannable (e.g. Author's Note). */
  injected: string[]
  /** Chat metadata holding sticky/cooldown state; mutated unless `dryRun`. */
  metadata: ChatMetadata
  trigger: GenerationType
  character: { filename: string; tags: string[] } | null
  dryRun: boolean
  substitute: (text: string) => string
  countTokens: (text: string) => number
  random: () => number
  /** Applies WORLD_INFO regex scripts; depth is set for at-depth entries. */
  applyRegex: (content: string, depth: number | null) => string
}

export interface DepthEntries {
  depth: number
  role: number
  entries: string[]
}

export interface ScanResult {
  before: string
  after: string
  examples: Array<{ position: 'before' | 'after'; content: string }>
  depth: DepthEntries[]
  anTop: string[]
  anBottom: string[]
  outlets: Record<string, string[]>
  activated: ScanEntry[]
}

const MAX_SCAN_DEPTH = 1000
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate']
const byOrder = (a: WorldInfoEntry, b: WorldInfoEntry) => b.order - a.order

const ScanState = { None: 0, Initial: 1, Recursion: 2, MinActivations: 3 } as const
type ScanState = (typeof ScanState)[keyof typeof ScanState]

/** Regex key: `/pattern/flags` with escaped inner slashes. */
export function parseKeyRegex(input: string): RegExp | null {
  const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/)
  if (!match) return null
  const [, rawPattern, flags] = match
  if (rawPattern!.match(/(^|[^\\])\//)) return null
  const pattern = rawPattern!.replace('\\/', '/')
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

const isKnownDecorator = (line: string) =>
  KNOWN_DECORATORS.some((d) => (line.startsWith('@@@') ? line.substring(1) : line).startsWith(d))

function parseDecorators(content: string): [string[], string] {
  if (!content.startsWith('@@')) return [[], content]
  const lines = content.split('\n')
  const decorators: string[] = []
  let fallback = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('@@')) return [decorators, lines.slice(i).join('\n')]
    if (line.startsWith('@@@') && !fallback) continue
    if (isKnownDecorator(line)) {
      decorators.push(line.startsWith('@@@') ? line.substring(1) : line)
      fallback = false
    } else {
      fallback = true
    }
  }
  return [decorators, content]
}

const toEntries = ({ name, book }: NamedLorebook) =>
  Object.values(book.entries).map((entry) => ({ ...entry, world: name }))

/** Chat lore, persona lore, then global/character lore by strategy. */
export function sortEntries(sources: LorebookSources, strategy: number): ScanEntry[] {
  const globalNames = new Set(sources.global.map((b) => b.name))
  const chat = sources.chat && !globalNames.has(sources.chat.name) ? toEntries(sources.chat) : []
  const persona =
    sources.persona &&
    sources.persona.name !== sources.chat?.name &&
    !globalNames.has(sources.persona.name)
      ? toEntries(sources.persona)
      : []
  const character = sources.character
    .filter(
      (b) =>
        !globalNames.has(b.name) &&
        b.name !== sources.chat?.name &&
        b.name !== sources.persona?.name,
    )
    .flatMap(toEntries)
  const global = sources.global.flatMap(toEntries)

  let rest
  if (strategy === 1) rest = [...character.toSorted(byOrder), ...global.toSorted(byOrder)]
  else if (strategy === 2) rest = [...global.toSorted(byOrder), ...character.toSorted(byOrder)]
  else rest = [...global, ...character].toSorted(byOrder)

  return [...chat.toSorted(byOrder), ...persona.toSorted(byOrder), ...rest]
    .map((entry) => {
      const [decorators, content] = parseDecorators(entry.content || '')
      return { ...entry, decorators, content }
    })
    .map((entry) => ({ ...structuredClone(entry), hash: getStringHash(JSON.stringify(entry)) }))
}

class ScanBuffer {
  private readonly depthBuffer: string[] = []
  private readonly recurseBuffer: string[] = []
  private skew = 0
  private readonly input: ScanInput

  constructor(input: ScanInput) {
    this.input = input
    for (let depth = 0; depth < Math.min(MAX_SCAN_DEPTH, input.messages.length); depth++) {
      this.depthBuffer[depth] = input.messages[depth]!.trim()
    }
  }

  get depth() {
    return this.input.settings.depth + this.skew
  }

  advance() {
    this.skew++
  }

  addRecurse(text: string) {
    this.recurseBuffer.push(text)
  }

  get hasRecurse() {
    return this.recurseBuffer.length > 0
  }

  text(entry: ScanEntry, state: ScanState): string {
    let depth = entry.scanDepth ?? this.depth
    if (depth <= 0) return ''
    depth = Math.min(depth, MAX_SCAN_DEPTH)

    const joiner = '\n\x01'
    let result = '\x01' + this.depthBuffer.slice(0, depth).join(joiner)
    const global = this.input.globalScanData
    const extras: Array<[boolean, string]> = [
      [entry.matchPersonaDescription, global.personaDescription],
      [entry.matchCharacterDescription, global.characterDescription],
      [entry.matchCharacterPersonality, global.characterPersonality],
      [entry.matchCharacterDepthPrompt, global.characterDepthPrompt],
      [entry.matchScenario, global.scenario],
      [entry.matchCreatorNotes, global.creatorNotes],
    ]
    for (const [enabled, text] of extras) if (enabled && text) result += joiner + text
    if (this.input.injected.length) result += joiner + this.input.injected.join(joiner)
    if (this.recurseBuffer.length && state !== ScanState.MinActivations)
      result += joiner + this.recurseBuffer.join(joiner)
    return result
  }

  matches(haystack: string, needle: string, entry: ScanEntry): boolean {
    const regex = parseKeyRegex(needle)
    if (regex) return regex.test(haystack)

    const caseSensitive = entry.caseSensitive ?? this.input.settings.caseSensitive
    const text = caseSensitive ? haystack : haystack.toLowerCase()
    const key = caseSensitive ? needle : needle.toLowerCase()
    const wholeWords = entry.matchWholeWords ?? this.input.settings.matchWholeWords

    if (!wholeWords || key.split(/\s+/).length > 1) return text.includes(key)
    return new RegExp(`(?:^|\\W)(${escapeRegex(key)})(?:$|\\W)`).test(text)
  }

  score(entry: ScanEntry, state: ScanState): number {
    const text = this.text(entry, state)
    const primary = entry.key.filter((key) => this.matches(text, key, entry)).length
    const secondary = entry.keysecondary.filter((key) => this.matches(text, key, entry)).length
    if (!entry.key.length) return 0
    if (entry.keysecondary.length) {
      if (entry.selectiveLogic === WI_LOGIC.AND_ANY) return primary + secondary
      if (entry.selectiveLogic === WI_LOGIC.AND_ALL)
        return secondary === entry.keysecondary.length ? primary + secondary : primary
    }
    return primary
  }
}

type TimedType = 'sticky' | 'cooldown' | 'delay'

class TimedEffects {
  private readonly active: Record<TimedType, ScanEntry[]> = { sticky: [], cooldown: [], delay: [] }
  private readonly state: {
    sticky: Record<string, TimedEffect>
    cooldown: Record<string, TimedEffect>
  }

  private readonly chatLength: number
  private readonly entries: ScanEntry[]
  private readonly dryRun: boolean

  constructor(chatLength: number, entries: ScanEntry[], metadata: ChatMetadata, dryRun: boolean) {
    this.chatLength = chatLength
    this.entries = entries
    this.dryRun = dryRun
    const timed = (metadata.timedWorldInfo ??= { sticky: {}, cooldown: {} })
    for (const type of ['sticky', 'cooldown'] as const) {
      if (!timed[type] || typeof timed[type] !== 'object') timed[type] = {}
      for (const [key, value] of Object.entries(timed[type]))
        if (!value || typeof value !== 'object') delete timed[type][key]
    }
    this.state = timed
  }

  private key = (entry: ScanEntry) => `${entry.world}.${entry.uid}`

  private effect(type: 'sticky' | 'cooldown', entry: ScanEntry, isProtected: boolean): TimedEffect {
    return {
      hash: entry.hash,
      start: this.chatLength,
      end: this.chatLength + Number(entry[type]),
      protected: isProtected,
    }
  }

  check() {
    if (!this.dryRun) {
      this.checkType('sticky', (entry) => {
        if (!entry.cooldown) return
        this.state.cooldown[this.key(entry)] = this.effect('cooldown', entry, true)
        this.active.cooldown.push(entry)
      })
      this.checkType('cooldown')
    }
    for (const entry of this.entries)
      if (entry.delay && this.chatLength < entry.delay) this.active.delay.push(entry)
  }

  private checkType(type: 'sticky' | 'cooldown', onEnded?: (entry: ScanEntry) => void) {
    for (const [key, value] of Object.entries(this.state[type])) {
      const entry = this.entries.find((e) => String(e.hash) === String(value.hash))
      if (this.chatLength <= Number(value.start) && !value.protected) {
        delete this.state[type][key]
        continue
      }
      if (!entry) {
        if (this.chatLength >= Number(value.end)) delete this.state[type][key]
        continue
      }
      if (!entry[type]) {
        delete this.state[type][key]
        continue
      }
      if (this.chatLength >= Number(value.end)) {
        delete this.state[type][key]
        onEnded?.(entry)
        continue
      }
      this.active[type].push(entry)
    }
  }

  isActive(type: TimedType, entry: ScanEntry) {
    return this.active[type].some((e) => e.hash === entry.hash)
  }

  record(activated: ScanEntry[]) {
    if (this.dryRun) return
    for (const entry of activated) {
      for (const type of ['sticky', 'cooldown'] as const) {
        if (entry[type] && !this.state[type][this.key(entry)])
          this.state[type][this.key(entry)] = this.effect(type, entry, false)
      }
    }
  }
}

function filterByInclusionGroups(
  newEntries: ScanEntry[],
  activated: Map<string, ScanEntry>,
  buffer: ScanBuffer,
  state: ScanState,
  timed: TimedEffects,
  input: ScanInput,
) {
  const groups: Record<string, ScanEntry[]> = {}
  for (const entry of newEntries.filter((e) => e.group)) {
    for (const group of entry.group.split(/,\s*/).filter(Boolean))
      (groups[group] ??= []).push(entry)
  }
  if (!Object.keys(groups).length) return

  const remove = (entry: ScanEntry) => {
    const index = newEntries.indexOf(entry)
    if (index >= 0) newEntries.splice(index, 1)
  }
  const removeAllBut = (group: ScanEntry[], keep: ScanEntry | null) =>
    group.filter((e) => e !== keep).forEach(remove)

  const hasSticky = new Map<string, boolean>()
  for (const [key, group] of Object.entries(groups)) {
    const sticky = group.filter((e) => timed.isActive('sticky', e))
    hasSticky.set(key, sticky.length > 0)
    if (sticky.length) group.filter((e) => !sticky.includes(e)).forEach(remove)
    group.filter((e) => timed.isActive('cooldown', e) || timed.isActive('delay', e)).forEach(remove)
  }

  for (const [key, group] of Object.entries(groups)) {
    if (!input.settings.useGroupScoring && !group.some((e) => e.useGroupScoring)) continue
    if (hasSticky.get(key)) continue
    const scores = group.map((e) => buffer.score(e, state))
    const max = Math.max(...scores)
    for (let i = 0; i < group.length; i++) {
      if ((group[i]!.useGroupScoring ?? input.settings.useGroupScoring) && scores[i]! < max) {
        remove(group[i]!)
        group.splice(i, 1)
        scores.splice(i, 1)
        i--
      }
    }
  }

  for (const [key, group] of Object.entries(groups)) {
    if (hasSticky.get(key)) continue
    if ([...activated.values()].some((e) => e.group === key)) {
      removeAllBut(group, null)
      continue
    }
    if (group.length <= 1) continue
    const prioritized = group.filter((e) => e.groupOverride).toSorted(byOrder)
    if (prioritized.length) {
      removeAllBut(group, prioritized[0]!)
      continue
    }
    const total = group.reduce((sum, e) => sum + (e.groupWeight ?? DEFAULT_WEIGHT), 0)
    const roll = input.random() * total
    let weight = 0
    const winner = group.find((e) => (weight += e.groupWeight ?? DEFAULT_WEIGHT) >= roll)
    if (winner) removeAllBut(group, winner)
  }
}

function keyMatches(
  entry: ScanEntry,
  buffer: ScanBuffer,
  state: ScanState,
  substitute: (text: string) => string,
): boolean {
  const text = buffer.text(entry, state)
  const primary = entry.key.find((key) => {
    const value = substitute(key)
    return value && buffer.matches(text, value.trim(), entry)
  })
  if (!primary) return false
  if (!entry.selective || !Array.isArray(entry.keysecondary) || !entry.keysecondary.length)
    return true

  const logic = entry.selectiveLogic ?? WI_LOGIC.AND_ANY
  let any = false
  let all = true
  for (const key of entry.keysecondary) {
    const value = substitute(key)
    const hit = Boolean(value) && buffer.matches(text, value.trim(), entry)
    if (hit) any = true
    else all = false
    if (logic === WI_LOGIC.AND_ANY && hit) return true
    if (logic === WI_LOGIC.NOT_ALL && !hit) return true
  }
  if (logic === WI_LOGIC.NOT_ANY && !any) return true
  if (logic === WI_LOGIC.AND_ALL && all) return true
  return false
}

/** Activates lorebook entries and arranges them by position. */
export function scanWorldInfo(input: ScanInput): ScanResult {
  const { settings, entries } = input
  const empty: ScanResult = {
    before: '',
    after: '',
    examples: [],
    depth: [],
    anTop: [],
    anBottom: [],
    outlets: {},
    activated: [],
  }
  const buffer = new ScanBuffer(input)
  const timed = new TimedEffects(input.messages.length, entries, input.metadata, input.dryRun)
  timed.check()
  if (!entries.length) return empty

  let budget = Math.round((settings.budget * input.maxContext) / 100) || 1
  if (settings.budgetCap > 0 && budget > settings.budgetCap) budget = settings.budgetCap

  const delayLevels = [
    ...new Set(
      entries
        .filter((e) => e.delayUntilRecursion)
        .map((e) => (e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion))),
    ),
  ].toSorted((a, b) => a - b)
  let delayLevel = delayLevels.shift() ?? 0

  const activated = new Map<string, ScanEntry>()
  const failedProbability = new Set<ScanEntry>()
  let activatedText = ''
  let overflowed = false
  let state: ScanState = ScanState.Initial
  let loops = 0

  while (state) {
    if (settings.maxRecursionSteps && settings.maxRecursionSteps <= loops) break
    loops++
    let nextState: ScanState = ScanState.None
    const candidates = new Set<ScanEntry>()

    for (const entry of entries) {
      if (failedProbability.has(entry) || activated.has(`${entry.world}.${entry.uid}`)) continue
      if (entry.disable) continue
      if (
        Array.isArray(entry.triggers) &&
        entry.triggers.length &&
        !entry.triggers.includes(input.trigger)
      )
        continue

      const filter = entry.characterFilter
      if (filter?.names?.length) {
        const included = Boolean(input.character && filter.names.includes(input.character.filename))
        if (filter.isExclude ? included : !included) continue
      }
      if (filter?.tags?.length && input.character) {
        const included = input.character.tags.some((tag) => filter.tags.includes(tag))
        if (filter.isExclude ? included : !included) continue
      }

      const sticky = timed.isActive('sticky', entry)
      if (timed.isActive('delay', entry)) continue
      if (timed.isActive('cooldown', entry) && !sticky) continue
      if (state !== ScanState.Recursion && entry.delayUntilRecursion && !sticky) continue
      if (
        state === ScanState.Recursion &&
        entry.delayUntilRecursion &&
        Number(entry.delayUntilRecursion) > delayLevel &&
        !sticky
      )
        continue
      if (state === ScanState.Recursion && settings.recursive && entry.excludeRecursion && !sticky)
        continue

      if (entry.decorators.includes('@@activate')) {
        candidates.add(entry)
        continue
      }
      if (entry.decorators.includes('@@dont_activate')) continue
      if (entry.constant || sticky) {
        candidates.add(entry)
        continue
      }
      if (!Array.isArray(entry.key) || !entry.key.length) continue
      if (keyMatches(entry, buffer, state, input.substitute)) candidates.add(entry)
    }

    const order = new Map(entries.map((entry, index) => [entry, index]))
    const newEntries = [...candidates].toSorted(
      (a, b) =>
        Number(timed.isActive('sticky', b)) - Number(timed.isActive('sticky', a)) ||
        order.get(a)! - order.get(b)!,
    )

    const scannedTokens = input.countTokens(activatedText)
    filterByInclusionGroups(newEntries, activated, buffer, state, timed, input)

    let newContent = ''
    let ignoresBudget = newEntries.filter((e) => e.ignoreBudget).length
    for (const entry of newEntries) {
      if (entry.ignoreBudget) ignoresBudget--
      if (overflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue
        break
      }

      const passes =
        !entry.useProbability ||
        entry.probability === 100 ||
        timed.isActive('sticky', entry) ||
        input.random() * 100 <= entry.probability
      if (!passes) {
        failedProbability.add(entry)
        continue
      }

      entry.content = input.substitute(entry.content)
      newContent += `${entry.content}\n`

      if (!entry.ignoreBudget && scannedTokens + input.countTokens(newContent) >= budget) {
        overflowed = true
        continue
      }

      activated.set(`${entry.world}.${entry.uid}`, entry)
    }

    const successful = newEntries.filter((e) => !failedProbability.has(e))
    const forRecursion = successful.filter((e) => !e.preventRecursion)

    if (settings.recursive && !overflowed && forRecursion.length) nextState = ScanState.Recursion
    if (
      settings.recursive &&
      !overflowed &&
      state === ScanState.MinActivations &&
      buffer.hasRecurse
    )
      nextState = ScanState.Recursion

    if (
      !nextState &&
      !overflowed &&
      settings.minActivations > 0 &&
      activated.size < settings.minActivations
    ) {
      const overMax =
        (settings.minActivationsDepthMax > 0 && buffer.depth > settings.minActivationsDepthMax) ||
        buffer.depth > input.messages.length
      if (!overMax) {
        nextState = ScanState.MinActivations
        buffer.advance()
      }
    }

    if (nextState === ScanState.None && delayLevels.length) {
      nextState = ScanState.Recursion
      delayLevel = delayLevels.shift()!
    }

    state = nextState
    if (state) {
      const text = forRecursion.map((e) => e.content).join('\n')
      if (text) {
        buffer.addRecurse(text)
        activatedText = `${text}\n${activatedText}`
      }
    }
  }

  const result: ScanResult = { ...empty, outlets: {}, activated: [...activated.values()] }
  const before: string[] = []
  const after: string[] = []

  for (const entry of [...activated.values()].toSorted(byOrder)) {
    const depth = entry.position === WI_POSITION.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null
    const content = input.applyRegex(entry.content, depth)
    if (!content) continue
    switch (entry.position) {
      case WI_POSITION.before:
        before.unshift(content)
        break
      case WI_POSITION.after:
        after.unshift(content)
        break
      case WI_POSITION.EMTop:
        result.examples.unshift({ position: 'before', content })
        break
      case WI_POSITION.EMBottom:
        result.examples.unshift({ position: 'after', content })
        break
      case WI_POSITION.ANTop:
        result.anTop.unshift(content)
        break
      case WI_POSITION.ANBottom:
        result.anBottom.unshift(content)
        break
      case WI_POSITION.atDepth: {
        const role = entry.role ?? 0
        const existing = result.depth.find(
          (d) => d.depth === (entry.depth ?? DEFAULT_DEPTH) && d.role === role,
        )
        if (existing) existing.entries.unshift(content)
        else result.depth.push({ depth: entry.depth, entries: [content], role })
        break
      }
      case WI_POSITION.outlet:
        if (entry.outletName) (result.outlets[entry.outletName] ??= []).push(content)
        break
    }
  }

  result.before = before.join('\n')
  result.after = after.join('\n')
  timed.record(result.activated)
  return result
}
