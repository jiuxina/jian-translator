# 性能优化记录

## 当前：界面连贯性、附件布局与即时设置（2026-11-17）

这一轮保留按钮、滑块和透明底栏的完整液态玻璃，以及已有位移、缩放、淡入淡出、
拖动和减少动态效果。内容卡片继续使用静态磨砂；没有通过降低贴图精度、
减少折射或删除动效解决设置页的视觉跳变。

设置页的补渲染还涉及合成链：即使两份 PNG 已解码，祖先以 `opacity` 淡入也会建立
背景采样边界，使子控件在动画期间缺少实际背景折射。当前遮罩、对话框和分类容器
保持 `opacity:1`，遮罩暗化单独绘制，淡入进度应用到文字、磨砂填充与光学绘制层。
原有变换轨迹与光学公式不变；不能注册数值自定义属性时使用同进度逐帧回退。
桌面原生偏好和字体先完成加载，再按最终布局准备玻璃。冷目标的解码准备门槛、
快速反向切换和返回取消仍然保留。

图片预览改为紧凑附件，80 × 80px 缩略图所在容器固定为 88px 高，不再根据大图或纵图
高度挤占原文空间。新增、移除和中途替换继续平滑动画；原图提交、文字选择、
图片按钮和翻译要求入口保留。Android 使用 `adjustNothing`，WebView 仅由稳定的系统栏
和刘海安全区约束，IME 高度不参与其边距；网页输入焦点也不隐藏底栏或压缩卡片。

设置即时应用和自动持久化。连续范围与颜色输入仍每帧最多预览一次，空闲 200ms 后
合并写入，`change` 与关闭立即提交。桌面写入串行处理最新快照，保存时不锁编辑、
导航或关闭；关闭和重开保留未完成写入的最新值，失败保留重试状态。
已保存快照去重仍会更新应有的本地缓存，覆盖“改动后又回到正在写入值”的竞争情况。
本轮没有新增与旧基线等条件的帧率或触摸延迟测量，不把布局修复换算为性能提升比例。

| 回归入口 | 观察内容 |
| --- | --- |
| `tests/verify-settings-compositor.mjs` | 在实际动画 30%、65%、99.5%、100% 采样开关位移滤镜的像素差异，并检查玻璃祖先的合成条件、关闭重开和无动画状态。 |
| `tests/verify-attachment-layout.mjs` | 多种手机尺寸、横纵图、可编辑文字空间、选择复制、翻译要求可达性、删除与快速替换动画。 |
| `tests/verify-android-ime.mjs` | 使用生产 Android insets 逻辑和合成平台替身，检查键盘开关/高度变化不触发布局、旧系统安全区、旋转和刘海。 |
| `tests/verify-settings-preview.mjs` | 生产预览与持久化函数的合帧、空闲提交、关闭提交、串行写入、缓存失败和重试。 |
| `tests/verify-motion.mjs`、`tests/verify-android-interactions.mjs` | 即时设置、保存期间操作与重开、字体异步取消、焦点后几何稳定和 Android 连续输入。 |

浏览器探针使用合成内容、桥接替身和独立页面，拦截外部请求；不会读取实际偏好或浏览器会话。
共用预览和 Chrome 调试地址可分别通过 `IT_PREVIEW_ORIGIN`、`IT_CDP_ORIGIN` 指定，
本轮使用 `8875` / `9240`，不为每项检查另起浏览器进程。
合成器报告默认 `.build/settings-compositor-optimized.json`，图片布局报告默认
`.build/attachment-layout.json`，均为定向证据。
完成源码、资源、文档和 Release 构建后才执行本轮唯一一次最终全量；
日志 `.build/ui-polish-final-verification.log`，退出状态清单
`.build/ui-polish-final-results.json`。

本轮唯一一次完整回归为 **15/16 组通过**。综合交互组为 **134/136**；
两项失败来自测试场景的状态依赖：前置场景清空本地偏好后，仅用调试入口临时设置壁纸，
恢复默认值被合法去重；后续桌面断言又依赖被提前中止场景应设置的配色。
这份完整结果保留不改，修正场景独立性后仅运行两个受影响的完整设置场景，
**53/53 通过**，页面异常与外部请求均为 0。独立结果为
`.build/ui-polish-settings-targeted.json`；没有再次运行整套，也没有修改产品代码。
其余组包含光学公式、图片导入、实时保存、性能、Android 连续交互、首帧准备、
真实合成、附件布局、IME、安全区和跨端契约。
其中实际合成 **53/53**、附件布局 **17/17**、性能 **21/21**、
Android 连续交互 **23/23** 均通过；Java fixture 编译运行通过。

在相同合成条纹背景中，手机浅色设置页在动画 99.5% 时开关折射滤镜的变化像素，
旧版为 3、结束后为 1173；当前为 829、结束后为 827。
当前 30% 进度已有 797 个变化像素。该像素比较用于证明动画期间实际存在折射，
不代表设备帧率。报告为 `.build/settings-compositor-baseline.json` 与
`.build/ui-final-settings-compositor.json`。禁止注册数值属性的兼容场景也验证了渐变、
真实折射、快速切换和关闭后无残留回调。

本轮交付目标改为 `output/笺-2.3.0-release.apk`，采用 Release、版本 `2.3.0` /
code `6`，保留应用标识 `ink.jian.translate` 和名称“笺”。后续交付同样保留原身份，
不自行添加文字或包名后缀。此前带额外标识的产物已被替代，不再交付。
原身份 Release 已重新构建并核验名称、包名、非 debuggable 标志和六项资源。
原 Release 签名仍待授权使用；尚未确认签名或覆盖安装能力。
下文 Debug APK、原始卡片光学链和取消回滚说明属于历史阶段，不代表本轮交付。

## 历史：第一轮性能优化（2026-11-16）

2026-11-16，基于 `34f1cc1` 的源码进行优化，应用版本保持 `2.2.0`。
文本、图片、音节、长文、设置、壁纸、快捷键和各端桥接均保留。
液态玻璃的光学公式、640 边长 / 360000 像素贴图上限、折射、高光、
三层渐进模糊、按压变化和原有动画参数保持原样。

## 实现

`web/liquid-glass.js` 将尺寸与圆角读取集中到同一帧的读取阶段，再统一更新滤镜。
首次挂载也进入该队列，使用未受弹窗缩放动画影响的本地 border box。
未变化的 SVG 属性与 CSS 属性跳过写入；CSS 值同时记录请求字符串和浏览器序列化值，
避免小数模糊半径经过 CSSOM 舍入后被误判为变化，同时仍可恢复外部样式修改。

光学贴图照常生成和 PNG 编码，缓存仅保留尺寸、半径、最大位移和 PNG 地址。
编码后的 RGBA 数组不再被缓存与表面状态长期引用。公开 `generateMaps()` 的完整返回值保留。
节点观察器只修复被直接替换内容的玻璃表面；删除表面或其祖先时再清理注册表，
普通流式文本变化不再触发全表面扫描。

`web/app.js` 的语言轮盘先一次性添加候选测量节点，再统一读取实际字体排版宽度，
保留列表顺序、滚动方向、时长与宽度限制。字体和字距每次从当前按钮读取。
流式译文仍逐帧淡入，动画落定后合并相邻文本节点；停止与校正会清理对应监听、
定时器和待执行帧。动画事件乱序到达时，正在淡入的片段仍保留原位置。

Android 将相册图片的解码、EXIF 旋转、JPEG 压缩、Base64 编码和 JS 参数转义移到后台；
拍照确认图也在既有后台执行器解码。1600 px 采样上限、JPEG 85、确认动画、
闪光灯、切换镜头和重拍行为保留。UI 线程仅交付结果与更新界面。
Activity 销毁和后续原生请求会使旧任务失效，过期确认图会回收。

图片选择桥新增 `pickImageWithToken(token)`，保留 `pickImage()` 兼容入口。
新请求立即取消旧导入，原生交付携带请求 token；网页只接受匹配且尚未消费的结果。
文本图片另校验 `imageSeq`，保证用户随后清空、删除或替换图片后，旧解码结果无法覆盖新状态。
同一图片选择桥供翻译和壁纸使用，token 也防止旧翻译图片误交付给后续壁纸回调。

`web/` 是前端唯一源码；本轮已同步 Android 的六项 assets。macOS 和 Windows 使用同一源码。

## 测量

在 Windows、Node.js `22.19.0`、无界面 Chrome `157.0.8103.51`、
1180 × 900 / DPR 1 的独立测试上下文中运行 `tests/verify-performance.mjs`。
原版使用修改前保存的六项网页源码，优化版使用当前源码，均启用完整液态玻璃和动画。
文本、配置和剪贴板均为合成数据，外部请求被拦截。

| 场景与指标 | 原版 | 优化后 |
| --- | ---: | ---: |
| 启动布局次数（LayoutCount） | 125 | 39 |
| 启动 bounding rect 读取次数 | 284 | 23 |
| 12 轮相同配置 + 刷新：SVG 属性写入 | 17400 | 0 |
| 12 轮相同配置 + 刷新：bounding rect 读取 | 1044 | 0 |
| 活跃表面保留的原始贴图字节 | 7407040 | 0 |
| 跨多项语言选择的布局次数 | 32 | 11 |
| 10000 字译文落定后的文本节点 | 147 | 1 |
| 10000 字译文过程的 computed style 读取 | 152 | 6 |

原始贴图数组减少约 7.06 MiB。58 个已生成玻璃表面的尺寸、最大位移与
displacement / specular 两份 PNG SHA-256 全部相同；基线与优化版合成截图均已实际查看。
非默认渐进模糊强度 `4` 的重复刷新也达到零 SVG / CSS 写入，外部修改的层样式能够恢复。
实际调节六项卡片玻璃参数时，SVG / CSS 正常变化，几何 PNG 保持复用。

这些是一次同场景测量的操作计数与指定缓存占用，耗时会随设备、缓存和浏览器调度变化。
完整采样含 ScriptDuration、TaskDuration 等数值，保存在：

- `.build/performance-comparison-baseline.json`
- `.build/performance-comparison-optimized.json`
- `.build/performance-baseline.png`
- `.build/performance-optimized.png`

## 验证与复现

最小验证：

```powershell
node tests/verify-stream-writer.mjs
node tests/verify-image-import.mjs
```

前者运行真实 writer，覆盖乱序动画落定、万字文本的前缀与完整性、校正、取消、
旧回调和动态减少动画；后者运行真实图片选择处理，覆盖清空、删除、替换、
跨用途过期交付、重复回填与旧原生桥兼容。

启动当前源码预览：

```powershell
node tests/serve-preview.mjs web 8897
```

另外启动独立 Chrome，仅使用新建的测试目录与本地调试端口：

```powershell
Start-Process -FilePath 'C:/Program Files/Google/Chrome/Application/chrome.exe' `
  -ArgumentList '--headless=new','--remote-debugging-address=127.0.0.1',`
    '--remote-debugging-port=9235','--user-data-dir=F:/xm/translator/.build/performance-profile-20261116',`
    '--no-first-run','--no-default-browser-check','--disable-background-networking',`
    '--disable-extensions','about:blank' -WindowStyle Hidden
$env:IT_PREVIEW_ORIGIN = 'http://127.0.0.1:8897'
$env:IT_CDP_ORIGIN = 'http://127.0.0.1:9235'
node tests/verify-performance.mjs
```

浏览器与项目路径需按本机调整。测试用 `Target.createBrowserContext` 与独立 session
操作自己创建的页面，不枚举其他标签，不读取真实用户浏览器配置。
`IT_PERFORMANCE_SCREENSHOT` 可指定合成页面截图路径，
`IT_PERFORMANCE_REPORT` 可指定 JSON 报告路径。
对旧源码运行时增加 `--baseline`，它保留功能断言并记录旧版开销。
随后比较报告内 `maps.surfaces` 的尺寸、最大位移和两份 PNG 哈希。

最后一次全量回归需在代码、资源与文档完成后执行，包含
`verify-liquid-glass`、`verify-stream-writer`、`verify-image-import`、
`verify-performance`、`verify-motion`、`verify-updates`、
`verify-macos`、`verify-release-preparation` 和 `verify-desktop-patch`。
macOS 回归前先运行 `node app/macos/build.mjs --prepare-only`。
浏览器回归的语言轮盘方向验证使用受控动画时钟，避免跨进程固定延时采样错过动画。

Android 已在 `.build/android-performance-validation` 的独立无签名工程中通过
`compileDebugJavaWithJavac --offline`。该工程复制公开源码和依赖声明，
使用相同 SDK 与依赖版本，未读取原工程签名文件、keystore 或本机配置。
原构建脚本会在配置阶段读取签名属性，验证时使用隔离工程可以避开此依赖。
最终 Android 构建前同步六项网页资源，并将 `ANDROID_USER_HOME` 指向隔离目录内的新文件夹。
当前 Windows 环境的离线回归与编译覆盖共享界面和原生代码，Mac 原生运行、
Android 实机图片交互与 Windows WebView2 帧率仍需相应平台的运行测量。

## Android 连续交互优化

用户反馈第一轮优化后 Android 操作仍不跟手，第二轮以 `ff3e51d` 为基线，
进一步处理持续输入和拖动的同步开销。以下修改保留所有设置、玻璃层与动画：

- 范围与颜色滑杆同步更新草稿、读数及填充，重预览合并到每帧一次。
  `change`、保存和类别切换会立即提交待预览值；取消、关闭和重开会撤销旧回调。
  离散选项仍同步应用。相同根 CSS / 属性与原生外观投影不再重复写入，
  弹窗预览也不再二次配置整个引擎。半径和布局变化仍显式刷新准确几何。
- 拖动开始时缓存按钮几何，同一手势的移动只计算坐标并写滑块位置；
  越阈值仍在抬手前切换，结束时按最终排版校准。批量定位先读后写，
  隐藏页面不再测量，首次显示时即时定位到已保存模型，再恢复后续滑动动画；
  重复 resize 按帧合并，设置关闭时不测量其导航。
- Android 使用一个 Blob Worker 执行原 `generateMaps` 数学函数和 OffscreenCanvas PNG 编码，
  未改变尺寸上限、数值精度、像素、滤镜图元、三层渐进模糊或背景柔光。
  相同几何请求合并，等待中的过期尺寸跳过，旧结果无法覆盖新尺寸或恢复已删除的表面。
  新贴图尚未完成时保留现有玻璃，并用最新边界绘制；配置和按压也沿用最新边界。
  不支持该能力、启动失败、运行异常或超时时，待处理表面按原主线程算法完整恢复。
  Worker 源码由现有光学函数生成，不新增第七项网页资源；其他平台保留原渲染路径。

`tests/verify-android-interactions.mjs` 在独立 Chromium、390 × 844 / DPR 3、
CPU 4 倍降速下比较同一组合成操作。一次采样如下：

| 操作 | 第一轮版本 | 连续交互优化后 |
| --- | ---: | ---: |
| 同一帧 20 次滑杆输入与最终 change：玻璃配置次数 | 42 | 1 |
| 上述光学调整的原生外观调用 | 21 | 0 |
| 上述操作的 LayoutCount | 41 | 1 |
| 20 次同索引拖动的布局读取 | 160 | 0 |
| 12 次 resize 的同步布局读取 | 336 | 0 |
| resize 合批后总布局读取 | 346 | 12 |
| 391 × 607 新贴图生成阶段观察到的主线程长任务 | 154 ms | 无 |

该次新尺寸生成的主线程 ScriptDuration 为约 146 ms → 5.5 ms；
Worker 承担原有计算，并非省去计算或降低玻璃质量。时间只描述该次合成测量，
不等同于手机帧率或端到端触摸延迟。报告保存在
`.build/android-interactions-before.json` 与 `.build/android-interactions-after.json`。
原始副本位于 `.build/android-touch-baseline/web`。

探针还逐像素比较 Worker 与原算法的 displacement / specular PNG，
两类均为 0 个不同字节；验证本地 `file:` 页面可启动 Worker、连续尺寸覆盖、
生成期间修改配置不回退边界、祖先删除后不恢复、Worker 异常后的完整回退，
以及主题改变仍同步原生、取消还原和待预览值立即保存。
`ItLiquidGlass.diagnostics()` 仅返回生成次数、队列长度和 Worker 状态等开发诊断标量。

```powershell
node tests/verify-settings-preview.mjs
node tests/verify-segment-drag.mjs
$env:IT_PREVIEW_ORIGIN = 'http://127.0.0.1:8871'
$env:IT_CDP_ORIGIN = 'http://127.0.0.1:9236'
node tests/verify-android-interactions.mjs
```

本轮预览使用 `node tests/serve-preview.mjs web 8871`，基线目录使用端口 `8872`。
Chrome 仍采用上文所述的独立无界面 profile，调试端口改为 `9236`。
探针不枚举其他标签；所有数据、原生接口和文件页面内容均为测试自身创建或项目公开源码。
`IT_ANDROID_INTERACTION_REPORT` 和 `IT_ANDROID_INTERACTION_SCREENSHOT`
可以分别指定报告与合成截图路径。

最终全量验证在原有套件之外加入 `verify-settings-preview`、
`verify-segment-drag` 和 `verify-android-interactions`；日志保存到
`.build/android-responsiveness-final-verification.log`。
测试 APK 从同一独立无签名 Android 工程的 Debug 构建生成，
交付路径为 `output/笺-2.2.0-安卓响应优化-debug.apk`。
当前没有连接 Android 设备，以上结论来自合成移动场景与构建验证，
仍需在实际设备上确认 WebView 支持情况和操作体验。

## 将光学开销限制在交互组件

2026-11-16，用户进一步指定将内容卡片改为低开销磨砂，液态玻璃只保留在按钮、
交互轨道和滑块。该范围替代前两轮“所有卡片继续保留光学链”的约束：

- 实际内容卡片、设置、预览、菜单、下拉、关于、提示与桌面悬浮窗卡片不再注册光学状态，
  不生成折射 / 高光 PNG，不附加背景采样或三层渐进模糊。磨砂由普通色层、轻微渐变和
  细纹绘制，保留圆角、阴影、壁纸范围与内容交互。磨砂不透明度仍实时预览和保存。
- 手机底部 Tab 轨道与齿轮使用相同透明 `button` 玻璃，选中滑块继续折射但填充透明。
  齿轮移除“设置”可见文字，保留可访问名称与 58 × 58 px 触控区域。
- 语言下拉打开和选项刷新后聚焦非编辑选项，选择 / 关闭后返回入口按钮。
  搜索需要主动点击输入框，筛选、方向键、空格、回车和返回行为继续保留。
- `liquidGlass.card` 六项旧偏好仍可归一化和保存，设置页面板对象仅显示有效的不透明度；
  滑块保留四项、按钮保留三项。底层 card 引擎接口仅在兼容测试中显式调用，
  不由产品界面挂载。

同一合成 Android 场景、390 × 844 / DPR 3、CPU 4 倍降速，在 `41ba608`
与本轮源码上各运行一次，页面初始状态测得：

| 指标 | 调整前 | 调整后 |
| --- | ---: | ---: |
| 大容器持有的光学状态 | 36 | 0 |
| 大容器直接附加的光学背景 / 模糊层 | 36 | 0 |
| 已生成光学图的组件数量 | 57 | 24 |
| 已生成组件贴图尺寸累计像素 | 1081039 | 98205 |

该累计像素数为每个已生成组件的 `mapWidth × mapHeight` 之和，
不对共享缓存去重，也不是屏幕绘制面积或 GPU 时间。此场景生成范围减少约 90.9%，
无法将该比例直接换算为帧率提升。前后报告与真实查看的合成截图分别保存为
`.build/material-before.json` / `.build/material-after.json`、
`.build/material-before.png` / `.build/material-after.png`。

针对性验证覆盖实际容器无光学状态 / 直接层 / backdrop、底栏和设置同预设且 alpha 为 0、
选中滑块透明、图标可访问名称与触控尺寸、语言打开 / 刷新 / 选择 / 手动搜索的焦点，
以及浅深主题普通和错误提示可读性。真实按钮的高对比背景截图仍能检测到折射像素变化。
公开旧引擎精度、三层渐进模糊兼容、Worker 过期任务与完整回退测试继续独立保留。

最终日志为 `.build/material-final-verification.log`；六项共用网页资源在构建前同步到
Android，交付包为 `output/笺-2.2.0-交互玻璃与磨砂-debug.apk`。
该包为独立无签名工程生成的 Debug APK，当前未连接 Android 真机，
合成焦点测试确认没有自动编辑焦点，仍需实际输入法与设备确认体验。

## 按压前后保持相同材质

2026-11-16，模型选择器与设置分类滑块持续使用原按住时的液态玻璃，
不再在静止时覆盖不透明白底。透明 Tab 滑块保留原静止时的折射强度，
按住时不再更新光学参数；其它按钮与下拉入口同样保持原有透明材质。
指针状态仍用于记录按压与清理，不再触发滤镜或底色写入；
拖动和选中动画继续按原几何路径运行。

`tests/verify-performance.mjs` 覆盖默认与自定义强度下的模型和设置分类滑块，
检查按下、松开、取消与失焦前后光学参数相等，并保留 Tab 透明与折射强度检查。
数学与归一化测试另见 `tests/verify-liquid-glass.mjs`。
独立 Chromium 的定向状态检查为 20/20，报告和按住前后截图位于
`.build/steady-materials/`；最终唯一一次全量回归日志为
`.build/steady-material-final-verification.log`，退出状态清单为
`.build/steady-material-final-results.json`。

## 切换前准备完整玻璃

2026-11-17，用户反馈目标页入场后才补齐折射。根因有两处：
隐藏模型滑块首次显示才完成定位，外部模式操作栏和隐藏设置分类也要显示后才有尺寸；
引擎此前在给 `feImage` 写入 PNG 地址后立即标记 ready，没有等图像解码。

当前实现不更改光学公式、图元、透明度、贴图精度、动画时长或缓动：

- 启动恢复偏好后定位隐藏模型滑块，预热模式页面、底部操作栏与默认设置页。
  `display:none` 的操作栏用不绘制、不可交互的真实布局测量；隐藏设置分类在内容框内
  临时保留布局，也不显示或接收焦点。无需复制包含用户输入的 DOM。
- 引擎增加 `prepare(scope, { signal }) → Promise<true>` 与 `isReady(scope)`。
  准备完成必须匹配当前 border box、圆角、光学 key，以及两份 PNG 的 decode / load 完成。
  每份几何缓存只预解码一次；旧 WebView 无 `Image.decode()` 时使用 load / error。
  PNG 解码有超时，失败明确报告而不无限等待。`attach/configure/refresh/stateOf` 契约继续兼容。
- 图像状态增加 `decoded` 与 `readyGeometry` 开发诊断；`.maps` 保留已应用贴图元信息，
  不能单独把它或根元素的 ready 状态当成当前页全部滤镜已准备。
  隐藏表面尺寸临时变为 0 时保留已解码 key，重新测得不同尺寸后仍会失效并重建。
- 暖页面同步切换；冷页面保留旧画面、隔离旧输入与操作栏，并等待目标页和 dock 准备后
  才执行原动画。新点击覆盖旧请求，回到已显示页直接取消等待。
  设置准备中返回可取消；类别正常动画、无动画和 resize 收束均遵守准备门槛。
  重叠测量通过所有者集合管理，旧请求取消不会隐藏仍被新请求测量的控件。
  准备失败恢复旧页或分类，不以未准备玻璃完成入场。

同轮修复手机语言展开框的粉色边框，以及界面标签可长按选中的问题。
`user-select:none` 用于应用标签；原文、实际译文和流式片段恢复 `text`，
搜索与其他可编辑输入也能选择复制。占位内容、标题、状态与按钮不进入选择范围；
原复制按钮和快捷键焦点轮廓保留。桌面共享悬浮窗应用同样的选择规则。

`tests/verify-glass-readiness.mjs` 使用独立 CDP 上下文、合成 Android 桥及内容：
暂停真实 Worker 结果与实际 `Image.decode()` 的完成交付，确认旧画面仍在、
目标未开始动画；放行后逐个检查入场动画首帧的页面和操作栏控件。
另覆盖暖同步、共享任务消费者独立取消、尺寸改变、重复与反向切页、
设置准备中返回、无动画和 resize、手机边框、文字选择、复制和桌面键盘焦点。
四项 VM 测试先归一化源码换行，保证 CRLF 工作区下提取生产函数的断言稳定。

本轮只使用一个独立测试 Chrome 会话，未读取用户浏览器、真实偏好或崩溃日志。
预览端口 `8874`，调试端口 `9238`。针对性报告位于 `.build/glass-readiness.json`；
最终全量日志位于 `.build/glass-readiness-final-verification.log`。
新测试 APK 为 `output/笺-2.3.0-首帧玻璃与文字选择-debug.apk`，
由独立无发布签名工程生成，包内六项网页资源逐项核对当前源码。
当前未连接 Android 设备，合成焦点与选择测试不等于已完成特定输入法实机验收。

## 收窄交互玻璃边缘

2026-11-17，用户反馈玻璃边框的折射范围过大。`opticalPreset()` 对 `pill` 和 `button`
使用 `max(1, min(8, 原截面宽度 × 0.4))` 的边缘带，单位为 CSS px；
截面厚度按相同比例缩放，保持 60:50 几何比例。圆角 17px 的语言入口边缘带
从 17px 改为 6.8px，圆角 29px 的底栏与设置按钮从 29px 改为 8px。
折射最大位移也会相应柔和，公开折射比例、透明填充、高光和动画参数保持原值。

定向数学验证检查边缘仍有非零位移、中心内圈中性位移，以及高光 RGBA 数组逐字节相等；
220 × 64px、圆角 28px 的两个交互预设，发生折射的像素均少于此前的一半。
旧 `card` 预设及公开 `generateMaps()` 的算法没有更改，Worker 使用同一组传入截面参数。
真实合成移动截图保存为 `.build/glass-narrow-rim-mobile.png`，已查看并确认边缘效果。

本阶段在文档和相关资源同步后执行一次最终全量回归，
日志为 `.build/glass-narrow-rim-final-verification.log`。
Android 交付包为 `output/笺-2.3.0-窄边玻璃-debug.apk`，继续包含首帧准备、
手机语言框边框和界面文字选择修复；前一阶段包保留不覆盖。
