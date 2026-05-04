# CLAUDE.md — 브릭카츄 (Brickkachu) 3D Nanoblock Game

## 프로젝트 개요

바닐라 JS 기반의 3D 나노블록 게임. 피카츄 에디션.
빌드 도구 없음. importmap으로 CDN 라이브러리 로드.

## 기술 스택

- **Three.js 0.160.0** — 3D 렌더링 (CDN, importmap)
- **Cannon-es 0.20.0** — 물리 엔진 (CDN, importmap)
- **lil-gui** — Three.js addons에 포함된 GUI 라이브러리
- **Web Audio API** — 절차적 효과음 (외부 파일 없음)
- 바닐라 JS ES Modules, CSS
- 서버 불필요 (로컬 파일로 실행 가능)

## 파일 구조

```
index.html          — 메인 HTML, UI 버튼, importmap 정의
style.css           — 전체 스타일
js/
  main.js           — 진입점: Three.js/Cannon 초기화, 애니메이션 루프
  state.js          — 전역 상태 싱글턴 (state, guiParams, objects, materials 등)
  scene.js          — 블록 배치/제거, 폭발, 히스토리(undo/redo), 씬 스냅샷
  entities.js       — 동물 스폰/AI/애니메이션/클릭 액션 (animals 배열)
  food.js           — 먹이 스폰/낙하 물리/고스트 프리뷰
  sound.js          — Web Audio API 절차적 효과음
  camera.js         — 3D 프리뷰 카메라 업데이트, 스냅 방향
  input.js          — 포인터/키보드 입력 처리, 동물 잡기 로직
  ui.js             — 팔레트, 모드 버튼, lil-gui, 스냅 컨트롤
pikachu_reference.png
```

## 핵심 상수 (변경 시 주의)

| 상수 | 위치 | 값 | 의미 |
|------|------|----|------|
| `voxelSize` | state.js:3 | 50 | 블록 한 칸 크기 (단위: Three.js 유닛) |
| `GROUND_BASE_HEIGHT` | entities.js:23 | 80 | 동물이 서 있는 기준 지면 높이 |
| `MAX_ANIMALS` | entities.js:10 | 20 | 최대 동물 수 |
| 중력 | main.js:38 | -1470 | Cannon-es 중력 (y축, 기본 -980의 1.5배) |
| `linearDamping` | entities.js | 0.95 | 동물 물리 감쇠 |

## 전역 상태 (state.js)

모든 모듈이 `state` 객체를 공유한다. 주요 필드:

```js
state.currentMode   // 'add' | 'remove' | 'food'
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

## 먹이 시스템 (food.js)

- 🍎 버튼으로 먹이 설치 모드 진입 (`state.currentMode = 'food'`)
- 클릭한 위치에 사과 모델 스폰 (복셀 기반 기하 도형)
- 동물이 `EAT_RADIUS` (voxelSize × 1.8) 내에 오면 먹음
- HEAVY 동물이 먹이 위 블록 파괴 시 `triggerFoodFall()` 호출 → 낙하 물리
- `FOOD_GRAVITY = -980`

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
- 스냅샷: JSON 문자열 (블록 위치 + 재질 슬롯 + guiParams)
- 최대 50스텝 유지
- 단축키: Ctrl+Z / Ctrl+Y

## UI 모드 버튼

| 버튼 | ID | 기능 |
|------|-----|------|
| ✏️ | btn-add | 블록 추가/제거 토글 |
| 💣 | btn-explode | 전체 블록 물리 폭발 |
| ↻ | btn-restore | 폭발 전 상태 복원 |
| 🐾 | add-dog-btn | 동물 스폰/제거 모드 토글 |
| 🍎 | btn-food | 먹이 설치 모드 |
| 🧹 | btn-clear-all | 동물+먹이 전체 제거 |
| ×1 | btn-game-speed | 배속 토글 (x1→x2→x3→x1) |

## 개발 규칙

- **빌드 없음**: npm run, webpack 등 사용 안 함. 브라우저에서 직접 실행.
- **전역 상태 공유**: 새 기능도 `state.js`의 `state` 객체에 필드 추가.
- **새 모듈 추가 시**: `main.js`에서 import 후 `init()` 또는 `animate()`에 연결.
- **물리 body 제거**: 반드시 `state.world.removeBody(body)` 호출 (메모리 누수 방지).
- **Three.js 객체 제거**: 반드시 `state.scene.remove(mesh)` 후 geometry/material dispose 고려.
- **동물은 `animals` 배열로 관리**: `dogs`는 `animals`의 alias (하위 호환용).
- **한국어로 소통**.
