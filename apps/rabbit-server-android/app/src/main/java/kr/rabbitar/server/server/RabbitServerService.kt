package kr.rabbitar.server.server

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kr.rabbitar.server.R
import kr.rabbitar.server.content.Content
import kr.rabbitar.server.inference.GenieXInferenceProvider
import kr.rabbitar.server.inference.InferenceProvider
import kr.rabbitar.server.inference.MockInferenceProvider
import kr.rabbitar.server.protocol.ChatRequest
import kr.rabbitar.server.protocol.Frames
import kr.rabbitar.server.settings.Settings
import kr.rabbitar.server.ui.MainActivity
import org.json.JSONObject
import java.net.URI

/**
 * "서버 시작" 한 번으로:  모델 로딩 → 릴레이 연결 → hello 확인 → 온라인.
 * "서버 중지" 한 번으로:  새 요청 차단 → 진행 요청 정리 → 연결 종료 → 모델 해제.
 *
 * 포그라운드 서비스라서 화면이 꺼져도 계속 돌 가능성이 높지만, Android 가 항상 살려 둔다는 보장은 없다.
 * 전시 중에는 충전기를 꽂고 배터리 최적화를 꺼 둔다 (docs/EXHIBITION_CHECKLIST.md).
 */
class RabbitServerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var startJob: Job? = null
    private var provider: InferenceProvider? = null
    private var relay: RelayClient? = null
    private var orchestrator: ChatOrchestrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var hadNetwork = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> shutdown()
            else -> if (startJob == null) startUp()
        }
        // 시스템이 서비스를 죽였을 때 자동으로 되살리지 않는다: 소유자가 모르는 사이에 공개 서버가 켜지면 안 된다.
        return START_NOT_STICKY
    }

    private fun startUp() {
        val settings = Settings(this)
        val token = settings.loadToken()
        startForegroundNow("시작하는 중")
        if (!settings.isConfigured || token == null) {
            fail("최초 설정이 끝나지 않았어요 (릴레이 주소·단말 토큰)")
            return
        }
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "rabbit:server").apply { acquire(12 * 60 * 60 * 1000L) }

        startJob = scope.launch {
            try {
                // 1) 모델
                setPhase(Phase.LOADING_MODEL, "")
                val content = Content(readAsset("qa_ko.json"), readAsset("llm_ko.json"))
                val p: InferenceProvider = if (settings.provider == "mock") MockInferenceProvider(content) else GenieXInferenceProvider(
                    applicationContext,
                    GenieXInferenceProvider.Config(settings.modelName, settings.precision, settings.runtimeId, settings.computeUnit, settings.chipset),
                )
                provider = p
                ServerState.update { it.copy(engine = p.engine, diagnostics = p.describe(), relayHost = hostOf(settings.relayUrl), lastError = "") }
                p.load { msg ->
                    ServerState.update { it.copy(detail = msg) }
                    ServerState.log(msg)
                    notify("모델 로딩 중 · $msg")
                }
                ServerState.update { it.copy(diagnostics = p.describe()) }

                // 2) 릴레이
                setPhase(Phase.CONNECTING, hostOf(settings.relayUrl))
                val client = RelayClient(settings.relayUrl, token, { p.engine }, scope, relayListener)
                relay = client
                val orch = ChatOrchestrator(content, p, scope, send = { client.send(it) }, onStats = { s ->
                    val sorted = s.latenciesMs.sorted()
                    ServerState.update {
                        it.copy(
                            queued = s.queued, served = s.served, failed = s.failed, sessions = s.sessions,
                            medianLatencyMs = sorted.getOrElse(sorted.size / 2) { 0 }, lastLatencyMs = s.latenciesMs.lastOrNull() ?: 0,
                            diagnostics = p.describe(),
                        )
                    }
                })
                orchestrator = orch
                orch.start()
                client.start()
                watchNetwork()
            } catch (e: Exception) {
                fail(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    private val relayListener = object : RelayClient.Listener {
        override fun onConnecting(attempt: Int) {
            if (ServerState.state.value.phase != Phase.ONLINE) setPhase(if (attempt == 0) Phase.CONNECTING else Phase.RECONNECTING, "시도 ${attempt + 1}")
        }

        override fun onOnline() {
            // hello.ack 를 받았다 = 릴레이가 이 단말을 인증했고 관람객 질문을 넘겨줄 준비가 됐다.
            ServerState.update { it.copy(phase = Phase.ONLINE, detail = "", onlineSince = System.currentTimeMillis(), lastError = "") }
            ServerState.log("온라인")
            notify("온라인 · 관람객 질문을 받는 중")
        }

        override fun onOffline(reason: String, willRetry: Boolean) {
            ServerState.log("연결 끊김: $reason")
            if (willRetry) {
                ServerState.update { it.copy(phase = Phase.RECONNECTING, detail = reason, lastError = reason) }
                notify("다시 연결 중 · $reason")
            } else fail(reason)
        }

        override fun onFrame(type: String, json: JSONObject) {
            when (type) {
                "chat.request" -> ChatRequest.parse(json)?.let { orchestrator?.submit(it) }
                "cancel" -> json.optString("requestId").takeIf { it.isNotEmpty() }?.let { orchestrator?.cancel(it) }
            }
        }
    }

    /** Wi-Fi ↔ LTE 전환 등으로 네트워크가 바뀌면 백오프를 기다리지 않고 바로 다시 붙는다. */
    private fun watchNetwork() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (hadNetwork) {
                    ServerState.log("네트워크 변경 감지 → 재연결")
                    relay?.reconnectNow()
                }
                hadNetwork = true
            }
        }
        networkCallback = cb
        cm.registerDefaultNetworkCallback(cb)
    }

    private fun shutdown() {
        setPhase(Phase.STOPPING, "")
        startJob?.cancel()
        startJob = null
        orchestrator?.stop() // 새 요청 차단 + 진행 요청 정리
        orchestrator = null
        relay?.stop() // 릴레이는 곧바로 offline 을 방송한다
        relay = null
        networkCallback?.let { runCatching { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } }
        networkCallback = null
        val p = provider
        provider = null
        scope.launch {
            runCatching { p?.release() }
            ServerState.update { it.copy(phase = Phase.STOPPED, detail = "", queued = 0, onlineSince = 0) }
            ServerState.log("중지됨")
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun fail(reason: String) {
        ServerState.update { it.copy(phase = Phase.ERROR, detail = reason, lastError = reason, onlineSince = 0) }
        ServerState.log("오류: $reason")
        orchestrator?.stop()
        orchestrator = null
        relay?.stop()
        relay = null
        val p = provider
        provider = null
        scope.launch { runCatching { p?.release() } }
        startJob = null
        releaseWakeLock()
        notify("오류 · $reason")
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    private fun setPhase(phase: Phase, detail: String) {
        ServerState.update { it.copy(phase = phase, detail = detail) }
        ServerState.log(phase.label + if (detail.isNotEmpty()) " · $detail" else "")
        notify(phase.label)
    }

    private fun readAsset(name: String): String = assets.open(name).bufferedReader(Charsets.UTF_8).use { it.readText() }

    private fun hostOf(url: String): String = runCatching { URI(url).host }.getOrNull() ?: url

    /* ───── 알림 ───── */

    private fun buildNotification(text: String): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Rabbit AR Server", NotificationManager.IMPORTANCE_LOW).apply { description = "서버 실행 상태" })
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, RabbitServerService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_rabbit)
            .setContentTitle("Rabbit AR Server 실행 중")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "서버 중지", stop).build())
            .build()
    }

    private fun startForegroundNow(text: String) {
        val n = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(NOTIFICATION_ID, n)
    }

    private fun notify(text: String) {
        runCatching { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(text)) }
    }

    override fun onDestroy() {
        orchestrator?.stop()
        relay?.stop()
        networkCallback?.let { runCatching { (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it) } }
        releaseWakeLock()
        scope.cancel()
        if (ServerState.state.value.phase !in setOf(Phase.ERROR, Phase.STOPPED)) ServerState.update { it.copy(phase = Phase.STOPPED, detail = "시스템이 서비스를 종료했어요", onlineSince = 0) }
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "kr.rabbitar.server.STOP"
        private const val CHANNEL = "rabbit_server"
        private const val NOTIFICATION_ID = 7301

        fun start(context: Context) = context.startForegroundService(Intent(context, RabbitServerService::class.java))
        fun stop(context: Context) = context.startService(Intent(context, RabbitServerService::class.java).setAction(ACTION_STOP))
    }
}
