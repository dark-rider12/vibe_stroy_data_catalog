"""
MODULE: column_lineage.py
ROLE: Построение зависимостей на уровне колонок (Data Mapping).
"""

import re
import sqlglot
from sqlglot.lineage import lineage
from sqlglot import exp
from sqlglot.optimizer.qualify import qualify
from lineage.table_lineage import _get_table_id


def _node_to_expr(node) -> str:
    """
    Рекурсивно генерирует SQL-выражение из AST-узла sqlglot,
    сохраняя читабельный вид.
    """
    if node is None:
        return ''
    # CONCAT_WS: разделитель — первый элемент expressions, остальные — аргументы
    # node.this у ConcatWs всегда None, поэтому обрабатываем отдельно
    if isinstance(node, exp.ConcatWs):
        parts = [_node_to_expr(e) for e in node.expressions]
        if parts:
            sep = parts[0]
            args = ', '.join(parts)
            return f'CONCAT_WS({args})'
        return node.sql(dialect='postgres')
    # String concatenation: || вместо CONCAT
    if isinstance(node, exp.DPipe):
        return f'{_node_to_expr(node.this)} || {_node_to_expr(node.expression)}'
    if isinstance(node, exp.Concat):
        return ' || '.join(_node_to_expr(e) for e in node.expressions)
    # Parameter placeholder: $N (postgres-стиль)
    if isinstance(node, exp.Parameter):
        return f'${node.name}'
    # Если узел имеет метод sql (как большинство узлов sqlglot), используем его.
    # Но для подзапросов и сложных выражений стараемся сохранить структуру.
    try:
        return node.sql(dialect='postgres')
    except Exception:
        return str(node)


def _strip_sql_comments(sql: str) -> str:
    """
    Убирает SQL-комментарии из выражения, не трогая строковые литералы.
    """
    if not sql:
        return ''

    result = []
    i = 0
    length = len(sql)
    in_single_quote = False
    in_double_quote = False
    in_line_comment = False
    in_block_comment = False

    while i < length:
        char = sql[i]
        next_char = sql[i + 1] if i + 1 < length else ''

        if in_line_comment:
            if char in '\r\n':
                in_line_comment = False
                result.append(char)
            i += 1
            continue

        if in_block_comment:
            if char == '*' and next_char == '/':
                in_block_comment = False
                i += 2
            else:
                i += 1
            continue

        if not in_single_quote and not in_double_quote:
            if char == '-' and next_char == '-':
                in_line_comment = True
                i += 2
                continue
            if char == '/' and next_char == '*':
                in_block_comment = True
                i += 2
                continue

        result.append(char)

        if char == "'" and not in_double_quote:
            if in_single_quote and next_char == "'":
                result.append(next_char)
                i += 2
                continue
            in_single_quote = not in_single_quote
        elif char == '"' and not in_single_quote:
            if in_double_quote and next_char == '"':
                result.append(next_char)
                i += 2
                continue
            in_double_quote = not in_double_quote

        i += 1

    cleaned = re.sub(r'\s+', ' ', ''.join(result)).strip()
    # Убираем "осиротевшие" закрывающие маркеры блочных комментариев */
    # Они могут появиться если sqlglot сохранил trailing-комментарий вида /*text*/
    # и при этом открывающая часть /* уже была удалена строчным комментарием --
    cleaned = re.sub(r'\s*\*/\s*', ' ', cleaned).strip()
    return cleaned


def _get_union_selects(node) -> list:
    """
    Рекурсивно извлекает все SELECT-ветки из UNION/UNION ALL/INTERSECT/EXCEPT.
    Возвращает список exp.Select узлов.
    """
    if isinstance(node, exp.Select):
        return [node]
    if isinstance(node, exp.Union):
        return _get_union_selects(node.this) + _get_union_selects(node.expression)
    return []


def _get_union_parts(node) -> list:
    """
    Рекурсивно извлекает ветки и операторы между ними.
    Возвращает список чередующихся элементов:
      [exp.Select, operator_str, exp.Select, operator_str, exp.Select, ...]
    где operator_str — 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT' и т.д.
    """
    if isinstance(node, exp.Select):
        return [node]
    if isinstance(node, exp.Union):
        if isinstance(node, exp.Intersect):
            op = 'INTERSECT'
        elif isinstance(node, exp.Except):
            op = 'EXCEPT'
        else:
            op = 'UNION' if node.args.get('distinct') else 'UNION ALL'
        left_parts = _get_union_parts(node.this)
        right_parts = _get_union_parts(node.expression)
        return left_parts + [op] + right_parts
    return []


def _resolve_cte_source(cte_name: str, col_name: str, cte_map: dict, lookup: dict, default_db: str = ""):
    """
    По имени CTE и колонки находит реальную таблицу-источник.
    Возвращает full_table_id (строку вида "db.schema.table") или None.
    Поддерживает CTE с UNION ALL — ищет колонку во всех ветках.
    """
    resolved = _resolve_cte_source_column(cte_name, col_name, cte_map, lookup, default_db)
    return resolved[0][0] if resolved else None


def _resolve_cte_source_column(cte_name: str, col_name: str, cte_map: dict, lookup: dict, default_db: str = ""):
    """
    По имени CTE (или его алиасу в расширенном cte_map) и колонке находит
    реальные таблицы-источники И реальные имена колонок (не алиасы вывода like client_name).

    Возвращает СПИСОК пар (full_table_id, real_col_name). Может содержать несколько
    элементов для CTE/подзапроса с UNION/UNION ALL — по одной паре на ветку.

    Для КАЖДОЙ ветки строится ЛОКАЛЬНЫЙ alias_map: разные ветки могут использовать
    одинаковый алиас (напр. 'cc') для РАЗНЫХ таблиц, и без локального маппинга
    алиас затирается последней веткой (последняя побеждает). Это чинит случай
    UNION внутри подзапроса/CTE без хардкода таблиц.
    Рекурсивно спускается в цепочки CTE->CTE.
    """
    cte_info = cte_map.get(cte_name.lower())
    if not cte_info:
        return []
    body = cte_info['select']
    cte_alias_map = cte_info.get('alias_map', {})

    result = []
    found_match = False
    for sel in _get_union_selects(body):
        # Локальный alias_map ТЕКУЩЕЙ ветки (без таблиц из WITH-клаузы ветки,
        # чтобы не засорять маппинг телами локальных CTE)
        branch_sel = sel.copy()
        branch_sel.set('with', None)
        branch_alias_map = {}
        for tbl in branch_sel.find_all(exp.Table):
            full_tid = _get_table_id(tbl, default_db)
            if full_tid:
                if tbl.alias:
                    branch_alias_map[tbl.alias.lower()] = full_tid
                branch_alias_map[tbl.name.lower()] = full_tid

        for sel_item in sel.selects:
            sel_alias = sel_item.alias_or_name.lower() if sel_item.alias_or_name else ''
            if sel_alias != col_name.lower():
                continue
            found_match = True
            inner = sel_item.this if isinstance(sel_item, exp.Alias) else sel_item
            # Константа или системная функция — таблицы-источника нет
            if _is_constant_expression(_node_to_expr(inner)):
                break
            if isinstance(inner, exp.Column):
                real_col = inner.name
                tbl_ref = inner.table.lower() if inner.table else None
                if tbl_ref:
                    if tbl_ref in branch_alias_map and branch_alias_map[tbl_ref] in lookup:
                        result.append((branch_alias_map[tbl_ref], real_col))
                    elif tbl_ref in cte_alias_map and cte_alias_map[tbl_ref] in lookup:
                        result.append((cte_alias_map[tbl_ref], real_col))
                    elif cte_map.get(tbl_ref):
                        # цепочка CTE->CTE или alias CTE из расширенного маппинга
                        result.extend(_resolve_cte_source_column(tbl_ref, real_col, cte_map, lookup, default_db))
                    else:
                        for tid in lookup.keys():
                            if tid.split('.')[-1] == tbl_ref:
                                result.append((tid, real_col))
                                break
                else:
                    # Непроквалифицированная колонка — первая реальная таблица ветки
                    for bt in branch_sel.find_all(exp.Table):
                        tid = _get_table_id(bt, default_db)
                        if tid and tid in lookup:
                            result.append((tid, real_col))
                            break
            else:
                # Сложное выражение (функция, каст, конкатенация, ...) — берём
                # первую реальную таблицу ветки, имя колонки оставляем запрошенным
                for bt in branch_sel.find_all(exp.Table):
                    tid = _get_table_id(bt, default_db)
                    if tid and tid in lookup:
                        result.append((tid, col_name))
                        break
            # Одна колонка на ветку UNION — переходим к следующей ветке
            break

    # Fallback: первая реальная таблица из CTE.
    # Срабатывает ТОЛЬКО если колонка в CTE вообще не найдена (found_match == False).
    # Если колонка найдена, но во всех ветках является константой/системной функцией —
    # таблицы-источника нет (возвращаем пустой список).
    if not result and not found_match and cte_alias_map:
        for tid in cte_alias_map.values():
            if tid in lookup:
                result.append((tid, col_name))
                break
    return result


_DEFAULT_SCHEMAS = {"core", "calc", "public", "ods", "dds", "dm", "sandbox_1", "sandbox_2", "sandbox_3"}


def _build_schema_lookahead(catalog: dict = None) -> str:
    r"""
    Строит регулярку отрицательного просмотра вперёд для известных схем DWH:
    (?!(?:core|calc|public|ods|dds|dm)\.)
    Используется для предотвращения коллизий при замене алиасов (напр. 'dm', 'dds', 'ods'),
    чтобы 'dm.core.table.col' не превращалось в 'dm.table_ref.core.table.col'.
    """
    schemas = set(_DEFAULT_SCHEMAS)
    if catalog:
        for db_name, db_schemas in catalog.items():
            if db_name == "CorpusName" or not isinstance(db_schemas, dict):
                continue
            for s in db_schemas.keys():
                schemas.add(s.lower())
    pattern = '|'.join(re.escape(s) for s in sorted(schemas, key=len, reverse=True))
    return rf'(?!(?:{pattern})\.)'


def _resolve_cte_refs(expression_sql: str, cte_map: dict, cte_alias_to_name: dict = None, lookup: dict = None, default_db: str = "", visited: set = None, schema_lookahead: str = "") -> str:
    """
    Разворачивает ссылки на CTE в выражении.
    Обрабатывает как прямые имена CTE ("account_stats.col"),
    так и алиасы CTE ("ast.col" если JOIN account_stats ast).
    """
    if not cte_map or not expression_sql:
        return expression_sql

    if visited is None:
        visited = set()

    if not schema_lookahead:
        schema_lookahead = _build_schema_lookahead()

    # Строим расширенный маппинг: и имена CTE, и их алиасы → cte_info
    effective_map = dict(cte_map)  # cte_name -> cte_info
    if cte_alias_to_name:
        for alias, cte_name in cte_alias_to_name.items():
            if cte_name in cte_map:
                effective_map[alias] = cte_map[cte_name]

    expr_lower = expression_sql.lower()
    for ref_name, cte_info in effective_map.items():
        if ref_name in visited or ref_name not in expr_lower:
            continue
        cte_select = cte_info['select']
        cte_alias_map = cte_info['alias_map']

        # Ищем все вхождения "ref_name.something" в выражении
        pattern = re.compile(
            rf'(?<![.\w]){re.escape(ref_name)}\.([a-zA-Z_][a-zA-Z0-9_]*)',
            re.IGNORECASE
        )

        def replace_cte_ref(m, _body=cte_select, _cte_info=cte_info, _current_ref=ref_name):
            col_ref = m.group(1).lower()
            # Берём актуальный alias_map из cte_info (он мог быть обновлён рекурсивным проходом)
            _amap = _cte_info['alias_map']
            # Для UNION/UNION ALL собираем выражение из КАЖДОЙ ветки с реальным оператором
            parts = _get_union_parts(_body)
            # parts = [Select, 'UNION ALL', Select, 'UNION ALL', Select, ...]
            branch_sqls = []   # (operator_before, sql) — operator_before пуст для первой ветки
            pending_op = ''
            for part in parts:
                if isinstance(part, str):
                    pending_op = part
                    continue
                # part — это exp.Select (ветка)
                # Строим alias_map ЛОКАЛЬНО для этой ветки — у каждой ветки UNION
                # могут быть одинаковые алиасы, ссылающиеся на разные таблицы
                branch_amap = {}
                for tbl in part.find_all(exp.Table):
                    full_tid = _get_table_id(tbl, default_db)
                    if full_tid:
                        if tbl.alias:
                            branch_amap[tbl.alias.lower()] = full_tid
                        branch_amap[tbl.name.lower()] = full_tid
                # Если в ветке нет своих таблиц — fallback на актуальный _amap
                if not branch_amap:
                    branch_amap = _amap
                # Убираем из branch_amap ключи, значения которых являются псевдо-ID для CTE
                # (последняя часть пути совпадает с именем CTE в cte_map)
                # (они не реальные таблицы и будут раскрыты через _resolve_cte_refs ниже).
                # ВАЖНО: проверяем tid_last in cte_map, а НЕ cte_key in cte_map!
                # Если у реальной физической таблицы алиас совпал с именем CTE (напр. FROM real_table account_info),
                # она не должна удаляться из branch_amap и считаться CTE.
                branch_cte_aliases = {}
                for cte_key in list(branch_amap.keys()):
                    tid_val = branch_amap[cte_key]
                    tid_last = tid_val.split('.')[-1].lower()
                    if tid_last in cte_map:
                        branch_cte_aliases[cte_key] = tid_last
                        del branch_amap[cte_key]
                # Если после фильтрации branch_amap пустой — ветка содержит только CTE-ссылки.
                # НЕ делаем fallback на _amap: это приведёт к неверной замене алиасов CTE
                # на реальные таблицы (напр. 'a' → 'dds.account_detail' вместо раскрытия через CTE).
                # Вместо этого оставляем branch_amap пустым и передаём branch_cte_aliases
                # в рекурсивный _resolve_cte_refs ниже.
                for sel_item in part.selects:
                    sel_alias = sel_item.alias_or_name.lower() if sel_item.alias_or_name else ''
                    if sel_alias != col_ref:
                        continue
                    inner = sel_item.this if isinstance(sel_item, exp.Alias) else sel_item
                    inner_sql = _node_to_expr(inner)
                    inner_sql = _strip_sql_comments(inner_sql)
                    inner_sql = inner_sql.replace('"DWH".', '').replace('"', '')
                    inner_sql_lower = inner_sql.lower()
                    for ak in sorted(branch_amap.keys(), key=len, reverse=True):
                        if ak not in inner_sql_lower:
                            continue
                        full_tid = branch_amap[ak]
                        if lookup and full_tid in lookup:
                            db_orig, schema_orig, name_orig = lookup[full_tid]
                            ref = f"{db_orig}.{schema_orig}.{name_orig}"
                        else:
                            tbl_parts = full_tid.split('.')
                            ref = '.'.join(tbl_parts[-3:]) if len(tbl_parts) >= 3 else '.'.join(tbl_parts)
                        inner_sql = re.sub(
                            rf'(?<![\w.])({re.escape(ak)})\.{schema_lookahead}',
                            f'{ref}.',
                            inner_sql,
                            flags=re.IGNORECASE
                        )
                        inner_sql_lower = inner_sql.lower()
                    next_visited = set(visited) | {_current_ref}
                    inner_sql = _resolve_cte_refs(inner_sql, cte_map, branch_cte_aliases if branch_cte_aliases else None, lookup, default_db, next_visited, schema_lookahead)
                    branch_sqls.append((pending_op, inner_sql))
                    break
                pending_op = ''

            if branch_sqls:
                # Склеиваем: первая ветка без оператора, остальные с оператором перед ними
                result_parts = []
                for op, sql in branch_sqls:
                    if result_parts:
                        result_parts.append(f'\n{op}\n')
                    result_parts.append(sql)
                combined = ''.join(result_parts)
                # Если все ветки одинаковые — показываем одно
                unique_sqls = list(dict.fromkeys(s for _, s in branch_sqls))
                if len(unique_sqls) == 1:
                    return unique_sqls[0]
                return combined

            # Колонка не найдена в SELECT CTE — заменяем только префикс на первую реальную таблицу
            if _amap:
                first_real = next(iter(_amap.values()))
                if lookup and first_real in lookup:
                    db_orig, schema_orig, name_orig = lookup[first_real]
                    ref = f"{db_orig}.{schema_orig}.{name_orig}"
                else:
                    tbl_parts = first_real.split('.')
                    ref = '.'.join(tbl_parts[-3:]) if len(tbl_parts) >= 3 else '.'.join(tbl_parts)
                return f'{ref}.{m.group(1)}'
            return m.group(0)  # fallback

        expression_sql = pattern.sub(replace_cte_ref, expression_sql)

    return expression_sql


def compute_column_lineage(catalog: dict, sql_transformations: list[dict], existing_tables: set = None) -> dict:
    """
    Строит граф зависимостей колонок (column_lineage) с помощью sqlglot.
    """
    print(f"   - Анализ {len(sql_transformations)} запросов для column lineage...")

    lookup = {}
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName": continue
        for schema_name, tables in schemas.items():
            # Пропускаем таблицы схемы public из lineage (они технические)
            if schema_name == 'public':
                continue
            for table_name, table_obj in tables.items():
                if "column_lineage" not in table_obj:
                    table_obj["column_lineage"] = {}

                full_key = f"{db_name}.{schema_name}.{table_name}".lower()
                lookup[full_key] = (db_name, schema_name, table_name)

    # Build schema for sqlglot to resolve * and ambiguous columns
    schema_dict = {}
    for key, (db, schema, table) in lookup.items():
        table_obj = catalog[db][schema][table]
        cols = {col["name"].lower(): "string" for col in table_obj.get("columns", [])}
        
        if db not in schema_dict:
            schema_dict[db] = {}
        if schema not in schema_dict[db]:
            schema_dict[db][schema] = {}
            
        schema_dict[db][schema][table] = cols

    from sqlglot.schema import MappingSchema
    sqlglot_schema = MappingSchema(schema_dict)
    schema_lookahead = _build_schema_lookahead(catalog)

    for item in sql_transformations:
        sql = item["query"]
        # default_db: база, из которой пришёл скрипт (для резолвинга таблиц без явного db)
        default_db = item.get("db_name", "dwh").lower()
        try:
            parsed = sqlglot.parse_one(sql, read="postgres")

            target_table = None
            if isinstance(parsed, exp.Create) and isinstance(parsed.this, exp.Table):
                target_table = _get_table_id(parsed.this, default_db)
            elif isinstance(parsed, exp.Insert):
                target_table = _get_table_id(parsed.this, default_db)

            if not target_table or target_table not in lookup:
                continue

            # --- Qualify columns to resolve table names ---
            try:
                parsed = qualify(parsed, schema=sqlglot_schema, dialect="postgres")
            except Exception:
                pass

            select_expr = parsed.expression
            # CREATE TABLE ... AS (SELECT ...) — sqlglot оборачивает SELECT в Subquery
            if isinstance(select_expr, exp.Subquery):
                select_expr = select_expr.this
            if not isinstance(select_expr, (exp.Select, exp.Union)):
                continue

            # Для UNION ALL: получаем все ветки SELECT
            # Имена колонок берём из первой ветки, expression_sql — из всех веток
            union_branches = _get_union_selects(select_expr)
            # Первая ветка используется для итерации по именам колонок и для lineage()
            first_select = union_branches[0] if union_branches else select_expr

            # Build alias mapping (реальные таблицы из FROM/JOIN, без CTE)
            # CTE-имена намеренно исключаем — они обрабатываются отдельно через cte_map
            alias_mapping = {}
            for tbl in parsed.find_all(exp.Table):
                if tbl is parsed.this: continue
                full_tid = _get_table_id(tbl, default_db)
                if full_tid:
                    if tbl.alias:
                        alias_mapping[tbl.alias.lower()] = full_tid
                    alias_mapping[tbl.name.lower()] = full_tid

            # Строим маппинг inline-view подзапросов: алиас → cte_info-подобная структура
            # Пример: SELECT u.col FROM (SELECT ... UNION SELECT ...) u
            # Здесь u — exp.Subquery с алиасом, а не exp.Table
            subquery_map = {}
            for subq in parsed.find_all(exp.Subquery):
                # Пропускаем подзапросы без алиаса (скалярные подзапросы и т.п.)
                if not subq.alias:
                    continue
                subq_alias = subq.alias.lower()
                subq_body = subq.this  # exp.Select или exp.Union
                if not isinstance(subq_body, (exp.Select, exp.Union)):
                    continue
                # Собираем таблицы внутри подзапроса
                subq_alias_map = {}
                for tbl in subq_body.find_all(exp.Table):
                    full_tid = _get_table_id(tbl, default_db)
                    if full_tid:
                        if tbl.alias:
                            subq_alias_map[tbl.alias.lower()] = full_tid
                        subq_alias_map[tbl.name.lower()] = full_tid
                subquery_map[subq_alias] = {'select': subq_body, 'alias_map': subq_alias_map}

            # Строим CTE-маппинг из qualified AST
            # With может быть как в parsed, так и в select_expr (зависит от версии sqlglot)
            cte_map = {}
            with_clause = parsed.find(exp.With) or select_expr.find(exp.With)
            if with_clause:
                # Первый проход: регистрируем все CTE с их прямыми таблицами
                for cte in with_clause.expressions:
                    cte_name = cte.alias.lower() if cte.alias else ''
                    cte_body = cte.this  # может быть exp.Select или exp.Union (UNION ALL)
                    if not cte_name or not isinstance(cte_body, (exp.Select, exp.Union)):
                        continue
                    # Собираем таблицы из всех веток (для UNION ALL — из каждой ветки)
                    cte_alias_map = {}
                    for tbl in cte_body.find_all(exp.Table):
                        full_tid = _get_table_id(tbl, default_db)
                        if full_tid:
                            if tbl.alias:
                                cte_alias_map[tbl.alias.lower()] = full_tid
                            cte_alias_map[tbl.name.lower()] = full_tid
                    cte_map[cte_name] = {'select': cte_body, 'alias_map': cte_alias_map}

                # Второй проход: рекурсивно разворачиваем ссылки CTE→CTE в alias_map.
                # Повторяем до тех пор, пока в alias_map не останется ни одной ссылки на другой CTE.
                # Это обрабатывает цепочки любой глубины: A→B→C→реальная_таблица.
                #
                # ВАЖНО: CTE-имена попадают в alias_map двумя способами:
                #   1. Ключ совпадает с именем CTE: ref_lower in cte_map
                #      (например, alias_map['account_calendar'] = 'dwh.account_calendar')
                #   2. Ключ — это алиас CTE (напр. 'a'), а значение — псевдо-ID вида 'dwh.cte_name'
                #      который _get_table_id построил из exp.Table с именем CTE.
                #      В этом случае последняя часть tid совпадает с именем CTE в cte_map.
                max_iterations = len(cte_map) + 1  # защита от циклических CTE
                for _ in range(max_iterations):
                    changed = False
                    for cte_name, cte_info in cte_map.items():
                        resolved_alias_map = {}
                        for ref, tid in cte_info['alias_map'].items():
                            ref_lower = ref.lower()
                            # Способ 1: ключ — имя CTE
                            target_cte = None
                            if ref_lower in cte_map and ref_lower != cte_name:
                                target_cte = ref_lower
                            else:
                                # Способ 2: значение tid — псевдо-ID для CTE
                                # (последняя часть пути совпадает с именем CTE)
                                tid_last = tid.split('.')[-1].lower()
                                if tid_last in cte_map and tid_last != cte_name:
                                    target_cte = tid_last
                            if target_cte:
                                # Разворачиваем ссылку на другой CTE
                                for inner_ref, inner_tid in cte_map[target_cte]['alias_map'].items():
                                    resolved_alias_map[inner_ref] = inner_tid
                                changed = True
                            else:
                                resolved_alias_map[ref] = tid
                        cte_info['alias_map'] = resolved_alias_map
                    if not changed:
                        break

            # Строим маппинг алиасов CTE: "ast" -> "account_stats"
            cte_alias_to_name = {}
            for tbl in parsed.find_all(exp.Table):
                if tbl is parsed.this: continue
                if tbl.alias and tbl.name.lower() in cte_map:
                    cte_alias_to_name[tbl.alias.lower()] = tbl.name.lower()

            # Удаляем из alias_mapping все ключи, которые являются именами или алиасами CTE.
            # Также удаляем ключи, чьи значения — псевдо-ID для CTE (напр. 'a' → 'dwh.daily_flows'),
            # которые _get_table_id построил из exp.Table с именем CTE.
            cte_keys_to_remove = set(cte_map.keys()) | set(cte_alias_to_name.keys())
            # Добавляем ключи с псевдо-ID: последняя часть значения совпадает с именем CTE
            for k, v in list(alias_mapping.items()):
                if v.split('.')[-1].lower() in cte_map:
                    cte_keys_to_remove.add(k)
            for k in cte_keys_to_remove:
                alias_mapping.pop(k, None)

            # Удаляем из alias_mapping алиасы inline-view подзапросов
            for k in subquery_map.keys():
                alias_mapping.pop(k, None)

            # Строим маппинг LATERAL-функций: алиас → раскрытое SQL-выражение тела функции.
            # Пример: CROSS JOIN LATERAL generate_series(a.open_date, ...) AS report_date
            # → lateral_map['report_date'] = 'generate_series(dds.account_detail.open_date, ...)'
            # Обходим всё дерево (включая CTE и подзапросы), поэтому работает для любого паттерна.
            lateral_map = {}
            for lat in parsed.find_all(exp.Lateral):
                lat_alias = lat.alias.lower() if lat.alias else ''
                if not lat_alias or lat.this is None:
                    continue
                lat_sql = _node_to_expr(lat.this)
                lat_sql = _strip_sql_comments(lat_sql)
                lat_sql = re.sub(r'"[A-Za-z0-9_]+"\.', lambda m: m.group(0).replace('"', ''), lat_sql)
                lat_sql = lat_sql.replace('"', '')
                # Раскрываем алиасы таблиц внутри тела lateral через alias_mapping
                for alias_key in sorted(alias_mapping.keys(), key=len, reverse=True):
                    full_tid = alias_mapping[alias_key]
                    if lookup and full_tid in lookup:
                        db_orig, schema_orig, name_orig = lookup[full_tid]
                        table_ref = f"{db_orig}.{schema_orig}.{name_orig}"
                    else:
                        table_parts = full_tid.split('.')
                        table_ref = '.'.join(table_parts[-3:]) if len(table_parts) >= 3 else '.'.join(table_parts)
                    lat_sql = re.sub(
                        rf'(?<![\w.])({re.escape(alias_key)})\.',
                        f'{table_ref}.',
                        lat_sql,
                        flags=re.IGNORECASE
                    )
                lateral_map[lat_alias] = lat_sql

            # Расширенный маппинг: алиасы CTE тоже считаются CTE-ссылками,
            # inline-view подзапросы раскрываются тем же механизмом.
            effective_cte = dict(cte_map)
            for a, cn in cte_alias_to_name.items():
                if cn in cte_map:
                    effective_cte[a] = cte_map[cn]
            effective_cte.update(subquery_map)

            # Предобрабатываем ветки UNION/UNION ALL:
            #   * локальный alias_map каждой ветки (алиасы могут повторяться между ветками);
            #   * WITH-клаузу из верхнего запроса — lineage() резолвит CTE через неё.
            # Каждая ветка сохраняется отдельно, чтобы источники колонок собирались
            # из ВСЕХ веток, а не только из первой (first_select).
            parsed_with = parsed.args.get("with")
            branch_infos = []
            for part in _get_union_parts(select_expr):
                if isinstance(part, str):
                    # оператор между ветками: 'UNION', 'UNION ALL', ...
                    branch_infos.append(part)
                    continue
                branch_alias_map = {}
                for tbl in part.find_all(exp.Table):
                    full_tid = _get_table_id(tbl, default_db)
                    if full_tid:
                        if tbl.alias:
                            branch_alias_map[tbl.alias.lower()] = full_tid
                        branch_alias_map[tbl.name.lower()] = full_tid
                # Убираем из локального маппинга алиасы CTE и subquery (раскрываются отдельно)
                cte_and_subq_keys = set(cte_map.keys()) | set(cte_alias_to_name.keys()) | set(subquery_map.keys())
                for k in list(branch_alias_map.keys()):
                    if k in cte_and_subq_keys:
                        del branch_alias_map[k]
                    elif branch_alias_map.get(k, '').split('.')[-1].lower() in cte_map:
                        del branch_alias_map[k]
                # Если ветка не содержит своих таблиц — fallback на глобальный alias_mapping
                effective_alias_map = branch_alias_map if branch_alias_map else alias_mapping
                branch = part
                if parsed_with and not branch.find(exp.With):
                    branch = part.copy()
                    branch.set("with", parsed_with)
                branch_infos.append({"select": branch, "alias_map": effective_alias_map})

            if parsed.args.get("with"):
                first_select.set("with", parsed.args.get("with"))

            # Получаем список колонок целевой таблицы для позиционного сопоставления
            db_t, schema_t, name_t = lookup[target_table]
            table_columns = [c["name"].lower() for c in catalog[db_t][schema_t][name_t].get("columns", [])]

            for i, select_item in enumerate(first_select.selects):
                alias = select_item.alias_or_name
                
                # Если алиаса нет (напр. в INSERT), берем имя колонки по позиции из метаданных
                if not alias and i < len(table_columns):
                    alias = table_columns[i]
                
                if not alias: continue

                # Собираем expression_sql из ВСЕХ веток UNION (с реальным оператором из AST)
                # Для обычного SELECT — одна ветка, результат тот же что раньше
                branch_expressions = []  # (operator_before, sql)
                pending_op = ''
                for bi in branch_infos:
                    if isinstance(bi, str):
                        pending_op = bi
                        continue
                    branch = bi['select']
                    if i >= len(branch.selects):
                        pending_op = ''
                        continue
                    branch_item = branch.selects[i]
                    if isinstance(branch_item, exp.Alias):
                        raw_expr_node = branch_item.this
                    else:
                        raw_expr_node = branch_item

                    branch_sql = _node_to_expr(raw_expr_node)
                    branch_sql = _strip_sql_comments(branch_sql)
                    # Убираем артефакты квалификации: "DWH"., "ods"., "dds". и кавычки вокруг имён БД
                    branch_sql = re.sub(r'"[A-Za-z0-9_]+"\.', lambda m: m.group(0).replace('"', ''), branch_sql)
                    branch_sql = branch_sql.replace('"', '')

                    # Локальный alias_map ветки уже посчитан заранее (branch_infos)
                    effective_alias_map = bi['alias_map']
                    branch_sql_lower = branch_sql.lower()

                    for alias_key in sorted(effective_alias_map.keys(), key=len, reverse=True):
                        if alias_key not in branch_sql_lower:
                            continue
                        full_tid = effective_alias_map[alias_key]
                        if lookup and full_tid in lookup:
                            db_orig, schema_orig, name_orig = lookup[full_tid]
                            table_ref = f"{db_orig}.{schema_orig}.{name_orig}"
                        else:
                            table_parts = full_tid.split('.')
                            table_ref = '.'.join(table_parts[-3:]) if len(table_parts) >= 3 else '.'.join(table_parts)
                        branch_sql = re.sub(
                            rf'(?<![\w.])({re.escape(alias_key)})\.{schema_lookahead}',
                            f'{table_ref}.',
                            branch_sql,
                            flags=re.IGNORECASE
                        )
                        branch_sql_lower = branch_sql.lower()

                    branch_sql = _resolve_cte_refs(branch_sql, cte_map, cte_alias_to_name, lookup, default_db, None, schema_lookahead)
                    # Раскрываем алиасы inline-view подзапросов (аналогично CTE)
                    branch_sql = _resolve_cte_refs(branch_sql, subquery_map, {}, lookup, default_db, None, schema_lookahead)
                    branch_expressions.append((pending_op, branch_sql))
                    pending_op = ''

                # Если все ветки дали одинаковое выражение — показываем одно
                unique_sqls = list(dict.fromkeys(s for _, s in branch_expressions))
                if len(unique_sqls) == 1:
                    expression_sql = unique_sqls[0]
                elif branch_expressions:
                    result_parts = []
                    for op, sql in branch_expressions:
                        if result_parts:
                            result_parts.append(f'\n{op}\n')
                        result_parts.append(sql)
                    expression_sql = ''.join(result_parts)
                else:
                    expression_sql = ''

                # Если expression_sql — это голый алиас LATERAL-функции (например, "report_date"),
                # подставляем раскрытое выражение тела функции из lateral_map.
                if expression_sql.strip().lower() in lateral_map:
                    expression_sql = lateral_map[expression_sql.strip().lower()]

                target_col = alias.lower()
                db_t, schema_t, name_t = lookup[target_table]
                col_lineage = catalog[db_t][schema_t][name_t]["column_lineage"]

                # Сохраняем выражение СРАЗУ, чтобы Вариант 1 мог его проанализировать
                if target_col not in col_lineage:
                    col_lineage[target_col] = {"expression": expression_sql, "sources": []}
                else:
                    col_lineage[target_col]["expression"] = expression_sql

                # Собираем источники ИЗ КАЖДОЙ ветки UNION (не только из первой).
                # Каждая ветка имеет свой alias_map и свой WITH-scope.
                source_columns = []
                for bi in branch_infos:
                    if isinstance(bi, str):
                        continue
                    branch = bi['select']
                    effective_alias_map = bi['alias_map']
                    if i >= len(branch.selects):
                        continue
                    branch_item = branch.selects[i]
                    if isinstance(branch_item, exp.Alias):
                        branch_raw = branch_item.this
                    else:
                        branch_raw = branch_item
                    # Имя колонки для lineage() берём из текущей ветки
                    branch_alias = branch_item.alias_or_name or alias

                    found = False
                    # ПРЯМОЕ разрешение ссылок на CTE/подзапрос с UNION-телом.
                    # Листья lineage() для такого случая квалифицируются веточным алиасом
                    # (напр. 'cc.client_id' при переиспользуемом 'cc' в обеих ветках),
                    # и глобальный alias_mapping затирает первую ветку последней.
                    # Поэтому для ссылок на union-подзапрос/CTE источники собираем через
                    # _resolve_cte_source_column (ветка = свой alias_map). Это авторитетно:
                    # если источников нет (все ветки — константы) — walk не запускаем.
                    try:
                        base_item = branch_item.this if isinstance(branch_item, exp.Alias) else branch_item
                        if isinstance(base_item, exp.Column) and base_item.table:
                            union_ref = None
                            cte_ref_info = effective_cte.get(base_item.table.lower())
                            if cte_ref_info:
                                cte_ref_body = cte_ref_info.get('select')
                                if isinstance(cte_ref_body, exp.Union) or len(_get_union_selects(cte_ref_body)) > 1:
                                    union_ref = base_item.table.lower()
                            if union_ref:
                                for resolved_cte in _resolve_cte_source_column(union_ref, base_item.name or alias, effective_cte, lookup, default_db):
                                    source_columns.append({"table": resolved_cte[0], "column": resolved_cte[1] or "*"})
                                    found = True
                                continue
                    except Exception:
                        pass

                    try:
                        node = lineage(branch_alias, branch, schema=sqlglot_schema, dialect="postgres")
                        # Если qualify сломался на уровне всего запроса, lineage может вернуть корень без downstream
                        if not node.downstream:
                            node_fallback = lineage(branch_alias, branch, dialect="postgres")
                            if node_fallback.downstream:
                                node = node_fallback

                        for n in node.walk():
                            if not n.downstream:
                                clean_name = n.name.replace('"', '').replace("'", "")
                                col_name = None
                                src_table = None

                                if '.' in clean_name:
                                    parts = clean_name.split('.')
                                    col_name = parts[-1]
                                    table_candidate = parts[-2].lower()

                                    if table_candidate in effective_alias_map:
                                        src_table = effective_alias_map[table_candidate]
                                    elif table_candidate in effective_cte:
                                        # CTE/подзапрос может содержать UNION — несколько источников (по ветке)
                                        for resolved_cte in _resolve_cte_source_column(table_candidate, col_name, effective_cte, lookup, default_db):
                                            source_columns.append({"table": resolved_cte[0], "column": resolved_cte[1] or "*"})
                                            found = True
                                        continue
                                    else:
                                        cand_db = parts[-3].lower() if len(parts) >= 3 and parts[-3].lower() in ("ods", "dds", "dm") else None
                                        matched = False
                                        if cand_db:
                                            for tid in lookup.keys():
                                                tid_parts = tid.split('.')
                                                if len(tid_parts) == 3 and tid_parts[0] == cand_db and tid_parts[2] == table_candidate:
                                                    src_table = tid
                                                    matched = True
                                                    break
                                        if not matched:
                                            for tid in lookup.keys():
                                                if tid.split('.')[-1] == table_candidate:
                                                    src_table = tid
                                                    break
                                else:
                                    col_name = clean_name
                                    if hasattr(n, 'source') and isinstance(n.source, exp.Table):
                                        src_table = _get_table_id(n.source, default_db)
                                    elif hasattr(n, 'expression') and isinstance(n.expression, exp.Column):
                                        # Реальная колонка-источник (не алиас вывода типа client_name)
                                        col_name = n.expression.name
                                        if n.expression.table:
                                            tbl_ref = n.expression.table.lower()
                                            if tbl_ref in effective_alias_map:
                                                src_table = effective_alias_map.get(tbl_ref)
                                            elif tbl_ref in effective_cte:
                                                for resolved_cte in _resolve_cte_source_column(tbl_ref, col_name, effective_cte, lookup, default_db):
                                                    source_columns.append({"table": resolved_cte[0], "column": resolved_cte[1] or "*"})
                                                    found = True
                                                continue
                                            else:
                                                for tid in lookup.keys():
                                                    if tid.split('.')[-1] == tbl_ref:
                                                        src_table = tid
                                                        break

                                if src_table:
                                    source_columns.append({"table": src_table, "column": col_name or "*"})
                                    found = True
                    except Exception:
                        pass

                    # FALLBACK для этой ветки: если lineage не нашел колонок — ищем в самом выражении
                    if not found and branch_raw:
                        try:
                            for col_node in branch_raw.find_all(exp.Column):
                                col_name = col_node.name
                                col_table_alias = col_node.table.lower() if col_node.table else None
                                src_table = None
                                cte_appended = False

                                if col_table_alias:
                                    if col_table_alias in effective_alias_map:
                                        src_table = effective_alias_map[col_table_alias]
                                    elif col_table_alias in effective_cte:
                                        for resolved_cte in _resolve_cte_source_column(col_table_alias, col_name, effective_cte, lookup, default_db):
                                            source_columns.append({"table": resolved_cte[0], "column": resolved_cte[1]})
                                            found = True
                                        cte_appended = True
                                    else:
                                        for tid in lookup.keys():
                                            if tid.split('.')[-1] == col_table_alias:
                                                src_table = tid
                                                break
                                if src_table and col_name and not cte_appended:
                                    source_columns.append({"table": src_table, "column": col_name})
                                    found = True
                        except Exception:
                            pass

                if source_columns:
                    for sc in source_columns:
                        tbl_key = sc["table"]
                        if tbl_key in lookup:
                            db_s, schema_s, name_s = lookup[tbl_key]
                            src_tbl_str = f"{db_s}.{schema_s}.{name_s}"
                        else:
                            src_tbl_str = tbl_key
                        entry = {"source_table": src_tbl_str, "source_column": sc["column"]}
                        if entry not in col_lineage[target_col]["sources"]:
                            col_lineage[target_col]["sources"].append(entry)
        except Exception as e:
            print(f"   [Column Lineage Warning] Ошибка расчета для {target_table}: {e}")
            continue
    return catalog


def _is_constant_expression(expression_sql: str) -> bool:
    """
    Возвращает True если выражение колонки является константой или системной функцией
    (не зависит ни от какой таблицы-источника).
    Примеры: CURRENT_DATE, NOW(), CURRENT_TIMESTAMP, TRUE, FALSE, 'literal', 42, NULL.
    """
    if not expression_sql:
        return False
    expr = expression_sql.strip()
    # Системные функции/константы PostgreSQL без аргументов
    SYSTEM_CONSTANTS = {
        'current_date', 'current_time', 'current_timestamp', 'localtime',
        'localtimestamp', 'now()', 'clock_timestamp()', 'statement_timestamp()',
        'transaction_timestamp()', 'timeofday()', 'true', 'false', 'null',
    }
    if expr.lower() in SYSTEM_CONSTANTS:
        return True
    # Числовой литерал (целый или дробный, возможно отрицательный)
    if re.match(r'^-?\d+(\.\d+)?$', expr):
        return True
    # Строковый литерал: 'текст'
    if re.match(r"^'[^']*'$", expr):
        return True
    # Попытка распарсить и проверить что нет ни одной колонки/таблицы
    try:
        parsed = sqlglot.parse_one(expr, read="postgres")
        if list(parsed.find_all(exp.Column)):
            return False
        if list(parsed.find_all(exp.Table)):
            return False
        # Агрегатные и оконные функции зависят от данных таблицы — константами не считаем
        # (например COUNT(*), MAX(COUNT(*)), row_number() over (...))
        if list(parsed.find_all(exp.AggFunc)) or list(parsed.find_all(exp.Window)):
            return False
        # Есть только литералы, функции без аргументов-колонок — считаем константой
        return True
    except Exception:
        return False


def compute_column_sources(catalog: dict, source_system_map: dict = None) -> dict:
    """
    Для каждой колонки рекурсивно вычисляет оригинальные источники.
    source_system_map: словарь {prefix_lower -> system_name} из dds.core.ref_source_system.
    Если передан — префиксы ODS-таблиц заменяются на человекочитаемые названия.
    """
    if source_system_map is None:
        source_system_map = {}

    def resolve_source_name(prefix: str) -> str:
        """Возвращает человекочитаемое название системы или сам префикс если не найден."""
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
                for col_obj in table_obj.get("columns", []):
                    col_name = col_obj["name"]
                    sources = set()
                    visited = set()

                    def dfs(t_id, c_name):
                        state = (t_id.lower(), c_name.lower())
                        if state in visited: return
                        visited.add(state)
                        t_info = lookup.get(state[0])
                        col_lineage = t_info.get("column_lineage", {}) if t_info else {}
                        
                        entry = col_lineage.get(c_name)
                        if not entry:
                            for k, v in col_lineage.items():
                                if k.lower() == c_name.lower():
                                    entry = v
                                    break
                        
                        upstream_cols = entry.get("sources", []) if isinstance(entry, dict) else []
                        if not upstream_cols:
                            parts = state[0].split(".")
                            # parts = [db, schema, table] или [db, table]
                            t_db     = parts[0].lower() if len(parts) >= 2 else ""
                            t_schema = parts[-2].lower() if len(parts) >= 2 else ""
                            t_name   = parts[-1].lower() if parts else ""

                            # Если выражение колонки — константа или системная функция
                            # (CURRENT_DATE, NOW(), литерал и т.д.) — источника нет, ставим прочерк
                            expr_for_check = entry.get("expression", "") if isinstance(entry, dict) else ""
                            if _is_constant_expression(expr_for_check):
                                sources.add("-")
                                return

                            # Источниками считаем: схема ods (старая структура) или база ods (новая)
                            is_ods_source = (t_schema == 'ods') or (t_db == 'ods')
                            if is_ods_source:
                                prefix = t_name.split("_")[0] if "_" in t_name else t_name
                                sources.add(resolve_source_name(prefix))
                            elif t_schema == 'core' and (t_name.startswith('ref_manual_') or t_name == 'ref_source_system'):
                                sources.add('РУЧ')
                            else:
                                # ВАРИАНТ 1: Анализируем само выражение колонки
                                # Пытаемся найти таблицы, упомянутые в коде этой колонки
                                t_info = lookup.get(state[0].lower())
                                col_lineage_entry = t_info.get("column_lineage", {}).get(c_name.lower()) if t_info else None
                                expr = col_lineage_entry.get("expression", "") if col_lineage_entry else ""
                                
                                found_via_expr = False
                                if expr:
                                    try:
                                        # Парсим выражение и ищем в нем упоминания таблиц
                                        expr_parsed = sqlglot.parse_one(expr, read="postgres")
                                        for tbl_node in expr_parsed.find_all(exp.Table):
                                            tbl_id = _get_table_id(tbl_node, t_db)
                                            if tbl_id in lookup:
                                                t_src_info = lookup[tbl_id]
                                                if t_src_info.get("sources"):
                                                    for s in t_src_info["sources"].split(", "):
                                                        if s.strip(): 
                                                            sources.add(s.strip())
                                                            found_via_expr = True
                                    except:
                                        pass
                                
                                # Если по выражению ничего не нашли, только тогда берем источники всей таблицы
                                if not found_via_expr:
                                    if t_info and t_info.get("sources"):
                                        for s in t_info["sources"].split(", "):
                                            if s.strip():
                                                sources.add(s.strip())
                        else:
                            for up in upstream_cols:
                                # Если в качестве колонки указана *, это значит 
                                # нам важна сама таблица-источник, а не конкретное поле.
                                if up["source_column"] == "*":
                                    t_up_info = lookup.get(up["source_table"].lower())
                                    if t_up_info and t_up_info.get("sources"):
                                        for s in t_up_info["sources"].split(", "):
                                            if s.strip(): sources.add(s.strip())
                                else:
                                    dfs(up["source_table"], up["source_column"])

                    dfs(f"{db_name}.{schema_name}.{table_name}", col_name)
                    # Если среди источников есть и реальные и прочерк — убираем прочерк
                    real_sources = {s for s in sources if s != "-"}
                    if real_sources:
                        col_obj["sources"] = ", ".join(sorted(real_sources))
                    elif sources == {"-"}:
                        col_obj["sources"] = "-"
                    else:
                        col_obj["sources"] = ""

    # Формируем sources на уровне таблицы — объединяем уникальные источники всех колонок
    for db_name, schemas in catalog.items():
        if db_name == "CorpusName": continue
        for schema_name, tables in schemas.items():
            if schema_name == 'public':
                continue
            for table_name, table_obj in tables.items():
                table_sources = set()
                for col_obj in table_obj.get("columns", []):
                    if col_obj.get("sources"):
                        for s in col_obj["sources"].split(", "):
                            if s.strip() and s.strip() != "-":
                                table_sources.add(s.strip())
                if table_sources:
                    table_obj["sources"] = ", ".join(sorted(table_sources))

    return catalog
