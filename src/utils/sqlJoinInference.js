/* 
MODULE: src/utils/sqlJoinInference.js
ROLE: Движок анализа и вывода связей (JOIN Inference Engine) для построения шаблонов витрин.
DESIGN: Модульная архитектура со стратегиями вывода связей (Strategy Pattern),
        позволяющая легко подключать новые эвристики, AI-модели и валидаторы в будущем.
*/

/**
 * Генерирует читаемый короткий алиас для таблицы (например, account_detail -> ad).
 * @param {string} tableName 
 * @param {Set<string>} existingAliases 
 * @returns {string}
 */
export function generateTableAlias(tableName, existingAliases = new Set()) {
  const cleanName = tableName.replace(/^v_/, "").replace(/^ext_/, "");
  const parts = cleanName.split("_").filter(Boolean);
  let baseAlias = "";

  if (parts.length >= 2) {
    baseAlias = parts.map(p => p[0]).join("").toLowerCase();
  } else if (cleanName.length > 0) {
    baseAlias = cleanName.substring(0, Math.min(3, cleanName.length)).toLowerCase();
  } else {
    baseAlias = "t";
  }

  // Если алиас уже занят, добавляем числовой суффикс
  let finalAlias = baseAlias;
  let counter = 2;
  while (existingAliases.has(finalAlias)) {
    finalAlias = `${baseAlias}${counter}`;
    counter++;
  }
  existingAliases.add(finalAlias);
  return finalAlias;
}

/**
 * Нормализует имя таблицы до "чистого" имени без внешних префиксов типа dm.ext_dds.
 * @param {string} fullName 
 * @returns {string}
 */
export function normalizeTableName(fullName) {
  if (!fullName) return "";
  const parts = fullName.split(".");
  return parts[parts.length - 1].toLowerCase().trim();
}

/**
 * Проверяет, является ли таблица или витрина временным черновиком (tmp_*).
 * @param {string|object} item 
 * @returns {boolean}
 */
export function isTemporaryTable(item) {
  if (!item) return false;
  const name = typeof item === "string" ? item : (item.table || item.name || "");
  const clean = normalizeTableName(name);
  return clean.startsWith("tmp_");
}

/**
 * Получает канонический ключ таблицы (db.schema.table).
 * @param {string|object} item 
 * @returns {string}
 */
export function getTableKey(item) {
  if (typeof item === "string") return item.toLowerCase();
  if (item && item.db && item.schema && item.table) {
    return `${item.db}.${item.schema}.${item.table}`.toLowerCase();
  }
  if (item && item.name) return item.name.toLowerCase();
  return "";
}

// ============================================================================
// БАЗА ЗНАНИЙ JOIN (Knowledge Graph)
// ============================================================================

class JoinKnowledgeGraph {
  constructor() {
    // Ребра графа: Map<tableKey, Map<otherTableKey, Array<JoinEdge>>>
    this.adjacency = new Map();
    // Индекс по голому имени таблицы (для гибкого матчинга cross-schema ссылок)
    this.nameIndex = new Map();
    this.isIndexed = false;
  }

  /**
   * Добавляет двунаправленное ребро связи между двумя таблицами.
   */
  addEdge(sourceKey, targetKey, edgeInfo) {
    const src = sourceKey.toLowerCase();
    const tgt = targetKey.toLowerCase();
    if (src === tgt) return;

    if (!this.adjacency.has(src)) this.adjacency.set(src, new Map());
    if (!this.adjacency.get(src).has(tgt)) this.adjacency.get(src).set(tgt, []);
    this.adjacency.get(src).get(tgt).push(edgeInfo);

    // Добавляем симметричное ребро для поиска обратных связей
    if (!this.adjacency.has(tgt)) this.adjacency.set(tgt, new Map());
    if (!this.adjacency.get(tgt).has(src)) this.adjacency.get(tgt).set(src, []);
    this.adjacency.get(tgt).get(src).push({
      ...edgeInfo,
      isReversed: true,
      originalLeftTable: edgeInfo.originalRightTable,
      originalRightTable: edgeInfo.originalLeftTable,
      originalLeftAlias: edgeInfo.originalRightAlias,
      originalRightAlias: edgeInfo.originalLeftAlias,
      condition: edgeInfo.condition
    });

    // Индексация по базовым именам
    const srcName = normalizeTableName(src);
    const tgtName = normalizeTableName(tgt);
    if (!this.nameIndex.has(srcName)) this.nameIndex.set(srcName, new Set());
    if (!this.nameIndex.has(tgtName)) this.nameIndex.set(tgtName, new Set());
    this.nameIndex.get(srcName).add(src);
    this.nameIndex.get(tgtName).add(tgt);
  }

  /**
   * Возвращает все известные связи между двумя таблицами (прямые).
   */
  getDirectEdges(tableA, tableB) {
    const keyA = getTableKey(tableA);
    const keyB = getTableKey(tableB);

    // 1. Точное совпадение по full key
    const direct = this.adjacency.get(keyA)?.get(keyB);
    if (direct && direct.length > 0) return direct;

    // 2. Матчинг по нормализованным именам таблиц (например, dds.core.acc vs dm.ext_dds.acc)
    const nameA = normalizeTableName(keyA);
    const nameB = normalizeTableName(keyB);

    const candidatesA = this.nameIndex.get(nameA) || [keyA];
    const candidatesB = this.nameIndex.get(nameB) || [keyB];

    for (const cA of candidatesA) {
      for (const cB of candidatesB) {
        const edges = this.adjacency.get(cA)?.get(cB);
        if (edges && edges.length > 0) return edges;
      }
    }

    return null;
  }
}

// Глобальный синглтон базы знаний
export const knowledgeGraph = new JoinKnowledgeGraph();

// ============================================================================
// СТРАТЕГИИ ИЗВЛЕЧЕНИЯ И ВЫВОДА JOIN (Extensible Strategies)
// ============================================================================

/**
 * Стратегия 1: Парсинг реальных SQL-скриптов из catalogData.
 * Извлекает блоки FROM ... JOIN ... ON ... и сохраняет условия.
 */
export class SqlScriptMiningStrategy {
  name = "SqlScriptMiningStrategy";

  indexCatalog(catalogData, graph) {
    if (!catalogData) return;

    for (const dbName of Object.keys(catalogData)) {
      if (dbName === "source_system_map") continue;
      const schemas = catalogData[dbName];
      if (!schemas || typeof schemas !== "object") continue;

      for (const schemaName of Object.keys(schemas)) {
        const tables = schemas[schemaName];
        if (!tables || typeof tables !== "object") continue;

        for (const tableName of Object.keys(tables)) {
          if (isTemporaryTable(tableName)) continue;
          const tInfo = tables[tableName];
          if (!tInfo || !tInfo.sql_script) continue;

          const currentKey = `${dbName}.${schemaName}.${tableName}`;
          this._extractJoinsFromScript(tInfo.sql_script, currentKey, graph);
        }
      }
    }
  }

  _extractJoinsFromScript(script, currentMartKey, graph) {
    if (!script) return;
    if (isTemporaryTable(currentMartKey)) return;

    // Регулярное выражение для извлечения FROM таблицы
    const fromRegex = /\bfrom\s+([a-zA-Z0-9_\.]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_]+))?/i;
    const fromMatch = fromRegex.exec(script);
    const baseTableRaw = fromMatch ? fromMatch[1] : null;
    const baseAlias = fromMatch && fromMatch[2] ? fromMatch[2] : null;

    if (isTemporaryTable(baseTableRaw)) return;

    // Карта алиасов в этом запросе
    const aliasMap = new Map();
    if (baseTableRaw) {
      const baseClean = normalizeTableName(baseTableRaw);
      if (baseAlias) aliasMap.set(baseAlias.toLowerCase(), baseTableRaw);
      aliasMap.set(baseClean, baseTableRaw);
    }

    // Регулярное выражение для извлечения JOIN секций
    const joinRegex = /(?:(inner|left|right|full|cross)\s+)?join\s+([a-zA-Z0-9_\.]+)(?:\s+(?:as\s+)?([a-zA-Z0-9_]+))?\s+on\s+([\s\S]*?)(?=(?:(?:inner|left|right|full|cross)?\s+join|\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\blimit\b|\bhaving\b|\bwindow\b|\)|\;|$))/gi;

    let match;
    const joins = [];

    while ((match = joinRegex.exec(script)) !== null) {
      const joinType = (match[1] || "left").toUpperCase();
      const joinedTable = match[2];
      const joinedAlias = match[3] || null;
      let rawCondition = match[4].trim();

      // Очистка условия от завершающих символов
      rawCondition = rawCondition.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");

      if (joinedAlias) {
        aliasMap.set(joinedAlias.toLowerCase(), joinedTable);
      }
      aliasMap.set(normalizeTableName(joinedTable), joinedTable);

      joins.push({
        joinType,
        joinedTable,
        joinedAlias,
        condition: rawCondition
      });
    }

    // Сохраняем связи между базовой таблицей и джойнами, а также между джойнами
    const allTablesInQuery = [];
    if (baseTableRaw) allTablesInQuery.push({ table: baseTableRaw, alias: baseAlias });

    const sourceAliasMap = Object.fromEntries(aliasMap);

    for (const j of joins) {
      if (isTemporaryTable(j.joinedTable)) continue;
      allTablesInQuery.push({ table: j.joinedTable, alias: j.joinedAlias });

      // Пытаемся понять, с какими таблицами из запроса соединяется j
      for (const prior of allTablesInQuery) {
        if (prior.table === j.joinedTable) continue;
        if (isTemporaryTable(prior.table)) continue;

        const priorAlias = prior.alias ? prior.alias.toLowerCase() : null;
        const priorName = normalizeTableName(prior.table);

        const mentionsPrior = (priorAlias && new RegExp(`\\b${priorAlias}\\.`, "i").test(j.condition)) ||
                              new RegExp(`\\b${priorName}\\.`, "i").test(j.condition);

        if (mentionsPrior || allTablesInQuery.length === 2) {
          graph.addEdge(prior.table, j.joinedTable, {
            condition: j.condition,
            joinType: j.joinType,
            sourceMart: currentMartKey,
            confidence: 1.0,
            strategy: this.name,
            originalLeftTable: prior.table,
            originalRightTable: j.joinedTable,
            originalLeftAlias: prior.alias,
            originalRightAlias: j.joinedAlias,
            sourceAliasMap: sourceAliasMap
          });
        }
      }
    }
  }
}

/**
 * Стратегия 2: Эвристическое сопоставление по совпадающим колонкам-ключам (_id, _inn, _cd).
 */
export class CommonKeyMatchStrategy {
  name = "CommonKeyMatchStrategy";

  findJoin(tableA, tableB, catalogData) {
    const colsA = this._getTableColumns(tableA, catalogData);
    const colsB = this._getTableColumns(tableB, catalogData);
    if (!colsA || !colsB) return null;

    const setB = new Map(colsB.map(c => [c.name.toLowerCase(), c]));
    const matchedKeys = [];

    // Приоритетные суффиксы идентификаторов
    const prioritySuffixes = ["_id", "_code", "_cd", "_no", "_number", "_inn", "_guid"];

    for (const colA of colsA) {
      const nameLower = colA.name.toLowerCase();
      if (setB.has(nameLower)) {
        const isId = prioritySuffixes.some(s => nameLower.endsWith(s)) || nameLower === "id";
        if (isId) {
          matchedKeys.push({ colName: colA.name, isId: true });
        }
      }
    }

    if (matchedKeys.length > 0) {
      const bestKey = matchedKeys[0].colName;
      return {
        condition: `{{aliasLeft}}.${bestKey} = {{aliasRight}}.${bestKey}`,
        confidence: 0.7,
        strategy: this.name,
        note: `Предположение по совпадающему ключу ${bestKey}`,
        originalLeftAlias: null,
        originalRightAlias: null
      };
    }

    return null;
  }

  _getTableColumns(tableItem, catalogData) {
    if (!catalogData) return null;
    let db, schema, table;
    if (typeof tableItem === "object") {
      ({ db, schema, table } = tableItem);
    } else if (typeof tableItem === "string") {
      const parts = tableItem.split(".");
      if (parts.length === 3) [db, schema, table] = parts;
      else if (parts.length === 1) table = parts[0];
    }

    if (db && schema && table) {
      return catalogData[db]?.[schema]?.[table]?.columns || null;
    }

    if (table) {
      for (const d of Object.keys(catalogData)) {
        for (const s of Object.keys(catalogData[d] || {})) {
          if (catalogData[d][s][table]) {
            return catalogData[d][s][table].columns || null;
          }
        }
      }
    }
    return null;
  }
}

/**
 * Стратегия 3: Вывод связей на основе Column-Level Lineage (зарезервировано).
 */
export class ColumnLineageStrategy {
  name = "ColumnLineageStrategy";

  findJoin(tableA, tableB, catalogData) {
    return null;
  }
}

// Реестр стратегий (легко расширяется новыми)
export const inferenceStrategies = [
  new SqlScriptMiningStrategy(),
  new CommonKeyMatchStrategy(),
  new ColumnLineageStrategy()
];

// ============================================================================
// ОСНОВНОЙ ПАЙПЛАЙН ГЕНЕРАЦИИ ШАБЛОНА
// ============================================================================

/**
 * Инициализирует граф знаний связей из каталога (ленивая загрузка 1 раз).
 * @param {object} catalogData 
 */
export function initJoinKnowledgeGraph(catalogData) {
  if (knowledgeGraph.isIndexed) return;
  const scriptStrategy = inferenceStrategies.find(s => s instanceof SqlScriptMiningStrategy);
  if (scriptStrategy) {
    scriptStrategy.indexCatalog(catalogData, knowledgeGraph);
  }
  knowledgeGraph.isIndexed = true;
}

/**
 * Преобразует строковое имя таблицы в объект с метаданными { db, schema, table, fullKey, fullId }.
 * Поддерживает форматы:
 * - db.schema.table
 * - schema.table (с авто-маппингом схем ext_dds -> dds.core и т.д.)
 * - table (поиск по catalogData)
 */
export function resolveTableInfo(rawName, catalogData) {
  if (!rawName) return null;
  const clean = rawName.replace(/["`\[\]]/g, "").trim().toLowerCase();
  const parts = clean.split(".");

  if (parts.length === 3) {
    let [db, schema, table] = parts;
    if (db === "dm" && schema === "ext_dds") {
      db = "dds";
      schema = "core";
    } else if (db === "dm" && schema === "ext_calc") {
      db = "dds";
      schema = "calc";
    } else if (db === "dm" && schema === "ext_ods") {
      db = "ods";
      schema = "core";
    } else if (db === "dds" && schema === "ext_ods") {
      db = "ods";
      schema = "core";
    }

    return {
      db,
      schema,
      table,
      fullKey: `${db}.${schema}.${table}`,
      fullId: `${db}-${schema}-${table}`
    };
  }

  if (parts.length === 2) {
    let [schema, table] = parts;
    let db = null;

    if (schema === "ext_dds") {
      db = "dds";
      schema = "core";
    } else if (schema === "ext_calc") {
      db = "dds";
      schema = "calc";
    } else if (schema === "ext_ods") {
      db = "ods";
      schema = "core";
    }

    if (!db && catalogData) {
      for (const d of Object.keys(catalogData)) {
        if (d === "source_system_map") continue;
        if (catalogData[d]?.[schema]?.[table]) {
          db = d;
          break;
        }
      }
    }

    if (!db) {
      db = (schema === "calc" || schema === "core") ? "dds" : "dm";
    }

    return {
      db,
      schema,
      table,
      fullKey: `${db}.${schema}.${table}`,
      fullId: `${db}-${schema}-${table}`
    };
  }

  if (parts.length === 1) {
    const table = parts[0];
    if (catalogData) {
      for (const d of Object.keys(catalogData)) {
        if (d === "source_system_map") continue;
        for (const s of Object.keys(catalogData[d] || {})) {
          if (catalogData[d][s]?.[table]) {
            return {
              db: d,
              schema: s,
              table,
              fullKey: `${d}.${s}.${table}`,
              fullId: `${d}-${s}-${table}`
            };
          }
        }
      }
    }
    return {
      db: "dds",
      schema: "core",
      table,
      fullKey: `dds.core.${table}`,
      fullId: `dds-core-${table}`
    };
  }

  return null;
}

/**
 * Нормализует шаблон условия соединения для подсчета частотности одинаковых ключей соединения.
 */
export function normalizeConditionPattern(cond, leftAlias, rightAlias, leftTable, rightTable) {
  if (!cond) return "";
  let c = cond.toLowerCase().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const lNames = [leftAlias, leftTable ? normalizeTableName(leftTable) : null].filter(Boolean);
  const rNames = [rightAlias, rightTable ? normalizeTableName(rightTable) : null].filter(Boolean);

  for (const n of lNames) {
    c = c.replace(new RegExp(`\\b${n}\\.`, "gi"), "$L.");
  }
  for (const n of rNames) {
    c = c.replace(new RegExp(`\\b${n}\\.`, "gi"), "$R.");
  }
  return c;
}

/**
 * Находит таблицы, используемые в условии JOIN (по алиасам), которые ещё не добавлены в шаблон.
 */
export function findMissingTables(edge, leftTable, rightTable, currentTables, catalogData) {
  if (!edge || !edge.condition) return [];
  const condition = edge.condition;
  const sourceAliasMap = edge.sourceAliasMap || {};

  const leftNames = new Set([
    normalizeTableName(edge.originalLeftTable),
    leftTable ? normalizeTableName(getTableKey(leftTable)) : null,
    leftTable ? normalizeTableName(leftTable.table) : null,
    edge.originalLeftAlias?.toLowerCase()
  ].filter(Boolean));

  const rightNames = new Set([
    normalizeTableName(edge.originalRightTable),
    rightTable ? normalizeTableName(getTableKey(rightTable)) : null,
    rightTable ? normalizeTableName(rightTable.table) : null,
    edge.originalRightAlias?.toLowerCase()
  ].filter(Boolean));

  const currentKeys = new Set(currentTables.map(t => getTableKey(t).toLowerCase()));
  const currentNames = new Set(currentTables.map(t => normalizeTableName(t.table || t.name)));

  const regex = /\b([a-zA-Z0-9_]+)\.[a-zA-Z0-9_]+/g;
  const missing = [];
  const seenAliases = new Set();
  let m;

  while ((m = regex.exec(condition)) !== null) {
    const aliasLower = m[1].toLowerCase();
    if (leftNames.has(aliasLower) || rightNames.has(aliasLower) || seenAliases.has(aliasLower)) {
      continue;
    }
    seenAliases.add(aliasLower);

    const rawTableName = sourceAliasMap[aliasLower] || aliasLower;
    // Игнорируем временные таблицы (tmp_*), чтобы не предлагать их для добавления в шаблон
    if (isTemporaryTable(rawTableName)) continue;

    const resolved = resolveTableInfo(rawTableName, catalogData);
    if (resolved && isTemporaryTable(resolved.table)) continue;

    const normName = resolved ? normalizeTableName(resolved.table) : normalizeTableName(rawTableName);
    const fullKey = resolved ? resolved.fullKey.toLowerCase() : rawTableName.toLowerCase();

    // Проверяем, добавлена ли уже таблица в текущий набор таблиц шаблона
    const isPresent = currentKeys.has(fullKey) || currentNames.has(normName);
    if (!isPresent) {
      missing.push({
        alias: aliasLower,
        rawName: rawTableName,
        table: resolved ? resolved.table : normName,
        schema: resolved ? resolved.schema : "core",
        db: resolved ? resolved.db : "dds",
        fullKey: resolved ? resolved.fullKey : `dds.core.${normName}`,
        fullId: resolved ? resolved.fullId : `dds-core-${normName}`
      });
    }
  }

  return missing;
}

/**
 * Оценивает качество связи для умного ранжирования.
 * Приоритет: чистые условия (без чужих алиасов) и часто встречающиеся в витринах DWH.
 */
export function scoreEdge(edge, leftTable, rightTable, currentTables, frequency = 1, missingTables = []) {
  let score = 0;

  // 1. Базовый вес стратегии (100 для скриптов витрин, 70 для эвристики ключей)
  const confidence = typeof edge.confidence === "number" ? edge.confidence : 1.0;
  score += Math.round(confidence * 100);

  // 2. Чистота связи (Cleanliness)
  if (missingTables.length === 0) {
    score += 50; // Чистое бинарное соединение или все зависимости уже в запросе
  } else {
    // Штраф за каждую недостающую таблицу в шаблоне
    score -= missingTables.length * 30;
  }

  // 3. Частотность: +5 за каждое использование в других витринах (макс 30)
  const freqBonus = Math.min((frequency - 1) * 5, 30);
  score += freqBonus;

  // 4. Простота: небольшой штраф за чрезмерные AND фильтры
  if (edge.condition) {
    const andCount = (edge.condition.match(/\band\b/gi) || []).length;
    score -= Math.min(andCount * 3, 15);
  }

  return score;
}

/**
 * Адаптирует псевдонимы колонок в выражении ON под новые алиасы в генерируемом шаблоне.
 * НЕ удаляет чужие алиасы (сохраняет условие полностью), но если чужая таблица уже есть в шаблоне —
 * адаптирует её алиас к актуальному алиасу в запросе.
 */
export function adaptConditionAliases(edge, newLeftAlias, newRightAlias, extraAliasMap = null) {
  if (!edge || !edge.condition) return "";
  let result = edge.condition;

  // Если это шаблон со спец-токенами
  if (result.includes("{{aliasLeft}}") || result.includes("{{aliasRight}}")) {
    return result
      .replace(/\{\{aliasLeft\}\}/g, newLeftAlias)
      .replace(/\{\{aliasRight\}\}/g, newRightAlias);
  }

  const origLeftAlias = edge.originalLeftAlias;
  const origRightAlias = edge.originalRightAlias;

  // Заменяем оригинальные алиасы через границы слов
  if (origLeftAlias && origLeftAlias.toLowerCase() !== newLeftAlias.toLowerCase()) {
    result = result.replace(new RegExp(`\\b${origLeftAlias}\\.`, "gi"), `${newLeftAlias}.`);
  }
  if (origRightAlias && origRightAlias.toLowerCase() !== newRightAlias.toLowerCase()) {
    result = result.replace(new RegExp(`\\b${origRightAlias}\\.`, "gi"), `${newRightAlias}.`);
  }

  // Также заменяем имена таблиц, если они использовались вместо алиасов
  if (edge.originalLeftTable) {
    const leftName = normalizeTableName(edge.originalLeftTable);
    result = result.replace(new RegExp(`\\b${leftName}\\.`, "gi"), `${newLeftAlias}.`);
  }
  if (edge.originalRightTable) {
    const rightName = normalizeTableName(edge.originalRightTable);
    result = result.replace(new RegExp(`\\b${rightName}\\.`, "gi"), `${newRightAlias}.`);
  }

  // Если в запросе присутствуют и другие таблицы (extraAliasMap),
  // и в условии упомянуты их оригинальные алиасы из sourceAliasMap, адаптируем и их алиасы!
  if (extraAliasMap && edge.sourceAliasMap) {
    for (const [origAlias, rawTable] of Object.entries(edge.sourceAliasMap)) {
      if (origAlias.toLowerCase() === origLeftAlias?.toLowerCase() ||
          origAlias.toLowerCase() === origRightAlias?.toLowerCase()) {
        continue;
      }
      const tableNorm = normalizeTableName(rawTable);
      for (const [currKey, currAlias] of extraAliasMap.entries()) {
        if (currKey === rawTable.toLowerCase() || normalizeTableName(currKey) === tableNorm) {
          result = result.replace(new RegExp(`\\b${origAlias}\\.`, "gi"), `${currAlias}.`);
          break;
        }
      }
    }
  }

  return result;
}

/**
 * Строит план соединения для списка выбранных таблиц с умным ранжированием и обнаружением зависимостей.
 * @param {Array<object>} tables - список выбранных таблиц
 * @param {object} options - параметры генерации
 * @returns {object} { fromTable, joinPlan, aliasMap, explanations }
 */
export function buildJoinPlan(tables, options = {}) {
  const {
    catalogData,
    baseTableKey,
    defaultJoinType = "LEFT JOIN",
    userSelectedSources = null
  } = options;

  if (!tables || tables.length === 0) {
    return { fromTable: null, joinPlan: [], aliasMap: new Map(), explanations: [] };
  }

  const rawJoinType = (defaultJoinType || "LEFT JOIN").trim().toUpperCase();
  const effectiveJoinType = (rawJoinType === "INNER JOIN" || rawJoinType === "JOIN") ? "JOIN" : "LEFT JOIN";

  initJoinKnowledgeGraph(catalogData);

  // Определяем базовую таблицу (FROM)
  let fromTable = tables[0];
  if (baseTableKey) {
    const found = tables.find(t => getTableKey(t) === baseTableKey.toLowerCase());
    if (found) fromTable = found;
  }

  const remaining = tables.filter(t => t !== fromTable);
  const connected = [fromTable];
  const joinPlan = [];
  const explanations = [];
  const aliasMap = new Map();
  const existingAliases = new Set();

  // Назначаем алиас для базовой таблицы
  const fromAlias = generateTableAlias(fromTable.table, existingAliases);
  aliasMap.set(getTableKey(fromTable), fromAlias);

  const commonKeyStrategy = inferenceStrategies.find(s => s instanceof CommonKeyMatchStrategy);

  // Итеративно присоединяем таблицы, находя лучшие связи с уже подключенными таблицами
  while (remaining.length > 0) {
    let bestCandidateIndex = -1;
    let bestCandidateScore = -Infinity;
    let bestConnection = null;
    let bestAllSources = [];

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const candidateKey = getTableKey(candidate);
      const userSelectedChoice = userSelectedSources?.[candidateKey] || null;

      // Собираем все связи кандидата с любой из уже подключенных таблиц
      const candidateEdges = [];

      for (const target of connected) {
        const directEdges = knowledgeGraph.getDirectEdges(target, candidate) || [];
        for (const edge of directEdges) {
          // Исключаем временные таблицы и витрины (tmp_*) из кандидатов умного ранжирования
          if (isTemporaryTable(edge.sourceMart) ||
              isTemporaryTable(edge.originalLeftTable) ||
              isTemporaryTable(edge.originalRightTable)) {
            continue;
          }
          candidateEdges.push({ edge, target });
        }

        if (commonKeyStrategy && !isTemporaryTable(target) && !isTemporaryTable(candidate)) {
          const keyMatch = commonKeyStrategy.findJoin(target, candidate, catalogData);
          if (keyMatch) {
            candidateEdges.push({ edge: keyMatch, target });
          }
        }
      }

      if (candidateEdges.length === 0) continue;

      // Считаем частоту паттернов условий для этой пары таблиц
      const patternFreqs = new Map();
      for (const item of candidateEdges) {
        const pat = normalizeConditionPattern(
          item.edge.condition,
          item.edge.originalLeftAlias,
          item.edge.originalRightAlias,
          item.edge.originalLeftTable || item.target.table,
          item.edge.originalRightTable || candidate.table
        );
        item.pattern = pat;
        patternFreqs.set(pat, (patternFreqs.get(pat) || 0) + 1);
      }

      // Оцениваем каждую связь
      for (let idx = 0; idx < candidateEdges.length; idx++) {
        const item = candidateEdges[idx];
        const freq = patternFreqs.get(item.pattern) || 1;
        const missing = findMissingTables(item.edge, item.target, candidate, tables, catalogData);
        let score = scoreEdge(item.edge, item.target, candidate, tables, freq, missing);

        const sourceId = item.edge.sourceMart || `heuristic_${item.edge.strategy}_${item.target.table}_${idx}`;
        item.id = sourceId;
        item.missingTables = missing;
        item.frequency = freq;

        // Если пользователь явно выбрал этот источник в UI
        if (userSelectedChoice && (userSelectedChoice === sourceId || userSelectedChoice === item.edge.sourceMart)) {
          score += 10000;
          item.isUserSelected = true;
        }

        item.score = score;
      }

      // Сортируем связи кандидата по убыванию веса (самые чистые и частые первыми)
      candidateEdges.sort((a, b) => b.score - a.score);

      const topConnection = candidateEdges[0];
      if (topConnection.score > bestCandidateScore) {
        bestCandidateScore = topConnection.score;
        bestCandidateIndex = i;
        bestConnection = topConnection;
        bestAllSources = candidateEdges;
      }
    }

    if (bestCandidateIndex !== -1 && bestConnection) {
      const [tableToJoin] = remaining.splice(bestCandidateIndex, 1);
      const targetAlias = generateTableAlias(tableToJoin.table, existingAliases);
      aliasMap.set(getTableKey(tableToJoin), targetAlias);

      const parentAlias = aliasMap.get(getTableKey(bestConnection.target));

      // Адаптируем условие JOIN под актуальные алиасы запроса
      const adaptedCondition = adaptConditionAliases(
        bestConnection.edge,
        parentAlias,
        targetAlias,
        aliasMap
      );

      // Формируем чистый список доступных источников для UI
      const seenSources = new Set();
      const availableSources = [];

      for (const item of bestAllSources) {
        if (seenSources.has(item.id)) continue;
        seenSources.add(item.id);

        let label = "";
        if (item.edge.sourceMart) {
          label = item.edge.sourceMart;
        } else if (item.edge.note) {
          label = item.edge.note;
        } else {
          label = "Автоматический подбор по ключу";
        }

        let statusTag = "";
        if (item.missingTables.length > 0) {
          statusTag = `⚠️ требует ${item.missingTables.map(m => m.table).join(", ")}`;
        } else if (item.frequency > 1) {
          statusTag = `✓ чистое, ${item.frequency} витрин`;
        } else {
          statusTag = `✓ чистое`;
        }

        availableSources.push({
          id: item.id,
          sourceMart: item.edge.sourceMart || null,
          strategy: item.edge.strategy,
          targetTableKey: getTableKey(item.target),
          targetTableName: item.target.table,
          score: item.score,
          frequency: item.frequency,
          missingTables: item.missingTables,
          label: label,
          statusTag: statusTag,
          isClean: item.missingTables.length === 0,
          isDefault: availableSources.length === 0,
          isSelected: item.id === bestConnection.id,
          rawCondition: item.edge.condition
        });
      }

      joinPlan.push({
        table: tableToJoin,
        alias: targetAlias,
        joinedWith: bestConnection.target,
        joinedWithAlias: parentAlias,
        joinType: effectiveJoinType,
        condition: adaptedCondition,
        sourceMart: bestConnection.edge.sourceMart || null,
        confidence: bestConnection.edge.confidence,
        note: bestConnection.edge.note || null,
        missingTables: bestConnection.missingTables,
        availableSources: availableSources
      });

      let expSource = bestConnection.edge.sourceMart 
        ? `из скрипта ${bestConnection.edge.sourceMart}` 
        : (bestConnection.edge.note || "автоматический подбор");
      if (bestConnection.missingTables && bestConnection.missingTables.length > 0) {
        expSource += ` (требует таблицы: ${bestConnection.missingTables.map(m => m.table).join(", ")})`;
      }

      explanations.push({
        left: bestConnection.target.table,
        right: tableToJoin.table,
        condition: adaptedCondition,
        source: expSource
      });

      connected.push(tableToJoin);
    } else {
      // Связи не найдены — выносим оставшуюся таблицу с TODO условием
      const tableToJoin = remaining.shift();
      const targetAlias = generateTableAlias(tableToJoin.table, existingAliases);
      aliasMap.set(getTableKey(tableToJoin), targetAlias);

      const defaultParent = connected[0];
      const defaultParentAlias = aliasMap.get(getTableKey(defaultParent));

      joinPlan.push({
        table: tableToJoin,
        alias: targetAlias,
        joinedWith: defaultParent,
        joinedWithAlias: defaultParentAlias,
        joinType: effectiveJoinType,
        condition: `/* TODO: укажите условие соединения с ${defaultParentAlias} (${defaultParent.table}) */`,
        sourceMart: null,
        confidence: 0,
        note: "Прямая связь в существующих витринах не найдена",
        missingTables: [],
        availableSources: []
      });

      explanations.push({
        left: defaultParent.table,
        right: tableToJoin.table,
        condition: "/* TODO */",
        source: "связь не найдена, требуется ручная проверка ключа"
      });

      connected.push(tableToJoin);
    }
  }

  return {
    fromTable,
    fromAlias,
    joinPlan,
    aliasMap,
    explanations
  };
}

/**
 * Преобразует ссылку на таблицу с учётом целевой БД запроса (foreign tables ext_*).
 * - Если БД таблицы совпадает с targetDb: targetDb.schema.table
 * - Если БД таблицы отличается: targetDb.ext_<schema>.table для работы кросс-базового запроса
 * @param {{ db: string, schema: string, table: string }} tableObj 
 * @param {string} targetDb 
 * @returns {string}
 */
export function formatTableReferenceForTarget(tableObj, targetDb) {
  if (!tableObj || !tableObj.table) return "";
  const tDb = (tableObj.db || "").toLowerCase();
  const tSchema = (tableObj.schema || "").toLowerCase();
  const tName = tableObj.table;

  if (!targetDb) {
    return `${tDb}.${tSchema}.${tName}`;
  }

  const tgtDb = targetDb.toLowerCase();

  // Если БД таблицы совпадает с целевой БД:
  if (tDb === tgtDb) {
    return `${tgtDb}.${tSchema}.${tName}`;
  }

  // Кросс-базовый запрос через foreign tables (ext_*)
  if (tDb === "ods" && tSchema === "core") {
    return `${tgtDb}.ext_ods.${tName}`;
  }
  if (tDb === "dds" && tSchema === "core") {
    return `${tgtDb}.ext_dds.${tName}`;
  }
  if (tDb === "dds" && tSchema === "calc") {
    return `${tgtDb}.ext_calc.${tName}`;
  }

  // Динамический fallback для прочих внешних схем
  return `${tgtDb}.ext_${tSchema}.${tName}`;
}

/**
 * Автоматически определяет целевую базу данных запроса в зависимости от состава таблиц.
 * - Если все таблицы из одной БД — запросу не требуются внешние таблицы (все локальные).
 * - Если таблицы из разных БД:
 *   - При наличии таблиц из слоя dm: целевая БД dm (dds и ods переходят в ext_*).
 *   - При наличии dds и ods (без dm): целевая БД dds (ods переходит в ext_ods).
 * @param {Array<object>} tables 
 * @param {string} [baseTableKey] 
 * @returns {string} e.g. "dm", "dds", "ods"
 */
export function determineTargetDb(tables, baseTableKey = null) {
  if (!tables || tables.length === 0) return "dm";

  const dbs = new Set(tables.map(t => (t.db || "").toLowerCase()).filter(Boolean));

  // Если все таблицы из одной БД — используем эту БД напрямую
  if (dbs.size === 1) {
    return Array.from(dbs)[0];
  }

  // Если таблицы из разных БД:
  // 1. Если участвует слой dm — целевая БД dm (поддерживает ext_dds, ext_calc, ext_ods)
  if (dbs.has("dm")) {
    return "dm";
  }

  // 2. Если участвуют dds и ods (без dm) — целевая БД dds (поддерживает ext_ods)
  if (dbs.has("dds") && dbs.has("ods")) {
    return "dds";
  }

  // В остальных случаях ориентируемся на базовую таблицу FROM
  if (baseTableKey) {
    const baseTable = tables.find(t => getTableKey(t) === baseTableKey.toLowerCase());
    if (baseTable && baseTable.db) return baseTable.db.toLowerCase();
  }

  return tables[0]?.db?.toLowerCase() || "dm";
}

const TECHNICAL_COLUMN_NAMES = new Set([
  "source_system_id",
  "is_active",
  "is_deleted",
  "dwh_start_date",
  "dwh_end_date",
  "etl_process_id"
]);

/**
 * Проверяет, содержит ли таблица колонки dwh_start_date и dwh_end_date.
 * @param {object} tableObj 
 * @param {object} catalogData 
 * @returns {boolean}
 */
export function hasHistoricalDates(tableObj, catalogData) {
  if (!tableObj || !catalogData) return false;
  const dbData = catalogData[tableObj.db] || catalogData[tableObj.db?.toLowerCase()] || catalogData[tableObj.db?.toUpperCase()];
  if (!dbData) return false;
  const schemaData = dbData[tableObj.schema] || dbData[tableObj.schema?.toLowerCase()] || dbData[tableObj.schema?.toUpperCase()];
  if (!schemaData) return false;
  const tblData = schemaData[tableObj.table] || schemaData[tableObj.table?.toLowerCase()] || schemaData[tableObj.table?.toUpperCase()];
  if (!tblData || !Array.isArray(tblData.columns)) return false;

  const colNames = new Set(tblData.columns.map(c => (c.name || "").toLowerCase()));
  return colNames.has("dwh_start_date") && colNames.has("dwh_end_date");
}

/**
 * Проверяет, можно ли применить режим Timeline Slicing для выбранного набора таблиц.
 * Требуется: не менее 2 таблиц и у каждой есть dwh_start_date и dwh_end_date.
 * @param {Array<object>} selectedTables 
 * @param {object} catalogData 
 * @returns {boolean}
 */
export function canApplyTimelineSlicing(selectedTables, catalogData) {
  if (!selectedTables || selectedTables.length < 2 || !catalogData) {
    return false;
  }
  return selectedTables.every(t => hasHistoricalDates(t, catalogData));
}

function getTableColumns(tableObj, catalogData) {
  if (!tableObj || !catalogData) return [];
  const dbData = catalogData[tableObj.db] || catalogData[tableObj.db?.toLowerCase()] || catalogData[tableObj.db?.toUpperCase()];
  if (!dbData) return [];
  const schemaData = dbData[tableObj.schema] || dbData[tableObj.schema?.toLowerCase()] || dbData[tableObj.schema?.toUpperCase()];
  if (!schemaData) return [];
  const tblData = schemaData[tableObj.table] || schemaData[tableObj.table?.toLowerCase()] || schemaData[tableObj.table?.toUpperCase()];
  if (!tblData || !Array.isArray(tblData.columns)) return [];
  return tblData.columns.map(c => c.name);
}

/**
 * Генерирует SQL-шаблон с нарезкой временных интервалов (Timeline Slicing) для SCD Type 2 таблиц.
 */
function generateTimelineSlicingTemplate(tables, plan, effectiveTargetDb, catalogData) {
  const { fromTable, fromAlias, joinPlan, explanations } = plan;

  // Извлекаем парные равенства из условий JOIN
  const eqRegex = /\b([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*=\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\b/g;
  const equalities = [];
  for (const j of joinPlan) {
    let m;
    const cond = j.condition || "";
    while ((m = eqRegex.exec(cond)) !== null) {
      equalities.push({
        leftAlias: m[1].toLowerCase(),
        leftCol: m[2].toLowerCase(),
        rightAlias: m[3].toLowerCase(),
        rightCol: m[4].toLowerCase()
      });
    }
  }

  // Находим ключевые колонки соединения базовой таблицы (fromTable)
  const fromKeyCols = [];
  for (const eq of equalities) {
    if (eq.leftAlias === fromAlias.toLowerCase() && !fromKeyCols.includes(eq.leftCol)) {
      fromKeyCols.push(eq.leftCol);
    }
    if (eq.rightAlias === fromAlias.toLowerCase() && !fromKeyCols.includes(eq.rightCol)) {
      fromKeyCols.push(eq.rightCol);
    }
  }

  // Fallback: если ключ не распознан из условий равенства, берем первый id / *_id столбец
  if (fromKeyCols.length === 0) {
    const fromCols = getTableColumns(fromTable, catalogData);
    const idCol = fromCols.find(c => c.toLowerCase().endsWith("_id") && !TECHNICAL_COLUMN_NAMES.has(c.toLowerCase())) || fromCols[0] || "id";
    fromKeyCols.push(idCol);
  }

  // Хелпер сопоставления колонок ключа для присоединенной таблицы
  const getMatchingKeySelect = (targetAlias, targetTable) => {
    return fromKeyCols.map(kCol => {
      // 1. Ищем прямое равенство в условиях JOIN
      for (const eq of equalities) {
        if (eq.leftAlias === targetAlias.toLowerCase() && eq.rightAlias === fromAlias.toLowerCase() && eq.rightCol === kCol) {
          return eq.leftCol === kCol ? eq.leftCol : `${eq.leftCol} AS ${kCol}`;
        }
        if (eq.rightAlias === targetAlias.toLowerCase() && eq.leftAlias === fromAlias.toLowerCase() && eq.leftCol === kCol) {
          return eq.rightCol === kCol ? eq.rightCol : `${eq.rightCol} AS ${kCol}`;
        }
      }
      // 2. Проверяем наличие колонки с таким же именем в целевой таблице
      const targetCols = getTableColumns(targetTable, catalogData).map(c => c.toLowerCase());
      if (targetCols.includes(kCol.toLowerCase())) {
        return kCol;
      }
      return kCol;
    }).join(", ");
  };

  const lines = [];

  // 1. CTE timeline_events: собираем все точки изменения дат (dwh_start_date и dwh_end_date)
  lines.push("WITH timeline_events AS (");
  const eventQueries = [];

  const fromFull = formatTableReferenceForTarget(fromTable, effectiveTargetDb);
  const fromKeySelect = fromKeyCols.join(", ");
  eventQueries.push(`    SELECT ${fromKeySelect}, dwh_start_date AS change_dt FROM ${fromFull}`);
  eventQueries.push(`    UNION`);
  eventQueries.push(`    SELECT ${fromKeySelect}, dwh_end_date   AS change_dt FROM ${fromFull}`);

  for (const j of joinPlan) {
    const jFull = formatTableReferenceForTarget(j.table, effectiveTargetDb);
    const jKeySelect = getMatchingKeySelect(j.alias, j.table);
    eventQueries.push(`    UNION`);
    eventQueries.push(`    SELECT ${jKeySelect}, dwh_start_date AS change_dt FROM ${jFull}`);
    eventQueries.push(`    UNION`);
    eventQueries.push(`    SELECT ${jKeySelect}, dwh_end_date   AS change_dt FROM ${jFull}`);
  }

  lines.push(eventQueries.join("\n"));
  lines.push("),");
  lines.push("");

  // 2. CTE timeline_intervals: нарезка элементарных интервалов через LEAD
  const partitionCols = fromKeyCols.join(", ");
  lines.push("timeline_intervals AS (");
  lines.push("    SELECT");
  lines.push(`        ${partitionCols},`);
  lines.push("        change_dt AS valid_from,");
  lines.push(`        LEAD(change_dt) OVER (PARTITION BY ${partitionCols} ORDER BY change_dt) AS valid_to`);
  lines.push("    FROM (");
  lines.push(`        SELECT DISTINCT ${partitionCols}, change_dt`);
  lines.push("        FROM timeline_events");
  lines.push("    ) t");
  lines.push("),");
  lines.push("");

  // 3. CTE clean_intervals: фильтрация завершенных интервалов
  lines.push("clean_intervals AS (");
  lines.push(`    SELECT ${partitionCols}, valid_from, valid_to`);
  lines.push("    FROM timeline_intervals");
  lines.push("    WHERE valid_to IS NOT NULL");
  lines.push("      AND valid_from < valid_to");
  lines.push(")");
  lines.push("");

  // 4. Финальный SELECT
  lines.push("SELECT");
  const selectParts = [];

  // Бизнес-поля базовой таблицы (без технических SCD полей)
  const fromCols = getTableColumns(fromTable, catalogData).filter(c => !TECHNICAL_COLUMN_NAMES.has(c.toLowerCase()));
  if (fromCols.length > 0) {
    fromCols.forEach(c => selectParts.push(`    ${fromAlias}.${c},`));
  } else {
    selectParts.push(`    ${fromAlias}.*,`);
  }

  // Бизнес-поля присоединенных таблиц
  for (const j of joinPlan) {
    const jCols = getTableColumns(j.table, catalogData).filter(c => !TECHNICAL_COLUMN_NAMES.has(c.toLowerCase()));
    if (jCols.length > 0) {
      jCols.forEach(c => selectParts.push(`    ${j.alias}.${c},`));
    } else {
      selectParts.push(`    ${j.alias}.*,`);
    }
  }

  // Технические поля результирующего измерения
  selectParts.push("");
  selectParts.push("    -- Технические поля результирующего измерения (SCD Type 2):");
  selectParts.push(`    ${fromAlias}.source_system_id,`);
  selectParts.push("    CASE");
  selectParts.push("        WHEN i.valid_to >= '9999-12-31'::timestamp THEN true");
  selectParts.push("        ELSE false");
  selectParts.push("    END AS is_active,");

  const allAliases = [fromAlias, ...joinPlan.map(j => j.alias)];
  const isDeletedExpr = allAliases.map(a => `COALESCE(${a}.is_deleted, false)`).join(" OR ");
  selectParts.push(`    (${isDeletedExpr}) AS is_deleted,`);
  selectParts.push("    i.valid_from AS dwh_start_date,");
  selectParts.push("    i.valid_to   AS dwh_end_date,");
  selectParts.push("    uuid_generate_v5(uuid_nil(), 1::text) AS etl_process_id");

  lines.push(selectParts.join("\n"));
  lines.push("");

  // 5. Блок FROM clean_intervals и джойны по интервалам
  lines.push("FROM clean_intervals i");

  // Соединение базовой таблицы с интервалами
  const fromIntervalOn = fromKeyCols.map(k => `${fromAlias}.${k} = i.${k}`).join(" AND ");
  lines.push(`LEFT JOIN ${fromFull} ${fromAlias}`);
  lines.push(`    ON ${fromIntervalOn}`);
  lines.push(`   AND i.valid_from >= ${fromAlias}.dwh_start_date`);
  lines.push(`   AND i.valid_from <  ${fromAlias}.dwh_end_date`);

  // Соединение каждой последующей таблицы
  for (const j of joinPlan) {
    const jFull = formatTableReferenceForTarget(j.table, effectiveTargetDb);
    const jt = j.joinType === "INNER JOIN" ? "JOIN" : j.joinType;
    lines.push(`${jt} ${jFull} ${j.alias}`);
    lines.push(`    ON ${j.condition}`);
    lines.push(`   AND i.valid_from >= ${j.alias}.dwh_start_date`);
    lines.push(`   AND i.valid_from <  ${j.alias}.dwh_end_date`);
  }

  lines.push(";");

  // 6. Пояснения
  lines.push("");
  lines.push("/* ----------------------------------------------------------------------------");
  lines.push("Режим: Timeline Slicing (хронологическое совмещение версий SCD Type 2)");
  lines.push("Использованные источники связей:");
  for (const exp of explanations) {
    lines.push(` * [${exp.left}] <-> [${exp.right}]: ${exp.source}`);
  }
  lines.push("---------------------------------------------------------------------------- */");

  return lines.join("\n");
}

/**
 * Генерирует готовый текстовый SQL-скрипт (SELECT-запрос) шаблона витрины.
 * @param {Array<object>} tables 
 * @param {object} options 
 * @returns {string}
 */
export function generateSqlTemplate(tables, options = {}) {
  const {
    targetDb = null,
    targetSchema = null,
    catalogData = null,
    baseTableKey = null,
    defaultJoinType = "LEFT JOIN",
    userSelectedSources = null,
    enableTimelineSlicing = false
  } = options;

  if (!tables || tables.length === 0) {
    return "-- Перетащите таблицы из боковой панели для генерации шаблона запроса";
  }

  // Определяем целевую БД запроса для кросс-базовой маршрутизации
  let effectiveTargetDb = targetDb;
  if (!effectiveTargetDb && targetSchema && targetSchema !== "dm.calc") {
    const parts = targetSchema.split(".");
    effectiveTargetDb = parts[0];
  }
  if (!effectiveTargetDb) {
    effectiveTargetDb = determineTargetDb(tables, baseTableKey);
  }

  const plan = buildJoinPlan(tables, {
    catalogData,
    baseTableKey,
    defaultJoinType,
    userSelectedSources
  });

  // Если включен режим Timeline Slicing и условия применимости соблюдены — генерируем хронологический шаблон
  if (enableTimelineSlicing && canApplyTimelineSlicing(tables, catalogData)) {
    return generateTimelineSlicingTemplate(tables, plan, effectiveTargetDb, catalogData);
  }
  const { fromTable, fromAlias, joinPlan, explanations } = plan;

  const lines = [];

  // 1. Блок SELECT
  lines.push("SELECT");
  const allSelectTables = [
    { table: fromTable, alias: fromAlias },
    ...joinPlan.map(j => ({ table: j.table, alias: j.alias }))
  ];

  const selectLines = allSelectTables.map((item, idx) => {
    const isLast = idx === allSelectTables.length - 1;
    const comma = isLast ? "" : ",";
    return `    ${item.alias}.*${comma}`;
  });

  lines.push(selectLines.join("\n"));

  // 2. Блок FROM с поддержкой внешних таблиц (ext_*)
  const fromFullName = formatTableReferenceForTarget(fromTable, effectiveTargetDb);
  lines.push(`FROM ${fromFullName} ${fromAlias}`);

  // 3. Блоки JOIN с поддержкой внешних таблиц (ext_*)
  for (const j of joinPlan) {
    const fullTarget = formatTableReferenceForTarget(j.table, effectiveTargetDb);
    const comment = j.sourceMart 
      ? `/* Связь из ${j.sourceMart} */`
      : (j.note ? `/* ${j.note} */` : "");

    const jt = j.joinType === "INNER JOIN" ? "JOIN" : j.joinType;
    lines.push(`${jt} ${fullTarget} ${j.alias}`);
    lines.push(`    ON ${j.condition} ${comment}`.trimEnd());
  }

  lines.push(";");

  // 4. Пояснения в подвале скрипта
  lines.push("");
  lines.push("/* ----------------------------------------------------------------------------");
  lines.push("Использованные источники связей:");
  for (const exp of explanations) {
    lines.push(` * [${exp.left}] <-> [${exp.right}]: ${exp.source}`);
  }
  lines.push("---------------------------------------------------------------------------- */");

  return lines.join("\n");
}
