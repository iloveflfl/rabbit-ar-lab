package kr.rabbitar.server.server

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

enum class Phase(val label: String) {
    STOPPED("중지됨"),
    LOADING_MODEL("모델 로딩 중"),
    CONNECTING("연결 중"),
    ONLINE("온라인"),
    RECONNECTING("다시 연결 중"),
    STOPPING("끄는 중"),
    ERROR("오류"),
}

data class ServerUiState(
    val phase: Phase = Phase.STOPPED,
    val detail: String = "",
    val engine: String = "-",
    val diagnostics: Map<String, String> = emptyMap(),
    val relayHost: String = "",
    val onlineSince: Long = 0,
    val queued: Int = 0,
    val served: Int = 0,
    val failed: Int = 0,
    val sessions: Int = 0,
    val medianLatencyMs: Long = 0,
    val lastLatencyMs: Long = 0,
    val lastError: String = "",
    val log: List<String> = emptyList(),
)

/** 서비스와 화면이 공유하는 상태. 관람객의 질문·답변 내용은 여기에 넣지 않는다. */
object ServerState {
    private val _state = MutableStateFlow(ServerUiState())
    val state: StateFlow<ServerUiState> = _state

    fun update(f: (ServerUiState) -> ServerUiState) = _state.update(f)

    fun log(line: String) = _state.update {
        val t = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date())
        it.copy(log = (it.log + "$t  $line").takeLast(40))
    }
}
