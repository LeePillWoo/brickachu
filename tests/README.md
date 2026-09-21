# 회귀 테스트

Node.js 24 이상에서 프로젝트 폴더를 열고 실행합니다.

```powershell
node tests/run.mjs
```

npm 설치나 빌드는 필요하지 않습니다. 처음 실행할 때 `index.html`의 importmap에 고정된 Three.js와 Cannon-es를 내려받아 `.tmp/qa/`에 저장합니다. 캐시가 있으면 오프라인에서도 실행할 수 있습니다. importmap의 의존성 URL을 바꾸면 해당 캐시를 다시 내려받습니다.

동물, 블록·실행 취소, 입력, 효과음, 먹이, 살아난 블록 친구, 변신 간식 테스트를 각각 독립된 Node 프로세스에서 실행합니다. 하나라도 실패하면 실행 명령은 종료 코드 `1`을 반환합니다. 실제 Three.js 기하와 Cannon-es 물리를 사용하며, DOM·렌더러·오디오 장치는 필요한 부분만 모의 구현합니다.

`living-test.mjs`는 연결된 블록 수집·형태별 능력·눈 부착·실행 취소/다시 실행·자원 정리를, `magic-test.mjs`는 변신 효과·게임 시간에 따른 만료·일반 사과 복원·자원 정리를 검증합니다. `input-test.mjs`에는 눈 붙이기와 직접 먹이기, 간식 배치 입력도 포함됩니다. 공개 UI는 간식을 한 종류씩 선택하며, 내부 API의 기존 두 재료 조합 호환성은 별도로 검증합니다.

폭탄 회귀에서는 일반 블록·블록 친구·일반 동물이 모두 폭발 대상으로 옮겨지는지, 블록 친구가 현재 위치에서 흩어지는지, 먹이는 기존 낙하 동작을 유지하는지 확인합니다. 복원 대상은 블록과 블록 친구이며, 일반 동물은 다시 소환해야 합니다.

캐시가 준비된 뒤 특정 테스트만 실행하려면 다음과 같이 입력합니다.

```powershell
node --import ./tests/register.mjs ./tests/input-test.mjs
```

## 실제 브라우저 검증

Playwright와 Chromium이 준비된 환경에서는 다음을 실행합니다. 게임 자체는 Playwright에 의존하지 않습니다.

```powershell
node tests/browser.cjs
node tests/toys-browser.cjs
```

모바일 화면과 터치 선택만 빠르게 확인하려면 `node tests/toys-browser.cjs --mobile-only`를 실행합니다.

Playwright 또는 브라우저가 별도 경로에 있다면 환경변수로 지정할 수 있습니다.

```powershell
$env:PLAYWRIGHT_MODULE = 'C:/path/to/node_modules/playwright'
$env:CHROMIUM_EXECUTABLE = 'C:/path/to/chrome.exe'
node tests/browser.cjs
node tests/toys-browser.cjs
```

임시 로컬 서버와 헤드리스 브라우저를 자동으로 시작·종료합니다. 클릭·되돌리기·폭발·복원·먹이 낙하·동물 동작·길게 누르기·모바일 터치·주사율과 배속을 검사합니다. 스크린샷은 `.tmp/qa/desktop.png`, `.tmp/qa/mobile.png`에 저장됩니다. 실제 CDN 모듈을 사용하며 검증 중에는 분석용 태그 요청만 차단합니다.

`toys-browser.cjs`는 새 놀이 카드를 통한 진입, 예제 블록 만들기, 눈 붙이기와 실행 취소/다시 실행, 간식 단일 선택, 직접 먹이기, 일반 사과 복원, 변신 만료와 무지개 흔적 정리를 검사합니다. 간식 선택은 다른 간식 클릭 시 교체되고, 같은 간식 재클릭 시 유지되며, **🍎 원래대로**로만 일반 사과 선택으로 바뀌어야 합니다.

모바일 검증은 여러 화면 크기에서 작은 놀이 버튼, 눈 붙이기·먹이기, 패널 닫기·다시 열기를 확인합니다. 간식 패널이 화면 중앙을 가리거나 화면 밖으로 넘치지 않아야 하며, **×**로 닫으면 블록 편집으로 돌아가야 합니다.

선택한 간식에 맞게 오른쪽 도구 막대 아이콘이 바뀌고, 다른 모드에서도 그 아이콘이 유지되는지 확인합니다. 풍선 변신 중 실제 수평 속도는 평소 속도의 40%를 넘지 않아야 합니다.

새 놀이 스크린샷은 `.tmp/qa/living-desktop.png`, `.tmp/qa/snacks-desktop.png`, `.tmp/qa/toys-mobile.png`에 저장됩니다. 실패 시에는 `.tmp/qa/toys-failure.png`도 저장합니다. 각 브라우저 검증 명령 역시 실패하면 종료 코드 `1`을 반환합니다.
