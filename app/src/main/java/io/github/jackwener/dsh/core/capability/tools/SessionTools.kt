package io.github.jackwener.dsh.core.capability.tools

import io.github.jackwener.dsh.core.capability.CallContext
import io.github.jackwener.dsh.core.capability.Tool
import io.github.jackwener.dsh.core.capability.ToolResult
import io.github.jackwener.dsh.core.capability.ToolSet
import io.github.jackwener.dsh.core.capability.int
import io.github.jackwener.dsh.core.capability.reqStr
import io.github.jackwener.dsh.core.capability.str
import io.github.jackwener.dsh.core.data.SessionDao
import io.github.jackwener.dsh.core.model.Risk
import io.github.jackwener.dsh.core.model.ToolGroup
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Cross-conversation search: a model can look up what its other conversations did (files they
 * created, tools they set up, decisions) without the user repeating it. Only reads the local
 * session log; the answer names the conversations so the model can report what it looked at.
 */
@Singleton
class SessionTools @Inject constructor(private val dao: SessionDao) : ToolSet {
    override val tools = listOf(
        object : Tool("session_search", ToolGroup.Files, Risk.read, false,
            "Search the messages of your other DSH conversations on this phone, e.g. to find what another conversation set up or decided. Returns matching snippets with the conversation titles; say which conversation you searched.",
            {
                string("query", "Text to look for (case-insensitive)", required = true)
                int("limit", "Max matches (default 10, at most 30)")
            }) {
            override suspend fun invoke(args: JsonObject, call: CallContext): ToolResult {
                val q = args.reqStr("query").trim()
                if (q.isEmpty()) return ToolResult.error("invalid_args", "query is required")
                val limit = (args.int("limit") ?: 10).coerceIn(1, 30)
                val hits = withContext(Dispatchers.IO) { dao.searchEvents(q, limit) }
                if (hits.isEmpty()) return ToolResult.text("No match for \"$q\" in any other conversation.")
                val lines = StringBuilder("Matches for \"$q\" in other conversations:\n")
                for (e in hits) {
                    val title = withContext(Dispatchers.IO) { dao.get(e.sessionId) }?.title?.takeIf { it.isNotBlank() } ?: e.sessionId
                    lines.append("- [").append(title).append("] ").append(role(e.type)).append(": ").append(snippet(e.json, q)).append('\n')
                }
                lines.append("\nName the conversations you searched when you report back.")
                return ToolResult.text(lines.toString().trimEnd())
            }
        },
        object : Tool("session_read", ToolGroup.Files, Risk.read, false,
            "Read recent messages of the current conversation straight from the local log — it still works after the context was compacted, so use it when you need the earlier exchange again. Also accepts another conversation id.",
            {
                string("sessionId", "Conversation id (default: the current conversation)")
                int("limit", "How many messages to return (default 20, at most 60)")
                string("role", "user | assistant | all (default all)")
            }) {
            override suspend fun invoke(args: JsonObject, call: CallContext): ToolResult {
                val sid = args.str("sessionId")?.takeIf { it.isNotBlank() } ?: call.sessionId
                if (sid.isBlank()) return ToolResult.error("invalid_args", "no session id")
                val limit = (args.int("limit") ?: 20).coerceIn(1, 60)
                val role = args.str("role") ?: "all"
                val events = withContext(Dispatchers.IO) { dao.events(sid) }
                val msgs = events.mapNotNull { e ->
                    when (e.type) {
                        "user/message" -> if (role == "assistant") null else textOfUser(e.json)?.let { "user" to it }
                        "assistant/message" -> if (role == "user") null else textOfAssistant(e.json)?.let { "assistant" to it }
                        else -> null
                    }
                }.takeLast(limit)
                if (msgs.isEmpty()) return ToolResult.text("No messages found in that conversation.")
                val sb = StringBuilder("Recent messages (")
                sb.append(msgs.size).append("):\n")
                msgs.forEach { (r, t) -> sb.append("[").append(r).append("] ").append(t.take(500)).append('\n') }
                return ToolResult.text(sb.toString().trimEnd())
            }
        },
    )

    private fun textOfUser(json: String): String? = runCatching {
        val o = Json.parseToJsonElement(json).jsonObject
        val src = o["source"]?.jsonObject?.get("kind")?.jsonPrimitive?.contentOrNull
        if (src != null && src != "user") null else {
            val c = o["content"]
            val text = when (c) {
                is JsonArray -> c.mapNotNull { (it as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull }.joinToString("\n")
                is JsonPrimitive -> c.contentOrNull
                else -> null
            }
            text?.trim()?.takeIf { it.isNotEmpty() }
        }
    }.getOrNull()

    private fun textOfAssistant(json: String): String? = runCatching {
        val o = Json.parseToJsonElement(json).jsonObject
        val text = (o["content"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.get("text")?.jsonPrimitive?.contentOrNull }?.joinToString("\n")
        text?.trim()?.takeIf { it.isNotEmpty() }
    }.getOrNull()

    private fun role(type: String) = when (type) {
        "user/message" -> "user"
        "assistant/message" -> "assistant"
        "tool/call" -> "tool call"
        "tool/result" -> "tool result"
        else -> type
    }

    /** A ±90-char window around the first hit, with JSON escapes flattened for reading. */
    private fun snippet(json: String, q: String): String {
        val at = json.indexOf(q, ignoreCase = true).let { if (it < 0) 0 else it }
        val start = (at - 90).coerceAtLeast(0)
        val end = (at + q.length + 90).coerceAtMost(json.length)
        val body = json.substring(start, end)
            .replace("\\n", " ").replace("\\\"", "\"").replace("\"", "")
            .replace(Regex("\\s+"), " ").trim()
        return (if (start > 0) "…" else "") + body + "…"
    }
}
