# AGENTS.md — руководство для AI-агентов

Не используй суб-агентов. 
Если надо исследовать health-check-dashboard-front - то на локально уже развёрнута библиотека, используй поиск по ней.

Кратко: как устроен проект, как собирать/проверять, что можно менять безопасно,
а что требует реального пульта. Подробности — в `docs/` (см. карту ниже).

## 1. Что это

Electron-приложение для мониторинга и управления роутингом консолей
**Allen & Heath SQ** (SQ-5/6/7) по сети. Renderer — чистый TypeScript **без
фреймворков**. Сеть трогает только main-процесс.

## 2. Команды

| Команда | Что делает |
|---|---|
| `npm install` | Установка зависимостей |
| `npm run build` | Production-сборка webpack (main + preload + renderer) |
| `npm run build:dev` | Dev-сборка |
| `npm run watch` | webpack в режиме watch (dev) |
| `npm run typecheck` | `tsc --noEmit` — **единственная** проверка типов |
| `npm test` | Юнит-тесты чистых декодеров (`node --test` + `tsx`, без пульта) |
| `npm start` | `build` + `electron .` |
| `npm run dev` | `build:dev` + `electron . --enable-logging` |
| `npm run pack` / `dist` | Сборка в `release/` (без установщика / с установщиками) |

**Автотесты есть, но покрывают только чистые декодеры.** `npm test` запускает
`node:test` через `tsx` и не требует ни пульта, ни Electron; тесты лежат в
папках `__tests__` рядом с модулями как `*.test.ts`
(`src/main/__tests__/`, `src/main/transport/__tests__/`,
`src/renderer/tabs/monitor/__tests__/`). `ts-loader` работает в
`transpileOnly: true`, поэтому ошибки типов **не** ловятся сборкой — после правок
всегда запускай `npm run typecheck`, `npm test` **и** `npm run build`.

Проверка без реального пульта: `typecheck` + `test` + `build` + **демо-режим**
(полная симуляция SQ-5, `src/main/demo-meters.ts`).

## 3. Архитектура (кратко)

- **main** (`src/main/`) — единственный владелец сети: TCP к пульту, UDP-метры,
  модели роутинга/состояния, IPC. Наружу отдаёт данные через `sq:*`-каналы.
- **preload** (`src/main/preload.ts`) — мост `window.sq` через `contextBridge`.
  Renderer не имеет Node (`nodeIntegration: false`, `contextIsolation: true`).
- **renderer** (`src/renderer/`) — UI; обращается только к `window.sq`.

Поток данных: `TCP → Framer → Connection (EventEmitter) → SQController.wireEvents
→ RoutingModel/MixerState → троттлинг 120 мс → IPC "sq:routing" → UI`.
Метры идут отдельно через `sq:meters` и коалесцируются в `requestAnimationFrame`.

Карта документации:

| Документ | О чём |
|---|---|
| `docs/ARCHITECTURE.md` | Общая архитектура, IPC-мост, хранение, демо, сцены, стили |
| `docs/CONNECT-SCREEN.md` | Экран подключения, рукопожатие, ошибки, ограничения |
| `docs/ROUTING-TAB.md` | Вкладка «Роутинг» |
| `docs/MONITOR-TAB.md` | Вкладка «Монитор» |
| `docs/LOG-TAB.md` | Вкладка «Журнал» |
| `docs/SQ-PROTOCOL.md` | Бинарный протокол SQ (кадры, регистры, метры) |
| `docs/BACKLOG-NO-CONSOLE.md` | Бэклог правок без проверки на пульте |
| `README.md` / `CHANGELOG.md` | Обзор и история изменений |

## 4. Правила сборки HTML

`dist/renderer/index.html` генерируется плагином
`webpack/html-from-tabs-plugin.js` из `index.template.html` и HTML-фрагментов
вкладок по плейсхолдерам `<!-- @tab:NAME -->`. **Свой `view.html` держи рядом со
своим `index.ts`.** Неразрешённый плейсхолдер валит сборку. Новые фрагменты
регистрируются в `webpack.config.js` (секция `HtmlFromTabsPlugin.fragments`).

## 5. Конвенции кода

- **Без фреймворков.** Никаких React/Vue и лишних зависимостей.
- **DOM-ссылки — через `elementRefs`.** При добавлении элемента в разметку
  дополни **три** места: `ElementRefs` (`src/renderer/core/types.ts`),
  `elementRefs` (`src/renderer/core/utils.ts`) и сам HTML.
- **IPC-типы — в `src/shared/ipc.ts`.** Новый метод UI добавляй в `SqApi`,
  реализуй в `preload.ts` и в `main.ts` (`ipcMain.handle`).
- **Экранирование:** пользовательский текст (имена каналов/сцен) пропускай через
  `escapeHtml()`. HTML только локальный, CSP: `default-src 'self'`;
  `script-src 'self'`.
- **Стили** — только `src/renderer/assets/styles.css`; цвета/радиусы берутся из
  CSS-токенов `:root`, захардкоженные значения не заводи.
- **Троттлинг/метры:** не запрашивай DOM в цикле метро-пакетов — используй
  существующий паттерн `pendingMeters` + `requestAnimationFrame`.

## 6. Ограничения и guardrails

- **Протокол не угадывать.** Форматы кадров и метро-пакетов восстановлены
  реверс-инжинирингом. Не меняй существующие декодеры «по догадке». Всё, что
  касается неизвестного wire-format (пакеты `0x07`/`0x16`/`0x09`, бит
  стерео/моно миксов, режим матриц, aux/group, FX-метры), **нельзя
  реализовать/проверить без реального пульта** — см.
  `docs/BACKLOG-NO-CONSOLE.md`, группа B.
- **Реальные модели — только SQ-5/6/7.** Не добавляй «примерные» спек-таблицы.
- **Не коммить** `dist/`, `node_modules/`, `release/` (см. `.gitignore`).
- Хранилища: `localStorage` (`sq_recent_hosts`, `sq_saved_routing`,
  `sq_safe_outputs`), диагностические дампы — в `<userData>/diagnostics`.
- Данные не серверные: всё локально, синхронизации нет.

## 7. Порядок работы

1. Ознакомься с профильным `docs/*.md` и, если правишь UI, — с `AGENTS.md` §5.
2. Атомарные задачи из `docs/BACKLOG-NO-CONSOLE.md` бери по одной; при статусе
   `[x]` дописывай результат и убирай закрытый пункт из TODO профильного дока.
3. После правок: `npm run typecheck` → `npm test` → `npm run build` → ручная
   проверка в демо-режиме (без пульта).
4. Изменения, требующие пульта, помечай как группу B и не «закрывай» вслепую.

## 8. Релиз и коммиты

- **Версия поднимается в трёх местах:** `package.json`, `package-lock.json`
  (два поля `version` — корневое и в `packages[""]`), `CHANGELOG.md`.
- **Семантика:** новая функциональность → `X.Y.0`; поведение/фикс → `X.Y.Z`.
- **CHANGELOG:** сверху новый раздел `## [X.Y.Z] — YYYY-MM-DD` с подзаголовками
  `Добавлено` / `Изменено` / `Исправлено` (формат Keep a Changelog).
- **Сообщение коммита** — как в истории: `Release vX.Y.Z: <краткая суть>`
  (например, `Release v1.16.1: sync scroll on by default`). Коммить только
  осмысленные, связанные изменения; коммит/пуш — только по прямой просьбе.
