# YMail — 다중 사용자 버전

Claude가 만든 기존 Ymail 디자인을 최대한 유지하면서 **여러 사용자가 같은 서버에서 계정/메일/채팅을 공유**하도록 바꾼 버전입니다.

## 들어간 기능
- 여러 사용자의 회원가입 / 로그인
- `아이디@ymail.com` 주소
- 사용자 목록
- 사용자 간 실제 메일 전송 (받은편지함/보낸편지함)
- 사용자 간 실제 채팅
- 2.5초마다 채팅 자동 새로고침
- 기존 관리자 패널
- 기존 검색 / Yeol AI / 브라우저 UI 유지
- 비밀번호는 scrypt로 해시하고 로그인은 HttpOnly 서명 쿠키 사용

## Render
Runtime: Node
Build Command: `npm install`
Start Command: `npm start`

환경 변수:
- `MAIL_DOMAIN=ymail.com`
- `ADMIN_USERNAME=yeonwook1013`
- `ADMIN_PASSWORD=관리자 비밀번호`
- 선택: `SESSION_SECRET` (고정된 긴 랜덤 문자열)
- 선택: 검색 기능용 `TAVILY_API_KEY` / `SEARXNG_URL` / `BRAVE_API_KEY`

`.env` 파일은 배포본에 넣지 않았습니다. 비밀번호/키는 Render Environment에만 넣으세요.

## 데이터 저장
계정/메일/채팅은 `data/` 아래 JSON 파일에 서버 측으로 저장합니다. **따라서 같은 서비스에 접속한 사람들은 서로의 계정/메일/채팅을 공유합니다.**

중요: 일반적인 Render 웹서비스의 로컬 디스크는 재배포/인스턴스 교체 때 데이터가 보존된다고 보장할 수 없습니다. 공개 서비스로 오래 운영하려면 이후 PostgreSQL 같은 외부 영속 DB로 교체하는 것을 권장합니다.

## 로컬 실행
`node server.js`
그리고 `http://localhost:3000`
