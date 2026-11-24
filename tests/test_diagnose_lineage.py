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


if __name__ == "__main__":
    test_diagnose_lineage()
