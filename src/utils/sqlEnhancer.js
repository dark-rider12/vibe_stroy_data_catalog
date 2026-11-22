/**
 * MODULE: src/utils/sqlEnhancer.js
 * ROLE: Автоматическое улучшение читаемости SQL-скрипта:
 *       1. Квалификация полей (Column Qualification) по метаданным соединенных таблиц.
 *       2. Нормализация регистра ключевых слов (Capitalize Keywords).
 *       3. Явное добавление AS для псевдонимов колонок.
 *       4. Выравнивание отступов и джойнов (Prettify).
 */

/**
 * Список ключевых слов SQL для нормализации регистра.
 * Отсортированы по убыванию длины для корректного сопоставления составных операторов.
 */
const SQL_KEYWORDS = [
  "create or replace", "create table as", "create table", "create view", "create unlogged table",
  "left outer join", "right outer join", "full outer join",
  "left join", "right join", "full join", "inner join", "cross join", "natural join",
  "partition by", "order by", "group by", "is not null", "is null", "union all",
  "nulls first", "nulls last", "row_number", "dense_rank",
  "select", "distinct", "from", "where", "having", "limit", "offset",
  "join", "on", "as", "and", "or", "not", "in", "is", "null",
  "between", "like", "ilike", "exists", "case", "when", "then", "else", "end",
  "union", "intersect", "except", "with", "table", "view", "unlogged",
  "asc", "desc", "over", "coalesce", "nullif", "count", "sum", "avg", "min", "max",
  "round", "cast", "lag", "lead", "rank", "true", "false"
];

/**
 * Слова, которые не могут быть псевдонимом колонки (зарезервированные структурные ключевые слова).
 */
const NON_ALIAS_KEYWORDS = new Set([
  "FROM", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "JOIN", "LEFT", "RIGHT", "INNER", "FULL", "CROSS", "ON",
  "UNION", "EXCEPT", "INTERSECT", "AND", "OR", "CASE", "WHEN", "THEN", "ELSE", "END",
  "OVER", "ASC", "DESC", "PARTITION"
]);

/**
 * Маскирует строковые литералы и комментарии, заменяя их на токены-заглушки.
 *
 * @param {string} sql
 * @returns {{ maskedSql: string, tokens: string[] }}
 */
export function maskStringsAndComments(sql) {
  if (!sql) return { maskedSql: "", tokens: [] };

  const tokens = [];
  let i = 0;
  let out = "";

  while (i < sql.length) {
    // Однострочный комментарий: --
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const comment = end === -1 ? sql.slice(i) : sql.slice(i, end);
      const placeholder = `___SQL_TOKEN_${tokens.length}___`;
      tokens.push(comment);
      out += placeholder;
      i += comment.length;
      continue;
    }

    // Многострочный комментарий: /* ... */
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const comment = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
      const placeholder = `___SQL_TOKEN_${tokens.length}___`;
      tokens.push(comment);
      out += placeholder;
      i += comment.length;
      continue;
    }

    // Строковый литерал в одинарных кавычках: '...'
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2; // Экранированная одинарная кавычка ''
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      const str = sql.slice(i, j);
      const placeholder = `___SQL_TOKEN_${tokens.length}___`;
      tokens.push(str);
      out += placeholder;
      i = j;
      continue;
    }

    // Долларовые кавычки PostgreSQL: $$ ... $$ или $tag$ ... $tag$
    if (sql[i] === "$") {
      const tagMatch = sql.slice(i).match(/^(\$[a-zA-Z0-9_]*\$)/);
      if (tagMatch) {
        const tag = tagMatch[1];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          const str = sql.slice(i, end + tag.length);
          const placeholder = `___SQL_TOKEN_${tokens.length}___`;
          tokens.push(str);
          out += placeholder;
          i += str.length;
          continue;
        }
      }
    }

    out += sql[i];
    i++;
  }

  return { maskedSql: out, tokens };
}

/**
 * Восстанавливает замаскированные строки и комментарии.
 *
 * @param {string} maskedSql
 * @param {string[]} tokens
 * @returns {string}
 */
export function unmaskStringsAndComments(maskedSql, tokens) {
  if (!maskedSql || !tokens || tokens.length === 0) return maskedSql;
  let out = maskedSql;
  for (let idx = tokens.length - 1; idx >= 0; idx--) {
    const placeholder = `___SQL_TOKEN_${idx}___`;
    out = out.split(placeholder).join(tokens[idx]);
  }
  return out;
}

/**
 * ПРАВИЛО 2: Нормализация регистра ключевых слов (Capitalize Keywords).
 * Приводит операторы к верхнему регистру вне строк и комментариев.
 *
 * @param {string} sql
 * @returns {string}
 */
export function capitalizeKeywords(sql) {
  if (!sql) return "";
  const { maskedSql, tokens } = maskStringsAndComments(sql);

  let res = maskedSql;
  const sortedKeywords = [...SQL_KEYWORDS].sort((a, b) => b.length - a.length);

  for (const kw of sortedKeywords) {
    const words = kw.split(/\s+/);
    const pattern = words.map((w) => `\\b${w}\\b`).join("\\s+");
    const regex = new RegExp(pattern, "gi");
    res = res.replace(regex, (match) => {
      // Сохраняем исходное количество внутренних пробелов между словами оператора
      const matchWords = match.split(/\s+/);
      return matchWords.map((w) => w.toUpperCase()).join(" ");
    });
  }

  return unmaskStringsAndComments(res, tokens);
}

/**
 * Разбивает строку на элементы по разделителю верхнего уровня (игнорируя разделители внутри скобок).
 *
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[]}
 */
export function splitTopLevel(text, delimiter = ",") {
  const items = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
    } else if (char === delimiter && depth === 0) {
      items.push(text.slice(start, i));
      start = i + 1;
    }
  }
  items.push(text.slice(start));
  return items;
}

/**
 * ПРАВИЛО 3: Явное добавление AS для псевдонимов колонок.
 * Преобразует неявные псевдонимы вида `a.col new_col` в `a.col AS new_col`.
 *
 * @param {string} selectListSql - Текст между SELECT и FROM
 * @returns {string}
 */
export function ensureExplicitColumnAliasesInSelectList(selectListSql) {
  if (!selectListSql) return "";

  // Разбиваем по запятым верхнего уровня
  const items = splitTopLevel(selectListSql, ",");

  const formattedItems = items.map((rawItem) => {
    // Выделяем начальные и конечные пробелы
    const matchLead = rawItem.match(/^(\s*)/);
    const lead = matchLead ? matchLead[1] : "";
    const matchTrail = rawItem.match(/(\s*)$/);
    const trail = matchTrail ? matchTrail[1] : "";
    const trimmed = rawItem.trim();

    if (!trimmed) return rawItem;

    // Если уже есть явный AS на верхнем уровне
    const asParts = splitTopLevel(trimmed, " ");
    const hasTopLevelAs = asParts.some((p) => p.trim().toUpperCase() === "AS");
    if (hasTopLevelAs) {
      return rawItem;
    }

    // Ищем структуру: <выражение> <псевдоним>
    // Псевдоним должен быть валидным идентификатором
    const aliasRegex = /^(.*?[^,\s])\s+([a-zA-Z_][a-zA-Z0-9_]*)$/;
    const m = trimmed.match(aliasRegex);
    if (m) {
      const expr = m[1].trim();
      const alias = m[2].trim();

      // Проверяем, что alias не является ключевым словом
      if (!NON_ALIAS_KEYWORDS.has(alias.toUpperCase())) {
        // Проверяем, что expr не является просто DISTINCT
        if (expr.toUpperCase() !== "DISTINCT") {
          return `${lead}${expr} AS ${alias}${trail}`;
        }
      }
    }

    return rawItem;
  });

  return formattedItems.join(",");
}

/**
 * Извлекает таблицы и их алиасы из секций FROM и JOIN.
 *
 * @param {string} fromAndJoinsSql - Текст начиная с FROM
 * @returns {Array<{ rawTable: string, alias: string }>}
 */
export function extractTablesAndAliases(fromAndJoinsSql) {
  if (!fromAndJoinsSql) return [];

  const results = [];
  const tableRegex = /\b(?:FROM|(?:LEFT|RIGHT|FULL|INNER|CROSS|NATURAL)?\s*(?:OUTER\s+)?JOIN)\s+([a-zA-Z0-9_."`]+)(?:\s+(?:AS\s+)?(?!\b(?:LEFT|RIGHT|FULL|INNER|CROSS|JOIN|ON|WHERE|GROUP|ORDER|HAVING|LIMIT)\b)([a-zA-Z0-9_]+))?/gi;

  let match;
  while ((match = tableRegex.exec(fromAndJoinsSql)) !== null) {
    const rawTable = match[1];
    let alias = match[2];

    if (!alias) {
      // Если алиас не указан явно, используем имя таблицы без схемы
      const clean = rawTable.replace(/["'`]/g, "").trim();
      const parts = clean.split(".");
      alias = parts[parts.length - 1];
    }

    results.push({
      rawTable,
      alias
    });
  }

  return results;
}

/**
 * Ищет список колонок для таблицы в структуре catalogData.
 *
 * @param {string} rawTable - Имя таблицы из запроса (например, 'core.account_detail' или 'ext_ods.client')
 * @param {Object} catalogData - Метаданные каталога
 * @param {string} currentDb - Текущая БД контекста
 * @returns {Set<string>}
 */
export function getTableColumnsFromCatalog(rawTable, catalogData, currentDb = "dds") {
  const colSet = new Set();
  if (!rawTable || !catalogData) return colSet;

  const clean = rawTable.replace(/["'`]/g, "").trim().toLowerCase();
  const parts = clean.split(".");

  let db = currentDb;
  let schema = "";
  let table = "";

  if (parts.length === 3) {
    db = parts[0];
    schema = parts[1];
    table = parts[2];
  } else if (parts.length === 2) {
    schema = parts[0];
    table = parts[1];
  } else {
    table = parts[0];
  }

  // Обработка foreign-table соглашений: ext_ods -> ods.core, ext_dds -> dds.core, ext_calc -> dds.calc
  if (schema === "ext_ods") {
    db = "ods";
    schema = "core";
  } else if (schema === "ext_dds") {
    db = "dds";
    schema = "core";
  } else if (schema === "ext_calc") {
    db = "dds";
    schema = "calc";
  }

  // 1. Поиск по вычисленным db и schema
  if (db && schema && catalogData[db]?.[schema]?.[table]?.columns) {
    catalogData[db][schema][table].columns.forEach((c) => colSet.add(c.name.toLowerCase()));
    return colSet;
  }

  // 2. Если schema указана, а db нет или не найдена — ищем по базам в порядке приоритета: dds, dm, ods
  const dbOrder = [currentDb, "dds", "dm", "ods"];
  for (const d of dbOrder) {
    if (schema && catalogData[d]?.[schema]?.[table]?.columns) {
      catalogData[d][schema][table].columns.forEach((c) => colSet.add(c.name.toLowerCase()));
      return colSet;
    }
  }

  // 3. Если schema не указана — ищем таблицу во всех доступных схемах
  for (const d of Object.keys(catalogData)) {
    for (const s of Object.keys(catalogData[d] || {})) {
      if (catalogData[d][s]?.[table]?.columns) {
        catalogData[d][s][table].columns.forEach((c) => colSet.add(c.name.toLowerCase()));
        return colSet;
      }
    }
  }

  return colSet;
}

/**
 * ПРАВИЛО 1: Квалификация полей (Column Qualification).
 * Если в соединённых таблицах поле присутствует ровно в одной из них, подставляет её алиас.
 *
 * @param {string} selectListSql - Текст между SELECT и FROM
 * @param {Array<{ alias: string, cols: Set<string> }>} joinedTables - Список таблиц с колонками
 * @returns {string}
 */
export function qualifyColumnsInSelectList(selectListSql, joinedTables) {
  if (!selectListSql || !joinedTables || joinedTables.length <= 1) {
    return selectListSql;
  }

  // Разбиваем по элементам SELECT
  const items = splitTopLevel(selectListSql, ",");

  const qualifiedItems = items.map((rawItem) => {
    // В каждом элементе SELECT находим идентификаторы колонок
    // Исключаем ключевые слова, функции (с открывающей скобкой после них) и уже квалифицированные поля
    const identRegex = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/g;

    return rawItem.replace(identRegex, (ident, offset, fullStr) => {
      const lowerIdent = ident.toLowerCase();

      // Проверяем контекст:
      // 1. Если перед идентификатором стоит точка: `table.col` -> уже квалифицирован
      if (offset > 0 && fullStr[offset - 1] === ".") {
        return ident;
      }

      // 2. Если после идентификатора стоит точка: `table.col` -> это квалификатор
      const nextCharIdx = offset + ident.length;
      if (nextCharIdx < fullStr.length && fullStr[nextCharIdx] === ".") {
        return ident;
      }

      // 3. Если после идентификатора (возможно через пробелы) стоит скобка `(` -> это функция
      const afterStr = fullStr.slice(nextCharIdx).trimStart();
      if (afterStr.startsWith("(")) {
        return ident;
      }

      // 4. Если это зарезервированное ключевое слово
      if (SQL_KEYWORDS.includes(lowerIdent) || NON_ALIAS_KEYWORDS.has(ident.toUpperCase())) {
        return ident;
      }

      // 5. Проверяем, является ли идентификатор псевдонимом после AS (или неявным)
      const beforeStr = fullStr.slice(0, offset).trimEnd();
      if (/\bAS$/i.test(beforeStr)) {
        return ident;
      }

      // 6. Ищем, в скольких соединенных таблицах есть такое поле
      const matchingTables = joinedTables.filter((t) => t.cols.has(lowerIdent));

      // Квалифицируем ТОЛЬКО если поле присутствует СТРОГО в одной таблице!
      if (matchingTables.length === 1) {
        const tableAlias = matchingTables[0].alias;
        return `${tableAlias}.${ident}`;
      }

      // Если в 0 или >1 таблицах — оставляем как есть для безопасности
      return ident;
    });
  });

  return qualifiedItems.join(",");
}

/**
 * ПРАВИЛО 4: Выравнивание отступов и джойнов (Prettify).
 * Переносит JOIN ... ON ... и логические связки AND/OR на отдельные строки с единым отступом в 4 пробела.
 *
 * @param {string} fromAndAfterSql - Текст начиная с секции FROM
 * @returns {string}
 */
export function prettifyJoinsAndConditions(fromAndAfterSql) {
  if (!fromAndAfterSql) return "";

  const lines = fromAndAfterSql.split("\n");
  const result = [];

  for (let line of lines) {
    let trimmed = line.trim();
    if (!trimmed) {
      result.push("");
      continue;
    }

    // Если строка содержит JOIN ... ON ... на одной строке
    // Переносим ON на следующую строку с отступом в 4 пробела
    const joinOnMatch = trimmed.match(/^((?:LEFT|RIGHT|FULL|INNER|CROSS|NATURAL)?\s*(?:OUTER\s+)?JOIN\s+[\s\S]+?)\s+\bON\b\s+([\s\S]+)$/i);
    if (joinOnMatch) {
      const joinPart = joinOnMatch[1].trim();
      const onPart = joinOnMatch[2].trim();

      result.push(joinPart);

      // Разбиваем условия в ON по AND/OR верхнего уровня
      const onTokens = onPart.split(/\s+\b(AND|OR)\b\s+/i);
      if (onTokens.length > 1) {
        // Первая часть идет с префиксом ON
        result.push(`    ON ${onTokens[0].trim()}`);
        // Последующие части идут с оператором AND/OR
        for (let k = 1; k < onTokens.length; k += 2) {
          const op = onTokens[k].toUpperCase();
          const cond = onTokens[k + 1] ? onTokens[k + 1].trim() : "";
          if (cond) {
            result.push(`    ${op} ${cond}`);
          }
        }
      } else {
        result.push(`    ON ${onPart}`);
      }
      continue;
    }

    // Если строка уже начинается с ON
    if (/^ON\b/i.test(trimmed)) {
      result.push(`    ${trimmed}`);
      continue;
    }

    // Если строка в секции WHERE или ON содержит условия AND/OR
    if (/^WHERE\b/i.test(trimmed)) {
      const whereMatch = trimmed.match(/^WHERE\s+([\s\S]+)$/i);
      if (whereMatch) {
        const whereCond = whereMatch[1].trim();
        const whereTokens = whereCond.split(/\s+\b(AND|OR)\b\s+/i);
        if (whereTokens.length > 1) {
          result.push(`WHERE ${whereTokens[0].trim()}`);
          for (let k = 1; k < whereTokens.length; k += 2) {
            const op = whereTokens[k].toUpperCase();
            const cond = whereTokens[k + 1] ? whereTokens[k + 1].trim() : "";
            if (cond) {
              result.push(`    ${op} ${cond}`);
            }
          }
          continue;
        }
      }
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * ГЛАВНАЯ ФУНКЦИЯ: Комплексное улучшение SQL-скрипта.
 *
 * @param {string} sql - Исходный SQL скрипт
 * @param {Object} [options]
 * @param {Object} [options.catalogData] - Метаданные каталога
 * @param {string} [options.currentDb] - Текущая БД контекста
 * @param {string} [options.currentSchema] - Текущая схема контекста
 * @param {string} [options.currentTable] - Текущая таблица контекста
 * @returns {string} Улучшенный SQL
 */
export function enhanceSqlScript(sql, options = {}) {
  if (!sql || typeof sql !== "string") return "";

  const catalogData = options.catalogData || (typeof window !== "undefined" ? window.catalogData : null);
  const currentDb = options.currentDb || "dds";

  // 1. Маскируем строки и комментарии для безопасной обработки
  const { maskedSql, tokens } = maskStringsAndComments(sql);

  // Ищем секции SELECT и FROM
  const fromRegex = /(\s+FROM\s+)/i;
  const fromMatch = maskedSql.match(fromRegex);

  let processedSql = maskedSql;

  if (fromMatch) {
    const fromIndex = fromMatch.index;
    const beforeFrom = maskedSql.slice(0, fromIndex);
    const fromAndAfter = maskedSql.slice(fromIndex);

    // Находим SELECT
    const selectMatch = beforeFrom.match(/(\bSELECT\s+)([\s\S]*)$/i);
    if (selectMatch) {
      const prefix = beforeFrom.slice(0, selectMatch.index) + selectMatch[1];
      let selectBody = selectMatch[2];

      // Правило 3: Явный AS для псевдонимов колонок
      selectBody = ensureExplicitColumnAliasesInSelectList(selectBody);

      // Правило 1: Квалификация полей (если есть соединенные таблицы и catalogData)
      if (catalogData) {
        const extracted = extractTablesAndAliases(fromAndAfter);
        if (extracted.length > 1) {
          const joinedTables = extracted.map((t) => ({
            alias: t.alias,
            cols: getTableColumnsFromCatalog(t.rawTable, catalogData, currentDb)
          }));
          selectBody = qualifyColumnsInSelectList(selectBody, joinedTables);
        }
      }

      // Правило 4: Форматирование JOIN и связок AND/OR
      const formattedFromAndAfter = prettifyJoinsAndConditions(fromAndAfter);

      processedSql = prefix + selectBody + formattedFromAndAfter;
    }
  }

  // 2. Восстанавливаем строки и комментарии
  let unmasked = unmaskStringsAndComments(processedSql, tokens);

  // 3. Правило 2: Нормализация регистра ключевых слов
  const finalEnhanced = capitalizeKeywords(unmasked);

  return finalEnhanced;
}
