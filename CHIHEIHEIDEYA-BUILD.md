# chiheiheideya 构建：会话迁移导入 + 品牌标识

本次改动**只改源码，未构建、未安装**（构建环境不在手机上）。

## 一、改动清单

| 文件 | 改动 |
|---|---|
| `app/build.gradle.kts` | ① `applicationId` 默认加 `.chiheiheideya` 后缀（可用 `-Pdsh.idSuffix=` 覆盖，传空串去掉）② `versionName` 默认后缀 `-chiheiheideya~`（可 `-Pdsh.versionSuffix=` 覆盖，CI 的 `-dev$BUILD_NO` 依然有效）③ 新增 `BuildConfig.BUILD_TAG = "chiheiheideya~"` |
| `app/src/main/AndroidManifest.xml` | `taskAffinity` / `RUN_TASK` action 改成 `${applicationId}` 占位，随包名变化 |
| `app/src/main/res/values/strings.xml` | `app_name` → `DSH · chiheiheideya`；新增 `about_build_tag`（备用，尚未接到关于页 UI） |
| `js/packages/bundle-android/cordis.patch.yml` | `system-prompt.personaPrefix` 加入构建身份：被问起时回答「这是 chiheiheideya 的 DSH-Android 构建（tag chiheiheideya~），不是官方发布」 |
| `js/packages/plugin-guard/session-import.js` | **新增**：会话迁移导入器（结构修复 + seq 重编号 + zstd 分帧 + 附件对象去重），注册 SDK 方法 `android/session/import` |
| `js/packages/plugin-guard/index.js` | 挂载导入器（`setupSessionImport`） |
| `app/.../core/data/Database.kt` | `SessionDao.insertEvents(List<EventEntity>)` 批量插入 |
| `app/.../core/session/SessionStore.kt` | 启动后调用 `android/session/import`，把结果写进会话库，处理完的目录改名 `import-sessions-done-<ts>` |
| `app/.../core/platform/DataTransfer.kt` | 「导入数据（文件夹）」识别**按会话分目录**的导出（子目录含 `session.json`+`events.jsonl`），改投递到 `$DSH_HOME/android/import-sessions`，不再整包覆盖 `databases/files` |

## 二、会话导入怎么用
1. 设置 → 关于 → 导入数据（文件夹），选中**按会话分目录**的全量导出目录（每个子目录一个会话）。
2. 重启 App：启动后 SessionStore 让引擎侧转换并发起落库。
3. 会话列表出现这些会话，标题 = 目录名，历史完整可读。

**已知局限**：这类导出只含 App 事件库快照（信封字段与部分 `turn/end`、`tool/result`、`compaction/*` 事件缺失），导入器会做结构修复，但默认 **`writeLog=false`** —— 只保证「看得见」，不写引擎日志，因此**不保证能带着旧上下文继续聊**；要尝试续聊可把调用参数 `writeLog` 改 true，风险是个别旧事件仍过不了新版严格校验（届时该会话说 `stored log is corrupt`）。

## 三、构建（不安装）
```bash
# 1) 先重建引擎（改了 js/packages）
bash js/build-engine.sh                 # 产出 toolchains/out/engine/engine.zip

# 2) 打 APK（默认已带 chiheiheideya 标识）
./gradlew assembleDebug                 # 或 assembleRelease（需 dsh.signing.* 属性）
# 显式传参等价写法：
./gradlew assembleDebug -Pdsh.versionSuffix="-chiheiheideya~" -Pdsh.idSuffix=".chiheiheideya"
adb install  # ← 不要执行，本次要求不安装
```
- 新包名 `io.github.jackwener.dsh.chiheiheideya`，与官方 `.dev` 包**可并存**；数据互不共享（导入用上面的会话导入）。
- 想恢复官网包名：`-Pdsh.idSuffix=`（空串）；想只改版本号：`-Pdsh.versionSuffix="-chiheiheideya~"`。

## 四、未验证（本机没有 JDK/Android SDK/NDK）
- Kotlin 改动**未编译**：`SessionStore.kt` 的导入代码只用了文件里已有的 import 与 `JsonRpcPeer.request`；`DataTransfer.kt` 的 `return@runCatching count` 为 `Result<Int>`。
- `session-import.js` / `index.js` 已过 `node --check`，`importSessions()` 已在真数据（5 个会话）上 dry-run 通过。
- 引擎 zip 未重建、APK 未构建、未签名、未安装。
