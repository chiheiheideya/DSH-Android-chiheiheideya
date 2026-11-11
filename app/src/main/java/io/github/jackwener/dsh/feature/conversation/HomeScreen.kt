package io.github.jackwener.dsh.feature.conversation

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateListOf
import io.github.jackwener.dsh.core.designsystem.BtnSize
import io.github.jackwener.dsh.core.designsystem.BtnVariant
import io.github.jackwener.dsh.core.designsystem.DButton
import io.github.jackwener.dsh.core.designsystem.DDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.github.jackwener.dsh.core.designsystem.DInput
import io.github.jackwener.dsh.core.session.Block
import io.github.jackwener.dsh.core.session.Turn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import io.github.jackwener.dsh.core.designsystem.LocalReducedMotion
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.jackwener.dsh.R
import io.github.jackwener.dsh.core.data.Settings
import io.github.jackwener.dsh.core.designsystem.Dsh
import io.github.jackwener.dsh.core.designsystem.DshType
import io.github.jackwener.dsh.core.designsystem.IconBtn
import io.github.jackwener.dsh.core.designsystem.Radius
import io.github.jackwener.dsh.core.designsystem.Segmented
import io.github.jackwener.dsh.core.designsystem.Tag
import io.github.jackwener.dsh.core.designsystem.Tone
import io.github.jackwener.dsh.core.designsystem.Whale
import io.github.jackwener.dsh.core.session.Conversation
import io.github.jackwener.dsh.core.session.SessionLive
import io.github.jackwener.dsh.feature.trajectory.TrajectoryView
import kotlinx.coroutines.launch

/**
 * The single home screen: the conversation, with the dsh sidebar as a modal drawer and a
 * 对话 / 轨迹 toggle for the same session.
 */
@Composable
fun HomeScreen(vm: HomeViewModel, onSettings: (String?) -> Unit, onAutomation: () -> Unit) {
    val c = Dsh.colors
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val sessions by vm.sessions.collectAsStateWithLifecycle()
    val status by vm.rowStatus.collectAsStateWithLifecycle()
    val currentId by vm.currentId.collectAsStateWithLifecycle()
    // Transient layers close before Back leaves home (BackHandlerAllowlistTest): the open drawer.
    BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
    // Back in front with a conversation open (e.g. from the launcher after a background run): it is seen now.
    LifecycleResumeEffect(currentId) { vm.markSeen(); onPauseOrDispose {} }
    ModalNavigationDrawer(
        drawerState = drawer,
        scrimColor = c.scrim,
        drawerContent = {
            ModalDrawerSheet(Modifier.width(300.dp), drawerShape = RoundedCornerShape(topEnd = 20.dp, bottomEnd = 20.dp),
                drawerContainerColor = c.sidebar, drawerTonalElevation = 0.dp, windowInsets = androidx.compose.foundation.layout.WindowInsets(0)) {
                SessionDrawer(
                    sessions, status, currentId,
                    onNew = { vm.newSession(null); scope.launch { drawer.close() } },
                    onOpen = { vm.open(it); scope.launch { drawer.close() } },
                    onAutomation = { scope.launch { drawer.close() }; onAutomation() },
                    onSettings = { section -> scope.launch { drawer.close() }; onSettings(section) },
                    onClose = { scope.launch { drawer.close() } },
                    onRename = vm::rename, onPin = vm::pin, onMute = vm::mute, onDelete = vm::delete,
                    onDshModify = { scope.launch { drawer.close() }; vm.openDshModify() },
                    searchHits = vm.searchHits.collectAsStateWithLifecycle().value,
                    onSearch = vm::searchSessions,
                )
            }
        },
    ) {
        ConversationPane(vm, onMenu = { scope.launch { drawer.open() } }, onSettings = onSettings, onAutomation = onAutomation)
    }
}

@Composable
private fun ConversationPane(vm: HomeViewModel, onMenu: () -> Unit, onSettings: (String?) -> Unit, onAutomation: () -> Unit) {
    val c = Dsh.colors
    val live by vm.live.collectAsStateWithLifecycle()
    val conv by vm.conversation.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    val view by vm.view.collectAsStateWithLifecycle()
    val prefill by vm.prefill.collectAsStateWithLifecycle()
    val composer = rememberComposerState(live.sessionId)
    LaunchedEffect(prefill, live.sessionId) {
        if (live.sessionId == vm.id) prefill?.let { composer.text = it; vm.prefill.value = null }
    }
    val empty = conv.isEmpty && !live.running
    // …and 轨迹, a view of the same session (not a page): Back returns to 对话.
    BackHandler(view == SessionView.Trajectory) { vm.view.value = SessionView.Chat }
    // While the run waits on the user (approval / question / permission / takeover card) nothing is
    // happening, so stop the "working" animations: the UI settles to idle, which also lets
    // accessibility services and UI automation read the card's buttons.
    var chatSearch by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val toastContext = androidx.compose.ui.platform.LocalContext.current
    /** Sensitive strings found before an export; non-null while the confirm dialog is up. */
    var privacyHits by remember { mutableStateOf<List<String>?>(null) }
    // 构建页: import a Markdown transcript next to the search icon.
    val importMd = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            val n = vm.importMarkdown(uri)
            if (n <= 0) android.widget.Toast.makeText(toastContext, "导入失败：文件无法解析", android.widget.Toast.LENGTH_SHORT).show()
            else android.widget.Toast.makeText(toastContext, "已导入 " + n + " 条消息，正在让模型读取", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
    val waitingOnUser = live.approval != null || live.question != null || live.permission != null || live.takeover != null
    CompositionLocalProvider(LocalReducedMotion provides (LocalReducedMotion.current || waitingOnUser)) {
    Column(Modifier.fillMaxSize().background(c.bgBase).statusBarsPadding()) {
        // 权限引导：进入应用时提示一次（Dhizuku 在上，Shizuku 在下），可"暂不"；
        // 点"暂不"后**持久记住**（以前只存在 remember 里，每次回首页又弹出来）。
        // 想再看到：设置 → 权限 里手动去授权即可。
        val bannerCtx = androidx.compose.ui.platform.LocalContext.current
        val promptPrefs = remember(bannerCtx) { bannerCtx.getSharedPreferences("permission_prompts", android.content.Context.MODE_PRIVATE) }
        var dhzPrompt by remember {
            mutableStateOf(!io.github.jackwener.dsh.core.platform.DhizukuBridge.isGranted() &&
                !promptPrefs.getBoolean("dhizuku_declined", false) && !promptPrefs.getBoolean("prompt_shown_once", false))
        }
        var dhzTip by remember { mutableStateOf(false) }
        val (shzAccess, shzState) = io.github.jackwener.dsh.feature.settings.rememberShellState()
        var shzPrompt by remember {
            mutableStateOf(!shzState.ready && !promptPrefs.getBoolean("shizuku_declined", false) && !promptPrefs.getBoolean("prompt_shown_once", false))
        }
        var shzTip by remember { mutableStateOf(false) }
        // 权限横幅：展示过一次就记住，之后默认不再自动弹（设置 → 手机权限 里仍可授权）
        androidx.compose.runtime.LaunchedEffect(Unit) {
            if (dhzPrompt || shzPrompt) promptPrefs.edit().putBoolean("prompt_shown_once", true).apply()
        }
        androidx.compose.runtime.LaunchedEffect(dhzTip) { if (dhzTip) { kotlinx.coroutines.delay(3000); dhzPrompt = false } }
        androidx.compose.runtime.LaunchedEffect(shzTip) { if (shzTip) { kotlinx.coroutines.delay(3000); shzPrompt = false } }
        androidx.compose.runtime.LaunchedEffect(shzState) { if (shzState.ready) shzPrompt = false }
        if (dhzPrompt) {
            Row(Modifier.fillMaxWidth().clip(Radius.panel).background(c.bgLayer2).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (dhzTip) "在设置 → 权限 找到我" else "启用 Dhizuku 设备所有者权限？可管理应用、锁屏、禁用摄像头等（十分危险，请谨慎使用）", Modifier.weight(1f), style = DshType.xs13, color = c.labelSecondary)
                if (!dhzTip) {
                    io.github.jackwener.dsh.core.designsystem.DButton("去授权", { io.github.jackwener.dsh.core.platform.DhizukuBridge.requestPermission(bannerCtx) { dhzPrompt = false } }, variant = io.github.jackwener.dsh.core.designsystem.BtnVariant.Outline, size = io.github.jackwener.dsh.core.designsystem.BtnSize.Sm)
                    io.github.jackwener.dsh.core.designsystem.DButton("暂不", { dhzTip = true; promptPrefs.edit().putBoolean("dhizuku_declined", true).apply() }, size = io.github.jackwener.dsh.core.designsystem.BtnSize.Sm)
                }
            }
        }
        if (shzPrompt && !shzState.ready) {
            Row(Modifier.fillMaxWidth().clip(Radius.panel).background(c.bgLayer2).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (shzTip) "在设置 → 权限 找到我" else "Shizuku 未授权：不授权也能用基础功能，授权后可以开关 Wi‑Fi / 蓝牙 / 移动数据、修改系统设置、在后台屏操作 App。", Modifier.weight(1f), style = DshType.xs13, color = c.labelSecondary)
                if (!shzTip) {
                    io.github.jackwener.dsh.core.designsystem.DButton("去授权", { runCatching { shzAccess.launchIntent()?.let { bannerCtx.startActivity(it) } }; shzPrompt = false }, variant = io.github.jackwener.dsh.core.designsystem.BtnVariant.Outline, size = io.github.jackwener.dsh.core.designsystem.BtnSize.Sm)
                    io.github.jackwener.dsh.core.designsystem.DButton("暂不", { shzTip = true; promptPrefs.edit().putBoolean("shizuku_declined", true).apply() }, size = io.github.jackwener.dsh.core.designsystem.BtnSize.Sm)
                }
            }
        }
        Row(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(R.drawable.dsw_panel_left_outline, onMenu, size = 40.dp, iconSize = 18.dp, tint = c.labelPrimary, contentDescription = stringResource(R.string.open_sidebar))
            Text(if (empty) "" else live.title.ifBlank { conv.turns.firstOrNull()?.user?.text?.lineSequence()?.firstOrNull() ?: stringResource(R.string.new_session) },
                Modifier.weight(1f).padding(horizontal = 4.dp), style = DshType.s14m, color = c.labelPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            // Every conversation can import / export a Markdown transcript (left of the search icon).
            if (!empty) {
                IconBtn(R.drawable.dsw_paperclip_outline, { importMd.launch(arrayOf("text/markdown", "text/plain", "application/octet-stream")) }, size = 40.dp, iconSize = 18.dp,
                    tint = c.labelSecondary, contentDescription = "导入 markdown 对话")
                IconBtn(R.drawable.dsw_download_outline, {
                    // Cookies / API keys in the conversation: ask which may go into the file first.
                    scope.launch {
                        val hits = runCatching { vm.scanPrivacy() }.getOrDefault(emptyList())
                        if (hits.isEmpty()) vm.exportMarkdown { path -> android.widget.Toast.makeText(toastContext, "已导出（含全部对话事件与同名 .json）：" + path, android.widget.Toast.LENGTH_LONG).show() }
                        else privacyHits = hits
                    }
                }, size = 40.dp, iconSize = 18.dp,
                    tint = c.labelSecondary, contentDescription = "导出 markdown 对话")
            }
            privacyHits?.let { hits ->
                PrivacyExportDialog(hits, onCancel = { privacyHits = null }) { chosen ->
                    privacyHits = null
                    vm.exportMarkdown(chosen) { path -> android.widget.Toast.makeText(toastContext, "已导出（含全部对话事件与同名 .json）：" + path, android.widget.Toast.LENGTH_LONG).show() }
                }
            }
            // 搜索本对话: user messages and replies (not reasoning or code).
            if (!empty) IconBtn(R.drawable.dsw_search_outline, { chatSearch = true }, size = 40.dp, iconSize = 18.dp,
                tint = c.labelSecondary, contentDescription = stringResource(R.string.search_sessions))
            // 对话 / 轨迹: one icon toggle instead of a segmented control, so the title keeps its room at 360 dp.
            if (!empty) {
                val traj = view == SessionView.Trajectory
                IconBtn(if (traj) R.drawable.dsw_flat_list_outline else R.drawable.dsw_inspect_outline,
                    { vm.view.value = if (traj) SessionView.Chat else SessionView.Trajectory }, size = 40.dp, iconSize = 18.dp,
                    tint = if (traj) c.labelPrimary else c.labelSecondary,
                    contentDescription = stringResource(if (traj) R.string.view_chat else R.string.view_trajectory))
            }
            // Nothing to leave on the empty home, so no 新会话 there.
            if (!empty) IconBtn(R.drawable.dsw_new_chat_outline, { vm.newSession(null) }, size = 40.dp, iconSize = 18.dp, tint = c.labelPrimary, contentDescription = stringResource(R.string.new_session))
        }
        val agentDisplay by vm.agentDisplay.collectAsStateWithLifecycle()
        agentDisplay?.takeIf { live.running }?.let { AgentPreview(vm, it) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AnimatedContent(Triple(view, empty, live.sessionId), transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "pane") { (v, isEmpty, _) ->
                when {
                    v == SessionView.Trajectory -> TrajectoryView(vm)
                    isEmpty -> EmptyHero(vm, composer, settings, live, conv, onAutomation, onSettings)
                    // One list state per session (and per crossfading pane), so positions never leak across sessions.
                    else -> ChatStream(conv, live, settings.workDetails, rememberLazyListState(), onInspect = vm::inspect, onRetry = vm::retry, onContinue = { vm.continueTask() }, onOpenSettings = { onSettings(it) }, modifier = Modifier.fillMaxSize())
                }
            }
        }
        if (!empty && view == SessionView.Chat) BottomDock(vm, composer, settings, live, conv, onAutomation, onSettings)
        if (chatSearch) ChatSearchSheet(conv.turns, onClose = { chatSearch = false })
        else if (view == SessionView.Trajectory) {
            // Trajectory has no composer: keep the run stoppable from here.
            if (live.running) Box(Modifier.fillMaxWidth().navigationBarsPadding().padding(8.dp), contentAlignment = Alignment.Center) {
                io.github.jackwener.dsh.core.designsystem.DButton(stringResource(R.string.stop_generating), { vm.stop() },
                    variant = io.github.jackwener.dsh.core.designsystem.BtnVariant.Outline, icon = R.drawable.dsw_stop_fill)
            } else Spacer(Modifier.navigationBarsPadding())
        }
    }
    }
}

/** dsh EmptyHero: centered whale + 探索未至之境 + 预览版 pill, composer below. No suggestion chips. */
@Composable
private fun EmptyHero(vm: HomeViewModel, composer: ComposerState, settings: Settings, live: SessionLive, conv: Conversation, onAutomation: () -> Unit, onSettings: (String?) -> Unit) {
    val c = Dsh.colors
    Column(Modifier.fillMaxSize().imePadding().navigationBarsPadding().padding(horizontal = 8.dp).padding(bottom = 32.dp),
        verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically) {
            Whale(width = 34.dp)
            Spacer(Modifier.width(10.dp))
            Text(stringResource(R.string.hero_title), style = DshType.xl24.copy(fontSize = DshType.xl24.fontSize * 1.08f, fontWeight = androidx.compose.ui.text.font.FontWeight(500)),
                color = c.labelPrimary, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(28.dp))
        ComposerSlot(vm, composer, settings, live, conv, hero = true, onAutomation = onAutomation, onManageModes = { onSettings("Modes") })
    }
}

/** Bottom dock: [todo dock | queue dock] above the composer slot (approval ▸ permission ▸ question ▸ composer). */
@Composable
private fun BottomDock(vm: HomeViewModel, composer: ComposerState, settings: Settings, live: SessionLive, conv: Conversation, onAutomation: () -> Unit, onSettings: (String?) -> Unit) {
    Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().padding(bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (live.running) TodoDock(conv.todos, writtenThisTurn = conv.turns.lastOrNull()?.let { it.status == io.github.jackwener.dsh.core.session.TurnStatus.Running && it.todos != null } == true)
        QueueDock(live.queue, onEdit = { q -> vm.removeQueued(q.id); composer.text = q.text }, onDelete = { vm.removeQueued(it.id) }, onSendNow = { vm.sendQueuedNow(it.id) })
        Box(Modifier.padding(horizontal = 8.dp)) { ComposerSlot(vm, composer, settings, live, conv, hero = false, onAutomation = onAutomation, onManageModes = { onSettings("Modes") }) }
    }
}

/** First non-null wins: permission card, approval card, question card, composer. */
@Composable
fun ComposerSlot(vm: ConversationController, composer: ComposerState, settings: Settings, live: SessionLive, conv: Conversation, hero: Boolean,
                 onAutomation: (() -> Unit)? = null, showChips: Boolean = true, canSendEmpty: Boolean = false,
                 prepare: (String) -> String = { it }, onManageModes: (() -> Unit)? = null,
                 /** Bumped by a voice summon (assistant gesture, ball long-press): start listening. */
                 listenRequest: Int = 0) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val modelChangePending by vm.modelChangePending.collectAsStateWithLifecycle()
    val model by vm.model.collectAsStateWithLifecycle()
    val send = {
        val text = prepare(composer.outgoingText(context))
        composer.clear()
        vm.send(text, now = settings.busySend == io.github.jackwener.dsh.core.data.BusySend.Steer)
    }
    val voice = io.github.jackwener.dsh.feature.voice.rememberVoiceInput(composer) {
        // Attachments still loading: leave the spoken text in the draft for a manual send.
        if (composer.pending == 0 && !composer.isEmpty) send()
    }
    val cardShown = live.takeover != null || live.permission != null || live.approval != null || live.question != null
    // A summon can land just before the panel switches to its recent session (a new composer, so a new
    // VoiceInput): a request taken in the last moment is replayed on the new one.
    var handled by remember { mutableIntStateOf(0) }
    var handledAt by remember { mutableLongStateOf(0L) }
    LaunchedEffect(listenRequest, voice) {
        val now = android.os.SystemClock.uptimeMillis()
        val replay = listenRequest == handled && listenRequest > 0 && now - handledAt < 1500
        if ((listenRequest > handled || replay) && !cardShown) { if (!replay) handledAt = now; handled = listenRequest; voice.start() }
    }
    // Queued messages the run never sent (stopped / failed) come back into the composer.
    LaunchedEffect(live.sessionId, live.restoredDraft) {
        val draft = live.restoredDraft ?: return@LaunchedEffect
        composer.text = listOf(draft, composer.text).filter { it.isNotBlank() }.joinToString("\n\n")
        vm.consumeRestoredDraft()
    }
    when {
        live.takeover != null -> TakeoverCard(live.takeover) { vm.answerTakeover(live.takeover.requestKey, it) }
        live.permission != null -> PermissionCard(live.permission) { vm.answerPermission(live.permission.requestKey, it) }
        live.approval != null -> ApprovalCard(live.approval) { vm.approve(live.approval, it) }
        live.question != null -> QuestionCard(live.question, onSubmit = { vm.answer(live.question, it) }, onSkip = { vm.skipQuestion(live.question) })
        else -> Composer(
            composer, live.running, live.preset, vm::setPreset, model.choice, settings.providers, model.effort, vm::setModel, vm::setEffort, conv.contextTokens,
            onSend = { voice.cancel(); send() },
            onStop = { vm.stop() },
            reasoning = model.reasoning(settings.reasoningCatalog), reasoningChoice = model.reasoningChoice, onReasoning = vm::setReasoning,
            // #53: this conversation's own model is gone; the next message runs on the default.
            modelNotice = live.model?.takeIf { model.fellBack }?.let { stringResource(R.string.session_model_gone, modelLabel(it.model), modelLabel(model.choice.model)) },
            hero = hero,
            actions = ComposerActions(
                onNewSession = if (conv.isEmpty) null else ({ vm.newSession() }),
                onTrajectory = if (conv.isEmpty) null else ({ vm.view.value = SessionView.Trajectory }),
                onAutomation = onAutomation,
            ),
            showChips = showChips,
            canSendEmpty = canSendEmpty,
            modelChangePending = modelChangePending,
            mode = settings.mode(live.modeId),
            modes = settings.allModes,
            modeLocked = !live.modeChangeable,
            onMode = vm::setMode,
            onManageModes = onManageModes,
            voice = voice,
        )
    }
}


/** 搜索本对话: matches in user messages and model replies only (reasoning and tool output are skipped). */
@Composable
private fun ChatSearchSheet(turns: List<Turn>, onClose: () -> Unit) {
    val c = Dsh.colors
    var q by remember { mutableStateOf("") }
    val results = remember(turns, q) {
        if (q.isBlank()) emptyList() else buildList {
            turns.forEach { t ->
                t.user?.text?.takeIf { it.contains(q, ignoreCase = true) }?.let { add("用户" to it) }
                val reply = t.blocks.filterIsInstance<Block.Text>().joinToString("\n") { it.text }
                if (reply.contains(q, ignoreCase = true)) add("回复" to reply)
            }
        }
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.fillMaxWidth(0.94f).heightIn(max = 560.dp).clip(Radius.panel).background(c.bgLayer2).padding(16.dp)) {
            DInput(q, { q = it }, placeholder = stringResource(R.string.search_sessions))
            Spacer(Modifier.height(8.dp))
            if (q.isNotBlank() && results.isEmpty()) Text(stringResource(R.string.no_matching_sessions), style = DshType.xs13, color = c.labelTertiary)
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(results) { (role, text) ->
                    Column {
                        Text(role, style = DshType.xxs12, color = c.labelTertiary)
                        Text(text.take(300), style = DshType.xs13, color = c.labelPrimary)
                    }
                }
            }
        }
    }
}

/** Asks which sensitive strings may go into the export file (they are listed at its top). */
@Composable
private fun PrivacyExportDialog(hits: List<String>, onCancel: () -> Unit, onConfirm: (List<String>) -> Unit) {
    val c = Dsh.colors
    val chosen = remember { mutableStateListOf<String>().apply { addAll(hits) } }
    DDialog(onCancel, "导出前确认隐私信息", buttons = {
        DButton("取消", onCancel, variant = BtnVariant.Outline, size = BtnSize.Sm)
        DButton("确定导出", { onConfirm(chosen.toList()) }, size = BtnSize.Sm)
    }) {
        Text("会话里有 " + hits.size + " 处敏感信息（cookie / API Key / token 等）。勾选要写进导出文件的条目，它们会列在文件最上面。",
            style = DshType.xs13, color = c.labelSecondary)
        Spacer(Modifier.height(6.dp))
        Column(Modifier.heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
            for (h in hits) {
                val on = h in chosen
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp))
                        .clickable { if (on) chosen.remove(h) else chosen.add(h) }
                        .padding(vertical = 6.dp, horizontal = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(if (on) "\u2611" else "\u2610", style = DshType.s14, color = if (on) c.labelPrimary else c.labelTertiary)
                    Spacer(Modifier.width(8.dp))
                    Text(h.take(100), style = DshType.xs13, color = c.labelSecondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}
