import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, readRowsFromStorage, resetRows, saveAllRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  diagnosePath,
  CONVERSION_KEY,
  EVENTDEF_KEY,
  USERPATH_KEY,
  type PathDiagnosis,
} from '@/domain/path-diagnosis'
import {
  transitionConversion,
  transitionGeneric,
  transitionPath,
} from '@/domain/path-workflow'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 路径诊断：列表和详情共用这一份，保证「可确认」的判断与步骤明细来源一致。
 * 读取时基于存储里的最新数据，避免页面拿着旧缓存放过已归档的漏斗。
 */
export function listPathDiagnoses(filters: Record<string, string> = {}): PathDiagnosis[] {
  const stored = readRowsFromStorage()
  const matched = filterRows(stored[USERPATH_KEY] ?? [], filters)
  return matched.map((row) =>
    diagnosePath(row, {
      funnelRows: stored[CONVERSION_KEY] ?? [],
      eventRows: stored[EVENTDEF_KEY] ?? [],
    }),
  )
}

export function getPathDiagnosis(id: number): PathDiagnosis | null {
  const stored = readRowsFromStorage()
  const row = (stored[USERPATH_KEY] ?? []).find((item) => Number(item.id) === id)
  if (!row) {
    return null
  }
  return diagnosePath(row, {
    funnelRows: stored[CONVERSION_KEY] ?? [],
    eventRows: stored[EVENTDEF_KEY] ?? [],
  })
}

function negativeAction(action: string): boolean {
  return NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
}

/**
 * 动作入口：先按存储的最新数据重新校验，再在同一个快照上完成所有写入，
 * 一次性落盘；任何一步校验或明细写入失败都不会留下半成品。
 */
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const stored = readRowsFromStorage()
  const rows: Record<string, EntryRow[]> = {
    ...stored,
    [key]: [...(stored[key] ?? [])].map((row) => ({ ...row })),
  }

  let outcome: ReturnType<typeof transitionGeneric>
  try {
    if (key === CONVERSION_KEY) {
      outcome = transitionConversion(rows, id, action, stored) ?? {
        result: { ok: false, message: `转化定义没有登记「${action}」这个动作` },
        commit: false,
      }
    } else if (key === USERPATH_KEY) {
      outcome = transitionPath(rows, id, action) ?? {
        result: { ok: false, message: `路径模式没有登记「${action}」这个动作` },
        commit: false,
      }
    } else {
      outcome = transitionGeneric(
        rows,
        key,
        id,
        action,
        target,
        meta.statuses,
        meta.entity,
        negativeAction(action),
      )
    }
  } catch (error) {
    // 校验异常视为写入失败：不落盘，内存与存储都保持原样。
    return {
      ok: false,
      message: error instanceof Error ? error.message : `${meta.entity}${action}失败，未写入任何变更`,
    }
  }

  if (outcome.commit) {
    try {
      saveAllRows(rows)
    } catch (error) {
      return {
        ok: false,
        message: `${outcome.result.message}；写入失败：${
          error instanceof Error ? error.message : '本地存储不可用'
        }，未产生变更`,
      }
    }
  }
  return outcome.result
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
