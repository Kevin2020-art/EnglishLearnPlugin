# 🎧 EnglishLearnPlugin — 英语听力与中英双语字幕精听浏览器插件

一款基于 Chrome / Edge (Manifest V3) 的本地英语听力与中英双语字幕精听插件。专为英语分级阅读（如 RAZ / Reading A-Z）及日常精听跟读设计，基于精确到毫秒的时间戳（`.srt` / `.json`）实现单句跳转与双语对照学习。

---

## ✨ 核心功能

- **📂 灵活选择播放目录**
  - 使用现代本地文件系统接口（`window.showDirectoryPicker`），支持直接选择**单篇课文目录**（包含 `.mp3` 与字幕文件），也支持选择包含多个子目录的**总目录**（可在顶部下拉框一键切换不同课文）。
  - 自动记住上次选择的目录名称。
- **⏯ 完整的播放与单句控制**
  - 支持 **播放、暂停、继续、停止、上一句、下一句**。
  - 支持点击全文列表中的任意句子，直接跳转到该句开头播放。
  - 当前播放句子在大舞台卡片与全文列表中同步高亮，并自动平滑滚动到视野中央。
- **👁️ 中英文字幕独立显隐**
  - 支持独立切换 **显示/隐藏英文** 与 **显示/隐藏中文**（可自由组合为：中英双语、纯英文、纯中文、或全隐藏纯盲听模式）。
- **⏱️ 毫秒级 Whisper 词级时间戳 & 首音防截断补偿**
  - 支持使用 Apple Silicon 免费开源的 **`mlx-whisper`** 进行词级语音识别（Word-level Timestamps）并结合开口波形校准，一键生成精确到 `0.01s` 的 `subtitles.srt`。
  - 内置 `0.50s` 首音前置保护缓冲与 `0.18s` 尾部收尾缓冲，彻底消除爆破音/擦音（P, T, K, S, F, C）开头被截断吞音的问题。
  - 自动与目录内的中文 `.txt` 智能配对，即开即听，无需任何手工打轴。

---

## 📁 项目结构

```text
EnglishLearnPlugin/
├── plugin/                  # Chrome / Edge 浏览器插件源码 (Manifest V3)
│   ├── icons/               # 插件图标 (16x16, 48x48, 128x128)
│   ├── manifest.json        # 插件配置文件
│   ├── background.js        # 后台服务脚本（点击图标打开/聚焦播放器标签页）
│   ├── player.html          # 播放器主页面
│   ├── player.css           # 播放器界面样式
│   └── player.js            # 播放器核心控制、目录扫描与时间戳对齐逻辑
├── generate_timestamps.py   # 本地批量生成时间戳文件 (subtitles.srt / .json) 的 Python 工具
├── resources/               # 本地音频与字幕素材目录（已在 .gitignore 中忽略）
├── .gitignore
└── README.md
```

---

## 🚀 安装与使用方法

### 1. 在浏览器中加载插件
1. 打开 Chrome 或 Edge 浏览器，访问扩展程序管理页面：
   - Chrome：地址栏输入 `chrome://extensions/`
   - Edge：地址栏输入 `edge://extensions/`
2. 打开右上角的 **「开发者模式 (Developer mode)」**。
3. 点击左上角的 **「加载已解压的扩展程序 (Load unpacked)」**，选择本项目下的 `plugin` 文件夹。
4. 点击浏览器右上角工具栏中的插件图标，即可打开独立的 **英语双语精听播放器** 页面。

### 2. 加载课文目录播放（电脑端）
1. 点击页面左上角的 **「📁 选择目录 (电脑)」** 按钮。
2. 选择存放了 `.mp3` 与字幕文件的文件夹（例如 `resources`），在弹出的浏览器本地查看权限提示框中点击 **「允许」**。
3. 使用底部的控制栏进行播放、暂停、继续、停止、上一句/下一句切换，以及中英文字幕显隐切换。

### 3. 在手机上使用（iPhone / Android 如 Pixel 10a）
1. **打开播放器网页并安装到桌面（PWA 模式）**：
   - 将本项目推送到 GitHub 并开启 **GitHub Pages**（访问地址：`https://kevin2020-art.github.io/EnglishLearnPlugin/`）。
   - **iPhone (Safari)**：打开网址 -> 点击底部分享按钮 -> **「添加到主屏幕」**。
   - **Pixel 10a / Android (Chrome)**：打开网址 -> 点击右上角 `⋮` 菜单 -> **「添加到主屏幕」->「安装应用」**。
2. **选取课文文件播放**：
   - 点击页面顶部的 **「📱 选文件 (手机端)」**。
   - 在手机文件选择器（iCloud 云盘 / Google Drive / 本地存储）中进入某篇课文目录：
     - **已用脚本生成过 `.srt`**：只需同时勾选 **`xxx.mp3` + `subtitles.srt`** 两个文件即可 0 误差播放。
     - **尚未生成 `.srt`**：同时勾选 **`1 个 .mp3 + 2 个 .txt/.md`**，手机浏览器会在本地自动完成双语对齐与时间戳计算。

---

## 📂 `resources` 素材目录详细说明

由于音频（`.mp3`）及个人学习资料体积较大，`resources/` 目录已在 [.gitignore](file:///Users/dong/myLearn/EnglishLearnPlugin/.gitignore) 中设置为忽略，不纳入 Git 仓库跟踪。

### 1. 目录组织方式（支持两种结构）

插件同时支持 **单篇目录结构** 和 **多篇总目录结构**：

#### 方式 A：单篇目录（直接将素材放在 `resources/` 下）
```text
resources/
├── animals_in_the_ground.mp3      # 英文朗读音频（如通过 Chrome Audio Capture 录制）
├── Animals in the ground.txt      # 英文字幕纯文本
├── 地下的动物.txt                  # 中文字幕纯文本
├── subtitles.srt                  # [自动/脚本生成] 标准中英双语时间戳字幕文件
└── subtitles.json                 # [自动/脚本生成] JSON 格式时间戳数据文件
```

#### 方式 B：多篇总目录（在 `resources/` 下按课文分子文件夹）
```text
resources/
├── 01_Animals_in_the_ground/
│   ├── animals_in_the_ground.mp3
│   ├── Animals in the ground.txt
│   ├── 地下的动物.txt
│   └── subtitles.srt
└── 02_Another_Lesson/
    ├── lesson2.mp3
    ├── english.txt
    └── chinese.txt
```
> 当选择总目录时，插件会自动扫描所有包含 `.mp3` 的子文件夹，并在界面顶部显示**「当前目录课程」下拉框**，方便随时切换不同课文。

### 2. 素材文件命名与格式要求

1. **音频文件（`.mp3`）**：
   - 每个课文文件夹内放置 1 个 `.mp3` 文件（文件名任意）。
   - 支持使用 **Chrome Audio Capture** 等工具从在线阅读网站（如 RAZ / Reading A-Z）内录保存的音频。
2. **中英文字幕文件（2 个 `.txt` 或 `.md` 文件）**：
   - **同时支持 `.txt` 和 `.md`（Markdown）文件**：你可以放纯文本 `.txt`，也可以直接放带格式的 `.md` 文件（插件与脚本会自动清理 `# 标题`、`**加粗**`、`> 引用`、`- 列表` 等 Markdown 语法符号）。
   - **文件名无需固定**：插件会自动检测文件内容中的中文字符占比，智能区分哪个是英文字幕、哪个是中文字幕。
   - **格式与切分规则**：
     - 英文文本按句末标点（`.`、`?`、`!`）自动切分为自然句（自动保护 `6.7` 等数字中的小数点不被误切）。
     - 中文文本按句末标点（`、` 除外，以 `。`、`？`、`！`、`：` 为边界）自动切分为自然句。
     - 建议保持中英文文件拆句后的**总句数一一对应**，以便获得最佳的双语对齐效果。
   - **漏标点自动修补与对齐**：中英句子按长度比例、数字锚点和段落位置动态对齐。如果某处英文漏了句号（例如 `Look down There are...`），程序会自动根据对应中文句子的长度比例与英文大写/句首词边界，**直接补上句号拆成独立句子**并分别对齐音频时间戳，无需手动修改原 `.txt` 文件。
3. **时间戳文件（`subtitles.srt` / `subtitles.json`，可选但推荐）**：
   - 记录每一句精确到毫秒的 `[开始时间, 结束时间]` 以及对应的中英文句子。
   - 若目录中已存在 `subtitles.srt` 或 `subtitles.json`，插件会直接读取，实现 **0 误差** 的上下句跳转与高亮同步。

### 3. 如何制作新课文并生成毫秒级精准时间戳？（推荐工作流）

本工具集成了 Apple Silicon (M 系列芯片) 免费开源的 **`mlx-whisper` 词级语音识别** 与 **`mlx-lm` 本地大模型自动英译中**。首次使用前只需安装一次（永久免费、纯离线）：
```bash
/Users/dong/anaconda3/bin/pip install mlx-whisper mlx-lm
```

#### 极简一步制作流程（只需放 1 个 `.mp3` 文件！）

1. **第 1 步（放入音频）**：新建课文文件夹，只需放入录好的 `xxx.mp3`（无需准备英文 `.txt` 或中文 `.txt`；如果您已有现成的 `.txt` 也可以一起放入）。
2. **第 2 步（一键转写英文 + 自动翻译中文 + 生成双语毫秒级时间戳）**：
   在终端运行：
   ```bash
   /Users/dong/anaconda3/bin/python3 /Users/dong/myLearn/EnglishLearnPlugin/generate_timestamps.py "你的课文文件夹路径"
   ```
   - 脚本会自动完成全部工作：
     1. 使用 `mlx-whisper` 识别每个英文单词的发音时间，自动按停顿分段生成 **`xxx.txt`（纯英文文本）**；
     2. 使用 `mlx-lm`（默认调用 `mlx-community/Qwen2.5-3B-Instruct-4bit`）结合全文语境，将英文 **1 对 1 翻译为中文**，自动保存 **`xxx_zh.txt`（纯中文文本）**，天然 100% 句数对齐；
     3. 直接输出合成好的中英双语 **`subtitles.srt`** 和 **`subtitles.json`**，在电脑或手机端打开播放器即可 0 误差播放！

#### 其他常用命令参数
```bash
# 1. 默认扫描并处理 ./resources 及其所有子目录
/Users/dong/anaconda3/bin/python3 generate_timestamps.py

# 2. 对指定目录按“句”生成精准时间戳（默认：先按回车符锁死段落，段内再分句）
/Users/dong/anaconda3/bin/python3 generate_timestamps.py "/Users/dong/Library/Mobile Documents/com~apple~CloudDocs/2026/RAZ/ThingsMove"

# 3. 对指定目录按“回车符（整段）”生成时间戳（一段/绘本一页作为一条字幕）
/Users/dong/anaconda3/bin/python3 generate_timestamps.py "/Users/dong/Library/Mobile Documents/com~apple~CloudDocs/2026/RAZ/ThingsMove" --by-newline
```

---

## ⌨️ 键盘快捷键

| 按键 | 功能 |
| :--- | :--- |
| `Space` (空格键) | **播放 / 暂停 / 继续** |
| `←` (左方向键) | 跳转到 **上一句** 并播放 |
| `→` (右方向键) | 跳转到 **下一句** 并播放 |
| `Esc` | **停止播放** 并复位 |

