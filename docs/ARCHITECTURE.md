# Архитектура приложения — общее описание

> Общая информация об устройстве приложения: архитектура Electron, IPC-мост,
> конвейер данных, общие модули main/renderer, навигация, горячие клавиши,
> хранилища, демо-режим и определение сцены. Здесь собрано то, что **не**
> относится к отдельной вкладке или протоколу — за деталями по ним см. карту
> документации ниже.

## 0. Карта документации

| Документ | Содержание |
|---|---|
| [`CONNECT-SCREEN.md`](CONNECT-SCREEN.md) | Стартовый экран подключения, рукопожатие, ошибки |
| [`ROUTING-TAB.md`](ROUTING-TAB.md) | Вкладка «Роутинг»: Active/Input Patching, A/B, Upload/Download, сохранения |
| [`MONITOR-TAB.md`](MONITOR-TAB.md) | Вкладка «Монитор»: L/R выходы, PAFL, safes, метры |
| [`LOG-TAB.md`](LOG-TAB.md) | Вкладка «Журнал»: уровни, метки, источники записей |
| [`SQ-PROTOCOL.md`](SQ-PROTOCOL.md) | Бинарный протокол SQ: кадры, регистры, ParamData, метры |
| [`../README.md`](../README.md) | Краткий обзор возможностей и запуска |
| [`../CHANGELOG.md`](../CHANGELOG.md) | История изменений |

## 1. Архитектура

Приложение — Electron-приложение с жёстким разделением процессов:

- **main-процесс** (`src/main/`) — единственный, кто работает с сетью. Владеет
  TCP-соединением с пультом, UDP-потоком метров, моделями роутинга и состояния
  каналов. Наружу отдаёт данные через IPC.
- **preload** (`src/main/preload.ts`) — мост `window.sq` через `contextBridge`.
  Renderer не имеет доступа к Node (`nodeIntegration: false`,
  `contextIsolation: true`).
- **renderer** (`src/renderer/`) — UI на чистом TypeScript без фреймворков:
  экран подключения, дашборд и три вкладки. Сеть не трогает — только `window.sq`.

### Поток данных

```
TCP :51326 ──► Framer ──► Connection (EventEmitter)
                              │ dsp / paramData / routingBlock / channelName /
                              │ stereoPairs / sceneList / sceneRecall …
                              ▼
                    SQController.wireEvents (main.ts)
                      ├─ RoutingModel.handleDsp   (роутинг)
                      ├─ MixerState.handleDsp     (фейдеры/мьюты/гейны/…)
                      └─ dirty → flush каждые 120 мс → IPC "sq:routing"
                                                          │
UDP-метры ──► decodeMeterMessage ──► IPC "sq:meters" ─────┤
                                                          ▼
                                            renderer: dashboard → вкладки
```

Ключевые особенности:
- Снапшоты роутинга **троттлятся**: `dirty`-флаг + `setInterval(flush, 120)`
  (`main.ts:1024-1034`), чтобы бурст кадров не заливал UI.
- Поток метров идёт отдельно и не троттлится в main — renderer коалесцирует его
  по кадрам анимации.
- Логи (`sq:log`) — отдельный канал, см. [`LOG-TAB.md`](LOG-TAB.md).

## 2. Структура исходников

```
src/
├── main/                     # main-процесс Electron
│   ├── main.ts               # окно, IPC, SQController (подключение, демо, сцены)
│   ├── preload.ts            # мост window.sq (contextBridge)
│   ├── models.ts             # спецификации SQ-5/6/7 и физические I/O
│   ├── routing.ts            # декодер патч-кадров + RoutingModel
│   ├── state.ts              # MixerState: фейдер/мьют/гейн/pan/HPF/… + декодеры
│   ├── stereo-links.ts       # таблица стерео-линков из ParamData (офсет 81548)
│   ├── paramdata-diagnostics.ts # forensics-отчёт по таблице стерео-линков
│   ├── meters.ts             # декодер UDP-метров, кодировка dBFS, диагностика
│   ├── demo-meters.ts        # генератор синтетического потока метров для демо
│   └── transport/
│       ├── connection.ts     # TCP/UDP-соединение, рукопожатие, парсинг дампов
│       ├── frame.ts          # формат кадров, Sub-типы, Framer, энкодеры
│       └── buffer.ts         # little-endian буфер чтения/записи
├── shared/
│   └── ipc.ts                # общие типы IPC + интерфейс SqApi (window.sq)
└── renderer/                 # UI
    ├── index.ts              # точка входа webpack
    ├── assets/
    │   ├── index.template.html  # каркас, плейсхолдеры @tab:*, CSP
    │   └── styles.css           # дизайн-токены и все стили
    ├── core/
    │   ├── types.ts          # ElementRefs, RendererState, реэкспорт IPC-типов
    │   ├── utils.ts          # elementRefs, state, помощники, showScreen/showView
    │   └── meters.ts         # общая шкала метров dBFS → % / цвет
    ├── connect/              # экран подключения
    ├── dashboard/            # дашборд: события пульта, переключение вкладок
    └── tabs/
        ├── routing/          # «Роутинг» (+ modals.html)
        ├── monitor/          # «Монитор»
        └── log/              # «Журнал»
```

## 3. Сборка и запуск

`package.json` (v1.14.0):

| Команда | Действие |
|---|---|
| `npm start` | `webpack --mode production` + `electron .` |
| `npm run dev` | dev-сборка + `electron . --enable-logging` |
| `npm run watch` | `webpack --watch` |
| `npm run typecheck` | `tsc --noEmit` (типы проверяются отдельно от сборки) |
| `npm run clean` | удалить `dist/` |
| `npm run pack` | production-сборка + `electron-builder --dir` (без установщика) |
| `npm run dist` | production-сборка + установщики (dmg/nsis/AppImage) |
| `npm run dist:mac-arm64` | сборка под Apple Silicon |

### Три таргета webpack

`webpack.config.js` собирает независимо:

| Target | Вход | Выход | target |
|---|---|---|---|
| `main` | `src/main/main.ts` | `dist/main/main.js` | `electron-main` |
| `preload` | `src/main/preload.ts` | `dist/main/preload.js` | `electron-preload` |
| `renderer` | `src/renderer/index.ts` | `dist/renderer/renderer.js` | `web` |

- `ts-loader` работает в `transpileOnly: true` — ошибки типов ловит только
  `npm run typecheck`.
- `source-map` включён во всех таргетах.
- В `dist/main/` копируется `build/icon.png` — иконка для Dock в dev-режиме.

### Сборка HTML

`webpack/html-from-tabs-plugin.js` (`HtmlFromTabsPlugin`) собирает
`dist/renderer/index.html` из `index.template.html`, подставляя фрагменты
`view.html` / `modals.html` по плейсхолдерам `<!-- @tab:NAME -->`. Подстановка
многопроходная (дашборд содержит плейсхолдеры вкладок), неразрешённые
плейсхолдеры валят сборку. Каждый модуль владеет своей разметкой рядом с кодом.

### Безопасность renderer

`index.template.html` задаёт CSP:
`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self';`.
Скрипты только локальные; inline-стили разрешены (используются в разметке).

`tsconfig.json`: `strict: true`, `target ES2020`, `module ESNext`,
`moduleResolution bundler`, `noEmit`.

### Упаковка

`electron-builder` (секция `build` в `package.json`): appId
`com.sqrouter.control`, productName `SQ Router Control`, macOS DMG
universal, подпись кода отключена (`identity: null`). Окно:
1180×820, минимум 880×600, фон `#0f1115` (`main.ts:1300-1314`).

## 4. IPC-мост `window.sq`

Объявлен в `src/shared/ipc.ts` (`SqApi`), реализован в `preload.ts`.
Контекст изолирован, Node в renderer отключён.

### Методы (invoke)

| Метод | Канал | Назначение |
|---|---|---|
| `connect(host, port?)` | `sq:connect` | Подключение к пульту |
| `disconnect()` | `sq:disconnect` | Разрыв соединения |
| `getSnapshot()` | `sq:getSnapshot` | Текущий снапшот роутинга + состояния |
| `demoRefresh()` | `sq:demoRefresh` | Новый вариант демо-роутинга |
| `startDemo()` | `sq:startDemo` | Запуск демо-режима |
| `requestDump()` | `sq:requestDump` | Запрос полного дампа у пульта |
| `getStatus()` | `sq:getStatus` | Статус (connected/version/spec) |
| `setInputPatch(destB3, source, ch)` | `sq:setInputPatch` | Инпатч одного канала |
| `setOutputPatch(sourceB3, type, ch)` | `sq:setOutputPatch` | Аутпатч |
| `setFxOutputPatch(fx, side, type, ch)` | `sq:setFxOutputPatch` | Выход FX-возврата |
| `setMonitorOutput(side, type, ch)` | `sq:setMonitorOutput` | Мониторный выход (PAFL) |
| `setPafl(b3, on)` | `sq:setPafl` | Соло шины |
| `applyRouting({inputs, outputs})` | `sq:applyRouting` | Применение сохранённого роутинга |
| `restoreOutputs(outputs)` | `sq:restoreOutputs` | Возврат выходов после сессии монитора |

### События (on*, возвращают функцию отписки)

| Подписка | Канал | Payload | Источник |
|---|---|---|---|
| `onStatus` | `sq:status` | `StatusPayload` | connect/disconnect |
| `onRouting` | `sq:routing` | `SnapshotPayload` | throttle 120 мс |
| `onLog` | `sq:log` | `LogPayload` | все события/кадры |
| `onMeters` | `sq:meters` | `MetersPayload` | UDP ~25–50 Гц |
| `onInitialState` | `sq:initialState` | — | конец начального бурста |

## 5. Конвейер данных (main)

`SQController.wireEvents(conn)` (`main.ts:1024-1224`) подписан на события
`Connection`:

| Событие | Обработка |
|---|---|
| `dsp` | `RoutingModel.handleDsp` + `MixerState.handleDsp`; при изменении — `dirty`; live-кадры реколла сцены и патчей пишутся в журнал |
| `channelName` | имя канала → `RoutingModel.names` |
| `stereoPairs` | таблица стерео-линков → модель |
| `paramDataSize` | первый большой ParamData → `dumpParamData` (диагностика) |
| `sceneName` | имя сцены в библиотеку |
| `sceneList` | сводка списка сцен (журнал) |
| `sceneRecall` | активная сцена (эвристика) |
| `routingBlock` | размер routing/config-блока |
| `initialState` | сводки Initial state, flush снапшота, `sq:initialState` |
| `connect` / `disconnect` | `sq:status`, журнал |
| `meters` | проброс `sq:meters` |
| `meterPacketInfo` | инвентарь метро-пакетов (журнал + дампы) |
| `error` | журнал |

### Начальный дамп

`Connection._parseInitialState` (`connection.ts:534-633`) разбирает ParamData
(~97 КБ) и **переизлучает значения синтетическими `dsp`-событиями** в том же
формате, что и живые кадры. Благодаря этому `MixerState.handleDsp` — единый
потребитель и для дампа, и для live. Там же декодируются имена каналов,
инпатчинг и таблица стерео-линков.

## 6. Общие модули main

| Модуль | Ключевое |
|---|---|
| `models.ts` | `SQModelSpec` и таблица `MODELS` (SQ-5/6/7), `modelSpec(id)`, `modelName(id)`; fallback `DEFAULT_SPEC` для неизвестной модели |
| `routing.ts` | `RoutingModel`, декодер патч-кадров `0x0b/0x0d`, `b3ToLabel`/`labelToB3`, enums источников/назначений; снапшот `RoutingSnapshot` |
| `state.ts` | `MixerState` — состояние каналов в пользовательских единицах; декодеры `wireToDb`, `wireToTrimDb`, `wireToPan`, `wireToHpfHz`, `wireToDelayMs` |
| `stereo-links.ts` | Декодер таблицы стерео-линков (офсет 81548, шаг 4 Б, два варианта кодирования A/B) |
| `paramdata-diagnostics.ts` | `analyzeStereoTable` — отчёт и поиск таблицы при смене прошивки |
| `meters.ts` | Декодер UDP-метров, `decodeMeterMessage`, кодировка dBFS, инвентарь/диффы пакетов |
| `demo-meters.ts` | `DemoMetersSim` — синтетический поток метров для демо (тик 200 мс) |
| `transport/frame.ts` | Формат кадров, `Sub`-типы, `Framer` (ресемплинг потока), энкодеры |
| `transport/buffer.ts` | `BufferReader` — little-endian чтение/запись, null-terminated строки |

## 7. Общие модули renderer

### `core/utils.ts`

- `elementRefs` — единый типизированный словарь ссылок на все DOM-элементы.
  Все модули берут элементы отсюда; при добавлении элемента в разметку нужно
  дополнить `ElementRefs` (`core/types.ts`) и `elementRefs`.
- `state: RendererState` — кросс-вкладочное состояние (`modelSpec`,
  `stereoPairs`, `mixStereoPairs`, `activeInputs`, `channelStates`,
  `currentSceneName`, `isDemoMode`).
- Помощники: `isValidHost`, `setMessage`, `setLoading`, `getRecent`/`addRecent`/
  `renderRecent`, `showScreen`, `showView`, `fmtTime`, `escapeHtml`, `todayStr`,
  `updateSceneHint`, `flashTitle`.

### `core/types.ts`

`ElementRefs`, `RendererState`, глобальное расширение `Window` с `sq: SqApi`,
реэкспорт общих IPC-типов.

### `core/meters.ts`

Общая шкала для обеих вкладок: `METER_MIN_DB = −60`, `METER_WARN_DB = −20`,
`METER_HOT_DB = −6`; `dbToPercent`, `meterClassName`, `meterDbText`.
Благодаря этому шкала баров одинакова в «Роутинге» и «Мониторе».

### `dashboard/index.ts`

Точка сборки UI: `enterDashboard`, подписки `onStatus`/`onRouting`/`onLog`/
`onMeters`/`onInitialState`, переключение вкладок. Импортируется ради
сайд-эффектов из `renderer/index.ts`.

## 8. Навигация и топбар

Топбар дашборда (`dashboard/view.html`):

| Элемент | Роль |
|---|---|
| `.dot.live` | Индикатор подключения (зелёная точка) |
| `#topbar-title` | Модель пульта (из `ModelSpec.name`) |
| `#topbar-sub` | Хост + версия прошивки (`FW A.B.C`) |
| `#topbar-scene` | Активная сцена: `· 🎬 <имя>` (`updateSceneHint`) |
| `🔊 Роутинг` / `🎧 Монитор` / `📋 Журнал` | Переключение вкладок |
| `Отключиться` | Разрыв и возврат на экран подключения |

`showView("routing" | "log" | "monitor")` (`utils.ts:196-205`) прячет/показывает
вью и подсвечивает активную кнопку. Кнопка «Журнал» при открытом журнале
меняет текст на «← Назад» (см. [`LOG-TAB.md`](LOG-TAB.md)).

## 9. Горячие клавиши

| Клавиши | Где | Действие |
|---|---|---|
| `Enter` | экран подключения (IP/порт) | Подключиться |
| `Enter` | модалка сохранения роутинга | Подтвердить сохранение |
| `Esc` | модалки сохранения/загрузки роутинга | Закрыть |
| `←` / `→` | вкладка «Монитор» | Переключение миксов |
| `1–9`, `0` | вкладка «Монитор» | Миксы 1–10 |
| `Esc` | вкладка «Монитор» | Сброс выбора |
| `M` (по `e.code`) | вкладка «Журнал» | Поставить метку |

Подробности по вкладкам — в соответствующих документах.

## 10. Хранение данных

Приложение не имеет сервера: всё локально.

### `localStorage` (renderer)

| Ключ | Что хранит | Лимит | Модуль |
|---|---|---|---|
| `sq_recent_hosts` | Недавние хосты | 6 | `core/utils.ts` |
| `sq_saved_routing` | Сохранённые роутинги | 100 | `tabs/routing` |
| `sq_safe_outputs` | «Безопасные» выходы монитора | — | `tabs/monitor` |

### Файлы диагностики (main)

Пишутся в `<userData>/diagnostics` (например,
`~/Library/Application Support/SQ Router Control/diagnostics`):

- `paramdata-dump.bin` — сырой ParamData;
- `paramdata-stereo.txt` — отчёт по таблице стерео-линков;
- `meter-packet-0x<id>-<len>B.bin` — по одному дампу на форму метро-пакета.

Пути и сводки дублируются в журнал (`LOG-TAB.md`, раздел «Диагностика»).

## 11. Демо-режим

`SQController.startDemo()` (`main.ts:642-690`) поднимает полностью
симулированный SQ-5 (FW 1.9.4) без сети:

- модель и `MixerState` наполняются правдоподобным шоу (`seedDemoMixerState`);
- начальный бурст: 5 фаз по ~50 мс с растущими снапшотами (имена, патчи,
  стерео-пары, аутпатчи, routing-блок), затем `sq:initialState`;
- периодическая симуляция live-изменений каждые 4.5 с;
- поток метров `DemoMetersSim` (~5 пакетов/с, тик 200 мс).

`demoRefresh()` (кнопка «Обновить» в демо) пересобирает **другой** вариант
роутинга из `DEMO_VARIANTS` и циклически реколлит сцену. Демо и реальное
подключение взаимоисключающи: `connect()` вызывает `stopDemo()`, `startDemo()`
вызывает `stopDemo()`.

## 12. Определение активной сцены

В бинарном протоколе SQ **нет запроса активной сцены**, поэтому имя определяется
косвенно (`main.ts:301-306,1041-1056`, `connection.ts:461-510`):

1. `sceneNames` — библиотека `sceneId → имя` из списка сцен (sub=0x08).
2. `currentSceneId` — последняя наблюдённая сцена:
   - live-кадр подтверждения реколла `F7 02 02 1C [sceneId] …` (самый надёжный
     источник; приходит после любого реколла — поверхность, софткеи, MIDI);
   - либо эвристика: полная запись сцены `00 02 18 [sceneId] … 40 00 00` после
     реколла/переименования/сохранения (`sceneRecall`).
3. Пока ни один кадр не пришёл, активная сцена **неизвестна** (не угадывается).
4. Имя показывается в топбаре (`updateSceneHint`) и пишется в журнал.

Ограничение: активная сцена, выставленная до подключения приложения, не
отображается, пока пульт не пришлёт хотя бы один реколл/запись.

## 13. Модели и адаптация I/O

`models.ts` — все SQ используют 48-канальный DSP-движок, но различаются
физическими разъёмами:

| Модель | XLR in | Line in | Local in | XLR out | TRS out | Local out | USB |
|---|---|---|---|---|---|---|---|
| SQ-5 (`0x01`) | 16 | 6 | 22 | 12 | 2 | 14 | 32 |
| SQ-6 (`0x02`) | 24 | 6 | 30 | 14 | 2 | 16 | 32 |
| SQ-7 (`0x03`) | 32 | 6 | 38 | 16 | 2 | 18 | 32 |

Mix-шин — 12, DCA — 8. `modelSpec()` определяет, какие источники/выходы
валидны, и передаётся в снапшоте; при неизвестной модели — `DEFAULT_SPEC`
с пометкой `Unknown (0x..)`. Спека также участвует в стерео-слиянии и
селекторах (см. `ROUTING-TAB.md`, `MONITOR-TAB.md`).

## 14. Стили и дизайн-система

Все стили — `renderer/assets/styles.css` (≈1800 строк), токены в `:root`:

| Токен | Значение | Роль |
|---|---|---|
| `--bg` | `#0f1115` | Фон окна |
| `--bg-elev` / `--bg-elev2` | `#161a21` / `#1c212b` | Панели/поля |
| `--border` / `--border-soft` | `#272d39` / `#1f242f` | Рамки |
| `--text` / `--text-dim` / `--text-faint` | `#e6e9ef` / `#8b94a6` / `#5b6473` | Текст |
| `--accent` / `--accent-dim` | `#4f9cf9` / `#2f6fc0` | Акцент (синий) |
| `--green` / `--red` / `--amber` | `#3ecf8e` / `#f0616d` / `#f5b042` | OK / ошибка / предупреждение |
| `--radius` | `10px` | Скругления |
| `--mono` / `--sans` | SF Mono… / системный sans | Шрифты |

Глобально: `box-sizing: border-box`, правило `[hidden] { display: none
!important; }` — атрибут `hidden` всегда побеждает. Тёмная тема
единственная, кастомные скроллбары (`::-webkit-scrollbar`).

## 15. Диагностика и отладка

- **Журнал** — основной пользовательский инструмент (см. `LOG-TAB.md`).
- **Renderer**: глобальный обработчик ошибок пишет стек в консоль
  (`renderer/index.ts:11-14`).
- **Main**: `uncaughtException` / `unhandledRejection` логируются
  (`main.ts:1330-1335`), падение renderer-процесса — событие
  `render-process-gone`.
- **Одноэкземплярность**: single-instance lock; повторный запуск фокусирует
  существующее окно (`main.ts:1386-1395`).
- **Дампы**: `paramdata-dump.bin` и meter-пакеты в `<userData>/diagnostics`
  (раздел 10).
- **Метро-инвентарь**: `meterPacketInfo` логирует формы пакетов и изменения
  слотов — для расшифровки ещё не декодированных метро-пакетов
  (`SQ-PROTOCOL.md`, §10.1).

## 16. Известные неизвестные

Полный список открытых вопросов протокола — в
[`SQ-PROTOCOL.md`](SQ-PROTOCOL.md), раздел 10. Кратко:

- не декодированы некоторые метро-пакеты (раскладка mix/Main LR подтверждена
  лишь частично);
- режим стерео/моно самих миксов не найден в ParamData — определяется по
  метрам;
- активная сцена не запрашивается, только наблюдается;
- нет автообнаружения пультов, авто-переподключения и выбора сетевого
  интерфейса (см. `CONNECT-SCREEN.md`, «Ограничения»).

## TODO

- добавить подсказку про определение сцены
- новый раздел со снапшотами, например уровни посылов на эффекты, панорамы для ведущих вокалистов
- экспорт темплейта для записи мультитрека через daw reaper — ведётся в отдельной
  ветке `feature/reaper-track-template` (на момент написания ветка отстаёт от
  `main` и уникальных коммитов не содержит — задел под задачу)
