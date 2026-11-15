# 设置项关系简报

审查日期：2026-11-15。依据当前 `web/app.js`、`web/theme.css` 与
`desktop/patch/setup.rs`，覆盖网页、Android 和 Windows 的设置消费路径。
这是代码关系审查；真实 Windows 字体列表、剪贴板、DWM 及 DPI 验收仍需实机确认。

## 六个分组及字段

| 分组 | 保存字段 | 生效范围与关系 |
| --- | --- | --- |
| 外观 | `appearance.mode/palette/material/glassStrength/cardReveal/radius` | 明暗、配色、材质、圆角共用到主界面与 Windows 浮窗；`cardReveal` 只控制主卡片，浮窗另存透出度。 |
| 背景 | `background.data/opacity/blur/fit` | 主背景图片及淡化、模糊、显示方式；后三项也作用于浮窗背景，包括浮窗独立图片。 |
| 阅读与布局 | `appearance.font/systemFontFamily/fontScale/fontWeight/fontColorMode/fontColor/layout` | 字体、字号、字重、颜色用于正文；系统字体仅 PC。`layout` 改主界面内容间距；原生浮窗目前只写入对应 dataset，没有消费它的布局规则。 |
| 动效 | `appearance.motion/ambientLight` | 动画模式和环境柔光是独立设置；系统减少动态效果优先。原生浮窗的柔光开关控制卡片装饰高光，主界面控制环境柔光。 |
| 翻译偏好 | `translation.defaultTab/sourceLanguage/targetLanguage/defaultModels.{text,syllable,doc}/rememberLanguages/rememberModels` | 决定主界面下次启动的初始页面、语言和模型；记忆项可覆盖默认项，不改变正在进行的翻译。 |
| 电脑功能 | `selection_shortcut/activation_shortcut/open_main_window/target_lang/auto_start/start_to_tray`；`popup.cardReveal/backgroundData` | 快捷键、划词展示和启动行为；浮窗目标语言、透出度与独立背景。网页和 Android 不显示此组。 |

通用偏好包含 `version`；旧配置先补缺省值、过滤不支持的枚举并夹紧数值，再填充控件。
桌面字段由原生设置文件保存；通用偏好在网页/Android 使用本地存储，Windows 以原生设置为准并写前端缓存。

## 父子项、覆盖项与条件失效

- 选择“纯色”材质后，玻璃强度暂时不参与最终画面。本轮将滑块禁用并显示说明，
  **保留原值**；切回玻璃或磨砂后继续使用。原生浮窗也通过纯色 CSS 规则关闭 backdrop-filter，
  不应只根据其内部 blur 变量判断最终效果。
- 主卡片与浮窗透出度控制各自卡片的底色、模糊和内部高光；100% 时背景完全透出，
  不清除背景图片自己的淡化、模糊，也不清除正文和边框。两项不是重复配置。
- `fontColorMode=theme` 使用主题正文色并禁用颜色输入；原有 `fontColor` 值保留。
  切换为 `custom` 后恢复该值，自定义色优先于浅深主题色，用户需留意与背景的对比度。
- Windows `systemFontFamily` 非空时优先使用所选系统字体，`font` 提供通用回退；
  字体不存在或未覆盖某字符时按 CSS 字体链回退。读取列表失败不清除原选择；
  原字体仍可用时继续使用，不能仅凭枚举失败认定实际使用了回退字体。
  网页和 Android 保留通用字体类别，不应用 PC 系统字体。
- 浮窗 `backgroundData` 非空时覆盖主背景图片；清空后恢复跟随 `background.data`。
  两种图片共用 `background.opacity/blur/fit`，没有第二套显示参数；即使主窗口没有图片，
  这些参数仍可能影响浮窗独立图片，不宜仅按主背景是否为空整体禁用。
- `rememberLanguages=true` 时，上次有效语言覆盖默认源/目标语言；
  `rememberModels=true` 时，上次有效模型覆盖各页默认模型。关闭对应记忆后下次启动使用默认值。
  `defaultTab=last` 单独决定是否恢复上次页面；其余页面选项使用指定页。
- `open_main_window` 决定划词结果显示位置。浮窗路径使用 `target_lang`（自动、中、英）
  并固定调用 `index-mt-2b`；主窗口路径只接收选区文本，沿用主界面当前语言和文本模型。
  因而 `target_lang` 与 `translation.targetLanguage` 不是重复项，默认模型也不覆盖原生浮窗模型。
- `auto_start` 与 `start_to_tray` 独立：后者也影响手动启动。自动启动注册表在保存时更新，
  启动是否显示主窗口在下次启动时读取。快捷键冲突由原生注册返回错误并尝试回滚，不会静默成功。

## 保存、取消与恢复默认

- 通用外观草稿实时预览；翻译默认项用于下次启动。浮窗独立背景和透出度在设置内嵌卡片预览，
  保存成功后才同步真实浮窗；保存、重新创建或再次唤起浮窗均可投影已提交外观。
- 取消、关闭、Esc/系统返回恢复打开设置时的已提交副本；文件选择异步回调受会话序号保护，
  关闭后返回的图片不会重新写入草稿。保存过程中阻止重复保存及关闭。
- “恢复本组默认”只修改草稿，仍须保存；取消可撤销。外观不重置阅读/动效字段；
  阅读、动效各复位自己的 appearance 子字段；背景、翻译各复位整组；
  电脑功能同时复位桌面字段及 popup 子组，保留其他组。
- Windows 先完成原生快捷键、启动与文件持久化，再提交前端状态并同步浮窗；原生失败显示错误，
  保留草稿供修改。网页本地存储失败不当作成功；Android 原生外观缓存失败会显示缓存未更新提示。

## 结论与后续建议

没有发现可以直接删除而不损失独立用途的重复设置；字体类别/系统字体、默认值/记忆、
主背景/浮窗图片和两项卡片透出度均有明确边界。纯色材质下玻璃强度的无效操作已在本轮处理。

仍建议在 UI 中补充“记忆覆盖默认项”“主窗口划词与浮窗使用不同语言/模型”的就近提示。
原生浮窗目前不消费 `layout`，而字体类别回退链、圆角、材质与柔光的实现也与内嵌预览存在细节差异；
预览能验证设置趋势，不代表真实浮窗逐像素一致。后续应按实际产品预期统一这些细节或注明作用范围。
