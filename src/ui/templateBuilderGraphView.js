/* 
MODULE: src/ui/templateBuilderGraphView.js
ROLE: Вариант 2 (Variant 2) — Интерактивный граф соединений (Graph View) по эскизу пользователя.
      Отображает корневую таблицу (FROM) сверху и ветвящиеся дочерние таблицы с соединительными SVG-линиями,
      портами связей и возможностью быстрого переключения родительской таблицы в узле.
DESIGN: Полностью изолированный модуль. Может быть удалён в 1 шаг без влияния на остальной код.
*/

import { getTableKey } from "../utils/sqlJoinInference.js";

/**
 * Экранирует HTML-спецсимволы.
 */
function escapeHtml(str) {
  if (typeof str !== "string") return str == null ? "" : String(str);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Находит все ключи узлов, являющихся потомками (дети, внуки и т.д.) для заданного узла,
 * чтобы исключить их из списка выбора родителя (защита от циклов).
 * @param {string} nodeKey 
 * @param {Map<string, object>} nodesByKey 
 * @returns {Set<string>}
 */
function getDescendantKeys(nodeKey, nodesByKey) {
  const descendants = new Set();
  const queue = [nodeKey];
  while (queue.length > 0) {
    const curKey = queue.shift();
    const cur = nodesByKey.get(curKey);
    if (cur && Array.isArray(cur.children)) {
      for (const child of cur.children) {
        if (!descendants.has(child.key)) {
          descendants.add(child.key);
          queue.push(child.key);
        }
      }
    }
  }
  return descendants;
}

/**
 * Рекурсивно генерирует HTML для поддерева узлов графа.
 */
function renderGraphNodeBranch(node, context) {
  const { nodesByKey, baseKey } = context;
  const key = node.key;
  const isBase = node.isBase || key === baseKey;
  const t = node.table;
  const layer = (t.db || "dds").toLowerCase();
  const planItem = node.joinInfo;
  const sources = planItem?.availableSources || [];
  const missingTables = planItem?.missingTables || [];
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;

  // Допустимые родители
  const invalidParents = getDescendantKeys(key, nodesByKey);
  invalidParents.add(key);

  const eligibleParents = [];
  for (const [candKey, candNode] of nodesByKey.entries()) {
    if (!invalidParents.has(candKey)) {
      eligibleParents.push(candNode);
    }
  }

  const currentParentKey = node.parentKey || (planItem?.joinedWith ? getTableKey(planItem.joinedWith) : "");

  let html = `
    <div class="tb-graph-branch ${isBase ? 'tb-graph-branch--root' : ''}" data-branch-key="${escapeHtml(key)}">
      <div class="tb-graph-node-wrapper">
        <div class="tb-graph-card ${isBase ? 'tb-graph-card--base' : ''}" 
             id="tb-gnode-${escapeHtml(key.replace(/[^a-zA-Z0-9_]/g, '_'))}"
             data-key="${escapeHtml(key)}">
          
          ${!isBase ? `<div class="tb-graph-port tb-graph-port--top" title="Входное соединение (от родителя)"></div>` : ''}

          <div class="tb-graph-card-header">
            <div class="tb-graph-card-left">
              <span class="tb-layer-badge tb-layer-badge--${escapeHtml(layer)}">${escapeHtml(layer.toUpperCase())}</span>
              <span class="tb-graph-schema">${escapeHtml(t.schema)}</span>
              <strong class="tb-graph-table" title="${escapeHtml(t.table)}">${escapeHtml(t.table)}</strong>
              ${node.alias ? `<span class="tb-alias-pill">${escapeHtml(node.alias)}</span>` : ''}
            </div>
            <div class="tb-graph-card-right">
              <button type="button" class="tb-btn-base ${isBase ? 'active' : ''}" 
                      data-action="set-base" data-key="${escapeHtml(key)}"
                      title="${isBase ? 'Базовая таблица (FROM)' : 'Сделать базовой таблицей (FROM)'}">
                ${isBase ? '★ FROM' : 'Сделать FROM'}
              </button>
              <button type="button" class="tb-btn-remove" 
                      data-action="remove-table" data-key="${escapeHtml(key)}"
                      title="Удалить из шаблона">
                ✕
              </button>
            </div>
          </div>
  `;

  if (!isBase) {
    html += `
      <div class="tb-graph-card-body">
        <div class="tb-graph-parent-row">
          <label class="tb-graph-label">Соединить с:</label>
          <select class="tb-graph-parent-select" data-key="${escapeHtml(key)}">
            ${eligibleParents.map(p => {
              const isSelected = p.key === currentParentKey;
              const pLayer = (p.table.db || "").toUpperCase();
              const pFrom = p.isBase ? " (★ FROM)" : "";
              return `<option value="${escapeHtml(p.key)}" ${isSelected ? 'selected' : ''}>
                ${escapeHtml(p.table.table)} [${escapeHtml(pLayer)}]${pFrom} (${escapeHtml(p.alias)})
              </option>`;
            }).join("")}
          </select>
        </div>

        ${sources.length > 0 ? `
          <div class="tb-graph-source-row">
            <label class="tb-graph-label">Связь:</label>
            <select class="tb-graph-source-select" data-key="${escapeHtml(key)}">
              ${sources.map(s => {
                const optTitle = escapeHtml(s.rawCondition || s.label);
                const optText = `${s.isDefault ? '★ ' : ''}${escapeHtml(s.label)} [${escapeHtml(s.statusTag)}]`;
                return `<option value="${escapeHtml(s.id)}" ${s.isSelected ? 'selected' : ''} title="${optTitle}">${optText}</option>`;
              }).join("")}
            </select>
          </div>
        ` : `
          <div class="tb-graph-fallback-hint">
            <span>Прямая связь не найдена (TODO)</span>
          </div>
        `}

        ${missingTables.length > 0 ? `
          <div class="tb-graph-missing-row">
            <span class="tb-graph-missing-tag" title="В условии используется таблица не из шаблона">⚠️ ${missingTables.map(m => m.table).join(", ")}</span>
            <button type="button" class="tb-btn-add-missing tb-btn-add-missing--compact" 
                    data-db="${escapeHtml(missingTables[0].db)}" data-schema="${escapeHtml(missingTables[0].schema)}" data-table="${escapeHtml(missingTables[0].table)}"
                    title="Добавить ${escapeHtml(missingTables[0].table)} в шаблон">
              + Добавить
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  html += `
          ${hasChildren ? `<div class="tb-graph-port tb-graph-port--bottom" title="Выходные соединения к дочерним таблицам"></div>` : ''}
        </div> <!-- .tb-graph-card -->
      </div> <!-- .tb-graph-node-wrapper -->
  `;

  // Рекурсивный рендер дочерних веток
  if (hasChildren) {
    html += `<div class="tb-graph-children">`;
    for (const child of node.children) {
      html += renderGraphNodeBranch(child, context);
    }
    html += `</div>`;
  }

  html += `</div> <!-- .tb-graph-branch -->`;
  return html;
}

/**
 * Рендерит интерактивный граф связей (Вариант 2: Graph View).
 * @param {HTMLElement} container - DOM-контейнер для вставки
 * @param {object} params - параметры и колбэки
 */
export function renderGraphView(container, params) {
  if (!container) return;

  const {
    tables = [],
    plan = null,
    tree = null,
    state = {},
    onSetParent,
    onSetSource,
    onSetBase,
    onRemove,
    onAddMissing
  } = params;

  if (!tree || !tree.root) {
    container.innerHTML = `<div class="tb-graph-empty">Нет данных для отображения графа</div>`;
    return;
  }

  const { root, nodesByKey } = tree;
  const baseKey = state.baseTableKey;

  let html = `
    <div class="tb-graph-view-container" id="tb-graph-view-container">
      <div class="tb-graph-header-hint">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="18" cy="5" r="3"></circle>
          <circle cx="6" cy="12" r="3"></circle>
          <circle cx="18" cy="19" r="3"></circle>
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
        </svg>
        <span>Граф соединений: базовая таблица (FROM) расположена наверху, дочерние ветви — снизу. Связи соединяются кривыми линиями.</span>
      </div>

      <div class="tb-graph-viewport" id="tb-graph-viewport">
        <!-- SVG-холст для соединительных стрелок -->
        <svg class="tb-graph-svg-canvas" id="tb-graph-svg-canvas">
          <defs>
            <marker id="tb-graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#1a73e8"></path>
            </marker>
          </defs>
          <g id="tb-graph-svg-edges"></g>
        </svg>

        <div class="tb-graph-tree-root">
          ${renderGraphNodeBranch(root, { nodesByKey, baseKey })}
        </div>
      </div>
    </div>
  `;

  container.innerHTML = html;

  // Навешиваем обработчики кликов и селектов
  attachGraphEvents(container, {
    onSetParent,
    onSetSource,
    onSetBase,
    onRemove,
    onAddMissing
  });

  // Запускаем отрисовку SVG-линий связей
  scheduleGraphLinesRedraw(container, tree);
}

function attachGraphEvents(container, callbacks) {
  const { onSetParent, onSetSource, onSetBase, onRemove, onAddMissing } = callbacks;

  container.querySelectorAll(".tb-graph-parent-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const key = sel.getAttribute("data-key");
      const parentKey = sel.value;
      if (onSetParent) onSetParent(key, parentKey);
    });
  });

  container.querySelectorAll(".tb-graph-source-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const key = sel.getAttribute("data-key");
      const sourceId = sel.value;
      if (onSetSource) onSetSource(key, sourceId);
    });
  });

  container.querySelectorAll('button[data-action="set-base"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-key");
      if (onSetBase) onSetBase(key);
    });
  });

  container.querySelectorAll('button[data-action="remove-table"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-key");
      if (onRemove) onRemove(key);
    });
  });

  container.querySelectorAll(".tb-btn-add-missing").forEach(btn => {
    btn.addEventListener("click", () => {
      const db = btn.getAttribute("data-db");
      const schema = btn.getAttribute("data-schema");
      const table = btn.getAttribute("data-table");
      if (onAddMissing) onAddMissing(db, schema, table);
    });
  });
}

/**
 * Отрисовывает SVG-кривые между родительскими и дочерними узлами.
 */
export function drawGraphEdges(container, tree) {
  if (!container || !tree || !tree.flatTreeList) return;
  const viewport = container.querySelector("#tb-graph-viewport");
  const svg = container.querySelector("#tb-graph-svg-canvas");
  const edgesGroup = container.querySelector("#tb-graph-svg-edges");
  if (!viewport || !svg || !edgesGroup) return;

  const viewportRect = viewport.getBoundingClientRect();
  svg.setAttribute("width", viewport.scrollWidth.toString());
  svg.setAttribute("height", viewport.scrollHeight.toString());

  const scrollLeft = viewport.scrollLeft;
  const scrollTop = viewport.scrollTop;

  let edgesHtml = "";

  for (const node of tree.flatTreeList) {
    if (node.isBase || !node.parentKey) continue;

    const parentId = `tb-gnode-${node.parentKey.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    const childId = `tb-gnode-${node.key.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    const parentEl = viewport.querySelector(`#${parentId}`);
    const childEl = viewport.querySelector(`#${childId}`);

    if (!parentEl || !childEl) continue;

    const pRect = parentEl.getBoundingClientRect();
    const cRect = childEl.getBoundingClientRect();

    // Координаты нижнего центра родителя
    const x1 = (pRect.left + pRect.width / 2) - viewportRect.left + scrollLeft;
    const y1 = pRect.bottom - viewportRect.top + scrollTop;

    // Координаты верхнего центра потомка
    const x2 = (cRect.left + cRect.width / 2) - viewportRect.left + scrollLeft;
    const y2 = cRect.top - viewportRect.top + scrollTop;

    // Гладкая кубическая кривая Безье
    const deltaY = Math.max(20, Math.abs(y2 - y1) * 0.5);
    const cp1Y = y1 + deltaY;
    const cp2Y = y2 - deltaY;

    const d = `M ${x1} ${y1} C ${x1} ${cp1Y}, ${x2} ${cp2Y}, ${x2} ${y2}`;

    edgesHtml += `
      <path class="tb-graph-edge-path" 
            d="${d}" 
            fill="none" 
            stroke="#1a73e8" 
            stroke-width="2.5" 
            marker-end="url(#tb-graph-arrow)" />
    `;
  }

  edgesGroup.innerHTML = edgesHtml;
}

function scheduleGraphLinesRedraw(container, tree) {
  requestAnimationFrame(() => {
    drawGraphEdges(container, tree);
    // Повторный прогон после возможного reflow шрифтов
    setTimeout(() => drawGraphEdges(container, tree), 80);
  });
}

