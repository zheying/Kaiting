# E2E 浏览器隔离与启动失败验收

## 问题证据

近期 macOS 崩溃报告与 E2E 启动日志的进程 ID 一致：由 Node 启动的测试 Chrome 在 `_RegisterApplication` / `TransformProcessType` 阶段收到 `SIGABRT`，尚未进入测试页面。一次运行中，9 个用例各自重启浏览器，重复触发相同失败；同一范围在允许启动浏览器的执行环境中通过。

这些记录证明测试实例启动失败，不能据此断言用户日常 Chrome 进程也崩溃。修复时不关闭用户浏览器、不读取或复用个人浏览器资料。

## 预期行为与失败方式

| 场景 | 预期行为与证据 |
| --- | --- |
| 正常执行 | 使用 Playwright 管理的独立 Chromium / Chrome for Testing，临时 profile；记录浏览器版本、路径和解码检查结果 |
| 安装缺失 | 明确提示安装测试浏览器；不回退到系统 Chrome，不自动覆盖现有浏览器 |
| 旧配置指定系统 Chrome | 明确拒绝该配置，提示移除；不能静默采用个人浏览器 |
| 已知受限的 macOS seatbelt 执行环境 | 在启动浏览器前停止，说明须由获准的执行环境运行；不修改环境标志绕过限制 |
| 浏览器启动异常 | 全局预检只尝试一次，失败即结束；不让每个用例重复启动 |
| AAC 解码不可用 | 关闭预检浏览器并失败，不跳过音频验收 |
| 执行中再次发生故障 | 保持零重试，并在首个用例失败后停止后续用例，限制反复启动 |
| 仅列出范围、无匹配用例 | 不启动浏览器或服务 |
| 有头调试与 CI | 使用同一浏览器策略；预检与实际测试采用相同有头/无头模式 |

## 验证范围

1. 先以隔离的进程边界验收预检：统计启动、关闭次数，检查失败码与 JSON 产物；不故意启动受限 Chrome 复现系统崩溃。
2. 定向运行真实 AAC 直传、ALAC/FLAC 转码的播放、暂停、seek、自然结束与重播 E2E，保留音频只读、SQLite、trace、截图及报告证据。
3. 比较验证前后 Chrome 崩溃报告和已运行的系统 Chrome 主进程；只记录进程级证据，不访问个人浏览器资料。
4. 运行类型检查、构建与 diff 检查；本次不运行完整业务测试或部署 NAS。

浏览器策略依据：[Playwright 浏览器安装与通道说明](https://playwright.dev/docs/browsers)、[Chrome for Testing](https://developer.chrome.com/docs/automation-and-testing/chrome-for-testing)。当前锁定的 Playwright 1.63.0 将独立 `chromium` 构建标记为 Chrome for Testing；实际 AAC 支持必须经过预检与真实播放验证。
