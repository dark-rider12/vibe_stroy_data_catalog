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
  prettifyJoinsAndConditions,
  enhanceSqlScript
} from "../src/utils/sqlEnhancer.js";

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
  console.log("  ✓ Неявные псевдонимы (expr alias) преобразованы в явные (expr AS alias)");

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

  // 5. Тестирование выравнивания отступов JOIN и условий (Prettify)
  console.log("\n5. Проверка выравнивания отступов JOIN и AND/OR:");
  const unformattedFrom = `FROM core.account_detail a
LEFT JOIN core.client_detail c ON a.client_id = c.client_id AND c.is_active = true
WHERE a.is_active = true AND a.open_date >= '2024-01-01'`;

  const prettified = prettifyJoinsAndConditions(unformattedFrom);
  assert(prettified.includes("    ON a.client_id = c.client_id"), `ON должно быть с отступом 4 пробела. Получено:\n${prettified}`);
  assert(prettified.includes("    AND c.is_active = true"), `AND в ON должно быть с отступом 4 пробела`);
  assert(prettified.includes("    AND a.open_date >= '2024-01-01'"), `AND в WHERE должно быть с отступом 4 пробела`);
  console.log("  ✓ Секции ON и логические связки AND/OR перенесены на отдельные строки с 4 пробелами");

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
from dds.core.account_balance_detail b
left join dds.core.account_detail a on b.account_id = a.account_id and a.account_type = 'ACTIVE'
where b.currency_cd = 'RUB' and b.balance_amt > 0;
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

  // Проверка форматирования
  assert(enhanced.includes("    ON b.account_id = a.account_id"), "ON на новой строке с 4 пробелами");
  assert(enhanced.includes("    AND a.account_type = 'ACTIVE'"), "AND в ON на новой строке с 4 пробелами");
  assert(enhanced.includes("    AND b.balance_amt > 0"), "AND в WHERE на новой строке с 4 пробелами");

  console.log("\n======================================================");
  console.log("✓ ВСЕ ТЕСТЫ SQL ENHANCER УСПЕШНО ПРОЙДЕНЫ!");
  console.log("======================================================");
}

runTests();
