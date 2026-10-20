/**
 * MODULE: src/utils/scriptTransform.js
 * ROLE: Преобразование CTAS скрипта в DDL (CREATE TABLE + обвес) и DML (INSERT INTO).
 *       Управление переключением режимов отображения (Dev / Test) во вкладке «Скрипт».
 */

import { initScriptLineNumbers, initScriptWordHighlight } from "./helpers.js";

/**
 * Экранирует спецсимволы в строке HTML (с fallback).
 */
function safeHtml(str) {
  if (typeof escapeHtml === "function") {
    return escapeHtml(str);
  }
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Форматирует идентификатор колонки.
 */
function formatColumnIdent(name) {
  if (/^[a-z_][a-z0-9_]*$/i.test(name)) {
    return name;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Преобразует CTAS скрипт и метаданные таблицы в DDL и DML (INSERT INTO).
 *
 * @param {Object} tableInfo - Метаданные таблицы из catalogData
 * @param {string} dbName - Имя БД (dds, dm, ods)
 * @param {string} schemaName - Имя схемы (core, calc)
 * @param {string} tableName - Имя таблицы
 * @returns {Object} { ddl: string, dml: string, isCtas: boolean }
 */
export function transformCtasScript(tableInfo, dbName, schemaName, tableName) {
  const defaultTarget = `${dbName}.${schemaName}.${tableName}`;
  const originalScript = (tableInfo?.sql_script || "").trim();
  const extraScript = (tableInfo?.sql_script_extra || "").trim();

  // Ищем CTAS паттерн
  const ctasMatch = originalScript.match(
    /^([\s\S]*?create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?table\s+([^\s(]+)\s+as\s*\(?)([\s\S]*)$/i
  );

  let target = defaultTarget;
  let body = "";
  let isCtas = false;

  if (ctasMatch) {
    isCtas = true;
    target = ctasMatch[2] || defaultTarget;
    body = ctasMatch[3].trim();

    // Очищаем закрывающую скобку и точку с запятой в конце body
    if (ctasMatch[1].endsWith("(")) {
      body = body.replace(/\)\s*;?\s*$/, "").trim();
    } else {
      body = body.replace(/;\s*$/, "").trim();
    }
  } else if (/^insert\s+into/i.test(originalScript)) {
    // Если скрипт уже является INSERT INTO
    body = originalScript.replace(/;\s*$/, "").trim();
  } else {
    // Fallback: берем оригинальный скрипт как тело запроса
    body = originalScript.replace(/;\s*$/, "").trim();
  }

  // Формируем DDL (CREATE TABLE)
  const columns = tableInfo?.columns || [];
  let colDefs = "";
  if (columns.length > 0) {
    colDefs = columns
      .map((col, idx) => {
        const notNullPart = col.notnull ? " NOT NULL" : "";
        const comma = idx < columns.length - 1 ? "," : "";
        return `    ${formatColumnIdent(col.name)} ${col.type || "text"}${notNullPart}${comma}`;
      })
      .join("\n");
  } else {
    colDefs = "    -- Колонки не указаны в метаданных";
  }

  let ddl = `CREATE TABLE ${target} (\n${colDefs}\n);`;
  if (extraScript) {
    ddl += `\n\n\n${extraScript}`;
  }

  // Формируем DML (INSERT INTO)
  let dml = "";
  if (columns.length > 0) {
    const colNames = columns
      .map((col, idx) => {
        const comma = idx < columns.length - 1 ? "," : "";
        return `    ${formatColumnIdent(col.name)}${comma}`;
      })
      .join("\n");

    dml = `INSERT INTO ${target} (\n${colNames}\n)\n${body};`;
  } else {
    dml = `INSERT INTO ${target}\n${body};`;
  }

  return { ddl, dml, isCtas };
}

/**
 * Переключает режим отображения скрипта между 'dev' (CTAS) и 'test' (DDL + INSERT).
 *
 * @param {string} uniqueId - Уникальный ID таблицы (например, 'dds-core-account_balance_detail')
 * @param {'dev'|'test'} mode - Выбранный режим
 * @param {HTMLElement} btnElement - Нажатая кнопка
 */
export function switchScriptMode(uniqueId, mode, btnElement) {
  const switchBox = document.getElementById(`script-mode-switch-${uniqueId}`);
  const devBlock = document.getElementById(`script-${uniqueId}`);
  const testContainer = document.getElementById(`test-script-container-${uniqueId}`);
  const mainCopyBtn = document.getElementById(`copy-btn-${uniqueId}`);

  if (!switchBox || !devBlock || !testContainer) return;

  // Обновляем активный класс кнопок переключателя
  switchBox.querySelectorAll(".script-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn === btnElement || btn.dataset.mode === mode);
  });

  if (mode === "dev") {
    devBlock.style.display = "";
    testContainer.style.display = "none";
    if (mainCopyBtn) mainCopyBtn.style.display = "";
  } else {
    devBlock.style.display = "none";
    if (mainCopyBtn) mainCopyBtn.style.display = "none";

    // Если контейнер Test еще не отрендерен — рендерим
    if (!testContainer.dataset.rendered) {
      const db = switchBox.dataset.db || "";
      const schema = switchBox.dataset.schema || "";
      const table = switchBox.dataset.table || "";

      let tableInfo = null;
      if (window.catalogData && window.catalogData[db]?.[schema]?.[table]) {
        tableInfo = window.catalogData[db][schema][table];
      }

      if (!tableInfo) {
        testContainer.innerHTML = `
          <div class="empty-pane" style="padding: 20px;">
            Не удалось загрузить метаданные таблицы для формирования DDL и INSERT.
          </div>
        `;
      } else {
        const { ddl, dml } = transformCtasScript(tableInfo, db, schema, table);

        testContainer.innerHTML = `
          <div class="test-script-window">
            <div class="test-script-header">
              <div class="test-script-title">
                <span class="test-script-badge">DDL</span>
                <span>1. Создание таблицы и обвеса (CREATE TABLE)</span>
              </div>
              <button type="button" class="copy-btn test-copy-btn" onclick="copyScriptContent('ddl-script-${uniqueId}', this)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Копировать DDL
              </button>
            </div>
            <pre class="ddl-block table-script-block test-script-block" id="ddl-script-${uniqueId}"><code>${safeHtml(ddl)}</code></pre>
          </div>

          <div class="test-script-window">
            <div class="test-script-header">
              <div class="test-script-title">
                <span class="test-script-badge test-script-badge--dml">DML</span>
                <span>2. Загрузка данных (INSERT INTO)</span>
              </div>
              <button type="button" class="copy-btn test-copy-btn" onclick="copyScriptContent('dml-script-${uniqueId}', this)">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                Копировать INSERT
              </button>
            </div>
            <pre class="ddl-block table-script-block test-script-block" id="dml-script-${uniqueId}"><code>${safeHtml(dml)}</code></pre>
          </div>
        `;

        testContainer.dataset.rendered = "true";

        // Применяем нумерацию строк и подсветку комментариев в стиле DBeaver
        initScriptLineNumbers(testContainer);
        initScriptWordHighlight();
      }
    }

    testContainer.style.display = "flex";
  }
}
