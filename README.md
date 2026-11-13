# DSH（DeepSeek Harness 智能体）· chiheiheideya 构建

> **DSH（DeepSeek Harness 智能体）** 是把这个应用带到这台手机上、并参与它开发的 AI 智能体。应用里的每一次读屏、点按、脚本与构建，它都在场 —— 名字就写在这里。

把开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）完整跑在 Android 手机上的个人构建：不需要 root、不需要电脑，装上 APK 就能让 AI 直接替你操作手机。

本仓库是 [`jackwener/DSH-Android`](https://github.com/jackwener/DSH-Android) 的**个人构建分支**（包名独立、可与官方版共存），在上游基础上增加了会话迁移导入、导出进度、权限提示记忆与中文思考约束。

---


## 更新记录（build 124）

- **导入/导出更稳**：会话导出每次写新目录（修复二次导出 EACCES）；导入会话改为系统选目录；整包导入不会卡死（小目录同步、大目录后台原子替换，引擎等恢复完成）。
- **数据恢复**：整包恢复跳过旧会话库与旧引擎日志；恢复后自动把 `shared_prefs` 里的旧包路径换成本包路径。
- **上下文策略**：关闭引擎自动压缩（`compaction-basic auto: false`）；接近上限时按人格规则先整理「可丢弃清单」并询问用户，而不是悄悄压缩。
- **权限优先级**：Dhizuku 可用时优先（如静默安装），否则回落 Shizuku。
- **安装检测**：关于页比对"已安装版本/运行版本"，静默安装后提示「重启应用」。
- **无障碍**：首次安装与每次更新后提示一次，并说明覆盖安装会让系统关闭无障碍服务。
- **主页浮条**：点「导入/导出 会话点我」直接进 设置 → 关于；「知道了」永久记住。
- **安全**：仓库与 APK 不含任何账号、API Key、Cookie 或签名文件；新装应用是全新状态，需要你自己登录。

## 一、和官方版有什么不同

| 能力 | 官方 `jackwener/DSH-Android` | 本项目 |
|---|---|---|
| 包名 | `io.github.jackwener.dsh` | **`com.dsh.chiheiheideya`**（独立安装、数据互不干扰，可与官方版共存） |
| 版本号 | `0.4.0` | **`0.4.0-chiheiheideya~N`**（每次 CI 构建递增） |
| 身份声明 | DSH | 系统提示词明确声明「这是 chiheiheideya 的构建，不是官方发布」 |
| **旧实例会话导入** | 无 | **有**：选一个「按会话分目录」的导出目录，自动结构修复（补 turn/end、重编 seq 连续、补消息 id、过滤残缺事件）后写入会话库，**选完立即生效，不用重启** |
| 导出全部会话 | 单个 `sessions-export.json`（大库容易 OOM 闪退） | **按会话分目录流式导出**（逐会话、逐页 500 条写 `session.json` + `events.jsonl`），内存恒定 |
| 导入/导出数据 | 无进度反馈，大目录像"卡住" | **有进度**：`正在导出 128/400MB` |
| Shizuku / Dhizuku 引导 | 每次回到首页都弹 | 点「暂不」后**持久记住**，不再打扰（设置→权限 仍可手动授权） |
| 检查更新 | 走官方仓库 | 走本仓库，**jsDelivr 镜像优先**（国内网络也能拿到清单） |
| 特权操作 | — | **Dhizuku 优先**（静默安装等），不可用时自动回落到 Shizuku |
| 权限引导 | 每次进首页都弹 | 只自动展示一次；App 更新后无障碍被系统关闭会提示一次 |
| 思考语言 | 模型自行决定（常混英文） | **系统提示词硬规则**：默认全过程用简体中文思考与回答，除非你明确要求换语言 |

> 右边这些差异都在本仓库源码里，可自行 diff 上游。

## 二、它能做什么

- **操作手机**：读屏、点按、输入、滑动；开 App、跳转页面、回复通知
- **系统设置**：亮度、音量、勿扰、闹钟、Wi‑Fi/蓝牙/移动数据、定位、媒体控制
- **文件**：查找、整理、移动、压缩解压、读 PDF/Word/Excel/PPT 文字
- **手机里自带 Linux 环境**：跑脚本、处理文件、写代码
- **自动化**：定时或在连接 Wi‑Fi、充电、收到通知等条件下触发
- **多模型**：DeepSeek 之外可接 OpenAI / Claude / Gemini / Kimi / GLM / 通义 / 火山 等
- **完整 dsh**：技能、MCP、子 agent、网页搜索原样可用（引擎未 fork，只加了 Android 侧插件）

## 三、安装

1. 到 [Releases](../../releases/latest) 下载最新 `app-debug.apk`（**debug 签名**，个人测试与分发用）
2. 安装后与官方版并存（包名不同，不会互相覆盖）
3. 打开后登录 DeepSeek 账号，或在 设置 → 模型服务 填自己的 API Key

> 仅支持 `arm64-v8a`、Android 10+。

## 四、使用教程

### 1. 从别的 DSH 实例搬会话过来
**方式 A（推荐，带结构修复）**
1. 旧实例导出后得到「按会话分目录」的结构：
   ```
   DSH-测试文件/
   ├── 会话A/session.json + events.jsonl
   └── 会话B/session.json + events.jsonl
   ```
2. 新机 → 设置 → 关于 → **导入数据（文件夹）** → 选中该目录
3. 提示「已导入 N 个会话」后**立即出现在列表**（无需重启）

**方式 B（整包迁移设置与文件）**
设置 → 关于 → 导出数据（文件夹）→ 在新机用同一个入口选中它 → 重启生效（会覆盖 `databases/files/shared_prefs`，先备份）。

### 2. 导出会话
设置 → 关于 → **导出全部会话（文件夹）** → 写到 `下载/DSH-chiheiheideya/sessions-export/<会话名>/`，可直接拿到另一个版本按「方式 A」导入。

### 3. 导出全部数据
设置 → 关于 → **导出数据（文件夹）** → 复制到 `下载/数据导出/`，过程中显示 `x/xxxMB` 进度。**注意**：里面含浏览器 Cookie 与 API Key 密文，别随意外发。

### 4. 权限
- **Shizuku**：解锁 Wi‑Fi/蓝牙/移动数据、系统设置、后台屏操作等
- **Dhizuku**：设备所有者级能力（管理应用、锁屏、禁摄像头），十分危险，按需授权
- 首页横幅点「暂不」后不再反复弹；想授权去 设置 → 权限

### 4.1 导入/导出（会话与数据分开）
- **导出会话（仅会话内容）**：设置 → 关于 →「导出会话」→ 写到 `下载/DSH-导出/sessions-export-<月日-时分>/`，每个会话一个子目录（session.json + events.jsonl）。每次导出都是新目录，不会覆盖上一次。
- **导入会话（仅会话内容）**：设置 → 关于 →「导入会话」→ **系统目录选择器里选导出目录**（或某个会话文件夹）→ 转换后立刻出现在列表，**不需要重启**。
- **导出数据（应用全部数据）**：设置、API Key、登录态、Cookie、插件与引擎数据（不含会话），写到 `下载/数据导出/`。
- **导入数据（应用全部数据）**：设置 → 关于 →「导入数据」→ 选整包目录 → 复制完提示「已暂存，重启应用后生效」；**应用会自动跳过会话库与旧引擎日志**（避免会话被清空、工作目录失效），会话请用上面的「导入会话」。

### 5. 从旧 DSH 实例整包迁移（含密钥与 Cookie）
旧实例里 设置 → 关于 → 导出数据（文件夹）后，会得到一个包含下列目录的文件夹：

```
数据导出/
├── databases/     会话库（dsh.db）
├── shared_prefs/  设置、登录态
├── files/         引擎会话日志、插件、附件、API Key（dsh-home）
└── app_webview/   浏览器 Cookie
```

**导入**：新机 → 设置 → 关于 →「导入数据（文件夹）」→ 选中该文件夹 → **把 App 划掉重开**（整包恢复在启动最早期执行）。
> ⚠️ 整包含 API Key/Cookie：只在自己的设备间转运；恢复会覆盖新机现有的 databases/shared_prefs/files。

只想搬会话、不动设置时：导出「按会话分目录」的结构（每个会话一个子目录，含 session.json + events.jsonl），用同一个入口选中即可，导入后立即可见。

### 6. 常见问题
| 现象 | 原因 / 处理 |
|---|---|
| 点开会话提示 `stored log is corrupt` | 该会话是「只读式导入」（历史可看、模型记忆不完整）；要在新实例继续聊 |
| 导入后列表没变化 | 目录里必须是「会话子目录含 `session.json` + `events.jsonl`」的结构 |
| 导出大目录像卡住 | 看进度文字；`数据导出` 复制几百 MB 属正常 |

## 五、自己构建

需要 JDK 17+、Android SDK（compileSdk 37.2 / NDK arm64）、Node 22+：

```bash
bash js/build-engine.sh                     # 产出 toolchains/out/engine/engine.zip
./gradlew :app:assembleDebug \
  -Pdsh.versionSuffix="-chiheiheideya~" \
  -Pdsh.idSuffix=".chiheiheideya"           # 想回官方包名就传 -Pdsh.idSuffix=
```

CI 见 [`.github/workflows/build-apk.yml`](.github/workflows/build-apk.yml)。keystore 由 CI 现场生成（仅 debug 用），仓库内**不含任何签名私钥、Cookie 或 API Key**。

## 六、开源引用与致谢

本构建完全建立在下列开源项目之上：

- **[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** — dsh 引擎本体（Apache-2.0）
- **[jackwener/DSH-Android](https://github.com/jackwener/DSH-Android)** — Android 外壳、JNI 启动器、设备插件与构建脚本（Apache-2.0）
- **[Cordis](https://github.com/cordiverse/cordis)** — 插件运行时
- **[Shizuku](https://github.com/RikkaApps/Shizuku)** — 免 root 的 shell 权限（打包分发其官方 APK）
- Node.js / pnpm / sharp / AndroidX / Compose 等各自许可

上游版权与许可条款原样保留（见 [LICENSE](LICENSE)）。本仓库改动同样以 Apache-2.0 发布。

**贡献与署名**
- 构建、测试与运维：**chiheiheideya**
- 会话迁移导入、流式导出、本 README：**DSH（DeepSeek Harness 智能体）**

## 七、隐私与安全

- 会话、附件、设置、密钥**只存在你自己的手机上**（`/data/user/0/com.dsh.chiheiheideya/`）
- 仓库与 Release **不含**签名私钥、Cookie、API Key、任何会话数据
- APK 为 **debug 签名**：适合自用与内测；正式分发请自行换签名
- 危险操作（shell、写文件、设备管理）默认走审批；完全权限模式需你主动开

## 八、许可

Apache-2.0，继承上游。
