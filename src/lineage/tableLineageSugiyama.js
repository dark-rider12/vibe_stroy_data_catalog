/* 
MODULE: src/lineage/tableLineageSugiyama.js
ROLE: Алгоритм распределения по слоям и оптимизации пересечений Sugiyama (Barycenter/Median + Sifting + Fenwick BIT).
*/

import { SUGIYAMA_PASSES, SIFTING_PASSES, SUGIYAMA_GRAVITY_WEIGHT } from "./tableLineageConstants.js";

/**
 * Вычисляет ранги узлов (топологическая сортировка longest path),
 * вставляет виртуальные узлы (dummy nodes) для транзитных связей,
 * строит карты слоев и смежности.
 */
export function computeLayersAndVirtualNodes(nodesSet, edges) {
  let nodesArray = Array.from(nodesSet);

  // Расчет слоев (Топологическая сортировка - Longest path)
  let rank = {};
  nodesArray.forEach((n) => (rank[n] = 0));

  // Удаляем случайные self-loops и дубликаты рёбер
  edges = edges.filter((e) => e.source !== e.target);
  const edgeSet = new Set();
  edges = edges.filter((e) => {
    const key = `${e.source}|${e.target}`;
    if (edgeSet.has(key)) return false;
    edgeSet.add(key);
    return true;
  });

  let changed = true;
  let limit = nodesArray.length;
  while (changed && limit > 0) {
    changed = false;
    edges.forEach((e) => {
      if (rank[e.target] < rank[e.source] + 1) {
        rank[e.target] = rank[e.source] + 1;
        changed = true;
      }
    });
    limit--;
  }

  // Вставка виртуальных узлов (Dummy Nodes) для длинных связей
  let splitEdges = [];
  edges.forEach((e) => {
    const rS = rank[e.source],
      rT = rank[e.target];
    if (rT <= rS + 1) {
      splitEdges.push(e);
    } else {
      let prev = e.source;
      for (let r = rS + 1; r < rT; r++) {
        const vId = `vnode-${e.source}-${e.target}-${r}`;
        nodesSet.add(vId);
        rank[vId] = r;
        splitEdges.push({ source: prev, target: vId, _isVirtual: true });
        prev = vId;
      }
      splitEdges.push({ source: prev, target: e.target, _isVirtual: true });
    }
  });
  edges = splitEdges;
  nodesArray = Array.from(nodesSet);

  // Карты рёбер по источнику/цели
  const outEdgesMap = new Map(); // source -> [edges]
  const inEdgesMap = new Map();  // target -> [edges]
  edges.forEach((e) => {
    if (!outEdgesMap.has(e.source)) outEdgesMap.set(e.source, []);
    outEdgesMap.get(e.source).push(e);
    if (!inEdgesMap.has(e.target)) inEdgesMap.set(e.target, []);
    inEdgesMap.get(e.target).push(e);
  });

  // Группируем узлы по колонкам (слоям)
  let layers = {};
  let maxLayer = 0;
  nodesArray.forEach((n) => {
    const r = rank[n];
    if (!layers[r]) layers[r] = [];
    layers[r].push(n);
    if (r > maxLayer) maxLayer = r;
  });

  return {
    nodesArray,
    edges,
    rank,
    maxLayer,
    layers,
    outEdgesMap,
    inEdgesMap,
  };
}

/**
 * Подсчёт пересечений между соседними слоями с помощью дерева Фенвика (Fenwick / BIT) за O(m log m).
 */
export function countCrossings(layer1, layer2, posMap, pairIndex, layerPairEdges) {
  if (!layer1 || !layer2 || layer1.length === 0 || layer2.length === 0)
    return 0;

  const relevantEdges = layerPairEdges[pairIndex] || [];
  if (relevantEdges.length < 2) return 0;

  const R = layer2.length;
  const pairs = [];
  for (let i = 0; i < relevantEdges.length; i++) {
    pairs.push([
      posMap.get(relevantEdges[i].source) || 0,
      posMap.get(relevantEdges[i].target) || 0,
    ]);
  }
  pairs.sort((a, b) => a[0] - b[0]);

  const bit = new Array(R + 2).fill(0);
  let crossings = 0;
  let inserted = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j < pairs.length && pairs[j][0] === pairs[i][0]) j++;
    for (let k = i; k < j; k++) {
      const t = pairs[k][1];
      let pref = 0;
      for (let x = Math.min(t + 1, R); x > 0; x -= x & -x) pref += bit[x];
      crossings += inserted - pref;
    }
    for (let k = i; k < j; k++) {
      const t = pairs[k][1];
      for (let x = Math.min(t + 1, R); x <= R; x += x & -x) bit[x]++;
    }
    inserted += j - i;
    i = j;
  }
  return crossings;
}

export function countTotalCrossings(testLayers, posMap, maxLayer, layerPairEdges) {
  let total = 0;
  for (let i = 0; i < maxLayer; i++) {
    total += countCrossings(testLayers[i], testLayers[i + 1], posMap, i + 1, layerPairEdges);
  }
  return total;
}

function getMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Оптимизация расположения узлов в слоях по алгоритму Sugiyama (Barycenter/Median + Sifting).
 */
export async function optimizeSugiyamaLayout(
  layers,
  maxLayer,
  edges,
  reportProgress = () => {},
  yieldToBrowser = () => Promise.resolve(),
) {
  let neighborsRight = {};
  let neighborsLeft = {};
  edges.forEach((e) => {
    if (!neighborsRight[e.source]) neighborsRight[e.source] = [];
    if (!neighborsLeft[e.target]) neighborsLeft[e.target] = [];
    neighborsRight[e.source].push(e.target);
    neighborsLeft[e.target].push(e.source);
  });

  for (let i = 0; i <= maxLayer; i++) {
    if (layers[i]) layers[i].sort();
  }

  // Предсчитаем подмножества рёбер между соседними слоями для быстрого подсчёта пересечений
  const layerPairEdges = [];
  for (let i = 1; i <= maxLayer; i++) {
    const srcSet = new Set(layers[i - 1] || []);
    const tgtSet = new Set(layers[i] || []);
    layerPairEdges[i] = edges.filter(
      (e) => srcSet.has(e.source) && tgtSet.has(e.target)
    );
  }

  // Адаптивное число инициализаций слоя 0 для выхода из локальных минимумов
  const layer0Size = layers[0] ? layers[0].length : 0;
  const numInitializations = Math.min(20, Math.max(5, Math.floor(layer0Size / 2)));

  const initializations = [];
  if (layers[0]) {
    const original = [...layers[0]];
    initializations.push(original);
    initializations.push([...original].reverse());

    for (let k = 0; k < numInitializations; k++) {
      const shuffled = [...original];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      initializations.push(shuffled);
    }
  } else {
    initializations.push([]);
  }

  reportProgress(5, "Предобработка связей…");

  let bestPositions = new Map();
  let bestLayers = {};
  let minTotalCrossings = Infinity;
  let minCost = Infinity;

  for (let initIdx = 0; initIdx < initializations.length; initIdx++) {
    const initPct = 10 + Math.round((initIdx / initializations.length) * 78);
    reportProgress(initPct, `Оптимизация схемы данных… ${initPct}%`);
    await yieldToBrowser();

    let testLayers = {};
    for (let i = 0; i <= maxLayer; i++) {
      testLayers[i] = layers[i] ? [...layers[i]] : [];
    }
    testLayers[0] = [...initializations[initIdx]];

    let testPositions = new Map();
    for (let i = 0; i <= maxLayer; i++) {
      testLayers[i].forEach((n, idx) => testPositions.set(n, idx));
    }

    // 15 проходов forward / backward
    for (let pass = 0; pass < SUGIYAMA_PASSES; pass++) {
      const useMedian = pass % 2 !== 0;

      // Forward pass с Barycentric Gravity (притяжение к якорному родителю)
      for (let i = 1; i <= maxLayer; i++) {
        if (!testLayers[i]) continue;
        testLayers[i].forEach((n) => {
          const neighbors = neighborsLeft[n] || [];
          if (neighbors.length > 0) {
            const nPos = neighbors.map((nb) => testPositions.get(nb)).sort((a, b) => a - b);
            let val;
            if (n.startsWith("vnode-")) {
              if (nPos.length > 0) {
                val = nPos[0];
                const rTargets = neighborsRight[n] || [];
                if (rTargets.length > 0 && testPositions.has(rTargets[0])) {
                  val += (testPositions.get(rTargets[0]) || 0) * 0.001;
                }
              }
            } else {
              const bary = nPos.reduce((a, b) => a + b, 0) / nPos.length;
              // Выбор якоря: согласован с Phase 2.1 и Rule 18 (четное -> 0, нечетное -> median)
              let anchorIdx = 0;
              if (nPos.length > 1 && nPos.length % 2 !== 0) {
                anchorIdx = Math.floor(nPos.length / 2);
              }
              const anchor = nPos[anchorIdx];
              val = useMedian ? anchor : (bary + anchor * SUGIYAMA_GRAVITY_WEIGHT) / (1 + SUGIYAMA_GRAVITY_WEIGHT);
            }
            testPositions.set(n, val);
          }
        });
        testLayers[i].sort((a, b) => {
          const diff = (testPositions.get(a) || 0) - (testPositions.get(b) || 0);
          if (Math.abs(diff) > 0.0001) return diff;
          // Look-ahead tie-breaker: compare targets' positions in subsequent layers
          const aR = neighborsRight[a] || [];
          const bR = neighborsRight[b] || [];
          if (aR.length > 0 && bR.length > 0) {
            const aTargetPos = Math.min(...aR.map((nb) => testPositions.get(nb) ?? 0));
            const bTargetPos = Math.min(...bR.map((nb) => testPositions.get(nb) ?? 0));
            if (Math.abs(aTargetPos - bTargetPos) > 0.0001) {
              return aTargetPos - bTargetPos;
            }
          }
          return a.localeCompare(b);
        });
        testLayers[i].forEach((n, idx) => testPositions.set(n, idx));
      }

      // Backward pass с Barycentric Gravity (притяжение к якорному потомку)
      for (let i = maxLayer - 1; i >= 0; i--) {
        if (!testLayers[i]) continue;
        testLayers[i].forEach((n) => {
          const neighbors = neighborsRight[n] || [];
          if (neighbors.length > 0) {
            const nPos = neighbors.map((nb) => testPositions.get(nb)).sort((a, b) => a - b);
            let val;
            if (n.startsWith("vnode-")) {
              if (nPos.length > 0) {
                val = nPos[0];
                const lSources = neighborsLeft[n] || [];
                if (lSources.length > 0 && testPositions.has(lSources[0])) {
                  val += (testPositions.get(lSources[0]) || 0) * 0.001;
                }
              }
            } else {
              // Взвешенный барицентр: обратная пропорция к in-degree потомка
              // (дерево прямых связей приоритетнее широких консолидирующих join-ов)
              let sumW = 0;
              let sumPosW = 0;
              neighbors.forEach((nb) => {
                const inDeg = (neighborsLeft[nb] || []).length || 1;
                const w = 1 / inDeg;
                sumW += w;
                sumPosW += (testPositions.get(nb) || 0) * w;
              });
              const bary = sumW > 0 ? sumPosW / sumW : nPos[0];

              // Якорный потомок: выделенный ребенок (in-degree === 1), иначе верхний nPos[0]
              const dedicated = neighbors.filter(
                (nb) => (neighborsLeft[nb] || []).length === 1
              );
              const anchor = dedicated.length > 0
                ? Math.min(...dedicated.map((nb) => testPositions.get(nb) || 0))
                : nPos[0];

              val = useMedian
                ? anchor
                : (bary + anchor * SUGIYAMA_GRAVITY_WEIGHT) / (1 + SUGIYAMA_GRAVITY_WEIGHT);
            }
            testPositions.set(n, val);
          }
        });
        testLayers[i].sort((a, b) => {
          const diff = (testPositions.get(a) || 0) - (testPositions.get(b) || 0);
          if (Math.abs(diff) > 0.0001) return diff;
          // Look-back tie-breaker: compare sources' positions in preceding layers
          const aL = neighborsLeft[a] || [];
          const bL = neighborsLeft[b] || [];
          if (aL.length > 0 && bL.length > 0) {
            const aSrcPos = Math.min(...aL.map((nb) => testPositions.get(nb) ?? 0));
            const bSrcPos = Math.min(...bL.map((nb) => testPositions.get(nb) ?? 0));
            if (Math.abs(aSrcPos - bSrcPos) > 0.0001) {
              return aSrcPos - bSrcPos;
            }
          }
          return a.localeCompare(b);
        });
        testLayers[i].forEach((n, idx) => testPositions.set(n, idx));
      }
    }

    // Sifting Pass (2 прохода)
    for (let pass = 0; pass < SIFTING_PASSES; pass++) {
      let changed = false;
      for (let i = 0; i <= maxLayer; i++) {
        if (!testLayers[i] || testLayers[i].length < 2) continue;
        let L = testLayers[i];

        for (let j = 0; j < L.length; j++) {
          const node = L[j];
          L.splice(j, 1);

          let bestPos = 0;
          let minC = Infinity;
          let minLength = Infinity;

          for (let p = 0; p <= L.length; p++) {
            L.splice(p, 0, node);
            L.forEach((n, idx) => testPositions.set(n, idx));

            const L_left = testLayers[i - 1];
            const L_right = testLayers[i + 1];
            const c =
              countCrossings(L_left, L, testPositions, i, layerPairEdges) +
              countCrossings(L, L_right, testPositions, i + 1, layerPairEdges);

            // Tie-breaker: Minimize edge length + anchor distance
            let totalDist = 0;
            const leftNeighbors = neighborsLeft[node] || [];
            leftNeighbors.forEach((nb) => {
              if (testPositions.has(nb)) {
                totalDist += Math.abs(testPositions.get(nb) - p);
              }
            });
            const rightNeighbors = neighborsRight[node] || [];
            rightNeighbors.forEach((nb) => {
              if (testPositions.has(nb)) {
                totalDist += Math.abs(testPositions.get(nb) - p);
              }
            });

            // Дополнительный штраф за отклонение от якорного родителя / якорного потомка
            if (leftNeighbors.length > 0) {
              const anchor = Math.min(...leftNeighbors.map((nb) => testPositions.get(nb) || 0));
              totalDist += Math.abs(p - anchor) * SUGIYAMA_GRAVITY_WEIGHT;
            } else if (rightNeighbors.length > 0) {
              const dedicated = rightNeighbors.filter(
                (nb) => (neighborsLeft[nb] || []).length === 1
              );
              const targetList = dedicated.length > 0 ? dedicated : rightNeighbors;
              const anchor = Math.min(...targetList.map((nb) => testPositions.get(nb) || 0));
              totalDist += Math.abs(p - anchor) * SUGIYAMA_GRAVITY_WEIGHT;
            }

            if (c < minC || (c === minC && totalDist < minLength)) {
              minC = c;
              minLength = totalDist;
              bestPos = p;
            }
            L.splice(p, 1);
          }

          L.splice(bestPos, 0, node);
          L.forEach((n, idx) => testPositions.set(n, idx));
          if (bestPos !== j) changed = true;
        }
      }
      if (!changed) break;
    }

    const totalC = countTotalCrossings(testLayers, testPositions, maxLayer, layerPairEdges);

    // Weighted Cost: (Crossings * 10000) + Total Edge Length + Top Parent/Child Alignment Penalty
    let totalEdgeLen = 0;
    edges.forEach((e) => {
      totalEdgeLen += Math.abs(
        (testPositions.get(e.source) || 0) - (testPositions.get(e.target) || 0)
      );
    });

    let topAlignPenalty = 0;
    for (let i = 1; i <= maxLayer; i++) {
      testLayers[i].forEach((n) => {
        if (n.startsWith("vnode-")) return;
        const parents = neighborsLeft[n];
        if (!parents || parents.length === 0) return;
        const minP = Math.min(...parents.map((p) => testPositions.get(p) || 0));
        topAlignPenalty += Math.abs((testPositions.get(n) || 0) - minP);
      });
    }
    if (testLayers[0]) {
      testLayers[0].forEach((n) => {
        if (n.startsWith("vnode-")) return;
        const children = neighborsRight[n];
        if (!children || children.length === 0) return;
        const dedicated = children.filter((ch) => (neighborsLeft[ch] || []).length === 1);
        const targetList = dedicated.length > 0 ? dedicated : children;
        const minC = Math.min(...targetList.map((ch) => testPositions.get(ch) || 0));
        topAlignPenalty += Math.abs((testPositions.get(n) || 0) - minC);
      });
    }

    const currentCost = totalC * 10000 + totalEdgeLen + topAlignPenalty * 2;

    if (currentCost < minCost) {
      minCost = currentCost;
      minTotalCrossings = totalC;
      bestPositions = new Map(testPositions);
      for (let i = 0; i <= maxLayer; i++) {
        bestLayers[i] = [...testLayers[i]];
      }
    }
    if (minTotalCrossings === 0) break;
  }

  return {
    layers: bestLayers,
    positions: bestPositions,
    neighborsLeft,
    neighborsRight,
  };
}
