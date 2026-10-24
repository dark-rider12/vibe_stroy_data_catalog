# Скрипты инициализации тестового DWH (ODS -> DDS -> DM)

Данные скрипты разворачивают тестовое хранилище данных банковской тематики для проверки и демонстрации Data Catalog.

## Архитектура тестового DWH

* **3 физические базы данных PostgreSQL**:
  * `ods` — сырые данные (CRM, АБС, 1C). Схема `core` (17 таблиц с тестовыми данными).
  * `dds` — детальный слой. Читает `ods` через Foreign Data Wrapper (`postgres_fdw`, сервер `ods_server`, схема `ext_ods`). Схемы `core` (17 таблиц), `calc` (1 таблица).
  * `dm` — витрины данных. Читает `dds` через Foreign Data Wrapper (`postgres_fdw`, сервер `dds_server`, схемы `ext_dds`, `ext_calc`). Схема `core` (18 витрин).

* **Связь с генератором каталога**:
  В базах `dds` и `dm` создаётся служебная таблица `public.sql_inventory` и Event Trigger `capture_ddl_sql_trigger_public`, который автоматически перехватывает запросы создания таблиц и представлений (`CREATE TABLE AS`, `CREATE VIEW` и др.) и регистрирует их текст. Именно из `public.sql_inventory` скрипт `sql_loader.py` извлекает SQL-трансформации и строит автоматический Table & Column Lineage.

---

## Порядок развёртывания

### Шаг 0. Создание баз данных (в psql / DBeaver)

```sql
CREATE DATABASE ods;
CREATE DATABASE dds;
CREATE DATABASE dm;
```

---

### Шаг 1. Предварительная настройка sql_inventory и Event Trigger (БД `dds` и `dm`)

> [!IMPORTANT]
> Этот шаг выполняется **до** запуска скриптов наполнения таблиц. Создание Event Trigger требует прав суперпользователя (`postgres`).

Выполните скрипт `00_init_sql_inventory.sql` в базах `dds` и `dm`:
```bash
psql -U postgres -d dds -f 00_init_sql_inventory.sql
psql -U postgres -d dm  -f 00_init_sql_inventory.sql
```
* Создаёт служебную таблицу `public.sql_inventory`.
* Создаёт функцию `public.trg_capture_ddl_sql()`.
* Регистрирует Event Trigger `capture_ddl_sql_trigger_public` на событие `ddl_command_end` для автоматической записи всех последующих DDL-запросов.

---

### Шаг 2. Инициализация ODS (БД `ods`)

Запустите скрипт `01_init_ods.sql` в базе `ods`:
```bash
psql -U postgres -d ods -f 01_init_ods.sql
```
* Создаёт схему `core`.
* Создаёт 17 таблиц и наполняет их тестовыми данными.
* Навешивает комментарии на таблицы и колонки.

---

### Шаг 3. Инициализация DDS (БД `dds`)

1. Откройте `02_init_dds.sql` и при необходимости проверьте параметры подключения в блоке `CREATE SERVER ods_server` и `CREATE USER MAPPING` (по умолчанию `localhost:5432`, пользователь `postgres`, укажите ваш пароль в `YOUR_PASSWORD`).
2. Запустите скрипт в базе `dds`:
```bash
psql -U postgres -d dds -f 02_init_dds.sql
```
* Включает `postgres_fdw` и подключает `ods_server`.
* Импортирует таблицы из `ods.core` в `ext_ods`.
* Формирует детальный слой (`core.*`, `calc.*`).
* Навешивает комментарии.
* DDL-запросы создания автоматически перехватываются триггером в `public.sql_inventory`.

---

### Шаг 4. Инициализация DM (БД `dm`)

1. Откройте `03_init_dm.sql` и проверьте параметры подключения к серверу `dds_server`.
2. Запустите скрипт в базе `dm`:
```bash
psql -U postgres -d dm -f 03_init_dm.sql
```
* Включает `postgres_fdw` и подключает `dds_server`.
* Импортирует внешние таблицы из DDS (`ext_dds`, `ext_calc`).
* Формирует 18 витрин данных (`core.*`).
* Навешивает комментарии.
* DDL-запросы создания автоматически перехватываются триггером в `public.sql_inventory`.

---

### Шаг 5. Проверка генерации каталога

После выполнения скриптов вернитесь в корень проекта и запустите:
```bash
python generate_catalog.py
```
После завершения откройте `dist/index.html` в браузере.
