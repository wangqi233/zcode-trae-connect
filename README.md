# zcode-trae-connect

把 **Trae 桌面 App**（`Trae CN` / `TRAE SOLO CN`，及可选的远程笔记本 Trae）的模型，通过本地 `trae2api` 网关，以 OpenAI 兼容供应商的形式接入 **ZCode**。零配置插件壳 + 安全默认（禁用服务端令牌族自动轮换）。

Bring **Trae desktop-app** models (`Trae CN` / `TRAE SOLO CN`, plus an optional remote laptop Trae) into **ZCode** as OpenAI-compatible providers, through the local `trae2api` gateway — with a zero-config plugin shell and safe defaults (no server-side token-family rotation).

> 本仓库是 [a137460387/trae2api](https://github.com/a137460387/trae2api) 的派生分发（MIT）。派生差异仅一处补丁，见 [NOTICE.md](NOTICE.md)。本插件壳、Hook、CLI、部署脚本与文档为新增内容（MIT）。本仓库不含任何运行时凭据/沙箱/日志。
>
> This repository is a fork-style distribution of [a137460387/trae2api](https://github.com/a137460387/trae2api) (MIT). The only derived change is the auth patch in `src/auth.js` (see [NOTICE.md](NOTICE.md)). The plugin shell, hooks, CLI, deploy scripts and docs are new (MIT). No runtime credentials, sandboxes, or logs are committed.

---

## 快速开始 / Quick Start

前置：Windows + Node 18+、已登录的 Trae 客户端（CN / SOLO）。

```bash
npm ci                          # 安装网关依赖
copy .env.example .env          # 编辑：TRAE_EDITION、TRAE_DATA_DIR(沙箱副本)、TRAE_POOL_SELF_RENEW=off、API_KEY
node bin/cli.mjs serve          # 启动网关（默认 :19960）
node bin/cli.mjs doctor         # 健康检查
node bin/cli.mjs status         # 模型数量与池状态
node scripts/write-zcode-providers.js   # 写入 ZCode provider 配置（dry-run 先用 --dry-run）
```

ZCode 插件化（推荐）：

1. 把本仓库作为 ZCode 插件启用（目录含 `.zcode-plugin/plugin.json`）。
2. 每次会话开始，`SessionStart` hook 自动确保网关在线（`hooks/service-ensure.mjs`），配置 `TRAE_AUTO_START=0` 可关闭自动启动、保持只读。

详细： [docs/install.md](docs/install.md) · 远程笔记本：[docs/remote.md](docs/remote.md) · 安全红线：[docs/security.md](docs/security.md)

EN: Quick start above; full install in `docs/install.md`, remote-laptop setup in `docs/remote.md`, security red lines in `docs/security.md`.

---

## 架构 / Architecture

```
ZCode                                  Trae 桌面客户端
 ┌───────────────────┐          ┌──────────────────────────┐
 │ provider: trae-*  │          │ Trae CN / TRAE SOLO CN   │
 │  └ OpenAI 兼容     │          │  └ storage.json（凭据）    │
 │     http://127.0.0.1:19960 ──┼─→ 本地 trae2api 网关       │
 │     http://127.0.0.1:19961    │     （只读凭据 + 客户端保活）│
 └───────────────────┘          └──────────────────────────┘
（可选）ZCode ──LAN──→ 笔记本 trae2api 网关（凭据永不离开笔记本）
```

- 网关读取登录过的 Trae 数据目录获取凭据，向本地起 OpenAI 兼容 `/v1` 服务。
- **self-renew 默认关闭**：网关不发 `ExchangeToken`，令牌续期完全交给 Trae 客户端自己完成，杜绝「网关轮换令牌族 → 踢掉 App 登录」。
- 凭据副本必须放沙箱目录（`TRAE_DATA_DIR` 指向副本）。

EN: The gateway reads Trae's logged-in data dir and serves an OpenAI-compatible `/v1` endpoint locally. Self-renew is off by default — the client alone refreshes credentials, so the gateway can never rotate a token family the app relies on. Always point `TRAE_DATA_DIR` at a sandbox copy.

---

## 目录 / Layout

| 路径 | 说明 |
|---|---|
| `src/` `tests/` `docs/` `web/` … | 上游 trae2api 原样（除 `src/auth.js` 补丁） |
| `.zcode-plugin/plugin.json` | ZCode 插件 manifest（SessionStart hook） |
| `hooks/service-ensure.mjs` | 会话开始确保网关在线 + 可选远程探测 |
| `bin/cli.mjs` | serve / setup / doctor / status / remote |
| `scripts/start-instances.ps1` | 参数化启动一个/两个网关实例 |
| `scripts/write-zcode-providers.js` | 写 ZCode provider 配置（env 读 key） |
| `scripts/verify-instances.js` | 实例实测（一次最小 chat completion） |
| `scripts/remote-handshake.md` | 跨设备握手协议（清单 v2 + 回报 schema） |
| `docs/` | 安装 / 远程 / 安全 双语文档 |
| `NOTICE.md` | 派生与许可证说明 |

EN: layout above — upstream tree plus the plugin shell, hooks, CLI, parameterized deploy scripts, handshake protocol and docs.

---

## 开发 / Development

```bash
node --check src/*.js            # 语法校验
npm test                         # 上游 vitest 套件（含 self-renew 用例）
node bin/cli.mjs doctor          # 环境自检
```

发布包将 vendored `node_modules`（开箱即用零配置）；源码仓库不提交依赖（`.gitignore` 覆盖）。

EN: release artifacts vendor `node_modules` for zero-config installs; the source tree never commits dependencies.

## 许可证 / License

MIT，细则见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

EN: MIT. Details in LICENSE and NOTICE.md.