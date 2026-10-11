/*
MODULE: src/lineage/columnLineageLayout.js
ROLE: Позиционирование карточек (layout) в Column Lineage.

Содержит:
- optimizeCardPositions — выравнивание карточек по вертикали:
    1. alignLayer: медианный сдвиг к соседнему слою + collision resolution
    2. СМЕЩЕНИЕ ОТВЕТВЛЕНИЙ: non-main карточки вниз на 150px
    3. ВЫРАВНИВАНИЕ ОСНОВНОЙ ЦЕПОЧКИ по вертикали
    4. ФИНАЛЬНЫЙ collision pass с учётом зазора между слоями (0px или 20px)

НЕ ТРОГАТЬ БЕЗ ИЗУЧЕНИЯ LINEAGE_ARCHITECTURE.md и LINEAGE_ROUTING_ALGORITHM.md (правила 13, 14).
*/

import { getSources } from "./columnLineageGraph.js";
import { sanitizeId } from "../utils/helpers.js";

/**
 * Оптимизирует позиции карточек по вертикали.
 *
 * @param {object} ctx
 * @param {Element}  ctx.pane            - корневой элемент панели
 * @param {string}   ctx.uniqueId        - уникальный ID вкладки
 * @param {Map}      ctx.layersMap       - tableId → depth
 * @param {Set}      ctx.displayedTables - множество отображаемых tableId
 * @param {number}   ctx.minDepth        - минимальная глубина
 * @param {number}   ctx.maxDepth        - максимальная глубина
 * @param {Set}      ctx.highlightedLines - lineKey подсвеченных рёбер
 * @param {Set}      ctx.highlightedCols  - colKey подсвеченных колонок
 * @param {string}   ctx.centerTableId   - полный ID центральной таблицы
 * @param {string}   ctx.columnName      - имя выбранной колонки
 * @param {Function} ctx.getTableInfo    - (fullId) => tableInfo | null
 */
export function optimizeCardPositions(ctx) {
  const {
    pane, uniqueId, layersMap, displayedTables,
    minDepth, maxDepth,
    highlightedLines, highlightedCols,
    centerTableId, columnName,
    getTableInfo,
  } = ctx;

  const cards = pane.querySelectorAll(".cll-card");
  const layersMapLower = new Map();
  const layersMapOriginal = new Map();
  layersMap.forEach((depth, id) => {
    layersMapLower.set(id.toLowerCase(), depth);
    layersMapOriginal.set(id.toLowerCase(), id);
  });

  cards.forEach((card) => {
    card.style.transition = "none";
    card.style.alignSelf = "flex-start";
  });

  const canvas = pane.querySelector(".lineage-canvas");
  let scale = 1;
  if (canvas && canvas.offsetWidth > 0) {
    const canvasRect = canvas.getBoundingClientRect();
    scale = canvasRect.width / canvas.offsetWidth;
  }

  const getCenterY = (el) => {
    const r = el.getBoundingClientRect();
    return (r.top + r.height / 2) / scale;
  };

  // Глобальный Set для отслеживания карточек, уже обработанных в вертикальных группах
  const globallyStackedCards = new Set();

  // ============================================
  // ОПРЕДЕЛЕНИЕ ОСНОВНОЙ ЦЕПОЧКИ (самый длинный путь через центральную колонку)
  // ============================================
  const childrenByParentColGlobal = new Map();
  const parentByChildColGlobal = new Map();
  highlightedLines.forEach(lineKey => {
    // Ключи рёбер проброса ("prop-...") не содержат "->" — в цепочках layout не участвуют
    if (!lineKey.includes("->")) return;
    const [srcFull, tgtFull] = lineKey.split("->");
    const parentCol = srcFull.toLowerCase();
    const childCol = tgtFull.toLowerCase();
    if (!childrenByParentColGlobal.has(parentCol)) {
      childrenByParentColGlobal.set(parentCol, []);
    }
    childrenByParentColGlobal.get(parentCol).push(childCol);
    parentByChildColGlobal.set(childCol, parentCol);
  });

  // Считаем длину цепочки вниз от каждой колонки
  const chainLengthDown = new Map();
  const calcChainLengthDown = (colKey) => {
    if (chainLengthDown.has(colKey)) return chainLengthDown.get(colKey);
    const children = childrenByParentColGlobal.get(colKey) || [];
    if (children.length === 0) {
      chainLengthDown.set(colKey, 1);
      return 1;
    }
    const maxChildLength = Math.max(...children.map(c => calcChainLengthDown(c)));
    chainLengthDown.set(colKey, 1 + maxChildLength);
    return 1 + maxChildLength;
  };

  // Считаем длину цепочки вверх от каждой колонки
  const chainLengthUp = new Map();
  const calcChainLengthUp = (colKey) => {
    if (chainLengthUp.has(colKey)) return chainLengthUp.get(colKey);
    const parent = parentByChildColGlobal.get(colKey);
    if (!parent) {
      chainLengthUp.set(colKey, 1);
      return 1;
    }
    const parentLength = calcChainLengthUp(parent);
    chainLengthUp.set(colKey, 1 + parentLength);
    return 1 + parentLength;
  };

  // Считаем длины для всех колонок в highlightedCols
  highlightedCols.forEach(colKey => {
    calcChainLengthDown(colKey.toLowerCase());
    calcChainLengthUp(colKey.toLowerCase());
  });

  // Определяем какая цепочка самая длинная ЧЕРЕЗ центральную колонку
  const centerColKey = `${centerTableId}.${columnName.toLowerCase()}`;
  const mainChainCols = new Set();

  // Строим цепочку вверх от центральной колонки
  let current = centerColKey.toLowerCase();
  while (current) {
    mainChainCols.add(current);
    const parent = parentByChildColGlobal.get(current);
    current = parent || null;
  }

  // Строим цепочку вниз от центральной колонки (самый длинный путь)
  current = centerColKey.toLowerCase();
  while (current) {
    mainChainCols.add(current);
    const children = childrenByParentColGlobal.get(current) || [];
    if (children.length > 0) {
      const childrenWithLength = children.map(child => ({
        child,
        length: chainLengthDown.get(child) || 1,
      }));
      childrenWithLength.sort((a, b) => b.length - a.length);
      current = childrenWithLength[0].child;
    } else {
      current = null;
    }
  }

  // Таблицы, которые входят в самую длинную цепочку
  const mainChainTables = new Set();
  mainChainCols.forEach(colKey => {
    const tableId = colKey.substring(0, colKey.lastIndexOf('.'));
    mainChainTables.add(tableId);
  });

  // Возвращает true, если видимая колонка-приёмник имеет ровно одно входящее
  // ребро. Такие связи получают приоритет при вертикальном выравнивании:
  // их endpoint не должен визуально уходить к границе строки.
  const hasSingleVisibleIncomingEdge = (tableId, columnName) => {
    const tableInfo = getTableInfo(tableId);
    if (!tableInfo?.column_lineage) return false;
    const entry = tableInfo.column_lineage[columnName] ||
      Object.entries(tableInfo.column_lineage).find(
        ([name]) => name.toLowerCase() === columnName.toLowerCase(),
      )?.[1];
    if (!entry) return false;
    return getSources(entry).filter((src) => displayedTables.has(src.source_table)).length === 1;
  };

  const alignLayer = (targetDepth, sourceDepth) => {
    const tableIds = Array.from(layersMap.entries())
      .filter(([id, d]) => d === targetDepth)
      .map(([id]) => id);
    if (tableIds.length === 0) return;

    // ============================================
    // СМЕЩЕНИЕ ОТВЕТВЛЕНИЙ ОТ ОСНОВНОЙ ЦЕПОЧКИ
    // ============================================
    const nonMainCards = [];
    tableIds.forEach((tableId) => {
      const card = document.getElementById(`cll-card-${uniqueId}-${tableId}`);
      if (card && card.style.display !== "none" && !mainChainTables.has(tableId)) {
        nonMainCards.push({ tableId, card });
      }
    });

    // Смещаем non-main карточки вниз на фиксированное расстояние
    const BRANCH_OFFSET = 150; // пиксели
    nonMainCards.forEach(({ card }) => {
      const currentTransform = card.style.transform || "";
      const match = currentTransform.match(/translateY\(([^)]+)px\)/);
      const currentY = match ? parseFloat(match[1]) : 0;
      card.style.transform = `translateY(${currentY + BRANCH_OFFSET}px)`;
      globallyStackedCards.add(card);
    });

    const layerCards = [];
    tableIds.forEach((tableId) => {
      const card = document.getElementById(`cll-card-${uniqueId}-${tableId}`);
      if (!card) return;

      // Пропускаем карточки, которые уже были обработаны в вертикальных группах
      if (globallyStackedCards.has(card)) return;

      const deltas = [];
      const singleIncomingDeltas = [];
      const tableIdLower = tableId.toLowerCase();

      const addDelta = (delta, targetTableId, targetColumn) => {
        deltas.push(delta);
        if (hasSingleVisibleIncomingEdge(targetTableId, targetColumn)) {
          singleIncomingDeltas.push(delta);
        }
      };

      // ПРАВИЛО ЕДИНСТВЕННОГО РОДИТЕЛЯ (позиционирование):
      // Определяем, сколько уникальных source-таблиц на sourceDepth связаны с этой карточкой.
      const parentTablesAtSourceDepth = new Set();
      displayedTables.forEach((otherTableId) => {
        if (layersMap.get(otherTableId) === sourceDepth) {
          const tInfo = getTableInfo(tableId);
          if (tInfo && tInfo.column_lineage) {
            Object.values(tInfo.column_lineage).forEach(entry => {
              getSources(entry).forEach(src => {
                if (src.source_table === otherTableId) {
                  parentTablesAtSourceDepth.add(otherTableId);
                }
              });
            });
          }
        }
      });

      const isSingleParentAtLayer = parentTablesAtSourceDepth.size === 1;

      if (isSingleParentAtLayer) {
        // Single Parent: собираем deltas из ВСЕХ column_lineage соединений
        const singleParentId = Array.from(parentTablesAtSourceDepth)[0];
        const tInfo = getTableInfo(tableId);
        if (tInfo && tInfo.column_lineage) {
          Object.entries(tInfo.column_lineage).forEach(([targetCol, entry]) => {
            getSources(entry).forEach(src => {
              if (src.source_table === singleParentId) {
                const sEl = document.getElementById(
                  `cll-col-${uniqueId}-${singleParentId}-${sanitizeId(src.source_column)}`,
                );
                const tEl = document.getElementById(
                  `cll-col-${uniqueId}-${tableId}-${sanitizeId(targetCol)}`,
                );
                if (sEl && tEl) {
                  addDelta(
                    getCenterY(sEl) - getCenterY(tEl),
                    tableId,
                    targetCol,
                  );
                }
              }
            });
          });
        }
      } else {
        // Multi-parent: оригинальная логика — используем только highlightedLines
        highlightedLines.forEach((lineKey) => {
          // Ключи рёбер проброса ("prop-...") не содержат "->" — пропускаем
          if (!lineKey.includes("->")) return;
          const lineKeyLower = lineKey.toLowerCase();
          const [srcFull, tgtFull] = lineKeyLower.split("->");
          const srcTable = srcFull.substring(0, srcFull.lastIndexOf("."));
          const tgtTable = tgtFull.substring(0, tgtFull.lastIndexOf("."));

          if (
            srcTable === tableIdLower &&
            layersMapLower.get(tgtTable) === sourceDepth
          ) {
            const tgtOrig = layersMapOriginal.get(tgtTable);
            const srcOrig = layersMapOriginal.get(srcTable);
            const sEl = document.getElementById(
              `cll-col-${uniqueId}-${srcOrig}-${sanitizeId(srcFull.split(".").pop())}`,
            );
            const tEl = document.getElementById(
              `cll-col-${uniqueId}-${tgtOrig}-${sanitizeId(tgtFull.split(".").pop())}`,
            );
            if (sEl && tEl) {
              addDelta(
                getCenterY(tEl) - getCenterY(sEl),
                tgtOrig,
                tgtFull.split(".").pop(),
              );
            }
          } else if (
            tgtTable === tableIdLower &&
            layersMapLower.get(srcTable) === sourceDepth
          ) {
            const srcOrig = layersMapOriginal.get(srcTable);
            const tgtOrig = layersMapOriginal.get(tgtTable);
            const sEl = document.getElementById(
              `cll-col-${uniqueId}-${srcOrig}-${sanitizeId(srcFull.split(".").pop())}`,
            );
            const tEl = document.getElementById(
              `cll-col-${uniqueId}-${tgtOrig}-${sanitizeId(tgtFull.split(".").pop())}`,
            );
            if (sEl && tEl) {
              addDelta(
                getCenterY(sEl) - getCenterY(tEl),
                tgtOrig,
                tgtFull.split(".").pop(),
              );
            }
          }
        });
      }

      let median = 0;
      // Одиночные входы имеют приоритет: именно их можно выровнять по центру
      // без необходимости разводить несколько портов внутри одной строки.
      const alignmentDeltas = singleIncomingDeltas.length > 0
        ? singleIncomingDeltas
        : deltas;
      if (alignmentDeltas.length > 0) {
        alignmentDeltas.sort((a, b) => a - b);
        median = alignmentDeltas[Math.floor(alignmentDeltas.length / 2)];
      }

      const rect = card.getBoundingClientRect();
      const currentTransform = card.style.transform || "";
      const match = currentTransform.match(/translateY\(([^)]+)px\)/);
      const currentY = match ? parseFloat(match[1]) : 0;

      layerCards.push({
        id: tableId,
        el: card,
        naturalTop: rect.top / scale - currentY,
        height: rect.height / scale,
        idealDelta: median,
      });
    });

    // Sort cards by natural top position
    layerCards.sort((a, b) => a.naturalTop - b.naturalTop);

    // Collision resolution: ensure no overlap with at least 0px gap
    let lastBottom = -Infinity;
    const MIN_GAP = 0;

    layerCards.forEach((c) => {
      let targetTop = c.naturalTop + c.idealDelta;
      if (targetTop < lastBottom + MIN_GAP) {
        targetTop = lastBottom + MIN_GAP;
      }
      const finalDelta = targetTop - c.naturalTop;
      c.el.style.transform = `translateY(${finalDelta}px)`;
      lastBottom = targetTop + c.height;
    });
  };

  for (let d = -1; d >= minDepth; d--) alignLayer(d, d + 1);
  for (let d = 1; d <= maxDepth; d++) alignLayer(d, d - 1);

  // ============================================
  // ВЫРАВНИВАНИЕ ОСНОВНОЙ ЦЕПОЧКИ ПО ВЕРТИКАЛИ
  // ============================================
  const mainChainCardsByDepth = new Map();
  mainChainTables.forEach(tableId => {
    const depth = layersMap.get(tableId);
    if (depth !== undefined) {
      const card = document.getElementById(`cll-card-${uniqueId}-${tableId}`);
      if (card && card.style.display !== "none") {
        if (!mainChainCardsByDepth.has(depth)) {
          mainChainCardsByDepth.set(depth, []);
        }
        mainChainCardsByDepth.get(depth).push(card);
      }
    }
  });

  const sortedDepths = Array.from(mainChainCardsByDepth.keys()).sort((a, b) => a - b);

  // Выравниваем карточки основной цепочки по вертикали.
  // Для точности — по среднему центру колонок mainChain (не по центру карточки).
  if (sortedDepths.length > 1) {
    const firstDepth = sortedDepths[0];
    const firstCards = mainChainCardsByDepth.get(firstDepth);

    // Находим все колонки mainChain в первом слое и вычисляем их средний центр
    const firstDepthMainChainColKeys = new Set();
    firstCards?.forEach(card => {
      const tableId = card.querySelector('.cll-column[data-table-id]')?.getAttribute('data-table-id');
      if (tableId) {
        Array.from(card.querySelectorAll('.cll-column')).forEach(col => {
          const colKey = col.getAttribute('data-col-key');
          if (colKey && mainChainCols.has(colKey)) {
            firstDepthMainChainColKeys.add(colKey);
          }
        });
      }
    });

    let firstCenterY = 0;
    let firstCount = 0;
    firstDepthMainChainColKeys.forEach(colKey => {
      // Более надёжный способ найти элемент колонки по colKey
      document.querySelectorAll(`[data-col-key="${colKey}"]`).forEach(col => {
        const rect = col.getBoundingClientRect();
        firstCenterY += (rect.top + rect.height / 2) / scale;
        firstCount++;
      });
    });
    firstCenterY = firstCount > 0 ? firstCenterY / firstCount : 0;

    // Если не удалось найти колонки, используем центр первой карточки
    if (firstCount === 0 && firstCards && firstCards.length > 0) {
      const firstCardRect = firstCards[0].getBoundingClientRect();
      firstCenterY = (firstCardRect.top + firstCardRect.height / 2) / scale;
    }

    for (let i = 1; i < sortedDepths.length; i++) {
      const depth = sortedDepths[i];
      const cardsAtDepth = mainChainCardsByDepth.get(depth);
      if (cardsAtDepth) {
        cardsAtDepth.forEach(card => {
          const cardColKeys = [];
          Array.from(card.querySelectorAll('.cll-column')).forEach(col => {
            const colKey = col.getAttribute('data-col-key');
            if (colKey && mainChainCols.has(colKey)) {
              cardColKeys.push(colKey);
            }
          });

          let cardCenterY = 0;
          let cardCount = 0;
          cardColKeys.forEach(colKey => {
            document.querySelectorAll(`[data-col-key="${colKey}"]`).forEach(col => {
              const rect = col.getBoundingClientRect();
              cardCenterY += (rect.top + rect.height / 2) / scale;
              cardCount++;
            });
          });
          cardCenterY = cardCount > 0 ? cardCenterY / cardCount : 0;

          // Если не нашли колонки mainChain, используем центр карточки
          if (cardCount === 0) {
            const cardRect = card.getBoundingClientRect();
            cardCenterY = (cardRect.top + cardRect.height / 2) / scale;
          }

          const deltaY = firstCenterY - cardCenterY;
          const currentTransform = card.style.transform || "";
          const match = currentTransform.match(/translateY\(([^)]+)px\)/);
          const currentY = match ? parseFloat(match[1]) : 0;
          card.style.transform = `translateY(${currentY + deltaY}px)`;
          globallyStackedCards.add(card);
        });
      }
    }
  }

  // ============================================
  // ВЫРАВНИВАНИЕ КАРТОЧЕК В ОДНОМ СЛОЕ (с учётом количества таблиц в соседних слоях)
  // Правило: таблицы одного слоя касаются друг друга ТОЛЬКО,
  // если в текущем слое больше таблиц, чем в следующем (по направлению потока данных)
  // ============================================

  // Собираем количество таблиц в каждом слое
  const layerCounts = new Map();
  displayedTables.forEach(tableId => {
    const depth = layersMap.get(tableId);
    layerCounts.set(depth, (layerCounts.get(depth) || 0) + 1);
  });

  // Группируем ВСЕ карточки по слоям (включая те, что уже обработаны в mainChain)
  const allCardsByDepth = new Map();
  displayedTables.forEach(tableId => {
    const depth = layersMap.get(tableId);
    const card = document.getElementById(`cll-card-${uniqueId}-${tableId}`);
    if (card && card.style.display !== "none") {
      if (!allCardsByDepth.has(depth)) allCardsByDepth.set(depth, []);
      allCardsByDepth.get(depth).push(card);
    }
  });

  // Зазор между карточками в слоях, где касание не требуется
  const GAP_SIZE = 20;

  allCardsByDepth.forEach((layerCards, depth) => {
    if (layerCards.length <= 1) return;

    // Определяем, нужно ли касание: текущий слой имеет больше таблиц, чем следующий?
    const nextDepth = depth + 1;
    const currentCount = layerCounts.get(depth) || 0;
    const nextCount = layerCounts.get(nextDepth) || 0;
    const shouldTouch = currentCount > nextCount;
    const desiredGap = shouldTouch ? 0 : GAP_SIZE;

    // Сортируем по текущей Y-позиции (с учётом всех transform)
    layerCards.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top;
    });

    const cardData = layerCards.map(card => {
      const rect = card.getBoundingClientRect();
      const match = (card.style.transform || "").match(/translateY\(([^)]+)px\)/);
      const currentTY = match ? parseFloat(match[1]) : 0;
      return { card, top: rect.top / scale, height: rect.height / scale, currentTY };
    });

    // Проходим один раз сверху вниз: только толкаем вниз, никогда вверх
    let trackedBottom = cardData[0].top + cardData[0].height;

    for (let i = 1; i < cardData.length; i++) {
      const cd = cardData[i];
      const desiredTop = trackedBottom + desiredGap;

      if (cd.top < desiredTop) {
        const deltaY = desiredTop - cd.top;
        cd.card.style.transform = `translateY(${cd.currentTY + deltaY}px)`;
        trackedBottom = desiredTop + cd.height;
      } else {
        trackedBottom = cd.top + cd.height;
      }
    }
  });
}


