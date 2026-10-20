/* 
MODULE: src/utils/helpers.js
ROLE: Переиспользуемые функции, не привязанные к конкретному UI.
*/

import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

export function copyText(text, btnElement) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const originalHTML = btnElement.innerHTML;
      btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="color: #047857;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      setTimeout(() => {
        btnElement.innerHTML = originalHTML;
      }, 2000);
    })
    .catch((err) => console.error("Ошибка копирования: ", err));
}

export function copySearchResult(text, event, btnElement) {
  event.stopPropagation();
  navigator.clipboard
    .writeText(text)
    .then(() => {
      const originalHTML = btnElement.innerHTML;
      btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" style="color: #047857;"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      setTimeout(() => {
        btnElement.innerHTML = originalHTML;
      }, 2000);
    })
    .catch((err) => console.error("Ошибка копирования: ", err));
}

export function copyTableData(tableId, btnElement) {
  const table = document.querySelector(`#tbl-${tableId}`);
  if (!table) return;

  const cleanCellText = (text) => text.replace(/\s+/g, " ").trim();
  const escapeHtml = (text) =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  const headerCells = Array.from(table.querySelectorAll("thead th"));
  const rows = table.querySelectorAll("tbody tr");
  const columnsToCopy = headerCells
    .map((th, index) => ({ index, title: cleanCellText(th.innerText) }))
    .filter((col) => col.title);

  let textToCopy = `${columnsToCopy.map((col) => col.title).join("\t")}\n`;
  let htmlToCopy = `
<table style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 10pt;">
  <thead>
    <tr>
      ${columnsToCopy.map((col) => `<th style="border: 1px solid #bfbfbf; padding: 6px; background: #f2f2f2; font-weight: bold; text-align: left;">${escapeHtml(col.title)}</th>`).join("")}
    </tr>
  </thead>
  <tbody>
`;

  rows.forEach((row) => {
    const cells = row.querySelectorAll("td");
    const values = columnsToCopy.map((col) => cleanCellText(cells[col.index]?.innerText || ""));
    textToCopy += `${values.join("\t")}\n`;
    htmlToCopy += `
    <tr>
      ${values.map((value) => `<td style="border: 1px solid #bfbfbf; padding: 6px; vertical-align: top;">${escapeHtml(value)}</td>`).join("")}
    </tr>
`;
  });

  htmlToCopy += `
  </tbody>
</table>`;

  const writeClipboard = () => {
    if (navigator.clipboard && window.ClipboardItem) {
      return navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([htmlToCopy], { type: "text/html" }),
          "text/plain": new Blob([textToCopy], { type: "text/plain" }),
        }),
      ]);
    }
    return navigator.clipboard.writeText(textToCopy);
  };

  writeClipboard()
    .then(() => {
      const originalHTML = btnElement.innerHTML;
      const originalColor = btnElement.style.color;
      btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> Скопировано!`;
      btnElement.style.color = "#047857";
      setTimeout(() => {
        btnElement.innerHTML = originalHTML;
        btnElement.style.color = originalColor;
      }, 2000);
    })
    .catch((err) => {
      console.error("Ошибка при копировании: ", err);
      alert("Не удалось скопировать данные.");
    });
}

export function getStringHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, "_");
}

export function highlightMatch(text, query) {
  if (!text) return "";
  const regex = new RegExp(
    `(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
    "gi",
  );
  return text.replace(regex, '<span class="highlight">$1</span>');
}

export function copyScriptContent(uniqueId, btnElement) {
  let pre = document.getElementById(`script-${uniqueId}`);
  if (!pre || pre.tagName.toLowerCase() !== "pre") {
    pre = document.getElementById(uniqueId);
  }
  if (!pre || pre.tagName.toLowerCase() !== "pre") return;

  // Собираем только текст кода, без номеров строк
  const lineCodes = pre.querySelectorAll(".line-code");
  const text = lineCodes.length > 0
    ? Array.from(lineCodes).map(el => el.textContent).join("\n")
    : pre.innerText;

  navigator.clipboard.writeText(text)
    .then(() => {
      const originalHTML = btnElement.innerHTML;
      const originalColor = btnElement.style.color;
      btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg> Скопировано!`;
      btnElement.style.color = "#047857";
      setTimeout(() => {
        btnElement.innerHTML = originalHTML;
        btnElement.style.color = originalColor;
      }, 2000);
    })
    .catch((err) => console.error("Ошибка копирования: ", err));
}

export function copyDqScript(elementId, btnElement) {
  const container = document.getElementById(elementId);
  if (!container) return;
  const text = container.textContent.trim();
  navigator.clipboard.writeText(text)
    .then(() => {
      const originalHTML = btnElement.innerHTML;
      btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Скопировано!`;
      btnElement.classList.add("copied");
      setTimeout(() => {
        btnElement.innerHTML = originalHTML;
        btnElement.classList.remove("copied");
      }, 2000);
    })
    .catch((err) => console.error("Ошибка копирования DQ скрипта: ", err));
}

export function generateDqScript(uniqueId, db, schema, table) {
  const selectEl = document.getElementById(`dq-select-${uniqueId}`);
  if (!selectEl) return;
  const colName = selectEl.value;
  if (!colName) return;

  const subtextEl = document.getElementById(`dq-subtext-${uniqueId}`);
  if (subtextEl) {
    const options = Array.from(selectEl.options);
    const isFirstCol = options.length > 0 && options[0].value === colName;
    const isFirstId = isFirstCol && colName.toLowerCase().endsWith("_id");
    const labelText = isFirstId ? "первое поле с постфиксом <code>_id</code>." : "выбранное поле для проверки.";
    subtextEl.innerHTML = `<code>${colName}</code> — ${labelText}`;
  }

  let constraintsMap = {};
  try {
    const rawData = selectEl.getAttribute("data-constraints");
    if (rawData) constraintsMap = JSON.parse(rawData);
  } catch (e) {
    console.error("Failed to parse constraints map", e);
  }

  const badgeEl = document.getElementById(`dq-badge-${uniqueId}`);
  const badgeTextEl = document.getElementById(`dq-badge-text-${uniqueId}`);
  const constraintType = constraintsMap[colName];
  if (badgeEl && badgeTextEl) {
    if (constraintType) {
      badgeTextEl.textContent = constraintType;
      badgeEl.style.display = "";
    } else {
      badgeEl.style.display = "none";
    }
  }

  const scriptEl = document.getElementById(`dq-script-${uniqueId}`);
  if (scriptEl) {
    const sql = `select ${colName}, count(*)\nfrom ${db}.${schema}.${table}\ngroup by ${colName}\nhaving count(*)>1;\n`;
    const codeTag = scriptEl.querySelector("code");
    if (codeTag) {
      codeTag.textContent = sql;
    } else {
      scriptEl.textContent = sql;
    }
  }
}

export function generateFillDqScript(uniqueId, db, schema, table) {
  const selectEl = document.getElementById(`dq-fill-select-${uniqueId}`);
  if (!selectEl) return;
  const colName = selectEl.value;
  if (!colName) return;

  const subtextEl = document.getElementById(`dq-fill-subtext-${uniqueId}`);
  const colNameEl = document.getElementById(`dq-fill-colname-${uniqueId}`);
  if (subtextEl && colNameEl) {
    colNameEl.textContent = colName;
    subtextEl.innerHTML = `<code>${colName}</code> — выбранное поле для проверки заполненности.`;
  }

  const scriptEl = document.getElementById(`dq-fill-script-${uniqueId}`);
  if (scriptEl) {
    const cleanColName = colName.replace(/[^a-zA-Z0-9_]/g, '_');
    const sql = `SELECT COUNT(*) AS total_rows, 
COUNT(${colName}) AS filled_rows,
    ROUND(100.0 * COUNT(${colName}) / NULLIF(COUNT(*), 0), 2)
        AS fill_percentage_${cleanColName}
FROM ${db}.${schema}.${table};`;
    const codeTag = scriptEl.querySelector("code");
    if (codeTag) {
      codeTag.textContent = sql;
    } else {
      scriptEl.textContent = sql;
    }
  }
}

export function initDqScripts() {
  // Инициализируем все существующие скрипты DQ для дублей
  document.querySelectorAll('.dq-col-select[id^="dq-select-"]').forEach(selectEl => {
    const id = selectEl.id;
    if (id && id.startsWith('dq-select-')) {
      const uniqueId = id.substring('dq-select-'.length);
      const db = selectEl.dataset.db || '';
      const schema = selectEl.dataset.schema || '';
      const table = selectEl.dataset.table || '';
      generateDqScript(uniqueId, db, schema, table);
    }
  });

  // Инициализируем все скрипты для проверки заполненности
  document.querySelectorAll('.dq-col-select[id^="dq-fill-select-"]').forEach(selectEl => {
    const id = selectEl.id;
    if (id && id.startsWith('dq-fill-select-')) {
      const uniqueId = id.substring('dq-fill-select-'.length);
      const db = selectEl.dataset.db || '';
      const schema = selectEl.dataset.schema || '';
      const table = selectEl.dataset.table || '';
      generateFillDqScript(uniqueId, db, schema, table);
    }
  });
}

/**
 * Добавляет нумерацию строк в блоки скрипта (стиль DBeaver).
 * Номера строк некликабельны и не выделяются мышкой.
 */
export function initScriptLineNumbers(root = document) {
  const blocks = root.querySelectorAll(".table-script-block code");
  blocks.forEach((code) => {
    // Не обрабатывать повторно
    if (code.dataset.lineNumbersApplied) return;
    code.dataset.lineNumbersApplied = "true";

    const raw = code.textContent;
    // Убираем trailing newline чтобы не получить пустую последнюю строку
    const lines = raw.replace(/\n$/, "").split("\n");

    const fragment = document.createDocumentFragment();
    let inMultilineComment = false;
    lines.forEach((line, i) => {
      const row = document.createElement("span");
      row.className = "script-line";

      const num = document.createElement("span");
      num.className = "line-num";
      num.textContent = i + 1;

      const content = document.createElement("span");
      content.className = "line-code";
      
      // Разбираем строку на части: код и комментарии
      const parts = parseLineForComments(line, inMultilineComment);
      inMultilineComment = parts.inMultilineComment;
      
      // Создаем фрагмент для содержимого строки
      const lineFragment = document.createDocumentFragment();
      parts.segments.forEach(segment => {
        const span = document.createElement("span");
        span.textContent = segment.text;
        if (segment.isComment) {
          span.className = "sql-comment";
        }
        lineFragment.appendChild(span);
      });
      content.appendChild(lineFragment);

      row.appendChild(num);
      row.appendChild(content);
      fragment.appendChild(row);
    });

    code.textContent = "";
    code.appendChild(fragment);
  });
}

/**
 * Разбирает строку на сегменты кода и комментариев.
 * Возвращает объект с сегментами и флагом inMultilineComment.
 */
function parseLineForComments(line, inMultilineComment) {
  const segments = [];
  let pos = 0;
  let currentInMultiline = inMultilineComment;

  // Если уже внутри многострочного комментария
  if (currentInMultiline) {
    const closePos = line.indexOf("*/");
    if (closePos !== -1) {
      // Комментарий закрывается в этой строке
      segments.push({ text: line.substring(0, closePos + 2), isComment: true });
      if (closePos + 2 < line.length) {
        segments.push({ text: line.substring(closePos + 2), isComment: false });
      }
      currentInMultiline = false;
    } else {
      // Вся строка - комментарий
      segments.push({ text: line, isComment: true });
    }
    return { segments, inMultilineComment: currentInMultiline };
  }

  // Ищем начальные комментарии -- в начале строки (с учетом отступов)
  const trimmed = line.trimStart();
  const leadingWhitespace = line.length - trimmed.length;
  
  if (trimmed.startsWith("--")) {
    // Вся строка от -- до конца - комментарий
    segments.push({ text: line.substring(0, leadingWhitespace), isComment: false });
    segments.push({ text: line.substring(leadingWhitespace), isComment: true });
    return { segments, inMultilineComment: false };
  }

  // Ищем /* и */ в строке
  let searchPos = 0;
  while (searchPos < line.length) {
    const openPos = line.indexOf("/*", searchPos);
    const dashPos = line.indexOf("--", searchPos);
    
    // Находим ближайший маркер комментария
    let nextCommentPos = -1;
    let commentType = null;
    
    if (openPos !== -1 && (dashPos === -1 || openPos < dashPos)) {
      nextCommentPos = openPos;
      commentType = "block";
    } else if (dashPos !== -1) {
      nextCommentPos = dashPos;
      commentType = "line";
    }
    
    // Если не найдено больше комментариев - остаток строки это код
    if (nextCommentPos === -1) {
      if (searchPos < line.length) {
        segments.push({ text: line.substring(searchPos), isComment: false });
      }
      break;
    }
    
    // Добавляем код до начала комментария
    if (nextCommentPos > searchPos) {
      segments.push({ text: line.substring(searchPos, nextCommentPos), isComment: false });
    }
    
    if (commentType === "block") {
      // Нашли /* - ищем соответствующий */
      const closePos = line.indexOf("*/", nextCommentPos + 2);
      if (closePos !== -1) {
        // Комментарий на одной строке
        segments.push({ text: line.substring(nextCommentPos, closePos + 2), isComment: true });
        searchPos = closePos + 2;
      } else {
        // Многострочный комментарий начинается здесь
        segments.push({ text: line.substring(nextCommentPos), isComment: true });
        currentInMultiline = true;
        searchPos = line.length;
      }
    } else if (commentType === "line") {
      // Однострочный комментарий -- до конца строки
      segments.push({ text: line.substring(nextCommentPos), isComment: true });
      searchPos = line.length;
    }
  }

  return { segments, inMultilineComment: currentInMultiline };
}

/**
 * Подсветка всех вхождений выделенного слова в блоке скрипта (стиль DBeaver).
 * Срабатывает при выделении целого слова мышкой.
 */
export function initScriptWordHighlight() {
  // Очистить все подсветки в блоке
  function clearHighlights(code) {
    code.querySelectorAll(".word-highlight, .word-highlight-selected").forEach((mark) => {
      const parent = mark.parentNode;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    });
  }

  // Подсветить все вхождения word в .line-code элементах (все — светлым классом)
  function applyHighlights(code, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");

    code.querySelectorAll(".line-code").forEach((lineEl) => {
      const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      let node;
      while ((node = walker.nextNode())) textNodes.push(node);

      textNodes.forEach((textNode) => {
        const text = textNode.textContent;
        if (!re.test(text)) return;
        re.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
          if (m.index > last) {
            frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          }
          const mark = document.createElement("span");
          mark.className = "word-highlight";
          mark.textContent = m[0];
          frag.appendChild(mark);
          last = m.index + m[0].length;
        }
        if (last < text.length) {
          frag.appendChild(document.createTextNode(text.slice(last)));
        }
        textNode.parentNode.replaceChild(frag, textNode);
      });
    });
  }

  // Пометить тёмным классом тот span, который пользователь выделил (по смещению в строке)
  function markSelectedOccurrence(lineEl, charOffset) {
    const highlights = lineEl.querySelectorAll(".word-highlight");
    for (const hl of highlights) {
      const range = document.createRange();
      range.selectNodeContents(lineEl);
      range.setEnd(hl, 0);
      const offsetBefore = range.toString().length;
      if (offsetBefore <= charOffset && charOffset < offsetBefore + hl.textContent.length) {
        hl.classList.remove("word-highlight");
        hl.classList.add("word-highlight-selected");
        return;
      }
    }
  }

  document.querySelectorAll(".table-script-block").forEach((pre) => {
    if (pre.dataset.wordHighlightApplied) return;
    pre.dataset.wordHighlightApplied = "true";

    const code = pre.querySelector("code");
    if (!code) return;

    pre.addEventListener("mouseup", () => {
      const sel = window.getSelection();
      const selectedText = sel ? sel.toString() : "";
      const word = selectedText.trim();

      // До изменения DOM — запоминаем, в какой строке и на каком смещении начато выделение
      let anchorLineEl = null;
      let anchorCharOffset = -1;
      if (word.length >= 2 && !/\s/.test(word) && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        let node = range.startContainer;
        while (node && !(node.classList && node.classList.contains("line-code"))) {
          node = node.parentNode;
        }
        if (node) {
          anchorLineEl = node;
          const lineRange = document.createRange();
          lineRange.selectNodeContents(anchorLineEl);
          lineRange.setEnd(range.startContainer, range.startOffset);
          anchorCharOffset = lineRange.toString().length;
        }
      }

      // Сбрасываем предыдущую подсветку
      clearHighlights(code);

      if (word.length >= 2 && !/\s/.test(word)) {
        applyHighlights(code, word);
        // Выделенное вхождение помечаем тёмнее
        if (anchorLineEl && anchorCharOffset >= 0) {
          markSelectedOccurrence(anchorLineEl, anchorCharOffset);
        }
        // Восстанавливаем выделение на подсвеченном span, чтобы Ctrl+C работал
        const marked = code.querySelector(".word-highlight-selected");
        if (marked && sel) {
          const restoreRange = document.createRange();
          restoreRange.selectNodeContents(marked);
          sel.removeAllRanges();
          sel.addRange(restoreRange);
        }
      }
    });
  });

  // Сброс подсветки при клике вне блока скрипта
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".table-script-block")) {
      document.querySelectorAll(".table-script-block code").forEach(clearHighlights);
    }
  });
}

/**
 * Определяет, является ли выражение передачей 1:1 (без преобразований).
 * Паттерн: "table.column" или просто "column" — без функций, операторов, CASE и т.д.
 */
function isDirectMapping(expression) {
  if (!expression) return false;
  // Допускаем только: слова, точки, пробелы по краям
  // Запрещаем: скобки, операторы, ключевые слова SQL-функций
  const trimmed = expression.trim();
  return /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(trimmed);
}

/**
 * Ищет описание колонки в catalogData по полному пути таблицы и имени колонки.
 * source_table формат: "DWH.schema.table_name"
 */
function findSourceColumnDescription(sourceTable, sourceColumn) {
  if (!window.catalogData || !sourceTable || !sourceColumn) return null;
  const parts = sourceTable.split('.');
  if (parts.length < 3) return null;
  const [db, schema, table] = parts;
  const col = window.catalogData?.[db]?.[schema]?.[table]?.columns?.find(
    c => c.name.toLowerCase() === sourceColumn.toLowerCase()
  );
  return col?.description ?? null;
}

export const TECHNICAL_FIELDS = {
  'source_system_id': 'ID системы-источника. Ссылка на dds.core.ref_source_system',
  'is_active': 'Признак актуальности',
  'is_deleted': 'Признак удаления записи в системе-источнике',
  'dwh_start_date': 'Дата начала действия записи',
  'dwh_end_date': 'Дата окончания действия записи',
  'etl_process_id': 'ID ETL процесса. Ссылка на справочник ref_etl_process'
};

/**
 * Генерирует блок COMMENT ON COLUMN для витрины dm или таблиц dds.
 * Открывает модальное окно с результатом.
 */
export function fillDmComments(uniqueId, dbName, schemaName, tableName) {
  const tableData = window.catalogData?.[dbName]?.[schemaName]?.[tableName];
  if (!tableData) {
    alert('Данные таблицы не найдены в catalogData');
    return;
  }

  const fullTableName = `${dbName}.${schemaName}.${tableName}`;
  const lines = []; // { sql: string, type: 'existing'|'new'|'empty'|'aliased'|'aliased-empty'|'transformed' }

  // Хелпер: "DWH.dds.account_detail" → "dds.account_detail"
  const shortRef = (dotPath) => dotPath.split('.').slice(1).join('.');

  for (const col of tableData.columns) {
    const colName = col.name;
    const colDesc = col.description;
    const lineageInfo = tableData.column_lineage?.[colName.toLowerCase()];

    const sources = lineageInfo?.sources ?? [];
    const expression = lineageInfo?.expression ?? '';

    // Случай 1: комментарий уже есть
    if (colDesc) {
      lines.push({
        sql: `COMMENT ON COLUMN ${fullTableName}.${colName} IS '${colDesc.replace(/'/g, "''")}';`,
        type: 'existing'
      });
      continue;
    }

    // Технические поля в DDS
    const colNameLower = colName.toLowerCase();
    if (dbName.toLowerCase() === 'dds' && TECHNICAL_FIELDS[colNameLower]) {
      lines.push({
        sql: `COMMENT ON COLUMN ${fullTableName}.${colName} IS '${TECHNICAL_FIELDS[colNameLower].replace(/'/g, "''")}';`,
        type: 'new'
      });
      continue;
    }

    // Нет комментария — анализируем lineage
    const isSingleSource = sources.length === 1;
    const isDirect = isSingleSource && isDirectMapping(expression);

    if (isDirect) {
      const src = sources[0];
      const srcDesc = findSourceColumnDescription(src.source_table, src.source_column);
      const isAliased = colName.toLowerCase() !== src.source_column.toLowerCase();

      if (isAliased) {
        // Случай 4а: псевдоним + в источнике есть комментарий
        // Случай 4б: псевдоним + в источнике тоже нет комментария
        const srcRef = shortRef(src.source_table);
        if (srcDesc) {
          lines.push({
            sql: `--COMMENT ON COLUMN ${fullTableName}.${colName} IS '${srcDesc.replace(/'/g, "''")}'; -- alias of ${srcRef}.${src.source_column}`,
            type: 'aliased'
          });
        } else {
          lines.push({
            sql: `--COMMENT ON COLUMN ${fullTableName}.${colName} IS ''; -- alias of ${srcRef}.${src.source_column}, no description in source`,
            type: 'aliased-empty'
          });
        }
      } else if (srcDesc) {
        // Случай 2: 1:1, комментарий есть в источнике — новый комментарий
        lines.push({
          sql: `COMMENT ON COLUMN ${fullTableName}.${colName} IS '${srcDesc.replace(/'/g, "''")}';`,
          type: 'new'
        });
      } else {
        // Случай 3: 1:1, но в источнике тоже нет комментария
        lines.push({
          sql: `--COMMENT ON COLUMN ${fullTableName}.${colName} IS ''; -- no description in source ${shortRef(src.source_table)}.${src.source_column}`,
          type: 'empty'
        });
      }
    } else {
      // Случай 6: нет данных lineage вообще (скрипт таблицы отсутствует в sql_inventory)
      if (!expression && sources.length === 0) {
        lines.push({
          sql: `--COMMENT ON COLUMN ${fullTableName}.${colName} IS ''; -- no lineage data`,
          type: 'no-data'
        });
      } else {
        // Случай 5: вычисляемое выражение или несколько источников
        const exprText = expression ? expression.replace(/'/g, "''") : '';
        lines.push({
          sql: `--COMMENT ON COLUMN ${fullTableName}.${colName} IS '${exprText}';`,
          type: 'transformed'
        });
      }
    }
  }

  _showFillCommentsModal(tableName, lines);
}

/**
 * Отображает модальное окно с результатами генерации COMMENT ON COLUMN.
 */
function _showFillCommentsModal(tableName, lines) {
  // Удаляем предыдущий модал если есть
  document.getElementById('fill-comments-modal')?.remove();

  const typeConfig = {
    existing:      { bg: '',          label: '' },
    new:           { bg: '#d1fae5',   label: '● новый' },
    empty:         { bg: '#fef9c3',   label: '● нет описания в источнике' },
    aliased:       { bg: '#fef3c7',   label: '● псевдоним' },
    'aliased-empty': { bg: '#f3e8ff', label: '● псевдоним, источник пустой' },
    transformed:   { bg: '#fee2e2',   label: '● вычисляемое' },
    'no-data':     { bg: '#f1f5f9',   label: '● нет данных lineage' },
  };

  const rowsHtml = lines.map(({ sql, type }) => {
    const cfg = typeConfig[type] || typeConfig.existing;
    const bgStyle = cfg.bg ? `background:${cfg.bg};` : '';
    const labelHtml = cfg.label
      ? `<span class="fcm-label fcm-label-${type}">${cfg.label}</span>`
      : '';
    const isCommented = sql.trimStart().startsWith('--');
    const codeClass = isCommented ? 'fcm-code fcm-code--muted' : 'fcm-code';
    return `<div class="fcm-row" style="${bgStyle}"><code class="${codeClass}">${_escHtml(sql)}</code>${labelHtml}</div>`;
  }).join('');

  const modal = document.createElement('div');
  modal.id = 'fill-comments-modal';
  modal.className = 'fcm-overlay';
  modal.innerHTML = `
    <div class="fcm-dialog" id="fcm-dialog">
      <div class="fcm-resizer fcm-resizer--left"  id="fcm-resizer-left"></div>
      <div class="fcm-resizer fcm-resizer--right" id="fcm-resizer-right"></div>
      <div class="fcm-header">
        <span class="fcm-title">COMMENT ON COLUMN — <b>${_escHtml(tableName)}</b></span>
        <div class="fcm-header-actions">
          <button class="fcm-copy-btn" id="fcm-copy-btn" title="Скопировать всё">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            Скопировать
          </button>
          <button class="fcm-close-btn" id="fcm-close-btn" title="Закрыть">✕</button>
        </div>
      </div>
      <div class="fcm-legend">
        <span class="fcm-label fcm-label-new">● новый</span> — найден в источнике &nbsp;
        <span class="fcm-label fcm-label-empty">● нет описания в источнике</span> — 1:1, но источник тоже пустой &nbsp;
        <span class="fcm-label fcm-label-aliased">● псевдоним</span> — переименован через AS, описание из источника &nbsp;
        <span class="fcm-label fcm-label-aliased-empty">● псевдоним, источник пустой</span> — AS + источник без описания &nbsp;
        <span class="fcm-label fcm-label-transformed">● вычисляемое</span> — есть преобразование &nbsp;
        <span class="fcm-label fcm-label-no-data">● нет данных lineage</span> — скрипт таблицы отсутствует в sql_inventory
      </div>
      <div class="fcm-body">${rowsHtml}</div>
    </div>
  `;

  document.body.appendChild(modal);

  // Закрытие
  document.getElementById('fcm-close-btn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Копирование
  document.getElementById('fcm-copy-btn').addEventListener('click', () => {
    const allSql = lines.map(l => l.sql).join('\n');
    navigator.clipboard.writeText(allSql).then(() => {
      const btn = document.getElementById('fcm-copy-btn');
      if (!btn) return;
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ Скопировано!';
      btn.style.color = '#059669';
      setTimeout(() => { btn.innerHTML = orig; btn.style.color = ''; }, 2000);
    });
  });

  // Ресайз по левому и правому краям
  _initFcmResize(
    document.getElementById('fcm-dialog'),
    document.getElementById('fcm-resizer-left'),
    document.getElementById('fcm-resizer-right')
  );
}

/**
 * Инициализирует ресайз диалога за левый и правый края.
 * Тянем левый ползунок — диалог расширяется влево (и вправо симметрично).
 * Тянем правый ползунок — аналогично.
 * Реализовано через изменение width диалога; диалог центрирован flex-контейнером.
 */
function _initFcmResize(dialog, resizerLeft, resizerRight) {
  const MIN_W = 400;
  const MAX_W = window.innerWidth - 48; // 24px padding с каждой стороны

  function startResize(e, side) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = dialog.offsetWidth;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      // Левый ползунок: тянем влево — увеличиваем (dx отрицательный → ширина растёт)
      // Правый ползунок: тянем вправо — увеличиваем (dx положительный → ширина растёт)
      const delta = side === 'left' ? -dx : dx;
      const newW = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
      dialog.style.width = newW + 'px';
      dialog.style.maxWidth = 'none';
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  resizerLeft.addEventListener('mousedown',  e => startResize(e, 'left'));
  resizerRight.addEventListener('mousedown', e => startResize(e, 'right'));
}

function _escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function exportTableToHTML(uniqueId, dbName, schemaName, tableName, objectType) {
  // Показываем модальное окно с формой вместо немедленного скачивания
  _showExportModal(uniqueId, dbName, schemaName, tableName, objectType);
}

/**
 * Показывает модальное окно с формой экспорта.
 */
function _showExportModal(uniqueId, dbName, schemaName, tableName, objectType) {
  document.getElementById('export-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'export-modal';
  modal.className = 'exp-overlay';
  modal.innerHTML = `
    <div class="exp-dialog" id="exp-dialog">
      <div class="exp-header">
        <span class="exp-title">📄 Создание файла документации</span>
        <button class="exp-close-btn" id="exp-close-btn" title="Закрыть">✕</button>
      </div>
      <div class="exp-body">
        <div class="exp-field">
          <label class="exp-label" for="exp-short-name">Краткое название</label>
          <input class="exp-input" id="exp-short-name" type="text"
                 placeholder="Например: Клиенты, Транзакции за месяц…" autocomplete="off">
        </div>
        <div class="exp-field">
          <label class="exp-label">Добавьте файл-шаблон .docx</label>
          <div class="exp-dropzone" id="exp-dropzone">
            <div class="exp-dropzone-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="none"
                   viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"
                   stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </div>
            <div class="exp-dropzone-text">
              Перетащите файл сюда<br>или <b id="exp-browse-link">выберите через Обзор</b>
            </div>
            <div class="exp-file-selected" id="exp-file-name" style="display:none;">
              ✓ <span id="exp-file-name-text"></span>
            </div>
          </div>
          <input type="file" id="exp-file-input" accept=".docx" style="display:none;">
        </div>
      </div>
      <div class="exp-footer">
        <button class="exp-cancel-btn" id="exp-cancel-btn">Отмена</button>
        <button class="exp-submit-btn" id="exp-submit-btn">Создать файл</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const fileInput    = document.getElementById('exp-file-input');
  const dropzone     = document.getElementById('exp-dropzone');
  const browseLink   = document.getElementById('exp-browse-link');
  const fileNameEl   = document.getElementById('exp-file-name');
  const fileNameText = document.getElementById('exp-file-name-text');

  // Фокус на поле ввода — Enter работает сразу без клика по полю
  document.getElementById('exp-short-name').focus();

  let selectedFile = null;

  // Кнопка «Обзор» — открывает диалог выбора файла
  browseLink.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });
  dropzone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) _setFile(fileInput.files[0]);
  });

  // Drag-and-drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.docx')) {
      _setFile(file);
    } else if (file) {
      alert('Пожалуйста, перетащите файл с расширением .docx');
    }
  });

  function _setFile(file) {
    selectedFile = file;
    fileNameText.textContent = file.name;
    fileNameEl.style.display = 'flex';
  }

  // Вспомогательная функция отправки формы
  function _submit() {
    const shortName = document.getElementById('exp-short-name').value.trim();
    modal.remove();
    _buildAndDownloadHTML(uniqueId, dbName, schemaName, tableName, objectType, shortName, selectedFile);
  }

  // Закрытие
  document.getElementById('exp-close-btn').addEventListener('click', () => modal.remove());
  document.getElementById('exp-cancel-btn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  // Enter / Escape — глобальный обработчик, работает при любом фокусе пока модал открыт
  function _onDocKeydown(e) {
    if (!document.getElementById('export-modal')) {
      document.removeEventListener('keydown', _onDocKeydown);
      return;
    }
    if (e.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', _onDocKeydown);
    } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      document.removeEventListener('keydown', _onDocKeydown);
      _submit();
    }
  }
  document.addEventListener('keydown', _onDocKeydown);

  // Создать файл
  document.getElementById('exp-submit-btn').addEventListener('click', _submit);
}

/**
 * Вычисляет имя скачиваемого файла по типу объекта, краткому названию и расширению.
 */
function _buildFileName(dbName, schemaName, tableName, objectType, shortName, ext) {
  let filePrefix;
  if (objectType === 'v' || objectType === 'm') {
    filePrefix = 'Описание вью';
  } else if (dbName.toLowerCase() === 'dm') {
    filePrefix = 'Описание витрины';
  } else {
    filePrefix = 'Описание таблицы';
  }
  const isManualRef = schemaName.toLowerCase() === 'core' && tableName.toLowerCase().startsWith('ref_manual_');
  const manualSuffix = isManualRef ? ' (справочник, обновляемый вручную)' : '';
  const shortNamePart = shortName ? ` ${shortName}` : '';
  return `${filePrefix}${shortNamePart}${manualSuffix} ${dbName}_${schemaName}_${tableName}.${ext}`;
}

/**
 * Если передан файл-шаблон .docx — возвращает его с правильным именем (без замены тегов).
 * Если шаблон не передан — генерирует и скачивает HTML-файл.
 */
function _buildAndDownloadHTML(uniqueId, dbName, schemaName, tableName, objectType, shortName, templateFile) {
  if (templateFile) {
    _downloadDocxAsIs(templateFile, uniqueId, dbName, schemaName, tableName, objectType, shortName);
    return;
  }
  // Получаем данные таблицы из DOM
  const table = document.querySelector(`#tbl-${uniqueId}`);
  if (!table) {
    alert("Ошибка: таблица не найдена");
    return;
  }

  // Получаем описание таблицы
  const tableDesc = document.querySelector(`#${uniqueId} .table-description`)?.innerText.trim() || "Описание отсутствует";
  const sources = document.querySelector(`#${uniqueId} .table-sources`)?.innerText.trim() || "";

  // Строим HTML документ
  let htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 40px;
      color: #1e293b;
    }
    h1 {
      color: #0f172a;
      border-bottom: 3px solid #3B82F6;
      padding-bottom: 10px;
    }
    h2 {
      color: #334155;
      margin-top: 30px;
    }
    .meta {
      background: #f1f5f9;
      padding: 15px;
      border-radius: 8px;
      margin: 20px 0;
      line-height: 1.6;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 20px;
      table-layout: fixed;
    }
    th {
      background: #3B82F6;
      color: white;
      padding: 8px;
      text-align: left;
      font-weight: 600;
      font-size: 11pt;
    }
    td {
      padding: 8px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 10pt;
      vertical-align: top;
      word-wrap: break-word;
    }
    tr:hover {
      background: #f8fafc;
    }
    .type-badge {
      background: #e0e7ff;
      color: #3730a3;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10pt;
      font-weight: 600;
    }
    .notnull-yes {
      color: #059669;
      font-weight: 600;
    }
    .notnull-no {
      color: #dc2626;
      font-weight: 600;
    }
    code {
      background: #f1f5f9;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 9pt;
    }
  </style>
</head>
<body>
  <h1>${dbName}.${schemaName}.${tableName}</h1>
  
  <div class="meta">
    <h2>Описание</h2>
    <p>${tableDesc}</p>
    ${sources ? `<p><strong>${sources}</strong></p>` : ''}
  </div>

  <h2>Структура таблицы</h2>
  <table>
    <colgroup>
      <col style="width: 5%;">
      <col style="width: 18%;">
      <col style="width: 15%;">
      <col style="width: 22%;">
      <col style="width: 20%;">
      <col style="width: 10%;">
      <col style="width: 10%;">
    </colgroup>
    <thead>
      <tr>
        <th>№ п/п</th>
        <th>Функц. наим-е атрибута</th>
        <th>Тип данных</th>
        <th>Бизнес описание</th>
        <th>Алгоритм заполнения</th>
        <th>Система источник</th>
        <th>Обязательность заполнения</th>
      </tr>
    </thead>
    <tbody>
`;

  // Добавляем строки таблицы (без последней колонки с кнопкой lineage)
  const rows = table.querySelectorAll('tbody tr');
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 7) {
      const num = cells[0].innerText;
      const name = cells[1].innerText;
      const type = cells[2].innerText;
      const desc = cells[3].innerText;
      const expr = cells[4].innerText;
      const sources = cells[5].innerText;
      const notnull = cells[6].innerText;

      const notnullClass = notnull === 'Да' ? 'notnull-yes' : 'notnull-no';
      const emptyMarkers = new Set(["-", "—"]);
      const descHtml = emptyMarkers.has(desc) ? "" : desc;
      const exprHtml = emptyMarkers.has(expr) || !expr ? "" : `<code>${expr}</code>`;
      const sourcesHtml = emptyMarkers.has(sources) ? "" : sources;

      htmlContent += `
      <tr>
        <td>${num}</td>
        <td><strong>${name}</strong></td>
        <td><span class="type-badge">${type}</span></td>
        <td>${descHtml}</td>
        <td>${exprHtml}</td>
        <td>${sourcesHtml}</td>
        <td class="${notnullClass}">${notnull}</td>
      </tr>
`;
    }
  });

  htmlContent += `
    </tbody>
  </table>

  <div style="margin-top: 40px; padding-top: 20px; border-top: 2px solid #e2e8f0; color: #64748b; font-size: 12px;">
    <p>Сгенерировано из DWH Catalog | ${new Date().toLocaleString('ru-RU')}</p>
  </div>
</body>
</html>`;

  const fileName = _buildFileName(dbName, schemaName, tableName, objectType, shortName, 'html');

  // Создаем Blob и скачиваем файл
  const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Принимает .docx файл-шаблон, заменяет теги через docxtemplater и скачивает результат.
 */
function _downloadDocxAsIs(templateFile, uniqueId, dbName, schemaName, tableName, objectType, shortName) {
  const fileName = _buildFileName(dbName, schemaName, tableName, objectType, shortName, 'docx');

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const zip = new PizZip(e.target.result);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter(part) {
          if (!part.module) {
            return '{' + part.value + '}';
          }
          return '';
        },
      });

      // Капитализация первой буквы краткого названия
      const shortRus = shortName
        ? shortName.charAt(0).toUpperCase() + shortName.slice(1)
        : '';

      // Первые два слова имени файла (например "Описание витрины")
      const fullFileName = _buildFileName(dbName, schemaName, tableName, objectType, shortName, 'docx');
      const fileName2Words = fullFileName.split(' ').slice(0, 2).join(' ');

      // Текущая дата в формате дд/мм/гггг
      const now = new Date();
      const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

      // Комментарий к таблице из DOM
      const tableDescEl = document.querySelector(`#${uniqueId} .table-description`);
      const commentOnTable = tableDescEl ? tableDescEl.innerText.trim() : '';

      // Строки таблицы колонок из DOM
      const domTable = document.querySelector(`#tbl-${uniqueId}`);
      const rows = [];
      if (domTable) {
        domTable.querySelectorAll('tbody tr').forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 7) {
            rows.push({
              num:         cells[0].innerText.trim(),
              col_name:    cells[1].innerText.trim(),
              col_type:    cells[2].innerText.trim(),
              description: cells[3].innerText.trim(),
              expression:  cells[4].innerText.trim(),
              sources:     cells[5].innerText.trim(),
              notnull:     cells[6].innerText.trim(),
            });
          }
        });
      }

      // Содержимое вкладки "Скрипт" — берём из catalogData, а не из DOM (чтобы не было нумерации строк)
      let scriptContent = '';
      if (objectType !== 'v' && objectType !== 'm') {
        const scriptData = window.catalogData?.[dbName]?.[schemaName]?.[tableName];
        if (scriptData) {
          const mainScript = (scriptData.sql_script || '').trim();
          const extraScript = (scriptData.sql_script_extra || '').trim();
          scriptContent = mainScript && extraScript ? `${mainScript}\n\n\n${extraScript}` : mainScript || extraScript;
        }
      }

      // Primary key: из catalogData, для вью — прочерк
      let primaryKey = '-';
      if (objectType !== 'v' && objectType !== 'm') {
        const pkData = window.catalogData?.[dbName]?.[schemaName]?.[tableName]?.primary_key;
        const dqInfo = window.catalogData?.[dbName]?.[schemaName]?.[tableName]?.dq_info?.duplicate_protection;
        const hasPk = pkData && pkData.columns && pkData.columns.length > 0;
        const hasDqProtection = dqInfo && dqInfo.has_unique_index && dqInfo.has_unique_constraint;
        
        if (hasPk && hasDqProtection) {
          primaryKey = 'Лишний primary_key - нужно исправить!!!';
        } else if (hasDqProtection) {
          const firstCol = dqInfo.first_col_name || rows[0]?.col_name || '';
          primaryKey = `CREATE UNIQUE INDEX ${tableName}_idx
ON ${dbName}.${schemaName}.${tableName} (${firstCol})
WHERE is_active = true;

ALTER TABLE ${dbName}.${schemaName}.${tableName}
ADD CONSTRAINT ${tableName}_unique_version
UNIQUE (${firstCol}, dwh_start_date);`;
        } else if (hasPk) {
          primaryKey = pkData.columns.join(', ');
        } else {
          primaryKey = 'нет primary key';
        }
      }

      // История: проверяем наличие полей dwh_start_date и dwh_end_date
      // Для dds.ref_manual_* — история не применима, оставляем пустым для ручного заполнения
      const isManualRefTable = schemaName.toLowerCase() === 'core' && tableName.toLowerCase().startsWith('ref_manual_');
      let history = '-';
      if (isManualRefTable) {
        history = '⚠';
      } else if (objectType !== 'v' && objectType !== 'm') {
        const colNames = rows.map(r => r.col_name.toLowerCase());
        if (colNames.includes('dwh_start_date') && colNames.includes('dwh_end_date')) {
          history = 'таблица содержит исторические данные';
        } else {
          history = 'таблица не содержит исторические данные';
        }
      }

      // Данные для замены тегов
      doc.render({
        name: `${dbName}.${schemaName}.${tableName}`,
        short_rus: shortRus,
        file_name: fileName2Words,
        date: dateStr,
        comment_on_table: commentOnTable,
        rows,
        script: scriptContent,
        primary_key: primaryKey,
        history,
      });

      const out = doc.getZip().generate({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      const url = URL.createObjectURL(out);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Ошибка при обработке .docx шаблона:', err);
      alert('Ошибка при обработке шаблона. Проверьте формат файла и теги.');
    }
  };
  reader.readAsArrayBuffer(templateFile);
}
