/* 
MODULE: src/utils/sqlObfuscator.js
ROLE: Чистая логика обфускации и деобфускации промптов и SQL-скриптов для безопасной работы с нейросетями.
Поддерживает диалекты PostgreSQL и MS SQL.
*/

// Общие ключевые слова ANSI SQL
export const COMMON_SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER',
  'CROSS', 'ON', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC', 'NULLS',
  'FIRST', 'LAST', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'ALL',
  'DISTINCT', 'AS', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT',
  'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'WITH', 'RECURSIVE', 'INSERT',
  'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'VIEW', 'INDEX',
  'DROP', 'ALTER', 'ADD', 'COLUMN', 'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'CHECK', 'DEFAULT', 'UNIQUE', 'OVER', 'PARTITION', 'WINDOW',
  'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'CURRENT', 'ROW',
  'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'LOCALTIME', 'LOCALTIMESTAMP',
  'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'CURRENT_ROLE', 'CURRENT_SCHEMA', 'CURRENT_CATALOG',
  'DAY', 'DAYS', 'MONTH', 'MONTHS', 'YEAR', 'YEARS', 'HOUR', 'HOURS', 'MINUTE', 'MINUTES',
  'SECOND', 'SECONDS', 'WEEK', 'WEEKS', 'MILLISECOND', 'MICROSECOND', 'QUARTER', 'DECADE',
  'CENTURY', 'MILLENNIUM', 'EPOCH', 'DOW', 'DOY', 'ISODOW', 'ISOYEAR',
  'TRUE', 'FALSE', 'CAST', 'COALESCE', 'NULLIF', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
  'FIRST_VALUE', 'LAST_VALUE', 'BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'TINYINT',
  'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'BOOLEAN', 'DATE', 'TIME',
  'TIMESTAMP', 'TEXT', 'VARCHAR', 'CHAR', 'BYTEA', 'BLOB', 'CLOB', 'INTERVAL',
  'USING', 'NATURAL', 'ANY', 'SOME', 'UPPER', 'LOWER', 'SUBSTRING', 'TRIM',
  'COALESCE', 'CONCAT', 'ROUND', 'TRUNC', 'ABS', 'FLOOR', 'CEIL', 'CEILING',
  'EXTRACT', 'REPLACE', 'POSITION'
]);

// Специфические ключевые слова и функции PostgreSQL
export const POSTGRES_KEYWORDS = new Set([
  ...COMMON_SQL_KEYWORDS,
  'ILIKE', 'SIMILAR', 'RETURNING', 'DATE_TRUNC', 'DATE_PART', 'AGE',
  'STRING_AGG', 'ARRAY_AGG', 'GENERATE_SERIES', 'JSONB', 'JSON',
  'JSON_BUILD_OBJECT', 'JSONB_SET', 'JSONB_EXTRACT_PATH', 'JSONB_ARRAY_ELEMENTS',
  'UNLOGGED', 'CONFLICT', 'DO', 'NOTHING', 'CONCURRENTLY', 'FILTER', 'SPLIT_PART',
  'CONCAT_WS', 'TO_CHAR', 'TO_DATE', 'TO_NUMBER', 'TO_TIMESTAMP', 'NOW',
  'CLOCK_TIMESTAMP', 'STATEMENT_TIMESTAMP', 'MAKE_DATE', 'MAKE_TIME',
  'MAKE_TIMESTAMP', 'MAKE_TIMESTAMPTZ', 'MAKE_INTERVAL', 'JUSTIFY_DAYS',
  'JUSTIFY_HOURS', 'JUSTIFY_INTERVAL', 'BOOL_AND', 'BOOL_OR', 'VACUUM',
  'ANALYZE', 'EXPLAIN', 'PERFORM', 'RAISE', 'NOTICE', 'EXCEPTION', 'FOUND',
  'ROW_COUNT', 'SERIAL', 'BIGSERIAL', 'UUID', 'GEN_RANDOM_UUID', 'TIMESTAMPTZ',
  'TIMETZ'
]);

// Специфические ключевые слова, функции и хинты MS SQL (T-SQL)
export const MSSQL_KEYWORDS = new Set([
  ...COMMON_SQL_KEYWORDS,
  'TOP', 'NOLOCK', 'APPLY', 'ISNULL', 'LEN', 'GETDATE', 'SYSDATETIME',
  'SYSUTCDATETIME', 'GETUTCDATE', 'SYSDATETIMEOFFSET', 'DATEADD', 'DATEDIFF',
  'DATEPART', 'DATENAME', 'CONVERT', 'TRY_CONVERT', 'PARSE', 'TRY_PARSE',
  'CHARINDEX', 'PATINDEX', 'STUFF', 'STRING_SPLIT', 'STRING_ESCAPE', 'NVARCHAR',
  'NCHAR', 'NTEXT', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET',
  'BIT', 'MONEY', 'SMALLMONEY', 'UNIQUEIDENTIFIER', 'NEWID', 'NEWSEQUENTIALID',
  'IIF', 'CHOOSE', 'MERGE', 'MATCHED', 'OUTPUT', 'OPTION', 'RECOMPILE',
  'MAXRECURSION', 'OPTIMIZE', 'FOR', 'GO', 'EXEC', 'EXECUTE', 'DECLARE', 'BEGIN',
  'TRANSACTION', 'TRAN', 'COMMIT', 'ROLLBACK', 'TRY', 'CATCH', 'PRINT',
  'OBJECT_ID', 'SCOPE_IDENTITY', 'IDENT_CURRENT', 'QUOTENAME', 'HASHBYTES',
  'CHECKSUM', 'ROWCOUNT', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'CLUSTERED',
  'NONCLUSTERED', 'IDENTITY', 'SCHEMA_NAME', 'DB_NAME', 'OBJECT_NAME', 'COL_NAME'
]);

/**
 * Проверяет, является ли строка представлением даты, времени или интервала
 * (чтобы исключить их из обфускации и сохранить в оригинальном виде).
 * @param {string} str
 * @returns {boolean}
 */
export function isDateTimeString(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();

  // 1. ISO 8601 Date / DateTime: YYYY-MM-DD или YYYY/MM/DD (с опциональным временем)
  if (/^\d{4}[-/]\d{2}[-/]\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.test(s)) {
    return true;
  }

  // 2. Европейский / Российский формат: DD.MM.YYYY или DD/MM/YYYY (с опциональным временем)
  if (/^\d{2}[./]\d{2}[./]\d{4}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/i.test(s)) {
    return true;
  }

  // 3. Только время: HH:MM:SS или HH:MM
  if (/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    return true;
  }

  // 4. Формат даты YYYYMMDD (часто используется в DWH, партициях)
  if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(s)) {
    return true;
  }

  // 5. Выражения интервалов (например: '1 day', '7 days', '1 month', '12 hours', '1 год')
  if (/^\d+\s*(day|days|month|months|year|years|hour|hours|minute|minutes|second|seconds|week|weeks|день|дня|дней|месяц|месяца|месяцев|год|года|лет|час|часа|часов|минута|минуты|минут)$/i.test(s)) {
    return true;
  }

  return false;
}

/**
 * Извлекает все известные сущности DWH из window.catalogData:
 * базы данных, схемы, таблицы, вью, колонки.
 * @param {Object} catalogData
 * @returns {Set<string>}
 */
export function extractDwhTerms(catalogData) {
  const terms = new Set();
  if (!catalogData || typeof catalogData !== 'object') return terms;

  for (const [dbName, schemas] of Object.entries(catalogData)) {
    if (dbName && dbName !== 'source_system_map') {
      terms.add(dbName);
    }
    if (!schemas || typeof schemas !== 'object') continue;

    for (const [schemaName, tables] of Object.entries(schemas)) {
      if (schemaName && schemaName !== 'public') {
        terms.add(schemaName);
      }
      if (!tables || typeof tables !== 'object') continue;

      for (const [tableName, tableInfo] of Object.entries(tables)) {
        if (tableName) {
          terms.add(tableName);
        }
        if (tableInfo && Array.isArray(tableInfo.columns)) {
          for (const col of tableInfo.columns) {
            if (col && col.name) {
              terms.add(col.name);
            }
          }
        }
      }
    }
  }

  return terms;
}

/**
 * Извлекает идентификаторы (таблицы, алиасы, переменные, поля) из текста SQL
 * с учетом диалекта (PostgreSQL или MS SQL).
 * @param {string} sql
 * @param {'postgres'|'mssql'} dialect
 * @returns {Set<string>}
 */
export function extractSqlTerms(sql, dialect = 'postgres') {
  const terms = new Set();
  if (!sql || typeof sql !== 'string') return terms;

  const reserved = dialect === 'mssql' ? MSSQL_KEYWORDS : POSTGRES_KEYWORDS;

  // 1. Идентификаторы в кавычках / скобках
  if (dialect === 'mssql') {
    // [schema].[table] или [column]
    const bracketMatches = sql.matchAll(/\[([^\]]+)\]/g);
    for (const m of bracketMatches) {
      const val = m[1].trim();
      if (val && !reserved.has(val.toUpperCase())) {
        terms.add(val);
      }
    }
    // Переменные @var
    const varMatches = sql.matchAll(/@([a-zA-Z0-9_]+)/g);
    for (const m of varMatches) {
      const val = m[1].trim();
      if (val && !reserved.has(val.toUpperCase())) {
        terms.add(val);
      }
    }
    // Временные таблицы #temp или ##global_temp
    const tempMatches = sql.matchAll(/#{1,2}([a-zA-Z0-9_]+)/g);
    for (const m of tempMatches) {
      const val = m[1].trim();
      if (val && !reserved.has(val.toUpperCase())) {
        terms.add(val);
      }
    }
  }

  // PostgreSQL / ANSI двойные кавычки "identifier"
  const quotedMatches = sql.matchAll(/"([^"]+)"/g);
  for (const m of quotedMatches) {
    const val = m[1].trim();
    if (val && !reserved.has(val.toUpperCase())) {
      terms.add(val);
    }
  }

  // 2. Стандартные слова/идентификаторы (латиница + подчеркивания + цифры)
  const wordMatches = sql.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g);
  for (const m of wordMatches) {
    const val = m[1].trim();
    const upper = val.toUpperCase();
    if (val.length >= 2 && !reserved.has(upper) && !/^\d+$/.test(val)) {
      terms.add(val);
    }
  }

  return terms;
}

/**
 * Экранирует спецсимволы регулярного выражения
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Обезличивает промпт и SQL запрос.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {string} params.sql
 * @param {'postgres'|'mssql'} [params.dialect='postgres']
 * @param {Object} [params.catalogData=null]
 * @param {boolean} [params.maskStrings=true] - маскировать ли строковые константы SQL
 * @returns {{
 *   obfuscatedPrompt: string,
 *   obfuscatedSql: string,
 *   combinedText: string,
 *   mapping: {
 *     tokenToOriginal: Object.<string, string>,
 *     originalToToken: Object.<string, string>,
 *     items: Array<{token: string, original: string, type: string}>
 *   }
 * }}
 */
export function obfuscatePromptAndSql({
  prompt = '',
  sql = '',
  dialect = 'postgres',
  catalogData = null,
  maskStrings = true
}) {
  const reserved = dialect === 'mssql' ? MSSQL_KEYWORDS : POSTGRES_KEYWORDS;
  const tokenToOriginal = {};
  const originalToToken = {};
  const items = [];
  let objCounter = 1;
  let strCounter = 1;
  const preservedDateTokens = [];

  // Функция регистрации токена
  function registerToken(original, type = 'identifier') {
    const key = original.toLowerCase();
    if (originalToToken[key]) {
      return originalToToken[key];
    }
    const token = `OBJ_${String(objCounter++).padStart(3, '0')}`;
    originalToToken[key] = token;
    tokenToOriginal[token] = original;
    items.push({ token, original, type });
    return token;
  }

  // 1. Извлекаем строковые литералы из SQL (если включено)
  let processedSql = sql || '';
  if (maskStrings && processedSql) {
    // В MS SQL: N'...' или '...'
    // В PostgreSQL: '...' или $$...$$ или E'...'
    const stringLiteralRegex = dialect === 'mssql'
      ? /(?:N)?'([^']*(?:''[^']*)*)'/g
      : /(?:E)?'([^']*(?:''[^']*)*)'|\$\$([\s\S]*?)\$\$/g;

    processedSql = processedSql.replace(stringLiteralRegex, (match, singleContent, dollarContent) => {
      const content = singleContent !== undefined ? singleContent : dollarContent;
      // Если строка чисто пробельная или очень короткая/числовая, можно не шифровать
      if (!content || content.trim().length === 0) return match;

      // Даты, дата/время и интервалы НЕ искажать — сохраняем через временный плейсхолдер
      if (isDateTimeString(content.trim())) {
        const dtPlaceholder = `___PRESERVED_DT_${preservedDateTokens.length}___`;
        preservedDateTokens.push({ placeholder: dtPlaceholder, original: match });
        return dtPlaceholder;
      }

      const strKey = `__STR__:${match.trim().toLowerCase()}`;
      if (!originalToToken[strKey]) {
        const token = `STR_${String(strCounter++).padStart(3, '0')}`;
        originalToToken[strKey] = token;
        tokenToOriginal[token] = match; // сохраняем полный исходный литерал
        items.push({ token, original: match, type: 'string' });
      }
      return `'${originalToToken[strKey]}'`;
    });
  }

  // 2. Собираем всех кандидатов на замену
  const candidateTerms = new Set();

  // 2a. Из catalogData
  if (catalogData) {
    const dwhTerms = extractDwhTerms(catalogData);
    for (const term of dwhTerms) {
      if (term && term.length >= 2 && !reserved.has(term.toUpperCase())) {
        candidateTerms.add(term);
      }
    }
  }

  // 2b. Из SQL
  if (sql) {
    const sqlTerms = extractSqlTerms(sql, dialect);
    for (const term of sqlTerms) {
      if (term && term.length >= 2 && !reserved.has(term.toUpperCase())) {
        candidateTerms.add(term);
      }
    }
  }

  // 2c. Из промпта (любые латинские слова/идентификаторы, например deal_rk, dict_branch)
  if (prompt) {
    const promptWords = prompt.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g) || [];
    for (const word of promptWords) {
      if (word.length >= 2 && !reserved.has(word.toUpperCase())) {
        // Добавляем, если слово либо уже в кандидатах (например, из DWH или SQL),
        // либо выглядит как идентификатор с подчеркиванием (fct_deals, deal_rk)
        if (candidateTerms.has(word) || word.includes('_')) {
          candidateTerms.add(word);
        }
      }
    }
  }

  // 3. Сортируем термины по длине (по убыванию), чтобы избежать частичной замены подстрок!
  // Например: "fct_credit_deals" должно замениться раньше, чем "credit_deals" или "deals"
  const sortedTerms = Array.from(candidateTerms).sort((a, b) => b.length - a.length);

  // Регистрируем токены для всех кандидатов
  for (const term of sortedTerms) {
    registerToken(term, 'identifier');
  }

  // 4. Выполняем согласованную замену в промпте и SQL
  let obfuscatedPrompt = prompt || '';
  let obfuscatedSql = processedSql;

  for (const term of sortedTerms) {
    const key = term.toLowerCase();
    const token = originalToToken[key];
    if (!token) continue;

    // Регулярное выражение с границами слова (\b), регистронезависимо
    const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
    obfuscatedPrompt = obfuscatedPrompt.replace(regex, token);
    obfuscatedSql = obfuscatedSql.replace(regex, token);
  }

  // 4b. Возвращаем обратно неизменные даты и интервалы из плейсхолдеров
  if (preservedDateTokens && preservedDateTokens.length > 0) {
    for (const { placeholder, original } of preservedDateTokens) {
      obfuscatedSql = obfuscatedSql.replace(placeholder, original);
    }
  }

  // 5. Формируем объединенный текст для быстрой отправки в нейросеть
  let combinedText = '';
  if (obfuscatedPrompt && obfuscatedSql) {
    combinedText = `${obfuscatedPrompt.trim()}\n\n\`\`\`sql\n${obfuscatedSql.trim()}\n\`\`\``;
  } else if (obfuscatedPrompt) {
    combinedText = obfuscatedPrompt.trim();
  } else if (obfuscatedSql) {
    combinedText = `\`\`\`sql\n${obfuscatedSql.trim()}\n\`\`\``;
  }

  return {
    obfuscatedPrompt,
    obfuscatedSql,
    combinedText,
    mapping: {
      tokenToOriginal,
      originalToToken,
      items
    }
  };
}

/**
 * Восстанавливает исходные названия (деобфусцирует) в ответе нейросети.
 * @param {string} text - текст или SQL с токенами OBJ_xxx и STR_xxx
 * @param {Object} mapping - объект с картой соответствий tokenToOriginal
 * @returns {string} - восстановленный текст
 */
export function deobfuscateText(text, mapping) {
  if (!text || typeof text !== 'string') return '';
  if (!mapping || !mapping.tokenToOriginal) return text;

  let restored = text;
  const tokenToOriginal = mapping.tokenToOriginal;

  // Сортируем токены по длине по убыванию (на случай если токены разной длины)
  const tokens = Object.keys(tokenToOriginal).sort((a, b) => b.length - a.length);

  for (const token of tokens) {
    const original = tokenToOriginal[token];
    if (!original) continue;

    // Токен может встретиться в одинарных кавычках 'STR_001' (если это строка)
    if (token.startsWith('STR_')) {
      // Заменяем 'STR_xxx' или STR_xxx на исходный литерал
      const strRegex = new RegExp(`'?${escapeRegex(token)}'?`, 'gi');
      restored = restored.replace(strRegex, original);
    } else {
      // Заменяем OBJ_xxx с границами слова (\b), регистронезависимо
      const objRegex = new RegExp(`\\b${escapeRegex(token)}\\b`, 'gi');
      restored = restored.replace(objRegex, original);
    }
  }

  return restored;
}
