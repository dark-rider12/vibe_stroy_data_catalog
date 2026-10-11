/*
MODULE: src/lineage/columnLineageGraph.js
ROLE: Построение графа зависимостей и трассировка lineage-цепочек.

Содержит:
- getSources         — нормализация записи column_lineage к массиву источников
- buildLayersMap     — построение карты слоёв (tableId → depth) обходом upstream/downstream
- traceLineage       — трассировка подсвечиваемых колонок и линий от заданной колонки
- calcColumnEdgeCounts — подсчёт входящих/исходящих рёбер для каждой колонки (для адаптивных размеров)

Чистая логика: нет DOM, нет SVG, нет HTML.
*/

/**
 * Нормализует запись column_lineage к массиву источников.
 * Поддерживает оба формата:
 *   - старый: [ { source_table, source_column }, ... ]
 *   - новый:  { expression: "...", sources: [...] }
 *
 * @param {*} entry
 * @returns {Array<{source_table: string, source_column: string}>}
 */
export function getSources(entry) {
  if (!entry) return [];
  if (Array.isArray(entry)) return entry;
  if (typeof entry === "object" && Array.isArray(entry.sources)) return entry.sources;
  return [];
}

/**
 * Строит карту слоёв: tableId → depth (целое число).
 * Центральная таблица получает depth=0, upstream — отрицательные, downstream — положительные.
 *
 * @param {string} centerTableId - полный ID центральной таблицы "db.schema.name"
 * @param {Function} getTableInfo - (fullId) => tableInfo | null
 * @returns {Map<string, number>} layersMap
 */
export function buildLayersMap(centerTableId, getTableInfo) {
  const layersMap = new Map();
  layersMap.set(centerTableId, 0);

  // Обход upstream (вверх по зависимостям)
  let queue = [centerTableId];
  while (queue.length > 0) {
    const current = queue.shift();
    const depth = layersMap.get(current);
    const info = getTableInfo(current);
    if (info && info.lineage && info.lineage.upstream) {
      info.lineage.upstream.forEach((up) => {
        const upDepth = depth - 1;
        if (!layersMap.has(up) || layersMap.get(up) > upDepth) {
          layersMap.set(up, upDepth);
          queue.push(up);
        }
      });
    }
  }

  // Обход downstream (вниз по зависимостям)
  queue = [centerTableId];
  while (queue.length > 0) {
    const current = queue.shift();
    const depth = layersMap.get(current);
    const info = getTableInfo(current);
    if (info && info.lineage && info.lineage.downstream) {
      info.lineage.downstream.forEach((down) => {
        const downDepth = depth + 1;
        if (!layersMap.has(down) || layersMap.get(down) < downDepth) {
          layersMap.set(down, downDepth);
          queue.push(down);
        }
      });
    }
  }

  return layersMap;
}

/**
 * Трассирует lineage-цепочку от заданной колонки — определяет,
 * какие колонки и линии должны быть подсвечены.
 *
 * Помимо метаданных column_lineage учитывает временные рёбра проброса
 * (фичи «Протянуть колонку» / «Протянуть таблицу»): копия подсвечивается
 * вместе с родительской колонкой, ребро проброса — с обоими концами.
 *
 * @param {string} startTableId - полный ID таблицы "db.schema.name"
 * @param {string} startColName - имя колонки (нижний регистр)
 * @param {Set<string>} displayedTables - множество всех отображаемых tableId
 * @param {Function} getTableInfo - (fullId) => tableInfo | null
 * @param {Array<{parentTableId: string, childTableId: string, columnName: string, childColumnName?: string}>} [propagationEdges] - рёбра проброса текущей вкладки
 * @returns {{ highlightedCols: Set<string>, highlightedLines: Set<string> }}
 */
export function traceLineage(startTableId, startColName, displayedTables, getTableInfo, propagationEdges) {
  const highlightedCols = new Set();
  const highlightedLines = new Set();

  const traceUpstream = (tableId, colName) => {
    const tInfo = getTableInfo(tableId);
    if (!tInfo || !tInfo.column_lineage) return;

    // Case-insensitive поиск записи колонки
    const entry =
      tInfo.column_lineage[colName] ||
      Object.entries(tInfo.column_lineage).find(
        ([k]) => k.toLowerCase() === colName.toLowerCase(),
      )?.[1];

    getSources(entry).forEach((src) => {
      const srcTableId = src.source_table;
      const srcColName = src.source_column.toLowerCase();

      if (displayedTables.has(srcTableId)) {
        const srcColKey = `${srcTableId}.${srcColName}`;
        const lineKey = `${srcTableId}.${srcColName}->${tableId}.${colName.toLowerCase()}`;
        highlightedLines.add(lineKey);

        if (!highlightedCols.has(srcColKey)) {
          highlightedCols.add(srcColKey);
          traceUpstream(srcTableId, srcColName);
        }
      }
    });
  };

  const traceDownstream = (tableId, colName) => {
    displayedTables.forEach((targetTableId) => {
      const tInfo = getTableInfo(targetTableId);
      if (!tInfo || !tInfo.column_lineage) return;

      Object.entries(tInfo.column_lineage).forEach(([targetCol, entry]) => {
        getSources(entry).forEach((src) => {
          if (
            src.source_table === tableId &&
            src.source_column.toLowerCase() === colName.toLowerCase()
          ) {
            const targetColKey = `${targetTableId}.${targetCol.toLowerCase()}`;
            const lineKey = `${tableId}.${colName.toLowerCase()}->${targetTableId}.${targetCol.toLowerCase()}`;
            highlightedLines.add(lineKey);

            if (!highlightedCols.has(targetColKey)) {
              highlightedCols.add(targetColKey);
              traceDownstream(targetTableId, targetCol.toLowerCase());
            }
          }
        });
      });
    });
  };

  const centerColKey = `${startTableId}.${startColName.toLowerCase()}`;
  highlightedCols.add(centerColKey);
  traceUpstream(startTableId, startColName.toLowerCase());
  traceDownstream(startTableId, startColName.toLowerCase());

  // ── Учёт рёбер проброса (Column/Table Propagation) ──────────────────────────
  // Фикспоинт-цикл: пока находятся новые пары «родитель ↔ копия», добавляем
  // колонки и рёбра проброса в подсветку и продолжаем от них обычную трассировку.
  if (Array.isArray(propagationEdges) && propagationEdges.length > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of propagationEdges) {
        if (!e || !e.parentTableId || !e.childTableId || !e.columnName) continue;

        const childColName = (e.childColumnName || e.columnName).toLowerCase();
        const parentColKey = `${e.parentTableId}.${e.columnName.toLowerCase()}`;
        const childColKey = `${e.childTableId}.${childColName}`;
        const propLineKey = `prop-${e.parentTableId}-${e.childTableId}-${e.columnName.toLowerCase()}`;

        if (!highlightedCols.has(parentColKey) && !highlightedCols.has(childColKey)) continue;

        if (!highlightedLines.has(propLineKey)) {
          highlightedLines.add(propLineKey);
          changed = true;
        }
        if (!highlightedCols.has(parentColKey)) {
          highlightedCols.add(parentColKey);
          changed = true;
          traceUpstream(e.parentTableId, e.columnName.toLowerCase());
        }
        if (!highlightedCols.has(childColKey)) {
          highlightedCols.add(childColKey);
          changed = true;
          traceDownstream(e.childTableId, childColName);
        }
      }
    }
  }

  return { highlightedCols, highlightedLines };
}

/**
 * Подсчитывает количество входящих и исходящих рёбер для каждой колонки.
 * Используется для расчёта адаптивной высоты (padding) ячеек колонок.
 *
 * @param {Set<string>} displayedTables
 * @param {Function} getTableInfo
 * @returns {{ columnSourceCounts: Object, columnTargetCounts: Object }}
 */
export function calcColumnEdgeCounts(displayedTables, getTableInfo) {
  const columnSourceCounts = {};
  const columnTargetCounts = {};

  displayedTables.forEach((targetTableId) => {
    const tInfo = getTableInfo(targetTableId);
    if (!tInfo || !tInfo.column_lineage) return;
    Object.entries(tInfo.column_lineage).forEach(([targetCol, entry]) => {
      const colKeyT = `${targetTableId}.${targetCol.toLowerCase()}`;
      getSources(entry).forEach((src) => {
        const sourceTableId = src.source_table;
        const sourceCol = src.source_column.toLowerCase();
        if (displayedTables.has(sourceTableId)) {
          const colKeyS = `${sourceTableId}.${sourceCol}`;
          columnSourceCounts[colKeyS] = (columnSourceCounts[colKeyS] || 0) + 1;
          columnTargetCounts[colKeyT] = (columnTargetCounts[colKeyT] || 0) + 1;
        }
      });
    });
  });

  return { columnSourceCounts, columnTargetCounts };
}
