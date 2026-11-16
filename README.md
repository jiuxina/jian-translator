<div align="center">
  <img src="app/icon.png" alt="笺图标" width="112">
  <h1>笺</h1>
  <p><strong>一款好看又好用的翻译工具，支持 Windows、macOS、Android 和网页。</strong></p>
  <p>
    <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform Windows">
    <img src="https://img.shields.io/badge/platform-macOS-black" alt="Platform macOS">
    <img src="https://img.shields.io/badge/platform-Android-green" alt="Platform Android">
    <img src="https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey" alt="License CC BY-NC-SA 4.0">
  </p>
</div>

## ✨ 它能做什么

- **文本翻译**：输入或粘贴一段话，选择语言后点击翻译；最多支持 8000 字。
- **图片翻译**：拍照、选图或粘贴截图，识别画面里的文字并翻译。
- **长文翻译**：打开 `.txt` 或 `.md` 文件，自动分段翻译并拼成完整译文。
- **音节控制**：把译文控制在指定的音节数附近，适合字幕、配音和歌词。
- **个性化外观**：提供浅色、深色、主题色、壁纸、字体、交互控件液态玻璃和磨砂面板设置。
- **桌面小功能**：Windows 和 macOS 支持快捷键唤起；Windows 还提供划词悬浮窗。

翻译服务来自 [bilibili Index-Translate](https://github.com/bilibili/Index-Translate) 的官方公开 API。
本项目是非官方客户端，与哔哩哔哩没有隶属关系。

## 📱 界面一览

应用主界面分为“文本”“音节”“长文”三个模式；左右两栏分别放原文和译文，底部按钮负责清空与翻译。
电脑点击左上角“笺”，手机点击右下角齿轮图标，可以进入个性化设置和关于页。
底部导航和齿轮使用透明玻璃，内容卡片使用低开销的静态磨砂。
打开语言列表不会自动弹出键盘，需要搜索时再点搜索框。

## 📦 安装

### Windows

1. 打开 [Releases](https://github.com/jiuxina/jian-translator/releases)。
2. 下载 `.exe` 免安装版，或下载 `.msi` 安装版。
3. 双击运行；如果 Windows 提醒未知发布者，选择“仍要运行”。

### Android

1. 打开 [Releases](https://github.com/jiuxina/jian-translator/releases)。
2. 下载最新 `.apk`。
3. 允许安装来自此来源的应用；使用拍照翻译时授权相机权限。

### macOS

1. 打开 [Releases](https://github.com/jiuxina/jian-translator/releases)。
2. 下载适用于 Mac 的 `.dmg` 或 `.zip`。
3. 首次打开时按 macOS 提示允许运行；使用划词功能时授权辅助功能与自动化权限。

### 网页版

`web/index.html` 需要通过本地静态服务器在 Chromium 系浏览器中打开；部分界面效果和桌面端可能有差异。

## 🚀 快速上手

1. 打开应用，选择“文本”“图片”“音节”或“长文”模式。
2. 选择源语言和目标语言；不确定时可以先粘贴内容再调整。
3. 点击“翻译”，等待右侧出现结果。
4. 点击“复制”保存译文；长文还能直接下载结果。

> 想改变主题、字体、壁纸、玻璃质感或翻译偏好，请进入“设置”。这里的大部分调整会保存在本机。

## ⌨️ 常用桌面功能

| 功能 | Windows 快捷键 | macOS 快捷键 | 说明 |
| --- | --- | --- | --- |
| 显示主窗口 | `Ctrl+Alt+I` | `Cmd+Alt+I` | 从任何位置快速唤起应用 |
| 划词翻译 | `Ctrl+Alt+T` | `Cmd+Alt+T` | 选中文本后呼出悬浮窗 |
| 打开设置 | `Ctrl+,` | `Cmd+,` | macOS 支持系统标准快捷键 |

默认快捷键可在设置中查看和调整。关闭窗口通常会保留托盘；完全退出请使用系统托盘或应用菜单。

## 🧩 权限说明

| 平台 | 权限 / 授权 | 用途 |
| --- | --- | --- |
| Android | 相机 | 在应用内拍摄待翻译图片 |
| Android | 网络 | 连接翻译接口 |
| Windows | 本机设置与剪贴板 | 保存外观偏好、支持划词结果复制 |
| macOS | 辅助功能、System Events | 仅在触发划词翻译时捕获选中文本 |
| macOS | 通知或登录项授权 | 快捷键、托盘和开机启动相关能力按需申请 |

应用不会上传你的壁纸、设置或本机文档；只有你主动提交翻译的内容会发送到翻译接口。

## 🤝 参与贡献

欢迎报告问题、提出功能建议或提交 Pull Request。普通用户可以直接在
[Issues](https://github.com/jiuxina/jian-translator/issues) 中描述使用的平台、步骤和看到的结果。

开发者文档、构建流程、测试记录和历史实现说明已整理到
[技术文档](docs/technical.md)；界面细节另见
[界面主题记录](docs/ui-theme.md)。

推送到 `main` 或 `v*` 标签会自动构建 Windows、macOS 和 Android 安装包；标签构建会
自动发布 GitHub Release 并附带安装包、Windows 便携 EXE 和 SHA-256 校验清单。

## 📄 开源协议

本项目采用 **Creative Commons BY-NC-SA 4.0** 协议发布。

你可以自由共享和改编，但需要署名、不得用于商业目的，并且改编内容必须以相同协议发布。
完整条款见 [LICENSE](LICENSE)。

## 👨‍💻 作者

**jiuxina**

如果这个项目对你有帮助，欢迎点一个 Star ⭐。
