# 远程笔记本接入 / Remote Laptop Setup

场景：你（主控）想用**朋友的 Trae 账号**模型，但朋友的凭据**不能搬到你机器上**。

- Trae 有设备/IP 级风控（官方对错误码 4017 的描述即「设备/IP 级风控，常见于多账号同设备」）。凭据离开原始设备后，指纹不匹配会被拒。
- 因此方案是**反向的**：网关跑在笔记本上，读笔记本本地凭据、用笔记本真实设备指纹，从服务端看与「朋友自己用」无异；主控通过内网连过来。

```
主控 ZCode  ──LAN──→  笔记本 trae2api 网关（读笔记本凭据）
                        ▲ 客户端常驻，自己刷新 token
```

## 步骤 / Steps

1. **主控生成清单**：`node bin/cli.mjs remote` 并阅读 `scripts/remote-handshake.md`，把清单交给笔记本侧执行（人，或笔记本侧 AI）。

2. **笔记本执行（只读 → 网关 → 防火墙）**，逐项回报结构化 JSON：
   - A 只读探测：产品目录、登录态（只报告存在/加密/长度）、`TRAE_EDITION=cn`、客户端常驻？
   - B 启动网关：沙箱副本 `TRAE_DATA_DIR`、`TRAE_POOL_SELF_RENEW=off`、自设 `API_KEY`、监听端口、本机自测 `/v1/models` 与一次补全。
   - C 防火墙：**只放行网关端口**，建议源 IP 白名单 = 主控 IP。
   - D 禁止事项逐条勾选（storage.json 不外发、不改客户端、不伪造设备、不打印 token）。

3. **主控校验回报**：
   ```bash
   node bin/cli.mjs remote check report.json
   ```

4. **主控注册 provider**：在 ZCode 的 `provider_config.json` 中新增一条，`baseUrl` 指向笔记本内网地址（如 `http://<laptop-ip>:<port>/v1`），`apiKey` 为笔记本网关设的 `API_KEY`。可手动编辑或用 `scripts/write-zcode-providers.js` 扩展条目；改前务必备份目标文件。

5. **保持客户端常驻**：笔记本 Trae 客户端不能关——续期由它完成，网关只读转发。

## 安全要点 / Security notes

- 端口只放行网关监听端口；源地址收敛到主控 IP。
- 凭据不跨设备；回报文件不含 token，也不建议含主机名/MAC。
- 网关权限最小化：主控只拥有调用该网关的鉴权 key，不接触笔记本数据目录。
- 参考协议全文：`scripts/remote-handshake.md`。

EN: remote setup keeps credentials on the laptop; the desktop only calls its gateway over LAN. Follow the handshake in `scripts/remote-handshake.md`, validate the returned report with `node bin/cli.mjs remote check`, then register the provider in ZCode with the laptop's LAN base URL. Keep the laptop client running (it owns token refresh).