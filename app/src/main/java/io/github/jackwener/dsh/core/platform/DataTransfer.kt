package io.github.jackwener.dsh.core.platform

import android.content.Context
import android.net.Uri
import android.os.Environment
import android.provider.DocumentsContract
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * 数据导出 / 导入（文件夹）。
 *
 * 导出：把 databases、shared_prefs、files、app_webview 复制到 Download/数据导出（同名结构），
 * 里面有全部会话库、设置、插件、API Key 和浏览器 Cookie。
 *
 * 导入：设置 → 关于 →「导入数据（文件夹）」选中该目录；先复制到 files/restore-staging 并写标记，
 * 真正落盘在下一次进程启动最早期（DshApp.onCreate 开头，Room / SharedPreferences 都还没打开），
 * 不会写坏正在使用的数据库。app_webview 只在导出侧包含，导入不覆盖（WebView 已启动时覆盖会崩）。
 */
object DataTransfer {

    /** 复制进度（设置页显示「128/400MB」）。 */
    data class Progress(val label: String, val done: Long, val total: Long)

    /** 正在进行的复制进度，null = 空闲。 */
    val progress = MutableStateFlow<Progress?>(null)

    private const val STAGING = "restore-staging"
    private const val PENDING = "restore-pending"
    private val EXPORT_SECTIONS = listOf("databases", "shared_prefs", "files", "app_webview")
    private val IMPORT_SECTIONS = listOf("databases", "shared_prefs", "files")

    /** 导出到 Download/数据导出，返回 (目录, 文件数)。边复制边更新 [progress]（几 GB 时也能看到 128/400MB）。 */
    fun exportToDownloads(ctx: Context): Result<Pair<String, Int>> = runCatching {
        val root = ctx.filesDir.parentFile ?: error("找不到应用数据目录")
        val out = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "数据导出")
        if (!out.exists() && !out.mkdirs()) error("无法创建 " + out.absolutePath)
        val total = EXPORT_SECTIONS.sumOf { sizeOf(File(root, it)) }
        progress.value = Progress("正在导出", 0, total)
        try {
            var count = 0
            var done = 0L
            var lastTick = 0L
            for (section in EXPORT_SECTIONS) {
                val src = File(root, section)
                if (!src.exists()) continue
                val dst = File(out, section)
                dst.mkdirs()
                count += copyTree(src, dst) { bytes ->
                    done += bytes
                    if (done - lastTick > 4L * 1024 * 1024) { lastTick = done; progress.value = Progress("正在导出", done, total) }
                }
            }
            if (count == 0) error("没有可导出的数据")
            progress.value = Progress("正在导出", total.coerceAtLeast(done), total.coerceAtLeast(done))
            out.absolutePath to count
        } finally {
            progress.value = null
        }
    }

    /** 目录总字节数（进度分母）。 */
    private fun sizeOf(dir: File): Long {
        if (!dir.exists()) return 0
        val files = dir.listFiles() ?: return 0
        var n = 0L
        for (f in files) n += if (f.isDirectory) sizeOf(f) else f.length()
        return n
    }

    /** 把用户选中的目录整棵复制到暂存区，返回复制的文件数。 */
    fun stageFromTree(ctx: Context, treeUri: Uri): Result<Int> = runCatching {
        val rootId = DocumentsContract.getTreeDocumentId(treeUri)
        val staging = File(ctx.filesDir, STAGING)
        if (staging.exists()) staging.deleteRecursively()
        if (!staging.mkdirs()) error("无法创建暂存目录")
        var count = 0
        var bytes = 0L
        progress.value = Progress("正在读取导入数据", 0, 0)
        collect(ctx, treeUri, rootId, staging) { n ->
            count++
            bytes += n
            if (count % 8 == 0) progress.value = Progress("正在读取导入数据", bytes, 0)
        }
        if (count == 0) { progress.value = null; error("该文件夹里没有文件") }
        // 按会话分目录的全量导出（每个子目录有 session.json + events.jsonl）：不是整包数据，
        // 交给引擎侧转换后由 SessionStore 落库，不覆盖 databases/files。
        // SAF 在不同 ROM 上可能把「选中的目录本身」也复制成一层（staging/<目录名>/<会话>/…），
        // 所以先找到真正装会话目录的那一层，再只把那几个会话复制过去。
        val sessionRoot = findSessionExportRoot(staging)
        if (sessionRoot != null) {
            val target = File(ctx.filesDir, "dsh-home/android/import-sessions").apply { mkdirs() }
            val dirs = sessionRoot.listFiles().orEmpty().filter {
                it.isDirectory && File(it, "session.json").isFile && File(it, "events.jsonl").isFile
            }
            for (d in dirs) {
                val to = File(target, d.name)
                if (to.exists()) runCatching { to.deleteRecursively() }
                copyInto(d, to)
            }
            staging.deleteRecursively()
            progress.value = null
            return@runCatching dirs.size
        }
        File(ctx.filesDir, PENDING).writeText(staging.absolutePath)
        progress.value = null
        count
    }

    private fun collect(ctx: Context, treeUri: Uri, dirId: String, out: File, onFile: (Long) -> Unit) {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
        )
        ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                if (name == "." || name == "..") continue
                val mime = c.getString(2)
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    val dir = File(out, name)
                    dir.mkdirs()
                    collect(ctx, treeUri, id, dir, onFile)
                } else {
                    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)
                    val input = ctx.contentResolver.openInputStream(docUri) ?: continue
                    var copied = 0L
                    input.use { i -> File(out, name).outputStream().use { o ->
                        val buf = ByteArray(64 * 1024)
                        while (true) { val r = i.read(buf); if (r <= 0) break; o.write(buf, 0, r); copied += r }
                    } }
                    onFile(copied)
                }
            }
        }
    }

    /** 进程启动最早期调用：有暂存数据就覆盖回应用数据目录。 */
    fun applyPending(ctx: Context) {
        val marker = File(ctx.filesDir, PENDING)
        if (!marker.exists()) return
        val staging = File(ctx.filesDir, STAGING)
        if (!staging.isDirectory) {
            marker.delete()
            return
        }
        val dataRoot = ctx.filesDir.parentFile ?: run {
            marker.delete()
            return
        }
        for (section in IMPORT_SECTIONS) {
            val src = File(staging, section)
            if (!src.exists()) continue
            val dst = File(dataRoot, section)
            dst.mkdirs()
            for (f in src.listFiles().orEmpty()) copyInto(f, File(dst, f.name))
        }
        staging.deleteRecursively()
        marker.delete()
        ctx.getSharedPreferences("data_transfer", Context.MODE_PRIVATE)
            .edit().putBoolean("restored", true).apply()
    }

    /** 找到「按会话分目录」的导出根（最多向下两层，兼容 SAF 把选中目录也复制一层的情况）。 */
    private fun findSessionExportRoot(root: File, depth: Int = 0): File? {
        val files = root.listFiles().orEmpty()
        if (files.any { it.isDirectory && File(it, "session.json").isFile && File(it, "events.jsonl").isFile }) return root
        if (depth >= 2) return null
        for (dir in files.filter { it.isDirectory }) findSessionExportRoot(dir, depth + 1)?.let { return it }
        return null
    }

    private fun copyTree(src: File, dst: File, onBytes: (Long) -> Unit = {}): Int {
        var n = 0
        for (f in src.listFiles().orEmpty()) {
            val target = File(dst, f.name)
            if (f.isDirectory) {
                target.mkdirs()
                n += copyTree(f, target, onBytes)
            } else {
                val copied = runCatching {
                    target.parentFile?.mkdirs()
                    var bytes = 0L
                    f.inputStream().use { i -> target.outputStream().use { o ->
                        val buf = ByteArray(64 * 1024)
                        while (true) { val r = i.read(buf); if (r <= 0) break; o.write(buf, 0, r); bytes += r }
                    } }
                    bytes
                }.getOrDefault(0L)
                if (copied > 0L) { onBytes(copied); n++ }
            }
        }
        return n
    }

    private fun copyInto(src: File, dst: File) {
        if (src.isDirectory) {
            dst.mkdirs()
            for (f in src.listFiles().orEmpty()) copyInto(f, File(dst, f.name))
        } else {
            runCatching {
                dst.parentFile?.mkdirs()
                src.inputStream().use { i -> dst.outputStream().use { o -> i.copyTo(o) } }
            }
        }
    }
}
