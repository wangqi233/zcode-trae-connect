# TODO

## 已知缺口

- [ ] 第三方模型路由（`渠道//模型名`，如 `Kimi-CN//kimi-k3`、`aliyuncs//qwen3.8-max`）：官方客户端走云端 agent 通道（`solo_agent_lite` + 完整 `model_info`：`ak`/`base_url`/`custom_model_type`）承载，裸 `llm_utils_chat` 通道透传该名字会 4001 / 4023。需要对官方客户端抓包，对齐 `encrypted_prompt_set` 等加密参数。
  - 注：对应的**第一方裸名**（`kimi-k3`/`qwen3.8-max`/`glm-5.3` 等）已验证可直调，无需走此通道。
- [ ] 模型表自动同步：从上游 `get_detail_param` / 客户端 `state.vscdb` 生成 `model-config.json`，避免手工维护导致幽灵模型名。

## 改进

- [ ] 单测补齐：数据目录探测、请求头构造、模型名解析
- [ ] 文档整理：`docs/` 与 `doc/` 两个目录合并统一

## 已完成

- [x] 区域配置表集中化（`src/realms.js`）：host / 默认版本 / 模型归属收归一处
- [x] 凭证区域由凭证自身推导（不再用"当前选中区域"反推账号归属）
- [x] 按请求自动选区：池内含双区域账号时，按模型名路由到对应区域
- [x] 上游运行时切换：`GET/POST/DELETE /v1/upstream`，即时生效免重启，状态持久化
