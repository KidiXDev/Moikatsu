import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { EngineSettings } from '../engine/settings.ts'
import type { Persona, RegexScript } from '../engine/types.ts'
import type { AppSettings, Library } from './library.ts'
import { readJson, resolveInside, safeName, type DataPaths } from './storage.ts'

/** Source folder name → our folder, file extension. */
const FOLDERS: Array<[string, keyof DataPaths, string]> = [
  ['characters', 'characters', '.png'],
  ['group chats', 'groupChats', '.jsonl'],
  ['groups', 'groups', '.json'],
  ['worlds', 'lorebooks', '.json'],
  ['OpenAI Settings', 'presets', '.json'],
  ['QuickReplies', 'quickReplies', '.json'],
]

const stripExt = (file: string) => file.replace(/\.[^.]+$/, '')

type Json = Record<string, unknown>
const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}

export interface ImportReport {
  copied: Record<string, number>
  skipped: number
}

async function copyNew(from: string, to: string, report: ImportReport, label: string) {
  if (existsSync(to)) {
    report.skipped++
    return
  }
  await mkdir(path.dirname(to), { recursive: true })
  await copyFile(from, to)
  report.copied[label] = (report.copied[label] ?? 0) + 1
}

async function files(dir: string, ext: string) {
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(ext))
}

/**
 * Copies characters, chats, groups, lorebooks, presets, persona avatars, and Quick Reply sets
 * from another install's user data folder, and converts its settings. Existing files are kept.
 */
export async function importDataFolder(source: string, library: Library): Promise<ImportReport> {
  const { paths } = library
  if (
    !existsSync(path.join(source, 'characters')) &&
    !existsSync(path.join(source, 'settings.json'))
  )
    throw new Error(`${source} doesn't look like a data folder (no characters/ or settings.json)`)
  const report: ImportReport = { copied: {}, skipped: 0 }

  for (const [from, to, ext] of FOLDERS)
    for (const file of await files(path.join(source, from), ext))
      await copyNew(
        path.join(source, from, file),
        resolveInside(paths[to] as string, `${safeName(stripExt(file))}${ext}`),
        report,
        to,
      )

  const chatsDir = path.join(source, 'chats')
  for (const character of existsSync(chatsDir) ? await readdir(chatsDir) : [])
    for (const file of await files(path.join(chatsDir, character), '.jsonl'))
      await copyNew(
        path.join(chatsDir, character, file),
        resolveInside(
          paths.chats,
          path.join(safeName(character), `${safeName(stripExt(file))}.jsonl`),
        ),
        report,
        'chats',
      )

  for (const file of await files(path.join(source, 'User Avatars'), '.png'))
    await copyNew(
      path.join(source, 'User Avatars', file),
      resolveInside(paths.personas, `${safeName(stripExt(file))}.png`),
      report,
      'personas',
    )

  const imported = convertSettings(await readJson<Json>(path.join(source, 'settings.json'), {}))
  await library.settings.update((current) => {
    const personas = { ...imported.personas, ...current.personas }
    const engine = { ...imported.engine, ...current.engine }
    Object.assign(current, { ...imported, ...current, personas, engine })
  })
  return report
}

function convertSettings(st: Json): AppSettings {
  const power = obj(st.power_user)
  const ext = obj(st.extension_settings)
  const wi = obj(st.world_info_settings)
  const lore = obj(wi.world_info)
  const note = obj(ext.note)
  const reasoning = obj(power.reasoning)

  const personas: Record<string, Persona> = {}
  for (const [avatar, name] of Object.entries(obj(power.personas))) {
    const d = obj(obj(power.persona_descriptions)[avatar])
    personas[safeName(stripExt(avatar))] = {
      name: String(name),
      description: String(d.description ?? ''),
      position: Number(d.position ?? 0),
      depth: Number(d.depth ?? 2),
      role: Number(d.role ?? 0),
      lorebook: String(d.lorebook ?? ''),
      title: String(d.title ?? ''),
      connections: (Array.isArray(d.connections) ? d.connections : []).map((c: Json) => ({
        type: c.type === 'group' ? 'group' : 'character',
        id: c.type === 'group' ? String(c.id) : stripExt(String(c.id)),
      })),
    }
  }

  const characterLorebooks = Object.fromEntries(
    (Array.isArray(lore.charLore) ? lore.charLore : []).map((c: Json) => [
      stripExt(String(c.name)),
      Array.isArray(c.extraBooks) ? c.extraBooks.map(String) : [],
    ]),
  )
  const characterNotes = Object.fromEntries(
    (Array.isArray(note.chara) ? note.chara : []).map((c: Json) => [
      stripExt(String(c.name)),
      {
        prompt: String(c.prompt ?? ''),
        useChara: Boolean(c.useChara),
        position: Number(c.position ?? 0),
      },
    ]),
  )
  let stopStrings: string[] = []
  try {
    stopStrings = JSON.parse(String(power.custom_stopping_strings || '[]'))
  } catch {
    // Not a JSON list: no stop strings.
  }

  const engine: Partial<EngineSettings> = {
    preferCharacterPrompt: power.prefer_character_prompt as boolean,
    preferCharacterJailbreak: power.prefer_character_jailbreak as boolean,
    pinExamples: power.pin_examples as boolean,
    collapseNewlines: power.collapse_newlines as boolean,
    trimSpaces: power.trim_spaces as boolean,
    trimSentences: power.trim_sentences as boolean,
    autoFixMarkdown: power.auto_fix_generated_markdown as boolean,
    allowName1Display: power.allow_name1_display as boolean,
    allowName2Display: power.allow_name2_display as boolean,
    userPromptBias: power.user_prompt_bias as string,
    showUserPromptBias: power.show_user_prompt_bias as boolean,
    stopStrings,
    stopStringsMacros: power.custom_stopping_strings_macro as boolean,
    worldInfo: {
      depth: wi.world_info_depth,
      minActivations: wi.world_info_min_activations,
      minActivationsDepthMax: wi.world_info_min_activations_depth_max,
      budget: wi.world_info_budget,
      budgetCap: wi.world_info_budget_cap,
      includeNames: wi.world_info_include_names,
      recursive: wi.world_info_recursive,
      caseSensitive: wi.world_info_case_sensitive,
      matchWholeWords: wi.world_info_match_whole_words,
      characterStrategy: wi.world_info_character_strategy,
      useGroupScoring: wi.world_info_use_group_scoring,
      maxRecursionSteps: wi.world_info_max_recursion_steps,
    } as EngineSettings['worldInfo'],
    authorsNote: {
      defaultPrompt: note.default,
      defaultInterval: note.defaultInterval,
      defaultDepth: note.defaultDepth,
      defaultPosition: note.defaultPosition,
      defaultRole: note.defaultRole,
      allowWIScan: note.allowWIScan,
      characterNotes,
    } as EngineSettings['authorsNote'],
    reasoning: {
      autoParse: reasoning.auto_parse,
      addToPrompts: reasoning.add_to_prompts,
      maxAdditions: reasoning.max_additions,
      ...(typeof reasoning.prefix === 'string'
        ? {
            template: {
              name: String(reasoning.name ?? 'Imported'),
              prefix: reasoning.prefix,
              suffix: String(reasoning.suffix ?? ''),
              separator: String(reasoning.separator ?? ''),
            },
          }
        : {}),
    } as EngineSettings['reasoning'],
  }

  const quickReply = obj(ext.quickReplyV2)
  return JSON.parse(
    JSON.stringify({
      personas,
      defaultPersona: power.default_persona ? stripExt(String(power.default_persona)) : undefined,
      globalLorebooks: Array.isArray(lore.globalSelect) ? lore.globalSelect : undefined,
      characterLorebooks,
      regexScripts: Array.isArray(ext.regex) ? (ext.regex as RegexScript[]) : undefined,
      allowedCharacterRegex: Array.isArray(ext.character_allowed_regex)
        ? ext.character_allowed_regex.map((a: unknown) => stripExt(String(a)))
        : undefined,
      allowedPresetRegex: obj(ext.preset_allowed_regex).openai,
      activePreset: obj(st.oai_settings).preset_settings_openai,
      globalVariables: obj(ext.variables).global,
      quickReplies: Object.keys(quickReply).length
        ? {
            ...quickReply,
            characterConfigs: Object.fromEntries(
              Object.entries(obj(quickReply.characterConfigs)).map(([k, v]) => [stripExt(k), v]),
            ),
          }
        : undefined,
      engine,
    }),
  ) as AppSettings
}
