# Changelog

## 0.1.0 — 草创（早期开发）

首个可安装版本。功能框架已成形；接口与行为仍可能随迭代调整，不建议用于生产关键链路。

- 两种响应模式：
  - `stream`：SSE 流式（start / chunk / done | error），客户端断连即取消，15s keepalive；
  - `callback`：入队返回 `task_id`，调度执行完成后 POST 回调，失败自动重试（送达状态机）。
- 任务底座：SQLite（node:sqlite，WAL）存储任务与日志；激活时救援未完成任务；
  `biz_id` 请求级幂等（409 + 原任务信息）；回调按 `biz_id + replay_seq` 防重放对账。
- 会话能力：`session_id` 复用即多轮上下文；进程重启经 `resume()` 恢复；同会话任务串行。
- 认证：RSA-SHA256 请求签名 + 时间戳容差 + nonce 防重放；业务级/管理级 scope 分级。
- 管理接口：任务列表/详情/日志/取消（中止 live agent）/重播/优先级/运行统计。
- 参考工具页（`/static/`）：管理运维、接入测试、工具（浏览器本地生成密钥对，私钥不落盘）。
- 文档与示例：配置参考 `docs/config.md`；独立 profile 接入示例 `examples/dsh-profile/`。

已知边界（详见 README / 源码注释）：
- 尚未在真实 DSH 进程完成端到端集成验证（真实模型 turn / kill 救援 / 重启 resume /
  同 session 串行需在部署环境按示例验证）；
- Electron 部署形态的 webServer 监听待实测；
- 回调 `callback_url` 存在 SSRF 暴露面（V1 面向内网 + 签名客户端）。

# 0.1.0-20260907
feat: 发布v0.1.0修订版本，完善功能与文档

新增会话ID隔离机制，优化签名路径处理，添加LLM能力支持与文件日志功能，重构前端页面布局与文档结构，修复数据库表名与路径配置，实现流式推理增量回调，更新README与配置说明