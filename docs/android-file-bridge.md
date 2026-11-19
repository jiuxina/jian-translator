# Android 文件桥接与图片恢复

本页记录 2026-11-19 审查修复的 Android 行为；共享页面仍以 `web/` 为唯一维护源。

## 文档打开与保存

- `WebChromeClient.onShowFileChooser` 将长文的隐藏文件输入交给系统 `ACTION_OPEN_DOCUMENT`，筛选纯文本和 Markdown。取消时用 `null` 结束本次回调，不当作读取失败。
- 网页在打开选择器前调用 `prepareDocumentImport(editRevision)`。原生保存选择结果 URI 和编辑版本；正常页面继续由 FileReader 导入，重建后的页面由 `__itOnRestoredDocument(text, name, editRevision)` 接收。网页接受或丢弃迟到结果后必须调用 `acknowledgeDocumentImport(editRevision)`。
- 重建后的原生导入以 UTF-8 读取，最多 8 MB；过大、权限失效、提供器不可读时给出重新选择提示。大段文本和图片不会写进 Activity Bundle。
- `NativeBridge.saveDocument(filename, text)` 通过 `ACTION_CREATE_DOCUMENT` 让用户选择位置。每次请求独占一份应用私有缓存文件，写入完成或用户取消后清空缓存内容，避免上一请求的清理覆盖新导出。保存结果以 `__itOnDocumentSaved(status, message)` 回到页面，状态为 `saved`、`cancelled` 或 `error`。
- 系统返回结果按文档打开、保存、相机/相册的请求码分流，文档操作不会被误当作图片解码。

## 图片恢复协议

- 网页使用 `pickImageWithTokenAndPurpose(token, purpose)`；用途为 `translation`、`background` 或 `popup-background`。原生持久化请求 token、用途和待投递 URI，避免相册/相机期间进程重建丢失目的地。
- 页面完成初始化后调用 `bridgeReady()`；原生同时等待页面加载完成，再投递结果。存活页面使用 `__itOnImage(dataUrl, token)`，重建页面使用 `__itRestoreImage(dataUrl, token, purpose)`。
- 网页处理或因更新编辑而丢弃结果后调用 `acknowledgeImage(token)`。只有匹配当前请求的确认才能清除原生待处理状态；旧异步解码也由原生序号拦截。
- 页面重新加载会更新页面代次；已经开始的图片解码不得继续投递给旧页面回调，而是在新页面就绪后重新分发。原生文档读取同时校验 URI 与编辑版本，导出写入也有重复启动保护和跨 Activity 的串行锁。
- 相册使用可持久授权的文档 URI；不提供持久授权或之后撤销授权的提供器仍可能要求用户重新选择。不会因恢复操作自动读取其他图片。
- 导入 PNG 等带透明通道的图片在 JPEG 编码前以白色合成，避免透明文字截图产生黑底。

## 相机

快门具有“拍照”的无障碍名称并可聚焦。镜头切换先确认目标镜头存在；单摄设备保留当前预览。启动时缺少后摄可回退到前摄。确认预览处理 EXIF 的旋转及镜像方向。

## 验证边界

`node tests/verify-android-file-bridge.mjs` 覆盖桥接、恢复和相机的源码契约；它不代替 Android 编译或设备验收。

`node tests/verify-transfer-recovery.mjs` 使用合成存储、DOM 和原生回调替身执行共享页面的生产恢复函数，覆盖就绪顺序、持久化恢复、编辑失效、过期 token、图片用途分流、重复投递确认与保存反馈。不会读取真实页面存储或文件。

平台验收需使用合成 txt/md、透明 PNG 和拍摄样张，覆盖选择/取消、保存失败、后台重建、进程重建、连续导入、导入后编辑、TalkBack、单摄设备，以及带旋转和镜像 EXIF 的确认预览。未运行的编译或设备检查必须单独列明，不记作通过。
