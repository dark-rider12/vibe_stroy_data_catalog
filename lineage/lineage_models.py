"""
MODULE: lineage_models.py
ROLE: Структуры данных для хранения графов зависимостей.
INPUT: None
OUTPUT: DataClasses / TypedDicts
DATA STRUCTURE: Models
USED BY: table_lineage.py, column_lineage.py
DEPENDENCIES: typing
"""

from typing import TypedDict, List, Optional

class ColumnDef(TypedDict):
name: str
type: str
description: Optional[str]

class TableLineageItem(TypedDict):
source_table: str
transformation_type: str

class CatalogTable(TypedDict):
description: Optional[str]
type: str
columns: List[ColumnDef]
table_lineage: List[TableLineageItem]
column_lineage: dict
ddl: str