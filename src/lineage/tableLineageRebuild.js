/* 
MODULE: src/lineage/tableLineageRebuild.js
ROLE: Логика Smart Execution Helper: последовательный выбор downstream-таблиц для пересборки DWH, блокировка узлов без скрипта в sql_inventory и их потомков, построение очереди и выгрузка SQL.
*/

import { sanitizeId } from "../utils/helpers.js";

// Состояние пересборки для каждого unique_id канваса
const rebuildStates = new Map();

function getTableInfoStr(nodePath) {
  const p = nodePath.split(".");
  if (p.length === 3) return window.catalogData[p[0]]?.[p[1]]?.[p[2]];
  return null;
}

function getState(uniqueId) {
  if (!rebuildStates.has(uniqueId)) {
    rebuildStates.set(uniqueId, {
      activeSources: new Set(), // ODS таблицы с New Data
      checkedNodes: new Set(),  // Таблицы, выбранные к пересборке (в порядке добавления)
    });
  }
  return rebuildStates.get(uniqueId);
}

/**
 * Проверяет, есть ли у таблицы скрипт трансформации в sql_inventory
 */
export function hasSqlScript(nodeId) {
  const info = getTableInfoStr(nodeId);
  if (!info) return false;
  if (info._isVirtual) return false;
  return Boolean(info.sql_script && info.sql_script.trim().length > 0);
}

/**
 * Получает полный текст скрипта таблицы (основной + дополнительный)
 */
export function getFullSqlScript(nodeId) {
  const info = getTableInfoStr(nodeId);
  if (!info) return "";
  const s1 = (info.sql_script || "").trim();
  const s2 = (info.sql_script_extra || "").trim();
  if (s1 && s2) return `${s1}\n\n${s2}`;
  return s1 || s2 || "";
}

/**
 * Строит граф смежности из реальных метаданных каталога для видимых узлов канваса
 */
function getGraphAdjacency(canvas) {
  const parentsMap = new Map();  // target -> [sources]
  const childrenMap = new Map(); // source -> [targets]
  const visibleNodes = new Set();

  canvas.querySelectorAll(".ln-node:not(.ln-virtual)").forEach((el) => {
    const id = el.dataset.nodeId;
    if (id) {
      visibleNodes.add(id);
      parentsMap.set(id, []);
      childrenMap.set(id, []);
    }
  });

  visibleNodes.forEach((id) => {
    const info = getTableInfoStr(id);
    const upstreams = (info?.lineage?.upstream || []).filter((u) => visibleNodes.has(u));
    const downstreams = (info?.lineage?.downstream || []).filter((d) => visibleNodes.has(d));

    parentsMap.set(id, upstreams);
    childrenMap.set(id, downstreams);
  });

  return { parentsMap, childrenMap };
}

/**
 * Находит всех потомков активных ODS-источников
 */
function computeImpactedSubgraph(canvas, activeSources) {
  const { parentsMap, childrenMap } = getGraphAdjacency(canvas);
  const impacted = new Set();
  const queue = Array.from(activeSources);
  const visited = new Set(activeSources);

  while (queue.length > 0) {
    const cur = queue.shift();
    const children = childrenMap.get(cur) || [];
    children.forEach((child) => {
      impacted.add(child);
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    });
  }

  // Для каждого узла в подграфе определяем его релевантных родителей (только из активной ветки)
  const activeBranchParents = new Map();
  impacted.forEach((nodeId) => {
    const allP = parentsMap.get(nodeId) || [];
    // Родитель должен быть либо активным источником, либо сам входить в impacted
    const branchP = allP.filter((p) => activeSources.has(p) || impacted.has(p));
    activeBranchParents.set(nodeId, branchP);
  });

  return { impacted, parentsMap: activeBranchParents, childrenMap };
}

/**
 * Проверяет, можно ли выбрать узел согласно строгому downstream-правилу слева направо:
 * 1. Узел должен иметь скрипт в sql_inventory (если нет -> заблокирован).
 * 2. Все его родители в активной ветке должны быть УЖЕ готовы:
 *    - либо быть источником New Data (activeSources),
 *    - либо быть УЖЕ отмечены галочкой (checkedNodes).
 * Если хотя бы один родитель в ветке не отмечен или заблокирован (нет скрипта), потомок выбрать нельзя!
 */
export function canCheckNode(nodeId, state, impactedData) {
  if (!impactedData.impacted.has(nodeId)) return false;
  if (!hasSqlScript(nodeId)) return false; // Сам узел без скрипта -> нельзя

  const parents = impactedData.parentsMap.get(nodeId) || [];
  if (parents.length === 0) return true;

  // Все родители из активной ветки пересборки должны быть удовлетворены
  return parents.every((p) => {
    if (state.activeSources.has(p)) return true;
    if (impactedData.impacted.has(p)) {
      // Родитель обязан быть выбранным (checkedNodes)
      return state.checkedNodes.has(p);
    }
    return false;
  });
}

/**
 * Каскадный сброс галочек downstream:
 * Если узел снимается с выбора, все зависимые потомки, для которых он был условием,
 * также автоматически снимаются.
 */
function cascadeUncheck(nodeId, state, impactedData) {
  const toRemove = new Set([nodeId]);
  let changed = true;

  while (changed) {
    changed = false;
    state.checkedNodes.forEach((n) => {
      if (toRemove.has(n)) return;
      const parents = impactedData.parentsMap.get(n) || [];
      const hasUnsatisfiedParent = parents.some((p) => {
        if (state.activeSources.has(p)) return false;
        return toRemove.has(p) || !state.checkedNodes.has(p);
      });
      if (hasUnsatisfiedParent) {
        toRemove.add(n);
        changed = true;
      }
    });
  }

  toRemove.forEach((n) => state.checkedNodes.delete(n));
}

/**
 * Переключает статус источника пересборки ("New Data" для ODS или "Rebuild" для остальных слоёв)
 */
export function toggleNewDataSource(nodeId, uniqueId) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return;

  const state = getState(uniqueId);
  const isOds = nodeId.toLowerCase().startsWith("ods.");

  if (state.activeSources.has(nodeId)) {
    state.activeSources.delete(nodeId);
    state.checkedNodes.delete(nodeId);
  } else {
    state.activeSources.add(nodeId);
    // Для не-ODS таблиц сама таблица сразу становится первым шагом пересборки в очереди SQL
    if (!isOds && hasSqlScript(nodeId)) {
      state.checkedNodes.add(nodeId);
    }
  }

  // При изменении источников пересчитываем валидность выбранных потомков
  const impactedData = computeImpactedSubgraph(canvas, state.activeSources);
  const invalid = [];
  state.checkedNodes.forEach((n) => {
    // Сам активный источник не валидируется как потомок
    if (!state.activeSources.has(n)) {
      if (!impactedData.impacted.has(n) || !canCheckNode(n, state, impactedData)) {
        invalid.push(n);
      }
    }
  });
  invalid.forEach((n) => cascadeUncheck(n, state, impactedData));

  updateRebuildDOM(canvas, uniqueId);
}

/**
 * Переключает выбор чекбокса на потомке (с проверкой downstream-правила)
 */
export function toggleCheckDescendant(nodeId, uniqueId) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return;

  const state = getState(uniqueId);
  const impactedData = computeImpactedSubgraph(canvas, state.activeSources);

  if (state.checkedNodes.has(nodeId)) {
    // Снимаем галочку и каскадно сбрасываем зависимых потомков
    cascadeUncheck(nodeId, state, impactedData);
  } else {
    // Проверяем, разрешено ли поставить галочку
    if (!canCheckNode(nodeId, state, impactedData)) {
      return; // Заблокировано правилом downstream или отсутствием скрипта
    }
    state.checkedNodes.add(nodeId);
  }

  updateRebuildDOM(canvas, uniqueId);
}

/**
 * Автоматически выбирает все доступные валидные узлы цепочки по топологии DAG
 */
export function selectAllEligibleDescendants(uniqueId) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return;

  const state = getState(uniqueId);
  const impactedData = computeImpactedSubgraph(canvas, state.activeSources);

  let addedAny = true;
  while (addedAny) {
    addedAny = false;
    impactedData.impacted.forEach((nodeId) => {
      if (!state.checkedNodes.has(nodeId) && canCheckNode(nodeId, state, impactedData)) {
        state.checkedNodes.add(nodeId);
        addedAny = true;
      }
    });
  }

  updateRebuildDOM(canvas, uniqueId);
}

/**
 * Полный сброс режима пересборки
 */
export function resetRebuildFlow(uniqueId) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return;

  const state = getState(uniqueId);
  state.activeSources.clear();
  state.checkedNodes.clear();

  updateRebuildDOM(canvas, uniqueId);
}

/**
 * Топологическая сортировка выбранных к пересборке таблиц для порядка запуска
 */
export function getTopologicalRebuildQueue(uniqueId) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return [];

  const state = getState(uniqueId);
  if (state.checkedNodes.size === 0) return [];

  const { childrenMap } = getGraphAdjacency(canvas);
  const selected = Array.from(state.checkedNodes);

  // Подсчитываем in-degree только среди выбранных узлов
  const inDegree = new Map();
  selected.forEach((n) => inDegree.set(n, 0));

  selected.forEach((u) => {
    (childrenMap.get(u) || []).forEach((v) => {
      if (inDegree.has(v)) {
        inDegree.set(v, inDegree.get(v) + 1);
      }
    });
  });

  const queue = selected.filter((n) => inDegree.get(n) === 0);
  const sorted = [];

  while (queue.length > 0) {
    const u = queue.shift();
    sorted.push(u);
    (childrenMap.get(u) || []).forEach((v) => {
      if (inDegree.has(v)) {
        inDegree.set(v, inDegree.get(v) - 1);
        if (inDegree.get(v) === 0) {
          queue.push(v);
        }
      }
    });
  }

  // Если вдруг цикл или остатки, добавляем остаток
  selected.forEach((n) => {
    if (!sorted.includes(n)) sorted.push(n);
  });

  return sorted;
}

/**
 * Обновляет визуальное состояние DOM (классы узлов, чекбоксы, док, линии)
 */
export function updateRebuildDOM(canvas, uniqueId) {
  const pane = canvas.closest(".pane-lineage");
  if (!pane) return;

  const state = getState(uniqueId);
  const isActive = state.activeSources.size > 0;

  pane.classList.toggle("rebuild-flow-active", isActive);

  if (!isActive) {
    // Очищаем все стили и бейджи
    canvas.querySelectorAll(".ln-node").forEach((el) => {
      el.classList.remove(
        "ln-node-dimmed",
        "ln-rebuild-source",
        "ln-rebuild-impacted",
        "ln-rebuild-checked",
        "ln-rebuild-eligible",
        "ln-rebuild-waiting",
        "ln-rebuild-blocked",
        "ln-rebuild-no-script",
        "ln-nd-revealed"
      );
      const btn = el.querySelector(".ln-new-data-btn");
      if (btn) {
        btn.classList.remove("is-active");
        const isOdsNode = el.dataset.nodeId?.toLowerCase().startsWith("ods.");
        btn.innerHTML = isOdsNode
          ? `<span class="ln-nd-text">+ New Data</span>`
          : `<span class="ln-nd-text">+ Rebuild</span>`;
      }
      const cbWrap = el.querySelector(".ln-rebuild-cb-wrap");
      if (cbWrap) cbWrap.remove();
      const noScriptBadge = el.querySelector(".ln-no-script-badge");
      if (noScriptBadge) noScriptBadge.remove();
    });

    const svgEl = canvas.querySelector(".lineage-svg");
    if (svgEl) {
      svgEl.querySelectorAll("path.ln-edge-line").forEach((p) => {
        p.classList.remove("ln-edge-rebuild-active", "ln-edge-rebuild-tree", "ln-edge-dimmed");
      });
    }

    const dock = pane.querySelector(".ln-rebuild-dock");
    if (dock) dock.remove();
    return;
  }

  // Режим пересборки АКТИВЕН
  const impactedData = computeImpactedSubgraph(canvas, state.activeSources);
  const sortedQueue = getTopologicalRebuildQueue(uniqueId);
  const orderMap = new Map();
  sortedQueue.forEach((id, idx) => orderMap.set(id, idx + 1));

  let blockedCount = 0;

  // 1. Обновляем узлы
  canvas.querySelectorAll(".ln-node:not(.ln-virtual)").forEach((el) => {
    const id = el.dataset.nodeId;
    if (!id) return;

    const isSource = state.activeSources.has(id);
    const isImpacted = impactedData.impacted.has(id);
    const hasScript = hasSqlScript(id);

    // Подсветка кнопок New Data на ODS и Rebuild на остальных слоях
    const ndBtn = el.querySelector(".ln-new-data-btn");
    if (ndBtn) {
      const isOdsNode = id.toLowerCase().startsWith("ods.");
      ndBtn.classList.toggle("is-active", isSource);
      if (isOdsNode) {
        ndBtn.innerHTML = isSource
          ? `<span class="ln-nd-text">New Data</span><span class="ln-nd-close" title="Снять New Data">✕</span>`
          : `<span class="ln-nd-text">+ New Data</span>`;
      } else {
        const stepNum = orderMap.get(id);
        const stepPrefix = stepNum ? `Шаг ${stepNum}: ` : "";
        ndBtn.innerHTML = isSource
          ? `<span class="ln-nd-text">${stepPrefix}Rebuild</span><span class="ln-nd-close" title="Снять Rebuild">✕</span>`
          : `<span class="ln-nd-text">+ Rebuild</span>`;
      }
    }

    if (!isSource && !isImpacted) {
      // Несвязанный узел -> приглушаем
      el.classList.add("ln-node-dimmed");
      el.classList.remove(
        "ln-rebuild-source",
        "ln-rebuild-impacted",
        "ln-rebuild-checked",
        "ln-rebuild-eligible",
        "ln-rebuild-waiting",
        "ln-rebuild-blocked",
        "ln-rebuild-no-script",
        "ln-nd-revealed"
      );
      const cb = el.querySelector(".ln-rebuild-cb-wrap");
      if (cb) cb.remove();
      const badge = el.querySelector(".ln-no-script-badge");
      if (badge) badge.remove();
      return;
    }

    el.classList.remove("ln-node-dimmed");

    if (isSource) {
      el.classList.add("ln-rebuild-source");
      el.classList.remove(
        "ln-rebuild-impacted",
        "ln-rebuild-checked",
        "ln-rebuild-eligible",
        "ln-rebuild-waiting",
        "ln-rebuild-blocked",
        "ln-rebuild-no-script",
        "ln-nd-revealed"
      );
      const cb = el.querySelector(".ln-rebuild-cb-wrap");
      if (cb) cb.remove();
      const badge = el.querySelector(".ln-no-script-badge");
      if (badge) badge.remove();
      return;
    }

    // Это потомок
    el.classList.add("ln-rebuild-impacted");

    if (!hasScript) {
      // Блокирован из-за отсутствия скрипта в sql_inventory
      blockedCount++;
      el.classList.add("ln-rebuild-blocked", "ln-rebuild-no-script");
      el.classList.remove("ln-rebuild-checked", "ln-rebuild-eligible", "ln-rebuild-waiting");

      // Добавляем предупреждающий бейдж в стиле pill, если его ещё нет
      let badge = el.querySelector(".ln-no-script-badge");
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "ln-no-script-badge";
        badge.innerHTML = `<span class="ln-nd-text">⚠️ Нет данных</span>`;
        badge.title = "Пересборка невозможна: скрипт отсутствует в public.sql_inventory";
        el.appendChild(badge);
      }

      // Убираем чекбокс (не добавляем элементы внутрь карточки, сохраняя её неизменные размеры)
      const cbWrap = el.querySelector(".ln-rebuild-cb-wrap");
      if (cbWrap) cbWrap.remove();
      return;
    }

    // Узел имеет скрипт
    const badge = el.querySelector(".ln-no-script-badge");
    if (badge) badge.remove();

    const isChecked = state.checkedNodes.has(id);
    const isEligible = canCheckNode(id, state, impactedData);

    el.classList.remove("ln-rebuild-blocked", "ln-rebuild-no-script");
    el.classList.toggle("ln-rebuild-checked", isChecked);
    el.classList.toggle("ln-rebuild-eligible", !isChecked && isEligible);
    el.classList.toggle("ln-rebuild-waiting", !isChecked && !isEligible);

    let cbWrap = el.querySelector(".ln-rebuild-cb-wrap");
    if (!cbWrap) {
      cbWrap = document.createElement("button");
      cbWrap.type = "button";
      el.appendChild(cbWrap);
    }

    if (isChecked) {
      const stepNum = orderMap.get(id) || "";
      cbWrap.className = "ln-rebuild-cb-wrap is-checked";
      cbWrap.title = `Шаг пересборки #${stepNum}. Нажмите для отмены`;
      cbWrap.innerHTML = `
        <span class="ln-rebuild-text">Шаг ${stepNum}</span>
        <span class="ln-rebuild-close" title="Отменить выбор">✕</span>
      `;
    } else if (isEligible) {
      cbWrap.className = "ln-rebuild-cb-wrap is-eligible";
      cbWrap.title = "Нажмите, чтобы включить в очередь пересборки";
      cbWrap.innerHTML = `
        <span class="ln-rebuild-mini-cb"></span>
        <span class="ln-rebuild-text">+ Выбрать</span>
      `;
    } else {
      cbWrap.className = "ln-rebuild-cb-wrap is-disabled";
      cbWrap.title = "Сначала выберите родительскую таблицу слева";
      cbWrap.innerHTML = `
        <span class="ln-rebuild-mini-cb disabled"></span>
        <span class="ln-rebuild-text">Ждёт</span>
      `;
    }

    cbWrap.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleCheckDescendant(id, uniqueId);
    };
  });

  // 2. Обновляем рёбра графа
  const svgEl = canvas.querySelector(".lineage-svg");
  if (svgEl) {
    const allChildrenMap = new Map();
    const allParentsMap = new Map();
    svgEl.querySelectorAll("path.ln-edge-line").forEach((p) => {
      const s = p.dataset.source;
      const t = p.dataset.target;
      if (!s || !t) return;
      if (!allChildrenMap.has(s)) allChildrenMap.set(s, []);
      allChildrenMap.get(s).push(t);
      if (!allParentsMap.has(t)) allParentsMap.set(t, []);
      allParentsMap.get(t).push(s);
    });

    // BFS вниз от всех активных ODS источников для поиска всех рёбер дерева потомков
    const downstreamGraphNodes = new Set(state.activeSources);
    const q = Array.from(state.activeSources);
    while (q.length > 0) {
      const cur = q.shift();
      (allChildrenMap.get(cur) || []).forEach((child) => {
        if (!downstreamGraphNodes.has(child)) {
          downstreamGraphNodes.add(child);
          q.push(child);
        }
      });
    }

    const getRealEndpoint = (node, dir) => {
      let cur = node;
      let safety = 0;
      while (cur && cur.startsWith("vnode-") && safety++ < 50) {
        if (dir === "up") {
          const parents = allParentsMap.get(cur);
          cur = parents ? parents[0] : null;
        } else {
          const children = allChildrenMap.get(cur);
          cur = children ? children[0] : null;
        }
      }
      return cur;
    };

    svgEl.querySelectorAll("path.ln-edge-line").forEach((p) => {
      const s = p.dataset.source;
      const t = p.dataset.target;
      if (!s || !t) return;

      // Принадлежит ли ребро поддереву потомков активных источников?
      const isDownstreamEdge = downstreamGraphNodes.has(s) && downstreamGraphNodes.has(t);

      // Активно ли ребро в текущей выбранной очереди пересборки?
      const realSrc = s.startsWith("vnode-") ? getRealEndpoint(s, "up") : s;
      const realTgt = t.startsWith("vnode-") ? getRealEndpoint(t, "down") : t;
      const isRebuildActive =
        (state.activeSources.has(realSrc) || state.checkedNodes.has(realSrc)) &&
        state.checkedNodes.has(realTgt);

      p.classList.toggle("ln-edge-rebuild-active", isRebuildActive);
      p.classList.toggle("ln-edge-rebuild-tree", isDownstreamEdge && !isRebuildActive);
      p.classList.toggle("ln-edge-dimmed", !isDownstreamEdge);
    });
  }

  // 3. Обновляем плавающую нижнюю консоль (Bottom Rebuild Dock)
  renderRebuildDock(pane, uniqueId, state.activeSources.size, state.checkedNodes.size, blockedCount);
}

/**
 * Создаёт или обновляет плавающий нижний док (Floating Rebuild Dock)
 */
function renderRebuildDock(pane, uniqueId, sourcesCount, checkedCount, blockedCount) {
  let dock = pane.querySelector(".ln-rebuild-dock");
  if (!dock) {
    dock = document.createElement("div");
    dock.className = "ln-rebuild-dock";
    pane.appendChild(dock);
  }

  const blockedHtml = blockedCount > 0
    ? `<div class="ln-dock-stat ln-dock-stat--blocked" title="Узлы без скрипта в sql_inventory (пересборка заблокирована)">⚠️ Без скрипта: <b>${blockedCount}</b></div>`
    : "";

  dock.innerHTML = `
    <div class="ln-dock-stats">
      <div class="ln-dock-stat ln-dock-stat--sources">Источников: <b>${sourcesCount}</b></div>
      <div class="ln-dock-divider"></div>
      <div class="ln-dock-stat ln-dock-stat--checked">Выбрано к пересборке: <b>${checkedCount}</b></div>
      ${blockedHtml}
    </div>
    <div class="ln-dock-actions">
      <button class="ln-dock-btn ln-dock-btn--select-all" id="btn-select-all-${uniqueId}" title="Последовательно выбрать все доступные валидные таблицы по цепочке">Выбрать всех потомков</button>
      <button class="ln-dock-btn ln-dock-btn--reset" id="btn-reset-${uniqueId}" title="Сбросить выбор пересборки">Сбросить</button>
      <button class="ln-dock-btn ln-dock-btn--primary" id="btn-export-sql-${uniqueId}" ${checkedCount === 0 ? "disabled" : ""}>
        Сформировать SQL пересчёта (${checkedCount})
      </button>
    </div>
  `;

  dock.querySelector(`#btn-select-all-${uniqueId}`).onclick = (e) => {
    e.stopPropagation();
    selectAllEligibleDescendants(uniqueId);
  };

  dock.querySelector(`#btn-reset-${uniqueId}`).onclick = (e) => {
    e.stopPropagation();
    resetRebuildFlow(uniqueId);
  };

  const exportBtn = dock.querySelector(`#btn-export-sql-${uniqueId}`);
  if (exportBtn) {
    exportBtn.onclick = (e) => {
      e.stopPropagation();
      openRebuildSqlModal(uniqueId);
    };
  }
}

/**
 * Удаляет префикс базы данных из SQL (dds.core.tbl -> core.tbl, dds.ext_ods.tbl -> ext_ods.tbl),
 * не затрагивая строковые литералы в одинарных кавычках.
 */
export function stripDbPrefix(sql, dbName) {
  if (!sql || !dbName) return sql;
  const regex = new RegExp(`('(?:[^']|'')*')|\\b${dbName}\\.([a-zA-Z0-9_]+)`, "gi");
  return sql.replace(regex, (match, stringLiteral, afterDot) => {
    if (stringLiteral) return stringLiteral;
    return afterDot;
  });
}

/**
 * Определяет, какие узлы из очереди выполнения можно безопасно удалить,
 * не ломая последовательную цепочку зависимостей (т.е. ни один другой узел в очереди не зависит от них).
 */
export function getRemovableNodesInQueue(canvas, queue) {
  if (!canvas || !queue || queue.length === 0) return new Set();
  const { childrenMap } = getGraphAdjacency(canvas);
  const queueSet = new Set(queue);
  const removable = new Set();

  queue.forEach((nodeId) => {
    // Проверяем, достижим ли хоть один другой узел из queueSet downstream от nodeId
    let hasDependentInQueue = false;
    const visited = new Set([nodeId]);
    const toVisit = [...(childrenMap.get(nodeId) || [])];

    while (toVisit.length > 0) {
      const cur = toVisit.pop();
      if (visited.has(cur)) continue;
      visited.add(cur);

      if (queueSet.has(cur)) {
        hasDependentInQueue = true;
        break;
      }

      const nextChildren = childrenMap.get(cur) || [];
      for (let i = 0; i < nextChildren.length; i++) {
        if (!visited.has(nextChildren[i])) {
          toVisit.push(nextChildren[i]);
        }
      }
    }

    if (!hasDependentInQueue) {
      removable.add(nodeId);
    }
  });

  return removable;
}

/**
 * Открывает модальное окно с упорядоченным списком SQL-скриптов и кнопками копирования/скачивания
 */
export function openRebuildSqlModal(uniqueId) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return;

  const state = getState(uniqueId);

  let currentTabKey = "";
  let scriptsMap = new Map();
  let stepsMeta = [];
  let currentQueue = [];

  const computeRebuildData = () => {
    currentQueue = getTopologicalRebuildQueue(uniqueId);
    if (currentQueue.length === 0) {
      return null;
    }

    const removableNodes = getRemovableNodesInQueue(canvas, currentQueue);

    // Группируем последовательность шагов по базам данных (сохраняя топологический порядок DAG)
    const dbGroups = [];
    currentQueue.forEach((tblId) => {
      const parts = tblId.split(".");
      const db = parts[0];
      const schema = parts[1];
      const table = parts.slice(2).join(".");
      const lastGroup = dbGroups[dbGroups.length - 1];
      if (lastGroup && lastGroup.db === db) {
        lastGroup.tables.push({ tblId, db, schema, table });
      } else {
        dbGroups.push({ db, tables: [{ tblId, db, schema, table }] });
      }
    });

    const dbSections = new Map(); // dbName -> { tablesSql: "", tableCount: 0 }
    const getDbSection = (db) => {
      if (!dbSections.has(db)) {
        dbSections.set(db, { tablesSql: "", tableCount: 0 });
      }
      return dbSections.get(db);
    };

    stepsMeta = [];
    let stepCounter = 0;

    dbGroups.forEach((group) => {
      const sec = getDbSection(group.db);

      group.tables.forEach((t) => {
        stepCounter++;
        const stepNum = stepCounter;
        const isRemovable = removableNodes.has(t.tblId);
        stepsMeta.push({ stepNum, tblId: t.tblId, isRemovable });
        sec.tableCount++;

        const rawScript = getFullSqlScript(t.tblId).trim();
        const cleanScript = stripDbPrefix(rawScript, t.db);
        const script = cleanScript.endsWith(";") ? cleanScript : `${cleanScript};`;

        const info = getTableInfoStr(t.tblId);
        const isView = info?.type === "v" || /^\s*create\s+(?:or\s+replace\s+)?view/i.test(script);
        const isMatView = info?.type === "m" || /^\s*create\s+materialized\s+view/i.test(script);
        const localTableId = `${t.schema}.${t.table}`;
        const dropStmt = isView
          ? `DROP VIEW IF EXISTS ${localTableId};`
          : isMatView
          ? `DROP MATERIALIZED VIEW IF EXISTS ${localTableId};`
          : `DROP TABLE IF EXISTS ${localTableId};`;

        sec.tablesSql += `-- ------------------------------------------------------------------------\n`;
        sec.tablesSql += `-- ШАГ ${stepNum} из ${currentQueue.length}: ${t.tblId}\n`;
        sec.tablesSql += `-- ------------------------------------------------------------------------\n`;
        sec.tablesSql += `${dropStmt}\n\n`;
        sec.tablesSql += `${script}\n\n`;
        sec.tablesSql += `DO $$ BEGIN \n`;
        sec.tablesSql += `    RAISE NOTICE '>>> Таблица ${t.tblId} успешно создана: %', clock_timestamp(); \n`;
        sec.tablesSql += `END $$;\n\n`;
      });
    });

    scriptsMap = new Map();
    dbSections.forEach((sec, db) => {
      scriptsMap.set(db, {
        label: `БД ${db} (${sec.tableCount} табл.)`,
        subtitle: `Скрипт для базы данных ${db}`,
        sql: sec.tablesSql || "",
        db: db,
      });
    });

    if (!scriptsMap.has(currentTabKey)) {
      currentTabKey = Array.from(scriptsMap.keys())[0] || "";
    }

    return { queue: currentQueue, stepsMeta, scriptsMap, removableNodes };
  };

  const initialData = computeRebuildData();
  if (!initialData) return;

  // Рендерим модальное окно
  const modalOverlay = document.createElement("div");
  modalOverlay.className = "rebuild-modal-overlay";

  modalOverlay.innerHTML = `
    <div class="rebuild-modal-card">
      <div class="rebuild-modal-header">
        <div class="rebuild-modal-title-group">
          <h3 class="rebuild-modal-title"><span class="rebuild-modal-brand">GravityFlow</span></h3>
        </div>
        <button class="rebuild-modal-close-btn" title="Закрыть">✕</button>
      </div>

      <div class="rebuild-modal-body">
        <div class="rebuild-steps-bar">
          <div class="rebuild-steps-label">Очередь выполнения:</div>
          <div class="rebuild-steps-list"></div>
        </div>

        <div class="rebuild-db-tabs-bar">
          <span class="rebuild-db-tabs-label">Вкладка:</span>
          <div class="rebuild-db-tabs"></div>
          <span class="rebuild-db-tabs-spacer"></span>
          <button class="rebuild-btn rebuild-btn--primary" id="btn-modal-copy-sql">📋 Копировать SQL</button>
        </div>

        <div class="rebuild-code-container">
          <div class="rebuild-code-header">
            <span id="rebuild-code-title">Скрипт пересборки DWH</span>
            <span class="rebuild-code-lines" id="rebuild-code-lines-count"></span>
          </div>
          <pre class="rebuild-code-pre"><code id="rebuild-code-text"></code></pre>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modalOverlay);

  const stepsContainer = modalOverlay.querySelector(".rebuild-steps-list");
  const tabsContainer = modalOverlay.querySelector(".rebuild-db-tabs");
  const codeEl = modalOverlay.querySelector("#rebuild-code-text");
  const codeTitleEl = modalOverlay.querySelector("#rebuild-code-title");
  const codeLinesEl = modalOverlay.querySelector("#rebuild-code-lines-count");
  const copyBtn = modalOverlay.querySelector("#btn-modal-copy-sql");

  const closeModal = () => modalOverlay.remove();
  modalOverlay.querySelector(".rebuild-modal-close-btn").onclick = closeModal;
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });

  const renderStepsList = () => {
    stepsContainer.innerHTML = stepsMeta
      .map(
        (s) => `
        <div class="rebuild-step-item ${s.isRemovable ? "is-removable" : ""}" ${
          !s.isRemovable
            ? 'title="Нельзя удалить: от этой таблицы зависят следующие шаги в очереди"'
            : ""
        }>
          <span class="rebuild-step-number">${s.stepNum}</span>
          <span class="rebuild-step-name">${s.tblId}</span>
          ${
            s.isRemovable
              ? `<button class="rebuild-step-remove-btn" data-tbl-id="${s.tblId}" title="Удалить из очереди">✕</button>`
              : ""
          }
        </div>`
      )
      .join("");

    stepsContainer.querySelectorAll(".rebuild-step-remove-btn").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const tblId = btn.dataset.tblId;
        if (!tblId) return;

        // Удаляем узел из очереди пересборки
        state.checkedNodes.delete(tblId);
        if (state.activeSources.has(tblId)) {
          state.activeSources.delete(tblId);
        }

        // Обновляем граф и плавающий док на канвасе
        updateRebuildDOM(canvas, uniqueId);

        // Пересчитываем данные модального окна
        const data = computeRebuildData();
        if (!data || data.queue.length === 0) {
          closeModal();
          return;
        }

        renderStepsList();
        renderTabs();
        updateActiveTab(currentTabKey);
      };
    });
  };

  const renderTabs = () => {
    tabsContainer.innerHTML = Array.from(scriptsMap.entries())
      .map(
        ([key, val]) => `
        <button class="rebuild-db-tab-btn ${key === currentTabKey ? "active" : ""}" data-tab="${key}">
          ${val.label}
        </button>`
      )
      .join("");

    tabsContainer.querySelectorAll(".rebuild-db-tab-btn").forEach((btn) => {
      btn.onclick = () => {
        updateActiveTab(btn.dataset.tab);
      };
    });
  };

  const updateActiveTab = (key) => {
    currentTabKey = key;
    const item = scriptsMap.get(key) || scriptsMap.get(Array.from(scriptsMap.keys())[0]);
    if (!item) return;
    codeEl.textContent = item.sql;
    codeTitleEl.textContent = item.subtitle;
    codeLinesEl.textContent = `${item.sql.split("\n").length} строк`;

    tabsContainer.querySelectorAll(".rebuild-db-tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === key);
    });

    copyBtn.textContent = `📋 Копировать SQL (${item.label})`;
  };

  // Первичная инициализация
  renderStepsList();
  renderTabs();
  updateActiveTab(currentTabKey);

  // Копирование
  copyBtn.onclick = async () => {
    const item = scriptsMap.get(currentTabKey) || scriptsMap.get(Array.from(scriptsMap.keys())[0]);
    if (!item) return;
    const currentSql = item.sql;
    const originalText = copyBtn.textContent;
    try {
      await navigator.clipboard.writeText(currentSql);
      copyBtn.textContent = "✓ Скопировано!";
      setTimeout(() => (copyBtn.textContent = originalText), 2000);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = currentSql;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copyBtn.textContent = "✓ Скопировано!";
      setTimeout(() => (copyBtn.textContent = originalText), 2000);
    }
  };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
