# Trae 协议实测记录

本文记录通过实测与抓包得到的 **Trae 上游协议细节**——认证、请求头、错误码语义、模型目录与区域差异。这些结论来自对官方客户端的观测，而非官方文档；每项尽量标注观测日期，便于判断时效性。

> 这些知识是本项目最难重建的部分。若你发现某项已过期，欢迎提 issue 或 PR 更正。

## 排队：CN vs SOLO

| 产品 | 常见 function | 热门模型排队 |
|---|---|---|
| Trae CN | `chat_v3` 通用池 | **很重**（常 1000+） |
| TRAE SOLO | `solo_work_lite` / `create_agent_task` | **较轻** |

本项目默认 `TRAE_PRODUCT=solo`，指定模型走 `solo_work_lite`，不要退回 CN 的 `chat_v3` 主路径。

## 已对齐（可用）

### 认证
- 目录：`%APPDATA%\TRAE SOLO CN\User\globalStorage\storage.json`
- 解密 `iCubeAuthInfo://icube.cloudide`（tc / AES-128-CBC）

### Headers（与 SOLO 日志一致）
| Header | 来源 |
|---|---|
| `x-app-id` | 固定 app id |
| `x-device-id` | `iCubeAuthInfo://icube-dc:<id>` |
| `x-machine-id` | `telemetry.machineId` |
| `x-ide-version` | manifest `appVersion` |
| `x-ide-version-code` | 日期型 |
| `x-device-brand` / `x-os-version` | SOLO 默认，env 可覆盖 |
| `x-flow-traceparent` | 本地生成 |
| `Authorization` | `Cloud-IDE-JWT <token>` |

### 对话通道
| 模式 | 本地 | 说明 |
|---|---|---|
| `auto` | `llm_utils_chat` + `inline_chat` | 最轻 |
| 指定模型 | `llm_utils_chat` + **`solo_work_lite`** + `config_name` | 与 SOLO 同池 |
| 完整 Agent | `create_agent_task` 骨架 | 未 100% 复刻 |

实测：`solo_work_lite + glm-5.2` 正常；`chat_v3 + glm-5.2` 易大排队（SOLO CN 默认实例场景）。  
注意：`TRAE_DATA_DIR` 固定到 `TraeWork-CN-N` 这类目录时，目录名不含 "solo" → `isSoloProduct()` 判 false → 默认走 `chat_v3`；要切回 SOLO 池需显式 `TRAE_PRODUCT=solo`。  
**2026-09-17 事故复现**：用暂存目录（名不含 solo）起临时网关测新导入账号，全部请求默认 `chat_v3`，新模型齐齐 4001，症状极像"账号无此模型权限"；`TRAE_PRODUCT=solo` 后同批模型全部可用。测账号/开账号池时务必显式 solo，勿凭 4001 下账号能力结论。

### 模型目录（重要）

`llm_utils_chat` 的 `config_name` 必须在 SOLO `get_detail_param(function=solo_work_lite)` 返回列表中。  
**不在列表**（如历史 `glm-5.1`）会立刻 `4001 param is invalid`——以 HTTP 200 + SSE error 事件返回，不触发换模/换号。

CN SOLO 模型名有两套格式（2026-09-12 实测）：

1. **第一方模型**：裸 `config_name`。`solo_work_lite` 目录共 38 个：`glm-5.2`、`glm-5-turbo`、`glm-5`、`glm-5.3`、`DeepSeek-V4-Pro/-Flash`（含 `-Official`）、`qwen3.8-max`、`qwen-3.7-plus`、`kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`、`Doubao-Seed-2.*`、内部代号 `sagitta`/`aquila`/`seed-code-pro-0430` 等。快照：`scripts/_solo-models-clean.json`。  
   **2026-09-17 复测（双账号、最小请求逐一验证）**：新代第一方裸名 `glm-5.3`/`kimi-k3`/`kimi-k2.7-code`/`qwen3.8-max`/`glm-5-turbo`/`Doubao-Seed-2.1-Pro` 经网关直调 `solo_work_lite` **全部可用**（此前"新模型 4023/需 custom_models 渠道"的记载不适用于第一方裸名），已收录 `model-config.json`：`glm-5.3`→tier1、`qwen3.8-max`→tier2。
2. **第三方模型（`<渠道>//<模型名>`，暂不可经网关调用）**：`get_detail_param` 目录里各 `custom_model_*` 条目带 `custom_models` 白名单（如 `Kimi-CN//kimi-k3`、`aliyuncs//qwen3.8-max`、`bigmodel-plan//glm-5.3`；约 167 个，渠道 `anthropic`/`openai`/`openrouter`/`vercel`/`deepseek`/`aliyuncs`/`volcengine`/`bigmodel`/`zai`/`siliconflow`/`gitee`/`Kimi-CN/Global`/`MiniMax-CN/Global` 等；`-plan`/`-agent-plan` 后缀疑似订阅计费通道）。这属于官方客户端 UI 选项层，**裸 `llm_utils_chat` 通道不认这些名字**：原样透传（请求体 `config_name`）→ `4001 param is invalid`（2026-09-12 实测 `anthropic//claude-opus-4-6`）；以 `config_name=custom_model_1M_text` + `model=Kimi-CN//kimi-k3` 直调返回 `4023 model is unknown`——客户端还携带 `encrypted_prompt_set` 等网关未复刻的加密参数（2026-09-10 实测）。另注意网关别名解析会子串匹配本地键、把 `//` 名悄悄改写（如 `deepseek//deepseek-v4-pro` 含本地键 `deepseek-v4-pro` → 上游实收第一方 `DeepSeek-V4-Pro`），看似调用成功实则不是第三方路由。真第三方路由需官方客户端的云端 agent 通道（`solo_agent_lite` + 完整 `model_info`：`ak`/`base_url`/`custom_model_type`），见 `TODO.md`。

两套目录各有独占模型、互不通用：`qwen3.8-flash`、`kimi-k2.8-preview`、`minimax-m2*`、GLM 旧系（4.6/4.7/5.1）只在 `chat_v3`（51 个）；`glm-5-turbo`、`kimi-k2.6`、`Doubao-Seed-2.0-Code`、`custom_model_claude`、`sagitta` 等只在 `solo_work_lite`。需要 `chat_v3` 独占模型时请求体显式传 `"function": "chat_v3"`（重排队，勿作主路径）。

**2026-09-10 实测（chat_v3 池 / TraeWork-CN-N 账号，最小请求逐一验证）**：

- 可用：`glm-5.2`、`glm-5`、`kimi-k2.6`、`qwen-3.7-plus`、`DeepSeek-V4-Pro`、`DeepSeek-V4-Flash`、`custom_model_deepseek_reasoner`（deepseek-r1，`toolcall_compatible=false`）
- 4001：`kimi-k3`、`kimi-k2.7-code`、`glm-5-turbo`（连同映射到它的 `glm-5.1`）、doubao 全系、`qwen3.8-max`——即上表"solo_work_lite 独占"名单，chat_v3 池本就没有，属目录差异而非全局下架
- `get_detail_param(chat_v3)` 返回 41 个 config_name，与本地 `model-config.json` 差异：+32（多为 `title_generation`/`fast_apply` 等内部工具模型，勿用 `fetch-models.js --update` 全量收录）/ −22

拉表：`node scripts/dump-model-detail.js`（SOLO 表，function 读 `TRAE_SOLO_FUNCTION`，默认 `solo_work_lite`）；`node scripts/fetch-models.js`（`chat_v3` 表，对比本地 `model-config.json`）。本地 `model-config.json` 别名可映射到上述两种格式；排队/错误降级也会跳过 4001/4023。

### OAuth
SOLO ClientID：`en1oxy7wnw8j9n`（`product.json` → `authConfig.SOLO.stable`）

## 国际版（SG）2026-09-17 实测

本机加装两个国际版产品并登录 SG 账号（API host `coresg-normal.trae.ai`，鉴权 host `growsg-normal.trae.ai`）：

| 产品 | 安装目录（`Local\Programs\`） | 数据目录（`%APPDATA%\`） | 产品身份 |
|---|---|---|---|
| TRAE SOLO 国际版（TraeWork） | `TRAE SOLO` | `TRAE SOLO` | `com.trae.solo.app` / `x-ide-version 0.1.65` |
| Trae 国际版（TraeCode） | `Trae` | `Trae` + `TRAE`（同账号） | `com.trae.app` / `x-ide-version 3.5.91` |

两族目录都已在 `_poolScanDirs()` 的 `SG_PRODUCT_DIRS` 内，热导入自动收池；同一 userId 登多个目录时按 `poolImportFromAuth` 的 userId 键**合并为一个成员**（保留 expiredAt 更新的一份）。

**edition 推导 bug（2026-09-17 修复）**：`decryptAuthData()` **不返回 `_edition` 字段**，而 `poolImportFromAuth` 原先写 `_edition: authInfo._edition || 'cn'`——于是**所有 SG 账号入池时都被错标成 `cn`**（CN 账号碰巧正确故长期未暴露）。后果：`_memberAuthHost()` 会拿 SG refreshToken 打 `api.trae.cn`（刷新必失败），且 edition 隔离后这些成员在 SG 上游下被错误过滤。已改为 `_editionFromAuth()`：优先显式 `_edition`，其次按 `host`（`growsg/coresg/coreva/trae.ai` → sg，`trae.cn/mchost.guru` → cn），再按 `userRegion.region`（SG/US → sg，CN → cn），最后才回落 `cn`。已修正池中两个错标成员的存量数据。

### 目录由产品身份决定，权益由账号档位决定

- **同一账号**（<intl-userId>9，Free）换 `x-ide-version` 请求：`0.1.65`（SOLO 身份）下 `solo_work_lite` 目录 13 个（含 `gpt-5.4`）且裸名直调可用；`3.5.91`（经典身份）下同目录只剩 `gpt-5.2`，直调 `gpt-5.4` → 4001。**网关默认头就是 0.1.65**（`getIdeVersion` 读 CN manifest 的 appVersion），SG 成员入池即可直调 `gpt-5.4`/`gpt-5.2`，无需改代码。
- **1005 = 套餐权益拒绝**（新错码，模型级，勿据此换号）：`gpt-6-astra`、`gpt-5.6-sol/terra/luna`、`gpt-5.5`、`glm-5.2` 在 Free 档一律 1005，换产品身份无效。UI 呈现随产品不同：TraeCode 国际版显示全量列表挂 🔒（Pro 升级入口），TraeWork 国际版 Free 直接隐藏。不把 1005 加入 `ACCOUNT_FAILOVER_CODES` 是正确的。
- **Free 档可调**（最小请求逐一实测）：`gpt-5.4`、`gpt-5.2`（双通道），`deepseek-v3.2`、`kimi-k2.5`、`gemini-3.1-pro`（含 `-paygo/-auto`、`3-flash-premium/-auto`、`gemini_2.5_flash_premium`）、`minimax-m3/m2.7`、`doubao-for-auto`、paygo GPT（`gpt-5.2-codex-paygo`/`gpt-5.1-paygo`/`gpt-5-paygo`）、`Dola-Seed-2.0-Code`。TraeCode UI 显示名 **Seed-2.1-Turbo** 即 `Dola-Seed-2.0-Code`（直呼 `Seed-2.1-Turbo` 等变体 4001——UI 友好名≠config_name）。快照：`scripts/_sg-models-clean.json`。
- `custom_model_*`（11-14 个）为 BYOK 槽位，未配 Key 时 4023，与 CN 结论一致。

### 协议细节与坑

- `llm_utils_chat` **无论 `stream:false` 与否都回 SSE**，解析一律按 SSE 处理。
- **所有 messages 的 content 必须数组形态**（`[{type:'text',...}]`）：字符串 content → HTTP 400 + 4001 `cannot unmarshal string into ...LLMRawMessageContent`。网关构造本就转数组，无需改。
- 原生推理档位字段 `user_message_context.model_info.reasoning_effort_level`（`minimal/low/medium/high`）：服务端**收下但无实测效果**（换零钱任务 n=2/档，推理 token 量无单调关系，发字段组反而低于 baseline；提示词注入 A/B 因账号 4008 中断待补）。真实客户端推理档位的线上字段未捕获——网关 think-effort 提示词注入仍是唯一已验证手段。
- **4008 配额是账号级**：一个账号测穿后全模型 4008（首个 SG 账号 7576... 即如此退役，且被登出后凭证目录被覆盖、等于退场）；与 CN 按模型的配额表现不同。
- 账号同时登多个客户端时，`TRAE_POOL_SELF_RENEW` 的换族会一次性踢掉所有客户端登录态（CN-12 事故机制同源）——SG 账号现同登 3 个产品目录，入池前权衡是否 `TRAE_POOL_SELF_RENEW=off`。

### 上游运行时切换（CN ⇄ SG）

`GET/POST/DELETE /v1/upstream`（`src/auth.js` 的 `setUpstreamEdition` 等）。POST `{"edition":"cn"|"sg"}` 即时生效，无需改 `.env`，无需重启。

- **优先级**：运行时覆盖 > `TRAE_EDITION` env > 磁盘自动探测（`detectEdition` 按 storage.json mtime 挑 CN/SG 目录）。
- **切换语义**：同步重算 `getApiHost()`/`getAuthHost()`/`getTraeDataDir()`，并清空 `_cachedAuthInfo`/`_cachedStorageMtime`/`_poolActiveUserId`，下一个请求即走新上游。
- **池按 edition 隔离**：`_poolHealthy` 增加 edition 判定，CN 上游只挑 `_edition=cn` 成员、SG 只挑 `sg`——避免拿 CN token 打 SG host（或反之）。`poolStatus()` 新增 `upstream` 与每成员 `edition`/`served`/`benched` 字段。
- **持久化**：状态文件默认 `%APPDATA%/traework-pool-upstream.json`（可 `TRAE_UPSTREAM_STATE_FILE` 覆盖）。**不可放进 `TRAE_POOL_DIR`**——`_poolLoad()` 会读该目录所有 `*.json` 并当成账号成员（断言测试抓到过这个 bug）。
- **`.env` 里 `TRAE_EDITION` 已显式设为 cn**：运行时覆盖优先级更高，所以两者不冲突；`DELETE /v1/upstream` 会退回 env 值。
- **顺手修的真实 bug**：`getAuthHost()` 原先 SG 分支返回 `DEFAULT_HOST_SG`（chat host `coresg-normal`），会导致 SG token 刷新打到错的 host。已新增 `DEFAULT_AUTH_HOST_SG = https://growsg-normal.trae.ai`（取自 SG 客户端 storage.json 实测值，可 env 覆盖）并修正三处调用。
- 验证：28 项断言（切换/host/池过滤/非法输入/大小写容错/持久化/新进程读取/env 优先级）+ 真实网关端点实测（含重启恢复、SG 上游真实请求打通到上游返回 4008）。

#### 切换后的使用约束（2026-09-17 实测结论）

**模型名两区不通用**：CN/SG 目录各 47 个模型里只有 3 个交集（`glm-5.2`、`minimax-m3`、内部工具 `summary`）。CN 独占 22 个（glm-5.3 / qwen3.8-max / Doubao 系），SG 独占 24 个（gpt-5.4 / gpt-5.2 / Gemini 系 / kimi-k2.5 / seed）。切区后用错区的模型名 → **4001 param is invalid**。

**fallback 链在 SG 侧会连环撞墙**：`model-config.json` 是 CN 向的，`fallback.mappings` 目标（`glm-5-turbo`/`glm-5`/`qwen-3.7-plus`/`Doubao-Seed-2.0-Code`/`DeepSeek-V4-Flash`）**在 SG 全部不存在**。切到 SG 后走 fallback 的请求会连续 4001 直到耗尽备选，症状是"所有 claude-* 请求挂了"而非清晰的模型不存在。

**Claude 别名在 SG 不可用**：`claude-opus-4-*` / `claude-sonnet-4-*` 等别名全映射到 `glm-5.2`（CN 模型）。SG 侧 `glm-5.2` 存在但被 **1005 权益拦截**（Pro 档锁定），Free 档实际不可用。**SG 侧请直接用原生名**。

**为什么不做按模型自动路由**（决策记录）：理想是模型名驱动选区，但需要 ① 把 `model-config.json` 拆成 CN/SG 两份（含别名与 fallback 链分区）② 把 host 从全局单例改为每请求计算 ③ 凭证缓存 `_cachedAuthInfo`/`_storageMtimeChanged` 按区隔离，否则按请求切区会让全局单例来回翻动、出现间歇性故障。在 SG 侧无可用产能（唯一账号配额耗尽）时无法端到端验证，故暂缓。**重启此项的前置条件**：SG 账号配额恢复 → 先补 SG 模型配置（别名/fallback）→ 再评估路由改造。

## 未完成：`create_agent_task`

真机：

```text
POST /api/agent/v3/create_agent_task
body ≈ 180–210KB
agent_type=function=solo_work_lite
```

卡点：summary template / `encrypted_prompt_set` 非 tc，需抓完整明文 body。  
步骤见 `TODO.md`。探测：`node scripts/probe-solo-create-agent.js --model glm-5.2`。

## `.env` 要点

```env
TRAE_PRODUCT=solo
TRAE_EDITION=cn
# TRAE_DATA_DIR=%APPDATA%/TRAE SOLO CN
# TRAE_SOLO_FUNCTION=solo_work_lite
# TRAE_OAUTH_CLIENT_ID=en1oxy7wnw8j9n
```

陷阱：设 `TRAE_DATA_DIR` 后 `detectEdition()` 的 cn/sg 候选解析到**同一文件**（mtime 相等）→ 误判 `sg`。固定实例时必须同时显式 `TRAE_EDITION=cn`。
