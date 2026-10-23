import type { ChatMessage } from '../types.ts'
import { NAMES_BEHAVIOR, type ExampleMessage, type HistoryMessage } from './builder.ts'

export interface HistoryOptions {
  namesBehavior: number
  isGroup: boolean
  userName: string
}

/** Chat messages (oldest first) to prompt history messages. */
export function toHistoryMessages(
  chat: ChatMessage[],
  { namesBehavior, isGroup, userName }: HistoryOptions,
): HistoryMessage[] {
  return chat.map((message) => {
    const isNarrator = message.extra?.type === 'narrator'
    const role = isNarrator ? 'system' : message.is_user ? 'user' : 'assistant'
    let content = message.mes

    if (namesBehavior === NAMES_BEHAVIOR.DEFAULT) {
      const otherSpeaker = message.name !== userName
      if ((isGroup && otherSpeaker) || (message.force_avatar && otherSpeaker && !isNarrator))
        content = `${message.name}: ${content}`
    } else if (namesBehavior === NAMES_BEHAVIOR.CONTENT && !isNarrator) {
      content = `${message.name}: ${content}`
    }

    return {
      role,
      content: content.replace(/\r/gm, ''),
      name: message.name,
      media: message.extra?.media,
      mediaDisplay: message.extra?.media_display,
      mediaIndex: message.extra?.media_index,
    }
  })
}

/** Splits `mes_example` into `<START>` blocks. */
export function splitExampleBlocks(examples: string): string[] {
  if (!examples || examples === '<START>') return []
  const text = examples.startsWith('<START>') ? examples : `<START>\n${examples.trim()}`
  return text
    .split(/<START>/gi)
    .slice(1)
    .map((block) => `<START>\n${block.trim()}\n`)
}

export interface ExampleNames {
  userName: string
  charName: string
  groupNames: string[]
  isGroup: boolean
}

/** Example blocks to messages, one array per block. */
export function parseExampleBlocks(blocks: string[], names: ExampleNames): ExampleMessage[][] {
  return blocks.map((block) =>
    parseExampleBlock(block.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, ''), names),
  )
}

function parseExampleBlock(
  text: string,
  { userName, charName, groupNames, isGroup }: ExampleNames,
): ExampleMessage[] {
  const groupPrefixes = groupNames.map((name) => `${name}:`)
  const result: ExampleMessage[] = []
  let lines: string[] = []
  let inUser = false
  let inBot = false
  let botName = charName

  const add = (name: string, systemName: ExampleMessage['name']) => {
    let content = lines.join('\n').replace(`${name}:`, '').trim()
    if (isGroup) content = `${name}: ${content}`
    result.push({ role: 'system', content, name: systemName })
    lines = []
  }

  // The first line is the block heading.
  for (const line of text.split('\n').slice(1)) {
    if (line.startsWith(`${userName}:`)) {
      inUser = true
      if (inBot) add(botName, 'example_assistant')
      inBot = false
    } else if (
      line.startsWith(`${charName}:`) ||
      groupPrefixes.some((prefix) => line.startsWith(prefix))
    ) {
      if (!line.startsWith(`${charName}:`) && groupPrefixes.length) botName = line.split(':')[0]!
      inBot = true
      if (inUser) add(userName, 'example_user')
      inUser = false
    }
    lines.push(line)
  }

  if (inUser) add(userName, 'example_user')
  else if (inBot) add(botName, 'example_assistant')
  return result
}
