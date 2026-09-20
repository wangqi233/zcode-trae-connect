# NOTICE — Derived Distribution

本仓库是 **派生分发**（fork-style distribution），不是独立项目。

This repository is a derived distribution, not a standalone project.

## 上游 / Upstream

- 上游仓库： [a137460387/trae2api](https://github.com/a137460387/trae2api)
- 许可： MIT（`Copyright (c) 2026 trae2api contributors`）——上游代码与文件保留其原作者著作权与许可，见仓库内的上游 `LICENSE` 文本与上游仓库。
- 本仓库拷贝的上游文件（`src/`、`tests/`、`doc/`、`docs/PROTOCOL.md`、`web/`、`accounts/`、`scripts/` 下上游自有脚本、根级 `.bat/.sh` 辅助脚本、`package*.json`、`model-config.json`、`vitest.config.js`、`.github/` 等）按上游原样包含，**不做改动**，仅在上游 `3da7b58`（2026-09-17）基线上 **唯一一处派生改动**：

## 派生改动 / Only derived change

`src/auth.js` — 单账号路径 self-renew 守卫补丁（+25 行）

- **根因**：`refreshTokenIfNeeded()` 的单账号分支在 token 进入 30 分钟临期窗口时无条件调用 `ExchangeToken`；`ExchangeToken` 服务端轮换整个令牌族，会把同一账号在其他客户端实例的登录静默踢掉。池模式早已有 `TRAE_POOL_SELF_RENEW` 守卫（`_poolPrepareMember`），单账号路径缺失。
- **改动**：`TRAE_POOL_SELF_RENEW=off` 时——token 仍有效则继续用导入 token 服务（不提前刷新），过期才报错提示打开 Trae 客户端刷新；跳过日志按进程只打印一次（`_singleRenewSkipLogged`）。
- **PR**：已向 upstream 提交（`patch/selfrenew-single-account`），合并后可回归上游。尚未合并前，本仓库的该文件以补丁版为准。

## 新增内容 / New content (license: MIT, `(c) 2026 zcode-trae-connect contributors`)

`.zcode-plugin/`（plugin manifest）、`hooks/`、`bin/`、`skills/`、`scripts/start-instances.ps1`、`scripts/verify-instances.js`、`scripts/write-zcode-providers.js`、`scripts/remote-handshake.md`、`docs/`（install/remote/security）、`README.md`、`NOTICE.md`。

## 隐私与凭据 / Privacy & secrets

本仓库**不包含**任何运行时凭据、沙箱副本、日志或本机/设备的私密签名。您的 `.env`、`storage.json`、`instances/`、`sandbox/`、`logs/`、provider_config 备份均在 `.gitignore` 覆盖之下，绝不入库。

This repository contains no runtime credentials, sandboxes, logs, or private machine signatures. All local secrets are `.gitignore`-covered and never committed.

## 依赖 / Dependencies

发布包（release artifact）将 vendored `node_modules`；源码树不提交依赖。上游依赖声明见 `package.json`（`npm ci` 可复现）。