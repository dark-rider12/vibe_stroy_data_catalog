/* 
MODULE: src/lineage/tableLineageStale.js
ROLE: Логика Time Machine (анализ времени обновления таблиц из БД, подсветка Stale-веток, счетчик, легенда и попап по ПКМ).
*/

import { clearLineageHighlight } from "./tableLineageHighlight.js";

// Хранилище активного состояния Stale по идентификатору холста (unique_id)
const staleInstances = new Map();

/**
 * Парсит строковую дату (DD.MM.YYYY HH:MM:SS или ISO) в миллисекунды (Timestamp)
 */
export function parseTableDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const s = dateStr.trim();
  // Формат DD.MM.YYYY HH:MM:SS или DD.MM.YYYY HH:MM
  const ruMatch = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (ruMatch) {
    const day = parseInt(ruMatch[1], 10);
    const month = parseInt(ruMatch[2], 10) - 1;
    const year = parseInt(ruMatch[3], 10);
    const hour = ruMatch[4] ? parseInt(ruMatch[4], 10) : 0;
    const min = ruMatch[5] ? parseInt(ruMatch[5], 10) : 0;
    const sec = ruMatch[6] ? parseInt(ruMatch[6], 10) : 0;
    return new Date(year, month, day, hour, min, sec).getTime();
  }
  // Fallback ISO / стандартный Date.parse
  const ts = Date.parse(s);
  return isNaN(ts) ? null : ts;
}

/**
 * Форматирует дату для компактного отображения внутри карточки (YYYY-MM-DD HH:MM или DD.MM.YYYY HH:MM)
 */
export function formatCardDate(dateStr) {
  if (!dateStr) return "—";
  const s = dateStr.trim();
  // Если формат "DD.MM.YYYY HH:MM:SS", сокращаем до "DD.MM.YYYY HH:MM"
  const ruMatch = s.match(/^(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})(?::\d{2})?$/);
  if (ruMatch) return ruMatch[1];
  return s.length > 16 ? s.substring(0, 16) : s;
}

/**
 * Получает информацию о таблице из window.catalogData
 */
function getTableData(nodeId) {
  if (!nodeId || !window.catalogData) return null;
  const p = nodeId.split(".");
  if (p.length === 3) return window.catalogData[p[0]]?.[p[1]]?.[p[2]];
  return null;
}

/**
 * Проверяет, активен ли режим Stale (Time Machine) для данного холста
 */
export function isStaleModeActive(uniqueId) {
  return staleInstances.get(uniqueId)?.active === true;
}

/**
 * Получает информацию об устаревшем узле для данного холста
 */
export function getStaleNodeInfo(uniqueId, nodeId) {
  const inst = staleInstances.get(uniqueId);
  if (!inst || !inst.active) return null;
  return inst.staleDetails.get(nodeId) || null;
}

/**
 * Переключатель режима Time Machine
 */
export function toggleStaleMode(uniqueId, isEnabled) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return;
  const pane = canvas.closest(".pane-lineage");
  if (!pane) return;

  if (!staleInstances.has(uniqueId)) {
    staleInstances.set(uniqueId, {
      active: false,
      staleNodes: new Set(),
      staleDetails: new Map(),
      staleEdges: new Set(),
    });
  }
  const inst = staleInstances.get(uniqueId);
  inst.active = !!isEnabled;

  // Синхронизируем состояние чекбокса в DOM, если переключение вызвано программно
  const cb = document.getElementById(`stale-cb-${uniqueId}`);
  if (cb && cb.checked !== inst.active) {
    cb.checked = inst.active;
  }

  if (inst.active) {
    applyStaleAnalysis(canvas, uniqueId);
  } else {
    clearStaleAnalysis(canvas, uniqueId);
  }
}

/**
 * Основной расчет и применение визуализации Stale-веток
 */
export function applyStaleAnalysis(canvas, uniqueId) {
  const inst = staleInstances.get(uniqueId);
  if (!inst) return;

  // Показываем даты на карточках
  canvas.classList.add("ln-stale-active");

  // Очищаем предыдущие данные расчета
  inst.staleNodes.clear();
  inst.staleDetails.clear();
  inst.staleEdges.clear();

  // 1. Собираем все видимые узлы на канвасе
  const visibleNodes = new Set();
  canvas.querySelectorAll(".ln-node:not(.ln-virtual)").forEach((el) => {
    const id = el.dataset.nodeId;
    if (id) visibleNodes.add(id);
  });

  // 2. Строим граф смежности (родители и дети) для видимых узлов
  const parentsMap = new Map();  // target -> [sources]
  const childrenMap = new Map(); // source -> [targets]
  visibleNodes.forEach((id) => {
    const info = getTableData(id);
    const upstreams = (info?.lineage?.upstream || []).filter((u) => visibleNodes.has(u));
    const downstreams = (info?.lineage?.downstream || []).filter((d) => visibleNodes.has(d));
    parentsMap.set(id, upstreams);
    childrenMap.set(id, downstreams);
  });

  // 3. Выявляем прямые Stale-узлы: Time(Parent) > Time(Child)
  const directStale = new Set();
  visibleNodes.forEach((childId) => {
    const childInfo = getTableData(childId);
    const childDateStr = childInfo?.script_updated_at;
    const childTime = parseTableDate(childDateStr);
    if (!childTime) return;

    const parents = parentsMap.get(childId) || [];
    for (const parentId of parents) {
      const parentInfo = getTableData(parentId);
      const parentDateStr = parentInfo?.script_updated_at;
      const parentTime = parseTableDate(parentDateStr);

      if (parentTime && parentTime > childTime) {
        // Родитель обновился позже дочерней таблицы -> дочерняя устарела (Stale)
        directStale.add(childId);
        inst.staleNodes.add(childId);
        inst.staleDetails.set(childId, {
          nodeId: childId,
          nodeDate: childDateStr || "—",
          parentId: parentId,
          parentDate: parentDateStr || "—",
          isDirect: true,
          reason: "Таблица обновлена раньше, чем родительская. Требуется пересчёт.",
        });
        // Фиксируем ребро как Stale
        inst.staleEdges.add(`${parentId}|${childId}`);
        break; // Достаточно одного более свежего родителя
      }
    }
  });

  // 4. Каскадное распространение Stale вниз по графу потомков (Downstream cascade)
  const q = Array.from(directStale);
  while (q.length > 0) {
    const cur = q.shift();
    const children = childrenMap.get(cur) || [];
    for (const nextId of children) {
      if (!inst.staleNodes.has(nextId)) {
        inst.staleNodes.add(nextId);
        const nextInfo = getTableData(nextId);
        inst.staleDetails.set(nextId, {
          nodeId: nextId,
          nodeDate: nextInfo?.script_updated_at || "—",
          parentId: cur,
          parentDate: getTableData(cur)?.script_updated_at || "—",
          isDirect: false,
          reason: `Ветка устарела: родительский узел ${cur.split('.').pop()} требует пересчёта.`,
        });
        q.push(nextId);
      }
      inst.staleEdges.add(`${cur}|${nextId}`);
    }
  }

  // 5. Визуализация карточек узлов: оранжевая рамка и бейдж '!'
  canvas.querySelectorAll(".ln-node:not(.ln-virtual)").forEach((el) => {
    const id = el.dataset.nodeId;
    if (inst.staleNodes.has(id)) {
      el.classList.add("ln-node-stale");
      if (!el.querySelector(".ln-stale-badge")) {
        const badge = document.createElement("span");
        badge.className = "ln-stale-badge";
        badge.title = "Таблица устарела (требует пересчёта)";
        badge.textContent = "!";
        el.appendChild(badge);
      }
    } else {
      el.classList.remove("ln-node-stale");
      el.querySelector(".ln-stale-badge")?.remove();
    }
  });

  // 6. Визуализация связей: окрашивание путей в оранжевый цвет
  const svg = canvas.querySelector(".lineage-svg");
  if (svg) {
    // Вспомогательная функция проверки принадлежности ребра к stale
    // (учитывает возможные промежуточные vnodes)
    svg.querySelectorAll("path.ln-edge-line").forEach((path) => {
      const src = path.dataset.source;
      const tgt = path.dataset.target;
      if (!src || !tgt) return;

      // Раскрутка реального источника и цели ребра сквозь vnode
      const realSrc = resolveRealNode(src, "up", svg);
      const realTgt = resolveRealNode(tgt, "down", svg);

      if (
        inst.staleEdges.has(`${realSrc}|${realTgt}`) ||
        (inst.staleNodes.has(realSrc) && inst.staleNodes.has(realTgt)) ||
        (inst.staleEdges.has(`${src}|${tgt}`))
      ) {
        path.classList.add("ln-edge-stale");
      } else {
        path.classList.remove("ln-edge-stale");
      }
    });
  }

  // 7. Верхний счетчик проблемных веток
  renderStaleCounter(canvas, uniqueId, inst.staleNodes.size);

  // 8. Легенда справа от чек-бокса "The Time Has Come"
  renderStaleLegend(canvas, uniqueId);
}

/**
 * Раскручивает vnode-цепочку до реального имени таблицы
 */
function resolveRealNode(nodeId, direction, svg) {
  if (!nodeId || !nodeId.startsWith("vnode-")) return nodeId;
  let cur = nodeId;
  let safety = 0;
  while (cur.startsWith("vnode-") && safety++ < 30) {
    const attr = direction === "up" ? "target" : "source";
    const nextAttr = direction === "up" ? "source" : "target";
    const p = svg.querySelector(`path.ln-edge-line[data-${attr}="${cur}"]`);
    if (!p) break;
    cur = p.dataset[nextAttr];
  }
  return cur;
}

/**
 * Очистка визуализации при выключении режима
 */
export function clearStaleAnalysis(canvas, uniqueId) {
  // Скрываем даты на карточках
  canvas.classList.remove("ln-stale-active");

  // Снимаем классы с карточек узлов и удаляем бейджи
  canvas.querySelectorAll(".ln-node").forEach((el) => {
    el.classList.remove("ln-node-stale");
    el.querySelector(".ln-stale-badge")?.remove();
  });

  // Возвращаем обычный цвет связям
  const svg = canvas.querySelector(".lineage-svg");
  if (svg) {
    svg.querySelectorAll("path.ln-edge-line").forEach((p) => {
      p.classList.remove("ln-edge-stale");
    });
  }

  // Удаляем верхний счетчик и легенду
  canvas.querySelector(".ln-stale-counter")?.remove();
  removeStaleLegend(canvas, uniqueId);

  // Закрываем модальное окно, если открыто
  closeStaleModal(uniqueId);
}

/**
 * Отрисовка верхнего счетчика "Найдены устаревшие ветки: N"
 */
function renderStaleCounter(canvas, uniqueId, count) {
  canvas.querySelector(".ln-stale-counter")?.remove();
  if (count <= 0) return;

  const counterEl = document.createElement("div");
  counterEl.className = "ln-stale-counter";
  counterEl.innerHTML = `
    <span class="ln-stale-counter-icon">⚠️</span>
    <span class="ln-stale-counter-text">Найдены устаревшие ветки</span>
    <span class="ln-stale-counter-badge">${count}</span>
  `;
  canvas.appendChild(counterEl);
}

/**
 * Удаление плашки с легендой
 */
function removeStaleLegend(canvas, uniqueId) {
  canvas?.querySelector(".ln-stale-legend")?.remove();
  if (uniqueId) {
    document.getElementById(`stale-legend-${uniqueId}`)?.remove();
    const toggle = document.getElementById(`stale-toggle-${uniqueId}`);
    toggle?.parentNode?.querySelector(".ln-stale-legend")?.remove();
  }
}

/**
 * Отрисовка плашки с легендой справа от переключателя "The Time Has Come"
 */
function renderStaleLegend(canvas, uniqueId) {
  removeStaleLegend(canvas, uniqueId);

  const legendEl = document.createElement("div");
  legendEl.className = "ln-stale-legend";
  if (uniqueId) {
    legendEl.id = `stale-legend-${uniqueId}`;
  }
  legendEl.innerHTML = `
    <div class="ln-stale-legend-item">
      <span class="ln-legend-line ln-legend-line--stale"></span>
      <span class="ln-legend-label">Устаревшая ветка (stale)</span>
    </div>
    <div class="ln-stale-legend-item">
      <span class="ln-legend-line ln-legend-line--normal"></span>
      <span class="ln-legend-label">Обычная ветка</span>
    </div>
    <div class="ln-stale-legend-item">
      <span class="ln-legend-dot-badge">!</span>
      <span class="ln-legend-label">Узел с проблемой (требует пересчёта)</span>
    </div>
  `;

  const toggle = uniqueId ? document.getElementById(`stale-toggle-${uniqueId}`) : null;
  if (toggle && toggle.parentNode) {
    toggle.insertAdjacentElement("afterend", legendEl);
  } else {
    canvas.appendChild(legendEl);
  }
}

/**
 * Открытие всплывающего окна при правом клике на устаревшую таблицу
 */
export function openStaleModal(event, nodeId, uniqueId) {
  const canvas = document.getElementById(`canvas-${uniqueId}`);
  if (!canvas) return;

  const info = getStaleNodeInfo(uniqueId, nodeId);
  if (!info) return;

  closeStaleModal(uniqueId);

  const shortName = nodeId.split(".").pop();
  const parentShortName = info.parentId ? info.parentId.split(".").pop() : "—";
  const nodeDateFormatted = formatCardDate(info.nodeDate);
  const parentDateFormatted = formatCardDate(info.parentDate);

  const modal = document.createElement("div");
  modal.className = "ln-stale-popup";
  modal.id = `stale-modal-${uniqueId}`;

  modal.innerHTML = `
    <div class="ln-stale-popup-header">
      <div class="ln-stale-popup-title">
        <span class="ln-stale-header-icon">⚠️</span>
        <span>Устаревшая ветка</span>
        <span class="ln-stale-pill">Stale</span>
      </div>
      <button class="ln-stale-popup-close" onclick="window.closeStaleModal('${uniqueId}')" title="Закрыть">✕</button>
    </div>
    <div class="ln-stale-popup-body">
      <div class="ln-stale-current-node">
        <div class="ln-stale-node-name">${shortName}</div>
        <div class="ln-stale-node-date">Обновлено: ${nodeDateFormatted}</div>
      </div>
      <div class="ln-stale-parent-info">
        <span class="ln-stale-parent-arrow">↑</span>
        <div class="ln-stale-parent-text">
          <div>Родитель: <strong>${parentShortName}</strong></div>
          <div class="ln-stale-parent-date">Обновлено: ${parentDateFormatted}</div>
        </div>
      </div>
      <div class="ln-stale-warning-box">
        <span class="ln-stale-warning-icon">!</span>
        <span>${info.reason}</span>
      </div>
      <button class="ln-stale-rebuild-btn" type="button" disabled title="Кнопка будет активирована в следующей версии">
        <span class="ln-stale-btn-icon">🔄</span>
        <span>Запустить пересчёт</span>
      </button>
    </div>
  `;

  canvas.appendChild(modal);

  // Закрытие по клику вне окна
  const outsideClickListener = (e) => {
    if (!modal.contains(e.target) && !e.target.closest(".ln-node")) {
      closeStaleModal(uniqueId);
      document.removeEventListener("click", outsideClickListener);
    }
  };
  setTimeout(() => {
    document.addEventListener("click", outsideClickListener);
  }, 50);
}

/**
 * Закрытие окна детализации Stale
 */
export function closeStaleModal(uniqueId) {
  const modal = document.getElementById(`stale-modal-${uniqueId}`);
  modal?.remove();
}
