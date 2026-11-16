# 笺 技术文档

这份文档面向开发者和维护者，记录架构、构建、验证与历史实现。
面向普通用户的功能介绍和安装说明见仓库根目录的 `README.md`。

Windows、macOS、Android 与网页共用的翻译界面。`web/` 是界面、主题和交互的源码；
Windows 通过 Pake/Tauri 加载本地页面，macOS 使用 Chromium 桌面壳，Android 使用 WebView。

当前源码版本为 `2.2.0`；既有发布包 `output/笺-2.1.0.exe`、`output/笺-2.1.0.msi`、
`output/笺-2.1.0.apk` 保留不覆盖。新发布包使用版本化文件名，校验值见 `output/SHA256SUMS.txt`。
电脑点击左上角“笺”、手机点击底栏右侧齿轮打开菜单，再进入“设置”即可调整外观与翻译偏好。
模式和模型滑块支持按住横向拖动，越过相邻项阈值时立即切换；文本滚动条随主题显示为透明轨道与细圆角滑块。
设置分类使用连续滑块与内容淡入淡出；卡片、Tab 滑块和按钮分别使用参考页最匹配的液态玻璃预设。
“液态玻璃”按调整对象显示 6、4、3 项公开滑条；旧材质、强度、透出和扁平光学参数已移除。
旧注入脚本与主题资源也已从源码和后续 Android 资源输入中移除；历史安装包继续保留。
Windows 普通窗口外圆角为 22 DIP，最大化与全屏时清除裁剪，卡片圆角仍可单独设置。
参考实现说明与当前运行时验收状态见 [界面主题记录](ui-theme.md) 和
[桌面集成说明](desktop-integration.md)。关于页移除渐变图标，保留名称、版本与仓库链接。
“设置 → 更新”可开关启动自动检查，也可立即检查；自动检查每 24 小时最多一次，
读取仓库的 GitHub 正式发布并提供发布页链接，失败、限流及暂无正式版本均有明确状态。
完整的父子依赖、覆盖顺序和平台差异见 [设置项关系简报](settings-audit.md)。
上一轮安装包为 `output/笺-2.2.0-界面优化.exe`、`output/笺-2.2.0-界面优化.msi`、
`output/笺-2.2.0-界面优化.apk`；应用版本保持 `2.2.0`，原有发布包继续保留。
本轮交付为 `output/笺-2.2.0-交互优化.exe`、`output/笺-2.2.0-交互优化.msi`、
`output/笺-2.2.0-交互优化.apk`，包含手机底栏、安全区、拖动选择、滚动条和浮窗背景范围修正。
全量替换液态玻璃后的包为 `output/笺-2.2.0-液态玻璃.exe`、
`output/笺-2.2.0-液态玻璃.msi`、`output/笺-2.2.0-液态玻璃.apk`；
Android 包使用 versionCode `5` / versionName `2.2.0`。本轮校验值见 `output/SHA256SUMS.txt`。

## 本地验证

需要 Node.js 22 或以上以及 Chrome。无需安装前端依赖。
性能优化的实现、前后测量与复现方式见 [性能优化记录](performance.md)。

```powershell
node tests/serve-preview.mjs web 8899
```

另开独立 Chrome 调试会话，指定 `--remote-debugging-port=9223` 和位于 `.build/` 的
独立 `--user-data-dir`，然后执行：

```powershell
node tests/verify-motion.mjs
node tests/verify-liquid-glass.mjs
node tests/verify-stream-writer.mjs
node tests/verify-image-import.mjs
node tests/verify-settings-preview.mjs
node tests/verify-segment-drag.mjs
node tests/verify-updates.mjs
node app/macos/build.mjs --prepare-only
node tests/verify-macos.mjs
```

回归使用本地桥接替身并拦截外部请求，不调用翻译接口。界面设计、验证记录和历史成品说明见
[ui-theme.md](ui-theme.md)。
`IT_CDP_ORIGIN` 可指定其他 Chrome 调试地址，`IT_PREVIEW_ORIGIN` 可指定其他本地预览地址。
Android 连续输入、拖动、窗口变化与后台光学图生成另由
`node tests/verify-android-interactions.mjs` 验证；该探针使用合成 Android 桥、
390 × 844 / DPR 3 视口和 CPU 4 倍降速，不依赖真实照片或翻译内容。
支持 Worker / OffscreenCanvas 的 Android WebView 使用后台生成光学贴图，
不支持或生成失败时使用原算法完整回退；六项网页资源与桌面共用的方式不变。
上一任务最终离线浏览器回归为 `127/128`；覆盖连续动画、设置事务、窗口桥接契约、
移动端触控、旧偏好迁移和高对比背景下真实折射像素变化。唯一失败是语言轮盘反向动画的固定帧采样，
针对性动画时钟探针已确认正向与反向位移正常；液态玻璃计算测试由
`node tests/verify-liquid-glass.mjs` 单独验证。离线 Chromium 结果不代表已完成打包后 Windows
WebView2 或 Android System WebView 的实机视觉验收。
本轮新增预设、更新检查与 macOS 桥接的验证记录见桌面集成文档。

## Windows 构建

需要 Git Bash、Node.js、Rust MSVC 工具链及 WebView2。当前补丁针对 **Pake 3.18.0**；
将该版本安装在 `.build/npm-global`，仅在构建进程设置 `npm_config_prefix` 指向该目录，
再用 Git Bash 执行 `app/rebuild.sh`。补丁应用器会把 `desktop/` 的源码复制到本地 Pake 模板。

```powershell
$env:npm_config_prefix = "$PWD/.build/npm-global"
$env:IT_OUT_DIR = "$PWD/.build/release-stage"
& 'D:\Program Files\Git\usr\bin\bash.exe' app/rebuild.sh
```

Git Bash 安装位置因机器而异，使用本机实际路径。默认构建输出在 `output/`；设置 `IT_OUT_DIR`
可把产物写到隔离目录，正在运行的桌面程序可以继续工作。

## macOS 构建

在 Mac 安装 Node.js 22 或以上，然后在 `app/macos/` 执行 `npm ci` 和 `npm run build`。
构建使用锁定的 Electron/Chromium，生成通用架构 DMG/ZIP；`app/rebuild.sh` 在 Darwin
同样转交此构建流程。详情和平台验收范围见 [macOS 适配](macos.md)。
当前 Windows 环境不能替代 Mac 的构建、签名、公证或原生交互验收。

## Android 构建

需要 JDK 17、Android SDK 35 和 Gradle wrapper。`android/local.properties` 仅存本机 SDK
路径；发布签名从 `android/signing.properties` 读取，可参考同目录的 example。密钥和真实
签名配置均不入库。缺少签名配置时仍可执行 Debug 编译，Release 打包需要完整本地配置。

构建前的 `syncWebAssets` 只覆盖 `web/` 六项资源，不删除源资源或 assets 目录。
在 `android/` 执行：

```powershell
.\gradlew.bat -g ..\.build\gradle-home :app:assembleRelease --offline --console=plain
```

当前版本为 Android versionCode `5` / versionName `2.2.0`，Windows 安装包版本 `2.2.0`。

## 自动发布

推送到 `main` 或推送 `v*` 标签会触发 [.github/workflows/release.yml](.github/workflows/release.yml)。
工作流分别在 Windows、macOS 与 Ubuntu 运行器上构建三端产物，最后调用
`scripts/prepare-release.mjs` 生成规范命名附件、`RELEASE_NOTES.md`、`SHA256SUMS.txt`
和来源清单。标签构建会把附件与发布说明上传到对应的 GitHub Release；
普通分支构建只保存 `prepared-release` 附件，用于发布前审阅。

Android Release 优先读取 `ANDROID_KEYSTORE_BASE64` 和
`ANDROID_SIGNING_PROPERTIES_BASE64` 两个仓库 Secrets，并在构建前还原到
Gradle 已配置的 `android/keystore/release.keystore` 与 `android/signing.properties`。
Secrets 缺失时自动退回 debug 签名。macOS 包未做 Developer ID 公证，
首次打开仍需按系统提示确认。发布说明模板在 `docs/releases/v<版本>.md`，
新增版本前应先补充对应文案。

## 版本管理

源码、资源、Gradle wrapper、文档和测试入库。依赖缓存、构建目录、发布二进制、预览媒体、
本机配置与签名文件保留在工作区但由 Git 忽略。`output/SHA256SUMS.txt` 记录发布包校验值。
