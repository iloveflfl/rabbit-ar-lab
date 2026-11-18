package kr.rabbitar.server.settings

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 최초 설정값. 단말 토큰은 Android Keystore 의 AES-GCM 키로 암호화해서 저장한다
 * (키는 기기 밖으로 나가지 않는다). 토큰을 로그·알림·화면에 그대로 내보내지 않는다.
 */
class Settings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("rabbit_server", Context.MODE_PRIVATE)

    var relayUrl: String
        get() = prefs.getString("relay_url", "") ?: ""
        set(v) = prefs.edit().putString("relay_url", v.trim().trimEnd('/')).apply()

    /** "geniex" 또는 "mock" */
    var provider: String
        get() = prefs.getString("provider", "geniex") ?: "geniex"
        set(v) = prefs.edit().putString("provider", v).apply()

    var modelName: String
        get() = prefs.getString("model_name", DEFAULT_MODEL) ?: DEFAULT_MODEL
        set(v) = prefs.edit().putString("model_name", v.trim()).apply()

    var precision: String
        get() = prefs.getString("precision", DEFAULT_PRECISION) ?: DEFAULT_PRECISION
        set(v) = prefs.edit().putString("precision", v.trim()).apply()

    /** "" = 런타임 기본값(NPU), "npu" | "gpu" | "cpu" */
    var computeUnit: String
        get() = prefs.getString("compute_unit", "") ?: ""
        set(v) = prefs.edit().putString("compute_unit", v).apply()

    /** "" = 자동, "llama_cpp" | "qairt" */
    var runtimeId: String
        get() = prefs.getString("runtime_id", "") ?: ""
        set(v) = prefs.edit().putString("runtime_id", v).apply()

    var chipset: String
        get() = prefs.getString("chipset", "") ?: ""
        set(v) = prefs.edit().putString("chipset", v.trim()).apply()

    val hasToken: Boolean get() = prefs.contains("token_ct")

    fun saveToken(token: String) {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ct = cipher.doFinal(token.trim().toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString("token_ct", Base64.encodeToString(ct, Base64.NO_WRAP))
            .putString("token_iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    /** 복호화에 실패하면(키가 사라진 경우 등) null. 그때는 토큰을 다시 입력받는다. */
    fun loadToken(): String? = try {
        val ct = Base64.decode(prefs.getString("token_ct", null) ?: return null, Base64.NO_WRAP)
        val iv = Base64.decode(prefs.getString("token_iv", null) ?: return null, Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(ct), Charsets.UTF_8)
    } catch (e: Exception) {
        null
    }

    fun clearToken() = prefs.edit().remove("token_ct").remove("token_iv").apply()

    val isConfigured: Boolean get() = relayUrl.startsWith("https://") && hasToken

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    companion object {
        private const val KEY_ALIAS = "rabbit_device_token_key"
        private const val TRANSFORM = "AES/GCM/NoPadding"

        /** GenieX 공식 빠른 시작의 예시 모델. 전시에 쓸 모델은 실기기에서 한국어 품질·속도를 보고 고른다. */
        const val DEFAULT_MODEL = "unsloth/Qwen3-0.6B-GGUF"
        const val DEFAULT_PRECISION = "Q4_0"
    }
}
