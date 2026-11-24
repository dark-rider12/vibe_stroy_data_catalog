#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MODULE: diagnose_lineage.py
ROLE: Автономная утилита глубокой диагностики и безопасного (обезличенного) экспорта
      сбоев Expression Lineage и Column Lineage на промышленных базах данных.

ИСПОЛЬЗОВАНИЕ:
  1. По полному имени целевой таблицы:
     python diagnose_lineage.py --table dm.core.contract_account_link

  2. По файлу скрипта:
     python diagnose_lineage.py --sql-file path/to/script.sql --table dm.core.contract_account_link

  3. Автопоиск всех проблемных запросов в sql_inventory:
     python diagnose_lineage.py --scan-broken

РЕЗУЛЬТАТ:
  Создает файл lineage_diagnostic_report.txt, полностью очищенный от чувствительных
  данных (таблицы -> TAB_1, колонки -> COL_1, строки -> 'STR_1', ошибки маскированы),
  готовый для отправки разработчику в чат.
"""

import os
import sys
import re
import json
import argparse
import traceback
from typing import Dict, List, Tuple, Any, Optional, Set

# Настройка кодировки вывода для консолей Windows
if sys.platform == "win32":
    import io
    if hasattr(sys.stdout, "buffer") and sys.stdout.buffer is not None:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "buffer") and sys.stderr.buffer is not None:
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

import sqlglot
from sqlglot import exp
from sqlglot.lineage import lineage
from sqlglot.optimizer.qualify import qualify
from sqlglot.schema import MappingSchema

from lineage.table_lineage import _get_table_id
from lineage.column_lineage import (
    _node_to_expr,
    _strip_sql_comments,
    _get_union_selects,
    _get_union_parts,
    _is_constant_expression,
    _build_schema_lookahead,
    _resolve_cte_refs,
    _resolve_cte_source_column,
    _init_column_lineage_worker,
    _analyze_single_query_lineage,
)
from sql_loader import _normalize_foreign_tables


# =====================================================================
# ОЧИСТКА КОММЕНТАРИЕВ (COMMENT STRIPPER / DATA PROTECTION)
# =====================================================================

def strip_sql_comments(sql: str) -> str:
    """
    Удаляет однострочные (--) и многострочные (/* */) комментарии из SQL,
    гарантируя отсутствие чувствительных данных и сохраняя строковые литералы
    (в одинарных, двойных и доллар-кавычках) и структуру строк.
    """
    if not sql:
        return ""
    result = []
    i = 0
    length = len(sql)
    in_single_quote = False
    in_double_quote = False
    in_dollar_quote = False
    dollar_tag = ""
    in_line_comment = False
    in_block_comment = False

    while i < length:
        char = sql[i]
        next_char = sql[i + 1] if i + 1 < length else ""

        # Внутри строчного комментария --
        if in_line_comment:
            if char in "\r\n":
                in_line_comment = False
                result.append(char)
            i += 1
            continue

        # Внутри блочного комментария /* ... */
        if in_block_comment:
            if char == "*" and next_char == "/":
                in_block_comment = False
                i += 2
            else:
                if char in "\r\n":
                    result.append(char)  # сохраняем перевод строки для точности номеров строк
                i += 1
            continue

        # Проверка dollar-quoted strings: $tag$...$tag$ или $$...$$
        if not in_single_quote and not in_double_quote and not in_dollar_quote:
            if char == "$":
                m = re.match(r"^\$([a-zA-Z0-9_]*)\$", sql[i:])
                if m:
                    dollar_tag = m.group(0)
                    in_dollar_quote = True
                    result.append(dollar_tag)
                    i += len(dollar_tag)
                    continue
        elif in_dollar_quote:
            if sql[i:].startswith(dollar_tag):
                result.append(dollar_tag)
                i += len(dollar_tag)
                in_dollar_quote = False
                dollar_tag = ""
                continue
            result.append(char)
            i += 1
            continue

        # Начало комментариев (вне строк)
        if not in_single_quote and not in_double_quote and not in_dollar_quote:
            if char == "-" and next_char == "-":
                in_line_comment = True
                i += 2
                continue
            if char == "/" and next_char == "*":
                in_block_comment = True
                i += 2
                continue

        result.append(char)

        # Обработка строк в одинарных кавычках
        if char == "'" and not in_double_quote and not in_dollar_quote:
            if in_single_quote and next_char == "'":
                result.append(next_char)
                i += 2
                continue
            in_single_quote = not in_single_quote
        # Обработка строк в двойных кавычках
        elif char == '"' and not in_single_quote and not in_dollar_quote:
            if in_double_quote and next_char == '"':
                result.append(next_char)
                i += 2
                continue
            in_double_quote = not in_double_quote

        i += 1

    return "".join(result)


# =====================================================================
# ДЕТЕРМИНИРОВАННЫЙ ОБЕЗЛИЧИВАТЕЛЬ (ANONYMIZER / SANITIZER)
# =====================================================================

SQL_RESERVED_KEYWORDS = {
    'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
    'CROSS', 'ON', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'NULLS',
    'FIRST', 'LAST', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'ALL',
    'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT',
    'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'EXISTS', 'WITH', 'RECURSIVE',
    'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'VIEW',
    'DROP', 'ALTER', 'ADD', 'COLUMN', 'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN',
    'REFERENCES', 'CHECK', 'DEFAULT', 'UNIQUE', 'OVER', 'PARTITION', 'WINDOW',
    'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW',
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'ROUND', 'CAST',
    'TRUE', 'FALSE', 'DATE', 'TIMESTAMP', 'INTERVAL', 'EXTRACT', 'NOW', 'DAY',
    'MONTH', 'YEAR', 'HOUR', 'MINUTE', 'SECOND', 'ROW_NUMBER', 'DENSE_RANK', 'RANK'
}


class SqlSanitizer:
    """
    Обезличивает SQL-запросы, метаданные и сообщения об ошибках,
    заменяя имена реальных сущностей на синтетические токены.
    """
    def __init__(self, target_table_id: str = ""):
        self.target_table_id = target_table_id.lower()
        self.db_map: Dict[str, str] = {}
        self.schema_map: Dict[str, str] = {}
        self.table_map: Dict[str, str] = {}
        self.column_map: Dict[str, str] = {}
        self.cte_map: Dict[str, str] = {}
        self.alias_map: Dict[str, str] = {}
        self.string_map: Dict[str, str] = {}

        if self.target_table_id:
            parts = self.target_table_id.split(".")
            if len(parts) == 3:
                self.get_db(parts[0])
                self.get_schema(parts[1])
                self.table_map[parts[2]] = "TAB_TARGET"
            elif len(parts) == 2:
                self.get_schema(parts[0])
                self.table_map[parts[1]] = "TAB_TARGET"
            else:
                self.table_map[parts[0]] = "TAB_TARGET"

    def get_db(self, name: str) -> str:
        k = name.lower()
        if k not in self.db_map:
            self.db_map[k] = f"DB_{len(self.db_map) + 1}"
        return self.db_map[k]

    def get_schema(self, name: str) -> str:
        k = name.lower()
        if k not in self.schema_map:
            self.schema_map[k] = f"SCH_{len(self.schema_map) + 1}"
        return self.schema_map[k]

    def get_table(self, name: str) -> str:
        k = name.lower()
        if k not in self.table_map:
            self.table_map[k] = f"TAB_{len(self.table_map) + 1}"
        return self.table_map[k]

    def get_cte(self, name: str) -> str:
        k = name.lower()
        if k not in self.cte_map:
            self.cte_map[k] = f"CTE_{len(self.cte_map) + 1}"
        return self.cte_map[k]

    def get_column(self, name: str) -> str:
        k = name.lower()
        if k in SQL_RESERVED_KEYWORDS:
            return name
        if k not in self.column_map:
            self.column_map[k] = f"COL_{len(self.column_map) + 1}"
        return self.column_map[k]

    def get_alias(self, name: str) -> str:
        k = name.lower()
        if k not in self.alias_map:
            self.alias_map[k] = f"A_{len(self.alias_map) + 1}"
        return self.alias_map[k]

    def get_string(self, text: str) -> str:
        if text not in self.string_map:
            self.string_map[text] = f"STR_{len(self.string_map) + 1}"
        return self.string_map[text]

    def register_cte_names(self, ctes: Set[str]):
        for c in ctes:
            self.get_cte(c)

    def register_tables_and_columns(self, lookup: Dict[str, Any], table_columns_map: Dict[str, List[str]]):
        for full_id in lookup.keys():
            parts = full_id.split(".")
            if len(parts) == 3:
                self.get_db(parts[0])
                self.get_schema(parts[1])
                self.get_table(parts[2])
            cols = table_columns_map.get(full_id, [])
            for c in cols:
                self.get_column(c)

    def sanitize_text(self, text: str) -> str:
        """Обезличивает произвольный текст (ошибки, трейсы, выражения)."""
        if not text:
            return ""
        # Замена полных путей таблиц: db.schema.table
        for orig, anon in sorted(self.table_map.items(), key=lambda x: len(x[0]), reverse=True):
            pattern = rf'(?<![A-Za-z0-9_]){re.escape(orig)}(?![A-Za-z0-9_])'
            text = re.sub(pattern, anon, text, flags=re.IGNORECASE)
        for orig, anon in sorted(self.cte_map.items(), key=lambda x: len(x[0]), reverse=True):
            pattern = rf'(?<![A-Za-z0-9_]){re.escape(orig)}(?![A-Za-z0-9_])'
            text = re.sub(pattern, anon, text, flags=re.IGNORECASE)
        for orig, anon in sorted(self.column_map.items(), key=lambda x: len(x[0]), reverse=True):
            pattern = rf'(?<![A-Za-z0-9_]){re.escape(orig)}(?![A-Za-z0-9_])'
            text = re.sub(pattern, anon, text, flags=re.IGNORECASE)
        for orig, anon in sorted(self.schema_map.items(), key=lambda x: len(x[0]), reverse=True):
            pattern = rf'(?<![A-Za-z0-9_]){re.escape(orig)}(?![A-Za-z0-9_])'
            text = re.sub(pattern, anon, text, flags=re.IGNORECASE)
        for orig, anon in sorted(self.db_map.items(), key=lambda x: len(x[0]), reverse=True):
            pattern = rf'(?<![A-Za-z0-9_]){re.escape(orig)}(?![A-Za-z0-9_])'
            text = re.sub(pattern, anon, text, flags=re.IGNORECASE)
        return text

    def sanitize_sql_ast(self, ast_node) -> str:
        """Клонирует AST и рекурсивно обезличивает все узлы."""
        if not ast_node:
            return ""
        copied = ast_node.copy()
        
        # 0. Удаление всех комментариев из AST-узлов для защиты чувствительных данных
        for node in copied.walk():
            if hasattr(node, "comments") and node.comments:
                node.comments = None

        # 1. Замена строковых литералов
        for lit in copied.find_all(exp.Literal):
            if lit.is_string:
                lit.set("this", self.get_string(lit.this))

        # 2. Обезличивание CTE
        with_clause = copied.find(exp.With)
        if with_clause:
            for cte in with_clause.expressions:
                if cte.alias:
                    cte_anon = self.get_cte(cte.alias)
                    cte.set("alias", exp.TableAlias(this=exp.to_identifier(cte_anon)))

        # 3. Обезличивание таблиц и алиасов
        for tbl in copied.find_all(exp.Table):
            t_name = tbl.name.lower()
            if t_name in self.cte_map:
                tbl.set("this", exp.to_identifier(self.get_cte(t_name)))
            else:
                tbl.set("this", exp.to_identifier(self.get_table(t_name)))

            if tbl.db:
                tbl.set("db", exp.to_identifier(self.get_schema(tbl.db)))
            if tbl.catalog:
                tbl.set("catalog", exp.to_identifier(self.get_db(tbl.catalog)))
            if tbl.alias:
                tbl.set("alias", exp.TableAlias(this=exp.to_identifier(self.get_alias(tbl.alias))))

        # 3a. Обезличивание алиасов подзапросов и LATERAL
        for subq in copied.find_all(exp.Subquery):
            if subq.alias:
                subq.set("alias", exp.TableAlias(this=exp.to_identifier(self.get_alias(subq.alias))))
        for lat in copied.find_all(exp.Lateral):
            if lat.alias:
                lat.set("alias", exp.TableAlias(this=exp.to_identifier(self.get_alias(lat.alias))))

        # 4. Обезличивание колонок
        for col in copied.find_all(exp.Column):
            c_name = col.name.lower()
            col.set("this", exp.to_identifier(self.get_column(c_name)))
            if col.table:
                tbl_ref = col.table.lower()
                if tbl_ref in self.alias_map:
                    col.set("table", exp.to_identifier(self.alias_map[tbl_ref]))
                elif tbl_ref in self.cte_map:
                    col.set("table", exp.to_identifier(self.cte_map[tbl_ref]))
                elif tbl_ref in self.table_map:
                    col.set("table", exp.to_identifier(self.table_map[tbl_ref]))

        # 5. Обезличивание алиасов колонок
        for a in copied.find_all(exp.Alias):
            if a.alias:
                a.set("alias", exp.to_identifier(self.get_column(a.alias)))

        try:
            return copied.sql(dialect="postgres", pretty=True)
        except Exception:
            return str(copied)


# =====================================================================
# ИНСТРУМЕНТАЛЬНЫЙ ДИАГНОСТ (INSTRUMENTED LINEAGE TRACER)
# =====================================================================

class LineageTracer:
    def __init__(self, target_table_arg: str, sql_query: str, config: dict, db_connection=None):
        self.target_arg = target_table_arg.strip().lower()
        # Автоматическая фильтрация комментариев для защиты чувствительных данных
        self.raw_sql = strip_sql_comments(sql_query).strip()
        self.config = config
        self.db_conn = db_connection
        self.logs: List[str] = []
        self.sanitizer = SqlSanitizer(self.target_arg)

    def log(self, section: str, message: str, status: str = "INFO"):
        marker = {"INFO": "[·]", "OK": "[✓]", "WARN": "[!]", "ERR": "[✗]"}.get(status, "[ ]")
        self.logs.append(f"{marker} {section}: {message}")

    def run_diagnostics(self) -> str:
        self.log("INIT", f"Начало диагностики для объекта: '{self.target_arg}'")
        self.log("INIT", "Комментарии (-- и /* */) автоматически отфильтрованы (защита чувствительных данных)", "OK")
        self.log("INIT", f"Длина SQL-запроса (без комментариев): {len(self.raw_sql)} символов, строк: {len(self.raw_sql.splitlines())}")

        # 1. Определение целевого ID (db.schema.table)
        target_parts = self.target_arg.split(".")
        if len(target_parts) == 3:
            target_db, target_schema, target_table = target_parts
        elif len(target_parts) == 2:
            target_db, target_schema, target_table = self.config.get("databases", ["dm"])[0], target_parts[0], target_parts[1]
        else:
            target_db, target_schema, target_table = self.config.get("databases", ["dm"])[0], "core", target_parts[0]

        target_id = f"{target_db}.{target_schema}.{target_table}".lower()
        self.sanitizer = SqlSanitizer(target_id)

        # 2. Нормализация foreign tables
        normalized_sql = _normalize_foreign_tables(self.raw_sql, target_db)
        if normalized_sql != self.raw_sql:
            self.log("NORMALIZE", "Ссылки foreign tables (ext_ods/ext_dds) успешно нормализованы в dds.core/ods.core", "OK")
        else:
            self.log("NORMALIZE", "Ссылки foreign tables не обнаружены или не требовали изменений", "INFO")

        # 3. Синтаксический парсинг (sqlglot)
        parsed = None
        try:
            parsed = sqlglot.parse_one(normalized_sql, read="postgres")
            self.log("PARSE", f"SQL успешно распарсен sqlglot. Корневой узел: {type(parsed).__name__}", "OK")
        except Exception as e:
            err_msg = str(e).strip()
            self.log("PARSE", f"Критическая ошибка синтаксиса sqlglot.parse_one: {err_msg}", "ERR")
            return self.build_report(status="FAILED_PARSE", parsed=None)

        # Обработка exp.Block (безопасно для старых версий sqlglot)
        block_type = getattr(exp, "Block", None)
        if block_type and isinstance(parsed, block_type):
            self.log("PARSE", f"Скрипт содержит несколько команд (exp.Block). Число выражений: {len(parsed.expressions)}", "WARN")
            main_stmt = parsed.find((exp.Create, exp.Insert, exp.Select, exp.Union))
            if main_stmt:
                parsed = main_stmt
                self.log("PARSE", f"Извлечена основная DDL/DML инструкция: {type(parsed).__name__}", "OK")
            else:
                self.log("PARSE", "Не удалось найти Create/Insert/Select внутри блока!", "ERR")

        # 4. Проверка совпадения целевой таблицы
        parsed_target = None
        if isinstance(parsed, exp.Create) and isinstance(parsed.this, (exp.Table, exp.Schema)):
            parsed_target = _get_table_id(parsed.this, target_db)
        elif isinstance(parsed, exp.Insert):
            parsed_target = _get_table_id(parsed.this, target_db)
        elif isinstance(parsed, (exp.Select, exp.Union)):
            parsed_target = target_id

        self.log("TARGET", f"Целевая таблица из SQL: '{parsed_target}', ожидаемая: '{target_id}'", 
                 "OK" if parsed_target == target_id else "WARN")

        # 5. Извлечение WITH и анализ CTE
        select_expr = parsed.expression if isinstance(parsed, (exp.Create, exp.Insert)) else parsed
        if isinstance(select_expr, exp.Subquery):
            select_expr = select_expr.this

        if not isinstance(select_expr, (exp.Select, exp.Union)):
            self.log("STRUCTURE", f"Тело запроса не является Select или Union ({type(select_expr).__name__})", "ERR")
            return self.build_report(status="FAILED_NOT_SELECT", parsed=parsed)

        with_clause = parsed.find(exp.With) or select_expr.find(exp.With)
        cte_names = set()
        if with_clause:
            for cte in with_clause.expressions:
                if cte.alias:
                    cte_names.add(cte.alias.lower())
            self.sanitizer.register_cte_names(cte_names)
            self.log("CTE", f"Обнаружено {len(cte_names)} CTE блоков в запросе", "OK")
        else:
            self.log("CTE", "CTE (WITH) в запросе отсутствуют", "INFO")

        # 6. Извлечение физических таблиц и всех колонок из запроса
        phys_tables = set()
        for tbl in parsed.find_all(exp.Table):
            t_name = tbl.name.lower()
            if t_name not in cte_names and tbl is not getattr(parsed, 'this', None):
                tid = _get_table_id(tbl, target_db)
                if tid:
                    phys_tables.add(tid)
        self.log("TABLES", f"Физических таблиц-источников обнаружено: {len(phys_tables)}", "OK")

        # Регистрируем абсолютно ВСЕ имена колонок из AST в санитизатор для 100% защиты
        for c_node in parsed.find_all(exp.Column):
            if c_node.name:
                self.sanitizer.get_column(c_node.name.lower())
        for a_node in parsed.find_all(exp.Alias):
            if a_node.alias:
                self.sanitizer.get_column(a_node.alias.lower())

        # 7. Подготовка каталога метаданных (lookup, schema_dict, table_columns_map)
        lookup = {target_id: (target_db, target_schema, target_table)}
        schema_dict = {target_db: {target_schema: {target_table: {}}}}
        table_columns_map = {}

        # Извлекаем колонки целевой таблицы из первой ветки SELECT
        first_select = _get_union_selects(select_expr)[0] if _get_union_selects(select_expr) else select_expr
        out_cols = []
        for s in first_select.selects:
            a = s.alias_or_name
            if a:
                out_cols.append(a.lower())
                self.sanitizer.get_column(a.lower())
        table_columns_map[target_id] = out_cols
        schema_dict[target_db][target_schema][target_table] = {c: "string" for c in out_cols}

        # Если есть подключение к БД — загрузим реальные колонки для найденных таблиц
        if self.db_conn:
            self.fetch_real_metadata(phys_tables, lookup, schema_dict, table_columns_map)
        else:
            # Моделируем колонки источников
            for pt in phys_tables:
                parts = pt.split(".")
                if len(parts) == 3:
                    lookup[pt] = (parts[0], parts[1], parts[2])
                    schema_dict.setdefault(parts[0], {}).setdefault(parts[1], {})[parts[2]] = {"id": "string"}
                    table_columns_map[pt] = ["id"]

        self.sanitizer.register_tables_and_columns(lookup, table_columns_map)

        # 8. Проверка qualify
        try:
            sqlglot_schema = MappingSchema(schema_dict)
            _init_column_lineage_worker(lookup, schema_dict, _build_schema_lookahead(), table_columns_map)
            qualify(parsed.copy(), schema=sqlglot_schema, dialect="postgres")
            self.log("QUALIFY", "Схема sqlglot.qualify успешно валидирована без ошибок", "OK")
        except Exception as q_err:
            q_msg = str(q_err).strip().split("\n")[0]
            self.log("QUALIFY", f"sqlglot.qualify завершился с ошибкой: {q_msg} (сработает fallback)", "WARN")

        # 9. Запуск полного боевого анализатора _analyze_single_query_lineage
        item = {
            "target_table": target_table,
            "target_schema": target_schema,
            "db_name": target_db,
            "query": normalized_sql
        }
        res_target, col_lineage, warn = _analyze_single_query_lineage(item)

        if warn:
            self.log("ANALYZER", f"Предупреждение анализатора: {warn}", "WARN")

        if not col_lineage:
            self.log("ANALYZER", "Анализатор вернул ПУСТОЙ результат (0 колонок)!", "ERR")
            return self.build_report(status="FAILED_EMPTY_LINEAGE", parsed=parsed)

        total_cols = len(col_lineage)
        has_expr = sum(1 for c, d in col_lineage.items() if d.get("expression"))
        has_src = sum(1 for c, d in col_lineage.items() if d.get("sources"))

        self.log("ANALYZER", f"Итого колонок: {total_cols}, с выражениями: {has_expr}, с источниками: {has_src}", "OK")

        # 10. Детальный аудит колонок без выражений или источников
        problem_cols = []
        for col_name, data in col_lineage.items():
            expr = data.get("expression", "")
            srcs = data.get("sources", [])
            if not expr or not srcs:
                problem_cols.append({
                    "column": col_name,
                    "has_expression": bool(expr),
                    "expression_preview": expr[:120] if expr else "(пусто)",
                    "sources_count": len(srcs)
                })

        if problem_cols:
            self.log("AUDIT", f"Колонок требующих внимания: {len(problem_cols)}", "WARN")
        else:
            self.log("AUDIT", "Все колонки успешно рассчитаны и связаны с источниками!", "OK")

        return self.build_report(
            status="SUCCESS",
            parsed=parsed,
            col_lineage=col_lineage,
            problem_cols=problem_cols
        )

    def fetch_real_metadata(self, phys_tables: Set[str], lookup: dict, schema_dict: dict, table_columns_map: dict):
        """Загружает реальные колонки из PostgreSQL."""
        try:
            cursor = self.db_conn.cursor()
            for pt in phys_tables:
                parts = pt.split(".")
                if len(parts) != 3:
                    continue
                db_name, sc_name, tb_name = parts
                cursor.execute("""
                    SELECT column_name, data_type
                    FROM information_schema.columns
                    WHERE table_schema = %s AND table_name = %s
                """, (sc_name, tb_name))
                rows = cursor.fetchall()
                cols = [r[0].lower() for r in rows] if rows else ["id"]
                lookup[pt] = (db_name, sc_name, tb_name)
                schema_dict.setdefault(db_name, {}).setdefault(sc_name, {})[tb_name] = {c: "string" for c in cols}
                table_columns_map[pt] = cols
            self.log("METADATA", f"Загружены метаданные для {len(phys_tables)} таблиц из БД", "OK")
        except Exception as e:
            self.log("METADATA", f"Не удалось загрузить колонки из БД: {e}", "WARN")

    def build_report(self, status: str, parsed=None, col_lineage=None, problem_cols=None) -> str:
        out = []
        out.append("=" * 70)
        out.append("ОТЛАДОЧНЫЙ ОТЧЁТ LINEAGE (ПОЛНОСТЬЮ ОБЕЗЛИЧЕН)")
        out.append("=" * 70)
        out.append(f"СТАТУС ВЫПОЛНЕНИЯ: {status}")
        out.append(f"ЦЕЛЕВОЙ ОБЪЕКТ: {self.sanitizer.sanitize_text(self.target_arg)}")
        out.append("")
        out.append("--- [1. ЖУРНАЛ ШАГОВ АНАЛИЗАТОРА] ---")
        for line in self.logs:
            out.append(self.sanitizer.sanitize_text(line))

        if problem_cols:
            out.append("")
            out.append("--- [2. КОЛОНКИ С ОСОБЕННОСТЯМИ] ---")
            for pc in problem_cols:
                anon_col = self.sanitizer.get_column(pc["column"])
                expr_prev = self.sanitizer.sanitize_text(pc["expression_preview"])
                out.append(f"  • {anon_col}: expression={pc['has_expression']} (preview: {expr_prev}), sources={pc['sources_count']}")

        if col_lineage:
            out.append("")
            out.append("--- [3. ПРИМЕРЫ ВЫЧИСЛЕННЫХ ВЫРАЖЕНИЙ (ПЕРВЫЕ 5 КОЛОНОК)] ---")
            for k in list(col_lineage.keys())[:5]:
                anon_col = self.sanitizer.get_column(k)
                expr = self.sanitizer.sanitize_text(col_lineage[k].get("expression", "")[:150])
                srcs = [f"{self.sanitizer.sanitize_text(s.get('source_table'))}.{self.sanitizer.get_column(s.get('source_column'))}" 
                        for s in col_lineage[k].get("sources", [])]
                out.append(f"  • {anon_col}: sources={srcs}")
                out.append(f"      expr: {expr}")

        if parsed:
            out.append("")
            out.append("--- [4. ОБЕЗЛИЧЕННЫЙ ВОСПРОИЗВОДИМЫЙ SQL-СКРИПТ] ---")
            out.append(self.sanitizer.sanitize_sql_ast(parsed))

        out.append("")
        out.append("=" * 70)
        out.append("КОНЕЦ ОТЧЁТА (СКОПИРУЙТЕ ЭТОТ БЛОК И ПРИШЛИТЕ В ЧАТ)")
        out.append("=" * 70)
        return "\n".join(out)


# =====================================================================
# CLI ВХОДНАЯ ТОЧКА
# =====================================================================

def main():
    parser = argparse.ArgumentParser(description="Автономная диагностика Lineage для промышленных БД")
    parser.add_argument("--table", type=str, help="Полное имя таблицы (напр. dm.core.contract_account_link)")
    parser.add_argument("--sql-file", type=str, help="Путь к файлу с SQL-запросом (если не из БД)")
    parser.add_argument("--scan-broken", action="store_true", help="Найти в sql_inventory запросы с пустым lineage")
    parser.add_argument("--out", type=str, default="lineage_diagnostic_report.txt", help="Имя выходного файла отчёта")
    args = parser.parse_args()

    # Загрузка конфигурации
    config = {}
    try:
        from config import load_config
        config = load_config()
    except Exception:
        config = {"databases": ["dm", "dds", "ods"], "schemas": ["core", "calc"]}

    if not args.table and not args.sql_file and not args.scan_broken:
        print("[!] Ошибка: Укажите целевую таблицу через --table (напр. dm.core.contract_account_link)")
        print("    или укажите файл со скриптом через --sql-file path/to/script.sql")
        print("    или запустите сканирование через --scan-broken")
        sys.exit(1)

    sql_query = ""
    target_table = args.table or ""
    db_conn = None

    if args.sql_file:
        if not os.path.exists(args.sql_file):
            print(f"[!] Файл не найден: {args.sql_file}")
            sys.exit(1)
        with open(args.sql_file, "r", encoding="utf-8") as f:
            sql_query = strip_sql_comments(f.read())
    else:
        # Извлечение скрипта из public.sql_inventory
        parts = target_table.split(".")
        if len(parts) == 3:
            db_name, sc_name, tb_name = parts
        elif len(parts) == 2:
            db_name, sc_name, tb_name = config.get("databases", ["dm"])[0], parts[0], parts[1]
        else:
            db_name, sc_name, tb_name = config.get("databases", ["dm"])[0], "core", parts[0]

        try:
            from db import get_connection
            print(f"[*] Подключение к БД '{db_name}' для поиска скрипта таблицы '{sc_name}.{tb_name}'...")
            db_conn = get_connection(config, db_name)
            cursor = db_conn.cursor()
            cursor.execute("""
                SELECT query_text 
                FROM public.sql_inventory 
                WHERE lower(target_schema) = lower(%s) 
                  AND lower(target_table) = lower(%s)
                ORDER BY updated_at DESC LIMIT 1
            """, (sc_name, tb_name))
            row = cursor.fetchone()
            if row and row[0]:
                sql_query = strip_sql_comments(row[0])
                print(f"[✓] Скрипт найден в public.sql_inventory (комментарии удалены, длина {len(sql_query)} символов)")
            else:
                print(f"[!] Внимание: Скрипт для таблицы {sc_name}.{tb_name} не найден в базе {db_name}.public.sql_inventory.")
                print(f"    Проверьте базы: {config.get('databases', [])}")
                sys.exit(1)
        except Exception as e:
            print(f"[!] Ошибка подключения к БД: {e}")
            print("    Вы можете запустить диагностику напрямую из файла скрипта:")
            print(f"    python diagnose_lineage.py --table {target_table} --sql-file script.sql")
            sys.exit(1)

    tracer = LineageTracer(target_table, sql_query, config, db_conn)
    report_text = tracer.run_diagnostics()

    with open(args.out, "w", encoding="utf-8") as f:
        f.write(report_text)

    print("")
    print("=" * 65)
    print(f"✓ Диагностика успешно завершена!")
    print(f"✓ Безопасный обезличенный отчёт сохранён в файл: {args.out}")
    print("=" * 65)
    print("Вы можете открыть этот файл, скопировать его содержимое ('абракадабру')")
    print("и отправить сюда в чат для точной отладки парсера.")


if __name__ == "__main__":
    main()
