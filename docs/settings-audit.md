# 设置项关系简报

2026-11-16 资源审计：当前界面不再加载旧注入主题；此前 Android 仍将 `res/raw/` 中的旧
脚本和样式打包，这四项资源及 `app/` 中对应旧文件现已移至回收站并从源码移除。
`syncWebAssets` 改为覆盖共用前端资源的 Gradle Copy 任务，不再删除 assets 目录。
新增更新模块后共六项资源。

复审日期：2026-11-18。依据当前 `web/app.js`、`web/theme.css`、`web/liquid-glass.js` 与
`desktop/patch/setup.rs`，审查网页、Android、Windows 与 macOS 的偏好归一化及消费路径。
这是代码关系审查；SVG `backdrop-filter` 的最终效果仍需在目标 Android WebView 和 Windows WebView2
中验收，不能以 CSS 支持查询或离线浏览器模拟替代实机结果。

## 当前分组与配置

| 分组 | 保存字段 | 生效范围与关系 |
| --- | --- | --- |
| 外观 | `appearance.mode/palette/radius` | 明暗、配色和卡片圆角作用于共用界面及桌面悬浮窗；桌面窗口外圆角是独立原生设置，不由此项改变。 |
| 液态玻璃 | `liquidGlass.{card,pill,button}` | 面板只消费 card.backgroundOpacity 绘制静态磨砂；Tab/模型/设置导航滑块用 pill，按钮/透明 Tab 轨道/下拉入口用 button；各组互不改写。 |
| 背景 | `background.data/opacity/blur/fit` | 主窗口壁纸图片及其淡化、背景模糊、填充方式。PC 浮窗可用 `popup.backgroundData` 选择独立图片；为空时跟随主壁纸。两处图片继续沿用这组壁纸参数。 |
| 阅读与布局 | `appearance.font/systemFontFamily/fontScale/fontWeight/fontColorMode/fontColor/layout` | 正文排版；系统字体仅 PC。`layout` 调整主界面内容间距。 |
| 动效 | `appearance.motion/ambientLight` | 界面动画和环境柔光，与液态玻璃光学参数互相独立。 |
| 翻译偏好 | `translation.defaultTab/sourceLanguage/targetLanguage/defaultModels.{text,syllable,doc}/rememberLanguages/rememberModels` | 配置下次启动默认页面、语言和各页模型；已启用的记忆项可覆盖相应默认值。 |
| 更新 | `updates.autoCheck` | 默认启用；修改后即时应用并自动保存，启动自动检查每 24 小时最多一次。手动检查独立于开关；只比较正式发布并链接到仓库发布页。 |
| 电脑功能 | `selection_shortcut/activation_shortcut/open_main_window/target_lang/start_to_tray`；`popup.backgroundData` | Windows/macOS 原生快捷键、划词结果显示、启动到托盘、浮窗目标语言和独立背景。首次启动默认显示主窗口且不开机自启；两项都可由用户打开。Windows 自启动是独立系统状态，不进入普通偏好快照；macOS 登录项仍由桌面设置保存。 |

偏好版本为 `3`。`appearance.material`、`appearance.glassStrength`、`appearance.cardReveal` 与
`popup.cardReveal` 不再参与归一化或渲染；旧配置中的这些键会被丢弃，液态玻璃使用新默认参数，
字体、主题、壁纸、翻译偏好等无关字段继续保留。版本 2 的扁平玻璃对象也会替换为新的三组默认值。
没有把旧“强度/透出”值重解释成新的光学参数。

## 液态玻璃参数

| 参数 | 范围与默认值 | 作用 |
| --- | --- | --- |
| `specularOpacity` | 0–100%；pill/button 50 | 交互玻璃镜面层透明度；card 历史值保留但不应用。 |
| `specularSaturation` | 0–50；pill 6、button 9 | 交互玻璃采用 SVG 饱和度倍率，1 为中性。 |
| `refractionLevel` | 0–100%；pill/button 100 | 模型与设置分类滑块固定使用 0.9 倍系数；透明 Tab 滑块固定为 0.4 倍。按压不改变材质。 |
| `blurLevel` | 0–40 px；pill 0.2 | 当前设置只对 pill 提供。 |
| `progressiveBlurStrength` | 历史 card 0–10；默认 1 | 仅保留旧配置及引擎 API 兼容，实际内容面板无三层模糊。 |
| `backgroundOpacity` | 0–100%；card 60 | 静态磨砂不透明度；button 底色固定透明，移动导航滑块也保持透明。 |

设置按调整对象只显示 1、4 或 3 个有效控件；不再向面板显示无作用的折射、高光和模糊参数。
`liquidGlass.card` 六个历史值仍归一化并保存，不丢弃既有偏好。
不再公开轮廓、边缘宽度、厚度和折射率。
这些内部几何保持参考比例，按元素尺寸重新生成，不与用户滑条形成第二套强度控制。
模型与设置分类滑块底色不透明度固定为 0.1，首次显示、按压和拖动结束后保持一致；
Tab 滑块使用透明材质，保留原有静止外观。该材质选择由组件决定，不增加保存字段或设置开关。
主界面与桌面浮窗共享对应预设，不能单独为浮窗保存另一套玻璃强度或透明度。
`background.opacity/blur` 只处理壁纸图像，`liquidGlass.card.backgroundOpacity`
处理面板静态色层与纹理，作用层不同；按钮不继承面板的不透明度。

## 父子关系与覆盖

- `appearance.fontColorMode=theme` 时正文色跟随主题并禁用自定义颜色控件，已保存的 `fontColor` 保留；切到 `custom` 后该色覆盖主题正文色。
- PC 的 `systemFontFamily` 非空时优先使用系统字体，通用字体类别提供回退；网页和 Android 不应用该 PC 字体字段。
- `popup.backgroundData` 非空时替换浮窗的背景图片；清空后浮窗继续跟随 `background.data`。主背景图片未选择时，浮窗独立图片仍可使用共享壁纸淡化、模糊和填充值。
- `rememberLanguages` 和 `rememberModels` 分别使最近一次有效语言或模型覆盖对应默认项；`defaultTab=last` 单独决定页面恢复行为。
- `open_main_window` 决定划词结果出现位置。浮窗路径使用 `target_lang` 并固定调用轻量模型；主窗口路径沿用主界面的语言与文本模型，因此两类语言/模型选项并非重复。
- Windows 自启动使用共用的 HKCU Run 值。界面显示系统中登记的完整目标路径；只有明确执行“设为当前版本”才写入当前 exe，任一版本关闭开关都会删除全局启动项。普通设置保存、默认值恢复及旧设置缓存都不改变注册表。多版本切换需退出现有实例后再启动目标版本。
- `auto_start` 与 `start_to_tray` 的新安装默认均为关闭；安装包不会注入 `--start-to-tray`。已有设置文件中的显式 `true` 仍优先于默认值。
- macOS 的 `auto_start` 仍由登录项服务处理；Windows 不再把旧 `desktop-settings.json` 中的 `auto_start` 当成系统状态。
- 快捷键冲突由原生注册失败返回并尝试回滚，不应静默保存为成功。
- `updates.autoCheck` 不改变操作系统启动项；关闭自动检查后，手动检查仍可用。检查结果与频率时间戳不属于外观草稿，检查失败不声称“已是最新版本”。更新分组重置只恢复此开关。

## 即时应用、持久化与重置

- 不再提供“取消”“保存”按钮。外观、玻璃、壁纸、翻译、更新和电脑功能修改后自动保存；关闭按钮、Esc、系统返回和点击遮罩会保留更改，并立即提交尚未写入的值。
- 范围与颜色控件同步更新读数，每帧最多执行一次预览，持续输入在空闲 200ms 后合并持久化；`change`、关闭和离散选择立即提交。关闭后过期帧不能重新应用旧值。
- 桌面原生写入串行进行；保存期间仍可编辑、切换类别、关闭和重开。旧写入完成不能覆盖较新状态；若用户改动后又回到正在保存的同一快照，仍更新本地缓存，不重复提交相同原生快照。
- 保存失败时当前外观继续生效，未持久化状态保留并显示“重试保存”；后续修改或重试提交最新值，不无限自动重试，不声称保存成功。原生快捷键校验、注册和回滚错误继续显示；异步返回不打断正在进行的快捷键录制。
- 浮窗图片设置立即更新内嵌预览，并随自动保存同步真实 Windows 悬浮窗。玻璃配置作为同一份顶层对象同时传给主窗口与悬浮窗。网页与 Android 使用本地偏好，Android 同步提交原生色板缓存。
- “恢复本组默认”即时应用并自动保存；液态玻璃页仅重置当前调整对象，外观页仅重置主题、配色和卡片圆角，不影响其它组。
- 桌面首开先载入原生配置与系统字体，再按最终布局准备玻璃并打开窗口。准备期间返回可取消；较晚的配置、字体和光学回调不能重新打开已取消窗口或抢走焦点。
- Windows 自启动的状态读取只申请注册表查询权限；键缺失表示关闭，权限和读取错误显示为未知。无效或已移动的目标保持“已启用”并可修复，不会误报为关闭。注册表操作使用专用串行原生命令。
- 桌面设置面板关闭动画结束后保留透明终态并立即隐藏遮罩；关闭过程中重开会使旧完成回调失效，减少动态效果时也直接应用正确的隐藏状态。
- 液态玻璃引擎只为交互组件生成 SVG displacement、specular 与 Gaussian primitives。若运行时不支持该特性，交互玻璃明确标记 unsupported 并报告错误；面板静态磨砂独立绘制，不依赖滤镜支持情况。
- 底部 Tab 轨道与右侧齿轮共用透明按钮预设，齿轮无可见文字但保留可访问名称；语言列表打开、刷新及选择后不主动聚焦搜索框，搜索只在用户主动进入时唤起输入法。

设置根节点、遮罩根节点与分类容器保持 `opacity:1`，避免在动画期间截断子按钮的背景采样。
遮罩的暗化单独绘制，文字、磨砂填充和可绘制光学层按原动画进度淡入；位移、缩放和玻璃参数保留。
数值自定义属性不能注册的运行时采用同进度逐帧回退。贴图就绪和动画中的真实折射分别验证，
不能只用 PNG 已解码或最终帧截图推断整段动画已连贯。

原文图片使用固定高度的小附件缩略图，不再按原图纵横比占满输入区；文字仍可编辑、选择和复制。
Android 输入法使用覆盖模式，WebView 只保留系统栏与刘海安全区；键盘高度和可见性不改变页面尺寸，
网页也不因输入焦点隐藏底栏或重排卡片。

本审计移除了旧注入资源、扁平玻璃键、伪彩色高光与滑块轨道的重复折射；修复设置下拉的
hover/open 样式覆盖按钮预设的问题。未发现需要保留的新旧参数映射。定向浏览器检查覆盖
当前预设、控件数量、按住状态、滤镜尺寸和 macOS 桥接；最终全量结果见桌面集成文档。
当前渲染链中 SVG 只处理交互控件的折射与高光，产品卡片不叠加三层渐进模糊；
底层旧 card API 的单独兼容测试仍保留。轮盘收尾跟随本次合成动画，旧取消不能提交新选择。
历史任务最终全量为 127/128，后续定向动画检查通过；不再将早先的 128/128 混写为最终结果。
本轮新增 `verify-settings-compositor`、`verify-attachment-layout` 与 `verify-android-ime`，
实时保存、故障重试和过期回调由 `verify-settings-preview` 与更新后的设置交互场景覆盖。
本轮最终全量在完成文档、资源和构建后仅执行一次，日志为
`.build/ui-polish-final-verification.log`，退出状态清单为 `.build/ui-polish-final-results.json`。
仍需目标 Windows、Mac 和 Android 设备的原生渲染、缩放与性能验收。
