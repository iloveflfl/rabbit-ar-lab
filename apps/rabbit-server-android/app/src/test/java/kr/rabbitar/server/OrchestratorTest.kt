package kr.rabbitar.server

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kr.rabbitar.server.content.Content
import kr.rabbitar.server.inference.InferenceProvider
import kr.rabbitar.server.inference.MockInferenceProvider
import kr.rabbitar.server.protocol.ChatRequest
import kr.rabbitar.server.server.ChatOrchestrator
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.Collections
import java.util.UUID

class OrchestratorTest {
    private val data = File("../../../packages/educational-content/data")
    private val content = Content(File(data, "qa_ko.json").readText(), File(data, "llm_ko.json").readText())

    private class Harness(content: Content, provider: InferenceProvider) {
        val frames: MutableList<JSONObject> = Collections.synchronizedList(ArrayList())
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val orch = ChatOrchestrator(content, provider, scope, send = { frames.add(JSONObject(it)) })

        fun ask(message: String, session: String = UUID.randomUUID().toString()): ChatRequest =
            ChatRequest(UUID.randomUUID().toString(), session, "general", message, null).also { orch.submit(it) }

        suspend fun finalOf(req: ChatRequest): JSONObject = withTimeout(8000) {
            while (true) {
                synchronized(frames) { frames.firstOrNull { it.getString("requestId") == req.requestId && it.getString("type") != "chat.delta" } }?.let { return@withTimeout it }
                delay(15)
            }
            @Suppress("UNREACHABLE_CODE") JSONObject()
        }

        fun deltas(req: ChatRequest): String = synchronized(frames) {
            frames.filter { it.getString("requestId") == req.requestId && it.getString("type") == "chat.delta" }.joinToString("") { it.getString("text") }
        }
    }

    /** 고정된 글을 토큰처럼 흘려보내는 가짜 모델 */
    private class Scripted(private val text: String, private val tokenDelay: Long = 2) : InferenceProvider {
        override val engine = "geniex"
        var calls = 0
        var lastUser = ""
        override suspend fun load(onProgress: (String) -> Unit) {}
        override fun generate(system: String, user: String, maxTokens: Int): Flow<String> = flow {
            calls++
            lastUser = user
            text.chunked(3).forEach {
                emit(it)
                delay(tokenDelay)
            }
        }
        override suspend fun release() {}
        override fun describe() = emptyMap<String, String>()
    }

    @Test fun strongShortQuestionUsesCannedCacheWithoutModel() = runBlocking {
        val model = Scripted("쓰이지 않음")
        val h = Harness(content, model).also { it.orch.start() }
        val req = h.ask("왜 영하 50도인데 기판은 73도야?")
        val f = h.finalOf(req)
        assertEquals("chat.final", f.getString("type"))
        assertEquals("canned", f.getString("engine"))
        assertEquals("show_heating", f.getString("animation"))
        assertEquals(0, model.calls)
        assertEquals(f.getString("reply"), h.deltas(req))
        h.scope.cancel()
    }

    @Test fun modelAnswerHidesActionTagAndValidatesIt() = runBlocking {
        val model = Scripted("받침에 따라 열이 빠지는 길이 달라져서 그래.\n#동작: show_mounting")
        val h = Harness(content, model).also { it.orch.start() }
        val req = h.ask("받침 구조에 따라 측정 온도가 달라진 까닭을 조금 더 길게 풀어서 자세히 설명해 줄 수 있을까?")
        val f = h.finalOf(req)
        assertEquals("geniex", f.getString("engine"))
        assertEquals("받침에 따라 열이 빠지는 길이 달라져서 그래.", f.getString("reply"))
        assertEquals("show_mounting", f.getString("animation"))
        assertEquals("results_mounting", f.getString("highlight"))
        assertFalse("스트림에 태그가 새면 안 된다", h.deltas(req).contains("#"))
        assertEquals(1, model.calls)
        h.scope.cancel()
    }

    @Test fun unknownActionFromModelFallsBackToRouteDefault() = runBlocking {
        val h = Harness(content, Scripted("구리 단차는 높이 차이를 잰 값이야. #동작: open_camera")).also { it.orch.start() }
        val f = h.finalOf(h.ask("구리 시편의 단차 프로파일 측정이 정확히 무엇을 의미하는지 자세히 풀어서 알려 줄래?"))
        assertEquals("show_cu_profile", f.getString("animation"))
        h.scope.cancel()
    }

    @Test fun sessionsDoNotShareContext() = runBlocking {
        val model = Scripted("답")
        val h = Harness(content, model).also { it.orch.start() }
        val a = UUID.randomUUID().toString()
        val b = UUID.randomUUID().toString()
        val long = "이 연구의 받침 구조 비교 실험을 처음 듣는 사람에게 차근차근 설명해 줄 수 있을까요 부탁해요"
        h.finalOf(h.ask("$long A", a))
        h.finalOf(h.ask("$long B", b))
        assertFalse("B 의 프롬프트에 A 의 질문이 들어가면 안 된다", model.lastUser.contains(" A"))
        h.finalOf(h.ask("$long A2", a))
        assertTrue("같은 세션은 직전 문답을 문맥으로 쓴다", model.lastUser.contains("[직전 질문]") && model.lastUser.contains(" A"))
        h.scope.cancel()
    }

    @Test fun requestsAreServedOneAtATimeInOrder() = runBlocking {
        val h = Harness(content, MockInferenceProvider(content)).also { it.orch.start() }
        val long = "차근차근 아주 자세하게 길게 풀어서 설명해 줄 수 있을까요 부탁합니다 정말로요"
        val r1 = h.ask("Mo 참고 실험을 $long")
        val r2 = h.ask("구리 단차를 $long")
        h.finalOf(r1)
        h.finalOf(r2)
        val order = synchronized(h.frames) { h.frames.map { it.getString("requestId") } }
        assertTrue("첫 요청의 프레임이 모두 끝난 뒤에 둘째 요청이 시작된다", order.lastIndexOf(r1.requestId) < order.indexOf(r2.requestId))
        assertEquals("mock", h.finalOf(r1).getString("engine"))
        h.scope.cancel()
    }

    @Test fun cancelStopsGeneration() = runBlocking {
        val model = Scripted("가".repeat(600), tokenDelay = 10)
        val h = Harness(content, model).also { it.orch.start() }
        val req = h.ask("받침 구조에 따라 온도가 달라진 까닭을 아주 길고 자세하게 처음부터 끝까지 설명해 줘")
        delay(120)
        h.orch.cancel(req.requestId)
        delay(300)
        assertTrue(synchronized(h.frames) { h.frames.none { it.getString("type") == "chat.final" } })
        h.scope.cancel()
    }

    @Test fun stoppedServerRejectsNewRequests() = runBlocking {
        val h = Harness(content, Scripted("답")).also { it.orch.start() }
        h.orch.stop()
        val f = h.finalOf(h.ask("안녕"))
        assertEquals("chat.error", f.getString("type"))
        assertEquals("offline", f.getString("code"))
        h.scope.cancel()
    }
}
