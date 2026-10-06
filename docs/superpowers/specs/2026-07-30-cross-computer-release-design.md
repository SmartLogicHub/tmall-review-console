# 跨电脑发布包设计

## 目标

生成可直接复制到另一台 Windows 电脑使用的发布包：保留回复数据库，不复制原电脑的 Chrome 专用资料；新电脑首次使用时创建自己的浏览器资料并重新登录。

## 行为

- 发布包包含 `data/tmall-review-console.sqlite`。
- 发布包不包含 `data/browser-profile`、SQLite `-wal/-shm` 或任何 Windows 凭据。
- “登录已验证”只在真实淘宝页面验证成功后显示；仅保存账号密码显示为“已配置”。
- Chrome 启动失败返回明确提示，说明检查 Chrome、关闭 RPA/调试工具或重建浏览器资料，不再显示笼统的内部错误。
- 现有本机运行模式保持不变。

## 验证

- 打包测试断言数据库存在且浏览器资料不存在。
- API 测试断言仅保存凭据不会返回 `authenticated`。
- API 测试断言 `TmallBrowserLaunchError` 返回可读的 503 错误。
- 执行全量测试、类型检查、构建，并核对最终压缩包目录。

