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
- **桌面小功能**：Windows 和 macOS 支持快捷键唤起与划词悬浮窗。

翻译服务来自 [bilibili Index-Translate](https://github.com/bilibili/Index-Translate) 的官方公开 API。
本项目是非官方客户端，与哔哩哔哩没有隶属关系。

## 📱 界面一览

主界面提供“文本”“音节”“长文”三个模式，分别显示原文和译文。
文本模式支持添加图片，原文和译文均可选择复制。
界面采用液态玻璃交互控件与磨砂面板，可调整主题、字体、壁纸和动画。

电脑点击左上角“笺”，手机点击右下角齿轮图标，可以进入设置和关于页。
设置修改后即时生效并自动保存在本机；需要搜索语言时，点击语言列表中的搜索框即可。

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

1. 打开应用，选择“文本”“音节”或“长文”模式；翻译图片时，在文本模式点击“图片”。
2. 选择源语言和目标语言；不确定时可以先粘贴内容再调整。
3. 点击“翻译”，等待右侧出现结果。
4. 点击“复制”保存译文；长文还能直接下载结果。

翻译期间可以切换模式，三个模式各自运行。“取消”保留已经完整翻译的内容，
“清空”清除当前模式的输入与结果。流式中断或译文截断会显示失败提示；请缩短原文后重试。
Android 长文通过系统文件选择器打开、保存；重建后的文档恢复要求 UTF-8 文本，最大 8 MB。

> 想改变主题、字体、壁纸、玻璃质感或翻译偏好，请进入“设置”。修改即时应用并自动保存，
> 无需再点保存；“恢复本组默认”只重置当前分组。

## ⌨️ 常用桌面功能

| 功能 | Windows 快捷键 | macOS 快捷键 | 说明 |
| --- | --- | --- | --- |
| 显示主窗口 | `Ctrl+Alt+I` | `Cmd+Alt+I` | 从任何位置快速唤起应用 |
| 划词翻译 | `Ctrl+Alt+T` | `Cmd+Alt+T` | 选中文本后呼出悬浮窗 |
| 打开设置 | `Ctrl+,` | `Cmd+,` | macOS 支持系统标准快捷键 |

默认快捷键可在设置中查看和调整。关闭窗口通常会保留托盘；完全退出请使用系统托盘或应用菜单。
使用划词翻译时，先选中文本再按快捷键，悬浮窗会显示等待状态并逐步呈现译文。

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

开发、构建和维护说明见 [技术文档](docs/technical.md)。

## 📄 开源协议

本项目采用 **Creative Commons BY-NC-SA 4.0** 协议发布。

你可以自由共享和改编，但需要署名、不得用于商业目的，并且改编内容必须以相同协议发布。
完整条款见 [LICENSE](LICENSE)。

## 👨‍💻 作者

**jiuxina**

如果这个项目对你有帮助，欢迎点一个 Star ⭐。
