# 保存反馈胶囊验证

2026-09-28：全局与沉浸播放器中的保存提示共用播放错误的紧凑胶囊样式。弹窗内保留内联提示。

## 浏览器验证

在独立的临时预览标签页验证，没有操作真实曲库或服务端数据。

- 桌面 1108 × 879：保存中和保存失败均为 52px 高，距 56px 高的播放器 12px。
- 手机 393 × 852：保存反馈与播放器均为 52px 高，间隔 12px；重试和取消的触控高度均为 44px。
- 窄屏 320 × 667：失败文案完整显示，页面无横向溢出。
- 深色主题：胶囊使用深色半透明背景，文字可读，仍为 52px 高。
- “完成保存”与“重试保存”：提示消失，收藏状态更新。
- “取消保存”：提示消失，原收藏状态不变。
- `playlist-save-error`：仍为弹窗内联错误，重试后按草稿名称保存并关闭弹窗。
- `player-offline`：仍为 52px 高、距播放器 12px，仅保留“重新连接”操作。
- 验证期间未发现浏览器控制台错误。

## 构建检查

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run prototype:build`：通过，仍有原有的超过 500kB 分包提示。
- `git diff --check`：通过。

## 截图

- `desktop-saving.png`、`desktop-error.png`：桌面保存中与保存失败。
- `mobile-saving.png`、`mobile-error.png`：手机保存中与保存失败。
- `mobile-narrow-error.png`：320px 窄屏。
- `mobile-playback-reference.png`：播放错误回归。
- `dialog-error.png`：弹窗内联错误。
- `dark-saving.png`：深色主题。
