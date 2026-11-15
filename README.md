# 笺

Windows、Android 与网页共用的翻译界面。`web/` 是当前界面、主题和交互的源码；
Windows 通过 Pake/Tauri 加载本地页面，Android 使用 WebView 加载同一份资源。

## 本地验证

需要 Node.js 22 或以上以及 Chrome。无需安装前端依赖。

```powershell
node tests/serve-preview.mjs web 8899
```

另开独立 Chrome 调试会话，指定 `--remote-debugging-port=9223` 和位于 `.build/` 的
独立 `--user-data-dir`，然后执行：

```powershell
node tests/verify-motion.mjs
```

回归使用本地桥接替身并拦截外部请求，不调用翻译接口。界面设计、验证记录和历史成品说明见
[docs/ui-theme.md](docs/ui-theme.md)。
`IT_CDP_ORIGIN` 可指定其他 Chrome 调试地址，`IT_PREVIEW_ORIGIN` 可指定其他本地预览地址。
当前完整离线回归包含 66 项检查。

## Windows 构建

需要 Git Bash、Node.js、Rust MSVC 工具链及 WebView2。当前补丁针对 **Pake 3.18.0**；
将该版本安装在 `.build/npm-global`，仅在构建进程设置 `npm_config_prefix` 指向该目录，
再用 Git Bash 执行 `app/rebuild.sh`。补丁应用器会把 `desktop/` 的源码复制到本地 Pake 模板。

```powershell
$env:npm_config_prefix = "$PWD/.build/npm-global"
$env:IT_OUT_DIR = "$PWD/.build/release-stage"
& 'D:\Program Files\Git\usr\bin\bash.exe' app/rebuild.sh
```

Git Bash 安装位置因机器而异，使用本机实际路径。默认构建输出在 `output/`；设置 `IT_OUT_DIR`
可把产物写到隔离目录，正在运行的桌面程序可以继续工作。

## Android 构建

需要 JDK 17、Android SDK 35 和 Gradle wrapper。`android/local.properties` 仅存本机 SDK
路径；发布签名从 `android/signing.properties` 读取，可参考同目录的 example。密钥和真实
签名配置均不入库。缺少签名配置时仍可执行 Debug 编译，Release 打包需要完整本地配置。

先用 PowerShell `Copy-Item` 将 `web/` 中前端资源覆盖至 `android/app/src/main/assets/`，
校验一致后，在 `android/` 执行：

```powershell
.\gradlew.bat -g ..\.build\gradle-home :app:assembleRelease -x syncWebAssets --offline --console=plain
```

历史 `syncWebAssets` 任务会删除目标目录，因此此处使用覆盖同步并跳过该任务。
当前发布版本为 Android versionCode `4` / versionName `2.1.0`，Windows 安装包版本 `2.1.0`。

## 版本管理

源码、资源、Gradle wrapper、文档和测试入库。依赖缓存、构建目录、发布二进制、预览媒体、
本机配置与签名文件保留在工作区但由 Git 忽略。`output/SHA256SUMS.txt` 记录发布包校验值。
