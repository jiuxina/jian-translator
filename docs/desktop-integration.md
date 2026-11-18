# 桌面窗口与设置集成

## Windows 自启动目标与窗口边缘、设置关闭（2026-11-18）

Windows 免安装版和安装版共用当前用户的 `Run\IndexTranslate`。读取设置时显示实际登记路径、
目标存在性和是否属于当前 exe；访问失败显示未知，不能被当作关闭。只有明确启用或选择
“设为当前版本”才写入当前进程的完整 exe 路径；从任一版本关闭都会移除全局启动项。
普通偏好保存、桌面默认值恢复和旧 `auto_start` 缓存均不再改变 Windows 注册表。
新安装首次启动默认显示主窗口，`auto_start` 和 `start_to_tray` 均关闭；用户保存过的显式设置
仍会在后续启动中生效。
同标识版本仍使用单实例：切换目标时先退出已运行版本，再启动目标版本并选择切换。
移动/重命名 exe 后需重新选择目标。macOS 登录项仍由其现有设置实现管理。

定向检查使用内存 Win32 注册表替身，覆盖缺失项、拒绝访问、目标创建、旧版本、坏值、
环境变量展开、缓冲区增长和写入失败（9 个场景）；`tests/verify-autostart-ui.mjs`
覆盖 Windows / macOS 设置桥行为（12/12）。未读取或修改真实用户 Run 项。

无边框窗口此前由 Tao 为阴影预留的非客户区导致页面内容外露出白边。普通窗口现在在
`WM_NCCALCSIZE` 处理后使用完整客户区矩形；最大化仍保留工作区边界，圆角裁剪保持原样。
`tests/verify-windows-frame.mjs` 使用自有隐藏 Tao 窗口验证启动、四边覆盖、调整大小与圆角，
结果 4/4。设置页关闭时保留透明终态、完成后立即隐藏遮罩；重开会取消旧关闭回调。
`tests/verify-settings-close.mjs` 覆盖关闭、关闭中重开和减少动态效果。

补丁器同步注册两个自启动命令的 Rust 导入、handler、Tauri ACL 与 capability；
旧模板、部分补丁和重复运行均由 `python -X utf8 tests/verify-desktop-patch.py`
定向验证（11/11）。

## 当前：浮窗关闭与再次唤起修复（2026-11-18）

用户反馈首次翻译后点外部无法关闭，Esc 关闭后再次按快捷键会使应用未响应。
旧版用原生 `ShowWindow` 显示，却没有更新 Tao 的可见性缓存，导致框架聚焦和隐藏操作
不能可靠执行；Esc 又销毁 WebView，下一次唤起在 UI 事件线程同步重建窗口，进入
Windows WebView2 已知的同步创建死锁路径。

当前显示、可聚焦与隐藏均走框架 API；关闭只取消请求并隐藏，同一 WebView 可反复复用。
冷创建和预热由后台线程串行处理，UI 线程只呈现既有窗口。窗口已可见时先隐藏，
再切为不可聚焦等待态，避免快速重用时 Tao 更新样式意外激活旧窗。
外部点击判断不再依赖浮窗曾取得前台焦点，内部点击仍保留，Esc 也使用相同的隐藏路径。
首次快速入场、缩放与流式文字淡入均保留。

生产函数提取式回归 **19/19**，覆盖首次未聚焦外点关闭、Esc 隐藏、12 次重开、
旧结果仍可见时快速重用、错误路径与创建线程约束。真实 Tao 自有离屏窗口探针 **3/3**，
复现旧可见性缓存错误并验证生产辅助函数 12 次显示／隐藏／重开；共享渲染 **22/22**，
macOS 生命周期 **20/20**。没有重新执行整套测试。两类原生回归均有编译与运行超时，
不会因未来死锁回归无限挂起。

最终“快速重用先隐藏”补丁已成功构建为 Release，源码提交为 `26b644c`，
构建目录为 `.build/popup-release-stage-20261118/`。此前审批超时的尝试未启动编译，
后续成功构建的 EXE/MSI 已同步到交付目录。编译后只核对版本、原应用身份和产物哈希，
复用修改阶段已有的定向结果，没有重复运行回归。

## 划词时先显示悬浮窗（2026-11-17，后续关闭修复见上节）

悬浮窗模式改为先展示等待态，再异步取词和接收译文。旧流程在显示窗口前等待复制选区，
Windows 还包含固定等待、修饰键释放和剪贴板变化轮询；macOS 等待系统脚本复制完成。
这段显示前等待会让人感觉窗口在翻译返回后才出现，实际网络响应并非原来的显示门槛。

Windows 和 macOS 均预热隐藏的本地悬浮窗，不在预热或空闲时读取选区与剪贴板。
快捷键触发后先定位并显示等待态，取词期间不激活窗口，原应用保有焦点。
Windows 使用 Tao 管理的 `set_focusable(false)` / `show()` 同步原生窗口与框架可见性；
取词后恢复焦点能力并聚焦。Windows 外部点击轮询独立于前台焦点判断，因此初次无激活
显示时点选空白处也会关闭。
macOS 使用 `showInactive()`，取词完成后恢复可聚焦状态。
已打开的 macOS 浮窗会先清理旧失焦回调再复用，避免关闭尚未完成时重用失效窗口。

关闭路径隐藏并复用同一个 WebView，不销毁后再于热键事件线程重建。冷启动所需窗口创建
移至后台线程并串行化，避免 Windows WebView2 在 UI 事件处理器中同步创建而卡死。
主窗口“显示全部窗口”的路径跳过预热悬浮窗，避免空闲窗口意外出现。

共用数据协议为 `{id, phase, text, notice, target}`，阶段为 `pending`、`ready` 或 `notice`。
同一请求从等待态推进一次，不为等待态提交空翻译；正式文本在原窗口内开始流式翻译，
不重播整个窗口入场。实际显示时通过 `__popupPresent()` 启动原有 `popup-arrive` 动画，
流式文字继续使用 `stream-arrive`，减少动态效果与关闭动画偏好继续生效。
重复投递、旧 ID、过期网络片段和复制反馈不得替换较新的状态。
关闭会撤销当前请求，较晚的取词、重试或网络返回不能重新显示窗口。
macOS 保留取词串行保护，取词未结束时重复快捷键不会启动重叠的系统复制。
“在主窗口显示结果”的偏好继续保留原目的窗口行为。

本轮定向证据：

| 检查 | 结果 | 范围 |
| --- | ---: | --- |
| `tests/verify-popup-latency.mjs` | 22/22 | 在真实 Chromium 渲染中延迟响应，检查等待态先绘制、实际入场与流式淡入、单次请求、取消和旧结果隔离。 |
| `tests/verify-windows-popup-lifecycle.mjs` | 19/19 | 提取生产 Rust 函数，使用合成 Win32/Tauri 边界验证框架可见与焦点缓存、首次未聚焦外点关闭、内部点击保留、Esc 隐藏复用、12 次重开、快速重用、创建线程、取消、失败及 watchdog 代次竞争。 |
| `tests/verify-windows-popup-native.mjs` | 3/3 | 使用真实 Tao 0.34.5 与自有离屏 HWND 复现旧可见缓存错误，验证生产辅助函数的 12 次显示、隐藏与重开，等待显示不改变前台窗口。 |
| `tests/verify-macos-popup-lifecycle.mjs` | 20/20 | 执行生产生命周期函数，使用合成 Electron 窗口和延迟选区验证无激活等待、同窗更新、连续触发、关闭与重试。 |

报告分别为 `.build/popup-latency.json`、`.build/windows-popup-lifecycle.json`、
`.build/macos-popup-lifecycle.json`；等待态截图为 `.build/popup-pending.png`，已实际查看。
原生探针报告为 `.build/popup-native-probe-result.json`。它仅创建两个自有离屏小窗口，
不读取系统剪贴板或选区，不发送输入，也不创建 WebView；不能把该结果当作真实 WebView2
构建或完成态抢焦点验收。
全部内容、网络、剪贴板和窗口边界均为合成数据或替身，不读取真实用户数据。
这些检查不等于真实 Windows HWND / WebView2 焦点、macOS 权限与系统复制验收；
Windows 目标 `cargo check --target x86_64-pc-windows-msvc --offline` 已通过，
最终 EXE/MSI Release 构建成功，名称“笺”和应用标识 `ink.jian.translate` 保持原样，
EXE 的 FileVersion / ProductVersion 均为 `2.3.0`。交付记录如下：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `output/笺-2.3.0.exe` | 9,490,432 | `c7c2eddfc2ff166949ce7be22e772262e6b81ae6e7f6a721a121ca2ab02bbb28` |
| `output/笺-2.3.0.msi` | 4,333,568 | `453dc619ae3d0a97682b0356418e01637939d7dd2f6b8141c851aa5639c18a04` |

最终构建目录为 `.build/popup-release-stage-20261118/`，
来源哈希与资产清单为 `.build/popup-release-artifacts.json`；上一版构建仍保留在原隔离目录。
窗口补丁另以四项定向检查验证：
主窗口显示与回退聚焦排除预热浮窗、重复应用、CRLF 和变化锚点失败，
入口为 `python tests/verify-desktop-patch.py DesktopPopupRevealTests`。
watchdog 的破坏性关闭在 UI 线程再次校验代次，避免旧失焦确认关闭后来复用的窗口。

本轮界面任务的唯一一次完整回归保留为 **15/16 组**，设置测试夹具修正后的相关场景为
**53/53**；后加的划词提前显示仅做上述定向检查，没有重新运行整套或改写历史统计。
Android 交付继续保持名称“笺”和 `ink.jian.translate`，采用 Release；
原签名使用仍待明确授权，当前不以未签名文件声称完成 APK 交付。

## 首次发布候选的版本元数据（2026-11-16）

首发准备修复了下文历史包中的 PE 版本不一致：补丁器从 `app/macos/package.json`
读取应用版本，只改生成的 Cargo `[package].version`，不改 Pake CLI 或依赖版本。
首次发布候选的 Windows EXE FileVersion/ProductVersion 实读均为 `2.2.0`，
MSI ProductVersion 也为 `2.2.0`。首发使用独立规范文件名与校验清单，
不覆盖下文历史交付。流程、已知限制及未完成的发布条件见 [首发准备记录](release-preparation.md)。

## 本轮交付与验证（2026-11-16）

Windows EXE/MSI 与 Android Release 构建成功，原有安装包保留，新增：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `output/笺-2.2.0-玻璃与更新.exe` | 9,447,424 | `78B45D00A083572ECFB872007BC28298A80019F0305E02632B7BBAD46F612EA6` |
| `output/笺-2.2.0-玻璃与更新.msi` | 4,308,992 | `B9CDC82BD334B44CC108C06891F3FE2E2C9DCD731CC971888955CE72BF5A36E3` |
| `output/笺-2.2.0-玻璃与更新.apk` | 3,560,624 | `47949887413D75C3FD1F94E706DF09AA85BF67DDA9C2D347EC596702B6D84AE8` |

Windows 最终隔离输出为 `.build/release-stage-presets-v4-20261116/`；
先前“分型玻璃”预览包保留，最终交付使用表中“玻璃与更新”文件。MSI ProductVersion 为 `2.2.0`。
EXE 的 PE FileVersion/ProductVersion 仍为 Pake 模板 `3.18.0`，不是关于页的应用版本。
Android APK 经 AAPT 核验为 versionCode `5` / versionName `2.2.0`；六项前端镜像及 APK entry
与 `web/` 字节一致，APK 内已没有旧注入版 CSS/JS 资源。哈希清单追加在 `output/SHA256SUMS.txt`。

针对性检查包括共享引擎数学、公开滑条归一化、更新版本比较/频率/错误状态、macOS IPC 与
资源路径边界、共享悬浮窗提取、JS/Python 语法、Rust 格式与 Windows 目标 `cargo check`。
独立 Chromium 预览确认三组 6/4/3 滑条、滑块按住状态、面板本地滤镜尺寸、Mac 界面桥接、
去图标关于页、按钮简化及更新结果；截图见 `output/preview-presets-*.png`、
`output/preview-updates-settings.png` 和 `output/preview-about-no-icon.png`。
最终 v4 浮窗检查还覆盖中文多行复制桥替身、反馈文字修改后背景层恢复和透明外留白，
结果为 `output/verify-popup-final.json`，截图为 `output/preview-popup-final-v4.png`。

实现及文档完成后，只执行一次最终完整离线浏览器回归：**97/107**，
输出为 `output/verify-presets-final.log`；同阶段 Rust **93/93**，
输出为 `output/verify-presets-rust-final.log`。回归拦截外网、使用原生桥接替身；
更新 API 使用响应替身而非真实发布请求。

浏览器失败包括测试桌面连接的变量作用域、尚未打开设置时未初始化滑条属性，
以及 SVG 合成开销引起的低帧率和动画帧等待超时。前两项随后修正并通过定向检查；
另修复隐藏表面重复写入相同 `pending` 状态触发刷新循环的问题，空闲状态计数已稳定。
引擎 v4 随后将渐进模糊从 SVG 移到参考使用的独立 CSS 层，去掉多余 PNG；
轮盘绑定实际 transition 的完成时钟及选择代次。独立正常 Chromium 的最终定向检查
`output/verify-animation-targets-final.json` 确认 Tab 双向、轮盘正反/快速改选和设置关闭清理通过，
没有残留动画。本机多数帧采样约 95ms，仍有性能成本，不能称为 60fps 流畅。
不重跑全套。唯一全量统计保持 97/107，
不将后续局部通过改写成完整套件通过。

macOS 采用新的 Chromium 桌面壳，代码、资源准备、依赖锁文件和纯 Node/界面桥接检查完成；
构建命令和平台行为见 [macOS 适配](macos.md)。当前运行环境为 Windows，
**未生成 DMG/ZIP，未完成 Mac 本机字体、剪贴板、权限、登录项或原生窗口验收**。
Windows 22 DIP 外圆角与阴影、各 DPI 下缩放/最大化，以及 Android System WebView 的最终
绘制和性能也仍需目标设备验收。构建成功和浏览器像素变化不代替这些结果。

## 液态玻璃引擎（2026-11-16）

`web/liquid-glass.js` 是网页、Android 和 Windows 悬浮窗共同使用的 SVG 液态玻璃引擎。
桌面补丁应用器会把它复制到 Pake 模板 `src/app/liquid-glass.js`；`setup.rs` 以
`include_str!` 引入，并在执行独立 `POPUP_BOOTSTRAP` 前注入引擎。当前悬浮窗卡片
使用静态磨砂背景色、渐变和细纹，不挂载 SVG 光学状态或渐进模糊层；只有复制按钮
使用完整交互玻璃。圆角、壁纸层和外阴影继续由卡片 frame 负责。

浮窗接收通用偏好顶层 `liquidGlass.{card,pill,button}`。卡片仅消费 `card.backgroundOpacity`，
其余旧光学值保留兼容；复制按钮使用 `button` 三项滑条。Tab 等滑块使用 `pill` 四项滑条，默认值与范围见
[界面主题](ui-theme.md)。旧材质、玻璃强度、卡片透出字段已从浮窗
渲染路径移除。浮窗可独立选择背景图；背景图片淡化、模糊及适配继续沿用 `background.opacity/blur/fit`，
这些壁纸参数不改写全局液态玻璃参数。

滤镜需要 Chromium 系 WebView 支持 SVG filter 作为 `backdrop-filter`；参考实现也注明浏览器差异。
引擎在不支持的运行时明确标记并输出错误，不静默退回旧的 CSS 磨砂或白色描边。模板脚本的注入和
滤镜声明可通过静态/浏览器测试检查，但是否在目标 Pake WebView2 中产生正确折射，仍要用打包后的
Windows 窗口做视觉验收；目前也未声称 Android System WebView 支持已完成设备验证。

参考：[Liquid Glass in the Browser: Refraction with CSS and SVG](https://kube.io/blog/liquid-glass-css-svg)。

## 偏好迁移

通用偏好版本更新为 3。`appearance.material/glassStrength/cardReveal` 和 `popup.cardReveal` 不再读作
有效设置，旧玻璃值不映射为新光学参数；归一化后使用新的 `liquidGlass` 默认值。主题、字体、壁纸、
翻译偏好等无关设置保留。版本 2 的扁平玻璃对象同样被三种新预设替换。
设置“液态玻璃”分组只复位当前调整对象；“电脑功能”复位浮窗背景与
原生桌面选项时会保留顶层液态玻璃配置。

维护源是 `desktop/patch/setup.rs`；`patch_apply.py` 将它同步到工作区的 Pake 3.18.0 模板，
并补齐命令权限及 Windows API feature。不要只修改 `.build/` 内的生成副本。

## v12 构建记录（2026-11-16）

Pake Windows Release 成功；构建输出保存在 `.build/release-stage-liquid-glass-20261116/`，
并以独立文件名交付 EXE/MSI。Android `assembleRelease -x syncWebAssets --offline` 成功，
使用 versionCode `5` / versionName `2.2.0`。APK 内含 `assets/liquid-glass.js`，
`app.js`、`theme.css`、`index.html` 和新引擎均与 `web/` 的 Android 镜像一致。
EXE、MSI、APK 的 SHA-256 均记录在 `output/SHA256SUMS.txt`。

上一任务最终唯一全量回归为 **127/128**，轮盘帧采样随后通过定向动画时钟检查；
更早一次 GPU Chromium 曾为 128/128，不能混写为最终结果。回归检查打包入口的模板同步和静态滤镜声明。
实际打包 WebView2 中的 SVG `backdrop-filter` 绘制及 Android System WebView 设备效果仍待验收；
当前构建成功与浏览器像素变化不代表这两项实机验证已完成。

## 历史：悬浮窗背景范围与滚动条（2026-11-15）

`POPUP_BOOTSTRAP` 使用 `#card-frame` 关联卡片和背景层，frame 只绘制外阴影；
背景层与卡片同矩形、同圆角并裁剪图片、模糊和淡化层。body 的 22px 留白保持透明，
不再承载背景。完全透出时移除卡片填充与内部高光，但 frame 仍可保留外阴影。
完整显示按卡片尺寸适配，填满模式仅在背景模糊开启时扩展边缘。

悬浮窗正文和共享界面使用透明轨道及主题色圆角细滚动条，移除系统箭头和白底。
设置中的悬浮窗预览采用相同的裁剪范围。综合离线回归 **120/120**，含真实模板的
背景范围、完整显示、阴影和滚动验证；不代替原生 Windows 窗口的 DPI、绘制和输入验收。
本轮 EXE/MSI 于 2026-11-15 21:02 在 `.build/release-stage-touch-2.2.0/` 构建成功，
交付到 `output/笺-2.2.0-交互优化.exe` 和 `output/笺-2.2.0-交互优化.msi`。
版本与 PE 元数据限制同下文记录，SHA-256 见发布清单。

## 历史：设置界面与关于链接（2026-11-15）

设置分类现在使用导航滑块和右侧淡入淡出，系统减少动态效果与窗口缩放会收束过渡。
设置下拉复用主题控件，Windows 字体列表异步返回后刷新选项；不新增原生命令或权限。
当时记录的旧玻璃字段仅供历史追踪，当前配置关系见 [设置项关系简报](settings-audit.md)。

关于页的开源仓库链接沿用 Pake 3.18.0 的外部链接处理：注入脚本截获外部 `_blank` 链接，
经已注册的 shell 插件打开系统浏览器。Android 使用既有 HTTP(S) / `ACTION_VIEW` 路径。
本轮离线回归为 **92/92**；它核验前端交互及链接属性，不把源码出口检查当作真实系统浏览器验收。

Windows 构建于 2026-11-15 20:02 完成，产物为 `output/笺-2.2.0-界面优化.exe` 与
`output/笺-2.2.0-界面优化.msi`。MSI 只读查询 ProductVersion 为 `2.2.0`；
EXE PE FileVersion/ProductVersion 仍为 Pake 模板的 `3.18.0`，与上一轮限制相同。

## 窗口边框

主窗口普通状态增加 22 DIP 圆角区域，使用 `GetDpiForWindow` 随 DPI 缩放。
尺寸、位置、DPI、显示器与桌面合成变化时刷新区域；最大化与全屏时移除区域，保留完整工作区。
区域比较避免 `SetWindowRgn` 重复窗口消息；GDI 所有权仅在成功设置后转给系统。
`DwmExtendFrameIntoClientArea` 请求保留原生阴影；自定义区域与阴影的实际组合仍需 Windows 视觉验收。

主窗口安装子类处理器后关闭窗口装饰。处理器让原窗口过程先完成 `WM_NCCALCSIZE`，再恢复
Windows 11 无装饰阴影添加的微小顶部 inset；修正范围限于顶部正向 1–8 个设备像素，不触碰
其余工作区边界。DWM `DWMWA_BORDER_COLOR / DWMWA_COLOR_NONE` 继续关闭激活描边，焦点和原生主题
变化时重放。原生阴影、圆角、最大化和现有边缘缩放继续使用。该 DWM 属性需要 Windows 11；不支持时
输出 HRESULT 诊断，不中止启动。首屏顶部边框、DPI 缩放、窗口缩放与任务栏行为仍须通过真实 EXE 截图验收。

## 设置保存

`DesktopSettings.preferences` 保留前端的版本化通用偏好，老配置缺项时仍能读取。
保存仅在快捷键或自动启动字段改变时执行相应系统操作，失败时回滚并返回可见错误。
设置先写同目录临时文件并刷新，再原子替换正式文件；成功后才更新内存和浮窗外观。

桌面设置 JSON 的 `preferences.appearance` 保存正文字体、字重和文字颜色，顶层 `preferences.liquidGlass`
保存共用玻璃参数，`preferences.popup` 保存可选浮窗背景图。悬浮窗图片为空时跟随主窗口背景，独立图片覆盖
该图片，背景淡化、模糊与填充仍沿用主背景。设置内嵌预览实时响应，实际悬浮窗只在保存成功、创建或
再次唤起时同步，不重新发起翻译请求。系统减少动态效果始终优先于应用动效选项。

`it_list_system_fonts` 通过 Windows GDI 枚举系统字体，只允许 `pake` 主窗口在
`tauri://localhost` 或无非默认端口的 `http(s)://tauri.localhost` 应用来源调用；远程站点、
相似域名、文件来源与本地开发服务器均拒绝；
`it_write_clipboard_text` 通过 Win32 Unicode 剪贴板写入翻译全文，只允许「笺」应用仍为
`about:blank` 的划词悬浮窗调用。
两个命令均登记在 invoke handler、build ACL 与 Tauri capability 中。剪贴板写入与划词 Ctrl+C 捕获
使用同一事务锁，避免并发写入被误识别为选区。

## 上一轮验证基线（2026-11-15）

- Windows 目标 `cargo check --target x86_64-pc-windows-msvc --offline` 通过。
- 维护源 `rustfmt --edition 2021 --check` 通过；补丁同步后的文件哈希与维护源一致。
- JavaScript 离线回归覆盖主界面设置；它不覆盖 DWM 实际绘制。
- 原生画面验收尝试启动独立 QA 应用时，Computer Use 的应用授权等待超时，未获得窗口截图。
  因此激活、Alt+Tab、最大化、缩放和系统主题切换的原生视觉验收仍待完成。

## 2.2.0 验收状态

- 维护源与生成的 Pake 3.18.0 模板已包含窗口处理器、GDI 字体枚举、剪贴板写入及权限登记；
  `rustfmt --check`、Windows 目标离线 `cargo check` 和模板 `cargo test`（93 项）通过，覆盖本地
  origin 放行、远程及非默认端口拒绝，以及剪贴板窗口文档限制。
- Windows EXE/MSI 已于 2026-11-15 18:38 重建；MSI ProductVersion 为 2.2.0。Android APK 为 versionCode 5 /
  versionName 2.2.0。离线浏览器回归 80/80 通过，但它对原生窗口、字体及剪贴板使用替身。
- 浏览器回归不模拟 DWM 或系统剪贴板。安装包验收需覆盖首次显示、100%/125%/150% 和至少一种
  200% 以上缩放、焦点切换、最大化还原、四边缩放、任务栏自动隐藏、系统字体选择和全文粘贴。
- 原生窗口外框必须包含在截图中，单独检查网页内容不能证明顶边已消失。
