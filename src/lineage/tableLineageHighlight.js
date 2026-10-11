/* 
MODULE: src/lineage/tableLineageHighlight.js
ROLE: Логика взаимодействия и подсветки графа Table Lineage (клики, обходы BFS, очистка выделения).
*/

import { navigateTo } from "../routing/navigation.js";

export function handleLineageClick(event, nodeId) {
  event.stopPropagation();

  if (
    event.target.closest(
      ".ln-new-data-btn, .ln-rebuild-cb-wrap, .ln-no-script-badge, .ln-rebuild-dock"
    )
  ) {
    return;
  }

  const canvas = event.target.closest(".lineage-canvas");
  const pane = canvas ? canvas.closest(".pane-lineage") : null;
  const targetEl = event.currentTarget || event.target.closest(".ln-node");

  // В режиме пересборки клик по карточке потомка переключает чекбокс
  if (pane && pane.classList.contains("rebuild-flow-active") && targetEl) {
    if (targetEl.classList.contains("ln-rebuild-impacted") && canvas) {
      const uniqueId = canvas.id ? canvas.id.replace("canvas-", "") : "";
      if (uniqueId && typeof window.toggleCheckDescendant === "function") {
        window.toggleCheckDescendant(nodeId, uniqueId);
        return;
      }
    }
    // В режиме пересборки клик по телу карточки вне потомков не сбивает режим пересборки
    clearLineageHighlight();
    return;
  }

  if (targetEl && targetEl.classList.contains("ln-clicked")) {
    navigateTo("#" + nodeId.replace(/\./g, "-"));
    return;
  }

  clearLineageHighlight();
  highlightLineage(event, nodeId);
}

export function highlightLineage(event, nodeId) {
  // Находим контейнер lineage-canvas, в котором кликнули
  const canvas = event.target.closest(".lineage-canvas");
  if (!canvas) return;

  // Собираем все связанные узлы (вверх и вниз по графу)
  const connectedNodes = new Set();
  connectedNodes.add(nodeId);

  const svgEl = canvas.querySelector(".lineage-svg");
  if (!svgEl) return;
  const allPaths = svgEl.querySelectorAll("path.ln-edge-line, path:not(.ln-edge-hit)");

  // Строим карту связей один раз — BFS по ней вместо перебора всех путей
  // на каждый узел (было O(N·E), стало O(N + E))
  const parentsMap = new Map();  // target -> [sources]
  const childrenMap = new Map(); // source -> [targets]
  allPaths.forEach((p) => {
    const src = p.dataset.source;
    const tgt = p.dataset.target;
    if (!parentsMap.has(tgt)) parentsMap.set(tgt, []);
    parentsMap.get(tgt).push(src);
    if (!childrenMap.has(src)) childrenMap.set(src, []);
    childrenMap.get(src).push(tgt);
  });

  // Вверх (предки)
  let q = [nodeId];
  let visited = new Set([nodeId]);
  while (q.length > 0) {
    const current = q.shift();
    (parentsMap.get(current) || []).forEach((src) => {
      if (!visited.has(src)) {
        visited.add(src);
        connectedNodes.add(src);
        q.push(src);
      }
    });
  }
  // Вниз (потомки)
  q = [nodeId];
  visited = new Set([nodeId]);
  while (q.length > 0) {
    const current = q.shift();
    (childrenMap.get(current) || []).forEach((tgt) => {
      if (!visited.has(tgt)) {
        visited.add(tgt);
        connectedNodes.add(tgt);
        q.push(tgt);
      }
    });
  }

  // Все узлы: приглушаем неподключённые, подсвечиваем подключённые
  canvas.querySelectorAll(".ln-node").forEach((el) => {
    // ID узла берём из data-атрибута (был парсинг onclick через regex)
    const elNodeId = el.dataset.nodeId || "";

    if (connectedNodes.has(elNodeId)) {
      el.classList.add("ln-highlighted");
      if (elNodeId === nodeId) {
        el.classList.add("ln-clicked");
      }
    }
  });

  // Линии: подсвечиваем связанные
  allPaths.forEach((p) => {
    if (
      connectedNodes.has(p.dataset.source) &&
      connectedNodes.has(p.dataset.target)
    ) {
      p.classList.add("ln-path-highlighted");
    }
  });
}

// Строит карты «родители/дети» из SVG-путей (data-source/data-target).
// O(E) — только при клике, на рендеринг не влияет.
export function buildAdjacencyFromPaths(svgEl) {
  const parentsMap = new Map(); // target -> [sources]
  const childrenMap = new Map(); // source -> [targets]
  svgEl.querySelectorAll("path.ln-edge-line, path:not(.ln-edge-hit)").forEach((p) => {
    const src = p.dataset.source;
    const tgt = p.dataset.target;
    if (!src || !tgt) return;
    if (!parentsMap.has(tgt)) parentsMap.set(tgt, []);
    parentsMap.get(tgt).push(src);
    if (!childrenMap.has(src)) childrenMap.set(src, []);
    childrenMap.get(src).push(tgt);
  });
  return { parentsMap, childrenMap };
}

// BFS-обход вверх по графу (все предки), O(V + E).
export function collectAncestors(parentsMap, start) {
  const visited = new Set([start]);
  const q = [start];
  while (q.length > 0) {
    const cur = q.shift();
    (parentsMap.get(cur) || []).forEach((src) => {
      if (!visited.has(src)) {
        visited.add(src);
        q.push(src);
      }
    });
  }
  return visited;
}

// BFS-обход вниз по графу (все потомки), O(V + E).
export function collectDescendants(childrenMap, start) {
  const visited = new Set([start]);
  const q = [start];
  while (q.length > 0) {
    const cur = q.shift();
    (childrenMap.get(cur) || []).forEach((tgt) => {
      if (!visited.has(tgt)) {
        visited.add(tgt);
        q.push(tgt);
      }
    });
  }
  return visited;
}

// Подсветка по клику на ребро: подсвечиваем все предки источника и все
// потомки цели ребра (вместе с самими конечными узлами).
export function highlightLineageEdge(canvas, pathEl) {
  const sourceId = pathEl.dataset.source;
  const targetId = pathEl.dataset.target;
  if (!sourceId || !targetId) return;

  const svgEl = canvas.querySelector(".lineage-svg");
  if (!svgEl) return;
  const { parentsMap, childrenMap } = buildAdjacencyFromPaths(svgEl);

  // Предки источника + потомки цели — то самое «семейство ребра».
  const connectedNodes = new Set();
  collectAncestors(parentsMap, sourceId).forEach((n) => connectedNodes.add(n));
  collectDescendants(childrenMap, targetId).forEach((n) => connectedNodes.add(n));

  canvas.querySelectorAll(".ln-node").forEach((el) => {
    const elNodeId = el.dataset.nodeId || "";
    if (connectedNodes.has(elNodeId)) {
      el.classList.add("ln-highlighted");
    }
  });

  svgEl.querySelectorAll("path.ln-edge-line, path:not(.ln-edge-hit)").forEach((p) => {
    if (
      connectedNodes.has(p.dataset.source) &&
      connectedNodes.has(p.dataset.target)
    ) {
      p.classList.add("ln-path-highlighted");
    }
  });

  // Кликнутое ребро выделяем отдельно — более сильным стилем (на видимой линии).
  const visualEl = pathEl.classList.contains("ln-edge-line")
    ? pathEl
    : svgEl.querySelector(`path.ln-edge-line[data-source="${sourceId}"][data-target="${targetId}"]`) || pathEl;
  visualEl.classList.add("ln-path-clicked");
}

export function handleLineageContextMenu(event, nodeId, uniqueId) {
  event.preventDefault();
  event.stopPropagation();

  const targetEl = event.currentTarget || event.target.closest(".ln-node");
  if (!targetEl) return;

  // Если узел является устаревшим и активен режим Time Machine — открываем окно детализации Stale
  if (targetEl.classList.contains("ln-node-stale") && typeof window.openStaleModal === "function") {
    window.openStaleModal(event, nodeId, uniqueId);
    return;
  }

  const btn = targetEl.querySelector(".ln-new-data-btn");
  if (!btn) return;

  if (targetEl.classList.contains("ln-rebuild-source")) {
    if (uniqueId && typeof window.toggleNewDataSource === "function") {
      window.toggleNewDataSource(nodeId, uniqueId);
      return;
    }
  }

  const canvas = targetEl.closest(".lineage-canvas");
  if (canvas) {
    canvas
      .querySelectorAll(".ln-nd-revealed:not(.ln-rebuild-source)")
      .forEach((el) => {
        if (el !== targetEl) {
          el.classList.remove("ln-nd-revealed");
        }
      });
  }

  targetEl.classList.toggle("ln-nd-revealed");
}

export function clearLineageHighlight(e) {
  if (
    e &&
    e.target &&
    e.target.closest(
      ".ln-new-data-btn, .ln-rebuild-cb-wrap, .ln-no-script-badge, .ln-rebuild-dock, .rebuild-modal-overlay, .rebuild-modal-card, .ln-stale-popup"
    )
  ) {
    return;
  }

  // Ищем только тот canvas, в котором есть подсветка, а не весь документ.
  // Это ускоряет работу с большим количеством открытых lineage.
  const hit = document.querySelector(
    ".ln-highlighted, .ln-clicked, .ln-path-highlighted, .ln-path-clicked, .ln-nd-revealed"
  );
  const canvas = hit ? hit.closest(".lineage-canvas") : null;
  const root = canvas || document;

  root
    .querySelectorAll(".ln-highlighted")
    .forEach((el) => el.classList.remove("ln-highlighted"));
  root
    .querySelectorAll(".ln-clicked")
    .forEach((el) => el.classList.remove("ln-clicked"));
  root
    .querySelectorAll(".ln-path-highlighted")
    .forEach((el) => el.classList.remove("ln-path-highlighted"));
  root
    .querySelectorAll(".ln-path-clicked")
    .forEach((el) => el.classList.remove("ln-path-clicked"));
  root
    .querySelectorAll(".ln-nd-revealed:not(.ln-rebuild-source)")
    .forEach((el) => el.classList.remove("ln-nd-revealed"));
}

document.addEventListener("click", clearLineageHighlight);

