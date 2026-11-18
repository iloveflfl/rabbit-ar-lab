package kr.rabbitar.server.content

import kr.rabbitar.server.protocol.Ids
import org.json.JSONArray
import org.json.JSONObject

/**
 * 전시 전용 Q&A 지식. 웹과 같은 JSON(qa_ko.json, llm_ko.json)을 읽는다.
 * 매칭 규칙은 packages/educational-content/src/index.ts 와 같아야 한다.
 */
class Content(qaJson: String, llmJson: String) {

    data class Canned(
        val id: String, val reply: String, val animation: String?, val highlight: String?,
        val sourceFactIds: List<String>, val score: Double, val strong: Boolean,
    )

    data class Route(val topic: String, val keywords: List<String>, val factIds: List<String>, val animation: String, val highlight: String)
    data class Prompt(val system: String, val user: String, val factIds: List<String>, val route: Route?)
    data class Parsed(val reply: String, val animation: String?)

    private data class Entry(
        val id: String, val topic: String, val keywords: List<String>, val must: List<String>?, val not: List<String>?,
        val reply: String, val animation: String?, val highlight: String?, val sourceFactIds: List<String>,
    )

    private val minScore: Double
    private val strongScore: Double
    private val fallback: Canned
    private val entries: List<Entry>
    val systemPrompt: String
    val actionTag: String
    private val digest: Map<String, String>
    private val routes: List<Route>

    init {
        val qa = JSONObject(qaJson)
        minScore = qa.getDouble("min_score")
        strongScore = qa.getDouble("strong_score")
        val fb = qa.getJSONObject("fallback")
        fallback = Canned("fallback", fb.getString("reply"), fb.optStringOrNull("animation"), fb.optStringOrNull("highlight"), fb.strings("sourceFactIds"), 0.0, false)
        entries = qa.getJSONArray("entries").objects().map {
            Entry(
                it.getString("id"), it.getString("topic"), it.strings("keywords"),
                if (it.has("must")) it.strings("must") else null, if (it.has("not")) it.strings("not") else null,
                it.getString("reply"), it.optStringOrNull("animation"), it.optStringOrNull("highlight"), it.strings("sourceFactIds"),
            )
        }
        val llm = JSONObject(llmJson)
        systemPrompt = llm.getString("system_prompt")
        actionTag = llm.getString("action_tag")
        val d = llm.getJSONObject("facts_digest")
        digest = d.keys().asSequence().associateWith { d.getString(it) }
        routes = llm.getJSONArray("topic_routes").objects().map {
            Route(it.getString("topic"), it.strings("keywords"), it.strings("factIds"), it.getString("animation"), it.getString("highlight"))
        }
    }

    fun matchCanned(message: String, topic: String = "general"): Canned {
        val n = normalize(message)
        var best: Entry? = null
        var bestScore = 0.0
        for (e in entries) {
            if (e.must != null && e.must.none { containsKeyword(n, it) }) continue
            if (e.not != null && e.not.any { containsKeyword(n, it) }) continue
            var s = score(n, e.keywords)
            if (s == 0.0) continue
            if (e.topic == topic) s += 1.5
            if (s > bestScore) {
                best = e
                bestScore = s
            }
        }
        val b = best
        if (b == null || bestScore < minScore) return fallback
        return Canned(b.id, b.reply, b.animation, b.highlight, b.sourceFactIds, bestScore, bestScore >= strongScore)
    }

    fun routeTopic(message: String, topic: String = "general"): Route? {
        val n = normalize(message)
        var best = routes.firstOrNull { it.topic == topic }
        var bestScore = if (best != null) 1.0 else 0.0
        for (r in routes) {
            val s = score(n, r.keywords) + if (r.topic == topic) 1.0 else 0.0
            if (s > bestScore) {
                best = r
                bestScore = s
            }
        }
        return best
    }

    /** 고른 주제의 근거만 넣어 프롬프트를 짧게 유지한다(온디바이스 모델의 문맥·속도 절약). */
    fun buildPrompt(message: String, topic: String = "general"): Prompt {
        val route = routeTopic(message, topic)
        val factIds = route?.factIds ?: listOf("sic_continuous_minus50", "sic_cyclic_minus50", "sic_etch_rate_setpoints")
        val facts = factIds.mapNotNull { digest[it] }.joinToString("\n") { "- $it" }
        return Prompt("$systemPrompt\n\n[포스터 사실]\n$facts", message, factIds, route)
    }

    /** 모델 출력에서 '#동작: id' 를 떼어 내고, allowlist 밖의 값은 버린다. */
    fun parseModelOutput(raw: String): Parsed {
        var animation: String? = null
        val kept = ArrayList<String>()
        for (line in raw.split(NEWLINE)) {
            val t = line.trim()
            val i = t.indexOf(actionTag)
            if (i >= 0) {
                val id = t.substring(i + actionTag.length).trim().replace(NOT_ID, "")
                if (animation == null && id in Ids.SCENE_ACTIONS) animation = id
                val before = t.substring(0, i).trim()
                if (before.isNotEmpty()) kept.add(before)
                continue
            }
            if (t.isNotEmpty()) kept.add(t)
        }
        val reply = kept.joinToString(" ").replace(MARKUP, "").replace(SPACES, " ").trim()
        return Parsed(reply, animation)
    }

    companion object {
        private val NEWLINE = Regex("\\r?\\n")
        private val NOT_ID = Regex("[^a-z_]")
        private val MARKUP = Regex("[*_`#<>]")
        private val SPACES = Regex("\\s+")
        private val DASHES = Regex("[\\u2212\\u2012\\u2013\\u2014]")
        private val STRIP = Regex("[\\s.,!?~'\"`()\\[\\]{}:;·…/\\\\°℃]+")

        fun normalize(s: String): String = s.lowercase().replace(DASHES, "-").replace(STRIP, "")

        private fun alpha(c: Char) = c in 'a'..'z'
        private fun digit(c: Char) = c in '0'..'9'
        private fun sameClass(a: Char, b: Char) = (alpha(a) && alpha(b)) || (digit(a) && digit(b))

        /** 영문·숫자 키워드는 같은 종류의 글자에 붙어 있으면 무시한다 ("he" ⊄ "chiller", "75" ⊄ "175"). */
        fun containsKeyword(normalized: String, keyword: String): Boolean {
            var from = 0
            while (true) {
                val i = normalized.indexOf(keyword, from)
                if (i < 0) return false
                val leftOk = i == 0 || !sameClass(normalized[i - 1], keyword.first())
                val end = i + keyword.length
                val rightOk = end >= normalized.length || !sameClass(normalized[end], keyword.last())
                if (leftOk && rightOk) return true
                from = i + 1
            }
        }

        fun score(normalized: String, keywords: List<String>): Double =
            keywords.sumOf { if (containsKeyword(normalized, it)) maxOf(2, it.length).toDouble() else 0.0 }

        private fun JSONObject.strings(key: String): List<String> =
            optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()

        private fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key)) null else optString(key).ifEmpty { null }
        private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
    }
}
