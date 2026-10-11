"""
MODULE: metadata_loader.py
ROLE: Извлечение метаданных (схемы, таблицы, колонки) из DWH.
INPUT: dict конфигурации
OUTPUT: Словарь catalog с полным описанием структуры данных
DATA STRUCTURE: dict (catalog)
USED BY: generate_catalog.py
DEPENDENCIES: db.py, psycopg2.Error
"""

from decimal import Decimal

from psycopg2 import Error
from db import get_connection


def _format_column_type(col_type: str) -> str:
    """Приводит имена типов к привычному виду DBeaver."""
    if not col_type:
        return col_type
    if col_type == "character varying":
        return "varchar"
    if col_type.startswith("character varying("):
        return "varchar" + col_type[len("character varying"):]
    return col_type


def extract_metadata(config: dict) -> dict:
    catalog = {}
    target_schemas = config.get("schemas", [])

    for db in config["databases"]:
        print(f"Подключение к БД: {db}...")
        try:
            connection = get_connection(config, db)
            cursor = connection.cursor()
            db_data = {}

            if target_schemas:
                filter_nspname = "n.nspname = ANY(%s)"
                filter_schemaname = "schemaname = ANY(%s)"
                query_params = (target_schemas,)
            else:
                filter_nspname = "n.nspname NOT IN ('information_schema', 'pg_catalog')"
                filter_schemaname = "schemaname NOT IN ('information_schema', 'pg_catalog')"
                query_params = () 

            # 1. Таблицы и колонки
            cursor.execute(f"""
                SELECT n.nspname, c.relname, c.relkind, obj_description(c.oid),
                    a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
                    col_description(c.oid, a.attnum), a.attnotnull
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_attribute a ON a.attrelid = c.oid
                WHERE c.relkind IN ('r', 'v', 'm', 'p') 
                AND c.relname NOT IN ('pg_stat_statements', 'pg_stat_statements_info')
                AND {filter_nspname}
                AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY n.nspname, c.relname, a.attnum;
            """, query_params)
            
            for row in cursor.fetchall():
                schema, table, relkind, t_desc, col_name, col_type, col_desc, col_notnull = row
                if schema not in db_data: db_data[schema] = {}
                if table not in db_data[schema]:
                    db_data[schema][table] = {
                        "type": relkind, 
                        "description": t_desc, 
                        "columns": [], 
                        # Подготовка к Lineage
                        "lineage": {
                            "upstream": set(),
                            "downstream": set()
                        },
                        "column_lineage": {}
                    }
                db_data[schema][table]["columns"].append({
                    "name": col_name, 
                    "type": _format_column_type(col_type), 
                    "description": col_desc,
                    "notnull": col_notnull
                })

            # 2. Primary keys
            cursor.execute(f"""
                SELECT n.nspname, c.relname, con.conname,
                    array_agg(a.attname ORDER BY array_position(con.conkey, a.attnum))
                FROM pg_constraint con
                JOIN pg_class c ON c.oid = con.conrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
                WHERE con.contype = 'p'
                AND {filter_nspname}
                GROUP BY n.nspname, c.relname, con.conname;
            """, query_params)

            for row in cursor.fetchall():
                schema, table, con_name, pk_cols = row
                if schema in db_data and table in db_data[schema]:
                    db_data[schema][table]["primary_key"] = {
                        "constraint_name": con_name,
                        "columns": pk_cols
                    }

            # 2b. Unique constraints
            cursor.execute(f"""
                SELECT n.nspname, c.relname, con.conname,
                    array_agg(a.attname ORDER BY array_position(con.conkey, a.attnum))
                FROM pg_constraint con
                JOIN pg_class c ON c.oid = con.conrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
                WHERE con.contype = 'u'
                AND {filter_nspname}
                GROUP BY n.nspname, c.relname, con.conname;
            """, query_params)

            for row in cursor.fetchall():
                schema, table, con_name, u_cols = row
                if schema in db_data and table in db_data[schema]:
                    if "unique_constraints" not in db_data[schema][table]:
                        db_data[schema][table]["unique_constraints"] = []
                    db_data[schema][table]["unique_constraints"].append({
                        "constraint_name": con_name,
                        "columns": u_cols
                    })

            # 3. Indexes (исключаем автоматически созданные для PK и UNIQUE constraints)
            cursor.execute(f"""
                SELECT schemaname, tablename, indexname, indexdef
                FROM pg_indexes
                WHERE {filter_schemaname}
                AND indexname NOT IN (
                    SELECT conname FROM pg_constraint
                    WHERE contype IN ('p', 'u')
                )
                ORDER BY schemaname, tablename, indexname;
            """, query_params)

            for row in cursor.fetchall():
                schema, table, idx_name, idx_def = row
                if schema in db_data and table in db_data[schema]:
                    if "indexes" not in db_data[schema][table]:
                        db_data[schema][table]["indexes"] = []
                    db_data[schema][table]["indexes"].append(idx_def)

            catalog[db] = db_data
        except Error as e:
            print(f"Ошибка при работе с БД {db}: {e}")
        finally:
            if 'connection' in locals() and connection:
                cursor.close()
                connection.close()
    return catalog


def load_source_system_map(config: dict) -> dict:
    """
    Загружает справочник систем-источников из dds.core.ref_source_system.
    Возвращает словарь {prefix_lower -> system_name}.
    Таблица существует только в БД dds, поэтому подключаемся сразу к ней.
    """
    source_map = {}
    try:
        connection = get_connection(config, "dds")
        cursor = connection.cursor()
        cursor.execute("""
            SELECT system_prefix, system_name
            FROM core.ref_source_system
        """)
        for prefix, name in cursor.fetchall():
            if prefix:
                source_map[prefix.strip().lower()] = name.strip()
        cursor.close()
        connection.close()
        print(f"   - Загружено {len(source_map)} систем-источников из dds.core.ref_source_system")
    except Exception as e:
        print(f"   - Предупреждение: не удалось загрузить dds.core.ref_source_system: {e}")
    return source_map


def load_source_system_details(config: dict) -> dict:
    """
    Загружает справочник систем-источников из dds.core.ref_source_system.
    Возвращает словарь {prefix_lower -> {"system_name": ..., "system_id": ...}}.

    Используется для фичи генерации хэш-ID в Column Lineage (кнопка 🆔),
    в отличие от load_source_system_map, где берётся только system_name.
    Таблица существует только в БД dds, поэтому подключаемся сразу к ней.
    """
    source_map = {}
    try:
        connection = get_connection(config, "dds")
        cursor = connection.cursor()
        cursor.execute("""
            SELECT system_prefix, system_name, system_id
            FROM core.ref_source_system
        """)
        for prefix, name, system_id in cursor.fetchall():
            if prefix:
                entry = {"system_name": name.strip() if name else None}
                if system_id is not None:
                    # system_id может быть Decimal (numeric) — приводим к строке для JSON-сериализации
                    entry["system_id"] = str(system_id).strip() if isinstance(system_id, (Decimal, str)) else system_id
                else:
                    entry["system_id"] = None
                source_map[prefix.strip().lower()] = entry
        cursor.close()
        connection.close()
        print(f"   - Загружено {len(source_map)} деталей систем-источников из dds.core.ref_source_system")
    except Exception as e:
        print(f"   - Предупреждение: не удалось загрузить system_id из dds.core.ref_source_system: {e}")
    return source_map
