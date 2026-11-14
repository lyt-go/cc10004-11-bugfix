import type { ActionResult, EntryRow } from '@/data/types'
import {
  CONVERSION_FIELDS,
  CONVERSION_KEY,
  EVENTDEF_KEY,
  PATH_FIELDS,
  PATH_FIRST_STATUSES,
  USERPATH_KEY,
  buildFunnelSteps,
  buildPathSnapshot,
  buildVersionFromRow,
  currentFunnelVersion,
  diagnosePath,
  eventDefinitionStatus,
  readPathSnapshot,
  readVersionHistory,
  resolveFunnelVersion,
  serializeVersionHistory,
  type FunnelStep,
  type FunnelVersion,
  type PathDiagnosis,
} from '@/domain/path-diagnosis'

/**
 * 转化定义 ↔ 路径模式的引用流转。
 *
 * 所有会改动两边的动作都在这里完成校验：步骤/每步事件校验、归档漏斗停止新确认、
 * 首个完成校验的路径取得确认号、其余请求仅进入复核。返回值里的 commit 决定
 * 这次是否落盘——校验失败时不写，复核记录则单独落盘。
 */

type RowsMap = Record<string, EntryRow[]>

export type WorkflowOutcome = {
  result: ActionResult
  /** true 表示需要把本次改动落盘；复核类拒绝也会写一条复核记录。 */
  commit: boolean
  diagnosis?: PathDiagnosis
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

function ensureRows(rows: RowsMap, key: string): EntryRow[] {
  return rows[key] ?? []
}

function funnelCode(row: EntryRow): string {
  return text(row[CONVERSION_FIELDS.code])
}

function nextConfirmationNo(paths: EntryRow[]): string {
  const used = paths
    .map((row) => text(row[PATH_FIELDS.confirmNo]))
    .map((value) => {
      const matched = value.match(/^PATH-CONF-(\d+)$/)
      return matched ? Number(matched[1]) : 0
    })
  const max = used.reduce((acc, value) => Math.max(acc, value), 0)
  return `PATH-CONF-${String(max + 1).padStart(4, '0')}`
}

/**
 * 转化定义发生变更（归档/重新启用）时，把已确认路径的确认快照冻结下来留档，
 * 不删除确认号，但标记待复核；之后历史流失节点按快照解释，不随新版本重算。
 */
function freezeDependentPaths(rows: RowsMap, funnel: EntryRow, reason: string): void {
  const code = funnelCode(funnel)
  const paths = ensureRows(rows, USERPATH_KEY)
  for (const path of paths) {
    const linkedCode = text(path[PATH_FIELDS.funnel])
    const snapshot = readPathSnapshot(path)
    if (linkedCode !== code || !snapshot) {
      continue
    }
    path[PATH_FIELDS.archivedSnapshot] = JSON.stringify({
      ...snapshot,
      archivedAt: new Date().toISOString(),
    })
    path[PATH_FIELDS.snapshot] = ''
    path[PATH_FIELDS.reviewStatus] = '待复核'
    path[PATH_FIELDS.reviewReason] = reason
    path[PATH_FIELDS.reviewAt] = new Date().toISOString()
    path.pending = true
    path.abnormal = true
  }
}

function submitConversionReview(funnels: EntryRow[], index: number, allRowsSnapshot: RowsMap): WorkflowOutcome {
  const current = funnels[index]
  const status = text(current.status)
  if (status !== '草稿') {
    return {
      result: { ok: false, message: `转化定义当前状态「${status}」，只有草稿可以提交定义评审` },
      commit: false,
    }
  }
  const steps = buildFunnelSteps(current)
  if (steps.length === 0 || steps.some((step) => step.node === '' || step.event === '')) {
    return {
      result: { ok: false, message: '步骤序列与每步事件必须按步骤一一对应，补全后才能提交评审' },
      commit: false,
    }
  }
  const eventRows = ensureRows(allRowsSnapshot, EVENTDEF_KEY)
  for (const [stepIndex, step] of steps.entries()) {
    const checked = eventDefinitionStatus(step.event, eventRows)
    if (!checked.valid) {
      return {
        result: {
          ok: false,
          message: `第 ${stepIndex + 1} 步事件「${step.event}」校验未通过：${checked.reason}`,
        },
        commit: false,
      }
    }
  }
  funnels[index] = { ...current, status: '定义评审中', pending: true, abnormal: false }
  return { result: { ok: true, message: `转化定义已提交评审，共 ${steps.length} 个步骤` }, commit: true }
}

function enableConversion(funnels: EntryRow[], index: number): WorkflowOutcome {
  const current = funnels[index]
  const status = text(current.status)
  if (status === '已归档') {
    // 重新启用必须形成新版本：旧版本的步骤快照保留在版本历史里，供历史路径追溯。
    const version = currentFunnelVersion(current) + 1
    const history = readVersionHistory(current)
    funnels[index] = {
      ...current,
      status: '已启用',
      pending: false,
      abnormal: false,
      [CONVERSION_FIELDS.version]: version,
      [CONVERSION_FIELDS.history]: serializeVersionHistory([
        ...history,
        buildVersionFromRow(current, version),
      ]),
    }
    return {
      result: {
        ok: true,
        message: `已归档漏斗重新启用，形成新版本 v${version}；路径需按新版本重新分析确认`,
      },
      commit: true,
    }
  }
  if (status !== '定义评审中') {
    return {
      result: { ok: false, message: `转化定义当前状态「${status}」，只有定义评审中才能启用` },
      commit: false,
    }
  }
  const version = currentFunnelVersion(current)
  const history = readVersionHistory(current)
  const base = history.find((item) => item.version === version) ?? buildVersionFromRow(current, version)
  funnels[index] = {
    ...current,
    status: '已启用',
    pending: false,
    abnormal: false,
    [CONVERSION_FIELDS.version]: version,
    [CONVERSION_FIELDS.history]: serializeVersionHistory([
      ...history.filter((item) => item.version !== version),
      base,
    ]),
  }
  return { result: { ok: true, message: `转化定义已启用，步骤版本 v${version}` }, commit: true }
}

function archiveConversion(rows: RowsMap, funnels: EntryRow[], index: number): WorkflowOutcome {
  const current = funnels[index]
  const status = text(current.status)
  if (status === '已归档') {
    return { result: { ok: false, message: '转化定义已归档，无需重复归档' }, commit: false }
  }
  const version = resolveFunnelVersion(current, currentFunnelVersion(current)) ??
    buildVersionFromRow(current, currentFunnelVersion(current))
  const archivedVersion: FunnelVersion = {
    ...version,
    steps: version.steps.map((step) => ({ ...step })),
    archivedAt: new Date().toISOString(),
  }
  const history = readVersionHistory(current).filter(
    (item) => item.version !== archivedVersion.version,
  )
  funnels[index] = {
    ...current,
    status: '已归档',
    pending: false,
    abnormal: false,
    [CONVERSION_FIELDS.version]: archivedVersion.version,
    [CONVERSION_FIELDS.history]: serializeVersionHistory([...history, archivedVersion]),
  }
  freezeDependentPaths(
    rows,
    funnels[index],
    '所属转化定义已归档，确认已冻结，保留归档前流失节点',
  )
  return {
    result: {
      ok: true,
      message: `转化定义已归档，版本 v${archivedVersion.version} 冻结；关联路径停止新确认，历史流失节点保留`,
    },
    commit: true,
  }
}

export function transitionConversion(
  rows: RowsMap,
  id: number,
  action: string,
  allRowsSnapshot: RowsMap,
): WorkflowOutcome | null {
  if (!['提交定义评审', '启用漏斗', '归档漏斗'].includes(action)) {
    return null
  }
  const funnels = ensureRows(rows, CONVERSION_KEY)
  const index = funnels.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { result: { ok: false, message: `没有找到编号为 ${id} 的转化定义` }, commit: false }
  }
  if (action === '提交定义评审') {
    return submitConversionReview(funnels, index, allRowsSnapshot)
  }
  if (action === '启用漏斗') {
    return enableConversion(funnels, index)
  }
  return archiveConversion(rows, funnels, index)
}

function stepsSummary(steps: FunnelStep[]): string {
  return steps.map((step) => `${step.node}（${step.event}）`).join(' → ') || '未配置'
}

function submitPathAnalysis(
  paths: EntryRow[],
  index: number,
  current: EntryRow,
  diagnosis: PathDiagnosis,
): WorkflowOutcome {
  const status = text(current.status)
  // 已确认路径只有在漏斗版本切换后才允许回到分析；其余已终态不允许回退。
  const canAnalyze =
    PATH_FIRST_STATUSES.includes(status) || (status === '已确认' && diagnosis.versionChanged)
  if (!canAnalyze) {
    return {
      result: { ok: false, message: `路径模式当前状态「${status}」，只有草稿或模式分析中可以继续分析` },
      commit: false,
      diagnosis,
    }
  }
  if (!diagnosis.funnelCode) {
    return { result: { ok: false, message: '路径未关联有效的转化定义，不能提交分析' }, commit: false, diagnosis }
  }
  if (diagnosis.archived) {
    return {
      result: { ok: false, message: '所属转化定义已归档，停止新的路径分析；归档前流失节点仍可追溯' },
      commit: false,
      diagnosis,
    }
  }
  // 版本切换后重新分析：把路径重新绑定到当前漏斗版本，确认前仍需逐步骤校验。
  if (diagnosis.versionChanged) {
    const previous = readPathSnapshot(current)
    paths[index] = {
      ...current,
      status: '模式分析中',
      pending: true,
      abnormal: false,
      [PATH_FIELDS.funnelVersion]: diagnosis.currentFunnelVersion,
      [PATH_FIELDS.confirmNo]: '',
      [PATH_FIELDS.reviewStatus]: '',
      [PATH_FIELDS.reviewReason]: '',
      [PATH_FIELDS.reviewAt]: '',
      [PATH_FIELDS.snapshot]: '',
      // 旧确认依据留档，追溯时按当时版本解释。
      [PATH_FIELDS.archivedSnapshot]: previous
        ? JSON.stringify({ ...previous, archivedAt: new Date().toISOString() })
        : current[PATH_FIELDS.archivedSnapshot] ?? '',
    }
    return {
      result: {
        ok: true,
        message: `路径已按漏斗 v${diagnosis.currentFunnelVersion} 重新进入分析，确认前会逐步骤校验`,
      },
      commit: true,
      diagnosis,
    }
  }
  paths[index] = { ...current, status: '模式分析中', pending: false }
  return {
    result: { ok: true, message: `路径模式已进入分析，步骤序列：${stepsSummary(diagnosis.steps)}` },
    commit: true,
    diagnosis,
  }
}

function confirmPath(
  rows: RowsMap,
  paths: EntryRow[],
  index: number,
  current: EntryRow,
  diagnosis: PathDiagnosis,
): WorkflowOutcome {
  const status = text(current.status)

  if (diagnosis.archived) {
    const losses = diagnosis.lossNodes.map((node) => node.node).join('、')
    return {
      result: {
        ok: false,
        message: `所属转化定义已归档，停止新的路径确认${losses ? `；保留归档前流失节点：${losses}` : ''}`,
      },
      commit: false,
      diagnosis,
    }
  }

  // 连续两次确认或版本切换撞在一起：后到者不拿确认号，只记一条复核。
  if (readPathSnapshot(current) || status === '已确认') {
    const message =
      status === '已确认'
        ? `路径已确认${diagnosis.confirmationNo ? `（${diagnosis.confirmationNo}）` : ''}，重复确认仅进入复核，未生成新确认号`
        : '另一请求已完成校验并取得确认号，本次仅进入复核'
    paths[index] = {
      ...current,
      [PATH_FIELDS.reviewStatus]: '待复核',
      [PATH_FIELDS.reviewReason]: message,
      [PATH_FIELDS.reviewAt]: new Date().toISOString(),
      pending: true,
    }
    return { result: { ok: false, message }, commit: true, diagnosis }
  }
  if (!PATH_FIRST_STATUSES.includes(status)) {
    return {
      result: { ok: false, message: `路径模式当前状态「${status}」不能进入确认` },
      commit: false,
      diagnosis,
    }
  }
  if (!diagnosis.funnelCode) {
    return { result: { ok: false, message: '路径未关联有效的转化定义，不能确认' }, commit: false, diagnosis }
  }
  if (diagnosis.versionChanged) {
    return {
      result: {
        ok: false,
        message: `路径基于 v${diagnosis.requestedVersion}，当前漏斗已是 v${diagnosis.currentFunnelVersion}，版本切换后必须重新分析确认`,
      },
      commit: false,
      diagnosis,
    }
  }
  if (diagnosis.pathNodes.length === 0) {
    return { result: { ok: false, message: '路径节点序列为空，不能确认' }, commit: false, diagnosis }
  }
  if (diagnosis.invalidSteps.length > 0) {
    const first = diagnosis.invalidSteps[0]
    return {
      result: {
        ok: false,
        message:
          first.index > 0
            ? `第 ${first.index} 步（${first.node} / ${first.event}）校验未通过：${first.reason}`
            : `节点「${first.node}」校验未通过：${first.reason}`,
      },
      commit: false,
      diagnosis,
    }
  }

  const funnel = ensureRows(rows, CONVERSION_KEY).find(
    (row) => funnelCode(row) === diagnosis.funnelCode,
  )
  const version =
    (funnel ? resolveFunnelVersion(funnel, diagnosis.requestedVersion) : null) ?? {
      version: diagnosis.requestedVersion,
      steps: diagnosis.steps.map((step) => ({ node: step.node, event: step.event })),
      businessDomain: diagnosis.businessDomain,
      createdAt: new Date().toISOString(),
    }
  const confirmationNo = nextConfirmationNo(paths)
  const confirmed = buildPathSnapshot(diagnosis, version, { confirmationNo })
  confirmed.confirmedAt = new Date().toISOString()
  paths[index] = {
    ...current,
    status: '已确认',
    pending: false,
    abnormal: false,
    [PATH_FIELDS.funnelVersion]: version.version,
    [PATH_FIELDS.snapshot]: JSON.stringify(confirmed),
    [PATH_FIELDS.lossNodes]: JSON.stringify(confirmed.lossNodes),
    [PATH_FIELDS.confirmNo]: confirmationNo,
    [PATH_FIELDS.reviewStatus]: '',
    [PATH_FIELDS.reviewReason]: '',
    [PATH_FIELDS.reviewAt]: '',
  }
  return {
    result: {
      ok: true,
      message: `路径已确认并取得确认号 ${confirmationNo}，${confirmed.steps.length} 个步骤全部校验通过`,
    },
    commit: true,
    diagnosis,
  }
}

function archivePath(
  paths: EntryRow[],
  index: number,
  current: EntryRow,
  diagnosis: PathDiagnosis,
): WorkflowOutcome {
  if (text(current.status) === '已归档') {
    return { result: { ok: false, message: '路径模式已归档，无需重复归档' }, commit: false, diagnosis }
  }
  const snapshot = buildPathSnapshot(diagnosis, {
    version: diagnosis.requestedVersion,
    steps: diagnosis.steps.map((step) => ({ node: step.node, event: step.event })),
    businessDomain: diagnosis.businessDomain,
    createdAt: new Date().toISOString(),
  })
  const archived = {
    ...snapshot,
    lossNodes: diagnosis.lossNodes.map((node) => ({ ...node })),
    archivedAt: new Date().toISOString(),
  }
  paths[index] = {
    ...current,
    status: '已归档',
    pending: false,
    [PATH_FIELDS.archivedSnapshot]: JSON.stringify(archived),
    [PATH_FIELDS.lossNodes]: JSON.stringify(archived.lossNodes),
  }
  return {
    result: { ok: true, message: '路径模式已归档，流失节点按归档时版本保留' },
    commit: true,
    diagnosis,
  }
}

export function transitionPath(rows: RowsMap, id: number, action: string): WorkflowOutcome | null {
  if (!['提交模式分析', '确认模式', '归档模式'].includes(action)) {
    return null
  }
  const paths = ensureRows(rows, USERPATH_KEY)
  const index = paths.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { result: { ok: false, message: `没有找到编号为 ${id} 的路径模式` }, commit: false }
  }
  const current = paths[index]
  const diagnosis = diagnosePath(current, {
    funnelRows: ensureRows(rows, CONVERSION_KEY),
    eventRows: ensureRows(rows, EVENTDEF_KEY),
  })
  if (action === '提交模式分析') {
    return submitPathAnalysis(paths, index, current, diagnosis)
  }
  if (action === '确认模式') {
    return confirmPath(rows, paths, index, current, diagnosis)
  }
  return archivePath(paths, index, current, diagnosis)
}

export function transitionGeneric(
  rows: RowsMap,
  key: string,
  id: number,
  action: string,
  target: string,
  statuses: string[],
  entity: string,
  negative: boolean,
): WorkflowOutcome {
  const entries = ensureRows(rows, key)
  const index = entries.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { result: { ok: false, message: `没有找到编号为 ${id} 的${entity}` }, commit: false }
  }
  const current = text(entries[index].status)
  if (current === target) {
    return {
      result: { ok: false, message: `${entity}已经是「${target}」，不用重复操作` },
      commit: false,
    }
  }
  const lastStatus = statuses[statuses.length - 1]
  entries[index] = {
    ...entries[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: negative,
  }
  return {
    result: { ok: true, message: `${entity}已${action}，当前状态「${target}」` },
    commit: true,
  }
}
