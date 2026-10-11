/*
MODULE: src/lineage/columnLineagePropagation.js
ROLE: Логика фичи проброса добавления колонок в Column Lineage.

Содержит:
- Проверку условий проброса
- Контекстное меню с кнопкой и чекбоксами
- Добавление колонок в дочерние таблицы
- Управление временными рёбрами
- Перемещение колонок
- Оповещения

Только UI изменения, без сохранения в backend.
*/

import { sanitizeId, TECHNICAL_FIELDS } from "../utils/helpers.js";

// Проверяет, принадлежит ли таблица базе данных dds
function isDdsTable(tableId) {
  if (!tableId) return false;
  return tableId.split('.')[0].toLowerCase() === 'dds';
}

// Проверяет, принадлежит ли таблица базе данных ods
function isOdsTable(tableId) {
  if (!tableId) return false;
  return tableId.split('.')[0].toLowerCase() === 'ods';
}

/**
 * Получает объект таблицы из window.catalogData по полному ID "db.schema.name"
 * @param {string} tableId - полный ID таблицы
 * @returns {Object|null} объект таблицы или null
 */
function getCatalogTableInfo(tableId) {
  if (!tableId) return null;
  const parts = tableId.split('.');
  if (parts.length < 3) return null;
  return window.catalogData?.[parts[0]]?.[parts[1]]?.[parts.slice(2).join('.')];
}

/**
 * Получает system_id из source_system_map по префиксу ODS-таблицы.
 * system_id хранится только для систем-источников (ODS-слой), поэтому если
 * родительская таблица не из ODS (например, DDS→DDS), поднимаемся по lineage
 * вверх (upstream), пока не найдём таблицу ODS с префиксом из справочника.
 * Префикс — буквы до первого _ в имени таблицы.
 * @param {string} parentTableId - ID таблицы, с которой начали (например, 'dds.core.account_detail')
 * @returns {string|null} значение system_id или null
 */
function getSourceSystemId(parentTableId) {
  const sourceMap = window.catalogData?.source_system_map;
  if (!sourceMap) return null;

  const visited = new Set();
  const queue = [parentTableId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.toLowerCase())) continue;
    visited.add(current.toLowerCase());

    const parts = current.split('.');
    // system_id ищем только по префиксу ODS-таблиц
    if (parts[0] && parts[0].toLowerCase() === 'ods') {
      const tableName = parts[parts.length - 1];
      const prefix = tableName.split('_')[0].toLowerCase();
      const entry = sourceMap[prefix];
      if (entry && entry.system_id != null) {
        return entry.system_id;
      }
    }

    // Префикс не найден — поднимаемся в upstream
    const info = getCatalogTableInfo(current);
    const upstream = info?.lineage?.upstream || [];
    upstream.forEach(up => queue.push(up));
  }

  console.warn(`[ID Button] No system_id found in ODS prefix chain starting at ${parentTableId}`);
  return null;
}

/**
 * Генерирует выражение хэша для колонки ID
 * @param {string} uniqueId - ID вкладки
 * @param {string} childTableId - ID дочерней таблицы
 * @param {string} columnName - имя колонки
 * @param {string} columnKey - ключ колонки
 * @param {string} tableId - ID таблицы (для совместимости)
 * @param {string} parentTableId - ID родительской таблицы
 * @param {HTMLElement} columnEl - DOM элемент колонки
 */
function generateIdHashExpression(uniqueId, childTableId, columnName, columnKey, tableId, parentTableId, columnEl) {
  // Получаем system_id для родительской таблицы
  const systemId = getSourceSystemId(parentTableId);
  
  if (!systemId) {
    showPropagationNotification('Не удалось найти system_id для родительской таблицы в dds.core.ref_source_system', true);
    return;
  }

  // Спрашиваем пользователя, какое название колонки использовать перед _id
  const userPrefix = prompt('Введите название колонки (без _id):', columnName);
  
  if (!userPrefix || userPrefix.trim() === '') {
    return; // Пользователь отменил
  }

  const prefix = userPrefix.trim();
  const alias = `${prefix}_id`;
  const variable1 = columnName;
  const variable2 = systemId;

  // Формируем выражение
  const expression = `uuid_generate_v5(uuid_nil(), uuid_generate_v5(uuid_nil(), ${variable2}::text)::text ||'-'|| ${variable1}::text)`;

  // Сохраняем выражение и алиас
  PROPAGATION_STATE.columnExpressions.set(columnKey, {
    expression,
    alias
  });

  // Обновляем отображение колонки
  columnEl.setAttribute('data-col-alias', alias);
  columnEl.setAttribute('data-col-expression', expression);
  columnEl.childNodes[0].nodeValue = `${columnName} → ${alias}`;

  // Дополнительное действие: если кнопка ID нажата в первой колонке созданной
  // (виртуальной) таблицы и родительское поле называется id — протягиваем исходное
  // поле второй раз с псевдонимом <prefix>_cd (id системы-источника из слоя ods).
  let cdAlias = null;
  if (columnName.toLowerCase() === 'id' && isFirstColumnInCard(columnEl)) {
    cdAlias = addSourceIdCopyColumn(uniqueId, childTableId, columnName, parentTableId, columnEl, `${prefix}_cd`);
  }

  // Уведомляем о необходимости перерисовки SQL
  document.dispatchEvent(new CustomEvent('propagation-update', {
    detail: { uniqueId, reason: 'expression-added' }
  }));

  showPropagationNotification(
    cdAlias
      ? `Хэш-ID сгенерирован: ${alias}, исходный id: ${cdAlias}`
      : `Хэш-ID сгенерирован: ${alias}`,
    false
  );
}

/**
 * Проверяет, является ли колонка первой в карточке таблицы (по порядку .cll-column).
 * @param {HTMLElement} columnEl - DOM элемент колонки
 * @returns {boolean}
 */
function isFirstColumnInCard(columnEl) {
  const container = columnEl?.closest('.cll-columns');
  if (!container) return false;
  const first = container.querySelector('.cll-column:not(.cll-aggregate)');
  return !!first && first === columnEl;
}

/**
 * Протягивает исходное поле родителя (id системы-источника) в созданную таблицу
 * второй раз с псевдонимом <cdAlias> (например <prefix>_cd). Колонка вставляется
 * сразу после колонки, на которой была нажата кнопка ID.
 *
 * @param {string} uniqueId - ID вкладки
 * @param {string} childTableId - ID созданной (виртуальной) таблицы
 * @param {string} parentFieldName - имя исходного поля родителя (например 'id')
 * @param {string} parentTableId - ID родительской таблицы
 * @param {HTMLElement} anchorColumnEl - колонка, на которой нажали кнопку ID
 * @param {string} cdAlias - имя новой колонки (например 'account_cd')
 * @returns {string|null} имя добавленной колонки или null (если колонка уже существует)
 */
function addSourceIdCopyColumn(uniqueId, childTableId, parentFieldName, parentTableId, anchorColumnEl, cdAlias) {
  const cdColumnEl = addPropagatedColumn(uniqueId, childTableId, { name: cdAlias }, parentTableId);
  if (!cdColumnEl) return null;

  // Вставляем сразу после колонки, на которой нажали кнопку ID
  anchorColumnEl.after(cdColumnEl);

  // Прописываем выражение: если родитель из ODS и поле id — приводим к varchar
  const isOds = isOdsTable(parentTableId);
  const expression = (isOds && parentFieldName.toLowerCase() === 'id')
    ? `${parentFieldName}::varchar`
    : parentFieldName;

  const cdKey = `${childTableId}.${cdAlias.toLowerCase()}`;
  PROPAGATION_STATE.columnExpressions.set(cdKey, {
    expression,
    alias: cdAlias,
  });
  cdColumnEl.setAttribute('data-col-alias', cdAlias);
  cdColumnEl.setAttribute('data-col-expression', expression);
  cdColumnEl.childNodes[0].nodeValue = `${parentFieldName} → ${cdAlias}`;
  cdColumnEl.title = `Исходный id системы-источника (${parentFieldName}) из ${parentTableId}`;

  // Перенаправляем ребро проброса: линия строится от исходной колонки родителя
  // (id) к новой колонке (<cdAlias>) — для поиска колонок используем разные имена:
  //   columnName      = 'id'      → колонка родителя
  //   childColumnName = <cdAlias> → колонка потомка
  const edgeKey = `prop-${parentTableId}-${childTableId}-${cdAlias.toLowerCase()}`;
  const edge = PROPAGATION_STATE.propagationEdges.get(edgeKey);
  if (edge) {
    edge.columnName = parentFieldName;
    edge.childColumnName = cdAlias;
  }

  return cdAlias;
}

/**
 * Набор технических полей DDS-таблиц.
 * При протягивании DDS→DDS эти колонки родителя НЕ копируются 1:1,
 * а заново создаются через addTechnicalColumns с константными значениями.
 */
const TECHNICAL_FIELD_NAMES = new Set([
  'source_system_id',
  'is_active',
  'is_deleted',
  'dwh_start_date',
  'dwh_end_date',
  'etl_process_id'
]);

/**
 * Проверяет, является ли имя колонки техническим полем DDS.
 * @param {string} name - имя колонки
 * @returns {boolean}
 */
export function isTechnicalFieldName(name) {
  return !!name && TECHNICAL_FIELD_NAMES.has(String(name).toLowerCase());
}

/**
 * Отфильтровывает технические поля DDS из списка колонок.
 * @param {string[]} columns - имена колонок
 * @returns {string[]} колонки без технических полей
 */
export function filterTechnicalColumns(columns) {
  return (columns || []).filter(name => !isTechnicalFieldName(name));
}

/**
 * Возвращает набор технических полей для протянутой таблицы DDS.
 * Для variable2 (system_id) используется та же логика, что и в кнопке ID.
 * @param {string} tableType - 'dimension' | 'fact'
 * @param {string} systemId - system_id системы-источника
 * @returns {Array<{name: string, expression: string}>|null}
 */
function getTechnicalFieldsForType(tableType, systemId) {
  if (!systemId) return null;
  const sourceSystemId = {
    name: 'source_system_id',
    expression: `uuid_generate_v5(uuid_nil(), ${systemId}::text)`
  };
  const etlProcessId = {
    name: 'etl_process_id',
    expression: 'uuid_generate_v5(uuid_nil(), 1::text)'
  };

  if (tableType === 'fact') {
    return [sourceSystemId, etlProcessId];
  }
  // dimension (по умолчанию)
  return [
    sourceSystemId,
    { name: 'is_active', expression: 'true' },
    { name: 'is_deleted', expression: 'false' },
    { name: 'dwh_start_date', expression: "'1900-01-01 23:59:59.999'::timestamp" },
    { name: 'dwh_end_date', expression: "'9999-12-31 23:59:59.999'::timestamp" },
    etlProcessId
  ];
}

/**
 * Добавляет технические поля в протянутую DDS-таблицу в конце списка колонок.
 * Использует тип таблицы (Факты/Измерения), выбранный в диалоге Table Propagation.
 * @param {string} uniqueId - ID вкладки
 * @param {string} childTableId - ID новой (виртуальной) таблицы
 * @param {string} parentTableId - ID родительской таблицы
 * @param {string} tableType - 'dimension' | 'fact'
 */
export function addTechnicalColumns(uniqueId, childTableId, parentTableId, tableType) {
  if (!isDdsTable(childTableId)) return;

  const systemId = getSourceSystemId(parentTableId);
  if (!systemId) {
    showPropagationNotification('Не удалось найти system_id для технических полей: dds.core.ref_source_system', true);
    return;
  }

  const fields = getTechnicalFieldsForType(tableType, systemId);
  if (!fields) return;

  const childCard = document.getElementById(`cll-card-${uniqueId}-${childTableId}`);
  const columnsContainer = childCard?.querySelector('.cll-columns');

  fields.forEach((field) => {
    const columnEl = addPropagatedColumn(uniqueId, childTableId, { name: field.name }, parentTableId);
    if (!columnEl) return;

    // Технические поля — всегда в конце списка колонок, независимо от позиции в родителе
    if (columnsContainer) columnsContainer.appendChild(columnEl);

    const columnKey = `${childTableId}.${field.name.toLowerCase()}`;
    // Технические поля не являются колонками родителя — убираем лишнее ребро
    const edgeKey = `prop-${parentTableId}-${childTableId}-${field.name.toLowerCase()}`;
    PROPAGATION_STATE.propagationEdges.delete(edgeKey);

    // Сохраняем выражение и алиас для генерации SQL
    PROPAGATION_STATE.columnExpressions.set(columnKey, {
      expression: field.expression,
      alias: field.name
    });
  });

  // Уведомляем о необходимости перерисовки SQL
  document.dispatchEvent(new CustomEvent('propagation-update', {
    detail: { uniqueId, reason: 'technical-fields-added' }
  }));
}

// Состояние проброса - сбрасывается при перезагрузке страницы
if (!window.__propagationState) {
  window.__propagationState = {
    propagatedColumns: new Map(), // Map<uniqueId, Set<columnKey>>
    propagationEdges: new Map(),   // Map<edgeKey, pathInfo>
    columnAliases: new Map(),      // Map<columnKey, string>
    columnExpressions: new Map(),  // Map<columnKey, {expression, alias}>
    menuElement: null,
    currentMenuTarget: null,
  };
}

const PROPAGATION_STATE = window.__propagationState;
if (!PROPAGATION_STATE.columnAliases) {
  PROPAGATION_STATE.columnAliases = new Map();
}
if (!PROPAGATION_STATE.columnExpressions) {
  PROPAGATION_STATE.columnExpressions = new Map();
}

/**
 * Запрашивает алиас для колонки у пользователя
 */
export function promptColumnAlias(uniqueId, childTableId, columnName, columnEl) {
  const columnKey = `${childTableId}.${columnName.toLowerCase()}`;
  const currentAlias = PROPAGATION_STATE.columnAliases.get(columnKey) || '';
  const newAlias = prompt(`Задайте алиас для колонки "${columnName}" (в таблице ${childTableId.split('.').pop()}):`, currentAlias);

  if (newAlias !== null) {
    const trimmed = newAlias.trim();
    if (trimmed) {
      PROPAGATION_STATE.columnAliases.set(columnKey, trimmed);
      columnEl.setAttribute('data-col-alias', trimmed);
      columnEl.childNodes[0].nodeValue = `${columnName} AS ${trimmed}`;
    } else {
      PROPAGATION_STATE.columnAliases.delete(columnKey);
      columnEl.removeAttribute('data-col-alias');
      columnEl.childNodes[0].nodeValue = columnName;
    }

    const event = new CustomEvent('propagation-update', {
      detail: { uniqueId, reason: 'alias-updated' },
    });
    document.dispatchEvent(event);
  }
}

/**
 * Преобразует ссылку на родительскую таблицу в секции FROM.
 * Начинает всегда с database/ext_*.
 * - Если targetDb === parentDb: parentSchema.tableName
 * - Если targetDb !== parentDb: ext_schema.tableName
 */
function formatFromTableReference(parentTableId, childTableId) {
  if (!parentTableId) return '';
  const pParts = parentTableId.split('.');
  const cParts = childTableId ? childTableId.split('.') : [];

  const parentDb     = pParts[0] || '';
  const parentSchema = pParts[1] || '';
  const tableName    = pParts.slice(2).join('.') || pParts[pParts.length - 1];

  const childDb = cParts[0] || parentDb;

  // Если слои (БД) совпадают: childDb.parentSchema.tableName
  if (parentDb.toLowerCase() === childDb.toLowerCase()) {
    return `${childDb}.${parentSchema}.${tableName}`;
  }

  // Если слои разборные (кросс-базовый запрос через foreign tables ext_*): childDb.ext_schema.tableName
  // Маппинг известная схема → ext_название
  if (parentDb.toLowerCase() === 'ods' && parentSchema.toLowerCase() === 'core') {
    return `${childDb}.ext_ods.${tableName}`;
  }
  if (parentDb.toLowerCase() === 'dds' && parentSchema.toLowerCase() === 'core') {
    return `${childDb}.ext_dds.${tableName}`;
  }
  if (parentDb.toLowerCase() === 'dds' && parentSchema.toLowerCase() === 'calc') {
    return `${childDb}.ext_calc.${tableName}`;
  }

  // Динамический fallback для остальных схем при переходе между слоями
  return `${childDb}.ext_${parentSchema}.${tableName}`;
}

/**
 * Генерирует изменённый SQL-скрипт дочерней таблицы с учётом протянутых колонок.
 * Использует полный скрипт (sql_script + sql_script_extra), как во вкладке «Скрипт».
 * Новые колонки вставляются в SELECT в той позиции, в которой они находятся в карточке lineage.
 * Стиль запятых (leading/trailing) определяется автоматически по оригинальному скрипту.
 * 
 * @returns {{ sql: string, hasDuplicates: boolean, duplicateNames: string[] }}
 */
export function generateModifiedSql(childTableId, getTableInfo, uniqueId) {
  console.log(`[DEBUG generateModifiedSql] START childTableId=${childTableId} uniqueId=${uniqueId}`);
  const info = getTableInfo(childTableId);
  const propagatedSet = PROPAGATION_STATE.propagatedColumns.get(uniqueId);
  const hasPropagated = propagatedSet && Array.from(propagatedSet).some(k => k.startsWith(childTableId.toLowerCase() + '.'));
  console.log(`[DEBUG generateModifiedSql] info=${!!info} isVirtual=${!!(info?._isVirtual)} hasScript=${!!(info?.sql_script)} hasPropagated=${hasPropagated}`);

  // ── Ветка для виртуальных таблиц или таблиц с пропогированными колонками ────────────
  // Генерируем CREATE TABLE ... AS SELECT с нуля.
  if (info?._isVirtual || (hasPropagated && !info?.sql_script)) {
    console.log(`[DEBUG generateModifiedSql] propagatedSet size=${propagatedSet?.size || 0}`);
    const addedColumns = [];
    const childCard = document.getElementById(`cll-card-${uniqueId}-${childTableId}`);
    console.log(`[DEBUG generateModifiedSql] childCard found=${!!childCard} id=${childCard?.id || 'N/A'}`);
    if (propagatedSet) {
      const prefix = childTableId.toLowerCase() + '.';
      if (childCard) {
        const cols = childCard.querySelectorAll('.cll-column');
        console.log(`[DEBUG generateModifiedSql] DOM columns count=${cols.length} names=[${Array.from(cols).map(el => el.getAttribute('data-col-name')).join(', ')}]`);
        childCard.querySelectorAll('.cll-column').forEach(el => {
          const colName = el.getAttribute('data-col-name');
          if (!colName) return;
          const columnKey = `${childTableId}.${colName.toLowerCase()}`;
          if (propagatedSet.has(columnKey)) {
            const expressionData = PROPAGATION_STATE.columnExpressions.get(columnKey);
            if (expressionData) {
              addedColumns.push({ colName, alias: expressionData.alias, expression: expressionData.expression });
            } else {
              const alias = PROPAGATION_STATE.columnAliases.get(columnKey);
              addedColumns.push({ colName, alias });
            }
          }
        });
      } else {
        console.log(`[DEBUG generateModifiedSql] USING FALLBACK`);
        // Fallback: берём из Set в порядке вставки
        propagatedSet.forEach(columnKey => {
          if (columnKey.startsWith(prefix)) {
            const colName = columnKey.slice(prefix.length);
            const expressionData = PROPAGATION_STATE.columnExpressions.get(columnKey);
            if (expressionData) {
              addedColumns.push({ colName, alias: expressionData.alias, expression: expressionData.expression });
            } else {
              const alias = PROPAGATION_STATE.columnAliases.get(columnKey);
              addedColumns.push({ colName, alias });
            }
          }
        });
      }
    }

    console.log(`[DEBUG generateModifiedSql] addedColumns count=${addedColumns.length}`);
    if (addedColumns.length === 0) {
      console.log(`[DEBUG generateModifiedSql] RETURNING EMPTY SQL`);
      return { sql: '', hasDuplicates: false, duplicateNames: [] };
    }

    // Для виртуальной таблицы parentTableId из info._propagatedFrom, иначе из data-propagated-from первой колонки в DOM
    const parentCol = childCard?.querySelector('.cll-column[data-propagated="true"]');
    const parentTableId = info?._propagatedFrom || parentCol?.getAttribute('data-propagated-from') || '';
    
    // Форматирование таблицы в FROM с учётом foreign tables (ext_*)
    const fromTableRef = formatFromTableReference(parentTableId, childTableId);

    const colLines = addedColumns.map((item, idx) => {
      // Если есть выражение, используем его
      if (item.expression) {
        const expr = item.alias ? `${item.expression} AS ${item.alias}` : item.expression;
        const comma = idx < addedColumns.length - 1 ? ',' : '';
        return `    ${expr}${comma}`;
      }
      // Иначе обычная колонка с алиасом
      const expr = item.alias ? `${item.colName} AS ${item.alias}` : item.colName;
      const comma = idx < addedColumns.length - 1 ? ',' : '';
      return `    ${expr}${comma}`;
    });

    const createSql =
      `CREATE TABLE ${childTableId} AS\nSELECT\n${colLines.join('\n')}\nFROM ${fromTableRef};`;

    // COMMENT ON COLUMN для технических полей — внизу через пропущенную строку
    const techComments = addedColumns
      .filter(item => TECHNICAL_FIELD_NAMES.has(String(item.colName).toLowerCase()))
      .map(item => `COMMENT ON COLUMN ${childTableId}.${item.colName} IS '${(TECHNICAL_FIELDS[item.colName.toLowerCase()] || '').replace(/'/g, "''")}';`);

    const sql = techComments.length > 0
      ? `${createSql}\n\n${techComments.join('\n')}`
      : createSql;

    return { sql, hasDuplicates: false, duplicateNames: [] };
  }
  // ── Обычная ветка ────────────────────────────────────────────────────────

  // Полный скрипт = sql_script + (разделитель) + sql_script_extra — как во вкладке «Скрипт»
  const mainScript = (info?.sql_script || '').trim();
  const extraScript = (info?.sql_script_extra || '').trim();
  const fullScript = mainScript && extraScript
    ? mainScript + '\n\n\n' + extraScript
    : mainScript || extraScript;

  if (!fullScript) return { sql: '', hasDuplicates: false, duplicateNames: [] };

  if (!propagatedSet || propagatedSet.size === 0) {
    return { sql: fullScript, hasDuplicates: false, duplicateNames: [] };
  }

  // Собираем протянутые колонки для этой таблицы
  const addedColumnsForTable = [];
  propagatedSet.forEach(columnKey => {
    const prefix = childTableId.toLowerCase() + '.';
    if (columnKey.startsWith(prefix)) {
      const colName = columnKey.slice(prefix.length);
      const expressionData = PROPAGATION_STATE.columnExpressions.get(columnKey);
      if (expressionData) {
        addedColumnsForTable.push({ colName, alias: expressionData.alias, expression: expressionData.expression });
      } else {
        const alias = PROPAGATION_STATE.columnAliases.get(columnKey);
        addedColumnsForTable.push({ colName, alias });
      }
    }
  });

  if (addedColumnsForTable.length === 0) {
    return { sql: fullScript, hasDuplicates: false, duplicateNames: [] };
  }

  // --- Определяем порядок колонок из DOM карточки ---
  const childCard = document.getElementById(`cll-card-${uniqueId}-${childTableId}`);
  const domOrder = []; // [{colName (lower), isPropagated}]
  if (childCard) {
    childCard.querySelectorAll('.cll-column').forEach(el => {
      const name = el.getAttribute('data-col-name');
      const isPropagated = el.getAttribute('data-propagated') === 'true';
      if (name) domOrder.push({ colName: name.toLowerCase(), isPropagated });
    });
  }

  // insertBeforeMap: propColName (lower) → nextOriginalColName (lower) | null
  const insertBeforeMap = new Map();
  domOrder.forEach((item, idx) => {
    if (!item.isPropagated) return;
    let nextOriginal = null;
    for (let i = idx + 1; i < domOrder.length; i++) {
      if (!domOrder[i].isPropagated) { nextOriginal = domOrder[i].colName; break; }
    }
    insertBeforeMap.set(item.colName, nextOriginal);
  });

  // --- Проверяем дубликаты ---
  const selectMatch = mainScript.match(/SELECT\s+([\s\S]+?)(?:\s+FROM\s)/i);
  const originalColNames = new Set();
  if (selectMatch) {
    selectMatch[1].split(',').forEach(expr => {
      const trimmed = expr.trim();
      const asMatch = trimmed.match(/\bAS\s+(\w+)\s*$/i);
      if (asMatch) { originalColNames.add(asMatch[1].toLowerCase()); }
      else { const lw = trimmed.match(/(\w+)\s*$/); if (lw) originalColNames.add(lw[1].toLowerCase()); }
    });
  }
  const duplicateNames = addedColumnsForTable
    .map(item => {
      const eff = item.alias ? item.alias.toLowerCase() : item.colName.toLowerCase();
      return originalColNames.has(eff) ? (item.alias || item.colName) : null;
    })
    .filter(Boolean);

  // --- Определяем стиль запятых ---
  // leading  = ", col"  (запятая в начале строки)
  // trailing = "col,"   (запятая в конце строки)
  const fromMatch = mainScript.match(/(\s+FROM\s+)/i);
  if (!fromMatch) {
    return { sql: fullScript, hasDuplicates: duplicateNames.length > 0, duplicateNames };
  }

  const fromIndex = fromMatch.index;
  const selectBlock = mainScript.slice(0, fromIndex);
  const fromAndAfter = mainScript.slice(fromIndex);

  const selectLines = selectBlock.split('\n');
  let leadingCount = 0, trailingCount = 0;
  selectLines.forEach(line => {
    const t = line.trim();
    if (t.startsWith(',')) leadingCount++;
    if (t.endsWith(',')) trailingCount++;
  });
  const useLeading = leadingCount >= trailingCount;

  // --- Вспомогательные функции ---
  // Найти строку в массиве, содержащую colName как целое слово
  const findLineIdx = (lines, colNameLower) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (new RegExp(`\\b${colNameLower}\\b`, 'i').test(lines[i])) return i;
    }
    return -1;
  };

  // Вспомогательная функция: найти индекс первой реальной колонки SELECT
  // (первая непустая, не-SELECT, не-комментарий строка после "SELECT")
  const findFirstColumnIdx = (lines) => {
    let pastSelect = false;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!pastSelect) {
        if (/^SELECT\b/i.test(t)) { pastSelect = true; }
        continue;
      }
      if (t && !t.startsWith('--')) return i;
    }
    return -1;
  };

  // --- Вставляем колонки в правильном порядке (по DOM сверху вниз) ---
  const resultLines = [...selectLines];
  let offset = 0;

  const sortedAdded = [...addedColumnsForTable].sort((a, b) => {
    const posA = domOrder.findIndex(d => d.colName === a.colName.toLowerCase() && d.isPropagated);
    const posB = domOrder.findIndex(d => d.colName === b.colName.toLowerCase() && d.isPropagated);
    return posA - posB;
  });

  sortedAdded.forEach(item => {
    // Формируем выражение: если есть кастомное выражение, используем его, иначе обычная колонка
    const expr = item.expression
      ? (item.alias ? `${item.expression} AS ${item.alias}` : item.expression)
      : (item.alias ? `${item.colName} AS ${item.alias}` : item.colName);
    const nextOriginal = insertBeforeMap.get(item.colName.toLowerCase());

    if (nextOriginal) {
      const lineIdx = findLineIdx(resultLines, nextOriginal);
      if (lineIdx >= 0) {
        const adjustedIdx = lineIdx + offset;
        if (useLeading) {
          // Проверяем: является ли nextOriginal первой колонкой SELECT?
          const firstColIdx = findFirstColumnIdx(resultLines);
          if (adjustedIdx === firstColIdx) {
            // Новая колонка становится первой → без запятой
            // Старая первая колонка должна получить запятую в начале
            const oldFirstLine = resultLines[adjustedIdx];
            const oldFirstTrimmed = oldFirstLine.trim();
            if (!oldFirstTrimmed.startsWith(',')) {
              // Добавляем ведущую запятую к старой первой строке
              resultLines[adjustedIdx] = oldFirstLine.replace(/^(\s*)/, '$1, ');
            }
            resultLines.splice(adjustedIdx, 0, `    ${expr}`);
          } else {
            // Обычный случай: вставляем «, expr» перед строкой nextOriginal
            resultLines.splice(adjustedIdx, 0, `    , ${expr}`);
          }
        } else {
          // trailing-стиль: новая строка идёт ПЕРЕД nextOriginal,
          // значит после неё есть следующая колонка → она должна иметь запятую
          resultLines.splice(adjustedIdx, 0, `    ${expr},`);
        }
        offset++;
        return;
      }
    }

    // Вставка в конец SELECT-блока (перед FROM) — новая колонка станет последней
    if (useLeading) {
      resultLines.push(`    , ${expr}`);
    } else {
      // trailing-стиль: предпоследняя колонка уже имеет запятую (она была последней),
      // добавляем запятую к ней, новая строка — последняя, без запятой
      for (let i = resultLines.length - 1; i >= 0; i--) {
        const t = resultLines[i].trim();
        if (t && !t.startsWith('--')) {
          if (!t.endsWith(',')) resultLines[i] = resultLines[i].replace(/\s+$/, '') + ',';
          break;
        }
      }
      resultLines.push(`    ${expr}`);
    }
  });

  const modifiedMainSql = resultLines.join('\n') + fromAndAfter;

  // Собираем полный скрипт: модифицированный main + оригинальный extra
  const finalSql = extraScript
    ? modifiedMainSql + '\n\n\n' + extraScript
    : modifiedMainSql;

  return { sql: finalSql, hasDuplicates: duplicateNames.length > 0, duplicateNames };
}

/**
 * Отображает модальное окно с подсвеченными новыми строками SQL
 */
export function showSqlDiffModal(childTableId, uniqueId, getTableInfo) {
  const { sql: modifiedSql, hasDuplicates, duplicateNames } = generateModifiedSql(childTableId, getTableInfo, uniqueId);
  const tableName = childTableId.split('.').pop();

  const overlay = document.createElement('div');
  overlay.className = 'sql-diff-overlay';

  const modal = document.createElement('div');
  modal.className = 'sql-diff-modal';

  const header = document.createElement('div');
  header.className = 'sql-diff-header';

  const headerTitle = document.createElement('div');
  headerTitle.innerHTML = `
    <div class="sql-diff-header-title">Обновленный SQL: ${tableName}</div>
    <div class="sql-diff-header-subtitle">Новые добавленные колонки подсвечены зелёным цветом со знаком +</div>
  `;

  const headerActions = document.createElement('div');
  headerActions.className = 'sql-diff-header-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'sql-diff-copy-btn';
  copyBtn.textContent = '📋 Скопировать SQL';
  if (hasDuplicates) {
    // Кнопка заблокирована — скрипт некорректен
    copyBtn.disabled = true;
    copyBtn.title = `Нельзя скопировать: конфликт имён (${duplicateNames.join(', ')})`;
  } else {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(modifiedSql);
      showPropagationNotification('Новый SQL-скрипт скопирован в буфер обмена!', false);
    };
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'sql-diff-close-btn';
  closeBtn.innerHTML = '&times;';

  headerActions.appendChild(copyBtn);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerTitle);
  header.appendChild(headerActions);

  // Баннер предупреждения о дубликатах
  if (hasDuplicates) {
    const dupBanner = document.createElement('div');
    dupBanner.className = 'sql-diff-dup-banner';
    dupBanner.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      Конфликт имён: колонки <b>${duplicateNames.join(', ')}</b> уже существуют в таблице. Скрипт выдаст ошибку при выполнении.
    `;
    modal.appendChild(header);
    modal.appendChild(dupBanner);
  } else {
    modal.appendChild(header);
  }

  const content = document.createElement('div');
  content.className = 'sql-diff-content';

  const lines = modifiedSql.split('\n');

  // Строим set выражений протянутых колонок для быстрого поиска при подсветке
  const propagatedSet = PROPAGATION_STATE.propagatedColumns.get(uniqueId);
  const addedExprs = new Set();
  if (propagatedSet) {
    const prefix = childTableId.toLowerCase() + '.';
    propagatedSet.forEach(columnKey => {
      if (columnKey.startsWith(prefix)) {
        const colName = columnKey.slice(prefix.length);
        const expressionData = PROPAGATION_STATE.columnExpressions.get(columnKey);
        if (expressionData) {
          addedExprs.add((expressionData.alias
            ? `${expressionData.expression} AS ${expressionData.alias}`
            : expressionData.expression).toLowerCase());
        } else {
          const alias = PROPAGATION_STATE.columnAliases.get(columnKey);
          addedExprs.add((alias ? `${colName} AS ${alias}` : colName).toLowerCase());
        }
      }
    });
  }

  const codeLinesHtml = lines.map((line) => {
    // Строка добавленная, если её содержимое (без пробелов и запятых) совпадает с одним из выражений
    const trimmed = line.trim().replace(/^,\s*/, '').replace(/,$/, '').trim();
    const isAdded = addedExprs.has(trimmed.toLowerCase());

    const cleanLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (isAdded) {
      return `<div class="sql-diff-line sql-diff-line--added">+ ${cleanLine}</div>`;
    }
    return `<div class="sql-diff-line">${cleanLine}</div>`;
  }).join('');

  content.innerHTML = `<pre class="sql-diff-pre">${codeLinesHtml}</pre>`;

  modal.appendChild(content);
  overlay.appendChild(modal);

  const closeModal = () => overlay.remove();
  header.querySelector('.sql-diff-close-btn').onclick = closeModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  document.body.appendChild(overlay);
}

/**
 * Обновляет индикатор/кнопку "Новый SQL" в шапке карточек таблиц.
 * Если для таблицы больше нет протянутых колонок — убирает кнопку.
 */
export function updateTableCardSqlButtons(uniqueId, getTableInfo) {
  const propagatedSet = PROPAGATION_STATE.propagatedColumns.get(uniqueId);
  console.log(`[DEBUG updateTableCardSqlButtons] propagatedSet size=${propagatedSet?.size || 0}`);

  // Убираем SQL-кнопки с карточек, у которых больше нет протянутых колонок
  document.querySelectorAll(`[id^="cll-card-${uniqueId}-"] .cll-sql-view-btn`).forEach(btn => {
    const card = btn.closest('[id^="cll-card-"]');
    if (!card) return;
    // Извлекаем tableId из id карточки: "cll-card-<uniqueId>-<tableId>"
    const prefix = `cll-card-${uniqueId}-`;
    const tableId = card.id.slice(prefix.length);
    const hasPropagated = propagatedSet && Array.from(propagatedSet).some(k => k.startsWith(tableId.toLowerCase() + '.'));
    if (!hasPropagated) btn.remove();
  });

  if (!propagatedSet || propagatedSet.size === 0) return;

  const countByTable = new Map();
  propagatedSet.forEach(columnKey => {
    const parts = columnKey.split('.');
    if (parts.length >= 2) {
      const tableId = parts.slice(0, -1).join('.');
      countByTable.set(tableId, (countByTable.get(tableId) || 0) + 1);
    }
  });

  console.log(`[DEBUG updateTableCardSqlButtons] tables: ${JSON.stringify(Object.fromEntries(countByTable))}`);
  countByTable.forEach((count, childTableId) => {
    const childCard = document.getElementById(`cll-card-${uniqueId}-${childTableId}`);
    if (!childCard) return;

    const header = childCard.querySelector('.cll-header');
    if (!header) return;

    // Проверяем наличие дубликатов для индикации на кнопке
    console.log(`[DEBUG updateTableCardSqlButtons] processing table=${childTableId}`);
    const { hasDuplicates } = generateModifiedSql(childTableId, getTableInfo, uniqueId);

    let sqlBtn = header.querySelector('.cll-sql-view-btn');
    if (!sqlBtn) {
      sqlBtn = document.createElement('button');
      sqlBtn.className = 'cll-sql-view-btn';
      sqlBtn.onclick = (e) => {
        e.stopPropagation();
        console.log(`[DEBUG SQL BUTTON CLICK] table=${childTableId} uniqueId=${uniqueId}`);
        showSqlDiffModal(childTableId, uniqueId, getTableInfo);
      };
      header.appendChild(sqlBtn);
    }

    if (hasDuplicates) {
      sqlBtn.textContent = `⚠️ Новый SQL (+${count})`;
      sqlBtn.classList.add('cll-sql-view-btn--error');
      sqlBtn.classList.remove('cll-sql-view-btn--ok');
      sqlBtn.title = 'Конфликт имён колонок — скрипт содержит ошибку';
    } else {
      sqlBtn.textContent = `📜 Новый SQL (+${count})`;
      sqlBtn.classList.add('cll-sql-view-btn--ok');
      sqlBtn.classList.remove('cll-sql-view-btn--error');
      sqlBtn.title = '';
    }
  });
}

/**
 * Добавляет пропагированную колонку в DOM
 */
export function addPropagatedColumn(uniqueId, childTableId, columnInfo, parentTableId) {
  const childCard = document.getElementById(`cll-card-${uniqueId}-${childTableId}`);
  if (!childCard) {
    console.warn(`[Propagation] Карточка таблицы ${childTableId} не найдена`);
    return null;
  }

  const columnsContainer = childCard.querySelector('.cll-columns');
  if (!columnsContainer) {
    console.warn(`[Propagation] Контейнер колонок не найден`);
    return null;
  }

  const columnName = columnInfo.name;
  const columnKey = `${childTableId}.${columnName.toLowerCase()}`;
  const propagatedId = generatePropagatedColumnId(uniqueId, childTableId, columnName);
  const edgeKey = generateEdgeKey(parentTableId, childTableId, columnName);
  const safeColumnName = sanitizeId(columnName);

  // Проверяем, не добавлена ли уже
  if (PROPAGATION_STATE.propagatedColumns.get(uniqueId)?.has(columnKey)) {
    return null;
  }

  // Создаём элемент колонки
  const columnEl = document.createElement('div');
  columnEl.className = 'cll-column cll-column-propagated';
  columnEl.id = `cll-col-${uniqueId}-${childTableId}-${safeColumnName}-prop`;
  columnEl.setAttribute('data-col-key', columnKey);
  columnEl.setAttribute('data-table-id', childTableId);
  columnEl.setAttribute('data-col-name', columnName);
  columnEl.setAttribute('data-propagated', 'true');
  columnEl.setAttribute('data-propagated-from', parentTableId);
  columnEl.setAttribute('data-unique-id', uniqueId);
  columnEl.textContent = columnName;
  columnEl.title = `Проброшено из ${parentTableId}`;

  // Добавляем кнопки редактирования алиаса и удаления
  const controls = document.createElement('div');
  controls.className = 'cll-column-propagated-controls';

  const editBtn = document.createElement('button');
  editBtn.className = 'cll-prop-move-btn cll-prop-edit-alias';
  editBtn.innerHTML = '✏️';
  editBtn.title = 'Задать/изменить алиас колонки';
  editBtn.onclick = (e) => {
    e.stopPropagation();
    promptColumnAlias(uniqueId, childTableId, columnName, columnEl);
  };

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'cll-prop-move-btn cll-prop-delete';
  deleteBtn.innerHTML = '✕';
  deleteBtn.title = 'Удалить протянутую колонку';
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    removePropagatedColumn(uniqueId, columnKey);
    PROPAGATION_STATE.propagationEdges.delete(edgeKey);
    document.dispatchEvent(new CustomEvent('propagation-update', {
      detail: { uniqueId, reason: 'column-removed' },
    }));
  };

  // Кнопка ID — только для таблиц в DDS
  if (isDdsTable(childTableId)) {
    const idBtn = document.createElement('button');
    idBtn.className = 'cll-prop-move-btn cll-prop-id';
    idBtn.innerHTML = '🆔';
    idBtn.title = 'Сгенерировать хэш-ID';
    idBtn.onclick = (e) => {
      e.stopPropagation();
      generateIdHashExpression(uniqueId, childTableId, columnName, columnKey, childTableId, parentTableId, columnEl);
    };
    controls.appendChild(idBtn);
    controls.appendChild(editBtn);
    controls.appendChild(deleteBtn);
  } else {
    controls.appendChild(editBtn);
    controls.appendChild(deleteBtn);
  }

  columnEl.appendChild(controls);

  // Drag-and-drop для перемещения колонки
  let isDragging = false;
  let lastMoveTime = 0;
  let cooldown = 150;

  columnEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    isDragging = true;
    lastMoveTime = 0;
    columnEl.classList.add('cll-column-dragging');
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
  });

  function handleDragMove(e) {
    if (!isDragging) return;
    e.preventDefault();
    e.stopPropagation();
    
    const now = Date.now();
    if (now - lastMoveTime < cooldown) return;
    
    const mouseY = e.clientY;
    const colRect = columnEl.getBoundingClientRect();
    const colCenter = colRect.top + colRect.height / 2;
    const mouseToColDelta = mouseY - colCenter;
    const colHeight = colRect.height;
    
    const currentBefore = columnEl.previousElementSibling;
    const currentAfter = columnEl.nextElementSibling;
    
    let moved = false;
    
    if (currentBefore && mouseToColDelta < -colHeight / 2) {
      movePropagatedColumn(columnEl, 'up');
      moved = true;
    }
    else if (currentAfter && mouseToColDelta > colHeight / 2) {
      movePropagatedColumn(columnEl, 'down');
      moved = true;
    }
    
    if (moved) {
      lastMoveTime = now;
      const uniqueId = columnEl.getAttribute('data-unique-id');
      if (uniqueId) {
        document.dispatchEvent(new CustomEvent('propagation-update', {
          detail: { uniqueId, reason: 'column-moved' },
        }));
      }
    }
  }

  function handleDragEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    columnEl.classList.remove('cll-column-dragging');
    document.removeEventListener('mousemove', handleDragMove);
    document.removeEventListener('mouseup', handleDragEnd);
  }

  // Показываем controls при hover
  columnEl.addEventListener('mouseenter', () => {
    controls.style.opacity = '1';
  });
  columnEl.addEventListener('mouseleave', () => {
    controls.style.opacity = '0';
  });

  // Клик по копии — трассировка подсветки как для обычной колонки
  columnEl.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    columnEl.dispatchEvent(new CustomEvent('cll-propagated-column-click', {
      bubbles: true,
      detail: { tableId: childTableId, columnName },
    }));
  });

  // Определяем позицию вставки, соответствующую положению колонки в родительской таблице
  const parentColId = `cll-col-${uniqueId}-${parentTableId}-${safeColumnName}`;
  const parentColEl = document.getElementById(parentColId) || 
    document.querySelector(`[data-table-id="${parentTableId}"][data-col-name="${columnName}"]`);

  let insertIdx = -1;
  if (parentColEl && parentColEl.parentElement) {
    const parentCols = Array.from(parentColEl.parentElement.querySelectorAll('.cll-column:not(.cll-aggregate)'));
    const pIdx = parentCols.indexOf(parentColEl);
    if (pIdx !== -1) {
      insertIdx = pIdx;
    }
  }

  const childCols = Array.from(columnsContainer.querySelectorAll('.cll-column:not(.cll-aggregate)'));
  if (insertIdx >= 0 && insertIdx < childCols.length) {
    columnsContainer.insertBefore(columnEl, childCols[insertIdx]);
  } else {
    columnsContainer.appendChild(columnEl);
  }

  // Сохраняем состояние
  if (!PROPAGATION_STATE.propagatedColumns.has(uniqueId)) {
    PROPAGATION_STATE.propagatedColumns.set(uniqueId, new Set());
  }
  PROPAGATION_STATE.propagatedColumns.get(uniqueId).add(columnKey);
  console.log(`[DEBUG addPropagatedColumn] table=${childTableId} col=${columnName} key=${columnKey}`);

  // Сохраняем информацию о ребре
  PROPAGATION_STATE.propagationEdges.set(edgeKey, {
    parentTableId,
    childTableId,
    columnName,
    uniqueId,
  });

  return columnEl;
}

/**
 * Проверяет условия для проброса в дочернюю таблицу
 * @param {string} tableId - полный ID таблицы "db.schema.name"
 * @param {Function} getTableInfo - функция получения информации о таблице
 * @returns {Object} { canPropagate: boolean, reason?: string }
 */
export function checkPropagationConditions(tableId, getTableInfo) {
  const info = getTableInfo(tableId);
  if (!info) {
    return { canPropagate: false, reason: "Таблица не найдена" };
  }

  // Условие 1: только один родитель
  const upstream = info.lineage?.upstream || [];
  if (upstream.length !== 1) {
    return { 
      canPropagate: false, 
      reason: `Количество родителей: ${upstream.length} (требуется ровно 1)` 
    };
  }

  // Виртуальные таблицы (созданные через Table Propagation) не имеют скрипта
  // в sql_inventory — их SQL генерируется с нуля через «Новый SQL»
  // (generateModifiedSql), поэтому условия 2 и 3 к ним неприменимы.
  if (!info._isVirtual) {
    // Условие 2: есть скрипт в sql_inventory
    const hasScript = info.sql_script && info.sql_script.trim().length > 0;
    if (!hasScript) {
      return { canPropagate: false, reason: "Нет скрипта в sql_inventory" };
    }

    // Условие 3: нет GROUP BY в скрипте
    const hasGroupBy = /GROUP\s+BY/i.test(info.sql_script);
    if (hasGroupBy) {
      return { canPropagate: false, reason: "Скрипт содержит GROUP BY" };
    }
  }

  return { canPropagate: true };
}

/**
 * Поиск подходящих дочерних таблиц для проброса
 * @param {string} parentTableId - ID родительской таблицы
 * @param {Function} getTableInfo - функция получения информации
 * @returns {Array<{tableId: string, tableInfo: Object}>} Список подходящих дочерних таблиц
 */
export function findEligibleChildren(parentTableId, getTableInfo) {
  const eligible = [];
  
  // Получаем информацию о родительской таблице
  const parentInfo = getTableInfo(parentTableId);
  if (!parentInfo || !parentInfo.lineage?.downstream) {
    return eligible;
  }

  // Проверяем всех потомков
  for (const childTableId of parentInfo.lineage.downstream) {
    const result = checkPropagationConditions(childTableId, getTableInfo);
    if (result.canPropagate) {
      eligible.push({
        tableId: childTableId,
        tableInfo: getTableInfo(childTableId),
      });
    }
  }

  return eligible;
}

/**
 * Показывает оповещение
 * @param {string} message - текст сообщения
 * @param {boolean} isError - true для ошибки (красный), false для информации (зелёный)
 */
export function showPropagationNotification(message, isError = true) {
  // Удаляем существующие оповещения
  const existing = document.querySelector('.propagation-notification');
  if (existing) {
    existing.remove();
  }

  const notification = document.createElement('div');
  notification.className = `propagation-notification propagation-notification-${isError ? 'error' : 'success'}`;
  notification.textContent = message;

  document.body.appendChild(notification);

  // Автоудаление через 5 секунд
  setTimeout(() => {
    if (notification.parentNode) {
      notification.style.animation = 'slideOut 0.3s ease-in forwards';
      setTimeout(() => notification.remove(), 300);
    }
  }, 5000);
}

/**
 * Создаёт уникальный ID для ребра проброса
 */
function generateEdgeKey(parentTableId, childTableId, columnName) {
  return `prop-${parentTableId}-${childTableId}-${columnName.toLowerCase()}`;
}

/**
 * Создаёт уникальный ID для пропагированной колонки
 */
function generatePropagatedColumnId(uniqueId, tableId, columnName) {
  return `prop-col-${uniqueId}-${tableId}-${columnName.toLowerCase()}`;
}



/**
 * Перемещает пропагированную колонку вверх или вниз
 * @param {HTMLElement} columnElement - элемент колонки
 * @param {string} direction - 'up' или 'down'
 */
export function movePropagatedColumn(columnElement, direction) {
  const container = columnElement.parentElement;
  if (!container) return;

  const allColumns = Array.from(container.querySelectorAll('.cll-column'));
  const currentIndex = allColumns.indexOf(columnElement);

  if (direction === 'up' && currentIndex > 0) {
    container.insertBefore(columnElement, allColumns[currentIndex - 1]);
  } else if (direction === 'down' && currentIndex < allColumns.length - 1) {
    container.insertBefore(columnElement, allColumns[currentIndex + 2]);
  }

  // Перерисовка рёбер
  const uniqueId = columnElement.getAttribute('data-unique-id') || 
    columnElement.closest('.pane-col-lineage')?.parentElement?.id || 
    columnElement.closest('.pane-col-lineage')?.id;

  if (uniqueId) {
    const event = new CustomEvent('propagation-update', {
      detail: { uniqueId, reason: 'column-moved' },
    });
    document.dispatchEvent(event);
  }
}

/**
 * Удаляет пропагированную колонку
 * @param {string} uniqueId - ID вкладки
 * @param {string} columnKey - ключ колонки "tableId.colName"
 */
export function removePropagatedColumn(uniqueId, columnKey) {
  const propagatedSet = PROPAGATION_STATE.propagatedColumns.get(uniqueId);
  if (!propagatedSet) return;

  propagatedSet.delete(columnKey);

  // Удаляем из DOM
  const columnEl = document.querySelector(`[data-col-key="${columnKey}"][data-propagated="true"]`);
  if (columnEl) {
    columnEl.remove();
  }

  // Удаляем связанные рёбра
  for (const [edgeKey, edgeInfo] of PROPAGATION_STATE.propagationEdges.entries()) {
    if (edgeInfo.uniqueId === uniqueId) {
      const parts = edgeKey.split('-');
      if (parts.length >= 4 && parts[3] === columnKey.split('.')[1]) {
        PROPAGATION_STATE.propagationEdges.delete(edgeKey);
      }
    }
  }
}

/**
 * Создаёт HTML контекстного меню
 * @param {Object} param0 - параметры
 * @param {MouseEvent} param0.event - событие мыши
 * @param {string} param0.columnName - имя колонки
 * @param {string} param0.tableId - ID таблицы
 * @param {string} param0.uniqueId - уникальный ID вкладки
 * @param {Array} param0.eligibleChildren - подходящие дочерние таблицы
 * @param {Function} param0.getTableInfo - функция получения информации
 * @param {Function} param0.onClose - callback при закрытии
 */
export function showPropagationContextMenu({
  event,
  columnName,
  tableId,
  uniqueId,
  eligibleChildren,
  getTableInfo,
  onClose,
}) {
  // Закрываем существующее меню
  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'propagation-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.style.transform = 'translateY(-100%)';

  const title = document.createElement('div');
  title.className = 'propagation-menu-title';
  title.textContent = `Протянуть ${columnName}`;

  menu.appendChild(title);

  const parentInfo = getTableInfo(tableId);
  const downstream = parentInfo?.lineage?.downstream || [];

  if (downstream.length === 0) {
    const noChildren = document.createElement('div');
    noChildren.className = 'propagation-menu-message propagation-menu-message--muted';
    noChildren.textContent = 'Нет дочерних таблиц для проброса';
    menu.appendChild(noChildren);
  } else if (eligibleChildren.length === 0) {
    const failureDetails = downstream.map(childId => {
      const res = checkPropagationConditions(childId, getTableInfo);
      const tableName = childId.split('.').pop();
      return `${tableName}: ${res.reason}`;
    }).join('\n');

    const reasonEl = document.createElement('div');
    reasonEl.className = 'propagation-menu-message propagation-menu-message--error';
    reasonEl.textContent = `Нельзя протянуть:\n${failureDetails}`;
    menu.appendChild(reasonEl);
  } else if (eligibleChildren.length === 1) {
    // 1 подходящая таблица — отдельная кнопка без чекбоксов
    const child = eligibleChildren[0];
    const button = document.createElement('button');
    button.className = 'propagation-menu-btn propagation-menu-btn-primary';
    button.textContent = 'Протянуть колонку';
    button.onclick = (e) => {
      e.stopPropagation();
      addPropagatedColumn(uniqueId, child.tableId, { name: columnName }, tableId);
      hideContextMenu();
      showPropagationNotification(`Колонка "${columnName}" протянута в ${child.tableId.split('.').pop()}`, false);
      
      setTimeout(() => {
        const event = new CustomEvent('propagation-update', {
          detail: { uniqueId, reason: 'column-added' },
        });
        document.dispatchEvent(event);
      }, 50);
      
      if (onClose) onClose();
    };
    menu.appendChild(button);
  } else {
    // Несколько подходящих таблиц — список с чекбоксами
    const checkboxContainer = document.createElement('div');
    checkboxContainer.className = 'propagation-checkboxes';

    eligibleChildren.forEach(child => {
      const checkboxItem = document.createElement('label');
      checkboxItem.className = 'propagation-checkbox-item';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'propagation-checkbox';
      checkbox.value = child.tableId;
      checkbox.checked = false; // По умолчанию выбор снят

      const childLabel = document.createElement('span');
      childLabel.className = 'propagation-checkbox-label';
      childLabel.textContent = child.tableId.split('.').pop();

      checkboxItem.appendChild(checkbox);
      checkboxItem.appendChild(childLabel);
      checkboxContainer.appendChild(checkboxItem);
    });

    menu.appendChild(checkboxContainer);

    const button = document.createElement('button');
    button.className = 'propagation-menu-btn propagation-menu-btn-primary';
    button.textContent = 'Протянуть колонку';
    button.style.marginTop = '12px';
    button.onclick = (e) => {
      e.stopPropagation();
      const checkboxes = menu.querySelectorAll('.propagation-checkbox:checked');
      if (checkboxes.length === 0) {
        showPropagationNotification('Выберите хотя бы одну таблицу', true);
        return;
      }

      checkboxes.forEach(cb => {
        const childTableId = cb.value;
        addPropagatedColumn(uniqueId, childTableId, { name: columnName }, tableId);
      });

      hideContextMenu();
      showPropagationNotification(`Колонка "${columnName}" протянута в ${checkboxes.length} таблицу(ы)`, false);

      setTimeout(() => {
        const event = new CustomEvent('propagation-update', {
          detail: { uniqueId, reason: 'column-added' },
        });
        document.dispatchEvent(event);
      }, 50);

      if (onClose) onClose();
    };
    menu.appendChild(button);
  }

  // Предотвращаем закрытие меню при кликах внутри него
  menu.onclick = (e) => e.stopPropagation();

  const handleOutsideClick = (e) => {
    if (PROPAGATION_STATE.menuElement && !PROPAGATION_STATE.menuElement.contains(e.target)) {
      hideContextMenu();
    }
  };

  PROPAGATION_STATE.outsideClickHandler = handleOutsideClick;
  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick, { capture: true });
    document.addEventListener('contextmenu', handleOutsideClick, { capture: true });
  }, 10);

  PROPAGATION_STATE.menuElement = menu;
  document.body.appendChild(menu);

  // Автопозиционирование
  setTimeout(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
  }, 50);

  return menu;
}

/**
 * Закрывает контекстное меню
 */
export function hideContextMenu() {
  if (PROPAGATION_STATE.outsideClickHandler) {
    document.removeEventListener('click', PROPAGATION_STATE.outsideClickHandler, { capture: true });
    document.removeEventListener('contextmenu', PROPAGATION_STATE.outsideClickHandler, { capture: true });
    PROPAGATION_STATE.outsideClickHandler = null;
  }
  if (PROPAGATION_STATE.menuElement) {
    PROPAGATION_STATE.menuElement.remove();
    PROPAGATION_STATE.menuElement = null;
    PROPAGATION_STATE.currentMenuTarget = null;
  }
}

/**
 * Инициализация проброса для вкладки Column Lineage
 * @param {string} uniqueId - уникальный ID вкладки
 * @param {Function} getTableInfo - функция получения информации о таблице
 * @param {Set} displayedTables - множество отображаемых таблиц
 */
export function initPropagation(uniqueId, getTableInfo, displayedTables) {
  // Очищаем состояние для этой вкладки
  PROPAGATION_STATE.propagatedColumns.set(uniqueId, new Set());

  // Добавляем обработчики на колонки
  const pane = document.getElementById(uniqueId);
  if (!pane) return;

  pane.querySelectorAll('.cll-column:not(.cll-aggregate)').forEach(colEl => {
    // Удаляем старые обработчики
    const oldHandler = colEl._propagationHandler;
    if (oldHandler) {
      colEl.removeEventListener('contextmenu', oldHandler);
    }

    // Новый обработчик
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Выделяем колонку синим цветам при клике ПКМ (аналогично ЛКМ)
      colEl.click();

      const tableId = colEl.getAttribute('data-table-id');
      const columnName = colEl.getAttribute('data-col-name');

      if (!tableId || !columnName) return;

      const parentInfo = getTableInfo(tableId);
      const downstream = parentInfo?.lineage?.downstream || [];

      if (downstream.length === 0) {
        showPropagationNotification('У таблицы нет дочерних таблиц для проброса', true);
        return;
      }

      // Ищем подходящие дочерние таблицы
      const eligibleChildren = findEligibleChildren(tableId, getTableInfo);

      if (eligibleChildren.length === 0) {
        const failureDetails = downstream.map(childId => {
          const res = checkPropagationConditions(childId, getTableInfo);
          const tableName = childId.split('.').pop();
          return `${tableName}: ${res.reason}`;
        }).join('; ');

        showPropagationNotification(`Нельзя протянуть: ${failureDetails}`, true);
      }

      showPropagationContextMenu({
        event: e,
        columnName,
        tableId,
        uniqueId,
        eligibleChildren,
        getTableInfo,
        onClose: () => {
          // При закрытии обновляем рёбра
          const event = new CustomEvent('propagation-update', {
            detail: { uniqueId, reason: 'menu-closed' },
          });
          document.dispatchEvent(event);
        },
      });
    };

    colEl._propagationHandler = handler;
    colEl.addEventListener('contextmenu', handler);
  });
}

/**
 * Очистка состояния проброса для вкладки
 * @param {string} uniqueId - уникальный ID вкладки
 */
export function cleanupPropagation(uniqueId) {
  // Удаляем все пропагированные колонки из DOM
  const propagatedSet = PROPAGATION_STATE.propagatedColumns.get(uniqueId);
  if (propagatedSet) {
    propagatedSet.forEach(columnKey => {
      const columnEl = document.querySelector(`[data-col-key="${columnKey}"][data-propagated="true"]`);
      if (columnEl) {
        columnEl.remove();
      }
    });
    propagatedSet.clear();
  }

  // Удаляем связанные рёбра
  for (const [edgeKey, edgeInfo] of PROPAGATION_STATE.propagationEdges.entries()) {
    if (edgeInfo.uniqueId === uniqueId) {
      PROPAGATION_STATE.propagationEdges.delete(edgeKey);
    }
  }

  PROPAGATION_STATE.propagatedColumns.delete(uniqueId);
  hideContextMenu();
}

/**
 * Получает все пропагированные колонки для вкладки
 * @param {string} uniqueId - уникальный ID вкладки
 * @returns {Set<string> | undefined} множество ключей колонок
 */
export function getPropagatedColumns(uniqueId) {
  return PROPAGATION_STATE.propagatedColumns.get(uniqueId);
}

/**
 * Получает все рёбра проброса
 * @returns {Map<string, Object>} карта рёбер
 */
export function getPropagationEdges() {
  return PROPAGATION_STATE.propagationEdges;
}
