# 代码质量与用户体验审查报告

**日期：** 2026-11-18

**范围与方法：** 只读审查共享 Web、Windows/Tauri、macOS/Electron、Android/WebView 和发布流水线；查看桌面宽屏文本页与长文页；用合成数据运行局部生产函数。未访问真实翻译服务、用户文件、剪贴板、浏览器配置、设备数据、密钥或签名材料，未修改应用源码。

## 结论

桌面宽屏视图的层级和入口清楚。主要风险集中在异步任务所有权、流式响应完整性、Windows 快捷键/划词，以及 Android WebView 的文件和下载桥接。建议先处理三个 P1：Windows 划词重复投递、快捷键释放二次触发、以及不完整流被当作成功译文。

**级别说明：** P1 会造成重要输入被覆盖、重复操作或不完整结果被误认完成；P2 会让常见功能失效、结果不一致或产生明确的用户困惑；P3 主要影响无障碍、低频设备和维护/发布质量。

## P1

### Windows 划词重投会覆盖编辑并重复翻译

原生端在 [setup.rs](../desktop/patch/setup.rs#L2297) 对同一选区于 0、250、700、1500ms 重复 eval；网页端 [app.js](../web/app.js#L2234) 每次都覆盖原文、清附件并安排翻译。用户触发划词后开始编辑，迟到投递会覆盖编辑；合成 Node VM 确认四次投递都会触发前端翻译入口，因此当较早请求已经完成时可能重复发送 API 请求。应使用请求 ID、前端幂等确认，只在页面尚未就绪时重试。

### Windows 快捷键释放时可能再次触发

快捷键 handler [setup.rs](../desktop/patch/setup.rs#L2616) 忽略 Pressed/Released 状态，只做 320ms 去抖。按住快捷键超过 320ms 再释放，显示/隐藏可能执行两遍，划词可能重复取词。应只处理 Pressed，再做去抖。

### 不完整流可能被当作完整译文

Web 解析器 [app.js](../web/app.js#L1243) 和 Windows 浮窗解析器 [setup.rs](../desktop/patch/setup.rs#L1665) 忽略 SSE 错误和 `finish_reason`；浮窗固定 `max_tokens: 1024`（[setup.rs](../desktop/patch/setup.rs#L1646)）。离线合成中 `finish_reason: "length"` 的 `partial` 正常返回，错误事件返回空成功。应验证结束原因，失败的长文区块不可标为完成，并提示截断。

## P2

### 模式共用忙碌状态和取消控制器

全局 `running/controller` 在 [app.js](../web/app.js#L843)，文本、音节、长文和清空均共用。长文运行时切换音节会静默无效，清空音节会取消长文；请求也没有整体或读流超时。应按模式隔离任务并显示明确忙碌/重试状态。

### 清空后部分译文会复活

清空在 [app.js](../web/app.js#L2215) 中止并清空，AbortError 回调 [app.js](../web/app.js#L2168) 又写回 buffer。离线合成已复现。清空前应使请求失效，区别“保留进度取消”和“清空”。

### 长文区块会改变语言或模型

[runDoc](../web/app.js#L2418) 每个区块重新读取共享语言/模型。翻译期间修改设置会使同一篇文档前后使用不同配置；离线合成已复现。任务开始时应固定配置。

### 源语言设置与主页面语言选择可能不一致

主页面源语言下拉只包含“自动检测”和常用语种（[app.js](../web/app.js#L398)），设置页允许选择完整语言列表（[app.js](../web/app.js#L3255)）。恢复一个不在常用列表中的源语言时，内部翻译状态会采用该值，但主页面下拉没有对应选项而继续显示自动检测（[app.js](../web/app.js#L2931)）。用户看到的源语言与实际翻译请求不同。应让主选择器支持全部源语言，或在加载时将当前少见语种明确添加到选项中。

### SSE 不兼容 CRLF 且丢失 EOF 末帧

[app.js](../web/app.js#L1248) 和 [setup.rs](../desktop/patch/setup.rs#L1672) 只按 `\\n\\n` 分帧，EOF 不处理剩余 buffer。CRLF 可得到空译文，末帧文字可丢失；离线合成已确认。应按 SSE 规范处理换行并 flush 末帧。

### Android 长文打开文件断路

Web 页隐藏 file input 位于 [index.html](../web/index.html#L175)，读取逻辑位于 [app.js](../web/app.js#L2473)；Android [MainActivity.java](../android/app/src/main/java/ink/jian/translate/MainActivity.java#L238) 的 WebChromeClient 没有 `onShowFileChooser`。Android 点击“打开文件”无法选择 txt/md。源码确认，未真机验证。应接入文档选择器并处理取消/重建。

### Android 下载译文没有保存桥

[app.js](../web/app.js#L2504) 使用 Blob URL 下载；[MainActivity.java](../android/app/src/main/java/ink/jian/translate/MainActivity.java#L186) 没有 DownloadListener 或导出桥。Android 无法可靠调用系统保存位置。源码确认，具体 WebView 表现待设备验证。应通过原生桥和 `ACTION_CREATE_DOCUMENT` 保存并反馈结果。

### Android 重建会丢失图片回调

活动只保存 WebView 状态（[MainActivity.java](../android/app/src/main/java/ink/jian/translate/MainActivity.java#L149)），图片 callback token 只在内存中设置/读取（[MainActivity.java](../android/app/src/main/java/ink/jian/translate/MainActivity.java#L619)、[MainActivity.java](../android/app/src/main/java/ink/jian/translate/MainActivity.java#L828)）。活动或进程在相册/相机期间重建后，图片可能静默丢失。应持久化待处理请求和结果，待 WebView 就绪后恢复投递。

### macOS 等待取词完成后可能夺回焦点

[main.cjs](../app/macos/main.cjs#L315) 等待 System Events 复制；等待时窗口不可聚焦（[main.cjs](../app/macos/main.cjs#L453)），Escape 只在浮窗文档监听（[main.cjs](../app/macos/main.cjs#L389)），完成后无条件 focus（[main.cjs](../app/macos/main.cjs#L481)）。用户等待时切换应用，结果仍可能抢焦点。源码推导，未在 macOS 实测。应提供等待期取消，并在 focus 前检查请求和前台应用。

### 旧文件读取会覆盖长文新编辑

[FileReader.onload](../web/app.js#L2475) 无序号或编辑版本检查。选择文件后清空并输入新内容，旧读取完成会覆盖新内容；离线合成已复现。应丢弃迟到导入。

### Windows 剪贴板读取缺少边界检查

[setup.rs](../desktop/patch/setup.rs#L1987) 在检查长度前解引用 UTF-16 指针，也未用 `GlobalSize` 限定可读区域。异常或未终止剪贴板数据可能越界读取、产生垃圾文本或崩溃。应先建立受限切片再找 NUL。未读取真实剪贴板。

### 空结果复制/下载占位文案

空输出在 [app.js](../web/app.js#L1968) 写入占位文字，复制按钮直接复制 `textContent`（[app.js](../web/app.js#L2227)），长文下载同样读取占位文案（[app.js](../web/app.js#L2504)）。空白页面可能复制或下载“译文将在这里呈现”。应以真实结果状态判断可复制/下载。

### 图片粘贴承诺与实现不一致

输入框提示和 README 承诺可直接贴图，但“粘贴”按钮只调用文本剪贴板（[app.js](../web/app.js#L2199)），未注册图片 paste/drop 处理器。用户粘贴截图不会导入。应实现 `ClipboardEvent` 图片读取，或修正文案。

### 透明 PNG 转 JPEG 可能产生黑底

[shrinkImage](../web/app.js#L369) 在透明 canvas 上直接 `drawImage` 后转 JPEG；透明区域会以默认黑色合成，透明截图上的黑字可能无法识别。应先绘制白底或保留 PNG。源码推导，未调用真实 OCR。

## P3 与质量缺口

- Android 相机快门是自绘 `FrameLayout`，没有 `contentDescription`（[CameraActivity.java](../android/app/src/main/java/ink/jian/translate/CameraActivity.java#L198)），TalkBack 无法识别“拍照”。
- Android 相机切换不先检查 `hasCamera`（[CameraActivity.java](../android/app/src/main/java/ink/jian/translate/CameraActivity.java#L527)），单摄设备可能退出相机；确认预览 decode 不处理 EXIF，竖拍图可能横置（[CameraActivity.java](../android/app/src/main/java/ink/jian/translate/CameraActivity.java#L441)）。两项均未真机验证。
- Windows `it_debug_log` 可将任意消息无限追加到临时日志（[setup.rs](../desktop/patch/setup.rs#L2341)）。当前未发现实际页面调用，发布包应删除、限长或轮转。
- 发布工作流直接构建并发布（[release.yml](../.github/workflows/release.yml#L139)）。附件准备器会验证发布版本和应用包清单一致，但 workflow 没有将触发的 Git tag 与准备器生成的 manifest tag 比较；tag 与包版本不匹配时仍可能发布版本名称不一致的附件。发布 job 也不运行完整回归。应验证 tag/manifest/附件版本一致，并让发布依赖验证结果。

## 已完成的验证

- `node --check`：`web/app.js`、`web/updates.js`、`app/macos/main.cjs`、`core.cjs`、`preload.cjs` 通过。
- 定向离线检查：`verify-version-consistency`、`verify-updates`、`verify-stream-writer`、`verify-image-import` 通过。
- Web 与 Android assets 的六项共享资源 SHA-256 完全一致。
- 可视检查：本地 Chromium 桌面宽屏下文本页和长文页，无明显重叠或空白布局故障。
- `verify-android-ime.mjs` 未能运行：当前 Node 子进程启动 `javac.exe` 返回 Windows `EPERM`，因此不能把 Android IME 合同测试计为通过。

## 未覆盖与风险边界

本轮没有运行完整测试套件。仓库规定的完整回归需要启动项目工作区以外的浏览器、JDK 与 Rust 工具；本轮访问范围仅包括项目工作区，因此没有启动这些工具，也未把未运行测试计作通过。没有 Android 真机/模拟器、macOS 真机、Windows 打包 WebView2、系统 TalkBack、真实输入法或真实 API 验证。上述未覆盖项不改变已经由源码或离线合成确认的问题，但应在修复后补做平台验收。
