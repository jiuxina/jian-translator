# 首个 Release 准备记录

目标仓库为 `jiuxina/jian-translator`，候选版本为 `v2.2.0`。
2026-11-16 通过公开 GitHub REST API 只读核实：仓库可公开访问，
Release 和标签均为空，默认分支为 `main`，Git 仓库尚为空。
本地当前没有 Git remote，也没有本地标签。

本次只进行发布准备，不创建远程 Release、不上传附件、不推送分支或标签。
建议先使用 `draft: true / prerelease: true / makeLatest: false`。
Release 文案见 [v2.2.0](releases/v2.2.0.md)；本地成套附件由
`scripts/prepare-release.mjs` 生成，使用规范英文文件名，避免误传历史包。

## 资产与版本

候选附件只包含 Windows x64 EXE/MSI、Android APK、专用 SHA-256 清单；
另附本地审阅用的 Release 文案和来源清单。macOS 源码适配已完成，
但没有实际 Mac 构建与验收结果，因此本次不列 DMG/ZIP。

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
node scripts/prepare-release.mjs --windows-dir .build/release-first-v2.2.0-20261116 --android output/笺-2.2.0-玻璃与更新.apk --out-dir output/first-release-v2.2.0
```

准备器只处理显式指定的构建资产、发布文案及当前提交号，生成：

- 三个规范命名的二进制附件；
- 只含三个附件的 `SHA256SUMS.txt`；
- `RELEASE_NOTES.md`；
- `release-manifest.json`，记录版本、草稿/预发布属性、文件大小、哈希和来源提交。

准备完毕后应将实际版本属性、文件哈希、验证结果和最终提交状态补入本记录。
如远程源码、许可证核对或设备验收仍未完成，应继续保持草稿状态。
