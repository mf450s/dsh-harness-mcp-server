// Dev-only smoke test (not shipped): drives apply() with a minimal fake ctx and verifies the
// three increments ported onto upstream v0.1.9:
//   1. 任意会话续接: live 接管 / 持久化 resume / 明确报错(三级)
//   2. realpath 规范化: create 的 meta.cwd 为 realpath 值; 目录不存在时回退 resolve 不阻断
//   3. attach_session 工具 + 启动存量捞回(workspaceRegistry/sessions/sessionPersistence 三服务路径)
//   4. 审批抑制: 本插件自有会话 deterministic(缺省 rejected / 允许名单 allowed-once), 非本插件拥有的会话走 next() 交回 UI
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { apply } from './lib/index.js'

const attachedIds = []
const created = []
const resumed = []
const disposed = []
const flushed = []

// smoke 文件所在目录的 realpath(win32 反斜杠规范路径) —— 与 workspace.path / fs.realpath 结果同 canon
const FAKE_CWD = realpathSync(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const fakeWs = {
  id: 'ws-fake',
  title: 'fake',
  path: FAKE_CWD,
  sessionIds: [],
  attachSession: async (id) => { attachedIds.push(id) },
}
const wsRegistry = {
  list: () => [fakeWs],
  resolveByPath: async (p) => (p === FAKE_CWD ? fakeWs : undefined),
  create: async () => fakeWs,
}

function makeAgent(id, cwd) {
  return {
    session: { id, log: [], events: [], header: { version: 0, id, createdAt: Date.now(), cwd } },
    followup: () => {},
    whenIdle: async () => {},
  }
}

const liveAgent = makeAgent('sess-live', FAKE_CWD)
const liveSession2 = { id: 'sess-live2', log: [], events: [], header: { version: 0, id: 'sess-live2', createdAt: 1, cwd: FAKE_CWD } }

const fakeSessions = {
  get: (id) => (id === 'sess-live' ? liveAgent.session : id === 'sess-live2' ? liveSession2 : undefined),
  list: () => [liveSession2],
  flush: async (session) => { flushed.push(session.id); return true },
}
const fakePersistence = {
  list: async () => [{ version: 0, id: 'sess-persisted', createdAt: 1, cwd: FAKE_CWD }],
}

// ── 审批抑制脚手架 ──
// apply() 在插件自己的 ctx 上注册 approval/request 监听(cordis waterfall: listener(request, next))。
// 这里按 waterfall 姿势派发: 监听器返回裁决 = 本插件裁决; 监听器调用 next() = 交回链路其余部分
// (浏览器 UI 的 answerer)。模拟 UI 永远挂着直到手动 settle, 于是"是否等待 UI"可被直接测出。
const approvalListeners = []
function makeUiChain(initialOutcome) {
  const state = { consulted: false }
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  if (initialOutcome) setTimeout(() => settle(initialOutcome), 30)
  return { next: () => { state.consulted = true; return promise }, settle, state }
}
// 50ms 内结算 = 没有等待 UI(模拟 UI 不会自行出结果)
// 注意: runtimeConfig 是模块级共享状态, 第二个实例配置允许名单后会覆盖第一个实例的视图,
// 所以"缺省配置(空名单)"的两项必须排在第二次 apply() 之前。
async function dispatchApproval(index, request, ui) {
  const outcome = await Promise.race([
    Promise.resolve(approvalListeners[index](request, ui.next)),
    new Promise((resolve) => setTimeout(() => resolve('PENDING'), 50)),
  ])
  return { outcome, consultedUi: ui.state.consulted }
}

const ctx = {
  tools: { keys: () => [] },
  llm: {},
  agents: {
    get: (id) => (id === 'sess-live' ? liveAgent : undefined),
    create: async ({ sessionId, meta }) => {
      const id = String(sessionId)
      created.push({ id, cwd: meta?.cwd })
      return { agent: makeAgent(id, meta?.cwd), dispose: async () => { disposed.push(id) } }
    },
    resume: async ({ resumeSessionId }) => {
      const id = String(resumeSessionId)
      if (id !== 'sess-persisted') throw new Error(`no persisted session "${id}"`)
      resumed.push(id)
      return { agent: makeAgent(id, FAKE_CWD), dispose: async () => { disposed.push(id) } }
    },
  },
  agentPresets: { mount: async () => ({ id: 'standard' }) },
  sessions: fakeSessions,
  sessionPersistence: fakePersistence,
  workspaceRegistry: wsRegistry,
  effect: (fn) => { disposer = fn(); return disposer },
  // approval/request 监听器捕获口(审批抑制测试用): 记录 apply() 注册的 waterfall listener
  on: (name, listener) => { if (name === 'approval/request') approvalListeners.push(listener); return () => {} },
  get: (name) => (name === 'workspaceRegistry' ? wsRegistry
    : name === 'sessions' ? fakeSessions
    : name === 'sessionPersistence' ? fakePersistence
    : undefined),
}
let disposer = () => {}

const PORT = 8099
const PORT2 = 8095 // 第二个 apply() 实例(允许名单配置)用的端口: 与 8099 错开, 且本机未被占用
const BASE = `http://127.0.0.1:${PORT}/mcp`

async function rpc(sessionId, body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
  const sid = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  return { sid, status: res.status, text }
}

function parsePayload(text) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data: ')) return JSON.parse(t.slice(6))
  }
  return JSON.parse(text)
}

// 解出 MCP envelope 里的内层 JSON(text content 是 out() 字符串); isError 结果取错误文本
function innerOf(resp) {
  const payload = parsePayload(resp.text)
  if (payload.error) return { error: payload.error.message }
  const r = payload.result
  if (r.isError) return { error: r.content?.[0]?.text ?? 'isError' }
  return JSON.parse(r.content[0].text)
}

const checks = {}
try {
  await apply(ctx, { port: PORT, host: '127.0.0.1' })
  await new Promise((r) => setTimeout(r, 400))

  const init = await rpc(undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } },
  })
  checks['initialize 拿到 sessionId'] = Boolean(init.sid)
  await rpc(init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const echo = await rpc(init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ping-8099' } } })
  checks['echo 通'] = echo.status === 200 && echo.text.includes('ping-8099')

  const toolsList = await rpc(init.sid, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  const toolNames = parsePayload(toolsList.text).result?.tools?.map((t) => t.name) ?? []
  checks['attach_session 在工具清单里'] = toolNames.includes('attach_session')

  // ── 增量3: attach_session 工具(live / 持久化 / 未知三态) ──
  const attachLive = await rpc(init.sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-live' } } })
  checks['attach_session live 会话'] = attachLive.status === 200 && innerOf(attachLive).attached === true

  const attachMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-nope' } } })
  checks['attach_session 未知会话报错'] = attachMissing.status === 200 && typeof innerOf(attachMissing).error === 'string'

  const attachPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-persisted' } } })
  checks['attach_session 持久化会话(经 sessionPersistence)'] = attachPersisted.status === 200 && innerOf(attachPersisted).attached === true

  // ── 增量1: 任意会话续接三级 ──
  const runLive = await rpc(init.sid, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-live' } } })
  const runLiveInner = runLive.status === 200 ? innerOf(runLive) : { error: 'bad' }
  checks['agent_run 接管 live 会话(不 resume 不 dispose)'] = runLiveInner.sessionId === 'sess-live' && resumed.length === 0 && disposed.length === 0

  const runPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-persisted' } } })
  const runPersistedInner = runPersisted.status === 200 ? innerOf(runPersisted) : { error: 'bad' }
  checks['agent_run 持久化会话 resume + flush + dispose'] = runPersistedInner.sessionId === 'sess-persisted'
    && resumed.includes('sess-persisted') && flushed.includes('sess-persisted') && disposed.includes('sess-persisted')

  const runUnknown = await rpc(init.sid, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-unknown' } } })
  checks['agent_run 未知会话明确报错'] = runUnknown.status === 200 && String(innerOf(runUnknown).error ?? '').includes('session not found for resume')

  // ── 增量2: realpath 规范化 ──
  const runNew = await rpc(init.sid, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD } } })
  const runNewInner = runNew.status === 200 ? innerOf(runNew) : { error: 'bad' }
  checks['agent_run 池新建: meta.cwd 为 realpath 值'] = Boolean(created[0]) && created[0].cwd === FAKE_CWD && runNewInner.sessionId === created[0].id

  const missingDir = resolve(FAKE_CWD, 'nonexistent-xyz')
  const runMissingCwd = await rpc(init.sid, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: missingDir } } })
  const runMissingInner = runMissingCwd.status === 200 ? innerOf(runMissingCwd) : { error: 'bad' }
  checks['目录不存在: realpath 回退 resolve 且不阻断'] = Boolean(runMissingInner.sessionId) && created[1]?.cwd === missingDir

  // ── 增量3: 启动存量捞回(sessions.list + sessionPersistence.list 两源) ──
  await new Promise((r) => setTimeout(r, 500))
  checks['存量捞回: live 列表会话补挂'] = attachedIds.includes('sess-live2')
  checks['存量捞回: 持久化会话补挂'] = attachedIds.includes('sess-persisted')

  // ── 审批抑制(MCP-only): 本插件自有会话 deterministic 裁决, 非本插件拥有的会话交回 UI ──
  // 本插件池里 create 出来的会话(在 liveAgents/sessionToCwd 两张表里) + 缺省允许名单(空) → deterministic rejected
  const ownedSessionId = String(created[0].id)
  const dDefault = await dispatchApproval(0, { agent: { id: ownedSessionId }, toolName: 'bash' }, makeUiChain())
  checks['审批: 本插件自有会话 + 空允许名单 → deterministic rejected(不询问 UI)'] = dDefault.outcome === 'rejected' && dDefault.consultedUi === false

  // 非本插件拥有的会话(经 ctx.agents.get 从 UI 接管, 不在两张表里) → 原样 next(), UI 的 ask 行为不变
  const uiChain = makeUiChain('allowed-once')
  const dPassthrough = await dispatchApproval(0, { agent: { id: 'sess-live' }, toolName: 'bash' }, uiChain)
  checks['审批: 非本插件拥有的会话 → 走 next() 交回 UI(透传其裁决)'] = dPassthrough.outcome === 'allowed-once' && dPassthrough.consultedUi === true

  // 允许名单(第二实例, 独立端口): 命中(工作区根 + toolName) → allowed-once; 不命中 → 仍 deterministic rejected
  await apply(ctx, { port: PORT2, host: '127.0.0.1', approvalAllowlist: [{ root: FAKE_CWD, toolName: 'bash' }] })
  await new Promise((r) => setTimeout(r, 200))
  const dAllow = await dispatchApproval(1, { agent: { id: ownedSessionId }, toolName: 'bash' }, makeUiChain())
  checks['审批: 命中允许名单(工作区根 + toolName) → allowed-once'] = dAllow.outcome === 'allowed-once' && dAllow.consultedUi === false
  const dDeny = await dispatchApproval(1, { agent: { id: ownedSessionId }, toolName: 'web_fetch' }, makeUiChain())
  checks['审批: 允许名单不匹配(toolName) → 仍 deterministic rejected'] = dDeny.outcome === 'rejected' && dDeny.consultedUi === false

  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  for (const [name, ok] of Object.entries(checks)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log('attach_session 路径记录:', JSON.stringify(attachedIds))
  console.log(failed.length === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failed.length} 项)`)
  disposer()
  await new Promise((r) => setTimeout(r, 100))
  process.exit(failed.length === 0 ? 0 : 1)
} catch (e) {
  console.error('SMOKE ERROR:', e)
  process.exit(1)
}
