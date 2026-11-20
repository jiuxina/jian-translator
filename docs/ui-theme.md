# 界面主题与动效

## v20：统一界面字体粗细（2026-11-20）

“设置 → 阅读与布局”中的“界面字体粗细”统一控制所有共享界面文字，包括导航、语言和模型
选择器、按钮、设置与关于标题、提示、原文、译文及桌面划词浮窗。沿用 `appearance.fontWeight`
和原有 300–700 五档，默认 400；旧配置直接保留已保存字重，不增加另一套正文或界面开关。
设置实时预览并自动保存，“恢复本组默认”恢复 400。选中项继续由颜色、滑块等方式标识。

字重改变后重测下拉标签宽度、重新对齐导航与模型滑块，并刷新交互控件玻璃几何；
重复应用同一字重不重复测量。
定向检查为 `node tests/verify-settings-preview.mjs`、
`node tests/verify-version-consistency.mjs`，另以隔离合成预览检查主界面文字，
静态核对共享浮窗模板的标题、正文和复制按钮均继承同一字重。
本地合成主界面已检查 300、700 两端字重、刷新页面保留选择、恢复本组默认到 400，
以及 360×640 窄屏的粗体导航、正文与设置；浏览器计算字重与选择值一致。

## v19：译文正文与辅助文字可读性优化（2026-11-20）

原文与译文正文统一为 1.8 倍行高，基准字号为桌面 16px、窄屏 15.5px，并继续遵循
已有 90%–140% 字号、字体、字重和自定义文字颜色偏好。原文占位提示、空译文提示、
卡片标题、字数统计与模式简述使用主题次级文字色；窄屏间距、固定浮窗尺寸和现有操作布局不变。
Windows 与 macOS 的划词浮窗正文基准字号调整为 15px，等待提示、状态和底栏也稍作放大，
保留独立缩放偏好、固定窗口尺寸和正文滚动。网页及 Android 继续共享同一组前端资源。

定向验证为 `node tests/verify-settings-preview.mjs` 和
`node tests/verify-version-consistency.mjs`。完成文档及修改后执行一次
`node scripts/verify-release.mjs`；窄屏及最大字号布局通过隔离的本地合成界面检查。

## v18：设置连续交接与主界面响应优化（2026-11-19）

设置分类在同一内容视口中重叠交接。下一页先保持隐藏和不可操作，完成当前尺寸的液态玻璃
准备及贴图解码后，再与仍显示的当前页同步淡入淡出。页面继续使用独立滚动位置，玻璃祖先
始终不增加不透明度/滤镜/遮罩来模拟转场。准备期间保留当前页的交互；交接期间两页暂时不可交互，
动画结束后仅保留目标页并恢复交互，原页面内的焦点移交到目标分类导航。
重复切换遵循最新用户选择，旧页面继续可见直至下一页可绘制，交接中恢复默认临时禁用。
窗口尺寸更新会收束过期动画和准备；交接中关闭先保持已绘制的页面组合，待外层退场后清理，
重开时移除冻结的内联位移、透明度与层级。减少动态效果时保持已准备后的即时切换。

模式间交接复用卡片的矩形与当前视觉样式快照，先集中读取几何再创建动画。相同状态的
空闲操作栏跳过测量；按钮使用原 DOM 与点击处理，仅在完整移动路径不重叠且设备支持
独立 `translate` 时移动，按压仍用原 `transform` 反馈。常用语言、设置选择器保留分组、
排序、禁用与键盘行为，同时缓存标准化标签和上次筛选结果；等价重绘复用当前 DOM，搜索
仍在每次输入时即时更新，不增加等待。

动效距离、时长、缓动、玻璃公式、颜色与透明度保持不变。网页和 Android WebView 资源
继续以 `web/` 为唯一共享真源；资源 URL 仅递增本轮缓存查询版本。设置页面冷准备、热切换、
快速反转、关闭重开和窄屏交互的验证入口见 [性能记录](performance.md)。

## 历史 v17：设置玻璃连续合成、附件和即时设置（2026-11-17）

首帧贴图准备继续保留，但它不能单独保证设置入场时的真实折射。设置遮罩、
对话框或分类容器以整体 `opacity` 淡入时会建立新的背景采样边界，使子控件在动画中
无法采到应用背景，直到最后一帧才突然出现折射。当前让这些祖先始终保持 `opacity:1`，
将遮罩暗化放到独立伪元素，淡入进度传给文字、磨砂填充与光学绘制层。
原有缩放、位移、淡入淡出、时长、缓动、玻璃光学参数和透明材质继续保留。
对话框使用 `--it-settings-reveal`，分类使用 `--it-settings-page-reveal`；
不能注册数值自定义属性的旧 WebView 通过逐帧进度回退保持相同动效。
连续切换、快速关闭重开和减少动态效果仍需正确取消与收束。
桌面设置先读取原生配置和系统字体，再测量最终布局、准备玻璃并开始动画，
避免打开后字体或控件几何变化再次补渲染。

图片以原文输入区上方的紧凑附件呈现：80 × 80px 缩略图使用 88px 高的容器，
纵图和横图占用相同空间，关闭按钮独立可点，提交翻译仍使用原图片数据。
添加、删除和中途替换继续使用连续高度与透明度动画，过期加载结果不能覆盖最新图片。
文字输入、图片/粘贴按钮与翻译要求入口保留可用空间；删除附件不清空原文。

Android 键盘以覆盖方式出现，页面布局和底栏不因输入焦点或键盘高度压缩；
系统栏与刘海安全区仍保留，旋转窗口时按新的安全区更新。网页不再因输入焦点隐藏底栏、
缩小面板或改写卡片间距。语言搜索继续只在用户主动点入时唤起输入法。

设置页移除取消和保存按钮，保留关闭与“恢复本组默认”，修改即时应用并自动持久化。
连续滑块输入逐帧预览，空闲 200ms 合并保存，松手或关闭立即提交。
保存过程中可继续操作；关闭不回滚，失败显示重试，旧写入不能覆盖新修改。
恢复本组默认、壁纸和浮窗图片、快捷键、翻译偏好与更新开关均沿用这套规则。

新增验证入口为 `tests/verify-settings-compositor.mjs`、`tests/verify-attachment-layout.mjs`
与 `tests/verify-android-ime.mjs`，实时保存由 `tests/verify-settings-preview.mjs` 和设置交互场景覆盖。
合成检查分别观察动画 30%、65%、99.5%、100% 时开关真实位移滤镜的像素差异，
以及不同手机尺寸下的附件布局、原文选择、替换动画和 Android 安全区/IME 布局。
本轮最终全量在源码、资源、文档和构建完成后仅执行一次；结果记录为 `.build/ui-polish-final-verification.log` 与
`.build/ui-polish-final-results.json`，不能沿用历史套件的通过统计。
本轮交付目标为 Release 包 `output/笺-2.3.0-release.apk`，
版本 `2.3.0` / code `6`，名称“笺”、应用标识 `ink.jian.translate` 均保持原值。
后续交付也不自行增加文字或包名后缀；此前带额外标识的产物不再交付。
原身份 Release 已重新构建并核验名称、包名与资源；原签名待授权使用，覆盖安装能力尚未验证。

## v16：首帧玻璃准备与界面文字选择（2026-11-17，历史实现）

手机语言入口的展开边框使用原来的 `--lg-edge`，包括设置中的源语言、目标语言和
浮窗目标语言入口。桌面键盘 `:focus-visible` 轮廓保留，语言搜索仍需主动进入输入框。
界面标题、状态、选项和按钮文字默认不可选；三个原文输入区、实际译文及流式片段
可选择复制，搜索与可编辑设置输入仍保留正常编辑。桌面浮窗仅正文 `#out` 可选择。

页面初始化后为隐藏模式的模型滑块定位，并预热模式页面、外部底部操作按钮和默认设置页。
`ItLiquidGlass.prepare(scope, { signal })` 同时等待当前局部尺寸贴图与两份 PNG 解码，
`isReady(scope)` 提供暖目标同步查询。旧 Worker 结果或解码完成不得使过期尺寸就绪。
准备失败沿用引擎的明确错误路径；不以透明平层作为成功玻璃。

Tab 点击仍同步提交选中意图与拖动阈值；旧页面保持绘制，原文与旧操作栏停止交互，
目标页面及操作栏均准备后才开始原有入场动画。已预热再次切页同步开始，不强加等待帧。
设置打开与类别切换，包括关闭动画、resize 收束路径，也在显示前检查就绪。
等待期间返回、快速反向或重复请求只取消自己的等待，不终止其他消费者共享的光学生成。
隐藏测量状态使用所有者集合，避免旧取消清理移除新请求仍需要的布局。

图元、透明度、折射强度、动画时长和缓动保持 v15 的参数。
独立回归通过延迟真实 Worker 回复和图片解码，观察目标动画首帧，而非只检查动画结束状态。
验证入口为 `tests/verify-glass-readiness.mjs`，实现和产物说明见 [性能记录](performance.md)。

后续按用户要求收窄玻璃边缘折射区域：`pill` 与 `button` 的光学截面宽度改为
原圆角截面的 40%，最小 1px、最大 8px。截面厚度同步缩放，保持原 60:50 比例；
折射位移幅度随截面变得更柔和，设置里的折射比例、高光、透明度和动画不改。
中心超过边缘带的区域保持中性位移，避免胶囊大部分内部都发生扭曲。
旧 `card` 引擎预设继续兼容；产品内容面板仍为静态磨砂。

## v15：交互控件持续使用液态玻璃（2026-11-16，历史实现）

所有模型选择器（含 2B/9B）与设置分类滑块从首次显示起就使用液态玻璃：
折射系数固定为公开强度的 0.9 倍，底色不透明度固定为 0.1。静止、按住、拖动、
松开、取消和窗口失焦不再切换为白色或另一种材质，修改玻璃偏好或调整尺寸后也遵循同一规则。
按压缩放、拖动位移、选中位置与键盘操作继续提供交互反馈。

Tab 栏保留原有静止时的透明玻璃外观；选中滑块使用 `material: 'clear'`，
固定为 0.4 倍折射、透明填充，按住时也使用相同参数。其它按钮与下拉入口原本已使用
持续透明的按钮玻璃；手机设置入口同时去掉多余的按压背景声明，避免按压状态引入另一层底色。
材质参数的初始化、偏好更新和尺寸更新共用同一计算路径，指针状态只记录交互状态。

相关覆盖位于 `tests/verify-liquid-glass.mjs` 与 `tests/verify-performance.mjs`，
检查固定材质、自定义折射强度、实际按下 / 松开 / 取消 / 失焦，以及 Tab 的透明外观。
`web/` 的共享源码同步到 Android assets，Windows 与 macOS 构建继续使用同一前端。
定向独立 Chromium 检查为 20/20，覆盖桌面 / 手机、浅色 / 深色下的三个模型组、
设置导航与 Tab；按住前后截图已实际查看，报告与截图位于 `.build/steady-materials/`。
最终全量回归按项目规则只执行一次，日志与各脚本退出状态分别保存至
`.build/steady-material-final-verification.log` 和 `.build/steady-material-final-results.json`。

## v14：交互玻璃与静态磨砂（2026-11-16，历史实现）

液态玻璃只挂载到按钮、Tab 交互轨道、模型与导航滑块。原文、译文、设置、预览、
菜单、下拉、关于、提示和桌面悬浮窗的内容面板采用静态色层、渐变和细纹；
这些容器不注册光学状态、不生成位移 PNG、不使用 backdrop 采样和三层渐进模糊。
Windows 与 macOS 的共享悬浮窗模板也使用同一范围，复制按钮继续保留液态玻璃。

手机底部 Tab 轨道与右侧设置按钮共用透明 `button` 预设。底栏选中滑块保留 `pill`
的折射和按压变化，填充透明，不再覆盖一片不透明白底。设置按钮移除可见文字，
保留居中齿轮、58px 触控尺寸和“设置与关于”可访问名称。

“液态玻璃”调整对象当前提供“磨砂面板”“Tab 与模型滑块”“按钮、底栏与下拉入口”，
分别显示 1、4、3 项控件。磨砂只调整不透明度；旧 `liquidGlass.card` 的其余值
保持归一化和保存兼容，不以无效滑条误导用户。壁纸模糊仍只处理壁纸，不作用于卡片。

语言下拉打开后焦点落在非编辑选项，选项异步刷新也不自动聚焦搜索框。
主动点击搜索框后仍可正常输入和筛选，方向键、空格、回车、Esc 与系统返回路径保留。
详见 [性能记录](performance.md) 与 [设置关系](settings-audit.md)。

## v13：按组件匹配参考预设（2026-11-16，历史实现）

液态玻璃只由 `web/liquid-glass.js` 的同一条 SVG 光学链产生。卡片与面板参考 Music Player
内容面板，Tab、模型和设置导航滑块参考 Dynamic Toggle，按钮与下拉入口参考凸面按钮。
公开参数按参考页逐项核对；页面提供的是不同演示，并不存在一组覆盖所有组件的默认值。

| 组件预设 | 镜面高光 | 饱和度 | 折射强度 | 基础模糊 | 渐进模糊 | 底色不透明度 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `card`：卡片、弹层、悬浮窗 | 40% | 6 | 100% | 1 px | 1 | 60% |
| `pill`：Tab、模型、设置导航滑块 | 50% | 6 | 100% | 0.2 px | 不提供 | 按参考交互固定 |
| `button`：按钮、下拉入口 | 50% | 9 | 100% | 不提供 | 不提供 | 固定透明 |

设置页通过“调整对象”复用最多六条滑条：卡片六项、滑块四项、按钮三项。对应参考公开范围为
高光 0–100%、饱和度 0–50、折射 0–100%、基础模糊 0–40 px、渐进模糊 0–10、
卡片底色不透明度 0–100%。“恢复本组默认”只恢复当前对象，不改写其它对象。
厚度、边缘宽度、折射率和表面轮廓不再作为用户设置。

Dynamic Toggle 的 `lip` 曲面与按住状态也进入共享引擎：静止时折射系数为公开强度的 0.4 倍，
底色不透明度为 1；按住或拖动时分别为 0.9 倍和 0.1。松开、取消指针或窗口失焦会恢复状态。
轨道本身透明，只有滑块折射，避免两层材质叠加。按钮不再叠加旧的渐变填充和白色内高光。

修正上一轮凸面圆角矩形公式缺少四次根的问题；凹面与唇形也按参考曲线计算。
高光采用灰白遮罩合成被折射背景的饱和度，移除人为的色相环。基础几何保持参考示意的
60:50 边缘宽度与厚度比例，随组件尺寸一并缩放；位移图按组件本地尺寸重新生成。
这是响应式组件对同一光学方法的应用，不声称与参考页固定 PNG 的几何逐像素相同。

偏好版本为 `3`，配置结构为 `liquidGlass.{card,pill,button}`。上一轮扁平玻璃配置和更早的
材质、强度、透出键均丢弃并使用新预设；字体、主题、壁纸与翻译偏好保留。
旧注入实现的八项资源已移至回收站并从源码和后续 APK 资源输入中移除，不保留运行时回退。
环境背景、配色、布局和外阴影属于界面样式，继续保留。

Windows 主窗口普通状态使用随 DPI 缩放的 22 DIP 外圆角，最大化或全屏时取消区域裁剪；
此项独立于“卡片圆角”。macOS 使用 Chromium 桌面壳、原生交通灯和拖动区域，共用前端与引擎，
全屏或最大化时清除前端圆角。具体构建与验收边界见 [桌面集成](desktop-integration.md)。
引擎明确拒绝已知不支持 SVG 背景折射的非 Chromium 渲染器，显示持续错误提示，
不把普通着色层当作成功渲染。UA 和 CSS 查询仍不等于目标设备绘制验收。

引擎 v4 将折射背景与文字内容分层：所有表面都使用独立背景层，卡片另外使用三个
CSS `backdrop-filter: blur(...)` / `mask-image` 层实现渐进模糊，SVG 内只保留基础模糊、
折射、背景饱和度和高光。这与参考演示的分工一致，不把渐进模糊重复塞进 SVG 合成链。
运行时也不再生成多余的渐进模糊 PNG；按钮和胶囊没有不适用的渐进模糊层。
语言轮盘的收尾绑定当前 `CSSTransition.finished` 和选择代次，防止慢帧或旧动画取消提前清空条带。

定向数值检查、语法检查和独立 Chromium 预览已覆盖预设分组、控件数量、按住状态、
设置面板滤镜尺寸和 macOS 桥接界面。实际 Windows DWM 阴影/缩放、Mac 原生全屏与
Android System WebView 性能需要目标设备验收。最终全量回归和本轮构建记录见桌面集成文档。

最终全量之后还修复了隐藏表面重复写入同值 `pending` 状态所触发的刷新循环。
空闲页面连续两次间隔 1.2 秒采样，状态写入、RAF 队列及 SVG 更新计数均保持不变，
没有修改光学参数或动效等级。最终定向动画记录见 `output/verify-animation-targets-final.json`：
双向 Tab、轮盘正反/快速改选和设置关闭清理通过，没有残留动画；本机多数帧采样约 95ms，
不能报告为 60fps。关于页移除渐变图标；各模式主按钮统一为“翻译”，
长文导出入口统一为“下载”。设置增加更新分类，检查结果与启动检查开关独立保存。

## 历史 v12：全量替换为 SVG 液态玻璃（2026-11-16）

本节记录上一轮实现，其参数和界面已被 v13 取代。主界面、玻璃控件、设置内预览和 Windows 划词悬浮窗统一使用
`web/liquid-glass.js` 生成按元素尺寸更新的 SVG 位移图、镜面图和渐进模糊图，并直接将滤镜
应用到各自表面的 `backdrop-filter`。方案参考 [Kube 的 Liquid Glass CSS/SVG 说明](https://kube.io/blog/liquid-glass-css-svg)，
折射表面与滤镜代码为本项目实现。浏览器文档指出将 SVG filter 用作 `backdrop-filter` 具有浏览器限制；
打包后 WebView2 与 Android WebView 的实际支持仍待实机验收。运行时不支持时会标记错误并明确报告，
不会回退到先前的普通磨砂、彩色边线或纯色效果。

设置页的“液态玻璃”分类配置全局共享的 `liquidGlass` 对象：

| 参数 | 默认值 | 效果 |
| --- | ---: | --- |
| `surfaceProfile` | `convex-squircle` | 表面轮廓：凸面圆、凸面圆角矩形、凹面、唇形边缘。 |
| `bezelWidth` | 12 px | 折射边缘宽度，4–32 px。 |
| `glassThickness` | 14 | 玻璃表面厚度，影响光线路径。 |
| `refractiveIndex` | 1.5 | 折射率，1.0–2.5；1.0 不产生背景偏移。 |
| `refractionLevel` | 100% | 位移图缩放，0–200%。 |
| `specularOpacity` | 45% | 镜面高光不透明度。 |
| `specularSaturation` | 6 | 镜面色彩饱和度，1–10。 |
| `blurLevel` | 60% | 基础高斯模糊量。 |
| `progressiveBlurStrength` | 50% | 玻璃平面内部渐进模糊。 |
| `backgroundOpacity` | 60% | 玻璃着色层透明度。 |

旧 `appearance.material`、`appearance.glassStrength`、`appearance.cardReveal` 和
`popup.cardReveal` 已退出新配置和渲染流程；旧值不会折算到新参数。旧版保存数据升级时只替换玻璃参数为
新默认值，主题、字体、壁纸和翻译偏好等其它配置继续保留。原来的壁纸图片 `background.opacity`、
`background.blur`、`background.fit` 仍保留，用于壁纸图层，与玻璃着色、玻璃模糊互相独立。
玻璃配置全局共享，不提供悬浮窗独立玻璃设置；PC 仍可单独选择浮窗背景图片。

### v12 验证状态

- 单元测试验证四种轮廓产生不同位移图、折射率为 1 时位移为零、玻璃厚度影响光线偏移，
  并验证各配置范围归一化。
- 本轮唯一一次 `node tests/verify-motion.mjs` 全量执行：**127/128 通过**。覆盖旧偏好升级、玻璃参数控件与分组重置、
  折射/高光/模糊更新、悬浮窗共享参数及浅深模式；高对比条纹背景下开关折射时，卡片边缘
  有 **18,726** 个像素发生变化，证明滤镜在 Chromium 实际改变了背景采样。
- 唯一失败项是语言轮盘反向动画断言在 60/90ms 固定采样窗口读到相同帧；随后将测试改为等待动画时钟推进，
  针对性 Chromium 探针确认正向与反向位置变化均符合预期。按全量测试只执行一次的要求，本轮未重跑完整套件。
- 已生成并查看默认主题截图 `output/preview-liquid-glass-final.png`，以及 A/B 验证图
  `output/preview-liquid-glass-no-refraction.png` 和 `output/preview-liquid-glass-refraction.png`。
  平滑默认壁纸上的折射较克制；高对比背景更容易观察边缘偏移。
- Rust `rustfmt --check`、补丁器 Python 语法、JavaScript 语法和 `git diff --check` 通过。
- 尚未用打包后的 Windows WebView2 和 Android System WebView 确认实际 `backdrop-filter: url(#...)` 绘制；
  代码能生成滤镜或 CSS 声明被接受，都不能替代这项检查。

### v12 构建产物

Windows Pake Release/安装包与 Android Release 均构建成功，旧文件保留，新增：

| 平台 | 文件 | SHA-256 |
| --- | --- | --- |
| Windows | `output/笺-2.2.0-液态玻璃.exe` | `6FCD13E80DFFA2CAA5A946C5B154B18099C0BF8D55FA1149A8B3DB29DD85D909` |
| Windows | `output/笺-2.2.0-液态玻璃.msi` | `12964DB599930294F84C91B7566A3F818A77F87B9BEA1D41F5138D4EC84FF06E` |
| Android | `output/笺-2.2.0-液态玻璃.apk` | `740B849EC1DF959EEF355E49ECDABE9C25222E519D5C51C56CA9C1084BFFDF16` |

Windows 源码在 `.build/release-stage-liquid-glass-20261116/` 构建后复制交付。
APK 的 assets 包含新的 `liquid-glass.js`，网页四项资源与 `web/` 同步。完整清单见
`output/SHA256SUMS.txt`。目标 Windows/Android WebView 的实机玻璃渲染仍未验收。

---

历史版本记录从 v11 开始；下方条目仅说明当时实现，不代表当前材质设置。

## v11：手机底栏入口、拖动选择与卡片背景裁剪（2026-11-15）

- 手机顶部品牌入口与空标题栏收起，底栏改为三个模式共用玻璃胶囊，旁边独立放置“设置”
  齿轮按钮。齿轮提供 58px 触控区域，在上方打开“设置…”与“关于”；关闭页面后回焦到齿轮。
  输入时底栏和操作区一同避让。Windows 窄窗口仍保留标题栏及最小化、最大化、关闭按钮。
- 去掉 WebKit 默认蓝色触摸高亮，保留主题 `:focus-visible` 焦点轮廓与正文选区颜色。
  浏览器使用 CSS 安全区；Android 原生把系统栏、刘海和键盘 insets 应用为 WebView 实际外边距，
  再将已处理的 insets 清零后传给 WebView，避免 fixed 控件和触摸坐标落在系统栏下或重复避让。
- 主模式与模型胶囊支持鼠标及触屏拖动：横向移动 8px 后捕获，滑块跟随指针，
  越过相邻项中点并加 4px 回差时实时切换；同一手势支持多次和反向切换，松开或取消后对齐当前项。
  普通点击、方向键、焦点及原有持久化路径保留；条外松开、失焦和缩放均清理捕获。
- 原文、译文、翻译要求、下拉列表与设置内容统一透明滚动轨道、主题色细圆角滑块，
  去掉系统滚动箭头。WebKit 使用伪元素样式；标准 scrollbar 属性只在非 WebKit 分支中使用，
  避免 Chromium 用原生滚动条覆盖自绘样式。
- Windows 悬浮窗背景层改为卡片同矩形及同圆角裁剪，图片、模糊和淡化都不进入四周阴影留白；
  外阴影放到 frame，内部高光留给卡片。`contain` 按卡片尺寸完整显示，
  `cover` 仅在背景模糊开启时扩展所需边缘。设置内预览同步使用同样分层。

### v11 验证记录

- `node tests/verify-motion.mjs`：**120/120 通过**。新增鼠标/触屏拖动、门槛抖动、
  实时多项/反向选择、取消与条外松开、拖动后方向键、手机齿轮入口与回焦、安全区、
  点击高亮、浅深滚动条、窄桌面标题栏、悬浮窗背景与预览矩形、完整显示、透明外部和阴影检查。
- 实际浏览器截图已查看：`output/preview-touch-mobile-main.png`、
  `output/preview-touch-mobile-menu.png`、`output/preview-touch-scrollbar-light.png`、
  `output/preview-touch-scrollbar-dark.png`、`output/preview-popup-clipped-contain.png`、
  `output/preview-popup-clipped-dark.png`。浮窗带边框测试图四边完整，外部采样仅有透明或阴影像素。
- JavaScript 语法、维护源 `rustfmt --check` 及 `git diff --check` 通过；
  Android 离线 Java 编译及 Release 构建成功。Java、JS 及综合代码审查均已完成；
  审查发现的窄桌面窗口按钮隐藏和 `contain` 图片边缘裁剪已修复并复核。
- Android 完整离线 `check` 在 AndroidTest lint 模型依赖解析时因缺少本地缓存停止；
  这不代表完整检查已通过。真实 Android 状态栏、IME、横竖屏与刘海屏，Windows 原生浮窗及
  DPI 的设备验收仍需补充；浏览器仿真和模板渲染不替代设备结果。
- Rust 预检的 Windows 目标离线 `cargo check` 通过；严格 `clippy -D warnings` 仍报告三项既有
  脚本投递/窗口创建警告（多余借用及副作用 `map`），未把严格 Clippy 记录为通过。

### v11 构建交付

应用版本保持 `2.2.0`，Android versionCode 保持 `5`。上一轮产物保留，本轮另存为：

| 文件 | 字节数 | 构建时间（Asia/Shanghai） |
| --- | ---: | --- |
| `output/笺-2.2.0-交互优化.exe` | 9,400,320 | 2026-11-15 21:02:44 |
| `output/笺-2.2.0-交互优化.msi` | 4,292,608 | 2026-11-15 21:02:41 |
| `output/笺-2.2.0-交互优化.apk` | 3,579,692 | 2026-11-15 20:59:11 |

Windows 由 `.build/release-stage-touch-2.2.0/` 复制，Release 编译和 MSI 打包成功；
Android 先覆盖同步四项 `web/` 资源，再离线构建并跳过历史删除任务。
APK 内资源哈希与源码一致，v2 签名验证通过；发布 SHA-256 追加到 `output/SHA256SUMS.txt`。
MSI 产品版本为 `2.2.0`；EXE 的 PE 版本仍沿用 Pake 模板 `3.18.0` 的已知限制。

---

## v10：设置连贯切换、统一下拉与开源入口（2026-11-15）

- 设置导航采用独立选中滑块，兼容桌面竖排和手机横排；右侧设置项按默认 140ms 淡出、
  140ms 淡入交接。淡出时连续选择只更新最终目标，入场期间可再次重定向；关闭、缩放、
  动态开启系统减少动态效果均会清理旧计时器并收束到当前选择。
- “减少”使用 80ms 的淡入淡出并取消位移；“关闭”或系统减少动态效果直接呈现目标页。
  离场与入场过程中隔离旧控件焦点，返回与保存仍沿用现有草稿事务。
- 设置下拉复用 `.sel-btn` / `.sel-pop`，与主界面共用玻璃材质、主题配色、圆角和箭头；
  支持键盘、搜索、禁用态、焦点返回，以及 Windows 系统字体异步返回后的列表刷新。
  手机下拉按钮至少 48px 高，PC 字体行及加载提示在手机隐藏。
- 关于页移除“译”和 `TRANSLATION CLIENT`，标识文字使用“笺”，新增开源仓库地址
  `https://github.com/jiuxina/jian-translator`。Windows 沿用 Pake 既有外链出口；
  Android 让 HTTP(S) 导航进入既有 `ACTION_VIEW` 拦截，网页使用新标签打开。
- 完成六组设置消费关系检查，见 [设置项关系简报](settings-audit.md)。
  纯色材质下禁用不生效的玻璃强度滑块并保留原值；切回玻璃或磨砂后恢复。
  本轮不删除具有独立用途的配置。

### v10 验证记录

- `node tests/verify-motion.mjs`：**92/92 通过**，增加关于页仓库、导航滑块、
  淡出/淡入、快速连续切页、系统减少动态效果两帧内收束、键盘方向键和空格选择、
  动态字体搜索、纯色依赖禁用、手机横排滑块与 PC 控件隐藏等验证。
- JavaScript 语法与 `git diff --check` 通过。独立代码审查发现的快速切页跳帧、
  下拉空格提交旧焦点和系统减少动态效果未立即收束问题均已修复并复核。
- 实际浏览器截图：`output/preview-settings-polish-light.png`、
  `output/preview-settings-polish-dark.png`、`output/preview-settings-polish-dropdown.png`、
  `output/preview-settings-polish-mobile.png` 与 `output/preview-2.2.0-about.png`。
  字体和剪贴板仍使用离线替身，原生窗口与实际字体列表验收限制见 v9 记录。

### v10 构建交付

版本保持 `2.2.0`，Android versionCode 保持 `5`。为保留本轮之前的包，新增以下文件名：

| 文件 | 字节数 | 构建时间（Asia/Shanghai） |
| --- | ---: | --- |
| `output/笺-2.2.0-界面优化.exe` | 9,400,320 | 2026-11-15 20:02:15 |
| `output/笺-2.2.0-界面优化.msi` | 4,292,608 | 2026-11-15 20:02:11 |
| `output/笺-2.2.0-界面优化.apk` | 3,577,484 | 2026-11-15 19:57:10 |

Windows 构建写入 `.build/release-stage-settings-2.2.0/`，随后复制到以上独立文件名。
Android 四项 assets 用覆盖同步后跳过历史删除任务，离线 `assembleRelease` 成功，
APK 内资源哈希与 `web/` 一致，v2 签名有效。发布 SHA-256 已追加到 `output/SHA256SUMS.txt`。
Windows 的 MSI 版本与 EXE 模板元数据差异继续沿用 v9 中记录的限制。

---

## v9：应用内关于、正文排版与透明悬浮窗（2026-11-15）

- 版本统一到 2.2.0；Android versionCode 为 5。主菜单只保留“设置…”和“关于”，关于信息使用
  主题玻璃弹窗，支持 Escape、系统返回、焦点隔离与返回焦点恢复。
- 主界面和悬浮窗卡片各自有 0–100% 透出度。0% 保持原有玻璃材质，100% 清除卡片材质和模糊；
  图片本身的背景淡化、模糊和填充继续由主背景设置控制。
- 原文、译文及悬浮窗正文增加字重与主题/自定义字体颜色；PC 字体下拉由 Windows GDI 实时枚举系统字体，
  字体命令仅允许应用本地 origin 调用。
- 悬浮窗背景默认跟随主窗口，可独立选图并一键恢复跟随；选图结果在内嵌预览更新，保存后才投影到真实悬浮窗。
- 文本模型显示名称“2B 快”改为“2B”，接口模型标识不变。悬浮窗复制通过 Windows Unicode 剪贴板写入，
  并为成功、空内容与失败显示明确状态。

### v9 验证记录

- `node tests/verify-motion.mjs`：**80/80 通过**，覆盖菜单/关于交互、设置保存与撤销、字体字段兼容、
  PC 字体枚举桥模拟、悬浮窗选图与恢复跟随、透出度端点及浅深主题/三种材质/模糊降级。
- `node --check`（前端与回归）、Rust `rustfmt --check`、补丁器 `py_compile`、Windows 目标离线
  `cargo check` 均通过；Pake 模板 `cargo test` 为 **93/93**。
- Android `assembleRelease` 成功，包名 `ink.jian.translate`、versionCode `5`、versionName `2.2.0`；
  `apksigner verify` 确认 v2 签名有效，证书指纹与既有发布签名一致。Android 四项 assets 与 `web/`
  SHA-256 一致。
- Windows Release EXE/MSI 于 2026-11-15 18:38 重建；MSI ProductVersion 为 `2.2.0`。Pake 仍将 EXE 的 PE
  FileVersion/ProductVersion 标为 `3.18.0`，应用关于页与 MSI 产品版本为 `2.2.0`。
- Windows origin 限制测试已包含在模板 Rust 测试中：`cargo test --offline` **93/93 通过**；
  Windows 目标 `cargo check --offline` 与维护源 `rustfmt --check` 通过。
- 浏览器回归使用系统字体和剪贴板替身；Windows 实机的 DWM 顶边、实际 GDI 字体列表、浮窗全文复制
  与不同 DPI 的截图验收尚未完成，不以编译和模拟桥测试替代原生画面验收。

### v9 发布包（2.2.0）

| 文件 | 字节数 | 构建时间（Asia/Shanghai） |
| --- | ---: | --- |
| `output/笺-2.2.0.exe` | 9,396,224 | 2026-11-15 18:38:06 |
| `output/笺-2.2.0.msi` | 4,288,512 | 2026-11-15 18:38:02 |
| `output/笺-2.2.0.apk` | 3,575,056 | 2026-11-15 17:43:35 |

三个安装包使用独立版本文件名，保留 2.1.0 包；SHA-256 已追加到 `output/SHA256SUMS.txt`。
Pake 构建写入隔离目录 `.build/release-stage-2.2.0/`。关于页和设置页静态浏览器截图为
`output/preview-2.2.0-about.png` 与 `output/preview-2.2.0-settings.png`；截图用于 UI 检查，
不代表原生 Windows 窗口边缘已验收。

---

## v7：个性化设置与桌面边框（2026-11-15）

- Windows 主窗口不再绘制系统激活边框；保留原生阴影、圆角及现有拖动和缩放。
- Windows、Android、网页增加外观、阅读布局、背景、动效、翻译偏好分组。主题含浅/深/系统、
  四套配色、玻璃材质和强度；背景可调淡化、模糊与填充；内容可调字体、字号和紧凑间距。
- 设置提供实时预览和保存；关闭、Escape 和系统返回会还原未保存草稿。Windows 专属快捷键和启动选项保留。
- 默认薄樱浅色玻璃不变。翻译偏好可配置默认页面、语言、各页模型，并可选择是否记忆上次状态。
- Web 的版本化配置是浏览器和 Android 的设置源；Windows 使用原生设置文件，页面首绘等待配置载入，
  旧背景键会迁移。Windows 划词浮窗只接收外观投影，主题变化不会重启翻译流。
- Android 原生系统栏、安全区背景、加载层和图片来源面板随主题更新；取景界面保留黑色风格。

此版本前端缓存版本号为 `v14`，应用发布版本为 `2.1.0`。通用设置在本机保存，不提供跨设备同步。

### v7 验证记录

- `tests/verify-motion.mjs`：**66/66 通过**。外网请求被阻断，覆盖原有连续动画、三端设置入口、
  预览与撤销、背景恢复、默认语言／模型优先级、记住页面后的 resize、分组重置、保存竞态、
  纯色材质、Android 浅深启动色板及手机 48px 触控区。
- JavaScript 语法检查通过；Android Debug Java 编译通过，四个 assets 镜像与 `web/` 的 SHA-256 一致。
- Windows 目标离线 `cargo check`、维护补丁 `rustfmt --check`、模板同步哈希检查通过。
- 浅色、深色和 390×844 手机设置截图均来自实际浏览器渲染并经查看；无明显溢出或遮挡。
- Windows 原生画面验收因 Computer Use 应用授权等待超时未完成；DWM 激活切换、原生浮窗及窗口
  缩放仍需要实机复核，详见 `docs/desktop-integration.md`。当前未连接 Android 设备。
- Android 原生色板缓存会在创建 Activity 根视图前应用；操作系统最初显示的静态浅色启动画面仍可能
  在深色冷启动时短暂出现，进入应用内容后使用已保存色板。

### v7 发布包（2.1.0）

| 文件 | 字节数 | 构建时间（Asia/Shanghai） |
| --- | ---: | --- |
| `output/笺-2.1.0.exe` | 9,370,112 | 2026-11-15 15:36:50 |
| `output/笺-2.1.0.msi` | 4,280,320 | 2026-11-15 15:36:46 |
| `output/笺-2.1.0.apk` | 3,570,744 | 2026-11-15 15:35:10 |

- Windows Release 编译及中文 MSI 打包成功；只读查询 MSI 的 `ProductVersion` 为 `2.1.0`。
  EXE 的 PE FileVersion/ProductVersion 仍由 Pake 模板标为 `3.18.0`，应用内版本与安装包版本为 `2.1.0`。
- Android Release 构建成功，包名 `ink.jian.translate`、versionCode `4`、versionName `2.1.0`；
  `apksigner verify` 确认 APK v2 签名有效，保留既有签名身份。
- APK 内四个前端资源与当前 `web/` 逐字节哈希一致，包含最终的保存快照、分组重置和原生色板修复。
- 三个发布文件均从隔离构建目录复制并再次校验 SHA-256；完整校验值在 `output/SHA256SUMS.txt`，
  同时保留旧版本校验值。旧文件另备份到 `.build/release-backup-v7-20261115/`。
- 新设置截图为 `output/preview-settings-light.png`、`output/preview-settings-dark.png`、
  `output/preview-settings-mobile.png`。这些是前端实际渲染，不代表 DWM 原生画面已验收。

## 仓库与构建基线（2026-11-15）

本项目已开始纳入本地 Git 管理；源码、资源、测试与文档入库，构建缓存与发布二进制不入库。
Android 签名凭据已外置到被忽略的 `android/signing.properties`，原密钥保持不变。
独立预览服务现位于 `tests/serve-preview.mjs`，不再依赖 `.build/` 中的临时脚本；
Windows 模板版本固定使用 Pake 3.18.0。完整入口见根目录 README。

> **当前源码：v11「手机底栏入口、拖动选择与卡片背景裁剪」**（2026-11-15，前端资源 v17）。当前自绘界面的样式与
> 动效真源是 `web/theme.css`；Android WebView 共用这份资源。Windows 划词浮窗在
> `desktop/patch/setup.rs` 中接收已保存的外观偏好。
> v7 发布包采用独立文件名，保留 `output/` 中既有文件及正在运行的程序。
> v1 至 v5 章节保留历史设计和发布记录。

## v6：一镜到底

- 文本、音节和长文在同一空间中交接。新页面的模型胶囊与两张玻璃卡片从旧页面当前矩形
  连续变换，卡片内容根据导航顺序横向进入和离开，顶栏、共享语言条与操作区位置稳定。
  退场卡片移除第二层玻璃材质，避免交叠时颜色突然变深。
- 页面交接统一为 `--lg-duration-panel:420ms`，与导航滑块节奏一致；位移为
  `--lg-distance-scene:28px`，缓动为 `--lg-ease-scene`。用真实 DOM 的 Web Animations API
  与矩形测量完成衔接，不复制输入框或将正在翻译的内容替换为截图。
- 连续切换从当前视觉矩形、透明度和位移接续；最后一次选择生效。模型滑块只参与内容透明度交接，
  因而页面入场期间仍可切换模型。退场页当帧设置 `inert` / `aria-hidden`，焦点迁到新模式；
  模式内下拉跟随所属页面收起。
- 语言下拉和更多菜单从实际入口矩形展开，并沿原路径收起；桌面设置从菜单选项位置承接。
  设置打开时背景不可取得焦点，Tab 在对话框内循环，关闭后回到入口；快速开合不会复位到初始帧。
- 翻译要求的高度、透明度和位移允许中途反向，取消原先的点击锁。图片预览通过高度变化连续让出
  输入空间，移除过程中重新选择图片会保留最后一张，过期的加载回调不会覆盖新选择。
- `window.__itHandleBack()` 让 Escape 与 Android 返回键每次只收起当前可见的最上层。
  隐藏页面的翻译要求不消耗返回键。Android 图片来源面板在退场完成后启动拍照或相册，
  并阻止重复点按及 Activity 销毁后的延迟启动。
- 窗口变化会结束当前轨迹并重新对齐几何；运行中启用系统减少动态效果会立即结束动画。
  减少动态效果时 CSS 动画和过渡均关闭，旧 WebView 不支持 `Element.animate()` 时即时呈现最终状态。
  手机安全区、键盘让位、轮盘顺序和开始翻译按钮的悬浮行为沿用 v5。

离线交互回归：`tests/verify-motion.mjs`，使用 Node 内置 WebSocket 与 Chrome CDP，
不需要安装依赖。用 `.build/preview-server.mjs web 8899` 启动预览，并以独立 Chrome profile
监听 `127.0.0.1:9223` 后执行 `node tests/verify-motion.mjs`。脚本拦截外网请求，
剪贴板和桌面桥使用本地替身；覆盖方向、卡壳连续性、快速切换、模型滑块、展开反转、
图片重入、语言轮盘、返回、焦点隔离、减少动态效果、窗口变化及两种手机尺寸的实际点击。

Android 编译验证使用现有本地缓存：

```powershell
.\gradlew.bat -g F:\xm\translator\.build\gradle-home :app:compileDebugJavaWithJavac -x syncWebAssets --offline --console=plain
```

构建前须先将 `web/` 四个文件复制覆盖至 `android/app/src/main/assets/` 并校验一致。
跳过 `syncWebAssets` 是因为该历史任务会永久删除 assets 目录；此轮只修改同名资源，无需删除文件。
当前目录没有 `.git`，本轮无法创建 Git 提交。原生面板的设备实测仍需 Android 真机或模拟器。

### v6 验证记录（2026-11-15）

- `node tests/verify-motion.mjs`：**47/47 通过**。验收在自建页面中离线运行，剪贴板与设置桥接使用替身，
  没有访问翻译接口或外网；两种手机尺寸均检查实际指针命中，未只依赖程序化点击。
- `node --check web/app.js` 与 `node --check tests/verify-motion.mjs` 通过。
- Android `:app:compileDebugJavaWithJavac` 离线编译成功；`index.html`、`theme.css`、`app.js`、
  `langs.js` 四个镜像与 `web/` 的 SHA-256 完全一致。
- 代码审查修复了页面入场期间模型滑块回退、隐藏页面要求消耗返回键，以及 WebView 在取消填充动画后
  缓存工具栏隐藏状态的问题；最终审查无待解决问题。
- `output/preview-one-take.gif` 来自实际浏览器渲染，展示模式交接与翻译要求连续开合。
  该 GIF 是前端预览，未更新 EXE、MSI、APK 或它们的发布校验值。

## v5：手机布局与安全区

- `max-width:760px` 使用手机布局；品牌留在顶部，文本 / 音节 / 长文切换移到固定底部玻璃胶囊，
  共享模式滑块保留与桌面相同的移动反馈，每项的触控高度至少 48px。
- 清空 / 开始翻译保持独立、无底板，停靠在模式栏上方；主内容区预留两排控件所需的空间，
  短屏时内容在面板内滚动，避免按钮压住原文或译文。
- 文本输入取得焦点后隐藏两排固定栏，将可视空间还给输入区；离开输入状态恢复底栏。
  Tab 保持左右方向键、Home、End 切换，焦点和 `aria-selected` 跟随当前模式；过渡期间旧面板设为
  `inert` / `aria-hidden`，键盘和辅助技术会直接落在新面板。
- Android 原生根层在状态栏 / 导航栏下方绘制主题柔光，WebView 画布透明，并通过
  `WindowInsets` 留出安全区；底栏再以 `env(safe-area-inset-bottom)` 尊重设备手势区。
- 验收视口：390×844 与 360×640；浏览器回归同时验证 48px 触控区、底部间距、输入焦点时底栏显隐
  和短屏面板内部滚动。

### v5 发布构建（2026-11-15）

三个发布包均已更新到 `output/`，应用版本维持 `2.0.0`，前端资源版本为 `v12`。

| 文件 | 字节数 | 构建时间（Asia/Shanghai） |
| --- | ---: | --- |
| `output/笺.exe` | 9,341,952 | 2026-11-15 01:41:38 |
| `output/笺.msi` | 4,259,840 | 2026-11-15 01:41:34 |
| `output/笺.apk` | 3,557,788 | 2026-11-15 01:39:41 |

- Windows 使用现有 Git Bash、Rust 和工作区内的 Pake 构建；`npm_config_prefix` 仅在构建进程中指向
  `.build/npm-global`。EXE 与 MSI 均成功生成，构建前的旧包保存在 `.build/release-backup-20261115-013754/`。
- Android 使用现有 Gradle 缓存离线执行 `:app:assembleRelease -x syncWebAssets`；构建前已校验
  `web/` 与 `assets/` 一致，因此跳过会删除并重建 assets 的同步任务。
- APK 签名验证通过（v2），包名 `ink.jian.translate`、versionCode `3`、minSdk `24`、targetSdk `35`。
  包内四个前端文件与当前 `web/` 逐字节一致，DEX 包含原生 `UiMotion` 类。
- 新 EXE 使用 WebView2 本机调试端口验证，`.build/verify-release.mjs` 的 **11/11** 项通过：
  实际内嵌资源为 v12，导航和模型滑块就绪，页面切换的辅助技术状态正确，390×844 下底栏触控区
  与内容间距合格，输入焦点切入切出会隐藏并恢复底栏，页面无 JavaScript 异常。
- 成品窄屏截图为 `output/preview-release-mobile.png`；完整源码交互回归为 **57/57**。
  本次未连接 Android 真机，原生系统栏渲染仍待设备验证。文件 SHA-256 见 `output/SHA256SUMS.txt`。

## v4：历史视觉与动效规则（由 v5 继承）

- **视觉**：保留薄樱粉紫基调，增强玻璃色度、透光、镜面边和层级阴影；不扩大输入与吸底控件，
  开始翻译按钮悬浮仍不移动，吸底区仍无底板。
- **主界面**：Tab 内容 280ms 重叠淡入淡出；旧页退场时新页已同时入场，共享顶栏和语言条不动。
  快速连点时以最后一次选择为准。
- **交互节奏**：通用控件 220ms、弹层 240ms、页面 280ms；同一组 CSS 动效令牌由 JS 读取。
  只有模型滑块、语言轮盘和相机按键使用弹性缓动；轮盘方向、距离与候选列表顺序保持一致。
- **环境光**：64 秒低幅度柔光漂移；系统启用「减少动态效果」时关闭环境动画并即时切换。
  主译文和划词浮窗仍按偏好减少逐字动画；Android 原生动画时长跟随系统 animator / transition scale。
- **范围**：三 Tab、共享语言和设置/语言菜单、Windows 划词浮窗、Android 原生加载/错误层、
  相机与应用内取图来源面板。手机将模式 Tab 固定在安全区上的底部玻璃胶囊，翻译操作停靠在其上方；
  编辑输入时隐藏底栏，让出键盘空间。Android 系统权限提示及系统相册选择器由操作系统绘制，不改写。
- **平台边界**：真模糊只用于 WebView / WebView2；Android 原生弹层和控件使用半透明填充、
  镜面细边、圆角、系统涟漪和 elevation 来呼应材质，不伪装成系统不支持的模糊。
- **状态栏 / 安全区**：Android 状态栏与导航栏继续透明并采用浅色系统图标；原生根层铺主题柔光，
  WebView 通过 WindowInsets 预留顶部和底部安全区。网页底栏另外读取 `env(safe-area-inset-bottom)`，
  让浏览器和原生 WebView 都不会压住手势条或状态区。
- **同步**：修改 `web/` 后把 `index.html`、`theme.css`、`app.js`、`langs.js` 同步到
  `android/app/src/main/assets/`；Gradle `syncWebAssets` 仍会在构建阶段重新复制。

| 动效变量 | 默认值 | 作用 |
| --- | --- | --- |
| `--lg-duration-fast` | 140ms | 小型按压反馈 |
| `--lg-duration-control` | 220ms | 常规控件过渡 |
| `--lg-duration-dialog` | 240ms | 菜单与设置弹层 |
| `--lg-duration-panel` | 280ms | 页面切换与展开面板 |
| `--lg-duration-model` | 420ms | 模型滑块；轮盘时长另按列表距离计算 |
| `--lg-ease-enter` / `--lg-ease-spring` | CSS timing functions | 页面/弹层共用缓动与重点控件弹性 |

验证脚本：`.build/verify-anim.mjs`，覆盖连续 Tab 切换、共享栏位置、弹层开合、按列表顺序滚动、
动效减少模式和逐字流式输出。打包前把源文件同步到 Android assets；更新桌面包会执行
`app/rebuild.sh`。本次无需改网络接口或数据格式。

## 反馈与修正（v2 历史）

第一版只换了配色，却给导航、卡片、双栏、吸底都加了描边和阴影，**层级反而更多了**，
文字也基本没删。v2 反过来做减法：

| | v1 | v2 |
| --- | --- | --- |
| 容器层 | 卡片 / 双栏 / 指令框 / 输入框 / 吸底各有底色+描边+阴影 | 全部归零，整页只剩「一层纸 + 一处玻璃 + 双栏间一条竖线 + 吸底一条淡线 + 一个按钮」 |
| 文字 | 只换了颜色 | 模型全称→`2B/9B/35B`、导航→`文本/图片`、说明语/示例/状态/计数/页脚/空态全删 |
| 玻璃 | 无 | 只用在译文卡片一处，vendor 开源成品 |

对照稿：`output/theme-preview-v2.html`、`output/theme-preview-v2.png`（左现状 / 右 v2）。

## 用了哪些开源成品（不自己写效果）

| 需求 | 仓库 | Star | 许可 | 用法 |
| --- | --- | --- | --- | --- |
| 液态玻璃 | `lucasromerodb/liquid-glass-effect-macos` | **826** | ⚠️ 仓库无 LICENSE 文件（GitHub API `license=null`） | vendor 它的 SVG `feTurbulence` + `feDisplacementMap` 折射滤镜与 `.liquidGlass-*` 四层结构，原样保留，只把 tint/shine 染成薄樱色 |
| 字体 | `lxgw/LxgwWenKai` 霞鹜文楷 | **~27k** | OFL-1.1 | 可选，圆润手写感最强；CDN 成品 `callmebill/lxgw-wenkai-web`。默认不引外链，需本地 woff2 |
| 动效 | `animate.css` | **~80k** | MIT | 只取一个 `fadeInUp` keyframe（译文出现时 280ms），不引整库 |
| 背景漂移 | 同上玻璃仓库的 `@keyframes moveBackground` | 826 | 同上 | 60s linear infinite，幅度压到 2%，只在余光里动 |

玻璃仓库地址：<https://github.com/lucasromerodb/liquid-glass-effect-macos>
滤镜源码在它的 `index.html` 末尾 `<filter id="glass-distortion">`，CSS 在 `styles.css`。
本项目里对应 `app/custom.js` 的 `GLASS_SVG` 与 `app/theme-sakura.css` 第 8 节。

⚠️ **授权提醒**：玻璃仓库没有 LICENSE 文件，仅作个人/内部使用问题不大；若要分发产出物，
建议先向作者确认，或换成有明确 MIT 的玻璃组件（如 `shuding/liquid-glass` 一类）。
霞鹜文楷是 OFL-1.1、animate.css 是 MIT，可放心用。

## 四个开关

主题已**正式启用**（2026-11-13 构建出三端产物）。三层令牌集中在
`app/theme-sakura.css:24` 的 `:root`，改一处即可整页换色。下表是各端开关现状。

| 端 | 开关（v2 时期） | 位置 |
| --- | --- | --- |
| Windows | `THEME=` 与 `[ -n ... ]` 两行**已启用** | `app/rebuild.sh` |
| Android 网页层 | `syncPromoCss` 自动同步 `theme_sakura.css` 到 res/raw | `android/app/build.gradle` |
| Android 原生层 | `THEME_ENABLED=true`（同时切顶栏/底 Tab/进度条配色） | `MainActivity.java` |
| 液态玻璃（v2：仅译文 pane 一处） | `THEME_GLASS` | `app/custom.js` 末尾注入器 |
| 译文淡入 | `THEME_FADE` | 同上 |

**v3 已接管上述开关**：`app/rebuild.sh` 的 `THEME` 指向 `theme-liquid-glass.css`，
`MainActivity.java` 用 `THEME_MODE = 2`（`0` 官网 / `1` v2 / `2` v3）。
`custom.js` 的新注入器靠 `--lg-tint-1` 判断主题，旧注入器只保留译文淡入。
| 字体 | 取消 `theme-sakura.css` 末尾 A 段 `@font-face` 注释 + 放 woff2 到 `app/fonts/` | `app/theme-sakura.css` |
| 透明度 | 第 11 节 `.atcard/.card/...{opacity:.985}`，或 `.atnav`/`.row3 .btns` 的 `blur(14px)` | 同上 |

回退：注释掉 `THEME=` 两行 / `THEME_ENABLED` 改 `false`，现有外观完全不变。
`THEME_GLASS=false` 时 `custom.js` 不注入任何 DOM 与 SVG，CSS 里的玻璃段落空转。

## 构建产物

### 历史：v3 液态玻璃（2026-11-14 14:30–14:33）

| 产物 | 大小 (B) | 备注 |
| --- | --- | --- |
| `output/笺.exe` | 9,395,200 | Pake 3.18 / Tauri 2，注入 `hide-promo.css + custom.js + theme-liquid-glass.css`；exe 内可检索到 `--lg-tint-1` 与 `flex: 0 0 auto` |
| `output/笺.msi` | 4,251,648 | zh-CN x64 安装包 |
| `output/笺.apk` | 3,524,715 | Gradle `assembleRelease`；AAPT 把 raw 重命名成 `res/_q.css`（v3 主题）/ `res/Dg.css`（hide-promo）/ `res/fw.js`（custom.js）/ `res/iz.css`（v2 回退），主题内含无底板与紧凑按钮规则 |

### 历史：v2 薄樱（2026-11-13）

| 产物 | 大小 (B) |
| --- | --- |
| `output/笺.exe` | 9,377,792 |
| `output/笺.msi` | 4,247,552 |
| `output/笺.apk` | 3,515,991 |

桌面端 `setup.rs` 也已同步：`apply_caption_theme` 的 DWM 三色改为薄樱令牌，
`POPUP_BOOTSTRAP` 悬浮窗改为纸面 + 发丝边 + 20px 圆角 + `blur(14px)`，
按钮 hover 用薄樱渐变。划词悬浮窗是独立 HTML，不走网页注入，必须单独改。

### 本机构建环境注意事项（可复现）

- 全局 `pake-cli` 在 `C:\Users\jiuxi\AppData\Roaming\npm`，沙箱**不允许写**，
  且 `desktop/patch_apply.py` 默认就往那里打补丁。本机做法是复制一份到
  `F:\xm\translator\.build\npm-global\node_modules\pake-cli`，用
  `npm_config_prefix=F:\xm\translator\.build\npm-global` 让 `npm root -g` 指向它，
  再跑 `python desktop/patch_apply.py`，最后 `node <工作区>/pake-cli/dist/cli.js ...`。
  `.build/` 只是构建缓存，不属于交付源码。
- pake 用 `execaSync('rustc')` 检测 Rust；沙箱内 `spawnSync` 会 EPERM，
  需要提权运行（或由用户在普通终端里直接跑 `app/rebuild.sh`）。
- Gradle 用 `GRADLE_USER_HOME=F:\xm\translator\.build\gradle-home` 避开
  `C:\Users\jiuxi\.gradle` 的写入限制；`C:\Users\jiuxi\.android` 的 lint 写入告警可忽略。
- 重新构建前若旧 `笺.exe` 正在运行，pake 覆盖会 EPERM；先停掉进程再复制新产物。

## 动画 / 透明度 / 字体 具体做了什么

- **动画**：① 背景 60s 极慢漂移（成品自带）；② 按钮/控件 180ms 过渡；
  ③ 译文出现 280ms `fadeInUp`（单条 keyframe，不是整库）；④ 玻璃 hover 沿用原仓库
  `0.4s cubic-bezier(.175,.885,.32,2.2)` 的轻微膨胀。全部尊重 `prefers-reduced-motion`。
- **顶部装饰再减一层**（用户反馈）：删掉标题栏品牌圆点 `.it-tb-dot`、导航
  `border-bottom` 横线、活跃项 `::after` 小圆点；导航与 `2B` 之间改为纯留白，
  活跃态只靠字重与颜色区分。双栏之间的竖淡线保留（它是结构分隔，不是装饰）。
- **透明度**：所有容器背景归零，靠 `rgba(255,255,255,.34)` 的玻璃 tint +
  `backdrop-filter: blur(3px)` 分层，不再用白板。吸底条 `rgba(248,246,250,.86)` +
  `blur(14px)`，标题栏同理。次级文字 `#9692A4`、占位 `#C4C0CE`，两级递减。
- **字体**：正文保持系统中文字体（可读性 + 离线）；只有品牌「笺」、导航、空态印章
  可切霞鹜文楷。想全局启用就改 A 段选择器，但**不建议整页换手写体**。

## 约束与坑

- 官网实时远程加载，样式必须靠注入覆盖；任何本地复刻都会失去自动同步。
- `.atcard` 的 `backdrop-filter` 必须保持 `none`，否则 `.row3 .btns` 的
  `position: fixed` 会相对卡片定位、吸底失效。玻璃只加在译文 pane（不是 `.atcard`），
  因此不冲突。
- `custom.js` 的注入器用 `--sk-accent` 是否存在判断主题是否启用，主题没开时零开销。
- 玻璃三层必须 `pointer-events:none`，且官网译文 `textarea/.output` 要抬到 `z-index:3`，
  否则选不中、复制不了。
- 安卓注入样式是构建期拼进 HTML 的 `<style>`，`theme_sakura.css` 必须排在
  `hide_promo.css` 之后；桌面 `--inject` 列表顺序同理不能反。
- 自定义背景图模式下 `custom.js` 的 `rules()` 会写 `#it-bg-style`；玻璃的折射效果
  在照片上会比纯色底更明显，属于预期。

---

## v3：旧注入主题中的液态玻璃统一（2026-11-14，历史记录）

### 定稿决策

| 项 | 结论 |
| --- | --- |
| 配色基调 | **保留薄樱粉 tint**，只把材质从纸面换成玻璃，品牌辨识度不丢 |
| 覆盖范围 | **全量**：网页注入层 + Windows 壳（自绘标题栏 / 设置 / 浮标 / 划词悬浮窗 / DWM）+ Android 原生壳（顶栏 / 底 Tab / 加载 / 错误 / 溢出菜单 / 相机页 / 闪屏） |
| 暗色模式 | 本期**只做浅色**；`:root` 预留了 `--lg-dark-*` 扩展位，下一轮覆盖同名令牌即可 |
| 文案策略 | 沿用 v2 的精简，**一条都不加回来**；活跃态仍只靠字重与颜色区分 |

### 单一真源与文件清单

`app/theme-liquid-glass.css` 的 `:root` 是三端唯一的 `--lg-*` 令牌定义处；组件里不再
另写 rgba。预览页 `output/liquid-glass-preview.html` 直接 link 这份 CSS；由于静态预览
服务不解析 `../app/` 相对路径，页内另附一份**同值内联副本**兜底（本地用 `file://`
打开时由 `<link>` 加载真源，两份一致，不改变层叠结果）。

| 文件 | 作用 |
| --- | --- |
| `app/theme-liquid-glass.css` | **新建**：34 个 `--lg-*` 令牌、`.lg-*` 通用组件、官网 DOM 覆盖、降级规则 |
| `app/custom.js` | 新增 `__itLiquidGlassSystem()` 注入器与自研 SVG 折射滤镜；旧注入器改为只管译文淡入；`rules()` 自定义背景改用玻璃 tint |
| `app/hide-promo.css` | 硬编码白底 / 官网粉改成 `var(--lg-*, fallback)`，回退时原式生效 |
| `app/rebuild.sh` | `THEME` 指向 v3，注入顺序保持 `hide-promo.css → custom.js → 主题` |
| `desktop/patch/setup.rs` | `POPUP_BOOTSTRAP` 的 `#card` 内联同一套令牌（悬浮窗是独立 HTML，必须单独改）；`apply_caption_theme` 的 DWM 三色对齐 |
| `android/.../MainActivity.java` | `THEME_MODE` 三态、`glass()` / `ambient()` 工具、顶栏 / 悬浮胶囊底 Tab / 遮罩 / 菜单玻璃化；`backgroundRules()` 与网页侧同步 |
| `android/.../CameraActivity.java` | 圆形按钮与操作按钮改浅玻璃 + 深色图标 |
| `android/.../colors.xml` / `themes.xml` / `splash_bg.xml` | 颜色、闪屏渐变对齐令牌；新增 `glass_*` 色 |
| `android/app/build.gradle` | `syncPromoCss` 增加 `theme_liquid_glass.css` 同步 |
| `android/app/src/main/res/raw/theme_liquid_glass.css` | 构建期同步产物，已放一份初始副本保证 `R.raw` 可解析 |

### 材质三档

| 档 | 令牌 | 不透明度 | 用在哪 |
| --- | --- | --- | --- |
| subtle | `--lg-tint-0` | .20 | 大卡片 / 组容器 |
| regular | `--lg-tint-1` | .38 | 双栏面板 / 药丸 / 输入框 |
| strong | `--lg-tint-2` | .66 | 标题栏 / 吸底胶囊 / 设置 / 悬浮窗 |

统一叠加 `--lg-shine`（镜面内高光）、`--lg-edge`（白色发丝边）、`--lg-shadow*`
（悬浮阴影）、`--lg-r-*`（连续曲率圆角近似）。

**吸底区没有底板**（用户反馈「按钮太大 / 底下的白板也不要」后的定稿）：
`.row3 .btns` 只是定位容器，`background / border / box-shadow / backdrop-filter / padding`
全部归零；两个按钮不再 `flex:1` 撑满，按内容宽度收成紧凑玻璃胶囊并居中，靠按钮
自身的镜面高光与阴影浮起。桌面 `padding: 7px 18px / 12.5px`，窄屏 `6px 14px / 12px`；
正文底部留白同步收到 72px / 68px。`.no-lg-blur` 降级时只给按钮加不透明底，
不给容器补回白板。BEFORE 对照页仍保留 v2 的白板以体现差异。

**三端能力差异（不假装能模糊）**：网页层用 `backdrop-filter: blur() saturate()` +
tint + 高光，折射只给译文 pane；Windows 划词悬浮窗走 WebView2，同样完整；Android
原生 View（minSdk 24）与 DWM 标题栏没有 `backdrop-filter`，用 `GradientDrawable`
半透明 tint + 白色镜面边 + 曲率 + elevation 模拟，只保证视觉语义一致。

### 折射与授权

v2 vendor 的 `lucasromerodb/liquid-glass-effect-macos` **无 LICENSE**。v3 已把它
整体替换为本项目自研的等价滤镜（`feTurbulence → feGaussianBlur → feDisplacementMap
→ feDistantLight 高光 → feComposite`），在 `custom.js` 的 `LG_SVG` 与预览页各一份，
分发不再有授权风险。`theme-sakura.css` 与 v2 注入器保留作回退，不再默认加载。

### 降级 / 可访问性

- `CSS.supports('backdrop-filter')` 失败 → 给 `<html>` 加 `.no-lg-blur`，关掉折射与
  模糊，只留 tint + 镜面高光，不会出现空白玻璃。
- `LG_REFRACTION = false` 或 `prefers-reduced-motion: reduce` → 不装 SVG 与三层，
  纯 CSS 玻璃兜底；背景漂移与所有过渡同步关闭。
- 玻璃三层 `pointer-events: none`，官网 `textarea/.output` 与 pane 子元素抬到
  `z-index: 3`（`.lg-content`），译文仍可选中复制。
- 对比度（对白底实测）：正文 `--lg-ink` **13.96:1**、次级 `--lg-ink-sub` **5.32:1**，
  均过 4.5:1；`--lg-ink-faint` 2.66:1 只用于占位符 / 脚注等不承载信息的装饰文字。
- `.atcard` 的 `backdrop-filter` 仍强制 `none`，避免 `.row3 .btns` 的 `fixed` 失效。

### 一键回退

| 目标 | 改动 |
| --- | --- |
| 回到 v2 薄樱 | `app/rebuild.sh` 的 `THEME` 改回 `theme-sakura.css`；`MainActivity.java` 的 `THEME_MODE` 改 `1` |
| 回到官网原样 | 注释 `rebuild.sh` 的 `THEME=` 两行；`THEME_MODE` 改 `0` |

`hide-promo.css` 里所有新变量都带旧值 fallback，回退后外观与原本一致。

### 校验结果（2026-11-14）

`node --check` 两个 JS 均通过；CSS 括号 103/103、令牌引用 0 处未定义；Java 两个文件
括号平衡；Rust raw string 终止符计数 1（未被 `"#` 提前闭合）；注入顺序、raw 资源与
源文件一致性 17 项全部 PASS。

### 重新打包（2026-11-14 已执行成功，命令可复用）

```bash
# 1) Windows：先结束正在运行的旧「笺.exe」，否则覆盖会 EPERM
cd /f/xm/translator
npm_config_prefix=F:/xm/translator/.build/npm-global bash app/rebuild.sh

# 2) Android：-g 指定 gradle 缓存目录，preBuild 会自动同步 app/ 下的 CSS/JS
cd /f/xm/translator/android
bash ./gradlew -g F:/xm/translator/.build/gradle-home assembleRelease --console=plain
cp app/build/outputs/apk/release/app-release.apk ../output/笺.apk
```

`npm_config_prefix=` 是单条命令的进程级临时值，只让 `patch_apply.py` 里的
`npm root -g` 指到本机可写的 `.build/npm-global`；`rebuild.sh` 会自动优先用该目录下的
`pake-cli/dist/cli.js`（已打补丁），副本不存在时才回退 PATH 里的 `pake`。
Gradle 用 `-g` 而不是 `GRADLE_USER_HOME`，全程不写任何持久化环境变量、不装工具链。

本次实测：Windows 2m37s（rustc 检测未触发 EPERM）；Android 首次因 XML 注释里的
`--lg-*` 双横线失败，修掉后 1m03s 成功。**XML 注释内不允许出现 `--`**，
写令牌名时改用「lg 系列」这类措辞；改完可用 `xml.etree.ElementTree` 全量扫一遍
`res/**/*.xml` 再构建。

---

# v2 架构：自绘 UI + 官方公开 API（2026-11-14）

## 为什么换

v1 的做法是「加载官网 `translate.html` + 注入 CSS 去推广 + 覆盖主题」。这条链路有两个
问题：一是**未获授权修改官方页面**（《哔哩哔哩弹幕网用户使用协议》8.2 修改服务材料、
8.4 不得掩盖推广），二是官网 DOM 一改版，所有选择器就失效。

官方其实开了一条明路：`bilibili/Index-Translate` 以 Apache-2.0 开源，并提供 OpenAI
兼容的免费公网 API（`https://index-translate.bilibili.com/v1`）。维护者在 issue #28
明确回复「第三方接入符合预期使用范围，暂不需要申请或登记，也没有特定的署名要求」。

所以 v2 把界面自己画，请求直连接口。**这才是官方欢迎的接入方式。**

## 三端结构

```
web/                 ← 唯一前端真源，三端共用
  index.html         自绘 UI（标题栏 / 三 Tab / 双栏卡片 / 吸底按钮）
  theme.css          液态玻璃令牌与组件（--lg-* 与旧主题同源）
  app.js             /v1 客户端、prompt 构建、三个功能页
  langs.js           154 个语种表（来自官网 /site/langs.js）

Windows：pake 以「本地目录」方式打包 web/（入口 index.html，url_type=local）
Android：build.gradle 的 syncWebAssets 把 web/ 同步进 assets/，WebView 加载
         file:///android_asset/index.html，原生只负责相机与系统栏
```

## 接口与 prompt

| 功能 | 端点 | model |
|---|---|---|
| 文本 / 图片 | `/v1/chat/completions` | `index-mt-2b` / `-9b` / `-35b` |
| 音节控制 | `/v1/chat/completions` | `index-mt-2b-syllable` / `-9b-syllable` |
| 长文本 | `/v1/chat/completions`（前端分块） | `index-nailong-2b` / `-9b` |

请求固定带 `temperature: 0`、`max_tokens: max(1024, len*3)`、
`chat_template_kwargs: {enable_thinking: false}`。最后一项不能省，否则模型输出思维链。

prompt 逐字移植官网：`buildInstructionPrompt()`（指令模式，含术语干预 `A→B`、
`【源文】/【约束要求】` 结构与 JSON 格式保护）、`buildImagePrompt()`、
音节模板「译文严格控制在 N 个音节」。普通翻译官网走私有 `/translate_stream`，
服务端模板不可见，这里用等价的单行指令，实测 token 量与输出一致。

## 关键取舍

- **语音翻译已移除**。Index-Echo 只有私有 `/api/echo`，没有公开通道，所以不放进来。
- **包名换成 `ink.jian.translate`**（原 `com.bilibili.indextranslate` 把 bilibili 商标
  当自己的应用标识，上架必被拒）。代价：Android 需卸载重装，Windows 旧设置文件
  （`%APPDATA%/com.bilibili.index-translate/`）不再读取。
- **官方模板比自己拼 prompt 多约 7 个 token**，`/v1` 在 2B 下实测更快：
  短句 186ms vs 242ms、长段 578ms vs 619ms（配对采样，见当日记忆）。
- 悬浮窗（`desktop/patch/setup.rs` 的 `POPUP_BOOTSTRAP`）同步改为直连 `/v1`。
- `is_translate_app()` 的判断加入 `index.html` 本地入口，否则托盘增强与划词热键
  会被整体跳过。

## 构建

与 v1 相同，只是 `rebuild.sh` 的 url 参数换成了 `web/` 目录、去掉了 `--inject`：

```bash
cd /f/xm/translator
npm_config_prefix=F:/xm/translator/.build/npm-global bash app/rebuild.sh

cd /f/xm/translator/android
bash ./gradlew -g F:/xm/translator/.build/gradle-home assembleRelease --console=plain
cp app/build/outputs/apk/release/app-release.apk ../output/笺.apk
```

本次实测：Windows 2m04s 编译 + 打包，产物 `笺.exe` 9.33MB / `笺.msi` 4.05MB
（版本 2.0.0）；Android 1m04s，`ink.jian.translate` v2.0.0，assets 内含 4 个前端文件。

**构建前务必关掉运行中的 `笺.exe`**，否则 pake 收尾的 safe-delete 会失败
（编译其实已经成功，只是产物没能复制到 output/，重跑一次即可）。

## 旧文件状态

`app/hide-promo.css`、`app/custom.js`、`app/theme-sakura.css`、`app/theme-liquid-glass.css`
当时桌面入口已不再使用这些注入文件，但 Android `res/raw/` 仍被资源打包；先前
“已不参与任何构建”的判断不准确。v13 已将这些旧资源移至回收站并从源码移除。
