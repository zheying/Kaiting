# 测试浏览器崩溃修复验收

## 结论

已将 E2E 从系统 Chrome 改为 Playwright 管理的独立 Chrome for Testing，并增加启动前保护、一次性预检和失败即停。本次真实播放验收无新增 Chrome 崩溃报告，用户原有系统 Chrome 主进程保持不变。

历史崩溃报告中的进程 ID 与测试启动日志匹配，调用栈停在 macOS 应用注册阶段，异常为 `SIGABRT`。此前一次运行连续启动失败 9 次，尚未打开业务页面；相同测试在获准执行环境中可运行。证据指向测试实例受运行环境限制，不能据此推断用户日常 Chrome 进程也崩溃。

## 修复内容

- `playwright.config.ts` 固定使用 `chromium` 通道及临时测试资料，不再采用系统 `chrome` 通道；启动超时 20 秒，零重试，首个用例失败即停止后续用例。
- `scripts/e2e-browser.mjs` 供 E2E 与 CI 共用：识别已知的 macOS seatbelt 限制，启动前退出；检查独立浏览器安装及 AAC 能力；失败时不回退、不重试，保留 `browser-preflight.json`。
- `scripts/e2e.mjs` 在构建和启动之前收集匹配用例。无匹配立即报错，不启动浏览器。此步骤是必需的，因为 Playwright 的全局初始化发生在执行阶段的用例收集之前。
- CI、README、AGENTS 和测试说明统一改用独立浏览器安装方式。未改变应用功能或部署 NAS。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run test:browser` | 8 项通过：受限环境、缺安装、旧通道、启动失败、AAC 缺失、有头/无头、只预览 |
| `npm run test:selection` | 16 项通过，包含零匹配退出与精确测试范围验证 |
| macOS 实际受限执行 | 在全局预检退出，未运行用例、未启动浏览器 |
| AAC / ALAC / FLAC 实际播放 | 3 项通过，涵盖播放、暂停、seek、自然结束和刷新后从零重播 |
| 增加用例收集阶段后的 AAC 复验 | 1 项通过 |
| 测试期间 Chrome 状态 | 0 份新增崩溃报告；原系统 Chrome 主进程及启动时间未变 |
| 数据与页面 | 4 次用例执行的源音频哈希不变、SQLite 完整、无浏览器页面错误 |
| 静态检查 | 类型检查、生产构建、脚本语法检查、`git diff --check` 通过 |

测试浏览器为 Chrome for Testing 153.0.8010.12。仅验证本机 macOS 的上述范围；没有运行完整业务 E2E、Linux CI 或真实 iOS 设备验收。

## 复验与证据

```bash
npx playwright install chromium --no-shell
npm run test:browser
npm run test:selection
npm run test:e2e -- playback --list -g '实际播放、暂停 seek'
npm run test:e2e -- playback -g '实际播放、暂停 seek'
```

真实浏览器命令必须从允许启动浏览器的终端或获准执行环境运行，不清除受限环境标志绕过保护。

本地原始证据均位于被 Git 忽略的 `artifacts/`：

- `browser-isolation/acceptance.json`、`verification.json`、`before.json`、`after.json`：保护验收、崩溃和进程对照。
- `test-selection/acceptance.json`：命令选择验收。
- `e2e/2026-09-28T17-10-46-080Z-playback/`：受限环境启动前退出证据。
- `e2e/2026-09-28T17-11-13-664Z-playback/`：3 类真实播放报告、trace、截图、请求日志、音频哈希与 SQLite 校验。
- `e2e/2026-09-28T17-13-33-664Z-playback/`：最终命令流程的 AAC 复验及源码指纹。

需求与失败模式见 [验收计划](../testing/browser-isolation-plan.md)。
