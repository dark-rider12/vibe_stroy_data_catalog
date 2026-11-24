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


if __name__ == "__main__":
    test_alias_collision()
