# MouseX

MouseX 是一个 Tauri 客户端鼠标回报率测试工具。界面使用网页 UI，真实采样由 Rust 原生输入后端提供；浏览器模式仅用于本机开发调试。

## 客户端开发

```bash
npm install
npm run tauri:dev
```

## 构建客户端

```bash
npm run tauri:build
```

## 本机网页调试

仅用于调试 UI，不用于真实回报率测试：

```bash
npm run dev
```

```text
http://127.0.0.1:5173/
```

## 原生采样

客户端运行时，前端会自动检测 Tauri runtime，并调用 Rust 采样命令。客户端模式不使用 WebHID 作为主采样路径：

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

## 测试模式

- 客户端移动测试：macOS 优先使用 IOHID report 原始采样；其他平台当前使用 Rust 回退采样。
- 客户端静置测试：只有设备在静置时仍输出原始输入报告，才可能测得静置回报率。
- 本机浏览器调试：可能使用 WebHID 或指针事件备用路径，结果不作为真实回报率依据。

## 跨平台边界

客户端 UI 可在 macOS、Windows、Linux 上运行。真实 HID 级鼠标回报率应通过 Tauri/Rust 桌面模式采样，并逐个平台接入对应原始输入 API。目前 macOS 已接入 IOHID report；Windows Raw Input 和 Linux evdev/libinput 仍待补齐。
