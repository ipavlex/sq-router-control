# Changelog

Все заметные изменения проекта фиксируются в этом файле.

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
проект придерживается [Semantic Versioning](https://semver.org/lang/ru/).

## [1.0.8] — 2026-08-19

### Изменено
- `index.html` теперь генерируется автоматически: каркас страницы вынесен в
  `index.template.html`, разметка каждой вкладки — в её папку
  (`tabs/{routing,monitor,log}/view.html`, модалки роутинга — в
  `tabs/routing/modals.html`). Сборку выполняет webpack-плагин
  `HtmlFromTabsPlugin` (`webpack/html-from-tabs-plugin.js`).

## [1.0.7] — 2026-08-19

### Изменено
- Функция `setMsg` переименована в `setMessage`.

## [1.0.6] — 2026-08-19

### Изменено
- Переменная `els` переименована в `elementRefs` (все использования обновлены).

## [1.0.5] — 2026-08-19

### Изменено
- Интерфейс `Els` переименован в `ElementRefs` (переменная `els` сохранена).
- Сокращённые идентификаторы переименованы в полные: `Buf` → `BufferReader`,
  `sel` → `selector`, `lbl` → `label`, `mod` → `modifier`, `lr` → `side`,
  `snap` → `snapshot`, `cfg` → `config`, `fc` → `frameCounters`,
  `rec` → `record`, `gen` → `generation`, `l`/`r` → `left`/`right`.

## [1.0.4] — 2026-08-19

### Изменено
- Типы рендерера вынесены в отдельные файлы `types.ts` рядом с кодом:
  `Els` и `RendererState` — в `src/renderer/types.ts`; типы вкладки Routing
  (`EditRow`, `PatchInput`, `MergedInput`, `SavedSet`, `SavedRoutingEntry`) —
  в `src/renderer/tabs/routing/types.ts`; типы вкладки Monitor (`OutputOption`,
  `Dest`, `MixItem`) — в `src/renderer/tabs/monitor/types.ts`. Дубликат
  `EditRow` во вкладке Routing объединён в один.

## [1.0.3] — 2026-08-19

### Изменено
- Модули вкладок рендерера перенесены в отдельные папки
  (`src/renderer/tabs/{routing,monitor,log}/`), импорты обновлены.

## [1.0.2] — 2026-08-19

### Изменено
- Весь код переведён на TypeScript: рендерер разделён на модули по вкладкам
  (`utils.ts`, `connect.ts`, `dashboard.ts`, `routing.ts`, `monitor.ts`,
  `log.ts`), общие IPC-типы вынесены в `src/shared/ipc.ts`; main-процесс и
  preload используют эти типы.
- Добавлена сборка на webpack (таргеты main / preload / renderer); проверка
  типов — отдельной командой `npm run typecheck`.
- Устаревшие JS-файлы рендерера удалены.

## [1.0.1] — 2026-08-19

### Изменено
- Рендерер разбит на модули по вкладкам (`utils.js`, `connect.js`, `routing.js`,
  `monitor.js`, `log.js`, `renderer.js`) — без изменения поведения.
- Вкладка «Монитор»: выбор канала, микса или Main LR теперь меняет **роутинг**
  источника в выбранные L/R выходы вместо PAFL (соло):
  - стерео-пара → левый канал → L-выход, правый канал → R-выход;
  - моно-канал, микс, Main LR → источник в оба выхода L и R;
  - снятие выбора не меняет роутинг — выходы сохраняют последний источник;
  - смена L/R селекторов перенаправляет активный источник;
  - включение «Применять» сразу применяет текущий выбор.
- Добавлен мост `sq.setOutputPatch` (output-patch кадр `0x0f`) в main-процесс.

## [1.0.0] — 2026-08-19

### Добавлено
- Подключение к пульту Allen & Heath SQ по TCP (порт 51326, бинарный протокол).
- Демо-режим без пульта с симуляцией роутинга.
- Вкладка «Роутинг»: Active Patching, редактируемый Input Patching (списки A/B),
  Upload/Download, синхронная прокрутка, сохранение/загрузка роутингов.
- Вкладка «Монитор»: выбор L/R выходов, соло каналов, миксов и Main LR (PAFL).
- Вкладка «Журнал»: журнал кадров и событий.
- Определение модели пульта (SQ-5 / SQ-6 / SQ-7) и адаптация под её I/O.
- Сборка под macOS (arm64 / universal).