/* 
MODULE: src/lineage/tableLineage.js
ROLE: Оркестратор графа зависимостей на уровне таблиц (Global Map): сборка DOM, Pan/Zoom, запуск конвейера layout и рендеринга.
*/

import { sanitizeId } from "../utils/helpers.js";
import { initProgressBar } from "../ui/loadingBar.js";
import { ICONS } from "./tableLineageConstants.js";
import { handleLineageClick, handleLineageContextMenu } from "./tableLineageHighlight.js";
import {
  computeLayersAndVirtualNodes,
  optimizeSugiyamaLayout,
} from "./tableLineageSugiyama.js";
import {
  calculateNodeDegrees,
  getNodePaddingV,
  getLocalRect,
  applyPhase2Layout,
  alignStraightTopIncomingEdges,
  expandGapsForTracks,
} from "./tableLineageLayout.js";
import {
  buildFinalPorts,
  applyStraightTransitChains,
  renderEdges,
  getEdgeSY,
  getEdgeEY,
} from "./tableLineageEdges.js";
import {
  initLineageDebug,
  finalizeLineageDebug,
} from "./tableLineageDebug.js";
import {
  toggleNewDataSource,
  toggleCheckDescendant,
  selectAllEligibleDescendants,
  resetRebuildFlow,
  openRebuildSqlModal,
} from "./tableLineageRebuild.js";
import {
  formatCardDate,
  isStaleModeActive,
  applyStaleAnalysis,
  toggleStaleMode,
  openStaleModal,
  closeStaleModal,
} from "./tableLineageStale.js";

// Реэкспорт для глобального использования (в index.js и HTML onclick)
export {
  handleLineageClick,
  handleLineageContextMenu,
  toggleNewDataSource,
  toggleCheckDescendant,
  selectAllEligibleDescendants,
  resetRebuildFlow,
  openRebuildSqlModal,
  toggleStaleMode,
  openStaleModal,
  closeStaleModal,
};

if (typeof window !== "undefined") {
  window.handleLineageClick = handleLineageClick;
  window.handleLineageContextMenu = handleLineageContextMenu;
  window.toggleNewDataSource = toggleNewDataSource;
  window.toggleCheckDescendant = toggleCheckDescendant;
  window.selectAllEligibleDescendants = selectAllEligibleDescendants;
  window.resetRebuildFlow = resetRebuildFlow;
  window.openRebuildSqlModal = openRebuildSqlModal;
  window.toggleStaleMode = toggleStaleMode;
  window.openStaleModal = openStaleModal;
  window.closeStaleModal = closeStaleModal;
}

function getTableInfoStr(nodePath) {
  const p = nodePath.split(".");
  if (p.length === 3) return window.catalogData[p[0]]?.[p[1]]?.[p[2]];
  return null;
}

/**
 * Инициализация Pan & Zoom и кнопок управления
 */
function initPanAndZoom(pane, unique_id) {
  const viewport = pane.querySelector(".lineage-viewport");
  const content = pane.querySelector(".lineage-content");
  const innerCanvas = pane.querySelector(".lineage-canvas");
  if (!viewport || !content || !innerCanvas) return;

  let scale = 1,
    tx = 0,
    ty = 0;

  const updateTransform = (smooth = true) => {
    content.style.transition = smooth ? "transform 0.1s ease-out" : "none";
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
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

  let isPanning = false,
    startX,
    startY;
  viewport.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isPanning = true;
    startX = e.clientX - tx;
    startY = e.clientY - ty;
    content.style.transition = "none";
  });
  window.addEventListener("mousemove", (e) => {
    if (!isPanning) return;
    tx = e.clientX - startX;
    ty = e.clientY - startY;
    updateTransform(false);
  });
  window.addEventListener("mouseup", () => {
    isPanning = false;
  });

  pane.querySelectorAll(".ln-tool-btn").forEach((btn) => {
    btn.onclick = () => {
      const tool = btn.dataset.tool;
      if (tool === "zoom-in") {
        const oldScale = scale;
        scale = Math.min(4, scale * 1.25);
        tx =
          viewport.clientWidth / 2 -
          (viewport.clientWidth / 2 - tx) * (scale / oldScale);
        ty =
          viewport.clientHeight / 2 -
          (viewport.clientHeight / 2 - ty) * (scale / oldScale);
      } else if (tool === "zoom-out") {
        const oldScale = scale;
        scale = Math.max(0.1, scale * 0.8);
        tx =
          viewport.clientWidth / 2 -
          (viewport.clientWidth / 2 - tx) * (scale / oldScale);
        ty =
          viewport.clientHeight / 2 -
          (viewport.clientHeight / 2 - ty) * (scale / oldScale);
      } else if (tool === "fit") {
        const pad = 40;
        const sw = innerCanvas.offsetWidth,
          sh = innerCanvas.offsetHeight;
        const vw = viewport.clientWidth,
          vh = viewport.clientHeight;
        scale = Math.min((vw - pad) / sw, (vh - pad) / sh, 1);
        tx = (vw - sw * scale) / 2;
        ty = (vh - sh * scale) / 2;
      }
      updateTransform();
    };
  });
}

/**
 * Основная функция рендеринга Table Lineage
 */
export async function renderLineageCore(
  pane,
  nodesSet,
  edges,
  unique_id,
  selectedNodeId = null,
  onProgress = null,
) {
  if (pane.dataset.rendered === "true") return;

  const reportProgress = (pct, text) => {
    if (typeof onProgress === "function") onProgress(pct, text);
  };
  const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

  // 1. Расчет топологии и вставка dummy-узлов
  const topology = computeLayersAndVirtualNodes(nodesSet, edges);
  let { nodesArray, rank, maxLayer, outEdgesMap, inEdgesMap } = topology;
  edges = topology.edges;

  // 2. Оптимизация расположения узлов Sugiyama
  const sugiResult = await optimizeSugiyamaLayout(
    topology.layers,
    maxLayer,
    edges,
    reportProgress,
    yieldToBrowser,
  );
  let layers = sugiResult.layers;
  const { neighborsLeft } = sugiResult;

  reportProgress(90, "Отрисовка схемы…");

  // 3. Генерация HTML (Viewport + Content + Toolbar)
  let html = `
    <div class="lineage-container">
        <div class="lineage-toolbar">
            <button class="ln-tool-btn" data-tool="zoom-out" title="Уменьшить">${ICONS.zoomOut}</button>
            <button class="ln-tool-btn" data-tool="zoom-in" title="Увеличить">${ICONS.zoomIn}</button>
            <button class="ln-tool-btn" data-tool="fit" title="Вписать экран">${ICONS.fit}</button>
        </div>
        <div class="lineage-viewport">
            <div class="lineage-content">
                <div class="lineage-canvas" id="canvas-${unique_id}">
                    <svg class="lineage-svg ln-table-svg" id="svg-${unique_id}"></svg>
                    <div class="lineage-layout">
    `;

  const { nodeInDegree, nodeOutDegree } = calculateNodeDegrees(
    nodesArray,
    edges,
    inEdgesMap,
    outEdgesMap,
  );

  for (let i = 0; i <= maxLayer; i++) {
    if (!layers[i]) continue;
    html += `<div class="lineage-layer">`;
    layers[i].forEach((n) => {
      const nodeIdSafe = sanitizeId(n);
      if (n.startsWith("vnode-")) {
        html += `<div class="ln-node ln-virtual" id="lnode-${nodeIdSafe}-${unique_id}" style="width:0; padding:0; border:none; visibility:hidden; height:32px; margin: 5px 0;"></div>`;
      } else {
        const db = n.split(".")[0]?.toLowerCase() || "default";
        const schema = n.split(".")[1]?.toLowerCase() || "default";
        const exists = getTableInfoStr(n) !== null;
        const _coreSchemas = ["ods", "dds", "dm"];
        const _dbColorSchemas = ["core", "calc"];
        let schemaClass;
        if (!exists) {
          schemaClass = "ln-default";
        } else if (_dbColorSchemas.includes(schema)) {
          schemaClass = `ln-core-${db}`;
        } else if (_coreSchemas.includes(schema)) {
          schemaClass = `ln-${schema}`;
        } else {
          let _h = 0;
          for (let k = 0; k < schema.length; k++) _h = (_h * 31 + schema.charCodeAt(k)) % 8;
          schemaClass = `ln-system-${_h}`;
        }
        const isSelected = n === selectedNodeId ? "is-selected" : "";
        const shortName = n.split(".").pop();
        const tableInfo = getTableInfoStr(n);
        const isView = tableInfo && (tableInfo.type === "v" || tableInfo.type === "m");
        const viewIcon = isView
          ? `<svg class="ln-view-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M1 8c0 0 3-4.5 7-4.5s7 4.5 7 4.5-3 4.5-7 4.5S1 8 1 8z" fill="#FEF08A" fill-opacity="0.4" stroke="#EAB308" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.5" fill="#EAB308"/></svg>`
          : "";
        const pv = getNodePaddingV(n, nodeInDegree, nodeOutDegree);
        const isOds = db === "ods" || schema === "ods" || schemaClass === "ln-ods" || schemaClass === "ln-core-ods";
        const odsClass = isOds ? "ln-node-ods" : "";
        const btnClass = isOds ? "ln-new-data-btn ln-btn-ods" : "ln-new-data-btn ln-btn-rebuild";
        const btnTitle = isOds ? "Отметить новые данные для пересборки" : "Начать пересборку с этой таблицы";
        const btnText = isOds ? "+ New Data" : "+ Rebuild";
        const rebuildBtn = `<button class="${btnClass}" type="button" title="${btnTitle}" onclick="event.stopPropagation(); window.toggleNewDataSource('${n}', '${unique_id}')"><span class="ln-nd-text">${btnText}</span></button>`;
        
        const rawDate = tableInfo?.script_updated_at || "";
        const cardDate = formatCardDate(rawDate);
        const clockSvg = `<svg class="ln-clock-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"></circle><polyline points="8 4 8 8 10.5 9.5"></polyline></svg>`;
        const dateHtml = `<span class="ln-node-time" title="${rawDate ? 'Обновлено: ' + rawDate : 'Дата обновления неизвестна'}">${clockSvg} ${cardDate}</span>`;
        
        const nodeHeight = pv * 2 + 18;
        html += `<div class="ln-node ${schemaClass} ${isSelected} ${odsClass}" id="lnode-${nodeIdSafe}-${unique_id}" data-node-id="${n}" style="height:${nodeHeight}px; min-height:${nodeHeight}px; max-height:${nodeHeight}px;" onclick="handleLineageClick(event, '${n}')" oncontextmenu="handleLineageContextMenu(event, '${n}', '${unique_id}')">${rebuildBtn}${viewIcon}<div class="ln-node-body"><span class="ln-node-name">${shortName}</span>${dateHtml}</div></div>`;
      }
    });
    html += `</div>`;
  }

  html += `
                    </div>
                </div>
            </div>
        </div>
    </div>`;

  reportProgress(95, "Отрисовка схемы…");
  pane.innerHTML = html;
  pane.dataset.rendered = "true";

  // 4. Инициализация Pan & Zoom
  initPanAndZoom(pane, unique_id);

  // 5. Отрисовка линий и финальное позиционирование
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch (_) {}
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const svg = document.getElementById(`svg-${unique_id}`);
  const canvas = document.getElementById(`canvas-${unique_id}`);
  if (!svg || !canvas) return;

  initLineageDebug(unique_id);

  // Phase 2: Alignment, Collision Resolution & Isolated Pairs
  applyPhase2Layout(layers, maxLayer, unique_id, neighborsLeft, inEdgesMap, outEdgesMap);

  // Даем примениться marginTop после Phase 2 перед чтением координат
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  let rects = {};
  nodesSet.forEach((n) => {
    const el = document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`);
    if (el) rects[n] = getLocalRect(el, canvas);
  });

  // Rule 18: Прямое верхнее входящее ребро
  alignStraightTopIncomingEdges(layers, maxLayer, unique_id, inEdgesMap, outEdgesMap, canvas);

  // Даем примениться marginTop после Rule 18 перед пересчетом координат
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  // После сдвигов карточек перечитываем rects
  nodesSet.forEach((n) => {
    const el = document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`);
    if (el) rects[n] = getLocalRect(el, canvas);
  });

  // Построение портов
  let finalPorts = buildFinalPorts(nodesSet, outEdgesMap, inEdgesMap, rects);

  // Rule 15: Straight transit chains
  applyStraightTransitChains(edges, outEdgesMap, finalPorts, rects, rank, layers);

  // Адаптивное расширение каналов (gap)
  expandGapsForTracks(
    pane,
    layers,
    maxLayer,
    edges,
    rank,
    finalPorts,
    rects,
    getEdgeSY,
    getEdgeEY,
  );

  // После расширения перечитываем rects (X-координаты изменились)
  nodesSet.forEach((n) => {
    const el = document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`);
    if (el) rects[n] = getLocalRect(el, canvas);
  });

  // Отрисовка SVG-рёбер
  renderEdges(canvas, svg, edges, rank, rects, finalPorts);

  // Финализация и вывод отладочной информации
  finalizeLineageDebug(unique_id, edges, rects, finalPorts, getEdgeSY, getEdgeEY);

  // Если активен режим Time Machine — применяем подсветку Stale
  if (isStaleModeActive(unique_id)) {
    applyStaleAnalysis(canvas, unique_id);
  }
}

/**
 * Публичная точка входа рендеринга Lineage для выбранной таблицы
 */
export function renderLineage(unique_id) {
  const pane = document.querySelector(`#${unique_id} .pane-lineage`);
  if (!pane || pane.dataset.rendered === "true") return;

  const loading = pane.querySelector(".lineage-loading-spinner");
  if (loading) loading.style.display = "block";
  const updateBar = initProgressBar(loading);

  const startTask = async () => {
    if (document.fonts && document.fonts.ready) {
      try {
        await document.fonts.ready;
      } catch (_) {}
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    requestIdleCallback(
      async () => {
      try {
        const parts = unique_id.split("-");
        if (parts.length !== 3) {
          if (loading) loading.style.display = "none";
          return;
        }
        const [dbTarget, schemaTarget, nameTarget] = parts;
        const selectedNodeId = `${dbTarget}.${schemaTarget}.${nameTarget}`;

        const tableInfo = getTableInfoStr(selectedNodeId);
        if (!tableInfo || !tableInfo.lineage) {
          pane.innerHTML =
            '<div class="empty-pane">Нет данных о связях (Lineage) для этой таблицы.</div>';
          if (loading) loading.style.display = "none";
          return;
        }

        const upstream = tableInfo.lineage.upstream || [];
        const downstream = tableInfo.lineage.downstream || [];

        if (upstream.length === 0 && downstream.length === 0) {
          pane.innerHTML =
            '<div class="empty-pane">Эта таблица не имеет известных источников или потребителей.</div>';
          if (loading) loading.style.display = "none";
          return;
        }

        let nodesSet = new Set();
        let edges = [];

        function dfsUp(node) {
          if (nodesSet.has(node)) return;
          nodesSet.add(node);
          const info = getTableInfoStr(node);
          if (info && info.lineage && info.lineage.upstream) {
            info.lineage.upstream.forEach((up) => {
              edges.push({ source: up, target: node });
              dfsUp(up);
            });
          }
        }

        function dfsDown(node) {
          if (nodesSet.has(node)) return;
          nodesSet.add(node);
          const info = getTableInfoStr(node);
          if (info && info.lineage && info.lineage.downstream) {
            info.lineage.downstream.forEach((down) => {
              edges.push({ source: node, target: down });
              dfsDown(down);
            });
          }
        }

        nodesSet.add(selectedNodeId);
        upstream.forEach((up) => {
          edges.push({ source: up, target: selectedNodeId });
          dfsUp(up);
        });
        downstream.forEach((down) => {
          edges.push({ source: selectedNodeId, target: down });
          dfsDown(down);
        });

        await renderLineageCore(
          pane,
          nodesSet,
          edges,
          unique_id,
          selectedNodeId,
          updateBar,
        );
      } catch (e) {
        console.error("Lineage rendering error:", e);
        pane.innerHTML =
          '<div class="empty-pane">Ошибка при рендеринге lineage.</div>';
      } finally {
        if (loading) loading.style.display = "none";
      }
    },
    { timeout: 100 },
  );
  };
  startTask();
}
