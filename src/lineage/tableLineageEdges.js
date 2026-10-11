/* 
MODULE: src/lineage/tableLineageEdges.js
ROLE: Маршрутизация и рендеринг SVG-связей: расчет портов, прямой транзит (Rule 15), треки (Rule 11), fan-in (Rule 12), fan-out (Rule 12b), дуги и отрисовка путей.
*/

import { BUNDLE_SPACING, CHANNEL_SPACING, EDGE_HIT_WIDTH, TRANSIT_CLEARANCE } from "./tableLineageConstants.js";
import { getPortY } from "./tableLineageLayout.js";
import { clearLineageHighlight, highlightLineageEdge } from "./tableLineageHighlight.js";

/**
 * Расчет портов для каждого ребра
 */
export function buildFinalPorts(nodesSet, outEdgesMap, inEdgesMap, rects) {
  let finalPorts = new Map();

  const getRealEndpoint = (node, direction) => {
    let cur = node;
    let safety = 0;
    while (cur && cur.startsWith("vnode-") && safety++ < 50) {
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
    return cur || node;
  };

  const getCenterY = (n) =>
    rects[n] ? rects[n].top + rects[n].height / 2 : 0;

  const getEffectiveY = (edge, isOut) => {
    if (isOut) {
      if (edge._forcedEY !== undefined) return edge._forcedEY;
      if (edge._forcedY !== undefined) return edge._forcedY;
      const targetNode = edge.target.startsWith("vnode-")
        ? getRealEndpoint(edge.target, "down")
        : edge.target;
      return getCenterY(targetNode);
    } else {
      if (edge._forcedSY !== undefined) return edge._forcedSY;
      if (edge._forcedY !== undefined) return edge._forcedY;
      const sourceNode = edge.source.startsWith("vnode-")
        ? getRealEndpoint(edge.source, "up")
        : edge.source;
      return getCenterY(sourceNode);
    }
  };

  nodesSet.forEach((node) => {
    const process = (group, isOut) => {
      if (node.startsWith("vnode-")) {
        group.forEach((e) => {
          if (!finalPorts.has(e)) finalPorts.set(e, {});
          if (isOut) finalPorts.get(e).out = { isVirtual: true };
          else finalPorts.get(e).in = { isVirtual: true };
        });
        return;
      }
      const sorted = [...group].sort((a, b) => {
        const diff = getEffectiveY(a, isOut) - getEffectiveY(b, isOut);
        if (Math.abs(diff) > 0.1) return diff;
        const localA = getCenterY(isOut ? a.target : a.source);
        const localB = getCenterY(isOut ? b.target : b.source);
        if (Math.abs(localA - localB) > 0.1) return localA - localB;
        const keyA = `${a.source}->${a.target}`;
        const keyB = `${b.source}->${b.target}`;
        return keyA.localeCompare(keyB);
      });
      sorted.forEach((e, i) => {
        if (!finalPorts.has(e)) finalPorts.set(e, {});
        const p = { idx: i, count: sorted.length };
        if (isOut) finalPorts.get(e).out = p;
        else finalPorts.get(e).in = p;
      });
    };
    process(outEdgesMap.get(node) || [], true);
    process(inEdgesMap.get(node) || [], false);
  });
  return finalPorts;
}

export const getEdgeSY = (e, r, port, isVirtual) =>
  e._forcedSY !== undefined
    ? e._forcedSY
    : e._forcedY !== undefined
      ? e._forcedY
      : getPortY(r, port, isVirtual);

export const getEdgeEY = (e, r, port, isVirtual) =>
  e._forcedEY !== undefined
    ? e._forcedEY
    : e._forcedY !== undefined
      ? e._forcedY
      : getPortY(r, port, isVirtual);

/**
 * Поиск «чистой полосы» для прямого транзита с локальным обходом карточек промежуточных слоев.
 */
export function findFreeTransitY(
  firstY,
  lastY,
  sourceId,
  targetId,
  rank,
  layers,
  rects,
  allocatedYByLayer = {}
) {
  const rS = rank[sourceId];
  const rT = rank[targetId];
  const banned = [];

  for (let r = rS + 1; r < rT; r++) {
    const colNodes = layers[r];
    if (!colNodes) continue;
    for (const n of colNodes) {
      if (n.startsWith("vnode-")) continue;
      const R = rects[n];
      if (!R) continue;
      banned.push([R.top, R.bottom]);
    }
  }

  const isFree = (y) => {
    if (banned.some(([a, b]) => y > a && y < b)) return false;
    for (let r = rS; r < rT; r++) {
      const allocs = allocatedYByLayer[r] || [];
      if (allocs.some((ay) => Math.abs(ay - y) < TRANSIT_CLEARANCE)) return false;
    }
    return true;
  };

  // 1. Если прямой путь по firstY чист и свободен от других связей
  if (isFree(firstY)) return firstY;

  // 2. Если firstY заблокирован, но lastY свободен
  if (lastY !== undefined && isFree(lastY)) return lastY;

  // 3. Иначе ищем ближайшую свободную полосу
  let best = firstY;
  let bestDist = Infinity;
  const probe = (y) => {
    if (!isFree(y)) return;
    const d = Math.abs(y - firstY);
    if (d < bestDist) {
      bestDist = d;
      best = y;
    }
  };

  banned.forEach(([a, b]) => {
    probe(a - TRANSIT_CLEARANCE);
    probe(b + TRANSIT_CLEARANCE);
  });

  for (let r = rS; r < rT; r++) {
    const allocs = allocatedYByLayer[r] || [];
    allocs.forEach((ay) => {
      probe(ay - TRANSIT_CLEARANCE);
      probe(ay + TRANSIT_CLEARANCE);
    });
  }

  return bestDist === Infinity ? firstY : best;
}

/**
 * Rule 15: Принудительные прямые горизонтальные линии для целых транзитных цепочек.
 */
export function applyStraightTransitChains(edges, outEdgesMap, finalPorts, rects, rank, layers) {
  const allocatedYByLayer = {};

  edges.forEach((startEdge) => {
    if (startEdge.source.startsWith("vnode-")) return;

    let chain = [startEdge];
    let currentEdge = startEdge;

    while (currentEdge.target.startsWith("vnode-")) {
      const nextEdges = outEdgesMap.get(currentEdge.target);
      if (!nextEdges || nextEdges.length === 0) break;
      currentEdge = nextEdges[0];
      chain.push(currentEdge);
    }
    if (chain.length <= 1) return;

    const firstEdge = chain[0];
    const lastEdge = chain[chain.length - 1];
    const pFirst = finalPorts.get(firstEdge);
    const pLast = finalPorts.get(lastEdge);

    const sR = rects[firstEdge.source];
    const tR = rects[lastEdge.target];
    if (!sR || !tR) return;

    const firstY = getPortY(sR, pFirst.out, false);
    const lastY = getPortY(tR, pLast.in, false);

    const transitY = findFreeTransitY(
      firstY,
      lastY,
      firstEdge.source,
      lastEdge.target,
      rank,
      layers,
      rects,
      allocatedYByLayer
    );

    const rS = rank[firstEdge.source];
    const rT = rank[lastEdge.target];
    for (let r = rS; r < rT; r++) {
      if (!allocatedYByLayer[r]) allocatedYByLayer[r] = [];
      allocatedYByLayer[r].push(transitY);
    }

    chain.forEach((e, idx) => {
      if (idx === 0) {
        e._forcedEY = transitY;
      } else if (idx === chain.length - 1) {
        e._forcedSY = transitY;
        if (Math.abs(transitY - lastY) < 2) {
          e._forcedEY = transitY;
        }
      } else {
        e._forcedSY = transitY;
        e._forcedEY = transitY;
      }
    });
  });
}

/**
 * Отрисовка горизонтальной линии с "прыжками" (дугами) над вертикальными линиями
 */
export function drawHorizontalSegment(x1, x2, y, currentEdge, vSegments) {
  if (Math.abs(x1 - x2) < 1) return "";
  const dir = x1 < x2 ? 1 : -1;
  const R = 5; // Радиус дуги (прыжка)
  const minStraight = 5; // Минимальная длина прямого участка перед дугой

  let intersections = [];
  vSegments.forEach((v) => {
    if (v.edge === currentEdge) return;

    // Проверяем, пересекает ли горизонтальная линия вертикальную
    // Добавляем minStraight, чтобы дуга не рисовалась вплотную к узлам (убираем "зазоры")
    const isBetweenX =
      dir === 1
        ? v.x > x1 + R + minStraight && v.x < x2 - R - minStraight
        : v.x < x1 - R - minStraight && v.x > x2 + R + minStraight;

    const isCrossingY = y > v.yMin + 5 && y < v.yMax - 5;

    if (isBetweenX && isCrossingY) {
      intersections.push(v.x);
    }
  });

  if (intersections.length === 0) {
    return ` L ${x2} ${y}`;
  }

  // Сортируем точки пересечения по направлению движения
  intersections.sort((a, b) => (a - b) * dir);

  // Удаляем пересечения, которые слишком близко друг к другу (чтобы дуги не накладывались)
  let filteredIntersections = [];
  for (let i = 0; i < intersections.length; i++) {
    if (
      i === 0 ||
      Math.abs(
        intersections[i] -
          filteredIntersections[filteredIntersections.length - 1]
      ) >=
        R * 2
    ) {
      filteredIntersections.push(intersections[i]);
    }
  }

  let pathStr = "";
  filteredIntersections.forEach((ix) => {
    pathStr += ` L ${ix - R * dir} ${y}`;
    // Рисуем дугу (прыжок вниз, sweep-flag зависит от направления)
    const sweep = dir === 1 ? 1 : 0;
    pathStr += ` A ${R} ${R} 0 0 ${sweep} ${ix + R * dir} ${y}`;
  });

  pathStr += ` L ${x2} ${y}`;
  return pathStr;
}

/**
 * Построение и отрисовка всех SVG-рёбер в графе
 */
export function renderEdges(canvas, svg, edges, rank, rects, finalPorts) {
  const edgesByGap = {};
  edges.forEach((e) => {
    const gk = `${rank[e.source]}_${rank[e.target]}`;
    if (!edgesByGap[gk]) edgesByGap[gk] = [];
    edgesByGap[gk].push(e);
  });

  let svgContent = "";
  for (const [gk, gapEdges] of Object.entries(edgesByGap)) {
    let maxR = -Infinity,
      minL = Infinity;
    gapEdges.forEach((e) => {
      maxR = Math.max(maxR, rects[e.source].right);
      minL = Math.min(minL, rects[e.target].left);
    });
    const midX = (maxR + minL) / 2;

    gapEdges.forEach((e) => {
      const p = finalPorts.get(e);
      const sIsVirtual = e.source.startsWith("vnode-");
      const tIsVirtual = e.target.startsWith("vnode-");
      const y1 = getEdgeSY(e, rects[e.source], p.out, sIsVirtual);
      const y2 = getEdgeEY(e, rects[e.target], p.in, tIsVirtual);
      e._y1 = Math.min(y1, y2) - 1;
      e._y2 = Math.max(y1, y2) + 1;
      e._isHorizontal = Math.abs(y1 - y2) < 2;
    });

    // Rule 11: Vertical Separation
    const verticalEdges = gapEdges.filter((e) => !e._isHorizontal);
    verticalEdges.sort((a, b) => {
      if (Math.abs(a._y1 - b._y1) > 1) return a._y1 - b._y1;
      return b._y2 - a._y2;
    });

    let tracks = [];
    let edgeTracks = new Map();

    verticalEdges.forEach((e) => {
      const assignedTrack = tracks.length;
      tracks.push(e._y2);
      edgeTracks.set(e, assignedTrack);
    });

    const K = tracks.length;

    // Non-crossing fan-in (Rule 12)
    const targetGroups = new Map();
    verticalEdges.forEach((e) => {
      const tgt = e.target;
      if (!targetGroups.has(tgt)) targetGroups.set(tgt, []);
      targetGroups.get(tgt).push(e);
    });
    targetGroups.forEach((group) => {
      if (group.length < 2) return;

      const getEY = (e) => getEdgeEY(e, rects[e.target], finalPorts.get(e).in, e.target.startsWith("vnode-"));
      const getSY = (e) => getEdgeSY(e, rects[e.source], finalPorts.get(e).out, e.source.startsWith("vnode-"));

      const goingUp   = group.filter(e => getSY(e) > getEY(e));
      const goingDown = group.filter(e => getSY(e) < getEY(e));

      const allTracks = group.map(e => edgeTracks.get(e)).sort((a, b) => a - b);
      const nUp = goingUp.length;
      const tracksForUp   = allTracks.slice(0, nUp);
      const tracksForDown = allTracks.slice(nUp);

      if (goingDown.length >= 1) {
        goingDown.sort((a, b) => getEY(a) - getEY(b));
        const sorted = [...tracksForDown].sort((a, b) => a - b);
        goingDown.forEach((e, i) => edgeTracks.set(e, sorted[i]));
      }

      if (goingUp.length >= 1) {
        goingUp.sort((a, b) => getEY(b) - getEY(a));
        const sorted = [...tracksForUp].sort((a, b) => a - b);
        goingUp.forEach((e, i) => edgeTracks.set(e, sorted[i]));
      }
    });

    // Non-crossing fan-out (Rule 12b)
    const sourceGroups = new Map();
    verticalEdges.forEach((e) => {
      if (!sourceGroups.has(e.source)) sourceGroups.set(e.source, []);
      sourceGroups.get(e.source).push(e);
    });
    const getFOSY = (e) =>
      getEdgeSY(e, rects[e.source], finalPorts.get(e).out, e.source.startsWith("vnode-"));
    const getFOEY = (e) =>
      getEdgeEY(e, rects[e.target], finalPorts.get(e).in, e.target.startsWith("vnode-"));
    const fosCross = (a, b) => {
      const aRight = edgeTracks.get(a) < edgeTracks.get(b);
      const left = aRight ? b : a;
      const right = aRight ? a : b;
      const lEY = getFOEY(left);
      const rSY = getFOSY(right);
      const lYmin = Math.min(getFOSY(left), lEY);
      const lYmax = Math.max(getFOSY(left), lEY);
      if (Math.abs(getFOSY(right) - getFOEY(right)) < 2) return false;
      const rYmin = Math.min(rSY, getFOEY(right));
      const rYmax = Math.max(rSY, getFOEY(right));
      const tailCross = lEY > rYmin + 5 && lEY < rYmax - 5;
      const headCross = Math.abs(getFOSY(left) - lEY) >= 2
        && rSY > lYmin + 5 && rSY < lYmax - 5;
      return tailCross || headCross;
    };
    sourceGroups.forEach((group) => {
      if (group.length < 2) return;
      for (let pass = 0; pass < group.length; pass++) {
        let swapped = false;
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            if (!fosCross(group[i], group[j])) continue;
            const ta = edgeTracks.get(group[i]);
            const tb = edgeTracks.get(group[j]);
            edgeTracks.set(group[i], tb);
            edgeTracks.set(group[j], ta);
            if (fosCross(group[i], group[j])) {
              edgeTracks.set(group[i], ta);
              edgeTracks.set(group[j], tb);
            } else {
              swapped = true;
            }
          }
        }
        if (!swapped) break;
      }
    });

    // Adjacent track crossing reduction (Шлейфовая оптимизация параллельных связей)
    if (K > 1) {
      const getSY = (e) =>
        getEdgeSY(e, rects[e.source], finalPorts.get(e).out, e.source.startsWith("vnode-"));
      const getEY = (e) =>
        getEdgeEY(e, rects[e.target], finalPorts.get(e).in, e.target.startsWith("vnode-"));

      const countPairCrossings = (eLeft, eRight) => {
        const lSY = getSY(eLeft), lEY = getEY(eLeft);
        const rSY = getSY(eRight), rEY = getEY(eRight);
        const lYmin = Math.min(lSY, lEY), lYmax = Math.max(lSY, lEY);
        const rYmin = Math.min(rSY, rEY), rYmax = Math.max(rSY, rEY);
        let c = 0;
        if (Math.abs(rSY - rEY) >= 2 && lEY > rYmin + 5 && lEY < rYmax - 5) c++;
        if (Math.abs(lSY - lEY) >= 2 && rSY > lYmin + 5 && rSY < lYmax - 5) c++;
        return c;
      };

      const totalCrossings = () => {
        let total = 0;
        for (let i = 0; i < verticalEdges.length; i++) {
          for (let j = i + 1; j < verticalEdges.length; j++) {
            const eA = verticalEdges[i];
            const eB = verticalEdges[j];
            const tA = edgeTracks.get(eA);
            const tB = edgeTracks.get(eB);
            if (tA === tB) continue;
            const [eRight, eLeft] = tA < tB ? [eA, eB] : [eB, eA];
            total += countPairCrossings(eLeft, eRight);
          }
        }
        return total;
      };

      for (let pass = 0; pass < K * 2; pass++) {
        let swappedInPass = false;
        for (let i = 0; i < verticalEdges.length; i++) {
          for (let j = i + 1; j < verticalEdges.length; j++) {
            const eA = verticalEdges[i];
            const eB = verticalEdges[j];
            const tA = edgeTracks.get(eA);
            const tB = edgeTracks.get(eB);
            if (tA === tB) continue;

            const cBefore = totalCrossings();
            edgeTracks.set(eA, tB);
            edgeTracks.set(eB, tA);
            const cAfter = totalCrossings();

            if (cAfter < cBefore) {
              swappedInPass = true;
            } else {
              edgeTracks.set(eA, tA);
              edgeTracks.set(eB, tB);
            }
          }
        }
        if (!swappedInPass) break;
      }
    }

    // Rule 11b: Guaranteed Horizontal Clearance (No overlap between opposing source and target segments)
    for (let pass = 0; pass < verticalEdges.length; pass++) {
      let swapped = false;
      for (let i = 0; i < verticalEdges.length; i++) {
        for (let j = i + 1; j < verticalEdges.length; j++) {
          const e1 = verticalEdges[i];
          const e2 = verticalEdges[j];
          const sY1 = getEdgeSY(e1, rects[e1.source], finalPorts.get(e1).out, e1.source.startsWith("vnode-"));
          const eY1 = getEdgeEY(e1, rects[e1.target], finalPorts.get(e1).in, e1.target.startsWith("vnode-"));
          const sY2 = getEdgeSY(e2, rects[e2.source], finalPorts.get(e2).out, e2.source.startsWith("vnode-"));
          const eY2 = getEdgeEY(e2, rects[e2.target], finalPorts.get(e2).in, e2.target.startsWith("vnode-"));

          // Case 1: e1 is source segment at sY1, e2 is target segment at eY2
          if (Math.abs(sY1 - eY2) < 8) {
            const t1 = edgeTracks.get(e1);
            const t2 = edgeTracks.get(e2);
            // Source segment e1 must turn before target segment e2: cX(e1) < cX(e2) => t1 > t2
            if (t1 < t2) {
              edgeTracks.set(e1, t2);
              edgeTracks.set(e2, t1);
              swapped = true;
            }
          }
          // Case 2: e2 is source segment at sY2, e1 is target segment at eY1
          if (Math.abs(sY2 - eY1) < 8) {
            const t1 = edgeTracks.get(e1);
            const t2 = edgeTracks.get(e2);
            // Source segment e2 must turn before target segment e1: cX(e2) < cX(e1) => t2 > t1
            if (t2 < t1) {
              edgeTracks.set(e1, t2);
              edgeTracks.set(e2, t1);
              swapped = true;
            }
          }
        }
      }
      if (!swapped) break;
    }

    const safeZone = Math.max(0, (minL - maxR) / 2 - 10);
    const actualSpacing = K > 1
      ? Math.min(CHANNEL_SPACING, (safeZone * 2) / (K - 1))
      : CHANNEL_SPACING;

    verticalEdges.forEach((e) => {
      const t = edgeTracks.get(e);
      const off = ((K - 1) * actualSpacing) / 2 - t * actualSpacing;
      e._cX = midX + off;
    });

    gapEdges
      .filter((e) => e._isHorizontal)
      .forEach((e) => {
        e._cX = midX;
      });

    gapEdges.forEach((e) => {
      const p = finalPorts.get(e);
      const sR = rects[e.source],
        tR = rects[e.target];
      let sY = getEdgeSY(e, sR, p.out, e.source.startsWith("vnode-"));
      let eY = getEdgeEY(e, tR, p.in, e.target.startsWith("vnode-"));

      e._finalSY = sY;
      e._finalEY = eY;
      e._sX = sR.right;
      e._eX = tR.left;
      e._isHorizontalFinal = Math.abs(sY - eY) < 2;
    });

    // Собираем все вертикальные сегменты в текущем зазоре для поиска пересечений
    const vSegments = [];
    gapEdges.forEach((e) => {
      if (!e._isHorizontalFinal) {
        vSegments.push({
          x: e._cX || (e._sX + e._eX) / 2,
          yMin: Math.min(e._finalSY, e._finalEY),
          yMax: Math.max(e._finalSY, e._finalEY),
          edge: e,
        });
      }
    });

    gapEdges.forEach((e) => {
      const sX = e._sX;
      const eX = e._eX;
      const sY = e._finalSY;
      const eY = e._finalEY;
      const isHorizontal = e._isHorizontalFinal;

      let path = `M ${sX} ${sY}`;
      if (isHorizontal) {
        path += drawHorizontalSegment(sX, eX, sY, e, vSegments);
        if (Math.abs(sY - eY) > 0.1) {
          path += ` L ${eX} ${eY}`;
        }
      } else {
        const breakX = e._cX || (sX + eX) / 2;
        path += drawHorizontalSegment(sX, breakX, sY, e, vSegments);
        path += ` L ${breakX} ${eY}`;
        path += drawHorizontalSegment(breakX, eX, eY, e, vSegments);
      }

      // Невидимая широкая зона клика + видимая линия ребра
      svgContent += `<path class="ln-edge-hit" d="${path}" fill="none" stroke="transparent" stroke-width="${EDGE_HIT_WIDTH}" stroke-linecap="round" stroke-linejoin="round" data-source="${e.source}" data-target="${e.target}"/>`;
      svgContent += `<path class="ln-edge-line" d="${path}" fill="none" stroke="#94A3B8" stroke-width="2" data-source="${e.source}" data-target="${e.target}"/>`;
    });
  }
  svg.innerHTML = svgContent;

  svg.addEventListener("click", (e) => {
    const pathEl = e.target.closest("path");
    if (!pathEl || !svg.contains(pathEl)) return;
    if (!pathEl.dataset.source || !pathEl.dataset.target) return;
    e.stopPropagation();
    clearLineageHighlight();
    highlightLineageEdge(canvas, pathEl);
  });
}
