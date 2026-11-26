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
import time
from config import load_config
from metadata_loader import extract_metadata, load_source_system_map, load_source_system_details
from sql_loader import load_sql_transformations
from lineage.table_lineage import compute_table_lineage
from lineage.column_lineage import compute_column_lineage, compute_column_sources, _strip_sql_comments
from site_builder import generate_html

# Настройка кодировки для Windows-консолей
if sys.platform == "win32" and __name__ == "__main__":
    import io
    if getattr(sys.stdout, "encoding", "").lower() != "utf-8":
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
    if getattr(sys.stderr, "encoding", "").lower() != "utf-8":
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)


import re

_CREATE_TARGET_RE = re.compile(
    r'\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNLOGGED\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+'
    r'(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+\.[\w"]+\.[\w"]+)',
    re.IGNORECASE,
)
_INTO_TARGET_RE = re.compile(
    r'\bINTO\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?(?:TABLE\s+)?([\w"]+\.[\w"]+\.[\w"]+)',
    re.IGNORECASE,
)
_FROM_JOIN_TABLE_RE = re.compile(
    r'(\b(?:FROM|JOIN)\s+)'          # ключевое слово
    r'([\w]+\.[\w.]+)'               # schema.table или db.schema.table
    r'(\b)',                          # граница слова / пробел после имени
    re.IGNORECASE,
)
_LEADING_COMMENT_OR_EMPTY_RE = re.compile(r'^\s*(--|$)')

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


def _extract_all_explicit_target_dbs(script: str) -> list[str]:
    """
    Извлекает все явные db-префиксы из целевых инструкций (CREATE [UNLOGGED] TABLE/VIEW,
    INSERT INTO, SELECT ... INTO), если цель указана 3 компонентами (db.schema.table).
    Использует линейные (O(N)) предкомпилированные паттерны без catastrophic backtracking.
    """
    if not script:
        return []
    cleaned = _strip_sql_comments(script)
    matches: list[tuple[int, str]] = []
    for m in _CREATE_TARGET_RE.finditer(cleaned):
        parts = m.group(1).replace('"', '').split('.')
        if len(parts) == 3:
            db_part = parts[0].lower()
            if db_part and db_part != "pg_temp":
                matches.append((m.start(), db_part))
    if "INTO" in cleaned.upper():
        for m in _INTO_TARGET_RE.finditer(cleaned):
            parts = m.group(1).replace('"', '').split('.')
            if len(parts) == 3:
                db_part = parts[0].lower()
                if db_part and db_part != "pg_temp":
                    matches.append((m.start(), db_part))
    matches.sort(key=lambda x: x[0])
    seen = []
    for _, db_part in matches:
        if db_part not in seen:
            seen.append(db_part)
    return seen


def _extract_explicit_target_db(script: str) -> str:
    """
    Извлекает явный db-префикс из первой целевой инструкции (CREATE TABLE/VIEW, INSERT INTO, SELECT INTO),
    если имя цели указано тремя компонентами (db.schema.table). Иначе возвращает ''.
    """
    dbs = _extract_all_explicit_target_dbs(script)
    return dbs[0] if dbs else ""


def attach_sql_scripts(catalog: dict, sql_transformations: list[dict]) -> dict:
    """Добавляет к таблицам скрипты из public.sql_inventory для отображения в UI."""
    lookup = {}
    # Кандидаты по (schema, table) — используются ТОЛЬКО если db_name не задан и совпадение однозначно
    schema_table_candidates: dict[tuple[str, str], list[tuple[str, str, str]]] = {}
    # Маппинг schema → список db_name (для _add_db_prefix_all без перепутывания БД)
    schema_to_dbs: dict[str, list[str]] = {}
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName":
            continue
        for schema_name, tables in schemas.items():
            s_lc = schema_name.lower()
            dbs_list = schema_to_dbs.setdefault(s_lc, [])
            if db_name not in dbs_list:
                dbs_list.append(db_name)
            for table_name in tables.keys():
                target_tuple = (db_name, schema_name, table_name)
                # Ключ: (db, schema, table) — точное совпадение с учётом БД
                lookup[(db_name.lower(), s_lc, table_name.lower())] = target_tuple
                schema_table_candidates.setdefault((s_lc, table_name.lower()), []).append(target_tuple)

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
                # Fallback: только если таблица однозначно существует ровно в одной БД
                cands = schema_table_candidates.get((schema_lc, table_lc), [])
                if len(cands) == 1:
                    return f"{keyword}{cands[0][0]}.{name}{alias}"
                # Или если сама схема уникальна для одной БД
                dbs_for_schema = schema_to_dbs.get(schema_lc, [])
                if len(dbs_for_schema) == 1:
                    return f"{keyword}{dbs_for_schema[0]}.{name}{alias}"
            return m.group(0)

        # Ищем FROM/JOIN + имя (2 или 3 компонента)
        return _FROM_JOIN_TABLE_RE.sub(replacer, script)

    known_catalog_dbs = {d.lower() for d in catalog.keys() if d != "CorpusName"}
    attached_count = 0
    for item in sql_transformations:
        if item.get("source") != "public.sql_inventory":
            continue

        item_db          = (item.get("db_name")       or "").strip().lower().replace('"', '')
        target_schema    = (item.get("target_schema") or "").strip().lower().replace('"', '')
        target_table_raw = (item.get("target_table")  or "").strip().lower().replace('"', '')
        query = item.get("query") or ""
        if not target_table_raw or not query:
            continue

        tbl_parts = [p for p in target_table_raw.split('.') if p]
        explicit_tbl_db = ""
        if len(tbl_parts) >= 3:
            explicit_tbl_db = tbl_parts[-3]
            if not target_schema:
                target_schema = tbl_parts[-2]
            target_table = tbl_parts[-1]
        elif len(tbl_parts) == 2:
            if not target_schema:
                target_schema = tbl_parts[0]
            target_table = tbl_parts[1]
        elif len(tbl_parts) == 1:
            target_table = tbl_parts[0]
        else:
            continue

        if not target_schema or not target_table:
            continue

        if item_db and explicit_tbl_db and item_db != explicit_tbl_db:
            print(
                f"   [Attach Script Warning] Пропуск скрипта: db_name='{item_db}' "
                f"противоречит target_table='{target_table_raw}'."
            )
            continue

        effective_db = item_db or explicit_tbl_db

        # Защита от межбазового попадания скриптов:
        # если БД известна (dds/dm), ищем СТРОГО внутри неё без fallback в чужую БД.
        target = None
        if effective_db:
            target = lookup.get((effective_db, target_schema, target_table))
        else:
            cands = schema_table_candidates.get((target_schema, target_table), [])
            if len(cands) == 1:
                target = cands[0]
        if not target:
            continue

        db_name, schema_name, table_name = target
        table_entry = catalog[db_name][schema_name][table_name]
        # sql_loader.py читает строки в порядке updated_at DESC NULLS LAST:
        # не перезаписываем уже прикреплённый более свежий скрипт старой записью.
        if table_entry.get("sql_script"):
            continue

        # Для вкладки "Скрипт" берём оригинальный текст (без замены foreign tables).
        # Так скрипт можно запустить в Postgres — ext_dds.table остаётся ext_dds.table.
        # Для lineage-анализа используется item["query"] с нормализованными именами.
        raw = (item.get("raw_query") or query).rstrip()

        # Дополнительная защита: проверяем ВСЕ целевые инструкции в SQL.
        # Если в самом SQL-запросе явно указана 3-составная целевая БД,
        # не совпадающая с db_name целевой таблицы в каталоге — отклоняем такой скрипт.
        explicit_sql_dbs = _extract_all_explicit_target_dbs(raw)
        if query != raw:
            for candidate_db in _extract_all_explicit_target_dbs(query):
                if candidate_db not in explicit_sql_dbs:
                    explicit_sql_dbs.append(candidate_db)
        foreign_dbs = [d for d in explicit_sql_dbs if d != db_name.lower() and (d in known_catalog_dbs or len(explicit_sql_dbs) == 1)]
        if foreign_dbs:
            print(
                f"   [Attach Script Warning] Скрипт из '{effective_db or '?'}' явно создаёт/загружает "
                f"'{foreign_dbs[0]}.*' — отклонён для '{db_name}.{schema_name}.{table_name}'."
            )
            continue

        script = raw
        # Убираем ведущие закомментированные строки (-- ...) и пустые строки в начале скрипта.
        # Они выглядят как мусор во вкладке "Скрипт" — рабочий код должен идти первым.
        script_lines = script.splitlines()
        while script_lines:
            if _LEADING_COMMENT_OR_EMPTY_RE.match(script_lines[0]):
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

        # Пост-проверка итогового текста перед сохранением в каталог (только если текст изменился)
        if script.rstrip(';') != raw.rstrip(';'):
            final_sql_dbs = _extract_all_explicit_target_dbs(script)
            final_foreign_dbs = [d for d in final_sql_dbs if d != db_name.lower() and (d in known_catalog_dbs or len(final_sql_dbs) == 1)]
            if final_foreign_dbs:
                print(
                    f"   [Attach Script Warning] Пост-проверка отклонила итоговый скрипт с '{final_foreign_dbs[0]}.*' "
                    f"для '{db_name}.{schema_name}.{table_name}'."
                )
                continue

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

        # Сохраняем логин создателя скрипта из public.sql_inventory
        created_by = item.get("created_by")
        if created_by:
            catalog[db_name][schema_name][table_name]["created_by"] = str(created_by).strip()

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
                    table_col_map = {c.get("name", "").lower(): c.get("name", "") for c in columns}
                    col_names_lower = [c.get("name", "").lower() for c in columns]
                    has_dwh_start_date = "dwh_start_date" in col_names_lower
                    has_is_active = "is_active" in col_names_lower
                    
                    if is_first_id and has_dwh_start_date and has_is_active:
                        # 1. Парсим уникальные индексы (ищем partial index с is_active)
                        unique_indexes_parsed = []
                        for idx in indexes:
                            idx_upper = idx.upper()
                            if "UNIQUE" in idx_upper:
                                has_is_active_where = ("WHERE" in idx_upper and "IS_ACTIVE" in idx_upper)
                                m = re.search(r'CREATE\s+UNIQUE\s+INDEX\s+([^\s]+)\s+ON\s+.*?\((.*?)\)(?:\s+WHERE\s+(.*))?$', idx, re.IGNORECASE)
                                if m:
                                    idx_name = m.group(1).split('.')[-1].strip('"')
                                    raw_cols = [c.strip() for c in m.group(2).split(',')]
                                    where_clause = m.group(3) or ""
                                    is_partial_active = "is_active" in where_clause.lower() or has_is_active_where
                                    unique_indexes_parsed.append({
                                        "name": idx_name,
                                        "cols": raw_cols,
                                        "cols_lower": [c.lower() for c in raw_cols],
                                        "is_active_where": is_partial_active
                                    })

                        # 2. Парсим уникальные ограничения (ищем наличие dwh_start_date и ключевые колонки)
                        unique_constraints_parsed = []
                        for u_con in u_cons:
                            u_cols = u_con.get("columns", [])
                            u_cols_lower = [c.lower() for c in u_cols]
                            has_start_date = "dwh_start_date" in u_cols_lower
                            key_cols = [c for c in u_cols if c.lower() != "dwh_start_date"]
                            unique_constraints_parsed.append({
                                "constraint_name": u_con.get("constraint_name"),
                                "columns": u_cols,
                                "has_dwh_start_date": has_start_date,
                                "key_cols": key_cols,
                                "key_cols_lower": [c.lower() for c in key_cols]
                            })

                        # 3. Сопоставляем индекс и ограничение:
                        # Поддерживаются как одиночный ключ [first_col], так и составной [first_col, second_col]
                        # Имена индекса и ограничения могут быть любыми (не обязательно _idx и _unique_version)
                        matched_key_cols = None
                        matched_index_name = None
                        matched_constraint_name = None
                        has_unique_index = False
                        has_unique_constraint = False

                        # Сначала ищем полное совпадение (и индекс, и ограничение с одинаковыми колонками)
                        # Сортируем так, чтобы составной ключ (2 колонки) проверялся раньше одиночного
                        sorted_constraints = sorted(
                            [u for u in unique_constraints_parsed if u["has_dwh_start_date"] and len(u["key_cols"]) in (1, 2) and u["key_cols_lower"] and u["key_cols_lower"][0] == first_col_lower],
                            key=lambda u: len(u["key_cols"]),
                            reverse=True
                        )
                        for u in sorted_constraints:
                            cand_lower = u["key_cols_lower"]
                            for idx_info in unique_indexes_parsed:
                                if idx_info["cols_lower"] == cand_lower and idx_info["is_active_where"]:
                                    matched_key_cols = u["key_cols"]
                                    matched_index_name = idx_info["name"]
                                    matched_constraint_name = u["constraint_name"]
                                    has_unique_index = True
                                    has_unique_constraint = True
                                    break
                            if matched_key_cols:
                                break

                        # Если полного совпадения нет, проверяем частичное наличие
                        if not matched_key_cols:
                            for u in sorted_constraints:
                                matched_key_cols = u["key_cols"]
                                matched_constraint_name = u["constraint_name"]
                                has_unique_constraint = True
                                break

                        if not matched_key_cols:
                            for idx_info in unique_indexes_parsed:
                                if len(idx_info["cols"]) in (1, 2) and idx_info["cols_lower"] and idx_info["cols_lower"][0] == first_col_lower and idx_info["is_active_where"]:
                                    matched_key_cols = [table_col_map.get(c, c) for c in idx_info["cols_lower"]]
                                    matched_index_name = idx_info["name"]
                                    has_unique_index = True
                                    break

                        if not matched_key_cols:
                            matched_key_cols = [first_col_name]

                        duplicate_protection = {
                            "has_unique_index": has_unique_index,
                            "has_unique_constraint": has_unique_constraint,
                            "first_col_name": first_col_name,
                            "key_columns": matched_key_cols,
                            "cols_str": ", ".join(matched_key_cols),
                            "index_name": matched_index_name or f"{table_name}_idx",
                            "constraint_name": matched_constraint_name or f"{table_name}_unique_version",
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
        total_start = time.perf_counter()

        t0 = time.perf_counter()
        print("0. Сборка frontend-модулей (esbuild)...")
        # Автоматический вызов npx для сборки JS (скачает esbuild при необходимости)
        subprocess.run(
            "npx -y esbuild src/index.js --bundle --outfile=static/main.js --minify --banner:js=\"/* ВНИМАНИЕ: ФАЙЛ СГЕНЕРИРОВАН АВТОМАТИЧЕСКИ ESBUILD! Не редактируйте его вручную. Все изменения нужно вносить в исходники в папке src/ */\"",
            shell=True,
            check=True
        )
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
        print("1. Загрузка конфигурации...")
        config = load_config()
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
        print("2. Загрузка метаданных DWH...")
        catalog = extract_metadata(config)

        if not catalog:
            print("Нет данных для генерации.")
            return
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
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
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
        print("3. Загрузка SQL трансформаций (Подготовка lineage)...")
        sql_data = load_sql_transformations(config)
        catalog = attach_sql_scripts(catalog, sql_data)
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
        print("4. Расчет Table Lineage...")
        catalog = compute_table_lineage(catalog, sql_data, existing_tables_ids, source_system_map)
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
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
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
        print("5б. Расчет метаданных Data Quality...")
        compute_dq_metadata(catalog)
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        t0 = time.perf_counter()
        print("6. Сборка статического сайта...")
        generate_html(catalog, config["output_file"], source_system_map=source_system_details)
        print(f"   ✓ Выполнено за {time.perf_counter() - t0:.2f} сек.\n")

        total_elapsed = time.perf_counter() - total_start
        print("=" * 54)
        print(f"✓ Каталог успешно сгенерирован за {total_elapsed:.2f} сек.")
        print("=" * 54)

    except Exception as e:
        import traceback
        print(f"Критическая ошибка пайплайна: {e}")
        traceback.print_exc()

if __name__ == "__main__":
    main()
