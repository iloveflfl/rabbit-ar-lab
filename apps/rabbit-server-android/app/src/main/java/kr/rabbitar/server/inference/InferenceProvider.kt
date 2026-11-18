package kr.rabbitar.server.inference

import kotlinx.coroutines.flow.Flow

/** 추론 엔진을 갈아 끼울 수 있게 하는 경계. 관리 화면은 [engine] 과 [describe] 를 그대로 보여 준다. */
interface InferenceProvider {
    /** "geniex" 또는 "mock". 관람객 답변에 그대로 붙는다 — 가짜 엔진이 진짜인 척할 수 없다. */
    val engine: String

    /** 모델을 메모리에 올린다. 진행 상황은 [onProgress] 로 알린다. 실패하면 예외를 던진다. */
    suspend fun load(onProgress: (String) -> Unit)

    /** 토큰(글자 조각) 스트림. 수집을 취소하면 생성도 멈춘다. */
    fun generate(system: String, user: String, maxTokens: Int): Flow<String>

    /** 모델 자원을 내려놓는다. */
    suspend fun release()

    /** 진단 화면용: 실제로 무엇이 로드됐는지. */
    fun describe(): Map<String, String>
}
