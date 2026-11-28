// 连接故障 / 风控拦截诊断纯函数的离线测试（0.9.8 瘦身版：PC only）
// 跑法：MARVIS_TRANSPORT=direct node --test tests/failure-hints.test.mjs

import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import {
  connectionFailureHint,
  probeLocalRelay,
  shouldAutoWsFallback,
  enhanceRiskMessage,
} from "../src/marvis/failure-hints.mjs"

// ── openclaw / 10123 连接失败 ─────────────────────────────────────────

test("openclaw/10123 失败：诊断指向 PC 客户端 + WS_MODE=off 出路", () => {
  const h = connectionFailureHint({
    errText: "openclaw WebSocket 错误：WebSocket connection to 'ws://127.0.0.1:10123/' failed",
  })
  assert.equal(h.header, "openclaw-10123-unreachable")
  assert.match(h.hint, /10123/)
  assert.match(h.hint, /PC 客户端/)
  assert.match(h.hint, /MARVIS_WS_MODE=off/)
  assert.equal(h.command, "node scripts/doctor.mjs")
})

test("普通 ECONNREFUSED：通用上游诊断", () => {
  const h = connectionFailureHint({ errText: "connect ECONNREFUSED 127.0.0.1:8088" })
  assert.equal(h.header, "upstream-unreachable")
  assert.match(h.hint, /doctor/)
})

// ── relay 探针 ─────────────────────────────────────────────────────────

test("probeLocalRelay：真实 TCP server 可达时 true，关闭后 false", async () => {
  const srv = createServer((sock) => sock.end())
  await new Promise((resolve, reject) => {
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", resolve)
  })
  const port = srv.address().port
  const saved = process.env.MARVIS_LOCAL_WS
  try {
    process.env.MARVIS_LOCAL_WS = `ws://127.0.0.1:${port}/`
    assert.equal(await probeLocalRelay({ timeoutMs: 500 }), true)
  } finally {
    await new Promise((r) => srv.close(r))
    if (saved === undefined) delete process.env.MARVIS_LOCAL_WS
    else process.env.MARVIS_LOCAL_WS = saved
  }
  // server 已关，再探一次应失败
  const s2 = createServer()
  const port2 = await new Promise((resolve) => s2.listen(0, "127.0.0.1", () => resolve(s2.address().port)))
  await new Promise((r) => s2.close(r))
  const saved2 = process.env.MARVIS_LOCAL_WS
  try {
    process.env.MARVIS_LOCAL_WS = `ws://127.0.0.1:${port2}/`
    assert.equal(await probeLocalRelay({ timeoutMs: 300 }), false)
  } finally {
    if (saved2 === undefined) delete process.env.MARVIS_LOCAL_WS
    else process.env.MARVIS_LOCAL_WS = saved2
  }
})

test("probeLocalRelay：无人监听的端口 1s 内返回 false，不抛错", async () => {
  const saved = process.env.MARVIS_LOCAL_WS
  try {
    process.env.MARVIS_LOCAL_WS = "ws://127.0.0.1:1/"
    const t0 = Date.now()
    assert.equal(await probeLocalRelay({ timeoutMs: 300 }), false)
    assert.ok(Date.now() - t0 < 3000, "探针必须快速失败")
  } finally {
    if (saved === undefined) delete process.env.MARVIS_LOCAL_WS
    else process.env.MARVIS_LOCAL_WS = saved
  }
})

// ── 自动 WS 回退决策 ───────────────────────────────────────────────────

test("shouldAutoWsFallback：非off+未禁用+429 时 true（探针由调用方做）", () => {
  const base = { mode: "auto", autoDisabled: false, riskStatus: 429 }
  assert.equal(shouldAutoWsFallback(base), true)
  assert.equal(shouldAutoWsFallback({ ...base, mode: "relay" }), true)
  assert.equal(shouldAutoWsFallback({ ...base, autoDisabled: true }), false, "用户关掉就不重试")
  assert.equal(shouldAutoWsFallback({ ...base, riskStatus: 503 }), false, "改了状态码保持旧行为")
  assert.equal(shouldAutoWsFallback({ ...base, mode: "off" }), false, "显式 off 不自动回退")
})

// ── 429 文案升级 ───────────────────────────────────────────────────────

test("enhanceRiskMessage：PC 探针可达给出 relay 出路", () => {
  const s = enhanceRiskMessage("原始", { probeReachable: true, autoTried: false, autoError: "" })
  assert.match(s, /10123/)
  assert.match(s, /MARVIS_WS_MODE=relay/)
  assert.match(s, /doctor/)
})

test("enhanceRiskMessage：自动重试失败给出具体原因", () => {
  const s = enhanceRiskMessage("原始", {
    probeReachable: true, autoTried: true, autoError: "connection refused",
  })
  assert.match(s, /connection refused/)
  assert.match(s, /自动尝试/)
  assert.match(s, /PC 客户端/)
})

test("enhanceRiskMessage：PC 探针不可达提示启动客户端", () => {
  const s = enhanceRiskMessage("原始", { probeReachable: false, autoTried: false, autoError: "" })
  assert.match(s, /不可达/)
  assert.match(s, /PC 客户端/)
  assert.match(s, /doctor/)
})