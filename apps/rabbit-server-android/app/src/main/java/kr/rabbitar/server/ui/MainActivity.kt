package kr.rabbitar.server.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings as SystemSettings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kr.rabbitar.server.server.Phase
import kr.rabbitar.server.server.RabbitServerService
import kr.rabbitar.server.server.ServerState
import kr.rabbitar.server.server.ServerUiState
import kr.rabbitar.server.settings.Settings

private val Navy = Color(0xFF0B1A38)
private val Card = Color(0xFF14284F)
private val Yellow = Color(0xFFFFD44A)
private val Cyan = Color(0xFF5FD3FF)
private val Ok = Color(0xFF3DDBA8)
private val Heat = Color(0xFFFF8A6B)
private val Dim = Color(0xFFB9C8E4)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = Settings(this)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Yellow, onPrimary = Navy, surface = Card, background = Navy)) {
                Surface(Modifier.fillMaxSize(), color = Navy) {
                    var showSetup by remember { mutableStateOf(!settings.isConfigured) }
                    if (showSetup) SetupScreen(settings) { showSetup = false } else Dashboard(settings) { showSetup = true }
                }
            }
        }
    }
}

/* ───────────────────────── 대시보드: 큰 버튼 하나 ───────────────────────── */

@Composable
private fun Dashboard(settings: Settings, onEditSetup: () -> Unit) {
    val context = LocalContext.current
    val s by ServerState.state.collectAsStateWithLifecycle()
    val running = s.phase !in setOf(Phase.STOPPED, Phase.ERROR)
    val askNotif = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { RabbitServerService.start(context) }

    Column(
        Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Rabbit AR Server", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Black)
        Text(s.relayHost.ifEmpty { settings.relayUrl.removePrefix("https://") }, color = Dim, fontSize = 13.sp)
        Spacer(Modifier.height(22.dp))

        StatusBadge(s)
        Spacer(Modifier.height(18.dp))

        Button(
            onClick = {
                if (running) RabbitServerService.stop(context)
                else if (Build.VERSION.SDK_INT >= 33) askNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
                else RabbitServerService.start(context)
            },
            enabled = s.phase != Phase.STOPPING,
            modifier = Modifier.fillMaxWidth().height(96.dp),
            shape = RoundedCornerShape(28.dp),
            colors = ButtonDefaults.buttonColors(containerColor = if (running) Heat else Yellow, contentColor = Navy),
        ) {
            Text(if (running) "서버 중지" else "서버 시작", fontSize = 30.sp, fontWeight = FontWeight.Black)
        }
        Spacer(Modifier.height(10.dp))
        Steps(s.phase)

        if (s.lastError.isNotEmpty() && s.phase != Phase.ONLINE) {
            Spacer(Modifier.height(14.dp))
            Panel(border = Heat) {
                Text("최근 오류", color = Heat, fontWeight = FontWeight.Bold)
                Text(s.lastError, color = Color.White, fontSize = 14.sp)
            }
        }

        Spacer(Modifier.height(14.dp))
        Panel {
            Text("지금", color = Cyan, fontWeight = FontWeight.Bold)
            Metric("대기 중인 질문", "${s.queued}")
            Metric("동시 대화(세션)", "${s.sessions}")
            Metric("답한 질문 / 실패", "${s.served} / ${s.failed}")
            Metric("응답 시간 중앙값 / 최근", if (s.served > 0) "${"%.1f".format(s.medianLatencyMs / 1000.0)}초 / ${"%.1f".format(s.lastLatencyMs / 1000.0)}초" else "-")
            Metric("온라인 유지", Uptime(s.onlineSince))
        }

        Spacer(Modifier.height(14.dp))
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("모델 · 연산 장치 진단", color = Cyan, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                EngineTag(s.engine)
            }
            if (s.diagnostics.isEmpty()) Text("서버를 시작하면 실제로 로드된 엔진 정보가 여기에 나와요.", color = Dim, fontSize = 13.sp)
            s.diagnostics.forEach { (k, v) -> Metric(k, v) }
            DeviceHealth()
        }

        Spacer(Modifier.height(14.dp))
        Panel {
            Text("기록 (대화 내용은 저장하지 않아요)", color = Cyan, fontWeight = FontWeight.Bold)
            if (s.log.isEmpty()) Text("-", color = Dim)
            s.log.takeLast(12).forEach { Text(it, color = Dim, fontSize = 12.sp, fontFamily = FontFamily.Monospace) }
        }

        Spacer(Modifier.height(14.dp))
        BatteryHint()
        TextButton(onClick = onEditSetup, enabled = !running) { Text(if (running) "설정을 바꾸려면 서버를 먼저 중지하세요" else "최초 설정 다시 하기", color = Dim) }
    }
}

@Composable
private fun StatusBadge(s: ServerUiState) {
    val color = when (s.phase) {
        Phase.ONLINE -> Ok
        Phase.ERROR -> Heat
        Phase.STOPPED -> Color(0xFF8B98B4)
        else -> Yellow
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(14.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(10.dp))
        Text(s.phase.label, color = color, fontSize = 30.sp, fontWeight = FontWeight.Black)
    }
    if (s.detail.isNotEmpty()) Text(s.detail, color = Dim, fontSize = 13.sp)
}

/** 중지됨 → 모델 로딩 중 → 연결 중 → 온라인 */
@Composable
private fun Steps(phase: Phase) {
    val order = listOf(Phase.LOADING_MODEL to "모델", Phase.CONNECTING to "연결", Phase.ONLINE to "온라인")
    val reached = when (phase) {
        Phase.LOADING_MODEL -> 0
        Phase.CONNECTING, Phase.RECONNECTING -> 1
        Phase.ONLINE -> 2
        else -> -1
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        order.forEachIndexed { i, (_, label) ->
            val on = i <= reached
            Box(
                Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(if (on) (if (i == 2) Ok else Yellow) else Card).padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) { Text(label, color = if (on) Navy else Dim, fontSize = 13.sp, fontWeight = FontWeight.Bold) }
        }
    }
}

@Composable
private fun EngineTag(engine: String) {
    val (label, color) = when (engine) {
        "geniex" -> "GenieX 온디바이스" to Ok
        "mock" -> "MOCK · 가짜 엔진" to Color(0xFFFF3D71)
        else -> "미시작" to Color(0xFF8B98B4)
    }
    Box(Modifier.clip(RoundedCornerShape(50)).background(color).padding(horizontal = 10.dp, vertical = 3.dp)) {
        Text(label, color = Navy, fontSize = 12.sp, fontWeight = FontWeight.Black)
    }
}

/** 권한 없이 읽을 수 있는 범위의 기기 상태만 보여 준다. */
@Composable
private fun DeviceHealth() {
    val context = LocalContext.current
    var tick by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(3000)
            tick++
        }
    }
    val rt = Runtime.getRuntime()
    val usedMb = (rt.totalMemory() - rt.freeMemory()) / 1_000_000
    val pm = context.getSystemService(PowerManager::class.java)
    val thermal = if (Build.VERSION.SDK_INT >= 29) when (pm.currentThermalStatus) {
        PowerManager.THERMAL_STATUS_NONE -> "정상"
        PowerManager.THERMAL_STATUS_LIGHT -> "조금 따뜻함"
        PowerManager.THERMAL_STATUS_MODERATE -> "따뜻함 (성능 저하 가능)"
        PowerManager.THERMAL_STATUS_SEVERE -> "뜨거움 (성능 제한)"
        else -> "매우 뜨거움 — 잠시 쉬게 하세요"
    } else "-"
    Metric("앱 메모리(JVM)", "$usedMb MB")
    Metric("발열 상태", thermal)
    Metric("기기", "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} · ${socModel()}")
    @Suppress("UNUSED_EXPRESSION") tick
}

private fun socModel(): String = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else Build.HARDWARE

@Composable
private fun Uptime(since: Long): String {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(since) {
        while (since > 0) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    if (since <= 0) return "-"
    val sec = (now - since).coerceAtLeast(0) / 1000
    return "%d:%02d:%02d".format(sec / 3600, sec / 60 % 60, sec % 60)
}

@Composable
private fun BatteryHint() {
    val context = LocalContext.current
    val pm = context.getSystemService(PowerManager::class.java)
    if (pm.isIgnoringBatteryOptimizations(context.packageName)) return
    Panel(border = Yellow) {
        Text("전시 전에 확인", color = Yellow, fontWeight = FontWeight.Bold)
        Text("배터리 최적화가 켜져 있으면 화면이 꺼진 뒤 서버가 멈출 수 있어요. 앱 정보 → 배터리 → '제한 없음'으로 바꾸고, 충전기를 꽂아 두세요.", color = Color.White, fontSize = 13.sp)
        OutlinedButton(onClick = {
            context.startActivity(Intent(SystemSettings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")))
        }) { Text("앱 정보 열기") }
    }
}

@Composable
private fun Panel(border: Color? = null, content: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(if (border != null) border.copy(alpha = 0.14f) else Card).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) { content() }
}

@Composable
private fun Metric(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(label, color = Dim, fontSize = 13.sp, modifier = Modifier.weight(0.9f))
        Text(value, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1.1f))
    }
}

/* ───────────────────────── 최초 설정 (한 번만) ───────────────────────── */

@Composable
private fun SetupScreen(settings: Settings, onDone: () -> Unit) {
    var relay by remember { mutableStateOf(settings.relayUrl) }
    var token by remember { mutableStateOf("") }
    var provider by remember { mutableStateOf(settings.provider) }
    var model by remember { mutableStateOf(settings.modelName) }
    var precision by remember { mutableStateOf(settings.precision) }
    var unit by remember { mutableStateOf(settings.computeUnit) }
    var runtime by remember { mutableStateOf(settings.runtimeId) }
    var chipset by remember { mutableStateOf(settings.chipset) }
    var error by remember { mutableStateOf("") }

    Column(Modifier.fillMaxSize().systemBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("최초 설정", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Black)
        Text("한 번만 입력하면 다음부터는 '서버 시작' 버튼 하나로 켜져요.", color = Dim, fontSize = 14.sp)

        Panel {
            Text("1. 릴레이 연결", color = Cyan, fontWeight = FontWeight.Bold)
            OutlinedTextField(relay, { relay = it }, label = { Text("릴레이 주소 (https://….workers.dev)") }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(
                token, { token = it },
                label = { Text(if (settings.hasToken) "단말 토큰 (저장됨 · 바꿀 때만 입력)" else "단말 토큰 (wrangler secret DEVICE_TOKEN 과 같은 값)") },
                singleLine = true, modifier = Modifier.fillMaxWidth(), visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
            Text("토큰은 이 기기의 Android Keystore 로 암호화해 저장하고, 화면·알림·기록에 표시하지 않아요.", color = Dim, fontSize = 12.sp)
        }

        Panel {
            Text("2. 추론 엔진", color = Cyan, fontWeight = FontWeight.Bold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(provider == "geniex", { provider = "geniex" }, { Text("GenieX 온디바이스") })
                FilterChip(provider == "mock", { provider = "mock" }, { Text("MOCK (연결 시험용)") })
            }
            if (provider == "geniex") {
                OutlinedTextField(model, { model = it }, label = { Text("모델 이름 (Hugging Face / ai-hub-models)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(precision, { precision = it }, label = { Text("양자화 (GGUF, 예: Q4_0 · AI Hub 모델이면 비움)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("연산 장치", color = Dim, fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("" to "기본(NPU)", "npu" to "NPU", "gpu" to "GPU", "cpu" to "CPU").forEach { (v, l) -> FilterChip(unit == v, { unit = v }, { Text(l) }) }
                }
                Text("런타임", color = Dim, fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("" to "자동", "llama_cpp" to "llama_cpp (GGUF)", "qairt" to "qairt (AI Hub)").forEach { (v, l) -> FilterChip(runtime == v, { runtime = v }, { Text(l) }) }
                }
                OutlinedTextField(chipset, { chipset = it }, label = { Text("칩셋 (AI Hub 모델만, 예: SM8850)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Text("모델 가중치는 첫 시작 때 한 번 내려받아요(Wi-Fi 권장). 실제로 NPU 에서 도는지는 시작 후 진단 화면에서 확인하세요.", color = Dim, fontSize = 12.sp)
            } else {
                Text("MOCK 은 모델 없이 미리 준비한 답변을 흘려보내요. 관람객 화면에 'MOCK'이라고 표시돼요.", color = Dim, fontSize = 12.sp)
            }
        }

        if (error.isNotEmpty()) Text(error, color = Heat, fontWeight = FontWeight.Bold)

        Button(
            onClick = {
                val url = relay.trim()
                error = when {
                    !url.startsWith("https://") -> "릴레이 주소는 https:// 로 시작해야 해요."
                    token.isBlank() && !settings.hasToken -> "단말 토큰을 입력해 주세요."
                    token.isNotBlank() && token.trim().length < 24 -> "토큰이 너무 짧아요 (24자 이상)."
                    provider == "geniex" && model.isBlank() -> "모델 이름을 입력해 주세요."
                    else -> ""
                }
                if (error.isEmpty()) {
                    settings.relayUrl = url
                    if (token.isNotBlank()) settings.saveToken(token)
                    settings.provider = provider
                    settings.modelName = model
                    settings.precision = precision
                    settings.computeUnit = unit
                    settings.runtimeId = runtime
                    settings.chipset = chipset
                    onDone()
                }
            },
            modifier = Modifier.fillMaxWidth().height(60.dp), shape = RoundedCornerShape(18.dp),
        ) { Text("저장", fontSize = 20.sp, fontWeight = FontWeight.Black) }
        if (settings.isConfigured) TextButton(onClick = onDone) { Text("취소", color = Dim) }
    }
}
