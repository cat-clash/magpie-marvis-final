> `0.9.0` · PC-only · provider id 固定为 **`marvis`**（已有账号、路由组、模型配置全部无缝沿用）
>
> 本文档是**唯一权威使用文档**。原先分散的 `README-FINAL.md`、`CLEARING_CACHE.md`、
> `UPGRADE-0.7.md`、`UPGRADE-083-OPT.md` 已合并进本文件并删除；版本变更历史见
> [`CHANGELOG.md`](./CHANGELOG.md)。

上游只有一个：`https://yybadaccess.3g.qq.com`

- 推理：`/v1/chat/completions`（OpenAI 兼容，不需要 UAL 签名）
- 业务：`/v3/*`（钱包、用户信息，需要 md5 签名）

---

## 1. 模型目录

`model` 字段填的是**槽位名**，服务端再路由到真实模型；响应体里的 `model` 才是真实在跑的模型。

| 槽位（`model`） | 显示名 / 实际模型 | 上下文 | 能力 |
|---|---|---|---|
| `main-auto` | `deepseek-v4-1-flash-261017` | 1,000,000 | 思考 low/high/max · 工具 · 收图 |
| `deepseek-v4-pro-external` | `deepseek-v4-1-flash-261017-antidowngrade` | 1,000,000 | 思考 low/high/max · 工具 · 收图 |
| `hy3-preview-agent` | `deepseek-v4-flash-ga-260731` | 1,000,000 | 思考 · 工具 |
| `hy3-preview-agent-real` | `hy3` | 1,000,000 | 思考 · 工具 |
| `claude-sonnet-4-6` | `claude-sonnet-4-6` | 1,000,000 | 思考 · 工具 · 收图 |
| `claude-opus-4-6` | `claude-opus-4-6` | 1,000,000 | 思考 · 工具 · 收图 |
| `gpt-5.4` | `gpt-5.4-2026-03-05` | 1,000,000 | 思考 · 工具 · 收图 |
| `hunyuan-turbos-vision` | `HY-Vision-2.0-instruct` | 32,000 | 收图 |

默认模型 `main-auto`；默认输出上限 131,072（实测上游接受值）。

- `deepseek-v4-pro-external` 是**防降级槽位**：`auto` 家族（`main-auto` / `file-auto` / …）在服务端
  **按账号**改路由，被改的号会落到某个旧快照；这条是固定映射，账号被改路由时可用它拿回同一个模型。
  后缀 `-antidowngrade` 只是 UI 标记，**上游名字要剥掉它**（`expectedServedModel()` 负责）。
- 模型 ID 会自动归一：旧数字下标 `"0"`…`"7"`、已下线的旧显示名（`deepseek-v4-pro-202606`、
  `deepseek-v4-1-flash-261017 (防降级)`）、真实模型名都能收敛回槽位名，老路由不会因升级而 400。
- `kimi-k2.5` 已确认持续 500，**本地直接拦成 404**，不再打到上游。
- 自查某槽位到底服务哪个模型：`node scripts/probe-served-model.mjs`

---

## 2. 安装与登录

```bash
magpie plugin add ./magpie-marvis-final     # 本地路径安装
magpie plugin login marvis                  # QQ / 微信 OAuth，或从本机 Marvis 客户端导入
magpie provider test marvis-plugin          # 出字验证
```

三种登录方式（登录菜单里都在）：

| 方式 | 适用 | 说明 |
|---|---|---|
| QQ 登录 | PC | 隔离浏览器走 QQ 互联 OAuth，自动抓回调 |
| 微信登录 | PC | 打开授权页 → 授权 → 回调地址自动回填 |
| 从本机 Marvis 导入 | PC（已装官方客户端） | 直接读本机登录态，不用授权 |

**稳定资产目录**：出票文件、`openclaw.json`、`gateway.json`、`breaker-state.json` 都放这里，
**在插件目录之外**，`magpie plugin update` 清不掉（跨更新免疫）：

```powershell
# Windows 建议
[Environment]::SetEnvironmentVariable('MARVIS_NATIVE_DIR', "$env:USERPROFILE\.magpie-marvis-native", 'User')
```

---

## 3. 传输通道

```
MARVIS_TRANSPORT = gateway   ← 本地 OpenAI 兼容网关 http://127.0.0.1:8088/v1（PC / 手机通用）
                 = off       ← PC HTTP 直连 yybadaccess，Beacon 按请求现签 uskey
                 = openclaw  ← PC 客户端本地 WS relay（ws://127.0.0.1:10123）
```

别名：`local` = `gateway`；`direct` = `off`；`ws` / `relay` / `remote` = `openclaw`。
后四者会**关掉网关**，直接走对应通道。

不设 `MARVIS_TRANSPORT` 时是 **auto**：探测 `127.0.0.1:8088/v1/models`，可达才走 gateway，
否则按 `off` / `openclaw` 既有规则处理 —— 不是无条件默认 gateway。

也可以用配置文件代替环境变量（优先级：环境变量 > 文件 > auto）：

```json
// <稳定资产目录>/gateway.json
{ "mode": "gateway", "url": "http://127.0.0.1:8088/v1", "key": "", "timeoutMs": 600000 }
```

- **gateway**：出票、登录都由网关层承担，插件只发标准 `/v1/chat/completions`，不依赖 Windows 原生组件。
- **off（HTTP 直连）**：需要 uskey 出票链（见第 5 节），实测 2026-11-24 出票 34ms、`provider test` 1690ms PONG。
- **openclaw（WS relay）**：走 PC 客户端本地网关 `ws://127.0.0.1:10123`，token 从
  `%TEMP%\Tencent\Marvis\logs\Marvis.log` 的 `AiStarter.GetGatewayToken` 取最后一条。
  宿主没开着客户端时会失败，诊断见第 10 节。
- **直连代理剥离**：上游请求构造前临时剥离代理变量、完成后再恢复（`MARVIS_DIRECT_FETCH=0` 可关）。

---

## 4. 内置本地网关 `gateway/`

`0.9.6` 起，原先独立的 `Marvis-proxy-public` 仓库源码并入本仓库 `gateway/`（原仓库归档，避免两处漂移）。
纯 Python 标准库实现的 OpenAI / Anthropic 兼容网关，默认 `http://127.0.0.1:8088/v1`：

```bash
cd gateway
python serve.py            # Windows 也可 run.bat，Unix 用 ./run.sh
# 浏览器打开 http://127.0.0.1:8088/ 是 Web 控制台（账号池 / 用量 / 模型 / 接线 / 密钥 / 路由图）
```

- 首次使用先跑 `gateway/tools/extract_marvis_dll.py`，从已装客户端提取出票 DLL。
- 运行数据（`data/` `logs/` `backups/` `native/`）与设备指纹**不入库**（见 `gateway/.gitignore`）。
- 控制台加号登录 Marvis（QQ / 微信）后，对话才能通；否则回 `503 no_account`。
- 详细文档见 [`gateway/README.md`](./gateway/README.md)。

---

## 5. 凭据与续期

- **续期钩子**：`refreshLead` 默认 5 分钟（`MARVIS_REFRESH_LEAD_MS` 可调，clamp 到微信 TTL 的 1/3）。
  到点由**宿主**调 `auth.refresh` 并落库 —— 插件在请求路径里刷出来的 token 拿不到写回入口，
  刷了也存不住，反而每请求刷一次并撞风控。
- **续期端点**：`POST /marvis_client_login/marvis_refresh_token`，body `{userInfo:{openId, refreshToken, accessToken, loginType}}`。
  （早期版本错用 `GET /v3/marvis_refresh_token?refresh_token=…`，恒定回 `-109`，已修。）
- **同账号节流**：`MARVIS_REFRESH_MIN_INTERVAL_MS`（默认 1 小时，`0` 关闭）。
- **只有 `-107` / `-101` 才判登录失效**（标 `Sign-In: expired`），其它错误不动账号。

### uskey 出票（`off` 通道需要；gateway / openclaw 不需要）

```bash
node tools/extract-native.mjs   # 从 Program Files\Tencent\Marvis\Application\<ver>\win32-native
                                # 提取 Beacon 4 件套到插件 native/，再复制进稳定资产目录
# 没有 Windows 客户端时：指向外部出票服务
node tools/uskey-server.mjs     # 默认绑 127.0.0.1，支持 x-uskey-token 共享密钥
# 然后设 MARVIS_USKEY_URL=http://127.0.0.1:4617/uskey
```

**随机 uskey 兜底默认关闭**：两条路都没有时直接 fail-fast 报可操作错误（不再静默放随机票，
线上必 `4100404`）。`MARVIS_ALLOW_RANDOM_USKEY=1` 只在本地排查时开。

### 凭据失效怎么办

| 通道 | 处理 |
|---|---|
| gateway | 登录态在网关层，回网关控制台重新加号登录一次 |
| off | token 由续期钩子自动刷新；真失效（-107/-101）就在 magpie 重新登录 |
| openclaw | 宿主没开 / relay 不通：先看 `node scripts/probe-openclaw.mjs` 的 `mode` 与 `overrideWarning` |

---

## 6. 风控与节奏

**4100404（风控拦截）对外统一回 `429 + Retry-After`**，不再是裸 503；`MARVIS_RISK_STATUS=503` 可回退旧行为。

### 请求节奏闸（pacing，按账号分时间轴）

| 变量 | 默认 | 作用 |
|---|---|---|
| `MARVIS_MIN_REQUEST_INTERVAL_MS` | `800` | 同账号相邻两次出网的最小间隔 |
| `MARVIS_REQUEST_JITTER_MS` | `400` | 每次放行叠加的随机抖动 |
| `MARVIS_PACING_SCOPE` | `account` | `global` = 所有账号共用一条时间轴（旧行为） |

### 熔断器（按账号分桶）

| 变量 | 默认 | 作用 |
|---|---|---|
| `MARVIS_RISK_THRESHOLD` | `5` | 连续多少次风控后本地拒绝出网 |
| `MARVIS_RISK_COOLDOWN_MS` | `1800000` | **指数退避的基数**（`base×2^n`，上限 8h，±10% jitter） |
| `MARVIS_RISK_SCOPE` | `account` | `global` = 一个号被拦全体停（旧行为） |
| `MARVIS_RISK_WINDOW_MS` | `600000` | 共因闸的观察窗口 |
| `MARVIS_RISK_CONSENSUS` | `2` | 窗口内几个不同账号各自开闸就判定「通道级」；`0` = 纯隔离 |
| `MARVIS_RISK_GATE_WS` | 开 | `0` = WS 通道跳过熔断闸（不推荐） |

- 账号桶 = `sha256(openid||uid)` 前 12 位（不落明文），展示名 = 首 4 + 尾 4 脱敏。
- 状态持久化在 `<稳定资产目录>/breaker-state.json`（v2 多桶格式，重启不丢）；删掉即重置。
- 半开状态一次失败**立即重开**，不等满退避周期。
- **判读**：只有**一个**账号 429 = 账号级，换号可用；**多个**账号接连 429 = 通道级（IP/UA/uskey/上游节点），换号没用。
- **设备硬拉黑**：`403 + 4100404` 且响应延迟 < `MARVIS_HARD_BLOCK_MS`（默认 800ms）判定为设备被拉黑，
  文案会直说「换号 / 换 IP / 切通道 / 等冷却全部无效，只能换服务端签发的 qimei36」，并跳过自动 WS 回退。

```bash
node scripts/cli.mjs breaker              # 各账号：失败次数 / 冷却剩余 / 重开次数
node scripts/cli.mjs breaker list --json  # 机器可读
node scripts/cli.mjs breaker reset <账号>  # 立刻解封（bucket 或脱敏名子串）
node scripts/cli.mjs breaker reset --all
```

---

## 7. 思考与正文分离（`0.9.9` – `0.9.13`）

PC 客户端会把推理过程、重试、最终回答**拼进同一个文本流**，历史上表现为「回复满屏英文 / 像乱码」。
现在的处理链路：

1. **`0.9.10` / `0.9.11`**：AG-UI 事件按 `evName` 分流，`REASONING_*` 的 delta 只进 frame 的 `reasoning`
   字段 → `reasoning_content`（客户端收进可折叠的思考区），**不会混进正文**。
2. **`0.9.9`**：WS relay 补上 `reasoning_effort` 归一化，思考不再漏进内容。
3. **`0.9.13`**：还有第二条通路（思考与正文无结构边界），新增 `src/marvis/thinking-split.mjs`
   按**行**保守切分 —— 英文思考句式开头 + 中文占比 < 5% + 英文词数 ≥ 12 三条同时满足才判为思考；
   任何含中文正文的行一律留在 `content`；切完正文为空则整段还给 `content`（绝不返回空回答）。
4. **`0.9.12`**：DSH 后台**标题生成**请求（route 跟随当前会话）改由本地直接返回短标题，
   不再发上游 —— 注入框架被标题 LLM 复读出来的英文垃圾彻底消失。
5. **`0.9.7`**：额度显示改走本地网关 `token.conversations_usage`（与客户端 App 同源），
   网关不可达时静默回落 HTTP 钱包；`MARVIS_USAGE_WS=0` 可关。
   `reasoning_effort` 档位过大时自动把预算抬到 `MARVIS_MAX_TOKENS_FLOOR`（默认 64000）。

---

## 8. 界面选项

供应商卡片（`auth.options`，点一下立刻生效，不用重启）：

| 开关 | 默认 | 说明 |
|---|---|---|
| 拒绝时兜底改首行（403）`first_line_fallback` | 开 | 被 403 内容过滤拦下时，把 system 首行换成官方中文身份句重试一次 |
| 每个请求都改首行 `first_line_always` | 关 | 每个请求都替换 system 首行（包括本来能过的） |

首行文案在插件选项 JSON 里改（`first_line_fallback` 用的就是它）：

```json
{ "提示词首行替换": "你是功能强大的 AI 助手，名字叫 Marvis（马维斯）。" }
```

内置兜底句是官方中文身份句（英文那批 2026-11-17 起被上游拉黑）。`MARVIS_GUARD_WORD_JOINER=1`
可启用 U+2060 二道防线。

---

## 9. 环境变量速查

| 变量 | 默认 | 说明 |
|---|---|---|
| `MARVIS_TRANSPORT` | 未设（auto 探测 8088） | `gateway` / `off` / `openclaw`（别名见第 3 节） |
| `MARVIS_GATEWAY_URL` | `http://127.0.0.1:8088/v1` | 本地 HTTP 网关地址 |
| `MARVIS_GATEWAY_KEY` | 空 | 网关鉴权 key（可选） |
| `MARVIS_GATEWAY_TIMEOUT_MS` | `600000` | 网关请求超时 |
| `MARVIS_GATEWAY_CONFIG` | 空 | 显式指定 `gateway.json` 路径 |
| `MARVIS_GW_URL` | `ws://127.0.0.1:10123/` | **PC AG-UI WS relay** 地址，与 8088 网关无关 |
| `MARVIS_WS_MODE` | 兼容保留 | 旧变量：`off` = HTTP 直连；否则 relay |
| `MARVIS_NATIVE_DIR` | `~/.magpie-marvis-native` | 稳定资产目录 |
| `MARVIS_DIRECT_FETCH` | 开 | `0` = 关闭直连代理剥离 |
| `MARVIS_DIRECT_TRANSPORT` | 空 | 强制某些请求走直连 node:https |
| `MARVIS_USKEY_URL` / `MARVIS_QIMEI36` | 空 | 出票链（off 通道） |
| `MARVIS_ALLOW_RANDOM_USKEY` | 关 | `1` = 找回随机 uskey 兜底（仅排查） |
| `MARVIS_APP_VERSION` | 自动探测 | 覆盖上报给上游的客户端版本号 |
| `MARVIS_MAX_TOKENS_FLOOR` | `64000` | 思考档位过高时的预算下限；`0` 关闭 |
| `MARVIS_REASONING_EFFORT_FLOOR` | 空 | 强制最低思考档 |
| `MARVIS_DYNAMIC_MODELS` | 关 | `1` = 从网关 `/v1/models` 拉真实清单（缓存 1 小时） |
| `MARVIS_USAGE_WS` | 开 | `0` = 关闭网关额度查询 |
| `MARVIS_RISK_AUTO_WS` | 开 | PC 端 4100404 时若 10123 可达自动 WS 重试一次；`0` 关 |
| `MARVIS_RETRY_PACING` | 开 | `0` = 403 自愈重试不纳入节奏闸（仅调试） |

（完整变量以 `src/` 实现为准：`grep -rho "MARVIS_[A-Z0-9_]*" src | sort -u`）

---

## 10. 诊断与自检

```bash
node scripts/cli.mjs doctor        # 一键诊断「模型不出字」：逐环查版本/配置/网关/账号/出票/上游
                                   # exit 0 = 全通；1 = 有环失败，直接指出挂在哪一环
node scripts/cli.mjs accounts list # 看账号：key / 卡片名 / QQ·微信 / 状态（--verbose 看细节）
node scripts/check.mjs             # 交付面自检（当前 42 项全绿）
node --test                        # 离线测试（不依赖真机 / 网络）
node scripts/probe-openclaw.mjs    # WS 通道诊断：mode / fileMode / envMode / overrideWarning
node scripts/probe-gateway.mjs     # 本地网关探活
node scripts/probe-served-model.mjs # 各槽位实际服务的模型（检测被降级）
node scripts/probe-vision.mjs      # 收图能力实测
```

**已知边界**：WS 通道多轮对话会被展平为单段 prompt；`usage` 在 WS 通道恒为 0（额度请走 gateway 的
`conversations_usage`）；每轮短连接、无自动重连。

---

## 11. 常见问题

| 症状 | 根因 | 处理 |
|---|---|---|
| `403 4100404`（卡片显示 503） | 账号/设备被风控 | 看第 6 节判读；单账号冷却可换号，多账号接连出现要换 IP / 重签 uskey |
| `401 4100403` | 登录态过期 | 检查 `MARVIS_REFRESH_LEAD_MS`；微信 token 只有 2h |
| `403 非法请求 / 4100406` | system 首行身份词命中内容过滤 | 开 `first_line_fallback`，或改「提示词首行替换」 |
| `400 4130001` / `400 无效模型id` | 把真实模型名当 `model` 传了 | 传**槽位名**（第 1 节） |
| `429 限流` 但配的是 relay | 父进程继承了 `MARVIS_WS_MODE=off`，环境变量优先级高于文件 | `node scripts/probe-openclaw.mjs` 看 `envMode`；在 magpie 启动脚本里 `[Environment]::SetEnvironmentVariable('MARVIS_WS_MODE', $null, 'Process')` |
| 配了 relay 却走成 auto | `openclaw.json` 带 BOM，`JSON.parse` 拒绝 → 配置被静默跳过 | `0.9.4` 起读取前 `replace(/^\uFEFF/,"")`；用无 BOM 的 UTF-8 写配置 |
| 回复里混英文思考 / 像乱码 | PC 客户端把 reasoning 拼进正文流 | 见第 7 节；确认插件 ≥ `0.9.13` |
| 额度卡片显示 0 | 上游营销额度未扣减 | `0.9.7` 起 used=0 时显示「共 10,000,000 tokens（上游未扣减）」 |

---

## 12. qimei36 缓存清理

设备指纹被硬拉黑后需要换 qimei36。清除位置（三处都要清）：

1. `%APPDATA%\Tencent\Marvis\electron_data\IndexedDB\https_marvis-client.yyb.qq.com_0.indexeddb.leveldb`
2. `%APPDATA%\Tencent\Marvis\electron_data\Local Storage\leveldb`
3. `<稳定资产目录>\qimei36.txt`（即 `~/.magpie-marvis-native/qimei36.txt`）

```powershell
python clear_cache.py     # 仓库根的脚本，一次清掉上面三处
```

清完**必须用一个全新的进程**再起网关 / 插件（不要在旧进程里 continue / resume，环境变量缓存会照旧）。
号码若没变：说明还有别的持久化位置，或该号码由硬件指纹决定。清理时先完全退出 Marvis 客户端与 magpie。

---

## 13. 手机端（`0.9.8` 起的变化）

`0.9.8` 做了瘦身，**删除**了手机端的三样东西：

- 手机端 QQ / 微信登录（`mobile-login.mjs`、本机粘贴页、`phone-setup.sh`、`build-phone-kit.mjs`）
- `remote` wss 手机会话域传输（抓 handshake.log 那条路，凭据 15–20 分钟就失效）
- Android FFI / 手机出票相关代码

> ⚠ **如果你现在手机上还能点 QQ / 微信登录，说明装的是 `0.8.9` 旧版**——仓库里 `0.9.x`
> 已不含这些代码（`src/marvis/mobile-login.mjs`、`phone-setup.sh`、`build-phone-kit.mjs`
> 都已不存在）。确认方法：
>
> ```bash
> node -e "console.log(require('./node_modules/magpie-marvis-final/package.json').version)"  # 或
> grep '"version"' ~/.config/magpie/plugins/node_modules/magpie-marvis-final/package.json
> ```
>
> 0.9.x 里手机端只保留「插件 + 本地网关」这一种组合。

**现在手机怎么用**：走 `gateway` 通道 —— 在 Termux / PRoot 里跑本仓库的 `gateway/serve.py`，
账号池与出票都在网关侧维护，插件本体不依赖任何 Windows 原生组件：

```sh
pkg install python curl -y
cd gateway && python serve.py        # 监听 127.0.0.1:8088
# 控制台 http://127.0.0.1:8088/ 里加号登录 Marvis
mkdir -p ~/.magpie-marvis-native && cat > ~/.magpie-marvis-native/gateway.json <<'EOF'
{ "mode": "gateway", "url": "http://127.0.0.1:8088/v1", "key": "", "timeoutMs": 600000 }
EOF
```

然后在手机 magpie 壳里导入本插件目录，供应商 `marvis` 加「本地网关」账号即可。

---

## 14. 历史沿革

`0.2.x` 现签修复 → `0.3.x` openclaw WS 传输 → `0.4.x` 抓包重连 / 熔断器 / 中文首行护栏 →
`0.5.x` 精简、HTTP 直连恢复 → `0.6.x` 正名为纯 magpie 插件 + 本地网关 → `0.7.x` 流式透传 /
指数退避 / 节奏闸 / 主动续期 → `0.8.x` 网关模式 + 按账号隔离 → `0.9.x` 面板收敛、并入网关源码、
PC-only 瘦身、思考与正文彻底分离。

原版 `MYCF711/magpie-marvis`（HTTP-only）2026-11-18 起停更；本仓库合并了
`MYCF711/magpie-marvis`、`cat-clash/magpie-marvis-ws`、`yy158358/Marvis-proxy-public` 三条线的可用成果。
网关协议与手机出票方案的思路来自 `yy158358/Marvis-proxy-public`（MIT），本插件的网关转发实现已改写为
通用 OpenAI 兼容转发。（原 `NOTICE.md` 已从仓库移除，归属信息在此保留。）

---

## 15. 文档索引

| 文件 | 内容 |
|---|---|
| [`CHANGELOG.md`](./CHANGELOG.md) | 逐版本变更历史（含每次修复的实测依据） |
| [`FIX-4100404.md`](./FIX-4100404.md) | 4100404 专项排查记录 |
| [`docs/`](./docs/) | 回归清单、补丁设计、503 优化方案、乱码定位手册 |
| [`gateway/README.md`](./gateway/README.md) | 本地网关完整文档 |
