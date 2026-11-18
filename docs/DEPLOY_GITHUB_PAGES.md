# 웹 배포 (GitHub Pages) 와 QR

저장소 이름·사용자명은 아직 정해지지 않았다. 아래의 `<사용자>`, `<저장소>` 는 실제 값으로 바꾼다.
이 문서에 실제로 존재하는 주소는 없다.

## 1. 저장소 준비

```bash
git init
```

```bash
git add -A && git commit -m "Rabbit AR Lab"
```

`.gitignore` 가 `reference/`, `_handoff/`, 모델 가중치, `.dev.vars` 를 뺀다.
원본 PDF 를 공개할지 여부는 소유자가 정한다(기본: 올리지 않음).

**올라가는 것 중 포스터에서 나온 것:** `apps/web-ar/public/assets/targets/poster.mind` (포스터의 특징점 데이터)는
AR 인식에 꼭 필요해서 배포본에 들어간다. 원본 이미지 자체는 들어가지 않는다.

## 2. Pages 설정

1. GitHub 저장소 → Settings → Pages → Source 를 **GitHub Actions** 로.
2. Settings → Secrets and variables → Actions → **Variables** 에 `VITE_RELAY_URL` 추가.
   값: 릴레이 주소 (예: `https://rabbit-ar-relay.<계정 서브도메인>.workers.dev`).
   비밀이 아니라 공개 주소다. 비워 두면 채팅은 사전제작 답변으로만 동작한다.
3. `main` 에 push 하면 `.github/workflows/pages.yml` 이 테스트 → 빌드 → 배포한다.

배포 주소는 `https://<사용자>.github.io/<저장소>/` 형태가 된다. 빌드는 상대 경로(`base: './'`)를 쓰므로 저장소 이름이 무엇이든 동작한다.

## 3. 릴레이에 출처 등록

Pages 주소가 정해지면 릴레이의 `ALLOWED_ORIGINS` 를 `https://<사용자>.github.io` 로 바꾸고 다시 배포한다
(SETUP_WORKERS.md). 출처 제한은 보조 수단이지 인증이 아니다.

## 4. 수동 배포 (Actions 없이)

```bash
VITE_RELAY_URL=https://<릴레이 주소> npm run build
```

`apps/web-ar/dist` 를 그대로 정적 호스팅에 올린다. 카메라는 HTTPS 에서만 열린다.

## 5. QR 스티커

주소가 **확정된 뒤에** 만든다.

```bash
npm run make:qr -- https://<사용자>.github.io/<저장소>/
```

`assets/qr/poster-qr.svg`, `poster-qr.png` 가 생긴다.

- 붙이는 곳: 실물 포스터 CONCLUSIONS 띠의 오른쪽 빈 곳.
- 크기: 한 변 45~50 mm 권장 (1 m 거리에서 폰 카메라가 읽을 수 있는 크기, 흰 여백 포함).
- 붙인 뒤 AR 인식을 다시 시험한다. 타깃을 만들 때 그 자리는 가려 두었고(`ORIGINAL_QR_ZONE`), 아래쪽 타깃에서는 결론 띠 전체를 뺐다.
- 주소가 바뀌면 QR 도 다시 인쇄해야 한다.

## 6. 배포 후 확인

- 폰에서 QR → 페이지가 3초 안에 뜨는가
- "AR 시작하기" 를 누른 **뒤에** 카메라 권한을 묻는가
- 권한을 거부하면 안내와 함께 2D 보기로 갈 수 있는가
- 랜딩의 서버 상태 표시가 실제와 맞는가
