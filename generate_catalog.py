"""
MODULE: generate_catalog.py
ROLE: Главный entry point. Оркестрирует загрузку метаданных, lineage и рендер сайта.
INPUT: Вызов из CLI
OUTPUT: Статический каталог данных
DATA STRUCTURE: None
USED BY: User (CLI)
DEPENDENCIES: config, metadata_loader, sql_loader, table_lineage, column_lineage, site_builder
"""

import sys
import subprocess
from config import load_config
from metadata_loader import extract_metadata, load_source_system_map, load_source_system_details
from sql_loader import load_sql_transformations
from lineage.table_lineage import compute_table_lineage
from lineage.column_lineage import compute_column_lineage, compute_column_sources
from site_builder import generate_html

# Настройка кодировки для Windows-консолей
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')


import re

def _ensure_db_in_create_statement(script: str, db_name: str) -> str:
    """
    Если в первом CREATE TABLE/VIEW указано только schema.table (без db_name) —
    добавляет db_name в начало. Если уже три компонента (db.schema.table) — не трогает.
    Обрабатывает CREATE TABLE, CREATE VIEW, CREATE OR REPLACE VIEW,
    SELECT ... INTO schema.table.
    """
    # CREATE TABLE / CREATE [OR REPLACE] VIEW + [IF NOT EXISTS] + table_name
    def _fix_create(m):
        kw = m.group(1)          # ключевые слова (CREATE TABLE ...)
        name = m.group(2)        # имя таблицы/вью
        parts = name.split('.')
        if len(parts) == 2:      # schema.table → db.schema.table
            return kw + db_name + '.' + name
        return m.group(0)        # уже db.schema.table — оставляем

    script = re.sub(
        r'(CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?)'  # ключевые слова
        r'([\w.]+)',             # имя таблицы
        _fix_create,
        script,
        count=1,
        flags=re.IGNORECASE
    )

    # SELECT ... INTO schema.table
    def _fix_into(m):
        pre = m.group(1)         # всё до имени таблицы
        name = m.group(2)
        parts = name.split('.')
        if len(parts) == 2:
            return pre + db_name + '.' + name
        return m.group(0)

    script = re.sub(
        r'(\bINTO\s+)([\w.]+)',
        _fix_into,
        script,
        count=1,
        flags=re.IGNORECASE
    )

    return script


# Маппинг foreign-schema → база данных, в которой она существует
# (нужен чтобы добавлять db-префикс к ext_dds.table → dm.ext_dds.table)
_FOREIGN_SCHEMA_DB = {
    "ext_ods":  "dds",   # ext_ods живёт в базе dds
    "ext_dds":  "dm",    # ext_dds живёт в базе dm
    "ext_calc": "dm",    # ext_calc живёт в базе dm
}


def _add_db_to_foreign_schemas(script: str) -> str:
    """
    В тексте скрипта добавляет db-префикс перед foreign-схемами:
      ext_dds.table_name  →  dm.ext_dds.table_name
      ext_ods.table_name  →  dds.ext_ods.table_name
      ext_calc.table_name →  dm.ext_calc.table_name
    Если префикс уже есть (три компонента) — не трогает.
    """
    for foreign_schema, db_prefix in _FOREIGN_SCHEMA_DB.items():
        pattern = re.compile(
            rf'(?<![.\w]){re.escape(foreign_schema)}\.',
            re.IGNORECASE
        )
        script = pattern.sub(f'{db_prefix}.{foreign_schema}.', script)
    return script


def attach_sql_scripts(catalog: dict, sql_transformations: list[dict]) -> dict:
    """Добавляет к таблицам скрипты из public.sql_inventory для отображения в UI."""
    lookup = {}
    # Маппинг schema → db_name (для всех схем в каталоге)
    schema_to_db: dict[str, str] = {}
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName":
            continue
        for schema_name, tables in schemas.items():
            schema_to_db[schema_name.lower()] = db_name
            for table_name in tables.keys():
                # Ключ: (db, schema, table) — точное совпадение
                lookup[(db_name.lower(), schema_name.lower(), table_name.lower())] = (db_name, schema_name, table_name)
                # Ключ: (schema, table) — для обратной совместимости, если db_name в item отсутствует
                lookup[(schema_name.lower(), table_name.lower())] = (db_name, schema_name, table_name)

    def _add_db_prefix_all(script: str, current_db: str = "") -> str:
        """
        Добавляет db-префикс к КАЖДОЙ ссылке schema.table в FROM/JOIN,
        если schema известна в каталоге и у неё ещё нет db-префикса.
        Три компонента (db.schema.table) — не трогает.
        current_db — база данных объекта-владельца скрипта; при совпадении
        схемы сначала проверяем именно её, чтобы не добавить чужой db-префикс
        когда одна схема (например core) существует в нескольких БД.
        """
        def replacer(m):
            keyword = m.group(1)   # FROM / (LEFT|RIGHT|INNER|FULL|CROSS) JOIN / etc.
            name    = m.group(2)   # schema.table или db.schema.table
            alias   = m.group(3)   # остаток (пробел + алиас или пусто)
            parts   = name.split('.')
            if len(parts) == 2:
                schema_lc = parts[0].lower()
                table_lc  = parts[1].lower()
                # Сначала проверяем: есть ли эта таблица в текущей БД скрипта
                if current_db and (current_db.lower(), schema_lc, table_lc) in lookup:
                    return f"{keyword}{current_db}.{name}{alias}"
                # Fallback: используем schema_to_db (для foreign-схем и т.д.)
                db = schema_to_db.get(schema_lc)
                if db:
                    return f"{keyword}{db}.{name}{alias}"
            return m.group(0)

        # Ищем FROM/JOIN + имя (2 или 3 компонента)
        pattern = re.compile(
            r'(\b(?:FROM|JOIN)\s+)'          # ключевое слово
            r'([\w]+\.[\w.]+)'               # schema.table или db.schema.table
            r'(\b)',                          # граница слова / пробел после имени
            re.IGNORECASE
        )
        return pattern.sub(replacer, script)

    attached_count = 0
    for item in sql_transformations:
        if item.get("source") != "public.sql_inventory":
            continue

        item_db     = (item.get("db_name")       or "").lower()
        target_schema = (item.get("target_schema") or "").lower()
        target_table  = (item.get("target_table")  or "").lower()
        query = item.get("query") or ""
        if not target_schema or not target_table or not query:
            continue

        # Сначала ищем точно по (db, schema, table), затем fallback на (schema, table)
        target = lookup.get((item_db, target_schema, target_table))
        if not target:
            target = lookup.get((target_schema, target_table))
        if not target:
            continue

        db_name, schema_name, table_name = target
        # Для вкладки "Скрипт" берём оригинальный текст (без замены foreign tables).
        # Так скрипт можно запустить в Postgres — ext_dds.table остаётся ext_dds.table.
        # Для lineage-анализа используется item["query"] с нормализованными именами.
        raw = (item.get("raw_query") or item.get("query") or "").rstrip()
        script = raw
        # Убираем ведущие закомментированные строки (-- ...) и пустые строки в начале скрипта.
        # Они выглядят как мусор во вкладке "Скрипт" — рабочий код должен идти первым.
        script_lines = script.splitlines()
        while script_lines:
            if re.match(r'^\s*(--|$)', script_lines[0]):
                script_lines.pop(0)
            else:
                break
        script = '\n'.join(script_lines).rstrip()
        if not script.endswith(';'):
            script += ';'

        # Добавляем db-префикс ко всем schema.table в FROM/JOIN
        # Передаём db_name скрипта, чтобы схемы, общие для нескольких БД (напр. core),
        # резолвились в текущую БД, а не в ту, что оказалась последней в schema_to_db.
        script = _add_db_prefix_all(script, current_db=db_name)
        script = _ensure_db_in_create_statement(script, db_name)
        script = _add_db_to_foreign_schemas(script)
        # Store the processed script
        catalog[db_name][schema_name][table_name]["sql_script"] = script

        # Сохраняем дату обновления скрипта из public.sql_inventory
        updated_at = item.get("updated_at")
        if updated_at is not None:
            # datetime → строка "DD.MM.YYYY"
            try:
                dt_str = updated_at.strftime("%d.%m.%Y %H:%M:%S")
            except AttributeError:
                dt_str = str(updated_at)[:19]  # fallback для строк ISO
            catalog[db_name][schema_name][table_name]["script_updated_at"] = dt_str

        attached_count += 1

    # Формируем дополнительные блоки (NOT NULL + COMMENT) для каждой таблицы
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName":
            continue
        for schema_name, tables in schemas.items():
            for table_name, table_info in tables.items():
                has_original_script = bool(table_info.get("sql_script"))
                extra_parts = []

                # Блок ALTER TABLE ... ADD CONSTRAINT ... PRIMARY KEY
                pk = table_info.get("primary_key")
                pk_col_names = {c.strip().lower() for c in pk["columns"]} if (pk and pk.get("columns")) else set()
                if pk and pk.get("columns"):
                    cols = ", ".join(pk["columns"])
                    con_name = pk["constraint_name"]
                    pk_block = (
                        f"ALTER TABLE {db_name}.{schema_name}.{table_name}\n"
                        f"    ADD CONSTRAINT {con_name} PRIMARY KEY ({cols});"
                    )
                    extra_parts.append(pk_block)

                # Блок ALTER TABLE ... ADD CONSTRAINT ... UNIQUE
                u_cons = table_info.get("unique_constraints", [])
                for u_con in u_cons:
                    con_name = u_con.get("constraint_name")
                    if con_name and u_con.get("columns"):
                        cols = ", ".join(u_con["columns"])
                        uq_block = (
                            f"ALTER TABLE {db_name}.{schema_name}.{table_name}\n"
                            f"    ADD CONSTRAINT {con_name} UNIQUE ({cols});"
                        )
                        extra_parts.append(uq_block)

                # Блок ALTER TABLE ... SET NOT NULL (исключаем колонки, входящие в PRIMARY KEY)
                notnull_cols = [
                    c for c in table_info.get("columns", [])
                    if c.get("notnull") and c.get("name", "").strip().lower() not in pk_col_names
                ]
                if notnull_cols:
                    lines = [f"ALTER TABLE {db_name}.{schema_name}.{table_name}"]
                    for i, col in enumerate(notnull_cols):
                        suffix = "," if i < len(notnull_cols) - 1 else ";"
                        lines.append(f"    ALTER COLUMN {col['name']} SET NOT NULL{suffix}")
                    extra_parts.append("\n".join(lines))

                # Блок COMMENT ON TABLE / VIEW / MATERIALIZED VIEW / COMMENT ON COLUMN
                comment_lines = []
                if table_info.get("description"):
                    escaped = table_info["description"].replace("'", "''")
                    if table_info.get("type") == "v":
                        obj_keyword = "VIEW"
                    elif table_info.get("type") == "m":
                        obj_keyword = "MATERIALIZED VIEW"
                    else:
                        obj_keyword = "TABLE"
                    comment_lines.append(f"COMMENT ON {obj_keyword} {db_name}.{schema_name}.{table_name} IS '{escaped}';")
                col_comments = []
                for col in table_info.get("columns", []):
                    if col.get("description"):
                        escaped = col["description"].replace("'", "''")
                        col_comments.append(f"COMMENT ON COLUMN {db_name}.{schema_name}.{table_name}.{col['name']} IS '{escaped}';")
                if comment_lines and col_comments:
                    comment_lines.append("")  # пустая строка между COMMENT ON объектом и COMMENT ON COLUMN
                comment_lines.extend(col_comments)
                if comment_lines:
                    extra_parts.append("\n".join(comment_lines))

                # Блок CREATE INDEX
                indexes = table_info.get("indexes", [])
                if indexes:
                    extra_parts.append("\n".join(idx + ";" if not idx.rstrip().endswith(";") else idx for idx in indexes))

                # Блок ANALYZE
                if table_info.get("type") != "v":
                    extra_parts.append(f"ANALYZE {db_name}.{schema_name}.{table_name};")

                if extra_parts:
                    if not has_original_script:
                        table_info["sql_script_extra"] = "\n\n\n".join(extra_parts)
                        table_info["is_metadata_ddl"] = True
                    else:
                        table_info["sql_script_extra"] = "\n\n\n".join(extra_parts)

    print(f"   - SQL-скриптов прикреплено к таблицам: {attached_count}")
    return catalog


def compute_dq_metadata(catalog: dict):
    """Формирует метаданные Data Quality для каждой таблицы."""
    import json
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName":
            continue
        for schema_name, tables in schemas.items():
            for table_name, table_info in tables.items():
                columns = table_info.get("columns", [])
                if not columns:
                    table_info["dq_info"] = None
                    continue

                pk = table_info.get("primary_key")
                pk_cols = [c.lower() for c in pk["columns"]] if (pk and pk.get("columns")) else []
                u_cons = table_info.get("unique_constraints", [])
                u_cols = []
                for u in u_cons:
                    u_cols.extend([c.lower() for c in u.get("columns", [])])
                indexes = table_info.get("indexes", [])

                col_constraints = {}
                for col in columns:
                    c_name = col.get("name", "")
                    c_lower = c_name.lower()
                    b_type = None
                    if c_lower in pk_cols:
                        b_type = "PRIMARY KEY"
                    elif c_lower in u_cols:
                        b_type = "UNIQUE INDEX"
                    else:
                        for idx in indexes:
                            if "UNIQUE INDEX" in idx.upper() and c_lower in idx.lower():
                                b_type = "UNIQUE INDEX"
                                break
                    if b_type:
                        col_constraints[c_name] = b_type

                first_col_name = columns[0].get("name", "")
                is_first_id = first_col_name.lower().endswith("_id")
                selected_col = first_col_name
                badge_type = col_constraints.get(selected_col)

                sql_script = (
                    f"select {selected_col}, count(*)\n"
                    f"from {db_name}.{schema_name}.{table_name}\n"
                    f"group by {selected_col}\n"
                    f"having count(*)>1;\n"
                )

                # ========== Защита от дублей ==========
                # Проверка для таблиц DDS с первым полем _id и полями dwh_start_date, is_active
                duplicate_protection = None
                if db_name.lower() == "dds":
                    first_col_lower = first_col_name.lower()
                    col_names_lower = [c.get("name", "").lower() for c in columns]
                    has_dwh_start_date = "dwh_start_date" in col_names_lower
                    has_is_active = "is_active" in col_names_lower
                    
                    if is_first_id and has_dwh_start_date and has_is_active:
                        # Проверяем, есть ли UNIQUE INDEX на первое поле (включая partial index с WHERE)
                        has_unique_index_on_first = False
                        
                        # 1. Проверяем unique_constraints на одно поле
                        for u_con in u_cons:
                            u_con_cols_lower = [c.lower() for c in u_con.get("columns", [])]
                            if len(u_con_cols_lower) == 1 and u_con_cols_lower[0] == first_col_lower:
                                has_unique_index_on_first = True
                                break
                        
                        # 2. Проверяем indexes (включая partial с WHERE is_active = true)
                        if not has_unique_index_on_first:
                            for idx in indexes:
                                idx_upper = idx.upper()
                                if "UNIQUE" in idx_upper:
                                    # Проверяем, что индекс по первому полю (с или без WHERE)
                                    first_col_upper = first_col_name.upper()
                                    if f"({first_col_upper})" in idx_upper or f"({first_col_upper}, " in idx_upper:
                                        has_unique_index_on_first = True
                                        break
                                    # Проверяем partial index с WHERE is_active
                                    if "WHERE" in idx_upper and "IS_ACTIVE" in idx_upper and first_col_upper in idx_upper:
                                        has_unique_index_on_first = True
                                        break
                        
                        # Проверяем UNIQUE CONSTRAINT на (первое поле + dwh_start_date)
                        has_unique_constraint_on_id_date = False
                        target_cols = {first_col_lower, "dwh_start_date"}
                        for u_con in u_cons:
                            u_con_cols_lower = set([c.lower() for c in u_con.get("columns", [])])
                            if u_con_cols_lower == target_cols:
                                has_unique_constraint_on_id_date = True
                                break
                        
                        duplicate_protection = {
                            "has_unique_index": has_unique_index_on_first,
                            "has_unique_constraint": has_unique_constraint_on_id_date,
                            "first_col_name": first_col_name,
                            "schema_name": schema_name,
                            "table_name": table_name,
                            "db_name": db_name
                        }

                table_info["dq_info"] = {
                    "id_column": selected_col,
                    "is_first_id": is_first_id,
                    "badge_type": badge_type,
                    "sql_script": sql_script,
                    "col_constraints_json": json.dumps(col_constraints),
                    "duplicate_protection": duplicate_protection
                }


def main():
    try:
        print("0. Сборка frontend-модулей (esbuild)...")
        # Автоматический вызов npx для сборки JS (скачает esbuild при необходимости)
        subprocess.run(
            "npx -y esbuild src/index.js --bundle --outfile=static/main.js --minify --banner:js=\"/* ВНИМАНИЕ: ФАЙЛ СГЕНЕРИРОВАН АВТОМАТИЧЕСКИ ESBUILD! Не редактируйте его вручную. Все изменения нужно вносить в исходники в папке src/ */\"",
            shell=True,
            check=True
        )

        print("1. Загрузка конфигурации...")
        config = load_config()

        print("2. Загрузка метаданных DWH...")
        catalog = extract_metadata(config)

        if not catalog:
            print("Нет данных для генерации.")
            return

        print("2а. Загрузка справочника систем-источников...")
        source_system_map = load_source_system_map(config)
        source_system_details = load_source_system_details(config)

        # Собираем список всех реально существующих таблиц (db.schema.table)
        existing_tables_ids = set()
        for db_name, schemas in catalog.items():
            if db_name == "CorpusName": continue
            for schema_name, tables in schemas.items():
                for table_name in tables.keys():
                    existing_tables_ids.add(f"{db_name}.{schema_name}.{table_name}".lower())

        print(f"   - Всего в метаданных найдено {len(existing_tables_ids)} существующих таблиц.")

        print("3. Загрузка SQL трансформаций (Подготовка lineage)...")
        sql_data = load_sql_transformations(config)
        catalog = attach_sql_scripts(catalog, sql_data)

        print("4. Расчет Table Lineage...")
        catalog = compute_table_lineage(catalog, sql_data, existing_tables_ids, source_system_map)

        print("5. Расчет Column Lineage...")
        catalog = compute_column_lineage(catalog, sql_data, existing_tables_ids)
        catalog = compute_column_sources(catalog, source_system_map)

        # --- FINAL CLEANUP: Remove any links to ghost tables that might have leaked ---
        ghost_count = 0
        for db_name, schemas in catalog.items():
            if db_name == "CorpusName": continue
            for schema_name, tables in schemas.items():
                for table_name, table_obj in tables.items():
                    if "lineage" in table_obj:
                        lineage = table_obj["lineage"]
                        
                        old_up = lineage.get("upstream", [])
                        lineage["upstream"] = [up for up in old_up if up.lower() in existing_tables_ids]
                        if len(lineage["upstream"]) < len(old_up):
                            removed = set(old_up) - set(lineage["upstream"])
                            for r in removed:
                                print(f"   - [Cleanup] Удален фантомный upstream: {r} из таблицы {table_name}")
                                ghost_count += 1
                        
                        old_dw = lineage.get("downstream", [])
                        lineage["downstream"] = [dw for dw in old_dw if dw.lower() in existing_tables_ids]
                        if len(lineage["downstream"]) < len(old_dw):
                            removed = set(old_dw) - set(lineage["downstream"])
                            for r in removed:
                                print(f"   - [Cleanup] Удален фантомный downstream: {r} в таблице {table_name}")
                                ghost_count += 1

                    if "column_lineage" in table_obj:
                        for col_name, col_data in table_obj["column_lineage"].items():
                            if "sources" in col_data:
                                old_src = col_data["sources"]
                                col_data["sources"] = [s for s in old_src if s.get("source_table", "").lower() in existing_tables_ids]
                                if len(col_data["sources"]) < len(old_src):
                                    ghost_count += (len(old_src) - len(col_data["sources"]))

        if ghost_count > 0:
            print(f"   - [Cleanup] Всего удалено {ghost_count} ссылок на несуществующие таблицы.")

        print("5б. Расчет метаданных Data Quality...")
        compute_dq_metadata(catalog)

        print("6. Сборка статического сайта...")
        generate_html(catalog, config["output_file"], source_system_map=source_system_details)

    except Exception as e:
        import traceback
        print(f"Критическая ошибка пайплайна: {e}")
        traceback.print_exc()

if __name__ == "__main__":
    main()
