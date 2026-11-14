import type { EntryRow } from '@/data/types'

/**
 * 转化漏斗 → 路径模式的唯一领域实现。
 *
 * 路径列表、路径详情和确认动作都从这里取结论，避免出现「列表说可确认、详情里多一个节点」
 * 这类两处明细对不上的问题。历史路径按确认/归档当时的版本快照解释，而不是按当前版本重算。
 */

export const CONVERSION_KEY = 'conversion'
export const USERPATH_KEY = 'userpath'
export const EVENTDEF_KEY = 'eventdef'

/** 可进入确认的路径状态；确认后的路径只能经复核，不能再次确认。 */
export const PATH_FIRST_STATUSES = ['草稿', '模式分析中']

export const CONVERSION_FIELDS = {
  code: '转化编号',
  name: '转化名称',
  steps: '步骤序列',
  events: '每步事件',
  domain: '业务域',
  version: '定义版本',
  history: '_版本历史',
} as const

export const PATH_FIELDS = {
  code: '模式编号',
  name: '路径名称',
  nodes: '节点序列',
  weights: '节点权重',
  maxStepLength: '最大步长',
  funnel: '关联漏斗',
  funnelVersion: '关联版本',
  confirmNo: '确认号',
  reviewStatus: '复核状态',
  lossNodes: '流失节点',
  snapshot: '_确认快照',
  archivedSnapshot: '_归档前快照',
  reviewReason: '_复核原因',
  reviewAt: '_复核时间',
} as const

export type FunnelStep = {
  node: string
  event: string
}

export type FunnelVersion = {
  version: number
  steps: FunnelStep[]
  businessDomain: string
  createdAt: string
  archivedAt?: string
}

export type LossNode = {
  node: string
  event: string
  reason: string
}

export type StepCheck = {
  index: number
  node: string
  event: string
  matched: boolean
  eventValid: boolean
  weight: string
  message: string
}

export type PathSnapshot = {
  version: number
  steps: FunnelStep[]
  businessDomain: string
  nodeWeights: Record<string, string>
  maxStepLength: string
  lossNodes: LossNode[]
  conversionRate: string
  confirmedAt?: string
  confirmationNo?: string
  archivedAt?: string
}

export type PathDiagnosis = {
  pathId: number
  pathCode: string
  pathName: string
  pathStatus: string
  pathActionBlocked: Record<string, string>
  linkedFunnelCode: string
  funnelCode: string
  funnelName: string
  funnelStatus: string
  /** 漏斗当前版本（用于判断是否发生版本切换）。 */
  currentFunnelVersion: number
  /** 步骤明细实际按哪个版本解释。 */
  funnelVersion: number
  requestedVersion: number
  versionChanged: boolean
  archived: boolean
  businessDomain: string
  steps: StepCheck[]
  pathNodes: { node: string; weight: string }[]
  unknownNodes: { node: string; weight: string }[]
  lossNodes: LossNode[]
  invalidSteps: { index: number; node: string; event: string; reason: string }[]
  nodeWeights: Record<string, string>
  maxStepLength: string
  conversionRate: string
  confirmationNo: string
  reviewStatus: string
  reviewReason: string
  confirmed: boolean
  confirmable: boolean
  blockedReason: string
  summary: string
  snapshot: PathSnapshot | null
  archivedSnapshot: PathSnapshot | null
}

export type DiagnosisContext = {
  funnelRows: EntryRow[]
  eventRows: EntryRow[]
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

function versionNumber(value: unknown, fallback = 1): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

/** 步骤序列/事件序列/节点权重用同一套分隔符解析，列表和详情不会再各写一份。 */
export function splitSequence(value: unknown): string[] {
  return text(value)
    .split(/[>＞,，、;；|→\n\r]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

export function buildFunnelSteps(row: EntryRow): FunnelStep[] {
  const nodes = splitSequence(row[CONVERSION_FIELDS.steps])
  const events = splitSequence(row[CONVERSION_FIELDS.events])
  const size = Math.max(nodes.length, events.length)
  return Array.from({ length: size }, (_, index) => ({
    node: nodes[index] ?? '',
    event: events[index] ?? '',
  }))
}

export function currentFunnelVersion(row: EntryRow): number {
  const declared = versionNumber(row[CONVERSION_FIELDS.version], 0)
  const history = readVersionHistory(row)
  return Math.max(declared, ...history.map((item) => item.version), 1)
}

export function readVersionHistory(row: EntryRow): FunnelVersion[] {
  const raw = row[CONVERSION_FIELDS.history]
  if (typeof raw !== 'string' || raw.trim() === '') {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .map((item) => normalizeVersion(item))
      .filter((item): item is FunnelVersion => item !== null)
      .sort((left, right) => left.version - right.version)
  } catch {
    return []
  }
}

function normalizeSteps(input: unknown): FunnelStep[] {
  if (!Array.isArray(input)) {
    return []
  }
  return input
    .map((step) => {
      if (!step || typeof step !== 'object') {
        return null
      }
      const item = step as Record<string, unknown>
      return { node: text(item.node), event: text(item.event) }
    })
    .filter((step): step is FunnelStep => step !== null)
}

function normalizeVersion(input: unknown): FunnelVersion | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const source = input as Record<string, unknown>
  const version = versionNumber(source.version, 0)
  if (version <= 0) {
    return null
  }
  return {
    version,
    steps: normalizeSteps(source.steps),
    businessDomain: text(source.businessDomain),
    createdAt: text(source.createdAt),
    archivedAt: text(source.archivedAt) || undefined,
  }
}

export function buildVersionFromRow(row: EntryRow, version: number): FunnelVersion {
  return {
    version,
    steps: buildFunnelSteps(row),
    businessDomain: text(row[CONVERSION_FIELDS.domain]),
    createdAt: new Date().toISOString(),
  }
}

/** 版本历史里找不到时，才回退到行上当前字段；归档动作不会清空这些字段。 */
export function resolveFunnelVersion(row: EntryRow, version: number): FunnelVersion | null {
  const history = readVersionHistory(row)
  const stored = history.find((item) => item.version === version)
  if (stored) {
    return stored
  }
  if (version === currentFunnelVersion(row)) {
    return buildVersionFromRow(row, version)
  }
  return null
}

export function serializeVersionHistory(history: FunnelVersion[]): string {
  return JSON.stringify(
    [...history].sort((left, right) => left.version - right.version),
  )
}

export function eventDefinitionStatus(event: string, eventRows: EntryRow[]): {
  valid: boolean
  reason: string
} {
  const name = text(event)
  if (name === '') {
    return { valid: false, reason: '每步事件为空' }
  }
  if (eventRows.length === 0) {
    return { valid: true, reason: '' }
  }
  const matched = eventRows.find(
    (row) => text(row['事件编号']) === name || text(row['事件名称']) === name,
  )
  if (!matched) {
    return { valid: false, reason: '事件未在事件定义中登记' }
  }
  if (text(matched.status) === '已下线') {
    return { valid: false, reason: '事件已下线' }
  }
  return { valid: true, reason: '' }
}

function parseWeights(row: EntryRow): Record<string, string> {
  const weights = splitSequence(row[PATH_FIELDS.weights])
  const nodes = splitSequence(row[PATH_FIELDS.nodes])
  const result: Record<string, string> = {}
  nodes.forEach((node, index) => {
    result[node] = weights[index] ?? ''
  })
  return result
}

function normalizeLossNodes(input: unknown): LossNode[] {
  if (!Array.isArray(input)) {
    return []
  }
  return input
    .map((node) => {
      if (!node || typeof node !== 'object') {
        return null
      }
      const item = node as Record<string, unknown>
      return {
        node: text(item.node),
        event: text(item.event),
        reason: text(item.reason),
      }
    })
    .filter((node): node is LossNode => node !== null)
}

function parseSnapshot(row: EntryRow, field: string): PathSnapshot | null {
  const raw = row[field]
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    return {
      version: versionNumber(parsed.version, 1),
      steps: normalizeSteps(parsed.steps),
      businessDomain: text(parsed.businessDomain),
      nodeWeights:
        parsed.nodeWeights && typeof parsed.nodeWeights === 'object'
          ? Object.fromEntries(
              Object.entries(parsed.nodeWeights as Record<string, unknown>).map(
                ([key, value]) => [key, text(value)],
              ),
            )
          : {},
      maxStepLength: text(parsed.maxStepLength),
      lossNodes: normalizeLossNodes(parsed.lossNodes),
      conversionRate: text(parsed.conversionRate),
      confirmedAt: text(parsed.confirmedAt) || undefined,
      confirmationNo: text(parsed.confirmationNo) || undefined,
      archivedAt: text(parsed.archivedAt) || undefined,
    }
  } catch {
    return null
  }
}

export function readPathSnapshot(row: EntryRow): PathSnapshot | null {
  return parseSnapshot(row, PATH_FIELDS.snapshot)
}

export function readArchivedSnapshot(row: EntryRow): PathSnapshot | null {
  return parseSnapshot(row, PATH_FIELDS.archivedSnapshot)
}

export function computeLossNodes(pathNodes: string[], steps: FunnelStep[]): LossNode[] {
  const visited = new Set(pathNodes)
  return steps
    .filter((step) => step.node !== '' && !visited.has(step.node))
    .map((step) => ({
      node: step.node,
      event: step.event,
      reason: '路径未经过该漏斗步骤',
    }))
}

export function computeConversionRate(weights: Record<string, string>): string {
  const values = Object.values(weights)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  if (values.length === 0) {
    return ''
  }
  const last = values[values.length - 1]
  return last <= 1 ? `${(last * 100).toFixed(1)}%` : `${last}%`
}

/** 转化定义页面的动作可用性：与 local-service 的流转约束保持一份实现。 */
export function conversionActionBlocked(row: EntryRow, action: string): string {
  const status = text(row.status)
  if (action === '启用漏斗') {
    if (status === '已归档') {
      return ''
    }
    return status === '定义评审中' ? '' : `当前状态「${status}」不能启用漏斗`
  }
  if (status === '已归档') {
    return '已归档漏斗只能重新启用并形成新版本'
  }
  if (action === '提交定义评审') {
    return status === '草稿' ? '' : `当前状态「${status}」不能提交定义评审`
  }
  return ''
}

export function diagnosePath(row: EntryRow, context: DiagnosisContext): PathDiagnosis {
  const pathId = Number(row.id)
  const status = text(row.status)
  const pathCode = text(row[PATH_FIELDS.code])
  const pathName = text(row[PATH_FIELDS.name])
  const linkedFunnelCode = text(row[PATH_FIELDS.funnel])
  const pathNodes = splitSequence(row[PATH_FIELDS.nodes])
  const nodeWeights = parseWeights(row)
  const maxStepLength = text(row[PATH_FIELDS.maxStepLength])
  const confirmationNo = text(row[PATH_FIELDS.confirmNo])
  const reviewStatus = text(row[PATH_FIELDS.reviewStatus])
  const reviewReason = text(row[PATH_FIELDS.reviewReason])
  const confirmedSnapshot = readPathSnapshot(row)
  const archivedSnapshot = readArchivedSnapshot(row)

  const funnel = context.funnelRows.find(
    (item) => text(item[CONVERSION_FIELDS.code]) === linkedFunnelCode,
  )
  const funnelStatus = funnel ? text(funnel.status) : ''
  const funnelVersion = funnel ? currentFunnelVersion(funnel) : 0
  const rowVersion = versionNumber(row[PATH_FIELDS.funnelVersion], 0)
  const requestedVersion = rowVersion > 0 ? rowVersion : funnelVersion
  const versionChanged =
    Boolean(funnel) && rowVersion > 0 && rowVersion !== funnelVersion
  const archived = funnelStatus === '已归档'

  // 版本规则：路径展示它绑定版本（确认/归档时的 关联版本）的步骤；
  // 节点权重、最大步长同样只取这个版本的快照，避免步骤明细与权重来自不同版本。
  // 旧版本快照仅在版本与绑定版本一致时解释历史，重新分析绑定新版本后不再覆盖显示。
  const candidates = [confirmedSnapshot, archivedSnapshot].filter(
    (item): item is PathSnapshot => item !== null,
  )
  const displayGraph = candidates.find((item) => item.version === requestedVersion) ?? null
  const versionSnapshot =
    (funnel ? resolveFunnelVersion(funnel, requestedVersion) : null) ?? displayGraph
  const stepsSource = versionSnapshot?.steps ?? []
  const businessDomain = versionSnapshot?.businessDomain ?? ''
  const displayVersion = versionSnapshot?.version ?? requestedVersion

  const stepByNode = new Map<string, FunnelStep>()
  for (const step of stepsSource) {
    if (!stepByNode.has(step.node)) {
      stepByNode.set(step.node, step)
    }
  }
  const pathNodeSet = new Set(pathNodes)
  const invalidSteps: PathDiagnosis['invalidSteps'] = []
  const steps: StepCheck[] = stepsSource.map((step, index) => {
    const matched = pathNodeSet.has(step.node)
    const event = eventDefinitionStatus(step.event, context.eventRows)
    if (!event.valid) {
      invalidSteps.push({
        index: index + 1,
        node: step.node,
        event: step.event,
        reason: event.reason,
      })
    }
    return {
      index: index + 1,
      node: step.node,
      event: step.event,
      matched,
      eventValid: event.valid,
      weight: matched ? nodeWeights[step.node] ?? '' : '',
      message: event.valid
        ? matched
          ? '节点与事件均有效'
          : '路径未经过该步骤'
        : event.reason,
    }
  })

  const unknownNodes = pathNodes
    .filter((node) => !stepByNode.has(node))
    .map((node) => {
      invalidSteps.push({
        index: 0,
        node,
        event: '',
        reason: '节点不在转化定义的步骤序列中',
      })
      return { node, weight: nodeWeights[node] ?? '' }
    })

  const lossNodes = displayGraph?.lossNodes ?? computeLossNodes(pathNodes, stepsSource)

  const reasons: string[] = []
  if (!linkedFunnelCode) {
    reasons.push('路径未关联转化定义')
  } else if (!funnel) {
    reasons.push(`关联的转化定义 ${linkedFunnelCode} 不存在`)
  } else if (archived) {
    reasons.push('所属转化定义已归档，停止新的路径确认；归档前流失节点保留供追溯')
  }
  if (status !== '草稿' && status !== '模式分析中' && status !== '已确认') {
    reasons.push(`当前状态「${status}」不能进入确认`)
  }
  if (confirmedSnapshot || status === '已确认') {
    reasons.push(`路径已确认${confirmationNo ? `（${confirmationNo}）` : ''}，再次确认只会进入复核`)
  }
  if (versionChanged) {
    reasons.push(
      `路径基于版本 v${requestedVersion}，当前漏斗已是 v${funnelVersion}，需重新分析后再确认`,
    )
  }
  if (pathNodes.length === 0) {
    reasons.push('路径节点序列为空')
  }
  if (invalidSteps.length > 0) {
    reasons.push(`${invalidSteps.length} 个步骤校验未通过`)
  }

  const hasConfirmed = Boolean(confirmedSnapshot) || status === '已确认'
  const confirmable =
    Boolean(funnel) &&
    !archived &&
    !versionChanged &&
    !hasConfirmed &&
    status !== '已归档' &&
    PATH_FIRST_STATUSES.includes(status) &&
    pathNodes.length > 0 &&
    invalidSteps.length === 0
  const blockedReason = confirmable ? '' : reasons[0] ?? '当前路径不能确认'

  let summary = ''
  if (archived) {
    summary = '归档漏斗：停止新确认，保留流失节点'
  } else if (hasConfirmed) {
    summary = confirmationNo ? `已确认 ${confirmationNo}` : '已确认'
  } else if (versionChanged) {
    summary = `版本已切换（路径 v${requestedVersion} / 漏斗 v${funnelVersion}）`
  } else if (invalidSteps.length > 0) {
    summary = `${invalidSteps.length} 个步骤校验未通过`
  } else if (confirmable) {
    summary = `可确认（${steps.length} 步）`
  } else {
    summary = blockedReason
  }

  return {
    pathId,
    pathCode,
    pathName,
    pathStatus: status,
    // 页面按钮的禁用理由与确认校验共用同一套结论，避免列表和详情各判一次。
    pathActionBlocked: {
    确认模式: confirmable ? '' : blockedReason,
    提交模式分析: archived
      ? '所属转化定义已归档，停止新的路径分析'
      : !funnel
        ? '路径未关联有效的转化定义'
        : !['草稿', '模式分析中', '已确认'].includes(status)
          ? `当前状态「${status}」不能继续分析`
          : '',
  },
    linkedFunnelCode,
    funnelCode: funnel ? text(funnel[CONVERSION_FIELDS.code]) : '',
    funnelName: funnel ? text(funnel[CONVERSION_FIELDS.name]) : '',
    funnelStatus,
    currentFunnelVersion: funnelVersion,
    funnelVersion: displayVersion,
    requestedVersion,
    versionChanged,
    archived,
    businessDomain,
    steps,
    pathNodes: pathNodes.map((node) => ({ node, weight: nodeWeights[node] ?? '' })),
    unknownNodes,
    lossNodes,
    invalidSteps,
    nodeWeights: displayGraph?.nodeWeights ?? nodeWeights,
    maxStepLength: displayGraph?.maxStepLength || maxStepLength,
    conversionRate:
      displayGraph?.conversionRate ||
      (status === '已确认' ? computeConversionRate(nodeWeights) : ''),
    confirmationNo,
    reviewStatus,
    reviewReason,
    confirmed: Boolean(confirmedSnapshot) || status === '已确认',
    confirmable,
    blockedReason,
    summary,
    snapshot: displayGraph,
    archivedSnapshot,
  }
}

export function buildPathSnapshot(
  diagnosis: PathDiagnosis,
  version: FunnelVersion,
  options: { confirmationNo?: string; archivedAt?: string } = {},
): PathSnapshot {
  const confirmedAt = options.archivedAt ?? new Date().toISOString()
  return {
    version: version.version,
    steps: version.steps.map((step) => ({ ...step })),
    businessDomain: version.businessDomain,
    nodeWeights: { ...diagnosis.nodeWeights },
    maxStepLength: diagnosis.maxStepLength,
    lossNodes: diagnosis.lossNodes.map((node) => ({ ...node })),
    conversionRate: diagnosis.conversionRate,
    confirmedAt: options.confirmationNo ? confirmedAt : undefined,
    confirmationNo: options.confirmationNo,
    archivedAt: options.archivedAt,
  }
}
