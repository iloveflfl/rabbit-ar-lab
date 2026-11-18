package kr.rabbitar.server

import kr.rabbitar.server.content.Content
import kr.rabbitar.server.protocol.ChatAnswer
import kr.rabbitar.server.protocol.ChatRequest
import kr.rabbitar.server.protocol.Frames
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 웹(TypeScript)과 같은 JSON 을 읽어 같은 결과를 내는지 확인한다. */
class ContentTest {
    private val data = File("../../../packages/educational-content/data")
    private val content = Content(File(data, "qa_ko.json").readText(), File(data, "llm_ko.json").readText())

    @Test fun standardQuestions() {
        assertEquals("why_minus50_but_73", content.matchCanned("왜 영하 50도인데 기판은 73도야?").id)
        assertEquals("what_is_sic_etching", content.matchCanned("SiC 식각은 뭐야?").id)
        assertEquals("why_cool_3min", content.matchCanned("냉각을 왜 3분씩 했어?").id)
    }

    @Test fun specExamples() {
        assertEquals("show_heating", content.matchCanned("냉각기가 −50도인데 왜 기판은 73도야?").animation)
        assertEquals("show_cooling", content.matchCanned("30초만 식각하면 기판이 안 뜨거워?").animation)
        assertEquals("show_etch_rate", content.matchCanned("−40도가 −20도보다 왜 더 안 깎였어?").animation)
    }

    @Test fun materialsDoNotLeakIntoEachOther() {
        assertEquals("mo_reference", content.matchCanned("Mo 식각률은?").id)
        assertEquals("results_cu_profile", content.matchCanned("구리 식각률은 얼마야?").highlight)
        assertEquals("why_minus40_lowest", content.matchCanned("SiC 식각률은 얼마야?").id)
    }

    @Test fun keywordBoundaries() {
        assertFalse(Content.containsKeyword("chiller", "he"))
        assertTrue(Content.containsKeyword("he가뭐야", "he"))
        assertFalse(Content.containsKeyword("175도", "75"))
        assertEquals("fallback", content.matchCanned("motivation").id)
        assertEquals("fallback", content.matchCanned("오늘 점심 뭐 먹지").id)
    }

    @Test fun promptCarriesOnlyRoutedFacts() {
        val p = content.buildPrompt("식각률이 왜 75야?")
        assertEquals(listOf("sic_etch_rate_setpoints"), p.factIds)
        assertTrue(p.system.contains("201/75/185"))
        assertFalse(p.system.contains("10,999"))
    }

    @Test fun modelOutputParsing() {
        val ok = content.parseModelOutput("설정값과 실제 온도는 달라!\n#동작: show_heating")
        assertEquals("설정값과 실제 온도는 달라!", ok.reply)
        assertEquals("show_heating", ok.animation)
        val bad = content.parseModelOutput("답이야 #동작: launch_missiles")
        assertEquals("답이야", bad.reply)
        assertNull(bad.animation)
    }

    @Test fun requestValidation() {
        val sid = "123e4567-e89b-42d3-a456-426614174000"
        val good = JSONObject().put("requestId", sid).put("sessionId", sid).put("topic", "sic_etch_rate").put("message", " 왜\n그래? ")
        assertEquals("왜 그래?", ChatRequest.parse(good)!!.message)
        assertNull(ChatRequest.parse(JSONObject(good.toString()).put("requestId", "nope")))
        assertNull(ChatRequest.parse(JSONObject(good.toString()).put("message", "x".repeat(301))))
        assertEquals("general", ChatRequest.parse(JSONObject(good.toString()).put("topic", "rm -rf"))!!.topic)
    }

    @Test fun finalFrameDropsUnknownIds() {
        val sid = "123e4567-e89b-42d3-a456-426614174000"
        val req = ChatRequest(sid, sid, "general", "q", null)
        val f = JSONObject(Frames.final(req, ChatAnswer("답", "eval(1)", "nope", listOf("made_up", "mo_reference_etch"), "geniex")))
        assertTrue(f.isNull("animation"))
        assertTrue(f.isNull("highlight"))
        assertEquals(1, f.getJSONArray("sourceFactIds").length())
        assertNotNull(f.getString("reply"))
    }
}
