/* 
MODULE: src/ui/templateBuilder.js
ROLE: UI-компонент «Генератор шаблонов витрин» (Template Generator).
      Управляет состоянием конструктора, Drag & Drop приемом таблиц из боковой панели,
      интерактивным списком таблиц, генерацией и копированием SQL-скелета.
DESIGN: Полностью реактивное разделение State -> Render -> Actions для простого расширения.
*/

import { generateSqlTemplate, buildJoinPlan, getTableKey, canApplyTimelineSlicing } from "../utils/sqlJoinInference.js";
import { copyText } from "../utils/helpers.js";

// ============================================================================
// СОСТОЯНИЕ (State Store)
// ============================================================================

export const templateBuilderState = {
  isOpen: false,
  selectedTables: [], // Array<{ db, schema, table, fullId }>
  baseTableKey: null, // tableKey главной таблицы (FROM)
  userSelectedSources: {}, // Map<tableKey, sourceId> - пользовательский выбор источника связи
  defaultJoinType: "LEFT JOIN",
  enableTimelineSlicing: false, // Режим нарезки временных интервалов SCD2
  generatedSql: "",
  listeners: new Set(),

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },

  notify() {
    for (const listener of this.listeners) {
      listener(this);
    }
  }
};

// ============================================================================
// ДЕЙСТВИЯ (Actions)
// ============================================================================

/**
 * Добавляет таблицу в конструктор.
 * @param {object} tableObj { db, schema, table }
 * @returns {boolean} true если добавлена, false если дубликат
 */
export function addTableToBuilder(tableObj) {
  if (!tableObj || !tableObj.table) return false;

  const key = getTableKey(tableObj);
  const exists = templateBuilderState.selectedTables.some(t => getTableKey(t) === key);
  if (exists) {
    showToast(`Таблица ${tableObj.table} уже добавлена`, "warning");
    return false;
  }

  templateBuilderState.selectedTables.push({
    db: tableObj.db,
    schema: tableObj.schema,
    table: tableObj.table,
    fullId: `${tableObj.db}-${tableObj.schema}-${tableObj.table}`
  });

  // Если это первая таблица, делаем её базовой (FROM)
  if (templateBuilderState.selectedTables.length === 1) {
    templateBuilderState.baseTableKey = key;
  }

  showToast(`Таблица ${tableObj.table} добавлена в шаблон`, "success");

  // Если SQL уже был сгенерирован, обновляем его
  if (templateBuilderState.generatedSql) {
    generateTemplateSql();
  } else {
    templateBuilderState.notify();
  }

  return true;
}

/**
 * Удаляет таблицу из конструктора.
 * @param {string} tableKey 
 */
export function removeTableFromBuilder(tableKey) {
  const normKey = tableKey.toLowerCase();
  templateBuilderState.selectedTables = templateBuilderState.selectedTables.filter(
    t => getTableKey(t) !== normKey
  );
  delete templateBuilderState.userSelectedSources[normKey];

  if (templateBuilderState.baseTableKey === normKey) {
    templateBuilderState.baseTableKey = templateBuilderState.selectedTables.length > 0 
      ? getTableKey(templateBuilderState.selectedTables[0]) 
      : null;
  }

  if (templateBuilderState.selectedTables.length === 0) {
    templateBuilderState.generatedSql = "";
    templateBuilderState.notify();
  } else if (templateBuilderState.generatedSql) {
    generateTemplateSql();
  } else {
    templateBuilderState.notify();
  }
}

/**
 * Устанавливает таблицу в качестве базовой (FROM).
 * @param {string} tableKey 
 */
export function setBaseTable(tableKey) {
  templateBuilderState.baseTableKey = tableKey.toLowerCase();
  if (templateBuilderState.generatedSql) {
    generateTemplateSql();
  } else {
    templateBuilderState.notify();
  }
}

/**
 * Переключает источник связи для выбранной таблицы в плане соединения.
 * @param {string} tableKey 
 * @param {string} sourceId 
 */
export function setTableJoinSource(tableKey, sourceId) {
  if (!tableKey) return;
  templateBuilderState.userSelectedSources[tableKey.toLowerCase()] = sourceId;

  if (templateBuilderState.generatedSql) {
    generateTemplateSql();
  } else {
    templateBuilderState.notify();
  }
}

/**
 * Очищает список добавленных таблиц.
 */
export function clearBuilderTables() {
  templateBuilderState.selectedTables = [];
  templateBuilderState.baseTableKey = null;
  templateBuilderState.userSelectedSources = {};
  templateBuilderState.enableTimelineSlicing = false;
  templateBuilderState.generatedSql = "";
  templateBuilderState.notify();
}

/**
 * Синхронизирует координату left шторки конструктора с правым краем сайдбара.
 */
export function syncTemplateBuilderPosition() {
  const drawer = document.getElementById("template-builder-drawer");
  const sidebar = document.getElementById("sidebar");
  const resizer = document.getElementById("resizer");
  if (!drawer) return;

  if (sidebar) {
    const leftOffset = resizer ? resizer.getBoundingClientRect().right : sidebar.getBoundingClientRect().right;
    const finalLeft = Math.max(0, leftOffset);
    drawer.style.left = `${finalLeft}px`;
    document.documentElement.style.setProperty("--sidebar-width", `${finalLeft}px`);
  }
}

/**
 * Открывает или закрывает шторку конструктора.
 * @param {boolean} [forceState] 
 */
export function toggleTemplateBuilder(forceState) {
  const next = typeof forceState === "boolean" ? forceState : !templateBuilderState.isOpen;
  templateBuilderState.isOpen = next;

  const drawer = document.getElementById("template-builder-drawer");
  const headerBtn = document.getElementById("tb-header-toggle-btn");

  if (drawer) {
    drawer.style.width = ""; // Сбрасываем возможные inline-стили ширины
    if (next) {
      syncTemplateBuilderPosition();
    }
    drawer.classList.toggle("open", next);
    drawer.setAttribute("aria-hidden", (!next).toString());
  }

  if (headerBtn) {
    const hasDrafts = templateBuilderState.selectedTables.length > 0;
    headerBtn.style.display = hasDrafts ? "inline-flex" : "none";
    headerBtn.classList.toggle("active", next);
  }
}

/**
 * Открывает обучающее модальное окно Timeline Slicing.
 */
export function openTimelineSlicingHelpModal() {
  const modal = document.getElementById("tb-timeline-help-modal");
  if (!modal) return;
  modal.style.display = "flex";
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

/**
 * Закрывает обучающее модальное окно Timeline Slicing.
 */
export function closeTimelineSlicingHelpModal() {
  const modal = document.getElementById("tb-timeline-help-modal");
  if (!modal) return;
  modal.style.display = "none";
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

/**
 * Запускает генерацию шаблона SQL.
 */
export function generateTemplateSql() {
  if (templateBuilderState.selectedTables.length === 0) {
    showToast("Добавьте хотя бы одну таблицу для генерации шаблона", "warning");
    return;
  }

  const catalogData = window.catalogData || null;

  const sql = generateSqlTemplate(templateBuilderState.selectedTables, {
    catalogData: catalogData,
    baseTableKey: templateBuilderState.baseTableKey,
    defaultJoinType: templateBuilderState.defaultJoinType,
    userSelectedSources: templateBuilderState.userSelectedSources,
    enableTimelineSlicing: templateBuilderState.enableTimelineSlicing
  });

  templateBuilderState.generatedSql = sql;
  templateBuilderState.notify();

  // Автоскролл к сгенерированному SQL
  setTimeout(() => {
    const previewEl = document.getElementById("tb-sql-preview");
    if (previewEl) {
      previewEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, 50);
}

// ============================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (Toasts & Helpers)
// ============================================================================

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `tb-toast tb-toast--${type}`;
  toast.textContent = message;

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("tb-toast--visible"));

  setTimeout(() => {
    toast.classList.remove("tb-toast--visible");
    setTimeout(() => toast.remove(), 300);
  }, 2400);
}

/**
 * Парсит идентификатор из ссылки дерева сайдбара (#db-schema-table).
 */
function parseTableFromHref(href) {
  if (!href) return null;
  const hash = href.startsWith("#") ? href.substring(1) : href;
  const parts = hash.split("-");
  if (parts.length >= 3) {
    return {
      db: parts[0],
      schema: parts[1],
      table: parts.slice(2).join("-")
    };
  }
  return null;
}

// ============================================================================
// DRAG & DROP КОНТРОЛЛЕР
// ============================================================================

function initDragAndDrop() {
  const sidebar = document.getElementById("sidebar");
  const edgeDropzone = document.getElementById("tb-edge-dropzone");
  const drawer = document.getElementById("template-builder-drawer");

  if (!sidebar) return;

  // 1. Делаем все ссылки таблиц в сайдбаре draggable
  sidebar.addEventListener("dragstart", (e) => {
    const link = e.target.closest("a[href^='#']");
    if (!link) return;

    const tableInfo = parseTableFromHref(link.getAttribute("href"));
    if (!tableInfo || tableInfo.db === "home") return;

    // Устанавливаем данные перетаскивания
    const payload = JSON.stringify(tableInfo);
    e.dataTransfer.setData("application/json", payload);
    e.dataTransfer.setData("text/plain", `${tableInfo.db}.${tableInfo.schema}.${tableInfo.table}`);
    e.dataTransfer.effectAllowed = "copy";

    // Визуальное оформление
    link.classList.add("tb-is-dragging");
    document.body.classList.add("tb-dragging-active");

    // Подсвечиваем краевую зону, если шторка закрыта
    if (!templateBuilderState.isOpen && edgeDropzone) {
      if (sidebar) {
        const rect = sidebar.getBoundingClientRect();
        edgeDropzone.style.left = `${Math.max(0, rect.right)}px`;
      }
      edgeDropzone.classList.add("tb-edge-active");
    }
  });

  sidebar.addEventListener("dragend", (e) => {
    const link = e.target.closest("a[href^='#']");
    if (link) link.classList.remove("tb-is-dragging");
    document.body.classList.remove("tb-dragging-active");

    if (edgeDropzone) {
      edgeDropzone.classList.remove("tb-edge-active", "tb-drag-hover");
      edgeDropzone.style.left = "";
    }
  });

  // 2. Обработчики для краевой зоны (когда панель закрыта)
  if (edgeDropzone) {
    edgeDropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      edgeDropzone.classList.add("tb-drag-hover");
    });

    edgeDropzone.addEventListener("dragleave", () => {
      edgeDropzone.classList.remove("tb-drag-hover");
    });

    edgeDropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      edgeDropzone.classList.remove("tb-drag-hover", "tb-edge-active");
      edgeDropzone.style.left = "";
      document.body.classList.remove("tb-dragging-active");

      const dataStr = e.dataTransfer.getData("application/json");
      if (dataStr) {
        try {
          const tableInfo = JSON.parse(dataStr);
          toggleTemplateBuilder(true);
          addTableToBuilder(tableInfo);
        } catch (err) {
          console.error("Ошибка парсинга Drag&Drop данных:", err);
        }
      }
    });
  }

  // 3. Обработчики для основной зоны сброса внутри шторки
  if (drawer) {
    drawer.addEventListener("dragover", (e) => {
      const dropzone = e.target.closest("#tb-dropzone");
      if (dropzone || drawer.classList.contains("open")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const dz = document.getElementById("tb-dropzone");
        if (dz) dz.classList.add("drag-hover");
      }
    });

    drawer.addEventListener("dragleave", (e) => {
      if (!drawer.contains(e.relatedTarget)) {
        const dz = document.getElementById("tb-dropzone");
        if (dz) dz.classList.remove("drag-hover");
      }
    });

    drawer.addEventListener("drop", (e) => {
      e.preventDefault();
      const dz = document.getElementById("tb-dropzone");
      if (dz) dz.classList.remove("drag-hover");
      document.body.classList.remove("tb-dragging-active");

      const dataStr = e.dataTransfer.getData("application/json");
      if (dataStr) {
        try {
          const tableInfo = JSON.parse(dataStr);
          addTableToBuilder(tableInfo);
        } catch (err) {
          console.error("Ошибка парсинга Drag&Drop данных:", err);
        }
      }
    });
  }
}

// ============================================================================
// РЕНДЕРИНГ ШТОРКИ И КОМПОНЕНТОВ (DOM Renderer)
// ============================================================================

function renderTableList(container) {
  if (!container) return;
  const tables = templateBuilderState.selectedTables;

  if (tables.length === 0) {
    container.innerHTML = `
      <div class="tb-empty-state">
        <svg class="tb-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
          <rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 3"></rect>
          <path d="M12 8v8M8 12h8"></path>
        </svg>
        <div class="tb-empty-title">Таблицы ещё не добавлены</div>
        <div class="tb-empty-hint">Зажмите левую кнопку мыши на любой таблице в сайдбаре слева и перетащите её сюда</div>
      </div>
    `;
    return;
  }

  // Строим текущий план соединения, чтобы сразу показать доступные связи и зависимости
  const plan = tables.length >= 2 ? buildJoinPlan(tables, {
    catalogData: window.catalogData || null,
    baseTableKey: templateBuilderState.baseTableKey,
    defaultJoinType: templateBuilderState.defaultJoinType,
    userSelectedSources: templateBuilderState.userSelectedSources
  }) : null;

  let html = `<div class="tb-tables-grid">`;
  tables.forEach((t) => {
    const key = getTableKey(t);
    const isBase = key === templateBuilderState.baseTableKey;
    const layer = (t.db || "dds").toLowerCase();
    const planItem = !isBase ? plan?.joinPlan?.find(j => getTableKey(j.table) === key) : null;
    const sources = planItem?.availableSources || [];
    const missingTables = planItem?.missingTables || [];

    html += `
      <div class="tb-table-card ${isBase ? 'tb-table-card--base' : ''}" data-key="${key}">
        <div class="tb-table-card-main">
          <div class="tb-table-card-left">
            <span class="tb-layer-badge tb-layer-badge--${layer}">${layer.toUpperCase()}</span>
            <div class="tb-table-name-group">
              <span class="tb-table-schema">${t.schema}</span>
              <span class="tb-table-name" title="${t.table}">${t.table}</span>
            </div>
          </div>
          <div class="tb-table-card-right">
            <button type="button" class="tb-btn-base ${isBase ? 'active' : ''}" 
                    onclick="window.setTemplateBaseTable('${key}')" 
                    title="${isBase ? 'Базовая таблица (FROM)' : 'Сделать базовой таблицей (FROM)'}">
              ${isBase ? '★ FROM' : 'Сделать FROM'}
            </button>
            <button type="button" class="tb-btn-remove" 
                    onclick="window.removeTableFromTemplateBuilder('${key}')" 
                    title="Удалить из шаблона">
              ✕
            </button>
          </div>
        </div>
    `;

    if (!isBase && planItem) {
      html += `<div class="tb-table-card-details">`;

      if (sources.length > 0) {
        html += `
          <div class="tb-join-source-row">
            <label class="tb-join-source-label" title="Источник скрипта и условие JOIN">Связь:</label>
            <select class="tb-join-source-select" onchange="window.setTableJoinSource('${key}', this.value)">
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
                  <button type="button" class="tb-btn-add-missing" onclick="window.addMissingTable('${escapeHtml(m.db)}', '${escapeHtml(m.schema)}', '${escapeHtml(m.table)}')" title="Добавить ${escapeHtml(m.db)}.${escapeHtml(m.schema)}.${escapeHtml(m.table)} в шаблон">
                    + Добавить в шаблон
                  </button>
                </div>
              `).join("")}
            </div>
          </div>
        `;
      }

      html += `</div>`;
    }

    html += `</div>`;
  });
  html += `</div>`;
  container.innerHTML = html;
}

function renderOutput(container) {
  if (!container) return;
  const sql = templateBuilderState.generatedSql;

  if (!sql) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  container.innerHTML = `
    <div class="tb-result-box">
      <div class="tb-result-header">
        <div class="tb-result-title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
          Сгенерированный скелет скрипта
        </div>
        <div class="tb-result-actions">
          <button type="button" class="tb-action-btn tb-action-btn--primary" id="tb-copy-sql-btn" onclick="window.copyTemplateSql(this)">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Копировать SQL
          </button>
        </div>
      </div>
      <pre class="tb-code-block" id="tb-sql-preview"><code>${escapeHtml(sql)}</code></pre>
    </div>
  `;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function updateBuilderUI() {
  const count = templateBuilderState.selectedTables.length;
  const countEl = document.getElementById("tb-table-count");
  if (countEl) {
    countEl.textContent = count.toString();
  }

  const headerBtn = document.getElementById("tb-header-toggle-btn");
  const headerBadge = document.getElementById("tb-header-badge");

  if (headerBtn) {
    // Показываем кнопку в шапке ТОЛЬКО если есть хотя бы 1 таблица в заготовках
    headerBtn.style.display = count > 0 ? "inline-flex" : "none";
    headerBtn.classList.toggle("active", templateBuilderState.isOpen);
  }
  if (headerBadge) {
    headerBadge.textContent = count > 0 ? count.toString() : "";
    headerBadge.style.display = count > 0 ? "inline-flex" : "none";
  }

  const listContainer = document.getElementById("tb-tables-list");
  renderTableList(listContainer);

  // Управление видимостью чек-бокса Timeline Slicing
  const timelineGroup = document.getElementById("tb-timeline-group");
  const timelineCheckbox = document.getElementById("tb-timeline-checkbox");
  const canSlicing = canApplyTimelineSlicing(templateBuilderState.selectedTables, window.catalogData);

  if (timelineGroup) {
    if (canSlicing) {
      timelineGroup.style.display = "flex";
      timelineGroup.classList.add("tb-visible");
      if (timelineCheckbox) {
        timelineCheckbox.checked = !!templateBuilderState.enableTimelineSlicing;
      }
    } else {
      timelineGroup.style.display = "none";
      timelineGroup.classList.remove("tb-visible");
      templateBuilderState.enableTimelineSlicing = false;
      if (timelineCheckbox) {
        timelineCheckbox.checked = false;
      }
    }
  }

  const resultContainer = document.getElementById("tb-result-container");
  renderOutput(resultContainer);
}

// ============================================================================
// ИЗМЕНЕНИЕ ШИРИНЫ ШТОРКИ МЫШЬЮ (Resizer)
// ============================================================================

function initDrawerResizer() {
  const drawer = document.getElementById("template-builder-drawer");
  const resizer = document.getElementById("tb-resizer");
  if (!drawer || !resizer) return;

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isResizing = true;
    startX = e.clientX;
    startWidth = drawer.offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    resizer.classList.add("is-resizing");
    drawer.classList.add("tb-is-resizing-drawer");
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const delta = startX - e.clientX;
    let newWidth = startWidth + delta;
    const minWidth = 360;
    const maxWidth = Math.min(window.innerWidth - 80, 1200);
    if (newWidth < minWidth) newWidth = minWidth;
    if (newWidth > maxWidth) newWidth = maxWidth;
    drawer.style.width = `${newWidth}px`;
  });

  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
      resizer.classList.remove("is-resizing");
      drawer.classList.remove("tb-is-resizing-drawer");
    }
  });
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================================

export function initTemplateBuilder() {
  // Подписываемся на обновления состояния
  templateBuilderState.subscribe(updateBuilderUI);

  // Инициализируем Drag and Drop
  initDragAndDrop();

  // Инициализируем изменение ширины панели мышью (ползунок/ресайзер)
  initDrawerResizer();

  const joinTypeSelect = document.getElementById("tb-join-type-select");
  if (joinTypeSelect) {
    joinTypeSelect.addEventListener("change", (e) => {
      templateBuilderState.defaultJoinType = e.target.value;
      if (templateBuilderState.generatedSql) {
        generateTemplateSql();
      }
    });
  }

  const timelineCheckbox = document.getElementById("tb-timeline-checkbox");
  if (timelineCheckbox) {
    timelineCheckbox.addEventListener("change", (e) => {
      templateBuilderState.enableTimelineSlicing = e.target.checked;
      if (templateBuilderState.generatedSql) {
        generateTemplateSql();
      }
    });
  }

  // Кнопка справки Timeline Slicing (?)
  const helpBtn = document.getElementById("tb-timeline-help-btn");
  if (helpBtn) {
    helpBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTimelineSlicingHelpModal();
    });
  }

  // Закрытие модального окна справки при клике на оверлей вне карточки
  const helpModal = document.getElementById("tb-timeline-help-modal");
  if (helpModal) {
    helpModal.addEventListener("click", (e) => {
      if (e.target === helpModal) {
        closeTimelineSlicingHelpModal();
      }
    });
  }

  // Закрытие по нажатию клавиши Escape
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const modal = document.getElementById("tb-timeline-help-modal");
      if (modal && (modal.classList.contains("open") || modal.style.display !== "none")) {
        e.preventDefault();
        closeTimelineSlicingHelpModal();
        return;
      }
      if (templateBuilderState.isOpen) {
        e.preventDefault();
        toggleTemplateBuilder(false);
      }
    }
  });

  // Синхронизация ширины/позиции шторки при ресайзе окна
  window.addEventListener("resize", () => {
    if (templateBuilderState.isOpen) {
      syncTemplateBuilderPosition();
    }
  });

  // Закрытие панели при клике мышкой вне шторки:
  // ПРАВИЛО: Никакой клик в левой боковой панели (сайдбаре) не должен сворачивать правую панель.
  // Только клики в центральной рабочей области (.content) должны сворачивать правую панель.
  let mouseDownTarget = null;

  document.addEventListener("mousedown", (e) => {
    mouseDownTarget = e.target;
  });

  document.addEventListener("click", (e) => {
    if (!templateBuilderState.isOpen) return;
    const drawer = document.getElementById("template-builder-drawer");
    if (!drawer) return;

    // 1. Если клик или нажатие мыши началось внутри панели — не закрываем
    if (drawer.contains(e.target) || (mouseDownTarget && drawer.contains(mouseDownTarget))) {
      return;
    }

    // 2. Если клик по кнопке в шапке (у неё собственный обработчик toggle)
    if (e.target.closest("#tb-header-toggle-btn")) return;

    // 3. Если клик по тосту или краевой зоне
    if (e.target.closest(".tb-toast") || e.target.closest("#tb-edge-dropzone")) return;

    // 4. Если в этот момент происходил ресайз или перетаскивание таблицы
    if (document.body.classList.contains("tb-dragging-active") || drawer.classList.contains("tb-is-resizing-drawer")) {
      return;
    }

    // 5. ЖЕСТКОЕ ПРАВИЛО: никакой клик в левой боковой панели не должен сворачивать правую панель
    // Проверяем как по DOM-структуре (#sidebar, #sidebarToggleBtn, #resizer),
    // так и геометрически по координатам левой панели (на случай динамических элементов или скроллбара)
    const sidebar = document.getElementById("sidebar");
    if (e.target.closest("#sidebar") || e.target.closest("#sidebarToggleBtn") || e.target.closest("#resizer") ||
        (mouseDownTarget && (mouseDownTarget.closest("#sidebar") || mouseDownTarget.closest("#sidebarToggleBtn") || mouseDownTarget.closest("#resizer")))) {
      return;
    }
    if (sidebar) {
      const sidebarRect = sidebar.getBoundingClientRect();
      if (e.clientX <= (sidebarRect.right + 10)) {
        return;
      }
    }

    // 6. Только клики в центральной рабочей области (.content) сворачивают правую панель
    const contentArea = document.querySelector(".content");
    if (contentArea && contentArea.contains(e.target)) {
      toggleTemplateBuilder(false);
    }
  });

  // Первоначальный рендер
  updateBuilderUI();
}

// Экспортируем в глобальную область для вызовов из HTML
window.toggleTemplateBuilder = toggleTemplateBuilder;
window.setTemplateBaseTable = setBaseTable;
window.removeTableFromTemplateBuilder = removeTableFromBuilder;
window.clearBuilderTables = clearBuilderTables;
window.setTableJoinSource = setTableJoinSource;
window.addMissingTable = function(db, schema, table) {
  addTableToBuilder({ db, schema, table });
};
window.generateTemplateSql = generateTemplateSql;
window.openTimelineSlicingHelpModal = openTimelineSlicingHelpModal;
window.closeTimelineSlicingHelpModal = closeTimelineSlicingHelpModal;
window.copyTemplateSql = function(btn) {
  const sql = templateBuilderState.generatedSql;
  if (!sql) return;
  copyText(sql, btn);
};
