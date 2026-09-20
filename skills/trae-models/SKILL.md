---
name: trae-models
description: 维护 ZCode 中 Trae 供应商的模型列表（与 trae2api 网关 /v1/models 对齐），并对网关做健康检查。当用户需要核对/同步 Trae 模型、诊断 Trae 网关或"模型不可用"问题时使用。
---

# Trae 模型同步与健康检查

本 skill 指导如何把 ZCode 里的 Trae provider 模型列表与本地 trae2api 网关的实际能力对齐，并排查"模型不可用"类问题。

## 1. 查看网关模型列表

```bash
node bin/cli.mjs status
```

会打印 `:19960` / `:19961` 两个端点的 `/v1/models` 模型数量与池状态。

`GET http://127.0.0.1:19960/v1/models` 返回模型数组，其 `id` 字段应与 ZCode 供应商配置一致。不一致时重跑：

```bash
node scripts/write-zcode-providers.js   # 从环境变量读 bearer，不落盘
```

## 2. 健康检查

```bash
node bin/cli.mjs doctor
```

检查 node 版本、依赖、根目录 `.env`、ZCode provider_config.json 与两个端口。

## 3. 常见故障对照

| 现象 | 处置 |
|---|---|
| 端口未监听 | 运行 `scripts/start-instances.ps1`；同时确认 Trae 客户端常驻（网关只读凭据，客户端负责保活） |
| 模型 4001/4005 | 该模型不在当前账号目录 → 先 `/v1/models` 核对再用 write-zcode-providers.js 重建 |
| 4017 risk control | 设备/IP 级风控，见 `docs/security.md`；凭据不得搬离源设备 |
| token 过期报错 | 打开 Trae 客户端让它自行刷新（self-renew 关闭的设计，见 `docs/security.md`） |

## 4. 安全红线（摘要）

- 凭据只存在于 `.env` / `storage.json`；绝不打印、绝不上传。
- 绝不把 `storage.json` 复制出源设备。
- `TRAE_POOL_SELF_RENEW=off` 必须保持，避免服务端轮换令牌族踢掉客户端登录。

---
EN summary: sync ZCode Trae provider model lists against the local trae2api gateway (`/v1/models`) and troubleshoot gateway/model health via `bin/cli.mjs`. Security: credentials never leave the device; keep self-renew off.