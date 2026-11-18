# Rabbit AR Lab

벽에 걸린 A1 학술 포스터를 휴대폰으로 비추면, 포스터 전체가 쉬운 설명의 "토끼 입문 포스터"로 덮이고
2D 토끼 선생님과 3D 실험 장비·그래프가 포스터 앞 공간에 나타나는 WebAR.
화면 아래 채팅으로 물으면 전시자의 Galaxy 폰에서 도는 온디바이스 LLM(GenieX)이 답한다.

눈높이는 학부 1·2학년("고등학교 5학년")이다. 숫자는 전부 실제 포스터의 측정값 그대로다.

> **무엇이 검증됐고 무엇이 아닌지는 [STATUS.md](STATUS.md)에 있다.** 실기기·실제 배포가 필요한 항목은 아직 검증 전이다.

## 구성

```
apps/
  web-ar/                 관람객용 WebAR (Vite + TypeScript + Three.js + MindAR)  → GitHub Pages
  relay-worker/           고정 주소 릴레이 (Cloudflare Worker + Durable Object, WebSocket)
  rabbit-server-android/  소유자용 "Rabbit AR Server" 앱 (Kotlin + Compose + GenieX SDK)
packages/
  shared/                 웹·릴레이가 함께 쓰는 프로토콜 타입, 검증기, 허용 ID 목록
  educational-content/    연구 수치(poster_facts.json), 장면 대본, 사전제작 Q&A, LLM 문맥
assets/characters/rabbit/ 토끼 설정화 시트 (리그 원본에서 자동 생성, 확정안)
scripts/                  타깃 컴파일 절차, 수치 검증, QR 생성, 가짜 단말, 릴레이 E2E
docs/                     설치·배포·전시 운영·보안·검증 문서
reference/                인쇄 원본 PDF/PNG (git 에 올리지 않음)
```

```
관람객 휴대폰 ── GitHub Pages (WebAR + 채팅)
      │  WSS /v1/chat  (세션별)
      ▼
Cloudflare Worker + Durable Object   ← 메시지 전달만. LLM 은 여기서 돌지 않는다.
      ▲  WSS /device/connect  (폰에서 밖으로 거는 연결 1개, 토큰 인증)
      │
Galaxy S26 Ultra ── Rabbit AR Server 앱 ── GenieX 온디바이스 LLM
```

## 빨리 돌려 보기

```bash
npm install
```

```bash
npm run dev
```

`http://localhost:5173` 에서 **AR 없이 2D로 보기**를 누르면 카메라 없이 전체 내용을 볼 수 있다.
개발 서버에서는 **[개발] 모의 카메라로 AR 시험** 버튼으로 실제 추적 파이프라인을 실기기 없이 돌려 볼 수 있다
(reference/ 의 포스터 이미지를 가상 카메라로 비춘다. 실기기 검증을 대신하지 않는다).

채팅까지 로컬에서 이어 보려면 터미널 세 개:

```bash
npm run relay:dev
```

```bash
npm run mock-device
```

그리고 `http://localhost:5173/?mode=viewer&relay=http://127.0.0.1:8787` (먼저 `apps/relay-worker/.dev.vars.example` 을 `.dev.vars` 로 복사).

## 검사

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run typecheck
```

```bash
npm run validate:facts
```

Android (Android Studio 의 JDK 21 사용):

```bash
cd apps/rabbit-server-android && ./gradlew testDebugUnitTest assembleDebug
```

## 문서

| 문서 | 내용 |
|---|---|
| [STATUS.md](STATUS.md) | 기능별 검증 상태 (실측 / 자동화 테스트 / 미검증 / 미구현) |
| [docs/DEV_SETUP.md](docs/DEV_SETUP.md) | 개발 환경, 명령, 개발용 도구 |
| [docs/DEPLOY_GITHUB_PAGES.md](docs/DEPLOY_GITHUB_PAGES.md) | 웹 배포와 QR |
| [docs/SETUP_WORKERS.md](docs/SETUP_WORKERS.md) | 릴레이 배포, 토큰, Named Tunnel 대안 검토 |
| [docs/INSTALL_ANDROID.md](docs/INSTALL_ANDROID.md) | 앱 설치, 최초 설정, 원터치 운영 |
| [docs/DEVICE_VERIFICATION.md](docs/DEVICE_VERIFICATION.md) | S26 Ultra 실기기에서 확인할 것 |
| [docs/AR_CALIBRATION.md](docs/AR_CALIBRATION.md) | 좌표계, 타깃, 정합 측정값, 조정 방법 |
| [docs/EXHIBITION_CHECKLIST.md](docs/EXHIBITION_CHECKLIST.md) | 전시 당일 체크리스트 |
| [docs/SECURITY.md](docs/SECURITY.md) | 비밀값, 남용 방지, 공개 범위 |
| [scripts/compile_target.md](scripts/compile_target.md) | 이미지 타깃(.mind) 재현 절차와 결과 |

## 지켜야 할 것

- 토끼는 2D 다. 3D 모델을 만들지 않는다. 외형은 `apps/web-ar/src/rabbit/rig.ts` 한 곳에서만 바꾼다.
- 숫자는 `packages/educational-content/data/poster_facts.json` 에서만 온다. 화면·대사·답변에 숫자를 손으로 적으면 테스트가 잡는다.
- 저장소에 토큰·모델 가중치·`reference/` 를 올리지 않는다 (`.gitignore`).
