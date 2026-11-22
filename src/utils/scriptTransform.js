/**
 * MODULE: src/utils/scriptTransform.js
 * ROLE: Преобразование CTAS скрипта в DDL (CREATE TABLE + обвес) и DML (INSERT INTO).
 *       Управление переключением режимов отображения (Dev / Test) во вкладке «Скрипт».
 */

import { initScriptLineNumbers, initScriptWordHighlight } from "./helpers.js";
import { enhanceSqlScript } from "./sqlEnhancer.js";

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
        // Проверяем режим raw / enhanced
        const isRaw = document.getElementById(`script-raw-cb-${uniqueId}`)?.checked;
        let effectiveInfo = tableInfo;
        if (!isRaw && tableInfo?.sql_script) {
          const enhancedSql = enhanceSqlScript(tableInfo.sql_script, {
            catalogData: window.catalogData,
            currentDb: db,
            currentSchema: schema,
            currentTable: table
          });
          effectiveInfo = { ...tableInfo, sql_script: enhancedSql };
        }

        const { ddl, dml } = transformCtasScript(effectiveInfo, db, schema, table);

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

/**
 * Извлекает чистый, неповрежденный текст SQL-скрипта.
 * Защищает от склеивания строк в одну длинную строку и исключает артефакты номеров строк (.line-num).
 *
 * @param {HTMLElement} pre - Элемент <pre> блока скрипта
 * @param {HTMLElement} code - Вложенный элемент <code>
 * @returns {string} Чистый текст скрипта
 */
export function getCleanScriptText(pre, code) {
  // 1. Приоритет: catalogData (статичный неизменяемый источник правды из БД)
  const db = pre?.dataset?.db || "";
  const schema = pre?.dataset?.schema || "";
  const table = pre?.dataset?.table || "";
  const catalog = typeof window !== "undefined" && window.catalogData ? window.catalogData : null;
  if (catalog && db && schema && table) {
    const tableInfo = catalog[db]?.[schema]?.[table];
    if (tableInfo && typeof tableInfo.sql_script === "string" && tableInfo.sql_script.trim()) {
      const main = tableInfo.sql_script.trim();
      const extra = (tableInfo.sql_script_extra || "").trim();
      return extra ? `${main}\n\n\n${extra}` : main;
    }
  }

  // 2. Приоритет: ранее сохраненный чистый скрипт в dataset.rawScript
  if (code?.dataset?.rawScript) {
    return code.dataset.rawScript;
  }

  // 3. Приоритет: если DOM уже содержит строки .line-code — собираем только их, пропуская .line-num
  if (pre) {
    const lineCodes = pre.querySelectorAll(".line-code");
    if (lineCodes.length > 0) {
      return Array.from(lineCodes).map((el) => el.textContent).join("\n");
    }
  }

  // 4. Fallback: textContent элемента code (только если spans еще не создавались)
  return code ? code.textContent : "";
}

/**
 * Инициализирует отображение улучшенного скрипта во вкладке «Скрипт».
 * Вызывается при переключении на pane-script.
 *
 * @param {string} uniqueId - Уникальный ID таблицы
 */
export function initEnhancedScript(uniqueId) {
  const pre = document.getElementById(`script-${uniqueId}`);
  if (!pre) return;

  const code = pre.querySelector("code");
  if (!code) return;

  // Если уже инициализировано (уже сохранены rawScript и enhancedScript), не пересчитываем повторно
  if (code.dataset.enhancedInit) {
    return;
  }

  // Получаем гарантированно чистый исходный текст скрипта
  const rawScript = getCleanScriptText(pre, code);
  if (!rawScript || !rawScript.trim()) return;

  const db = pre.dataset.db || "";
  const schema = pre.dataset.schema || "";
  const table = pre.dataset.table || "";

  // Проверяем наличие extra-скрипта (обвеса), чтобы улучшить основной скрипт и сохранить обвес
  let mainScript = rawScript;
  let extraScript = "";
  const parts = rawScript.split("\n\n\n");
  if (parts.length >= 2) {
    mainScript = parts[0];
    extraScript = parts.slice(1).join("\n\n\n");
  }

  // Улучшаем основной скрипт трансформации
  const enhancedMain = enhanceSqlScript(mainScript, {
    catalogData: typeof window !== "undefined" ? window.catalogData : null,
    currentDb: db,
    currentSchema: schema,
    currentTable: table
  });

  const enhancedScript = extraScript
    ? `${enhancedMain}\n\n\n${extraScript}`
    : enhancedMain;

  // Сохраняем обе версии в датасете
  code.dataset.rawScript = rawScript;
  code.dataset.enhancedScript = enhancedScript;
  code.dataset.enhancedInit = "true";

  // Проверяем состояние чекбокса "Исходный скрипт"
  const cb = document.getElementById(`script-raw-cb-${uniqueId}`);
  const isRaw = cb ? cb.checked : false;

  // Если чекбокс выключен (по умолчанию), показываем улучшенный скрипт
  if (!isRaw) {
    code.textContent = enhancedScript;
    delete code.dataset.lineNumbersApplied;
    initScriptLineNumbers(pre);
    initScriptWordHighlight();
  }
}

/**
 * Переключает отображение между исходным и улучшенным скриптом.
 *
 * @param {string} uniqueId - Уникальный ID таблицы
 * @param {boolean} isRaw - Включен ли чекбокс "Исходный скрипт"
 */
export function toggleScriptRawMode(uniqueId, isRaw) {
  const pre = document.getElementById(`script-${uniqueId}`);
  if (!pre) return;

  const code = pre.querySelector("code");
  if (!code) return;

  // Если скрипт еще не был инициализирован
  if (!code.dataset.enhancedInit) {
    initEnhancedScript(uniqueId);
  }

  const rawScript = getCleanScriptText(pre, code);
  const enhancedScript = code.dataset.enhancedScript || rawScript;

  // Переключаем содержимое
  code.textContent = isRaw ? rawScript : enhancedScript;

  // Сбрасываем флаг нумерации строк и перерисовываем
  delete code.dataset.lineNumbersApplied;
  initScriptLineNumbers(pre);
  initScriptWordHighlight();

  // Если контейнер Test (DDL + INSERT) открыт или отрендерен — обновляем его тоже
  const testContainer = document.getElementById(`test-script-container-${uniqueId}`);
  if (testContainer && testContainer.dataset.rendered) {
    delete testContainer.dataset.rendered;
    const switchBox = document.getElementById(`script-mode-switch-${uniqueId}`);
    const activeModeBtn = switchBox?.querySelector(".script-mode-btn.active");
    const mode = activeModeBtn?.dataset.mode || "dev";
    if (mode === "test") {
      switchScriptMode(uniqueId, "test", activeModeBtn);
    }
  }
}
