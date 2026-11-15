# Windows 窗口与设置集成

维护源是 `desktop/patch/setup.rs`；`patch_apply.py` 将它同步到工作区的 Pake 3.18.0 模板，
并补齐命令权限及 Windows API feature。不要只修改 `.build/` 内的生成副本。

## 窗口边框

增强主窗口首次显示前通过 DWM 的 `DWMWA_BORDER_COLOR / DWMWA_COLOR_NONE` 关闭系统激活描边；
焦点和原生主题变化时重新应用。现有原生阴影、圆角、自绘标题栏和边缘缩放继续使用。
该 DWM 属性需要 Windows 11；不支持时输出 HRESULT 诊断，不中止启动。

## 设置保存

`DesktopSettings.preferences` 保留前端的版本化通用偏好，老配置缺项时仍能读取。
保存仅在快捷键或自动启动字段改变时执行相应系统操作，失败时回滚并返回可见错误。
设置先写同目录临时文件并刷新，再原子替换正式文件；成功后才更新内存和浮窗外观。

划词浮窗的 `__popupApplyPreferences(appearance)` 只调整外观；创建、再次唤起和保存后会重放，
不重新发起翻译请求。系统减少动态效果始终优先于应用动效选项。

## 本轮验证（2026-11-15）

- Windows 目标 `cargo check --target x86_64-pc-windows-msvc --offline` 通过。
- 维护源 `rustfmt --edition 2021 --check` 通过；补丁同步后的文件哈希与维护源一致。
- JavaScript 离线回归覆盖主界面设置；它不覆盖 DWM 实际绘制。
- 原生画面验收尝试启动独立 QA 应用时，Computer Use 的应用授权等待超时，未获得窗口截图。
  因此激活、Alt+Tab、最大化、缩放和系统主题切换的原生视觉验收仍待完成。
