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
import io
import json
import logging
import argparse
import contextlib
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
from sqlglot import exp, TokenType
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
from generate_catalog import attach_sql_scripts, _extract_all_explicit_target_dbs


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
    'CROSS', 'NATURAL', 'LATERAL', 'ON', 'USING', 'GROUP', 'BY', 'HAVING', 'ORDER',
    'ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'LIMIT', 'OFFSET', 'FETCH', 'NEXT',
    'ONLY', 'UNION', 'INTERSECT', 'EXCEPT', 'ALL', 'DISTINCT', 'AS', 'CASE', 'WHEN',
    'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE',
    'SIMILAR', 'TO', 'BETWEEN', 'EXISTS', 'WITH', 'RECURSIVE', 'MATERIALIZED',
    'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'MERGE', 'CREATE',
    'REPLACE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'TABLE', 'VIEW', 'INDEX', 'IF',
    'DROP', 'ALTER', 'ADD', 'COLUMN', 'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN',
    'REFERENCES', 'CHECK', 'DEFAULT', 'UNIQUE', 'OVER', 'PARTITION', 'WINDOW',
    'ROWS', 'RANGE', 'GROUPS', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT',
    'ROW', 'FILTER', 'WITHIN', 'CAST', 'TRUE', 'FALSE', 'UNKNOWN', 'INTERVAL',
    'DAY', 'MONTH', 'YEAR', 'HOUR', 'MINUTE', 'SECOND', 'TIME', 'ZONE', 'AT',
    'WITHOUT', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTEGER', 'INT', 'INT2', 'INT4',
    'INT8', 'BIGINT', 'SMALLINT', 'DECIMAL', 'NUMERIC', 'REAL', 'FLOAT', 'DOUBLE',
    'PRECISION', 'BOOLEAN', 'BOOL', 'VARCHAR', 'CHAR', 'CHARACTER', 'VARYING',
    'TEXT', 'UUID', 'JSON', 'JSONB', 'BYTEA', 'ARRAY', 'DISTRIBUTED', 'RANDOMLY',
    'REPLICATED', 'TABLESPACE', 'DATA', 'NO', 'COMMIT', 'PRESERVE', 'TRUNCATE',
    'ANALYZE', 'CASCADE', 'RESTRICT', 'CONFLICT', 'DO', 'NOTHING', 'RETURNING',
    'FOR', 'ANY', 'SOME', 'ESCAPE', 'COLLATE', 'LATERAL'
}

SQL_BUILTIN_FUNCTIONS = {
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'ROUND', 'TRUNC',
    'FLOOR', 'CEIL', 'CEILING', 'ABS', 'MOD', 'POWER', 'SQRT', 'SIGN', 'GREATEST',
    'LEAST', 'ROW_NUMBER', 'DENSE_RANK', 'RANK', 'NTILE', 'LAG', 'LEAD',
    'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE', 'EXTRACT', 'DATE_TRUNC', 'DATE_PART',
    'TO_DATE', 'TO_CHAR', 'TO_TIMESTAMP', 'TO_NUMBER', 'AGE', 'NOW', 'CURRENT_DATE',
    'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP', 'CLOCK_TIMESTAMP',
    'STATEMENT_TIMESTAMP', 'TRANSACTION_TIMESTAMP', 'LOWER', 'UPPER', 'INITCAP',
    'TRIM', 'BTRIM', 'LTRIM', 'RTRIM', 'SUBSTRING', 'SUBSTR', 'LEFT', 'RIGHT',
    'LENGTH', 'CHAR_LENGTH', 'CHARACTER_LENGTH', 'OCTET_LENGTH', 'POSITION', 'STRPOS',
    'REPLACE', 'TRANSLATE', 'REGEXP_REPLACE', 'REGEXP_MATCH', 'REGEXP_MATCHES',
    'SPLIT_PART', 'CONCAT', 'CONCAT_WS', 'FORMAT', 'LPAD', 'RPAD', 'REPEAT', 'REVERSE',
    'GENERATE_SERIES', 'UNNEST', 'ARRAY_AGG', 'STRING_AGG', 'ARRAY_LENGTH',
    'JSON_BUILD_OBJECT', 'JSONB_BUILD_OBJECT', 'JSON_EXTRACT_PATH_TEXT',
    'JSONB_EXTRACT_PATH_TEXT', 'JSON_ARRAY_ELEMENTS', 'JSONB_ARRAY_ELEMENTS',
    'UUID_GENERATE_V5', 'UUID_GENERATE_V4', 'UUID_NIL', 'GEN_RANDOM_UUID',
    'HASHTEXT', 'MD5', 'SHA256', 'ENCODE', 'DECODE', 'PG_TYPEOF', 'EXISTS'
}

_STRING_TOKEN_TYPES = {
    getattr(TokenType, name)
    for name in (
        'STRING', 'BIT_STRING', 'HEX_STRING', 'BYTE_STRING',
        'NATIONAL_RAW_STRING', 'NATIONAL_STRING', 'RAW_STRING',
        'HEREDOC_STRING', 'UNICODE_STRING'
    )
    if hasattr(TokenType, name)
}

_IDENT_TOKEN_TYPES = {
    getattr(TokenType, name)
    for name in ('VAR', 'IDENTIFIER', 'UNICODE_IDENTIFIER', 'OBJECT_IDENTIFIER')
    if hasattr(TokenType, name)
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
        self.func_map: Dict[str, str] = {}
        self.token_map: Dict[str, str] = {}
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

    def get_func(self, name: str) -> str:
        k = name.lower()
        if k not in self.func_map:
            self.func_map[k] = f"FUNC_{len(self.func_map) + 1}"
        return self.func_map[k]

    def get_token(self, name: str) -> str:
        k = name.lower()
        if k in self.table_map:
            return self.table_map[k]
        if k in self.cte_map:
            return self.cte_map[k]
        if k in self.column_map:
            return self.column_map[k]
        if k in self.schema_map:
            return self.schema_map[k]
        if k in self.db_map:
            return self.db_map[k]
        if k in self.alias_map:
            return self.alias_map[k]
        if k in self.func_map:
            return self.func_map[k]
        if k not in self.token_map:
            self.token_map[k] = f"TOK_{len(self.token_map) + 1}"
        return self.token_map[k]

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

    def _mask_dollar_quotes(self, sql: str) -> str:
        """Заменяет dollar-quoted литералы ($tag$...$tag$, $$...$$) на 'STR_N' до токенизации."""
        if not sql or "$" not in sql:
            return sql
        out = []
        i = 0
        n = len(sql)
        in_sq = False
        in_dq = False
        while i < n:
            ch = sql[i]
            nxt = sql[i + 1] if i + 1 < n else ""
            if ch == "'" and not in_dq:
                out.append(ch)
                if in_sq and nxt == "'":
                    out.append(nxt)
                    i += 2
                    continue
                in_sq = not in_sq
                i += 1
                continue
            if ch == '"' and not in_sq:
                out.append(ch)
                if in_dq and nxt == '"':
                    out.append(nxt)
                    i += 2
                    continue
                in_dq = not in_dq
                i += 1
                continue
            if ch == "$" and not in_sq and not in_dq:
                m = re.match(r"^\$([A-Za-z0-9_]*)\$", sql[i:])
                if m:
                    tag = m.group(0)
                    end_pos = sql.find(tag, i + len(tag))
                    if end_pos != -1:
                        body = sql[i + len(tag):end_pos]
                        out.append(f"'{self.get_string(body)}'")
                        i = end_pos + len(tag)
                        continue
            out.append(ch)
            i += 1
        return "".join(out)

    def sanitize_raw_sql(self, sql: str) -> str:
        """
        Гарантированно обезличивает SQL через лексер sqlglot.tokenize (с regex-резервом),
        когда AST-парсер упал или откатился к exp.Command. Сохраняет структуру строк.
        """
        if not sql:
            return ""
        clean_sql = strip_sql_comments(sql)
        clean_sql = self._mask_dollar_quotes(clean_sql)

        try:
            tokens = sqlglot.tokenize(clean_sql, read="postgres")
        except Exception:
            # Резервная тотальная очистка по regex (если даже лексер упал на невалидных кавычках)
            masked = re.sub(r"'(?:''|[^'])*'", lambda m: f"'{self.get_string(m.group(0))}'", clean_sql)
            masked = re.sub(r'"(?:""|[^"])*"', lambda m: self.get_token(m.group(0).strip('"')), masked)
            def _mask_word(m):
                w = m.group(0)
                if w.upper() in SQL_RESERVED_KEYWORDS or w.upper() in SQL_BUILTIN_FUNCTIONS:
                    return w
                return self.get_token(w)
            return re.sub(r'[A-Za-z_А-Яа-яЁё][A-Za-z0-9_$А-Яа-яЁё]*', _mask_word, masked)

        replacements: List[Tuple[int, int, str]] = []
        num_tokens = len(tokens)
        for i, tok in enumerate(tokens):
            if tok.token_type in _STRING_TOKEN_TYPES:
                replacements.append((tok.start, tok.end, f"'{self.get_string(tok.text)}'"))
                continue

            if tok.token_type not in _IDENT_TOKEN_TYPES:
                continue

            word_upper = tok.text.upper()
            word_lower = tok.text.lower()
            is_unquoted_var = (tok.token_type == TokenType.VAR)

            if is_unquoted_var and word_upper in SQL_RESERVED_KEYWORDS:
                continue

            next_tok = tokens[i + 1] if i + 1 < num_tokens else None
            if next_tok and next_tok.token_type == TokenType.L_PAREN:
                if is_unquoted_var and word_upper in SQL_BUILTIN_FUNCTIONS:
                    continue
                replacements.append((tok.start, tok.end, self.get_func(word_lower)))
                continue

            prev_tok = tokens[i - 1] if i > 0 else None
            is_dot_prev = bool(prev_tok and prev_tok.token_type == TokenType.DOT)
            is_dot_next = bool(next_tok and next_tok.token_type == TokenType.DOT)
            next2 = tokens[i + 2] if i + 2 < num_tokens else None
            next3 = tokens[i + 3] if i + 3 < num_tokens else None
            next4 = tokens[i + 4] if i + 4 < num_tokens else None

            if not is_dot_prev and is_dot_next and next2 and next2.token_type in _IDENT_TOKEN_TYPES:
                if next3 and next3.token_type == TokenType.DOT and next4 and next4.token_type in _IDENT_TOKEN_TYPES:
                    # Минимум 3 компонента: db.schema.table[.col]
                    anon = self.get_db(word_lower) if word_lower not in self.schema_map else self.schema_map[word_lower]
                else:
                    # 2 компонента: alias.col или schema.table
                    if word_lower in self.cte_map:
                        anon = self.cte_map[word_lower]
                    elif word_lower in self.schema_map:
                        anon = self.schema_map[word_lower]
                    elif word_lower in self.table_map:
                        anon = self.table_map[word_lower]
                    elif prev_tok and prev_tok.token_type in (TokenType.FROM, TokenType.JOIN, TokenType.TABLE, TokenType.INTO):
                        anon = self.get_schema(word_lower)
                    else:
                        anon = self.get_alias(word_lower)
            elif is_dot_prev and is_dot_next:
                anon = self.get_schema(word_lower) if word_lower in self.schema_map or (
                    next2 and next2.token_type in _IDENT_TOKEN_TYPES and next3 and next3.token_type == TokenType.DOT
                ) else self.get_table(word_lower)
            elif is_dot_prev and not is_dot_next:
                prev2 = tokens[i - 2] if i >= 2 else None
                prev3 = tokens[i - 3] if i >= 3 else None
                if prev3 and prev3.token_type == TokenType.DOT:
                    # 3+ компонента: ...db.schema.table ИЛИ ...schema.table.col
                    prev4 = tokens[i - 4] if i >= 4 else None
                    prev5 = tokens[i - 5] if i >= 5 else None
                    if prev5 and prev5.token_type == TokenType.DOT:
                        anon = self.get_column(word_lower)
                    elif prev4 and prev4.token_type in (TokenType.FROM, TokenType.JOIN, TokenType.TABLE, TokenType.INTO):
                        anon = self.get_table(word_lower)
                    else:
                        anon = self.get_token(word_lower)
                else:
                    if prev2 and prev2.token_type in _IDENT_TOKEN_TYPES and (tokens[i - 3].token_type in (TokenType.FROM, TokenType.JOIN, TokenType.TABLE, TokenType.INTO) if i >= 3 else False):
                        anon = self.get_table(word_lower)
                    else:
                        anon = self.get_column(word_lower)
            else:
                anon = self.get_token(word_lower)

            replacements.append((tok.start, tok.end, anon))

        # Собираем результат с точным сохранением пробелов и переносов строк
        res = []
        cursor = 0
        for start, end, repl in replacements:
            if start < cursor:
                continue
            res.append(clean_sql[cursor:start])
            res.append(repl)
            cursor = end + 1
        res.append(clean_sql[cursor:])
        return "".join(res)

    def sanitize_text(self, text: str) -> str:
        """Обезличивает произвольный текст (ошибки, трейсы, выражения)."""
        if not text:
            return ""
        text = self._mask_dollar_quotes(text)
        text = re.sub(r"'(?:''|[^'])*'", lambda m: f"'{self.get_string(m.group(0))}'", text)
        for mapping in (
            self.table_map, self.cte_map, self.column_map,
            self.schema_map, self.db_map, self.alias_map,
            self.func_map, self.token_map,
        ):
            for orig, anon in sorted(mapping.items(), key=lambda x: len(x[0]), reverse=True):
                pattern = rf'(?<![A-Za-z0-9_]){re.escape(orig)}(?![A-Za-z0-9_])'
                text = re.sub(pattern, anon, text, flags=re.IGNORECASE)
        return text

    def sanitize_sql_ast(self, ast_node, fallback_sql: str = "") -> str:
        """Клонирует AST и рекурсивно обезличивает все узлы. Блокирует утечку через exp.Command."""
        if not ast_node:
            return self.sanitize_raw_sql(fallback_sql) if fallback_sql else ""

        # КРИТИЧЕСКАЯ ЗАЩИТА: exp.Command хранит сырой SQL в строковом виде (не в узлах Table/Column),
        # поэтому сериализация через .sql() вывела бы реальные имена таблиц/колонок без обезличивания.
        if isinstance(ast_node, exp.Command) or ast_node.find(exp.Command) is not None:
            raw_fallback = fallback_sql or str(ast_node)
            return self.sanitize_raw_sql(raw_fallback)

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
                else:
                    col.set("table", exp.to_identifier(self.get_alias(tbl_ref)))

        # 5. Обезличивание алиасов колонок
        for a in copied.find_all(exp.Alias):
            if a.alias:
                a.set("alias", exp.to_identifier(self.get_column(a.alias)))

        try:
            return copied.sql(dialect="postgres", pretty=True)
        except Exception:
            return self.sanitize_raw_sql(fallback_sql or str(copied))


# =====================================================================
# ИНСТРУМЕНТАЛЬНЫЙ ДИАГНОСТ (INSTRUMENTED LINEAGE TRACER)
# =====================================================================

class _SqlglotWarningCapture(logging.Handler):
    """Перехватывает логи sqlglot, чтобы сырой SQL из предупреждений не попадал в терминал."""
    def __init__(self):
        super().__init__()
        self.messages: List[str] = []

    def emit(self, record):
        try:
            self.messages.append(record.getMessage())
        except Exception:
            pass


class LineageTracer:
    def __init__(
        self,
        target_table_arg: str,
        sql_query: str,
        config: dict,
        db_connection=None,
        inventory_records: Optional[List[dict]] = None,
        existing_target_dbs: Optional[Set[str]] = None,
    ):
        self.target_arg = target_table_arg.strip().lower()
        # Автоматическая фильтрация комментариев для защиты чувствительных данных
        self.raw_sql = strip_sql_comments(sql_query).strip()
        self.last_normalized_sql = self.raw_sql
        self.config = config
        self.db_conn = db_connection
        self.inventory_records: List[dict] = inventory_records or []
        self.existing_target_dbs: Set[str] = {d.lower() for d in (existing_target_dbs or set())}
        self.logs: List[str] = []
        self.script_audit_logs: List[str] = []
        self.sanitizer = SqlSanitizer(self.target_arg)

    def log(self, section: str, message: str, status: str = "INFO"):
        marker = {"INFO": "[·]", "OK": "[✓]", "WARN": "[!]", "ERR": "[✗]"}.get(status, "[ ]")
        self.logs.append(f"{marker} {section}: {message}")

    def audit_log(self, section: str, message: str, status: str = "INFO"):
        marker = {"INFO": "[·]", "OK": "[✓]", "WARN": "[!]", "ERR": "[✗]"}.get(status, "[ ]")
        self.script_audit_logs.append(f"{marker} {section}: {message}")

    def audit_script_sources(self, target_db: str, target_schema: str, target_table: str):
        """
        Проверяет происхождение скрипта для вкладки «Скрипт»:
        - несоответствие явной БД в CREATE/INSERT и целевой БД диагностики;
        - записи в public.sql_inventory across all DBs и дубли;
        - симуляцию attach_sql_scripts для контроля того, какой именно скрипт попадёт в каталог.
        """
        # Регистрируем известные БД/схемы/таблицы в санитайзер
        self.sanitizer.get_db(target_db)
        self.sanitizer.get_schema(target_schema)
        for ex_db in self.existing_target_dbs:
            self.sanitizer.get_db(ex_db)
        for rec in self.inventory_records:
            if rec.get("db_name"):
                self.sanitizer.get_db(rec["db_name"])
            if rec.get("target_schema"):
                self.sanitizer.get_schema(rec["target_schema"])
            raw_t = (rec.get("target_table") or "").strip().lower().replace('"', '')
            if raw_t:
                for tp in raw_t.split("."):
                    if tp and tp not in self.sanitizer.db_map and tp not in self.sanitizer.schema_map:
                        self.sanitizer.get_table(tp)

        # 1. Проверка заголовка текущего диагностируемого SQL
        if self.raw_sql:
            header_dbs = _extract_all_explicit_target_dbs(self.raw_sql)
            for h_db in header_dbs:
                self.sanitizer.get_db(h_db)
            foreign_hdr = [d for d in header_dbs if d != target_db.lower()]
            if foreign_hdr:
                self.audit_log(
                    "CROSS_DB_HEADER",
                    f"В тексте SQL явно указана целевая БД '{foreign_hdr[0]}', отличная от диагностируемой '{target_db}'! "
                    f"При генерации каталога такой скрипт должен отклоняться.",
                    "ERR",
                )
            elif header_dbs:
                self.audit_log(
                    "SQL_HEADER",
                    f"Заголовок CREATE/INSERT явно соответствует целевой БД '{header_dbs[0]}'",
                    "OK",
                )
            else:
                self.audit_log(
                    "SQL_HEADER",
                    "В заголовке CREATE/INSERT БД не указана явно (будет подставлена БД таблицы-владельца)",
                    "INFO",
                )

        # 2. Межбазовый аудит public.sql_inventory и симуляция attach_sql_scripts
        if not self.inventory_records:
            return

        phys_str = ", ".join(sorted(self.existing_target_dbs)) if self.existing_target_dbs else "(не проверялось)"
        self.audit_log("PHYS_TABLES", f"Таблица '{target_schema}.{target_table}' физически присутствует в БД: [{phys_str}]", "INFO")
        self.audit_log("INVENTORY_SCAN", f"Всего найдено записей в public.sql_inventory по всем БД: {len(self.inventory_records)}", "INFO")

        same_db_rows = [r for r in self.inventory_records if (r.get("db_name") or "").lower() == target_db.lower()]
        other_db_rows = [r for r in self.inventory_records if (r.get("db_name") or "").lower() != target_db.lower()]
        if len(same_db_rows) > 1:
            self.audit_log(
                "DUPLICATE_INVENTORY",
                f"В БД '{target_db}' обнаружено {len(same_db_rows)} записей для этой таблицы (будет взята самая свежая по updated_at)",
                "WARN",
            )
        if not same_db_rows and other_db_rows:
            other_dbs_list = ", ".join(sorted({(r.get('db_name') or '').lower() for r in other_db_rows}))
            self.audit_log(
                "MISSING_IN_TARGET_DB",
                f"В '{target_db}.public.sql_inventory' нет скрипта для этой таблицы, но найдены одноименные записи в БД: [{other_dbs_list}]",
                "WARN",
            )

        for idx, rec in enumerate(self.inventory_records, 1):
            r_db = (rec.get("db_name") or "").lower()
            r_sc = (rec.get("target_schema") or "").lower()
            r_tb = (rec.get("target_table") or "").lower()
            r_upd = str(rec.get("updated_at") or "None")[:19]
            r_raw = rec.get("raw_query") or rec.get("query") or ""
            r_sql_dbs = _extract_all_explicit_target_dbs(r_raw)
            for sd in r_sql_dbs:
                self.sanitizer.get_db(sd)
            status_row = "OK"
            if r_sql_dbs and any(sd != r_db for sd in r_sql_dbs):
                status_row = "ERR"
            self.audit_log(
                "INVENTORY_ROW",
                f"#{idx}: db='{r_db}', schema='{r_sc}', table='{r_tb}', updated_at='{r_upd}', sql_target_dbs={r_sql_dbs or ['(не указана)']}",
                status_row,
            )

        # Симулируем attach_sql_scripts на мини-каталоге всех БД, где таблица есть
        sim_dbs = set(self.existing_target_dbs) | {target_db.lower()}
        sim_catalog: Dict[str, Any] = {}
        for sdb in sim_dbs:
            sim_catalog[sdb] = {
                target_schema: {
                    target_table: {
                        "type": "r",
                        "description": "",
                        "columns": [],
                        "lineage": {"upstream": set(), "downstream": set()},
                        "column_lineage": {},
                    }
                }
            }

        sim_buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(sim_buf):
                attach_sql_scripts(sim_catalog, [dict(r) for r in self.inventory_records])
        except Exception as sim_err:
            self.audit_log("ATTACH_SIMULATION", f"Ошибка симуляции attach_sql_scripts: {sim_err}", "ERR")
            return

        for w_line in sim_buf.getvalue().splitlines():
            w_clean = w_line.strip()
            if "[Attach Script Warning]" in w_clean:
                self.audit_log("ATTACH_WARNING", w_clean, "WARN")

        attached_script = sim_catalog.get(target_db.lower(), {}).get(target_schema, {}).get(target_table, {}).get("sql_script")
        if attached_script:
            attached_dbs = _extract_all_explicit_target_dbs(attached_script)
            first_line = self.sanitizer.sanitize_raw_sql(attached_script.splitlines()[0]) if attached_script.splitlines() else ""
            if attached_dbs and any(ad != target_db.lower() for ad in attached_dbs):
                self.audit_log(
                    "ATTACH_SIMULATION",
                    f"КРИТИЧЕСКАЯ ОШИБКА: во вкладку 'Скрипт' для '{target_db}' прикрепился скрипт чужой БД {attached_dbs}! Заголовок: {first_line}",
                    "ERR",
                )
            else:
                self.audit_log(
                    "ATTACH_SIMULATION",
                    f"Во вкладку 'Скрипт' прикрепится скрипт: {first_line}",
                    "OK",
                )
        else:
            self.audit_log(
                "ATTACH_SIMULATION",
                f"Ни один скрипт не прошёл фильтр для '{target_db}.{target_schema}.{target_table}' (будет показан авто-DDL)",
                "WARN",
            )

    def _split_sql_statements(self, sql: str) -> List[str]:
        """Разделяет SQL на инструкции по ';' вне строковых литералов."""
        stmts = []
        cur = []
        in_sq = False
        in_dq = False
        n = len(sql)
        i = 0
        while i < n:
            ch = sql[i]
            nxt = sql[i + 1] if i + 1 < n else ""
            if ch == "'" and not in_dq:
                cur.append(ch)
                if in_sq and nxt == "'":
                    cur.append(nxt)
                    i += 2
                    continue
                in_sq = not in_sq
            elif ch == '"' and not in_sq:
                cur.append(ch)
                if in_dq and nxt == '"':
                    cur.append(nxt)
                    i += 2
                    continue
                in_dq = not in_dq
            elif ch == ";" and not in_sq and not in_dq:
                stmt = "".join(cur).strip()
                if stmt:
                    stmts.append(stmt)
                cur = []
            else:
                cur.append(ch)
            i += 1
        tail = "".join(cur).strip()
        if tail:
            stmts.append(tail)
        return stmts

    def _diagnose_parse_failure(self, normalized_sql: str):
        """
        Безопасно (без утечек имён) локализует, какая часть скрипта вызвала откат
        к exp.Command или ошибку синтаксиса, чтобы облегчить отладку.
        """
        # Предварительно регистрируем все токены/строки через sanitize_raw_sql,
        # чтобы sanitize_text надёжно маскировал любые фрагменты в логах.
        anon_full = self.sanitizer.sanitize_raw_sql(normalized_sql)
        anon_lines = anon_full.splitlines()

        # Проверяем частые хвостовые конструкции Greenplum/PostgreSQL
        if re.search(r'\bDISTRIBUTED\s+(?:BY|RANDOMLY|REPLICATED)\b', normalized_sql, re.IGNORECASE):
            self.log("SYNTAX_HINT", "Обнаружена конструкция Greenplum 'DISTRIBUTED BY/RANDOMLY/REPLICATED', переводящая CTAS в Command", "WARN")
        if re.search(r'\bTABLESPACE\s+\w+', normalized_sql, re.IGNORECASE):
            self.log("SYNTAX_HINT", "Обнаружена конструкция 'TABLESPACE ...', переводящая CTAS в Command", "WARN")

        stmts = self._split_sql_statements(normalized_sql)
        if len(stmts) > 1:
            self.log("SYNTAX_HINT", f"Скрипт состоит из {len(stmts)} инструкций; проверяем каждую отдельно...", "INFO")
            for idx, st in enumerate(stmts, 1):
                try:
                    st_ast = sqlglot.parse_one(st, read="postgres")
                    if isinstance(st_ast, exp.Command):
                        self.log("SYNTAX_HINT", f"Инструкция #{idx} откатилась к exp.Command", "WARN")
                except Exception as st_err:
                    self.log("SYNTAX_HINT", f"Инструкция #{idx} упала с ошибкой: {str(st_err).splitlines()[0]}", "WARN")

        # Пытаемся проверить, не ломается ли парсинг из-за одного из CTE (WITH c1 AS (...), ...)
        lines = normalized_sql.splitlines()
        if len(lines) > 2:
            # Ищем минимальный префикс/суффикс или проверяем последний блок строк
            first_bad_tail = None
            # Проверяем отбрасывание хвоста (последние 1..min(15, len//2) строк)
            max_trim = min(15, max(1, len(lines) - 1))
            for k in range(1, max_trim + 1):
                candidate = "\n".join(lines[:-k]).strip()
                if not candidate:
                    break
                try:
                    test_ast = sqlglot.parse_one(candidate, read="postgres")
                    if not isinstance(test_ast, exp.Command):
                        first_bad_tail = len(lines) - k + 1
                        break
                except Exception:
                    continue
            if first_bad_tail is not None:
                snippet = " | ".join(anon_lines[first_bad_tail - 1:])
                self.log("SYNTAX_HINT", f"Без строк {first_bad_tail}-{len(lines)} скрипт парсится как AST! Проблемный хвост: {snippet[:200]}", "WARN")

    def run_diagnostics(self) -> str:
        sqlglot_logger = logging.getLogger("sqlglot")
        capture_handler = _SqlglotWarningCapture()
        prev_level = sqlglot_logger.level
        prev_handlers = list(sqlglot_logger.handlers)
        prev_propagate = sqlglot_logger.propagate
        sqlglot_logger.handlers = [capture_handler]
        sqlglot_logger.propagate = False
        sqlglot_logger.setLevel(logging.WARNING)

        try:
            return self._run_diagnostics_inner(capture_handler)
        finally:
            sqlglot_logger.handlers = prev_handlers
            sqlglot_logger.propagate = prev_propagate
            sqlglot_logger.setLevel(prev_level)

    def _run_diagnostics_inner(self, capture_handler: _SqlglotWarningCapture) -> str:
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
        self.audit_script_sources(target_db, target_schema, target_table)

        if not self.raw_sql:
            self.log("INIT", f"В БД '{target_db}' скрипт трансформации не обнаружен — диагностика ограничена аудитом источников", "WARN")
            return self.build_report(status="NO_SCRIPT_IN_TARGET_DB", parsed=None)

        # 2. Нормализация foreign tables
        normalized_sql = _normalize_foreign_tables(self.raw_sql, target_db)
        self.last_normalized_sql = normalized_sql
        if normalized_sql != self.raw_sql:
            self.log("NORMALIZE", "Ссылки foreign tables (ext_ods/ext_dds) успешно нормализованы в dds.core/ods.core", "OK")
        else:
            self.log("NORMALIZE", "Ссылки foreign tables не обнаружены или не требовали изменений", "INFO")

        # 3. Синтаксический парсинг (sqlglot)
        parsed = None
        try:
            parsed = sqlglot.parse_one(normalized_sql, read="postgres")
            if isinstance(parsed, exp.Command):
                self.log("PARSE", "sqlglot откатился к разбору как 'Command' (встречен неподдерживаемый синтаксис)", "WARN")
            else:
                self.log("PARSE", f"SQL успешно распарсен sqlglot. Корневой узел: {type(parsed).__name__}", "OK")
        except Exception as e:
            err_msg = str(e).strip()
            self.log("PARSE", f"Критическая ошибка синтаксиса sqlglot.parse_one: {err_msg}", "ERR")
            self._diagnose_parse_failure(normalized_sql)
            return self.build_report(status="FAILED_PARSE", parsed=None)

        if capture_handler.messages:
            self.log("PARSE", f"Перехвачены предупреждения sqlglot ({len(capture_handler.messages)} шт., сырой SQL скрыт)", "WARN")

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

        if isinstance(parsed, exp.Command) or parsed.find(exp.Command) is not None:
            self.log("STRUCTURE", f"Запрос разобран как Command — точный AST-анализ невозможен", "ERR")
            self._diagnose_parse_failure(normalized_sql)
            return self.build_report(status="FAILED_NOT_SELECT", parsed=parsed)

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
            self._diagnose_parse_failure(normalized_sql)
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
        # Вычисляем раздел 4 заранее: при откате к exp.Command или None
        # sanitize_raw_sql зарегистрирует все токены в sanitizer до очистки логов.
        sanitized_sql = ""
        if parsed is not None or self.last_normalized_sql:
            sanitized_sql = self.sanitizer.sanitize_sql_ast(parsed, fallback_sql=self.last_normalized_sql)

        out = []
        out.append("=" * 70)
        out.append("ОТЛАДОЧНЫЙ ОТЧЁТ LINEAGE (ПОЛНОСТЬЮ ОБЕЗЛИЧЕН)")
        out.append("=" * 70)
        out.append(f"СТАТУС ВЫПОЛНЕНИЯ: {status}")
        out.append(f"ЦЕЛЕВОЙ ОБЪЕКТ: {self.sanitizer.sanitize_text(self.target_arg)}")
        if self.script_audit_logs:
            out.append("")
            out.append("--- [0. АУДИТ ИСТОЧНИКОВ СКРИПТА (ВКЛАДКА «СКРИПТ»)] ---")
            for line in self.script_audit_logs:
                out.append(self.sanitizer.sanitize_text(line))
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

        if sanitized_sql:
            out.append("")
            out.append("--- [4. ОБЕЗЛИЧЕННЫЙ ВОСПРОИЗВОДИМЫЙ SQL-СКРИПТ] ---")
            out.append(sanitized_sql)

        out.append("")
        out.append("=" * 70)
        out.append("КОНЕЦ ОТЧЁТА (СКОПИРУЙТЕ ЭТОТ БЛОК И ПРИШЛИТЕ В ЧАТ)")
        out.append("=" * 70)
        return "\n".join(out)


# =====================================================================
# CLI ВХОДНАЯ ТОЧКА
# =====================================================================

def _collect_cross_db_inventory(config: dict, primary_db: str, sc_name: str, tb_name: str) -> Tuple[List[dict], Set[str]]:
    """
    Сканирует public.sql_inventory и information_schema.tables по всем БД из конфигурации,
    чтобы обнаружить дубли и межбазовые коллизии скриптов для целевой таблицы.
    """
    from db import get_connection
    records: List[dict] = []
    existing_dbs: Set[str] = set()

    candidate_dbs = []
    for d in list(config.get("databases", [])) + ["dds", "dm", primary_db]:
        if d and d.lower() not in [x.lower() for x in candidate_dbs]:
            candidate_dbs.append(d)

    for cand_db in candidate_dbs:
        conn = None
        try:
            conn = get_connection(config, cand_db)
            cur = conn.cursor()

            cur.execute("""
                SELECT 1
                FROM information_schema.tables
                WHERE lower(table_schema) = lower(%s)
                  AND lower(table_name) = lower(%s)
                LIMIT 1
            """, (sc_name, tb_name))
            if cur.fetchone():
                existing_dbs.add(cand_db.lower())

            # Проверяем наличие public.sql_inventory в данной БД
            cur.execute("""
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name = 'sql_inventory'
                LIMIT 1
            """)
            if cur.fetchone():
                cur.execute("""
                    SELECT target_schema, target_table, query_text, updated_at
                    FROM public.sql_inventory
                    WHERE lower(target_table) = lower(%s)
                       OR lower(target_table) LIKE '%%.' || lower(%s)
                    ORDER BY updated_at DESC NULLS LAST
                """, (tb_name, tb_name))
                for r_sc, r_tb, r_sql, r_upd in cur.fetchall():
                    raw_text = r_sql or ""
                    norm_text = _normalize_foreign_tables(raw_text, cand_db)
                    records.append({
                        "source": "public.sql_inventory",
                        "db_name": cand_db,
                        "target_schema": r_sc,
                        "target_table": r_tb,
                        "query": norm_text,
                        "raw_query": raw_text,
                        "updated_at": r_upd,
                    })
        except Exception:
            pass
        finally:
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass

    return records, existing_dbs


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
    inventory_records: List[dict] = []
    existing_target_dbs: Set[str] = set()

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
                ORDER BY updated_at DESC NULLS LAST LIMIT 1
            """, (sc_name, tb_name))
            row = cursor.fetchone()
            inventory_records, existing_target_dbs = _collect_cross_db_inventory(config, db_name, sc_name, tb_name)

            if row and row[0]:
                sql_query = strip_sql_comments(row[0])
                print(f"[✓] Скрипт найден в public.sql_inventory (комментарии удалены, длина {len(sql_query)} символов)")
            elif inventory_records or db_name.lower() in existing_target_dbs:
                sql_query = ""
                print(f"[!] Внимание: в {db_name}.public.sql_inventory скрипт не найден, но обнаружены данные в других БД — формируем отчёт аудита...")
            else:
                print(f"[!] Внимание: Скрипт для таблицы {sc_name}.{tb_name} не найден в базе {db_name}.public.sql_inventory.")
                print(f"    Проверьте базы: {config.get('databases', [])}")
                sys.exit(1)
        except Exception as e:
            print(f"[!] Ошибка подключения к БД: {e}")
            print("    Вы можете запустить диагностику напрямую из файла скрипта:")
            print(f"    python diagnose_lineage.py --table {target_table} --sql-file script.sql")
            sys.exit(1)

    tracer = LineageTracer(
        target_table,
        sql_query,
        config,
        db_conn,
        inventory_records=inventory_records,
        existing_target_dbs=existing_target_dbs,
    )
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
