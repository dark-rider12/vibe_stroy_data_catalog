/*
MODULE: src/lineage/columnLineageCards.js
ROLE: Генерация HTML-разметки карточек таблиц/колонок для Column Lineage.

Содержит:
- buildCard — строит HTML-строку одной карточки таблицы со списком колонок

Чистый HTML-builder: нет DOM-манипуляций, нет SVG, нет событий.
*/

import { sanitizeId } from "../utils/helpers.js";

/**
 * Строит HTML-строку карточки таблицы для Column Lineage.
 *
 * @param {string} fullId - полный идентификатор таблицы "db.schema.name"
 * @param {boolean} isCenter - является ли таблица центральной (выбранной)
 * @param {string} uniqueId - уникальный ID вкладки (для изоляции DOM ID)
 * @param {Set<string>} highlightedCols - ключи подсвеченных колонок "tableId.colName"
 * @param {Object} columnSourceCounts - { "tableId.colName": count } — количество исходящих рёбер
 * @param {Object} columnTargetCounts - { "tableId.colName": count } — количество входящих рёбер
 * @param {Function} getTableInfo - (fullId) => tableInfo | null
 * @returns {string} HTML-строка карточки
 */
export function buildCard(fullId, isCenter, uniqueId, highlightedCols, columnSourceCounts, columnTargetCounts, getTableInfo) {
  const info = getTableInfo(fullId);
  if (!info) return "";

  const p = fullId.split(".");
  const tName = p[2].toUpperCase();

  const _dbColorSchemas = ["core", "calc"]; // схемы, наследующие цвет от базы данных
  const _dbLower = p[0].toLowerCase();
  const _schemaLower = p[1].toLowerCase();
  let headerClass;
  if (_dbColorSchemas.includes(_schemaLower)) {
    // Схемы core и calc наследуют цвет от базы данных
    headerClass = `cll-core-${_dbLower}`;
  } else if (_schemaLower === "ods") {
    headerClass = "cll-ods";
  } else if (_schemaLower === "dds") {
    headerClass = "cll-dds";
  } else if (_schemaLower === "dm") {
    headerClass = "cll-dm";
  } else {
    // Системная схема — назначаем цвет по хешу имени (стабильно, не зависит от порядка)
    const _systemPaletteSize = 8;
    let _hash = 0;
    for (let i = 0; i < _schemaLower.length; i++) {
      _hash = (_hash * 31 + _schemaLower.charCodeAt(i)) % _systemPaletteSize;
    }
    headerClass = `cll-system-${_hash}`;
  }

  const allCols = [];

  // Виртуальная колонка для агрегатов (показываем только если есть связи)
  const virtualColKey = `${fullId}.*`;
  const vSCount = columnSourceCounts[virtualColKey] || 0;
  const vTCount = columnTargetCounts[virtualColKey] || 0;

  if (vSCount > 0 || vTCount > 0) {
    const isVirtualSelected = highlightedCols.has(virtualColKey);
    const vClass = isVirtualSelected ? "is-selected" : "is-faded";

    const vMaxEdges = Math.max(vSCount, vTCount);
    let vDynamicPadding = "";
    if (vMaxEdges > 2) {
      const extraPadding = Math.max(0, (vMaxEdges - 2) * 4);
      vDynamicPadding = `padding-top: ${6 + extraPadding}px; padding-bottom: ${6 + extraPadding}px; `;
    }
    const vOpacityStyle = isVirtualSelected ? "" : "opacity: 0.8;";

    // Используем "star" вместо sanitizeId("*"), чтобы гарантировать валидный DOM ID
    allCols.push(`<div class="cll-column cll-aggregate ${vClass}" style="${vDynamicPadding}${vOpacityStyle}" id="cll-col-${uniqueId}-${fullId}-star" data-col-key="${virtualColKey}" data-table-id="${fullId}" data-col-name="*">* (Aggregate)</div>`);
  }

  if (info.columns) {
    info.columns.forEach((col) => {
      const colKey = `${fullId}.${col.name.toLowerCase()}`;
      const isSelected = highlightedCols.has(colKey);
      const colClass = isSelected ? "is-selected" : "is-faded";

      // Адаптивная высота: если связей > 2, увеличиваем padding.
      // Базовый padding в CSS: 6px. Высота строки ~25px.
      // Если связей много, увеличиваем padding, чтобы пины не вылезали.
      const sCount = columnSourceCounts[colKey] || 0;
      const tCount = columnTargetCounts[colKey] || 0;
      const maxEdges = Math.max(sCount, tCount);

      let dynamicPadding = "";
      if (maxEdges > 2) {
        const extraPadding = Math.max(0, (maxEdges - 2) * 4);
        const topPad = 6 + extraPadding;
        const botPad = 6 + extraPadding;
        dynamicPadding = `padding-top: ${topPad}px; padding-bottom: ${botPad}px; `;
      }

      const customStyleAttr = dynamicPadding ? `style="${dynamicPadding}"` : "";

      // Достаем expression для tooltip
      let expressionStr = "";
      if (info.column_lineage) {
        const entry = info.column_lineage[col.name] ||
          Object.entries(info.column_lineage).find(([k]) => k.toLowerCase() === col.name.toLowerCase())?.[1];
        if (entry && entry.expression) {
          expressionStr = entry.expression;
        }
      }
      const titleAttr = expressionStr
        ? `title="Expression: ${expressionStr.replace(/"/g, '&quot;')}"`
        : `title="${col.name}"`;

      const safeColName = sanitizeId(col.name);
      allCols.push(`<div class="cll-column ${colClass}" ${customStyleAttr} id="cll-col-${uniqueId}-${fullId}-${safeColName}" data-col-key="${colKey}" data-table-id="${fullId}" data-col-name="${col.name}" ${titleAttr}>${col.name}</div>`);
    });
  }

  // Добавляем класс cll-last-visible к последней колонке
  if (allCols.length > 0) {
    allCols[allCols.length - 1] = allCols[allCols.length - 1].replace('class="cll-column', 'class="cll-column cll-last-visible');
  }
  const colsHtml = allCols.join("");

  const cardClass = (isCenter ? "cll-card is-selected" : "cll-card") + (info._isVirtual ? " cll-card-virtual" : "");
  const targetHash = `#${fullId.replace(/\./g, "-")}`;
  const isView = info.type === 'v' || info.type === 'm';
  const viewIcon = isView
    ? `<svg class="ln-view-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path d="M1 8c0 0 3-4.5 7-4.5s7 4.5 7 4.5-3 4.5-7 4.5S1 8 1 8z" fill="#FEF08A" fill-opacity="0.4" stroke="#EAB308" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="2.5" fill="#EAB308"/></svg>`
    : '';

  const headerTitle = info._isVirtual
    ? 'Виртуальная таблица (создана через Table Propagation)'
    : 'Клик для перехода к таблице';
  const headerOnclick = info._isVirtual
    ? ''
    : `onclick="window.navigateTo('${targetHash}')"`;
  const headerCursor = info._isVirtual ? 'cursor: default;' : 'cursor: pointer;';
  const virtualHeaderClass = info._isVirtual ? 'cll-virtual-table-header' : '';

  // Для виртуальной таблицы добавляем кнопку удаления в шапку (слева, чтобы не накладываться на кнопку SQL)
  const deleteBtn = info._isVirtual
    ? `<button class="cll-delete-virtual-table-btn" title="Удалить протянутую таблицу" data-table-id="${fullId}" data-unique-id="${uniqueId}" onmousedown="event.stopPropagation();" onclick="event.stopPropagation(); if (window.__removeVirtualTable) window.__removeVirtualTable('${uniqueId}', '${fullId}');">✕</button>`
    : '';

  // ВАЖНО: ID карточки должен содержать uniqueId для изоляции верстки разных вкладок
  return `
  <div class="${cardClass}" id="cll-card-${uniqueId}-${fullId}">
      <div class="cll-header ${headerClass} ${virtualHeaderClass}" ${headerOnclick} style="${headerCursor}" title="${headerTitle}">
          ${deleteBtn}
          <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding-right:4px;">${viewIcon}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tName}</span></div>
      </div>
      <div class="cll-columns">
          ${colsHtml}
      </div>
  </div>
  `;
}
