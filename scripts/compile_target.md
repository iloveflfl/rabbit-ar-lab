# 이미지 타깃(.mind) 컴파일 — 재현 절차와 결과

MindAR 의 컴파일러는 브라우저(TensorFlow.js)에서 돈다. 명령줄 한 줄로는 만들 수 없어서,
개발 서버에 컴파일 페이지를 넣어 두었다.

## 준비

`reference/poster_print_master_2526x3576.png` 가 있어야 한다 (QR 스티커를 붙이기 전의 인쇄 원본).
PDF 에서 다시 만들려면:

```bash
python -I scripts/render_poster.py
```

## 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:5173/tools/compile-target.html` → **컴파일 시작**.

페이지가 하는 일 (`apps/web-ar/src/tools/compileTarget.ts`):

1. 인쇄 원본을 `sceneLayout.TARGETS` 의 영역대로 자른다 (전체 / 위 / 아래).
2. QR 스티커가 붙을 자리(`ORIGINAL_QR_ZONE`)를 주변 바탕색으로 덮어 특징점 후보에서 뺀다.
3. 각 타깃을 `compileWidth` 폭으로 줄인다.
4. MindAR `Compiler` 로 컴파일한다.
5. `apps/web-ar/public/assets/targets/poster.mind` 와 `poster.json`(메타데이터)로 저장한다.

`TARGETS` 의 순서·개수를 바꾸면 반드시 다시 컴파일한다. 개수가 다르면 AR 시작 때 오류로 알려 준다.

## 결과 (2026-11-18)

| 타깃 | 영역 | 픽셀 |
|---|---|---|
| 0 full | 포스터 전체 | 1011 × 1431 |
| 1 upper | v 0 ~ 0.545 | 1263 × 974 |
| 2 lower | v 0.535 ~ 0.925 | 1263 × 697 |

- 파일 크기 2,069 KB, 컴파일 약 30초 (데스크톱 Chromium).
- 모의 카메라에서 세 타깃 모두 인식됨. 1.15~1.5 m 에서는 full, 0.8 m 에서는 lower 로 잡혔다.

## 해 보지 않은 것

- 특징점 분포를 눈으로 확인하는 시각화. 포스터는 글자·그래프가 고르게 퍼져 있어 모의 시험에서는 문제가 없었지만,
  실물에서 특정 영역이 잘 안 잡히면 그 영역을 별도 타깃으로 더하는 것을 검토한다.
- 실제 인쇄물·실제 폰 카메라 인식. 종이 질감, 조명, 반사, 렌즈 왜곡은 모의 환경에 없다.

## QR 을 타깃으로 쓰지 않는 이유

QR 은 포스터의 아주 작은 부분이라 그것만으로는 포스터 전체의 자세를 안정적으로 알 수 없다.
이 프로젝트는 포스터 그림 자체를 인식하고, QR 은 웹 주소를 여는 데만 쓴다.
