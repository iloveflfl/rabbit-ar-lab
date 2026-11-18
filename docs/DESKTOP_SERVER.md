# 데스크탑 서버 (LM Studio + Gemma 4)

폰의 GenieX 대신 전시자 PC 가 답하는 구성이다. 관람객이 보는 주소는 Cloudflare Worker 릴레이로 고정되고,
PC 는 그 릴레이에 **바깥으로 접속만** 한다. 공유기 포트를 열거나 LM Studio 포트를 인터넷에 노출하지 않는다.

```
관람객 폰(WebAR)  ──wss──▶  rabbit-ar-relay.<계정>.workers.dev  ◀──wss──  이 PC (scripts/desktop-device.ts)
                                                                            └─ http://127.0.0.1:1234  LM Studio
```

## 켜는 법

1. 저장소 루트에 `desktop-server.env` 가 있어야 한다 (`desktop-server.env.example` 참고. git 에 올라가지 않는다).
2. `토끼 서버 시작.bat` 을 더블클릭한다. LM Studio 서버 시작 → 모델 올리기 → 예열 → 릴레이 접속 순서로 진행된다.
3. 창에 `릴레이 연결됨` 이 보이면 준비 끝. 창을 닫으면 서버가 꺼지고, 웹은 미리 준비한 답변으로만 응답한다.

전시 중에는 PC 가 절전에 들어가지 않게 한다.

## 모델에 넣는 것

매 질문마다 같은 시스템 프롬프트를 넣는다 (`packages/educational-content/src/index.ts` 의 `fullSystemPrompt`).

- 토끼 선생님 페르소나와 규칙 (`llm_ko.json` 의 `system_prompt`)
- 포스터 사실 요약 전부 (`facts_digest`)
- `poster_facts.json` 원본 전체
- 장면별 설명 대본 (`scene_scripts_ko.json`)
- 모범 답변 (`qa_ko.json` 의 답변들)

같은 세션의 직전 대화 2턴도 함께 넣어 "더 자세히" 같은 후속 질문을 받는다.

## 답변 검사

- 동작 태그(`#동작: …`)는 allowlist 에 있는 것만 받는다. 모델이 무난한 `rabbit_explain` 을 고르면 질문 주제에 맞는 장면으로 바꾼다.
- 답변의 숫자가 포스터 자료나 질문에 없으면 그 답을 버리고 미리 준비한 답변(`canned`)을 보낸다.
- 모델 호출이 60초를 넘거나 실패해도 미리 준비한 답변을 보낸다.
- 화면에는 `전시자 PC의 로컬 AI` 배지가 붙는다.

## 실측 (2026-11-19, 이 PC: RTX 4070 Ti SUPER 16GB, gemma-4-26b-a4b-it-uncensored Q4_K_M, 문맥 16384)

`npm run try:desktop` (로컬 릴레이 + 실제 모델, 질문 8개):

- 8개 모두 모델이 답했고 숫자 검사에 걸린 것은 없었다.
- 예열 전 첫 질문: 첫 글자까지 28.6초. 그 뒤로는 첫 글자 2.5~3.6초, 전체 8.5~16.6초.
- 범위 밖 질문("점심 뭐 먹을까"), 프롬프트 탈취 시도, 자료에 없는 조건("영하 100도")은 모두 거절하거나 범위 밖이라고 답했다.

이 측정은 질문 8개짜리 한 번이다. 여러 사람이 동시에 물을 때의 대기 시간은 재지 않았다 (모델은 한 번에 한 질문만 처리한다).

## 알아 둘 점

- 지금 모델은 `uncensored` 변형이다. 주제 제한과 출력 검사는 있지만, 불특정 다수에게 공개하는 전시에는 공식 Gemma 4 instruct 모델이 더 안전하다. 바꾸려면 `desktop-server.env` 의 `LMSTUDIO_MODEL` 과 bat 파일의 모델 이름을 고친다.
- 모델(15.6GB)이 VRAM 16GB 를 거의 다 쓴다. 다른 GPU 프로그램(ComfyUI 등)과 같이 돌리면 느려지거나 실패한다.
