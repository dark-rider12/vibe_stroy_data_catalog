"""
Тест защиты от попадания SQL-скриптов и Column Lineage из другой базы данных (dds <-> dm).
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from generate_catalog import attach_sql_scripts, _extract_explicit_target_db, _extract_all_explicit_target_dbs
from lineage.column_lineage import compute_column_lineage


def _make_table(cols=("id",)):
    return {
        "type": "r",
        "description": "",
        "columns": [{"name": c, "type": "bigint", "description": "", "notnull": False} for c in cols],
        "lineage": {"upstream": set(), "downstream": set()},
        "column_lineage": {},
    }


def test_cross_db_script_and_lineage_protection():
    catalog = {
        "ods": {"core": {"src_tab": _make_table(("id", "ods_val"))}},
        "dds": {"core": {"shared_tbl": _make_table(("id", "val")), "dds_only_tbl": _make_table(("id", "val"))}},
        "dm": {"core": {"shared_tbl": _make_table(("id", "val"))}},
    }

    dds_shared_sql = "CREATE TABLE core.shared_tbl AS SELECT id, ods_val AS val FROM ext_ods.src_tab"
    dm_shared_sql = "CREATE TABLE core.shared_tbl AS SELECT id, val FROM ext_dds.shared_tbl"
    # Скрипт в dm для таблицы, которой НЕТ в dm, но есть одноименная в dds (не должен попасть в dds!)
    dm_orphan_sql = "CREATE TABLE core.dds_only_tbl AS SELECT id, 999 AS val FROM ext_dds.shared_tbl"
    # Скрипт в dds (свежий и старый дубль): свежий должен сохраниться, старый не должен перезаписать
    dds_only_fresh_sql = "CREATE TABLE dds.core.dds_only_tbl AS SELECT id, ods_val AS val FROM ext_ods.src_tab"
    dds_only_stale_sql = "CREATE TABLE dds.core.dds_only_tbl AS SELECT id, 0 AS val FROM ext_ods.src_tab"
    # Ошибочный скрипт в dds.sql_inventory, явно создающий таблицу в dm
    misplaced_sql = "CREATE TABLE dm.core.dds_only_tbl AS SELECT id, 123 AS val FROM ext_dds.shared_tbl"

    assert _extract_explicit_target_db("/* comment */\nCREATE TABLE dm.core.tbl AS SELECT 1") == "dm"
    assert _extract_explicit_target_db("CREATE TABLE core.tbl AS SELECT 1") == ""

    sql_data = [
        # Имитируем порядок после sql_loader.py (сначала dds от свежего к старому, затем dm)
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "dds_only_tbl",
            "query": dds_only_fresh_sql.replace("ext_ods.", "ods.core."),
            "raw_query": dds_only_fresh_sql,
            "updated_at": None,
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "dds_only_tbl",
            "query": dds_only_stale_sql.replace("ext_ods.", "ods.core."),
            "raw_query": dds_only_stale_sql,
            "updated_at": None,
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "shared_tbl",
            "query": dds_shared_sql.replace("ext_ods.", "ods.core."),
            "raw_query": dds_shared_sql,
            "updated_at": None,
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "dds_only_tbl",
            "query": misplaced_sql.replace("ext_dds.", "dds.core."),
            "raw_query": misplaced_sql,
            "updated_at": None,
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dm",
            "target_schema": "core",
            "target_table": "shared_tbl",
            "query": dm_shared_sql.replace("ext_dds.", "dds.core."),
            "raw_query": dm_shared_sql,
            "updated_at": None,
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dm",
            "target_schema": "core",
            "target_table": "dds_only_tbl",
            "query": dm_orphan_sql.replace("ext_dds.", "dds.core."),
            "raw_query": dm_orphan_sql,
            "updated_at": None,
        },
    ]

    attach_sql_scripts(catalog, sql_data)

    # 1. Каждая одноименная таблица получила строго свой скрипт
    assert "ext_ods.src_tab" in catalog["dds"]["core"]["shared_tbl"]["sql_script"]
    assert "ext_dds.shared_tbl" in catalog["dm"]["core"]["shared_tbl"]["sql_script"]

    # 2. В dds_only_tbl остался свежий скрипт dds, не затертый старым дублем, ошибочным dm.* или dm_orphan_sql
    dds_only_script = catalog["dds"]["core"]["dds_only_tbl"]["sql_script"]
    assert "ods_val AS val" in dds_only_script, f"Expected fresh dds script, got: {dds_only_script}"
    assert "999 AS val" not in dds_only_script, "dm orphan script leaked into dds!"
    assert "123 AS val" not in dds_only_script, "misplaced dm CREATE script leaked into dds!"
    assert "0 AS val" not in dds_only_script, "stale dds script overwrote fresh script!"

    # 3. Проверяем защиту в случае, когда у dds_only_tbl вообще нет скрипта в dds, а в dm есть одноименный
    catalog_no_dds_script = {
        "dds": {"core": {"dds_only_tbl": _make_table(("id", "val"))}},
        "dm": {"core": {}},
    }
    attach_sql_scripts(catalog_no_dds_script, [
        {
            "source": "public.sql_inventory",
            "db_name": "dm",
            "target_schema": "core",
            "target_table": "dds_only_tbl",
            "query": dm_orphan_sql.replace("ext_dds.", "dds.core."),
            "raw_query": dm_orphan_sql,
            "updated_at": None,
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "dds_only_tbl",
            "query": misplaced_sql.replace("ext_dds.", "dds.core."),
            "raw_query": misplaced_sql,
            "updated_at": None,
        },
    ])
    assert "sql_script" not in catalog_no_dds_script["dds"]["core"]["dds_only_tbl"], \
        "dds table must NOT receive script from dm!"

    # 4. Проверяем column_lineage: скрипт из dm (для отсутствующей в dm таблицы) не должен попадать в dds
    compute_column_lineage(catalog_no_dds_script, [
        {
            "source": "public.sql_inventory",
            "db_name": "dm",
            "target_schema": "core",
            "target_table": "dds_only_tbl",
            "query": dm_orphan_sql.replace("ext_dds.", "dds.core."),
            "raw_query": dm_orphan_sql,
        }
    ])
    assert catalog_no_dds_script["dds"]["core"]["dds_only_tbl"]["column_lineage"] == {}, \
        "dm column_lineage leaked into dds table!"

    # 5. Проверяем UNLOGGED TABLE, SELECT INTO и многоинструкционные скрипты
    assert _extract_explicit_target_db("CREATE UNLOGGED TABLE dm.core.tbl AS SELECT 1") == "dm"
    assert _extract_explicit_target_db("SELECT 1+1 INTO dm.core.tbl") == "dm"
    assert _extract_all_explicit_target_dbs("CREATE TABLE tmp_x AS SELECT 1; CREATE TABLE dm.core.tbl AS SELECT 1+1;") == ["dm"]

    catalog_unlogged = {"dds": {"core": {"financial_account": _make_table(("id",))}}, "dm": {"core": {}}}
    attach_sql_scripts(catalog_unlogged, [
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "financial_account",
            "query": "CREATE UNLOGGED TABLE dm.core.financial_account AS SELECT 1+1;",
            "raw_query": "CREATE UNLOGGED TABLE dm.core.financial_account AS SELECT 1+1;",
        },
        {
            "source": "public.sql_inventory",
            "db_name": "dds",
            "target_schema": "core",
            "target_table": "financial_account",
            "query": "SELECT 1+1 INTO dm.core.financial_account;",
            "raw_query": "SELECT 1+1 INTO dm.core.financial_account;",
        },
    ])
    assert "sql_script" not in catalog_unlogged["dds"]["core"]["financial_account"], \
        "UNLOGGED/SELECT INTO dm.* leaked into dds!"

    print("✓ Тест test_cross_db_script_protection успешно пройден!")


if __name__ == "__main__":
    test_cross_db_script_and_lineage_protection()
