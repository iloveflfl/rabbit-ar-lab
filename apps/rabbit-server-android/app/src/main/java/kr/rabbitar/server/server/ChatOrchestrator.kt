package kr.rabbitar.server.server

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kr.rabbitar.server.content.Content
import kr.rabbitar.server.inference.InferenceProvider
import kr.rabbitar.server.protocol.ChatAnswer
import kr.rabbitar.server.protocol.ChatRequest
import kr.rabbitar.server.protocol.Frames
import kr.rabbitar.server.protocol.Ids
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * 관람객 질문 처리기.
 *
 *   질문 → (짧고 확실한 질문이면 사전제작 답변 캐시) → 근거 fact 고르기 → 모델 생성 → 출력 파싱 → 동작 allowlist 검증
 *
 * - 추론은 한 번에 하나만(직렬). 나머지는 대기열에서 기다린다.
 * - 세션별 문맥은 메모리에만 잠깐 둔다(TTL). 대화를 디스크에 쓰지 않는다.
 * - 이 클래스는 파일·문자·OS 명령 같은 기기 기능을 전혀 호출하지 않는다.
 */
class ChatOrchestrator(
    private val content: Content,
    private val provider: InferenceProvider,
    private val scope: CoroutineScope,
    private val send: (String) -> Unit,
    private val now: () -> Long = System::currentTimeMillis,
    private val onStats: (Stats) -> Unit = {},
) {
    data class Stats(val queued: Int, val served: Int, val failed: Int, val sessions: Int, val latenciesMs: List<Long>)

    private class Session(var lastUsed: Long, var lastQuestion: String?, var lastAnswer: String?)

    private val queue = Channel<ChatRequest>(capacity = MAX_QUEUE)
    private val queued = AtomicInteger(0)
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private val sessions = ConcurrentHashMap<String, Session>()
    private val latencies = ArrayDeque<Long>()
    private var served = 0
    private var failed = 0
    private var current: Pair<String, Job>? = null
    private var worker: Job? = null
    @Volatile private var accepting = false

    fun start() {
        accepting = true
        worker = scope.launch {
            for (req in queue) {
                queued.decrementAndGet()
                if (cancelled.remove(req.requestId)) continue
                val job = launch { handle(req) }
                current = req.requestId to job
                job.join()
                current = null
                publish()
            }
        }
    }

    /** 새 요청을 받지 않고, 진행 중인 요청을 정리한다. */
    fun stop() {
        accepting = false
        current?.second?.cancel()
        worker?.cancel()
        queue.close()
        sessions.clear()
    }

    fun submit(req: ChatRequest) {
        if (!accepting) {
            send(Frames.error(req, "offline", "서버를 끄는 중이에요."))
            return
        }
        if (queue.trySend(req).isSuccess) {
            queued.incrementAndGet()
            publish()
        } else {
            send(Frames.error(req, "busy", "줄이 꽉 찼어요. 잠깐 뒤에 다시 물어봐 주세요."))
        }
    }

    fun cancel(requestId: String) {
        val cur = current
        if (cur != null && cur.first == requestId) cur.second.cancel() else cancelled.add(requestId)
    }

    val isBusy: Boolean get() = queued.get() >= MAX_QUEUE - 1

    private suspend fun handle(req: ChatRequest) {
        val started = now()
        pruneSessions(started)
        try {
            val answer = withTimeout(GENERATION_TIMEOUT_MS) { answer(req) }
            send(Frames.final(req, answer))
            sessions.getOrPut(req.sessionId) { Session(started, null, null) }.apply {
                lastUsed = now()
                lastQuestion = req.message
                lastAnswer = answer.reply.take(160)
            }
            served++
            latencies.addLast(now() - started)
            while (latencies.size > 50) latencies.removeFirst()
        } catch (e: CancellationException) {
            // 관람객이 나갔거나 릴레이가 취소함: 조용히 끝낸다. 시간 초과는 알려 준다.
            if (e is kotlinx.coroutines.TimeoutCancellationException) {
                failed++
                send(Frames.error(req, "timeout", "답변이 너무 오래 걸렸어요."))
            }
        } catch (e: Exception) {
            failed++
            send(Frames.error(req, "device_error", "답변을 만들지 못했어요."))
        }
    }

    private suspend fun answer(req: ChatRequest): ChatAnswer {
        // 1) 짧고 키워드가 뚜렷한 질문은 검증된 사전제작 답변으로 바로 답한다(모델 부하 절약).
        val canned = content.matchCanned(req.message, req.topic)
        if (canned.strong && req.message.length <= SHORT_QUESTION_CHARS) {
            streamText(req, canned.reply)
            return ChatAnswer(canned.reply, canned.animation, canned.highlight, canned.sourceFactIds, Ids.ENGINE_CANNED)
        }

        // 2) 모델에 묻는다. 근거는 고른 주제의 fact 만, 직전 문답 한 쌍만 문맥으로 붙인다.
        val prompt = content.buildPrompt(req.message, req.topic)
        val prev = sessions[req.sessionId]
        val user = if (prev?.lastQuestion != null) "[직전 질문] ${prev.lastQuestion}\n[직전 답] ${prev.lastAnswer}\n[지금 질문] ${req.message}" else req.message

        val raw = StringBuilder()
        var sent = 0
        provider.generate(prompt.system, user, MAX_TOKENS).collect { token ->
            raw.append(token)
            if (raw.length > Ids.MAX_REPLY_CHARS * 2) throw IllegalStateException("runaway output")
            // '#동작:' 꼬리표가 화면에 새지 않도록, '#' 이후는 보내지 않고 붙들어 둔다.
            val visibleEnd = raw.indexOf("#").let { if (it >= 0) it else raw.length }
            if (visibleEnd - sent >= STREAM_CHUNK) {
                send(Frames.delta(req, raw.substring(sent, visibleEnd).take(Ids.MAX_DELTA_CHARS)))
                sent = visibleEnd
            }
        }
        val parsed = content.parseModelOutput(raw.toString())
        if (parsed.reply.isEmpty()) {
            // 모델이 빈 답을 냈다: 사전제작 답변으로 안전하게 대체한다.
            return ChatAnswer(canned.reply, canned.animation, canned.highlight, canned.sourceFactIds, Ids.ENGINE_CANNED)
        }
        // 3) 동작은 모델이 고른 것(allowlist 통과분)을 쓰고, 없으면 주제의 기본 동작을 쓴다.
        val animation = parsed.animation ?: prompt.route?.animation
        return ChatAnswer(parsed.reply, animation, prompt.route?.highlight, prompt.factIds, provider.engine)
    }

    private suspend fun streamText(req: ChatRequest, text: String) {
        var i = 0
        while (i < text.length) {
            val end = minOf(text.length, i + 14)
            send(Frames.delta(req, text.substring(i, end)))
            i = end
            kotlinx.coroutines.delay(24)
        }
    }

    private fun pruneSessions(t: Long) {
        if (sessions.size < 8) return
        sessions.entries.removeIf { t - it.value.lastUsed > SESSION_TTL_MS }
        if (sessions.size > MAX_SESSIONS) sessions.entries.sortedBy { it.value.lastUsed }.take(sessions.size - MAX_SESSIONS).forEach { sessions.remove(it.key) }
    }

    private fun publish() = onStats(Stats(queued.get(), served, failed, sessions.size, latencies.toList()))

    companion object {
        const val MAX_QUEUE = 8
        const val MAX_TOKENS = 320
        const val STREAM_CHUNK = 8
        const val SHORT_QUESTION_CHARS = 40
        const val GENERATION_TIMEOUT_MS = 60_000L
        const val SESSION_TTL_MS = 10 * 60_000L
        const val MAX_SESSIONS = 200
    }
}
