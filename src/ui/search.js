/* 
MODULE: src/ui/search.js
ROLE: Логика поисковой строки.
*/

import { highlightMatch } from "../utils/helpers.js";
import { restoreCurrentView, navigateTo } from "../routing/navigation.js";

const searchInput = document.getElementById("search-input");
const searchResultsView = document.getElementById("search-results");
const searchCount = document.getElementById("search-count");
const welcomeScreen = document.getElementById("welcome-screen");
const excludeOdsCheckbox = document.getElementById("exclude-ods-checkbox");

// Текущий активный scope: 'catalog' | 'expressions' | 'scripts'
let currentScope = 'catalog';

const SCOPE_PLACEHOLDERS = {
  catalog:     'Поиск таблиц, полей и описаний...',
  expressions: 'Поиск по алгоритму заполнения...',
  scripts:     'Поиск по тексту скрипта...',
};

export function getSearchPriority(dbName, schemaName, matchType) {
  const db     = dbName.toLowerCase();
  const schema = schemaName.toLowerCase();

  // Приоритет базы данных: dm=0, dds=1, ods=2, остальные=3
  const dbRank = db === "dm" ? 0 : db === "dds" ? 1 : db === "ods" ? 2 : 3;

  // Приоритет схемы внутри базы: core=0, calc=1, остальные=2
  const schemaRank = schema === "core" ? 0 : schema === "calc" ? 1 : 2;

  // Приоритет типа совпадения: tableName=0, colName=1, tableDesc=2, colDesc=3
  const matchRank = matchType === "tableName" ? 0
                  : matchType === "colName"   ? 1
                  : matchType === "tableDesc" ? 2
                  : matchType === "colDesc"   ? 3
                  : 9;

  // Итоговый приоритет: match (0-9) * 100 + db (0-3) * 10 + schema (0-2)
  // Тип совпадения важнее базы и схемы — все tableName выше всех colName
  return matchRank * 100 + dbRank * 10 + schemaRank;
}

// Возвращает человекочитаемый тип объекта — как в основном поиске
function getTypeLabel(dbName, schemaName, tableInfo) {
  const isView = tableInfo.type === "v" || tableInfo.type === "m";
  if (isView) return "View";
  if (dbName.toLowerCase() === "dm") return "Витрина";
  return "Таблица";
}

// Поиск по алгоритму заполнения (expression в column_lineage)
function searchExpressions(query, excludeOds) {
  const results = [];
  if (!window.catalogData || typeof window.catalogData !== 'object') return results;
  for (const [dbName, schemas] of Object.entries(window.catalogData)) {
    if (dbName === "source_system_map" || !schemas || typeof schemas !== "object") continue;
    for (const [schemaName, tables] of Object.entries(schemas)) {
      if (excludeOds && dbName.toLowerCase() === "ods") continue;
      // Схемы, скрытые в дереве, не участвуют в поиске
      if (window.hiddenSchemas && window.hiddenSchemas.has(schemaName.toLowerCase())) continue;
      if (!tables || typeof tables !== "object") continue;
      for (const [tableName, tableInfo] of Object.entries(tables)) {
        if (!tableInfo || typeof tableInfo !== "object") continue;
        const targetId = `${dbName}-${schemaName}-${tableName}`;
        const fullPath = `${dbName}.${schemaName}.${tableName}`;
        const context = `${dbName} / ${schemaName}`;
        const colLineage = tableInfo.column_lineage || {};

        for (const [colName, lineageEntry] of Object.entries(colLineage)) {
          const expr = (lineageEntry && lineageEntry.expression) ? lineageEntry.expression : '';
          if (!expr || !expr.toLowerCase().includes(query)) continue;

          const schema = schemaName.toLowerCase();
          const db = dbName.toLowerCase();
          const priority = db === 'dm' ? 1 : db === 'dds' ? 2 : db === 'ods' ? 3 : 4;

          results.push({
            priority,
            badgeClass: 't-expr',
            typeLabel: getTypeLabel(dbName, schemaName, tableInfo),
            titleHighlight: `${tableName} ➔ ${colName}`,
            fullPath,
            context,
            link: targetId,
            descHTML: highlightMatch(expr, query),
            rawTitle: `${tableName} ➔ ${colName}`,
          });
        }
      }
    }
  }
  return results;
}

// Поиск по тексту скрипта (sql_script + sql_script_extra)
function searchScripts(query, excludeOds) {
  const results = [];
  if (!window.catalogData || typeof window.catalogData !== 'object') return results;
  for (const [dbName, schemas] of Object.entries(window.catalogData)) {
    if (dbName === "source_system_map" || !schemas || typeof schemas !== "object") continue;
    for (const [schemaName, tables] of Object.entries(schemas)) {
      if (excludeOds && dbName.toLowerCase() === "ods") continue;
      // Схемы, скрытые в дереве, не участвуют в поиске
      if (window.hiddenSchemas && window.hiddenSchemas.has(schemaName.toLowerCase())) continue;
      if (!tables || typeof tables !== "object") continue;
      for (const [tableName, tableInfo] of Object.entries(tables)) {
        if (!tableInfo || typeof tableInfo !== "object") continue;
        const script = [tableInfo.sql_script || '', tableInfo.sql_script_extra || ''].join('\n');
        if (!script.trim() || !script.toLowerCase().includes(query)) continue;

        const targetId = `${dbName}-${schemaName}-${tableName}`;
        const fullPath = `${dbName}.${schemaName}.${tableName}`;
        const context = `${dbName} / ${schemaName}`;

        // Находим фрагмент вокруг совпадения для превью
        const lowerScript = script.toLowerCase();
        const matchIdx = lowerScript.indexOf(query);
        const snippetStart = Math.max(0, matchIdx - 60);
        const snippetEnd = Math.min(script.length, matchIdx + query.length + 60);
        let snippet = (snippetStart > 0 ? '…' : '') + script.slice(snippetStart, snippetEnd) + (snippetEnd < script.length ? '…' : '');
        snippet = snippet.replace(/\s+/g, ' ').trim();

        const schema = schemaName.toLowerCase();
        const db = dbName.toLowerCase();
        const priority = db === 'dm' ? 1 : db === 'dds' ? 2 : db === 'ods' ? 3 : 4;

        results.push({
          priority,
          badgeClass: 't-script',
          typeLabel: getTypeLabel(dbName, schemaName, tableInfo),
          titleHighlight: tableName,
          fullPath,
          context,
          link: targetId,
          descHTML: highlightMatch(snippet, query),
          rawTitle: tableName,
        });
      }
    }
  }
  return results;
}

export function initSearch() {
  if (!searchInput) return;

  // Инициализация scope-переключателя (select)
  const scopeSelect = document.getElementById('search-scope-select');
  if (scopeSelect) {
    scopeSelect.addEventListener('change', () => {
      currentScope = scopeSelect.value;
      searchInput.placeholder = SCOPE_PLACEHOLDERS[currentScope];
      searchInput.dispatchEvent(new Event('input'));
      searchInput.focus();
    });
  }

  // Перезапускаем поиск при переключении чекбокса
  if (excludeOdsCheckbox) {
    excludeOdsCheckbox.addEventListener("change", () => {
      searchInput.dispatchEvent(new Event("input"));
    });
  }

  searchInput.addEventListener("input", function (e) {
    const query = e.target.value.trim().toLowerCase();
    const excludeOds = excludeOdsCheckbox ? excludeOdsCheckbox.checked : false;
    const mainBody = document.querySelector(".main-body");
    if (mainBody) mainBody.classList.remove("lineage-scroll-locked");

    if (query.length < 2) {
      if (searchCount) searchCount.style.display = "none";
      restoreCurrentView();
      return;
    }

    document.querySelectorAll(".table-view").forEach((el) => (el.style.display = "none"));
    welcomeScreen.style.display = "none";
    searchResultsView.style.display = "block";

    let results = [];

    if (currentScope === 'expressions') {
      results = searchExpressions(query, excludeOds);
    } else if (currentScope === 'scripts') {
      results = searchScripts(query, excludeOds);
    } else {
      // Стандартный поиск по каталогу
      for (const [dbName, schemas] of Object.entries(window.catalogData)) {
        // Пропускаем служебные поля (source_system_map и др.)
        if (dbName === "source_system_map" || !schemas || typeof schemas !== "object") continue;
        for (const [schemaName, tables] of Object.entries(schemas)) {
          if (excludeOds && dbName.toLowerCase() === "ods") continue;
          // Схемы, скрытые в дереве, не участвуют в поиске
          if (window.hiddenSchemas && window.hiddenSchemas.has(schemaName.toLowerCase())) continue;
          if (!tables || typeof tables !== "object") continue;
          for (const [tableName, tableInfo] of Object.entries(tables)) {
            if (!tableInfo || typeof tableInfo !== "object") continue;
            const targetId = `${dbName}-${schemaName}-${tableName}`;
            const fullPath = `${dbName}.${schemaName}.${tableName}`;

            const isView = tableInfo.type === "v" || tableInfo.type === "m";
            const typeLabel = isView
              ? "View"
              : dbName.toLowerCase() === "dm"
                ? "Витрина"
                : "Таблица";
            const context = `${dbName} / ${schemaName}`;

            if (tableName.toLowerCase().includes(query)) {
              results.push({
                priority: getSearchPriority(dbName, schemaName, "tableName"),
                badgeClass: "t-name",
                typeLabel: typeLabel,
                titleHighlight: highlightMatch(tableName, query),
                fullPath: fullPath,
                context: context,
                link: targetId,
                descHTML: tableInfo.description
                  ? tableInfo.description
                  : '<span class="res-desc-empty">Описание отсутствует</span>',
                rawTitle: tableName,
              });
            }

            if (tableInfo.description && tableInfo.description.toLowerCase().includes(query)) {
              const descLabel =
                typeLabel === "Витрина"
                  ? "Описание витрины"
                  : typeLabel === "Таблица"
                    ? "Описание таблицы"
                    : "Описание view";
              results.push({
                priority: getSearchPriority(dbName, schemaName, "tableDesc"),
                badgeClass: "t-desc",
                typeLabel: descLabel,
                titleHighlight: tableName,
                fullPath: fullPath,
                context: context,
                link: targetId,
                descHTML: highlightMatch(tableInfo.description, query),
                rawTitle: tableName,
              });
            }

            for (const col of tableInfo.columns) {
              if (col.name.toLowerCase().includes(query)) {
                results.push({
                  priority: getSearchPriority(dbName, schemaName, "colName"),
                  badgeClass: "t-col",
                  typeLabel: "Поле",
                  titleHighlight: highlightMatch(`${tableName} ➔ ${col.name}`, query),
                  fullPath: fullPath,
                  context: context,
                  link: targetId,
                  descHTML: col.description
                    ? col.description
                    : '<span class="res-desc-empty">Описание отсутствует</span>',
                  rawTitle: `${tableName} ➔ ${col.name}`,
                });
              }
              if (col.description && col.description.toLowerCase().includes(query)) {
                results.push({
                  priority: getSearchPriority(dbName, schemaName, "colDesc"),
                  badgeClass: "t-coldesc",
                  typeLabel: "Описание поля",
                  titleHighlight: `${tableName} ➔ ${col.name}`,
                  fullPath: fullPath,
                  context: context,
                  link: targetId,
                  descHTML: highlightMatch(col.description, query),
                  rawTitle: `${tableName} ➔ ${col.name}`,
                });
              }
            }
          }
        }
      }
    }

    results.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.rawTitle.localeCompare(b.rawTitle);
    });

    if (searchCount) {
      searchCount.style.display = "block";
      searchCount.innerText = `Количество найденных результатов: ${results.length}`;
    }

    if (results.length === 0) {
      searchResultsView.innerHTML = `<div class="no-results" style="text-align:center; padding: 40px; color: var(--text-gray);">По запросу «<b>${e.target.value}</b>» ничего не найдено.</div>`;
    } else {
      let html = "";
      for (let i = 0; i < Math.min(results.length, 200); i++) {
        const res = results[i];
        html += `
                    <div class="search-item" onclick="navigateTo('#${res.link}')">
                        <span class="res-badge ${res.badgeClass}">${res.typeLabel}</span>
                        <div class="res-top">
                            <div class="res-title">${res.titleHighlight}</div>
                            <button class="res-copy-btn" onclick="copySearchResult('${res.fullPath}', event, this)" title="Скопировать">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                            </button>
                        </div>
                        <div class="res-context">📍 ${res.context}</div>
                        <div class="res-desc">${res.descHTML}</div>
                    </div>
                `;
      }
      searchResultsView.innerHTML = html;
    }
  });
}

