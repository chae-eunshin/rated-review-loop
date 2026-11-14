<p align="center">
  <img src="./docs/assets/banner.png" alt="rated-review-loop: AI가 코드를 리뷰하고, 사람이 그 리뷰를 평가합니다." width="100%">
</p>

# rated-review-loop

[English](./README.md) | 한국어

AI가 쓴 코드를 매번 리뷰하고, 지적 하나하나를 책임자가 평가하게 하고, 리뷰가 쓸모없어지기 시작하면 알려 주는 도구입니다.

Claude Code나 Codex 같은 코딩 에이전트는 자기가 쓴 코드를 리뷰할 수 있습니다. 하지만 보통 두 가지는 아무도 확인하지 않습니다. 리뷰가 정말 매번 일어나는지, 그리고 그 지적이 읽을 가치가 있는지입니다. `rated-review-loop`는 검사가 통과한 뒤 리뷰를 에이전트가 건너뛸 수 없는 단계로 만들고, 책임자가 각 지적을 어떻게 평가했는지 기록하고, 리뷰 스킬 버전과 리뷰어별로 유용도를 측정합니다. 최근 평가가 기준 아래로 내려가면 PR에 알립니다.

## 왜 필요한가

- **리뷰는 건너뛰어집니다.** "변경 사항을 리뷰해 줘"라고 시킨 에이전트는 가끔만 리뷰합니다. 구현이 끝날 때마다 도는 훅은 매번 리뷰합니다.
- **평가받지 않는 리뷰는 나아질 수 없습니다.** 평가가 없으면 리뷰 지시문을 고치는 일은 짐작에 기댑니다. 스킬 버전별로 평가가 쌓이면 새 스킬과 이전 스킬을 비교할 수 있습니다.
- **유용도는 조용히 떨어집니다.** 모델 업데이트나 스킬 수정 하나로 리뷰가 소음이 될 수 있습니다. 최근 100건의 이동 구간이 이를 일찍 잡아내고, 구간이 다 찬 뒤에만 알리기 때문에 표본이 적어서 생기는 헛경보가 없습니다.

## 동작 방식

```text
begin ──► implement ──► ready ──► [Stop hook] checks ──► review ──► submit ──► owner rates ──► stats
 baseline                          all must pass        session agent        ledger (committed)
                                                        or claude/codex CLI
```

1. **begin**이 범위 안의 파일마다 내용 식별값(git blob id)을 남깁니다. 작업 전부터 있던 수정이 에이전트 몫으로 잡히지 않습니다. 바뀌지 않은 tracked 파일은 읽지 않고, 커밋되지 않은 파일만 로컬에 복사해 둡니다.
2. **ready**로 에이전트가 구현한 파일을 알립니다.
3. 에이전트가 멈추면 **Stop 훅**이 설정한 검사를 실행합니다. 모두 통과할 때만 리뷰를 요청합니다. 같은 세션이 리뷰하거나(`session`), 별도의 `claude`·`codex` CLI 프로세스가 독립적으로 리뷰합니다(`claude-cli`, `codex-cli`).
4. 리뷰 결과는 변경 내용에 맞춰 검증되는 JSON입니다. 모든 지적에는 변경 범위 안의 파일과 줄, 근거, 영향, 최소 수정안이 있어야 합니다.
5. 에이전트는 답변 끝에 평가 질문을 붙입니다. 책임자가 답하면 평가가 **원장(ledger)**에 저장됩니다. 원장은 실행마다 작은 JSON 파일 하나이고, 커밋해서 팀이 함께 씁니다. 리뷰한 소스는 로컬에만 남습니다.
6. **stats**가 스킬 버전과 리뷰어별로 평가를 묶고, 최근 구간을 확인합니다.

## 설치

```sh
pnpm add -D rated-review-loop
```

Node.js 22 이상과 git이 필요합니다. CLI 리뷰어를 쓰려면 `claude`나 `codex` CLI를 설치하고 로그인해 두세요.

이 패키지는 CLI만 제공하고, import해서 쓰는 API는 없습니다. 공개 계약은 명령, 설정 파일, 원장(ledger) 형식입니다.

## 설정

### 1. 훅

```sh
cp node_modules/rated-review-loop/examples/claude-settings.json .claude/settings.json
cp node_modules/rated-review-loop/examples/codex-hooks.json .codex/hooks.json
```

이미 훅이 있다면 기존 파일에 합쳐 주세요. `--client` 인자로 어떤 에이전트가 리뷰하는지 구분하고, 이 값이 모든 평가와 함께 기록됩니다.

### 2. 설정 파일

저장소 루트에 `rated-review-loop.config.json`을 만듭니다. 모든 키는 생략할 수 있습니다.

```json
{
  "skill": "node_modules/rated-review-loop/skills/review-completed-code/SKILL.md",
  "guidelines": ["AGENTS.md", "docs/architecture.md"],
  "checks": ["pnpm typecheck", "pnpm lint"],
  "include": ["src/**/*.{ts,tsx}", "scripts/**/*.{js,mjs,ts}"],
  "reviewer": { "mode": "session" },
  "language": "en",
  "stats": { "groupBy": ["skill", "reviewer"], "window": 100, "threshold": 0.8 }
}
```

### 3. 로컬 상태 제외

```gitignore
.rated-review-loop/local/
```

`.rated-review-loop/ledger/`는 커밋하세요. 지적 제목, 근거 규칙, 평가만 담기고 소스 코드는 들어가지 않습니다. 끝난 지 14일이 지난 로컬 실행 기록은 다음 `begin` 때 지워지고, `prune`으로 직접 지울 수도 있습니다.

### 4. PR에서 리뷰 건강도 확인

```sh
cp node_modules/rated-review-loop/examples/review-health.yml .github/workflows/review-health.yml
```

이 워크플로는 어떤 그룹이 기준 이하일 때만 댓글을 달고, 댓글 하나를 계속 갱신하며, 회복되면 지웁니다. 커밋된 원장만 읽기 때문에 모델 접근이나 API 키가 필요 없습니다.

## 리뷰어

| 모드 | 리뷰하는 쪽 | 기록되는 모델 |
| --- | --- | --- |
| `session` | 코드를 쓴 에이전트가 같은 세션에서 | 세션 대화 기록에서 읽음 |
| `claude-cli` | 읽기 전용 도구와 JSON 스키마를 건 `claude -p` | Claude Code가 알려 준 값 |
| `codex-cli` | 출력 스키마를 건 `codex exec --sandbox read-only` | Codex 세션 기록에서 읽음 |

모든 모드가 같은 형식의 결과를 내기 때문에 평가와 통계는 리뷰어와 상관없이 동작합니다. CLI 리뷰어는 설치된 CLI의 로그인을 그대로 쓰며, 이 도구는 API 키를 저장하지 않습니다.

## 지적 평가하기

| 평가 | 뜻 |
| --- | --- |
| `useful` | 타당하고 반영할 가치가 있음 |
| `out-of-scope` | 타당하지만 이번 변경의 범위 밖 |
| `unsupported` | 취향이거나 근거가 약함 |
| `incorrect` | 사실과 다름 |
| `deferred` | 아직 판단 보류, 판정으로 세지 않음 |

평가는 나중에 바꿀 수 있습니다. 이력은 남고, 통계는 마지막 평가를 씁니다.

## 통계와 경고

```sh
npx rated-review-loop stats --format text
```

```text
skill 306f61d5d9f6 · reviewer claude: 41 runs, 63 findings, 4 unrated — useful 86% over the last 100
skill 9b1e04c2aa10 · reviewer codex: 12 runs, 18 findings, 2 unrated — useful 81% over 16/100 (not enough ratings to alert)
```

- **스킬 버전**은 스킬 파일 내용만의 해시입니다. 이 도구를 업데이트해도 통계가 초기화되지 않고, 스킬을 이전 내용으로 되돌리면 그 버전의 기록에 이어서 쌓입니다.
- **구간**: 그룹별로 가장 최근의 판정 `window`건입니다. 구간이 다 찼고 유용도가 `threshold` 이하일 때만 경고합니다.
- **묶음**: 기본값은 `["skill", "reviewer"]`입니다. 팀의 평가가 모델별로 구간을 채울 만큼 쌓인다면 `"model"`을 추가해 모델 버전까지 나눌 수 있습니다.

## 설정 레퍼런스

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `skill` | 내장 스킬 | 리뷰 지시문, 이 파일의 해시가 스킬 버전 |
| `guidelines` | `[]` | 리뷰어가 비교할 프로젝트 문서 |
| `checks` | `[]` | 리뷰 전에 모두 통과해야 하는 셸 명령 |
| `checkTimeoutMs` | `120000` | 검사 하나의 제한 시간 |
| `include` / `exclude` | 모든 파일 / 의존성·빌드·잠금 파일 | 리뷰 대상 파일 glob, 바이너리와 2MB 넘는 파일은 건너뜀 |
| `reviewer.mode` | `session` | `session`, `claude-cli`, `codex-cli` |
| `reviewer.model` | 각 CLI 기본값 | CLI 리뷰어가 쓸 모델 |
| `language` | `en` | 지적을 쓸 언어 |
| `stats.groupBy` | `["skill", "reviewer"]` | `skill`, `reviewer`, `model` 중 조합 |
| `stats.window` | `100` | 이동 구간 크기 |
| `stats.threshold` | `0.8` | 이 유용도 이하면 경고 |
| `ledgerDir` / `localDir` | `.rated-review-loop/ledger` / `.rated-review-loop/local` | 커밋되는 저장소와 로컬 저장소 |

## CLI 레퍼런스

```text
rated-review-loop hook --client <claude|codex>          Handle a SessionStart/Stop hook event from stdin
rated-review-loop begin <session-key> <task>            Record the baseline before implementing
rated-review-loop ready <session-key> <file...>         Mark the files you implemented as ready for checks
rated-review-loop packet <run-id>                       Print the change under review
rated-review-loop submit <run-id> <report.json>         Record a review report written by the session agent
rated-review-loop review <run-id>                       Have the configured CLI reviewer review and record the run
rated-review-loop rate <run-id> <F#> <label> [note]     Record the owner's rating of a finding
rated-review-loop status <session-key>                  Show the run bound to a session
rated-review-loop cancel <session-key>                  Cancel the run bound to a session
rated-review-loop stats [--format json|text|markdown]   Usefulness per skill version and reviewer
rated-review-loop prune [--days <n>]                    Delete local runs finished more than n days ago (default 14)
```

## 한계

- 이 도구는 지적이 유용했는지를 재지, 리뷰가 무엇을 놓쳤는지는 재지 않습니다. 지적이 없는 실행이 코드가 맞다는 증거는 아닙니다.
- 평가의 질은 책임자의 답에 달려 있습니다. 모호한 답은 미평가로 두세요.
- 포크에서 온 PR은 읽기 전용 토큰을 받기 때문에 건강도 댓글을 달 수 없습니다.

## 기여하기

PR을 올리기 전에 `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check:readme-sync`를 실행해 주세요. `README.md`와 `README-ko_kr.md`는 함께 맞춰 주세요. CI가 두 파일의 제목 구조와 코드 블록을 비교하고, 한쪽만 바꾼 PR은 설명에 `README one-sided: <사유>` 줄이 있어야 통과합니다.

## 라이선스

MIT
