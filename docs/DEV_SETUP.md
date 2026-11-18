# 개발 환경

## 필요한 것

- Node.js 22 이상 (전역 `WebSocket` 사용), npm
- Android 앱: Android Studio (번들 JDK 21), Android SDK 36, Gradle 은 래퍼가 내려받음
- 릴레이 로컬 실행에는 Cloudflare 계정이 필요 없다 (`wrangler dev` 가 로컬 런타임으로 돈다)

## 설치와 실행

```bash
npm install
```

```bash
npm run dev
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 웹 개발 서버 (기본 5173) |
| `npm run build` | 정적 사이트 → `apps/web-ar/dist` |
| `npm run relay:dev` | 릴레이 로컬 실행 (8787). `.dev.vars` 필요 |
| `npm run mock-device` | 가짜 단말을 릴레이에 붙임 (`engine: mock`) |
| `npm test` | 단위 테스트 (프로토콜·콘텐츠·릴레이·레이아웃·리그) |
| `npm run test:e2e` | 실제 Worker 런타임으로 릴레이 전 구간 시험 |
| `npm run typecheck` | 타입 검사 |
| `npm run validate:facts` | 연구 수치 보호 검사 |
| `npm run export:rabbit` | 토끼 설정화 시트 다시 생성 |
| `npm run make:qr -- <주소>` | QR 스티커 생성 (주소 확정 후) |

## 개발용 주소

| 주소 | 용도 |
|---|---|
| `/` | 랜딩 |
| `/?mode=viewer` | 2D 보기로 바로 |
| `/?mode=sim` | 모의 카메라 AR (개발 서버에서만) |
| `/?relay=http://127.0.0.1:8787` | 릴레이 주소 덮어쓰기 (개발 서버에서만) |
| `/?q=low` | 저사양 모드 강제 |
| `/tools/compile-target.html` | 이미지 타깃 컴파일 |

배포본에서는 `?relay=` 와 `?mode=sim` 이 동작하지 않는다. 릴레이 주소는 빌드할 때 `VITE_RELAY_URL` 로 정한다.

## 개발용 진단 훅

개발 서버에서 AR 또는 2D 보기를 열면 `window.__rabbit` 이 생긴다.

```js
__rabbit.stage.goScene('cyclic_cooling')   // 장면 이동
__rabbit.ar.trackState                     // 'searching' | 'tracking' | 'lost'
__rabbit.ar.simCamera.covered = true       // (모의) 포스터 가리기 → 추적 상실 시험
__rabbit.ar.simCamera.qrSticker = true     // (모의) QR 스티커 붙이기
await __rabbit.snap('name')                // 영상+AR 합성 화면을 apps/web-ar/.devshots/name.png 로 저장
```

## Android

```bash
cd apps/rabbit-server-android && ./gradlew testDebugUnitTest assembleDebug
```

`JAVA_HOME` 은 Android Studio 의 JBR(21) 을 가리키게 한다. `local.properties` 의 `sdk.dir` 은 각자 환경에 맞춘다.
교육 콘텐츠 JSON 은 `packages/educational-content/data` 를 assets 로 직접 읽으므로 사본이 없다.

버전을 고정한 이유:
- Android Gradle Plugin 9.2.1 — Gradle 9.4.1 과 맞는 버전
- Compose BOM 2025.10.01, OkHttp 4.12.0 — 더 새 버전은 compileSdk 37 을 요구한다
- GenieX `com.qualcomm.qti:geniex-android:0.10.0` — 2026-11 기준 최신. 버전을 올릴 때는 `GenieXInferenceProvider.kt` 가 컴파일되는지 확인

## 구조에서 알아 둘 것

- `packages/shared` 의 ID 목록과 Android `Ids.kt` 는 `kotlin-sync.test.ts` 가 같은지 검사한다.
- 질문 매칭 규칙은 TypeScript(`packages/educational-content/src/index.ts`)와 Kotlin(`Content.kt`)에 한 번씩 있다. 두 쪽 테스트가 같은 질문에 같은 답을 기대한다.
- MindAR 는 npm 의존성이 아니라 `apps/web-ar/src/vendor/mindar/` 에 배포 파일(1.2.5, MIT)을 넣어 두었다. Three.js 접착 코드는 직접 썼다(`ar/tracker.ts`).
