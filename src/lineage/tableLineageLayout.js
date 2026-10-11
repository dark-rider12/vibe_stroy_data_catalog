/* 
MODULE: src/lineage/tableLineageLayout.js
ROLE: Вычисление размеров узлов, вертикальное позиционирование (Phase 2), коллизии, isolated pairs, Rule 18 и расширение зазоров.
*/

import { sanitizeId } from "../utils/helpers.js";
import {
  BUNDLE_SPACING,
  MIN_GAP,
  MIN_GAP_23,
  BEND_TOLERANCE,
  MAX_ALIGN_OFFSET,
  CHANNEL_PADDING,
  TRACK_STEP,
} from "./tableLineageConstants.js";
import { logShift } from "./tableLineageDebug.js";

/**
 * Подсчитывает реальные степени узлов (прослеживая цепочки vnode до реальных узлов)
 */
export function calculateNodeDegrees(nodesArray, edges, inEdgesMap, outEdgesMap) {
  const nodeInDegree = new Map();
  const nodeOutDegree = new Map();
  nodesArray.forEach((n) => {
    nodeInDegree.set(n, 0);
    nodeOutDegree.set(n, 0);
  });

  const getRealEndpoint = (node, direction) => {
    let cur = node;
    let safety = 0;
    while (cur.startsWith("vnode-") && safety++ < 50) {
      if (direction === "up") {
        const e = (inEdgesMap.get(cur) || [])[0];
        if (!e) break;
        cur = e.source;
      } else {
        const e = (outEdgesMap.get(cur) || [])[0];
        if (!e) break;
        cur = e.target;
      }
    }
    return cur;
  };

  const realEdgePairs = new Set();
  edges.forEach((e) => {
    const src = e.source.startsWith("vnode-") ? getRealEndpoint(e.source, "up") : e.source;
    const tgt = e.target.startsWith("vnode-") ? getRealEndpoint(e.target, "down") : e.target;
    if (src.startsWith("vnode-") || tgt.startsWith("vnode-")) return;
    if (src === tgt) return;
    const key = `${src}|${tgt}`;
    if (realEdgePairs.has(key)) return;
    realEdgePairs.add(key);
    nodeOutDegree.set(src, (nodeOutDegree.get(src) || 0) + 1);
    nodeInDegree.set(tgt, (nodeInDegree.get(tgt) || 0) + 1);
  });

  return { nodeInDegree, nodeOutDegree };
}

export function getNodePaddingV(n, nodeInDegree, nodeOutDegree) {
  const dominantSide = Math.max(nodeInDegree.get(n) || 0, nodeOutDegree.get(n) || 0);
  if (dominantSide <= 4) return 12;
  const height = dominantSide * BUNDLE_SPACING + 2 * (BUNDLE_SPACING / 2);
  return Math.max(12, Math.round((height - 14) / 2));
}

export function getLocalRect(el, canvas) {
  let x = el.offsetLeft,
    y = el.offsetTop,
    p = el.offsetParent;
  while (p && p !== canvas) {
    x += p.offsetLeft;
    y += p.offsetTop;
    p = p.offsetParent;
  }
  return {
    left: x,
    top: y,
    width: el.offsetWidth,
    height: el.offsetHeight,
    right: x + el.offsetWidth,
    bottom: y + el.offsetHeight,
  };
}

export function getPortY(r, port, isVirtualNode) {
  if (isVirtualNode) return r.top + r.height / 2;
  const dominantCount = port ? port.count : 0;
  if (dominantCount <= 1) return r.top + r.height / 2;
  const totalBunch = (dominantCount - 1) * BUNDLE_SPACING;
  const startY = r.top + (r.height - totalBunch) / 2;
  return startY + (port ? port.idx : 0) * BUNDLE_SPACING;
}

/**
 * Проверка зазоров к реальным соседям своей колонки и сдвиг через marginTop.
 */
export function shiftWithGap(el, delta, minGap = MIN_GAP_23, rule = "Shift") {
  if (!el || !delta) return false;
  const newTop = el.offsetTop + delta;
  let above = null;
  const parent = el.parentElement;
  if (parent) {
    Array.from(parent.children).forEach((sib) => {
      if (sib === el) return;
      if (sib.classList.contains("ln-virtual")) return;
      if (sib.offsetTop < el.offsetTop) {
        if (!above || sib.offsetTop > above.offsetTop) above = sib;
      }
    });
  }
  const curMargin = parseFloat(el.style.marginTop || 0) || 0;
  // При сдвиге вверх (delta < 0) проверяем чтобы не наехать на соседа сверху.
  // Для первого элемента в слое (above === null) разрешаем подтяжку вверх
  // до -32px благодаря padding: 100px холста.
  if (delta < 0) {
    if (!above && curMargin + delta < -32) {
      logShift(rule, el.id, delta, minGap, false, "first in column: margin < -32px");
      return false;
    }
    if (above && newTop < above.offsetTop + above.offsetHeight + minGap) {
      logShift(rule, el.id, delta, minGap, false, `above neighbor gap < ${minGap}px`);
      return false;
    }
  }
  // При сдвиге вниз (delta > 0) во flex-потоке колонки элемент и все последующие соседи
  // смещаются вместе, сохраняя межэлементные зазоры.
  el.style.marginTop = curMargin + delta + "px";
  logShift(rule, el.id, delta, minGap, true);
  return true;
}

/**
 * Phase 2: Layer-by-layer alignment, collision resolution & isolated pairs.
 */
export function applyPhase2Layout(layers, maxLayer, unique_id, neighborsLeft, inEdgesMap, outEdgesMap) {
  const getPhase2PortY = (el, portIdx, portCount) => {
    if (portCount <= 1) return el.offsetTop + el.offsetHeight / 2;
    const totalBunch = (portCount - 1) * BUNDLE_SPACING;
    const startY = el.offsetTop + (el.offsetHeight - totalBunch) / 2;
    return startY + portIdx * BUNDLE_SPACING;
  };

  // 2.1. Align current layer to parents
  for (let i = 1; i <= maxLayer; i++) {
    if (!layers[i]) continue;

    layers[i].forEach((node) => {
      const neighbors = neighborsLeft[node] || [];
      if (neighbors.length > 0) {
        neighbors.sort((a, b) => {
          const aEl = document.getElementById(`lnode-${sanitizeId(a)}-${unique_id}`);
          const bEl = document.getElementById(`lnode-${sanitizeId(b)}-${unique_id}`);
          return (aEl?.offsetTop || 0) - (bEl?.offsetTop || 0);
        });

        let midIdx = 0;
        if (neighbors.length > 1 && neighbors.length % 2 !== 0) {
          midIdx = Math.floor(neighbors.length / 2);
        }
        const primaryParent = neighbors[midIdx];

        const pEl = document.getElementById(`lnode-${sanitizeId(primaryParent)}-${unique_id}`);
        const cEl = document.getElementById(`lnode-${sanitizeId(node)}-${unique_id}`);

        if (pEl && cEl) {
          let pPortY;
          if (primaryParent.startsWith("vnode-")) {
            pPortY = pEl.offsetTop + pEl.offsetHeight / 2;
          } else {
            const outEdges = outEdgesMap.get(primaryParent) || [];
            outEdges.sort((a, b) => {
              const aEl = document.getElementById(`lnode-${sanitizeId(a.target)}-${unique_id}`);
              const bEl = document.getElementById(`lnode-${sanitizeId(b.target)}-${unique_id}`);
              return (aEl?.offsetTop || 0) - (bEl?.offsetTop || 0);
            });
            const portIdx = outEdges.findIndex((e) => e.target === node);
            pPortY = portIdx >= 0
              ? getPhase2PortY(pEl, portIdx, outEdges.length)
              : pEl.offsetTop + pEl.offsetHeight / 2;
          }

          const cPortY = neighbors.length > 1
            ? getPhase2PortY(cEl, midIdx, neighbors.length)
            : cEl.offsetTop + cEl.offsetHeight / 2;

          const diff = pPortY - cPortY;
          const curMargin = parseFloat(cEl.style.marginTop || 0) || 0;
          const clamped = Math.max(
            -MAX_ALIGN_OFFSET,
            Math.min(MAX_ALIGN_OFFSET, curMargin + diff)
          );
          cEl.style.marginTop = clamped + "px";
          logShift("Phase2.1", cEl.id, clamped - curMargin, 0, true, `align to ${primaryParent}`);
        }
      }
    });

    // 2.2. Collision Resolution for THIS layer
    const layerNodes = layers[i]
      .map((n, idx) => {
        const el = document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`);
        if (el) el.dataset.sugiIdx = idx;
        return el;
      })
      .filter((el) => el !== null);

    layerNodes.sort(
      (a, b) => parseInt(a.dataset.sugiIdx) - parseInt(b.dataset.sugiIdx)
    );

    for (let iter = 0; iter < 15; iter++) {
      for (let j = 1; j < layerNodes.length; j++) {
        const prev = layerNodes[j - 1];
        const curr = layerNodes[j];
        const prevBottom = prev.offsetTop + prev.offsetHeight;
        const currTop = curr.offsetTop;
        if (currTop < prevBottom + MIN_GAP) {
          const overlap = prevBottom + MIN_GAP - currTop;
          const curMargin = parseFloat(curr.style.marginTop || 0) || 0;
          curr.style.marginTop = curMargin + overlap + "px";
        }
      }
    }


  }

  // 2.3. Straight-through для изолированных пар
  if (layers[0]) {
    const roots = layers[0]
      .filter((n) => !String(n).startsWith("vnode-"))
      .map((n) => ({
        id: n,
        el: document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`),
      }))
      .filter((x) => x.el !== null)
      .sort((a, b) => a.el.offsetTop - b.el.offsetTop);

    const pairs = [];
    roots.forEach(({ id, el }) => {
      const out = outEdgesMap.get(id) || [];
      if (out.length !== 1) return;
      const tId = out[0].target;
      if (String(tId).startsWith("vnode-")) return;
      const tEl = document.getElementById(`lnode-${sanitizeId(tId)}-${unique_id}`);
      if (!tEl) return;
      const ins = inEdgesMap.get(tId) || [];
      if (ins.length !== 1) return;
      const sCenter = el.offsetTop + el.offsetHeight / 2;
      const tCenter = tEl.offsetTop + tEl.offsetHeight / 2;
      const delta = tCenter - sCenter;
      if (Math.abs(delta) < BEND_TOLERANCE) return;
      pairs.push({ sourceEl: el, targetEl: tEl, delta });
    });

    pairs
      .slice()
      .sort((a, b) => a.sourceEl.offsetTop - b.sourceEl.offsetTop)
      .forEach((p) => {
        // Ограничиваем чрезмерный разрыв слоя при сдвиге источника (не более 48px),
        // передавая остаток в TargetFallback для сбалансированного выравнивания
        const allowedDelta = p.delta > 0 ? Math.min(48, p.delta) : p.delta;
        if (shiftWithGap(p.sourceEl, allowedDelta, 4, "Rule2.3:Source")) {
          p.sourceMoved = Math.abs(allowedDelta - p.delta) < BEND_TOLERANCE;
        }
      });

    const fallback = pairs.filter((p) => !p.sourceMoved);
    for (let pass = 0, applied = true; applied && pass < fallback.length; pass++) {
      applied = false;
      fallback
        .slice()
        .sort((a, b) => b.targetEl.offsetTop - a.targetEl.offsetTop)
        .forEach((p) => {
          const sCenter = p.sourceEl.offsetTop + p.sourceEl.offsetHeight / 2;
          const tCenter = p.targetEl.offsetTop + p.targetEl.offsetHeight / 2;
          const shift = sCenter - tCenter;
          if (Math.abs(shift) < BEND_TOLERANCE) return;
          if (shiftWithGap(p.targetEl, shift, 4, "Rule2.3:TargetFallback")) applied = true;
        });
    }
  }
}

/**
 * Rule 18: Прямое верхнее входящее ребро (Straight Top Incoming Edge).
 */
export function alignStraightTopIncomingEdges(
  layers,
  maxLayer,
  unique_id,
  inEdgesMap,
  outEdgesMap,
  canvas,
) {
  const elFor = (n) => document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`);
  const freshRect = (n) => {
    const el = elFor(n);
    return el ? getLocalRect(el, canvas) : null;
  };

  const shiftedCards = new Set();
  for (let li = 1; li <= maxLayer; li++) {
    const colNodes = layers[li];
    if (!colNodes) continue;
    for (const node of colNodes) {
      if (node.startsWith("vnode-")) continue;
      const insAll = inEdgesMap.get(node) || [];
      if (insAll.length === 0) continue;
      const tR = freshRect(node);
      if (!tR) continue;
      const srcCenter = (n) => {
        const r = freshRect(n);
        return r ? r.top + r.height / 2 : 0;
      };
      const sortedIns = [...insAll].sort(
        (a, b) => srcCenter(a.source) - srcCenter(b.source)
      );

      const topE = sortedIns[0];
      if (!topE) continue;
      const topIdx = 0;
      let S = topE.source;
      const isTransit = S.startsWith("vnode-");
      let realFirstEdge = topE;
      if (isTransit) {
        let curr = topE;
        while (S.startsWith("vnode-")) {
          const ins = inEdgesMap.get(S) || [];
          if (ins.length === 0) break;
          curr = ins[0];
          S = curr.source;
        }
        realFirstEdge = curr;
      }
      if (S.startsWith("vnode-")) continue;

      const sR = freshRect(S);
      if (!sR) continue;
      const topPortY = getPortY(tR, { idx: topIdx, count: sortedIns.length }, false);
      const outs = outEdgesMap.get(S) || [];
      const outsSorted = [...outs].sort((a, b) => {
        const ra = freshRect(a.target);
        const rb = freshRect(b.target);
        return (
          (ra ? ra.top + ra.height / 2 : 0) -
          (rb ? rb.top + rb.height / 2 : 0)
        );
      });
      let srcPortY;
      if (outsSorted.length <= 1) {
        srcPortY = sR.top + sR.height / 2;
      } else {
        const outIdx = Math.max(0, outsSorted.indexOf(realFirstEdge));
        srcPortY = getPortY(sR, { idx: outIdx, count: outsSorted.length }, false);
      }
      const tEl = elFor(node);
      const srcEl = elFor(S);
      if (!tEl) continue;

      const delta = topPortY - srcPortY;
      if (Math.abs(delta) < 0.5) {
        shiftedCards.add(tEl);
        if (srcEl) shiftedCards.add(srcEl);
        continue;
      }

      if (isTransit) {
        // Для транзитных цепочек: сдвигаем цель навстречу реальному источнику цепочки
        if (!shiftedCards.has(tEl) && shiftWithGap(tEl, -delta, 4, "Rule18:TargetToTransitSource")) {
          shiftedCards.add(tEl);
        }
        continue;
      }

      const srcHasParents = (inEdgesMap.get(S) || []).length > 0;
      if (outsSorted.length <= 1 && !srcHasParents) {
        // Одиночный выход источника без родителей (Слой 0): пробуем сдвинуть source, fallback — target
        let moved = false;
        if (
          srcEl &&
          !shiftedCards.has(srcEl) &&
          shiftWithGap(srcEl, delta, 4, "Rule18:SingleOutSource")
        ) {
          shiftedCards.add(srcEl);
          shiftedCards.add(tEl);
          moved = true;
        } else if (
          !shiftedCards.has(tEl) &&
          shiftWithGap(tEl, -delta, 4, "Rule18:SingleOutTargetFallback")
        ) {
          shiftedCards.add(tEl);
          if (srcEl) shiftedCards.add(srcEl);
          moved = true;
        }
        // Фиксируем строгую горизонталь для верхнего входящего ребра одиночного источника
        topE._forcedSY = topPortY;
        topE._forcedEY = topPortY;
      } else {
        // Промежуточный узел (есть родители) или Fan-out:
        // Двигаем только цель (target), чтобы не ломать входящие связи источника
        if (
          !shiftedCards.has(tEl) &&
          shiftWithGap(tEl, -delta, 4, "Rule18:TargetToSource")
        ) {
          shiftedCards.add(tEl);
          if (srcEl) shiftedCards.add(srcEl);
          topE._forcedSY = srcPortY;
          topE._forcedEY = srcPortY;
        }
      }
    }
  }
}

/**
 * Адаптивное расширение каналов (gap) между слоями.
 */
export function expandGapsForTracks(
  pane,
  layers,
  maxLayer,
  edges,
  rank,
  finalPorts,
  rects,
  getEdgeSY,
  getEdgeEY,
) {
  const layoutEl = pane.querySelector(".lineage-layout");
  const cs = layoutEl ? getComputedStyle(layoutEl) : null;
  const baseGap = cs ? parseFloat(cs.columnGap || cs.gap || "") || 120 : 120;

  const measureByGap = {};
  edges.forEach((e) => {
    const gk = `${rank[e.source]}_${rank[e.target]}`;
    if (!measureByGap[gk]) measureByGap[gk] = [];
    measureByGap[gk].push(e);
  });

  const requiredGap = {};
  Object.entries(measureByGap).forEach(([gk, gapEdges]) => {
    let k = 0;
    gapEdges.forEach((e) => {
      const p = finalPorts.get(e);
      if (!p) return;
      const y1 = getEdgeSY(e, rects[e.source], p.out, e.source.startsWith("vnode-"));
      const y2 = getEdgeEY(e, rects[e.target], p.in, e.target.startsWith("vnode-"));
      if (Math.abs(y1 - y2) >= 2) k += 1;
    });
    requiredGap[gk] = CHANNEL_PADDING + Math.max(0, k - 1) * TRACK_STEP;
  });

  if (layoutEl) {
    const layerEls = Array.from(layoutEl.children);
    let elIdx = 0;
    let accExcess = 0;
    let prevRank = -1;
    for (let i = 0; i <= maxLayer; i++) {
      if (!layers[i]) continue;
      if (prevRank >= 0) {
        const gk = `${prevRank}_${i}`;
        const need = requiredGap[gk] ?? baseGap;
        accExcess += Math.max(0, need - baseGap);
        if (accExcess > 0 && layerEls[elIdx]) {
          layerEls[elIdx].style.marginLeft = `${accExcess}px`;
        }
      }
      prevRank = i;
      elIdx += 1;
    }
  }
}
