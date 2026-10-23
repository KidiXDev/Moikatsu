export interface QuickReply {
  id: number
  label: string
  title: string
  icon: string
  showLabel: boolean
  message: string
  isHidden: boolean
  contextList: Array<{ set: string; isChained: boolean }>
  preventAutoExecute: boolean
  executeOnStartup: boolean
  executeOnUser: boolean
  executeOnAi: boolean
  executeOnChatChange: boolean
  executeOnGroupMemberDraft: boolean
  executeOnNewChat: boolean
  executeBeforeGeneration: boolean
  automationId: string
  [key: string]: unknown
}

export interface QuickReplySet {
  version: 2
  name: string
  disableSend: boolean
  placeBeforeInput: boolean
  injectInput: boolean
  color: string
  onlyBorderColor: boolean
  qrList: QuickReply[]
  idIndex: number
  [key: string]: unknown
}

/** Which sets are active in a scope (global settings, a character, or a chat). */
export interface QuickReplyConfig {
  setList: Array<{ set: string; isVisible: boolean }>
}

export const QUICK_REPLY_EVENTS = {
  startup: 'executeOnStartup',
  user: 'executeOnUser',
  ai: 'executeOnAi',
  chatChange: 'executeOnChatChange',
  newChat: 'executeOnNewChat',
  beforeGeneration: 'executeBeforeGeneration',
  groupMemberDraft: 'executeOnGroupMemberDraft',
} as const

export type QuickReplyEvent = keyof typeof QUICK_REPLY_EVENTS

const REPLY_DEFAULTS = {
  title: '',
  icon: '',
  showLabel: false,
  isHidden: false,
  contextList: [] as QuickReply['contextList'],
  preventAutoExecute: true,
  executeOnStartup: false,
  executeOnUser: false,
  executeOnAi: false,
  executeOnChatChange: false,
  executeOnGroupMemberDraft: false,
  executeOnNewChat: false,
  executeBeforeGeneration: false,
  automationId: '',
}

/** Messages starting with `/` are scripts; they are kept but can't run here. */
export const isScript = (reply: Pick<QuickReply, 'message'>) => reply.message.trim().startsWith('/')

interface LegacySet {
  name?: string
  quickReplySlots?: Array<{ mes?: string; label?: string; title?: string; hidden?: boolean }>
}

/** A Quick Reply set in the current format; converts legacy (v1) sets. */
export function normalizeQuickReplySet(raw: Record<string, unknown>): QuickReplySet {
  const legacy = raw as LegacySet
  const list: Array<Partial<QuickReply>> = Array.isArray(raw.qrList)
    ? (raw.qrList as Array<Partial<QuickReply>>)
    : (legacy.quickReplySlots ?? []).map((slot, i) => ({
        id: i + 1,
        label: slot.label ?? '',
        title: slot.title ?? '',
        message: slot.mes ?? '',
        isHidden: Boolean(slot.hidden),
      }))
  const qrList = list.map((qr, i): QuickReply => ({
    ...REPLY_DEFAULTS,
    ...qr,
    id: qr.id ?? i + 1,
    label: qr.label ?? '',
    message: qr.message ?? '',
  }))
  return {
    ...raw,
    version: 2,
    name: typeof raw.name === 'string' ? raw.name : 'Quick Replies',
    disableSend: Boolean(raw.disableSend),
    placeBeforeInput: Boolean(raw.placeBeforeInput),
    injectInput: Boolean(raw.injectInput),
    color: typeof raw.color === 'string' ? raw.color : 'transparent',
    onlyBorderColor: Boolean(raw.onlyBorderColor),
    qrList,
    idIndex: Math.max(Number(raw.idIndex) || 0, ...qrList.map((qr) => qr.id)),
  }
}

/** Set names active for a chat: global, then chat, then character, without duplicates. */
export function activeQuickReplySets(...configs: Array<QuickReplyConfig | undefined>) {
  const seen = new Map<string, boolean>()
  for (const config of configs)
    for (const { set, isVisible } of config?.setList ?? [])
      seen.set(set, (seen.get(set) ?? false) || isVisible !== false)
  return [...seen].map(([set, isVisible]) => ({ set, isVisible }))
}

/** Text that goes into the input box when a reply runs. */
export function quickReplyInput(set: QuickReplySet, reply: QuickReply, input: string) {
  if (set.injectInput && input.trim())
    return set.placeBeforeInput ? `${reply.message} ${input}` : `${input} ${reply.message}`
  return `${reply.message} `
}

/**
 * Replies that run automatically on an event, or when World Info entries with matching
 * automation ids activate. Scripts are skipped.
 */
export function autoRunQuickReplies(
  sets: QuickReplySet[],
  trigger: QuickReplyEvent | { automationIds: string[] },
): Array<{ set: QuickReplySet; reply: QuickReply }> {
  const matches = (reply: QuickReply) =>
    typeof trigger === 'string'
      ? Boolean(reply[QUICK_REPLY_EVENTS[trigger]])
      : Boolean(reply.automationId) && trigger.automationIds.includes(reply.automationId)
  return sets.flatMap((set) =>
    set.qrList
      .filter((reply) => matches(reply) && !isScript(reply))
      .map((reply) => ({ set, reply })),
  )
}
