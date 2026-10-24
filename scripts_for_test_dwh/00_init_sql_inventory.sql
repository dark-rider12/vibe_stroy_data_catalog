-- ============================================================================
-- 00_init_sql_inventory.sql
-- Инициализация инфраструктуры автоматического сбора SQL (public.sql_inventory)
--
-- Назначение:
--   Создает таблицу public.sql_inventory, функцию и Event Trigger для автоматического
--   перехвата DDL-запросов (CREATE TABLE, CREATE TABLE AS, CREATE VIEW и др.).
--   Именно из public.sql_inventory генератор каталога (sql_loader.py) извлекает
--   скрипты трансформаций и строит автоматический Table & Column Lineage.
--
-- ВНИМАНИЕ:
--   Этот скрипт необходимо выполнить в ОБЕИХ базах данных: dds и dm
--   ДО выполнения скриптов создания витрин и таблиц (02_init_dds.sql и 03_init_dm.sql),
--   чтобы все последующие DDL-команды автоматически записались в инвентарь!
--
-- Пример запуска:
--   psql -U postgres -d dds -f 00_init_sql_inventory.sql
--   psql -U postgres -d dm  -f 00_init_sql_inventory.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sql_inventory (
	target_schema text NOT NULL,
	target_table text NOT NULL,
	query_text text NULL,
	updated_at timestamp DEFAULT CURRENT_TIMESTAMP NULL,
	CONSTRAINT sql_inventory_pkey PRIMARY KEY (target_schema, target_table),
	CONSTRAINT sql_inventory_target_schema_not_null NOT NULL target_schema,
	CONSTRAINT sql_inventory_target_table_not_null NOT NULL target_table
);

CREATE OR REPLACE FUNCTION public.trg_capture_ddl_sql()
 RETURNS event_trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    obj record;
    v_table_name text;
BEGIN
    FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
    LOOP
        -- Ловим создание таблиц через SELECT/AS и создание вьюх
        IF obj.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'CREATE VIEW', 'CREATE OR REPLACE VIEW') THEN
            
            -- Извлекаем только имя объекта из object_identity (убираем схему)
            -- Например, из 'public.test_lineage' получим 'test_lineage'
            v_table_name := CASE 
                WHEN obj.object_identity LIKE '%.%' THEN split_part(obj.object_identity, '.', 2)
                ELSE obj.object_identity 
            END;
            INSERT INTO public.sql_inventory (target_schema, target_table, query_text, updated_at)
            VALUES (obj.schema_name, v_table_name, current_query(), CURRENT_TIMESTAMP)
            ON CONFLICT (target_schema, target_table) 
            DO UPDATE SET query_text = EXCLUDED.query_text, updated_at = EXCLUDED.updated_at;
        END IF;
    END LOOP;
END;
$function$
;

DROP EVENT TRIGGER IF EXISTS capture_ddl_sql_trigger_public;

CREATE EVENT TRIGGER capture_ddl_sql_trigger_public ON ddl_command_end
	EXECUTE FUNCTION public.trg_capture_ddl_sql();
