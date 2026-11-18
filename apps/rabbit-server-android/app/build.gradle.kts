plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "kr.rabbitar.server"
    compileSdk = 36

    defaultConfig {
        applicationId = "kr.rabbitar.server"
        // GenieX Android SDK 0.10.0 의 공식 요구사항: minSdk 27, arm64-v8a
        minSdk = 27
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // 교육 콘텐츠(사전제작 답변·LLM 문맥)는 웹과 같은 파일을 그대로 쓴다. 사본을 만들지 않는다.
    sourceSets["main"].assets.srcDir("../../../packages/educational-content/data")
    packaging {
        jniLibs { useLegacyPackaging = true }
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Qualcomm GenieX: 온디바이스 LLM 런타임 (Snapdragon 8 Elite / 8 Elite Gen 5)
    implementation("com.qualcomm.qti:geniex-android:0.10.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}
