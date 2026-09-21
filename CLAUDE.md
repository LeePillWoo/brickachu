# CLAUDE.md — 브릭카츄 (Brickkachu) 3D Nanoblock Game

## 프로젝트 개요

바닐라 JS 기반의 3D 나노블록 게임. 피카츄 에디션.
빌드 도구 없음. importmap으로 CDN 라이브러리 로드.
눈을 붙이면 만든 블록이 형태별 능력을 가진 친구로 살아나고, 간식 하나를 골라 동물과 블록 친구를 일시적으로 변신시킬 수 있음.

## 기술 스택

- **Three.js 0.160.0** — 3D 렌더링 (CDN, importmap)
- **Cannon-es 0.20.0** — 물리 엔진 (CDN, importmap)
- **lil-gui** — Three.js addons에 포함된 GUI 라이브러리
- **Web Audio API** — 절차적 효과음 (외부 파일 없음)
- 바닐라 JS ES Modules, CSS
- 정적 HTTP 서버로 실행 (`node serve.mjs`). 파일 직접 열기는 ES 모듈 보안 제한으로 실패할 수 있음.

## 파일 구조

```
index.html          — 메인 HTML, UI 버튼, importmap 정의
style.css           — 전체 스타일
js/
  main.js           — 진입점: Three.js/Cannon 초기화, 애니메이션 루프
  state.js          — 전역 상태 싱글턴 (state, guiParams, objects, materials 등)
  scene.js          — 블록 배치/제거, 폭발, 히스토리(undo/redo), 씬 스냅샷
  entities.js       — 동물 스폰/AI/애니메이션/클릭 액션 (animals 배열)
  living.js         — 연결된 블록 수집, 형태별 능력, 눈 부착, 블록 친구 스냅샷 복원
  magic.js          — 간식 재료/레시피, 변신 적용·만료, 무지개 흔적/자원 정리
  train.js          — 기차 배치, 일반 동물 순차 합류, 밧줄/운행/경로/연기와 자원 정리
  food.js           — 간식 스폰/낙하 물리/고스트 프리뷰
  sound.js          — Web Audio API 절차적 효과음
  camera.js         — 3D 프리뷰 카메라 업데이트, 스냅 방향
  input.js          — 포인터/키보드 입력 처리, 동물 잡기 로직
  ui.js             — 팔레트, 모드 버튼, lil-gui, 스냅 컨트롤
  toy-ui.js         — 눈/간식 툴바 상태, 간식 순환, 놀이 알림
serve.mjs           — 로컬 정적 HTTP 서버
tests/
  run.mjs           — Node 회귀 테스트 실행 및 고정 CDN 의존성 캐시 준비
  register.mjs      — Node에서 브라우저 importmap 의존성을 로컬 캐시로 연결
  *-test.mjs        — 동물/씬/입력/효과음/먹이/블록 친구/변신 단위 회귀
  browser.cjs       — 기존 게임의 실제 데스크톱/모바일 브라우저 검증
  toys-browser.cjs  — 눈 붙이기/간식 툴바 순환/모바일 조작의 실제 브라우저 검증
  train-browser.cjs — 기차 배치/합류/경로 드래그/취소/정리와 모바일 툴바 검증
pikachu_reference.png
```

## 핵심 상수 (변경 시 주의)

| 상수 | 위치 | 값 | 의미 |
|------|------|----|------|
| `voxelSize` | state.js:3 | 50 | 블록 한 칸 크기 (단위: Three.js 유닛) |
| `GROUND_BASE_HEIGHT` | entities.js | 0 | 물리 바닥과 동일한 기준 지면 높이 |
| `MAX_ANIMALS` | entities.js:10 | 20 | 최대 동물 수 |
| `MAX_LIVING_BLOCKS` | living.js | 96 | 블록 친구 한 마리를 구성하는 최대 블록 수 |
| `MAX_LIVING_SPAN` | living.js | voxelSize × 12 | 블록 친구의 가로·세로·높이 최대 범위 |
| `EFFECT_DURATION` | magic.js | 20 | 변신 지속 시간 (배속이 적용된 게임 초) |
| 중력 | main.js:38 | -1470 | Cannon-es 중력 (y축, 기본 -980의 1.5배) |
| `linearDamping` | entities.js | 0.95 | 동물 물리 감쇠 |

## 전역 상태 (state.js)

모든 모듈이 `state` 객체를 공유한다. 주요 필드:

```js
state.currentMode   // 'add' | 'remove' | 'food' | 'eyes' | 'train'
state.train         // null 또는 { mesh, position, followers, route, routeIndex, drawing, pathVisual, ropeGroup, ropes, ... }
state.snackIngredients // UI에서는 [] 또는 balloon/jelly/rainbow 중 한 종류
state.onToyNotice   // toy-ui.js가 등록하는 클릭을 막지 않는 알림 함수
state.gameSpeed     // 1 | 2 | 3 (배속)
state.world         // CANNON.World 인스턴스
state.scene         // THREE.Scene
state.camera        // THREE.PerspectiveCamera
state.animalMode    // 'spawn' | 'remove'
state.screenShakeTimer / screenShakeIntensity  // HEAVY 동물 클릭 시 흔들림
```

## 동물 시스템 (entities.js)

### 동물 그룹

```js
GROUP_ANIMALS = {
  quad:      ['dog','cat','sheep','pig','bulbasaur','squirtle','charmander'],
  hop:       ['rabbit','pikachu','eevee','grasshopper','frog'],
  sneak:     ['snake','turtle','snail','lizard'],
  heavy:     ['snorlax','elephant','slowpoke','wobbuffet'],
  waddle:    ['penguin','psyduck','togepi','clefairy','jigglypuff','meowth'],
  special:   ['porygon','ditto','diglett','gengar'],
  carnivore: ['lion','crocodile','bear'],
}
```

### 동물 상태 머신
`falling → idle ↔ walking`

### 클릭 액션
`spin | scale | jump | squash | pulse`
HEAVY 동물 클릭 시 화면 흔들림 + 블록 파괴 (`explodeBlockHeavy`)

### 동물 추가 시 필요한 작업
1. `GROUP_ANIMALS.all`에 타입 이름 추가
2. 해당 그룹(quad/hop 등)에 추가
3. `_buildAnimalMesh()` 내 switch에 케이스 추가
4. `_getAnimGroup()` 내 분기 확인

## 살아나는 블록 친구 (living.js)

- 툴바의 👀를 누를 때마다 즉시 `eyes` 모드 활성화. 다시 눌러도 모드를 해제하지 않음. 클릭한 블록과 면으로 연결된 덩어리가 한 친구가 됨.
- `collectConnectedBlocks(seed)`는 6방향으로 연결된 블록을 수집. `awakenBlocks(seed, normal)`은 크기/수량 제한을 검사하고 눈을 붙인 뒤 `{ ok, animal, reason }` 반환.
- 친구가 될 블록은 사용자가 ✏️ 블록 편집 도구로 직접 만듦.
- 만들어진 친구는 `registerCustomAnimal()`로 기존 `animals` 배열에 등록되어 이동, 클릭 액션, 길게 잡기, 먹이 섭취, 제거 흐름을 공유. `livingId`/`livingDescriptor`로 일반 동물과 구분.
- 생성된 친구를 눈 모드에서 다시 누르면 클릭 액션과 능력 설명 표시. 간식 모드의 클릭은 즉시 먹이기.
- `classifyLivingShape(size, blockCount)`는 아래 순서로 형태를 판정. `span = max(size.x, size.z)`.

| 조건 | 그룹 | 능력 |
| --- | --- | --- |
| 높이 ≥ span × 1.5 | HOP | 폴짝 점프 |
| 높이 ≤ span × 0.5 | SNEAK | 낮은 틈 이동·벽타기·대시 |
| 위 조건 이외에서 12블록 이상 또는 높이 3칸 이상 | HEAVY | 블록 파괴·발구르기 |
| 나머지 | WADDLE | 뒤뚱 이동·회전 댄스 |

생성 시 원본 블록을 물리 월드/씬/프리뷰에서 분리하고, 친구는 독립된 geometry/material을 소유함. 원본 형태·재질·눈 위치를 담은 descriptor를 `scene.js` 히스토리에 저장하여 Undo로 원래 블록, Redo로 같은 형태의 친구를 복원함. 기존 친구의 이동이나 일시적 변신은 descriptor를 변경하지 않음.

## 먹이와 변신 간식 (food.js, magic.js)

- 툴바의 `btn-food`를 누를 때마다 🍎 일반 사과 → 🎈 풍선 → 🍮 푸딩 → 🌈 무지개 → 🍎 일반 사과 순서로 순환하고 `food` 모드를 활성화함. 각 단계에서 한 종류의 간식을 사용함.
- 다른 도구로 전환해도 간식 순서는 유지됨. 간식 버튼을 다시 누르면 저장된 순서의 다음 간식으로 넘어가며, 기존 간식을 그대로 다시 활성화하는 동작이 아님.
- 일반 사과 단계에서는 `state.snackIngredients = []`, 나머지 단계에서는 해당 재료 ID 하나가 담긴 배열을 사용함.
- 동물이나 블록 친구 클릭은 `applySnack(animal, state.snackIngredients)`로 바로 먹이기. 바닥/블록 윗면 클릭은 `spawnFood(worldPosition, ingredients)`로 간식 배치.
- 배치한 간식은 생성 시 재료를 보관하므로 이후 UI 선택이 바뀌어도 해당 간식은 유지됨.
- `balloon`이 포함된 변신 중에는 바닥/블록 위 먹이 탐색·추적·자동 섭취를 중지함. 클릭으로 직접 먹이기는 허용하며 일반 사과나 다른 간식으로 풍선이 해제되면 기존 먹이 AI를 재개함.
- 동물이 `EAT_RADIUS` (voxelSize × 1.8) 내에 오면 먹음
- HEAVY 동물이 먹이 위 블록 파괴 시 `triggerFoodFall()` 호출 → 낙하 물리
- `FOOD_GRAVITY = -980`

`magic.js`의 `SNACK_INGREDIENTS`는 `{ id, icon, label, color, description }` 메타데이터 배열. `describeRecipe(ids)`는 레시피 이름 **문자열**을 반환. 내부 호환성을 위해 `normalizeIngredients(ids)`와 변신·먹이 API는 중복/알 수 없는 ID를 제거한 최대 두 재료 조합도 계속 처리하지만, 공개 UI는 한 종류만 선택하도록 제한함.

| 재료 ID | 이름 | 효과 |
| --- | --- | --- |
| balloon | 🎈 풍선 | 기본 수평 속도의 40% 이하로 천천히 떠다니기 |
| jelly | 🍮 푸딩 | 말랑한 모양과 바닥/벽 튕기기 |
| rainbow | 🌈 무지개 | 일시적인 무지개 발자국 |

푸딩은 🍮 아이콘과 푸딩 모양의 3D 먹이를 사용하며, 기존 호환성을 위해 내부 재료 ID는 `jelly`를 유지함. 말랑해지고 바닥·벽에서 튕기는 효과도 그대로 유지함.

`updateMagicEffects(animals, dt)`가 배속이 적용된 게임 시간 20초를 세고 만료 시 복원. 간식 버튼을 일반 사과(`[]`) 단계로 순환시킨 뒤 먹이면 기존 변신을 즉시 해제함. 다른 간식을 먹으면 이전 변신을 정리하고 새 간식의 효과를 적용함. `clearMagicEffect(animal)`은 복사 재질·장식·충돌 리스너·무지개 흔적을 정리하므로 친구 제거 시에도 호출해야 함.

풍선은 원본 `animal.speed`를 변경하지 않고 AI 이후에 수평 속도를 제한하며 가감속을 부드럽게 처리함. `toy-ui.js`가 현재 간식에 맞춰 오른쪽 `btn-food`의 아이콘·툴팁·접근성 이름을 동기화하고, 다른 모드에서도 현재 아이콘을 유지함.

## 동물 기차 (train.js)

- 🚂(`btn-train`)는 매번 `train` 모드를 활성화하며 다시 눌러도 유지함. 빈 바닥 클릭은 `spawnTrain(position)`으로 한 대만 배치/재배치.
- `state.train.position`은 바닥 기준 위치. `followers`에는 가까운 일반 동물부터 순차 등록하고 `animal.trainRide`로 참여 상태를 표시함. `livingId`가 있는 블록 친구는 가장 가까이 있어도 합류 대상에서 제외함.
- `balloon`이 포함된 변신 중인 동물은 합류 대상에서 제외함. 참여 중 풍선을 먹으면 `applySnack()`이 즉시 `detachTrainFollower()`를 호출하여 대열과 밧줄을 갱신함. 해제 후에는 기존 합류 대기 시간과 거리 조건을 다시 적용함.
- 기관차 → 첫 동물 → 다음 동물 사이에 밧줄을 표시하며 이동/대열 변경에 맞춰 연결 위치를 갱신함. 동물 이탈·기차 재배치·삭제 시 밧줄 참조와 소유 자원도 정리함.
- `ropeGroup`은 씬 직속 그룹. `ropes`의 각 항목은 `{ from, to, mesh, start, end, segments }`이며 `start`/`end`는 월드 좌표. 대기 중인 동물을 포함해 참여 동물당 한 연결을 표시하고, 공유 geometry/material은 기차가 소유하여 정리 시 각각 한 번 해제함.
- 고정 스텝에서 `updateMagicEffects()` 직후 `syncTrainRopes()`를 호출하여 동물의 최종 방향·크기와 간식 변신 보정까지 밧줄 끝 위치에 반영함.
- 이동 중 칙칙폭폭 효과음을 반복하고 간헐적으로 핑핑 소리와 연기를 냄. 멈추거나 경로를 그리는 동안에는 운행 효과를 멈추며, Web Audio API로 소리를 생성함.
- 기차놀이 중에는 육식/초식의 포식·도주·회피 행동보다 대열을 우선함. `state.train`이 있는 동안에는 합류 전 동물도 포식자 회피를 하지 않음. 기차가 제거되면 참여 상태를 해제하고 기존 동물 AI로 돌아감.
- 기차를 실제 포인터로 누른 뒤 끌면 `beginTrainRoute()` → `appendTrainRoutePoint(position)` → `finishTrainRoute()` 흐름으로 길을 그림. 그리는 동안 기차는 멈추고 OrbitControls를 잠금.
- 경로 입력은 블록 벽을 가로질러 허용하며 그리기만으로는 블록을 제거하지 않음. 실제 운행 구간에서 기관차/대열의 크기와 겹치는 블록을 `explodeBlockHeavy()`로 파괴하고, 승객의 이동 구간도 정리하여 뒤에 새로 놓인 블록을 통과함. 기차는 빈 바닥에 배치하며 보드 경계는 유지함.
- ESC, 두 번째 손가락, 모드 전환은 `cancelTrainRoute()`로 그리기를 취소하고 카메라 입력을 복구. `pathVisual`은 그리기 후 잠시 표시한 뒤 페이드하여 정리함.
- `updateTrain(dt)`에는 배속을 적용한 고정 시뮬레이션 시간을 전달. 🧹 개별 삭제/길게 눌러 전체 삭제, 폭탄은 `clearTrain()`으로 기차 메시·경로 표시·친구의 참여 참조를 정리함. 기차는 편집 히스토리 복원 대상이 아님.

## 폭탄과 복원 (scene.js, entities.js)

- `explodeBricks()`는 일반 블록뿐 아니라 `animals`의 블록 친구와 일반 동물도 함께 처리함. 블록 없이 동물만 있는 장면에서도 폭발 가능.
- `detachAnimalsForExplosion()`은 블록 친구의 현재 월드 변환을 사용해 각 블록을 폭발 조각으로 옮김. 생성 당시 descriptor의 위치로 되돌린 뒤 폭발시키지 않음.
- 일반 동물도 물리 폭발 대상으로 옮겨지며, 기존 AI 배열·잡기 참조·변신 효과는 정리됨. 폭발 조각과 동물 메시의 geometry/material은 폭발 수명이 끝나거나 복원할 때 정리함.
- 먹이는 기존 동작대로 유지하고, 받침이 없어진 먹이에 낙하 처리를 적용함.
- ↻ 복원과 편집 히스토리의 복원 대상은 일반 블록 및 블록 친구 descriptor. 일반 동물은 복원하지 않으므로 🐾로 다시 소환해야 함. 블록 친구의 이동·일시적 변신은 편집 스냅샷에 기록하지 않음.

## 효과음 (sound.js)

외부 파일 없이 Web Audio API로 절차적 생성.
모바일 오디오 언락: 최초 터치 시 무음 버퍼 재생 → iOS Safari 지원.

```js
playSound('block-place')
playSound('block-remove')
playSound('animal-spawn')
playSound('animal-remove')
playSound('animal-eat')
playSound('explode')
// ... 기타
```

## 물리 설정 (main.js)

```js
// ContactMaterial
ground ↔ animal : friction 0.4, restitution 0.1
animal ↔ animal : friction 0.3, restitution 0.2

// 동물 Body
fixedRotation: true
linearDamping: 0.95
allowSleep: false (World 옵션)
```

## 렌더링 파이프라인

```
THREE.WebGLRenderer
  → EffectComposer
      → RenderPass
      → SAOPass (Ambient Occlusion)
      → OutputPass
```

프리뷰 패널은 별도 `previewRenderer` + `previewScene` + `OrthographicCamera` 사용.
프리뷰 씬은 조명 없음 → MeshBasicMaterial로 원색 표현.

## 카메라 조작

| 동작 | 입력 |
|------|------|
| 오빗 | 우클릭 드래그 / Alt + 좌클릭 드래그 |
| 이동 | WASD (수평), Q/E (상하) |
| 줌 | 마우스 휠 / 중간 버튼 |
| 포커스 | F 키 |
| 취소 | ESC |

## 히스토리 (Undo/Redo)

- `scene.js`: `pushHistory()`, `undo()`, `redo()`
- 스냅샷: JSON 문자열 (블록 위치 + 재질 슬롯 + 모든 팔레트 재질 + guiParams + 블록 친구 descriptor)
- `snapshotLivingAnimals()` / `reconcileLivingAnimals()`로 블록 친구 생성·제거를 복원. 일반 동물과 기존 친구의 이동/변신은 편집 기록으로 되돌리지 않음.
- 최대 50스텝 유지
- 단축키: Ctrl+Z / Ctrl+Y 또는 Ctrl+Shift+Z (macOS는 Command)

## UI 모드 버튼

| 버튼 | ID | 기능 |
|------|-----|------|
| ✏️ | btn-add | 블록 편집 복귀 또는 추가/제거 토글 |
| 💣 | btn-explode | 블록·블록 친구·일반 동물 물리 폭발 |
| ↻ | btn-restore | 카운트다운 취소 또는 블록·블록 친구 복원 |
| 🐾 | add-dog-btn | 동물 스폰, 길게 누르면 그룹 선택 |
| 👀 | btn-eyes | 매번 눈 붙이기 모드 활성화, 재클릭 시 유지 |
| 🍎/🎈/🍮/🌈 | btn-food | 매번 다음 간식으로 순환하고 먹이기/배치 모드 활성화 |
| 🚂 | btn-train | 기차 배치/재배치 모드, 기차 드래그로 경로 그리기 |
| 🧹 | btn-clear-all | 친구/먹이/기차 개별 제거 모드, 2초 누름은 전체 제거 |
| ×1 | btn-game-speed | 배속 토글 (x1→x2→x3→x1) |

눈 붙이기/간식/기차/블록 편집/개별 제거 모드는 상호 배타적. 모드 변경 시 `onPointerCancel()`로 진행 중인 입력을 취소하고 툴바의 활성 상태를 동기화함. 놀이 조작은 데스크톱·모바일 모두 툴바에서 바로 수행하며, 블록 편집 복귀는 ✏️를 사용함. 네이티브 버튼의 키보드 활성화도 클릭·터치와 같은 모드 및 간식 순환 동작을 수행해야 함.

## 회귀 검증

Node.js 24 이상에서 `node tests/run.mjs` 실행. 개별 검증과 CDN 캐시는 `tests/README.md` 참고.

Playwright와 Chromium이 준비되어 있으면 `node tests/browser.cjs`로 기존 게임, `node tests/toys-browser.cjs`로 눈/간식 놀이, `node tests/train-browser.cjs`로 기차의 데스크톱/모바일 상호작용을 검증. 별도 설치 경로는 `PLAYWRIGHT_MODULE`, `CHROMIUM_EXECUTABLE` 환경변수로 지정. 테스트용 서버/브라우저는 각 명령이 자동 시작·종료하며 임시 결과는 `.tmp/qa/`에 저장.

## 개발 규칙

- **빌드 없음**: npm run, webpack 등 사용 안 함. `node serve.mjs`로 로컬 서버를 띄워 브라우저에서 실행.
- **전역 상태 공유**: 새 기능도 `state.js`의 `state` 객체에 필드 추가.
- **새 모듈 추가 시**: `main.js`에서 import 후 `init()` 또는 `animate()`에 연결.
- **물리 body 제거**: 반드시 `state.world.removeBody(body)` 호출 (메모리 누수 방지).
- **Three.js 객체 제거**: 반드시 `state.scene.remove(mesh)` 후 geometry/material dispose 고려.
- **동물은 `animals` 배열로 관리**: `dogs`는 `animals`의 alias (하위 호환용).
- **한국어로 소통**.
