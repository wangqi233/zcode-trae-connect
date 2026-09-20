# 账号池目录（account pool）

本目录是 `TRAE_POOL_DIR` 的默认位置，存放多账号池的成员文件。

## 文件格式

每个账号一个文件：`account-<userId>.json`。字段说明：

| 字段 | 含义 |
|------|------|
| `userId` | 账号 ID（文件名即用它，也是池内去重键） |
| `account` | 账号资料（用户名/邮箱等，仅用于展示） |
| `token` / `refreshToken` | 访问令牌与刷新令牌 |
| `expiredAt` / `refreshExpiredAt` | 令牌过期时间 |
| `host` / `userRegion` | 该账号所属区域（决定走哪个上游） |
| `_edition` | `cn` 或 `sg`（国内版 / 国际版） |
| `deviceIds` | 该账号专属的设备指纹（入池时自动生成并冻结） |
| `enabled` | `false` 表示人工下架，轮换会跳过 |
| `dead` / `exhaustedUntil` / `lastError` | 运行时健康状态，自动维护 |

## 添加账号

推荐让网关自动收池（热导入），不要把 `storage.json` 直接拷进本目录：

1. 在某个 Trae 客户端登录目标账号；
2. 网关启动后会在下次取凭证时扫描产品数据目录，自动生成成员文件；
3. 多开实例同理：把 `storage.json` 放到 `%APPDATA%\TraeWork-CN-<N>\User\globalStorage\` 即可（只需目录结构，不需要装客户端）。

## 管理

- **下架**：把成员文件的 `"enabled"` 改为 `false`，轮换会跳过它（保留凭证，便于随时恢复）。
- **删除**：直接删除该 JSON 文件。
- **查看**：`GET /v1/pool` 返回池状态（含每个成员的 realm 与是否可服务）。

## ⚠️ 安全

**本目录中的 token 是明文，等同于账号本体。** 请：

- 不要提交到版本库（本目录已被 `.gitignore` 排除）；
- 不要同步到网盘、不要打进备份包；
- 一旦泄露，立即在源客户端退出登录，使该 token 失效。

自用部署可以把本目录指到仓库外（更安全）：在 `.env` 里设置 `TRAE_POOL_DIR` 为绝对路径。
