import "./setup.js";
import fs from "fs";
import path from "path";
import vm from "vm";

import { computeLayersAndVirtualNodes, optimizeSugiyamaLayout } from "../src/lineage/tableLineageSugiyama.js";
import {
  calculateNodeDegrees,
  getNodePaddingV,
  getLocalRect,
  getPortY,
  applyPhase2Layout,
  alignStraightTopIncomingEdges,
} from "../src/lineage/tableLineageLayout.js";
import {
  buildFinalPorts,
  applyStraightTransitChains,
  getEdgeSY,
  getEdgeEY,
  renderEdges,
} from "../src/lineage/tableLineageEdges.js";
import { sanitizeId } from "../src/utils/helpers.js";

// Загрузка catalog.js с реальными метаданными
const catalogPath = path.resolve("dist/static/catalog.js");
if (!fs.existsSync(catalogPath)) {
  console.error(`Ошибка: Файл метаданных ${catalogPath} не найден. Сначала выполните сборку (python generate_catalog.py).`);
  process.exit(1);
}

const catalogJs = fs.readFileSync(catalogPath, "utf8");
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(catalogJs, sandbox);
global.window.catalogData = sandbox.window.catalogData;

function getTableInfoStr(nodePath) {
  const p = nodePath.split(".");
  if (p.length === 3) return global.window.catalogData[p[0]]?.[p[1]]?.[p[2]];
  return null;
}

export async function testTableLineage(selectedNodeId, verbose = false) {
  console.log(`\n======================================================`);
  console.log(`ТЕСТИРОВАНИЕ LINEAGE: ${selectedNodeId}`);
  console.log(`======================================================`);

  const unique_id = selectedNodeId.replace(/\./g, "-");
  const tableInfo = getTableInfoStr(selectedNodeId);
  if (!tableInfo || !tableInfo.lineage) {
    console.log(`Внимание: Нет данных lineage для узла ${selectedNodeId}!`);
    return { ok: false, microBends: [] };
  }

  const upstream = tableInfo.lineage.upstream || [];
  const downstream = tableInfo.lineage.downstream || [];

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

  const { nodesArray, edges: splitEdges, rank, maxLayer, layers, outEdgesMap, inEdgesMap } =
    computeLayersAndVirtualNodes(nodesSet, edges);

  const { layers: optLayers, neighborsLeft } = await optimizeSugiyamaLayout(
    layers,
    maxLayer,
    splitEdges
  );

  // Виртуальная модель DOM-контейнеров с точной геометрией flexbox
  const domElements = {};
  const domColumns = {};
  const { nodeInDegree, nodeOutDegree } = calculateNodeDegrees(
    nodesArray,
    splitEdges,
    inEdgesMap,
    outEdgesMap
  );

  for (let i = 0; i <= maxLayer; i++) {
    domColumns[i] = [];
    let curY = 0;
    (optLayers[i] || []).forEach((n) => {
      const isVirtual = n.startsWith("vnode-");
      let h = 40;
      if (!isVirtual) {
        const padV = getNodePaddingV(n, nodeInDegree, nodeOutDegree);
        h = padV * 2 + 16;
      } else {
        h = 32; // Высота виртуального узла 32px
      }
      const el = {
        nodeId: n,
        layer: i,
        baseTop: curY,
        get offsetTop() {
          return this.baseTop + (parseFloat(this.style.marginTop || 0) || 0);
        },
        offsetHeight: h,
        offsetWidth: isVirtual ? 0 : 160,
        offsetLeft: i * 280,
        offsetParent: null,
        style: { marginTop: "0px" },
        parentElement: null,
        dataset: {},
        classList: {
          contains: (cls) => cls === "ln-virtual" && isVirtual,
        },
      };
      el.id = `lnode-${sanitizeId(n)}-${unique_id}`;
      domElements[el.id] = el;
      domColumns[i].push(el);
      // margin 5+5=10px для vnode, плюс стандартный flex gap 35px между карточками
      curY += h + (isVirtual ? 10 : 0) + 35;
    });

    const parent = { children: domColumns[i] };
    domColumns[i].forEach((el) => (el.parentElement = parent));
  }

  global.document.getElementById = (id) => domElements[id] || null;
  const canvasMock = { offsetParent: null, offsetLeft: 0, offsetTop: 0 };

  // Этап 1: Phase 2 Layout (выравнивание по родителям + компакция)
  applyPhase2Layout(optLayers, maxLayer, unique_id, neighborsLeft, inEdgesMap, outEdgesMap);

  // Считывание прямоугольников после Phase 2
  let rects = {};
  nodesSet.forEach((n) => {
    const el = document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`);
    if (el) rects[n] = getLocalRect(el, canvasMock);
  });

  // Этап 2: Rule 18 (выравнивание верхних входящих рёбер)
  alignStraightTopIncomingEdges(optLayers, maxLayer, unique_id, inEdgesMap, outEdgesMap, canvasMock);

  // Повторное считывание rects после Rule 18
  nodesSet.forEach((n) => {
    const el = document.getElementById(`lnode-${sanitizeId(n)}-${unique_id}`);
    if (el) rects[n] = getLocalRect(el, canvasMock);
  });

  // Этап 3: Распределение портов
  let finalPorts = buildFinalPorts(nodesSet, outEdgesMap, inEdgesMap, rects);

  // Этап 4: Rule 15 (сквозной транзит длинных цепочек)
  applyStraightTransitChains(splitEdges, outEdgesMap, finalPorts, rects, rank, optLayers);

  const svgMock = { innerHTML: "", addEventListener: () => {} };
  renderEdges(canvasMock, svgMock, splitEdges, rank, rects, finalPorts);

  // Аудит геометрии всех рёбер
  let straightCount = 0;
  let microBends = [];
  let largeBends = [];

  splitEdges.forEach((e) => {
    const p = finalPorts.get(e);
    if (!p) return;
    const sR = rects[e.source];
    const tR = rects[e.target];
    if (!sR || !tR) return;

    const sY = getEdgeSY(e, sR, p.out, e.source.startsWith("vnode-"));
    const eY = getEdgeEY(e, tR, p.in, e.target.startsWith("vnode-"));
    const delta = Math.round((eY - sY) * 10) / 10;
    const absDelta = Math.abs(delta);

    if (absDelta < 2) {
      straightCount++;
    } else if (absDelta < 15) {
      microBends.push({ edge: `${e.source} -> ${e.target}`, sY, eY, delta });
    } else {
      largeBends.push({ edge: `${e.source} -> ${e.target}`, sY, eY, delta });
    }
  });

  console.log(`Всего рёбер: ${splitEdges.length}`);
  console.log(`Строго прямых связей (|Δ| < 2px): ${straightCount}`);
  console.log(`Микроизломов (2px <= |Δ| < 15px): ${microBends.length}`);
  if (microBends.length > 0) {
    microBends.forEach((b) =>
      console.log(`   [ВНИМАНИЕ: МИКРОИЗЛОМ] ${b.edge} | sY=${b.sY} eY=${b.eY} Δ=${b.delta}px`)
    );
  }
  console.log(`Больших изгибов на другие уровни (|Δ| >= 15px): ${largeBends.length}`);

  return {
    ok: microBends.length === 0,
    straightCount,
    microBends,
    largeBends,
  };
}

async function run() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const tablesToTest =
    args.length > 0
      ? args
      : [
          "dm.core.account_card_overview",
          "dm.core.account_balance_dynamics",
          "dm.core.unified_client_directory",
          "dds.calc.account_card_contract",
        ];

  let totalMicroBends = 0;
  for (const tableId of tablesToTest) {
    const res = await testTableLineage(tableId);
    totalMicroBends += (res.microBends || []).length;
  }

  console.log(`\n======================================================`);
  if (totalMicroBends === 0) {
    console.log(`✓ ВСЕ ТЕСТЫ ПРОЙДЕНЫ УСПЕШНО: 0 МИКРОИЗЛОМОВ`);
    console.log(`======================================================\n`);
    process.exit(0);
  } else {
    console.error(`✗ ОБНАРУЖЕНЫ ДЕФЕКТЫ ГЕОМЕТРИИ: ${totalMicroBends} МИКРОИЗЛОМОВ`);
    console.log(`======================================================\n`);
    process.exit(1);
  }
}

run();
