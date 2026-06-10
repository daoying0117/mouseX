# MouseX

MouseX 是一个网页 UI 的鼠标采样测试工具。桌面模式使用 Tauri + Rust 原生输入采样，并把采样数据推送给同一套 UI；浏览器模式才会尝试 WebHID，无法读取标准鼠标 HID report 时在移动测试中回退到浏览器指针事件采样。

## 网页模式

```bash
npm install
npm run dev
```

本机访问：

```text
http://127.0.0.1:5173/
```

## Tauri 桌面模式

开发运行：

```bash
npm install
npm run tauri:dev
```

构建安装包：

```bash
npm run tauri:build
```

桌面模式下，前端会自动检测 Tauri runtime，并调用 Rust 采样命令。此模式不使用 WebHID 作为主采样路径：

- `native_sampler_info`
- `start_native_sampling`
- `stop_native_sampling`

Rust 侧通过 `native-sample` 事件推送采样间隔到 UI。采样源会显示在顶部 badge：

- `native-iohid-report`：macOS 下通过 IOKit `IOHIDManagerRegisterInputReportWithTimeStampCallback` 接收鼠标 input report，并用 IOHID 时间戳计算间隔。
- `native-rdev-fallback`：IOHID 初始化失败或非 macOS 平台的临时回退路径，来自系统全局鼠标事件，不等同于真实 HID report。

项目结构已经把 UI 和采样源解耦，后续可以继续补齐平台专用后端：

- Windows：Raw Input
- Linux：evdev / libinput

macOS 第一次运行原生监听时，可能需要在系统设置中授予辅助功能或输入监控权限。

## 内网访问

开发模式监听所有网卡：

```bash
npm run dev:lan
```

构建后用 HTTP 在内网分发：

```bash
npm run build
npm run serve:lan
```

默认端口是 `4173`，可通过 `PORT=8080 npm run serve:lan` 修改。

HTTP 内网地址可以使用网页 UI 和移动测试备用采样，但不能启用 WebHID。WebHID 需要安全上下文：HTTPS 或 localhost。

## 内网 HTTPS

如果内网环境需要尝试 WebHID，请使用 HTTPS，并让客户端浏览器信任证书：

```bash
npm run build
SSL_KEY=/path/to/key.pem SSL_CERT=/path/to/cert.pem npm run serve:https-lan
```

默认 HTTPS 端口是 `4443`，可通过 `PORT=8443` 修改。

注意：即使在 HTTPS 下，Chrome 仍会保护 generic mouse / keyboard 等标准 HID collection。标准鼠标通常无法通过 WebHID 直接读取 report；只有设备暴露可访问的厂商自定义 HID collection 时，WebHID 路径才可能可用。

## 测试模式

- Tauri 桌面模式：macOS 优先使用 IOHID report 原始采样；其他平台当前使用 Rust 回退采样。
- 浏览器移动测试：优先使用 WebHID `inputreport`；不可用时使用 `pointerrawupdate` / `pointermove` 备用采样。
- 浏览器静置测试：只能使用 WebHID report。普通标准鼠标静止时通常不会上报，且标准鼠标 collection 可能被浏览器保护。

## 跨平台边界

网页 UI 可在 macOS、Windows、Linux 的 Chromium 浏览器中运行。真实 HID 级鼠标回报率受浏览器安全策略限制；严格采样应使用 Tauri/Rust 桌面模式，并逐个平台接入对应原始输入 API。目前 macOS 已接入 IOHID report；Windows Raw Input 和 Linux evdev/libinput 仍待补齐。
