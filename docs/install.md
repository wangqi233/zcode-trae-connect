# 安装 / Install（Trae 接入 ZCode）

中文为主；文末附 EN quick start。

## 0. 前置

- Windows 10/11；Node 18+（`node -v` 确认）。
- 已登录的 Trae 客户端（`Trae CN` 和/或 `TRAE SOLO CN`）。**客户端保持常驻**——续期交给它，网关只读。
- 可选：ZCode 桌面版（用于插件 hook 自动保活）。

## 1. 拉取与依赖

```bash
git clone https://github.com/<you>/zcode-trae-connect.git
cd zcode-trae-connect
npm ci
```

## 2. 网关配置（关键安全项）

```bash
copy .env.example .env
```

编辑 `.env`：

| 变量 | 值 | 说明 |
|---|---|---|
| `TRAE_EDITION` | `cn` | 国内版（SOLO 亦视为 cn 系：`solo`/`solo-cn`） |
| `TRAE_DATA_DIR` | **沙箱副本路径** | 复制 Trae 数据目录到副本（如 `D:\trae-sandbox-solo`），**绝不指向真实目录** |
| `TRAE_POOL_SELF_RENEW` | `off` | **必须**：杜绝网关轮换令牌族踢掉客户端登录 |
| `API_KEY` | 自设随机值 | ZCode provider 用它鉴权，记下来别丢 |
| `TRAE_MANUAL_TOKEN` | （留空） | 用客户端凭据而非手工 token |

> 为什么要 `TRAE_DATA_DIR` 沙箱副本：即使网关逻辑有写回，也只污染副本，动不到真实登录态。

## 3. 启动与自检

```bash
node bin/cli.mjs serve            # 前台运行（默认 :19960）
# 或后台：
powershell -ExecutionPolicy Bypass -File scripts/start-instances.ps1
node bin/cli.mjs status           # 应看到 /v1/models 与模型数
```

两个端口的默认约定：`:19960` TRAE SOLO CN、`:19961` Trae CN。单实例可只跑 `:19960`。

## 4. 写入 ZCode provider 配置

```bash
node scripts/write-zcode-providers.js --dry-run     # 先校验形状
$env:TRAE_SOLO_API_KEY='...'; $env:TRAE_CN_API_KEY='...'
node scripts/write-zcode-providers.js               # 写真实配置（自动备份）
```

- 脚本从环境变量读 key，文件内无任何凭据。
- ZCode 数据根不在默认位置时：`$env:ZCODE_DESKTOP_ROOT='E:\...\.zcode\v2'`（见脚本头注释的探测方法）。

## 5. ZCode 插件化（推荐）

- 把仓库目录作为 ZCode 插件启用（识别 `.zcode-plugin/plugin.json`）。
- 每次会话开始，`SessionStart` hook 自动确保网关在线（`hooks/service-ensure.mjs`）。
- 只想让插件只读探测、不自动拉起进程：`TRAE_AUTO_START=0`。
- 带远程笔记本网关时设 `TRAE_REMOTE_BASE_URL`（可选探测）。

## 6. 验证

```bash
node scripts/verify-instances.js
# 期望：HTTP 200 + 模型回显一次最小补全
```

---

## EN quick start

```bash
npm ci && copy .env.example .env   # edit: TRAE_EDITION=cn, TRAE_DATA_DIR=<sandbox copy>, TRAE_POOL_SELF_RENEW=off, API_KEY
node bin/cli.mjs serve
node bin/cli.mjs status
node scripts/write-zcode-providers.js
```

Always run the gateway against a *sandbox copy* (`TRAE_DATA_DIR`) of the Trae data dir and keep `TRAE_POOL_SELF_RENEW=off`. Details: the tables above; security: `docs/security.md`.