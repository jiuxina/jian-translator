# 笺 技术文档

这份文档面向开发者和维护者，记录架构、构建、验证与历史实现。
面向普通用户的功能介绍和安装说明见仓库根目录的 `README.md`。

## 文档维护约定

根目录 `README.md` 面向用户，只保留产品介绍、功能、安装、使用与反馈入口。
开发过程、修复经过、测试统计、本地构建路径、签名状态和待办事项统一写入 `docs/`，
不追加到 README。实现与验证分别记录在相应专题文档，构建和交付状态记录在
[Release 准备记录](release-preparation.md)；桌面产物详情记录在
[桌面集成说明](desktop-integration.md)。

## 编译后验证约定

按用户要求，常规打包采用精简验证：构建成功后，一次核对产物类型、版本、原应用名称与
应用标识，确认本次变更涉及的资源已打入包内，并更新交付文件哈希。需要签名的产物只做
必要的签名检查。已有的同源码验证结果直接复用，不重复编译、不在打包后重跑整套回归，
也不默认追加浏览器、原生窗口或跨平台探针。

功能修改期间执行与变更直接相关的最小检查；只有失败、新修改或尚未解决的具体问题，
才追加相应的定向诊断。确需完整回归时，在源码和相关文档完成后执行一次，结果单独记录。

## 架构与当前能力

Windows、macOS、Android 与网页共用的翻译界面。`web/` 是界面、主题和交互的源码；
Windows 通过 Pake/Tauri 加载本地页面，macOS 使用 Chromium 桌面壳，Android 使用 WebView。

当前源码版本为 `2.3.0`；既有发布包 `output/笺-2.1.0.exe`、`output/笺-2.1.0.msi`、
`output/笺-2.1.0.apk` 保留不覆盖。新发布包使用版本化文件名，校验值见 `output/SHA256SUMS.txt`。
电脑点击左上角“笺”、手机点击底栏右侧齿轮打开菜单，再进入“设置”即可调整外观与翻译偏好。
模式和模型滑块支持按住横向拖动，越过相邻项阈值时立即切换；文本滚动条随主题显示为透明轨道与细圆角滑块。
设置分类使用连续滑块与内容淡入淡出；液态玻璃仅用于按钮、交互轨道和滑块，
卡片、菜单、下拉弹层和悬浮窗内容使用静态磨砂，不挂载光学图层或 backdrop 模糊。
“液态玻璃”按磨砂面板、滑块、按钮分别显示 1、4、3 项有效控件；
旧版 `card` 光学值保留保存兼容，产品面板仅消费不透明度。
手机底部 Tab 与设置入口使用相同透明按钮玻璃，设置仅显示齿轮图标。
所有模型与设置分类滑块始终使用液态玻璃，按住、拖动、松开或取消不切换材质；
Tab 选中滑块保留原有静止外观，并持续使用透明填充与相同折射参数。
语言下拉打开、刷新和选择后均不自动聚焦编辑字段；手动点击搜索框仍可搜索。
手机语言框展开后保留原边框，不加粉色展开描边；键盘操作继续显示焦点轮廓。
界面标签默认不可长按选择，原文、实际译文及可编辑输入保留正常选择与复制。
Tab 与设置入场前预热并检查当前尺寸的玻璃 PNG 已解码；冷目标等待准备完成，
已预热目标直接使用原动画。快速反向切换或返回会取消旧等待，不改变玻璃材质。
设置入场与分类切换还需要保持背景采样链：遮罩、对话框和分类祖先保持 `opacity:1`，
遮罩暗化、文字、磨砂填充与光学绘制层分别接收淡入进度，保留原有变换与光学参数。
数值自定义属性无法注册时使用逐帧回退；不会等整体淡入结束才补出折射。
桌面设置先读取原生偏好和系统字体，再准备最终布局的玻璃；取消后较晚的回调不能重开窗口。
原文图片使用紧凑附件缩略图，横图和纵图占用相同高度，添加、删除和替换动画继续保留；
提交翻译使用原图数据，删除附件不清空文字。Android 键盘覆盖页面，保留系统栏和刘海安全区，
IME 高度不压缩 WebView；输入焦点不再隐藏底栏或挤压卡片。
设置移除取消和保存，修改即时应用并自动保存；范围/颜色输入逐帧预览、空闲 200ms 合并持久化，
松手或关闭立即提交。桌面保存队列不锁定操作，关闭不回滚，失败保留重试状态，
旧写入和过期加载不得覆盖较新值。分组重置、背景、快捷键和更新开关均自动保存。
桌面划词悬浮窗预先准备隐藏的本地页面，不在预热时读取选区或剪贴板。
快捷键触发后先以不激活方式显示等待态，再异步取词，保留原应用焦点；
取词和翻译返回后在同一窗口更新，入场缩放、淡入与流式文字淡入均保留。
关闭或新请求会使旧请求及迟到的重试、流式片段和复制反馈失效，避免过期内容重新弹窗。
交互玻璃的边缘折射带按圆角的 40% 计算，限制在 1–8px；
大胶囊不再让折射区域覆盖控件大部分内部，原高光、透明度与动画参数保留。
旧注入脚本与主题资源也已从源码和后续 Android 资源输入中移除；历史安装包继续保留。
Windows 普通窗口外圆角为 22 DIP，最大化与全屏时清除裁剪，卡片圆角仍可单独设置。
参考实现说明与当前运行时验收状态见 [界面主题记录](ui-theme.md) 和
[桌面集成说明](desktop-integration.md)。关于页移除渐变图标，保留名称、版本与仓库链接。
“设置 → 更新”可开关启动自动检查，也可立即检查；自动检查每 24 小时最多一次，
读取仓库的 GitHub 正式发布并提供发布页链接，失败、限流及暂无正式版本均有明确状态。
完整的父子依赖、覆盖顺序和平台差异见 [设置项关系简报](settings-audit.md)。
以下为历史 2.2.0 构建记录，既有发布包继续保留：
`output/笺-2.2.0-界面优化.exe`、`output/笺-2.2.0-界面优化.msi`、
`output/笺-2.2.0-界面优化.apk`。交互优化包为 `output/笺-2.2.0-交互优化.exe`、`output/笺-2.2.0-交互优化.msi`、
`output/笺-2.2.0-交互优化.apk`，包含手机底栏、安全区、拖动选择、滚动条和浮窗背景范围修正。
全量替换液态玻璃后的包为 `output/笺-2.2.0-液态玻璃.exe`、
`output/笺-2.2.0-液态玻璃.msi`、`output/笺-2.2.0-液态玻璃.apk`；
这些历史 Android 包使用 versionCode `5` / versionName `2.2.0`，校验值见 `output/SHA256SUMS.txt`。
2.3.0 发布说明见 [v2.3.0](releases/v2.3.0.md)，2026-11-16 的版本升级阶段未重新生成本地安装包；
推送包含本轮提交的 `v2.3.0` 标签后，由发布工作流构建并上传三端附件。
2026-11-17 的界面连贯优化按用户要求以原身份重建 Release 包，
交付目标为 `output/笺-2.3.0-release.apk`，版本 `2.3.0` / code `6`，
保留名称“笺”和应用标识 `ink.jian.translate`。此前带额外标识的产物已被替代，
不再交付；原身份 Release 已构建并核验名称、包名、非 debuggable 标志与六项资源，
原 Release 签名仍待授权使用，签名与覆盖安装能力尚未验证。

## 本地验证

需要 Node.js 22 或以上以及 Chrome。无需安装前端依赖。
`verify-android-ime` 还需要 JDK 17 的 `javac` / `java`，使用合成平台替身，不依赖 Android SDK 或真实设备。
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
node tests/verify-glass-readiness.mjs
node tests/verify-settings-compositor.mjs
node tests/verify-attachment-layout.mjs
node tests/verify-android-ime.mjs
node tests/verify-updates.mjs
node app/macos/build.mjs --prepare-only
node tests/verify-macos.mjs
```

桌面划词提前显示的最小定向检查为：

```powershell
node tests/verify-popup-latency.mjs
node tests/verify-windows-popup-lifecycle.mjs
node tests/verify-windows-popup-native.mjs
node tests/verify-macos-popup-lifecycle.mjs
```

共享渲染探针复用独立 Chromium 调试地址，默认端口 `9240`，也可通过 `IT_CDP_ORIGIN` 指定；
它只创建自己的 `about:blank` 页面，使用延迟网络与剪贴板替身，检查真实入场和文字动画。
Windows 定向检查需要本机 Rust 编译器，将实际生产函数提取到合成 Win32/Tauri 边界；
macOS 定向检查用 Electron 窗口和延迟取词替身执行实际生命周期函数。
共享渲染、Windows 生命周期及 macOS 生命周期分别为 **22/22**、**19/19**、**20/20** 通过，
不读取真实选区、剪贴板、偏好或浏览器会话。Windows 自有离屏 HWND 探针另为 **3/3**，
复现旧的窗口可见性缓存失步，并验证生产显示函数在真实 Tao 下连续 12 次隐藏、重开；
不创建 WebView、不发送输入、不激活窗口，不能替代实际应用的取词和焦点验收。
结果分别为 `.build/popup-latency.json`、`.build/windows-popup-lifecycle.json` 与
`.build/macos-popup-lifecycle.json`。Windows 目标离线 `cargo check` 与最终 Release
构建已通过，源码提交为 `26b644c`；`output/笺-2.3.0.exe` /
`output/笺-2.3.0.msi` 已更新为包含快速重用修复的产物。
真实窗口焦点仍需设备验收。主窗口唤起时排除预热浮窗的补丁另有四项定向检查，
入口为 `python tests/verify-desktop-patch.py DesktopPopupRevealTests`。

回归使用本地桥接替身并拦截外部请求，不调用翻译接口。界面设计、验证记录和历史成品说明见
[ui-theme.md](ui-theme.md)。
`IT_CDP_ORIGIN` 可指定其他 Chrome 调试地址，`IT_PREVIEW_ORIGIN` 可指定其他本地预览地址。
Android 连续输入、拖动、窗口变化与后台光学图生成另由
`node tests/verify-android-interactions.mjs` 验证；该探针使用合成 Android 桥、
390 × 844 / DPR 3 视口和 CPU 4 倍降速，不依赖真实照片或翻译内容。
支持 Worker / OffscreenCanvas 的 Android WebView 使用后台生成光学贴图，
不支持或生成失败时使用原算法完整回退；六项网页资源与桌面共用的方式不变。
首帧玻璃准备、取消竞争、PNG 解码、语言边框与文字选择的独立回归见
`tests/verify-glass-readiness.mjs`，默认本地预览端口 `8874`、Chrome 调试端口 `9238`，
同样可用 `IT_PREVIEW_ORIGIN` / `IT_CDP_ORIGIN` 覆盖。
新增设置合成探针在实际动画 30%、65%、99.5%、100% 对比真实位移滤镜的像素变化，
默认输出 `.build/settings-compositor-optimized.json`；附件布局探针默认输出
`.build/attachment-layout.json`。这两个探针默认预览端口 `8875`、Chrome 调试端口 `9240`，
复用独立测试会话。Android IME 探针用生产 insets 逻辑和平台替身验证稳定视口、旧系统、
旋转及刘海；它不能替代某款真实输入法的设备验收。
本轮界面任务的唯一一次完整回归已记录在 `.build/ui-polish-final-verification.log` 与
`.build/ui-polish-final-results.json`，结果为 **15/16 组**。两处设置测试状态依赖修正后，
受影响场景单独检查 **53/53** 通过，记录在 `.build/ui-polish-settings-targeted.json`。
随后增加的划词提前显示功能只执行上述相关定向检查，不重新运行整套，
也不将局部通过合并成一次全量通过声明。

历史任务最终离线浏览器回归为 `127/128`；覆盖连续动画、设置事务、窗口桥接契约、
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
签名配置均不入库。本轮在隔离工程中复制公开源码，保留原应用名称和应用标识；
原 Release 签名的使用仍待明确授权，不以可用文件或工具权限代替授权。
后续交付 APK 均使用 Release 构建，不自行增加应用名称文字或包名后缀。
签名一致性需核验后才能确认覆盖安装能力。

构建前的 `syncWebAssets` 只覆盖 `web/` 六项资源，不删除源资源或 assets 目录。
在 `android/` 执行：

```powershell
.\gradlew.bat -g ..\.build\gradle-home :app:assembleRelease --offline --console=plain
```

当前版本为 Android versionCode `6` / versionName `2.3.0`，Windows 与 macOS 构建版本均为 `2.3.0`。

## 自动发布

推送 `v*` 标签会触发 [.github/workflows/release.yml](.github/workflows/release.yml)。
工作流分别在 Windows、macOS 与 Ubuntu 运行器上构建三端产物，最后调用
`scripts/prepare-release.mjs` 生成规范命名附件、`RELEASE_NOTES.md`、`SHA256SUMS.txt`
和来源清单。标签构建会把附件与发布说明上传到对应的 GitHub Release；
工作流仅在标签事件上运行，普通分支推送不会再触发构建。

Android Release 优先读取 `ANDROID_KEYSTORE_BASE64` 和
`ANDROID_SIGNING_PROPERTIES_BASE64` 两个仓库 Secrets，并在构建前还原到
Gradle 已配置的 `android/keystore/release.keystore` 与 `android/signing.properties`。
Secrets 缺失时自动退回 debug 签名。macOS 包未做 Developer ID 公证，
首次打开仍需按系统提示确认。发布说明模板在 `docs/releases/v<版本>.md`，
新增版本前应先补充对应文案。

## 版本管理

源码、资源、Gradle wrapper、文档和测试入库。依赖缓存、构建目录、发布二进制、预览媒体、
本机配置与签名文件保留在工作区但由 Git 忽略。`output/SHA256SUMS.txt` 记录发布包校验值。
