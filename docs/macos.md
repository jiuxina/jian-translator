# macOS 桌面适配

macOS 使用 `app/macos/` 的 Electron/Chromium 桌面壳，共用 `web/` 的界面与光学引擎。
参考的 SVG backdrop 折射在 WKWebView 中不可作为同等实现，因此不使用 Pake 的 macOS
WKWebView 路径。没有另外制作磨砂或着色替代效果。引擎会拒绝已知不支持的浏览器并显示错误。

## 平台行为

- 主窗口使用原生交通灯、隐藏标题栏和拖动区；前端不显示 Windows 窗口按钮或缩放热区。
  普通窗口前端圆角为 22 px，全屏/最大化事件会清除圆角裁剪。
- 默认显示窗口与划词快捷键为 `Cmd+Alt+I` 和 `Cmd+Alt+T`，支持录制 Command；
  `Cmd+,` 打开设置。关闭主窗口后保留菜单栏托盘，退出由系统应用菜单执行。
- 字体通过 macOS `NSFontManager.availableFontFamilies` 获取系统实际字体列表，不使用固定样例。
  字体、字重、文字颜色和三类玻璃预设与其它端使用同一偏好结构。
- 悬浮窗引导由 `desktop/patch/setup.rs` 提取，主界面和悬浮窗共用引擎；复制通过原生剪贴板。
  主界面粘贴在用户点击后调用独立原生命令，正文下载只允许主窗口本地生成的 blob，
  并打开原生 TXT 保存对话框。
  选区捕获仅在用户触发划词后进行，需要 macOS 辅助功能与 System Events 自动化权限。
- 自动启动读取并设置 macOS 登录项，仅安装后的应用可修改。设置持久化采用同目录临时文件、
  刷盘与原子重命名；快捷键或登录项失败时回滚并向设置页报告。
- 自定义 `jian://app` 协议只分发本地应用资源。预加载仅暴露命令白名单；
  主进程进一步检查窗口、顶层 frame 和完整文档 URL。剪贴板写入仅允许悬浮窗，读取仅允许主窗口。
  Node 集成关闭，隔离与 sandbox 开启；阻止应用页面导航至远程站点。
- 关于和更新的仓库链接在系统浏览器中打开。更新检查只请求公开 GitHub Releases 元数据。

## 构建

在 Mac 安装 Node.js 22 或以上，执行：

```bash
cd app/macos
npm ci
npm run build
```

依赖锁定为 Electron `45.3.2`、electron-builder `26.18.0`，锁文件入库。
`build.mjs` 从 Rust 维护源提取共享悬浮窗脚本，为六项前端资源生成 SHA-256 清单，
通过 macOS `sips`/`iconutil` 生成图标，再构建 universal `.app`、DMG 与 ZIP。
默认输出到新的 `.build/macos-presets-<时间>/` 目录；`IT_OUT_DIR` 可指定隔离输出目录。
根目录的 `bash app/rebuild.sh` 在 Darwin 上也转交这个脚本。

`npm run build -- --dir` 只生成应用目录。`node app/macos/build.mjs --prepare-only`
可在 Windows 上提取共享资源，供纯 Node 检查使用；它不构建 Mac 二进制。
签名、公证由 Mac 构建环境的发布配置提供，本轮不读取或生成开发者证书。

## 已验证与待验证

Windows 上完成了 JavaScript 语法、纯设置与 URL/IPC 边界测试、共享悬浮窗一致性、
Chromium 中的 macOS 桥接模拟、交通灯预留区和 Command 快捷键记录。
这些结果不能代表 Mac 本机执行了 JXA、系统字体、登录项或选区捕获。

本轮未在 Mac 上构建或启动 `.app`，没有交付未经验证的 DMG。仍需在真实 Mac 上完成
Intel/Apple Silicon 构建、原生缩放/全屏、玻璃绘制与性能、字体、复制粘贴、保存下载、
快捷键和登录项验收；签名、公证状态也需由该构建环境确认。
