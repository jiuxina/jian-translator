# Windows 窗口与设置集成

维护源是 `desktop/patch/setup.rs`；`patch_apply.py` 将它同步到工作区的 Pake 3.18.0 模板，
并补齐命令权限及 Windows API feature。不要只修改 `.build/` 内的生成副本。

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

桌面设置 JSON 的 `preferences.appearance` 保存正文字体、字重、文字颜色与主卡片透出度；
`preferences.popup` 保存悬浮窗透出度和可选背景图。悬浮窗图片为空时跟随主窗口背景，独立图片覆盖
该图片，背景淡化、模糊与填充仍沿用主背景。卡片透出度 0% 保留原玻璃外观，100% 清除卡片填充、
模糊和内部高光，不影响文字、按钮和描边。设置内嵌预览实时响应，实际悬浮窗只在保存成功、创建或
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
