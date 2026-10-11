"""
MODULE: table_lineage.py
ROLE: Построение связей между таблицами на основе SQL.
"""

import re
import sqlglot
from sqlglot import exp

# Маппинг foreign-table схем → реальные (db, schema).
# Нормализация выполняется в sql_loader.py на уровне текста запроса,
# но _get_table_id может встретить ext_* в уже распарсенном AST,
# если sqlglot заметил остатки или если скрипт пришёл напрямую.
_FOREIGN_SCHEMA_MAP = {
    "ext_ods":  ("ods", "core"),
    "ext_dds":  ("dds", "core"),
    "ext_calc": ("dds", "calc"),
}


def _get_table_id(table_exp, default_db: str = "") -> str:
    """
    Извлекает db.schema.table_name из узла sqlglot.exp.Table.

    Поддерживает три формата:
      table_name              → default_db.name  (fallback, только если нет db/schema)
      schema.table_name       → default_db.schema.table_name
      db.schema.table_name    → db.schema.table_name

    Нормализует foreign-table схемы:
      ext_ods.table → ods.core.table
      ext_dds.table → dds.core.table
    """
    if not table_exp:
        return ""

    db     = (table_exp.catalog or "").lower()
    schema = (table_exp.db      or "").lower()
    name   = (table_exp.name    or "").lower()

    if not name:
        return ""

    # Нормализация foreign tables (на случай если sql_loader не успел)
    if schema in _FOREIGN_SCHEMA_MAP:
        real_db, real_schema = _FOREIGN_SCHEMA_MAP[schema]
        db     = real_db
        schema = real_schema
    elif db in _FOREIGN_SCHEMA_MAP:
        real_db, real_schema = _FOREIGN_SCHEMA_MAP[db]
        db     = real_db
        schema = real_schema

    if not db:
        db = default_db

    if not schema:
        # Только имя таблицы — не можем определить схему надёжно
        return f"{db}.{name}"

    return f"{db}.{schema}.{name}"

def compute_table_lineage(catalog: dict, sql_transformations: list[dict], existing_tables: set = None, source_system_map: dict = None) -> dict:
    """
    Строит граф зависимостей таблиц (table_lineage) с помощью sqlglot.
    """
    print(f"   - Анализ {len(sql_transformations)} запросов для table lineage...")
    
    # Инициализация словаря маппинга для case-insensitive поиска таблиц по каталогу
    lookup = {}
    
    # Инициализация пустой структуры lineage для всех таблиц в каталоге (кроме схемы public)
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName": continue # skip metadata
        for schema_name, tables in schemas.items():
            # Пропускаем таблицы схемы public из lineage (они технические)
            if schema_name == 'public':
                continue
            for table_name, table_obj in tables.items():
                # Убеждаемся, что внутри множества для накопления данных
                if "lineage" not in table_obj:
                    table_obj["lineage"] = {"upstream": set(), "downstream": set()}
                else:
                    # Если уже есть (из метадаты), конвертируем в set если это list
                    if isinstance(table_obj["lineage"]["upstream"], list):
                        table_obj["lineage"]["upstream"] = set(table_obj["lineage"]["upstream"])
                    if isinstance(table_obj["lineage"]["downstream"], list):
                        table_obj["lineage"]["downstream"] = set(table_obj["lineage"]["downstream"])
                
                # Ключ: db.schema.table (например ods.core.client)
                full_key = f"{db_name}.{schema_name}.{table_name}".lower()
                lookup[full_key] = (db_name, schema_name, table_name)
    
    for item in sql_transformations:
        sql = item["query"]
        # default_db: база, из которой пришёл скрипт (для резолвинга таблиц без явного db)
        default_db = item.get("db_name", "dwh").lower()
        try:
            parsed = sqlglot.parse_one(sql, read="postgres")
            
            target_table = None
            source_tables = set()
            
            if isinstance(parsed, exp.Create) and isinstance(parsed.this, exp.Table):
                target_table = _get_table_id(parsed.this, default_db)
            elif isinstance(parsed, exp.Insert):
                target_table = _get_table_id(parsed.this, default_db)
            
            if not target_table or target_table not in lookup:
                continue

            # Ищем все исходные таблицы в запросе
            for table in parsed.find_all(exp.Table):
                src_id = _get_table_id(table, default_db)
                if not src_id or src_id == target_table:
                    continue
                
                if src_id in lookup:
                    source_tables.add(src_id)
                else:
                    # SMART MATCHING: Если схема не указана, пробуем найти таблицу
                    # в любой доступной схеме той же базы данных
                    if not table.db:
                        tbl_name_lower = table.name.lower()
                        for candidate_id in lookup.keys():
                            parts = candidate_id.split('.')
                            if len(parts) == 3 and parts[0] == default_db and parts[2] == tbl_name_lower:
                                source_tables.add(candidate_id)
                                break
            
            if not source_tables:
                continue

            # Канонизируем целевую таблицу
            db_t, schema_t, name_t = lookup[target_table]
            canonical_target = f"{db_t}.{schema_t}.{name_t}"

            # Собираем канонические имена источников
            canonical_sources = []
            for src_id in source_tables:
                db_s, schema_s, name_s = lookup[src_id]
                canonical_sources.append(f"{db_s}.{schema_s}.{name_s}")
            
            # 1. Для целевой таблицы - записываем её источники (upstream)
            catalog[db_t][schema_t][name_t]["lineage"]["upstream"].update(canonical_sources)
            
            # 2. Для каждой исходной таблицы - записываем, что она является источником для целевой (downstream)
            for src_id in source_tables:
                db_s, schema_s, name_s = lookup[src_id]
                catalog[db_s][schema_s][name_s]["lineage"]["downstream"].add(canonical_target)
                        
        except Exception:
            continue

    # Конвертируем set в list для JSON сериализации
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName": continue
        for schema_name, tables in schemas.items():
            for table_name, table_obj in tables.items():
                if "lineage" in table_obj:
                    table_obj["lineage"]["upstream"] = list(table_obj["lineage"]["upstream"])
                    table_obj["lineage"]["downstream"] = list(table_obj["lineage"]["downstream"])

    return _compute_sources(catalog, source_system_map)

def _compute_sources(catalog: dict, source_system_map: dict = None) -> dict:
    if source_system_map is None:
        source_system_map = {}

    def resolve_source_name(prefix: str) -> str:
        return source_system_map.get(prefix.lower(), prefix)

    lookup = {}
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName": continue
        for schema_name, tables in schemas.items():
            # Пропускаем таблицы схемы public (они технические)
            if schema_name == 'public':
                continue
            for table_name, table_obj in tables.items():
                key = f"{db_name}.{schema_name}.{table_name}".lower()
                lookup[key] = table_obj

    for db_name, schemas in catalog.items():
        if db_name == "CorpusName": continue
        for schema_name, tables in schemas.items():
            # Пропускаем таблицы схемы public (они технические)
            if schema_name == 'public':
                continue
            for table_name, table_obj in tables.items():
                sources = set()
                visited = set()
                
                def dfs(t_key):
                    if t_key in visited:
                        return
                    visited.add(t_key)
                    
                    t_info = lookup.get(t_key.lower())
                    
                    # Источниками считаем таблицы из ods (схема ods или core в базе ods).
                    # Если lineage обрывается на dds/dm — это не источник, а отсутствие данных о загрузке.
                    if not t_info or not t_info.get("lineage", {}).get("upstream"):
                        parts = t_key.split(".")
                        # parts = [db, schema, table] или [db, table]
                        t_db     = parts[0].lower() if len(parts) >= 3 else ""
                        t_schema = parts[-2].lower() if len(parts) >= 2 else ""
                        t_name   = parts[-1].lower()
                        # Источник: схема ods (старая структура) или база ods (новая структура)
                        is_source = (t_schema == 'ods') or (t_db == 'ods')
                        if is_source:
                            prefix = t_name.split("_")[0] if "_" in t_name else t_name
                            sources.add(resolve_source_name(prefix))
                    else:
                        for up in t_info["lineage"]["upstream"]:
                            dfs(up)
                
                # Start DFS from current table's upstream
                if table_obj.get("lineage", {}).get("upstream"):
                    for up in table_obj["lineage"]["upstream"]:
                        dfs(up)
                
                table_obj["sources"] = ", ".join(sorted(sources))
    return catalog