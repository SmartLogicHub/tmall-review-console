# `chromex.exe` Chrome 兼容设计

## 背景

部分 Windows 10 电脑安装的 Chrome 位于：

`%LOCALAPPDATA%\Google\Chrome\Bin\chromex.exe`

当前程序只自动识别、显示并接受文件名为 `chrome.exe` 的程序，因此文件选择窗口会隐藏 `chromex.exe`，后端也会拒绝手动输入的路径。

## 方案

- 保留现有标准 Chrome 路径识别。
- 新增 `%LOCALAPPDATA%\Google\Chrome\Bin\chromex.exe` 自动候选路径。
- 文件选择器同时显示 `chrome.exe` 与 `chromex.exe`。
- 后端路径校验仅接受这两个明确文件名，继续拒绝其他 `.exe`。
- 所选文件仍必须存在，并通过一次使用临时资料目录的真实浏览器启动验证后才能保存。
- 换电脑后保存路径失效时，继续回退到当前电脑的自动识别结果。

## 不采用的方案

- 不重命名 `chromex.exe`，避免破坏浏览器启动或更新。
- 不允许任意 `.exe`，避免误选无关程序。
- 不绕过真实启动验证，因为仅凭文件名无法证明该程序与 Patchright 兼容。

## 验收

- 自动识别能找到 `%LOCALAPPDATA%\Google\Chrome\Bin\chromex.exe`。
- 选择窗口能看到并选择 `chromex.exe`。
- `validateChromeExecutablePath` 接受 `chrome.exe`、`chromex.exe`，拒绝其他程序。
- 真实启动验证收到并启动所选的 `chromex.exe`。
- 原有标准 Chrome、取消选择、失效路径回退等测试继续通过。
