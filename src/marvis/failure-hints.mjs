// failure-hints.mjs —— 连接故障 / 风控拦截的可行动诊断与自愈决策（0.9.8 瘦身版）
//
// 这两类故障以前只甩一句「连不上 / 被风控了」，用户不知道下一步做什么：
//   · PC 429/4100404：HTTP 模型网关的 uskey 节奏风控，换账号/IP/UA 都没用，
//     唯一可行路线是绕开 HTTP 走 openclaw WS（relay 10123）。
//
// 0.9.8 瘦身：手机端分支（Termux diag.sh / remote 手机会话域 / handshake 凭据）
// 已整体删除 —— 本插件只支持 PC 桌面。
//
// 本模块只放纯函数 + 一个 TCP 探针：不读凭据、不发请求、不改全局状态，
// 方便离线单测；真正的动作（重试、设环境变量）由 loader.mjs 决定。

import { createConnection } from "node:net"

const DEFAULT_RELAY_HOST = "127.0.0.1"
const DEFAULT_RELAY_PORT = 10123

/**
 * 连接失败（callUpstream 抛错）时的可行动诊断。
 *
 * @param {{errText: string}} arg
 * @returns {{header: string, hint: string, command: string}}
 */
export function connectionFailureHint({ errText }) {
  const text = String(errText ?? "")
  if (/openclaw|websocket|10123|ws:\/\//i.test(text)) {
    return {
      header: "openclaw-10123-unreachable",
      hint:
        "10123 是 Marvis PC 客户端的 AG-UI relay 端口：确认 PC 客户端已启动并登录（10123 在监听）。" +
        "若不想走 WS 通道，设 MARVIS_WS_MODE=off 或 MARVIS_TRANSPORT=direct 走 HTTP 直连。" +
        "自检：node scripts/doctor.mjs。",
      command: "node scripts/doctor.mjs",
    }
  }
  return {
    header: "upstream-unreachable",
    hint:
      "连不上上游：检查网络与代理（HTTP(S)_PROXY），或用 node scripts/doctor.mjs 自检通道配置。",
    command: "node scripts/doctor.mjs",
  }
}

/**
 * 解析本机 relay 地址：环境变量/配置只影响端口， host 默认 127.0.0.1。
 * 探针是纯网络层面的 TCP connect，不碰任何凭据。
 */
function relayEndpoint() {
  const raw = String(process.env.MARVIS_LOCAL_WS || "").trim()
  if (!raw) return { host: DEFAULT_RELAY_HOST, port: DEFAULT_RELAY_PORT }
  try {
    const u = new URL(raw)
    return {
      host: u.hostname || DEFAULT_RELAY_HOST,
      port: Number.parseInt(u.port || (u.protocol === "wss:" ? "443" : "80"), 10) || DEFAULT_RELAY_PORT,
    }
  } catch {
    return { host: DEFAULT_RELAY_HOST, port: DEFAULT_RELAY_PORT }
  }
}

/**
 * 本机 Marvis PC 客户端 relay 网关（默认 10123）是否可达。
 * 1s 超时，失败/拒绝一律 false —— 探针本身绝不能抛错把请求搞挂。
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export function probeLocalRelay({ timeoutMs = 1000 } = {}) {
  const { host, port } = relayEndpoint()
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* 已关 */ }
      resolve(v)
    }
    const socket = createConnection({ host, port }, () => done(true))
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once("error", () => done(false))
    socket.once("close", () => done(false))
  })
}

/**
 * 4100404 风控命中后要不要**尝试** WS 回退路径（探针由调用方做，见 probeLocalRelay）。
 *
 * 前提缺一不可：
 *   · 用户没用 MARVIS_RISK_AUTO_WS=0 关掉
 *   · 当前不是 off（用户显式关掉 WS 通道）
 *   · 风险状态没被 MARVIS_RISK_STATUS 改掉（改成 503 时保持旧行为）
 *
 * 注意：本函数**不检查探针** —— 调用方先判这里，通过后再花 1s 做 TCP 探测。
 *
 * @param {{mode:string, autoDisabled:boolean, riskStatus:number}} arg
 * @returns {boolean}
 */
export function shouldAutoWsFallback({ mode, autoDisabled, riskStatus }) {
  if (autoDisabled) return false
  const m = String(mode || "").toLowerCase()
  // 用户显式关掉 WS 通道（off）时绝不自动回退去连真实 10123：
  // 否则 HTTP 直连的每次风控/异常都会在 PC 客户端建一条新会话（刷屏根因之一）。
  if (m === "off") return false
  if (riskStatus !== 429) return false
  return true
}

/**
 * 把 4100404 的原始 429 文案升级成「有下一步」的版本。
 * 覆盖三种现场：PC 探针可达 / 自动重试成功或失败 / 探针不可达。
 *
 * @param {string} original
 * @param {{probeReachable:boolean, autoTried:boolean, autoError:string}} arg
 * @returns {string}
 */
export function enhanceRiskMessage(original, { probeReachable, autoTried, autoError }) {
  const base = String(original ?? "")
  if (autoTried) {
    if (!autoError) {
      // 成功路径不走这里（loader 直接返回响应），留着只是防御性兜底
      return base + " 已自动切到 Marvis PC 客户端 WS 通道重试。"
    }
    return (
      base +
      ` 已自动尝试切到本机 Marvis PC 客户端 WS 通道（MARVIS_WS_MODE=relay）重试，但失败：${autoError}。` +
      " 请确认 PC 客户端已登录并保持打开。" +
      " 自检：node scripts/doctor.mjs。"
    )
  }
  if (probeReachable) {
    return (
      base +
      " 检测到本机 127.0.0.1:10123（Marvis PC 客户端）可达：设 MARVIS_WS_MODE=relay 即可绕开 HTTP 风控；" +
      "或保持现状等冷却结束。自检：node scripts/doctor.mjs。"
    )
  }
  return (
    base +
    " 本机 127.0.0.1:10123 不可达（Marvis PC 客户端没开）：启动并登录 PC 客户端后可设 " +
    "MARVIS_WS_MODE=relay 绕开 HTTP 风控。" +
    " 自检：node scripts/doctor.mjs（会显示当前 WS 模式与凭据状态）。"
  )
}