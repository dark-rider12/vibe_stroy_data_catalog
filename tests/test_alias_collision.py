"""
Тест проверки изоляции области видимости псевдонимов (alias scope isolation)
между CTE и основным запросом.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lineage.column_lineage import _analyze_single_query_lineage, _init_column_lineage_worker, _build_schema_lookahead


def test_alias_collision():
    sql = """
    CREATE TABLE sch_1.tab_target AS
    WITH cte_12 AS (
      SELECT col_92, col_129 FROM db_2.sch_1.tab_6 AS a_2
    )
    SELECT
      a_2.col_51 AS col_141
    FROM db_2.sch_1.tab_target AS a_1
    LEFT JOIN db_2.sch_1.tab_39 AS a_2 ON a_1.col_6 = a_2.col_6
    """
    lookup = {
        'db_2.sch_1.tab_target': ('db_2', 'sch_1', 'tab_target'),
        'db_2.sch_1.tab_6': ('db_2', 'sch_1', 'tab_6'),
        'db_2.sch_1.tab_39': ('db_2', 'sch_1', 'tab_39'),
        'sch_1.tab_target': ('db_2', 'sch_1', 'tab_target'),
    }
    schema_dict = {'db_2': {'sch_1': {'tab_target': {}, 'tab_6': {}, 'tab_39': {}}}}
    table_columns_map = {'db_2.sch_1.tab_target': ['col_141']}

    _init_column_lineage_worker(lookup, schema_dict, _build_schema_lookahead(), table_columns_map)

    item = {'target_table': 'tab_target', 'target_schema': 'sch_1', 'db_name': 'db_2', 'query': sql}
    target, col_lineage, warn = _analyze_single_query_lineage(item)

    assert target == 'db_2.sch_1.tab_target', f"Unexpected target: {target}"
    assert 'col_141' in col_lineage, f"col_141 not found in {col_lineage}"
    col_data = col_lineage['col_141']

    # Проверяем, что A_2 в основном запросе раскрылся в TAB_39, а НЕ в TAB_6 из CTE_12
    assert 'tab_39' in col_data['expression'].lower(), f"Expected tab_39 in expr, got: {col_data['expression']}"
    assert 'tab_6' not in col_data['expression'].lower(), f"Unexpected tab_6 in expr: {col_data['expression']}"

    sources = [s.get('source_table') for s in col_data.get('sources', [])]
    assert 'db_2.sch_1.tab_39' in sources, f"Expected db_2.sch_1.tab_39 in sources, got: {sources}"
    assert 'db_2.sch_1.tab_6' not in sources, f"Unexpected db_2.sch_1.tab_6 in sources: {sources}"

    print("✓ Тест test_alias_collision успешно пройден!")


def test_lateral_generate_series_lineage():
    """
    Проверяет раскрытие expression и реальных источников для CROSS JOIN LATERAL generate_series(...)
    в CTE (с цепочкой CTE и ::date), прямом SELECT с ::date, алиасе AS gs(d) и константном диапазоне.
    """
    from lineage.column_lineage import compute_column_lineage

    def _mk(cols):
        return {
            'type': 'r',
            'description': '',
            'columns': [{'name': c, 'type': 'date', 'description': '', 'notnull': False} for c in cols],
            'lineage': {'upstream': set(), 'downstream': set()},
            'column_lineage': {},
        }

    catalog = {
        'ods': {
            'core': {
                'tok_4': _mk(['col_1', 'col_2']),
                'tok_5': _mk(['col_1', 'col_4', 'col_5', 'col_6']),
            }
        },
        'dds': {
            'core': {
                'tab_2': _mk(['col_9']),
                't_cte': _mk(['report_date', 'col_1']),
                't_direct_cast': _mk(['report_date', 'col_1']),
                't_gs_col': _mk(['report_date', 'col_1']),
                't_const': _mk(['report_date']),
            }
        },
    }

    sql_cte = """
    CREATE TABLE dds.core.t_cte AS
    WITH tok_1 AS (
      SELECT col_9, a_1.col_1 AS col_1
      FROM ods.core.tok_4 a_1
      LEFT JOIN ods.core.tok_5 a_2 ON a_1.col_1 = a_2.col_1
      CROSS JOIN LATERAL generate_series(
        CASE WHEN CAST('2024-01-01' AS DATE) > a_2.col_4 THEN CAST('2024-01-01' AS DATE) ELSE a_2.col_4 END,
        CASE WHEN a_2.col_5 IS NULL THEN current_date::date - 1 ELSE COALESCE(a_2.col_5, a_2.col_6)::date - 1 END,
        '1 day'::interval
      ) AS col_9
    ),
    tok_6 AS (
      SELECT a_3.col_9::date, a_3.col_1 AS col_1
      FROM tok_1 a_3
      LEFT JOIN dds.core.tab_2 a_8 ON a_3.col_9 = a_8.col_9
    )
    SELECT a_4.col_9 AS report_date, a_4.col_1 FROM tok_6 a_4
    """

    sql_direct_cast = """
    CREATE TABLE dds.core.t_direct_cast AS
    SELECT col_9::date AS report_date, a_1.col_1
    FROM ods.core.tok_4 a_1
    LEFT JOIN ods.core.tok_5 a_2 ON a_1.col_1 = a_2.col_1
    CROSS JOIN LATERAL generate_series(a_2.col_4, COALESCE(a_2.col_5, CURRENT_DATE), INTERVAL '1 day') AS col_9
    """

    sql_gs_col = """
    CREATE TABLE dds.core.t_gs_col AS
    SELECT gs.d AS report_date, a_1.col_1
    FROM ods.core.tok_5 a_1
    CROSS JOIN LATERAL generate_series(a_1.col_4, COALESCE(a_1.col_5, CURRENT_DATE), INTERVAL '1 day') AS gs(d)
    """

    sql_const = """
    CREATE TABLE dds.core.t_const AS
    SELECT dt::date AS report_date
    FROM ods.core.tok_4 a_1
    CROSS JOIN LATERAL generate_series(CAST('2024-01-01' AS DATE), CURRENT_DATE, INTERVAL '1 day') AS dt
    """

    compute_column_lineage(catalog, [
        {'db_name': 'dds', 'target_schema': 'core', 'target_table': 't_cte', 'query': sql_cte},
        {'db_name': 'dds', 'target_schema': 'core', 'target_table': 't_direct_cast', 'query': sql_direct_cast},
        {'db_name': 'dds', 'target_schema': 'core', 'target_table': 't_gs_col', 'query': sql_gs_col},
        {'db_name': 'dds', 'target_schema': 'core', 'target_table': 't_const', 'query': sql_const},
    ])

    # 1. CTE с ::date
    cte_rd = catalog['dds']['core']['t_cte']['column_lineage']['report_date']
    assert 'GENERATE_SERIES(' in cte_rd['expression'], f"Expected GENERATE_SERIES in CTE expr, got: {cte_rd['expression']}"
    assert 'ods.core.tok_5.col_4' in cte_rd['expression'], f"Expected resolved col_4 in expr, got: {cte_rd['expression']}"
    cte_srcs = {(s['source_table'], s['source_column']) for s in cte_rd['sources']}
    assert ('ods.core.tok_4', 'col_9') not in cte_srcs, f"Bogus tok_4.col_9 in CTE sources: {cte_srcs}"
    assert {('ods.core.tok_5', 'col_4'), ('ods.core.tok_5', 'col_5'), ('ods.core.tok_5', 'col_6')} <= cte_srcs, \
        f"Missing real tok_5 columns in CTE sources: {cte_srcs}"

    # 2. Прямой SELECT с col_9::date
    dir_rd = catalog['dds']['core']['t_direct_cast']['column_lineage']['report_date']
    assert 'GENERATE_SERIES(' in dir_rd['expression'], f"Expected GENERATE_SERIES in direct cast expr: {dir_rd['expression']}"
    dir_srcs = {(s['source_table'], s['source_column']) for s in dir_rd['sources']}
    assert ('ods.core.tok_4', 'col_9') not in dir_srcs, f"Bogus tok_4.col_9 in direct sources: {dir_srcs}"
    assert {('ods.core.tok_5', 'col_4'), ('ods.core.tok_5', 'col_5')} <= dir_srcs, \
        f"Missing real tok_5 columns in direct sources: {dir_srcs}"

    # 3. AS gs(d)
    gs_rd = catalog['dds']['core']['t_gs_col']['column_lineage']['report_date']
    assert 'GENERATE_SERIES(' in gs_rd['expression'], f"Expected GENERATE_SERIES for AS gs(d): {gs_rd['expression']}"
    assert 'ods.core.tok_5.col_4' in gs_rd['expression'], f"Expected resolved col_4 in gs(d) expr: {gs_rd['expression']}"

    # 4. Константный generate_series — выражение раскрыто, источников нет
    const_rd = catalog['dds']['core']['t_const']['column_lineage']['report_date']
    assert 'GENERATE_SERIES(' in const_rd['expression'], f"Expected GENERATE_SERIES for const lateral: {const_rd['expression']}"
    assert const_rd['sources'] == [], f"Expected empty sources for const lateral, got: {const_rd['sources']}"

    print("✓ Тест test_lateral_generate_series_lineage успешно пройден!")


if __name__ == "__main__":
    test_alias_collision()
    test_lateral_generate_series_lineage()
