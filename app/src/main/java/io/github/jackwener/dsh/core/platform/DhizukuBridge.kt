package io.github.jackwener.dsh.core.platform

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import com.rosan.dhizuku.api.Dhizuku
import com.rosan.dhizuku.api.DhizukuRequestPermissionListener
import com.rosan.dhizuku.api.DhizukuUserServiceArgs
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Dhizuku（设备所有者）桥——直接走 Dhizuku 接口。
 *
 * 授权后，DO 命令由 [DshDoService] 在 Dhizuku 进程内执行（UserService 模式）：
 * Dhizuku 加载我们的 Service 类并以设备所有者身份运行，里面直接调 DevicePolicyManager，
 * 不需要 cli 桥、不需要密钥。
 *
 * 这些权限十分危险，请谨慎使用。
 */
object DhizukuBridge {
    private const val PKG = "com.rosan.dhizuku"
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var doBinder: IBinder? = null
    @Volatile private var bound = false
    private var connection: ServiceConnection? = null
    private var boundArgs: DhizukuUserServiceArgs? = null

    fun isInstalled(c: Context): Boolean = try {
        c.packageManager.getPackageInfo(PKG, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    fun isReady(c: Context): Boolean = isInstalled(c) && try {
        Dhizuku.init(c)
    } catch (_: Throwable) {
        false
    }

    fun isGranted(): Boolean = try {
        Dhizuku.isPermissionGranted()
    } catch (_: Throwable) {
        false
    }

    fun requestPermission(context: Context, onResult: (Boolean) -> Unit) {
        when {
            !isReady(context) -> onResult(false)
            isGranted() -> { bindDo(context) {}; onResult(true) }
            else -> try {
                Dhizuku.requestPermission(object : DhizukuRequestPermissionListener() {
                    override fun onRequestPermission(grantResult: Int) {
                        val ok = grantResult == PackageManager.PERMISSION_GRANTED
                        if (ok) bindDo(context) {}
                        main.post { onResult(ok) }
                    }
                })
            } catch (_: Throwable) {
                onResult(false)
            }
        }
    }

    /**
     * Ensures the in-Dhizuku DO service is connected and suspends until the binder arrives.
     *
     * Tool calls run in the engine process and never go through the interactive 授权 flow, so a
     * granted-but-unbound state (the user ticked DSH in the Dhizuku app himself) used to leave
     * [doCommand] answering "未授权或未连接" forever. This is the lazy bind for that case.
     */
    suspend fun ensureBound(context: Context, timeoutMs: Long = 12_000): Boolean {
        if (doBinder != null) return true
        if (!isReady(context) || !isGranted()) return false
        val args = DhizukuUserServiceArgs(ComponentName(context, DshDoService::class.java))
        val waiter = CompletableDeferred<Boolean>()
        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                doBinder = service
                bound = service != null
                if (!waiter.isCompleted) waiter.complete(bound)
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                doBinder = null
                bound = false
            }
        }
        connection?.let { old ->
            runCatching {
                if (boundArgs != null) Dhizuku.unbindUserService(old) else context.unbindService(old)
            }
        }
        connection = conn
        boundArgs = args
        try {
            Dhizuku.startUserService(args)
        } catch (_: Throwable) {
        }
        val asked = try {
            Dhizuku.bindUserService(args, conn)
            true
        } catch (_: Throwable) {
            false
        }
        if (!asked) return false
        return withTimeoutOrNull(timeoutMs) { waiter.await() } ?: false
    }

    /** Connects the in-Dhizuku DO service (no-op when already bound); UI side, non-suspending. */
    fun bindDo(context: Context, onReady: (Boolean) -> Unit) {
        if (bound && doBinder != null) { onReady(true); return }
        if (!isReady(context) || !isGranted()) { onReady(false); return }
        val args = DhizukuUserServiceArgs(ComponentName(context, DshDoService::class.java))
        val conn = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                doBinder = service
                bound = service != null
                onReady(bound)
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                doBinder = null
                bound = false
            }
        }
        connection?.let { runCatching { context.unbindService(it) } }
        connection = conn
        boundArgs = args
        try {
            Dhizuku.startUserService(args)
        } catch (_: Throwable) {
        }
        try {
            Dhizuku.bindUserService(args, conn)
        } catch (_: Throwable) {
            onReady(false)
        }
    }

    /** Runs one DO command (see DshDoService for the command list); the result text. */
    fun doCommand(cmd: String, arg: String = ""): String {
        val b = doBinder
        if (b == null) return "failed: Dhizuku 未授权或未连接（设置 → 手机权限 → Dhizuku 设备所有者）"
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeString(cmd)
            data.writeString(arg)
            if (!b.transact(100, data, reply, 0)) "failed: transact returned false"
            else reply.readString() ?: "failed: empty reply"
        } catch (t: Throwable) {
            "failed: ${t.message ?: t.javaClass.simpleName}"
        } finally {
            data.recycle()
            reply.recycle()
        }
    }
}
