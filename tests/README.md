# 회귀 테스트

Node.js 24 이상에서 프로젝트 폴더를 열고 실행합니다.

```powershell
node tests/run.mjs
```

npm 설치나 빌드는 필요하지 않습니다. 처음 실행할 때 `index.html`의 importmap에 고정된 Three.js와 Cannon-es를 내려받아 `.tmp/qa/`에 저장합니다. 캐시가 있으면 오프라인에서도 실행할 수 있습니다. importmap의 의존성 URL을 바꾸면 해당 캐시를 다시 내려받습니다.

동물, 블록·실행 취소, 입력, 효과음, 먹이 테스트를 각각 독립된 Node 프로세스에서 실행합니다. 하나라도 실패하면 실행 명령은 종료 코드 `1`을 반환합니다. 실제 Three.js 기하와 Cannon-es 물리를 사용하며, DOM·렌더러·오디오 장치는 필요한 부분만 모의 구현합니다.

캐시가 준비된 뒤 특정 테스트만 실행하려면 다음과 같이 입력합니다.

```powershell
node --import ./tests/register.mjs ./tests/input-test.mjs
```

## 실제 브라우저 검증

Playwright와 Chromium이 준비된 환경에서는 다음을 실행합니다. 게임 자체는 Playwright에 의존하지 않습니다.

```powershell
node tests/browser.cjs
```

Playwright 또는 브라우저가 별도 경로에 있다면 환경변수로 지정할 수 있습니다.

```powershell
$env:PLAYWRIGHT_MODULE = 'C:/path/to/node_modules/playwright'
$env:CHROMIUM_EXECUTABLE = 'C:/path/to/chrome.exe'
node tests/browser.cjs
```

임시 로컬 서버와 헤드리스 브라우저를 자동으로 시작·종료합니다. 클릭·되돌리기·폭발·복원·먹이 낙하·동물 동작·길게 누르기·모바일 터치·주사율과 배속을 검사합니다. 스크린샷은 `.tmp/qa/desktop.png`, `.tmp/qa/mobile.png`에 저장됩니다. 실제 CDN 모듈을 사용하며 검증 중에는 분석용 태그 요청만 차단합니다.
