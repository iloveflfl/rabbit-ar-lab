package kr.rabbitar.server.inference

import android.content.Context
import com.geniex.sdk.GenieXSdk
import com.geniex.sdk.LlmWrapper
import com.geniex.sdk.ModelManagerWrapper
import com.geniex.sdk.bean.ChatMessage
import com.geniex.sdk.bean.GenerationConfig
import com.geniex.sdk.bean.HubSource
import com.geniex.sdk.bean.LlmCreateInput
import com.geniex.sdk.bean.LlmStreamResult
import com.geniex.sdk.bean.ModelConfig
import com.geniex.sdk.bean.ModelPullInput
import com.geniex.sdk.bean.SamplerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kr.rabbitar.server.protocol.Ids

/**
 * Qualcomm GenieX Android SDK 0.10.0 로 온디바이스 LLM 을 돌린다.
 * API 는 SDK 의 실제 클래스(com.geniex.sdk.*)에 맞춰 컴파일된다.
 *
 * 검증 상태: 이 코드는 "컴파일"까지만 확인됐다. Galaxy S26 Ultra 실기기에서 모델 로딩·NPU 동작을
 * 확인하기 전에는 온디바이스 추론이 된다고 말할 수 없다 (docs/DEVICE_VERIFICATION.md).
 */
class GenieXInferenceProvider(
    private val context: Context,
    private val config: Config,
) : InferenceProvider {

    data class Config(
        /** 예: "unsloth/Qwen3-0.6B-GGUF" (Hugging Face) 또는 "ai-hub-models/…" (Qualcomm AI Hub) */
        val modelName: String,
        /** GGUF 양자화. AI Hub 모델이면 비운다. */
        val precision: String?,
        /** "llama_cpp" | "qairt" | null(SDK 가 모델 경로로 판단) */
        val runtimeId: String?,
        /** "npu" | "gpu" | "cpu" | null(런타임 기본값 = NPU) */
        val computeUnit: String?,
        /** AI Hub 모델을 받을 때 필요한 칩셋. 예: "SM8850" (Snapdragon 8 Elite Gen 5) */
        val chipset: String?,
        val contextTokens: Int = 4096,
    )

    override val engine = Ids.ENGINE_GENIEX

    private var llm: LlmWrapper? = null
    private var loadedPath: String? = null
    private var loadMs: Long = 0
    private var resolvedRuntime: String? = null
    @Volatile private var lastTokensPerSec: Double = 0.0
    @Volatile private var lastTtftMs: Double = 0.0
    @Volatile private var lastStopReason: String = "-"

    override suspend fun load(onProgress: (String) -> Unit) = withContext(Dispatchers.IO) {
        val started = System.currentTimeMillis()
        onProgress("GenieX SDK 초기화")
        GenieXSdk.getInstance().init(context.applicationContext)

        var paths = ModelManagerWrapper.getPaths(config.modelName)
        if (paths == null) {
            // 가중치는 처음 한 번 Hugging Face / Qualcomm AI Hub 에서 받는다. 이어받기를 지원한다.
            onProgress("모델을 내려받는 중 (처음 한 번, Wi-Fi 권장)")
            var failure: String? = null
            ModelManagerWrapper.pullFlow(
                ModelPullInput(
                    model_name = config.modelName,
                    precision = config.precision?.ifBlank { null },
                    hub = HubSource.AUTO,
                    chipset = config.chipset?.ifBlank { null },
                ),
            ).collect { event ->
                when (event) {
                    is ModelManagerWrapper.PullEvent.Progress -> {
                        val done = event.files.sumOf { it.downloaded_bytes }
                        val total = event.files.sumOf { it.total_bytes }
                        if (total > 0) onProgress("모델 내려받기 ${done * 100 / total}% (${done / 1_000_000} / ${total / 1_000_000} MB)")
                    }
                    is ModelManagerWrapper.PullEvent.Error -> failure = "모델 내려받기 실패 (${event.code}): ${event.message}"
                    else -> onProgress("모델 내려받기 완료")
                }
            }
            failure?.let { throw IllegalStateException(it) }
            paths = ModelManagerWrapper.getPaths(config.modelName) ?: throw IllegalStateException("내려받은 모델의 경로를 찾지 못했어요: ${config.modelName}")
        }

        onProgress("모델을 메모리에 올리는 중 (${config.computeUnit ?: "기본=NPU"})")
        val runtime = config.runtimeId?.ifBlank { null } ?: paths.runtime_id
        val created = LlmWrapper.builder()
            .llmCreateInput(
                LlmCreateInput(
                    model_path = paths.model_path,
                    tokenizer_path = paths.tokenizer_path,
                    config = ModelConfig(nCtx = config.contextTokens),
                    runtime_id = runtime,
                    compute_unit = config.computeUnit?.ifBlank { null },
                ),
            )
            .build()
            .getOrElse { throw IllegalStateException("모델 로딩 실패: ${it.message}", it) }
        llm = created
        loadedPath = paths.model_path
        resolvedRuntime = runtime
        loadMs = System.currentTimeMillis() - started
        onProgress("모델 준비 완료 (${loadMs / 1000.0}초)")
    }

    override fun generate(system: String, user: String, maxTokens: Int): Flow<String> = flow {
        val model = llm ?: throw IllegalStateException("모델이 로드되지 않았어요")
        // 요청마다 문맥을 비운다: 다른 관람객의 대화가 KV 캐시에 남지 않게 한다.
        model.reset()
        val chat = arrayOf(ChatMessage(role = "system", content = system), ChatMessage(role = "user", content = user))
        val templated = model.applyChatTemplate(chat, null, false).getOrElse { throw IllegalStateException("채팅 템플릿 적용 실패: ${it.message}", it) }
        val gen = GenerationConfig(
            maxTokens = maxTokens,
            samplerConfig = SamplerConfig(temperature = 0.3f, topP = 0.9f, repetitionPenalty = 1.08f),
        )
        model.generateStreamFlow(templated.formattedText, config = gen).collect { r ->
            when (r) {
                is LlmStreamResult.Token -> emit(r.text)
                is LlmStreamResult.Completed -> {
                    lastTokensPerSec = r.profile.decodingSpeed
                    lastTtftMs = r.profile.ttftMs
                    lastStopReason = r.profile.stopReason
                }
                is LlmStreamResult.Error -> throw r.throwable
            }
        }
    }.onCompletion { cause ->
        // 취소(관람객 이탈·시간 초과)되면 네이티브 생성도 멈춘다.
        if (cause != null) runCatching { runBlocking { llm?.stopStream() } }
    }.flowOn(Dispatchers.IO)

    override suspend fun release() = withContext(Dispatchers.IO) {
        runCatching { llm?.stopStream() }
        runCatching { llm?.destroy() }
        llm = null
    }

    override fun describe(): Map<String, String> = linkedMapOf(
        "엔진" to "GenieX SDK ${runCatching { GenieXSdk.getInstance().getSdkVersion() }.getOrDefault("?")}",
        "모델" to config.modelName,
        "모델 파일" to (loadedPath ?: "(로드 전)"),
        "런타임" to (resolvedRuntime ?: config.runtimeId ?: "자동"),
        "요청한 연산 장치" to (config.computeUnit ?: "기본값(NPU)"),
        "로딩 시간" to if (loadMs > 0) "${loadMs / 1000.0}초" else "-",
        "최근 생성 속도" to if (lastTokensPerSec > 0) "%.1f 토큰/초".format(lastTokensPerSec) else "-",
        "최근 첫 토큰까지" to if (lastTtftMs > 0) "%.0f ms".format(lastTtftMs) else "-",
        "최근 종료 사유" to lastStopReason,
    )
}
