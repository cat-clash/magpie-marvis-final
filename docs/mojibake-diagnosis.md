# 乱码定位手册：先分三层，再动代码

> 记录 2026-11-29 一次完整的排查：用户报「调用 marvis 插件的回复出现乱码」，
> 最终定位为**读取侧代码页**问题（工具显示层），插件与网关的数据链完全清白。
>
> 写这份文档的目的不是记流水账，而是把「怎么在 10 分钟内判定责任层」固化下来，
> 避免下一次再对着 `app.log` 怀疑插件编码。

## 1. 三层分类（先判层，再改代码）

| 层 | 判据 | 典型特征 | 处置方向 |
|---|---|---|---|
| **数据层** | 落盘正文里出现 U+FFFD（`�`） | `�` 或连片问号，重放请求仍复现 | 流式管道：跨分片 UTF-8 解码、流被中途掐断 |
| **显示层** | 用 `[IO.File]::ReadAllLines($p,[Text.Encoding]::UTF8)` 读**正常**，工具输出却乱 | 乱码字符是「合法汉字」，形如 “閭€璇风爜” | 改读取方式，**不改代码** |
| **语义层** | 「乱码」其实是正文里正在被讨论的样本词 | 用户/模型自己贴进去的例子 | 不是故障 |

判层只需一条命令：**用显式 UTF-8 再读一遍**。读出来正常 → 立刻排除数据层。

## 2. 2026-11-29 实测：一个完整的假阳性

### 2.1 现象

`app.log` 里的这行：

```
2026/11/29 01:42:47 plugin [warn]: [loomy] 邀请码兑换失败（不影响签到）：邀请码绑定：邀请码不可用
```

在工具输出里显示成：

```
2026/11/29 01:42:47 plugin [warn]: [loomy] 閭€璇风爜鍏戞崲澶辫触...
```

第一反应是「插件把 UTF-8 字节按 GBK 写进去了」。**错的。**

### 2.2 字节级证据

```
"邀请码兑换失败" UTF-8 字节 = E9 82 80 E8 AF B7 E7 A0 81 E5 85 91 E6 8D A2 E5 A4 B1 E8 B4 A5
  → 以 UTF-8 解码 = 邀请码兑换失败          ← 文件里的真实内容
  → 以 GBK(936) 解码 = 閭€璇风爜鍏戞崲澶辫触   ← 工具输出里看到的"乱码"
```

**方向搞反了**：不是插件写坏了，是读取方用 GBK 解了 UTF-8 字节。

### 2.3 同一文件两种读法对照

| 读法 | 结果 |
|---|---|
| `Get-Content $log -Tail N`（PowerShell 5.1 默认） | MOJIBAKE（含 U+95AD「閭」） |
| `[System.IO.File]::ReadAllLines($log, UTF8)` | CLEAN（含 U+9080「邀」） |

### 2.4 宿主侧排除

`app.log` 共 21601 行，其中 14213 行含中文；“[workbuddy-tasks] 已拉起守护进程（pid 24088）”
等日志全部正常。若宿主真按 GBK 解码插件 stdout，这些行会一起坏 —— 它们没坏。

**结论：宿主读插件 stdout 是对的，文件本身是干净 UTF-8。**

### 2.5 三重叠加的根因（Windows PowerShell 5.1）

1. `Get-Content` 的**默认编码是 ANSI（当前代码页 936）**，与控制台 `chcp` 无关；
   `[Console]::OutputEncoding = UTF8` 也管不到它。只影响读取，不影响文件。
2. 机器上已有的 `profile.ps1`（本想修编码）**从未生效**：执行策略全 `Undefined`
   （= Restricted），profile 根本没加载，报 `running scripts is disabled on this system`。
3. 即使加载也仍会错：该 profile 是 **UTF-8 无 BOM**，而 PS 5.1 读 `.ps1` 同样按
   ANSI(936) —— 中文注释会先变乱码，再喂给解析器。本次排查中的验证脚本就因此炸过一次：
   `The string is missing the terminator: '.`

### 2.6 修复（Windows 侧，与插件无关）

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force

# 只钉读取侧。故意不改 Set-Content / Out-File：
# 5.1 写 UTF8 会带 BOM，会污染 magpie 的 json 配置（JSON.parse 遇 BOM 直接抛错）。
$PSDefaultParameterValues['Get-Content:Encoding']   = 'utf8'
$PSDefaultParameterValues['Select-String:Encoding'] = 'utf8'
$PSDefaultParameterValues['Import-Csv:Encoding']    = 'utf8'
```

外加：**含中文的 `.ps1` 必须存成 UTF-8 带 BOM**（或把脚本写成纯 ASCII）。

前后对照（ASCII-only 探针，避免探针自己踩坑）：

```
修后 profile 生效 : GetContent_Encoding_default = utf8   MojibakeChar_95AD = False  VERDICT = CLEAN
修前 -NoProfile   : GetContent_Encoding_default = (none) MojibakeChar_95AD = True   VERDICT = MOJIBAKE
```

## 3. 插件侧的证据：物理上不会产出乱码

对整个插件源码做静态检索：

```
iconv | latin1 | 'binary' | charset | gbk | gb2312 | gb18030  →  0 处编码转换
```

所有解码路径都是 `toString("utf8")` 或 `new TextDecoder()`：

- `src/marvis/gateway.mjs` — WS 帧解码
- `src/marvis/openclaw.mjs` — WS 帧解码
- `src/marvis/directnet.mjs` — `Buffer.concat(chunks).toString("utf8")`
- `src/marvis/desktop.mjs` — `Buffer.from(b64,"base64").toString("utf8")`

**没有任何一处按系统代码页转码**，所以：插件只可能在「流被中途掐断」时表现出半截字符，
不可能把完整中文编坏。

### 3.1 已知的真实"像乱码"的窗口（2026-11-28）

| 时间 | 事件 | 用户可见后果 |
|---|---|---|
| 22:41:31 | `plugin host quit: signal: terminated` | 回复在句子中间断裂，客户端拿到半截多字节序列 |
| 22:49–22:53 | `didn't load` / `no such plugin` 连续 129 次（插件路径指向已删除的临时会话目录） | 每次调用都在残缺流上收尾 |
| 22:56:26 | `plugins.json` 路径修正（已备份） | 之后 `didn't load` 归零 |

同期 `mid-reply` / `connection lost` 各 23 次、`ECONNRESET` 530 次 —— 这才是「乱码感」的真身。

## 4. 复发检测（字节级探针）

不要靠肉眼判断，跑一次字节级对照：

```js
// 关键断言：三个计数必须全 0
U+FFFD=0  SPLIT_MULTIBYTE_BOUNDARY=0  CHUNK_FATAL_UTF8_ERROR=0
```

做法：以 `stream: true` 逐块 POST 网关 `/v1/chat/completions`，
用 `new TextDecoder("utf-8", { fatal: true })` 逐块试解（抛错即非法 UTF-8），
并统计块尾是否为不完整多字节序列。

2026-11-29 01:56 之后的实测：

```
HTTP_STATUS=200  CHUNKS=6  BYTES=4990
U+FFFD=0  SPLIT_MULTIBYTE_BOUNDARY=0  CHUNK_FATAL_UTF8_ERROR=0
DELTA_TEXT="中文编码测试成功，一二三四五。"
```

## 5. 潜在缺陷（未触发，但值得记）

`gateway.mjs` 的 `new TextDecoder().decode(ev.data)` 没有传 `{ stream: true }`。

- **当前安全**：WebSocket `message` 事件投递完整帧，不跨消息切多字节字符。
- **风险**：若这条链路将来改成 HTTP 分块流（或某些实现把一帧拆多次投递），
  跨块切断的 UTF-8 序列会被替换成 U+FFFD，症状正是「中文偶发乱码」。
- **若要加固**：二进制分支改为「累积 Buffer → 整体解码」，不要对每个分片独立解码，
  也不要在消息边界之间保留 `stream: true` 的解码器状态（那会把上一帧的残留拼进来）。

## 6. 铁律

1. **报"乱码"前先用显式 UTF-8 读一遍**。读出来正常就是读法问题，别改代码。
2. `chcp 65001` 只改控制台显示，**不改变 `Get-Content` 的默认解码**。
3. 写带中文的 `.ps1` → UTF-8 **带 BOM**，或纯 ASCII。
4. 判断「插件编码坏了」之前，先确认 `app.log` 里**其它插件的中文是好的**——
   一处坏是插件，处处坏才是宿主。
