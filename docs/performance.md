# 性能优化记录

2026-11-16，基于 `34f1cc1` 的源码进行优化，应用版本保持 `2.2.0`。
文本、图片、音节、长文、设置、壁纸、快捷键和各端桥接均保留。
液态玻璃的光学公式、640 边长 / 360000 像素贴图上限、折射、高光、
三层渐进模糊、按压变化和原有动画参数保持原样。

## 实现

`web/liquid-glass.js` 将尺寸与圆角读取集中到同一帧的读取阶段，再统一更新滤镜。
首次挂载也进入该队列，使用未受弹窗缩放动画影响的本地 border box。
未变化的 SVG 属性与 CSS 属性跳过写入；CSS 值同时记录请求字符串和浏览器序列化值，
避免小数模糊半径经过 CSSOM 舍入后被误判为变化，同时仍可恢复外部样式修改。

光学贴图照常生成和 PNG 编码，缓存仅保留尺寸、半径、最大位移和 PNG 地址。
编码后的 RGBA 数组不再被缓存与表面状态长期引用。公开 `generateMaps()` 的完整返回值保留。
节点观察器只修复被直接替换内容的玻璃表面；删除表面或其祖先时再清理注册表，
普通流式文本变化不再触发全表面扫描。

`web/app.js` 的语言轮盘先一次性添加候选测量节点，再统一读取实际字体排版宽度，
保留列表顺序、滚动方向、时长与宽度限制。字体和字距每次从当前按钮读取。
流式译文仍逐帧淡入，动画落定后合并相邻文本节点；停止与校正会清理对应监听、
定时器和待执行帧。动画事件乱序到达时，正在淡入的片段仍保留原位置。

Android 将相册图片的解码、EXIF 旋转、JPEG 压缩、Base64 编码和 JS 参数转义移到后台；
拍照确认图也在既有后台执行器解码。1600 px 采样上限、JPEG 85、确认动画、
闪光灯、切换镜头和重拍行为保留。UI 线程仅交付结果与更新界面。
Activity 销毁和后续原生请求会使旧任务失效，过期确认图会回收。

图片选择桥新增 `pickImageWithToken(token)`，保留 `pickImage()` 兼容入口。
新请求立即取消旧导入，原生交付携带请求 token；网页只接受匹配且尚未消费的结果。
文本图片另校验 `imageSeq`，保证用户随后清空、删除或替换图片后，旧解码结果无法覆盖新状态。
同一图片选择桥供翻译和壁纸使用，token 也防止旧翻译图片误交付给后续壁纸回调。

`web/` 是前端唯一源码；本轮已同步 Android 的六项 assets。macOS 和 Windows 使用同一源码。

## 测量

在 Windows、Node.js `22.19.0`、无界面 Chrome `157.0.8103.51`、
1180 × 900 / DPR 1 的独立测试上下文中运行 `tests/verify-performance.mjs`。
原版使用修改前保存的六项网页源码，优化版使用当前源码，均启用完整液态玻璃和动画。
文本、配置和剪贴板均为合成数据，外部请求被拦截。

| 场景与指标 | 原版 | 优化后 |
| --- | ---: | ---: |
| 启动布局次数（LayoutCount） | 125 | 39 |
| 启动 bounding rect 读取次数 | 284 | 23 |
| 12 轮相同配置 + 刷新：SVG 属性写入 | 17400 | 0 |
| 12 轮相同配置 + 刷新：bounding rect 读取 | 1044 | 0 |
| 活跃表面保留的原始贴图字节 | 7407040 | 0 |
| 跨多项语言选择的布局次数 | 32 | 11 |
| 10000 字译文落定后的文本节点 | 147 | 1 |
| 10000 字译文过程的 computed style 读取 | 152 | 6 |

原始贴图数组减少约 7.06 MiB。58 个已生成玻璃表面的尺寸、最大位移与
displacement / specular 两份 PNG SHA-256 全部相同；基线与优化版合成截图均已实际查看。
非默认渐进模糊强度 `4` 的重复刷新也达到零 SVG / CSS 写入，外部修改的层样式能够恢复。
实际调节六项卡片玻璃参数时，SVG / CSS 正常变化，几何 PNG 保持复用。

这些是一次同场景测量的操作计数与指定缓存占用，耗时会随设备、缓存和浏览器调度变化。
完整采样含 ScriptDuration、TaskDuration 等数值，保存在：

- `.build/performance-comparison-baseline.json`
- `.build/performance-comparison-optimized.json`
- `.build/performance-baseline.png`
- `.build/performance-optimized.png`

## 验证与复现

最小验证：

```powershell
node tests/verify-stream-writer.mjs
node tests/verify-image-import.mjs
```

前者运行真实 writer，覆盖乱序动画落定、万字文本的前缀与完整性、校正、取消、
旧回调和动态减少动画；后者运行真实图片选择处理，覆盖清空、删除、替换、
跨用途过期交付、重复回填与旧原生桥兼容。

启动当前源码预览：

```powershell
node tests/serve-preview.mjs web 8897
```

另外启动独立 Chrome，仅使用新建的测试目录与本地调试端口：

```powershell
Start-Process -FilePath 'C:/Program Files/Google/Chrome/Application/chrome.exe' `
  -ArgumentList '--headless=new','--remote-debugging-address=127.0.0.1',`
    '--remote-debugging-port=9235','--user-data-dir=F:/xm/translator/.build/performance-profile-20261116',`
    '--no-first-run','--no-default-browser-check','--disable-background-networking',`
    '--disable-extensions','about:blank' -WindowStyle Hidden
$env:IT_PREVIEW_ORIGIN = 'http://127.0.0.1:8897'
$env:IT_CDP_ORIGIN = 'http://127.0.0.1:9235'
node tests/verify-performance.mjs
```

浏览器与项目路径需按本机调整。测试用 `Target.createBrowserContext` 与独立 session
操作自己创建的页面，不枚举其他标签，不读取真实用户浏览器配置。
`IT_PERFORMANCE_SCREENSHOT` 可指定合成页面截图路径，
`IT_PERFORMANCE_REPORT` 可指定 JSON 报告路径。
对旧源码运行时增加 `--baseline`，它保留功能断言并记录旧版开销。
随后比较报告内 `maps.surfaces` 的尺寸、最大位移和两份 PNG 哈希。

最后一次全量回归需在代码、资源与文档完成后执行，包含
`verify-liquid-glass`、`verify-stream-writer`、`verify-image-import`、
`verify-performance`、`verify-motion`、`verify-updates`、
`verify-macos`、`verify-release-preparation` 和 `verify-desktop-patch`。
macOS 回归前先运行 `node app/macos/build.mjs --prepare-only`。
浏览器回归的语言轮盘方向验证使用受控动画时钟，避免跨进程固定延时采样错过动画。

Android 已在 `.build/android-performance-validation` 的独立无签名工程中通过
`compileDebugJavaWithJavac --offline`。该工程复制公开源码和依赖声明，
使用相同 SDK 与依赖版本，未读取原工程签名文件、keystore 或本机配置。
原构建脚本会在配置阶段读取签名属性，验证时使用隔离工程可以避开此依赖。
最终 Android 构建前同步六项网页资源，并将 `ANDROID_USER_HOME` 指向隔离目录内的新文件夹。
当前 Windows 环境的离线回归与编译覆盖共享界面和原生代码，Mac 原生运行、
Android 实机图片交互与 Windows WebView2 帧率仍需相应平台的运行测量。
