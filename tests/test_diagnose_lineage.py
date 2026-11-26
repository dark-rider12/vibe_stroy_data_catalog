"""
Тестирование утилиты diagnose_lineage.py
"""

import os
import subprocess
import sys


def test_diagnose_lineage():
    sample_sql = """
    -- АВТОР: Иванов Иван Иванович, тел: +7(999)123-45-67
    /* КОНФИДЕНЦИАЛЬНО: Паспорт 4500 123456, секретный расчёт ставок */
    CREATE TABLE dm.core.contract_account_link AS
    SELECT DISTINCT
        cal.account_link_id, -- первичный ключ линка
        fa.account_name AS account_number,
        cal.contract_id,
        c.contract_cd
    FROM dm.ext_dds.contract_account_link cal
    LEFT JOIN dm.ext_dds.financial_account fa ON cal.account_id = fa.account_id
    LEFT JOIN dm.ext_dds.contracts c ON cal.contract_id = c.contract_id
    -- Финальный служебный комментарий
    """
    tmp_sql = "tests/.tmp_diag_sample.sql"
    tmp_report = "tests/.tmp_diag_report.txt"
    try:
        with open(tmp_sql, "w", encoding="utf-8") as f:
            f.write(sample_sql)

        cmd = [
            sys.executable,
            "diagnose_lineage.py",
            "--table", "dm.core.contract_account_link",
            "--sql-file", tmp_sql,
            "--out", tmp_report
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        assert res.returncode == 0, f"diagnose_lineage failed: {res.stderr}"

        with open(tmp_report, "r", encoding="utf-8") as f:
            content = f.read()

        assert "ОТЛАДОЧНЫЙ ОТЧЁТ LINEAGE (ПОЛНОСТЬЮ ОБЕЗЛИЧЕН)" in content
        assert "TAB_TARGET" in content
        assert "contract_account_link" not in content, "Real table name should be anonymized"
        assert "financial_account" not in content, "Real table name should be anonymized"
        # Проверка 100% фильтрации комментариев и защиты персональных данных
        assert "Иванов" not in content, "Sensitive comment leaked into report!"
        assert "+7(999)" not in content, "Phone number leaked into report!"
        assert "КОНФИДЕНЦИАЛЬНО" not in content, "Block comment leaked into report!"
        assert "4500 123456" not in content, "Passport leaked into report!"
        assert "первичный ключ" not in content, "Inline comment leaked into report!"
        assert "Финальный служебный" not in content, "Trailing comment leaked into report!"
        print("✓ Тест diagnose_lineage.py (включая фильтрацию комментариев) успешно пройден!")
    finally:
        if os.path.exists(tmp_sql):
            os.remove(tmp_sql)
        if os.path.exists(tmp_report):
            os.remove(tmp_report)


def test_diagnose_lineage_command_fallback_anonymization():
    """
    Проверяет, что при откате sqlglot к exp.Command или ошибке синтаксиса
    ни сырые имена таблиц/колонок/схем/функций, ни литералы, ни предупреждения sqlglot
    не утекают ни в отчёт, ни в консоль.
    """
    broken_sql = """
    -- Секретный комментарий: Петров П.П.
    create table core.secret_limits_daily as
    with secret_cte_one as (
        select
            cc.secret_contract_id as secret_alias_col,
            'СЕКРЕТНАЯ_СТРОКА' as secret_str_col,
            $$ДОЛЛАР_СЕКРЕТ$$ as dollar_col,
            custom_secret_udf(cc.secret_amount) as udf_col
        from ods.secret_schema.secret_source_table cc
    )
    select * from secret_cte_one
    DISTRIBUTED BY (secret_alias_col)
    """
    tmp_sql = "tests/.tmp_cmd_sample.sql"
    tmp_report = "tests/.tmp_cmd_report.txt"
    try:
        with open(tmp_sql, "w", encoding="utf-8") as f:
            f.write(broken_sql)

        cmd = [
            sys.executable,
            "diagnose_lineage.py",
            "--table", "dm.core.secret_limits_daily",
            "--sql-file", tmp_sql,
            "--out", tmp_report,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        assert res.returncode == 0, f"diagnose_lineage failed on Command script: {res.stderr}"

        # Проверяем, что консоль (stdout/stderr) не получила сырой SQL от логгера sqlglot
        combined_console = (res.stdout or "") + "\n" + (res.stderr or "")
        for leak in ("secret_limits_daily", "secret_cte_one", "secret_contract_id", "СЕКРЕТНАЯ_СТРОКА"):
            assert leak not in combined_console, f"Sensitive token leaked to console: {leak}"

        with open(tmp_report, "r", encoding="utf-8") as f:
            report = f.read()

        assert "--- [4. ОБЕЗЛИЧЕННЫЙ ВОСПРОИЗВОДИМЫЙ SQL-СКРИПТ] ---" in report, "Section 4 missing!"
        sensitive_tokens = (
            "secret_limits_daily",
            "secret_cte_one",
            "secret_contract_id",
            "secret_alias_col",
            "secret_str_col",
            "secret_amount",
            "secret_schema",
            "secret_source_table",
            "custom_secret_udf",
            "СЕКРЕТНАЯ_СТРОКА",
            "ДОЛЛАР_СЕКРЕТ",
            "Петров",
            "udf_col",
            "dollar_col",
        )
        for token in sensitive_tokens:
            assert token not in report, f"Sensitive token '{token}' leaked into report!\n{report}"

        assert "SYNTAX_HINT" in report, "Expected SYNTAX_HINT diagnostic message for Command fallback!"
        print("✓ Тест обезличивания при exp.Command и ParseError успешно пройден!")
    finally:
        if os.path.exists(tmp_sql):
            os.remove(tmp_sql)
        if os.path.exists(tmp_report):
            os.remove(tmp_report)


def test_diagnose_lineage_cross_db_script_audit():
    """
    Проверяет секцию [0. АУДИТ ИСТОЧНИКОВ СКРИПТА]:
    - обнаружение CROSS_DB_HEADER при несовпадении CREATE TABLE dm.* и --table dds.*;
    - обнаружение дублей и симуляцию attach_sql_scripts с полным обезличиванием.
    """
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from diagnose_lineage import LineageTracer

    bad_sql = "CREATE TABLE dm.core.financial_account AS SELECT 1+1;"
    inv_records = [
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "financial_account",
            "query": bad_sql,
            "raw_query": bad_sql,
            "updated_at": "2026-11-26 12:00:00",
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dm",
            "target_schema": "core",
            "target_table": "financial_account",
            "query": bad_sql,
            "raw_query": bad_sql,
            "updated_at": "2026-11-26 12:05:00",
        },
    ]

    tracer = LineageTracer(
        "dds.core.financial_account",
        bad_sql,
        {"databases": ["ods", "dds", "dm"]},
        db_connection=None,
        inventory_records=inv_records,
        existing_target_dbs={"dds", "dm"},
    )
    report = tracer.run_diagnostics()

    assert "--- [0. АУДИТ ИСТОЧНИКОВ СКРИПТА (ВКЛАДКА «СКРИПТ»)] ---" in report
    assert "CROSS_DB_HEADER" in report
    assert "ATTACH_WARNING" in report
    assert "ATTACH_SIMULATION" in report
    for leak in ("financial_account", "dm", "dds"):
        assert leak not in report, f"Sensitive db/table token '{leak}' leaked into audit report:\n{report}"

    print("✓ Тест межбазового аудита скриптов в diagnose_lineage.py успешно пройден!")


def test_nested_and_orphaned_block_comments():
    """
    Проверяет поддержку вложенных блочных комментариев PostgreSQL (/* ... /* ... */ ... */),
    '-- /*' и удаление осиротевших маркеров '*/' в strip_sql_comments / column_lineage / table_lineage.
    """
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from diagnose_lineage import LineageTracer, strip_sql_comments
    from lineage.column_lineage import (
        _strip_sql_comments,
        _analyze_single_query_lineage,
        _init_column_lineage_worker,
        _build_schema_lookahead,
    )
    from lineage.table_lineage import compute_table_lineage

    sql_nested = """
    CREATE TABLE dm.core.target_nested AS
    SELECT
        s.id,
        /* внешний комментарий
           /* вложенный комментарий */
           , null as leaked_fake_col
        */
        -- /* закомментированное открытие
        , null as orphan_marker_col
        */
        , s.amount AS total_amount,
        '/* строка_с_комментарием */' AS safe_str
    FROM ods.core.src_orders s
    """

    for fn in (strip_sql_comments, _strip_sql_comments):
        cleaned = fn(sql_nested)
        assert "leaked_fake_col" not in cleaned, f"Inner nested comment leaked! {cleaned}"
        assert "/*" not in cleaned.replace("'/* строка_с_комментарием */'", ""), f"Comment opener leaked! {cleaned}"
        assert "*/" not in cleaned.replace("'/* строка_с_комментарием */'", ""), f"Orphan */ leaked! {cleaned}"
        assert "'/* строка_с_комментарием */'" in cleaned, f"String literal damaged! {cleaned}"

    # Проверяем diagnose_lineage
    tracer = LineageTracer("dm.core.target_nested", sql_nested, {"databases": ["ods", "dds", "dm"]})
    report = tracer.run_diagnostics()
    assert "СТАТУС ВЫПОЛНЕНИЯ: SUCCESS" in report, f"Expected SUCCESS, got:\n{report}"
    assert "leaked_fake_col" not in report

    # Проверяем _analyze_single_query_lineage
    lookup = {
        "dm.core.target_nested": ("dm", "core", "target_nested"),
        "ods.core.src_orders": ("ods", "core", "src_orders"),
    }
    schema_dict = {
        "dm": {"core": {"target_nested": {"id": "string", "orphan_marker_col": "string", "total_amount": "string", "safe_str": "string"}}},
        "ods": {"core": {"src_orders": {"id": "string", "amount": "string"}}},
    }
    tcols = {
        "dm.core.target_nested": ["id", "orphan_marker_col", "total_amount", "safe_str"],
        "ods.core.src_orders": ["id", "amount"],
    }
    _init_column_lineage_worker(lookup, schema_dict, _build_schema_lookahead(), tcols)
    t_res, col_lin, warn = _analyze_single_query_lineage({
        "db_name": "dm",
        "target_schema": "core",
        "target_table": "target_nested",
        "query": sql_nested,
    })
    assert t_res == "dm.core.target_nested"
    assert "leaked_fake_col" not in col_lin
    assert "total_amount" in col_lin and "ods.core.src_orders" in [s["source_table"] for s in col_lin["total_amount"]["sources"]]

    # Проверяем compute_table_lineage
    cat = {
        "ods": {"core": {"src_orders": {"lineage": {"upstream": set(), "downstream": set()}, "columns": []}}},
        "dm": {"core": {"target_nested": {"lineage": {"upstream": set(), "downstream": set()}, "columns": []}}},
    }
    compute_table_lineage(cat, [{"db_name": "dm", "query": sql_nested}])
    assert "ods.core.src_orders" in cat["dm"]["core"]["target_nested"]["lineage"]["upstream"]

    print("✓ Тест вложенных и осиротевших блочных комментариев успешно пройден!")


if __name__ == "__main__":
    test_diagnose_lineage()
    test_diagnose_lineage_command_fallback_anonymization()
    test_diagnose_lineage_cross_db_script_audit()
    test_nested_and_orphaned_block_comments()
