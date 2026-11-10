/* 
MODULE: src/ui/templateBuilderTreeCards.js
ROLE: Вариант 1 (Variant 1) — Древовидный список карточек (Tree Cards) с отступами,
      ветвящимися направляющими линиями (├──, └──) и селектором родительской таблицы («Соединить с»).
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
 * Рендерит иерархический древовидный список таблиц (Вариант 1: Tree Cards).
 * @param {HTMLElement} container - DOM-контейнер для вставки
 * @param {object} params - параметры и колбэки
 */
export function renderTreeCards(container, params) {
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

  if (!tree || !tree.flatTreeList || tree.flatTreeList.length === 0) {
    container.innerHTML = `<div class="tb-tree-empty">Нет данных для отображения дерева</div>`;
    return;
  }

  const { flatTreeList, nodesByKey } = tree;
  const baseKey = state.baseTableKey;

  let html = `<div class="tb-tree-cards-container">`;

  // Подсказка об иерархии
  html += `
    <div class="tb-tree-header-hint">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="16" x2="12" y2="12"></line>
        <line x1="12" y1="8" x2="12.01" y2="8"></line>
      </svg>
      <span>Дерево соединений: выберите родительскую таблицу в поле <strong>«Соединить с»</strong> для ветвления связей от нужного узла.</span>
    </div>
    <div class="tb-tree-cards-list">
  `;

  for (const node of flatTreeList) {
    const key = node.key;
    const isBase = node.isBase || key === baseKey;
    const t = node.table;
    const layer = (t.db || "dds").toLowerCase();
    const planItem = node.joinInfo;
    const sources = planItem?.availableSources || [];
    const missingTables = planItem?.missingTables || [];
    const depth = node.depth || 0;
    const indentPx = depth * 28;

    // Вычисляем список допустимых родителей (исключая себя и всех своих потомков)
    const invalidParents = getDescendantKeys(key, nodesByKey);
    invalidParents.add(key);

    const eligibleParents = [];
    for (const [candKey, candNode] of nodesByKey.entries()) {
      if (!invalidParents.has(candKey)) {
        eligibleParents.push(candNode);
      }
    }

    const currentParentKey = node.parentKey || (planItem?.joinedWith ? getTableKey(planItem.joinedWith) : "");

    html += `
      <div class="tb-tree-node ${isBase ? 'tb-tree-node--base' : ''} ${depth > 0 ? 'tb-tree-node--child' : ''}" 
           data-key="${escapeHtml(key)}" 
           data-depth="${depth}"
           style="--tree-depth: ${depth}; margin-left: ${indentPx}px;">
        
        ${depth > 0 ? `
          <div class="tb-tree-branch-guide" aria-hidden="true">
            <span class="tb-tree-branch-line">${escapeHtml(node.prefix || "└── ")}</span>
          </div>
        ` : ''}

        <div class="tb-table-card ${isBase ? 'tb-table-card--base' : ''}">
          <div class="tb-table-card-main">
            <div class="tb-table-card-left">
              <span class="tb-layer-badge tb-layer-badge--${escapeHtml(layer)}">${escapeHtml(layer.toUpperCase())}</span>
              <div class="tb-table-name-group">
                <span class="tb-table-schema">${escapeHtml(t.schema)}</span>
                <span class="tb-table-name" title="${escapeHtml(t.table)}">${escapeHtml(t.table)}</span>
                ${node.alias ? `<span class="tb-alias-pill" title="SQL-алиас">${escapeHtml(node.alias)}</span>` : ''}
              </div>
            </div>
            <div class="tb-table-card-right">
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

    // Для неприсоединённых / дочерних таблиц показываем выбор родителя и источника
    if (!isBase) {
      html += `
        <div class="tb-table-card-details">
          <!-- Выбор родительской таблицы для ветвления (Join Tree) -->
          <div class="tb-join-parent-row">
            <label class="tb-join-parent-label" title="К какой таблице присоединить текущую">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 3v12"></path>
                <circle cx="18" cy="6" r="3"></circle>
                <circle cx="6" cy="18" r="3"></circle>
                <path d="M18 9a9 9 0 0 1-9 9"></path>
              </svg>
              Соединить с:
            </label>
            <select class="tb-parent-select" data-key="${escapeHtml(key)}">
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
      `;

      // Источник связей (скрипт витрины)
      if (sources.length > 0) {
        html += `
          <div class="tb-join-source-row">
            <label class="tb-join-source-label" title="Источник скрипта и условие JOIN">Связь:</label>
            <select class="tb-join-source-select" data-key="${escapeHtml(key)}">
              ${sources.map(s => {
                const optTitle = escapeHtml(s.rawCondition || s.label);
                const optText = `${s.isDefault ? '★ ' : ''}${escapeHtml(s.label)} [${escapeHtml(s.statusTag)}]`;
                return `<option value="${escapeHtml(s.id)}" ${s.isSelected ? 'selected' : ''} title="${optTitle}">${optText}</option>`;
              }).join("")}
            </select>
          </div>
        `;
      } else {
        html += `
          <div class="tb-join-fallback-hint">
            <span>Прямая связь в витринах не найдена (TODO условие)</span>
          </div>
        `;
      }

      // Недостающие таблицы
      if (missingTables.length > 0) {
        html += `
          <div class="tb-missing-table-banner">
            <div class="tb-missing-header">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
              </svg>
              <span>В условии используется таблица не из шаблона:</span>
            </div>
            <div class="tb-missing-list">
              ${missingTables.map(m => `
                <div class="tb-missing-item">
                  <span class="tb-missing-name"><strong>${escapeHtml(m.table)}</strong> <code class="tb-missing-alias">${escapeHtml(m.alias)}.</code></span>
                  <button type="button" class="tb-btn-add-missing" 
                          data-db="${escapeHtml(m.db)}" data-schema="${escapeHtml(m.schema)}" data-table="${escapeHtml(m.table)}"
                          title="Добавить ${escapeHtml(m.db)}.${escapeHtml(m.schema)}.${escapeHtml(m.table)} в шаблон">
                    + Добавить в шаблон
                  </button>
                </div>
              `).join("")}
            </div>
          </div>
        `;
      }

      html += `</div>`; // .tb-table-card-details
    }

    html += `
        </div> <!-- .tb-table-card -->
      </div> <!-- .tb-tree-node -->
    `;
  }

  html += `
      </div> <!-- .tb-tree-cards-list -->
    </div> <!-- .tb-tree-cards-container -->
  `;

  container.innerHTML = html;

  // Навешиваем обработчики событий
  attachTreeCardsEvents(container, {
    onSetParent,
    onSetSource,
    onSetBase,
    onRemove,
    onAddMissing
  });
}

function attachTreeCardsEvents(container, callbacks) {
  const { onSetParent, onSetSource, onSetBase, onRemove, onAddMissing } = callbacks;

  // Изменение родителя
  container.querySelectorAll(".tb-parent-select").forEach(sel => {
    sel.addEventListener("change", (e) => {
      const key = sel.getAttribute("data-key");
      const parentKey = sel.value;
      if (onSetParent) onSetParent(key, parentKey);
    });
  });

  // Изменение источника связи
  container.querySelectorAll(".tb-join-source-select").forEach(sel => {
    sel.addEventListener("change", (e) => {
      const key = sel.getAttribute("data-key");
      const sourceId = sel.value;
      if (onSetSource) onSetSource(key, sourceId);
    });
  });

  // Кнопка сделать FROM
  container.querySelectorAll('button[data-action="set-base"]').forEach(btn => {
    btn.addEventListener("click", (e) => {
      const key = btn.getAttribute("data-key");
      if (onSetBase) onSetBase(key);
    });
  });

  // Кнопка удалить
  container.querySelectorAll('button[data-action="remove-table"]').forEach(btn => {
    btn.addEventListener("click", (e) => {
      const key = btn.getAttribute("data-key");
      if (onRemove) onRemove(key);
    });
  });

  // Добавить недостающую таблицу
  container.querySelectorAll(".tb-btn-add-missing").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const db = btn.getAttribute("data-db");
      const schema = btn.getAttribute("data-schema");
      const table = btn.getAttribute("data-table");
      if (onAddMissing) onAddMissing(db, schema, table);
    });
  });
}

