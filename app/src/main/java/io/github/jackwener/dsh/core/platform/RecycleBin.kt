package io.github.jackwener.dsh.core.platform

import android.content.Context
import androidx.core.content.edit

/** 会话回收站：删除会话时只记录 id + 时间（数据先不删），可恢复或彻底删除。 */
object RecycleBin {
    private const val PREFS = "recycle_bin"

    fun entries(ctx: Context): Map<String, Long> =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).all.mapValues { (it.value as? Long) ?: 0L }

    fun add(ctx: Context, id: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { putLong(id, System.currentTimeMillis()) }
    }

    fun remove(ctx: Context, id: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit { remove(id) }
    }
}
