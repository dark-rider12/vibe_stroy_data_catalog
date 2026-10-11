# BROWSER_GUIDE.md — Инструкция по быстрой работе с браузером и Table Lineage

Инструкция для агента при работе с веб-интерфейсом каталога через `browser_subagent`.

> **ВАЖНО (Тестирование геометрии Lineage):** Для проверки геометрии layout, высот портов, транзитных цепочек и отсутствия микроизломов связей запускать браузер **НЕ ТРЕБУЕТСЯ**. Первичная и рекомендуемая проверка выполняется за миллисекунды через быстрый Node.js раннер `npm test` (см. [`LINEAGE_TESTING_GUIDE.md`](LINEAGE_TESTING_GUIDE.md)). Браузер используется только для финальной визуальной оценки стилей и проверки интерактивности (pan/zoom, клики).

---

## 1. Прямой переход к таблице (Direct Hash URL)

В проекте используется клиентский роутинг по хэшу URL ([`src/routing/navigation.js`](file:///c:/test/generate_catalog_gemini/src/routing/navigation.js)).
При открытии хэша таблица автоматически достается из `<template id="tpl-{targetId}">` и монтируется в DOM.

### Шаблон URL:
```text
file:///c:/test/generate_catalog_gemini/dist/index.html#{database}-{schema}-{table_name}[:tab]
```

### Примеры прямого открытия вкладки Lineage (БЕЗ кликов и БЕЗ вызова DOM):
- **DDS**: `file:///c:/test/generate_catalog_gemini/dist/index.html#dds-core-card_detail:lineage`
- **DM**: `file:///c:/test/generate_catalog_gemini/dist/index.html#dm-core-account_activity:lineage`
- **ODS**: `file:///c:/test/generate_catalog_gemini/dist/index.html#ods-core-abs_account:lineage`
- **DDS Calc**: `file:///c:/test/generate_catalog_gemini/dist/index.html#dds-calc-account_card_contract:lineage`

> **ГЛАВНОЕ ПРАВИЛО:** Добавляйте суффикс `:lineage` к хэшу! Таблица смонтируется и вкладка **Lineage активируется автоматически при открытии страницы**. 
> **НЕЛЬЗЯ** вызывать `browser_get_dom` и кликать по пикселям для переключения вкладки!

---

## 2. Открытие вкладки Lineage

Если в URL указан суффикс `:lineage`, переключение выполняется **автоматически** кодом роутинга [`src/routing/navigation.js`](file:///c:/test/generate_catalog_gemini/src/routing/navigation.js).

После загрузки страницы:
- Достаточно подождать 1.5–2 секунды (асинхронный Sugiyama layout через `requestIdleCallback`).
- Сразу снимать `capture_browser_console_logs` или делать `capture_browser_screenshot`.
- **Никаких вызовов `browser_get_dom` и пиксельных кликов делать НЕ нужно.**

---

## 3. Структура DOM и селекторы (Не запрашивать весь DOM без необходимости)

Структура страницы стабильна. Вместо тяжелого `browser_get_dom`:

### Узлы и элементы Lineage:
- **Контейнер графа**: `#lineage-container-{targetId}`
- **Холст**: `.ln-canvas` (`#lineage-canvas-{targetId}`)
- **SVG со связями**: `.ln-svg` (`#lineage-svg-{targetId}`)
- **Узлы (Nodes)**: `.ln-node`
  - Выбранный центральный узел: `.ln-node.is-selected`
  - Формат ID узла: `lnode-{src_db}_{src_schema}_{src_table}-{target_db}-{target_schema}-{target_table}`
    *(например: `lnode-dds_core_account_detail-dds-core-account_detail`)*
  - Цветовые классы слоев: `.ln-core-ods`, `.ln-core-dds`, `.ln-core-dm`, `.ln-system-1`
- **Связи (Edges)**: `<path class="ln-edge">`
  - Подсвеченные связи: `.ln-edge.is-highlighted`
  - Стрелки маркеров: `marker-end="url(#ln-arrow)"`
- **Тулбар управления**: `.ln-toolbar`
  - Кнопки зума: `.ln-tool-btn` (тексты: `−`, `+`, `⛶` / Вписать экран)

---

## 4. Памятка для формирования задач `browser_subagent`

При запуске сабагента указывать в Task конкретный компактный план:
1. Открыть прямой URL с суффиксом `:lineage` и сбросом кэша: `file:///c:/test/generate_catalog_gemini/dist/index.html?t=1#{targetId}:lineage`.
2. Подождать 2 секунды (`wait`). Вкладка Lineage активируется и отрендерится **автоматически**.
3. Снять логи `capture_browser_console_logs` (для анализа изломов `[Lineage:Bend]` и сдвигов `[Lineage:Shift:*]`) или сделать скриншот `capture_browser_screenshot`.
4. **СТРОГО ЗАПРЕЩЕНО:** вызывать `browser_get_dom`, искать элементы и кликать по пикселям для перехода на Lineage — переход уже выполнен по URL.

---

## 5. Когда обновлять эту инструкцию
- При изменении структуры шаблона [`templates/table.html`](file:///c:/test/generate_catalog_gemini/templates/table.html) (классы вкладок, структура панелей).
- При изменении роутинга [`src/routing/navigation.js`](file:///c:/test/generate_catalog_gemini/src/routing/navigation.js).
- При изменении стилей и DOM-структуры графа в [`src/lineage/tableLineage.js`](file:///c:/test/generate_catalog_gemini/src/lineage/tableLineage.js).

---

## 6. Работа с отладочным кодом (Console & `window.__LINEAGE_DEBUG__`)

Для выявления причин изломов связей и блокировок выравнивания в [`src/lineage/tableLineageDebug.js`](file:///c:/test/generate_catalog_gemini/src/lineage/tableLineageDebug.js) встроен автоматический отладочный трекер.

### Сброс кэша браузера при тестах
При пересборке JS (`npm run build:js`) открытая сессия браузера может кэшировать бандл. Чтобы гарантированно применить обновленный код, передавайте query-параметр:
```text
file:///c:/test/generate_catalog_gemini/dist/index.html?t=1#{targetId}
```

### Формат логов в консоли
Все события тегируются и легко фильтруются через инструмент `capture_browser_console_logs`:

1. **Изломы рёбер (`[Lineage:Bend]`)**:
   ```text
   [warning] [Lineage:Bend] ods.core.abs_account_balance_history -> dds.core.account_balance_detail (delta=66px, type=large-bend, sY=121, eY=187)
   ```
   - `delta`: смещение по вертикали между портом выхода и входа (`eY - sY`).
   - `type`: `micro-bend` ($|\Delta| < 15\text{px}$) или `large-bend` ($|\Delta| \ge 15\text{px}$).
   - `sY`, `eY`: физические высоты портов источника и цели.

2. **Сдвиги карточек (`[Lineage:Shift:*]`)**:
   ```text
   [log] [Lineage:Shift:Rule18:FanOutTarget] lnode-... delta=-66px ✗ BLOCKED (above neighbor gap < 4px)
   [log] [Lineage:Shift:Rule18:FanOutSourceFallback] lnode-... delta=66px ✓ APPLIED
   ```
   - Показывает, какое правило пыталось сдвинуть узел (`Phase2.1`, `Rule2.3`, `Rule18`), величину дельты, и если сдвиг заблокирован — точную причину (например, нарушение минимального зазора к соседу сверху/снизу).

### Программный доступ к данным отладки
Вся отладочная информация сохраняется в:
- `window.__LINEAGE_DEBUG__.bends` — массив всех непрямых связей с дельтами.
- `window.__LINEAGE_DEBUG__.shifts` — журнал всех попыток сдвига карточек с результатами.
- `window.__LINEAGE_DEBUG__.edges` — координаты всех связей графа.
- В DOM: `<script id="lineage-debug-data-{targetId}" type="application/json">`.

### Памятка для агента при отладке Table Lineage
1. Открыть URL с `?t=timestamp` и хэшем таблицы.
2. Кликнуть вкладку `Lineage` и подождать 2 секунды.
3. Вызвать `capture_browser_console_logs`.
4. По строкам `[Lineage:Bend]` сразу определить точные дельты изломов (не гадая по скриншоту).
5. По строкам `[Lineage:Shift:*]` сразу понять, какое правило вызвало нежелательный сдвиг или почему нужное выравнивание заблокировалось.

