package io.github.jackwener.dsh.core.capability.tools

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jackwener.dsh.core.capability.CallContext
import io.github.jackwener.dsh.core.capability.Tool
import io.github.jackwener.dsh.core.capability.ToolResult
import io.github.jackwener.dsh.core.capability.ToolSet
import io.github.jackwener.dsh.core.capability.reqStr
import io.github.jackwener.dsh.core.capability.str
import io.github.jackwener.dsh.core.model.Risk
import io.github.jackwener.dsh.core.model.ToolGroup
import io.github.jackwener.dsh.core.platform.DhizukuBridge
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 设备所有者（Dhizuku）工具——直接走 Dhizuku 接口（UserService 模式，代码在 Dhizuku 进程内
 * 以设备所有者身份执行），不需要 cli 桥或密钥。
 *
 * 这些权限十分危险，请谨慎使用：每个调用都会真实改变设备状态（隐藏/挂起应用、禁用摄像头或
 * 截屏、锁屏、改权限、阻止卸载、全局代理、静默装包），且大多不可撤销。只在用户明确要求时使用。
 */
@Singleton
class DhizukuTools @Inject constructor(@ApplicationContext private val context: Context) : ToolSet {
    private val danger = "【十分危险，请谨慎使用】"

    private suspend fun run(cmd: String, arg: String = ""): ToolResult = withContext(Dispatchers.IO) {
        // Lazy bind: the engine process never runs the interactive 授权 flow, and a user who ticked
        // DSH inside the Dhizuku app leaves the DO user service unconnected.
        if (!DhizukuBridge.ensureBound(context)) {
            return@withContext ToolResult.error("dhizuku_failed",
                "Dhizuku 未授权或未连接（设置 → 手机权限 → Dhizuku 设备所有者）")
        }
        val out = DhizukuBridge.doCommand(cmd, arg)
        if (out.startsWith("failed")) ToolResult.error("dhizuku_failed", out)
        else ToolResult.text(out)
    }

    private fun t(name: String, group: ToolGroup, risk: Risk, desc: String,
                  schema: io.github.jackwener.dsh.core.capability.SchemaBuilder.() -> Unit,
                  block: suspend (JsonObject, CallContext) -> ToolResult) =
        object : Tool(name, group, risk, false, danger + desc, schema) {
            override suspend fun invoke(args: JsonObject, call: CallContext): ToolResult = block(args, call)
        }

    override val tools = listOf(
        t("dhizuku_lock", ToolGroup.System, Risk.dangerous, "锁屏（立即锁屏）。", {}) { _, _ -> run("lock_now") },
        t("dhizuku_camera", ToolGroup.System, Risk.dangerous, "禁用或恢复摄像头。", { bool("disabled", "true = 禁用，false = 恢复", required = true) }) { a, _ ->
            val off = a["disabled"]?.toString()?.contains("true") == true
            run(if (off) "camera_off" else "camera_on")
        },
        t("dhizuku_screencap", ToolGroup.System, Risk.dangerous, "禁止或允许截屏。", { bool("disabled", "true = 禁止，false = 允许", required = true) }) { a, _ ->
            val off = a["disabled"]?.toString()?.contains("true") == true
            run(if (off) "screencap_off" else "screencap_on")
        },
        t("dhizuku_hide_app", ToolGroup.Apps, Risk.dangerous, "隐藏或恢复一个应用。", {
            string("package", "应用包名", required = true); bool("hide", "true = 隐藏，false = 恢复", required = true)
        }) { a, _ ->
            val pkg = a.reqStr("package"); val hide = a["hide"]?.toString()?.contains("true") == true
            run(if (hide) "hide" else "unhide", pkg)
        },
        t("dhizuku_suspend_app", ToolGroup.Apps, Risk.dangerous, "挂起或恢复一个应用。", {
            string("package", "应用包名", required = true); bool("suspend", "true = 挂起，false = 恢复", required = true)
        }) { a, _ ->
            val pkg = a.reqStr("package"); val sus = a["suspend"]?.toString()?.contains("true") == true
            run(if (sus) "suspend" else "resume", pkg)
        },
        t("dhizuku_block_uninstall", ToolGroup.Apps, Risk.dangerous, "阻止或允许卸载一个应用。", {
            string("package", "应用包名", required = true); bool("block", "true = 阻止卸载，false = 允许", required = true)
        }) { a, _ ->
            val pkg = a.reqStr("package"); val blk = a["block"]?.toString()?.contains("true") == true
            run(if (blk) "block_uninstall" else "unblock_uninstall", pkg)
        },
        t("dhizuku_screen_timeout", ToolGroup.System, Risk.dangerous, "设置最大息屏时间（秒，0 = 恢复默认）。", { int("seconds", "秒，0 = 清除", required = true) }) { a, _ ->
            run("screen_timeout", a["seconds"]?.toString() ?: "0")
        },
        t("dhizuku_grant_permission", ToolGroup.Apps, Risk.dangerous, "授予/撤销/重置一个应用的运行时权限。", {
            string("package", "应用包名", required = true); string("permission", "权限名，如 android.permission.CAMERA", required = true); string("action", "grant | deny | default", required = true)
        }) { a, _ ->
            val pkg = a.reqStr("package"); val perm = a.reqStr("permission"); val act = a.str("action") ?: "grant"
            run(when (act) { "deny" -> "deny"; "default" -> "perm_default"; else -> "grant" }, "$pkg $perm")
        },
        t("dhizuku_proxy", ToolGroup.System, Risk.dangerous, "设置或清除全局代理。", {
            string("host", "代理地址，如 127.0.0.1:7890（空 = 清除）")
        }) { a, _ ->
            val host = a.str("host")?.trim().orEmpty()
            run(if (host.isEmpty()) "proxy_clear" else "proxy", host)
        },
        t("dhizuku_stay_on", ToolGroup.System, Risk.dangerous, "充电时常亮开关。", { bool("enabled", "true = 常亮，false = 关闭", required = true) }) { a, _ ->
            val on = a["enabled"]?.toString()?.contains("true") == true
            run(if (on) "stay_on" else "stay_off")
        },
        t("dhizuku_status", ToolGroup.System, Risk.read, "查询 Dhizuku 状态和 DO 列表。", { string("what", "ping | hidden | suspended | blocked", required = true) }) { a, _ ->
            val w = a.str("what") ?: "ping"
            run(when (w) { "hidden" -> "list_hidden"; "suspended" -> "list_suspended"; "blocked" -> "list_blocked"; else -> "ping" })
        },
        t("dhizuku_install_apk", ToolGroup.System, Risk.dangerous, "用设备所有者权限静默安装一个 APK（不会弹系统安装确认框）。args: APK 的绝对路径，例如 /sdcard/Download/base.apk；执行前先确认文件存在。", {
            string("path", "APK 文件绝对路径", required = true)
        }) { a, _ -> run("install_apk", a.reqStr("path")) },
    )
}
