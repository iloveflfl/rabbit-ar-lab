package kr.rabbitar.server.protocol

/**
 * 웹·릴레이와 공유하는 유한 ID 목록. 원본은 packages/shared/src/ids.ts 이다.
 * packages/shared/test/kotlin-sync.test.ts 가 두 파일의 목록이 같은지 검사한다.
 */
object Ids {
    const val PROTOCOL_VERSION = 1
    const val DEVICE_VERSION = "1.0.0"

    val SCENE_ACTIONS = listOf(
        "rabbit_greet", "rabbit_explain", "rabbit_surprised", "show_heating", "show_cooling",
        "show_etch_rate", "show_mounting", "show_cu_profile", "show_mo",
    )

    val HIGHLIGHT_IDS = listOf(
        "motivation", "methods", "results_thermal_continuous", "results_thermal_cyclic", "results_etch_rate",
        "results_mounting", "results_cu_profile", "results_mo", "conclusions",
    )

    val TOPIC_IDS = listOf(
        "general", "research_overview", "plasma_etching_basics", "cryogenic_vs_sample_temp", "helium_backside_cooling",
        "continuous_heating", "cyclic_cooling", "sic_etch_rate", "mounting_comparison", "cu_step_height", "mo_reference",
    )

    val FACT_IDS = listOf(
        "semester1_si_glass_benchmark", "sic_continuous_minus50", "sic_cyclic_minus50", "sic_etch_rate_setpoints",
        "sic_mounting_comparison", "cu_profile_postprocessing", "mo_reference_etch",
    )

    /** 답변을 만든 주체. 관람객 화면에 그대로 표시된다. */
    const val ENGINE_GENIEX = "geniex"
    const val ENGINE_MOCK = "mock"
    const val ENGINE_CANNED = "canned"

    const val MAX_MESSAGE_CHARS = 300
    const val MAX_REPLY_CHARS = 900
    const val MAX_DELTA_CHARS = 400

    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
    fun isUuid(s: String?): Boolean = s != null && UUID.matches(s)
}
