## 0.9.0 — 2026-11-28

**revert「思考全丢弃」+ 正文流按行切分：英文思考进 reasoning_content（可折叠），中文回答留在正文**

- **为什么改**：0.9.11 把 `REASONING_*` 事件整段丢弃，思考面板从此空白——但 PC agent 还有**第二条通路**：它把推理、重试、最终回答**拼进同一个 `TEXT_MESSAGE_CONTENT` 文本流**（实测一个 assistant message 里 16193 字符、单一 text 块，思考与正文无结构边界）。丢弃 reasoning 事件对这条通路完全无效，用户端仍是满屏英文。
- **修复一（传输层）**：`gateway.mjs` 的 `REASONING_*` 事件从「直接 `return` 丢弃」改为 `pushFrame({ reasoning })`，交给上层输出 `reasoning_content` —— 客户端收进可折叠的思考区，而不是彻底不可见。
- **修复二（内容层）**：新增 `src/marvis/thinking-split.mjs`（`classifyLine` / `createLineSplitter` / `splitFullText`），按**行**保守分类：行内命中英文思考句式开头（`The user` / `Let me` / `Hmm` …）+ 中文字符占比 < 5% + 英文词数 ≥ 12，三条同时满足才判为思考 → 移入 `reasoning_content`；任何含中文正文的行一律留在 `content`。
- **接线**：`openclaw.mjs` 的流式（`openclawStreamResponse`）与非流式（`openclawChat` / `openclawResponse`）两条路径都接同一套切分；`openclawResponse` 内部再切一次（幂等），保证任何调用方传原始 text 也安全。
- **流式实时性**：splitter 一旦判定进入正文（出现含中文且非思考句式的行）立即转「直通」状态，之后每个 delta 原样放行 —— 不会因为等换行把整段回复憋到最后（`gateway-stream` 的逐 delta 断言仍通过）。
- **防误伤兜底**：① 重复思考行按前 140 字去重（PC agent 重试会把同一段叠两遍）；② 若切完正文一字符不剩（全文英文回答被误判），整段还给 `content`，绝不返回空回答。
- **测试**：新增 `tests/thinking-split.test.mjs`（13 例：分类边界、跨 delta 半行、去重、兜底、流式/非流式分离）；全量 **490 测试 / 485 pass / 1 fail（环境预存：mock gateway 需要 python，本机缺）/ 4 skipped**。

## 0.9.12 — 2026-11-28

**根治「另一个对话框也能看到的乱码」：标题生成请求本地返回，不再走 marvis**

- **现象**：新开对话后，一段英文（"GreetingThe user's message is a huge jailbreak prompt frame…"）显示在对话区/思考区；用户点"已停止"后未落盘。它是 **DSH 后台标题生成 LLM**（`session-title-first-prompt-llm`，route 跟随当前会话 `group/qq`）的输出——当前 preset 注入了 `[MODE: UNRESTRICTED SANDBOX]`，标题 LLM 把注入框架当用户输入，复读+反思吐出英文。
- **为什么 v0.9.9/0.9.10/0.9.11 没解决**：那些改的是对话主链路的 reasoning 分类/丢弃；标题生成是 DSH 独立的后台 LLM 调用，同样走 group/qq，但请求体是标题专用 system（"Create a concise title for an AI coding-assistant session…"），reasoning 不在主会话链路里。
- **修复**：`loader.mjs` 新增 `titleRequestLocalResponse(payload)`：识别 DSH 标题生成的固定 system 签名后，**在本地直接返回短标题**（从 user 消息的 JSON 里取第一条 text，≤20 字），流式/非流式都支持；普通对话请求返回 null 完全不受影响。标题任务不再发上游，注入模型的乱码无从产生。
- **测试**：新增 `tests/title-local.test.mjs`（4 例：非流式/流式拦截、普通请求不拦、异常输入）；全量 **477 测试 / 472 pass / 0 fail / 5 skipped**。

## 0.9.11 — 2026-11-28

**reasoning 全部丢弃：PC agent 卡死时倒出的工具调用 JSON / 重复段落不再显示**

- **背景**：v0.9.10 把 REASONING_* 分离到 reasoning_content，但 PC agent 卡在重试循环时（设备号被腾讯硬拉黑，BUG #7），思考内容本身是脏的——实测 24115 帧 reasoning 里全是 `_tool_call_intent` 工具调用 JSON 和重复段落（"现在在…找域名邮箱"重复多遍），正文只有 2550 帧。这些作为 reasoning_content 显示出来仍是用户看到的"乱码"。
- **修复**：`gateway.mjs` 新增导出 `isReasoningEvent(evName)`；AG-UI 流里所有 `REASONING_*` 事件**直接丢弃**（`return`），既不进 `content`，也不产生 `reasoning_content`。openclaw 侧的 reasoning_content 通道从此无输入，保留仅为兼容。
- **效果**：思考面板为空，乱码消失；正文只保留真正的回答（若 agent 卡死则无输出，但不再有乱码）。注意这不解决设备号封锁——marvis 要真正出答案仍需换服务端签发的新 qimei36。
- **测试**：`tests/ws-reasoning-content.test.mjs` 更新为 4 例（REASONING_* 全命中、正文事件不误丢、openclaw 通道兼容）；全量 **473 测试 / 468 pass / 0 fail / 5 skipped**。

## 0.9.10 — 2026-11-28

**真修复：WS relay 把 PC agent 的 REASONING_CONTENT 当正文（乱码根因）**

- **现象**：只有走 marvis 插件（`group/qq` → WS relay → PC 客户端 `agent.run`）时，回答正文里出现 "Interpretation:…" / "Let me do:" / 工具调用 JSON 这类英文思考，看起来像乱码；其他 provider 正常。
- **根因（实测确认）**：PC 客户端的 AG-UI 流把思考作为**独立事件**发出——`MarvisHost.bak.log` 里 `REASONING_CONTENT` **24115** 帧、`TEXT_MESSAGE_CONTENT` 2550 帧，每帧结构为 `{"type":"REASONING_CONTENT","delta":"…","event":"ag_ui_event"}`。插件 `gateway.mjs:317` 只判断 `typeof d.delta === "string"`，不检查事件类型，于是把所有思考 delta 当正文 yield；`openclaw.mjs` 再把它们包成 `content`。其他 provider 走标准 OpenAI API，`reasoning_content` 是独立字段，DSH 原生分离——所以只有 marvis 有这个问题。
- **修复**：
  - `gateway.mjs`：AG-UI 事件按 `evName` 分流，`REASONING_*` 的 delta 放进 frame 的 `reasoning` 字段，不再进 `delta`。
  - `openclaw.mjs`：`openclawStreamResponse` 把 `reasoning` 发成 `reasoning_content` chunk；`openclawChat` 单独累计 reasoning；`openclawResponse` 在流式/非流式都输出 `reasoning_content`。无思考时保持原单帧格式（兼容现有客户端）。
- **验证**：新增 `tests/ws-reasoning-content.test.mjs`（3 例：非流式分离、无思考兼容、流式 chunk 分流）；全量 **472 测试 / 467 pass / 0 fail / 5 skipped**。
- **说明**：v0.9.9 的 `reasoning_effort` 归一化对 WS relay 无效（该通道不转发此字段），本版才是根治。两版都保留，无冲突。

## 0.9.9 — 2026-11-28

**修复：WS relay 通道缺 reasoning_effort 归一化，模型思考漏进正文（显示为「乱码」）**

- **现象**：路由组 `qq`（marvis/deepseek-v4-1-flash-*）走 `openclaw.json` 的 `mode=relay`（ws://127.0.0.1:10123）时，请求体不带 `reasoning_effort`（近期 8 条 `group/qq` 路由记录 7 条无 effort 字段）。上游 deepseek-v4-flash 在该情况下把整段思考写进 `delta.content`，客户端当正文渲染，会话里出现「让我先一步一步来…」「The user is pushing back…」这类看起来像乱码的文本。
- **根因**：`reasoning_effort` 归一化 `_normalize_effort`（off/none/空 → floor，默认 low）只存在于 8088 Python 网关的 `gateway/api/openai.py`；WS relay 通道此前直接透传请求体，没有这道归一化。而当前 PC 默认走 relay（8088 未运行）。
- **修复**：`src/hooks/loader.mjs` 新增导出函数 `normalizeWsReasoningEffort(json)`，在 WS 分支 `callUpstream` 发出请求前调用：缺档位 / `none` / `off` / 空 → 补 `low`（可由 `MARVIS_REASONING_EFFORT_FLOOR` 覆盖），别名 `xhigh/ultra → max`、`minimal/tiny → low`；合法档位 `low/medium/high/max` 不动。思考因此走 `reasoning_content` 独立通道，不再污染正文。
- **测试**：新增 `tests/ws-reasoning-effort.test.mjs`（7 例：缺档位、none/off、合法档位、别名、reasoning 字段兜底、非对象、环境变量覆盖）。
- **注意**：这是止血（思考不进正文），不解决设备 qimei36 被腾讯硬拉黑导致的 502/429；换设备号才能恢复出答案。

## 0.9.8 — 2026-11-28

**瘦身：删除手机端（Termux/remote 会话域/Android FFI）与手机登录，插件回到 PC-only**

- **删除 `remote` 传输**（openclaw 远端 wss + connect/chat.send 协议 + handshake/frames
  抓包凭据 + killCmd 抢会话）：该路径需要 15-20 分钟短命的抓包凭据、与 PC 同源风控域、
  从未实测成功，无维护价值。`MARVIS_WS_MODE=remote` 存量配置自动归一化为 relay（不报错）。
- **删除 Android 出票**（fingerprint.mjs 的 `androidBunUskey` / bun:ffi dlopen 路径 +
  Android 默认出票地址 4617）；uskey 出票保留 Beacon native 与 MARVIS_USKEY_URL 外部服务两条。
- **删除手机登录**（mobile-login.mjs 566 行 + 粘贴码服务 + phone-setup.sh +
  magpie-marvis-diag.sh + build-phone-kit.mjs）：methods() 只保留 PC 桌面登录
  （QQ/微信扫码 + 从本机 Marvis 导入 + 无头粘贴回调地址）。
- **文案清理**：loader/failure-hints 中所有 remote/handshake/手机端指引改为 relay/PC 客户端；
  `shouldAutoWsFallback` / `enhanceRiskMessage` / `connectionFailureHint` 去掉 mobile 参数。
- **测试**：删除 mobile/remote/phone 相关测试 4 个；更新 failure-hints/openclaw/qa-config/
  qa-concurrency/optimization-083/loader-model-support 断言；qa-persistence 从 bun:test
  转 node:test（仓库 test 脚本是 node --test，bun: 协议在 node 下无法加载）。
  全量 **462 例 / 0 失败 / 5 skipped**。
- **净减约 1100 行**（openclaw.mjs 815→约 500、fingerprint.mjs 671→约 600、
  mobile-login.mjs -566、脚本 -2 个）。

## 0.9.7 — 2026-11-28

**额度卡片显示真实消耗（与客户端 App 同源）+ reasoning_effort 思考档预算自动补偿**

- **真实用量显示**：额度卡片从「永远 10,000,000/10,000,000（上游钱包接口 `used_tokens` 恒为 0）」
  改为优先走本地网关的 `token.conversations_usage`（与 Marvis 客户端 App「今日消耗 Token」
  完全同源的数据），显示「今日消耗 X / 共 10,000,000（N 个会话）」+「全部会话累计」。
  网关不可达（客户端没开）时静默回落 HTTP 钱包，行为与旧版一致；`MARVIS_USAGE_WS=0` 可关。
- **协议实测踩坑两则**（都已写进代码注释与测试）：
  ① `conversations.list` 的 `limit` 上限 100（首版默认 200 → `ok:false "limit must be an
  integer between 1 and 100"` → 被静默跳过 → 超时回落钱包）；现已 clamp 进 1..100。
  ② `usage()` 内部会对 windows 再跑一遍 `usageWindow()`——先包一层再传入会把 `textOnly`
  标记剥掉，第二轮按普通窗口查 `used` 抛错被 catch 吞掉、静默回落钱包；现在网关分支
  只传原始字段。
- **reasoning_effort 思考档预算补偿**（文档第九节）：`reasoning_effort=max` 时模型先思考
  3-4 万 token，`max_tokens=16000` → 上游 502 空正文；现在 loader 自动把用户给出的
  `max_tokens`/`max_completion_tokens` 抬到 64000（两个都没给且 effort=max 时补
  `max_tokens=64000`；high 档只在用户给了偏小预算时才抬；用户显式 ≥64000 不动）。
  `MARVIS_MAX_TOKENS_FLOOR=0` 可关。
- 测试：新增 `tests/usage-gateway.test.mjs`（5 例）与 `tests/reasoning-budget.test.mjs`
  （9 例），合计 71/71 pass。

## 0.9.6 — 2026-11-28

**并入 8088 本地网关源码（`gateway/`），原独立仓库 `Marvis-proxy-public` 归档**

- `gateway/` = 纯 Python 标准库实现的 OpenAI / Anthropic 兼容网关（默认 `http://127.0.0.1:8088/v1`），
  原先单独发布为 `cat-clash/Marvis-proxy-public`；两仓同源维护容易出现版本漂移，现统一并入本仓库。
- 只并入**源码**：`gateway/.gitignore` 排除 `data/` `logs/` `backups/` `native/`、设备指纹（`qimei36.txt` /
  `marvis_appkey.txt` / `client_keys.txt`）、`__pycache__`，以及 `tools/bionic_shim/*.so` 预编译产物
  （由 `tools/bionic_shim/build.sh` 现场重建）—— 公开仓库里不留运行数据与二进制。
- 根 `README.md` 增加「内置 8088 本地网关」一节：启动方式、Web 控制台地址、首次提取出票 DLL 的步骤。
- 插件行为无变化（`gateway` 传输通道与 `localgateway.mjs` 的探测逻辑未改）。

## 0.9.5 — 2026-11-28

**4100404 熔断闸对 WS 通道生效 + 按响应延迟区分「设备硬拉黑」与「节奏限流」**

- **实测背景（2026-11-28，本机）**：relay（PC WS）、HTTP 直连、官方 PC 客户端三条通道、
  两个不同账号（QQ / 微信）在**同一秒**被上游拦下，唯一共因是设备号 qimei36。
  403+4100404 延迟 73–307ms（<800ms 判据）⇒ 设备被**硬拉黑**，与账号 / IP / 传输无关。
- **修复 1 —— 熔断闸失效（`loader.mjs` 风控闸）**：旧条件 `!openclawEnabled() && (breaker.open || …)`
  让 WS 模式（relay / remote）**整条熔断闸被跳过**，而 WS 路径自己的
  `risk_control_blocked` 分支又在 `breaker.record(false)` —— 记了失败却没有任何一处读它。
  实测后果：宿主默认重试 7 次，一次用户请求 = 7 次真实撞击上游
  （usage.jsonl 每条 ~34.8s ÷ 单次 ~4.95s ≈ 7），`breaker-state.json` 的 failures 全程 0。
  现在闸对所有传输生效（`MARVIS_RISK_GATE_WS=0` 可退回旧行为，不推荐）。
- **修复 2 —— 节奏闸同理**：WS 与 HTTP 是同源风控域，WS 路径同样过 `pacingWait`
  （`MARVIS_PACE_WS=0` 可退回）。
- **修复 3 —— 硬拉黑 / 限流分流（新判据）**：403+4100404 且往返 <800ms（
  `MARVIS_HARD_BLOCK_MS` 可调，0 = 关闭）⇒ 文案改判「设备硬拉黑」，明确告知
  换账号 / 换 IP / 切 WS / 等冷却全部无效，唯一出路是换服务端签发的 qimei36；
  ≥800ms 维持原「账号级节奏风控」文案。硬拉黑时跳过自动 WS 回退
  （同源域，回退只会多撞一次；`MARVIS_RISK_AUTO_WS_HARD=1` 可强制保留）。
- **文档修正**：冷却文案不再建议「设 MARVIS_WS_MODE=remote 改走 WS 通道」——
  2026-11-28 实测 remote 与 HTTP 同源被封，旧文案会误导用户做无效操作。
- **验证**：全量测试 487 pass / 4 fail（4 个失败与基线 0.9.4 完全一致，均为本机
  8088 网关探活等环境预存问题，非本版引入）；`loader-model-support` 35/35
  （新增限流分支用例，硬拉黑分支用例按新文案改写）。
- 附：完整根因链（三通道同秒封禁证据、qimei.dll「拒绝交付」状态机、本机唯一真号
  已入黑名单）记录于工作区 `KNOWN_ISSUES.md` BUG #7。

## 0.9.4 — 2026-11-27

**修复 relay 模式被 BOM 配置打成 auto，导致 openclaw 协议错发到 PC AG-UI 网关**

**修复 relay 模式被 BOM 配置打成 auto，导致 openclaw 协议错发到 PC AG-UI 网关**

- **根因**：Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 UTF-8 BOM（EF-BB-BF）。
  Node 的 JSON.parse 不接受 BOM，fileConfig() 静默跳过 openclaw.json，于是 mode 从
  relay 落回 auto。auto 的 URL 是 10123，但旧代码把它送进 openclawRemoteStream
  发 {"type":"req","method":"connect"}；PC 客户端的 AG-UI 网关只认
  gateway.connected + event:"agent.run"，MarvisHost.log 明确回
  missing field event，插件 12s 后误报「握手无应答 / 前端独占会话」。
- **修复**：
  - fileConfig() 读取配置前 replace(/^\\uFEFF/, "")，BOM 配置也能解析。
  - auto 与 relay 一样走 gatewayChatStream（本地 AG-UI 协议），
    method:"connect" 只留给真正的 remote wss。
  - 新增 tests/openclaw-config-bom.test.mjs 锁住 BOM 回归。
- **验证**：修复前 probe-openclaw 显示 mode=auto，provider test 为 503 握手无应答；
  修复后 mode=relay / fileMode=relay / token=found，错误变为正常的
  429 risk_control_blocked（PC WS 也被风控拦时的标准错误），说明协议错位已消除。
- REA 仓库（cat-clash/REA）全库无 Marvis/openclaw/10123 条目；本修复依据插件源码与
  MarvisHost.log 实测，不引用 REA 作为技术来源。

## 0.9.3 — 2026-11-27

HEAD
**并发回到 3（0.8.8 的 1 太保守，agent 并行任务全排队）**

- **改**：`package.json` 的 `magpie.maxConcurrency` 由 **1 → 3**。
- **理由**：0.8.8 降到 1 是为了把 4100404 节奏风控压到最低，方向对，但代价被低估了 ——
  完全串行 + pacing（默认 800ms 间隔 / 400ms 抖动）意味着**任何并发都会被排成队**：
  agent 同时跑 3 个 subagent 时总耗时约为单发的 3 倍，体感是"插件变卡"。
  3 是折中：仍在"像人"的节奏量级（相邻请求仍受 pacing 闸约束），又不至于把并行按死。
- **可调**：仍按 0.8.8 的约定改 `package.json` 即可。若观察到 4100404 变多，
  先降回 2 再观察；需要更高吞吐请走多账号 + `MARVIS_PACING_SCOPE=account`
  （每号独立时间轴），而不是继续提高单设备并发。
- **注意**：`maxConcurrency` 是宿主在加载插件时读的，改完需要重载插件或重启 magpie 才生效。

1958888 (fix(0.9.3): strip BOM in openclaw config and route auto through AG-UI relay)

## 0.9.2 — 2026-11-27

**删掉「首行文本」面板（宿主布局撑不下）+ 修正令牌额度文案**

- **删面板**（package.json 的 magpie.panels → []）：多轮截图证实宿主给 provider 面板的
  高度只够一行，且不把面板高度计入布局 —— 任何面板内容都会压到下面的「高级」折叠行上。
  换边框、换字号、压成文字链都治不好。首行文本改在**插件选项 JSON** 里配置：
  {"提示词首行替换": "你的首行文本"}（optionsExample 已给示例）。那一行彻底消失。
  tests/panel-manifest.test.mjs 同步放宽为「允许 panels 为空数组」。
- **令牌额度文案**（src/hooks/usage.mjs）：实测上游 /v3/marvis_get_wallet 返回
  {"total_tokens":"10000000","used_tokens":"0",...} —— 这 1000 万是营销额度，实际请求
  走免费通道、不扣令牌。照实显示会被误读成「额度没生效」，现在 used=0 时显示
  共 10,000,000 tokens（上游未扣减）；有真实消耗时仍显示 X 可用 / 共 Y。
- **修 recordFailure 的 require bug**：ESM 模块里 require 未定义，被 try/catch 吞掉，
  钱包读取失败时诊断文件永远写不出来。改为顶部 import { mkdirSync, writeFileSync }。

## 0.9.0 — 2026-11-27

**「首行文本」面板压成一行按钮：彻底解决与「高级」行重叠**

- **根因**：宿主给 magpie.panels（slot: provider）的高度只够**一行**。旧面板塞了
  「label + 值 + 设置按钮 + 状态行」，高度超出后把下面的「高级」折叠行挤上来，
  表现为文字重叠（两张截图实测）。改 CSS 局部数值治不好——是结构本身就超了一行。
- **改法**（panel/first-line.html · first-line.js · first-line.css）：
  面板里只留**一个按钮**，按钮文字就是当前值（空值显示「内置兜底句」），末尾一个 ›。
  长句单行省略、完整文本挂 title；点按钮仍弹出原来的 <dialog> 输入框。
  状态行改为 :empty { display: none }，空着时不占任何高度。
  同时修掉一处会覆盖按钮结构的 textContent 赋值。

## 0.8.9 — 2026-11-27

**修复面板标签重叠：宿主已按 panels.title 渲染字段名，面板内不再重复写一遍**

- **问题**：设置页「首行文本」一行里，宿主渲染的字段名和面板内部的 .fl-label 两处「首行文本」
  叠在一起，显示成「首行文本（内置兜底句）」并对不齐。
- **修复**（\panel/first-line.html\ / \first-line.js\ / \first-line.css\）：
  删掉面板内部的重复 label 与对应 CSS；空值文案由「（内置兜底句）」改为「内置兜底句」。
  现在该行只剩「当前值 + 设置…」，字段名完全交给宿主。
- 顺带：\auth.options\ 的两条开关标签缩短到一行内（不再压到下面区块）。
  - \first_line_fallback\：拒绝时兜底改首行（403）
  - \first_line_always\：每个请求都改首行

## 0.8.8 — 2026-11-27

**并发默认降到 1：把多账号/高频突发的 4100404 风险压到最低**

- **改**：package.json 的 magpie.maxConcurrency 由 8 改为 **1**。
  腾讯的 4100404 是账号级自适应风控，看的是**请求节奏分布**：并发 8 时同一时间窗内
  多个请求会被画成自动化尖峰，触发后冷却时间还会被后续重试拉长（issue #71 同源）。
  串行 + pacing（默认 800ms 间隔 / 400ms 抖动）+ breaker（默认 5 次触发 30min 冷却）
  三者配合，才把"像人"的节奏守住。
- **说明**：maxConcurrency=1 不是性能退化 —— 上游对同一设备的并行本来就不友好；
  需要更高吞吐时应走多账号 + MARVIS_PACING_SCOPE=account（每号独立时间轴），
  而不是提高单设备并发。
- 可调：需要临时放开时改 package.json 的 maxConcurrency（不改代码逻辑）。

### 动态模型（`MARVIS_DYNAMIC_MODELS=1`）

- **实测**：上游直连 `https://yybadaccess.3g.qq.com/v1/models` 一律 **404**（腾讯没有列模型接口）；
  本地 8088 网关 `/v1/models` 返回 **200 + 真实清单**（实测 7 个：`deepseek-v4-1-flash-261017`、
  `deepseek-v4-pro-external`、`deepseek-v4-flash-202605`、`deepseek-v4-flash-ga-260731`、
  `hy3`、`HY-Vision-2.0-instruct`、`marvis-vision`）。
- **实现**（`src/hooks/models.mjs`）：`MARVIS_DYNAMIC_MODELS=1` 时，第一次调用 models 钩子
  从网关 `/models` 拉取；结果缓存 1 小时；拉不到（网关未启动 / 直连上游 / 网络错误）回落静态表。
  **默认关闭**——直连模式下静态表就是唯一权威，不改变现有行为。
- 可调：`MARVIS_GATEWAY_URL` 改网关基址（默认 `http://127.0.0.1:8088/v1`）。
- 边界：动态清单只反映**网关**侧的模型目录；上游本身没有列模型能力，直连时无法动态发现。

## 0.8.7 — 2026-11-27

**根因：PC 4100404 不是设备拉黑，是 HTTP 直连风控；绕开 HTTP 走 PC 客户端 WS 网关（10123）即可**

- **核心发现**：PC 客户端走 ws://127.0.0.1:10123 本地 WS 网关（qimei36 由 MarvisHost 进程持有，init success=true, q36 length=36），不走 HTTP 直连；HTTP 直连才触 4100404。插件自动探测失败前会回落 HTTP，导致误判“设备被拉黑”。
- **修复**：openclaw.json 写 {"mode":"relay","relayUrl":"ws://127.0.0.1:10123/"}，强制走 PC 客户端 WS 网关，实测 chat 1181ms 全链路通（纯配置驱动，不依赖环境变量）。
- **doctor 新增 [5/4] openclaw relay 检查**：探测 openclawStatus() 模式 + 10123 端口 TCP 可达性；MARVIS_WS_MODE=off 时直接标记为 fail 并给出“改回 relay”的修复提示，避免用户被 4100404 带偏。
- **前提**：PC Marvis 客户端必须运行（10123 在监听）；客户端关闭后 relay 断，插件会回落 HTTP。

# 更新记录

## 0.8.5 — 2026-11-26

**修复会话刷屏根因：用户显式 off 时仍自动连 10123 建会话**

- **修复（shouldAutoWsFallback 忽略 mode=off）**：HTTP 直连模式下遇到风控/异常，旧版会自动回退到真实 Marvis 10123 网关并发一条新请求，每次都在 PC 客户端建一条新对话。现在 mode=off 显式禁止自动回退（failure-hints.mjs）；测试文件也加 MARVIS_RISK_AUTO_WS=0 总开关，避免 QA 跑测试时误连真实网关。
- **QA 测试合入主仓**：qa-e2e(9)、qa-concurrency(9)、qa-persistence(19)、qa-config(41) 共 78 条行为级测试 + regression 报告。

## 0.8.4 — 2026-11-26

**并发安全、会话防刷屏与指纹可靠性：三项高优先级 + 会话复用 + 六项中优先级优化**

- **修复（自动 WS 回退的全局 env 竞态）**：4100404 自动切 relay 不再写 `process.env.MARVIS_WS_MODE`，改为 `mode:"relay"` 单次请求参数透传（`cfg(modeOverride)`），消除 await 窗口期并发请求被串味。
- **修复（403 自愈链绕过节奏闸）**：兜底句 / 4 句候选池 / U+2060 护栏三处重试全部走 `pacedRetryUpstream`，纳入账号节奏闸；`MARVIS_RETRY_PACING=0` 可关。
- **修复（会话刷屏）**：一次宿主逻辑请求（含所有 403 重试与自动 WS 回退）只生成一条 `conv_*`，贯穿 `gatewayChatStream`；`MARVIS_GATEWAY_CONVERSATION_ID` 可把全部插件流量钉在一条会话。
- **修复（Beacon 版本写死）**：`appVersion()` 自动从客户端日志 `client_platform_version` / 安装目录探测（本机 1.60.3600.59），`MARVIS_APP_VERSION` 仍最高优先；诊断新增 `appVersion` / `appVersionSource`。
- **首行自愈记忆**：`(账号桶, 原首行 hash) → 成功改写句`，TTL 24h，被拦即失效，命中后省掉整条重试链。
- **指纹可靠性**：`reloadFingerprint()` + `nativeMtimeMs()` 供 CLI/doctor 检测客户端升级；qimei36 先扫已知 `qimei_debug_*.log` 快路径，命中跳过全盘递归；`MARVIS_USKEY_TIMEOUT_MS` 可配（默认 5s）；`externalQimeiByAccount` 按账号缓存，修掉多账号互相覆盖。
- **诊断健壮性**：`riskEvents` 最近 20 条随 `breaker-state.json` 落盘（重启可恢复）；pacing `axes` Map 超 128 条时回收 1h 前的过期 key。

## 0.8.3 — 2026-11-25

**风控文案扣留：WS 通道的拦截文案不再伪装成正文；`risk_control_blocked` 与 HTTP 4100404 同口径回 429**

- **修复（WS 通道风控拦截文案当正文流出）**：2026-11-25 直连 PC 客户端 10123 实测帧序 ——
  拦截文案 delta（+496ms）与 `RUN_ERROR code=risk_control_blocked`（+513ms）只差 ~17ms；delta 一到就
  yield 的话，loader 只预取首帧、拿到文本就锁定 200，之后 RUN_ERROR 只能把流截断，表现为
  「200 + 一句『当前环境有误…』假回复 + 没有 finish_reason / [DONE]」。
  现在 `gatewayChatStream` 对本轮**第一段** delta 做短暂扣留（`MARVIS_RISK_HOLD_FIRST_MS`，默认 800ms
  兜底放行）：第二段到达立即放行（正常流式只差两个字符的间隔，观感不变）；命中风控文案（`RISK_RE`）
  或终止信号定性为风控时，扣留内容随 `failStream` 直接丢弃，绝不作为正文流出。`status=failed` 不带
  code 的形态也按扣留文案自行定性（150ms grace 窗口等 RUN_ERROR 抢先）。错误统一带
  `err.code = "risk_control_blocked"`。真机复验：`THROW code=risk_control_blocked / textFrames=0 / leaked=false`。
- **修复（WS 风控被当网络故障连撞 7 次）**：loader catch 现在识别 `err.code === "risk_control_blocked"`，
  走 `riskResponse("risk_blocked", …)` —— 与 HTTP 直连 4100404 同口径回 **429 + retry-after**，并计入
  当前账号的熔断（0.8.0 起的账号分桶照常生效）—— 不再落进 503 upstream_unreachable 让宿主按默认
  策略连试 7 次把冷却越撞越长（issue #71 同源）。
- **回归测试**：`tests/gateway-stream.test.mjs` 10 → 13 条 —— `status=failed` 无 code 也定性风控、
  正常回复第一段扣留后原样送达（不丢帧）、loader 接线 WS 风控 → 429 + retry-after（stream true/false
  双测，拦截文案不进响应体）。逐文件隔离全量对比基线：本补丁还顺带修好了
  `loader-model-support` 里 18 条原先失败的用例（它们期待的正是这个 429 分支），其余失败与基线完全一致。

## 0.8.2 — 2026-11-25

- **429 配置自检：揪出「环境变量覆盖配置文件」这个隐藏根因**（真实踩坑）：`openclaw.json` 写了
  `mode=relay`，用户却一直看到「429 限流 / 令牌用满 10,000,000」，以为是官方真限流 —— 实际上是
  父进程继承了 `MARVIS_WS_MODE=off`，而 `src/marvis/openclaw.mjs` 的 `cfg()` 里环境变量优先于文件
  （`env("MARVIS_WS_MODE", f.mode)`），插件被劫持到被 `4100404` 拦的 HTTP 直连，再触发本地熔断 429。
  以前这条链路完全不可见，换账号 / 等冷却都没用。
  - `openclawStatus()` / `probe-openclaw.mjs` 新增三个诊断字段：`fileMode` / `envMode` / `overrideWarning`
    （不含密钥），并抽出纯函数 `wsModeOverride(envMode, fileMode, effectiveMode)`；env=off 覆盖 file=relay/remote
    时给出可行动提示（含 magpie 启动脚本里清继承值的写法）。
  - `src/hooks/loader.mjs` 的风控冷却 429 文案拼接 `overrideWarning` —— 用户看到 429 的当下就知道
    是配置被覆盖，而不是去换号 / 干等。
  - **彻底修法**：在启动脚本（如 `D:\magpie\start-magpie.ps1`）清理代理变量后加一行
    `[Environment]::SetEnvironmentVariable('MARVIS_WS_MODE', $null, 'Process')`，每次启动都清掉继承值。
    实测改完重启后 `mode=relay`、pinned 账号真实请求 STATUS 200、breaker 全清不再累积 429。
  - 测试：`tests/openclaw.test.mjs` 新增 4 例（off 覆盖 relay/remote 提示、一致/未设置不告警、其它组合通用提示）
    与状态字段形状断言。
- 版本同步：package.json / registry-entry.json / README.md / README-FINAL.md 全部 0.8.2。

## 0.8.1 — 2026-11-25

- **修两个 0.8.0 首版回归**（0.8.0 刚发出就被自查发现，务必升级）：
  - **① 全局冷却挡不住的问题**：0.8.0 的 loader 只检查 `breaker.open`（当前账号桶），没检查共因闸打开的
    全局桶 `"*"`。结果是多个账号接连被拦、通道级封锁已经触发时，所有账号仍然照常出网 —— 共因闸形同虚设。
    修复：`src/hooks/loader.mjs` 现在同时取全局桶 `channelBreaker`，`breaker.open || channelBreaker.open`
    任一开闸就本地 429；文案区分「账号级冷却（其他账号不受影响）」与「通道级冷却（所有账号都停）」。
  - **② 升级后全体被旧冷却挡住的问题**：0.8.0 把旧版 v1 扁平 `breaker-state.json` 读进 `"*"` 桶时原样继承了
    `openedAt`，用户升级后直接撞上历史遗留的几十分钟全局冷却 —— 与「一个号被拦不拖累其他号」的目标完全相反。
    修复（两层）：
    · v1 迁移只继承 `failures` / `consecutiveOpens` 诊断计数，**丢弃活跃冷却**；
    · v2 自愈：account 作用域下全局桶的冷却**只应来自共因闸**（带 `reason:"cross-account"` 落盘标记），
      无标记的全局 `openedAt` 一律当 0.8.0 残留清零；真共因闸 `trip()` 落盘写 reason，重启后照常生效。
    实测用户真实污染文件（`"*"` 桶 39m 残留）升级后显示「无冷却」，账号桶自己的 1.8h 冷却保留。
  - 测试：`tests/account-isolation.test.mjs` 新增 5 例回归防护（残留自愈、真共因冷却保留、trip 落盘 reason、
    loader 双桶检查、v1 计数保留但冷却不继承）；`tests/breaker.test.mjs` 的时钟测试改用账号桶避开自愈逻辑。
    全套 410 例 404 pass / 0 fail / 6 skip，check.mjs 40 通过 / 1 警告 / 0 失败。

## 0.8.0 — 2026-11-25

- **按账号隔离：风控熔断与请求节奏闸都改成 per-account 分桶**（默认开启）。用户反馈「登录多个账号时，
  个别账号被限流会让其它账号一起不可用」—— 根因是 `src/breaker.mjs` 的 `riskBreaker` 与
  `src/pacing.mjs` 的 `pacingWait` 都是**进程级单例**，`breaker-state.json` 也只有一个扁平状态槽：
  magpie 壳每次请求只传当前选中的那一个账号（`src/hooks/loader.mjs` 的 `credsOf(auth)`），插件侧没有
  账号池，于是「谁被拦」的信息在状态层被抹平 —— 一个号熔断等于所有号全停。
  - `createBreaker({ bucket, label, onOpen })`：状态升 v2
    `{version:2, accounts:{[bucket]:{label,consecutiveOpens,openedAt,failures}}}`；读到 v1 扁平格式整体归入
    全局桶 `"*"`（老用户已有冷却不丢）；写盘只改自己那个桶，不动兄弟桶。
  - `accountKeyOf(creds)` = `sha256(openid|uid)` 前 12 位（不落 openid 明文）；
    `accountLabelOf(creds)` = 首 4 + 尾 4 脱敏标签（报错文案与 CLI 展示用）。
  - `getBreaker(bucket, label, opts)` 进程级池；`riskBreaker` 保留为全局桶实例 —— 旧导出形状不变，
    `tests/breaker.test.mjs` 的兼容断言照旧通过。
  - `pacingWait(key)`：每个账号一条独立时间轴，A 号在等最小间隔时 B 号立刻放行；
    无参调用仍落 `"*"` 桶（旧行为/旧测试不变）；`MARVIS_PACING_SCOPE=global` 回到总速率压平。
  - **跨账号共因闸**（保留原来那层保护）：`MARVIS_RISK_WINDOW_MS`（默认 10min）内 ≥
    `MARVIS_RISK_CONSENSUS`（默认 2）个**不同账号**各自开闸 → 判定拦的是通道（IP / UA / uskey / 上游节点），
    自动把全局桶也打开。`MARVIS_RISK_CONSENSUS=0` = 纯隔离，永不自动升级。
  - `MARVIS_RISK_SCOPE=account|global` 选择熔断作用域，默认 `account`；未知值当 `account`。
  - 报错文案改为「账号「XXXX」风控冷却中…（**其他账号不受影响**）」，并指向解封命令；
    4100404 的 429 文案补上「只有这一个账号被拦 = 账号级；多个账号接连被拦 = 通道级」的区分。
  - 新增 `scripts/breaker-cli.mjs` 与 `node scripts/cli.mjs breaker [list|reset]`
    （`list --json`、`reset <bucket|label 子串>`、`reset --all`）。
  - 新增 `tests/account-isolation.test.mjs`（18 例）：A 开闸 B 照常可用、v2 多桶落盘互不覆盖、v1 迁移进全局桶、
    共因闸开/关、pacing 分桶与 global 回退、无参向后兼容、`breakerBuckets` / `resetAllBreakers`、
    CLI 的 `--help` / `list --json` / `reset` / `reset --all`，以及 loader 接线断言（不回归到进程单例）。
  - 测试：全套 **406 例 400 pass / 0 fail / 6 skip**；`scripts/check.mjs` 40 通过 / 1 警告 / 0 失败。

## 0.7.16 — 2026-11-25

- **仓库转私有后的 phone-kit 下载说明**（纯文档，插件行为不变）：匿名访问 Release 附件直链会返回 404，
  raw 文件也返回 404。`README-FINAL.md` 的 phone-kit 小节改为指向 Release 页，并给出两条可用下载方式：
  ① 手机浏览器先登录 `github.com/cat-clash`；② 电脑上用已登录的 gh CLI
  `gh release download v0.7.16 -R cat-clash/magpie-marvis -p '*.zip'`，再把 zip 用微信文件传输助手/数据线送到手机。
  Release 附件里的插件文档同步为本版本。
## 0.7.15 — 2026-11-25

- **补齐真正能用的手机 phone-kit Release 附件**（此前文档写了「下载附件」，但仓库没有任何 Release，手机端只能拿到插件、拿不到 8088 网关，于是请求仍落到默认的 `ws://127.0.0.1:10123/` 而 503）：
  - 新增 `scripts/build-phone-kit.mjs` + `tests/phone-kit.test.mjs`：自包含 store ZIP 写出器（固定时间戳、
    UTF-8 标志、Unix 权限位，`.sh` 0755），把**插件本体 `plugin/` + Python 网关 `Marvis-proxy-public/` +
    `phone-setup.sh`** 打成一个 `magpie-marvis-phone-kit.zip`。Python `zipfile.testzip()` 通过，
    `phone-setup.sh` / `run.sh` 解压后均为 `0755`。
  - `phone-setup.sh` 修掉路径不一致：脚本原先一边从 `$DIR/scripts/` 复制诊断脚本、一边提示导入
    `$DIR/plugin/`。现在自动识别 `PLUGDIR`（Release 包在 `plugin/`，直接 clone 时就是仓库根），
    复制路径与提示统一用 `$PLUGDIR`。
  - `README-FINAL.md` 的 phone-kit 小节补上 v0.7.15 附件的直接下载链接；zip 的 sha256 仍只以 Release
    页面的 asset digest 为准（文档会随包一起变，写死必然过期）。
## 0.7.14 — 2026-11-25

- **把「导入电脑端登录态」提为手机端首选路径**（只改文档排序与措辞，插件行为不变）：
  - `README.md`：「0.7.4 – 0.7.14 新增」的第一条换成「**首选：直接把电脑端登录态导到手机**」
    （`node scripts/cli.mjs import-login login.json --yes`：不用扫码、不用守着电脑），
    原微信扫码条目改标题为「**备用：微信登录是「电脑出码 + 手机扫」**」并退到第二位。
  - `README-FINAL.md`：原「更省事：把电脑端登录态导到手机（0.7.10）」整节**前移**到
    「微信在手机上为什么一定要「电脑出码」」之前，标题改为「首选：把电脑端登录态导到手机
    （0.7.14 起首选路径）」，并补一句「为什么把它提到最前」；下面那套扫码流程标注为
    「**备用路径**」，第 4 步末句由「改用下面的 CLI 导入登录态」改为「直接用上面「首选…」」。
  - 微信网页授权（`wxWebAuthUrl`）保持原状：仍只作为页面底部的「公众号网页授权（实验）」链接，
    不参与登录主链路 —— 它的 appid 是网站应用，`oauth2/authorize` 在微信内必然 10005。
## 0.7.13 — 2026-11-25

- **`scripts/magpie-marvis-diag.sh` 的收尾换成能直接判读的**（只改诊断输出，不改插件行为）：
  - 新增 `CODE_MEANING` 段解释 `models_http_code`：`200` = 网关活着且能应答，但**不代表**网关侧有登录账号
    （`no_account` 的 503 仍可能）；`401` = 网关开了 `MARVIS_GATEWAY_KEY` 而 `gateway.json` 的 `key` 是空串
    （源码 `localgateway.mjs:184` 是 `if (c.key)`，空串不带鉴权头）；`000` = curl 不可用或请求超时，
    **不等于**网关没登录；其他非 200 → 看网关侧日志。
  - 「建议的手机 HTTP 网关最小修复」改成三步主次分明：① **首选 `--fix`** —— 它自己写含 `schemaVersion:1`
    的 `gateway.json`，端口从 `~/Marvis-proxy-public/config.json` 取（不会把端口写死 8088）；② 手工
    `printf`/`cat` 只是 `--fix` 跑不了时的降级；③ `export` 只对当前 Termux 会话有效，持久化靠 `gateway.json`。
  - `FIX_RESULT.next` 从「再跑一次本脚本」改成可执行判读：`listening=0` → 看 GATEWAY 行与
    `~/.magpie-marvis-native/gateway-start.log`；`listening=1` 仍 503 → 网关侧账号池是空的。
  - `NEXT_ACTION` 的「8088 有监听但非 200」分支补上 `401`/`000` 的区分。
- 测试：`tests/diag-script.test.mjs` 5 例 + `tests/failure-hints.test.mjs` 10 例全过（15/15）。
## 0.7.12 — 2026-11-25

- **撤掉本机引导页里的粘贴框**（真机反馈：在那儿提交显示「登录成功」，插件里却没有账号）：
  根因是壳只有在 `callback()` 被调用、且**没有**给粘贴内容时才去 await `paste.wait`；
  用户在本机页提交时壳根本没被通知，结果没人取 → 不写 `plugin-auth.json`；
  更糟的是那一次 `code` 已被页面这一侧换成登录态，再粘回壳的 Code 框反而报错。
  现在：`formPage()` 不再渲染 `<textarea>`/`name="callback"`/「完成登录」按钮（也不再暴露一次性 token），
  改成「第 2 步：把 `yybadaccess…code=…` 整条复制，**回到 magpie 的登录界面**，粘到那里的 **Code** 输入框」，
  并明确写「这个页面不接收粘贴」。`POST /submit` 一律回 **410**（页面已停用），不做换取、不消耗 code。
  `mobileOauthLogin().callback()` 的「等本地页」分支直接抛可操作错误（不再白等 10 分钟），
  `startPasteServer` 的 `wait` 只剩超时/取消信号（`settle` 死代码删除）。
- 测试：`startPasteServer` 的 GET 断言改成「没有 textarea / 没有完成登录 / 不暴露 token / 要指向 Code 框」；
  `POST /submit` 断言 410 且不写盘；新增 `exchangeFromPaste` 空内容/无 code/无 state 的可读错误断言。
## 0.7.11 — 2026-11-25

- **把 0.7.10 没扫干净的旧文案全部对齐**（行为不变，只改文字与注释）：
  - `src/hooks/methods.mjs` 的「微信登录（浏览器 · 粘贴回调地址）」入口 —— 这条是手机上**用户真能看到**的说明，
    之前还写着「唤起微信 App → 文件传输助手 → 微信里点『允许』」（0.7.7/0.7.8 的老路径）。
    现在改成「复制授权链接 → **电脑浏览器**打开出二维码 → 这台手机微信『扫一扫』→ 电脑跳
    `yybadaccess…code=…` 后整条粘回来」，并写明二维码必须显示在另一块屏幕上、不要存图片再扫。
  - `src/marvis/login.mjs` 的 `wxWebAuthUrl()` 文档：不再说「手机端优先用这个」，改为
    「**实验/说明用途**，对 Marvis 的 appid 必报 10005，不要设成手机主链接」。
  - `src/marvis/mobile-login.mjs` 的文件头原因 1、`wxAppLaunchUrl()` 文档、`formPage()` 注释、
    `copyScript` 回退注释：统一改成 0.7.10 的结论（网站应用只有 `snsapi_login`；
    `weixin://` 只能唤起微信本体、对扫码无帮助，已撤出主按钮；不支持 `navigator.share` 时回退到**复制**而不是唤起）。
  - `README.md` / `README-FINAL.md`：修掉两处 markdown 粘行、清掉两个「〔待主控核对〕」占位符、
    给 0.7.7 的「分享到微信」历史条目加上「0.7.10 起主路径已改」的指向说明。
- 测试：`mobile-login` + `wx-share` 54 例全过；`check.mjs` 40 通过 / 1 警告 / 0 失败。
## 0.7.10 — 2026-11-25

- **微信登录方向纠正（真机两次打回后的结论）**：Marvis 的 appid 是**网站应用**，只有
  `snsapi_login`（`qrconnect` 扫码）；它**不是公众号**，所以 `connect/oauth2/authorize`
  （0.7.8 的 snsapi_userinfo、0.7.9 的 snsapi_base）在微信内一律报
  **「此公众号并没有这些 scope 的权限，错误码:10005」**。改 scope 解决不了，是 appid 类型问题。
  微信又已禁止长按/相册识别二维码（「该二维码仅支持在扫一扫时通过摄像头来识别」），
  一台手机扫自己屏幕走不通。于是手机端主路径改为：
  **复制授权链接 → 到电脑（或第二台设备）浏览器打开出二维码 → 这台手机微信「扫一扫」→
  电脑跳到 `yybadaccess…code=…` → 整条粘回来**。
- 微信引导页：主按钮换成「复制授权链接（粘贴到电脑浏览器打开）」+ `copyWxMain()`；
  「分享到微信」降为可选次按钮；不再放 `weixin://` 主链接（唤起微信对扫码没帮助）。
  文案与 `mobileInstructions("WX")`（7 步）、`WECHAT_OPEN_HINT` 全部改为「二维码必须在另一块屏幕上」，
  并明确写出 10005 是 appid 类型问题、页面下方「公众号网页授权（实验）」对 Marvis 无效。
- **新增 `scripts/import-login.mjs`**（`node scripts/cli.mjs import-login <文件.json> --yes`）：
  把电脑端导出的一份 `{"marvis#xxxx": {...}}` 登录态合并进本机 `plugin-auth.json` ——
  手机扫码这条路走不通时，直接把电脑已登录的账号搬过去。带备份、原子写、`--dry-run`、
  `--overwrite`、`--json`，只合并 `marvis#` / `marvis-proxy` 前缀（不碰别的插件的凭据），
  目标文件不存在时自动建。测试 `tests/import-login.test.mjs` 13 例。
- 测试：`mobile-login`+`wx-share` 54 例、新增 `import-login` 13 例全过。
## 0.7.9 — 2026-11-25

- **修 0.7.8 的真机报错：微信网页授权 scope 改 `snsapi_base`**。0.7.8 把手机微信登录从
  `qrconnect`（扫码页）改成了公众号网页授权，方向对，但 scope 用了 `snsapi_userinfo`，
  真机在微信里点开链接直接弹：**「微信登录失败：此公众号并没有这些 scope 的权限，错误码:10005」**。
  10005 表示公众号未认证、没有 userinfo 权限；而 `snsapi_base` 是所有公众号默认具备的（无需认证），
  且我们只需要 code 去 Marvis 服务端换登录态（不需要昵称头像），base 完全够用 →
  `wxWebAuthUrl()` 的 scope 改为 `snsapi_base`。base 是静默授权：在微信里打开后**直接跳回**
  `redirect_uri?code=…`（不再弹确认页），页面文案随之改写（「直接跳转授权」而不是「点允许」）。
- **新增扫码备用链接**：万一网页授权仍被微信拒，本地登录页底部给出 `qrconnect` 扫码链接
  （`#wx-qr-url`，另一台设备或电脑打开来扫），并写明 10005 的应对。移动端 instructions 从 5 步增到 6 步。
- 抽出 `wxQrLoginUrl(guid)`（qrconnect 扫码），`authorizeUrl("WX", guid)` 改为复用它；
  `formPage` / `startPasteServer` 新增可选 `qrAuthUrl` 参数（不传则页面不渲染扫码块，桌面零影响）。
- 测试：`wxWebAuthUrl` 断言 scope=snsapi_base、新增 `wxQrLoginUrl` 形状测试、formPage 断言
  `#wx-qr-url` 与 10005 文案；`mobile-login`+`wx-share` 共 52 例全过。

## 0.7.8 — 2026-11-25

- **手机微信登录改用「网页授权」，一台手机直接确认（不再扫二维码）**：旧版手机端授权链接用的是
  `connect/qrconnect?scope=snsapi_login`（网站应用扫码登录），在微信里打开仍是一张二维码 ——
  用户截图实测卡死在微信的「该二维码仅支持摄像头识别，不支持相册读取」提示，一台手机扫不了自己屏幕的码。
  现在 `authorizeUrl("WX")` 之外新增 `wxWebAuthUrl(guid)`，生成
  `connect/oauth2/authorize?scope=snsapi_userinfo#wechat_redirect`（公众号网页授权），**在微信内置浏览器里
  打开直接弹「确认授权」页**，点「允许」后跳回 `yybadaccess…?code=…`，复制粘贴回 magpie 即可，全程不用扫码。
  QR 链接保留作桌面备用，QQ 逻辑不变；换取端 `parseCallback → exchangeCode` 只用 code + guid，不挑 scope，直接复用。
  - 实测依据（MicroMessenger UA + 本 appid）：`oauth2/authorize` → 301 → 标准网页授权入口（参数被接受）；
    `qrconnect` → 200 → 二维码页。
  - 页面文案同步：强调这条链接**必须在微信里打开**（系统浏览器打开只会显示「请在微信客户端打开链接」），
    移除已失效的「用系统浏览器打开」备用按钮；分享/复制/唤起按钮全保留。
  - 新增测试：`wxWebAuthUrl` 形状、微信 authorize 传网页授权链接给本地页、页面回显 oauth2/authorize，
    `mobile-login`+`wx-share` 共 51 例。版本全线 bump 0.7.8。

## 0.7.7 — 2026-11-25

- **撤掉登录菜单里的「账号管理」入口**：0.7.6 加的入口位置不对 —— 没登录时没账号可管，已登录的账号又不会去登录菜单里找「移除」。删掉 `src/marvis/account-manager.mjs` 与 `methods()` 手机分支的 `accountManagerMethod()`；账号管理仍走 Termux CLI：`node scripts/cli.mjs accounts list/logout/remove`（`--json`/`--verbose`、备份、幂等、歧义保护全保留），共享语义层 `src/marvis/accounts-store.mjs` 保留。
- **微信登录加「分享到微信（推荐）」主路径**：微信没有 QQ `mqqapi://forward/url?url=…` 那种能带网址的唤起协议（`weixin://` 只能开 App），上一版「唤起微信后没后续」。现在页面首选按钮调 `navigator.share({url:authUrl})` 直接把授权链接送进 Android 系统分享面板 → 选微信 → 文件传输助手 → 发送 → 微信里点开 →「确认授权」→「允许」；页面新增**初始可见**的 4 步后续块（`wx-next-steps`），把「右上角…复制链接 → 回 magpie 粘贴 Code」写清楚。不支持分享/分享取消时回退到 `copyWxUrl()` + `weixin://`（旧按钮全保留）。QQ 分支零改动。
- **手机 503 从「连不上」变成「照着做」**：`callUpstream` 的 catch 分支以前只回一句「连不上 Marvis 网关」，正是手机 openclaw WS 连 PC 端口 `ws://127.0.0.1:10123/` 失败时用户唯一看到的话。现在诊断按平台分流：手机明确告诉你「10123 是 PC 客户端端口，手机没有这个进程」，并给出 `sh ~/.magpie-marvis-native/magpie-marvis-diag.sh --fix`（写 `gateway.json` + 拉起本地 8088 网关）；桌面提示确认 PC 客户端或设 `MARVIS_WS_MODE=off`。响应体带 `error.diagnosis_hint`/`diagnose_command`，header `x-marvis-diagnosis: openclaw-10123-unreachable`。诊断纯函数在 `src/marvis/failure-hints.mjs`，新增 `tests/failure-hints.test.mjs` 10 例。
- **电脑端 4100404 风控自动 WS 回退**：以前命中 HTTP uskey 节奏风控只回 429 并叫用户手动设 `MARVIS_WS_MODE=remote`。现在桌面且本机 10123 relay 可达（1s TCP 探针）时**自动用 WS 重试一次**：成功直接返回 WS 响应；失败则在 429 文案里说清原因与下一步（含 `MARVIS_WS_MODE=relay`/`remote` + handshake 的出路）。手机不自动重试、显式 remote 不覆盖、`MARVIS_RISK_AUTO_WS=0` 可关、`MARVIS_RISK_STATUS=503` 保持旧行为。探针/决策/文案全在 `src/marvis/failure-hints.mjs`（纯函数、可单测）。

## 0.7.6 — 2026-11-25

- **壳里就能管理账号（含首选账号）**：手机端登录菜单新增「账号管理（取消登录 / 移除账号）」入口
  （`src/marvis/account-manager.mjs`）。点它 →「打开浏览器」→ 本机管理页（默认 `127.0.0.1:4619`，
  一次性 token 防 CSRF）上**每个账号**都有「取消登录」「移除」按钮 —— magpie 壳对首选账号不渲染
  移除按钮是壳侧 UI 限制，管理页不受它约束。只认整键（模糊选择器一律拒绝，防误删）；
  页面渲染时的账号快照作为并发基线，壳中途写回文件 → 409 可读错误、原文件不动；
  写盘前 `.bak-<时间戳>` 备份 + 原子替换。操作后需完全退出并重启 magpie（壳有内存态）。
- **微信登录不再直接打开二维码页**：`mobileOauthLogin` 给壳的 `url` 从 qrconnect 改成本机引导页
  （`paste.url`）。上一版壳「打开浏览器」直接开出扫码图片，用户根本走不到「唤起微信 + 复制授权链接」
  那套按钮；现在打开就是引导页，qrconnect 只留在页内的备用链接里。QQ 分支不变。
- **账号语义抽成唯一共享层** `src/marvis/accounts-store.mjs`：CLI（`scripts/accounts.mjs` 改薄壳）
  与管理页共用同一套选择器优先级 / logout 字段形状（`access:""`+`refresh:""`+`expires:1000`+
  `metadata.revokedAt`，身份字段保留）/ 乐观并发 / 备份原子写。该模块不 exit 不打印，错误一律 throw。
- **测试与宿主环境隔离**：`loader-model-support` / `legacy-model-loader` / `image-input` /
  `loader-revoked` 四个套件把 `MARVIS_NATIVE_DIR` 指向空临时目录 —— 宿主真实跑过插件时
  `~/.magpie-marvis-native/breaker-state.json` 里的 open 熔断状态会把所有出网断言打成本地
  429 `risk_cooldown`（本次 32 例假失败的根因）。新增 `tests/account-manager.test.mjs` 11 例
  （每账号两按钮 / logout 形状与备份 / 幂等 / remove 整删 / CSRF 403 / 模糊键 400 / 并发 409 /
  空目录 / 方法形状与 cancel / HTML 转义）；`tests/mobile-login.test.mjs` 钉住「微信壳 url 必须是
  本机引导页、不得是 qrconnect」与账号管理入口。全套 355 例 0 失败。

## 0.7.5 — 2026-11-25

- **诊断脚本 `--fix` 变成真自愈**：写完 `gateway.json` 后，如果 8088 上没人监听，脚本会按
  `MARVIS_PROXY_DIR` → `~/Marvis-proxy-public` → `~/marvis-proxy-public` → `~/Marvis-proxy`
  的顺序找 `run.sh`，执行 `sh run.sh start` 并轮询 `GET /v1/models`（最多 12 秒），最后打印
  `FIX_RESULT`（gateway_json / url / listening / next）。新增 `--no-start`（只写配置不起进程）与
  `--help`；启动日志落在 `~/.magpie-marvis-native/gateway-start.log`。
- **accounts CLI 可脚本化**：`list --verbose` 额外显示 `expires` 的 ISO 时间、剩余毫秒、`guid`、
  字段全集；`--json` 现在覆盖 `logout` / `remove`（stdout 只有一份结果：`action`/`dryRun`/`count`/
  `keys`/`already`/`backup`），`list --json` 补 `expiresAt`/`msLeft`/`nickname`。
  幂等的「已取消」场景返回 `count: 0` 且不产生新备份。
- **微信登录页少一步**：点主按钮唤起微信的同时把授权链接复制到剪贴板（`copyAndGo()`），
  按钮旁写明「顺手复制」，不用再切回浏览器手动复制一次。QQ 页保持原样（`mqqapi://` 自带 URL）。
- 新增 `tests/diag-script.test.mjs`：`sh -n` 语法、`--help`、只读模式不落盘、`--fix --no-start`
  的 `gateway.json` 形状、找不到 `run.sh` 时的下一步提示。`tests/accounts-cli.test.mjs` 增至 22 例，
  `tests/mobile-login.test.mjs` 补 `copyAndGo` 与「QQ 页不得出现 `copyAndGo`」断言。

## 0.7.4 — 2026-11-25

- 手机微信登录改为直接唤起微信 App：登录页主按钮用 `weixin://` 唤起微信，新增「复制授权链接」按钮，把授权链接粘贴到微信「文件传输助手」打开即可弹出「确认授权」页，一台手机即可完成。
- 不再引导「保存二维码图片再扫 / 长按识别图中二维码」（微信已收紧该链路，一台手机也扫不了自己的码）；系统浏览器打开授权页仅作扫码兜底。
- **新增账号管理：每个账号都能取消登录 / 直接移除**。`node scripts/cli.mjs accounts list|logout|remove`（也可
  `node scripts/accounts.mjs …`），不必再受「第一个账号删不掉」的限制：
  - `list` 列出本插件条目的 key / 卡片名 / QQ·微信 / 状态 / 可用选择器；
  - `logout <key|uid|卡片名>` 把 `access`/`refresh` 清空、`expires` 拨到过去、打 `metadata.revokedAt`，
    保留 `accountId`/`uid`/`guid`（重新登录还能复用同一张卡片和虚拟设备），并让 loader 回
    `401 + X-Magpie-Sign-In: expired`，壳上直接显示「需要重新登录」；
  - `remove <key|uid|卡片名>` 整条删除（插件没有上游登出接口，删本地凭据即可）；
  - 支持 `--dry-run` 预览、`--yes` 非交互确认、`--all` 批量取消（移除不支持 `--all`）；
    写盘前留 `.bak-<时间戳>` 备份、原子替换，并做乐观并发校验 —— magpie 正在运行时改文件会被拒绝。
- 修掉一个会拖住进程的监听句柄：本地登录页的 HTTP server 与超时定时器都不再参与保活
  （`server.unref()` / `timer.unref()`），新增 `cancel()` 供放弃授权时立刻释放端口；
  测试套件从「拖到 10 分钟超时才退」回到 4 秒。

## 0.7.3 — 2026-11-25

**手机 503 诊断 + 微信登录指引优化**

- 网关 502/503 错误响应补 `diagnosis_hint` / `diagnose_command`，直接告诉用户执行
  `sh ~/.magpie-marvis-native/magpie-marvis-diag.sh`。
- `phone-setup.sh` 把诊断脚本复制为 `~/.magpie-marvis-native/magpie-marvis-diag.sh`，并把
  `gateway.json` 写入 `schemaVersion: 1`。
- 微信手机登录页改为「优先在浏览器菜单/分享里选在微信中打开，让微信 App 授权；仍显示二维码时再长按识别」，
  明确不再引导下载/保存二维码图片扫码；保留备用授权链接、本机粘贴页与宿主粘贴输入框。
- README 标题与传输通道章节版本号同步到 0.7.3。

## 0.7.2 — 2026-11-24

**手机登录修复：把宿主的粘贴输入框和唤起按钮拿回来**

- **修复（手机上点 QQ / 微信登录「没地方粘贴、入口不见了」）**：0.7.1 的手机端返回
  `{ opened:true, method:"auto" }`，而宿主在这两种形态下渲染的内容不同（2026-11-24 用探针插件
  + `magpie plugin login` 实测）：

  | authorize() 返回 | 宿主渲染 |
  |---|---|
  | `opened:false` + `method:"code"` | 授权页 URL + instructions + **「Code:」粘贴输入框** |
  | `opened:true` + `method:"auto"` | 只有 URL + instructions，**没有「Code:」那一行** |

  0.7.1 正好是后者 —— 于是手机上点登录只剩一段文字：既没有输入框可粘，也没有「打开浏览器」
  按钮可点（用户截图现象）。现在手机端一律 `method:"code"` + 不设 `opened:true`，两个控件都回来。
  宿主协议层：`method === "code"` 时用户在「Code:」框里输入的内容会原样交给插件的 `callback(code)`。
- **恢复三个登录入口**：手机端重新提供 **QQ 登录 / 微信登录 / 浏览器·粘贴回调地址**（0.7.1 只留了两个）。
- **QQ 真正唤起手机 QQ App**：新增 `mqqapi://forward/url` 跳转 —— `display=mobile` 只决定网页版布局，
  **不会**唤起 App；本地登录页上「唤起 QQ」按钮与网页版兜底链接并存。
- **本地登录页升级**：页面上同时有「唤起 QQ / 微信授权」按钮与粘贴框；微信页给
  「长按二维码 → 识别图中二维码」提示（不用假的 scheme）。
- **测试**：新增宿主契约回归（手机端所有入口必须 `method:"code"` + 非 `opened:true`；
  桌面端保持 `opened:true` + `method:"auto"` 不变；本地页必须同时有唤起按钮与粘贴框）。

## 0.7.1 — 2026-11-24

**手机登录修补：粘贴入口在 authorize 阶段就给出**

- **修复（手机端授权完成后找不到粘贴入口）**：`mobileOauthLogin` 原先在 `callback()` 里才启动本地表单页，
  而 `instructions` 是 `authorize()` 的返回值 —— 用户在登录界面看到的只有「请粘贴地址」，
  拿不到入口 URL。手机上表现为「二维码扫完、授权点了，却没地方贴」。现在本地页提前到
  `authorize()` 启动并写进 `instructions`；`callback()` 只负责挂 abort 与等结果，结束一律 `close()`。
- **测试稳定性**：`npm test` 改为 `node --test --test-force-exit`；手机登录用例统一注入 fake server
  （残留 HTTP 句柄会让测试进程不退出）。

---

## 0.7.0 — 2026-11-24

**流式透传 + 风控强化：熔断指数退避与状态持久化、请求节奏闸、主动续期**

**正确性修复**

- **修复（directPost 流式响应中途 abort 失效）**：原先 abort 监听在响应头到达即被移除，客户端中途断开后连接挂到 600s 空闲超时才释放；现在 abort 全程有效，连接随流结束即清理。
- **修复（qimei36 客户端目录扫描负缓存）**：原先每请求都重复同步扫描 APPDATA；现加负缓存，扫描结果缓存复用（缓存粒度与失效条件〔待主控核对〕）。
- **修复（外部出票服务无超时）**：`MARVIS_USKEY_URL` 外部出票请求加 5s 超时，出票机卡死不再拖住整个请求链。
- **修复（网关探测通道与主路径不统一）**：网关探测通道与主路径统一，均走 `node:https` 强制直连，不再出现「探测走直连、请求走代理」的错配。

**手机登录（修复：手机端点 QQ / 微信登录完全没反应）**

- **根因（三条缺一不可）**：① 微信 `qrconnect` 是 PC 网站应用扫码页，手机上打开只有一张二维码，没有唤起微信的路径——用户看到「一张二维码」就没有下一步；② QQ 授权页被 `display=pc` 钉死为 PC 版，手机浏览器渲染账号密码表单，不唤起手机 QQ App；③ 手机 magpie 壳（1.6.6）的「粘贴 OAuth 回调」补丁按包名 `magpie-marvis` 打，本插件包名是 `magpie-marvis-final`，补丁不生效——`method:"code"` 那条路在手机上**连输入框都不弹**，这才是「点登录完全没反应」而非报错的原因。
- **修法（QQ）**：`src/marvis/login.mjs` 的 `authorizeUrl(loginType, guid, { mobile: true })` 手机端改用 `display=mobile`（手机浏览器会唤起已装的手机 QQ，否则走手机版网页登录）；**只改 display**，`redirect_uri` / `client_id` / `state` 一字不动——服务端只校验 redirect_uri（预注册死值）与 state（QQ 要小数形态）。display=mobile 是否被服务端接受**待真机验证**。
- **修法（微信）**：没有等价 display 开关，登录指引改为明确教「**长按二维码 → 识别图中二维码**」——这是手机上唯一能跳进微信的动作。
- **修法（绕开壳补丁）**：新增 `src/marvis/mobile-login.mjs` 自带**本地粘贴表单页**：`startPasteServer()` 起 `http://127.0.0.1:4618/`（被占用自动退随机端口，只绑回环），用户在手机浏览器把回调地址贴进去提交，插件在 `callback()` 里等结果；带一次性 token 防本机 CSRF、10 分钟超时、失败可在同一页重试。
- **登录方式排序（手机端）**：`src/hooks/methods.mjs` 的 `methods()` 检测到 `isMobile()` 时，两条手机登录排最前；网关占位账号从第一位挪到真登录之后（原先 gateway 模式时它霸占首位，用户以为只有这个选项）；「从本机 Marvis 导入」与桌面手动粘贴在手机端不再出现。

**行为变更 / 升级注意**

- **【行为变更】随机 uskey 兜底默认关闭**：以前默认放行随机 uskey，线上必回 `4100404`，看起来像「配了没生效」；现在 **fail-fast**，缺失出票链路（`native/` 或 `MARVIS_USKEY_URL`）直接报**可操作错误**，明确指出该配什么。想保留旧兜底行为的，显式设 `MARVIS_ALLOW_RANDOM_USKEY=1`（仅开发排查用，随机票线上必被风控拦截）。
- **uskey-server 默认绑 127.0.0.1**：`tools/uskey-server.mjs` 默认监听本机回环，可选启用 `x-uskey-token` 共享密钥，减少暴露面。
- **旧 `MARVIS_RISK_COOLDOWN_MS` 语义变化**：现在是熔断指数退避的**基数**（`base×2^n`），不再是固定冷却时长；按旧语义调过该变量的需按新语义重新评估。

**风控强化**

- **熔断器升级**：退避策略改为**指数退避**（`base×2^n`，上限 8h，±10% jitter）；半开状态一次失败**立即重开**（不再等满整个退避周期）；状态持久化到 `<稳定资产目录>/breaker-state.json`，重启不丢；新增 `riskEvents()` 事件环形缓冲，供诊断读取近期风控事件。
- **新增请求节奏闸 pacing**：出站补全请求最小间隔 `MARVIS_MIN_REQUEST_INTERVAL_MS`（默认 `800`）+ 随机抖动 `MARVIS_REQUEST_JITTER_MS`（默认 `400`），压平请求节奏，降低被节奏风控盯上的概率。

**流式透传**

- **gateway / openclaw 通道流式化**：`gateway`（PC AG-UI WS）与 `openclaw`（手机会话域 WS）两条通道改为流式 —— 网关侧 `TEXT_MESSAGE_CONTENT` / openclaw 侧 `event:chat` 增量实时转成 OpenAI `chat.completion.chunk` SSE，首字延迟从「整轮结束」降到秒级；**非流式行为不变**。
- **flatten 改进**：单条 user 消息原样直发；system 独立置顶保留。
- **agent.run requestId 唯一化**：每次 agent 运行的 requestId 唯一，避免多请求串号。

**主动续期**

- **`refreshLead` 可配置（`MARVIS_REFRESH_LEAD_MS`，默认 30 天 = `2592000000`）**：宿主「距到期多久算该续」的提前量从写死的 5 分钟改为可调，并 clamp 到微信 TTL 的 1/3（防 lead 逼近 token 生命期导致「从登录起永远该刷」的连续刷新循环）。到点由**宿主**调 `auth.refresh` 并落库 —— 微信 2h token 不再周期性掉线。30 天窗口对微信 2h / QQ 30 天都落在窗内，即「持续保活」。
- **新增 `needsProactiveRefresh()` / `proactiveRefresh()`（`src/hooks/proactive-refresh.mjs`）**：前者是纯判定（供诊断面板/doctor 回答「快到期了吗」）；后者带**同账号最小间隔节流**（`MARVIS_REFRESH_MIN_INTERVAL_MS`，默认 `3600000` 即 1 小时，`0` 关闭 —— 这是把 30 天窗口压成「每小时最多一次」的节奏阀）与失败隔离（`fatal` / `error` / `throttled` 三态，**一律不向宿主抛**），供能把结果落库的调用方使用。节流 key 用完整 openid 不截断，防短值碰撞串号。
  ⚠ **不在 loader 里调用**：插件在请求路径里刷出来的 token 拿不到写回宿主的入口，刷了存不住，反而变成「每请求刷一次」并撞上节奏风控。提前续期的正确落点是宿主的 refreshLead 机制。

**工程与测试**

- **测试与宿主环境隔离加固**：`MARVIS_*` 环境变量泄漏隔离、UTF-8 BOM 配置场景、`python3` 探测降级路径均有用例覆盖。
- **新增测试**：`tests/gateway-stream` / `breaker` / `pacing` / `refresh-proactive` 等。

## 0.6.4 — 2026-11-24

**一键诊断 + UTF-8 BOM 配置修复**

- **新增 `scripts/doctor.mjs`**：一键诊断「模型不出字」——逐环输出插件版本/入口、网关配置、/models + /health（账号池与出票后端）、最小 chat 请求，直接指出挂在哪一环；不打印任何密钥明文。实测本机：前三环全绿，chat 环 `4100404` 上游风控，与配置无关。
- **修复（gateway.json 带 BOM 时配置被整份跳过）**：Windows 编辑器 / PowerShell 写的 UTF-8 BOM（`U+FEFF`）会让 `JSON.parse` 失败，`gatewayConfig()` 静默退回默认——表现为网关 key 配了却像没配。现读取时去掉 BOM；测试覆盖 BOM 场景。本机 `gateway.json` 已去 BOM，诊断确认 `keyConfigured=true`、`mode=gateway`。
- 测试隔离：网关测试的 `env()` helper 显式隔离本机 `~/.magpie-marvis-native/gateway.json`，避免真实配置漏进测试。全量离线 197 通过 / 0 失败。

## 0.6.3 — 2026-11-24

**手机一键包压缩格式与脚本 Termux 兼容性修复**

- **修复（Release 附件在 Android 解压成散文件）**：`magpie-marvis-phone-kit.zip` 改用 Python `zipfile` 打包，条目统一 `create_system=3`（Unix）、`/` 路径、目录以 `/` 结尾且带 DOS 目录标志、`.sh` 带 `0755` 可执行位；GitHub 附件已替换为该版本（最终 sha256 以 GitHub Release 页 asset digest 为准 —— 不在本文件硬编码，因为本文件会随插件打进 zip，写死会形成「改文档→zip 变→哈希过期」的循环），Termux `unzip` 后目录结构正常。
- **修复（phone-setup.sh 在 Termux 跑不通）**：shebang 从 `#!/system/bin/sh` 改为 `#!/bin/sh`；端口读取改为 `sys.argv[1]` 传路径（路径含引号/空格不炸）；补 `$HOME` 未绑定检查；`set -e` 下网关启动失败改为显式报错 + 日志排查提示。CRLF 全清。
- **文档**：README-FINAL / README 手机段补 `pkg install python curl -y`、`sh phone-setup.sh` 调用方式、`gateway.json` 的 `timeoutMs`。
- 电脑端诊断确认：provider test 的 401/403 是上游 `4100404` 风控（key / qimei36 / 账号池 / ctypes 出票全部正常），与插件版本无关，切 off / gateway 同源。
- 测试：全量离线 197 通过 / 0 失败。

## 0.6.2 — 2026-11-24

**手机一键安装包（Release 附件）+ 网关无需 bionic .so 也能启动的实测记录**

- **新增 phone-kit 发布附件**：`magpie-marvis-phone-kit.zip` 把插件 + Python 网关（参考仓库）+ 一键脚本打在一起，手机上解压后 `sh phone-setup.sh` 即完成「起网关 + 写 gateway.json」，不用分别 clone 两个仓库。仓库内新增 `phone-setup.sh`（脚本本身也进 `files` 白名单）。
- **实测**：`serve.py` 用纯 Python 3.12 可直接 import（4 条出票通道缺资产时只返回空串、不抛异常）；网关服务启动本身不依赖 bionic `.so`，只有真正出票才需要 Termux 的本机库 —— 所以网关必须在 **Termux（bionic）** 里跑，dsh-go 的 glibc proot 加载不了那份 `.so`。
- 文档：README-FINAL 第四节顶部加「最快路径：下载附件 → 一条命令」，手工四步保留作无附件时的兜底。

## 0.6.1 — 2026-11-24

**手机端真正可用：配置文件开关网关 + 免登录占位账号 + 修正安装路径**

- **修复（手机端网关模式开不了）**：0.6.0 的 gateway 只读环境变量，而 magpie 安卓壳没有环境变量入口。新增文件配置：把 `gateway.example.json` 复制到 `~/.magpie-marvis-native/gateway.json` 即开启网关模式，`mode`/`url`/`key`/`timeoutMs` 全支持；环境变量仍优先。
- **修复（手机登录卡在打不开浏览器）**：手机壳只给旧包名 `magpie-marvis` 打过「粘贴 OAuth 回调」补丁，`magpie-marvis-final` 点 QQ/微信登录会卡住。新增登录方式「本地网关（手机推荐，免登录）」：网关模式下排在首位，生成一个本地占位账号让 magpie 出模型 / provider test，真正的加号登录在网关 Web 控制台做，不碰浏览器。
- **修复（安装命令错位）**：README-FINAL 第四节改为 magpie 手机壳的真实路径 —— 控制后台 `127.0.0.1:3430` → 插件 → 导入本地文件夹，明确 `dsh plugin add` 装的是 dsh 侧插件不是 magpie 插件；删掉 remote 抓包路线在手机上的可行性表述。
- 测试：新增 `gateway.json` 文件配置 + 环境变量覆盖 + 免登录账号用例；全量离线测试 197 通过 / 0 失败。

## 0.6.0 — 2026-11-24

**正名为纯 magpie 插件 + 本地网关传输（手机可用）**

- **正名**：仓库 / 元数据 / 文档统一为纯 magpie / OpenCode provider 插件 —— package.json description/keywords、registry 摘要、README、README-FINAL 全部去除面板子包字样；provider id 仍为 `marvis`，账号与路由无缝沿用。
- **移除 dsh-go 面板**：删除面板子包目录及其文档/配置描述，交付面不再包含独立面板；面板子包原本也不在 `files` 白名单内。
- **新增本地网关传输**：新增 `MARVIS_TRANSPORT=gateway`（默认推荐），插件连本地 OpenAI 兼容网关 `http://127.0.0.1:8088/v1`，跨平台（PC + 手机）；手机可在 Termux / PRoot 里跑参考仓库 `yy158358/Marvis-proxy-public` 的 Python 网关后使用。新增 `MARVIS_GATEWAY_URL` / `MARVIS_GATEWAY_KEY` / `MARVIS_GATEWAY_TIMEOUT_MS`；三种传输为 gateway（默认）→ off（PC HTTP 直连）→ openclaw（WS），旧 `MARVIS_WS_MODE` 兼容保留。
- 文档：README-FINAL 第四节改为「手机安装（Termux / PRoot）」，环境变量表补齐网关变量，传输通道章节 gateway 置顶；NOTICE 追加参考仓库致谢。

## 0.5.3 — 2026-11-24

**强制直连传输（node:https）——宿主代理机制免疫的硬保证**

- **新增 directPost（node:https 实现）**：主补全请求改走显式 keepAlive agent 的 node:https —— Node 24 实测「默认 agent 吃 HTTPS_PROXY env、显式 agent 完全无视」（死端口差分：默认 agent ECONNREFUSED vs 显式 agent 直连到达上游），Bun 的 node 兼容层遵循同一 API 语义。clash 开/关/死端口三种状态下传输层都保证直连
- 真实 ReadableStream body（Readable.toWeb + 手写兜底桥）——流式 SSE 交给宿主的链路保持；403 自愈链/风控熔断/每请求重签 uskey 语义不变
- 通道开关 `MARVIS_DIRECT_TRANSPORT`：默认 `https`（node:https 直连），`fetch` 回退旧 directFetch
- 与 clash 侧加固配套：clash 已加链首显式 DIRECT 规则（yybadaccess.3g.qq.com / *.3g.qq.com / *marvis*），规则集镜像刷新失败也不会回退走代理
- 风控现状记录：2026-11-24 凌晨起该设备/账号维度 POST 通道进入观察期（4100404，直连与代理出口无差别 100% 拦截；GET 通道全通；11-23 当日 1096 条成功），属上游侧状态，冷却后即时恢复

## 0.5.2 — 2026-11-24

**403 内容过滤自愈链升级（候选池多句自愈，吸收社区 403 修复包的有效算法）**

- **新增候选池自愈**：兜底句重试仍被拦时，从泛指候选池随机换句重试最多 4 句（排除已试句）。池子以**中文泛指句**为主（英文泛指句 11-17 起被上游陆续拉黑，照抄社区英文池会得到假兜底）；每句重试都走 callUpstream（remote 新开 WS / HTTP 重签 uskey）
- **「错误类型变了就停」**：候选池重试中上游一旦回 401/风控/404 等其他错误立即中止 —— 内容过滤自愈绝不把其他故障当救回信号
- **always 模式也参与自愈**：门禁由 `mode === "blocked"` 放宽为 `mode !== "off"` —— always 模式下用户自己那句被拦后不再没有任何兜底（0.5.1 及以前的真缺口）
- 自愈链顺序：用户兜底句 → 候选池随机换句（≤4）→ U+2060 护栏（可选）→ 统一诊断；不计入风控熔断（403 内容过滤与 4100404 节奏风控是两套机制）
- 文档全面对齐 0.5.1 最终形态：mode=off（HTTP 直连，实测恢复 200）列为 PC 端默认推荐；稳定资产目录（MARVIS_NATIVE_DIR）跨更新免疫；directnet 直连代理剥离；清除全部 bridge/AK-SK/refreshCmd 残留描述；registry-entry 市场描述同步
- 删除 CHANGELOG 重复的 0.3.0 条目与悬空引用；测试更新至新自愈链语义（188 通过 / 0 失败 / 4 skipped）

## 0.5.1 — 2026-11-24

**修（宿主代理拦截 HTTP 路径）**：clash 关闭时，magpie 宿主 Bun fetch 带着 HTTPS_PROXY 会把 yybadaccess 请求全部 ECONNRESET。新增 src/marvis/directnet.mjs（directFetch）：所有上游请求（chat/续期/钱包/uskey 外部出票/登录换取/头像/图片）构造前临时剥离代理变量、完成后恢复，`MARVIS_DIRECT_FETCH=0` 可关。腾讯国内端点直连即正确路径

## 0.5.0 — 2026-11-24

**精简版：去掉所有多余功能，只留验证过的主链路**

- **删除 bridge 模式**（adb UI 注入转发）：坐标硬编码、依赖前台、中文输入受限 —— 早已被 remote WS 取代的死路
- **删除 AK/SK 休眠签名**（src/marvis/aksk.mjs）：PC 端拿不到 AK/SK（marvis_create_aksk 403 / data.db 空表），且实测官方客户端 /v1 不发这套头；休眠能力无落地场景
- **删除凭据自动刷新机制**（refreshCmd / runRefreshCmd）：插件本体**永不调用模拟器/adb** —— 凭据失效时插件报出明确诊断，用户把新抓的 handshake.log 放回 native/ 即可恢复
- **删除脚手架模板文档**（GUIDE/HOOKS/UPDATING/CHECKLIST/MULTI-PROVIDER/SCORING/CONTRIBUTING/OFFICIAL-SOURCES/MAINTENANCE/AGENTS/README-TEMPLATE/examples/extract-contract.py）—— 交付面从 20+ 文档瘦身为 README + README-FINAL + CHANGELOG
- 保留全部核心修复：remote WS 通道、connect.auth 修正、每请求 uskey 现签、熔断器、官方中文首行护栏、U+2060 护栏、代理剥离、配置优先级修正
- 性能说明：新增机制全部位于请求热路径且为微秒级操作，无后台线程/轮询/定时器；实测全新凭据端到端 **1.7 秒**（magpie provider test）

## 0.4.4 — 2026-11-24

- **撤出本机测试工具**：`tools/marvis-refresh.ps1` / `tools/capture_marvis.py` 是开发期的本机测试台产物（绑定特定模拟器环境），不随插件分发。`refreshCmd` 机制保留 —— 凭据失效自动重抓的能力由用户自备的刷新脚本提供（放在插件目录外，避免 `magpie plugin update` 清掉）。**不装刷新脚本也能用**：凭据失效时插件报出明确的失效诊断，用户重抓一次 handshake.log 放回 native/ 即可恢复
- 凭据刷新命令示例（本机自备）：openclaw.json `"refreshCmd": "powershell -ExecutionPolicy Bypass -File <你的刷新脚本> <native目录>"`

## 0.4.3 — 2026-11-24

**relay 凭据短命问题终结：自动刷新流水线内置，端到端 PONG 实测 2 秒**

- **修（配置劫持）**：`fileConfig()` 现在让**插件自带的 native/openclaw.json 优先**于 `MARVIS_NATIVE_DIR` 里的同名文件 —— 用户环境变量残留的旧插件 `MARVIS_NATIVE_DIR`（内含 `mode=bridge`）会把传输层整体劫持到 3502 死桥，表现为所有请求 12s 无响应。**这是宿主内"全部失败"的真凶**
- **新增（凭据自动刷新）**：relay 凭据实测短命（≈15-20 分钟，手机会话死后服务器很快回收）。连接失败（握手无应答/被拒绝/WS 错误）且配置了 `refreshCmd` 时，自动执行重抓流水线（启动 App → attach 抓包 → 断网重连 → 写 native/handshake.log → 杀 App）后重试一次。配置：openclaw.json `"refreshCmd": "powershell -ExecutionPolicy Bypass -File tools\\marvis-refresh.ps1 <native目录>"`
- **新增 tools/marvis-refresh.ps1 + tools/capture_marvis.py**：自动刷新脚本（含 frida-python 探测、大小写重复代理变量清洗、.NET Process 后台抓包），Magpie 宿主实测可用
- 实测：`mode=remote` + 自动刷新 → `CONNECT OK → chat.send → PONG`，全新凭据下 2 秒返回

## 0.4.2 — 2026-11-24

**remote 通道真正稳定版（变体实验定位双根因，探针 PONG 复现）**

- **修（connect.auth 带 accessToken → -3）**：remote 模式下 connect.auth **不再发送**插件自己的 mv_ accessToken —— relaySessionId/relayToken 这一对就是登录态。0.4.1 仍带 token，magpie 定期轮换（refresh 成对轮换、与手机登录互踢）后必然失配，服务器回 `登录态鉴权失败: AK/SK fetched successfully but data is incomplete`；relay 模式（无握手凭据）保留 accessToken
- **修（宿主代理拦截 WS）**：magpie 宿主带 HTTPS_PROXY 时 Bun 的 WebSocket 会被代理转发，对 openclaw 端点 `proxy_connect: message forward failed`。现在构造 WS 前临时剥离代理变量、onopen/失败路径恢复（`MARVIS_WS_BYPASS_PROXY=0` 可关）
- 实测：探针 `CONNECT OK → chat.send → PONG`（auth = openid + relaySessionId + relayToken，无 accessToken）

## 0.4.1 — 2026-11-24

**remote 通道首次端到端打通（CONNECT OK → chat.send → PONG，真机凭据实测）**

- **修（connect 鉴权 -3）**：`relayConnectParams()` 的 `connect.auth` 补 `relaySessionId` / `relayToken`（取自 handshake.log 握手头）——缺失时服务器回 `登录态鉴权失败: AK/SK fetched successfully but data is incomplete`
- **修（openclaw.json）**：`handshakeFile` 现在有明确文档路径（此前默认空串会让 mode 自动探测落到 relay）；示例见 README-FINAL
- **断网重连抓包法**（README-FINAL 补充）：attach 模式 + `cmd connectivity airplane-mode enable/disable` 强制 App 断线重连，握手头自己送上门，不再和 App 启动抢时序（旧 spawn/启动竞争法已废弃）
- 实测记录：App 在线时同凭据并发连接会被立即踢（1006）；每请求前用 `MARVIS_WS_KILL_CMD`（或手动 force-stop）抢占会话

## 0.4.0 — 2026-11-24

**最终版：合并 marvis-aksk-fix / Marvis-proxy-public / dsh-magpie-marvis 的全部可用修复，PC 与手机通用**

- **4100404 改判 429 + Retry-After**（原 503 risk_blocked）：magpie 宿主对 503 连试 7 次会把账号级节奏风控的冷却越撞越长（issue #71 实测）；429 让宿主按 retry-after 退避。旧行为可用 `MARVIS_RISK_STATUS=503` 找回
- **新增风控熔断器**（src/breaker.mjs）：连续 5 次 4100404 后本地拒绝出网 30 分钟（`MARVIS_RISK_THRESHOLD` / `MARVIS_RISK_COOLDOWN_MS` 可调），请求不再陪撞风控
- **兜底首行换官方中文身份句**：英文句 `You are Marvis, Tencent's AI assistant.` 11-17 起被上游拉黑（issue #71），`你是功能强大的 AI 助手，名字叫 Marvis（马维斯）。` 是唯一稳定白名单；`MARVIS_FALLBACK_FIRST_LINE` 可覆盖
- **新增 4100406 内容过滤护栏**（可选，`MARVIS_GUARD_WORD_JOINER=1`）：兜底句重试仍被拦时，对 system 首行的可疑词对注入 U+2060 word joiner 再试最后一次（Marvis-proxy-public guard.py 的 L1 层思路）
- **新增 AK/SK 休眠签名**（src/marvis/aksk.mjs）：HMAC-SHA256(secretKey, nonce + "\\n" + timestamp)，三来源（env / native/aksk.json / 官方客户端 data.db 的 aksks 表，修复了原补丁 ESM 里 require 失效的缺陷）；**默认关闭**——官方客户端 /v1 不发 Marvis-Auth-Type，主动发会把 403 翻成 401，仅 `MARVIS_AKSK=1` 或配置存在时合并（PC 全局风控解除后即为正式第 2 层登录态）
- **面板子包（0.6.0 已移除）**：曾提供手机端面板 UI（连通性 / 额度 / 多 provider 切换），0.6.0 起交付面不再包含；主插件本体可装进手机 proot 里的 magpie
- 内容过滤判定补 `4100406` 业务码；registry-entry / 显示名 / 包名更新为 `magpie-marvis-final`（provider id 仍为 `marvis`，复用已有账号与路由）
- 188 项离线测试全绿（新增用例断言 429 语义与中文兜底句）

## 0.3.1 — 2026-11-23

**新增 bridge 模式：借手机 App 出内容（实测 200 通）**
- tools/marvis-bridge.py：adb 注入 + frida SSL_read 抓帧 → OpenAI 兼容接口
- 实测 say HELLO → HELLO，流式两帧 + [DONE] 正常
- 插件新增 MARVIS_WS_MODE=bridge + MARVIS_BRIDGE_URL
- 记录两条已证伪的路：手机端无 qimei 库（appKey 也不同）、openclaw agent 独占

## 0.3.0 — 2026-11-23

**改用 openclaw WS 传输（文档路线 11.3），绕开 PC 端被 4100404 全局风控的 HTTP 模型网关**
- 新增 src/marvis/openclaw.mjs：relay（本地 PC 网关 10123）/ remote（手机会话 wss）两种模式
- loader 在非 off 模式下走 WS chat.send，不再生成 uskey；响应包成 OpenAI 兼容格式
- 按社区实测上限调整：maxConcurrency 2→8、DEFAULT_OUTPUT 32000→131072
- 193 项离线测试全绿（含 mock openclaw WS 端到端）

## 0.2.58 — 2026-11-21

**修（4100404：uskey 按请求上下文真实出票，issue #70 / #71 / #72）**

- 重写 `src/marvis/fingerprint.mjs`：按官方 `beacon_napi.node` 的真实 API 调用
  `init(appKey, appVer)` + `setCommonParams({guid, login_openid, login_type})` +
  `getUskey("marvis", busInfo)`；不再用 `init({...})` / `getUskey(businessId, {reqScene, taskType})`。
- 新增 `src/marvis/protocol.mjs` 的 `requestIdentity()`：每次请求生成 `conv_` / `resp_` / `nonce`，
  按 `marvisAgentTag` / `marvisConversationID` / `marvisResponseID` / `marvisScene` / `model` /
  `nonce` / `originOpenID` 拼 `bus_info`，并同步写入 `Marvis-*` 请求头。
- `Ual-Access-MarvisExt` 补齐 `clientPlatform` / `clientPlatformVersion` / 可选 `subScene`；
  请求头新增 `Marvis-Model-Level: 1`、`Ual-Access-Requestid`、`X-Stainless-Read-Timeout`、
  `X-Stainless-Retry-Count`。
- 支持 `MARVIS_USKEY_URL` 外部出票服务（Docker / 容器场景），并附带最小
  `tools/uskey-server.mjs`；支持 `native/qimei36.txt` 或 `MARVIS_QIMEI36`。
- 新增 `tools/extract-native.mjs`：在 Windows 上自动从 Marvis 客户端复制 4 个 native 文件。
- `llmHeaders` / `marvisExt` 改为异步（出票可能需要加载 native 模块或请求外部服务）；
  loader 每次发请求都重新生成 identity，403 兜底重试不复用旧票。
- 保留 `MARVIS_ALLOW_RANDOM_USKEY=1` 作为开发兜底；正式使用请配置 native/ 或
  `MARVIS_USKEY_URL`，否则会继续收到 4100404。


## 0.2.57 — 2026-11-17

**改（4100404 风控的提示说清区别，issue #68）**

- 原来的文案只说「通常是一次性 uskey 用完了，重试即可」，但实测会出现**持续**的 4100404：同一设备/出口的
  4 个账号、11 个模型全部 `{"code":4100404,"msg":"客户端通用错误:请求被风控拦截"}`，换账号、换 UA 都一样
- 新的文案把两种情形分开：偶发一次 = 宿主重试即可；连续每次都这样 = 设备/出口被风控，停几分钟、别并发、或换出口（换账号没用）
- 状态码仍是 503 + `risk_blocked`（可重试语义不变，宿主重试逻辑不受影响）

## 0.2.56 — 2026-11-17

**修（发给上游的 UA 可能变成 `magpie/0.1.4342, AsyncOpenAI/Python 2.32.0`）**

- 模型网关要求 UA 是 Marvis agent 自己的 `AsyncOpenAI/Python 2.32.0`（换成浏览器/magpie 的 UA 会被 4100404 风控）
- 合并 magpie 传进来的头时按**原样**赋值，magpie 若用小写 `user-agent` 传自己的 UA，两处同名头会被 Headers 用逗号连成一条
- 改成**按小写判重**后再覆盖（Headers 实例 / 键值数组 / 普通对象三种形状都处理），本次实测三种形状的最终 UA 都是 `AsyncOpenAI/Python 2.32.0`

## 0.2.55 — 2026-11-17

**改（内置兜底首行换成 Marvis 自己的首句）**

- 默认首行 `You are a helpful assistant.` → `You are Marvis, Tencent's AI assistant.`：
  前者用的人太多，2026-11-17 实测已被上游 403；用厂商自己的身份句，黑名单不会反噬它自己的产品
- 同一批直打实测（只换 system 首行，其余不变）：
  `You are a helpful assistant.` → **403**；
  `You are Marvis, Tencent's AI assistant.` / `You are Marvis.` / `You are an AI assistant.` / `你是腾讯 Marvis 智能助手。` → **200**
- 这个句子只是**默认值**：`提示词首行替换` 留空时才用，用户写了就用用户的

## 0.2.54 — 2026-11-17

**修（首行改写只认 chat 的 `messages[]`：Anthropic / Responses 协议下等于空操作，issue #62 —— 由 @zhey80 用 `up_bytes` 差值定位）**

- 新增 `withFirstLineInBody` / `firstLineInBody`：一处按协议取/放 system 文本，always 与 403 兜底两条路共用
  - chat：`messages[]` 里第一条 `role: system`
  - **Anthropic（`/v1/messages`）：顶层 `system`** —— 字符串直接换；数据块数组只换**第一个** `text` 块，其余块与 `cache_control` 原样
  - Responses：顶层 `instructions`
- 门禁从「只认 `/chat/completions`」放宽到 `/messages`、`/responses`：不放行的话那两种协议会被整个短路，改写一次都跑不到
- **内置兜底句换成 `You are an AI assistant.`**：2026-11-17 直打实测 `You are a helpful assistant.` 已经是 403，
  也就是说旧默认值让 `first_line_fallback` 变成空操作；同批实测 `You are an AI assistant.` / `You are an assistant.` /
  `You are a coding assistant.` 都是 200
- 用例 +4：顶层 `system`（字符串）、顶层 `system`（数据块，带 `cache_control`）、顶层 `instructions`、403 兜底认顶层 `system`

## 0.2.53 — 2026-11-17

**改（不再自动猜「哪句首行能过」：白名单改写整套删掉，首行只由用户自己写）**

- 删掉 `IDENTITY_SENTENCES`（DSH / Claude Code / Codex / ZCode 等「已知身份句 → 等价句」表）、
  `IDENTITY_PHRASE_TEST` 与两个改写函数：合并一句新首行进白名单，很快也会被上游拉黑，跟着猜只是军备竞赛
- 现在插件只做两件事：`first_line_always` 把每个请求的 system 首行换成**你写的那句**；
  `first_line_fallback` 在被 403 拦下后换成那句重试一次（首行已经是那句就不再白试）
- 403 文案改成「首行请自己写」：指向 设置 → 插件 → 本插件「选项」的 `提示词首行替换`，并保留进群反馈
- 用例同步：删掉 11 条白名单改写用例，新增「200 时任何身份句都不改写」「403 时首行已是那句则不重试」
- README 的「首行改写」一节重写（旧版还写着「两个都关 = 只走内置白名单」）

## 0.2.52 — 2026-11-17

**修（中文界面下选项开关折行压到「模型」行）+ 保留「在哪改文本」的指向**

- 采纳 @pawamamama 的 #59：magpie 的 `label ≤ 60` 是**按字符数**校验，中文能过；
  但一个汉字约两列宽，40 字≈80 列 —— 窄窗口就折行，而选项行只预留一行高度，第二行直接压到「模型」区块上
- 两条 `labels.zh` 收到一行放得下的长度，并在 always 上留了个短指向：`每个请求都改写首行（文本在「选项」里）`
- 用例加一条「中文 label ≤ 24 字」的显示宽度上限（原来只查 magpie 的 60 字符上限）

## 0.2.51 — 2026-11-17

**改（选项的键名换成中文：`提示词首行替换`）**

- 那个键是我们自己起的名字（magpie 只要求选项的值是一个对象），所以直接改成中文：
  `{ "提示词首行替换": "You are a helpful assistant." }` —— 设置 → 插件 → 本插件「选项」框里
  看到的就是这一句，把引号里换成自己的话、保存即可，不用猜 `text` 是什么
- 默认值仍然写在这（示例即默认）；老版本存过的 `{"text": …}`（0.2.50）与
  `{"firstLine": {"text": …}}`（≤0.2.49）继续读，不用手动迁移
- 面板写回同一个键，并顺手收掉老的 `text` / `firstLine`

## 0.2.50 — 2026-11-17

**改（首行文本改成在「设置 → 插件」那一行的选项框里改：一个键 `text`，默认值就写在那）**

- 插件选项从 `{ "firstLine": { "mode": "blocked", "text": "" } }` 瘦成一个键：`{ "text": "You are a helpful assistant." }`
  —— 那个框是 magpie 的通用 JSON 编辑器（值必须是对象，写字符串会被拒），键越少越好改；
  示例就是**默认值**，点「选项」看到的那句就是要用的那句，把引号里换成自己的话、保存即可
- loader 优先读 `options.text`；老版本存下的 `{ "firstLine": { "text": … } }` 继续读（不用手动迁移）
- `mode` 不再写进 JSON：改不改由卡片上那两个开关决定（`first_line_fallback` / `first_line_always`）
- 面板（供应商编辑器里的「首行文本」）同步读写 `text`，保存时把老的 `firstLine` 键收掉
- 开关的 label 加长到 43 字：magpie 的选项行按内容宽度排，太短整行会缩到中间

## 0.2.49 — 2026-11-17

**修复（选项的第二行还是压到「模型」上：一条开关只能占一行）**

- 两条开关的 `description` 全部删掉，说明并进 `label`（≤60 字符）。magpie 的 `.plugin-options`
  是 flex 的 `.stack`，但每个选项**只预留一行高度**：多画一行 description，那一行就压到下一个
  field（模型列表）上 —— 0.2.47 / 0.2.48 的两次缩短都只是把溢出变短，没消除
- 插件的渲染改不了（`pluginOptionsField` 在 magpie 里），能改的只有「一条只占一行」
- 用例改成锁这条：任一开关出现 `description` / `descriptions` 就失败

## 0.2.48 — 2026-11-17

**修复（说明文字压到模型行）+ 改版（首行文本：点按钮弹输入框）**

- 两条开关的 `description` 缩短到**一行画得完**（zh ≤48 字符、en ≤120）：magpie 按一行算行高，
  第二行不会撑高，会直接压在下面的「模型」区块上（实测截图）。用例加了这条上限防回归。
- 首行文本面板改成**一行 + 按钮**：`首行文本  当前值  [设置…]`，点「设置…」弹出原生 `<dialog>`，
  里面是输入框和「取消 / 保存」两个按钮；保存时才写一次 `firstLine.text`（`options.set` 是整份替换、
  一秒最多一次，仍然整份展开写回）。面板本身只有一行高，不再把编辑器撑高。
- 面板用例同步：写回挂在「保存」按钮的 submit 上，禁止边打字边写（原来是 1.2s 防抖）。

## 0.2.47 — 2026-11-17

**修复（开关没置顶：漏了 `placement: "top"`）**

- 我上一版说「插件侧无法置顶」是**错的**：magpie 早就支持 `auth.options[i].placement: "top"`，
  写了就画在**账号下面、路由上面**（magpie 仓库 issue 5269；渲染侧 `pluginOptionsField(sub, top)`
  按 `o.placement === "top"` 分组，Go 侧字段 `json:"placement,omitempty"`）
- 两条开关（`first_line_fallback` / `first_line_always`）都加上 `placement: "top"`
- README 更正对应的错误说法；用例加一条断言「每条都必须 top」，防止以后新增开关漏掉
- ⚠ 面板（首行文本输入框）**没有**位置字段，仍只能追加在编辑器末尾 —— 想让输入框也置顶需要上游支持
- 验收：测试 185 项中 181 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.46 — 2026-11-17

**新增（首行文本的输入框：供应商卡片里的面板）**

- 开关已经由 magpie 原生渲染（`auth.options`，只支持布尔）；**文本没有原生控件**，
  所以补一个 `magpie.panels`（slot: provider）面板：一个输入框 + 回车/失焦自动保存，
  写的是同一份 `firstLine.text`，与「每个请求都改写首行」开关配套
- 位置由 magpie 决定：`app.js` 里 `ed.append(slot)` 在**编辑器末尾、取消/保存之上**，
  开关那两行在它的上方（`pluginOptionsField` 固定插在「高级」之前）—— 两者都无法置顶
- 面板只在 provider 编辑器里出现；`options.set` 是整份替换 + 一秒最多一次，
  所以写回展开读到的整份 opts，输入防抖 1.2s
- 新增 `tests/panel-manifest.test.mjs`（5 项）：清单形状 / files 白名单带面板文件（漏了就是空白）/
  必须加载 bridge 且用 options.get+set / 写回保留别的键 / 面板不许自己 fetch
- 验收：测试 184 项中 180 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  `npm pack --dry-run` 里能看到 `panel/first-line.{html,js,css}`

## 0.2.45 — 2026-11-17

**修复（开关放错层：0.2.44 的 provider 面板换成 magpie 自带的 `auth.options` 开关）**

- 0.2.44 用 `magpie.panels` 在供应商编辑器里开了个 iframe 面板 —— 机制没写错，但对这件事是**绕远路**：
  面板清单要窗口重载才刷新，装完看不出变化；而且它要维护一套 HTML/JS。
- magpie 本来就有这个扩展点（`auth.options`，#2038，`internal/plugin/host.js` 的 `optionsOf`）：
  插件声明 `{key, label, description?, default?, confirm?, labels?, descriptions?, confirms?}`，
  magpie 在**供应商编辑器**里每条画一行 Off/On，点一下立刻保存，插件用
  `input.magpie.option("marvis", key)` 现读 —— **不用重启、不用窗口重载**
- 两个开关：`first_line_fallback`（默认开，被 403 拦下时换兜底句重试一次）、
  `first_line_always`（默认关，每个请求都改写；开了先弹一次确认）
- 自定义首行文本仍在插件选项 JSON 里（`firstLine.text`，留空 = 内置兜底句）
- 删掉 `magpie.panels` / `panel/*` / 对应的 4 个面板用例；新增 `tests/plugin-options.test.mjs`（4 项），
  按 magpie 的校验规则锁住开关形状（key 正则、label ≤60、default 布尔、zh 文案、最多 16 条）
- 验收：测试 179 项中 175 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.44 — 2026-11-17

**新增（provider 编辑器里的「首行改写」面板：开关 + 输入框，不用手写 JSON）**

- `magpie.panels` 声明一个 `provider` 槽的面板（`panel/first-line.html`），它会出现在**每个 provider 编辑器**里：
  一个 `mode` 下拉（off / blocked / always）+ 一个「首行文本」输入框，改完自动保存
- 面板通过 `_magpie/bridge.js` 的 `magpie.options.get()/.set()` 读写**本插件自己的**选项 ——
  与 JSON 编辑框改的是同一份 `firstLine`，两条路等价
- `options.set` 是整份替换 + 一秒最多一次：写回时展开读到的整份 opts（不抹掉别的键），输入防抖 1.2s
- 新增 `tests/panel-manifest.test.mjs`（4 项）：面板清单形状 / `files` 白名单里必须带面板文件（漏了就是一块空白）/
  provider 槽必须走 bridge 且覆盖三档 / 写回必须保留别的键
- 验收：测试 179 项中 175 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  `npm pack --dry-run` 里能看到 `panel/first-line.{html,js,css}`

## 0.2.43 — 2026-11-17

**新增（降级自查探针）+ 文档更正（降级落点不是固定值）**

- `node scripts/probe-served-model.mjs`：绕开 magpie、用插件自己的 `llmHeaders()` 直连上游，
  逐账号打印 `main-auto` / 防降级槽位的**实际服务模型**；有账号与声明不一致时退出码 2。
  只读本机账号文件、不写任何配置，供应商关着也能跑（issue #43 的建议 3）
- 文档更正：被改路由的号会落到**某个旧快照**，而旧快照的名字**不固定** ——
  已知出现过 `deepseek-v4-flash-ga-260731`（#13）与 `deepseek-v4-flash-202605`（#43）。
  #15 里把落点写成固定值的那句不再成立；判定只认响应体里的 `model`
- 新增 `expectedServedModel()`：比之前先剥掉我们自己的 `-antidowngrade` 显示后缀 ——
  第一版探针直接拿显示名比，把 4 个正常账号全判成「被降级」（实测踩到的坑，用用例锁住）
- 新增 1 个用例；README 增加「你的号被降级了没有」一节
- 验收：测试 175 项中 171 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过；
  本机 4 账号 × 2 槽位实跑 8/8 与声明一致

## 0.2.42 — 2026-11-17

**新增（首行兜底开关：`firstLine.mode` / `firstLine.text`）**

- 整句白名单只覆盖「已知客户端的默认首句」；用户改过的首句、新客户端、没见过的写法仍然 403。
  新增插件选项（设置页里的 JSON）：`{"firstLine": {"mode": "blocked", "text": ""}}`
  - `off`：只走白名单（等于 0.2.41 的行为）
  - `blocked`（默认）：先按原样发；被 403「非法请求」拦下时，把 system 首行换成兜底句**重试一次**
  - `always`：每个请求都把首行换成 `text`（优先级高于白名单，适合「提示词根本改不了」的客户端）
- `text` 留空 = 内置兜底 `You are a helpful assistant.`（不含任何 agent 产品名，实测 200）；
  选项写坏（未知 mode / 非字符串 / 整个 options 是坏 JSON）一律退回默认，绝不让请求失败
- 重试**每次重新签 uskey** —— 它是一次性的，复用会直接撞风控，看起来像另一类故障
- 只换 system 消息的**第一行**，第二行起原样；没有 system 消息就不重试（不凭空插一条）
- 新增 5 个用例：默认 retry（两次都被拦仍给诊断）/ retry 成功直通 200 / off 不重试 /
  always 直改且优先于白名单 / 选项写坏退回默认
- 验收：测试 174 项中 170 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.41 — 2026-11-17

**变更（身份句改写：正则形状匹配 → 整句白名单）**

- 只对**主流客户端的默认首句**做整句替换（表里 11 条，逐条实测 403 → 200）；
  **用户自己改过的首句一个字节都不动** —— 不跟用户的修改打架，也不可能被二次改写
- 前缀稳定：同一客户端每次替换结果相同 ⇒ 上游前缀缓存照常命中。
  正则那种「形状像就改」在用户微调首句后仍然改写，前缀反复变、缓存反复失效（本次要解决的问题之一）
- 中文身份句实测原样就 200 ⇒ 从改写表移除（之前会做无谓的连字符替换，纯属让前缀变化）
- 403 文案改口径：默认首句走白名单自动换；改过首句的请求不动，仍被拦就把 system 首行贴出来加一行
- 新增 4 个用例：改过的首句不动 / 整句精确匹配（大小写、改词都不动）/ 句末标点归一 / 只替换第一句
- 验收：测试 169 项中 165 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.40 — 2026-11-17

**修复（Claude / Codex 的改写规则已经变成空转：产物照样 403）**

- 2026-11-17 复测 0.2.32 起的连字符改写产物：`You are Claude-Code, …` /
  `You are a coding agent running in the Codex-CLI, …` **仍然 403** —— 规则在跑，
  改完上游照样拦，用户看到的现象和没装插件一样（issue #36 / #41 的表里都记着）
- 上游认的是**第一句的形状**：`You are <产品名>` 当主语就拦，插字符不管用；**拆主语**才放行。
  实测（同一分钟、只换 system 首行）：`You are a coding agent, running in the Codex CLI, …` → 200、
  `You are an agent, Claude Code, …` → 200、`You are an agent, Claude-Code, …` → 200、
  `You are an agent, Claude.` → 200
- 改写改成「插一个逗号 + 泛指名词」：**名字一个字符都不删**，模型仍然知道自己是哪个客户端；
  老形态（`Codex-CLI` / `Claude-Code` / 裸 `You are Claude.`）继续被救回来
- 新增 2 个用例（老形态救回 / 幂等），改写产物与用例期望一起更新
- 验收：测试 166 项中 162 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.39 — 2026-11-17

**修复（ZCode 的身份句没被覆盖，整个客户端 403）**

- 2026-11-17 实测（同一分钟、只换 system 首行）：`You are ZCode, …` / `You are ZCode.` → 403，
  `You are Z-Code, …` → 200，`You are Zed, …` / `You are a helpful assistant.` → 200
  —— 这条的判据仍是字面量 `ZCode`，插连字符有效（**与 0.2.38 那条 DSH 的结论不是一回事**，别混）
- `IDENTITY_PHRASES` 补 `You are ZCode → You are Z-Code`，`IDENTITY_PHRASE_TEST` 同步补
  `You are\s+ZCode\b`；ZCode 的系统提示词**不可配置**，插件不改写就等于这个客户端完全不能用（issue #38）
- 403 文案改成「常见身份句插件已自动改写；仍被拦说明这句还没覆盖，把首行带到群里」——
  原来只教 `powered by → running in`，对 ZCode 这类提示词改不动的客户端是空建议
- 新增 4 个用例：长短两种 ZCode 写法改写 / 无关首句不误伤 / 已写成 `Z-Code` 不再动 / 诊断与改写同集合
- 验收：测试 165 项中 161 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.38 — 2026-11-16

**修复（连字符形态失效，改成换句式；报错文案写明根因与修法）**

- 2026-11-16 实测：`DeepSeek-Harness` / `Claude-Code` 这些**连字符形态也被拦了** ——
  上游把判据从「词对之间插字符就不认」收紧成「`You are an AI agent` + `DeepSeek`」，插字符不再管用
- 改写改成**换句式**：`powered by` → `running in`（等长、语义不变），
  `You are an AI agent running in DeepSeek Harness.` 实测 200；倒装/`inside` 也放行
- 报错文案写明**根因与修法**：「系统提示词首句被当成身份指纹（不是密钥或登录问题）」+ 具体改法
  + QQ 群 451129479，让用户那边的 agent 看了报错就能自己动手修
- 验收：测试 162 项中 158 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.37 — 2026-11-16

**修复（URL 图片：DNS 里混一条 0.0.0.0 就把整个域名拒掉）**

- `assertPublicHttpUrl()` 原来对 DNS 记录**逐条否决** —— 开了 DNS 过滤 / sinkhole 的机器上，
  `cdn.jsdelivr.net` 会解析成「3 条 Cloudflare IPv6 + 2 条 `0.0.0.0`」，于是整条外链图被拦
  （issue #34：curl 走 IPv6 取图 200，插件回 `400 invalid_image`）
- 改成：**只要还有一条公网记录就放行**，一条不剩才拒；字面 IP 那条分支仍然严格拒绝，SSRF 面不变
- 新增 2 个用例：混合记录（IPv6 + `0.0.0.0`）放行 / 全保留地址仍拒
- 验收：测试 162 项中 158 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.36 — 2026-11-16

**修复（`deepseek-v4-pro-external` 漏了识图能力声明）**

- 该槽位上游回的是 `deepseek-v4-1-flash-261017`，与 `main-auto` 同一个模型；0.2.26 给 `main-auto`
  补了 `vision: true`，这条漏了 —— 结果选中它时 `attachment` / `modalities.input` 全为假，传不了图
  （贡献：@xxhhlk，PR #32）
- 作者实测：两个槽位对同一张带字 PNG 都读出 `MAGPIE-VISION-TEST 42`
- 验收：测试 160 项中 156 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.35 — 2026-11-15

**修复（403 一律指引到群，不再按指纹判定）**

- 报错分流从「命中已知身份句才算内容过滤」改成「**403 + 非法请求就给统一提示**」
- 理由：上游指纹在持续扩大（英文 → 中文 → 还没见过的写法），按指纹判定永远漏
  —— 0.2.34 刚给中文补了一条规则，下一版还会有别的。而 403 + 这个组合目前只出现在
  内容过滤上（模型无权限是 400「无效模型 id」）
- **改写仍按指纹精确执行**（避免改无关内容），只有**诊断**放宽：宁可多给一句「进群」，
  也不把人甩回宿主那句「API 密钥无效」
- 验收：测试 160 项中 156 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.34 — 2026-11-16

**修复（中文 / 本地化身份句既不自动改写、也不给诊断）**

- 触发：system 首行是中文身份句（如 `你是一个由 DeepSeek Harness 驱动的 AI 智能体。`）时，上游同样回
  403 `4100406 非法请求`；但 0.2.29 起的三条改写规则都是英文整句模板，中文一句都不匹配 ——
  于是既不自动改写（用户照旧撞墙），也不进 `content_filtered` 诊断（宿主照旧显示「API 密钥无效」）
- 判据统一成「system 首行 + 词对 + 单个空格」：改写与诊断共用同一个集合，中文规则一并补上；
  顺带补上 Codex 身份句的诊断分支（此前只有 DSH 与 Claude 两条），改写限定在 system 角色的第一行
- 验收：`node --test` 157 项全过（新增 5 项：中文改写 / 中文诊断 / 非首行与 user 角色零改动 /
  全小写与句末叹号 / Codex 诊断）

## 0.2.33 — 2026-11-15

**修复（内容过滤的报错改成一句话，并指向 QQ 群）**

- 文案从两段式（点名 `You are an AI agent powered by DeepSeek Harness.` / `You are Claude Code…`）
  改成统一一句：**「上游内容过滤拦截（非密钥或登录问题），修复方法见 QQ 群 451129479。」**
- 为什么不点名具体 agent：被拦的可能是很多家，写死一家会在别家命中时把人带偏；而且 0.2.32 起
  身份句已在本地自动改写，走到报错这一步时已经不能断定就是那两句 —— 原来的说法是推断冒充结论
- 两个 403 分支合并成一个，以后新增指纹不用再加分支
- 验收：测试 156 项中 152 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.32 — 2026-11-15

**修复（Codex / Claude Desktop 的新会话 403）+ 补齐 DeepSeek 推理挡位**

- 身份句改写扩到三家：`DeepSeek Harness`、`Codex CLI`、`Claude Code` 都换成连字符形态
  （`DeepSeek-Harness` / `Codex-CLI` / `Claude-Code`）—— 2026-11-15 直打上游实测：
  原句 403「非法请求」，连字符 200；只改身份短语里的一个空格，其余字节不动（贡献：@BangShou1st）
- 背景：Marvis 的内容过滤按「产品身份」定点拦截；新会话会把身份句放在 system prompt 开头，
  老会话续聊不会 —— 所以表现是「老会话能用、新会话全 403」
- DeepSeek 两条 4.1f 条目补 `variants: low/high/max`：不声明时 DSH 接入页的 `reasoningEfforts`
  会缺这组挡位，Codex 目录则生成 low/medium/high/ultra（缺 max）（贡献：@BangShou1st）
- 保留 0.2.31 的兜底诊断：改写生效后若仍 403，错误信息仍会指出命中哪句身份声明
- 验收：测试 158 项中 154 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.31 — 2026-11-15

**修复（Claude Code 的身份句被上游拦时，错误信息能指路）**

- 触发：上游 403 + 请求体含 `You are Claude Code, Anthropic's official CLI for Claude.`
  （2026-11-15 实测，错误码 `4100406`，issue #26）
- 命中时返回 `content_filtered` 并给出可执行改写（`Claude Code` → `Claude-Code`，实测放行）；
  **只诊断、不替第三方工具改 prompt** —— 改不改是调用方自己的决定
- 顺带测到：`You are a Claude agent, built on Anthropic's Claude Agent SDK.` 这句**不触发**
- 验收：测试 150 项中 146 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.30 — 2026-11-15

**测试（锁住「门禁」语义：只改会被拦的形态，用户已修好的一个字节都不动）**

- 新增用例覆盖三种「用户自己已经修过」的形态：连字符 `DeepSeek-Harness`、破折号 `DeepSeek — Harness`、
  以及整句已被移出 —— 这些都必须**原样发出**
- 背景：0.2.29 的改写用的是精确正则 `(…DeepSeek)\s+(Harness)`，本来就只命中「单个空格」的原始形态；
  但当时没有测试锁住，以后谁放宽正则就会变成「无差别替换」，跟用户自己在 DSH 侧的修复打架
- 验收：测试 149 项中 145 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.29 — 2026-11-15

**新增（自动改写会被上游内容过滤拦下的那句 system prompt）**

- 请求体里出现 `You are an AI agent powered by DeepSeek Harness.` 时，自动把两个词之间的空格换成
  连字符（`DeepSeek-Harness`）—— **语义不变，但能过内容过滤**（issue #22 实测：连字符与破折号都放行；
  加在句末的感叹号 / 逗号、双空格、纯小写、后置括号**全都还是 403**）
- 用户**不用改 DSH 配置**：不用关 `includeHarnessIdentity`，也不用动 profile
- 只动这一处，其余消息一个字符都不碰；改写后若仍 403，0.2.28 的诊断文案照旧生效
- 验收：测试 148 项中 144 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.28 — 2026-11-15

**修复（403「非法请求」时给出能指路的错误，而不是让宿主显示「API 密钥无效」）**

- 触发条件：上游 403 + 请求体里含 `You are an AI agent powered by DeepSeek Harness.`。
  2026-11-15 实测：这句会被 Marvis 内容过滤**精确**拦下（少一个词就不触发），见 issue #22
- 命中时返回 `content_filtered` 并写明解法（关掉 DSH 的 `includeHarnessIdentity` 或改写开场白）；
  **不拦请求、不改 prompt** —— 只把错误文案从误导改成可执行
- 没命中标识句的 403 仍然原样透出，不误判
- 验收：测试 146 项中 142 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.27 — 2026-11-15

**新增（卡片上显示额度重置时间）**

- `auth.usage` 的主窗口补 `resetsAt`：按**北京时间每天 0 点**推算（issue #12 确认的规则）。
  上游 `/v3/marvis_get_wallet` 不返回重置时间，所以这里是固定规则推算，规则变了只改 `nextResetAt()`
- ⚠ 它**只影响卡片显示**：路由排序只读 `used`，给 `resetsAt` 不会让这个号排得更前
  （排序是 magpie 按剩余额度算的，插件给不了优先级）
- 验收：测试 144 项中 140 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.26 — 2026-11-15

**修复（`main-auto` 被声明成不收图，贴图直接 400）**

- `main-auto` 补 `vision: true`：上游 `deepseek-v4-1-flash-261017` 本来能识图，但 TABLE 里没标能力
  ⇒ 默认槽位被声明成 text-only ⇒ magpie 在入口就把带图请求 400 掉（定位来自 @ATCThunder，issue #8）
- 图片输入归一：http(s) 图片 URL 下载后转 `data:` URI（含 SSRF 防护、禁重定向）、裸 base64 补成
  data URI、Anthropic `image/source` 显式转换 —— 转不了时本地 400，不再静默丢图
- README 的模型清单去掉已不存在的「DeepSeek V4 Pro」，并注明两条 V4.1 Flash 路由都能识图
- 验收：测试 143 项中 139 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.25 — 2026-11-15

**修复（0.2.23 的「防降级」条目会让部分客户端卡死）**

- 该条目的显示名从 `deepseek-v4-1-flash-261017 (防降级)` 改为
  `deepseek-v4-1-flash-261017-antidowngrade` —— **纯 ASCII，不带空格与全角括号**
- 原因：显示名带非 ASCII 字符时，VS Code Copilot 里选中它会一直停在回复阶段（同一条在 DSH 下正常），
  模型名会被客户端拿去做 header / URL 处理，非 ASCII 在那一层会出问题（issue #15）
- 旧显示名保留归一映射：已经写好它的路由组升级后照常工作，不会 `400 无效模型id`
- 新增回归测试：**所有模型的显示名必须是纯 ASCII** —— 防止再有人给它加中文后缀
- 验收：测试 128 项中 124 通过、4 项因未注入 live 凭据跳过；合规检查 42 项全过

## 0.2.24 — 2026-11-13

**新增（无头宿主：粘贴回调地址登录）**

- 新增两条登录方式「QQ 登录（粘贴回调地址）」「微信登录（粘贴回调地址）」：宿主把授权页交给用户自己的浏览器，
  登录完把地址栏里那条 `…marvis_oauth?login_type=…&code=…&state=…` 粘贴回来即可换登录态
- 适用于 magpie 跑在无浏览器、无显示的容器/服务器上（原「隔离浏览器」路需要 Chromium 与显示，
  「从本机 Marvis 导入」只认 Windows 客户端）
- `guid` 仍与授权那次相同（按 OAuth state 暂存，手动流程 TTL 放宽到 30 分钟）；
  `callback` 的单参 / 两参调用形态都兼容
- 换取成功才消费这次登录：空输入、换取失败都能原样重试
- 原有三条登录方式行为不变
- 贡献者：@Yandre97（[#9](https://github.com/cat-clash/magpie-marvis-ws/pull/9)）

## 0.2.23 — 2026-11-13

**修复（`deepseek-v4-pro-external` 的显示名与实际模型不符）+ 加一条防降级槽位**

- 该槽位实测回的是 `deepseek-v4-1-flash-261017`（不是名字暗示的 pro），显示名改为
  `deepseek-v4-1-flash-261017 (防降级)` —— 与 `main-auto` 那条同时出现在模型列表里，名字上能区分
- 为什么两条并存：`main-auto` 属 auto 家族（`main-auto` / `file-auto` / `computer-auto` / `browser-auto`
  是同一族，服务端会**按账号**改路由，被改到的号会落到旧快照），而 `deepseek-v4-pro-external`
  是独立固定映射、不受影响 —— 账号被改路由时它可用来拿到同一个模型
- 旧显示名 `deepseek-v4-pro-202606` 保留归一映射：已经写好它的路由组升级后照常工作，
  不会把旧名字原样发给上游变成 `400 无效模型id`
- 验收：新增 2 项回归测试（抽掉别名映射会红）；全量 116 项中 112 通过、4 项因未注入 live 凭据跳过；
  合规检查 42 项全过

## 0.2.22 — 2026-11-08

**修复（保留仍可用的旧模型槽位）**

- 0.2.21 的 TABLE allowlist 会误伤 `app-auto` / `file-auto` / `computer-auto` / `browser-auto` 等旧槽位；
  改为只拦截已确认持续 500 的 `kimi-k2.5`，其他旧槽位继续由上游判定
- 配置合并同样改为不可用名单，不再丢弃所有目录外的手工或旧模型条目
- Magpie 可见模型键、`id`、`name` 仍只使用真实模型名；`main-auto` 不作为用户可见模型名
- 验收：全量 114 项中 110 通过、4 项因未注入 live 凭据跳过；真实当前 8 模型与旧 4 槽位全部 200，
  `kimi-k2.5` 流式/非流式均在本地 404 且上游调用为 0

## 0.2.21 — 2026-11-08

**修复（失效模型导致持续 500）+ 锁定真实模型显示名**

- 配置合并不再保留无法归一到当前目录的失效或手工模型 ID，避免继续调用已下线槽位
- `loader` 对不支持的模型直接返回 404 `model_unavailable`，不再发上游并触发多轮 500 重试；
  上游 `4130001 / 无效模型id` 也归为模型级 404
- Magpie 的模型键、`id`、`name` 继续显示真实模型名；`main-auto` 只作为内部上游槽位，不作为用户可见模型名
- README、npm 描述与 Discover 注册摘要同步为真实 8 个模型，删除 Kimi K2.5 与“18 个槽位”等失效宣传
- 验收：新增回归测试均先红后绿；全量 83 项中 79 通过、4 项因未注入 live 凭据跳过；
  真实 8 模型全部 200，`kimi-k2.5` 流式/非流式均在本地 404 且上游调用为 0

## 0.2.20 — 2026-11-08

**去掉对 `native/` 二进制的依赖（不再需要那 4 个 Windows 文件）**

- 新增 `src/marvis/fingerprint.mjs`：设备指纹改成本地生成，格式与上游一致；
  `native/` 变成**可选**——目录在且能加载就优先用它，不在也不影响使用
- 删除 `src/native.mjs`（原来要求 4 个 DLL 齐全，缺一个就返回 null）
- `MarvisExt` 的 `qimei36` 改成条件展开：取不到真值就整个字段不发，
  不要用占位值代替（该字段要求与设备一致）
- `loader` 的错误码 `native_unavailable` → `header_unavailable`
- README：「为什么需要 native/」改写为「设备指纹（不需要任何二进制）」，
  「只支持 Windows」改为跨平台说明
- 验收：无 `native/` 目录时走完整插件链路打真实网关 → 200；
  测试 59 通过、合规全过

> 0.2.16 ~ 0.2.19 是内部迭代版本，未公开发布；本次合并发布为 0.2.20。

## 0.2.15 — 2026-11-07

**文档（计费口径改写成计费公式）**

- README「计费 / 额度」从「字段含义 + 占比公式」改成**计费公式**：
  `计费 token = 缓存读取 × 0 +（输入 + 输出）× 0.5`，一个号每天 **1000 万计费 token**
- 并说明 1000 万是**计费** token，实际可用量远高于它 —— 缓存命中全免、输入输出打五折，
  按例子 `实际 : 计费 = 5 : 1`，1000 万计费 ≈ **5000 万实际 token**（全无缓存也有 2 : 1）
- 顶部「它能给你什么」的额度行同步成「1000 万计费 token（缓存免费 + 输入输出五折，实际能跑 2000 万～5000 万+）」
- 字段表里 `total_tokens` / `used_tokens` 标注「**计费** token」，避免与实际 token 混读

## 0.2.14 — 2026-11-07

**修复（微信账号登录态被踢下线）**

> 五个根因叠在一起，缺一个都修不好。前四条让续期「调不通」，第五条让续期「根本进不去」。

- **`auth.refresh` 的签名写错了（最致命）**：magpie 的续期钩子是
  `refresh(auth, provider)` —— 第一个参数是**账号对象**；只有
  `loader` / `usage` / `checkin` 才收 `getAuth` 函数。
  0.2.13 及以前写成 `async (getAuth) => getAuth()`，magpie 实测报
  `plugin [error]: auth.refresh: getAuth is not a function.
  (In 'getAuth()', 'getAuth' is an instance of Object)` ——
  **续期一次都没跑起来过**，30 秒重试、无限循环。现在两种传法都认
- **续期端点调错了**：以前调 `GET /v3/marvis_refresh_token?refresh_token=…`，
  该端点恒定回 `-109 RefreshToken missing required param (openid, guid, token)` ——
  **续期从来没成功过**。真实端点是 `POST /marvis_client_login/marvis_refresh_token`，
  body `{"userInfo":{openId,refreshToken,accessToken,loginType:"Marvis"}}`
- **微信 token 只有 2 小时**（`expires_in=7200`，QQ 是 ≈30 天 = `2591962`）：
  旧代码把 `expires_in` 当成「不是绝对时间戳」直接回退 30 天，于是**从不主动续期**。
  微信账号登录完几小时就 401「登录态过期/未登录」，QQ 只是 30 天没走完所以看不出来
- **`refresh_token` 空串覆盖**：续期响应里 `refresh_token` 回 `""`，`??` 不回退，
  存成空串后下次 `if (!refreshToken) return {}` 直接短路 —— 即使端点对了也永不续期
- **`-109` 被误判成登录失效**：它表示「参数检查未通过」（插件自身问题），
  标 `signIn: "expired"` 会让 magpie 把好账号标成「需要重新登录」。
  现在只有 `-107`（`RC_NO_AUTH_ERR`）/ `-101`（会话不存在）才标
- `refreshLead` 从 **24 小时**改为 **5 分钟**：24 小时对 2 小时的微信 token 意味着
  「从登录那刻起就永远该刷新」
- 新增 `src/marvis/expiry.mjs` 统一「绝对秒 / 绝对毫秒 / 相对秒 / 兜底」四分支，
  登录（`login.mjs`）、导入（`desktop.mjs`）、续期（`refresh.mjs`）三处共用

**修复（登录类型兜底）**

- `Ual-Access-Login-Type` 只认 **`1`（QQ）/ `2`（微信）** —— 渲染层
  `yct={QC:"1",WX:"2",WXAPP:"2"}`。五处兜底默认值 `6` 改成 `1`：
  `protocol.mjs` 两处（`llmHeaders` / `businessHeaders`）、`loader.mjs`、`usage.mjs`、
  `desktop.mjs` 的 JSON 形态。写 6 会让「拿不到 loginType 的账号」在后续请求里
  带错类型（`Ual-Access-Login-Type: 6` 不存在）→ 401

**文档**

- README 新增「**计费 / 额度**」小节：`total_tokens` / `used_tokens` / `avail_tokens` /
  `frozen_tokens` 四个字段的含义与占比公式
- README 登录说明改成「自动打开隔离浏览器、授权完自己关掉，不用复制 URL」——
  浏览器登录从 0.2.2 起就自动抓回调了

**实测（2026-11-07）**

- 五个账号（3 QQ + 2 微信）全部续期 `code:0`，续期后打 `/v1/chat/completions` 全部 **200**
- 续期**不换** `access_token`（响应与请求同值），只重置有效期；
  `metadata.openid` / `guid` / `refresh_token` 全部保留
- 修复前：两个微信账号 401 `{"code":4100403,"msg":"客户端通用错误:登录态过期/未登录"}`
- 修复后在**运行中的 magpie** 上复验：把过期账号的 `expires` 拨到过去 → 发一次请求 →
  magpie 自动续期并写回 `plugin-auth.json`（`expires` 变成 +2 小时），请求 **200**；
  五个账号现在全部有效
- 顺带：`auth.refresh` 的错误不再污染 magpie 日志（此前每 30 秒一条 `getAuth is not a function`）

## 0.2.13 — 2026-11-06

**修复（工具调用 400 invalid parameter）**

- Marvis 要求每个 `tools[].function.parameters` 显式带 `type: "object"`；
  DSH 的部分工具（如 `bash`）省略了它，**只要有一个工具缺 type，整次请求就 400**
- `loader` 现在递归补齐缺失的 `type:"object"`，不动 `properties` / `required` /
  `additionalProperties`；不改变工具名和行为
- 已用 DSH 当时的完整请求（57 个工具 + `reasoning_effort` + 流式）复放：
  修复前 400 `invalid parameter`，修复后 **200 流式工具调用**

## 0.2.12 — 2026-11-06

**修复（路由显示真实模型名）**

- 模型条目的 `id` 改成**真实模型名**（`deepseek-v4-1-flash-261017` 等），
  `apiId` 保留上游槽位名（`main-auto`）—— 路由/卡片不再显示 `0` 或 `main-auto`
- `loader` 同时认三种写法：真实模型名、旧槽位名、旧数字下标，统一映射到上游槽位；
  已实测 `model:"0"` 与 `model:"deepseek-v4-1-flash-261017"` 都返回 200
- 旧路由由升级脚本迁移 `marvis/0 → marvis/main-auto → marvis/<真实模型名>`；
  不迁移时 loader 仍兼容旧引用

## 0.2.11 — 2026-11-06

**修复（模型目录真正按槽位名）**

- `config.models` / `provider.models` 改成**对象表，键是槽位名**（`main-auto` 等），
  并给 `provider.models` 补上 `api.id`。此前是数组，magpie 会存成下标 `"0"…"7"`，
  路由里只显示 `0`，请求发 `model:"0"` 上游 400
- 旧数组形态在 `config` 合并时按 TABLE 顺序自动认回槽位名，用户改过的名字/上下文/能力保留
- `loader` 的数字 ID 兼容映射保留：即使路由组里还写着 `marvis/0`，也能正常调用
- 账号名继续带 `QQ·` / `微信·` 前缀（旧账号点刷新或重登后生效）

**升级提示**

- 安装后点一次「重新获取模型」，路由里把旧的 `0` 重新选成
  `deepseek-v4.1-flash-261017`，之后显示真实名称；不重选时 `0` 仍可用（loader 已兼容）

## 0.2.10 — 2026-11-06

**修复**

- **旧路由 `model:"0"` 报 `400 无效模型 id`**：0.2.x 的 `config.models` 是数组，
  magpie 把它持久化成下标 `"0"…"7"`，路由组引用 `marvis/0`，请求体就发 `"0"`。
  `loader` 现在把纯数字 ID 按 TABLE 顺序归一成槽位名（`0 → main-auto`），
  **旧路由不改配置即可继续用**
- **账号名前缀**：卡片名变成 `QQ·昵称` / `微信·昵称`，同名的 QQ/微信账号可以直接区分；
  旧账号点一次刷新（或重登）后生效
- 昵称/头像在登录、本机导入、刷新时统一通过签名 POST 获取，拿不到就留空

**说明**

- 路由页仍显示 `0`，是 0.2.x 数组模型 ID 的历史存量。本次优先保兼容、**不迁移路由组**
  （迁移要把 `marvis/0` 改成 `marvis/main-auto`，会动到用户现有路由）。
  需要显示真实名称时再做单独迁移。

## 0.2.9 — 2026-11-06

**新增（多账号并行）**

- **每个账号独立设备 `guid`（虚拟设备）**：扫码登录时生成新的 32 位 guid 并随账号保存，
  后续请求、刷新、额度查询都用该账号自己的 guid。此前所有账号共用本机 `svid`，
  上游同一 guid 只保留一个有效登录态，**新号登录会把旧号顶掉**（旧号随后 401）
- 登录过程中用 OAuth `state` 关联本次 guid，按 state 分开暂存，并发登录不会串号
- 本机导入仍使用客户端自己的 `svid`，保持与本机 Marvis 一致
- **账号名显示 QQ 昵称**：登录、本机导入、刷新时用签名 POST 取 `nick_name` / 头像并落盘；
  拿不到就留空，不编造。QQ 号拿不到（`openid` 是应用内 ID，不是 QQ 号）

**实测依据**

- 同一 token：原 guid → 200；随机 guid → 401；随机 `qimei36` / `nonce`（guid 不变）→ 200
  —— 绑定的是 guid，不是其他指纹

## 0.2.8 — 2026-11-06

**修复（根因，已实机验证）**

- **浏览器扫码登录 `-109 RC_PARAMS_INVALID` 的根因是换取时没带设备 `guid`**。
  实测：缺 guid → 恒定 `-109`；补 `Ual-Access-Guid`（或 `.qq.com` 的 `guid` cookie）后，
  死码立即变 `-107 RC_NO_AUTH_ERR` —— 参数检查发生在 code 校验之前。
  0.2.2～0.2.7 里「redirect_uri / 两次请求 / code 已消费 / UA / TLS」的解释均不成立，以本节为准
- **成功响应是 302 + Set-Cookie，不是 JSON**：改为 `redirect: "manual"`，
  从 `openid / accesstoken / refreshtoken / logintype / nickname / head_img_url /
  access_token_expire_time / appid / scope / is_locked` 还原账号
- **CDP 在 Request 阶段拦截回调**（`Fetch.requestPaused` + `Fetch.fulfillRequest` 静态完成页），
  浏览器不再把 code 发出去；监听器与钩子全部在 `Page.navigate` 之前安装
- **修正 `Network.responseReceived` 的资源类型读取位置**：类型在 `msg.params.type`，
  不在 `response.type`；原条件永不成立
- **回调 `state` 原样保留**并随换取请求回传；`guid` 不再在兜底路径变成 `undefined`
- **`-109` / `-107` 文案按实测更正**：`-109` = 参数检查未通过（最常见缺 guid），
  `-107` = 参数已通过但 code 无效/过期/已消费，都不是账号密码错误

**实机验证**

- QQ 扫码 → 隔离浏览器拦截 → Node 带 guid 换取成功：`uid=<已脱敏>`，拿到 access + refresh
- 用新凭据调用 `main-auto`：HTTP 200，`model=deepseek-v4-1-flash-261017`，内容 `"OK"`

## 0.2.7 — 2026-11-06

**修复**

- **UA 换回客户端自己的 Electron UA**（`Marvis/1.60.3300.408 ... Electron/44.7.0`）。
  之前为了「伪装成普通浏览器」用的是纯 Chrome UA —— 服务端很可能就是按这个区分调用方
- **去掉 `--disable-blink-features=AutomationControlled`**：它会在地址栏下面挂一条
  「你使用的是不受支持的命令行标记」黄色警告条。`navigator.webdriver` 改用 CDP 抹掉

**修复**

- **`state` 格式与客户端不一致**：app 是 `state=${Math.random()*100}`（**小数**，如 `31.1177412`），
  我写成了 `Math.floor(Math.random()*1e9)`（整数）。抓包确认服务端收到的是 `845583851` 这种
- **`loginType` 映射错了**：渲染层 `yct={QC:"1",WX:"2",WXAPP:"2"}`，
  `Ual-Access-Login-Type` 应该是 `1`/`2`，我写的是 `6`/`5`

**修复（`-109` 的最终根因）**

- **`marvis_oauth` 会被请求两次**：QQ 的 `self_redirect` + 页面自身重载，
  让同一个 code 打两遍 —— 第一次成功返回 token，第二次因为 code 已消耗而回
  `-109 RC_PARAMS_INVALID`。我之前读的是**页面最终状态**，拿到的正是第二次。
  客户端主进程用 `[oauth-dedup]`（"reuse first request"）处理这件事；
  插件改成监听 `Network.responseReceived`，**只认第一个响应体**，抓到立刻返回
- **`authorize()` 阻塞 1.4 秒**：里面调了 `findBrowser()`（15 次注册表查询），
  违反 HOOKS 四·陷阱 1。挪进 `callback()`

**修复**

- **响应解析对格式不敏感**：浏览器渲染 `application/json` 会加缩进/包装，
  原来只看 `startsWith("{")` 会漏判。改成「抠第一个 `{` 到最后一个 `}`」再解析

**修复**

- **授权页卡在「正在完成授权…」，magpie 加不进号**：上一版用 `Fetch.fulfillRequest`
  把回调换成静态页再在页面里 `fetch` 换取 —— 但执行上下文会随导航销毁，`Runtime.evaluate`
  拿不到结果。改成**完全不拦截**：让浏览器自己走完换取（TLS 指纹 / Cookie / Referer 天然齐全），
  只轮询 `location.href` 等它跳到回调地址，再读 `document.body.innerText`

**变更**

- **上下文窗口声明改为 1,000,000**（除 `hunyuan-turbos-vision` 仍 32k）。
  依据：实测 `main-auto` 发 **400,000 字符 = 190,511 tokens** 返回 200，
  远超 `config_defaults.yaml` 声明的 128k —— 那个 128k 是客户端自己的保守值
- **用户设置优先**：`config()` 不再整块覆盖 provider。改成**逐模型、逐字段合并** ——
  用户在 magpie 设置里改过的 `limit.context` / `limit.output` / `name` / `api` 一律保留，
  插件只补缺失字段和新增模型

**修复（逆向客户端主进程后对齐）**

- **换取请求改在页面上下文里发**：`yybadaccess` 的 WAF 做 TLS 指纹校验，
  Node 的 undici（OpenSSL）和 Chromium（BoringSSL）指纹不同 ——
  带头的请求从 Node 发出去一律 **400 空响应**。
- **补 `Referer`**：客户端重放时会把原始请求头整份复制（`reqHeaders` / `cookies` / `referer`），
  缺 referer 服务端判来源不合法。
- **去掉 `Ual-Access-Businessid`**：实测它会让 WAF 直接 400（这是我这轮踩的最大坑——
  加头反而更糟，不加头时至少还能拿到 `-109` JSON）。
- 浏览器先开 `about:blank`、装好钩子再 `Page.navigate` —— 否则首次请求漏过去，拦截永远不触发。

**修复（这是 `-109` 的真正根因）**

- **`redirect_uri` 少了 `?login_type=QC`**。Marvis 渲染层的 `Bpe(e)` 返回的是
  `.../marvis_oauth?login_type=${e}`，我写成了 `.../marvis_oauth`。
  服务端靠这个参数知道「用哪个 app 的 `client_secret` 去换 code」——
  少了它，**哪怕 code 是真的也一律 `-109 RC_PARAMS_INVALID`**（是参数无效，不是 code 无效）。
- 浏览器登录改为**正常走完回调请求**（带 Cookie、带正确 `redirect_uri`），
  只读第一个响应体；不再拦截后用 Node 重放（重放丢 Cookie，同样 `-109`）
- 微信登录同步修正

- **浏览器登录「授权码已被使用过」（`-109`）**：根因是 **QQ 会把 `redirect_uri` 的查询串整个丢掉** ——
  落地页收到的是 `?code=...&state=...`，**没有 `login_type`**，服务端因此判参数无效。
  改成用 CDP `Fetch.requestPaused` 在**跳转前**拦下回调，自己从 URL 取 `code` 再带 `login_type` 换。
  页面同时显示「授权完成」，用户不用对着 `-109` 的 JSON 发愣
- **换 token 带了鉴权头**：`marvis_oauth` 是**免鉴权**端点，带 `Ual-Access-*` 签名头会直接 400 空响应
- **`deviceGuid()` 永远取不到注册表**：JS 里 `\S` `\T` 是无效转义，反斜杠被吃掉，
  `reg` 收到 `HKCUSOFTWARETencentMarvisEnv` → 「无效参数」。改用 `String.raw`
- **本机导入的 guid 与 token 不同源**：服务端按 `(openid, guid, token)` 三元组校验，
  现在优先从**同一段内存**里取 `guid=`
- 去掉 `--disable-blink-features=AutomationControlled`（Edge 会弹「不受支持的命令行标记」警告条），
  改用 CDP `Page.addScriptToEvaluateOnNewDocument` 抹掉 `navigator.webdriver`
