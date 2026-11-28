// ④ auth.loader —— 接管所有出站请求
//
// 这里只做四件事：
//   1. 每次请求按本次请求上下文（conv / resp / scene / model / nonce / openid）**现签一个 uskey**
//   2. 换成这个账号的 Ual-Access-* 头（模型网关不认 Bearer，只认这套）
//   3. 把「模型不可用」翻成 404、「登录失效」翻成 401 + X-Magpie-Sign-In: expired
//   4. **把 Response 原样交回去** —— 绝不在 fetch 里读流（读了就是「只有第一段就结束」）
//
// ⚠ 实测：把 UAL 签名头（md5 body+ts+accessKey+nonce）加到模型网关上是**错的** ——
//   会从 403 风控变成 401 登录态过期。那套只用于 /v3/*。

import { randomUUID, createHash } from "node:crypto"
import { BASE_V1, DEFAULT_MODEL, DISPLAY_BY_SLOT, PROVIDER, canonicalModelId, isUnavailableModel, FIRST_LINE_OPTION_KEY, OFFICIAL_FIRST_LINE } from "../context.mjs"
import { llmHeaders } from "../marvis/protocol.mjs"
import { directFetch, directPost, directTransport } from "../marvis/directnet.mjs"
import { getBreaker, accountKeyOf, accountLabelOf, riskScope } from "../breaker.mjs"
import { pacingWait } from "../pacing.mjs"
import {
  openclawEnabled,
  openclawStatus,
  openclawChat,
  openclawChatStream,
  openclawResponse,
  openclawStreamResponse,
} from "../marvis/openclaw.mjs"
import { localGatewayEnabled, gatewayFetch, gatewayConfig } from "../marvis/localgateway.mjs"
import { normalizeTools } from "../marvis/tool-schema.mjs"
import { InvalidImageError, normalizeMessages } from "../marvis/images.mjs"
import {
  connectionFailureHint,
  probeLocalRelay,
  shouldAutoWsFallback,
  enhanceRiskMessage,
} from "../marvis/failure-hints.mjs"
// 0.9.8 瘦身：mobile-login.mjs（isMobile 等手机端登录）已删除

/**
 * 首行自愈成功记忆：(账号桶, 原首行 hash) → 上次成功放行的改写句。
 * 用户的 system 首行和账号基本固定，命中后直接用记忆句发第一发，省掉整条重试链。
 * 每次失败会删掉对应条目（上游黑名单会变，记忆不能是永久的）；TTL 默认 24h。
 */
const FIRST_LINE_MEMORY_TTL_MS = 24 * 60 * 60 * 1000
const firstLineMemory = new Map() // key = `${acctBucket}:${hash}` → { text, at }

function firstLineMemoryKey(bucket, originalLine) {
  const hash = createHash("sha256").update(String(originalLine || "")).digest("hex").slice(0, 16)
  return `${bucket}:${hash}`
}

function rememberedFirstLine(bucket, originalLine, mode) {
  if (mode === "off") return ""
  const key = firstLineMemoryKey(bucket, originalLine)
  const entry = firstLineMemory.get(key)
  if (!entry) return ""
  if (Date.now() - entry.at > FIRST_LINE_MEMORY_TTL_MS) {
    firstLineMemory.delete(key)
    return ""
  }
  return entry.text
}

function rememberFirstLine(bucket, originalLine, text, mode) {
  if (!text || mode === "off") return
  firstLineMemory.set(firstLineMemoryKey(bucket, originalLine), { text, at: Date.now() })
}

function forgetFirstLine(bucket, originalLine) {
  firstLineMemory.delete(firstLineMemoryKey(bucket, originalLine))
}

/**
 * 上游说「模型不行」的信号 —— 只收**模型级**的，映射成 404（搁置这个模型，不打死账号）。
 *
 * ⚠ `4130001` = `无效模型id`（请求体里的 model 不是注册表里的槽位）。
 * ⚠ `5104002` 是 **RPC 500**，这个业务码本身不等于模型失效 —— 不能加进来：
 *   把 5104002 全局映射成 404 会把正常模型的上游抖动误判成「模型不可用」，
 *   能用的模型和账号都会被标成失效。
 */
const MODEL_ISSUE =
  /model.*not (found|exist|allowed|available)|no such model|不支持.*模型|模型.*(不存在|未开通|不可用)|无效模型\s*id|4130001|4100402/i

/** 风控（uskey 配额用完 / 缺 MarvisExt）—— 可重试，但要换新 uskey */
const RISK_BLOCK = /4100404|风控拦截/

/**
 * 4100404 的**耗时判据**：区分「设备被硬拉黑」与「节奏/预算限流」（0.9.5）。
 *
 * 出处与实测（2026-11-28，本机）：
 *   403 + 4100404 且响应 **< 800ms**  ⇒ 设备被**硬拉黑**（服务端在业务逻辑之前就按
 *                                      设备号拒掉）——换账号 / 换 IP / 切 WS / 等冷却
 *                                      全都无效，重试只是白撞。
 *   403 + 4100404 且响应 **≥ 800ms**  ⇒ 触发频率或预算限制，冷却后可恢复。
 *
 * 实测硬拉黑签名：连续 5 发分别为 307 / 100 / 76 / 73 / 75 ms（硬拉黑特征「75–130ms
 * 内秒拒」，完全吻合）；同期 relay、HTTP 直连、官方 PC 客户端三条通道共享同一设备号、
 * 在同一秒被拦。
 *
 * 每次调用现读 env（测试需要按用例切换分支）；0 = 关闭判定。
 */
function hardBlockThreshold() {
  const raw = String(process.env.MARVIS_HARD_BLOCK_MS ?? "").trim()
  if (raw === "0") return 0
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 800
}

/** 登录态过期 */
const AUTH_EXPIRED = /4100403|登录态过期|未登录/

/**
 * Marvis 的内容过滤拦的是「**system 首行 + 词对 + 单个空格**」（issue #22 / #26）。
 *
 * 2026-11-15 首次定位 + 2026-11-16 复测（直打上游，只换 system prompt 第一句）：
 *
 *   `You are an AI agent powered by DeepSeek Harness.`      → 403 非法请求
 *   中文写法（由 DeepSeek Harness 驱动…）                    → 403 非法请求
 *   全小写同一句                                             → 403（大小写不敏感）
 *   句末加 ! 或 ,                                            → 403（句末符号无效）
 *   同一句放第 2 行 / 行内带前缀 / user 或 assistant 角色     → 200
 *   `DeepSeek-Harness` / `DeepSeek — Harness`               → 200（词间插字符放行）
 *
 * ⇒ 判据是「首行里的词对」，不是「整句模板」。只认英文整句会漏掉中文与本地化写法 ——
 *   它们照样 403，而且因为不命中模板，连 content_filtered 诊断都不会触发，
 *   用户看到的仍是宿主那句「API 密钥无效」。
 */
/**
 * 上游内容过滤拦截时的**统一**提示（本插件自己的 403 文案，不发给上游）。
 *
 * ⚠ 措辞必须同时成立三件事：
 *   ① 性质是内容过滤，不是密钥或登录（否则用户去重登，白折腾）；
 *   ② 说明**怎么自己解决** —— 首行是用户自己的事，插件只负责把它写进去；
 *   ③ 给出「还是被拦」时的上报动作（把首行带到群里）。
 * ⚠ 不要把「改哪一句」写死成唯一修法：不同客户端首句不同（issue #38 的 ZCode 提示词不可配置，
 *   用户侧根本没有可改的地方），写死一家会在别家命中时把人带偏。
 */
const CONTENT_FILTER_HINT =
  "上游内容过滤拦截：系统提示词首句被当成了身份指纹（不是密钥或登录问题）。" +
  "插件不再替你猜「哪句能过」—— 上游的黑名单一直在长，今天能过的改写明天就被加进去。" +
  "首行请自己写一句：设置 → 插件 → 本插件「选项」把「提示词首行替换」换成你的话" +
  "（别写任何 agent 产品名），再打开卡片上的「每个请求都改写首行」；只想被拦后兜底就保持默认。" +
  "还是被拦就把 system 首行原样带到 QQ 群 451129479。"

// ── 首行兜底（插件选项 firstLine）────────────────────────────────────
//
// 为什么要有它：上游拦的是「system 首行里的身份词对」，而**哪句能过一直在变** ——
// 我们把一句句首行加进白名单，换来的是它们很快也被拦。所以不再替用户猜：
// 首行由用户自己写（选项「提示词首行替换」），插件只负责把它写进去。
// 兜底句不含任何 agent 产品名（0.4.0 起默认用官方中文身份句；英文句 11-17 起被拉黑），
// 它能过；代价是模型不知道自己是哪个客户端，所以**默认只在被拦之后才用**（mode=blocked）。
//
// 两个开关由 **magpie 渲染在供应商卡片里**（`auth.options`，见 context.mjs 的 PLUGIN_OPTIONS），
// 用户在编辑器里点 Off/On 即生效，插件用 `input.magpie.option("marvis", key)` 读，
// **不用重启**（magpie 每次调用都现读）：
//
//   first_line_fallback（默认开）被拦时换兜底句重试一次 → blocked
//   first_line_always  （默认关）每个请求都换首行        → always
//   两个都关                                            → off（一个字节都不改）
//
// 首行文本来自插件选项的 JSON，**就一个键**（`magpie.options` = `{"text": "…"}`）：
// 设置 → 插件 → 本插件那一行的「选项」框里直接改那句话。只留一个键是有意的 ——
// 那个框是 magpie 的通用 JSON 编辑器（值必须是对象，写字符串会被拒），键越少越好改。
// 老版本存下的 `{ "firstLine": { "text": "…", "mode": "…" } }` 仍然读。
// 留空 = 内置兜底句。整行替换：只换 system 消息的第一行，第二行起原样。

/**
 * 内置兜底首行。
 *
 * ⚠ 0.4.0 变更（issue #71 实测，2026-11-23）：英文兜底句
 *   `You are Marvis, Tencent's AI assistant.` 已被上游拉黑（11-17 起全灭），
 *   官方客户端自己的**中文身份句**仍是唯一稳定白名单：
 *
 *     你是功能强大的 AI 助手，名字叫 Marvis（马维斯）。
 *
 *   默认换用它；用户可用环境变量 MARVIS_FALLBACK_FIRST_LINE 覆盖，
 *   或在「提示词首行替换」选项里写自己的句子（非空选项永远优先）。
 */
const FALLBACK_FIRST_LINE =
  String(process.env.MARVIS_FALLBACK_FIRST_LINE ?? "").trim() || OFFICIAL_FIRST_LINE


/**
 * 读一次「首行改写」配置。
 *
 * 开关从 magpie 现读（`input.magpie.option(provider, key)`，用户点一下就到，不用重启）；
 * 文本从插件选项的 JSON 读（`magpie.options.firstLine.text`）。任何形状不对的值都退回默认
 * （fallback 开 + 内置兜底句），绝不因为配置写错而让请求失败。
 *
 * @param {unknown} input   magpie 给插件的 input（`input.magpie.option` 在里面）
 * @param {unknown} options 插件选项（设置页那个 JSON）
 * @returns {{ mode: "off" | "blocked" | "always", text: string }}
 */
function firstLineOption(input, options) {
  let opts = options
  if (typeof opts === "string") {
    try {
      opts = JSON.parse(opts)
    } catch {
      opts = {}
    }
  }
  // 新形状：{"提示词首行替换": "…"}（键名就是给人看的字段名）；
  // 0.2.50 用的是 {"text": "…"}，0.2.49 及以前是 {"firstLine": {"text": "…"}} —— 都还读
  const raw =
    typeof opts?.[FIRST_LINE_OPTION_KEY] === "string"
      ? { text: opts[FIRST_LINE_OPTION_KEY] }
      : typeof opts?.text === "string"
        ? opts
        : opts?.firstLine
  const text =
    typeof raw?.text === "string" && raw.text.trim()
      ? raw.text.trim().replace(/\s*\n\s*/g, " ")
      : FALLBACK_FIRST_LINE
  // 开关：用户的值 → 插件默认。读不到（老 magpie / 抛错）就当默认
  const switched = (key, fallback) => {
    try {
      const v = input?.magpie?.option?.(PROVIDER, key)
      return typeof v === "boolean" ? v : fallback
    } catch {
      return fallback
    }
  }
  const always = switched("first_line_always", false)
  const blocked = switched("first_line_fallback", true)
  const mode = always ? "always" : blocked ? "blocked" : "off"
  return { mode, text }
}

/**
 * 把 system 消息的**第一行**整行换掉（第二行起原样）。
 *
 * 只动第一条 system 消息 —— 再往后的 system 不是身份句的常见位置，改了反而多余。
 * 没有 system 消息时原样返回（调用方据此判断有没有改动）。
 *
 * @param {unknown} messages
 * @param {string} text
 * @returns {unknown}
 */
function withFirstLine(messages, text) {
  if (!Array.isArray(messages)) return messages
  let touched = false
  const out = messages.map((message) => {
    if (touched) return message
    if (!message || typeof message !== "object") return message
    if (message.role !== "system" || typeof message.content !== "string") return message
    touched = true
    const line = firstLineOf(message.content)
    return { ...message, content: text + message.content.slice(line.length) }
  })
  return touched ? out : messages
}

/**
 * 把 system 提示词的**第一行**换成 `text` —— 三种协议一次覆盖。
 *
 *   chat（/v1/chat/completions）        `messages[]` 里第一条 `role: "system"`
 *   responses（/v1/responses）          顶层 `instructions`（字符串）
 *   anthropic（/v1/messages）           顶层 `system`：字符串，或 `[{type:"text", text}]` 数据块
 *
 * 为什么三处都要看：magpie 会把客户的协议折成 provider 的 chat 上游，但**折法不止一种**
 * （issue #62：Claude Desktop 走 /v1/messages 时 always 选项等于空操作）。
 * 抓到哪处换哪处，其余字段一个字节不动；都没命中就把原对象原样返回（调用方靠引用判「有没有改」）。
 *
 * 来历：#62 由 @zhey80 定位（同一模型只改首行长度，比对 usage.jsonl 的 up_bytes 差值 = 多加的字符数，
 * 证明首行没被替换）。
 *
 * @param {object} json  请求体
 * @param {string} text  要写进去的第一行（整行替换，行内其余内容与后续行不动）
 * @returns {object} 改过的**新对象**，或原对象（没得改）
 */
function withFirstLineInBody(json, text) {
  if (!json || typeof json !== "object") return json
  let out = json
  let changed = false

  const messages = withFirstLine(out.messages, text)
  if (messages !== out.messages) {
    out = { ...out, messages }
    changed = true
  }

  if (typeof out.instructions === "string" && out.instructions.trim()) {
    const line = firstLineOf(out.instructions)
    const next = text + out.instructions.slice(line.length)
    if (next !== out.instructions) {
      out = { ...out, instructions: next }
      changed = true
    }
  }

  if (typeof out.system === "string" && out.system.trim()) {
    const line = firstLineOf(out.system)
    const next = text + out.system.slice(line.length)
    if (next !== out.system) {
      out = { ...out, system: next }
      changed = true
    }
  } else if (Array.isArray(out.system)) {
    let done = false
    const blocks = out.system.map((block) => {
      if (done || !block || typeof block !== "object") return block
      if (block.type !== "text" || typeof block.text !== "string") return block
      done = true
      const line = firstLineOf(block.text)
      return { ...block, text: text + block.text.slice(line.length) }
    })
    if (done) {
      out = { ...out, system: blocks }
      changed = true
    }
  }

  return changed ? out : json
}

/**
 * U+2060（word joiner）护栏 —— 内容过滤的二道防线（可选，MARVIS_GUARD_WORD_JOINER=1 开启）。
 *
 * 原理（Marvis-proxy-public cap/guard.py 的 L1 层）：上游内容过滤按「首行身份词对」的
 * 正则/词表匹配，而对端是 LLM —— 在可疑词对的**第二个词的首字符前**插一个不可见的
 * U+2060 word joiner，模型读到时把它当零宽字符忽略，正则 `powered by` / `deepseek`
 * / `ai agent` 却不再连续命中。只动 system 首行，其余内容一个字节不碰。
 *
 * ⚠ 这是军备竞赛的缓兵之计：只在「兜底句重试也被拦」之后作为**最后一次重试**使用，
 *   不默认开启（上游若开始按语义匹配，这条防线也会失效）。
 *
 * @param {object} json 请求体
 * @param {string[]} [words] 可疑词表（小写匹配），默认内置
 * @returns {object} 改过的新对象，或原对象（没得改）
 */
const GUARD_WORDS = ["powered by", "deepseek", "ai agent", "claude code", "anthropic", "openai"]
const WORD_JOINER = "\u2060"

function withWordJoiner(json, words = GUARD_WORDS) {
  if (!json || typeof json !== "object") return json
  if (String(process.env.MARVIS_GUARD_WORD_JOINER ?? "").trim() !== "1") return json
  const join = (text) => {
    const line = firstLineOf(text)
    let next = line
    for (const word of words) {
      let at = next.toLowerCase().indexOf(word)
      while (at > 0) {
        next = next.slice(0, at + 1) + WORD_JOINER + next.slice(at + 1)
        at = next.toLowerCase().indexOf(word, at + word.length + 2)
      }
    }
    return next === line ? text : next + text.slice(line.length)
  }
  const messages = Array.isArray(json.messages)
    ? json.messages.map((message) =>
        message?.role === "system" && typeof message.content === "string"
          ? { ...message, content: join(message.content) }
          : message,
      )
    : json.messages
  if (typeof json.system === "string" && json.system.trim()) {
    return { ...json, messages, system: join(json.system) }
  }
  if (typeof json.instructions === "string" && json.instructions.trim()) {
    return { ...json, messages, instructions: join(json.instructions) }
  }
  return { ...json, messages }
}

/**
 * 请求体里**当前**那行 system 首行（三处协议都看）。
 *
 * 403 兜底重试要先问一句「是不是已经是用户那句了」—— 已经是就别再白打一次。
 *
 * @param {object} json
 * @returns {string}
 */
function firstLineInBody(json) {
  if (!json || typeof json !== "object") return ""
  const messages = Array.isArray(json.messages) ? json.messages : []
  for (const message of messages) {
    if (!message || message.role !== "system") continue
    const text = typeof message.content === "string" ? message.content : ""
    if (text.trim()) return firstLineOf(text).trim()
  }
  if (typeof json.instructions === "string" && json.instructions.trim()) {
    return firstLineOf(json.instructions).trim()
  }
  if (typeof json.system === "string" && json.system.trim()) return firstLineOf(json.system).trim()
  if (Array.isArray(json.system)) {
    for (const block of json.system) {
      if (!block || typeof block !== "object" || block.type !== "text") continue
      if (typeof block.text === "string" && block.text.trim()) return firstLineOf(block.text).trim()
    }
  }
  return ""
}


/**
 * 构造一个错误 Response。
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
/** 请求头构造失败（uskey 现签）—— 与「连不上上游」不是一类故障，别混成同一个 503 */
class HeaderUnavailable extends Error {}

function errorResponse(status, code, message, headers = {}) {
  return new Response(JSON.stringify({ error: { type: "upstream_error", code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/**
 * 风控熔断响应 —— **本地**拒绝，请求不出网（AGENTS 坑 6 的镜像：
 * 4100404 交给宿主连试 7 次会拉长账号的节奏风控冷却，issue #71 实测）。
 * @param {"risk_cooldown" | "risk_blocked"} code
 * @param {string} message
 * @param {number} retryAfterSec
 */
function riskResponse(code, message, retryAfterSec) {
  return errorResponse(429, code, message, {
    "retry-after": String(Math.max(1, Math.ceil(retryAfterSec))),
    "x-magpie-retry-after": String(Math.max(1, Math.ceil(retryAfterSec))),
  })
}

/**
 * 把会被上游内容过滤拦下的身份句改写成能放行的形态。
 *
 * ⚠ 只改 system 消息**第一行**里的身份短语 —— 那是上游唯一会拦的位置；
 *   user / assistant 里的同一句上游本来就放行，改了反而是多余改动。
 * ⚠ 门禁不变：只把词间那一个空格换成连字符，其余字符一个都不碰；
 *   已经写成连字符 / 破折号的形态没有空格可换，仍然原样发出（0.2.30 的用例继续守着）。
 * ⚠ 返回**新数组**才表示改过 —— 调用方据此决定要不要重新序列化 body（并去掉 content-length）。
 *
 * @param {unknown} messages
 * @returns {unknown}
 */
function firstLineOf(text) {
  const cut = text.indexOf("\n")
  return cut < 0 ? text : text.slice(0, cut)
}

/**
 * 这次请求里的 system 首行 —— 403 兜底重试拿它跟用户自己那句比：一样就不再白试一次。
 *
 * @param {unknown} bodyString
 * @returns {string}
 */
function systemFirstLineOf(bodyString) {
  if (typeof bodyString !== "string") return ""
  let json = null
  try {
    json = JSON.parse(bodyString)
  } catch {
    return ""
  }
  return firstLineInBody(json)
}

/**
 * 0.9.7：reasoning_effort 思考档的 max_tokens 预算下限补偿（文档第九节）。
 *
 * 实测：reasoning_effort=max 时模型先思考 3-4 万 token，
 *   max_tokens=16000 → 上游 502 空正文（"cut at its length, the whole output
 *   spent on reasoning"）；≥64000 → 200 正常返回。
 *
 * 规则：
 *   · effort 为 max（或 high 且预算 < 64000）→ 把 max_tokens /
 *     max_completion_tokens 抬到 64000；
 *   · 用户显式给了 ≥64000 就不动；
 *   · MARVIS_MAX_TOKENS_FLOOR=0 可整体关闭。
 *
 * @param {Record<string, any>} json 请求体对象（就地修改）
 * @returns {boolean} 是否发生改写
 */
export function applyReasoningBudgetFloor(json) {
  if (!json || typeof json !== "object") return false
  if (String(process.env.MARVIS_MAX_TOKENS_FLOOR ?? "").trim() === "0") return false
  const effort = String(json.reasoning_effort ?? json.reasoning ?? "").toLowerCase()
  if (effort !== "max" && effort !== "high") return false
  let changed = false
  // 只抬用户**实际给出**的预算字段：两个都没给且 effort=max 时补一个
  // max_tokens=64000（没预算照样 502）；high 档没给预算就不动（交给上游默认）。
  const keys = ["max_tokens", "max_completion_tokens"].filter((k) => json[k] !== undefined)
  if (!keys.length && effort === "max") {
    json.max_tokens = 64_000
    return true
  }
  for (const key of keys) {
    const cur = Number(json[key] ?? NaN)
    if (!Number.isFinite(cur) || cur < 64_000) {
      json[key] = 64_000
      changed = true
    }
  }
  return changed
}

/**
 * 0.9.12：识别 DSH 的「会话标题生成」后台请求并本地返回标题，彻底不发上游。
 *
 * DSH 会把标题生成走当前会话模型（group/qq → marvis）。当当前模型是注入了
 * [MODE: UNRESTRICTED SANDBOX] 的 unrestricted preset 时，标题 LLM 会把注入框架
 * 当成用户输入，复读+反思后把整段英文吐到对话区（用户看到的「另一个对话框的乱码」）。
 * 标题这种短任务根本不该走被封锁/被注入的模型——这里在本地生成一个简短标题直接返回。
 *
 * 识别依据：system 里含 DSH 标题生成的固定签名（稳定文案，见 app.asar 的
 * session-title-first-prompt-llm）。只拦截标题请求，普通对话完全不受影响。
 */
export function titleRequestLocalResponse(payload) {
  let body = null
  try {
    body = typeof payload === "string" ? JSON.parse(payload) : payload
  } catch {
    return null
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return null
  const sys = body.messages
    .filter((m) => m && m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content)
      ? m.content.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("") : ""))
    .join("\n")
  if (!/Create a concise title for an AI coding-assistant session/i.test(sys)) return null
  // 从 user 消息里取最后一段人类文本做标题（DSH 传的是 "Generate the session title from this JSON array..."）
  let title = "新对话"
  const userText = body.messages
    .filter((m) => m && m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content)
      ? m.content.map((x) => (typeof x === "string" ? x : x?.text ?? "")).join("") : ""))
    .join("\n")
  const m = userText.match(/\{\s*"seq"\s*:\s*\d+\s*,\s*"text"\s*:\s*"([^"]*)"/)
  const raw = (m ? m[1] : userText).trim().replace(/[\r\n]+/g, " ")
  if (raw) title = raw.length > 20 ? raw.slice(0, 20) + "…" : raw
  const id = `chatcmpl-title-${Date.now().toString(36)}`
  const message = { role: "assistant", content: title }
  if (body.stream) {
    const enc = new TextEncoder()
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model || "local-title",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`
    const bodyStream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(enc.encode(chunk({ role: "assistant", content: "" })))
        ctrl.enqueue(enc.encode(chunk({ content: title })))
        ctrl.enqueue(enc.encode(chunk({}, "stop")))
        ctrl.enqueue(enc.encode("data: [DONE]\n\n"))
        ctrl.close()
      },
    })
    return new Response(bodyStream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } })
  }
  return Response.json({
    id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model || "local-title",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

/**
 * WS relay 通道的 reasoning_effort 归一化（0.9.9）。
 *
 * 上游 deepseek-v4-flash 在请求不带 reasoning_effort、或档位为 none/off 时，
 * 会把整段思考写进 delta.content —— 客户端把它当正文渲染，用户看到一大段
 * 「让我先一步一步来…」的乱码。8088 网关的 api/openai.py::_normalize_effort
 * 已把 off/none/空抬到 floor（默认 low），但 WS relay 通道（openclaw.json
 * mode=relay → ws://127.0.0.1:10123）此前直接透传请求体，没有这道归一化。
 * 这里对齐同一行为：缺档位或 off/none 时补 low，让上游把思考分到
 * reasoning_content（DSH 客户端会把 reasoning_content 收进思考通道，不进正文）。
 *
 * 合法档位（low/medium/high/max）与 xhigh/ultra 等别名不动；
 * MARVIS_REASONING_EFFORT_FLOOR 可覆盖默认值（非合法值时回退 low）。
 *
 * @param {Record<string, any>} json 请求体对象（就地修改）
 * @returns {boolean} 是否发生改写
 */
export function normalizeWsReasoningEffort(json) {
  if (!json || typeof json !== "object") return false
  const raw = json.reasoning_effort ?? json.reasoning
  const eff = String(raw ?? "").trim().toLowerCase()
  const valid = ["low", "medium", "high", "max"]
  if (valid.includes(eff)) return false
  const alias = { xhigh: "max", "x-high": "max", highest: "max", ultra: "max", maximum: "max",
                  minimal: "low", minimum: "low", min: "low", tiny: "low", least: "low" }
  const configured = String(process.env.MARVIS_REASONING_EFFORT_FLOOR ?? "low").trim().toLowerCase()
  const floor = valid.includes(configured) ? configured : "low"
  json.reasoning_effort = alias[eff] ?? floor
  return true
}

// ⚠ 不要用 TABLE（`DISPLAY_BY_SLOT`）当准入集合。
//   TABLE 是**对外展示目录**，不是「上游可用集合」：`app-auto` / `file-auto` /
//   `computer-auto` / `browser-auto` 这类旧真实槽位不在 TABLE 里，上游却仍然 200。
//   拿 TABLE 做 allowlist 会把它们本地 404 掉（0.2.21 的事故）。
//   准入只查 `isUnavailableModel`（明确不可用名单，当前只有 `kimi-k2.5`），其余交给上游判。

/** 请求体里到底有没有指定模型（空 / null 的交回上游判） */
function hasModelId(value) {
  return value != null && String(value) !== ""
}

/**
 * 明确不可用的模型：**本地** 404，不出网、不 fallback。
 *
 * 只对 `isUnavailableModel` 命中名单的模型生效（当前只有 `kimi-k2.5`）。
 * TABLE 外的旧真实槽位不归这里管 —— 它们照常出网，可用性由上游响应决定。
 *
 * 为什么是 404 而不是 401/500（AGENTS 坑 6）：
 *   · 401 会被宿主当登录问题，failover 到**每一个账号**；
 *   · 500 会被当可重试的上游故障，同一个请求连打 8 次（kimi-k2.5 的 5104002 现场）；
 *   · 404 只搁置这个模型，文案把用户引导回模型列表里**真实模型名**的条目。
 */
function modelUnavailableResponse(id) {
  const example = DISPLAY_BY_SLOT[DEFAULT_MODEL] ?? DEFAULT_MODEL
  return errorResponse(
    404,
    "model_unavailable",
    `模型「${String(id).slice(0, 120)}」已被标记为持续不可用（上游稳定失败），` +
      `这次请求没有发往上游。请在模型列表里重新选择一个真实模型名条目（例如 ${example}）。`,
  )
}

/** 从账号凭据里取模型网关要的四件套 */
function credsOf(auth) {
  const meta = auth?.metadata ?? {}
  return {
    openid: String(meta.openid ?? auth?.uid ?? ""),
    accessToken: String(auth?.access ?? auth?.key ?? ""),
    guid: String(meta.guid ?? ""),
    loginType: String(meta.loginType ?? "1"),
  }
}

function openclawTransportRequested() {
  const t = String(process.env.MARVIS_TRANSPORT ?? "").trim().toLowerCase()
  return t === "openclaw" || t === "ws" || t === "relay" || t === "remote"
}

/**
 * 账号是否被**插件侧**取消过登录（`node scripts/cli.mjs accounts logout` 的落盘形状：
 * access/refresh 清空 + expires 拨到过去 + metadata.revokedAt 打标）。
 *
 * 为什么要单独认这一种：被取消登录的账号既没 access 也没 refresh，走原来的
 * `return {}` 会让它看起来像「插件没配好」；这里给它一个明确的 401 +
 * `X-Magpie-Sign-In: expired`（与 :831 登录失效同一条宿主通道），
 * 壳卡片上直接显示「需要重新登录」，用户知道该干什么。
 */
export function revokedByPluginLogout(auth) {
  if (!auth || typeof auth !== "object") return false
  const access = String(auth.access ?? auth.key ?? "").trim()
  const refresh = String(auth.refresh ?? "").trim()
  if (access || refresh) return false
  return Boolean(auth.metadata?.revokedAt)
}

export function loaderHook(input, options = {}) {
  return async (getAuth) => {
    // 先判断是否走本地网关：这条路不需要 magpie 侧的 Marvis 登录态
    // （账号/凭据全在网关里），必须放在下面的 creds 检查之前，
    // 否则手机上没登录 magpie 时会直接 return {} —— 插件像没装一样。
    const viaGateway = await localGatewayEnabled()
    const gw = gatewayConfig()

    const auth = await getAuth()
    const creds = credsOf(auth)
    // ── 按账号分桶的风控闸（0.8.0）───────────────────────────────────────
    // magpie 壳每次请求只传**当前选中的那一个账号**，插件侧没有账号池，所以「谁在冷却」
    // 只能从这份凭据算：bucket = sha256(openid/uid) 前 12 位（不落明文），
    // label = 脱敏账号名（首 4 + 尾 4），只用于报错文案与 CLI 列表。
    // MARVIS_RISK_SCOPE=global 时退回旧行为（所有账号共用 `"*"` 桶）。
    const acctBucket = riskScope() === "global" ? "*" : accountKeyOf(creds)
    const acctLabel = accountLabelOf(creds)
    const breaker = getBreaker(acctBucket, acctLabel)
    // 全局桶（通道级）：只可能被「跨账号共因闸」打开 —— 多个不同账号接连被拦时，
    // 判定拦的是通道而不是账号，此时必须对所有账号一起停（否则每个号都要轮流撞一遍）。
    // account 作用域下这条路平时是关的；MARVIS_RISK_SCOPE=global 时它就是 acctBucket 本身。
    const channelBreaker = acctBucket === "*" ? breaker : getBreaker("*", "跨账号共因")
    if (!viaGateway && (!creds.accessToken || !creds.openid)) {
      // 被 `accounts logout` 取消登录的账号：给壳明确的「需要重新登录」信号，
      // 不要静默 return {}（那看起来像插件坏了）。
      if (revokedByPluginLogout(auth)) {
        return {
          baseURL: BASE_V1,
          apiKey: "revoked",
          fetch: async () =>
            errorResponse(401, "sign_in_revoked", "该账号已在插件侧取消登录，请在 magpie 里重新登录。", {
              "X-Magpie-Sign-In": "expired",
            }),
        }
      }
      return {}
    }

    return {
      baseURL: viaGateway ? gw.url : BASE_V1,
      apiKey: viaGateway ? gw.key || "gateway" : "placeholder",
      fetch: async (target, init) => {
        const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url

        // ── 本地网关模式（手机端默认）────────────────────────────────
        // 账号/凭据/出票/风控全在网关那层（参考 Marvis-proxy-public，纯 Python、
        // Termux/PRoot 可跑）。插件退化成纯 provider：原样转发补全请求，不签 uskey、
        // 不抓包、不读流。显式 MARVIS_TRANSPORT=direct|openclaw 可关掉自动探测。
        // 非补全请求（/models）也一并转发，让 magpie 从网关拿真实模型清单。
        if (viaGateway) {
          return gatewayFetch(target, init)
        }

        // ⚠ 每次请求都现读开关：magpie 的 option() 本来就是现查的，改了立刻生效
        const firstLine = firstLineOption(input, options)

        // 非补全请求（/models 之类）原样放行 —— 上游没有这个端点，交给上层兜底。
        // 三种补全协议都要进来：/chat/completions、/messages（Anthropic）、/responses，
        // 否则那两种协议下「每个请求都改写首行」等于空操作（issue #62）。
        if (!/\/(?:chat\/completions|messages|responses)\b(?!\/)/.test(url)) {
          return directFetch(target, init)
        }

        // 0.9.12：标题生成请求本地返回，彻底不发上游（避免注入模型把乱码吐到对话区）。
        const titleRes = titleRequestLocalResponse(init?.body)
        if (titleRes) return titleRes

        /**
         * 一次逻辑请求（含所有 403 兜底/候选池/护栏重试）共用**一条** Marvis 会话。
         * 旧版每次 callUpstream 都新建 conv_*，候选池一次能刷出 6 条空会话；这里生成一次，
         * 贯穿整个重试链。MARVIS_GATEWAY_CONVERSATION_ID 可进一步把所有插件流量钉在一条会话。
         */
        const relayConversationId = `conv_${randomUUID().replace(/-/g, "")}`

        /**
         * 发一次上游请求。**每次都重新签 uskey** —— 它是一次性的：
         * 403 兜底重试若复用上一次的 uskey，会直接撞风控（`risk_blocked`），
         * 看起来像另一个故障，排查时会被带偏。
         */
        const callUpstream = async (payload) => {
          // openclaw WS 传输：绕开被 4100404 全局风控的 HTTP 模型网关（文档路线 11.3）。
          // 走这条路时不需要 uskey / llmHeaders；请求体已由下面的逻辑归一化过。
          if (openclawEnabled() || openclawTransportRequested()) {
            let json = null
            try {
              json = typeof payload === "string" ? JSON.parse(payload) : payload
            } catch {
              json = null
            }
            // 0.9.9：WS relay 通道补 reasoning_effort 归一化（对齐 8088 网关行为），
            // 否则上游把整段思考写进 delta.content，正文出现「乱码」。
            normalizeWsReasoningEffort(json)
            // 流式接线（C 类改造）：WS 通道（relay→AG-UI gateway / remote→手机会话域）
            // 在宿主要求 stream:true 时，把实时增量迭代器包成 chat.completion.chunk
            // 的 SSE 响应 —— 不再全量攒完才吐出。chunk 构造复用 openclawResponse
            // 现成的 chatChunkSse，与直连路径 normalizeStreaming 透传的 SSE 形状一致。
            // 非流式请求走原聚合路径，行为零变化。
            if (json?.stream) {
              const iterator = openclawChatStream(creds, json, { signal: init?.signal, conversationId: relayConversationId })
              // 预取首帧：连接 / 握手 / ACK / 无内容 RUN_ERROR 的失败在这里以 throw
              // 暴露，仍由下方 callUpstream 的统一 catch 映射成 503 错误响应 ——
              // 不会退化成「200 + 空流」。chunk 帧从第一帧起继续。
              const first = await iterator.next()
              if (first.done) {
                throw new Error("openclaw WS 通道没有产出任何内容")
              }
              return openclawStreamResponse(json, {
                [Symbol.asyncIterator]: async function* () {
                  yield first.value
                  yield* iterator
                },
              })
            }
            const result = await openclawChat(creds, json, { signal: init?.signal, conversationId: relayConversationId })
            return openclawResponse(json, result)
          }
          let headers
          try {
            // 上游 2026-11-17 之后要求 uskey 与本次请求上下文（conv/resp/scene/model/nonce/openid）绑定。
            // 每次真正发请求都重新生成一套 identity；403 兜底重试也会走这里，所以不会复用旧票。
            let payloadModel = DEFAULT_MODEL
            try {
              const payloadText =
                typeof payload === "string"
                  ? payload
                  : Buffer.isBuffer(payload)
                    ? payload.toString("utf8")
                    : String(payload ?? "")
              const parsed = JSON.parse(payloadText)
              payloadModel = canonicalModelId(parsed?.model) || DEFAULT_MODEL
            } catch {
              /* 不是 JSON 就用默认槽位，交给上游判 */
            }
            headers = await llmHeaders(creds, {
              model: payloadModel,
              scene: process.env.MARVIS_SCENE || "agent_chat",
              agentTag: process.env.MARVIS_AGENT_TAG || "main",
            })
          } catch (err) {
            throw new HeaderUnavailable(err?.message ?? String(err))
          }
          // 保留调用方传的 stream / 业务体，只换鉴权头。
          // ⚠ 必须**按小写判重**：magpie 传进来的头是普通对象、键的大小写不固定
          //   （`user-agent` 与 `User-Agent` 同时存在时，Headers 会把两条**用逗号连起来**，
          //   于是上游收到 `magpie/0.1.4342, AsyncOpenAI/Python 2.32.0` —— 既不是官方 UA，
          //   也可能被当成伪造头触发 4100404 风控）。
          const oursLower = new Set(Object.keys(headers).map((k) => k.toLowerCase()))
          const merged = {}
          const incoming = init?.headers
          if (incoming && typeof incoming.forEach === "function" && !Array.isArray(incoming)) {
            // Headers 实例
            incoming.forEach((value, key) => {
              if (!oursLower.has(String(key).toLowerCase())) merged[key] = value
            })
          } else if (Array.isArray(incoming)) {
            for (const [key, value] of incoming) {
              if (!oursLower.has(String(key).toLowerCase())) merged[key] = value
            }
          } else {
            for (const [key, value] of Object.entries(incoming ?? {})) {
              if (!oursLower.has(String(key).toLowerCase())) merged[key] = value
            }
          }
          Object.assign(merged, headers)
          if (payload !== init?.body) {
            // body 变了，长度 / 压缩头必须去掉，让 fetch 重新算
            delete merged["content-length"]
            delete merged["Content-Length"]
            delete merged["content-encoding"]
            delete merged["Content-Encoding"]
          }
          // 传输通道（0.5.3）：主补全请求默认走 node:https **强制直连**（directPost）。
          // 理由：Bun 的全局 fetch 会吃 HTTPS_PROXY，且代理解析可能在宿主启动时固化
          //（运行时剥 env 不保证生效）——clash 关着 = ECONNRESET，开着 = 出口被
          // 代理节点劫持、触发 4100404 风控。node:https 不做 fetch 那套代理解析，
          // 在任何宿主环境下都直连腾讯国内端点。流式请求由 payload 里的 stream 字段
          // 自然透传（body 一个字节不动），SSE 归一化仍由下方 normalizeStreaming 处理。
          // MARVIS_DIRECT_TRANSPORT=fetch 显式回退旧的 fetch + 剥 env 版本。
          if (directTransport() === "fetch") {
            return directFetch(url, { ...init, body: payload, headers: merged })
          }
          return directPost(url, { headers: merged, body: payload, signal: init?.signal })
        }

        /** 上游给流式响应时带的是 text/plain，但 body 是标准 SSE —— 归一化 content-type */
        const normalizeStreaming = (res) => {
          const ct = res.headers.get("content-type") ?? ""
          if (res.body && !/event-stream/i.test(ct)) {
            const headers = new Headers(res.headers)
            headers.set("content-type", "text/event-stream; charset=utf-8")
            return new Response(res.body, { status: res.status, headers })
          }
          return res
        }

        /**
         * 403 自愈链的每次重试也走节奏闸。
         *
         * 旧版三个重试函数直接调 callUpstream，绕过主路径的那一次 pacingWait ——
         * 一次请求最多连发 6 发（兜底句 + 4 句候选 + 护栏），节奏闸形同虚设，
         * 正好在「被内容过滤盯上」的高压时刻把请求打成尖峰。
         * 这里统一补上节流；MARVIS_RETRY_PACING=0 可显式关掉（仅调试用）。
         */
        const pacedRetryUpstream = async (payload) => {
          if (String(process.env.MARVIS_RETRY_PACING ?? "").trim() !== "0" && !openclawEnabled()) {
            await pacingWait(acctBucket)
          }
          return callUpstream(payload)
        }

        /**
         * 403 兜底：把首行换成兜底句，**重试一次**。
         * 成功返回规范化后的响应；失败返回 null（落回统一诊断，不把第二次的错误文本当结果）。
         */
        const retryWithFallbackFirstLine = async (json) => {
          const next = withFirstLineInBody(json, firstLine.text)
          if (next === json) return null // 三处都找不到 system 文本，无从下手
          try {
            const retry = await pacedRetryUpstream(JSON.stringify(next))
            if (retry.ok) {
              rememberFirstLine(acctBucket, systemFirstLine, firstLine.text, firstLine.mode)
              return normalizeStreaming(retry)
            }
            return null
          } catch {
            return null
          }
        }

        /**
         * 候选池二次自愈（0.5.2，借鉴社区 403 修复包 + 本仓军备竞赛结论重制）：
         * 兜底句重试仍被拦时，从泛指候选池随机换句重试（最多 4 句，排除已试句）。
         * ⚠ 池子以**中文泛指句**为主 —— 英文泛指句 2026-11-17 起被上游陆续拉黑，
         *   照抄社区英文池会得到「看起来能自愈、实际全 403」的假兜底。
         * ⚠ 每句重试都重新走 callUpstream（remote 模式新开 WS / HTTP 模式重签 uskey）；
         *   「错误类型变了就停」：上游一旦回 401/风控/404 等其他错误，立即中止 ——
         *   内容过滤自愈绝不把其他故障当救回信号。
         * ⚠ 不计入风控熔断：403 内容过滤与 4100404 节奏风控是两套机制，
         *   换句重试不撞 uskey 风控面；但最多 4 句限制本身就控制了暴露面。
         */
        const FIRST_LINE_CANDIDATES = [
          "你是一个乐于助人的 AI 助手。",
          "你是一个功能强大的 AI 助手。",
          "你是一个通用 AI 助手。",
          "你是一个知识丰富的 AI 助手。",
          "你是一个聪明可靠的 AI 助手。",
          "你是一个认真负责的 AI 助手。",
          "You are a helpful AI assistant.",
          "You are a capable AI assistant.",
          "You are an AI assistant.",
        ]
        const CANDIDATE_MAX_TRIES = 4

        const retryWithRandomFirstLines = async (json, triedSet) => {
          if (firstLine.mode === "off") return null
          const pool = [...FIRST_LINE_CANDIDATES].sort(() => Math.random() - 0.5)
          const tried = new Set(triedSet)
          let tries = 0
          for (const cand of pool) {
            if (tries >= CANDIDATE_MAX_TRIES) return null
            if (tried.has(cand)) continue
            tried.add(cand)
            tries += 1
            const next = withFirstLineInBody(json, cand)
            if (next === json) continue
            let retry
            try {
              retry = await pacedRetryUpstream(JSON.stringify(next))
            } catch {
              return null
            }
            if (retry.ok) {
              rememberFirstLine(acctBucket, systemFirstLine, cand, firstLine.mode)
              return normalizeStreaming(retry)
            }
            const errText = await retry.clone().text().catch(() => "")
            // 错误类型变了就停：401/风控/404 等其他故障 ≠ 内容过滤，立即中止
            if (!(retry.status === 403 && /非法请求|permission_error|4100406/i.test(errText))) return null
          }
          return null
        }

        /**
         * 最后一次重试：U+2060 护栏改写（MARVIS_GUARD_WORD_JOINER=1 时生效）。
         * 位置在兜底句重试**之后** —— 它是缓兵之计，不当首选。
         */
        const retryWithGuard = async (json) => {
          const next = withWordJoiner(json)
          if (next === json) return null // 护栏没开，或改写没有命中任何内容
          try {
            const retry = await pacedRetryUpstream(JSON.stringify(next))
            if (retry.ok) {
              // 护栏改写后的首行：从 next 里取，供下次直接命中
              const guardedLine = firstLineInBody(next)
              rememberFirstLine(acctBucket, systemFirstLine, guardedLine, firstLine.mode)
              return normalizeStreaming(retry)
            }
            return null
          } catch {
            return null
          }
        }

        // ⚠ 旧路由里模型 ID 是数组下标 `"0"…"7"`，上游只认槽位名。
        //   在这里做一次归一，旧路由不改配置也能继续用。
        let body = init?.body
        /** 改写前的原始请求体 —— 403 诊断要靠它判断上游拦的是哪句身份声明（body 可能已被改写） */
        const originalBody = typeof body === "string" ? body : ""
        /** @type {string | null} 命中「明确不可用」名单的模型 ID */
        let unavailableModel = null
        /** 请求体里的 system 首行 —— 403 兜底重试拿它比「是不是已经是用户那句」 */
        let systemFirstLine = ""
        /** 解析后的请求体 —— 403 兜底重试要用它重建 body */
        let requestJson = null
        if (typeof body === "string") {
          // 只做标记，不改 body —— 命中与否只影响错误文案
          systemFirstLine = systemFirstLineOf(originalBody)
          let json = null
          try {
            json = JSON.parse(body)
          } catch {
            /* 不是 JSON 就原样转发 */
          }
          if (json && typeof json === "object") {
            requestJson = json
            let changed = false
            const canonical = canonicalModelId(json.model)
            if (canonical !== json.model) {
              json.model = canonical
              changed = true
            }
            // ── 0.9.7：reasoning_effort=max 的 max_tokens 自动补偿 ──────────
            // 文档第九节（实测）：思考档开 max 时模型先思考 3-4 万 token，
            // max_tokens=16000 → 上游 502 空正文；≥64000 → 200 正常返回。
            // 规则见 applyReasoningBudgetFloor（纯函数，单测覆盖）。
            if (applyReasoningBudgetFloor(json)) changed = true
            if (hasModelId(json.model) && isUnavailableModel(json.model)) {
              // 明确不可用名单（当前只有 kimi-k2.5）：本地挡掉，不出网、不 fallback。
              unavailableModel = String(json.model)
            }
            if (unavailableModel === null) {
              // Marvis 要求每个工具 parameters 显式 type:"object"；
              // DSH 的部分工具省略了它，缺一个就 400 invalid parameter。
              const tools = normalizeTools(json.tools)
              if (tools !== json.tools) {
                json.tools = tools
                changed = true
              }
              try {
                // 图片 URL / 裸 base64 / Anthropic image 显式归一为 data URI；
                // 转换不了就本地 400，不再静默丢图或把无效输入交给上游。
                const messages = await normalizeMessages(json.messages)
                if (messages !== json.messages) {
                  json.messages = messages
                  changed = true
                }
              } catch (err) {
                if (err instanceof InvalidImageError) {
                  return errorResponse(400, "invalid_image", `图片输入无效：${err.message}`)
                }
                throw err
              }
              // mode=always：用户明确要求「每个请求都换成我填的那句」
              if (firstLine.mode === "always") {
                const forced = withFirstLineInBody(json, firstLine.text)
                if (forced !== json) {
                  json = forced
                  changed = true
                }
              } else {
                // 首行自愈记忆：同一账号 + 同一原首行上次被拦后换某句成功过，直接命中，
                // 省掉「兜底句 → 4 句候选 → 护栏」整条重试链。
                const remembered = rememberedFirstLine(acctBucket, systemFirstLine, firstLine.mode)
                if (remembered && remembered !== systemFirstLine) {
                  const forced = withFirstLineInBody(json, remembered)
                  if (forced !== json) {
                    json = forced
                    changed = true
                  }
                }
              }
            }
            if (changed) body = JSON.stringify(json)
          }
        }

        // 明确不可用模型：本地 404，一次 fetch 都不发
        if (unavailableModel !== null) {
          return modelUnavailableResponse(unavailableModel)
        }

        // 风控熔断中：本地 429，请求不出网 ——
        // 让账号自然冷却，而不是陪着宿主的默认重试策略把冷却时间撞得更长（issue #71）。
        // 0.8.0 起熔断按账号分桶：这里只挡**当前这个账号**，其他账号照常出网。
        // 例外是全局桶（跨账号共因闸）：多个不同账号接连被拦 → 判定通道级封锁 → 全体暂停。
        //
        // ⚠ 0.9.5 修正（本行曾是 `!openclawEnabled() && (...)`）：
        //   旧版让 **WS 通道（relay / remote）完全绕过熔断闸**，理由是「WS 走手机会话域，
        //   是另一个风控域」。2026-11-28 实测证伪 —— relay、HTTP 直连、**官方 PC 客户端**
        //   三条通道被**同一秒**、同一设备号（qimei36）一起拦下；`risk_control_blocked`
        //   与 HTTP 的 4100404 同源。而 WS 路径**自己已经在 `breaker.record(false)`**
        //   （见下方 risk_control_blocked 分支）——即「记了失败，却没有任何一处读它」，
        //   熔断器在 WS 下是一段死代码。
        //   实测后果：宿主默认重试 7 次，一次用户请求 = 7 次真实撞击上游
        //   （usage.jsonl 每条 34.8s ÷ 单次 ~4.95s ≈ 7），而 breaker-state.json 的
        //   `failures` 全程为 0 —— 熔断从未生效。
        //   现在熔断闸对所有传输生效。确需旧行为可设 MARVIS_RISK_GATE_WS=0（不推荐：
        //   那正是把冷却时间撞长的原因）。
        const gateWs = String(process.env.MARVIS_RISK_GATE_WS ?? "").trim() !== "0"
        if ((gateWs || !openclawEnabled()) && (breaker.open || channelBreaker.open)) {
          const channelWide = channelBreaker.open && channelBreaker !== breaker
          const gate = channelWide ? channelBreaker : breaker
          const minutes = Math.ceil(gate.retryAfterMs / 60_000)
          const message = channelWide
            ? `通道级风控冷却中：多个不同账号接连被 4100404 拦住，判定拦的是通道（uskey / UA / IP / ` +
              `上游节点），插件已暂停**所有账号**出网 ${minutes} 分钟。换账号没用 —— ` +
              "该换 IP、重签 uskey。" +
              "⚠ 2026-11-28 实测：relay / remote / HTTP 直连是同源风控域，三者会被同一设备号一起拦，" +
              "**不要**以为切 WS 就能绕（旧文案的误导已删）。真正能换的是**设备号 qimei36**（须服务端签发）。" +
              "MARVIS_RISK_CONSENSUS=0 可关闭这个共因闸（此后纯按账号隔离）。"
            : `账号「${acctLabel}」风控冷却中：连续 ${breaker.failures} 次被 4100404 拦截，` +
              `插件已暂停这个账号出网 ${minutes} 分钟` +
              "（**其他账号不受影响**；换 IP/UA 无效，等冷却结束）。" +
              "⚠ 2026-11-28 实测：若 qimei36 已被硬拉黑（403 在 <800ms 内秒回），" +
              "换账号 / 换 IP / 切 WS 通道 / 等冷却**全都无效**，只能换服务端签发的设备号。" +
              "判定命令见 KNOWN_ISSUES.md BUG #7。" +
              "MARVIS_RISK_COOLDOWN_MS=0 可禁用熔断；MARVIS_RISK_SCOPE=global 可退回全局冷却；" +
              "node scripts/cli.mjs breaker reset <账号> 可立刻解封。"
          // 0.8.2：若父进程继承了 MARVIS_WS_MODE=off 覆盖了 openclaw.json 的 relay，
          // 用户看到的 429 其实是「配置被劫持到 HTTP 直连」——把这条隐藏链路点出来，
          // 否则换账号 / 等冷却都没用（真实踩坑：用户配了 relay 却仍被 429，排查很久）。
          const cfgWarn = openclawStatus().overrideWarning
          const fullMessage = cfgWarn ? `${message} ${cfgWarn}` : message
          return riskResponse("risk_cooldown", fullMessage, gate.retryAfterMs / 1000)
        }

        let response
        let upstreamStartedAt = 0
        try {
          // ── 请求节奏闸（0.7.0）─────────────────────────────────────
          // 风控看的是**请求节奏分布**，熔断只是撞了之后的止损；压平节奏才是预防。
          // ⚠ 0.9.5 修正：旧版只对 HTTP 直连生效，理由是「WS 是另一个风控域，不该被
          //   HTTP 侧节奏拖慢」。2026-11-28 实测证伪（relay 与 HTTP 被同一设备号同一秒
          //   拦下），故 WS 同样要压节奏 —— 同源风控域就该同源节流。
          //   WS 上每轮是短连接、且 relay 会多轮展平，额外一次首帧前等待可接受。
          //   确需旧行为可设 MARVIS_PACE_WS=0。
          const paceWs = String(process.env.MARVIS_PACE_WS ?? "").trim() !== "0"
          if (paceWs || !openclawEnabled()) await pacingWait(acctBucket)
          // 0.9.5：给上游往返计时 —— 4100404 的**设备硬拉黑**与**节奏限流**靠耗时分流
          // （判据见下方 RISK_HARD_BLOCK_MS）。计时从真正发出请求起算，不含上面的节奏等待。
          upstreamStartedAt = Date.now()
          response = await callUpstream(body)
        } catch (err) {
          if (err instanceof HeaderUnavailable) {
            return errorResponse(503, "header_unavailable", `请求头构造失败：${err.message}`)
          }
          // WS 通道（relay / remote）把上游 risk_control_blocked 当错误抛出 ——
          // 那不是「连不上网关」，是上游风控；必须按 HTTP 侧 4100404 同样的口径回
          // 429 + retry-after，否则宿主会把它当网络故障连试 7 次，把冷却越撞越长
          // （issue #71）。relay 已经是最绕开 HTTP 的路线，再提示「切 relay」是废话：
          // 这里只说清楚「PC 客户端会话域也被同一个风控拦住」和真正的两条出路。
          // 拦截文案已在 gatewayChatStream 扣留丢弃，不会出现在 message 里。
          if (String(err?.code || "") === "risk_control_blocked") {
            breaker.record(false)
            const retryAfterSec = Math.max(1, Math.ceil(breaker.retryAfterMs / 1000) || 60)
            return riskResponse(
              "risk_blocked",
              "上游风控拦截（Marvis PC 客户端 WS 通道）：agent.run 被 risk_control_blocked 拦下，"
                + "与 HTTP 直连的 4100404 同源，换账号 / 换 IP 都无效。"
                + "可行出路只有一条：本地 Python 网关（8088）。自检：node scripts/doctor.mjs。"
                + `原始返回：${String(err?.message ?? err).slice(0, 400)}`,
              retryAfterSec,
            )
          }
          // 0.7.7：连接失败（最常见的就是手机 openclaw WS 连 PC 10123 端口）
          // 以前只甩一句「连不上」，用户不知道下一步做什么。这里补一条**能直接执行**的诊断：
          // 手机上指向本地 8088 网关的 diag.sh --fix；桌面上指向 PC 客户端/WS_MODE 出路。
          const errText = String(err?.message ?? err)
          const diag = connectionFailureHint({ errText })
          const res = errorResponse(503, "upstream_unreachable", `连不上 Marvis 网关：${errText}`, {
            "x-marvis-diagnosis": diag.header,
          })
          let body = {}
          try {
            body = await res.json()
          } catch {
            body = { error: { type: "upstream_error", code: "upstream_unreachable", message: errText } }
          }
          if (!body.error || typeof body.error !== "object") {
            body = { error: { type: "upstream_error", code: "upstream_unreachable", message: errText } }
          }
          body.error.diagnosis_hint = diag.hint
          body.error.diagnose_command = diag.command
          return new Response(JSON.stringify(body), {
            status: 503,
            headers: { "content-type": "application/json", "x-marvis-diagnosis": diag.header },
          })
        }

        if (response.ok) {
          // 成功即证明账号健康：清零熔断计数
          breaker.record(true)
          return normalizeStreaming(response)
        }

        // ── 网关 503 的可行动诊断 ────────────────────────────────────
        // 手机端最常见的 503 是「8088 没起 / 账号池为空」，但原始 503 JSON
        // 只说服务不可用，用户根本不知道下一步做什么。这里不改写成功响应，
        // 只在错误 code 上补一条人能直接执行的 hint。
        if (response.status === 503 || response.status === 502) {
          const gwHint =
            "Marvis 503 诊断：先看 8088 是否监听、账号池是否为空。启动网关：" +
            "在 Termux / PRoot 里 cd 到本插件的 gateway/ 目录执行 sh run.sh（或 python serve.py）；" +
            "再打开 http://127.0.0.1:8088/ 控制台加号登录 Marvis（账号池为空会回 503 no_account）。" +
            "若仍失败，确认 gateway.json.mode=gateway、url=http://127.0.0.1:8088/v1。" +
            "注意 ws://127.0.0.1:10123/ 是 PC AG-UI relay，手机端请走 8088 HTTP 网关。"
          const cloned = response.clone()
          let errBody = {}
          try {
            errBody = await cloned.json()
          } catch {
            try {
              const raw = await cloned.text()
              errBody = { error: { message: raw.slice(0, 300) } }
            } catch {
              /* 保留空 body */
            }
          }
          if (!errBody?.error || typeof errBody.error !== "object") {
            errBody = { error: { type: "upstream_error", code: "gateway_unavailable", message: String(errBody?.message ?? "") } }
          }
          if (!errBody.error.code) errBody.error.code = "gateway_unavailable"
          errBody.error.diagnosis_hint = gwHint
          errBody.error.diagnose_command = "node <插件目录>/scripts/doctor.mjs"
          return new Response(JSON.stringify(errBody), {
            status: response.status,
            headers: { "content-type": "application/json", "x-marvis-diagnosis": "gateway-503" },
          })
        }

        // —— 错误分流：只读 **错误** 的 body（成功响应绝不读，见文件头 ⚠）——
        let text = ""
        try {
          text = await response.clone().text()
        } catch {
          /* 读不出来就按状态码判 */
        }

        if (AUTH_EXPIRED.test(text) || response.status === 401) {
          return errorResponse(401, "sign_in_expired", "Marvis 登录态已过期，请重新登录。", {
            "X-Magpie-Sign-In": "expired",
          })
        }
        if (RISK_BLOCK.test(text)) {
          // 4100404 计入熔断并回 **429 + Retry-After**（0.4.0 变更）：
          //   旧版回 503 risk_blocked，宿主当可重试错误连试 7 次 —— 把账号级节奏风控的
          //   冷却时间越撞越长（issue #71 实测）。429 让宿主按 retry-after 退避；
          //   连续 MARVIS_RISK_THRESHOLD（默认 5）次后熔断，请求根本不出网。
          //   旧行为可用 MARVIS_RISK_STATUS=503 找回。
          breaker.record(false)
          // 0.9.5：按耗时分流「设备硬拉黑」与「节奏限流」——两者处置完全不同，
          // 旧版一律说「账号级节奏风控，换账号/等冷却」，把硬拉黑用户引向无用的动作。
          // 判定只改**文案与自动回退**，不额外升级熔断：record(false) 本身就会在
          // 连续 5 次后开闸（阈值语义不变），立即 trip 会跳过退避链、也让宿主侧
          // 的错误语义（429 vs 闸内 429）在两次响应间突兀切换。
          const upstreamMs = upstreamStartedAt ? Date.now() - upstreamStartedAt : 0
          const hardThreshold = hardBlockThreshold()
          const hardBlocked = hardThreshold > 0 && upstreamMs > 0 && upstreamMs < hardThreshold
          const retryAfterSec = Math.max(1, Math.ceil(breaker.retryAfterMs / 1000) || 60)
          const status = Number.parseInt(String(process.env.MARVIS_RISK_STATUS ?? ""), 10) || 429
          const baseMessage = hardBlocked
            ? `上游风控拦截（**设备硬拉黑**）：403 + 4100404 在 ${upstreamMs}ms 内秒回`
              + `（< ${hardThreshold}ms 即判设备号已被拉黑）。`
              + "此时服务端在业务逻辑之前就按**设备号 qimei36** 拒掉，"
              + "换账号 / 换 IP / 切 WS 通道（relay）/ 改首行 / 重装插件 / 等冷却**全都无效**。"
              + "唯一出路是换一个**由腾讯服务端签发**的 qimei36（改 MAC 等本地手段只会让 qimei.dll"
              + "进入「拒绝交付」分支返回空号，伪造 36-hex 则 100% 秒拒）。"
              + "判定与修复详见 KNOWN_ISSUES.md BUG #7。"
              + `原始返回：${text.slice(0, 300)}`
            : "上游风控拦截：Marvis 的 /v1/chat/completions 会校验 Ual-Access-MarvisExt.uskey "
              + "是否按本次请求上下文（conv / resp / scene / model / nonce / openid）用 Beacon SDK 现算。"
              + "插件已按 bus_info 出票；若连续出现，检查 native/ 的 4 个文件是否齐全、qimei36 是否真实，"
              + "或设置 MARVIS_USKEY_URL 指向外部出票服务。"
              + "若只有**这一个账号**被拦：是账号级节奏风控，换别的账号可用、等这个号冷却即可（0.8.0 起按账号隔离）；"
              + "若**多个账号**接连都这样：是通道级封锁（uskey / UA / IP），换账号也没用 ——"
              + `原始返回：${text.slice(0, 300)}`

          // ── 0.7.7：PC 端 4100404 自动 WS 回退 ──────────────────────
          // HTTP 模型网关被 uskey 节奏风控时，唯一验证可行的路线是绕开 HTTP 走 openclaw WS。
          // 桌面且本机 Marvis PC 客户端 relay（10123）可达时，自动重试一次：
          // 成功直接把 WS 响应交回去；失败在 429 文案里说清原因与下一步。
          // 手机没有 PC 客户端，不自动重试；显式 remote / 用户关掉 / 探针不通都不重试。
          let probeReachable = false
          let autoTried = false
          let autoError = ""
          // 0.9.5：设备已硬拉黑时不自动回退 WS —— relay 与 HTTP 是**同源风控域**，
          // 2026-11-28 实测两者被同一设备号同一秒拦下，回退只会白白多打一次上游
          // （实测 relay 也回 code=risk_control_blocked）。仍想试可设 MARVIS_RISK_AUTO_WS_HARD=1。
          const skipAutoForHardBlock =
            hardBlocked && String(process.env.MARVIS_RISK_AUTO_WS_HARD ?? "").trim() !== "1"
          const autoEnabled =
            !skipAutoForHardBlock &&
            shouldAutoWsFallback({
              mode: String(process.env.MARVIS_WS_MODE ?? ""),
              autoDisabled: String(process.env.MARVIS_RISK_AUTO_WS ?? "") === "0",
              riskStatus: status,
            })
          if (autoEnabled) {
            probeReachable = await probeLocalRelay()
            if (probeReachable) {
              // ⚠ 不碰 process.env.MARVIS_WS_MODE —— 那是全局状态。旧版在 await 之前设成
              //   "relay"、finally 里恢复，并发请求会在窗口期看到被劫持的模式（A 号回退
              //   把 B 号也拖进 WS）。改为把 mode 作为**单次请求参数**透传给 openclaw 调用链
              //   （cfg(modeOverride) → openclawChatStream / openclawChat），天然并发安全。
              const relayOpts = { signal: init?.signal, mode: "relay", conversationId: relayConversationId }
              try {
                autoTried = true
                if (requestJson?.stream) {
                  const iterator = openclawChatStream(creds, requestJson, relayOpts)
                  const first = await iterator.next()
                  if (!first.done) {
                    return openclawStreamResponse(requestJson, {
                      [Symbol.asyncIterator]: async function* () {
                        yield first.value
                        yield* iterator
                      },
                    })
                  }
                  autoError = "WS 通道没有产出任何内容"
                } else {
                  const result = await openclawChat(creds, requestJson, relayOpts)
                  return openclawResponse(requestJson, result)
                }
              } catch (e) {
                autoError = String(e?.message ?? e).slice(0, 200)
              }
            }
          } else {
            // 没进自动回退也要给探针结果，好让文案给出准确的「PC 客户端开没开」提示
            probeReachable = await probeLocalRelay()
          }

          return errorResponse(
            status,
            "risk_blocked",
            enhanceRiskMessage(baseMessage, { probeReachable, autoTried, autoError }),
            { "retry-after": String(retryAfterSec) },
          )
        }
        if (MODEL_ISSUE.test(text) || response.status === 404) {
          // 模型级错误 → 404，只搁置这个模型，不打死账号（AGENTS 坑 6）
          return errorResponse(404, "model_unavailable", `该模型在当前账号不可用：${text.slice(0, 300)}`)
        }
        // ⚠ 403 +「非法请求」一律按内容过滤处理，**不再看是否命中已知指纹**。
        //   理由：上游的指纹在持续扩大（英文 → 中文 → 还没见过的写法），按指纹判定永远漏；
        //   而 403 + 这个组合目前只出现在内容过滤上（模型无权限是 400「无效模型id」）。
        //   宁可多给一句「进群」，也不要把人甩回宿主那句「API 密钥无效」。
        if (response.status === 403 && /非法请求|permission_error|4100406/i.test(text)) {
          // 记忆句失效：同一账号+原首行的缓存条目删掉，本轮重新走完整自愈链找新句
          forgetFirstLine(acctBucket, systemFirstLine)
          // 自愈链（0.5.2）：门禁放宽为 mode !== "off" —— always 模式下用户自己那句
          // 被拦后同样参与自愈（0.5.1 及以前 always 模式没有任何兜底）。
          // 顺序：用户兜底句 → 候选池随机换句（≤4）→ U+2060 护栏（可选）→ 统一诊断。
          if (firstLine.mode !== "off" && requestJson && systemFirstLine !== firstLine.text) {
            const retried = await retryWithFallbackFirstLine(requestJson)
            if (retried) return retried
          }
          if (requestJson) {
            const poolRescued = await retryWithRandomFirstLines(requestJson, [firstLine.text, systemFirstLine])
            if (poolRescued) return poolRescued
          }
          // 候选池也全灭 → U+2060 护栏改写（可选）作最后一搏
          if (requestJson) {
            const guarded = await retryWithGuard(requestJson)
            if (guarded) return guarded
          }
          return errorResponse(403, "content_filtered", CONTENT_FILTER_HINT)
        }
        // 其余原样透出
        return new Response(text || null, {
          status: response.status,
          headers: response.headers,
        })
      },
    }
  }
}

export { DEFAULT_MODEL, credsOf }
