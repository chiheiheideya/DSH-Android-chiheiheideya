package io.github.jackwener.dsh.core.session

/**
 * Finds the sensitive strings a conversation may contain (cookies, API keys, tokens, passwords).
 *
 * The export flow shows what was found and lets the user tick what may go into the file; the ticked
 * entries are also listed at the top of the export so the user and the model can check them.
 */
object PrivacyScan {
    private val PATTERNS = listOf(
        Regex("""ghp_[A-Za-z0-9]{20,}"""),
        Regex("""github_pat_[A-Za-z0-9_]{20,}"""),
        Regex("""sk-[A-Za-z0-9_-]{16,}"""),
        Regex("""(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}"""),
        Regex("""__Host-[A-Za-z0-9_-]+=[A-Za-z0-9%._~+/=-]{12,}"""),
        Regex("""[A-Za-z0-9_.\-]+=[A-Za-z0-9%._~+/=-]{20,}"""),
        Regex("""(?i)(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}"""),
        Regex("""(?i)(?:sk|pk|rk)[-_](?:live|test)?[-_]?[A-Za-z0-9]{16,}"""),
        Regex("""(?i)(?:^|[;,]{0,1}\s)(?:[A-Za-z0-9_.\-]{1,40})=(?:[A-Za-z0-9%._~+/=-]{16,})(?:;|$)"""),
        Regex("""(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|passw(?:or)?d|cookie|密码|密钥)\s*[:=：]\s*["']?[A-Za-z0-9%._~+/=-]{12,}"""),
    )

    /** Up to [limit] distinct matches, in the order they appear in the text. */
    fun find(text: String, limit: Int = 30): List<String> {
        if (text.isBlank()) return emptyList()
        val out = LinkedHashSet<String>()
        for (p in PATTERNS) {
            for (m in p.findAll(text)) {
                val v = m.value.trim().trimEnd(';', ',', ')', '"', '\'', '`')
                if (v.length >= 12) out.add(v.take(160))
                if (out.size >= limit) return out.toList()
            }
        }
        return out.toList()
    }
}
