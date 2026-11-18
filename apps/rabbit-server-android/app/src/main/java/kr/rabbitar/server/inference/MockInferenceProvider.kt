package kr.rabbitar.server.inference

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kr.rabbitar.server.content.Content
import kr.rabbitar.server.protocol.Ids

/**
 * 모델 없이 전 구간(서비스·릴레이·웹)을 시험하기 위한 가짜 엔진.
 * 사전제작 답변을 토큰처럼 흘려보낸다. engine = "mock" 이므로 관람객 화면에 MOCK 으로 표시된다.
 */
class MockInferenceProvider(private val content: Content) : InferenceProvider {
    override val engine = Ids.ENGINE_MOCK

    override suspend fun load(onProgress: (String) -> Unit) {
        onProgress("MOCK 엔진: 실제 모델을 올리지 않습니다")
        delay(400)
    }

    override fun generate(system: String, user: String, maxTokens: Int): Flow<String> = flow {
        val a = content.matchCanned(user)
        val text = a.reply + (a.animation?.let { "\n${content.actionTag} $it" } ?: "")
        var i = 0
        while (i < text.length) {
            val end = minOf(text.length, i + 6)
            emit(text.substring(i, end))
            i = end
            delay(28)
        }
    }

    override suspend fun release() {}

    override fun describe() = mapOf("엔진" to "MOCK (가짜 엔진)", "모델" to "없음", "연산 장치" to "없음")
}
