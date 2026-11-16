# Windows 窗口与设置集成

## 液态玻璃引擎（2026-11-16）

`web/liquid-glass.js` 是网页、Android 和 Windows 悬浮窗共同使用的 SVG 液态玻璃引擎。
桌面补丁应用器会把它复制到 Pake 模板 `src/app/liquid-glass.js`；`setup.rs` 以
`include_str!` 引入，并在执行独立 `POPUP_BOOTSTRAP` 前注入引擎。悬浮窗的 `#card` 自身绑定
SVG displacement、specular、Gaussian 与渐进模糊滤镜；圆角、壁纸层和外阴影继续由卡片 frame 负责。

浮窗接收通用偏好顶层 `liquidGlass`。参数包括 `surfaceProfile`、`bezelWidth`、`glassThickness`、
`refractiveIndex`、`refractionLevel`、`specularOpacity`、`specularSaturation`、`blurLevel`、
`progressiveBlurStrength` 和 `backgroundOpacity`。旧材质、玻璃强度、卡片透出字段已从浮窗
渲染路径移除。浮窗可独立选择背景图；背景图片淡化、模糊及适配继续沿用 `background.opacity/blur/fit`，
这些壁纸参数不改写全局液态玻璃参数。

滤镜需要 Chromium 系 WebView 支持 SVG filter 作为 `backdrop-filter`；参考实现也注明浏览器差异。
引擎在不支持的运行时明确标记并输出错误，不静默退回旧的 CSS 磨砂或白色描边。模板脚本的注入和
滤镜声明可通过静态/浏览器测试检查，但是否在目标 Pake WebView2 中产生正确折射，仍要用打包后的
Windows 窗口做视觉验收；目前也未声称 Android System WebView 支持已完成设备验证。

参考：[Liquid Glass in the Browser: Refraction with CSS and SVG](https://kube.io/blog/liquid-glass-css-svg)。

## 偏好迁移

通用偏好版本更新为 2。`appearance.material/glassStrength/cardReveal` 和 `popup.cardReveal` 不再读作
有效设置，旧玻璃值不映射为新光学参数；归一化后使用新的 `liquidGlass` 默认值。主题、字体、壁纸、
翻译偏好等无关设置保留。设置“液态玻璃”分组复位顶层 `liquidGlass`；“电脑功能”复位浮窗背景与
原生桌面选项时会保留顶层液态玻璃配置。

维护源是 `desktop/patch/setup.rs`；`patch_apply.py` 将它同步到工作区的 Pake 3.18.0 模板，
并补齐命令权限及 Windows API feature。不要只修改 `.build/` 内的生成副本。

## v12 构建记录（2026-11-16）

Pake Windows Release 成功；构建输出保存在 `.build/release-stage-liquid-glass-20261116/`，
并以独立文件名交付 EXE/MSI。Android `assembleRelease -x syncWebAssets --offline` 成功，
使用 versionCode `5` / versionName `2.2.0`。APK 内含 `assets/liquid-glass.js`，
`app.js`、`theme.css`、`index.html` 和新引擎均与 `web/` 的 Android 镜像一致。
EXE、MSI、APK 的 SHA-256 均记录在 `output/SHA256SUMS.txt`。

离线 GPU Chromium 回归为 **128/128**，并检查打包入口的模板同步和静态滤镜声明。
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
