package kr.rabbitar.server.server

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * 릴레이로 나가는(outbound) WebSocket 하나를 유지한다. 이 앱은 어떤 포트도 열지 않는다.
 * 끊기면 지수 백오프로 다시 붙는다. 토큰은 Authorization 헤더로만 보낸다(URL·로그에 넣지 않는다).
 */
class RelayClient(
    private val relayUrl: String,
    private val token: String,
    private val engine: () -> String,
    private val scope: CoroutineScope,
    private val listener: Listener,
) {
    interface Listener {
        fun onConnecting(attempt: Int)
        /** 릴레이가 hello 를 받아 준 시점 = 실제로 관람객 질문을 받을 수 있는 시점 */
        fun onOnline()
        fun onOffline(reason: String, willRetry: Boolean)
        fun onFrame(type: String, json: JSONObject)
    }

    private val http = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    private var retryJob: Job? = null
    private var attempt = 0
    @Volatile private var wanted = false

    fun start() {
        wanted = true
        attempt = 0
        connect()
    }

    fun stop() {
        wanted = false
        retryJob?.cancel()
        ws?.close(1000, "bye")
        ws = null
    }

    fun send(text: String): Boolean = ws?.send(text) ?: false

    /** 네트워크가 바뀌었을 때(Wi-Fi ↔ LTE) 기다리지 않고 바로 다시 붙는다. */
    fun reconnectNow() {
        if (!wanted) return
        retryJob?.cancel()
        ws?.cancel()
        ws = null
        attempt = 0
        connect()
    }

    private fun connect() {
        if (!wanted) return
        listener.onConnecting(attempt)
        val url = relayUrl.trimEnd('/').replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws") + "/device/connect"
        val request = try {
            Request.Builder().url(url).header("Authorization", "Bearer $token").build()
        } catch (e: IllegalArgumentException) {
            listener.onOffline("릴레이 주소 형식이 잘못됐어요", false)
            return
        }
        ws = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(kr.rabbitar.server.protocol.Frames.hello(engine()))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== ws) return
                val json = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    return
                }
                val type = json.optString("type")
                if (type == "hello.ack") {
                    attempt = 0
                    listener.onOnline()
                } else if (type == "ping") {
                    webSocket.send("{\"type\":\"pong\"}")
                } else {
                    listener.onFrame(type, json)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== ws) return
                ws = null
                // 4001: 같은 토큰으로 다른 단말이 붙어서 밀려남 → 서로 밀어내며 무한 반복하지 않도록 재시도하지 않는다.
                if (code == 4001) {
                    wanted = false
                    listener.onOffline("다른 기기가 같은 토큰으로 접속했어요", false)
                } else retry("연결이 닫혔어요 ($code)")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== ws) return
                ws = null
                when (response?.code) {
                    401 -> {
                        wanted = false
                        listener.onOffline("단말 토큰이 릴레이의 DEVICE_TOKEN 과 달라요 (401)", false)
                    }
                    503 -> retry("릴레이에 DEVICE_TOKEN 이 설정되지 않았어요 (503)")
                    null -> retry(t.message ?: "네트워크 오류")
                    else -> retry("릴레이 응답 ${response.code}")
                }
            }
        })
    }

    private fun retry(reason: String) {
        if (!wanted) return
        val wait = minOf(30_000L, 1500L * (1L shl minOf(attempt, 5))) + Random.nextLong(0, 800)
        attempt++
        listener.onOffline(reason, true)
        retryJob = scope.launch {
            delay(wait)
            connect()
        }
    }
}
