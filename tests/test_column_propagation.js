/* 
Тест логики фичи "Протянуть колонку" (Column Propagation)
*/

import "./setup.js";
import { 
  checkPropagationConditions, 
  isMatchingFromTable,
  generateModifiedSql
} from "../src/lineage/columnLineagePropagation.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
}

function runTests() {
  console.log("======================================================");
  console.log("ТЕСТИРОВАНИЕ: Column Propagation (Протянуть колонку)");
  console.log("======================================================");

  // 1. Тестирование isMatchingFromTable
  console.log("\n1. Проверка сопоставления таблицы во FROM (isMatchingFromTable):");
  
  assert(
    isMatchingFromTable("core.account_detail", "dds.core.account_detail"),
    "Прямое совпадение core.account_detail"
  );
  console.log("  ✓ Прямое совпадение схемы и таблицы: core.account_detail == dds.core.account_detail");

  assert(
    isMatchingFromTable('"core"."account_detail"', "dds.core.account_detail"),
    "Кавычки в имени таблицы и схемы"
  );
  console.log("  ✓ Таблицы и схемы в кавычках экранируются корректно");

  assert(
    isMatchingFromTable("ext_ods.client", "ods.core.client"),
    "Foreign table ext_ods.client для ods.core.client"
  );
  console.log("  ✓ Foreign-таблица ext_ods.client сопоставляется с ods.core.client");

  assert(
    isMatchingFromTable("ext_calc.summary", "dds.calc.summary"),
    "Foreign table ext_calc.summary для dds.calc.summary"
  );
  console.log("  ✓ Foreign-таблица ext_calc.summary сопоставляется с dds.calc.summary");

  assert(
    isMatchingFromTable("account_detail", "dds.core.account_detail"),
    "Неквалифицированное имя account_detail"
  );
  console.log("  ✓ Неквалифицированное имя account_detail сопоставляется");

  assert(
    !isMatchingFromTable("client_detail", "dds.core.account_detail"),
    "Несовпадающие имена таблиц должны возвращать false"
  );
  console.log("  ✓ Несовпадающее имя таблицы отвергается");

  assert(
    !isMatchingFromTable("other_schema.account_detail", "dds.core.account_detail"),
    "Несовпадающие схемы должны возвращать false"
  );
  console.log("  ✓ Несовпадающая схема отвергается");

  // 2. Тестирование checkPropagationConditions
  console.log("\n2. Проверка условий проброса (checkPropagationConditions):");

  const singleParentTable = {
    lineage: { upstream: ["ods.core.source_acc"] },
    sql_script: `
      SELECT
          account_id,
          account_num
      FROM ext_ods.source_acc
    `
  };

  const getSingleParent = () => singleParentTable;
  const res1 = checkPropagationConditions("dds.core.target", getSingleParent);
  assert(res1.canPropagate, `Один родитель должен быть разрешен: ${res1.reason}`);
  console.log("  ✓ Таблица с ровно 1 родителем разрешена");

  const singleParentWithGroupBy = {
    lineage: { upstream: ["ods.core.source_acc"] },
    sql_script: `
      SELECT account_id, count(*)
      FROM ext_ods.source_acc
      GROUP BY account_id
    `
  };
  const resGroupBy = checkPropagationConditions("dds.core.target", () => singleParentWithGroupBy);
  assert(!resGroupBy.canPropagate && resGroupBy.reason.includes("GROUP BY"), "GROUP BY должен блокировать проброс");
  console.log("  ✓ Наличие GROUP BY блокирует проброс");

  // Multi-parent: родитель во FROM, только LEFT JOIN
  const multiParentLeftJoin = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail"] },
    sql_script: `
      SELECT
          a.account_id,
          c.client_name
      FROM core.account_detail a
      LEFT JOIN core.client_detail c ON a.client_id = c.client_id
    `
  };
  const getMultiLeft = () => multiParentLeftJoin;
  const resMultiLeft = checkPropagationConditions("dm.core.mart", getMultiLeft, "dds.core.account_detail");
  assert(resMultiLeft.canPropagate, `Родитель во FROM со всеми LEFT JOIN должен быть разрешен: ${resMultiLeft.reason}`);
  console.log("  ✓ Несколько родителей: родитель во FROM и LEFT JOIN разрешен");

  // Multi-parent: родитель во FROM, INNER JOIN + LEFT JOIN
  const multiParentInnerJoin = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail", "dds.core.card_detail"] },
    sql_script: `
      SELECT
          a.account_id,
          c.client_name,
          cd.card_number
      FROM core.account_detail a
      INNER JOIN core.client_detail c ON a.client_id = c.client_id
      LEFT JOIN core.card_detail cd ON a.account_id = cd.account_id
    `
  };
  const resMultiInner = checkPropagationConditions("dm.core.mart", () => multiParentInnerJoin, "dds.core.account_detail");
  assert(resMultiInner.canPropagate, `INNER JOIN и LEFT JOIN разрешены: ${resMultiInner.reason}`);
  console.log("  ✓ Несколько родителей: комбинация INNER JOIN и LEFT JOIN разрешена");

  // Multi-parent: родитель НЕ во FROM (он в JOIN)
  const resNotFrom = checkPropagationConditions("dm.core.mart", () => multiParentLeftJoin, "dds.core.client_detail");
  assert(!resNotFrom.canPropagate && resNotFrom.reason.includes("не является ведущей"), "Родитель в JOIN должен блокироваться");
  console.log("  ✓ Несколько родителей: родитель в JOIN (не в FROM) корректно блокируется");

  // Multi-parent: наличие RIGHT JOIN
  const multiParentRightJoin = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail"] },
    sql_script: `
      SELECT a.account_id, c.client_name
      FROM core.account_detail a
      RIGHT JOIN core.client_detail c ON a.client_id = c.client_id
    `
  };
  const resRight = checkPropagationConditions("dm.core.mart", () => multiParentRightJoin, "dds.core.account_detail");
  assert(!resRight.canPropagate && resRight.reason.includes("RIGHT/FULL/CROSS JOIN"), "RIGHT JOIN должен блокироваться");
  console.log("  ✓ Наличие RIGHT JOIN блокирует проброс");

  // Multi-parent: наличие FULL JOIN
  const multiParentFullJoin = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail"] },
    sql_script: `
      SELECT a.account_id, c.client_name
      FROM core.account_detail a
      FULL OUTER JOIN core.client_detail c ON a.client_id = c.client_id
    `
  };
  const resFull = checkPropagationConditions("dm.core.mart", () => multiParentFullJoin, "dds.core.account_detail");
  assert(!resFull.canPropagate && resFull.reason.includes("RIGHT/FULL/CROSS JOIN"), "FULL JOIN должен блокироваться");
  console.log("  ✓ Наличие FULL JOIN блокирует проброс");

  // Multi-parent: наличие CTE
  const multiParentWithCTE = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail"] },
    sql_script: `
      WITH cte AS (
          SELECT account_id FROM core.account_detail
      )
      SELECT cte.account_id, c.client_name
      FROM cte
      LEFT JOIN core.client_detail c ON cte.account_id = c.client_id
    `
  };
  const resCTE = checkPropagationConditions("dm.core.mart", () => multiParentWithCTE, "dds.core.account_detail");
  assert(!resCTE.canPropagate && resCTE.reason.includes("CTE (WITH)"), "CTE должен блокироваться");
  console.log("  ✓ Наличие CTE (WITH) блокирует проброс");

  // Multi-parent: наличие подзапроса в FROM
  const multiParentSubqueryFrom = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail"] },
    sql_script: `
      SELECT a.account_id, c.client_name
      FROM (SELECT * FROM core.account_detail) a
      LEFT JOIN core.client_detail c ON a.client_id = c.client_id
    `
  };
  const resSubqueryFrom = checkPropagationConditions("dm.core.mart", () => multiParentSubqueryFrom, "dds.core.account_detail");
  assert(!resSubqueryFrom.canPropagate && resSubqueryFrom.reason.includes("подзапрос"), "Подзапрос в FROM должен блокироваться");
  console.log("  ✓ Подзапрос в FROM блокирует проброс");

  // Multi-parent: наличие подзапроса в JOIN
  const multiParentSubqueryJoin = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail"] },
    sql_script: `
      SELECT a.account_id, c.client_name
      FROM core.account_detail a
      LEFT JOIN (SELECT * FROM core.client_detail) c ON a.client_id = c.client_id
    `
  };
  const resSubqueryJoin = checkPropagationConditions("dm.core.mart", () => multiParentSubqueryJoin, "dds.core.account_detail");
  assert(!resSubqueryJoin.canPropagate && resSubqueryJoin.reason.includes("подзапрос"), "Подзапрос в JOIN должен блокироваться");
  console.log("  ✓ Подзапрос в JOIN блокирует проброс");

  // Multi-parent: comma-join в FROM
  const multiParentCommaJoin = {
    lineage: { upstream: ["dds.core.account_detail", "dds.core.client_detail"] },
    sql_script: `
      SELECT a.account_id, c.client_name
      FROM core.account_detail a, core.client_detail c
      WHERE a.client_id = c.client_id
    `
  };
  const resComma = checkPropagationConditions("dm.core.mart", () => multiParentCommaJoin, "dds.core.account_detail");
  assert(!resComma.canPropagate && resComma.reason.includes("запятую"), "Таблицы через запятую в FROM должны блокироваться");
  console.log("  ✓ Перечисление таблиц через запятую в FROM блокирует проброс");

  // 3. Тестирование подстановки алиасов в generateModifiedSql
  console.log("\n3. Проверка генерации SQL с алиасами (generateModifiedSql):");

  const uniqueId = "test-tab-1";
  const childTableId = "dm.core.mart";

  // Регистрируем протянутую колонку
  window.__propagationState.propagatedColumns.set(uniqueId, new Set([`${childTableId}.opened_date`]));
  window.__propagationState.columnAliases.clear();
  window.__propagationState.columnExpressions.clear();

  const getTableInfoForSql = (id) => {
    if (id === childTableId) {
      return {
        sql_script: `
SELECT
    a.account_id,
    c.client_name
FROM core.account_detail a
LEFT JOIN core.client_detail c ON a.client_id = c.client_id
        `.trim()
      };
    }
    return null;
  };

  const sqlResultWithAlias = generateModifiedSql(childTableId, getTableInfoForSql, uniqueId);
  assert(
    sqlResultWithAlias.sql.includes("a.opened_date"), 
    `Колонка должна быть с префиксом алиаса 'a.opened_date'. Получено:\n${sqlResultWithAlias.sql}`
  );
  console.log("  ✓ Колонка успешно подставляется с алиасом таблицы из FROM ('a.opened_date')");

  // Проверяем с пользовательским алиасом
  window.__propagationState.columnAliases.set(`${childTableId}.opened_date`, "account_open_dt");
  const sqlResultCustomAlias = generateModifiedSql(childTableId, getTableInfoForSql, uniqueId);
  assert(
    sqlResultCustomAlias.sql.includes("a.opened_date AS account_open_dt"),
    `Ожидалось 'a.opened_date AS account_open_dt'. Получено:\n${sqlResultCustomAlias.sql}`
  );
  assert(
    Array.isArray(sqlResultCustomAlias.addedExpressions) && 
    sqlResultCustomAlias.addedExpressions.includes("a.opened_date AS account_open_dt"),
    "addedExpressions должно содержать точное выражение 'a.opened_date AS account_open_dt'"
  );
  assert(
    Array.isArray(sqlResultCustomAlias.addedLines) && 
    sqlResultCustomAlias.addedLines.some(l => l.includes("a.opened_date AS account_open_dt")),
    "addedLines должно содержать вставленную строку"
  );
  console.log("  ✓ Колонка с алиасом таблицы и кастомным AS alias: 'a.opened_date AS account_open_dt'");

  // Проверяем точный кейс пользователя (b.balance_amt AS sfwef)
  console.log("\n4. Проверка подсветки в Diff (кейс пользователя: b.balance_amt AS sfwef):");
  const testTableId = "dm.core.account_balance_dynamics";
  const testUniqueId = "test-tab-user-diff";
  window.__propagationState.propagatedColumns.set(testUniqueId, new Set([`${testTableId}.balance_amt`]));
  window.__propagationState.columnAliases.set(`${testTableId}.balance_amt`, "sfwef");

  const getTableInfoUserCase = () => ({
    sql_script: `
CREATE TABLE dm.core.account_balance_dynamics AS
SELECT
    b.account_id,
    a.account_number,
    b.currency_cd
FROM dds.core.account_balance_detail b
LEFT JOIN dds.core.account_detail a ON b.account_id = a.account_id
    `.trim()
  });

  const resUserCase = generateModifiedSql(testTableId, getTableInfoUserCase, testUniqueId);
  assert(
    resUserCase.sql.includes("b.balance_amt AS sfwef"),
    `SQL должен содержать 'b.balance_amt AS sfwef'. Получено:\n${resUserCase.sql}`
  );

  const normalizeForDiff = (s) => (s || '')
    .trim()
    .replace(/^,\s*/, '')
    .replace(/,$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  const addedExprSet = new Set();
  (resUserCase.addedExpressions || []).forEach(e => addedExprSet.add(normalizeForDiff(e)));
  (resUserCase.addedLines || []).forEach(l => addedExprSet.add(normalizeForDiff(l)));

  // Проверяем, что строка '    b.balance_amt AS sfwef,' из сгенерированного SQL распознается как добавленная
  const targetLine = "    b.balance_amt AS sfwef,";
  const isTargetAdded = addedExprSet.has(normalizeForDiff(targetLine));
  assert(
    isTargetAdded,
    `Строка '${targetLine}' должна распознаваться как добавленная для подсветки зелёным со знаком +`
  );
  console.log("  ✓ Строка 'b.balance_amt AS sfwef,' корректно распознаётся для подсветки зелёным цветом со знаком +");

  // Проверяем без алиаса у таблицы во FROM
  window.__propagationState.columnAliases.clear();
  const getTableInfoNoAlias = () => ({
    sql_script: `
SELECT
    account_id
FROM core.account_detail
LEFT JOIN core.client_detail ON account_detail.client_id = client_detail.client_id
    `.trim()
  });
  const sqlResultNoAlias = generateModifiedSql(childTableId, getTableInfoNoAlias, uniqueId);
  assert(
    sqlResultNoAlias.sql.includes("opened_date") && !sqlResultNoAlias.sql.includes(".opened_date"),
    `Без алиаса колонка должна быть без префикса. Получено:\n${sqlResultNoAlias.sql}`
  );
  console.log("  ✓ Таблица во FROM без алиаса: колонка без префикса ('opened_date')");

  console.log("\n======================================================");
  console.log("✓ ВСЕ ТЕСТЫ COLUMN PROPAGATION УСПЕШНО ПРОЙДЕНЫ!");
  console.log("======================================================");
}

runTests();
