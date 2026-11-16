# 设置项关系简报

审查日期：2026-11-16。依据当前 `web/app.js`、`web/theme.css`、`web/liquid-glass.js` 与
`desktop/patch/setup.rs`，审查网页、Android 与 Windows 的偏好归一化及消费路径。
这是代码关系审查；SVG `backdrop-filter` 的最终效果仍需在目标 Android WebView 和 Windows WebView2
中验收，不能以 CSS 支持查询或离线浏览器模拟替代实机结果。

## 当前分组与配置

| 分组 | 保存字段 | 生效范围与关系 |
| --- | --- | --- |
| 外观 | `appearance.mode/palette/radius` | 明暗、配色和圆角作用于共用界面及 Windows 悬浮窗。 |
| 液态玻璃 | `liquidGlass.surfaceProfile/bezelWidth/glassThickness/refractiveIndex/refractionLevel/specularOpacity/specularSaturation/blurLevel/progressiveBlurStrength/backgroundOpacity` | 一组参数统一作用于主界面、设置内预览、玻璃控件和 Windows 悬浮窗；Android 与网页使用同一配置。 |
| 背景 | `background.data/opacity/blur/fit` | 主窗口壁纸图片及其淡化、背景模糊、填充方式。PC 浮窗可用 `popup.backgroundData` 选择独立图片；为空时跟随主壁纸。两处图片继续沿用这组壁纸参数。 |
| 阅读与布局 | `appearance.font/systemFontFamily/fontScale/fontWeight/fontColorMode/fontColor/layout` | 正文排版；系统字体仅 PC。`layout` 调整主界面内容间距。 |
| 动效 | `appearance.motion/ambientLight` | 界面动画和环境柔光，与液态玻璃光学参数互相独立。 |
| 翻译偏好 | `translation.defaultTab/sourceLanguage/targetLanguage/defaultModels.{text,syllable,doc}/rememberLanguages/rememberModels` | 配置下次启动默认页面、语言和各页模型；已启用的记忆项可覆盖相应默认值。 |
| 电脑功能 | `selection_shortcut/activation_shortcut/open_main_window/target_lang/auto_start/start_to_tray`；`popup.backgroundData` | Windows 专属快捷键、划词结果显示、启动选项、浮窗目标语言和独立背景。液态玻璃参数仍保存在共用的顶层 `liquidGlass`，不是浮窗专属副本。 |

偏好版本为 `2`。`appearance.material`、`appearance.glassStrength`、`appearance.cardReveal` 与
`popup.cardReveal` 不再参与归一化或渲染；旧配置中的这些键会被丢弃，液态玻璃使用新默认参数，
字体、主题、壁纸、翻译偏好等无关字段继续保留。没有把旧“强度/透出”值重解释成新的光学参数。

## 液态玻璃参数

| 参数 | 范围与默认值 | 作用 |
| --- | --- | --- |
| `surfaceProfile` | `convex-circle`、`convex-squircle`、`concave`、`lip`；默认 `convex-squircle` | 选择边缘表面高度曲线，改变 Snell 折射法线。 |
| `bezelWidth` | 4–32 CSS px；默认 12 | 边缘折射区域宽度。 |
| `glassThickness` | 1–40；默认 14 | 表面法线计算及光线穿透厚度。 |
| `refractiveIndex` | 1.0–2.5，步进 0.1；默认 1.5 | 折射率为 1 时位移为零；更高值改变背景偏移。 |
| `refractionLevel` | 0–200%；默认 100% | 缩放位移图的实际折射量。 |
| `specularOpacity` | 0–100%；默认 45% | 调节镜面高光透明度；0% 关闭高光层。 |
| `specularSaturation` | 1–10；默认 6 | 控制高光颜色饱和度。 |
| `blurLevel` | 0–100%；默认 60% | 控制基础高斯模糊量。 |
| `progressiveBlurStrength` | 0–100%；默认 50% | 控制平面内部由位移遮罩混合的渐进模糊。 |
| `backgroundOpacity` | 0–100%；默认 60% | 控制玻璃着色层不透明度，不改变壁纸自身淡化设置。 |

主界面与 Windows 浮窗使用同一套值，不能单独为浮窗设置另一份玻璃强度或透明度。
壁纸设置中的 `background.opacity` 淡化的是图片；`liquidGlass.backgroundOpacity` 淡化的是玻璃着色层，
两者作用层不同。`background.blur` 模糊壁纸图像，`liquidGlass.blurLevel` 与
`progressiveBlurStrength` 模糊玻璃取样，调整其中一项不会改写另一项。

## 父子关系与覆盖

- `appearance.fontColorMode=theme` 时正文色跟随主题并禁用自定义颜色控件，已保存的 `fontColor` 保留；切到 `custom` 后该色覆盖主题正文色。
- PC 的 `systemFontFamily` 非空时优先使用系统字体，通用字体类别提供回退；网页和 Android 不应用该 PC 字体字段。
- `popup.backgroundData` 非空时替换浮窗的背景图片；清空后浮窗继续跟随 `background.data`。主背景图片未选择时，浮窗独立图片仍可使用共享壁纸淡化、模糊和填充值。
- `rememberLanguages` 和 `rememberModels` 分别使最近一次有效语言或模型覆盖对应默认项；`defaultTab=last` 单独决定页面恢复行为。
- `open_main_window` 决定划词结果出现位置。浮窗路径使用 `target_lang` 并固定调用轻量模型；主窗口路径沿用主界面的语言与文本模型，因此两类语言/模型选项并非重复。
- `auto_start` 与 `start_to_tray` 独立；快捷键冲突由原生注册失败返回并尝试回滚，不应静默保存为成功。

## 保存与重置

- 外观和液态玻璃草稿实时预览；取消、Esc 或系统返回会恢复已提交配置。液态玻璃页的“恢复本组默认”只重置顶层 `liquidGlass`，外观页重置主题、配色和圆角，不影响阅读、动效或壁纸设置。
- 浮窗图片设置在内嵌预览中更新；确认保存成功后才同步真实 Windows 悬浮窗。玻璃配置作为同一份顶层对象同时传给主窗口与悬浮窗。
- Windows 先持久化原生设置再提交前端状态；失败时保留草稿。网页与 Android 使用本地偏好，Android 原生色板缓存仍只服务系统栏等原生界面。
- 液态玻璃引擎使用 SVG displacement、specular 与 Gaussian primitives 绑定到对应表面的 `backdrop-filter`。若运行时不支持该特性，引擎明确标记 unsupported 并报告错误，不静默切换回旧磨砂、白色描边或纯色渲染。

本审计没有发现新旧玻璃参数之间应当保留的映射关系；旧玻璃键不再影响结果。离线 GPU Chromium
回归已完成 **128/128**，包括高对比背景折射像素检查和 Windows 悬浮窗模板路径；仍需完成目标
WebView2/Android WebView 的实际渲染、缩放和性能验收后，才能报告平台支持状态。
