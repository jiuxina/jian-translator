# 2026-11-19 代码质量与用户体验修复

对应 [2026-11-18 审查报告](code-quality-ux-audit-2026-11-18.md)。本次保持界面结构、服务地址与版本号 2.4.1，不生成或发布安装包。

## 共享翻译与输入

| 审查发现 | 修复行为 | 定向验证 |
| --- | --- | --- |
| 不完整译文、CRLF、EOF 末帧 | `translation-stream.js` 由主页面和桌面浮窗共用。增量解码 UTF-8，按 SSE 行与事件解析，支持 CR/LF/CRLF、多行 data、末帧 flush、usage 事件；DONE 后停止解析。只有非空正文和 `finish_reason: stop` 才算成功；length、过滤、错误、无结束原因和损坏 JSON 均失败 | `verify-translation-stream`、`verify-stream-boundaries` |
| 请求无限等待 | 连接/响应头 30 秒，响应体空闲 60 秒；读入新数据重置空闲计时。完成、失败、取消时清理计时器、读流与信号监听 | `verify-stream-boundaries` |
| 模式共享忙碌状态、清空回写 | 文本、音节、长文分别拥有任务、控制器、输出 writer 和真实结果。只有当前任务能更新内容和解除忙碌；取消保留已完整内容，清空使旧任务立即失效。不同输出 writer 不互相取消 | `verify-task-ownership`、`verify-stream-writer` |
| 长文配置漂移 | 开始时固定原文分块、源语言、目标语言和模型；只有完整区块进入完成结果及进度，失败不标记全篇完成 | `verify-task-ownership` |
| 文件读取覆盖新编辑 | 编辑代次与导入序号共同检查；清空、再次选择、用户输入后的旧 FileReader 结果不再生效 | `verify-task-ownership` |
| 少见源语言显示不一致 | 主源语言选择器包含全部语言，仍保留自动检测与常用语种在前 | `verify-audit-ux` |
| 占位文案复制/下载 | 按任务真实结果启用操作，不从输出 DOM 复制占位或错误文字。流式预览不可当作完成译文复制 | `verify-task-ownership`、`verify-audit-ux` |
| 图片粘贴与透明 JPEG | 输入框接收 ClipboardEvent 图片；支持时粘贴按钮优先读取图片。剪贴板授权/读取、文件读取与压缩都遵守输入代次；JPEG 编码前先铺白底 | `verify-image-import`、`verify-task-ownership`、`verify-audit-ux` |

失败后可以点击原有翻译按钮重试；不会自动重发 API 请求。长文取消或失败后只允许导出已经完整的区块。未完成的预览不会加入可复制结果。

## 原生端与发布

- **Windows 划词与快捷键：** 传递稳定请求 ID，前端同步确认并去重；未就绪的页面才消费补投，迟到投递不会覆盖编辑。只在 Pressed 事件后去抖，释放不执行操作。剪贴板在 GlobalSize 界限内查找 UTF-16 NUL；Release 诊断日志为无操作，开发日志限长并保留一份轮转副本。详见 [输入安全](windows-input-safety.md)。
- **Windows 安装器：** WiX 片段由现有补丁流程注入实际模板。全新安装默认关闭，只迁移旧安装实际拥有的已启用启动项；成功卸载后仅移除本安装目标。其他目录或便携版保持原状。详见 [安装器说明](windows-installer.md)。
- **Android：** 文档打开交给系统选择器，下载交给创建文档桥；请求码分别路由。原生持久化 URI/令牌/用途，网页在本地存储与会话存储中记录待处理令牌及失效状态，不在该元数据中保存原文或图片。页面就绪后才投递，匹配确认后清理；恢复不覆盖新编辑。快门可访问、镜头可用性与确认预览 EXIF 处理一并修复。详见 [文件与图片桥接](android-file-bridge.md)。
- **macOS：** 等待阶段使用临时 Escape 取消；复制之前、等待取词以及完成投递/聚焦之前检查前台应用身份。切换应用或关闭窗口后丢弃迟到结果。详见 [macOS 文档](macos.md)。
- **发布：** Git tag 必须与应用版本及准备器 manifest tag 相同；不匹配在创建输出前失败。便携离线验证是各平台构建及发布的前置依赖，附件清单与哈希仍由准备器核对。详见 [发布准备](release-preparation.md)。

## 资源与接口

`web/` 是七项共享资源的唯一维护源，新增 `translation-stream.js`；Android assets、macOS 打包清单与 Windows include/copy 均同步。macOS 准备脚本从 Rust 常量提取浮窗脚本，避免维护两份解析器。

新增网页侧协议：`__itTranslateSelection(text, requestId)`、`__itSelectionAccepted`；Android 的 `bridgeReady`、`pickImageWithTokenAndPurpose`、`acknowledgeImage`、`prepareDocumentImport`、`acknowledgeDocumentImport`、`saveDocument`，以及对应恢复/保存结果回调。旧选图方法和无 ID 划词入口保持兼容。没有修改外部翻译 API 或偏好版本。

## 最终验证与边界

本次修改过程中仅执行直接相关的定向测试，并在测试失败、修复完成时建立 Git 检查点。代码、资源和本文档完成后，最后一次汇总验证使用 `node scripts/verify-release.mjs`；它记录每组状态到 `.build/audit-release-verification.json`，任一失败即返回非零。此入口是便携离线测试集合，不等于完整平台回归；桌面补丁器测试另外记录。

已实际查看本地文本与长文页面，空译文复制/下载处于禁用状态，未见布局重叠或页面加载错误。测试使用合成数据与替身，没有读取真实剪贴板、用户文件、浏览器配置、签名资料或调用翻译服务。

受工作区访问限制，本次不启动工作区外的 JDK、Rust 或浏览器可执行文件。完整 CDP 动画/性能套件、Android Java 构建和 IME 合同、Rust 编译/原生探针、真实 MSI 升卸载、macOS 和 Android 设备验收仍需具备授权的运行环境；未运行项目不记作通过。平台验收覆盖报告原有未覆盖项、短/长按热键、断流与截断、跨模式取消、选择器取消/失败、后台及进程重建、TalkBack、单摄及 EXIF 样例。现有发布包保持原样。

随后用户授权使用 Codex 内置浏览器，已补做桌面与 360×640 窄屏的 **22/22 项集成检查**，未发现新的生产代码缺陷。详见 [内置浏览器补充验收](internal-browser-audit-2026-11-19.md)；这不改变上述原生编译、设备与完整 CDP 套件的验证边界。
