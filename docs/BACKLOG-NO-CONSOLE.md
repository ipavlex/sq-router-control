# Бэклог: правки без проверки на реальном пульте

> Назначение: собрать в одном месте задачи, которые можно **реализовать и проверить
> без живого пульта Allen & Heath SQ**. Файл задуман как рабочий список для
> атомарных правок: один пункт = одна независимая задача со стабильным ID,
> источником и способом проверки.
>
> Составлен по итогам разбора `docs/` (ARCHITECTURE, CONNECT-SCREEN, ROUTING-TAB,
> MONITOR-TAB, LOG-TAB, SQ-PROTOCOL). Дата разбора: 2026-09-28.

## 0. Как пользоваться

**Статусы:**

| Метка | Значение |
|---|---|
| `[ ]` | не начато |
| `[~]` | в работе |
| `[x]` | готово |
| `[-]` | отменено / неактуально |

**Правила:**

- Один пункт — одна атомарная правка. Не объединять несвязанные изменения.
- ID не переиспользуется даже после отмены пункта.
- При статусе `[x]` дописывать короткий результат (PR/коммит) и снимать
  актуальность с исходного TODO в профильном документе.
- Пункты внутри группы независимы и допускают параллельное выполнение.

**База проверки (без пульта):**

- `npm test` — юнит-тесты чистых декодеров (`node:test` + `tsx`), без пульта и
  Electron. Покрытие ограничено чистыми функциями; UI и wire-логика — вручную.
- Доступные способы проверки: **демо-режим** (полная симуляция SQ-5,
  `src/main/demo-meters.ts`), `npm run typecheck`, `npm test`, `npm run build`,
  ручной UI.
- Всё, что упирается в неизвестный wire-format, без пульта проверить нельзя —
  такие задачи вынесены в группу B.

**Легенда групп:**

- **A** — можно сделать и проверить без пульта (UI / логика / localStorage / демо).
- **B** — требует реального пульта (реверс-инжиниринг или поведение на железе).
- **C** — гибрид: код пишется без пульта, финальная проверка — на сети/железе.

---

## 1. Группа A — можно без пульта

### A.1. Вкладка «Роутинг»

- [x] **RT-01 — Синхронизация прокрутки включена по умолчанию**
  - Источник: `ROUTING-TAB.md` §13 (пункт удалён).
  - Суть: `syncScrollEnabled` инициализируется `true`
    (`src/renderer/tabs/routing/index.ts` → `syncScrollEnabled`).
  - Файлы: `src/renderer/tabs/routing/index.ts`,
    `src/renderer/tabs/routing/view.html` (кнопка сразу `.active`,
    `aria-pressed="true"`).
  - Проверка: `npm run typecheck` и `npm run build` — зелёные; демо-режим —
    прокрутка одной таблицы ведёт вторую.

- [-] **RT-02 — Решить судьбу кнопки «Обновить»** — отменено.
  - Источник: `ROUTING-TAB.md` §13 (пункт удалён).
  - Решение: кнопку **оставляем**. Она не дублирует Download: `getSnapshot()`
    читает уже построенную модель, а `requestFullDump()` перезапрашивает железо;
    это единственный проверенный on-demand способ синхронизации, нужный из-за
    заморозки Input Patching и оптимистичного применения патчей.
  - Исходная формулировка «убрать кнопку обновить?» удалена из доки.

### A.2. Вкладка «Журнал»

- [x] **LG-01 — Убрать кнопку «Назад», оставить единый «Журнал»**
  - Источник: `LOG-TAB.md` §TODO.
  - Результат: код уже соответствовал требованию — реализовано в **v1.14.1**
    (commit `5f1480b`, «persistent log button, no back button»). В `src/` нет
    «Назад»/back-логики; `log-btn` всегда `📋 Журнал` и подсвечивается активным.
  - Правки: удалён устаревший пункт TODO из `LOG-TAB.md`; исправлено неверное
    утверждение в `ARCHITECTURE.md` §8 (см. DOC-01).

- [x] **LG-02 — Кнопка «Сохранить в файл»**
  - Источник: `LOG-TAB.md` §TODO.
  - Результат: добавлена кнопка `#save-log` («Сохранить в файл») в панель
    журнала. Лента сериализуется из DOM в формате
    `[HH:MM:SS] [LEVEL] message` и пишется через `window.sq.exportFile()` в
    `.txt` (`<дата> SQ log.txt`). Пустой журнал — предупреждение в ленте;
    отмена диалога тихая; ошибка пишется в ленту.
  - Файлы: `src/renderer/tabs/log/view.html`, `src/renderer/tabs/log/index.ts`,
    `src/renderer/core/utils.ts`, `src/renderer/core/types.ts`.
  - Проверка: `npm run typecheck` и `npm run build` — зелёные; демо — набрать
    лог → «Сохранить в файл» → файл открывается 1:1 с экраном.

- [-] **LG-03 — Кнопка «Копировать в буфер обмена»** — отменено.
  - Источник: `LOG-TAB.md` §TODO (пункт удалён).
  - Причина: отменено по решению — не делаем.

- [x] **LG-04 — Переключатель «сырой hex ↔ распаршенное» в журнале**
  - Источник: `LOG-TAB.md` §TODO (переформулировано: не сохранение, а
    переключение представления).
  - Результат: `LogPayload.raw` (пробел-разделённый hex кадра,
    `src/shared/ipc.ts`); в main (`main.ts`) `raw` несут протокольные записи —
    исходящие патч-кадры и PAFL, принятые DSP-кадры, routing-блок, метр-пакет.
    В renderer `pushLog` хранит `parsed`/`raw` в `dataset`; кнопка
    `#log-raw-toggle` («Сырой hex») меняет текст у всех строк. Записи без кадра
    остаются текстовыми в обоих режимах. «Сохранить в файл» выгружает текущее
    представление.
  - Файлы: `src/shared/ipc.ts`, `src/main/main.ts`,
    `src/renderer/dashboard/index.ts`, `src/renderer/tabs/log/*`,
    `src/renderer/core/utils.ts`, `src/renderer/core/types.ts`,
    `src/renderer/assets/styles.css`.
  - Проверка: `npm run typecheck` и `npm run build` — зелёные. В демо wire-кадров
    нет (симуляция идёт через локальные `dsp(...)`), поэтому hex-представление
    реально видно только на пульте — это осознанное ограничение, не блокер.

### A.3. Экран подключения

- [x] **CN-01 — Авто-переподключение при разрыве**
  - Источник: `CONNECT-SCREEN.md` §11.
  - Суть: повторные попытки с backoff, UI-индикация.
  - Результат: авто-переподключение реализовано в main-процессе
    (`SQController.scheduleReconnect/attemptReconnect/cancelReconnect`):
    backoff `1→2→4→8→16→30с`, до **8** попыток, те же host/port. В
    `StatusPayload` добавлены `reconnect` (`ReconnectInfo`) и `reconnected`;
    новый IPC `sq:cancelReconnect`. Renderer показывает баннер
    `#reconnect-banner` с живым отсчётом и кнопкой «Отменить», остаётся на
    дашборде во время ретраев, при сдаче — экран подключения с причиной.
    Ручное подключение/демо/«Отключиться» отменяют серию.
  - Файлы: `src/shared/ipc.ts`, `src/main/preload.ts`, `src/main/main.ts`,
    `src/renderer/dashboard/index.ts` (+`view.html`),
    `src/renderer/connect/index.ts`, `src/renderer/core/{types,utils}.ts`,
    `src/renderer/assets/styles.css`.
  - Проверка: `npm run typecheck` и `npm run build` — зелёные. Логика воспроизводима
    на тестовом TCP-сервере: обрыв established-сокета → серия ретраев с backoff,
    успех → баннер скрывается, исчерпание/«Отменить» → экран подключения.
  - Доки: `CONNECT-SCREEN.md` §8/§8.1/§11 обновлены; исходный пункт §11 снят.

- [-] **CN-02 — Порт хранить per-host** — отменено.
  - Источник: `CONNECT-SCREEN.md` §11.
  - Причина: отменено по решению — не делаем.
  - Текущее поведение (порт один общий, по умолчанию `51326`) остаётся как есть
    и по-прежнему описано в `CONNECT-SCREEN.md` §11.

- [ ] **CN-03 — Выбор локального сетевого интерфейса в UI**
  - Источник: `CONNECT-SCREEN.md` §11.
  - Суть: `ConnectOptions.localInterface` уже существует — добавить селектор
    интерфейсов в экран подключения.
  - Файлы: `src/renderer/connect/*`, `src/main/transport/connection.ts`,
    `src/shared/ipc.ts`.
  - Проверка: список интерфейсов заполняется; сборка/typecheck; финально — CN-C1.

### A.4. Архитектура и общее

- [ ] **AR-01 — Новый раздел со снапшотами (посылы на эффекты, панорамы)**
  - Источник: `ARCHITECTURE.md` §16.
  - Суть: данные уже декодируются (`src/main/state.ts`; отправки на шины/FX и
    панорама — см. `SQ-PROTOCOL.md` §3 и §6.2). Сделать UI-раздел.
  - Файлы: `src/renderer/dashboard/*`, `src/shared/ipc.ts`, `src/main/state.ts`.
  - Проверка: рендер и навигация — в демо. **Корректность значений** сверить с
    пультом отдельно (см. примечание в группе B).

### A.5. Тесты (инфраструктура)

- [x] **TS-01 — Завести автотесты для чистых декодеров**
  - Источник: `SQ-PROTOCOL.md` §8.8 (подсказка про сборку тестовых буферов).
  - Результат: подключён встроенный раннер `node:test`, запускаемый через `tsx`
    (`npm test` → `node --import tsx --test "src/**/*.test.ts"`; добавлен
    единственный devDependency `tsx`). Тесты лежат рядом с модулями как
    `*.test.ts` и не попадают в webpack-сборку (явные entry-поинты).
  - Покрытие (100 тестов): `transport/buffer.ts`, `transport/frame.ts`
    (`Framer`: split/partial/resync/DSP/0x7F-0xF7), `meters.ts`
    (`rawToDb`, `meterBody`, `decodeMeterMessage` 0x06/0x17/0x18 + merge,
    `meterSamplePreview`, `diffMeterBody`, `hotMeterSlots`, `formatMeterChanges`),
    `stereo-links.ts` (encoding A/B + ловушки), `routing.ts`
    (`b3ToLabel`/`labelToB3`, input/output/FX/monitor патчи, replace,
    stereo-фильтр, snapshot/reset), `state.ts` (конвертеры, все регистры
    `handleDsp`, snapshot/reset). Тестовые UDP-пакеты собираются через
    `Buffer.concat([header, body])` (§8.8).
  - Файлы: `package.json`, `src/main/transport/buffer.test.ts`,
    `src/main/transport/frame.test.ts`, `src/main/meters.test.ts`,
    `src/main/stereo-links.test.ts`, `src/main/routing.test.ts`,
    `src/main/state.test.ts`.
  - Проверка: `npm test` — 100/100 зелёные без пульта; `npm run typecheck` и
    `npm run build` — зелёные.
  - Доки: `AGENTS.md` §2/§7 (команда `npm test`, «автотестов нет» → покрытие
    чистых декодеров) и база проверки в этом файле обновлены.

---

## 2. Группа B — нужен реальный пульт

> Реализация невозможна/бессмысленна без захвата трафика с живого SQ и
> изолированной подачи сигналов. Хранится здесь, чтобы не терять контекст.

- **MON-B1 — Отладить роутинг** («очень сильно багует», `MONITOR-TAB.md` §13).
  Часть дефектов может быть чистой логикой (см. C-MON-01), полный список — на железе.
- **MON-B2 — Метр к FX-кнопкам** (`MONITOR-TAB.md` §13). Данные вроде есть в 0x18
  (шины 36–39, `SQ-PROTOCOL.md` §8.4), привязку слотов подтвердить захватом.
- **MON-B3 — Определение aux / group** (`MONITOR-TAB.md` §13).
- **MON-B4 — Реальное определение стерео-миксов** (`MONITOR-TAB.md` §13,
  `SQ-PROTOCOL.md` §8.5/§10.2): бит режима в ParamData не найден.
- **MON-B5 — Режим матриц (стерео/моно) и имена слотов разбитых матриц**
  (`MONITOR-TAB.md` §12 п.5, §13).
- **PR-B1 — Декодировать метро-пакеты `0x07`, `0x16`, `0x09`**
  (`SQ-PROTOCOL.md` §10.1).
- **PR-B2 — Бит режима стерео/моно миксов в ParamData** (`SQ-PROTOCOL.md` §10.2).
- **PR-B3 — Переносимость id метро-пакетов между моделями** (SQ-6/7, Qu, CQ;
  `SQ-PROTOCOL.md` §10.2).
- **PR-B4 — Активная сцена**: в протоколе нет запроса, только наблюдение
  (`SQ-PROTOCOL.md` §7/§10.2, `ARCHITECTURE.md` §12).
- **PR-B5 — Сверить значения снапшотов AR-01 с реальным пультом.**

---

## 3. Группа C — гибрид

- [x] **CN-C1 — Автообнаружение пультов (mDNS / скан сети)**
  - Источник: `CONNECT-SCREEN.md` §11 (пункт снят, см. §4.2).
  - Результат: реализован **скан локальной подсети** без внешних зависимостей
    (mDNS не используется — потребовал бы библиотеку, а тип сервиса без пульта
    не подтвердить). `src/main/discovery.ts`: `subnetsFromInterfaces`/
    `localSubnets` (активные IPv4 /24, без loopback и `169.254/16`),
    `expandSubnet` (`.1`–`.254`), `probeHost` (TCP `51326` + минимальный
    префикс рукопожатия до кадра версии `sub=0x02`) и `scanNetwork` (пул до 32
    проб, общий UDP-сокет, `AbortController`, поток найденного через `onFound`).
    `SQController.discover/cancelDiscovery` (+ IPC `sq:discoverConsoles` /
    `sq:cancelDiscovery`), мост `window.sq.discoverConsoles/cancelDiscovery/
    onConsoleFound`, на экране подключения — кнопка «🔍 Найти пульты в сети»,
    статус, список с потоковым пополнением и кнопка «Отмена»; клик по находке
    подставляет хост/порт.
  - Файлы: `src/main/discovery.ts` (+`discovery.test.ts`), `src/shared/ipc.ts`,
    `src/main/preload.ts`, `src/main/main.ts`, `src/renderer/connect/*`,
    `src/renderer/core/{types,utils}.ts`, `src/renderer/assets/styles.css`.
  - Проверка: `npm test` — 113/113 (из них 13 новых: fake SQ-сервер на loopback
    для `probeHost`/`scanNetwork` + чистые `subnetsFromInterfaces`/`expandSubnet`);
    `npm run typecheck` и `npm run build` — зелёные. Финальная проверка — на
    реальном пульте в сети (группа C).

- [ ] **MON-C1 — Воспроизводимые баги роутинга в демо**
  - Источник: `MONITOR-TAB.md` §13 (первая строка).
  - Суть: отделить дефекты чистой логики от аппаратных; воспроизводимые в демо
    чинить здесь, остальное — `MON-B1`.

---

## 4. Правки документации (без кода и пульта)

- [x] **DOC-01 — Кнопка журнала: устранить противоречие**
  - Проблема: `ARCHITECTURE.md` §8 утверждал, что текст меняется на «← Назад»;
    `LOG-TAB.md` §2 и код (`src/renderer/dashboard/view.html` → `#log-btn`) — что
    подпись всегда `📋 Журнал`.
  - Результат: `ARCHITECTURE.md` §8 исправлен — подпись не меняется, возврат
    кнопками `🔊 Роутинг` / `🎧 Монитор`. Сделано вместе с LG-01.

- [x] **DOC-02 — Версия приложения**
  - Проблема: `ARCHITECTURE.md` §3 указывал `v1.14.0`, в `package.json` — уже
    `1.17.0`.
  - Результат: `ARCHITECTURE.md` §3 синхронизирован — `v1.17.0`.

- [x] **DOC-03 — Ссылки на строки кода**
  - Проблема: ссылки вида `main.ts:1024-1034`, `connection.ts:534-633` устарели
    (например, `wireEvents` переехал на 1282, `startDemo` — на 895).
  - Результат: все адреса по номерам строк заменены на **ссылки по символам**
    (`файл` → `символ`) в `ARCHITECTURE.md`, `CONNECT-SCREEN.md`, `LOG-TAB.md`
    и в этом бэклоге. Номера строк больше не поддерживаются.

- [x] **DOC-04 — Синхронизация кодов источников/назначений в UI-доках**
  - Проблема: `SQ-PROTOCOL.md` §4.2 содержит `0x1B` ME (Mon), которого нет в
    UI-доках (`ROUTING-TAB.md` §10, `MONITOR-TAB.md` §10).
  - Результат: выбран вариант «в UI не используется» (код не поддержан
    селекторами — `LOCK_TAB_DESTS`/`buildOutputOptions` в
    `monitor/index.ts` дают только `0x1a/0x1c/0x1d/0x1e`). Пометка добавлена в
    `SQ-PROTOCOL.md` §4.2, `MONITOR-TAB.md` §3 и §10 (новый подраздел «Типы
    выходов (destType)»), `ROUTING-TAB.md` §10.

- [ ] **DOC-05 — Снятие закрытых пунктов из TODO профильных доков**
  - После выполнения пунктов группы A убирать/помечать их в
    `ROUTING-TAB.md` §13, `LOG-TAB.md` §TODO, `MONITOR-TAB.md` §13.

---

## Приложение. Карта источников

| Документ | Что берём из него |
|---|---|
| `ARCHITECTURE.md` §16 | Новый раздел снапшотов (AR-01) |
| `ROUTING-TAB.md` §13 | RT-01 |
| `MONITOR-TAB.md` §12–13 | MON-B1…B5, MON-C1 |
| `LOG-TAB.md` §9, §TODO | LG-01, LG-02, LG-04 закрыты; LG-03 отменён |
| `CONNECT-SCREEN.md` §11 | CN-01 закрыт, CN-02 отменён, CN-C1 закрыт; CN-03 |
| `SQ-PROTOCOL.md` §8.8, §10 | TS-01 закрыт; PR-B1…B5 |

**Связи с существующим кодом:** `exportFile` — `src/renderer/dashboard/index.ts`
(`exportReaperTemplate`), `src/shared/ipc.ts` (`SqApi.exportFile`),
`src/main/preload.ts` (`exportFile`); `syncScrollEnabled` —
`src/renderer/tabs/routing/index.ts`; кнопка журнала —
`src/renderer/dashboard/view.html` (`#log-btn`).
