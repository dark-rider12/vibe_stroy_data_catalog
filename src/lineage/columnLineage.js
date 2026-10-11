/* 
MODULE: src/lineage/columnLineage.js
ROLE: Отрисовка графа зависимостей на уровне колонок (Column-Level Lineage).
Оркестратор: инициализация, pan/zoom, toolbar, event listeners.
Вся тяжёлая логика вынесена в подмодули:
  - columnLineageGraph.js   — построение графа, трассировка
  - columnLineageCards.js   — генерация HTML карточек
  - columnLineageEdges.js   — маршрутизация и отрисовка рёбер
  - columnLineageLayout.js  — позиционирование карточек
  - columnLineageFocus.js   — управление фокусным режимом
  - columnLineageConstants.js — константы визуализации
*/

import { switchTab } from "../ui/layout.js";
import { sanitizeId } from "../utils/helpers.js";
import { navigateTo } from "../routing/navigation.js";
import { applyFocusMode, updateLayerGaps, saveOriginalLayerGaps, buildFocusToggleBtn, updateFocusBtn } from "./columnLineageFocus.js";
import { drawLines, drawPropagationEdges } from "./columnLineageEdges.js";
import { MIN_TRACK_GAP, BASE_CHANNEL_WIDTH, EDGE_BEND_DISTANCE_SOURCE, EDGE_BEND_DISTANCE_TARGET } from "./columnLineageConstants.js";
import { buildCard } from "./columnLineageCards.js";
import { buildLayersMap, traceLineage, calcColumnEdgeCounts, getSources } from "./columnLineageGraph.js";
import { optimizeCardPositions } from "./columnLineageLayout.js";
import { initPropagation, cleanupPropagation, getPropagationEdges, getPropagatedColumns, updateTableCardSqlButtons, addPropagatedColumn, addTechnicalColumns, filterTechnicalColumns } from "./columnLineagePropagation.js";
import { initTablePropagation, cleanupTablePropagation, getVirtualTables } from "./tablePropagation.js";

export function openColumnLineage(uniqueId, columnName) {
  const tabBtn = document.getElementById(`tab-col-lineage-${uniqueId}`);
  if (tabBtn) {
    tabBtn.style.display = "inline-block";
    tabBtn.innerText = `Lineage: ${columnName}`;
    switchTab(tabBtn, "pane-col-lineage", uniqueId);
  }

  // Показываем спиннер немедленно, давая браузеру тик для отрисовки
  const parent = document.getElementById(uniqueId);
  const pane = parent?.querySelector(".pane-col-lineage");
  const spinner = pane?.querySelector(".lineage-loading-spinner");
  if (spinner) spinner.style.display = "block";

  // Тяжёлый рендер запускается в idle-время, после того как спиннер отрисован
  const rIC = window.requestIdleCallback || ((cb) => setTimeout(cb, 16));
  rIC(() => {
    try {
      renderColumnLineage(uniqueId, columnName);
    } finally {
      if (spinner) spinner.style.display = "none";
    }
  }, { timeout: 300 });
}

export function renderColumnLineage(uniqueId, columnName) {
  const parent = document.getElementById(uniqueId);
  if (!parent) return;
  const pane = parent.querySelector(".pane-col-lineage");
  if (!pane) return;

  // Очистка состояния проброса при переоткрытии вкладки.
  // Флаг __tablePropagationRerender позволяет rerenderCallback обойти очистку виртуальных таблиц.
  cleanupPropagation(uniqueId);
  if (!window.__tablePropagationRerender) {
    cleanupTablePropagation(uniqueId);
  }

  const parts = uniqueId.split("-");
  if (parts.length !== 3) return;
  const [dbTarget, schemaTarget, nameTarget] = parts;
  const centerTableId = `${dbTarget}.${schemaTarget}.${nameTarget}`;

  const centerTableInfo =
    window.catalogData[dbTarget]?.[schemaTarget]?.[nameTarget];
  if (!centerTableInfo) return;

  const getTableInfo = (fullId) => {
    // Сначала ищем виртуальные таблицы (созданные через Table Propagation)
    const vt = getVirtualTables().get(fullId.toLowerCase());
    if (vt) return vt;
    const p = fullId.split(".");
    if (p.length !== 3) return null;
    return window.catalogData[p[0]]?.[p[1]]?.[p[2]];
  };

  // Рёбра проброса текущей вкладки — участвуют в трассировке подсветки
  const getTabPropagationEdges = () => {
    const arr = [];
    getPropagationEdges().forEach((info) => {
      if (info.uniqueId === uniqueId) arr.push(info);
    });
    return arr;
  };

  // Построение карты слоёв и трассировка lineage — columnLineageGraph.js
  const layersMap = buildLayersMap(centerTableId, getTableInfo);
  const displayedTables = new Set(layersMap.keys());

  // Mutable sets — mutated in-place by updateHighlight
  const highlightedCols = new Set();
  const highlightedLines = new Set();
  let activeTableId = centerTableId;
  let activeColName = columnName;
  const { highlightedCols: initCols, highlightedLines: initLines } =
    traceLineage(centerTableId, columnName.toLowerCase(), displayedTables, getTableInfo, getTabPropagationEdges());
  initCols.forEach((k) => highlightedCols.add(k));
  initLines.forEach((k) => highlightedLines.add(k));

  // Подсчёт рёбер для адаптивной высоты карточек
  const { columnSourceCounts, columnTargetCounts } =
    calcColumnEdgeCounts(displayedTables, getTableInfo);

  // buildCard wrapper
  const buildCardLocal = (fullId, isCenter) =>
    buildCard(fullId, isCenter, uniqueId, highlightedCols, columnSourceCounts, columnTargetCounts, getTableInfo);

  let minDepth = 0,
    maxDepth = 0;
  layersMap.forEach((depth) => {
    if (depth < minDepth) minDepth = depth;
    if (depth > maxDepth) maxDepth = depth;
  });

  // Count edges per corridor to calculate dynamic gaps
  const corridorCounts = new Map();
  displayedTables.forEach((targetTableId) => {
    const tInfo = getTableInfo(targetTableId);
    if (!tInfo || !tInfo.column_lineage) return;
    Object.entries(tInfo.column_lineage).forEach(([targetCol, entry]) => {
      getSources(entry).forEach((src) => {
        const sourceTableId = src.source_table;
        if (displayedTables.has(sourceTableId)) {
          const sDepth = layersMap.get(sourceTableId);
          corridorCounts.set(sDepth, (corridorCounts.get(sDepth) || 0) + 1);
        }
      });
    });
  });

  let layoutHtml = "";
  for (let d = minDepth; d <= maxDepth; d++) {
    const tablesAtDepth = Array.from(layersMap.entries())
      .filter(([id, depth]) => depth === d)
      .map(([id]) => id);

    if (tablesAtDepth.length > 0) {
      const layerHtml = tablesAtDepth
        .map((id) => buildCardLocal(id, id === centerTableId))
        .join("");

      const edgeCount = corridorCounts.get(d) || 0;
      const dynamicGap = EDGE_BEND_DISTANCE_SOURCE + Math.max(0, edgeCount - 1) * MIN_TRACK_GAP + EDGE_BEND_DISTANCE_TARGET;
      const style = d < maxDepth ? `style="margin-right: ${dynamicGap}px"` : "";

      layoutHtml += `<div class="lineage-layer cll-layer" ${style}>${layerHtml}</div>`;
    }
  }

  // Состояние фокусного режима.
  // Сохраняем между rerender-ами (в т.ч. при Table Propagation) в window.__cllFocusModes
  // По умолчанию: true = фокусный режим. Если пользователь переключил на полный — сохраняем.
  if (!window.__cllFocusModes) window.__cllFocusModes = new Map();
  const savedFocus = window.__cllFocusModes.get(uniqueId);
  let focusMode = (savedFocus !== undefined) ? savedFocus : true;

  const html = `
<div class="lineage-container">
  <div class="lineage-toolbar">
      <button class="ln-tool-btn" data-tool="zoom-out" title="Уменьшить"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
      <button class="ln-tool-btn" data-tool="zoom-in" title="Увеличить"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg></button>
      <button class="ln-tool-btn" data-tool="fit" title="Вписать экран"><svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 15v6h-6M3 9V3h6"/></svg></button>
      <div class="ln-toolbar-sep"></div>
      ${buildFocusToggleBtn(focusMode)}
  </div>
  <div class="lineage-viewport">
      <div class="lineage-content">
          <div class="lineage-canvas" id="cll-canvas-${uniqueId}" style="position: relative; min-height: 400px;">
              <svg class="lineage-svg" id="cll-svg-${uniqueId}" style="position: absolute; top:0; left:0; width:100%; height:100%; overflow: visible; pointer-events: none; z-index: 5;"></svg>
              <div class="lineage-layout cll-layout-container" style="position: relative; z-index: 10;">
                  ${layoutHtml}
              </div>
          </div>
      </div>
  </div>
</div>
`;

  pane.innerHTML = html;
  pane.classList.toggle("cll-focus-mode", focusMode);

  // Pan & Zoom
  const viewport = pane.querySelector(".lineage-viewport");
  const content = pane.querySelector(".lineage-content");
  const innerCanvas = pane.querySelector(".lineage-canvas");
  let scale = 1,
    tx = 0,
    ty = 0;

  // Синхронизируем локальные scale/tx/ty с фактически применённым transform
  // на content. Сценарий: Table Propagation после перерисовки графа применяет
  // auto-fit zoom НАПРЯМУЮ через content.style.transform (не через эти
  // переменные), поэтому перед каждым действием зума/пана нужно подхватывать
  // актуальные значения — иначе первое взаимодействие сделает резкий рывок.
  const syncViewFromDom = () => {
    const cur = content.style.transform;
    if (!cur) return;
    const mScale = cur.match(/scale\(([-\d.]+)\)/);
    if (mScale) scale = parseFloat(mScale[1]);
    const mTranslate = cur.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    if (mTranslate) {
      tx = parseFloat(mTranslate[1]);
      ty = parseFloat(mTranslate[2]);
    }
  };

  syncViewFromDom();

  const updateTransform = (smooth = true) => {
    content.style.transition = smooth ? "transform 0.1s ease-out" : "none";
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      syncViewFromDom();
      const rect = viewport.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.max(0.1, Math.min(4, scale * delta));
      tx = mouseX - (mouseX - tx) * (newScale / scale);
      ty = mouseY - (mouseY - ty) * (newScale / scale);
      scale = newScale;
      updateTransform();
    },
    { passive: false },
  );

  let isPanning = false, startX, startY;
  viewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    syncViewFromDom();
    isPanning = true;
    startX = e.clientX - tx;
    startY = e.clientY - ty;
    content.style.transition = "none";
  });

  const onMouseMove = (e) => {
    if (!isPanning) return;
    tx = e.clientX - startX;
    ty = e.clientY - startY;
    updateTransform(false);
  };
  const onMouseUp = () => { isPanning = false; };

  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  // Shared state for drawLines (mutable, passed by reference)
  const sourceOffsets = {};
  const targetOffsets = {};
  const drawnPaths = new Set();

  // optimizeCardPositions wrapper — passes closure context as params
  const optimizeLocal = () => optimizeCardPositions({
    pane, uniqueId, layersMap, displayedTables,
    minDepth, maxDepth,
    highlightedLines, highlightedCols,
    centerTableId, columnName,
    getTableInfo,
  });

  // drawLines wrapper
  const drawLinesLocal = () => drawLines({
    uniqueId, pane, displayedTables, layersMap,
    highlightedLines, getTableInfo,
    drawnPaths, sourceOffsets, targetOffsets,
  });

  // Функция перерисовки рёбер проброса
  const drawPropagationEdgesLocal = () => {
    const propagationEdges = getPropagationEdges();
    drawPropagationEdges({
      uniqueId, pane, displayedTables, layersMap,
      propagationEdges, getTableInfo,
      sourceOffsets, targetOffsets,
    });
  };

  // Toolbar buttons
  pane.querySelectorAll(".ln-tool-btn").forEach((btn) => {
    btn.onclick = () => {
      const tool = btn.dataset.tool;
      if (tool === "focus-toggle") {
        focusMode = !focusMode;
        // Сохраняем выбор пользователя между rerender-ами
        window.__cllFocusModes.set(uniqueId, focusMode);
        pane.classList.toggle("cll-focus-mode", focusMode);
        updateFocusBtn(pane, focusMode);
        applyFocusMode(pane, highlightedCols, focusMode);
        updateLayerGaps(pane, focusMode, EDGE_BEND_DISTANCE_SOURCE, MIN_TRACK_GAP, EDGE_BEND_DISTANCE_TARGET);
        requestAnimationFrame(() => {
          optimizeLocal();
          void pane.offsetHeight;
          requestAnimationFrame(() => {
            drawLinesLocal();
            // drawLines очищает SVG — восстанавливаем рёбра проброса и их подсветку
            drawPropagationEdgesLocal();
            updateLineStyles();
            // Auto-fit on mode toggle
            const pad = 40;
            const sw = innerCanvas.offsetWidth, sh = innerCanvas.offsetHeight;
            const vw = viewport.clientWidth, vh = viewport.clientHeight;
            scale = Math.min((vw - pad) / sw, (vh - pad) / sh, 1);
            tx = (vw - sw * scale) / 2;
            ty = (vh - sh * scale) / 2;
            updateTransform();
          });
        });
        return;
      }
      if (tool === "zoom-in") {
        syncViewFromDom();
        const oldScale = scale;
        scale = Math.min(4, scale * 1.25);
        tx = viewport.clientWidth / 2 - (viewport.clientWidth / 2 - tx) * (scale / oldScale);
        ty = viewport.clientHeight / 2 - (viewport.clientHeight / 2 - ty) * (scale / oldScale);
      } else if (tool === "zoom-out") {
        syncViewFromDom();
        const oldScale = scale;
        scale = Math.max(0.1, scale * 0.8);
        tx = viewport.clientWidth / 2 - (viewport.clientWidth / 2 - tx) * (scale / oldScale);
        ty = viewport.clientHeight / 2 - (viewport.clientHeight / 2 - ty) * (scale / oldScale);
      } else if (tool === "fit") {
        syncViewFromDom();
        const pad = 40;
        const sw = innerCanvas.offsetWidth, sh = innerCanvas.offsetHeight;
        const vw = viewport.clientWidth, vh = viewport.clientHeight;
        scale = Math.min((vw - pad) / sw, (vh - pad) / sh, 1);
        tx = (vw - sw * scale) / 2;
        ty = (vh - sh * scale) / 2;
      }
      updateTransform();
    };
  });

  // Update SVG path highlight styles without full redraw
  const updateLineStyles = () => {
    const svg = document.getElementById(`cll-svg-${uniqueId}`);
    if (!svg) return;
    svg.querySelectorAll("path[data-line-key]").forEach((pathEl) => {
      // Рёбра проброса стилизуются отдельно — сохраняем пунктирный фиолетовый
      if (pathEl.getAttribute("data-propagation") === "true") return;
      const key = pathEl.getAttribute("data-line-key");
      const isHighlighted = highlightedLines.has(key);
      pathEl.setAttribute("class", `cll-path ${isHighlighted ? "is-highlighted" : "is-faded"}`);
      pathEl.setAttribute("stroke", isHighlighted ? "#1E40AF" : "#1E293B");
      pathEl.setAttribute("stroke-width", isHighlighted ? "3" : "2");
    });
    // Рёбра проброса: подсветка = жирнее и ярче, затухание = приглушение opacity
    svg.querySelectorAll('path[data-propagation="true"]').forEach((pathEl) => {
      const isHighlighted = highlightedLines.has(pathEl.getAttribute("data-line-key"));
      pathEl.setAttribute("stroke-width", isHighlighted ? "6" : "2.5");
      pathEl.setAttribute("opacity", isHighlighted ? "1" : "0.25");
      pathEl.classList.toggle("is-line-hl", isHighlighted);
    });
  };

  // Re-trace lineage from a new column click
  const updateHighlight = (tableId, colName) => {
    activeTableId = tableId;
    activeColName = colName;
    highlightedCols.clear();
    highlightedLines.clear();

    const { highlightedCols: newCols, highlightedLines: newLines } =
      traceLineage(tableId, colName.toLowerCase(), displayedTables, getTableInfo, getTabPropagationEdges());
    newCols.forEach((k) => highlightedCols.add(k));
    newLines.forEach((k) => highlightedLines.add(k));

    pane.querySelectorAll(".cll-column").forEach((el) => {
      const key = el.getAttribute("data-col-key");
      if (highlightedCols.has(key)) {
        el.classList.add("is-selected");
        el.classList.remove("is-faded");
        el.style.opacity = "";
      } else {
        el.classList.remove("is-selected");
        el.classList.add("is-faded");
        el.style.opacity = "0.8";
      }
    });

    applyFocusMode(pane, highlightedCols, focusMode);

    if (focusMode) {
      updateLayerGaps(pane, focusMode, EDGE_BEND_DISTANCE_SOURCE, MIN_TRACK_GAP, EDGE_BEND_DISTANCE_TARGET);
      requestAnimationFrame(() => {
        optimizeLocal();
        void pane.offsetHeight;
        requestAnimationFrame(() => {
          drawLinesLocal();
          // drawLines очищает SVG — рёбра проброса нужно перерисовать
          drawPropagationEdgesLocal();
          updateLineStyles();
        });
      });
    } else {
      updateLineStyles();
    }
  };

  // Клик по пропагированной колонке (копии) — трассируем от неё как от обычной
  innerCanvas.addEventListener("cll-propagated-column-click", (e) => {
    const d = e.detail || {};
    if (d.tableId && d.columnName) {
      updateHighlight(d.tableId, d.columnName);
    }
  });

  pane.querySelectorAll(".cll-column").forEach((colEl) => {
    colEl.style.cursor = "pointer";
    colEl.addEventListener("click", () => {
      updateHighlight(
        colEl.getAttribute("data-table-id"),
        colEl.getAttribute("data-col-name"),
      );
    });
  });

  // Инициализация проброса колонок
  initPropagation(uniqueId, getTableInfo, displayedTables);

  // Инициализация протягивания таблицы (Table Propagation).
  // rerenderCallback вызывается после создания виртуальной таблицы:
  //   1. Принудительно выставляем focusMode=false (пользователь должен увидеть
  //      полный граф с новой карточкой, а не узкий фокусный срез одной колонки)
  //   2. Перезапускаем renderColumnLineage с пустой колонкой = полный граф
  //   3. После layout поправляем позицию виртуальной карточки:
  //        - если у родителя нет РЕАЛЬНЫХ потомков → top-align с родителем
  //        - если есть → свободное место справа (ниже всех в слое)
  //   4. Auto-fit zoom, чтобы обе карточки поместились
  //   5. Добавляем выбранные колонки через addPropagatedColumn.
  const rerenderCallback = (virtualTableId, parentTableId, selectedColumns) => {
    // Принудительно полный режим — гарантируем, что новая карточка с колонками будет видна
    if (!window.__cllFocusModes) window.__cllFocusModes = new Map();
    window.__cllFocusModes.set(uniqueId, false);

    // Устанавливаем флаг, чтобы renderColumnLineage не очистил виртуальные таблицы
    window.__tablePropagationRerender = true;
    // Перерисовываем ПОЛНЫЙ граф (без колонки-фокуса):
    //  - передаём пустую строку вместо activeColName, чтобы traceLineage не
    //    строил узкие цепочки и не скрывал новые виртуальные колонки.
    renderColumnLineage(uniqueId, '');
    window.__tablePropagationRerender = false;

    // После рендера добавляем колонки в новую карточку + позиционируем + зумируем.
    // Три rAF: 1) runInitial 2) optimize + drawLines 3) наши правки
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const viewport = pane.querySelector(".lineage-viewport");
          const content  = pane.querySelector(".lineage-content");
          const innerCanvas = pane.querySelector(".lineage-canvas");
          if (!viewport || !content || !innerCanvas) return;

          const parentCard  = document.getElementById(`cll-card-${uniqueId}-${parentTableId}`);
          const virtualCard = document.getElementById(`cll-card-${uniqueId}-${virtualTableId}`);
          if (!parentCard || !virtualCard) return;

          // ── Определяем: есть ли у родителя РЕАЛЬНЫЕ (не виртуальные) потомки ──
          const parentInfo = getTableInfo(parentTableId);
          const allDownstreams = (parentInfo?.lineage?.downstream) || [];
          const realSiblingDownstreams = allDownstreams.filter(id => {
            if (id.toLowerCase() === virtualTableId.toLowerCase()) return false;
            const vt = getVirtualTables().get(id.toLowerCase());
            return !vt;
          });
          const onlyVirtualOrNoSiblings = realSiblingDownstreams.length === 0;

          const virtualLayer = virtualCard.closest('.lineage-layer');
          const parentRect  = parentCard.getBoundingClientRect();
          const canvasRect  = innerCanvas.getBoundingClientRect();

          // Считаем scale, потому что getBoundingClientRect() возвращает уже масштабированные значения
          let curScale = 1;
          const m = (content.style.transform || '').match(/scale\(([\d.]+)\)/);
          if (m) curScale = parseFloat(m[1]);
          const toCanvas = (pxClient) => pxClient / curScale;

          const parentTopCanvas  = toCanvas(parentRect.top  - canvasRect.top);
          const parentLeftCanvas = toCanvas(parentRect.left - canvasRect.left);
          const parentWidthCanvas  = toCanvas(parentRect.width);
          const virtualHeightCanvas = toCanvas(virtualCard.getBoundingClientRect().height);

          // Расстояние между слоями (gap) уже учтено в flex layout, используем
          // layout-координаты. ВАЖНО: вычисляем позицию виртуальной карточки
          // через её "natural top" в её слое без transform, затем переписываем transform.
          if (onlyVirtualOrNoSiblings) {
            // ── Случай А: у родителя нет реальных потомков ──
            //    Выравниваем верхнюю границу виртуальной карточки по верхней границе родителя
            const layer = virtualLayer;
            const layerRect = layer.getBoundingClientRect();
            const layerTopCanvas = toCanvas(layerRect.top - canvasRect.top);

            // Натуральный top = слой.top + gap до карточки.
            // Проще: найти разницу между текущим card.top и layer.top и компенсировать через translateY.
            const virtualRect = virtualCard.getBoundingClientRect();
            const virtualCurrentTop = toCanvas(virtualRect.top - canvasRect.top);

            const matchCur = (virtualCard.style.transform || '').match(/translateY\(([^)]+)px\)/);
            const currentTY = matchCur ? parseFloat(matchCur[1]) : 0;
            // Желаемый top = parentTopCanvas
            const desiredTopCanvas = parentTopCanvas;
            const deltaY = desiredTopCanvas - virtualCurrentTop;
            virtualCard.style.transform = `translateY(${currentTY + deltaY}px)`;

          } else {
            // ── Случай Б: у родителя уже есть реальные потомки ──
            //    Помещаем виртуальную карточку ниже всех карточек в её слое + 20px gap,
            //    чтобы гарантировать свободное место и отсутствие пересечений.
            const siblingsInLayer = Array.from(virtualLayer.querySelectorAll('.cll-card'))
              .filter(c => c.id !== virtualCard.id);

            let maxBottomCanvas = -Infinity;
            siblingsInLayer.forEach(sib => {
              const r = sib.getBoundingClientRect();
              const b = toCanvas(r.bottom - canvasRect.top);
              if (b > maxBottomCanvas) maxBottomCanvas = b;
            });

            if (maxBottomCanvas > -Infinity) {
              const virtualRect = virtualCard.getBoundingClientRect();
              const virtualCurrentTop = toCanvas(virtualRect.top - canvasRect.top);
              const matchCur = (virtualCard.style.transform || '').match(/translateY\(([^)]+)px\)/);
              const currentTY = matchCur ? parseFloat(matchCur[1]) : 0;
              const FREE_GAP = 35;  // совпадает с gap по умолчанию между карточками слоя
              const desiredTopCanvas = maxBottomCanvas + FREE_GAP;
              const deltaY = desiredTopCanvas - virtualCurrentTop;
              if (deltaY > 0) {
                virtualCard.style.transform = `translateY(${currentTY + deltaY}px)`;
              }
            }
          }

          // ── После поправки позиции: перерисовать линии (могут съехать пины) ──
          requestAnimationFrame(() => {
            drawLinesLocal();
            drawPropagationEdgesLocal();

            // ── Auto-fit zoom: поместить родительскую + виртуальную карточки ──
            const r1 = parentCard.getBoundingClientRect();
            const r2 = virtualCard.getBoundingClientRect();
            const combinedLeft   = Math.min(r1.left, r2.left) - canvasRect.left;
            const combinedTop    = Math.min(r1.top,  r2.top)  - canvasRect.top;
            const combinedRight  = Math.max(r1.right, r2.right) - canvasRect.left;
            const combinedBottom = Math.max(r1.bottom, r2.bottom) - canvasRect.top;
            const canvasW = innerCanvas.offsetWidth;
            const canvasH = innerCanvas.offsetHeight;
            const vw = viewport.clientWidth;
            const vh = viewport.clientHeight;
            const PAD = 60;

            // Переводим в canvas-координаты (внутренние размеры без scale)
            const contentLeft   = combinedLeft   / curScale;
            const contentTop    = combinedTop    / curScale;
            const contentRight  = combinedRight  / curScale;
            const contentBottom = combinedBottom / curScale;

            const unionW = contentRight - contentLeft;
            const unionH = contentBottom - contentTop;

            // Вычисляем новый scale так, чтобы обе карточки + паддинги влезли во viewport
            let newScale = curScale;
            if (unionW > 0 && unionH > 0) {
              const fitScaleW = (vw - PAD * 2) / unionW;
              const fitScaleH = (vh - PAD * 2) / unionH;
              newScale = Math.min(curScale, fitScaleW, fitScaleH, 1);
            }
            if (newScale < 0.1) newScale = 0.1;

            // Центрируем union-область относительно viewport
            const targetCx = contentLeft + unionW / 2;
            const targetCy = contentTop  + unionH / 2;

            const newTx = vw / 2 - targetCx * newScale;
            const newTy = vh / 2 - targetCy * newScale;

            // Обновляем pan/zoom напрямую через content.style.
            // (!) Здесь content — ССЫЛКА В OLD-ZAMYKANII (до ререндера). После
            // renderColumnLineage() pane.innerHTML был перезаписан → старый DOM
            // удалён. Ищем fresh-ноды снова на уже отрисованном pane.
            const freshViewport = pane.querySelector(".lineage-viewport");
            const freshContent  = pane.querySelector(".lineage-content");
            if (!freshViewport || !freshContent) return;

            freshContent.style.transition = 'transform 0.2s ease-out';
            freshContent.style.transform  = `translate(${newTx}px, ${newTy}px) scale(${newScale})`;

            // ── После зума: финально кидаем propagation-update (колонки, рёбра, SQL кнопка) ──
            // Добавляем колонки в порядке родительской таблицы.
            // При DDS→DDS технические поля родителя (source_system_id и т.д.) не
            // протягиваются 1:1 — заново создаются ниже с константными значениями.
            const parentIsDds = parentTableId.split('.')[0].toLowerCase() === 'dds';
            const childIsDds  = virtualTableId.split('.')[0].toLowerCase() === 'dds';
            const businessColumns = (parentIsDds && childIsDds)
              ? filterTechnicalColumns(selectedColumns)
              : selectedColumns;

            businessColumns.forEach(colName => {
              addPropagatedColumn(uniqueId, virtualTableId, { name: colName }, parentTableId);
            });
            // Технические поля (Факты/Измерения) для протянутой DDS-таблицы — в конце
            const vtInfo = getTableInfo(virtualTableId);
            if (vtInfo) {
              addTechnicalColumns(uniqueId, virtualTableId, parentTableId, vtInfo._tableType);
            }
            document.dispatchEvent(new CustomEvent('propagation-update', {
              detail: { uniqueId, reason: 'column-added' },
            }));
          });
        });
      });
    });
  };

  initTablePropagation(uniqueId, getTableInfo, rerenderCallback, pane);

  // Слушаем события обновления проброса
  const handlePropagationUpdate = (e) => {
    if (e.detail?.uniqueId === uniqueId) {
      if (e.detail?.reason === 'table-removed') {
        // Точечное удаление виртуальной таблицы: убираем карточку и перерисовываем
        // линии, НЕ перестраивая весь граф. Полный renderColumnLineage заново
        // запускает optimizeCardPositions и сдвигает родительские карточки.
        const removedId = e.detail?.virtualTableId;
        if (removedId) {
          const card = document.getElementById(`cll-card-${uniqueId}-${removedId}`);
          if (card) card.remove();
        }
        drawLinesLocal();
        drawPropagationEdgesLocal();
        updateTableCardSqlButtons(uniqueId, getTableInfo);
        return;
      }
      drawLinesLocal();
      drawPropagationEdgesLocal();
      updateTableCardSqlButtons(uniqueId, getTableInfo);
    }
  };
  document.addEventListener('propagation-update', handlePropagationUpdate);

  // Очистка при закрытии вкладки
  const cleanupPropagationOnClose = () => {
    cleanupPropagation(uniqueId);
    cleanupTablePropagation(uniqueId);
    document.removeEventListener('propagation-update', handlePropagationUpdate);
    // Чистим сохранённый фокус-режим вкладки
    if (window.__cllFocusModes) window.__cllFocusModes.delete(uniqueId);
  };

  const handleKeyDown = (e) => {
    if (!pane.isConnected) {
      window.removeEventListener("keydown", handleKeyDown);
      return;
    }
    if (!pane.classList.contains("active")) return;
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.isContentEditable)) {
      return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const activeColEl = pane.querySelector(
        `.cll-column[data-table-id="${activeTableId}"][data-col-name="${activeColName}"]`
      );
      if (!activeColEl) return;

      const container = activeColEl.closest('.cll-columns');
      if (!container) return;

      const allCols = Array.from(container.querySelectorAll('.cll-column'));
      const idx = allCols.indexOf(activeColEl);
      if (idx === -1) return;

      let nextColEl = null;
      if (e.key === "ArrowUp") {
        if (idx > 0) nextColEl = allCols[idx - 1];
      } else {
        if (idx < allCols.length - 1) nextColEl = allCols[idx + 1];
      }

      if (nextColEl) {
        e.preventDefault();
        updateHighlight(
          nextColEl.getAttribute("data-table-id"),
          nextColEl.getAttribute("data-col-name")
        );
      }
    }
  };

  window.addEventListener("keydown", handleKeyDown);

  // Initial render
  const runInitial = () => {
    saveOriginalLayerGaps(pane);
    applyFocusMode(pane, highlightedCols, focusMode);
    updateLayerGaps(pane, focusMode, EDGE_BEND_DISTANCE_SOURCE, MIN_TRACK_GAP, EDGE_BEND_DISTANCE_TARGET);
    optimizeLocal();
    void pane.offsetHeight;
    requestAnimationFrame(() => {
      drawLinesLocal();
      drawPropagationEdgesLocal();
    });
  };

  setTimeout(() => {
    if (document.fonts) {
      document.fonts.ready.then(runInitial);
    } else {
      runInitial();
    }
  }, 150);

  // Redraw lines on column scroll
  pane.querySelectorAll(".cll-columns").forEach((colContainer) => {
    colContainer.addEventListener("scroll", () => {
      requestAnimationFrame(drawLinesLocal);
    });
  });
}

// Re-export for backward compatibility
export { drawOrthogonalLine } from "./columnLineageEdges.js";
