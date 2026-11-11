package io.github.jackwener.dsh.core.platform

import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.ProxyInfo
import android.os.Binder
import android.os.Parcel
import com.rosan.dhizuku.api.Dhizuku
import java.io.File

/**
 * Device Owner 执行服务：由 Dhizuku 的服务器进程通过反射实例化（UserService 模式），因此在这里调
 * DevicePolicyManager 就是设备所有者身份，不需要任何桥或密钥。
 *
 * Dhizuku 的 UserService.startService 会：
 *  1. `service.getInterfaceDescriptor()` —— **必须非空**，否则它内部 requireNonNull 失败、整个
 *     startService 静默返回 null（这正是 dhizuku_* 工具一直报"未授权或未连接"的原因）；
 *  2. `transact(FIRST_CALL_TRANSACTION + 1)` = code 2 作为 onStart、`+2` = code 3 作为 onStop；
 *  3. 之后客户端用 code>=100 直接 transact 执行命令（读入 cmd 与 arg，写回结果）。
 */
class DshDoService(private val mContext: Context?) : Binder() {

    /** Must be a stable, non-null token: Dhizuku writes it as the interface token. */
    override fun getInterfaceDescriptor(): String = DESCRIPTOR

    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        when (code) {
            // Dhizuku's lifecycle pokes: FIRST_CALL_TRANSACTION + 1 / + 2.
            2, 3, 1 -> return true
            in 100..199 -> {
                val cmd = data.readString() ?: ""
                val arg = data.readString() ?: ""
                reply?.writeString(run(cmd, arg))
                return true
            }
        }
        return super.onTransact(code, data, reply, flags)
    }

    companion object {
        const val DESCRIPTOR = "io.github.jackwener.dsh.core.platform.IDshDoService"
    }

    private fun dpm(): DevicePolicyManager? =
        mContext?.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager

    /**
     * The device owner component. [Dhizuku.getOwnerComponent] only works in the client app's process;
     * this code runs inside Dhizuku's own process, where the API has no client and returns null — so
     * ask the DevicePolicyManager of this process instead (hidden API, called reflectively).
     */
    private fun admin(): ComponentName? {
        runCatching { Dhizuku.getOwnerComponent() }.getOrNull()?.let { return it }
        return runCatching {
            val m = dpm() ?: return@runCatching null
            val o = Class.forName("android.app.admin.DevicePolicyManager")
                .getMethod("getDeviceOwnerComponentOnAnyUser")
                .invoke(m)
            o as? ComponentName
        }.getOrNull() ?: runCatching {
            val m = dpm() ?: return@runCatching null
            val o = Class.forName("android.app.admin.DevicePolicyManager")
                .getMethod("getDeviceOwnerComponentOnCallingUser")
                .invoke(m)
            o as? ComponentName
        }.getOrNull()
    }

    private fun run(cmd: String, arg: String): String {
        val m = dpm()
        if (m == null) return "failed: no context"
        val a = admin()
        if (a == null) return "failed: no device owner component"
        return try {
            when (cmd) {
                "ping" -> "Success: Dhizuku DO ready"
                "lock_now" -> { m.lockNow(); "Success" }
                "camera_off" -> { m.setCameraDisabled(a, true); "Success" }
                "camera_on" -> { m.setCameraDisabled(a, false); "Success" }
                "screencap_off" -> { m.setScreenCaptureDisabled(a, true); "Success" }
                "screencap_on" -> { m.setScreenCaptureDisabled(a, false); "Success" }
                "hide" -> { m.setApplicationHidden(a, arg, true); "Success" }
                "unhide" -> { m.setApplicationHidden(a, arg, false); "Success" }
                "suspend" -> { m.setPackagesSuspended(a, arrayOf(arg), true); "Success" }
                "resume" -> { m.setPackagesSuspended(a, arrayOf(arg), false); "Success" }
                "block_uninstall" -> { m.setUninstallBlocked(a, arg, true); "Success" }
                "unblock_uninstall" -> { m.setUninstallBlocked(a, arg, false); "Success" }
                "screen_timeout" -> {
                    val sec = arg.toLongOrNull() ?: 0L
                    m.setMaximumTimeToLock(a, if (sec <= 0) Long.MAX_VALUE else sec * 1000)
                    "Success"
                }
                "grant" -> { m.setPermissionGrantState(a, arg.substringBefore(" "), arg.substringAfter(" ", ""), DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED); "Success" }
                "deny" -> { m.setPermissionGrantState(a, arg.substringBefore(" "), arg.substringAfter(" ", ""), DevicePolicyManager.PERMISSION_GRANT_STATE_DENIED); "Success" }
                "perm_default" -> { m.setPermissionGrantState(a, arg.substringBefore(" "), arg.substringAfter(" ", ""), DevicePolicyManager.PERMISSION_GRANT_STATE_DEFAULT); "Success" }
                "proxy" -> {
                    val host = arg.substringBefore(":"); val port = arg.substringAfter(":", "7890").toIntOrNull() ?: 7890
                    m.setRecommendedGlobalProxy(a, ProxyInfo.buildDirectProxy(host, port)); "Success"
                }
                "proxy_clear" -> { m.setRecommendedGlobalProxy(a, null); "Success" }
                "stay_on" -> { m.setGlobalSetting(a, android.provider.Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "3"); "Success" }
                "stay_off" -> { m.setGlobalSetting(a, android.provider.Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "0"); "Success" }
                "list_hidden", "list_suspended", "list_blocked" -> {
                    val pm = mContext!!.packageManager
                    // Hidden packages are disabled for the user, so getInstalledApplications(0)
                    // never returns them (list_hidden was always empty). MATCH_UNINSTALLED_PACKAGES
                    // includes them, and keeps suspended/blocked lists complete too.
                    val flags = android.content.pm.PackageManager.MATCH_UNINSTALLED_PACKAGES
                    val pkgs = pm.getInstalledApplications(flags).map { it.packageName }
                    val which = when (cmd) {
                        "list_hidden" -> pkgs.filter { runCatching { m.isApplicationHidden(a, it) }.getOrDefault(false) }
                        "list_suspended" -> pkgs.filter { runCatching { m.isPackageSuspended(a, it) }.getOrDefault(false) }
                        else -> pkgs.filter { runCatching { m.isUninstallBlocked(a, it) }.getOrDefault(false) }
                    }
                    which.joinToString(",").ifBlank { "（无）" }
                }
                "install_apk" -> installApk(arg)
                else -> "failed: unknown command $cmd"
            }
        } catch (t: Throwable) {
            "failed: ${t.message ?: t.javaClass.simpleName}"
        }
    }

    /**
     * Silent APK install. This code runs inside the Dhizuku process (device owner), which holds
     * MANAGE_EXTERNAL_STORAGE, so it can read the APK straight from /sdcard. The session is created
     * by the device owner, so the system installs it without the 安装 confirmation dialog.
     */
    private fun installApk(path: String): String {
        val ctx = mContext ?: return "failed: no context"
        val f = File(path)
        if (!f.exists()) return "failed: 文件不存在 $path"
        if (f.length() <= 0L) return "failed: 文件为空 $path"
        val pm = ctx.packageManager
        val pkg = pm.getPackageArchiveInfo(path, 0)?.packageName ?: return "failed: 无法解析 APK（$path）"
        val before = runCatching { pm.getPackageInfo(pkg, 0).versionName }.getOrNull()
        val installer = pm.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(pkg)
            setSize(f.length())
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                val out = session.openWrite("base.apk", 0L, f.length())
                try {
                    f.inputStream().use { input -> input.copyTo(out) }
                    session.fsync(out)
                } finally {
                    runCatching { out.close() }
                }
                // PackageInstaller rewrites the status Intent before sending it (adds status + message),
                // so the PendingIntent MUST be mutable — Android 12+ rejects an immutable one with
                // "The commit() status receiver should come from a mutable PendingIntent".
                val status = Intent("com.rosan.dhizuku.INSTALL_STATUS").setPackage("com.rosan.dhizuku")
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val pi = PendingIntent.getBroadcast(ctx, sessionId, status, flags)
                session.commit(pi.intentSender)
            }
        } catch (t: Throwable) {
            runCatching { installer.abandonSession(sessionId) }
            return "failed: 创建安装会话失败（${t.message ?: t.javaClass.simpleName}）"
        }
        val deadline = System.currentTimeMillis() + 90_000
        while (System.currentTimeMillis() < deadline) {
            val now = runCatching { pm.getPackageInfo(pkg, 0).versionName }.getOrNull()
            if (now != null && now != before) return "Success: 已安装 $pkg $now"
            if (now == null && runCatching { pm.getPackageInfo(pkg, 0) }.isSuccess) return "Success: 已安装 $pkg"
            Thread.sleep(700)
        }
        val still = runCatching { pm.getPackageInfo(pkg, 0).versionName }.getOrNull()
        return if (still != null && still != before) "Success: 已安装 $pkg $still"
        else "failed: 安装超时（90 秒内没看到 $pkg 装上，可能系统仍在确认或安装被拦）"
    }
}
