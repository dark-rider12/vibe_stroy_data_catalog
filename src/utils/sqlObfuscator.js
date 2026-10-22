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
  'SECOND', 'SECONDS', 'WEEK', 'WEEKS', 'MILLISECOND', 'MILLISECONDS', 'MICROSECOND', 'MICROSECONDS',
  'QUARTER', 'QUARTERS', 'DECADE', 'DECADES', 'CENTURY', 'CENTURIES', 'MILLENNIUM', 'MILLENNIA',
  'MILLENNIUMS', 'EPOCH', 'DOW', 'DOY', 'ISODOW', 'ISOYEAR',
  'TRUE', 'FALSE', 'CAST', 'COALESCE', 'NULLIF', 'COUNT', 'SUM', 'AVG', 'MIN',
  'MAX', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'NTILE', 'LAG', 'LEAD',
  'FIRST_VALUE', 'LAST_VALUE', 'BIGINT', 'INT', 'INTEGER', 'SMALLINT', 'TINYINT',
  'NUMERIC', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'BOOLEAN', 'DATE', 'TIME',
  'TIMESTAMP', 'TEXT', 'VARCHAR', 'CHAR', 'BYTEA', 'BLOB', 'CLOB', 'INTERVAL',
  'USING', 'NATURAL', 'ANY', 'SOME', 'UPPER', 'LOWER', 'SUBSTRING', 'TRIM',
  'COALESCE', 'CONCAT', 'ROUND', 'TRUNC', 'ABS', 'FLOOR', 'CEIL', 'CEILING',
  'EXTRACT', 'REPLACE', 'POSITION', 'SQL'
]);

// Стандартные уровни (единицы) усечения даты/времени в PostgreSQL (функция date_trunc, date_part)
export const DATE_TRUNC_UNITS = new Set([
  'microsecond', 'microseconds',
  'millisecond', 'milliseconds', 'ms',
  'second', 'seconds', 'sec', 'secs', 's',
  'minute', 'minutes', 'min', 'mins', 'm',
  'hour', 'hours', 'hr', 'hrs', 'h',
  'day', 'days', 'd',
  'week', 'weeks', 'w',
  'month', 'months', 'mon', 'mons',
  'quarter', 'quarters', 'qtr', 'qtrs',
  'year', 'years', 'yr', 'yrs', 'y',
  'decade', 'decades',
  'century', 'centuries', 'cent', 'cents',
  'millennium', 'millennia', 'millenniums', 'mil', 'mils',
  'epoch'
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
  'TIMETZ', 'MATERIALIZED', 'LATERAL', 'POSTGRE', 'POSTGRES', 'POSTGRESQL', 'PGSQL'
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
  'NONCLUSTERED', 'IDENTITY', 'SCHEMA_NAME', 'DB_NAME', 'OBJECT_NAME', 'COL_NAME',
  'MSSQL', 'TSQL'
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

  // 6. Уровни усечения date_trunc() / date_part() в PostgreSQL ('year', 'month', 'day', 'hour' и др.)
  if (DATE_TRUNC_UNITS.has(s.toLowerCase())) {
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
 * Удаляет однострочные (--) и многострочные (/* ... * /) комментарии из SQL,
 * не затрагивая строковые константы и экранированные идентификаторы.
 * Поддерживает PostgreSQL (включая вложенные комментарии /* /*...* / * / и dollar-quoting $$...$$)
 * и MS SQL (включая скобки [schema].[table]).
 * @param {string} sql
 * @param {'postgres'|'mssql'} dialect
 * @returns {string}
 */
export function stripSqlComments(sql, dialect = 'postgres') {
  if (!sql || typeof sql !== 'string') return '';
  const result = [];
  let i = 0;
  const len = sql.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBrackets = false; // для MS SQL [col]
  let inDollarQuote = false;
  let dollarTag = '';

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : '';

    // PostgreSQL dollar-quoting ($$...$$ или $tag$...$tag$)
    if (dialect === 'postgres' && !inSingleQuote && !inDoubleQuote) {
      if (!inDollarQuote && ch === '$') {
        const remainder = sql.slice(i);
        const match = remainder.match(/^\$([a-zA-Z0-9_]*)\$/);
        if (match) {
          inDollarQuote = true;
          dollarTag = match[0];
          result.push(dollarTag);
          i += dollarTag.length;
          continue;
        }
      } else if (inDollarQuote && ch === '$' && sql.startsWith(dollarTag, i)) {
        inDollarQuote = false;
        result.push(dollarTag);
        i += dollarTag.length;
        continue;
      }
    }

    if (inDollarQuote) {
      result.push(ch);
      i++;
      continue;
    }

    // MS SQL скобки [identifier]
    if (dialect === 'mssql' && !inSingleQuote && !inDoubleQuote) {
      if (!inBrackets && ch === '[') {
        inBrackets = true;
        result.push(ch);
        i++;
        continue;
      } else if (inBrackets && ch === ']') {
        inBrackets = false;
        result.push(ch);
        i++;
        continue;
      }
    }

    if (inBrackets) {
      result.push(ch);
      i++;
      continue;
    }

    // Одинарные кавычки ('...')
    if (ch === "'" && !inDoubleQuote) {
      if (inSingleQuote && next === "'") {
        result.push("''");
        i += 2;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      result.push(ch);
      i++;
      continue;
    }

    // Двойные кавычки ("...")
    if (ch === '"' && !inSingleQuote) {
      if (inDoubleQuote && next === '"') {
        result.push('""');
        i += 2;
        continue;
      }
      inDoubleQuote = !inDoubleQuote;
      result.push(ch);
      i++;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      // Однострочный комментарий: --
      if (ch === '-' && next === '-') {
        i += 2;
        while (i < len && sql[i] !== '\n' && sql[i] !== '\r') {
          i++;
        }
        continue;
      }
      // Многострочный блочный комментарий: /* ... */ (с поддержкой вложенности в PostgreSQL)
      if (ch === '/' && next === '*') {
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          if (sql[i] === '/' && sql[i + 1] === '*') {
            depth++;
            i += 2;
          } else if (sql[i] === '*' && sql[i + 1] === '/') {
            depth--;
            i += 2;
          } else {
            i++;
          }
        }
        result.push(' ');
        continue;
      }
    }

    result.push(ch);
    i++;
  }

  // Очистка пустых хвостов строк и избыточных тройных переводов строк
  return result.join('').replace(/[ \t]+$/gm, '').replace(/\n\s*\n\s*\n/g, '\n\n');
}

/**
 * Обезличивает промпт и SQL запрос.
 * @param {Object} params
 * @param {string} params.prompt
 * @param {string} params.sql
 * @param {'postgres'|'mssql'} [params.dialect='postgres']
 * @param {Object} [params.catalogData=null]
 * @param {boolean} [params.maskStrings=true] - маскировать ли строковые константы SQL
 * @param {boolean} [params.stripComments=true] - удалять ли однострочные и многострочные комментарии
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
  text = '',
  dialect = 'postgres',
  catalogData = null,
  maskStrings = true,
  stripComments = true
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

  // --- ЕДИНЫЙ РЕЖИМ (если передан text вместо раздельных prompt и sql) ---
  let unifiedInput = text || (!sql && prompt ? prompt : '');
  if (unifiedInput && !sql) {
    if (stripComments) {
      unifiedInput = stripSqlComments(unifiedInput, dialect);
    }
    let processedText = unifiedInput;

    // 1. Извлекаем строковые литералы
    if (maskStrings && processedText) {
      const stringLiteralRegex = dialect === 'mssql'
        ? /(?:N)?'([^']*(?:''[^']*)*)'/g
        : /(?:E)?'([^']*(?:''[^']*)*)'|\$\$([\s\S]*?)\$\$/g;

      processedText = processedText.replace(stringLiteralRegex, (match, singleContent, dollarContent) => {
        const content = singleContent !== undefined ? singleContent : dollarContent;
        if (!content || content.trim().length === 0) return match;

        // Даты, дата/время и интервалы НЕ искажать
        if (isDateTimeString(content.trim())) {
          const dtPlaceholder = `___PRESERVED_DT_${preservedDateTokens.length}___`;
          preservedDateTokens.push({ placeholder: dtPlaceholder, original: match });
          return dtPlaceholder;
        }

        const strKey = `__STR__:${match.trim().toLowerCase()}`;
        if (!originalToToken[strKey]) {
          const token = `STR_${String(strCounter++).padStart(3, '0')}`;
          originalToToken[strKey] = token;
          tokenToOriginal[token] = match;
          items.push({ token, original: match, type: 'string' });
        }
        return `'${originalToToken[strKey]}'`;
      });
    }

    // 2. Кандидаты на замену
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

    // 2b. Из SQL-парсера по тексту (все таблицы, алиасы, CTE, #temp, @var)
    const sqlTerms = extractSqlTerms(unifiedInput, dialect);
    for (const term of sqlTerms) {
      if (term && term.length >= 2 && !reserved.has(term.toUpperCase())) {
        candidateTerms.add(term);
      }
    }

    // 2c. Латинские слова с подчеркиваниями из промпта
    const promptWords = unifiedInput.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g) || [];
    for (const word of promptWords) {
      if (word.length >= 2 && !reserved.has(word.toUpperCase())) {
        if (candidateTerms.has(word) || word.includes('_')) {
          candidateTerms.add(word);
        }
      }
    }

    // 3. Сортировка по длине (по убыванию)
    const sortedTerms = Array.from(candidateTerms).sort((a, b) => b.length - a.length);
    for (const term of sortedTerms) {
      registerToken(term, 'identifier');
    }

    // 4. Замена по границам слова
    for (const term of sortedTerms) {
      const key = term.toLowerCase();
      const token = originalToToken[key];
      if (!token) continue;

      const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
      processedText = processedText.replace(regex, token);
    }

    // 5. Возврат дат
    if (preservedDateTokens && preservedDateTokens.length > 0) {
      for (const { placeholder, original } of preservedDateTokens) {
        processedText = processedText.replace(placeholder, original);
      }
    }

    return {
      obfuscatedPrompt: processedText,
      obfuscatedSql: '',
      combinedText: processedText.trim(),
      mapping: {
        tokenToOriginal,
        originalToToken,
        items
      }
    };
  }

  // --- РАЗДЕЛЬНЫЙ РЕЖИМ (обратная совместимость) ---
  // 1. Извлекаем строковые литералы из SQL (если включено)
  let processedSql = sql || '';
  if (stripComments && processedSql) {
    processedSql = stripSqlComments(processedSql, dialect);
  }
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
