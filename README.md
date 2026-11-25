# OpenCode Orchestrator

TypeScript-харнес для OpenCode V2. Пользователь ведёт задачи из главного чата. Каждую задачу выполняет своя корневая сессия OpenCode в отдельном worktree, а отдельный процесс runtime ведёт маршрут задачи, вопросы человеку в панели TUI и восстановление после сбоев.

Состояние: первая поставка. Задача из свободного текста проходит маршрут `code` → `show` → `deliver` до локального коммита в ветке задачи, человек одобряет дифф в TUI, рестарт runtime и службы OpenCode работу не теряет и не дублирует. Что вошло, что отложено и что проверено на живой службе 2.4.1, записано в [плане первой поставки](docs/first-delivery.md). Прежняя реализация удалена 23 ноября 2026 года; что она успела подтвердить, записано в [протоколе её приёмки](docs/research/acceptance-2026-11-20.md).

## Документы

| Документ | О чём |
| --- | --- |
| [Первая поставка](docs/first-delivery.md) | Решения, границы, факты OpenCode 2.4.1 и шага 0, отличия реализации, случаи и швы тестов |
| [Архитектура](docs/architecture.md) | Целевая система: решения, пакеты, статусы задачи, виды этапа, вопросы, права, восстановление |
| [Маршруты](docs/workflows.md) | Формат `.orchestrator/workflows/*.json` и `.orchestrator/config.json`; что из него знает первая поставка |
| [Внешние источники](docs/mcp-integrations.md) | Что читает исполнитель через MCP и что проверяет сам runtime |
| [Похожие проекты](docs/research/prior-art.md) | Обзор оркестраторов для OpenCode и других агентов, факты об OpenCode V2 |
| [Раннее исследование](docs/research/opencode-v2-research.md) | Исторический документ: первые опыты с API 2.3.2 и прежний план |

## Пакеты

| Каталог | Назначение |
| --- | --- |
| `packages/opencode-orchestrator-runtime/` | Долгоживущий процесс: SQLite, очередь и места, worktree, сессии OpenCode, сверка. Ядро (схема маршрута, функция перехода) в `src/core`, CLI `opencode-orchestrator` (`serve`, `status`) это `bin` пакета |
| `packages/opencode-orchestrator-plugin/` | Плагин OpenCode: `/orchestrate`, агент `orchestrator-worker`, инструмент `stage_report`, панель вопросов в TUI |

## Как запустить

Нужны OpenCode 2.4.x в режиме службы (`opencode serve --service`, его же поднимает Desktop), Node.js 24.11+ и pnpm 11.17.0.

1. Собрать runtime: `pnpm install && pnpm build`.
2. Подключить плагин в глобальном конфиге OpenCode (`~/.config/opencode/opencode.json`), чтобы он загружался и в worktree задач:

   ```json
   { "plugins": ["/путь/к/opencode-orchestrator/packages/opencode-orchestrator-plugin"] }
   ```

3. Положить в проект маршрут `.orchestrator/workflows/default.json` и при необходимости `.orchestrator/config.json` (формат в [маршрутах](docs/workflows.md#что-умеет-первая-поставка)). Проверить, что `git commit` в проекте проходит без участия человека: `serve` проверяет это при старте.
4. Запустить runtime в отдельном терминале: `node packages/opencode-orchestrator-runtime/dist/cli.js serve`. Адрес и пароль службы он берёт из `$XDG_STATE_HOME/opencode/service.json`.
5. В чате OpenCode: `/orchestrate <что сделать>`. Без аргументов команда показывает задачи, `/orchestrate stop <taskID>` останавливает задачу. Вопросы открываются в панели TUI сами; свернуть их можно Escape, вернуть командой «Оркестратор: открытые вопросы» из палитры.

## Разработка

```sh
pnpm install
pnpm check
```

`pnpm check` запускает oxlint и oxfmt, сборку, проверку типов и Vitest. Тесты разбиты на проекты: `core` (функция перехода и загрузчик маршрута), `runtime` (RPC runtime с поддельным OpenCode, настоящими git и SQLite) и `live`. Живой тест идёт против настоящей службы и пропускается без `ORCHESTRATOR_TEST_MODEL=<provider>/<model>`; службу он берёт из `ORCHESTRATOR_OPENCODE_URL` и `ORCHESTRATOR_OPENCODE_PASSWORD` или из `service.json`, и в ней должен быть подключён плагин.
