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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import io.github.jackwener.dsh.core.data.SessionEntity
import io.github.jackwener.dsh.core.designsystem.BtnSize
import io.github.jackwener.dsh.core.designsystem.BtnVariant
import io.github.jackwener.dsh.core.designsystem.DButton
import io.github.jackwener.dsh.core.designsystem.Dsh
import io.github.jackwener.dsh.core.designsystem.DTopBar
import io.github.jackwener.dsh.core.designsystem.DshType
import io.github.jackwener.dsh.feature.conversation.HomeViewModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 回收站：被删除的会话（只隐藏，数据还在），可恢复或彻底删除。 */
@Composable
fun RecycleBinScreen(onBack: () -> Unit, vm: HomeViewModel) {
    val c = Dsh.colors
    var items by remember { mutableStateOf<List<Pair<SessionEntity, Long>>>(emptyList()) }
    var reload by remember { mutableStateOf(0) }
    LaunchedEffect(reload) { items = runCatching { vm.recycleItems() }.getOrDefault(emptyList()) }
    val fmt = remember { SimpleDateFormat("MM-dd HH:mm", Locale.US) }
    Column(Modifier.fillMaxSize().background(c.bgBase)) {
        DTopBar("回收站", onBack)
        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("回收站是空的", style = DshType.s14, color = c.labelTertiary)
            }
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(items.size) { i ->
                    val (s, t) = items[i]
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.bgLayer1)
                        .padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(s.title.ifBlank { s.id }, style = DshType.s14, color = c.labelPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("删除于 " + fmt.format(Date(t)), style = DshType.xxs12, color = c.labelTertiary)
                        }
                        DButton("恢复", { vm.restoreFromRecycleBin(s.id); reload++ }, variant = BtnVariant.Outline, size = BtnSize.Sm)
                        Spacer(Modifier.padding(horizontal = 4.dp))
                        DButton("彻底删除", { vm.purgeFromRecycleBin(s.id); reload++ }, size = BtnSize.Sm)
                    }
                }
                item { Spacer(Modifier.height(16.dp)) }
            }
        }
    }
}
