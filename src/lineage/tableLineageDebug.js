/* 
MODULE: src/lineage/tableLineageDebug.js
ROLE: Сбор и структурированный вывод отладочной информации по Table Lineage (сдвиги, зазоры, изломы ребер).
*/

const debugState = {
  tableId: null,
  shifts: [],
  edges: [],
  bends: [],
};

/**
 * Инициализация отладочного состояния перед рендерингом графа
 */
export function initLineageDebug(tableId) {
  debugState.tableId = tableId;
  debugState.shifts = [];
  debugState.edges = [];
  debugState.bends = [];
  if (typeof window !== "undefined") {
    window.__LINEAGE_DEBUG__ = debugState;
  }
}

/**
 * Фиксация попытки сдвига карточки (успех или блокировка)
 */
export function logShift(rule, nodeId, delta, minGap, success, reason = "") {
  const item = {
    rule,
    nodeId,
    delta: Math.round(delta * 10) / 10,
    minGap,
    success,
    reason,
  };
  debugState.shifts.push(item);
  const statusStr = success ? "✓ APPLIED" : `✗ BLOCKED (${reason})`;
  console.log(`[Lineage:Shift:${rule}] ${nodeId} delta=${item.delta}px ${statusStr}`);
}

/**
 * Финализация отладки: сбор всех рёбер, выявление изломов и вывод сводки
 */
export function finalizeLineageDebug(tableId, edges, rects, finalPorts, getEdgeSY, getEdgeEY) {
  debugState.tableId = tableId;
  const edgeList = [];
  const bendList = [];

  edges.forEach((e) => {
    const p = finalPorts.get(e);
    if (!p) return;
    const sR = rects[e.source];
    const tR = rects[e.target];
    if (!sR || !tR) return;

    const sY = getEdgeSY(e, sR, p.out, e.source.startsWith("vnode-"));
    const eY = getEdgeEY(e, tR, p.in, e.target.startsWith("vnode-"));
    const delta = Math.round((eY - sY) * 10) / 10;
    const absDelta = Math.abs(delta);
    const isStraight = absDelta < 0.5;
    const isMicroBend = !isStraight && absDelta < 15;
    const isLargeBend = absDelta >= 15;

    const edgeInfo = {
      source: e.source,
      target: e.target,
      sY: Math.round(sY * 10) / 10,
      eY: Math.round(eY * 10) / 10,
      delta,
      type: isStraight ? "straight" : isMicroBend ? "micro-bend" : "large-bend",
      isStraight,
    };
    edgeList.push(edgeInfo);

    if (!isStraight) {
      bendList.push(edgeInfo);
    }
  });

  debugState.edges = edgeList;
  debugState.bends = bendList;

  // 1. Сохраняем в DOM для 100% гарантированного чтения через селектор в браузере
  let debugEl = document.getElementById(`lineage-debug-data-${tableId}`);
  if (!debugEl) {
    debugEl = document.createElement("script");
    debugEl.id = `lineage-debug-data-${tableId}`;
    debugEl.type = "application/json";
    document.body.appendChild(debugEl);
  }
  debugEl.textContent = JSON.stringify(debugState, null, 2);

  // 2. Логирование через console.warn (гарантированно перехватывается capture_browser_console_logs)
  debugState.shifts.forEach((s) => {
    if (s.success) {
      console.warn(`[Lineage:ShiftApplied] ${s.rule}: ${s.nodeId} (delta=${s.delta}px)`);
    } else {
      console.warn(`[Lineage:ShiftBlocked] ${s.rule}: ${s.nodeId} (delta=${s.delta}px, reason=${s.reason})`);
    }
  });

  if (bendList.length > 0) {
    bendList.forEach((b) => {
      console.warn(`[Lineage:Bend] ${b.source} -> ${b.target} (delta=${b.delta}px, type=${b.type}, sY=${b.sY}, eY=${b.eY})`);
    });
  } else {
    console.warn(`[Lineage:Debug] All ${edgeList.length} edges are straight!`);
  }

  // 3. Структурированная консольная таблица для ручной разработки в DevTools
  console.groupCollapsed(`[Lineage:Debug] Table: ${tableId} (Bends: ${bendList.length}, Shifts: ${debugState.shifts.length})`);
  if (debugState.shifts.length > 0) {
    console.table(debugState.shifts);
  }
  if (bendList.length > 0) {
    console.table(bendList);
  }
  console.log("Full debug data available at: window.__LINEAGE_DEBUG__");
  console.groupEnd();
}
