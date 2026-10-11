/*
MODULE: src/lineage/columnLineageEdges.js
ROLE: Маршрутизация и отрисовка рёбер (линий) в Column Lineage.

Содержит:
- _getTransitCardRects — вычисление прямоугольников промежуточных карточек для транзитных рёбер
- drawOrthogonalLine   — отрисовка одного ортогонального ребра в SVG
- drawLines            — полный цикл сбора соединений и отрисовки всех рёбер
*/

import { getSources } from "./columnLineageGraph.js";
import { sanitizeId } from "../utils/helpers.js";
import { MIN_TRACK_GAP, BASE_CHANNEL_WIDTH, EDGE_BEND_DISTANCE_SOURCE, EDGE_BEND_DISTANCE_TARGET } from "./columnLineageConstants.js";

// Счётчик транзитных обходов по «внешнему транзиту» — уникальные Y-уровни «магистралей».
// Сбрасывается в drawLines при каждом перерендере.
let transitBypassSeq = 0;

/**
 * Возвращает список прямоугольников карточек промежуточных слоёв,
 * через которые транзитное ребро (srcDepth → tgtDepth) может проходить.
 * Промежуточными считаются слои между srcDepth и tgtDepth (не включительно).
 *
 * @param {number} srcDepth - глубина слоя источника
 * @param {number} tgtDepth - глубина слоя цели
 * @param {Map} layersMap   - tableId → depth
 * @param {Map} allCardRects - tableId → { left, right, top, bottom } в canvas-координатах
 * @param {string} sourceTableId - id таблицы-источника (исключаем из промежуточных)
 * @param {string} targetTableId - id таблицы-цели (исключаем из промежуточных)
 * @returns {Array<{left, right, top, bottom}>}
 */
export function _getTransitCardRects(srcDepth, tgtDepth, layersMap, allCardRects, sourceTableId, targetTableId) {
  if (Math.abs(tgtDepth - srcDepth) <= 1) return []; // нет промежуточных слоёв

  const minDepth = Math.min(srcDepth, tgtDepth);
  const maxDepth = Math.max(srcDepth, tgtDepth);
  const result = [];

  layersMap.forEach((depth, tableId) => {
    if (depth > minDepth && depth < maxDepth) {
      // Это промежуточный слой
      if (tableId === sourceTableId || tableId === targetTableId) return;
      const r = allCardRects.get(tableId);
      if (r) result.push(r);
    }
  });

  return result;
}

function appendEdgePath(svg, pathD, lineKey, isHighlighted, isPropagation) {
  const path = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );
  path.setAttribute("d", pathD);
  path.setAttribute(
    "class",
    isPropagation ? "cll-path cll-path-propagation" : `cll-path ${isHighlighted ? "is-highlighted" : "is-faded"}`,
  );
  if (lineKey) path.setAttribute("data-line-key", lineKey);

  path.setAttribute("fill", "none");
  if (isPropagation) {
    path.setAttribute("stroke", "#8b5cf6");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("stroke-dasharray", "6,3");
    path.setAttribute("opacity", "0.9");
    path.setAttribute("data-propagation", "true");
  } else {
    path.setAttribute("stroke", isHighlighted ? "#1E40AF" : "#94A3B8");
    path.setAttribute("stroke-width", isHighlighted ? "3" : "2");
  }

  svg.appendChild(path);
}

function getEdgeGeometry(
  sourceRect,
  targetRect,
  canvasRect,
  scale,
  sourceOffsetIdx,
  totalSourceEdges,
  targetOffsetIdx,
  totalTargetEdges,
  singleParent,
) {
  const sourceCenterY =
    (sourceRect.top + sourceRect.height / 2 - canvasRect.top) / scale;
  const targetCenterY =
    (targetRect.top + targetRect.height / 2 - canvasRect.top) / scale;
  const sourceRowHeight = sourceRect.height / scale;
  const maxEdges = Math.max(totalSourceEdges, totalTargetEdges);
  const step = Math.min(14, sourceRowHeight / (maxEdges + 1));

  let startY = sourceCenterY;
  if (totalSourceEdges > 1) {
    startY += (sourceOffsetIdx - (totalSourceEdges + 1) / 2) * step;
  }

  let endY = targetCenterY;
  if (totalTargetEdges > 1) {
    endY += (targetOffsetIdx - (totalTargetEdges + 1) / 2) * step;
  }

  // Для одиночного входа допускаем прямую линию только очень близко к центру.
  const snapThreshold = totalTargetEdges > 1
    ? (singleParent ? 15 : 12)
    : Math.min(8, targetRect.height / 4);
  const shouldSnapToSource = Math.abs(startY - endY) * scale <= snapThreshold;
  if (shouldSnapToSource) endY = startY;

  return { startY, endY, isStraight: Math.abs(startY - endY) < 0.01 };
}
export function drawOrthogonalLine(
  uniqueId,
  sourceId,
  targetId,
  isHighlighted,
  sourceOffsetIdx = 1,
  lineKey = "",
  totalSourceEdges = 1,
  targetOffsetIdx = 1,
  totalTargetEdges = 1,
  edgeIdx = 0,
  totalEdges = 1,
  singleParent = false,
  transitCardRects = [],
  transitTrackIdx = 0,
  transitTrackTotal = 0,
  isPropagation = false,
) {
  const svg = document.getElementById(`cll-svg-${uniqueId}`);
  const canvas = document.getElementById(`cll-canvas-${uniqueId}`);
  const sourceEl = document.getElementById(sourceId);
  const targetEl = document.getElementById(targetId);

  if (!svg || !canvas || !sourceEl || !targetEl) return;

  const canvasRect = canvas.getBoundingClientRect();
  const sourceRect = sourceEl.getBoundingClientRect();
  const targetRect = targetEl.getBoundingClientRect();

  let scale = 1;
  if (canvas.offsetWidth > 0)
    scale = canvasRect.width / canvas.offsetWidth;

  const startX = (sourceRect.right - canvasRect.left) / scale;
  const endX = (targetRect.left - canvasRect.left) / scale;
  const { startY, endY } = getEdgeGeometry(
    sourceRect,
    targetRect,
    canvasRect,
    scale,
    sourceOffsetIdx,
    totalSourceEdges,
    targetOffsetIdx,
    totalTargetEdges,
    singleParent,
  );

  let routingChannel = EDGE_BEND_DISTANCE_TARGET + (totalEdges - 1 - edgeIdx) * MIN_TRACK_GAP;

  const gap = endX - startX;
  if (gap > 0) {
    const maxChannel = Math.max(10, gap - 10);

    if (routingChannel > maxChannel) {
      // Ищем минимально допустимый шаг (не меньше 4px, чтобы линии не сливались)
      let compressedStep = (maxChannel - EDGE_BEND_DISTANCE_TARGET) / (totalEdges || 1);
      if (compressedStep < 4) {
        compressedStep = 4;
      }

      // Пересчитываем каналы с новым шагом
      routingChannel = EDGE_BEND_DISTANCE_TARGET + (totalEdges - 1 - edgeIdx) * compressedStep;

      // Если выходим за maxChannel, сдвигаем всю пачку вправо (уменьшаем базу)
      if (EDGE_BEND_DISTANCE_TARGET + (totalEdges - 1) * compressedStep > maxChannel) {
        const overflow = (EDGE_BEND_DISTANCE_TARGET + (totalEdges - 1) * compressedStep) - maxChannel;
        const newBase = Math.max(10, EDGE_BEND_DISTANCE_TARGET - overflow);
        routingChannel = newBase + (totalEdges - 1 - edgeIdx) * compressedStep;
      }
    }
  } else {
    routingChannel = 20;
  }

  // Получаем карточки source и target для определения "Чистого Коридора"
  const sourceCard = sourceEl.closest('.cll-card');
  const targetCard = targetEl.closest('.cll-card');
  
  // Вычисляем границы карточек в координатах canvas
  const sourceCardRight = sourceCard 
    ? (sourceCard.getBoundingClientRect().right - canvasRect.left) / scale 
    : startX;
  const targetCardLeft = targetCard 
    ? (targetCard.getBoundingClientRect().left - canvasRect.left) / scale 
    : endX;

  // Clean Corridor (Чистый Коридор): вертикальный сегмент должен быть строго между карточками
  // Вычисляем базовую позицию канала
  let channelX = endX - routingChannel;
  
  // Гарантируем, что вертикальный сегмент не попадёт внутрь карточек
  // Вертикальный сегмент должен находиться строго правее sourceCardRight и левее targetCardLeft
  const minSafeX = sourceCardRight + 1;  // +1px отступ от правой границы источника
  const maxSafeX = targetCardLeft - 1;   // -1px отступ от левой границы цели
  
  // Определяем безопасную X-координату для вертикального сегмента
  let verticalX = channelX;
  
  // Если канал выходит за безопасные границы, корректируем
  if (channelX <= minSafeX) {
    verticalX = minSafeX + routingChannel;
  } else if (channelX >= maxSafeX) {
    verticalX = maxSafeX - routingChannel;
  }
  
  // Final clamp: вертикальный сегмент ДОЛЖЕН быть между карточками
  verticalX = Math.max(minSafeX, Math.min(maxSafeX, verticalX));

  // ======================================================================
  // ОБХОД ПРОМЕЖУТОЧНЫХ КАРТОЧЕК (Транзитные рёбра) — ВНЕШНИЙ ТРАНЗИТ
  // Горизонталь источника (на высоте startY) проходит сквозь промежуточные слои.
  // Если она пересекает карточку промежуточного слоя — строим 5-сегментный путь
  // с «магистралью» выше/ниже ВСЕХ промежуточных карточек.
  // ======================================================================
  if (transitCardRects.length > 0) {
    const crossingCards = transitCardRects.filter(
      (cr) => startY > cr.top && startY < cr.bottom
    );

    if (crossingCards.length > 0) {
      const topAll = Math.min(...transitCardRects.map((cr) => cr.top));
      const bottomAll = Math.max(...transitCardRects.map((cr) => cr.bottom));

      const PAD = 12;
      const midEdge = (startY + endY) / 2;
      const upDist = midEdge - (topAll - PAD);
      const downDist = (bottomAll + PAD) - midEdge;

      let routeY;
      if (upDist <= downDist) {
        routeY = topAll - PAD - transitBypassSeq * MIN_TRACK_GAP;
      } else {
        routeY = bottomAll + PAD + transitBypassSeq * MIN_TRACK_GAP;
      }
      transitBypassSeq++;

      const midX = verticalX;

      // X вертикали у источника: в зазоре между источником и первым промежуточным слоем.
      // Если выделен глобальный трек (drawLines) — используем его, иначе расчёт от числа рёбер.
      let cStartX;
      if (transitTrackTotal > 0) {
        const trackX = EDGE_BEND_DISTANCE_SOURCE + transitTrackIdx * MIN_TRACK_GAP;
        cStartX = endX >= startX ? startX + trackX : startX - trackX;
      } else {
        const trackOffset = EDGE_BEND_DISTANCE_SOURCE + Math.max(0, totalEdges - 1 - edgeIdx) * MIN_TRACK_GAP;
        cStartX = endX >= startX ? startX + trackOffset : startX - trackOffset;
      }
      if (endX >= startX) {
        const interLeft = Math.min(...transitCardRects.map((cr) => cr.left));
        cStartX = Math.min(cStartX, interLeft - 2);
        if (cStartX <= startX) cStartX = startX + 2;
        cStartX = Math.min(cStartX, midX - 2);
      } else {
        const interRight = Math.max(...transitCardRects.map((cr) => cr.right));
        cStartX = Math.max(cStartX, interRight + 2);
        if (cStartX >= startX) cStartX = startX - 2;
        cStartX = Math.max(cStartX, midX + 2);
      }

      const xDir = endX >= startX ? 1 : -1;
      const dirY1 = routeY >= startY ? 1 : -1;
      const dirY2 = endY >= routeY ? 1 : -1;
      const cornerRadius = 4;
      const r1 = Math.min(cornerRadius, Math.abs(routeY - startY) / 2, Math.abs(cStartX - startX));
      const r2 = Math.min(cornerRadius, Math.abs(routeY - startY) / 2, Math.abs(midX - cStartX));
      const r3 = Math.min(cornerRadius, Math.abs(endY - routeY) / 2, Math.abs(midX - cStartX));
      const r4 = Math.min(cornerRadius, Math.abs(endY - routeY) / 2, Math.abs(midX - endX));

      const pathD = `M ${startX} ${startY}
             L ${cStartX - r1 * xDir} ${startY}
             Q ${cStartX} ${startY} ${cStartX} ${startY + r1 * dirY1}
             L ${cStartX} ${routeY - r2 * dirY1}
             Q ${cStartX} ${routeY} ${cStartX + r2 * xDir} ${routeY}
             L ${midX - r3 * xDir} ${routeY}
             Q ${midX} ${routeY} ${midX} ${routeY + r3 * dirY2}
             L ${midX} ${endY - r4 * dirY2}
             Q ${midX} ${endY} ${midX + r4 * xDir} ${endY}
             L ${endX} ${endY}`;

      appendEdgePath(svg, pathD, lineKey, isHighlighted, isPropagation);
      return;
    }
  }
  // ======================================================================

  // Если startY === endY — линия горизонтальная, рисуем её прямо без изломов
  if (Math.abs(startY - endY) < 0.01) {
    const pathD = `M ${startX} ${startY} L ${endX} ${endY}`;

    appendEdgePath(svg, pathD, lineKey, isHighlighted, isPropagation);
    return; // Ранний выход — прямая линия, без ортогональной маршрутизации
  }

  // ======================================================================
  // ОБХОД ПРОМЕЖУТОЧНЫХ КАРТОЧЕК (Транзитные рёбра) — сдвиг вертикали влево
  // ======================================================================
  if (transitCardRects.length > 0) {
    const edgeMinY = Math.min(startY, endY);
    const edgeMaxY = Math.max(startY, endY);
    const bypassOffset = BASE_CHANNEL_WIDTH + Math.max(0, totalEdges - 1 - edgeIdx) * MIN_TRACK_GAP;

    for (const cr of transitCardRects) {
      const overlapY = edgeMinY < cr.bottom && edgeMaxY > cr.top;
      if (!overlapY) continue;

      const cardLeft  = cr.left;
      const cardRight = cr.right;

      if (verticalX > cardLeft - bypassOffset && verticalX < cardRight) {
        verticalX = cardLeft - bypassOffset;
        verticalX = Math.max(minSafeX, verticalX);
      }
    }

    verticalX = Math.min(maxSafeX, verticalX);
  }
  // ======================================================================

  const midX = verticalX;

  const radius = 4;
  const dirY = endY > startY ? 1 : -1;
  const r = Math.min(
    radius,
    Math.abs(endY - startY) / 2,
    Math.abs(midX - startX),
  );

  const pathD = `M ${startX} ${startY}
         L ${midX - r} ${startY}
         Q ${midX} ${startY} ${midX} ${startY + r * dirY} 
         L ${midX} ${endY - r * dirY} 
         Q ${midX} ${endY} ${midX + r} ${endY}
         L ${endX} ${endY}`;

  appendEdgePath(svg, pathD, lineKey, isHighlighted, isPropagation);
}

/**
 * Полный цикл сбора соединений и отрисовки всех рёбер Column Lineage.
 *
 * @param {object} ctx - контекст рендера
 * @param {string}   ctx.uniqueId          - уникальный ID вкладки
 * @param {Element}  ctx.pane              - корневой элемент панели
 * @param {Set}      ctx.displayedTables   - множество отображаемых tableId
 * @param {Map}      ctx.layersMap         - tableId → depth
 * @param {Set}      ctx.highlightedLines  - lineKey подсвеченных рёбер
 * @param {Function} ctx.getTableInfo      - (fullId) => tableInfo | null
 * @param {object}   ctx.drawnPaths        - Set для дедупликации рёбер (мутируется)
 * @param {object}   ctx.sourceOffsets     - объект смещений источников (мутируется)
 * @param {object}   ctx.targetOffsets     - объект смещений целей (мутируется)
 */
export function drawLines(ctx) {
  const {
    uniqueId, pane, displayedTables, layersMap,
    highlightedLines, getTableInfo,
    drawnPaths, sourceOffsets, targetOffsets,
  } = ctx;

  const svg = document.getElementById(`cll-svg-${uniqueId}`);
  const canvas = document.getElementById(`cll-canvas-${uniqueId}`);
  if (!svg || !canvas) return;
  svg.innerHTML = "";
  transitBypassSeq = 0;
  for (let key in sourceOffsets) delete sourceOffsets[key];
  for (let key in targetOffsets) delete targetOffsets[key];
  drawnPaths.clear();

  const sourceCounts = {};
  const targetCounts = {};
  const connections = [];

  // Pass 1: Collect everything and get vertical positions
  displayedTables.forEach((targetTableId) => {
    const tInfo = getTableInfo(targetTableId);
    if (!tInfo || !tInfo.column_lineage) return;
    Object.entries(tInfo.column_lineage).forEach(([targetCol, entry]) => {
      const tId = `cll-col-${uniqueId}-${targetTableId}-${sanitizeId(targetCol)}`;
      getSources(entry).forEach((src) => {
        const sourceTableId = src.source_table;
        const sourceCol = src.source_column;
        if (displayedTables.has(sourceTableId)) {
          // Если колонка '*', используем 'star', иначе штатный sanitizeId
          const safeSourceCol = sourceCol === "*" ? "star" : sanitizeId(sourceCol);
          const sId = `cll-col-${uniqueId}-${sourceTableId}-${safeSourceCol}`;

          const sEl = document.getElementById(sId);
          const tEl = document.getElementById(tId);
          if (!sEl || !tEl) return;

          // В фокусном режиме пропускаем рёбра к скрытым элементам
          if (sEl.style.display === "none" || tEl.style.display === "none") return;
          const sCard = sEl.closest(".cll-card");
          const tCard = tEl.closest(".cll-card");
          if (sCard && sCard.style.display === "none") return;
          if (tCard && tCard.style.display === "none") return;

          const sRect = sEl.getBoundingClientRect();
          const tRect = tEl.getBoundingClientRect();

          connections.push({
            sourceTableId,
            targetTableId,
            sourceDomId: sId,
            targetDomId: tId,
            lineKey: `${sourceTableId}.${sourceCol.toLowerCase()}->${targetTableId}.${targetCol.toLowerCase()}`,
            sourceY: sRect.top,
            targetY: tRect.top,
          });

          sourceCounts[sId] = (sourceCounts[sId] || 0) + 1;
          targetCounts[tId] = (targetCounts[tId] || 0) + 1;
        }
      });
    });
  });

  const canvasRect = canvas.getBoundingClientRect();
  let scale = 1;
  if (canvas.offsetWidth > 0)
    scale = canvasRect.width / canvas.offsetWidth;

  // ==================================================================================================
  // АРХИТЕКТУРНО ВАЖНАЯ ЛОГИКА ОРТОГОНАЛЬНОЙ МАРШРУТИЗАЦИИ ЛИНИЙ (НЕ ЛОМАТЬ И НЕ ИЗМЕНЯТЬ БЕЗ КРАЙНЕЙ НЕОБХОДИМОСТИ!)
  // Этот алгоритм гарантирует полное отсутствие бессмысленных "ступенчатых" пересечений линий.
  // Если сломать эти три этапа (Target Offset, Source Offset, Track Sorting) - линии превратятся в кашу.
  // ==================================================================================================

  // 1. ГЛОБАЛЬНЫЙ ПРЕДРАСЧЕТ ПИНОВ ЦЕЛИ (TARGET OFFSETS)
  const edgesByTarget = new Map();
  connections.forEach((c) => {
    if (!edgesByTarget.has(c.targetDomId)) edgesByTarget.set(c.targetDomId, []);
    edgesByTarget.get(c.targetDomId).push(c);
  });

  const precalculatedTargetOffsets = new Map();
  edgesByTarget.forEach((edges, tId) => {
    edges.sort((a, b) => a.sourceY - b.sourceY);
    edges.forEach((c, idx) => {
      precalculatedTargetOffsets.set(c.lineKey, idx + 1);
    });
  });

  // 2. ГЛОБАЛЬНЫЙ ПРЕДРАСЧЕТ ПИНОВ ИСТОЧНИКА (SOURCE OFFSETS)
  const edgesBySource = new Map();
  connections.forEach((c) => {
    if (!edgesBySource.has(c.sourceDomId)) edgesBySource.set(c.sourceDomId, []);
    edgesBySource.get(c.sourceDomId).push(c);
  });

  const precalculatedSourceOffsets = new Map();
  edgesBySource.forEach((edges, sId) => {
    edges.sort((a, b) => a.targetY - b.targetY);
    edges.forEach((c, idx) => {
      precalculatedSourceOffsets.set(c.lineKey, idx + 1);
    });
  });

  // ПРАВИЛО ЕДИНСТВЕННОГО РОДИТЕЛЯ:
  // Если у таблицы-приёмника только один уникальный родитель (sourceTable),
  // то линии не должны делать лишних изломов — хотя бы одна линия должна быть прямой горизонтальной.
  const parentCountByTarget = new Map();
  connections.forEach(c => {
    if (!parentCountByTarget.has(c.targetTableId)) {
      parentCountByTarget.set(c.targetTableId, new Set());
    }
    parentCountByTarget.get(c.targetTableId).add(c.sourceTableId);
  });

  // Единственный источник истины для endpoint-ов и решения о прямом ребре.
  const getConnectionGeometry = (c) => {
    const sourceEl = document.getElementById(c.sourceDomId);
    const targetEl = document.getElementById(c.targetDomId);
    if (!sourceEl || !targetEl) return null;
    const targetParents = parentCountByTarget.get(c.targetTableId);
    return getEdgeGeometry(
      sourceEl.getBoundingClientRect(),
      targetEl.getBoundingClientRect(),
      canvasRect,
      scale,
      precalculatedSourceOffsets.get(c.lineKey) || 1,
      sourceCounts[c.sourceDomId] || 1,
      precalculatedTargetOffsets.get(c.lineKey) || 1,
      targetCounts[c.targetDomId] || 1,
      Boolean(targetParents && targetParents.size === 1),
    );
  };

  // ДИНАМИЧЕСКИЙ ПЕРЕСЧЕТ ЗАЗОРОВ СЛОЕВ:
  // Вертикальный сегмент строится перед целевым слоем, поэтому ширину канала
  // считаем там же, а не у источника. Это важно для транзитных рёбер.
  const bentCounts = new Map();
  connections.forEach(c => {
    const geometry = getConnectionGeometry(c);
    const targetDepth = layersMap.get(c.targetTableId);
    if (!geometry || targetDepth === undefined || geometry.isStraight) return;
    const corridorDepth = targetDepth - 1;
    bentCounts.set(corridorDepth, (bentCounts.get(corridorDepth) || 0) + 1);
  });

  // Обновляем margin-right слоёв на основе количества изогнутых линий.
  // rightBlock — вертикали у целевой стороны зазора (изогнутые + прямые транзитные V2),
  // leftBlock — вертикали «внешнего транзита» у стороны источника (V1).
  const layers = pane.querySelectorAll(".cll-layer");

  const applyMargins = (transitSourceCounts, straightTransitTargetCounts) => {
    layers.forEach((layer) => {
      const card = layer.querySelector(".cll-card");
      if (!card) return;
      const colEl = card.querySelector(".cll-column[data-table-id]");
      if (!colEl) return;
      const tableId = colEl.getAttribute("data-table-id");
      const depth = layersMap.get(tableId);

      const bentCount = bentCounts.get(depth) || 0;
      const rightBlock = bentCount + (straightTransitTargetCounts.get(depth) || 0);
      const leftBlock = transitSourceCounts.get(depth) || 0;

      const gapVal = EDGE_BEND_DISTANCE_SOURCE
        + Math.max(0, rightBlock - 1) * MIN_TRACK_GAP
        + EDGE_BEND_DISTANCE_TARGET
        + (leftBlock > 0 ? leftBlock * MIN_TRACK_GAP : 0);
      layer.style.marginRight = gapVal + "px";
    });
  };

  const collectCardRects = () => {
    const rects = new Map();
    displayedTables.forEach((tableId) => {
      const card = document.getElementById(`cll-card-${uniqueId}-${tableId}`);
      if (!card || card.style.display === "none") return;
      const r = card.getBoundingClientRect();
      rects.set(tableId, {
        left:   (r.left   - canvasRect.left) / scale,
        right:  (r.right  - canvasRect.left) / scale,
        top:    (r.top    - canvasRect.top)  / scale,
        bottom: (r.bottom - canvasRect.top)  / scale,
      });
    });
    return rects;
  };

  // Первичный проход — целевые коридоры (эквивалент прежней логики)
  applyMargins(new Map(), new Map());
  const prelimCardRects = collectCardRects();

  // ======================================================================
  // ПРЕДРАСЧЕТ ТРАНЗИТНЫХ ОБХОДОВ («внешний транзит»)
  // Определяем рёбра, чья горизонталь источника (startY) пересекает промежуточную
  // карточку. Для них выделяем уникальные X-треки V1 в зазоре источника и
  // дополнительные V2 для прямых транзитных рёбер, затем расширяем зазоры слоёв.
  // ======================================================================
  const transitSourceCounts = new Map();
  const straightTransitTargetCounts = new Map();
  const transitSourceTracks = new Map();
  const straightTransitTracks = new Map();

  const crossingTransit = [];
  connections.forEach((c) => {
    const srcDepth = layersMap.get(c.sourceTableId);
    const tgtDepth = layersMap.get(c.targetTableId);
    if (srcDepth === undefined || tgtDepth === undefined) return;
    if (Math.abs(tgtDepth - srcDepth) <= 1) return;
    const geometry = getConnectionGeometry(c);
    if (!geometry) return;
    const transitCardRects = _getTransitCardRects(
      srcDepth, tgtDepth, layersMap, prelimCardRects,
      c.sourceTableId, c.targetTableId
    );
    if (transitCardRects.length === 0) return;
    const crossing = transitCardRects.some(
      (cr) => geometry.startY > cr.top && geometry.startY < cr.bottom
    );
    if (!crossing) return;
    crossingTransit.push({
      c,
      geometry,
      isStraight: geometry.isStraight,
      srcCorridor: tgtDepth > srcDepth ? srcDepth : srcDepth - 1,
    });
  });

  const sourceCorridorGroups = new Map();
  crossingTransit.forEach((item) => {
    if (!sourceCorridorGroups.has(item.srcCorridor)) {
      sourceCorridorGroups.set(item.srcCorridor, []);
    }
    sourceCorridorGroups.get(item.srcCorridor).push(item);
  });
  sourceCorridorGroups.forEach((items, corridor) => {
    transitSourceCounts.set(corridor, items.length);
    items.forEach((item, idx) => {
      transitSourceTracks.set(item.c.lineKey, { idx, total: items.length });
    });
  });

  const straightTransitCorridorGroups = new Map();
  crossingTransit.forEach((item) => {
    if (!item.isStraight) return;
    const tgtCorridor = layersMap.get(item.c.targetTableId) - 1;
    if (!straightTransitCorridorGroups.has(tgtCorridor)) {
      straightTransitCorridorGroups.set(tgtCorridor, []);
    }
    straightTransitCorridorGroups.get(tgtCorridor).push(item);
  });
  straightTransitCorridorGroups.forEach((items, corridor) => {
    straightTransitTargetCounts.set(corridor, items.length);
    items.forEach((item, idx) => {
      straightTransitTracks.set(item.c.lineKey, { idx, total: items.length });
    });
  });
  // ======================================================================

  // Повторный пересчёт margins с учётом транзитных вертикалей и финальные rect'ы
  applyMargins(transitSourceCounts, straightTransitTargetCounts);
  const allCardRects = collectCardRects();

  // ГЛОБАЛЬНАЯ АЛЛОКАЦИЯ ТРЕКОВ ПО ФАКТИЧЕСКОМУ КАНАЛУ ПЕРЕД ЦЕЛЬЮ.
  // В одном канале все вертикальные сегменты получают уникальные X-треки,
  // включая транзитные рёбра от разных исходных слоёв.
  const edgesByTargetCorridor = new Map();
  connections.forEach(c => {
    const targetDepth = layersMap.get(c.targetTableId);
    if (targetDepth === undefined) return;
    const corridorDepth = targetDepth - 1;
    if (!edgesByTargetCorridor.has(corridorDepth)) {
      edgesByTargetCorridor.set(corridorDepth, []);
    }
    edgesByTargetCorridor.get(corridorDepth).push(c);
  });

  edgesByTargetCorridor.forEach((depthEdges) => {
    const bentEdges = [];
    const straightEdges = [];

    depthEdges.forEach((c) => {
      const geometry = getConnectionGeometry(c);
      if (!geometry) return;

      if (geometry.isStraight) {
        straightEdges.push(c);
      } else {
        c.isUp = geometry.endY < geometry.startY;
        bentEdges.push(c);
      }
    });

    // Сортируем только bentEdges
    bentEdges.sort((a, b) => {
      if (a.isUp !== b.isUp) {
        return a.isUp ? 1 : -1;
      }
      if (!a.isUp) {
        return b.sourceY - a.sourceY || b.targetY - a.targetY;
      } else {
        return a.sourceY - b.sourceY || a.targetY - b.targetY;
      }
    });

    // Рисуем изогнутые линии с треками
    bentEdges.forEach((c, bentEdgeIdx) => {
      const targetParentsSet = parentCountByTarget.get(c.targetTableId);
      const isSingleParent = targetParentsSet && targetParentsSet.size === 1;
      const isHighlighted = highlightedLines.has(c.lineKey);

      const dupKey = `${c.sourceDomId}-${c.targetDomId}`;
      if (!drawnPaths.has(dupKey)) {
        drawnPaths.add(dupKey);
        const srcDepth = layersMap.get(c.sourceTableId);
        const tgtDepth = layersMap.get(c.targetTableId);
        const transitCardRects = _getTransitCardRects(
          srcDepth, tgtDepth, layersMap, allCardRects,
          c.sourceTableId, c.targetTableId
        );
        const tSrc = transitSourceTracks.get(c.lineKey);
        drawOrthogonalLine(
          uniqueId,
          c.sourceDomId,
          c.targetDomId,
          isHighlighted,
          precalculatedSourceOffsets.get(c.lineKey) || 1,
          c.lineKey,
          sourceCounts[c.sourceDomId] || 1,
          precalculatedTargetOffsets.get(c.lineKey) || 1,
          targetCounts[c.targetDomId] || 1,
          bentEdgeIdx,
          bentEdges.length,
          isSingleParent,
          transitCardRects,
          tSrc ? tSrc.idx : 0,
          tSrc ? tSrc.total : 0,
        );
      }
    });

    // Рисуем горизонтальные (прямые) линии без треков
    straightEdges.forEach((c) => {
      const targetParentsSet = parentCountByTarget.get(c.targetTableId);
      const isSingleParent = targetParentsSet && targetParentsSet.size === 1;
      const isHighlighted = highlightedLines.has(c.lineKey);

      const dupKey = `${c.sourceDomId}-${c.targetDomId}`;
      if (!drawnPaths.has(dupKey)) {
        drawnPaths.add(dupKey);
        const srcDepth = layersMap.get(c.sourceTableId);
        const tgtDepth = layersMap.get(c.targetTableId);
        const transitCardRects = _getTransitCardRects(
          srcDepth, tgtDepth, layersMap, allCardRects,
          c.sourceTableId, c.targetTableId
        );
        const tSrc = transitSourceTracks.get(c.lineKey);
        const tStraight = straightTransitTracks.get(c.lineKey);
        const straightTotal = tStraight ? bentEdges.length + tStraight.total : 0;
        const straightEdgeIdx = tStraight ? bentEdges.length + tStraight.total - 1 - tStraight.idx : 0;
        drawOrthogonalLine(
          uniqueId,
          c.sourceDomId,
          c.targetDomId,
          isHighlighted,
          precalculatedSourceOffsets.get(c.lineKey) || 1,
          c.lineKey,
          sourceCounts[c.sourceDomId] || 1,
          precalculatedTargetOffsets.get(c.lineKey) || 1,
          targetCounts[c.targetDomId] || 1,
          straightEdgeIdx,
          straightTotal,
          isSingleParent,
          transitCardRects,
          tSrc ? tSrc.idx : 0,
          tSrc ? tSrc.total : 0,
        );
      }
    });
  });
}

/**
 * Отрисовка рёбер проброса колонок
 * @param {Object} ctx - контекст
 * @param {string} ctx.uniqueId - уникальный ID вкладки
 * @param {HTMLElement} ctx.pane - панель Column Lineage
 * @param {Set<string>} ctx.displayedTables - множество отображаемых таблиц
 * @param {Map<string, number>} ctx.layersMap - карта слоёв
 * @param {Map<string, Object>} ctx.propagationEdges - рёбра проброса
 * @param {Function} ctx.getTableInfo - функция получения информации о таблице
 * @param {Object} ctx.sourceOffsets - смещения источников
 * @param {Object} ctx.targetOffsets - смещения целей
 */
export function drawPropagationEdges(ctx) {
  const {
    uniqueId, pane, displayedTables, layersMap,
    propagationEdges, getTableInfo,
    sourceOffsets, targetOffsets,
  } = ctx;

  const svg = document.getElementById(`cll-svg-${uniqueId}`);
  const canvas = document.getElementById(`cll-canvas-${uniqueId}`);
  if (!svg || !canvas) return;

  const canvasRect = canvas.getBoundingClientRect();
  let scale = 1;
  if (canvas.offsetWidth > 0)
    scale = canvasRect.width / canvas.offsetWidth;

  propagationEdges.forEach((edgeInfo, edgeKey) => {
    const { parentTableId, childTableId, columnName } = edgeInfo;
    // Для колонок-копий исходного id (_cd) ребро ищет исходную колонку родителя
    // (columnName = 'id'), а колонку потомка — по имени childColumnName.
    const childColumnName = edgeInfo.childColumnName || columnName;

    // Ищем DOM элементы пропущенной колонки
    const propagatedColKey = `${childTableId}.${childColumnName.toLowerCase()}`;
    const safeColumnName = sanitizeId(childColumnName);
    const propagatedColId = `cll-col-${uniqueId}-${childTableId}-${safeColumnName}-prop`;
    
    // Ищем родительскую колонку
    const safeParentColumnName = sanitizeId(columnName);
    const parentColId = `cll-col-${uniqueId}-${parentTableId}-${safeParentColumnName}`;
    
    const parentColEl = document.getElementById(parentColId) ||
      document.querySelector(`[data-table-id="${parentTableId}"][data-col-name="${columnName}"]`);
    const propagatedColEl = document.getElementById(propagatedColId) ||
      document.querySelector(`[data-col-key="${propagatedColKey}"][data-propagated="true"]`);

    if (!parentColEl || !propagatedColEl) return;

    const sourceRect = parentColEl.getBoundingClientRect();
    const targetRect = propagatedColEl.getBoundingClientRect();

    const startX = (sourceRect.right - canvasRect.left) / scale;
    const endX = (targetRect.left - canvasRect.left) / scale;
    const startY = (sourceRect.top + sourceRect.height / 2 - canvasRect.top) / scale;
    const endY = (targetRect.top + targetRect.height / 2 - canvasRect.top) / scale;

    const dx = endX - startX;
    const midX = startX + Math.max(30, dx / 2);

    let pathD = "";
    if (Math.abs(startY - endY) < 1) {
      pathD = `M ${startX} ${startY} L ${endX} ${endY}`;
    } else {
      pathD = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
    }

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathD);
    path.setAttribute("data-line-key", edgeKey);
    path.setAttribute("data-propagation", "true");
    path.setAttribute("class", "cll-path cll-path-propagation");
    path.setAttribute("stroke", "#8b5cf6");
    path.setAttribute("stroke-width", "2.5");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-dasharray", "6,3");
    path.setAttribute("opacity", "0.95");

    svg.appendChild(path);
  });
}



