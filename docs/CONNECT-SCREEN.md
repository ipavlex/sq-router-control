# Начальный экран подключения — описание работы

> Подробное описание стартового экрана «SQ Router Control»: интерфейс, поля
> ввода, потоки подключения и демо-режима, валидация, сообщения об ошибках,
> недавние хосты и рукопожатие с пультом. Справочник по протоколу SQ — в
> [`SQ-PROTOCOL.md`](SQ-PROTOCOL.md).

## 1. Назначение

Экран подключения (`#connect-screen`) — первое, что видит пользователь при
запуске приложения. Он позволяет:

- подключиться к пульту Allen & Heath SQ по IP-адресу или имени хоста;
- запустить **демо-режим** — полную симуляцию пульта без реального устройства;
- быстро вернуться к недавно использованным хостам.

При успешном подключении или старте демо экран сменяется дашбордом
(`showScreen("dash")`), а при отключении или разрыве связи — снова показывается
экран подключения.

Точки входа в коде:
- renderer: `src/renderer/connect/view.html`, `src/renderer/connect/index.ts`;
- общие помощники: `src/renderer/core/utils.ts`;
- main-процесс: `src/main/main.ts` (`SQController.connect`, `startDemo`),
  `src/main/transport/connection.ts` (TCP-рукопожатие).

## 2. Интерфейс

### Шапка (brand)

| Элемент | Описание |
|---|---|
| Логотип (`.logo`, inline SVG) | Мини-версия иконки приложения: пять уровневых метров (зелёный → янтарный → красный) |
| `SQ Router Control` (`h1`) | Название приложения |
| `Allen & Heath SQ — network routing monitor` (`.sub`) | Подзаголовок |

### Карточка ввода (`.card`)

| Элемент | Селектор | Роль |
|---|---|---|
| `IP-адрес пульта` | `label` → `#ip-input` | Поле хоста (IPv4 или имя) |
| Порт | `#port-input` | TCP-порт, по умолчанию `51326` |
| Подсказка | `.hint` | «Порт по умолчанию: `51326` … Порт MIDI — `51325`» |
| «Подключиться» | `#connect-btn` (`.btn.primary`) | Запуск подключения |
| Разделитель «или» | `.divider` | Визуальное отделение демо-режима |
| «▶ Демо-режим (без пульта)» | `#demo-btn` (`.btn.ghost.full`) | Запуск симуляции |
| Сообщение | `#connect-msg` (`.msg`, `hidden`) | Ошибка/инфо-плашка под кнопками |

### Недавние хосты (`.recent`)

| Элемент | Селектор | Роль |
|---|---|---|
| `Недавние:` | `.recent-label` | Подпись |
| Список чипов | `#recent-list` | Хосты, по клику подставляются в `#ip-input` |
| Контейнер | `#recent-row` | Скрыт, если истории нет |

## 3. Поля ввода

### IP-адрес / хост (`#ip-input`)

- `type="text"`, `inputmode="decimal"`, `placeholder="192.168.1.60"`,
  `autocomplete="off"`, `spellcheck="false"`.
- При старте приложения, если есть история, в поле подставляется первый
  недавний хост, и поле получает фокус (`src/renderer/index.ts:16-20`).
- Enter в поле запускает подключение (`connect/index.ts:88-90`).

### Порт (`#port-input`)

- `type="number"`, `value="51326"`, `min="1"`, `max="65535"`,
  `title="TCP port (default 51326)"`.
- При подключении пустое/некорректное значение превращается в `undefined` —
  main-процесс подставляет порт по умолчанию `51326`
  (`connect/index.ts:35`, `connection.ts:51,127`).
- Enter в поле также запускает подключение (`connect/index.ts:91-93`).

## 4. Поток подключения

`doConnect()` (`src/renderer/connect/index.ts:33-61`):

1. Читает и `trim()`-ит хост, парсит порт.
2. **Валидация** `isValidHost(host)` (`utils.ts:92-100`): допускается либо
   корректный IPv4 (каждый октет 0–255), либо hostname
   (`[a-zA-Z0-9-]+` с точками). При ошибке — сообщение
   «Введите корректный IP-адрес или имя хоста.» и фокус на поле; подключение
   не начинается.
3. `setLoading(true)` — кнопка «Подключиться» блокируется, добавляется спиннер,
   подпись меняется на «Подключение…» (`utils.ts:113-127`).
4. `window.sq.connect(host, port)` → IPC `sq:connect` → `SQController.connect`.
5. При успехе:
   - `state.isDemoMode = false`;
   - `addRecent(host)` — хост попадает в историю;
   - `enterDashboard(version, spec, host)` — переход на дашборд;
   - `doRefresh()` — первичная загрузка снапшота.
6. При ошибке: `setLoading(false)` и красная плашка с текстом ошибки
   (от main-процесса или исключения).

### Сообщения об ошибках подключения

Тексты формируются в main-процессе (`main.ts:257-266`) и `connection.ts`:

| Ситуация | Текст |
|---|---|
| Пустой хост | `Empty host` |
| Порт закрыт / MixPad занял порт | `Connection refused by <host>:51326. Is the mixer online and MixPad disabled?` |
| Хост не найден | `Host not found: <host>` |
| Таймаут соединения | `Connection timed out: <host>` |
| Таймаут рукопожатия (10 с) | `Handshake timed out after 10000ms` |
| Прочее | текст ошибки `err.message` |
| Ошибка валидации (renderer) | `Введите корректный IP-адрес или имя хоста.` |

Сообщения выводятся через `setMessage(text, "error")` (класс `.msg.error`,
красный). `setMessage("")` скрывает плашку.

## 5. Поток демо-режима

`doStartDemo()` (`src/renderer/connect/index.ts:12-31`):

1. Защита от повторного запуска: флаг `demoStarting` + `demoBtn.disabled`.
2. `setMessage("", "")` — очистка предыдущей ошибки.
3. `window.sq.startDemo()` → `SQController.startDemo()`: поднимает
   симулированный SQ-5 (FW 1.9.4), наполняет модель шоу, запускает начальный
   burst снапшотов и поток метров.
4. При успехе: `state.isDemoMode = true`, `enterDashboard(..., "demo")`,
   `doRefresh()` (в демо-режиме `doRefresh` вызывает `demoRefresh()` —
   регенерацию нового варианта роутинга).
5. При ошибке: «Не удалось запустить демо.» или текст исключения.
6. `finally`: сброс `demoStarting` (кнопка разблокируется только после
   завершения попытки).

## 6. Недавние хосты

- Хранилище — `localStorage` под ключом `sq_recent_hosts` (`utils.ts:90`).
- `addRecent(host)` (`utils.ts:137-142`): хост переносится в начало списка,
  дубликаты удаляются, хранится максимум **6** записей.
- `renderRecent()` (`utils.ts:144-162`): рисует чипы; клик по чипу подставляет
  хост в `#ip-input` и ставит фокус (подключение не запускается автоматически).
- Если история пуста, `#recent-row` скрыт.
- Хост добавляется только при **успешном** реальном подключении; демо-режим
  (`"demo"`) в историю не пишется.

## 7. Рукопожатие с пультом

Полная последовательность кадров описана в
[`SQ-PROTOCOL.md`](SQ-PROTOCOL.md); кратко (`connection.ts:1-18`):

1. UDP-сокет биндится на случайный локальный порт — приложению нужен канал
   для потока уровней.
2. TCP-соединение на `<host>:51326` (порт настраивается), `setNoDelay(true)`.
3. Обмен: meter-sub → ack → version → state-ack → initial state → type
   negotiation → subscribe-all → дополнительные подписки → flood параметров.
4. Keepalive `sub=0x03` каждые ~1000 мс (`KEEPALIVE_INTERVAL_MS`).
5. Общий таймаут рукопожатия — **10 000 мс**
   (`connectTimeoutMs`, `connection.ts:129,181-184`).

Успешное рукопожатие резолвит `VersionInfo` (модель, `fwA`, `fwB`, `build`) —
именно эти данные показываются в шапке дашборда, а `modelSpec(model)`
определяет количество входов/выходов.

## 8. Отключение и разрыв связи

- **Ручное**: кнопка «Отключиться» (`#disconnect-btn` в топбаре дашборда) →
  `doDisconnect()` (`connect/index.ts:63-68`): `window.sq.disconnect()`, очистка
  поля IP, `showScreen("connect")`.
- **Неожиданный разрыв**: дашборд слушает `onStatus`; при `connected: false`
  и видимом дашборде показывается экран подключения и сообщение
  «Соединение с пультом разорвано.» (`dashboard/index.ts:38-51`).
- При закрытии окна / выходе из приложения main-процесс вызывает
  `controller.disconnect()` (`main.ts:1407-1414`).

## 9. Состояния экрана

| Состояние | `#connect-screen` | `#dash-screen` |
|---|---|---|
| Запуск приложения | видим | скрыт |
| Успешное подключение / демо | скрыт | видим |
| Ручное отключение | видим | скрыт |
| Неожиданный разрыв | видим (+ сообщение) | скрыт |

Переключение выполняет `showScreen()` (`utils.ts:164-167`).

## 10. Ключевые файлы

| Файл | Ответственность |
|---|---|
| `src/renderer/connect/view.html` | Разметка экрана подключения |
| `src/renderer/connect/index.ts` | `doConnect`, `doStartDemo`, `doDisconnect`, `doRefresh`, привязки клавиш |
| `src/renderer/core/utils.ts` | `isValidHost`, `setMessage`, `setLoading`, `getRecent`/`addRecent`/`renderRecent`, `showScreen` |
| `src/renderer/index.ts` | Старт: подстановка недавнего хоста, фокус |
| `src/renderer/dashboard/index.ts` | `enterDashboard`, обработка разрыва связи |
| `src/shared/ipc.ts` | `ConnectResult`, `VersionInfo`, `ModelSpec` |
| `src/main/preload.ts` | Мост `window.sq.connect` / `startDemo` / `disconnect` |
| `src/main/main.ts` | `SQController.connect`/`startDemo`, IPC `sq:connect` и др. |
| `src/main/transport/connection.ts` | TCP-рукопожатие, порт, таймауты, keepalive |
| `src/renderer/assets/styles.css` | Стили `.card`, `.ip-input`, `.msg`, `.recent-chip` и др. |

## 11. Ограничения

- Нет автообнаружения пультов (mDNS/скан сети) — хост вводится вручную.
- Нет автоматического переподключения при разрыве — только ручной возврат.
- Порт хранится не для каждого хоста, а как одно общее значение по умолчанию
  `51326`.
- Нет выбора локального сетевого интерфейса (в `ConnectOptions` есть
  `localInterface`, но UI его не предоставляет).
- Порт MIDI `51325` только упомянут в подсказке — приложение с ним не работает.
- Приложение одноэкземплярное (single-instance lock), вторая копия
  фокусирует уже открытое окно.
