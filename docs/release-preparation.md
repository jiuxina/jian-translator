# Release 准备记录

## 当前版本：v2.4.5

### 当前阶段：v2.4.5 功能修复与发布说明准备（2026-11-22）

前端及关于页、Windows/macOS 构建版本统一为 `2.4.5`；Android 为 versionName `2.4.5` /
versionCode `12`，macOS 包清单与锁文件同步。发布说明见 [v2.4.5](releases/v2.4.5.md)。
本版将剪贴板翻译快捷键扩展为同时读取文字与图片，图片优先；读取和解码期间的新编辑、清空、
换图或新请求使迟到结果失效。Windows/macOS 默认快捷键分别为 `Ctrl+Alt+V` 和 `Cmd+Alt+V`。
本轮补充翻译重复输出保护：共享请求传输检测持续的相邻词句循环，停止请求并提示重试，
异常译文不作为成功结果保存；文字、图片、音节、文档和桌面划词浮窗共用此保护。
文档分块出错时保留此前已完成的内容；检查参考原文中的重复情况，以减少正常重复的误判。
共享 `app.js` 缓存查询版本递增至 `24`，`translation-stream.js` 递增至 `2`，Android 资源镜像同步。

版本一致性、图片/文字剪贴板契约、任务归属、macOS 合成桥接与桌面补丁检查通过。
本次 `node scripts/verify-release.mjs` 便携离线门槛 **17/17** 通过；
`node tests/verify-stream-boundaries.mjs` **25/25**，包括重复循环、取消清理与原文分析预算，
`node tests/verify-translation-stream.mjs` 的生产适配层和响应边界检查通过。
任务归属回归确认文字、图片、音节异常不保存成功结果，文档保留已完成分块；
Android 镜像、生成浮窗共享资源及 macOS 合成生命周期 **31/31** 通过。
回归使用合成响应，不调用真实翻译接口。Windows 原生 Rust 编译和两端真实剪贴板、
快捷键焦点仍需平台构建验收。
本地未构建安装包，不生成附件哈希，不创建或推送标签；待维护者推送最终提交及 `v2.4.5` 标签。

### 历史：v2.4.4 发布准备（2026-11-20）

前端及关于页、Windows/macOS 构建版本统一为 `2.4.4`；Android 为 versionName `2.4.4` /
versionCode `11`，macOS 包清单与锁文件同步。发布说明见 [v2.4.4](releases/v2.4.4.md)。
本版包含原文与译文字号、行距和辅助文字对比度优化，以及统一控制界面、正文与划词浮窗的
字体粗细设置。已有字重偏好直接沿用；切换字重时同步重测下拉标签并对齐滑块。
共享 `app.js` 缓存查询版本递增至 `22`，Android 资源镜像同步。

本次验证入口为 `node tests/verify-version-consistency.mjs`、
`node tests/verify-release-preparation.mjs`，两项定向检查已通过；代码与文档完成后执行一次
`node scripts/verify-release.mjs` 便携离线门槛。原生编译、安装升级与实机体验以标签构建和平台验收为准。

本地准备完成后等待维护者推送最终提交及 `v2.4.4` 标签；不创建或推送标签、不上传附件、
不发布远程 Release。未重命名历史安装包，也未为尚未构建的新包生成校验值。

### 历史：v2.4.3 发布准备（2026-11-19）

前端及关于页、Windows/macOS 构建版本统一为 `2.4.3`；Android 为 versionName `2.4.3` /
versionCode `10`，macOS 包清单与锁文件一并同步。发布说明见 [v2.4.3](releases/v2.4.3.md)。
本版集中交付共享主界面的设置分类连续交接、模式切换测量复用和下拉列表缓存；保留原有材质、
动效时长、翻译行为及减少动态效果支持。共享 `app.js` 缓存查询版本递增至 `20`，Android 镜像同步。

本轮仅更新版本与发布文案，按维护者要求未运行测试或构建。升级前的定向检查、离线回归实际结果与
未完成的 CDP 浏览器场景保留在 [性能记录](performance.md)，不表述为 2.4.3 升级后的新测试结果。
原生编译、安装器升卸载和各平台实机验收仍以标签构建及平台验收结果为准。

本地提交完成后等待维护者推送；发布工作流对应标签为 `v2.4.3`。本轮不推送、不创建标签、不上传附件，
也不重命名旧安装包或提前生成新包哈希。普通分支推送不触发发布，推送版本标签后才进入下述验证、构建与发布流程。

### 代码质量修复后的发布门槛（2026-11-19）

标签构建新增独立 `verify` 任务：先确认触发标签严格等于应用版本的 `v` 前缀形式，
再执行 `node scripts/verify-release.mjs` 和桌面补丁器测试；三端构建与发布均依赖此任务成功。
准备附件时必须传入 `--tag "$RELEASE_TAG"`，准备器再次核对标签与清单版本，
不匹配时在创建输出目录前失败。普通本地草稿准备仍可省略 `--tag`。

`scripts/verify-release.mjs` 是可在 Node 22 下运行的便携离线门槛，覆盖版本/共享资源、
流与任务归属、图片、设置、自启动、macOS 合成生命周期、Android 桥、安装器归属和发布准备。
它使用合成输入，不读取用户剪贴板、偏好、文档或签名材料，也不调用翻译服务。
它不等同于完整回归：浏览器渲染、Java/Rust 原生编译、打包 WebView2、真实 Android/macOS、
TalkBack 和安装/升级/卸载仍需单独的平台验收。任何未执行的项目都不得记作通过。

MSI 自启动生命周期和所需 Windows 安装矩阵见 [Windows 安装器](windows-installer.md)。
本次没有触发远程构建、推送、打标签或发布。

### 历史：v2.4.1 本地 Release 准备（2026-11-18）

本轮已完成源码、平台元数据和发布说明的版本统一：前端、Windows/macOS 构建版本为 `2.4.1`，
Android versionName 为 `2.4.1`、versionCode 为 `8`，发布说明为 [v2.4.1](releases/v2.4.1.md)。
Windows 自启动目标、无边框白边、设置关闭闪现和首次启动默认值均已包含在本轮源码变更中。

提交完成后，由维护者推送该提交并创建 `v2.4.1` 标签。GitHub Actions 会按标签构建 Windows EXE/MSI、
macOS universal DMG/ZIP 和 Android APK，并由发布准备脚本生成英文文件名、SHA-256 清单和 Release 文案。
本地代理不会推送、打标签、上传附件或发布远程 Release。

推送标签前须在仓库 Actions Secrets 中配置 `ANDROID_KEYSTORE_BASE64` 和
`ANDROID_SIGNING_PROPERTIES_BASE64`，后者的 `storeFile` 应为 `keystore/release.keystore`。
缺失或配置不完整会在发布构建前明确报错；不再声称回退到 debug 签名。本次未读取密钥或 Secrets，
其是否已配置需由仓库维护者确认。普通分支推送不发布，标签对应的三端构建全部成功后才发布正式 Release。

版本一致性检查入口为 `node tests/verify-version-consistency.mjs`；Windows 自启动、窗口边缘和设置动画的
定向入口见 `tests/verify-windows-autostart.mjs`、`tests/verify-windows-frame.mjs` 和
`tests/verify-settings-close.mjs`。发布附件及其哈希以标签构建结果为准；不把历史二进制重命名为
2.4.1，也不提前生成校验值。

本地收尾检查已完成：2.4.1 / Android code 8 与六项资源字节一致；发布准备器、标签触发与
Android 签名缺失门槛检查通过。Windows `cargo fmt --check` 和 `cargo check --offline` 通过；
自启动 UI 为 12/12，内存注册表探针为 9/9，隐藏窗口边缘探针为 4/4，设置关闭覆盖终态、
快速重开和减少动态效果。原生测试均从本次源码重新编译执行，不接受旧结果文本旁路。
运动交互复核为 148/148，日志为 `.build/version-2.4.1-motion-final.log`；此前全量中的玻璃
准备边框采样失败已单独复核通过，结果为 `.build/version-2.4.1-glass-readiness.json`。
已有完整回归结果保留，收尾只补跑受修改和失败影响的项目，没有重跑整套或将局部结果合并
声称新一次全量全通过。按维护者最终要求，本轮止于代码检查和 Release Note，不在本地重建发布包。
三端发布二进制、Windows WebView2 / macOS / Android 设备验收仍以标签构建及实机结果为准。

### 历史：界面连贯优化的本地 Release 包（2026-11-17）

本轮包含设置打开和分类切换期间的真实玻璃合成修复、紧凑图片附件、Android 键盘覆盖，
以及设置即时应用和自动持久化。玻璃折射、高光、透明度和已有动效保留；
设置关闭不回滚，持续输入合并保存，失败可重试。

交付目标为 `output/笺-2.3.0-release.apk`，Android versionName `2.3.0` /
versionCode `6`。按用户要求使用 **Release** 构建，保留名称“笺”和原应用标识
`ink.jian.translate`；后续交付也不自行增加文字、名称后缀或包名后缀。
此前带额外标识的产物已被替代，不再交付。隔离工程继续只复制公开源码和构建依赖声明，
已按原身份完成 Release 构建，原签名仍待明确授权使用；尚未确认签名与覆盖安装能力。
本页保留的 Debug APK 名称仅是早期阶段记录。

本轮最终全量在源码、共用资源、文档和构建完成后只执行一次，
完整日志为 `.build/ui-polish-final-verification.log`，逐项退出状态清单为
`.build/ui-polish-final-results.json`。新增回归入口：

- `tests/verify-settings-compositor.mjs`：在真实动画中对比位移滤镜像素，检查最后一帧没有突然补出折射。
- `tests/verify-attachment-layout.mjs`：不同手机尺寸、横纵图片、文字空间、选择与移除/替换动画。
- `tests/verify-android-ime.mjs`：生产安全区处理、键盘高度变化、旧系统、旋转与刘海的稳定视口。
- `tests/verify-settings-preview.mjs` 及更新后的交互场景：即时保存、异步队列、失败重试、过期回调和保存期间重开。

此前独立身份产物的构建、大小、哈希和签名验证只适用于已被替代的文件，
不能用于证明当前原身份 Release 包已完成。原身份 `assembleRelease --offline --no-daemon`
已成功，重新核验名称“笺”、`ink.jian.translate`、版本 `2.3.0` / code `6`、
非 debuggable 标志，以及包内六项前端资源与 `web/` 逐字节一致。
签名前记录为 `.build/ui-original-release-pre-sign.json`；签名后的大小、SHA-256 和
证书一致性需在原签名获授权使用后核验，当前不交付未签名 APK。
最终测试统计以本轮结果清单为准，不沿用历史或定向结果；未公开发布。
本轮完整回归 **15/16 组通过**，综合交互组 **134/136**；
其两处测试状态依赖修正后，仅运行受影响的两个完整设置场景，**53/53 通过**。
结果单独保存在 `.build/ui-polish-settings-targeted.json`，不覆盖完整日志或重跑全量。
Android 实机输入法与系统 WebView、Windows WebView2 和 macOS 原生渲染仍需相应设备确认。

### 历史：v2.3.0 版本升级与发布通道准备（2026-11-16）

2026-11-16，应用、关于页、更新检查、Windows 构建参数与 macOS 清单统一为 `2.3.0`；
Android 使用 versionName `2.3.0` / versionCode `6`，共用网页资源同步到 assets。
发布说明见 [v2.3.0](releases/v2.3.0.md)。该版本升级阶段未生成本地安装包。

完成版本提交后，将该提交合并并推送到 `main`，再创建指向同一提交的 `v2.3.0` 标签。
也可以在 GitHub 新建 Release 时创建该标签，Target 选择包含版本提交的 `main`。
当前 `.github/workflows/release.yml` 仅在 `v*` 标签推送后构建 Windows EXE/MSI、
macOS universal DMG/ZIP 和 Android APK，再上传五项附件与 `SHA256SUMS.txt`。
普通分支推送不会触发构建；发布标签后需等待三端与发布任务全部成功。

工作流当前使用 `prerelease: false`，标签构建成功后会自动发布正式 Release，
应用内更新检查可直接接收该版本。
发布准备脚本不会为 2.3.0 继承旧 2.2.0 的验收证据，最终构建结果以本次 Actions 为准。
版本一致性检查覆盖前端、Android 镜像与 versionCode、桌面构建参数和 macOS 锁文件。
该版本升级阶段完整离线回归的日志与退出状态清单保存为
`.build/version-2.3.0-final-verification.log` 和 `.build/version-2.3.0-final-results.json`。

## 历史记录：首个 v2.2.0 Release 准备

当时候选仓库为 `jiuxina/jian-translator`，候选版本为 `v2.2.0`。
2026-11-16 通过公开 GitHub REST API 只读核实：仓库可公开访问，
Release 和标签均为空，默认分支为 `main`，Git 仓库尚为空。
当时本地没有 Git remote，也没有本地标签。以下 v2.2.0 内容保留当时的准备状态和验收统计，
不代表上方本轮测试包的版本、签名或完成状态。

本次只进行发布准备，不创建远程 Release、不上传附件、不推送分支或标签。
建议先使用 `draft: true / prerelease: true / makeLatest: false`。
Release 文案见 [v2.2.0](releases/v2.2.0.md)；本地成套附件由
`scripts/prepare-release.mjs` 生成，使用规范英文文件名，避免误传历史包。

## 资产与版本

候选附件包含 Windows x64 EXE/MSI、macOS universal DMG/ZIP、Android APK、
专用 SHA-256 清单，另附本地审阅用的 Release 文案和来源清单。
macOS 包现在由 GitHub Actions 的 macOS 运行器构建，但仍未完成 Mac 实机验收。

Windows 的 Pake CLI 仍固定为 `3.18.0`；补丁器从应用清单读取 `2.2.0`，
只修改 Cargo `[package].version`，使 PE 字符串版本与应用、MSI 版本一致。
依赖版本和 CLI 自身版本不变。Android 为 versionCode 5 / versionName 2.2.0。
发布包与历史包使用独立输出目录，准备器拒绝覆盖已存在的目标目录。

本次 Windows 已在 `.build/release-first-v2.2.0-20261116/` 重建并实读属性：
EXE FileVersion、ProductVersion 和固定版本号均为 `2.2.0`，MSI ProductVersion 为 `2.2.0`。
两个文件的 Authenticode 状态均为 `NotSigned`。版本补丁的八项针对性测试通过。
本次构建只修改壳的版本元数据，前端和 Android APK 复用最终已核验资源。

## 发布前仍需完成的事项

1. 固定最终源码提交，再创建与该提交对应的 `v2.2.0` 标签；不得指向缺少待提交文档的旧 HEAD。
2. 保留并完成当前并行的 README、LICENSE、技术文档及 Mac 授权字段检查点。
   本任务不改写其许可证选择或暂存状态。
3. 核对第三方分发许可：当前 Windows 壳基于 Pake，模板 Cargo 清单声明
   `GPL-3.0-or-later`。项目根目录的 CC BY-NC-SA 声明不能自动替代该依赖的许可要求。
   应在公开分发前确认 Windows 衍生源码、构建方式和所需许可/通知的提供范围；
   本任务不擅自重授整个项目许可。
4. 完成 Windows DPI、窗口阴影、系统剪贴板和 Android WebView 的设备验收。
   当前证据支持预发布候选，不支持“所有平台稳定版验收完成”的声明。
5. 首发候选没有 Windows Authenticode 签名。Release 应明确来源与校验方式，
   不指示用户关闭安全保护。
6. 本地 Git remote 与目标公开仓库尚未关联，远程仓库仍无源码。
   本次不读取账号凭据或登录状态；实际上传时再使用用户授权的发布方式。

当前更新检查请求 `/repos/jiuxina/jian-translator/releases/latest`，
并拒绝 `draft/prerelease`。预发布不会触发应用的正式更新提示，
发布第一份正式版本后才进入此通道。

## 本地准备

在 Windows EXE/MSI 元数据核验及 Android 资源检查之后执行：

```powershell
node scripts/prepare-release.mjs --windows-dir .build/release-stage/windows --macos-dir .build/release-stage/macos --android output/笺-2.2.0-玻璃与更新.apk --out-dir output/first-release-v2.2.0-ready --revision cb53c70c40d8ede239d87def85782efe9a614abe
```

准备器只处理显式指定的构建资产、发布文案及当前提交号，生成：

- 五个规范命名的二进制附件；
- 只含三个附件的 `SHA256SUMS.txt`；
- `RELEASE_NOTES.md`；
- `release-manifest.json`，记录版本、草稿/预发布属性、文件大小、哈希和来源提交。

准备完毕后应将实际版本属性、文件哈希、验证结果和最终提交状态补入本记录。
如远程源码、许可证核对或设备验收仍未完成，应继续保持草稿状态。

准备器的清单记录“构建资产对应的来源提交”，不宣称该提交已完成发布门槛。
当前候选将引用本次版本修复检查点，最终首发标签应在并行文档/许可证提交完成后重新固定。
本地附件可审阅并复核；在完成上列事项前，不创建标签和公开 Release。

## 已准备的本地候选

最终审阅目录为 `output/first-release-v2.2.0-ready/`，包含三项规范附件、独立校验清单、
补入本次结果的发布说明和清单 JSON；先前 `output/first-release-v2.2.0/` 预览目录保留。
资产来源提交为 `cb53c70c40d8ede239d87def85782efe9a614abe`，并不包含尚未完成的并行许可证修改。

| 附件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `Jian-2.2.0-windows-x64.exe` | 9,447,424 | `2A2B4EB03FA4BFA1935B2C225818078CCB3730C1470E891AC69EC7FA5A06C23F` |
| `Jian-2.2.0-windows-x64.msi` | 4,313,088 | `1B402288008E68AD2AEAE61A2AC6774700930C717B7DA0D37A2B2DC1187B2C51` |
| `Jian-2.2.0-android.apk` | 3,560,624 | `47949887413D75C3FD1F94E706DF09AA85BF67DDA9C2D347EC596702B6D84AE8` |

准备工具的针对性检查覆盖文件内容/哈希、拒绝覆盖、重复参数、缺失输入、
硬链接别名和严格版本/提交格式；Python 版本补丁八项检查通过。
实际 PE/MSI 版本和三份附件哈希已核验；准备过程没有读取签名密钥、账号凭据或个人配置。

本任务完整验证仅在工具和文档完成后执行一次，日志为 `output/verify-first-release-final.log`。
它与上一任务的 97/107 结果分开记录；不能把两个任务的局部结果合并成一次全通过声明。

实际结果：浏览器 **140/142**，Rust **93/93**；光学数值、更新模块、Mac 资源与 IPC、
八项 Windows 版本补丁、附件准备与真实附件哈希均通过。
浏览器两项失败为测试本身的层级读取和跨场景状态遗留：
悬浮窗背景检查仍读取透明宿主而非光学背景层；更新保存继承了前一场景的延迟保存替身。
已修正这两处测试，后续只做两项定向验证，不重跑完整套件。
`output/verify-release-fixes-targeted.json` 记录两项定向结果均通过：
选图预览的实际光学背景层为非透明，更新开关保存后原生快照与本地偏好均为 `false`，
对话框关闭；没有 JavaScript 异常或外部请求。140/142 仍是本任务完整套件的实际统计。
