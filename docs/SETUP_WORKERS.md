# 릴레이 배포 (Cloudflare Workers + Durable Objects)

릴레이는 관람객 브라우저와 전시자의 폰 사이에서 **메시지만 전달**한다. LLM 은 폰에서 돈다.
폰이 꺼져 있으면 릴레이는 `offline` 이라고 답하고, 웹은 사전제작 답변으로 넘어간다.

## 왜 이 방식인가

| | 릴레이 (채택) | Named Tunnel (대안) |
|---|---|---|
| 폰에서 필요한 것 | 앱이 밖으로 WebSocket 하나를 건다 | `cloudflared` 를 폰에서 계속 실행 |
| 고정 주소 | `*.workers.dev` (도메인 없이 가능) | Cloudflare 에 등록한 **소유 도메인** 필요 |
| Android 적합성 | 표준 네트워킹만 사용 | 리눅스용 바이너리가 앱 안에서 돈다는 보장이 없음. Termux 에 기대면 원터치가 깨짐 |
| 남용 방지 | Worker 에서 속도 제한·대기열·스키마 검증 | 폰의 서버가 직접 받아야 함 |

Named Tunnel 은 구현하지 않았다. 소유 도메인이 있고 폰에서 `cloudflared` 를 안정적으로 돌릴 수 있음이 확인되면
`https://api.<도메인>` → `localhost:<포트>` 구조로 바꿀 수 있지만, 그러려면 앱에 로컬 HTTP 서버를 따로 넣어야 한다.
Quick Tunnel(`trycloudflare.com`)은 주소가 매번 바뀌므로 QR 에 쓸 수 없다.

## 배포

Cloudflare 계정에서 한 번:

```bash
cd apps/relay-worker && npx wrangler login
```

단말 토큰을 만든다 (32바이트 무작위):

```bash
npm -w @rabbit/relay-worker run token
```

나온 값을 Worker secret 으로 등록한다. 값은 저장소·문서·채팅에 남기지 않는다.

```bash
cd apps/relay-worker && npx wrangler secret put DEVICE_TOKEN
```

`wrangler.jsonc` 의 `ALLOWED_ORIGINS` 를 GitHub Pages 출처로 바꾼 뒤 배포한다.

```bash
npm run relay:deploy
```

출력에 나오는 `https://rabbit-ar-relay.<계정 서브도메인>.workers.dev` 가 고정 주소다.
Worker 이름과 계정 서브도메인을 바꾸지 않는 한 유지된다. 이 주소를

- 웹 빌드의 `VITE_RELAY_URL` 에,
- 폰 앱의 최초 설정 "릴레이 주소" 에 넣는다. 같은 토큰을 앱의 "단말 토큰" 에 넣는다.

요금제: Durable Object 는 SQLite 기반(`new_sqlite_classes`)으로 선언해 Workers Free 에서도 쓸 수 있게 했다.
무료 한도(요청 수, DO 사용 시간)는 배포 전에 Cloudflare 문서에서 현재 값을 확인한다. 실제 배포는 아직 해 보지 않았다.

## 엔드포인트

| 경로 | 누구 | 설명 |
|---|---|---|
| `GET /health` | 공개 | `{status, version, connectedAt, queueDepth}` 만. 모델·기기 정보 없음 |
| `WSS /v1/chat` | 관람객 | `hello` → `chat.request` → `chat.queued` / `chat.delta`* / `chat.final` 또는 `chat.error` |
| `POST /v1/chat` | 관람객 | WebSocket 을 못 쓸 때. `chat.request` 본문 → 최종 답 JSON |
| `WSS /device/connect` | 폰 | `Authorization: Bearer <DEVICE_TOKEN>`. 인증 실패 401 |
| `GET /device/status` | 소유자 | 같은 토큰. 엔진·접속 수·오늘 사용량 |

메시지 형식과 검증기는 `packages/shared/src/protocol.ts` 에 있다.

## 제한값 (`packages/shared/src/ids.ts` 의 `LIMITS`)

| 항목 | 값 |
|---|---|
| 질문 길이 | 300자 |
| 답변 길이 | 900자 (넘으면 자름) |
| 세션당 동시 질문 | 1 |
| 세션당 분당 | 6 |
| IP 당 분당 | 20 |
| 전체 대기열 | 8 |
| 하루 총 질문 | 3,000 |
| 질문 하나의 최대 대기 | 75초 |
| 동시 관람객 소켓 | 120 |

## 동작 방식에서 알아 둘 것

- 관람객 응답은 `requestId` 로 찾고 `sessionId` 를 대조한다. 어긋나면 전달하지 않는다.
- 한 번 쓴 `requestId` 는 다시 받지 않는다.
- 스키마를 어긴 관람객 프레임은 연결을 끊는다. 폰이 보낸 잘못된 프레임은 버리기만 한다.
- 같은 토큰으로 두 번째 폰이 붙으면 첫 번째 연결을 닫는다(코드 4001). 앱은 4001 을 받으면 재접속하지 않는다.
- Durable Object 는 WebSocket Hibernation 을 쓴다. 휴면에서 깨면 소켓에 붙여 둔 최소 정보로 연결표를 다시 만든다.
  진행 중이던 요청의 시간 제한은 메모리에 있으므로, 그 사이 휴면이 끼면 웹 쪽 시간 제한(80초)이 대신 끊는다.
- 대화 내용은 어디에도 저장하지 않는다. 저장하는 것은 "오늘 몇 건 처리했나" 숫자 하나뿐이다.

## 로컬에서 시험

```bash
npm run test:e2e
```

`wrangler dev` 로 실제 Worker 런타임을 띄우고, 가짜 단말 1대와 관람객 2명으로 인증·격리·스트리밍·재사용 방지·오프라인 전환을 확인한다.
