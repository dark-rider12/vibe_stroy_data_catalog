/* 
Тест модуля автоматического улучшения читаемости SQL (sqlEnhancer.js)
*/

import "./setup.js";
import {
  capitalizeKeywords,
  maskStringsAndComments,
  unmaskStringsAndComments,
  ensureExplicitColumnAliasesInSelectList,
  qualifyColumnsInSelectList,
  enhanceSqlScript
} from "../src/utils/sqlEnhancer.js";
import { getCleanScriptText } from "../src/utils/scriptTransform.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
}

function runTests() {
  console.log("======================================================");
  console.log("ТЕСТИРОВАНИЕ: SQL Enhancer (Автоулучшение скрипта)");
  console.log("======================================================");

  // 1. Тестирование маскирования строк и комментариев
  console.log("\n1. Проверка защиты строковых литералов и комментариев:");
  const sampleWithStrings = "SELECT 'select from where', a.col -- comment with select\nFROM t /* multi select */";
  const { maskedSql, tokens } = maskStringsAndComments(sampleWithStrings);
  assert(tokens.length === 3, `Ожидалось 3 токена (строка, --, /* */), получено: ${tokens.length}`);
  const restored = unmaskStringsAndComments(maskedSql, tokens);
  assert(restored === sampleWithStrings, "Восстановленный SQL должен в точности совпадать с исходным");
  console.log("  ✓ Строки в кавычках и комментарии успешно маскируются и восстанавливаются");

  // 2. Тестирование нормализации регистра ключевых слов (Capitalize Keywords)
  console.log("\n2. Проверка нормализации регистра ключевых слов:");
  const lowercaseSql = "select a.id, b.val from table_a a left outer join table_b b on a.id = b.id where b.status is not null and b.type = 'active' order by a.id asc";
  const capitalized = capitalizeKeywords(lowercaseSql);
  assert(capitalized.includes("SELECT"), "SELECT должен быть в верхнем регистре");
  assert(capitalized.includes("LEFT OUTER JOIN"), "LEFT OUTER JOIN должен быть в верхнем регистре");
  assert(capitalized.includes("ON"), "ON должен быть в верхнем регистре");
  assert(capitalized.includes("WHERE"), "WHERE должен быть в верхнем регистре");
  assert(capitalized.includes("IS NOT NULL"), "IS NOT NULL должен быть в верхнем регистре");
  assert(capitalized.includes("AND"), "AND должен быть в верхнем регистре");
  assert(capitalized.includes("ORDER BY"), "ORDER BY должен быть в верхнем регистре");
  assert(capitalized.includes("ASC"), "ASC должен быть в верхнем регистре");
  assert(capitalized.includes("'active'"), "Строковый литерал 'active' не должен менять регистр");
  console.log("  ✓ Все ключевые слова переведены в верхний регистр без изменения строковых литералов");

  // 3. Тестирование явного добавления AS для псевдонимов колонок
  console.log("\n3. Проверка явного добавления AS для псевдонимов колонок:");
  const implicitAliasList = "    a.account_id id,\n    b.balance_amt blocked_amt,\n    count(*) total,\n    c.phone AS client_phone";
  const explicitAliases = ensureExplicitColumnAliasesInSelectList(implicitAliasList);
  assert(explicitAliases.includes("a.account_id AS id"), `Ожидалось 'a.account_id AS id'. Получено:\n${explicitAliases}`);
  assert(explicitAliases.includes("b.balance_amt AS blocked_amt"), `Ожидалось 'b.balance_amt AS blocked_amt'`);
  assert(explicitAliases.includes("count(*) AS total"), `Ожидалось 'count(*) AS total'`);
  assert(explicitAliases.includes("c.phone AS client_phone"), "Уже имеющийся явный AS client_phone должен сохраниться");

  // Проверка защиты от вставки AS перед комментариями и строковыми литералами
  const sqlWithCommentBlock = `CREATE TABLE dm.core.contract_account_link AS
SELECT DISTINCT
    cal.account_link_id,
    c.class_name
/*
    ,source_system_id
    ,is_active*/
FROM dm.ext_dds.contract_account_link cal`;
  const enhancedComment = enhanceSqlScript(sqlWithCommentBlock);
  assert(!enhancedComment.includes("c.class_name AS /*"), `Ошибка: обнаружено 'c.class_name AS /*'. Получено:\n${enhancedComment}`);
  assert(enhancedComment.includes("c.class_name\n/*") || enhancedComment.includes("c.class_name \n/*"), "Исходный комментарий должен остаться без AS");

  // Проверка: реальный алиас с хвостовым комментарием должен получить AS перед алиасом, а не перед комментарием
  const sqlAliasWithComment = `SELECT c.class_name my_col /* comment */ FROM t`;
  const enhancedAliasComment = enhanceSqlScript(sqlAliasWithComment);
  assert(enhancedAliasComment.includes("c.class_name AS my_col /* comment */"), `Ожидалось 'c.class_name AS my_col /* comment */'. Получено:\n${enhancedAliasComment}`);

  // Проверка: строковое выражение в конце (col || 'abc') не должно получать AS
  const sqlStringConcat = `SELECT col || 'abc' FROM tab`;
  const enhancedStringConcat = enhanceSqlScript(sqlStringConcat);
  assert(!enhancedStringConcat.includes("AS 'abc'"), `Строковый литерал не должен трактоваться как алиас. Получено:\n${enhancedStringConcat}`);

  console.log("  ✓ Неявные псевдонимы (expr alias) преобразованы в явные (expr AS alias)");
  console.log("  ✓ Комментарии и строковые литералы надёжно защищены от ошибочной вставки AS");

  // 4. Тестирование квалификации полей (Column Qualification)
  console.log("\n4. Проверка квалификации полей по метаданным таблиц:");
  const testJoinedTables = [
    {
      alias: "a",
      cols: new Set(["account_id", "account_num", "client_id", "open_date"])
    },
    {
      alias: "c",
      cols: new Set(["client_id", "client_name", "phone", "email"])
    }
  ];

  const unaliasedColumns = "    account_num,\n    client_id,\n    phone AS client_phone,\n    a.open_date";
  const qualified = qualifyColumnsInSelectList(unaliasedColumns, testJoinedTables);

  assert(qualified.includes("a.account_num"), `Уникальное поле 'account_num' должно получить алиас 'a.'. Получено:\n${qualified}`);
  assert(qualified.includes("c.phone AS client_phone"), `Уникальное поле 'phone' должно получить алиас 'c.'. Получено:\n${qualified}`);
  assert(
    qualified.includes("    client_id,") && !qualified.includes(".client_id,"),
    `Неоднозначное поле 'client_id' (присутствует в обеих таблицах) НЕ должно модифицироваться`
  );
  assert(qualified.includes("a.open_date"), "Уже квалифицированное поле 'a.open_date' не должно задваиваться");
  console.log("  ✓ Уникальные поля успешно квалифицированы алиасами соответствующих таблиц");
  console.log("  ✓ Неоднозначные поля в 2+ таблицах сохранены без изменений (100% безопасность)");

  // 5. Проверка сохранения авторского форматирования в секциях FROM / JOIN / WHERE
  console.log("\n5. Проверка сохранения авторского форматирования строк и отступов:");
  const authorFrom = `FROM dds.core.account_balance_detail b
LEFT JOIN dds.core.account_detail a ON b.account_id = a.account_id AND a.account_type = 'ACTIVE'
WHERE b.currency_cd = 'RUB' AND b.balance_amt > 0;`;

  // 6. Комплексное тестирование enhanceSqlScript
  console.log("\n6. Комплексный тест enhanceSqlScript (End-to-End):");
  const mockCatalogData = {
    dds: {
      core: {
        account_detail: {
          columns: [
            { name: "account_id" },
            { name: "account_number" },
            { name: "account_type" },
            { name: "client_id" }
          ]
        },
        account_balance_detail: {
          columns: [
            { name: "balance_id" },
            { name: "account_id" },
            { name: "balance_amt" },
            { name: "currency_cd" },
            { name: "balance_date" }
          ]
        }
      }
    }
  };

  const rawTestScript = `
create table dm.core.account_balance_dynamics as
select
    b.account_id,
    account_number,
    account_type,
    currency_cd,
    balance_amt sfwef,
    b.balance_amt - 100 blocked_amt
${authorFrom}
  `.trim();

  const enhanced = enhanceSqlScript(rawTestScript, {
    catalogData: mockCatalogData,
    currentDb: "dm",
    currentSchema: "core",
    currentTable: "account_balance_dynamics"
  });

  console.log("\n--- Результат автоулучшения ---:\n" + enhanced + "\n-------------------------------");

  // Проверка ключевых слов
  assert(enhanced.includes("CREATE TABLE"), "CREATE TABLE в верхнем регистре");
  assert(enhanced.includes("SELECT"), "SELECT в верхнем регистре");
  assert(enhanced.includes("FROM"), "FROM в верхнем регистре");
  assert(enhanced.includes("LEFT JOIN"), "LEFT JOIN в верхнем регистре");

  // Проверка квалификации колонок
  assert(enhanced.includes("a.account_number"), "account_number квалифицировано как 'a.account_number'");
  assert(enhanced.includes("a.account_type"), "account_type квалифицировано как 'a.account_type'");
  assert(enhanced.includes("b.currency_cd"), "currency_cd квалифицировано как 'b.currency_cd'");

  // Проверка явного AS
  assert(enhanced.includes("balance_amt AS sfwef") || enhanced.includes("b.balance_amt AS sfwef"), "Псевдоним sfwef оформлен через AS");
  assert(enhanced.includes("AS blocked_amt"), "Псевдоним blocked_amt оформлен через AS");

  // Проверка сохранения авторского форматирования в строке JOIN (без принудительного переноса)
  assert(
    enhanced.includes("LEFT JOIN dds.core.account_detail a ON b.account_id = a.account_id AND a.account_type = 'ACTIVE'"),
    "Авторское форматирование строки JOIN сохранено"
  );
  console.log("  ✓ Авторская структура строк и отступов в секциях FROM/JOIN/WHERE сохранена неизменной");

  // 7. Тестирование getCleanScriptText (защита от склеивания строк и артефактов .line-num)
  console.log("\n7. Проверка getCleanScriptText (защита от склеивания строк в одну):");

  // Тест 7а: извлечение из window.catalogData
  const mockPre = {
    dataset: { db: "dm", schema: "core", table: "account_rest_daily" },
    querySelectorAll: () => []
  };
  const mockCode = { textContent: "corrupted_single_line_text", dataset: {} };
  global.window = global.window || {};
  global.window.catalogData = {
    dm: {
      core: {
        account_rest_daily: {
          sql_script: "create table dm.core.account_rest_daily\n    as\nselect 1, 2, 3",
          sql_script_extra: "ANALYZE dm.core.account_rest_daily;"
        }
      }
    }
  };

  const scriptFromCatalog = getCleanScriptText(mockPre, mockCode);
  assert(
    scriptFromCatalog.includes("create table dm.core.account_rest_daily\n    as\nselect 1, 2, 3\n\n\nANALYZE"),
    `Извлечение из catalogData должно вернуть многострочный SQL. Получено: ${scriptFromCatalog}`
  );
  console.log("  ✓ Уровень 1 (window.catalogData): извлекается чистый многострочный SQL минуя DOM");

  // Тест 7б: извлечение из code.dataset.rawScript
  const mockPreNoCat = { dataset: { db: "unknown", schema: "x", table: "y" }, querySelectorAll: () => [] };
  const mockCodeWithRaw = { dataset: { rawScript: "SELECT\n    a,\n    b\nFROM t" } };
  const scriptFromRaw = getCleanScriptText(mockPreNoCat, mockCodeWithRaw);
  assert(scriptFromRaw === "SELECT\n    a,\n    b\nFROM t", "Извлечение из dataset.rawScript успешно");
  console.log("  ✓ Уровень 2 (code.dataset.rawScript): извлекается ранее сохранённый чистый текст");

  // Тест 7в: извлечение из .line-code узлов DOM (игнорируя .line-num)
  const line1 = { textContent: "create table test" };
  const line2 = { textContent: "select 1" };
  const mockPreWithLines = {
    dataset: {},
    querySelectorAll: (sel) => (sel === ".line-code" ? [line1, line2] : [])
  };
  const mockCodeCorrupted = {
    // В DOM textContent вернул бы "1create table test2select 1"
    textContent: "1create table test2select 1",
    dataset: {}
  };
  const scriptFromLineCode = getCleanScriptText(mockPreWithLines, mockCodeCorrupted);
  assert(
    scriptFromLineCode === "create table test\nselect 1",
    `Извлечение из .line-code должно отбросить номера и сохранить переносы. Получено: ${scriptFromLineCode}`
  );
  console.log("  ✓ Уровень 3 (.line-code узлы DOM): отбрасываются цифры .line-num и восстанавливаются переносы строк \\n");

  console.log("\n======================================================");
  console.log("✓ ВСЕ ТЕСТЫ SQL ENHANCER УСПЕШНО ПРОЙДЕНЫ!");
  console.log("======================================================");
}

runTests();
