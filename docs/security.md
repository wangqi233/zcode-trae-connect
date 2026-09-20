# 安全红线 / Security Red Lines

这些是不可谈判的底线。违反任一条都可能泄密或触发账号风控。

Non-negotiable. Any violation risks leaking credentials or tripping account risk-control.

## 1. 凭据边界 / Credential boundaries

- `storage.json` **等同账号本体**：绝不复制、上传、发送到任何其他机器/仓库/聊天。
  `storage.json` is the account itself: never copy, upload, or send it anywhere.
- 网关数据目录必须指向**沙箱副本**（`TRAE_DATA_DIR=<副本>`），绝不指向真实 Trae 数据目录。
  Always point `TRAE_DATA_DIR` at a sandbox copy.
- 任何文件、日志、回报**不含** token / refreshToken 明文；报告只陈述「存在 / 加密 / 长度」。
  Never print token material; report existence / encryption / length only.

## 2. 令牌保活边界 / Token lifecycle

- `TRAE_POOL_SELF_RENEW=off` **必须保持**。`ExchangeToken` 会在服务端轮换整个令牌族，把同一账号在其他客户端的登录静默踢掉。
  Must stay off. `ExchangeToken` rotates the whole token family server-side, silently logging the account out of other clients.
- 客户端负责续期：Trae 客户端应常驻；网关只读转发。
  The client owns renewal: keep it running; the gateway is read-only.

## 3. 网络边界 / Network boundary

- 远程跨设备：防火墙**只放行网关端口**，源地址白名单收敛到主控 IP；凭据不跨设备（网关跑在来源设备上）。
  Remote linking: open only the gateway port, whitelist the desktop's source IP; credentials never cross devices.
- 本机场景：网关仅监听 `127.0.0.1` 即可，不必对网卡开放。
  Local scenario: bind `127.0.0.1` only.

## 4. 提交边界 / Git hygiene

- `.env`、`instances/`、`sandbox/`、`logs/`、`service*.log`、`**/.mimosa/`、`*.bak-before-*` 全部被 `.gitignore` 覆盖——不要 `git add -f`。
  All covered by `.gitignore` — never `git add -f`.
- 提交前跑一次污点扫描（<your-vcs-tool> 全文搜索下表中的本机痕迹签名）。
  Before committing, grep for your own machine signatures (paths, hostnames, MACs, bearer-like blobs).

## 5. Provider 配置维护 / Provider config care

- ZCode 的 `provider_config.json` 用严格 zod 校验：一个未知键会**静默丢弃整组** personal providers。修改前一键备份；用 `scripts/write-zcode-providers.js`（allowlist 校验）改写，不要手填随机键。
  ZCode validates strictly; one unknown key discards the whole personal provider set. Back up first; use the allowlist-validated script.
- 写 ZCode 配置前完全退出 ZCode 主进程（含托盘），否则运行态会覆盖外写内容。
  Fully quit ZCode (incl. tray) before writing its config files.

---

**自查命令 / Self-check**

```bash
node bin/cli.mjs doctor          # 环境与端口
node bin/cli.mjs status          # 模型数与池状态
node scripts/verify-instances.js # 一次最小实测
```