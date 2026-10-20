"""
MODULE: sql_loader.py
ROLE: Загрузка SQL-кода из надежных источников для анализа lineage и отображения скриптов.
INPUT: Подключение к БД
OUTPUT: list[dict] с SQL запросами
DATA STRUCTURE: [{"source": ..., "target_schema": ..., "target_table": ..., "query": ...}]
USED BY: generate_catalog.py
DEPENDENCIES: db.py

Источники:
  - public.sql_inventory в БД dds и dm (скрипты трансформаций CTAS/INSERT)
  - pg_views в каждой из трёх баз (ods, dds, dm) — системные вьюхи

Нормализация foreign tables (двухуровневая):
  Postgres не поддерживает кросс-базные запросы, поэтому сделаны foreign tables.

  Уровень 1 — жёсткий маппинг (приоритет, существующие схемы):
    ext_ods.*  → ods.core.*
    ext_dds.*  → dds.core.*
    ext_calc.* → dds.calc.*

  Уровень 2 — динамический fallback (для новых/нестандартных схем):
    Если ext_X не попал в жёсткий маппинг:
      ext_X.table → [бд_на_слой_ниже].X.table
    Иерархия слоёв: dm → dds → ods
    Примеры (скрипт в dm):
      ext_staging.orders → dds.staging.orders
    Примеры (скрипт в dds):
      ext_landing.customers → ods.landing.customers

  Если имя таблицы начинается с v_ — объект трактуется как view (type hint, не влияет на SQL).
"""

import re
from db import get_connection


# Базы данных, в которых есть public.sql_inventory
_SQL_INVENTORY_DBS = ["dds", "dm"]

# Базы данных, из которых берём pg_views
_PG_VIEWS_DBS = ["ods", "dds", "dm"]

# Схемы views, которые нас интересуют в каждой базе
_VIEWS_SCHEMAS = ["core", "ods", "dds", "dm"]

# Маппинг foreign-table схем → реальные (db, schema)
# ext_ods → ods.core,  ext_dds → dds.core,  ext_calc → dds.calc
_FOREIGN_SCHEMA_MAP = {
    "ext_ods":  ("ods", "core"),
    "ext_dds":  ("dds", "core"),
    "ext_calc": ("dds", "calc"),
}

# Иерархия слоёв для динамического fallback: db → бд на слой ниже
_LAYER_BELOW = {
    "dm":  "dds",
    "dds": "ods",
}

# Системные команды создания/удаления расширений (не являются трансформациями данных)
_IS_PURE_EXTENSION_REGEX = re.compile(
    r'^\s*(?:--[^\n]*\s*)*(?:CREATE|DROP)\s+EXTENSION\b[^;]*(?:;|\s*)*$',
    re.IGNORECASE
)

_EXTENSION_STMT_REGEX = re.compile(
    r'(?:^|;)\s*(?:--[^\n]*\s*)*(?:CREATE|DROP)\s+EXTENSION\b[^;]*(?:;|\s*)*',
    re.IGNORECASE
)


def _normalize_foreign_tables(sql: str, db_name: str = "") -> str:
    """
    Заменяет ссылки на foreign tables в тексте SQL на реальные таблицы.

    Уровень 1 — жёсткий маппинг (приоритет):
      ext_ods.table_name       →  ods.core.table_name
      db.ext_ods.table_name    →  ods.core.table_name  (с явным db-префиксом)
      ext_dds.table_name       →  dds.core.table_name
      ext_calc.table_name      →  dds.calc.table_name

    Уровень 2 — динамический fallback для неизвестных ext_* схем:
      Если ext_X не совпал с жёстким маппингом, применяется правило:
        ext_X.table → [слой_ниже_db_name].X.table
      Иерархия: dm → dds → ods
      Применяется только если db_name передан и входит в _LAYER_BELOW.
    """
    # Уровень 1: жёсткий маппинг
    for foreign_schema, (real_db, real_schema) in _FOREIGN_SCHEMA_MAP.items():
        replacement = f'{real_db}.{real_schema}.'

        # Вариант A: ext_schema.table (без db-префикса)
        pattern_a = re.compile(
            rf'(?<![.\w]){re.escape(foreign_schema)}\.',
            re.IGNORECASE
        )
        sql = pattern_a.sub(replacement, sql)

        # Вариант B: db.ext_schema.table (с явным db-префиксом, напр. dds.ext_ods.table)
        # Lookbehind не позволяет захватить ext_schema в этом случае через паттерн A,
        # поэтому явно матчим «\w+.ext_schema.» и заменяем всё целиком.
        pattern_b = re.compile(
            rf'(?<![.\w])\w+\.{re.escape(foreign_schema)}\.',
            re.IGNORECASE
        )
        sql = pattern_b.sub(replacement, sql)

    # Уровень 2: динамический fallback для оставшихся ext_* схем
    lower_db = _LAYER_BELOW.get(db_name, "")
    if lower_db:
        # Вариант A: ext_X.table
        fallback_pattern_a = re.compile(
            r'(?<![.\w])ext_(\w+)\.',
            re.IGNORECASE
        )
        sql = fallback_pattern_a.sub(
            lambda m: f'{lower_db}.{m.group(1)}.',
            sql
        )

        # Вариант B: db.ext_X.table (с явным db-префиксом)
        fallback_pattern_b = re.compile(
            r'(?<![.\w])\w+\.ext_(\w+)\.',
            re.IGNORECASE
        )
        sql = fallback_pattern_b.sub(
            lambda m: f'{lower_db}.{m.group(1)}.',
            sql
        )

    return sql


def load_sql_transformations(config: dict) -> list[dict]:
    """
    Загружает скрипты трансформации данных из двух источников:
      1. public.sql_inventory — из баз dds и dm
      2. pg_views             — из баз ods, dds, dm

    В обоих случаях ссылки на foreign tables нормализуются:
      ext_ods.* → ods.core.*
      ext_dds.* → dds.core.*
    """
    results = []

    # ── 1. public.sql_inventory ────────────────────────────────────────────────
    for db_name in _SQL_INVENTORY_DBS:
        if db_name not in config.get("databases", []):
            continue
        conn = None
        try:
            conn = get_connection(config, db_name)
            cursor = conn.cursor()
            cursor.execute("""
                SELECT target_schema, target_table, query_text, updated_at
                FROM public.sql_inventory
            """)
            rows = cursor.fetchall()
            print(f"   - [sql_inventory/{db_name}] Загружено {len(rows)} запросов")
            for row in rows:
                target_schema = row[0]
                target_table  = row[1]
                raw_query     = row[2] or ""
                updated_at    = row[3]
                # Пропускаем чисто системные команды (CREATE/DROP EXTENSION), не создающие таблицы DWH
                if _IS_PURE_EXTENSION_REGEX.match(raw_query):
                    continue
                query         = _normalize_foreign_tables(raw_query, db_name)
                # Если в комплексном скрипте есть преамбула EXTENSION, отсекаем её из query для lineage
                if "EXTENSION" in query.upper():
                    query = _EXTENSION_STMT_REGEX.sub(';', query).strip(' ;\n\r\t')
                    if not query:
                        continue
                results.append({
                    "source":        "public.sql_inventory",
                    "db_name":       db_name,
                    "target_schema": target_schema,
                    "target_table":  target_table,
                    "query":         query,
                    "raw_query":     raw_query,
                    "updated_at":    updated_at,
                })
        except Exception as e:
            print(f"   - [Warning] sql_inventory в БД '{db_name}': {e}")
        finally:
            if conn:
                conn.close()

    # ── 2. pg_views ────────────────────────────────────────────────────────────
    for db_name in _PG_VIEWS_DBS:
        if db_name not in config.get("databases", []):
            continue
        conn = None
        try:
            conn = get_connection(config, db_name)
            cursor = conn.cursor()
            # Формируем строку вида  'core','ods','dds','dm'
            schemas_literal = ",".join(f"'{s}'" for s in _VIEWS_SCHEMAS)
            cursor.execute(f"""
                SELECT schemaname, viewname,
                       'CREATE OR REPLACE VIEW ' || schemaname || '.' || viewname
                       || ' AS ' || definition AS full_sql
                FROM pg_views
                WHERE schemaname IN ({schemas_literal})
            """)
            rows = cursor.fetchall()
            print(f"   - [pg_views/{db_name}] Загружено {len(rows)} вьюх")
            for row in rows:
                schema_name = row[0]
                view_name   = row[1]
                raw_sql     = row[2] or ""
                full_sql    = _normalize_foreign_tables(raw_sql, db_name)
                results.append({
                    "source":        "pg_views",
                    "db_name":       db_name,
                    "target_schema": schema_name,
                    "target_table":  view_name,
                    "query":         full_sql,
                    "raw_query":     raw_sql,
                })
        except Exception as e:
            print(f"   - [Warning] pg_views в БД '{db_name}': {e}")
        finally:
            if conn:
                conn.close()

    print(f"   - Итого загружено SQL-записей: {len(results)}")
    return results
