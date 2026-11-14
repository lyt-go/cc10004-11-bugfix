import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  getPathDiagnosis,
  listPathDiagnoses,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { PathDiagnosis } from '@/domain/path-diagnosis'

const meta = moduleMeta('userpath')
const actions = meta.actions
const statuses = meta.statuses
const stats: { label: string; status?: string }[] = [
  { label: '路径模式总数' },
  { label: '已确认模式', status: '已确认' },
  { label: '模式分析中', status: '模式分析中' },
]

function StepTable({ diagnosis }: { diagnosis: PathDiagnosis }) {
  return (
    <table className="detail-table">
      <thead>
        <tr>
          <th>步骤</th>
          <th>节点</th>
          <th>每步事件</th>
          <th>节点权重</th>
          <th>校验结果</th>
        </tr>
      </thead>
      <tbody>
        {diagnosis.steps.map((step) => (
          <tr key={`${step.index}-${step.node}`} className={step.matched && step.eventValid ? '' : 'row-invalid'}>
            <td>{step.index}</td>
            <td>{step.node}</td>
            <td>{step.event}</td>
            <td>{step.weight || '—'}</td>
            <td>{step.message}</td>
          </tr>
        ))}
        {diagnosis.steps.length === 0 && (
          <tr>
            <td className="empty-state" colSpan={5}>当前版本没有可展示的步骤序列</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

export default function UserpathView() {
  const [rows, setRows] = useState<PathDiagnosis[]>([])
  const [total, setTotal] = useState(0)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<PathDiagnosis | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => ['模式编号', '路径名称', '关联漏斗'], [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listPathDiagnoses(filters)
      setRows(payload)
      setTotal(payload.length)
      setSelectedId((current) => {
        if (current !== null && payload.some((row) => row.pathId === current)) {
          return current
        }
        return payload.length > 0 ? payload[0].pathId : null
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '用户路径列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    setDetail(getPathDiagnosis(selectedId))
  }, [selectedId, rows])

  function runAction(action: string, diagnosis: PathDiagnosis) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, diagnosis.pathId, action)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setNotice(result.message)
    }
    reload()
  }

  const selected = detail

  return (
    <section className="page" data-module="userpath">
      <header className="page-head">
        <div>
          <h2>用户路径管理</h2>
          <p className="page-desc">挖掘和分析用户在各数据产品中的行为路径模式，识别高频路径和瓶颈。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('路径模式登记入口尚未接入审批流')}>
            登记路径模式
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出用户路径清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">
              {item.status
                ? rows.filter((row) => row.pathStatus === item.status).length
                : total}
            </strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => row.pathStatus === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            <th>模式编号</th>
            <th>路径名称</th>
            <th>关联漏斗</th>
            <th>节点序列</th>
            <th>节点权重</th>
            <th>最大步长</th>
            <th>确认号</th>
            <th>诊断结论</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.pathId} className={selectedId === row.pathId ? 'row-selected' : ''}>
              <td>{row.pathCode}</td>
              <td>
                <button className="link" type="button" onClick={() => setSelectedId(row.pathId)}>
                  {row.pathName}
                </button>
              </td>
              <td>{row.funnelCode ? `${row.funnelCode} v${row.funnelVersion}` : '未关联'}</td>
              <td>{row.pathNodes.map((item) => item.node).join(' → ') || '—'}</td>
              <td>{row.pathNodes.map((item) => item.weight).filter(Boolean).join(' / ') || '—'}</td>
              <td>{row.maxStepLength || '—'}</td>
              <td>{row.confirmationNo || '—'}</td>
              <td>
                <span className={row.confirmable ? 'tag-ok' : 'tag-stop'}>{row.summary}</span>
              </td>
              <td className="row-actions">
                {actions.map((action) => {
                  const blockedReason = row.pathActionBlocked[action] ?? ''
                  return (
                    <button
                      key={action}
                      className="link"
                      type="button"
                      disabled={blockedReason !== ''}
                      title={blockedReason || undefined}
                      onClick={() => runAction(action, row)}
                    >
                      {action}
                    </button>
                  )
                })}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={9}>暂无用户路径数据，可先登记路径模式</td>
            </tr>
          )}
        </tbody>
      </table>

      {selected && (
        <section className="detail-panel" data-testid="path-detail">
          <header className="detail-head">
            <div>
              <h3>
                {selected.pathCode} · {selected.pathName}
              </h3>
              <p className="page-desc">
                关联 {selected.funnelCode || '—'}
                {selected.funnelName ? `（${selected.funnelName}）` : ''} ·
                明细按 v{selected.funnelVersion} 解释
                {selected.funnelVersion !== selected.currentFunnelVersion
                  ? `（漏斗当前 v${selected.currentFunnelVersion}）`
                  : ''} · 业务域 {selected.businessDomain || '—'} · {selected.archived ? '所属漏斗已归档' : '可诊断'}
              </p>
            </div>
            <span className={selected.confirmable ? 'tag-ok' : 'tag-stop'}>{selected.summary}</span>
          </header>

          {selected.archived && (
            <p className="notice-text">
              所属转化定义已归档，停止新的路径确认；归档前流失节点保留供追溯。
            </p>
          )}
          {selected.versionChanged && (
            <p className="error-text">
              路径基于 v{selected.requestedVersion}，当前漏斗已是 v{selected.currentFunnelVersion}，需重新分析后才能确认。
            </p>
          )}
          {selected.reviewStatus && (
            <p className="notice-text">
              复核状态：{selected.reviewStatus}
              {selected.reviewReason ? ` · ${selected.reviewReason}` : ''}
            </p>
          )}

          <h4>转化定义步骤（按 v{selected.funnelVersion} 解释：已确认/归档路径取当时快照，未确认路径取关联版本）</h4>
          <StepTable diagnosis={selected} />

          <h4>路径节点</h4>
          <p className="detail-line">
            {selected.pathNodes.map((item) => `${item.node}（权重 ${item.weight || '—'}）`).join(' → ') || '—'}
          </p>
          <p className="detail-line">
            最大步长：{selected.maxStepLength || '—'} · 转化率：
            {selected.conversionRate || '待确认后生成'}
          </p>

          {selected.unknownNodes.length > 0 && (
            <>
              <h4>路径中存在、转化定义中没有的节点</h4>
              <p className="error-text">
                {selected.unknownNodes
                  .map((item) => `${item.node}（权重 ${item.weight || '—'}）`)
                  .join('、')}
              </p>
            </>
          )}

          {selected.lossNodes.length > 0 && (
            <>
              <h4>流失节点（{selected.archived ? '归档前快照，保留追溯' : '当前版本'}）</h4>
              <ul className="detail-list">
                {selected.lossNodes.map((node) => (
                  <li key={`${node.node}-${node.event}`}>
                    {node.node}
                    {node.event ? `（${node.event}）` : ''}：{node.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!selected.confirmable && selected.blockedReason && (
            <p className="detail-line">确认阻断原因：{selected.blockedReason}</p>
          )}
        </section>
      )}

      <footer className="page-foot">
        <span>共 {total} 条用户路径记录</span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
