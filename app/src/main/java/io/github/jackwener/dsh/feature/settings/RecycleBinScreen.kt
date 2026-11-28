package io.github.jackwener.dsh.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.jackwener.dsh.R
import io.github.jackwener.dsh.core.data.SessionEntity
import io.github.jackwener.dsh.core.designsystem.BtnSize
import io.github.jackwener.dsh.core.designsystem.BtnVariant
import io.github.jackwener.dsh.core.designsystem.DButton
import io.github.jackwener.dsh.core.designsystem.DDialog
import io.github.jackwener.dsh.core.designsystem.Dsh
import io.github.jackwener.dsh.core.designsystem.DshType
import io.github.jackwener.dsh.core.designsystem.IconBtn
import io.github.jackwener.dsh.core.designsystem.SettingsRow
import io.github.jackwener.dsh.feature.conversation.HomeViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 回收站：被删除的会话（只隐藏，数据还在），可恢复或彻底删除；右上角可多选。 */
@Composable
fun RecycleBinScreen(onBack: () -> Unit, vm: HomeViewModel) {
    val c = Dsh.colors
    var items by remember { mutableStateOf<List<Pair<SessionEntity, Long>>>(emptyList()) }
    var reload by remember { mutableStateOf(0) }
    var multi by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    // 待确认操作：id -> true=彻底删除，false=恢复
    var confirmPurge by remember { mutableStateOf<String?>(null) }
    var confirmRestore by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(reload) { items = runCatching { vm.recycleItems() }.getOrDefault(emptyList()) }
    val fmt = remember { SimpleDateFormat("MM-dd HH:mm", Locale.US) }

    Column(Modifier.fillMaxSize().background(c.bgBase)) {
        // 顶栏：左上角返回放大到 44dp，右侧多选/完成
        Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, top = 4.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            IconBtn(R.drawable.dsw_arrow_left, onBack, size = 44.dp, iconSize = 22.dp, tint = c.labelPrimary, contentDescription = "返回")
            Spacer(Modifier.width(4.dp))
            Text("回收站", Modifier.weight(1f), style = DshType.l20, color = c.labelPrimary)
            if (items.isNotEmpty()) {
                DButton(if (multi) "完成" else "多选", {
                    multi = !multi
                    if (!multi) selected = emptySet()
                }, variant = BtnVariant.Outline, size = BtnSize.Sm)
            }
        }
        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("回收站是空的", style = DshType.s14, color = c.labelTertiary)
            }
        } else {
            LazyColumn(Modifier.weight(1f).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(items.size) { i ->
                    val (s, t) = items[i]
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.bgLayer1)
                        .clickable(enabled = multi) { selected = if (s.id in selected) selected - s.id else selected + s.id }
                        .padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        if (multi) {
                            Box(Modifier.size(18.dp).clip(CircleShape).background(if (s.id in selected) c.info else c.borderL2), contentAlignment = Alignment.Center) {
                                if (s.id in selected) Text("✓", style = DshType.tiny10, color = c.labelOnPrimary)
                            }
                            Spacer(Modifier.width(10.dp))
                        }
                        Column(Modifier.weight(1f)) {
                            Text(s.title.ifBlank { s.id }, style = DshType.s14, color = c.labelPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("删除于 " + fmt.format(Date(t)), style = DshType.xxs12, color = c.labelTertiary)
                        }
                        if (!multi) {
                            DButton("恢复", { confirmRestore = s.id }, variant = BtnVariant.Outline, size = BtnSize.Sm)
                            Spacer(Modifier.width(6.dp))
                            DButton("彻底删除", { confirmPurge = s.id }, variant = BtnVariant.Danger, size = BtnSize.Sm)
                        }
                    }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
            if (multi && selected.isNotEmpty()) {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DButton("恢复选中（" + selected.size + "）", {
                        selected.forEach { vm.restoreFromRecycleBin(it) }
                        selected = emptySet(); reload++
                    }, variant = BtnVariant.Outline, size = BtnSize.Md)
                    DButton("彻底删除选中（" + selected.size + "）", {
                        selected.forEach { vm.purgeFromRecycleBin(it) }
                        selected = emptySet(); reload++
                    }, variant = BtnVariant.Danger, size = BtnSize.Md)
                }
            }
        }
    }
    confirmRestore?.let { id ->
        DDialog({ confirmRestore = null }, "恢复这个会话？", buttons = {
            DButton("取消", { confirmRestore = null }, variant = BtnVariant.Outline)
            DButton("恢复", { vm.restoreFromRecycleBin(id); confirmRestore = null; reload++ })
        }) { Text("它会回到会话列表，聊天记录都在。", style = DshType.xs13, color = c.labelSecondary) }
    }
    confirmPurge?.let { id ->
        DDialog({ confirmPurge = null }, "彻底删除？", buttons = {
            DButton("取消", { confirmPurge = null }, variant = BtnVariant.Outline)
            DButton("彻底删除", { vm.purgeFromRecycleBin(id); confirmPurge = null; reload++ }, variant = BtnVariant.Danger)
        }) { Text("会话和聊天记录会被永久删除，无法恢复。", style = DshType.xs13, color = c.labelSecondary) }
    }
}
