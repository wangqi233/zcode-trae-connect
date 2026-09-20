# Remote Handshake Protocol (清单模板 v2 + 回报 Schema)

跨设备接入的**协议化**流程：主控端生成清单 → 笔记本端（人或 AI）逐项执行 → 回报结构化 JSON → 主控端用 CLI 校验后按结果配置。

核心原则（不可妥协）：

1. **凭据永远不离开源设备。** `storage.json` 等同账号本体，不得复制、上传、发送到任何其他机器。
2. **网关在来源设备本地运行**，主控只通过网络调用；设备/IP 级风控（如 4017）以来源设备的真实指纹通过。
3. **只读探测优先**：先完成下方「A 只读探测」，确认可行后再启动网关、开防火墙。
4. **网关不自刷新令牌**（`TRAE_POOL_SELF_RENEW=off`）：`ExchangeToken` 会轮换整个令牌族，静默踢掉该账号在其他客户端的登录。客户端常驻负责保活。
5. **端口最小开放**：防火墙只放行网关监听端口，且建议源地址白名单到主控 IP。

---

## A. 只读探测清单（回报 `probe` 节）

- [ ] 记录 Trae 安装的产品目录（Trae CN / TRAE SOLO CN / 其他），存在若干 `User/globalStorage/storage.json`？
- [ ] 各目录登录态是否完整（存在 `iCubeAuthInfo://icube.cloudide` 或加密凭据，可解密）——只报告「存在/加密/长度」，**不打印明文**。
- [ ] `TRAE_EDITION` 应为 `cn`（国内版）。
- [ ] 客户端是否常驻运行（保持登录 + 自发续期，这是方案前提）。

## B. 网关启动清单（回报 `gateways` 节）

- [ ] 复制凭据目录为新沙箱副本（禁止直接指向真实数据目录），并在网关 `.env` 设置 `TRAE_DATA_DIR=<沙箱副本>`。
- [ ] `.env` 设置 `TRAE_EDITION=cn`、`TRAE_POOL_SELF_RENEW=off`、`TRAE_MANUAL_TOKEN` 留空；`API_KEY` 为自设随机值（主控端用它鉴权）。
- [ ] 启动网关：`node src/server.js`（工作目录=网关根目录），确认监听端口（默认 19960）。
- [ ] 本机自测：`curl http://127.0.0.1:19960/v1/models` 返回模型列表；一次最小 chat completion 成功。

## C. 网络开放清单（回报 `firewall_allows` 节）

- [ ] Windows 防火墙入站规则只放行该端口（可选源 IP 白名单=主控 IP）。
- [ ] 记录内网 IP + 端口供主控引用（回报中 IP 可选，如不便提供可留空，由主控实测）。

## D. 禁止事项（回报 `issues` 节，违反则回报并停止）

- [ ] 不把 `storage.json` 发给任何设备。
- [ ] 不改 Trae 官方客户端文件（只读）。
- [ ] 不伪造设备标识。
- [ ] 不把主控端账号登到笔记本。
- [ ] 不打印明文 token / refreshToken。

---

## 回报 Schema（v2）

```json
{
  "schema_version": 2,
  "probe_date": "YYYY-MM-DDTHH:mm:ssZ",
  "edition": "cn",
  "product_dirs_count": 1,
  "auth_state": {
    "plaintext_exists": true,
    "encrypted_exists": false,
    "decryptable": true
  },
  "gateways": [
    {
      "port": 19960,
      "listening": true,
      "models": 14,
      "sample_model": "glm-5.3"
    }
  ],
  "firewall_allows": ["19960/tcp (source <desktop-cidr>)"],
  "issues": [],
  "notes": "客户端常驻，网关只读，self-renew=off"
}
```

字段约束：

- `schema_version`: 必须为 2
- `gateways`: 数组，每项 `port`（number）+ `listening`（boolean）
- `firewall_allows`, `issues`, `notes`: 字符串数组 / 字符串，可为空

不含主机名、MAC、序列号等非必要标识；IP 为可选，仅在 `firewall_allows`/`notes` 中由执行方决定是否提供。

校验命令（主控端）：

```bash
node bin/cli.mjs remote check report.json
```

通过后，主控按 `docs/remote.md` 把该网关注册为 ZCode provider（baseUrl 指向笔记本内网地址）。