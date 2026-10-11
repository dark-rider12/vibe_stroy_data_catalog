/*
MODULE: src/lineage/tablePropagation.js
ROLE: Фича «Протянуть таблицу в следующий слой» (Table Propagation).

Пользователь зажимает ЛКМ на заголовке (.cll-header) карточки таблицы,
тянет вправо ≥ 60px и отпускает — появляется диалог создания новой таблицы.

Связь с columnLineagePropagation.js:
  - addPropagatedColumn(), movePropagatedColumn(), removePropagatedColumn(),
    promptColumnAlias(), updateTableCardSqlButtons(), showSqlDiffModal()
    используются без изменений для работы с колонками виртуальной таблицы.
  - generateModifiedSql() получает новую ветку для _isVirtual таблиц (в columnLineagePropagation.js).

Только UI-изменения. Не сохраняется в backend.
*/

import { addPropagatedColumn, showPropagationNotification } from './columnLineagePropagation.js';

// ─── Глобальное состояние ────────────────────────────────────────────────────

if (!window.__tablePropagationState) {
  window.__tablePropagationState = {
    virtualTables: new Map(),   // virtualTableId → tableObject
    drag: {
      active: false,
      parentTableId: null,
      uniqueId: null,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      ghost: null,
      ghostTimer: null,
    },
    colSelection: null,        // Текущая сессия in-card выбора колонок или null
    // Храним Map<uniqueId, cleanupFn[]> для корректной очистки слушателей
    listeners: new Map(),
  };
}

const STATE = window.__tablePropagationState;

// ─── Порог перетаскивания (px) ───────────────────────────────────────────────
const DRAG_THRESHOLD = 60;

// ─── Задержка перед появлением ghost (мс) ────────────────────────────────────
// Ghost создаётся не сразу при нажатии, а только если кнопка удержана чуть дольше.
// Это исключает «мелькание» иконки при обычном клике по заголовку для перехода
// на страницу таблицы.
const GHOST_DELAY_MS = 180;

// ─── Публичное API ───────────────────────────────────────────────────────────

/**
 * Инициализация drag-слушателей на всех .cll-header карточек в pane.
 * Вызывается из renderColumnLineage после рендера HTML.
 *
 * @param {string} uniqueId
 * @param {Function} getTableInfo  - локальная обёртка (уже с поддержкой виртуальных таблиц)
 * @param {Function} rerenderCallback - () => void, вызывается после создания виртуальной таблицы
 * @param {HTMLElement} pane
 */
export function initTablePropagation(uniqueId, getTableInfo, rerenderCallback, pane) {
  // Очищаем старые слушатели и drag-состояние для этого uniqueId.
  // Важно: НЕ вызываем cleanupTablePropagation(), т.к. он удаляет виртуальные
  // таблицы — при rerender после создания новой таблицы они должны сохраниться.
  clearTablePropagationRuntime(uniqueId);

  const cleanups = [];
  STATE.listeners.set(uniqueId, cleanups);

  // Навешиваем на каждый .cll-header в этой панели
  pane.querySelectorAll('.cll-header').forEach(header => {
    const card = header.closest('.cll-card');
    if (!card) return;

    // Извлекаем tableId из id карточки: "cll-card-<uniqueId>-<tableId>"
    const prefix = `cll-card-${uniqueId}-`;
    const tableId = card.id.slice(prefix.length);
    if (!tableId) return;

    const onMouseDown = (e) => {
      // Реагируем только на ЛКМ
      if (e.button !== 0) return;
      // Не перехватываем клики на кнопках внутри заголовка
      if (e.target.closest('button')) return;

      // Останавливаем всплытие, чтобы viewport не начал pan
      e.stopPropagation();

      STATE.drag.active = true;
      STATE.drag.parentTableId = tableId;
      STATE.drag.uniqueId = uniqueId;
      STATE.drag.startX = e.clientX;
      STATE.drag.startY = e.clientY;
      STATE.drag.lastX = e.clientX;
      STATE.drag.lastY = e.clientY;

      // Ghost создаём НЕ сразу, а через короткую задержку — только если кнопка
      // удержана чуть дольше. Быстрый клик по заголовку (переход на страницу
      // таблицы) не должен показывать иконку.
      clearTimeout(STATE.drag.ghostTimer);
      STATE.drag.ghostTimer = setTimeout(() => {
        const ghost = document.createElement('div');
        ghost.className = 'cll-drag-ghost';
        ghost.textContent = '→ Новая таблица';
        ghost.style.left = `${STATE.drag.lastX + 10}px`;
        ghost.style.top  = `${STATE.drag.lastY - 16}px`;
        document.body.appendChild(ghost);
        STATE.drag.ghost = ghost;
      }, GHOST_DELAY_MS);

      document.body.style.userSelect = 'none';
    };

    header.addEventListener('mousedown', onMouseDown);
    cleanups.push(() => header.removeEventListener('mousedown', onMouseDown));

    // Навешиваем клик на кнопку удаления виртуальной таблицы (если есть)
    const delBtn = header.querySelector('.cll-delete-virtual-table-btn');
    if (delBtn) {
      const onDelClick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const vTableId = delBtn.getAttribute('data-table-id');
        if (vTableId) {
          removeVirtualTable(uniqueId, vTableId);
        }
      };
      delBtn.addEventListener('click', onDelClick);
      cleanups.push(() => delBtn.removeEventListener('click', onDelClick));
    }
  });

  // Глобальные обработчики движения и отпускания
  const onMouseMove = (e) => {
    if (!STATE.drag.active || STATE.drag.uniqueId !== uniqueId) return;
    const dx = e.clientX - STATE.drag.startX;

    // Запоминаем текущую позицию для отложенного создания ghost
    STATE.drag.lastX = e.clientX;
    STATE.drag.lastY = e.clientY;

    if (STATE.drag.ghost) {
      STATE.drag.ghost.style.left = `${e.clientX + 10}px`;
      STATE.drag.ghost.style.top  = `${e.clientY - 16}px`;
      // Подсвечиваем ghost когда порог пройден
      STATE.drag.ghost.classList.toggle('cll-drag-ghost-ready', dx >= DRAG_THRESHOLD);
    }
  };

  const onMouseUp = (e) => {
    if (!STATE.drag.active || STATE.drag.uniqueId !== uniqueId) return;

    const dx = e.clientX - STATE.drag.startX;

    // Отменяем отложенное создание ghost (быстрый клик — ghost не появился)
    clearTimeout(STATE.drag.ghostTimer);
    STATE.drag.ghostTimer = null;

    // Убираем ghost
    if (STATE.drag.ghost) {
      STATE.drag.ghost.remove();
      STATE.drag.ghost = null;
    }
    document.body.style.userSelect = '';

    const parentTableId = STATE.drag.parentTableId;
    STATE.drag.active = false;
    STATE.drag.parentTableId = null;
    STATE.drag.uniqueId = null;

    // Только если потянули вправо достаточно
    if (dx >= DRAG_THRESHOLD) {
      showCreateTableDialog(parentTableId, uniqueId, getTableInfo, rerenderCallback);
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  cleanups.push(() => {
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  });
}

/**
 * Очищает только runtime-состояние пропагации (слушатели, drag, сессию выбора
 * колонок) для данного uniqueId, НЕ трогая виртуальные таблицы.
 * Используется в initTablePropagation при rerender, чтобы новая виртуальная
 * таблица не была удалена из состояния сразу после создания.
 */
function clearTablePropagationRuntime(uniqueId) {
  // Чистим сессию выбора колонок если она принадлежит этому uniqueId
  if (STATE.colSelection && STATE.colSelection.uniqueId === uniqueId) {
    exitColumnSelectionMode();
  }

  const cleanups = STATE.listeners.get(uniqueId);
  if (cleanups) {
    cleanups.forEach(fn => fn());
    STATE.listeners.delete(uniqueId);
  }
  // Если ghost завис — убираем
  if (STATE.drag.uniqueId === uniqueId) {
    clearTimeout(STATE.drag.ghostTimer);
    STATE.drag.ghostTimer = null;
    if (STATE.drag.ghost) { STATE.drag.ghost.remove(); STATE.drag.ghost = null; }
    STATE.drag.active = false;
    STATE.drag.parentTableId = null;
    STATE.drag.uniqueId = null;
    document.body.style.userSelect = '';
  }
}

/**
 * Очищает слушателей, drag-состояние и виртуальные таблицы данного uniqueId.
 * Также откатывает патч downstream у родительских таблиц.
 */
export function cleanupTablePropagation(uniqueId) {
  clearTablePropagationRuntime(uniqueId);
  // Удаляем виртуальные таблицы этой вкладки и откатываем downstream-патч
  STATE.virtualTables.forEach((info, id) => {
    if (info._ownedBy === uniqueId) {
      // Откатываем downstream у родителя
      const parentInfo = window.catalogData
        && (() => {
          const p = (info._propagatedFrom || '').split('.');
          return p.length === 3 ? window.catalogData[p[0]]?.[p[1]]?.[p[2]] : null;
        })();
      if (parentInfo?.lineage?.downstream) {
        const idx = parentInfo.lineage.downstream.indexOf(id);
        if (idx !== -1) parentInfo.lineage.downstream.splice(idx, 1);
      }
      STATE.virtualTables.delete(id);
    }
  });
}

/**
 * Возвращает Map всех виртуальных таблиц.
 */
export function getVirtualTables() {
  return STATE.virtualTables;
}

// ─── Вспомогательные функции: слои и схемы ──────────────────────────────────

// Порядок слоёв DWH
const LAYER_ORDER = ['ods', 'dds', 'dm'];

/**
 * Возвращает { defaultDb, allowedDbs } для дочерней таблицы.
 * Правила:
 *   - allowedDbs = [parentDb] + [nextLayerDb] (если есть)
 *   - defaultDb  = nextLayerDb (если есть), иначе parentDb
 */
function getLayerOptions(parentDb) {
  const idx = LAYER_ORDER.indexOf(parentDb.toLowerCase());
  const allowedDbs = [parentDb.toLowerCase()];
  let defaultDb = parentDb.toLowerCase();
  if (idx >= 0 && idx < LAYER_ORDER.length - 1) {
    const next = LAYER_ORDER[idx + 1];
    allowedDbs.push(next);
    defaultDb = next;
  }
  return { defaultDb, allowedDbs };
}

/**
 * Возвращает список схем для данной БД из window.catalogData (кроме public).
 */
function getSchemasForDb(db) {
  const dbData = window.catalogData?.[db];
  if (!dbData) return ['core'];
  const schemas = Object.keys(dbData).filter(s => s !== 'public' && s !== 'CorpusName');
  return schemas.length > 0 ? schemas : ['core'];
}

/**
 * Создаёт пару select-элементов (db, schema) с логикой зависимости.
 * Возвращает { dbSelect, schemaSelect, getFullPrefix }.
 */
function buildDbSchemaSelects(parentDb, containerEl) {
  const { defaultDb, allowedDbs } = getLayerOptions(parentDb);

  // ── DB select ──
  const dbSelect = document.createElement('select');
  dbSelect.className = 'tpd-db-select';
  allowedDbs.forEach(db => {
    const opt = document.createElement('option');
    opt.value = db;
    opt.textContent = db;
    if (db === defaultDb) opt.selected = true;
    dbSelect.appendChild(opt);
  });

  // ── Schema select ──
  const schemaSelect = document.createElement('select');
  schemaSelect.className = 'tpd-schema-select';

  function refreshSchemas() {
    const db = dbSelect.value;
    const schemas = getSchemasForDb(db);
    schemaSelect.innerHTML = '';
    schemas.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (s === 'core') opt.selected = true;
      schemaSelect.appendChild(opt);
    });
  }
  refreshSchemas();
  dbSelect.addEventListener('change', refreshSchemas);

  // Dot separator
  const dot1 = document.createElement('span');
  dot1.className = 'tpd-select-dot';
  dot1.textContent = '.';
  const dot2 = document.createElement('span');
  dot2.className = 'tpd-select-dot';
  dot2.textContent = '.';

  containerEl.appendChild(dbSelect);
  containerEl.appendChild(dot1);
  containerEl.appendChild(schemaSelect);
  containerEl.appendChild(dot2);

  return {
    dbSelect,
    schemaSelect,
    getFullPrefix: () => `${dbSelect.value}.${schemaSelect.value}`,
  };
}

// ─── Диалог создания таблицы ─────────────────────────────────────────────────

/**
 * Показывает диалог «Создать новую таблицу».
 *
 * @param {string} parentTableId
 * @param {string} uniqueId
 * @param {Function} getTableInfo
 * @param {Function} rerenderCallback
 */
export function showCreateTableDialog(parentTableId, uniqueId, getTableInfo, rerenderCallback) {
  // Чистим предыдущую сессию in-card выбора если была
  exitColumnSelectionMode();

  // Закрываем предыдущий диалог если есть
  document.querySelector('.table-propagation-overlay')?.remove();

  const parentInfo = getTableInfo(parentTableId);
  const parentColumns = parentInfo?.columns || [];
  // Полный id родителя для заголовка
  const parentParts = parentTableId.split('.');
  const parentDb     = parentParts[0] || 'dwh';
  const parentSchema = parentParts[1] || '';
  const parentName   = parentParts[parentParts.length - 1];
  const parentFullDisplay = parentParts.length >= 2 ? parentTableId : parentName;

  // ── Overlay ──────────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'table-propagation-overlay';

  // ── Dialog ───────────────────────────────────────────────────────────────
  const dialog = document.createElement('div');
  dialog.className = 'table-propagation-dialog';

  dialog.innerHTML = `
    <div class="tpd-header">
      <div class="tpd-title">Новая таблица из <span class="tpd-parent-name">${parentFullDisplay}</span></div>
      <button class="tpd-close-btn" title="Закрыть">&times;</button>
    </div>
    <div class="tpd-body">
      <label class="tpd-label">Имя новой таблицы</label>
      <div class="tpd-name-row"></div>
      <div class="tpd-name-error" style="display:none;"></div>

      <div class="tpd-cols-header">
        <label class="tpd-label" style="margin-bottom:0;">Колонки</label>
        <label class="tpd-all-cols-label">
          <input type="checkbox" class="tpd-all-cols-cb" checked>
          Протянуть все колонки
        </label>
      </div>

      <div class="tpd-type-select" style="display:none;">
        <span class="tpd-type-label">Тип таблицы</span>
        <label class="tpd-type-option">
          <input type="radio" name="tpd-table-type" value="dimension" checked>
          Измерения
        </label>
        <label class="tpd-type-option">
          <input type="radio" name="tpd-table-type" value="fact">
          Факты
        </label>
      </div>

      <div class="tpd-col-select" style="display:none;">
        <div class="tpd-col-list"></div>
        <div class="tpd-col-count"></div>
      </div>
    </div>
    <div class="tpd-footer">
      <button class="tpd-cancel-btn">Отмена</button>
      <button class="tpd-create-btn">Создать</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // ── Строим db/schema selects + name input ────────────────────────────────
  const nameRow   = dialog.querySelector('.tpd-name-row');
  const { dbSelect, schemaSelect, getFullPrefix } = buildDbSchemaSelects(parentDb, nameRow);

  // ── Выбор типа таблицы (Факты/Измерения) — виден только для БД dds ──────
  const typeSelect = dialog.querySelector('.tpd-type-select');
  function toggleTypeSelect() {
    typeSelect.style.display = dbSelect.value.toLowerCase() === 'dds' ? '' : 'none';
  }
  toggleTypeSelect();
  dbSelect.addEventListener('change', toggleTypeSelect);

  const nameInput = document.createElement('input');
  nameInput.className = 'tpd-name-input';
  nameInput.type = 'text';
  nameInput.placeholder = 'table_name';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameRow.appendChild(nameInput);

  // ── Ссылки на элементы ────────────────────────────────────────────────────
  const nameError    = dialog.querySelector('.tpd-name-error');
  const allColsCb    = dialog.querySelector('.tpd-all-cols-cb');
  const colSelect    = dialog.querySelector('.tpd-col-select');
  const colList      = dialog.querySelector('.tpd-col-list');
  const colCount     = dialog.querySelector('.tpd-col-count');
  const createBtn    = dialog.querySelector('.tpd-create-btn');
  const cancelBtn    = dialog.querySelector('.tpd-cancel-btn');
  const closeBtn     = dialog.querySelector('.tpd-close-btn');

  // Фокус на поле имени сразу
  setTimeout(() => nameInput.focus(), 50);

  // ── Список колонок ─────────────────────────────────────────────────────────
  const colCheckboxes = new Map();

  if (parentColumns.length > 0) {
    parentColumns.forEach(col => {
      const item = document.createElement('label');
      item.className = 'tpd-col-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tpd-col-cb';
      cb.checked = false;
      cb.value = col.name;
      colCheckboxes.set(col.name, cb);
      cb.addEventListener('change', updateColCount);

      const span = document.createElement('span');
      span.textContent = col.name;

      item.appendChild(cb);
      item.appendChild(span);
      colList.appendChild(item);
    });
  } else {
    colList.innerHTML = '<div class="tpd-no-cols">У родительской таблицы нет колонок</div>';
  }

  function updateColCount() {
    const selected = Array.from(colCheckboxes.values()).filter(cb => cb.checked).length;
    colCount.textContent = `Выбрано: ${selected} из ${parentColumns.length}`;
  }
  updateColCount();

  // ── Чекбокс «все колонки» ─────────────────────────────────────────────────
  allColsCb.addEventListener('change', () => {
    if (allColsCb.checked) {
      colSelect.style.display = 'none';
    } else {
      // Закрываем диалог → встраиваем чекбоксы в карточку
      const enteredTableName = nameInput.value.trim();
      const enteredName = enteredTableName ? `${getFullPrefix()}.${enteredTableName}` : '';
      closeDialog();
      const tableType = dialog.querySelector('input[name="tpd-table-type"]:checked')?.value || 'dimension';
      enterColumnSelectionMode(parentTableId, uniqueId, getTableInfo, rerenderCallback, enteredName, parentDb, tableType);
    }
  });

  // ── Валидация имени (только table_name часть) ─────────────────────────────
  function validateName(value) {
    const trimmed = value.trim();
    if (!trimmed) return 'Введите имя таблицы';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
      return 'Только латинские буквы, цифры и _';
    }
    return null;
  }

  nameInput.addEventListener('input', () => {
    nameError.style.display = 'none';
    nameError.textContent = '';
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createBtn.click(); }
    if (e.key === 'Escape') { closeDialog(); }
  });

  function closeDialog() { overlay.remove(); }

  closeBtn.onclick = closeDialog;
  cancelBtn.onclick = closeDialog;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });

  // ── Создать ────────────────────────────────────────────────────────────────
  createBtn.onclick = () => {
    const rawName = nameInput.value;
    const err = validateName(rawName);
    if (err) {
      nameError.textContent = err;
      nameError.style.display = '';
      nameInput.focus();
      return;
    }

    let selectedColumns;
    if (allColsCb.checked) {
      selectedColumns = parentColumns.map(c => c.name);
    } else {
      selectedColumns = Array.from(colCheckboxes.entries())
        .filter(([, cb]) => cb.checked)
        .map(([name]) => name);
      if (selectedColumns.length === 0) {
        showPropagationNotification('Выберите хотя бы одну колонку', true);
        return;
      }
    }

    // Собираем полный id: db.schema.table_name
    const fullTableName = `${getFullPrefix()}.${rawName.trim()}`;
    const tableType = dialog.querySelector('input[name="tpd-table-type"]:checked')?.value || 'dimension';
    closeDialog();
    createVirtualTable(uniqueId, parentTableId, fullTableName, selectedColumns, getTableInfo, rerenderCallback, tableType);
  };
}

// ─── Создание виртуальной таблицы ────────────────────────────────────────────

/**
 * Создаёт виртуальную таблицу, регистрирует в состоянии и запускает rerender.
 *
 * @param {string} uniqueId
 * @param {string} parentTableId  - полный ID "db.schema.name"
 * @param {string} tableName      - имя, введённое пользователем (schema.table или db.schema.table)
 * @param {string[]} selectedColumns - имена колонок из родительской таблицы
 * @param {Function} getTableInfo
 * @param {Function} rerenderCallback
 * @param {string} tableType - тип новой таблицы ('dimension' | 'fact')
 */
export function createVirtualTable(uniqueId, parentTableId, tableName, selectedColumns, getTableInfo, rerenderCallback, tableType) {
  // ── Нормализуем имя до db.schema.name ─────────────────────────────────────
  // tableName всегда приходит как db.schema.table_name из нового диалога
  // Поддерживаем и старый формат для обратной совместимости
  const parts = uniqueId.split('-');
  const defaultDb = parts[0] || 'dwh';
  const defaultSchema = parts[1] || 'core';

  const nameParts = tableName.split('.');
  let virtualTableId;
  if (nameParts.length === 3) {
    virtualTableId = tableName.toLowerCase();
  } else if (nameParts.length === 2) {
    virtualTableId = `${defaultDb}.${tableName}`.toLowerCase();
  } else {
    virtualTableId = `${defaultDb}.${defaultSchema}.${tableName}`.toLowerCase();
  }

  // Проверяем уникальность
  if (STATE.virtualTables.has(virtualTableId) || getTableInfo(virtualTableId)) {
    showPropagationNotification(`Таблица "${virtualTableId}" уже существует`, true);
    return;
  }

  const parentInfo = getTableInfo(parentTableId);
  const allParentCols = parentInfo?.columns || [];

  // Создаём объект виртуальной таблицы
  const virtualTable = {
    columns: [],
    lineage: {
      upstream: [parentTableId],
      downstream: [],
    },
    sql_script: '',
    sql_script_extra: '',
    sources: '',
    description: '',
    column_lineage: {},
    _isVirtual: true,
    _propagatedFrom: parentTableId,
    _selectedColumns: selectedColumns,
    _tableType: tableType || 'dimension',
    _ownedBy: uniqueId,
  };

  STATE.virtualTables.set(virtualTableId, virtualTable);

  // Обновляем downstream у родителя (в виртуальном слое — только для lineage визуализации)
  if (parentInfo) {
    if (!parentInfo.lineage) parentInfo.lineage = { upstream: [], downstream: [] };
    if (!parentInfo.lineage.downstream) parentInfo.lineage.downstream = [];
    if (!parentInfo.lineage.downstream.includes(virtualTableId)) {
      parentInfo.lineage.downstream.push(virtualTableId);
    }
  }

  showPropagationNotification(
    `Таблица "${virtualTableId.split('.').pop()}" создана — протягиваем колонки…`,
    false
  );

  // Запускаем rerender — после него добавим колонки
  rerenderCallback(virtualTableId, parentTableId, selectedColumns);
}

/**
 * Удаляет виртуальную таблицу, чистит состояния пропагации и запускает перерисовку.
 */
export function removeVirtualTable(uniqueId, virtualTableId, rerenderCallback) {
  const info = STATE.virtualTables.get(virtualTableId);
  if (!info) return;

  // Откатываем downstream у родителя
  const parentId = info._propagatedFrom;
  if (parentId) {
    const pParts = parentId.split('.');
    const parentInfo = window.catalogData
      && pParts.length === 3 ? window.catalogData[pParts[0]]?.[pParts[1]]?.[pParts[2]] : null;
    if (parentInfo?.lineage?.downstream) {
      const idx = parentInfo.lineage.downstream.indexOf(virtualTableId);
      if (idx !== -1) parentInfo.lineage.downstream.splice(idx, 1);
    }
  }

  // Очищаем пропагированные колонки этой таблицы из PROPAGATION_STATE
  if (window.__propagationState?.propagatedColumns) {
    const propagatedSet = window.__propagationState.propagatedColumns.get(uniqueId);
    if (propagatedSet) {
      const prefix = virtualTableId.toLowerCase() + '.';
      for (const k of Array.from(propagatedSet)) {
        if (k.startsWith(prefix)) {
          propagatedSet.delete(k);
        }
      }
    }
  }
  // Очищаем рёбра проброса, связанные с удалённой таблицей
  if (window.__propagationState?.propagationEdges) {
    for (const [edgeKey, edgeInfo] of window.__propagationState.propagationEdges.entries()) {
      if (edgeInfo.uniqueId === uniqueId && edgeInfo.childTableId === virtualTableId) {
        window.__propagationState.propagationEdges.delete(edgeKey);
      }
    }
  }

  // Удаляем таблицу из состояния
  STATE.virtualTables.delete(virtualTableId);

  showPropagationNotification(`Виртуальная таблица "${virtualTableId.split('.').pop()}" удалена`, false);

  // Триггерим событие обновления / ререндер
  const event = new CustomEvent('propagation-update', {
    detail: { uniqueId, reason: 'table-removed', virtualTableId },
  });
  document.dispatchEvent(event);
}

window.__removeVirtualTable = (uniqueId, virtualTableId) => {
  removeVirtualTable(uniqueId, virtualTableId);
};

// ─── Режим выбора колонок прямо в карточке ───────────────────────────────────

/**
 * Активирует режим выбора колонок в родительской карточке:
 * - Убирает диалог
 * - Вставляет чекбоксы слева от каждой колонки в карточке родителя
 * - Показывает плавающую панель подтверждения рядом с карточкой
 *
 * @param {string} parentTableId
 * @param {string} uniqueId
 * @param {Function} getTableInfo
 * @param {Function} rerenderCallback
 * @param {string} enteredName - предварительно введённое пользователем имя новой таблицы
 * @param {string} parentDb - БД родительской таблицы
 * @param {string} tableType - тип новой таблицы ('dimension' | 'fact')
 */
function enterColumnSelectionMode(parentTableId, uniqueId, getTableInfo, rerenderCallback, enteredName, parentDb, tableType) {
  // Чистим предыдущую сессию если есть
  exitColumnSelectionMode();

  const card = document.getElementById(`cll-card-${uniqueId}-${parentTableId}`);
  if (!card) {
    showPropagationNotification('Не найдена карточка родительской таблицы', true);
    return;
  }

  const parentInfo = getTableInfo(parentTableId);
  const parentColumns = parentInfo?.columns || [];

  // Сохраняем состояние выбора
  const session = {
    active: true,
    uniqueId,
    parentTableId,
    getTableInfo,
    rerenderCallback,
    enteredName: enteredName || '',
    tableType: tableType || 'dimension',
    columnEls: [],   // [{ el, colName, cb }]
    panel: null,     // плавающая панель подтверждения
    panelRemoveListener: null,
  };
  STATE.colSelection = session;

  // ── Вставляем чекбоксы в каждую реальную колонку (не aggregate) ──
  const columnContainer = card.querySelector('.cll-columns');
  if (!columnContainer) {
    showPropagationNotification('Нет контейнера колонок в карточке родителя', true);
    STATE.colSelection = null;
    return;
  }

  card.classList.add('cll-card-col-select');

  const colEls = columnContainer.querySelectorAll('.cll-column:not(.cll-aggregate)');
  colEls.forEach(colEl => {
    const colName = colEl.getAttribute('data-col-name');
    if (!colName || colName === '*') return;

    colEl.classList.add('cll-column-has-checkbox');

    const cbWrap = document.createElement('span');
    cbWrap.className = 'cll-column-checkbox-wrap';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'cll-column-checkbox';
    cb.value = colName;
    cb.checked = false;
    cb.addEventListener('click', (e) => {
      // Останавливаем всплытие чтобы не триггерить клик по колонке (выделение рёбер)
      e.stopPropagation();
    });
    cb.addEventListener('change', () => {
      updateFloatingPanelCount();
    });

    cbWrap.appendChild(cb);
    // prepend чтобы чекбокс был слева от текста колонки
    colEl.insertBefore(cbWrap, colEl.firstChild);

    session.columnEls.push({ el: colEl, colName, cb });
  });

  // ── Создаём плавающую панель подтверждения ──
  const panel = document.createElement('div');
  panel.className = 'cll-col-select-panel';
  panel.innerHTML = `
    <div class="ccs-header">
      <div class="ccs-title">Новая таблица</div>
      <button class="ccs-close-btn" title="Отмена">&times;</button>
    </div>
    <div class="ccs-body">
      <label class="ccs-label">Имя таблицы</label>
      <div class="ccs-name-row"></div>
      <div class="ccs-name-error" style="display:none;"></div>
      <div class="ccs-count"></div>
    </div>
    <div class="ccs-footer">
      <button class="ccs-cancel-btn">Отмена</button>
      <button class="ccs-confirm-btn">Создать</button>
    </div>
  `;
  document.body.appendChild(panel);
  session.panel = panel;

  // Позиционируем панель справа от карточки родителя
  positionFloatingPanel(panel, card);

  // Строим db/schema selects в floating panel
  const ccsNameRow = panel.querySelector('.ccs-name-row');
  const effectiveParentDb = parentDb || (parentTableId.split('.')[0] || 'dwh');
  const { dbSelect: ccsDbSel, schemaSelect: ccsSchemaSel, getFullPrefix: ccsGetPrefix } =
    buildDbSchemaSelects(effectiveParentDb, ccsNameRow);

  const nameInput = document.createElement('input');
  nameInput.className = 'ccs-name-input';
  nameInput.type = 'text';
  nameInput.placeholder = 'table_name';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  ccsNameRow.appendChild(nameInput);

  const nameError  = panel.querySelector('.ccs-name-error');
  const countEl    = panel.querySelector('.ccs-count');
  const confirmBtn = panel.querySelector('.ccs-confirm-btn');
  const cancelBtn  = panel.querySelector('.ccs-cancel-btn');
  const closeBtn   = panel.querySelector('.ccs-close-btn');

  // Если из диалога передали частичное имя — разбираем и предзаполняем
  if (enteredName) {
    const ep = enteredName.split('.');
    if (ep.length >= 3) {
      // db.schema.table — пытаемся выставить select-ы
      const eDb = ep[0], eSchema = ep[1], eTable = ep.slice(2).join('.');
      [...ccsDbSel.options].forEach(o => { if (o.value === eDb) o.selected = true; });
      ccsDbSel.dispatchEvent(new Event('change'));
      [...ccsSchemaSel.options].forEach(o => { if (o.value === eSchema) o.selected = true; });
      nameInput.value = eTable;
    } else {
      nameInput.value = ep[ep.length - 1] || enteredName;
    }
  }

  function updateFloatingPanelCount() {
    const selected = session.columnEls.filter(x => x.cb.checked).length;
    const total = session.columnEls.length;
    countEl.textContent = `Выбрано колонок: ${selected} из ${total}`;
  }
  updateFloatingPanelCount();

  // Валидация только table_name части
  function validateName(value) {
    const trimmed = value.trim();
    if (!trimmed) return 'Введите имя таблицы';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
      return 'Только латинские буквы, цифры и _';
    }
    return null;
  }

  nameInput.addEventListener('input', () => {
    nameError.style.display = 'none';
    nameError.textContent = '';
  });

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmBtn.click(); }
    if (e.key === 'Escape') { exitColumnSelectionMode(); }
  });

  closeBtn.onclick = () => exitColumnSelectionMode();
  cancelBtn.onclick = () => exitColumnSelectionMode();

  confirmBtn.onclick = () => {
    const rawName = nameInput.value;
    const err = validateName(rawName);
    if (err) {
      nameError.textContent = err;
      nameError.style.display = '';
      nameInput.focus();
      return;
    }

    const selectedColumns = session.columnEls
      .filter(x => x.cb.checked)
      .map(x => x.colName);

    if (selectedColumns.length === 0) {
      showPropagationNotification('Выберите хотя бы одну колонку', true);
      return;
    }

    const fullTableName = `${ccsGetPrefix()}.${rawName.trim()}`;
    exitColumnSelectionMode();
    createVirtualTable(uniqueId, parentTableId, fullTableName, selectedColumns, getTableInfo, rerenderCallback, session.tableType);
  };

  // Если пользователь ререндерит lineage (например, переключает режим) — чистим сессию
  // Также отслеживаем клик по overlay части, чтобы отмена работала по ESC
  const onKeyDown = (e) => {
    if (e.key === 'Escape' && STATE.colSelection === session) {
      exitColumnSelectionMode();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  session.panelRemoveListener = onKeyDown;
}

/**
 * Завершает режим выбора колонок в карточке:
 * - Удаляет чекбоксы из колонок
 * - Удаляет плавающую панель
 * - Снимает класс-маркер с карточки
 * - Очищает STATE.colSelection
 */
function exitColumnSelectionMode() {
  const session = STATE.colSelection;
  if (!session || !session.active) {
    STATE.colSelection = null;
    return;
  }

  session.active = false;

  // Убираем чекбоксы из DOM
  session.columnEls.forEach(({ el, cb }) => {
    el.classList.remove('cll-column-has-checkbox');
    const wrap = el.querySelector('.cll-column-checkbox-wrap');
    if (wrap) wrap.remove();
  });

  // Убираем класс-маркер с карточки
  const card = document.getElementById(`cll-card-${session.uniqueId}-${session.parentTableId}`);
  if (card) card.classList.remove('cll-card-col-select');

  // Убираем панель
  if (session.panel && session.panel.parentNode) {
    session.panel.remove();
  }

  // Убираем глобальный слушатель ESC
  if (session.panelRemoveListener) {
    window.removeEventListener('keydown', session.panelRemoveListener);
  }

  STATE.colSelection = null;
}

/**
 * Позиционирует плавающую панель подтверждения справа от карточки родителя,
 * учитывая текущий viewport. Не хватает места справа — показывает слева.
 */
function positionFloatingPanel(panel, anchorCard) {
  // Первый проход — вставляем без координат чтобы получить размеры панели
  panel.style.visibility = 'hidden';
  panel.style.left = '0px';
  panel.style.top  = '0px';

  // Планируем на следующий тик, чтобы размеры посчитались
  requestAnimationFrame(() => {
    const cardRect = anchorCard.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const GAP = 16;

    let left = cardRect.right + GAP;
    // Если не влезает справа — размещаем слева
    if (left + panelRect.width > window.innerWidth - 16) {
      left = cardRect.left - panelRect.width - GAP;
      // Если и слева не влезает — прижимаем к правому краю вьюпорта
      if (left < 16) left = window.innerWidth - panelRect.width - 16;
    }

    let top = cardRect.top;
    // Если панель выше чем карточка или вылезает снизу — центрируем или прижимаем
    if (top + panelRect.height > window.innerHeight - 16) {
      top = window.innerHeight - panelRect.height - 16;
    }
    if (top < 16) top = 16;

    panel.style.left = `${left}px`;
    panel.style.top  = `${top}px`;
    panel.style.visibility = 'visible';
  });
}

