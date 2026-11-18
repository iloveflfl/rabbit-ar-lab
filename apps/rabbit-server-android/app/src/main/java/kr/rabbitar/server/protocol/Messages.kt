package kr.rabbitar.server.protocol

import org.json.JSONArray
import org.json.JSONObject

/** 릴레이가 넘겨 준 관람객 질문. 형식이 조금이라도 어긋나면 null 을 돌려주고 버린다. */
data class ChatRequest(
    val requestId: String,
    val sessionId: String,
    val topic: String,
    val message: String,
    val selectedGraphId: String?,
) {
    companion object {
        private val CONTROL = Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]")
        private val BREAKS = Regex("[\\t\\r\\n]+")

        fun parse(o: JSONObject): ChatRequest? {
            val requestId = o.optString("requestId")
            val sessionId = o.optString("sessionId")
            if (!Ids.isUuid(requestId) || !Ids.isUuid(sessionId)) return null
            val topic = o.optString("topic", "general").let { if (it in Ids.TOPIC_IDS) it else "general" }
            val message = sanitize(o.optString("message"))
            if (message.isEmpty() || message.length > Ids.MAX_MESSAGE_CHARS) return null
            val graph = o.optString("selectedGraphId").takeIf { it in Ids.HIGHLIGHT_IDS }
            return ChatRequest(requestId, sessionId, topic, message, graph)
        }

        /** 제어문자 제거, 줄바꿈은 공백으로. */
        fun sanitize(s: String): String = s.replace(CONTROL, "").replace(BREAKS, " ").trim()
    }
}

data class ChatAnswer(
    val reply: String,
    val animation: String?,
    val highlight: String?,
    val sourceFactIds: List<String>,
    val engine: String,
)

object Frames {
    fun hello(engine: String): String = JSONObject()
        .put("type", "hello").put("protocol", Ids.PROTOCOL_VERSION).put("deviceVersion", Ids.DEVICE_VERSION).put("engine", engine).toString()

    fun status(busy: Boolean, engine: String): String = JSONObject()
        .put("type", "status").put("status", if (busy) "busy" else "online").put("engine", engine).toString()

    fun delta(req: ChatRequest, text: String): String = JSONObject()
        .put("type", "chat.delta").put("requestId", req.requestId).put("sessionId", req.sessionId).put("text", text).toString()

    /** 동작·강조·근거는 allowlist 에 있는 값만 내보낸다. */
    fun final(req: ChatRequest, a: ChatAnswer): String = JSONObject()
        .put("type", "chat.final").put("requestId", req.requestId).put("sessionId", req.sessionId)
        .put("reply", a.reply.take(Ids.MAX_REPLY_CHARS))
        .put("animation", a.animation?.takeIf { it in Ids.SCENE_ACTIONS } ?: JSONObject.NULL)
        .put("highlight", a.highlight?.takeIf { it in Ids.HIGHLIGHT_IDS } ?: JSONObject.NULL)
        .put("sourceFactIds", JSONArray(a.sourceFactIds.filter { it in Ids.FACT_IDS }.distinct().take(4)))
        .put("engine", a.engine).toString()

    fun error(req: ChatRequest, code: String, message: String): String = JSONObject()
        .put("type", "chat.error").put("requestId", req.requestId).put("sessionId", req.sessionId)
        .put("code", code).put("message", message).toString()
}
