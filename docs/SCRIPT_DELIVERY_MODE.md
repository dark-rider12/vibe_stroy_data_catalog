# Режим поставки на Test (DDL + INSERT INTO) во вкладке «Скрипт»

## 1. Контекст и назначение

В процессе разработки аналитических хранилищ данных (DWH) аналитики и инженеры данных часто используют разные форматы скриптов на разных этапах жизненного цикла:

* **Dev-контур (разработка / прототипирование):**
  Аналитик пишет трансформацию единым запросом `CTAS` (`CREATE TABLE ... AS SELECT ...`) и добавляет обвес таблицы (первичные ключи, уникальные индексы, комментарии к таблице и колонкам, `ANALYZE`). Всё это отображается во вкладке **«Скрипт»** в режиме **Dev (CTAS)**.

* **Test / Stage / Prod-контуры (релизная поставка):**
  Для управляемой поставки в тестовый и продуктивный контуры требуется разделить процесс на два изолированных шага:
  1. **DDL-миграция**: сначала создаётся пустая таблица с точными типами данных и полным обвесом (`CREATE TABLE ...` + `ALTER TABLE ... ADD CONSTRAINT` + `COMMENT ON ...` + `CREATE INDEX` + `ANALYZE`).
  2. **DML-загрузка (ETL/ELT)**: данные заливаются отдельной операцией `INSERT INTO <table> (<список_полей>) SELECT ...`.

Функциональность **режима поставки** автоматически преобразует аналитический CTAS в готовый комплект для поставки на Test без необходимости ручного переписывания SQL.

---

## 2. Пользовательский интерфейс (UI)

Во вкладке **«Скрипт»** для таблиц (режим скрыт для `VIEW` и системных представлений) на верхней панели справа от кнопки «Копировать скрипт» размещён сегментный переключатель:

```text
[ Копировать скрипт ]                    [ Dev (CTAS) | Test (DDL + INSERT) ]
```

### 2.1. Режим Dev (CTAS) — по умолчанию
* Отображает единый исходный SQL-скрипт трансформации из `public.sql_inventory` с блоком системных метаданных (обвесом).
* Кнопка **«Копировать скрипт»** копирует только этот исходный CTAS-скрипт.

### 2.2. Режим Test (DDL + INSERT)
При нажатии на `Test (DDL + INSERT)` скрипт переключается в представление из двух независимых окон:

1. **Окно 1: `DDL: CREATE TABLE`**
   * Заголовок: `[DDL] 1. Создание таблицы и обвеса (CREATE TABLE)`
   * Кнопка: `Копировать DDL` (копирует строго содержимое первого окна).
   * Содержимое:
     * Оператор `CREATE TABLE <имя> (...)` с именами и типами колонок из схемы БД.
     * Полный обвес: первичные ключи (`PRIMARY KEY`), уникальные ограничения (`UNIQUE`), ограничения `NOT NULL`, комментарии к таблице и колонкам (`COMMENT ON`), индексы (`CREATE INDEX`) и сбор статистики (`ANALYZE`).

2. **Окно 2: `DML: INSERT INTO`**
   * Заголовок: `[DML] 2. Загрузка данных (INSERT INTO)`
   * Кнопка: `Копировать INSERT` (копирует строго содержимое второго окна).
   * Содержимое:
     * Оператор `INSERT INTO <имя> (<явный перечень полей через запятую>)`.
     * Тело запроса `SELECT ...` или `WITH ... SELECT ...`, извлечённое из оригинального CTAS.

---

## 3. Алгоритм трансформации SQL

Трансформация выполняется модулем [`src/utils/scriptTransform.js`](file:///c:/test/generate_catalog_gemini/src/utils/scriptTransform.js):

1. **Парсинг CTAS:**
   Регулярное выражение с флагами `gi` находит конструкцию:
   ```regex
   ^([\s\S]*?create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?table\s+([^\s(]+)\s+as\s*\(?)([\s\S]*)$
   ```
   * Сохраняются префиксы и комментарии перед запросом.
   * Извлекается целевое имя таблицы (например, `dds.core.account_balance_detail`).
   * Извлекается тело запроса, очищаются внешние круглые скобки `( ... )` и замыкающие точки с запятой `;`.

2. **Генерация DDL:**
   * Из метаданных `tableInfo.columns` генерируется список столбцов с типами данных:
     ```sql
     CREATE TABLE dds.core.account_balance_detail (
         balance_id bigint,
         account_id bigint,
         balance_date date,
         balance_amt numeric(18,2),
         available_amt numeric(18,2),
         currency_cd text,
         source_system text,
         load_dttm timestamp without time zone
     );
     ```
   * К определению таблицы добавляется `tableInfo.sql_script_extra` (обвес).

3. **Генерация DML:**
   * Формируется список полей в явном виде:
     ```sql
     INSERT INTO dds.core.account_balance_detail (
         balance_id,
         account_id,
         balance_date,
         ...
     )
     SELECT
         balance_id,
         account_id,
         ...
     FROM dds.ext_ods.abs_account_balance_history;
     ```

---

## 4. Архитектура и файлы

| Файл | Назначение |
|---|---|
| [`src/utils/scriptTransform.js`](file:///c:/test/generate_catalog_gemini/src/utils/scriptTransform.js) | Логика трансформации CTAS в DDL и DML, переключение DOM-контейнеров |
| [`src/utils/helpers.js`](file:///c:/test/generate_catalog_gemini/src/utils/helpers.js) | Таргетированное копирование кода `copyScriptContent`, нумерация строк `initScriptLineNumbers`, подсветка слов `initScriptWordHighlight` |
| [`templates/table.html`](file:///c:/test/generate_catalog_gemini/templates/table.html) | Разметка переключателя режимов и контейнера двух окон в Jinja2-шаблоне |
| [`static/style.css`](file:///c:/test/generate_catalog_gemini/static/style.css) | Стили переключателя `.script-mode-switch` и окон `.test-script-window` |
| [`src/index.js`](file:///c:/test/generate_catalog_gemini/src/index.js) | Экспорт `switchScriptMode` в `window` |

---

## 5. Особенности и гарантии

1. **Ленивый рендеринг (Zero Overhead):**
   Окна DDL и INSERT генерируются в памяти только при первом клике на `Test (DDL + INSERT)`. Статический HTML-каталог не раздувается дублирующимися текстами скриптов.
2. **Точное копирование:**
   Кнопка «Копировать скрипт» в режиме Dev гарантированно копирует только CTAS. Каждое окно в режиме Test имеет собственную кнопку копирования.
3. **Единый стиль каталога:**
   Оба окна оформления сохраняют нумерацию строк в стиле DBeaver, подсветку комментариев и выделение повторяющихся слов по двойному клику.
