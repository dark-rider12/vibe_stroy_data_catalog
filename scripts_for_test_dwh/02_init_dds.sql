-- ============================================================================
-- 02_init_dds.sql
-- Слой: DDS (Detailed Data Store)
-- База данных: dds
-- Схемы: core, calc, ext_ods, sandbox_1, sandbox_2
-- Описание:
--   1. Настройка postgres_fdw (сервер ods_server -> БД ods).
--   2. Импорт внешних таблиц из ods.core в схему ext_ods.
--   3. Создание детальных таблиц/представлений DDS (с выборкой из ext_ods).
--   4. Добавление комментариев к таблицам и колонкам.
--   5. Регистрация SQL-трансформаций в public.sql_inventory (для Data Catalog).
-- ============================================================================

-- Подключение к БД dds (раскомментируйте при выполнении через psql):
-- \c dds

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- ----------------------------------------------------------------------------
-- Настройка FDW-соединения с БД ods
-- ВНИМАНИЕ: укажите реальные параметры подключения к вашей БД ods:
-- ----------------------------------------------------------------------------
DROP SERVER IF EXISTS ods_server CASCADE;
CREATE SERVER ods_server
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host 'localhost', dbname 'ods', port '5432');

-- Маппинг пользователя (замените postgres и YOUR_PASSWORD на ваши реквизиты)
CREATE USER MAPPING IF NOT EXISTS FOR CURRENT_USER
    SERVER ods_server
    OPTIONS (user 'postgres', password 'YOUR_PASSWORD');

-- Создание целевых схем
CREATE SCHEMA IF NOT EXISTS ext_ods;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS calc;
CREATE SCHEMA IF NOT EXISTS sandbox_1;
CREATE SCHEMA IF NOT EXISTS sandbox_2;

-- Импорт всех 17 внешних таблиц из ODS (схема core) в локальную схему ext_ods
IMPORT FOREIGN SCHEMA core FROM SERVER ods_server INTO ext_ods;

-- ----------------------------------------------------------------------------
-- Создание таблиц и представлений слоя DDS
-- ----------------------------------------------------------------------------
create or replace view core.v_test_account_detail as
select
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,
    cl.client_id,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,
    current_date - a.open_date as account_age_days  
from ext_ods.abs_account a
join ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join ext_ods.crm_client cl
    on cl.client_id = c.client_id;


SELECT * FROM pg_extension WHERE extname = 'uuid-ossp';
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";



create table core.account_detail as
select
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,
    cl.client_id,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,
    current_date - a.open_date as account_age_days,
    uuid_generate_v5(uuid_nil(), 0 :: text) as source_system_id, -- ID системы-источника. Ссылка на core.ref_source_system
	true as is_active, -- Признак актуальности
	false as is_deleted, -- Признак удаления записи в системе-источнике
	'1900-01-01 23:59:59.999' :: timestamp as dwh_start_date, -- Дата начала действия записи
	'9999-12-31 23:59:59.999' :: timestamp as dwh_end_date, -- Дата окончания действия записи
	uuid_generate_v5(uuid_nil(), 1 :: text) as etl_process_id -- ID ETL процесса. Ссылка на справочник ref_etl_process
from ext_ods.abs_account a
join ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join ext_ods.crm_client cl
    on cl.client_id = c.client_id;

CREATE UNIQUE INDEX account_detail_pkey
ON core.account_detail (account_id)
WHERE is_active = true;

ALTER TABLE core.account_detail
ADD CONSTRAINT account_detail_unique_version
UNIQUE (account_id, dwh_start_date);

--наложение ограничений NOT NULL
-- core.account_detail
alter table core.account_detail 
    alter column account_id set not null,
    alter column account_number set not null,
    alter column account_type set not null,
    alter column client_id set not null,
    alter column contract_id set not null;

-- ==================== core.account_detail ====================

comment on table core.account_detail is 'Детальная информация по банковским счетам клиентов с данными договоров и клиентской информацией. Детальный слой (DDS).';

comment on column core.account_detail.account_id is 'Уникальный идентификатор счёта (суррогатный ключ)';
comment on column core.account_detail.account_number is 'Номер банковского счёта';
comment on column core.account_detail.account_type is 'Тип счёта (депозитный, текущий, кредитный и т.д.)';
comment on column core.account_detail.currency_cd is 'Код валюты счёта в формате ISO 4217';
comment on column core.account_detail.open_date is 'Дата открытия счёта';
comment on column core.account_detail.close_date is 'Дата закрытия счёта (NULL, если счёт активен)';
comment on column core.account_detail.balance_amt is 'Текущий остаток средств на счёте';
comment on column core.account_detail.account_status is 'Статус счёта (active, closed, blocked и т.д.)';
comment on column core.account_detail.contract_id is 'Уникальный идентификатор договора, связанного со счётом';
comment on column core.account_detail.contract_number is 'Номер договора в учётной системе';
comment on column core.account_detail.contract_type is 'Тип договора (кредитный, депозитный, текущий и т.д.)';
comment on column core.account_detail.contract_start_date is 'Дата начала действия договора';
comment on column core.account_detail.contract_end_date is 'Дата окончания действия договора';
comment on column core.account_detail.interest_rate is 'Процентная ставка по договору (годовых)';
comment on column core.account_detail.contract_status is 'Статус договора (active, terminated, expired и т.д.)';
comment on column core.account_detail.client_id is 'Уникальный идентификатор клиента-владельца счёта';
comment on column core.account_detail.client_full_name is 'Полное ФИО клиента (фамилия, имя, отчество)';
comment on column core.account_detail.birth_date is 'Дата рождения клиента';
comment on column core.account_detail.phone is 'Контактный телефон клиента';
comment on column core.account_detail.email is 'Адрес электронной почты клиента';
comment on column core.account_detail.client_status is 'Статус клиента в CRM (active, inactive, blocked и т.д.)';
comment on column core.account_detail.account_age_days is 'Возраст счёта в днях (разница между текущей датой и датой открытия)';


create table core.transaction_detail as
select
    t.transaction_id,
    t.account_id,
    a.account_number,
    t.transaction_ts,
    t.transaction_ts::date as transaction_date,
    t.transaction_type,
    t.amount_amt,
    case
        when t.transaction_type = 'debit' then -t.amount_amt
        else t.amount_amt
    end as signed_amount_amt,
    t.currency_cd,
    t.merchant_name,
    t.description_txt,
    t.channel_cd,
    t.transaction_status,
    case
        when t.merchant_name is not null then 'merchant_operation'
        when t.description_txt ilike '%перевод%' then 'transfer'
        when t.description_txt ilike '%зарплат%' then 'salary'
        else 'other'
    end as operation_category,
    uuid_generate_v5(uuid_nil(), 0 :: text) as source_system_id, -- ID системы-источника. Ссылка на core.ref_source_system
	uuid_generate_v5(uuid_nil(), 1 :: text) as etl_process_id -- ID ETL процесса. Ссылка на справочник ref_etl_process
from ext_ods.abs_transaction t
join ext_ods.abs_account a
    on a.account_id = t.account_id;

alter table core.transaction_detail
    add constraint transaction_id_pkey primary key (transaction_id);


-- Профиль: связывает данные DDS с новыми ODS-справочниками
create table core.client_account_profile as
select
    ad.account_id,
    ad.account_number,
    ad.client_id,
    ad.client_full_name,
    ad.client_status,
    doc.doc_series || ' ' || doc.doc_number as active_passport,
    addr.city as client_city,
    addr.address_type
from core.account_detail ad
left join ext_ods.crm_client_document doc 
    on ad.client_id = doc.client_id 
    and doc.doc_type = 'passport' 
    and doc.is_active = true
left join ext_ods.crm_client_address addr 
    on ad.client_id = addr.client_id 
    and addr.is_active = true;

alter table core.client_account_profile
    add constraint pk_client_account_profile
    primary key (client_id, account_id);


-- Детализация по картам: маскируем номер карты по правилу 6*4 и вычисляем срок годности
create table core.card_detail as
select
    card_id,
    account_id,
    -- Маскирование: оставляем первые 6 и последние 4 цифры
    left(card_number, 6) || '******' || right(card_number, 4) as masked_card_number,
    card_system,
    issue_date,
    expiry_date,
    card_status,
    -- Бизнес-логика: определяем, не просрочена ли карта
    case 
        when expiry_date < current_date then 'expired'
        when card_status = 'active' then 'valid'
        else 'invalid'
    end as validity_status
from ext_ods.abs_card;


-- core.transaction_detail
alter table core.transaction_detail 
    alter column transaction_id set not null,
    alter column account_id set not null,
    alter column transaction_ts set not null,
    alter column transaction_type set not null,
    alter column amount_amt set not null;

-- core.client_account_profile
alter table core.client_account_profile 
    alter column account_number set not null,
    alter column client_full_name set not null;



-- core.card_detail
alter table core.card_detail 
    alter column card_id set not null,
    alter column account_id set not null,
    alter column masked_card_number set not null,
    alter column card_status set not null,
    alter column validity_status set not null;



--core.ref_source_system
create table core.ref_source_system (
	system_name varchar not null, --Название системы
	system_prefix varchar not null --Префикс на ODS-слое
);


COMMENT ON COLUMN core.ref_source_system.system_name IS 'Название системы';
COMMENT ON COLUMN core.ref_source_system.system_prefix IS 'Префикс на ODS-слое';
COMMENT ON TABLE core.ref_source_system IS 'Справочник систем-источников данных';


--core.ref_source_system
create table core.ref_manual_test (
	test_1 varchar, --Название системы
	test_2 varchar --Префикс на ODS-слое
);


COMMENT ON COLUMN core.ref_manual_test.test_1 IS 'Тестовое поле 1';
COMMENT ON COLUMN core.ref_manual_test.test_2 IS 'Тестовое поле 2';
COMMENT ON TABLE core.ref_manual_test IS 'Ручной тестовый справочник ';



-- ==================== 3. Создание таблиц для юнионов DDS ====================

-- DDS: юридические лица
create table core.corporate_client_detail as
select
    corporate_client_id as client_id,
    inn,
    kpp,
    ogrn,
    company_name,
    coalesce(short_name, company_name) as display_name,
    legal_address,
    coalesce(actual_address, legal_address) as effective_address,
    ceo_full_name,
    ceo_position,
    phone,
    email,
    industry_cd,
    company_size_cd,
    registration_date,
    current_date - registration_date as company_age_days,
    status_cd,
    created_ts
from ext_ods.crm_corporate_client;


-- DDS: физические лица
create table core.individual_client_detail as
select
    individual_client_id as client_id,
    last_name,
    first_name,
    middle_name,
    concat_ws(' ', last_name, first_name, middle_name) as full_name,
    birth_date,
    current_date - birth_date as age_days,
    passport_series || ' ' || passport_number as passport_full,
    passport_issue_date,
    passport_issuer,
    snils,
    inn,
    phone,
    email,
    registration_address,
    coalesce(actual_address, registration_address) as effective_address,
    marital_status_cd,
    employment_type_cd,
    monthly_income_amt,
    case
        when monthly_income_amt >= 200000 then 'high'
        when monthly_income_amt >= 100000 then 'medium'
        else 'low'
    end as income_level_cd,
    status_cd,
    created_ts
from ext_ods.crm_individual_client;


--dds calc таблица с родителями тоже из dds
create table calc.account_card_contract as
select
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    ad.open_date,
    ad.close_date,
    ad.balance_amt,
    ad.account_status,
    ad.contract_id,
    ad.contract_number,
    ad.contract_type,
    ad.contract_start_date,
    ad.contract_end_date,
    ad.interest_rate,
    ad.contract_status,
    ad.client_id,
    ad.client_full_name,
    cd.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.issue_date,
    cd.expiry_date,
    cd.card_status,
    cd.validity_status
from core.account_detail ad
left join core.card_detail cd
    on cd.account_id = ad.account_id;

COMMENT ON TABLE calc.account_card_contract IS 'dds calc таблица с родителями тоже из dds';


--таблица из всех сырых таблиц
create table core.master_account_party as
select
    -- Счёт
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,

    -- Договор
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,

    -- Клиент (общий справочник)
    cl.client_id,
    cl.last_name,
    cl.first_name,
    cl.middle_name,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,

    -- Тип клиента
    case
        when cc.corporate_client_id is not null then 'CORPORATE'
        when ic.individual_client_id is not null then 'INDIVIDUAL'
        else 'UNKNOWN'
    end as party_type,

    -- Юридическое лицо
    cc.inn as corp_inn,
    cc.kpp,
    cc.ogrn,
    cc.company_name,
    cc.short_name as company_short_name,
    cc.legal_address,
    cc.actual_address as company_actual_address,
    cc.ceo_full_name,
    cc.ceo_position,
    cc.industry_cd,
    cc.company_size_cd,
    cc.registration_date as company_registration_date,

    -- Физическое лицо
    ic.passport_series,
    ic.passport_number,
    ic.passport_issue_date,
    ic.snils,
    ic.inn as individual_inn,
    ic.marital_status_cd,
    ic.employment_type_cd,
    ic.monthly_income_amt,

    -- Адрес
    addr.city as client_city,
    addr.address_type,

    -- Документ
    doc.doc_series,
    doc.doc_number,
    doc.doc_type,
    doc.issue_date as doc_issue_date,

    -- Карта
    card.card_id,
    left(card.card_number, 6) || '******' || right(card.card_number, 4) as masked_card_number,
    card.card_system,
    card.issue_date as card_issue_date,
    card.expiry_date as card_expiry_date,
    card.card_status,
    case
        when card.expiry_date < current_date then 'expired'
        when card.card_status = 'active' then 'valid'
        else 'invalid'
    end as card_validity_status,

    -- Транзакции (агрегаты из подзапроса)
    tx.total_trx_count,
    tx.last_trx_date,
    tx.total_debit_amt,
    tx.total_credit_amt,

    -- Расчётные поля
    current_date - a.open_date as account_age_days,
    current_date - coalesce(ic.birth_date, cc.registration_date) as party_age_days

from ext_ods.abs_account a
join ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join ext_ods.crm_client cl
    on cl.client_id = c.client_id
left join ext_ods.crm_corporate_client cc
    on cc.corporate_client_id = cl.client_id
left join ext_ods.crm_individual_client ic
    on ic.individual_client_id = cl.client_id
left join ext_ods.crm_client_address addr
    on addr.client_id = cl.client_id
    and addr.is_active = true
left join ext_ods.crm_client_document doc
    on doc.client_id = cl.client_id
    and doc.is_active = true
left join ext_ods.abs_card card
    on card.account_id = a.account_id
left join (
    select
        account_id,
        count(*) as total_trx_count,
        max(transaction_ts::date) as last_trx_date,
        sum(case when transaction_type = 'debit' then amount_amt else 0 end) as total_debit_amt,
        sum(case when transaction_type = 'credit' then amount_amt else 0 end) as total_credit_amt
    from ext_ods.abs_transaction
    group by account_id
) tx
    on tx.account_id = a.account_id;


-- ==================== Комментарии ====================

comment on table core.master_account_party is 'Мастер-таблица детального слоя: полный профиль счёта, договора, клиента (ФЛ/ЮЛ), адреса, документа, карты и агрегированной транзакционной активности. Объединяет все 9 таблиц слоя ext_ods.';

comment on column core.master_account_party.account_id is 'Идентификатор счёта (ext_ods.abs_account)';
comment on column core.master_account_party.account_number is 'Номер счёта';
comment on column core.master_account_party.account_type is 'Тип счёта';
comment on column core.master_account_party.currency_cd is 'Код валюты';






--четное кол-во

--таблица из всех сырых таблиц
create table core.master_account_party_2 as
select
    -- Счёт
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,

    -- Договор
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,

    -- Клиент (общий справочник)
    cl.client_id,
    cl.last_name,
    cl.first_name,
    cl.middle_name,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,

    -- Тип клиента
    case
        when cc.corporate_client_id is not null then 'CORPORATE'
        when ic.individual_client_id is not null then 'INDIVIDUAL'
        else 'UNKNOWN'
    end as party_type,

    -- Юридическое лицо
    cc.inn as corp_inn,
    cc.kpp,
    cc.ogrn,
    cc.company_name,
    cc.short_name as company_short_name,
    cc.legal_address,
    cc.actual_address as company_actual_address,
    cc.ceo_full_name,
    cc.ceo_position,
    cc.industry_cd,
    cc.company_size_cd,
    cc.registration_date as company_registration_date,

    -- Физическое лицо
    ic.passport_series,
    ic.passport_number,
    ic.passport_issue_date,
    ic.snils,
    ic.inn as individual_inn,
    ic.marital_status_cd,
    ic.employment_type_cd,
    ic.monthly_income_amt,

    -- Адрес
    addr.city as client_city,
    addr.address_type,

    -- Документ
    doc.doc_series,
    doc.doc_number,
    doc.doc_type,
    doc.issue_date as doc_issue_date,

--     Карта
--    card.card_id,
--    left(card.card_number, 6) || '******' || right(card.card_number, 4) as masked_card_number,
--    card.card_system,
--    card.issue_date as card_issue_date,
--    card.expiry_date as card_expiry_date,
--    card.card_status,
--    case
--        when card.expiry_date < current_date then 'expired'
--        when card.card_status = 'active' then 'valid'
--        else 'invalid'
--    end as card_validity_status,

    -- Транзакции (агрегаты из подзапроса)
    tx.total_trx_count,
    tx.last_trx_date,
    tx.total_debit_amt,
    tx.total_credit_amt,

    -- Расчётные поля
    current_date - a.open_date as account_age_days,
    current_date - coalesce(ic.birth_date, cc.registration_date) as party_age_days

from ext_ods.abs_account a
join ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join ext_ods.crm_client cl
    on cl.client_id = c.client_id
left join ext_ods.crm_corporate_client cc
    on cc.corporate_client_id = cl.client_id
left join ext_ods.crm_individual_client ic
    on ic.individual_client_id = cl.client_id
left join ext_ods.crm_client_address addr
    on addr.client_id = cl.client_id
    and addr.is_active = true
left join ext_ods.crm_client_document doc
    on doc.client_id = cl.client_id
    and doc.is_active = true
--left join ext_ods.abs_card card
--    on card.account_id = a.account_id
left join (
    select
        account_id,
        count(*) as total_trx_count,
        max(transaction_ts::date) as last_trx_date,
        sum(case when transaction_type = 'debit' then amount_amt else 0 end) as total_debit_amt,
        sum(case when transaction_type = 'credit' then amount_amt else 0 end) as total_credit_amt
    from ext_ods.abs_transaction
    group by account_id
) tx
    on tx.account_id = a.account_id;


-- ==================== Комментарии ====================

comment on table core.master_account_party_2 is 'четное кол-во';





-- ==================== core.transaction_detail ====================

comment on table core.transaction_detail is 'Детальная информация по финансовым операциям и транзакциям клиентов. Детальный слой (DDS).';

comment on column core.transaction_detail.transaction_id is 'Уникальный идентификатор транзакции';
comment on column core.transaction_detail.account_id is 'Идентификатор счёта, по которому совершена транзакция';
comment on column core.transaction_detail.account_number is 'Номер счёта, по которому совершена транзакция';
comment on column core.transaction_detail.transaction_ts is 'Дата и время совершения транзакции (с временной меткой)';
comment on column core.transaction_detail.transaction_date is 'Дата транзакции (без времени, для агрегаций по дням)';
comment on column core.transaction_detail.transaction_type is 'Тип транзакции (debit — списание, credit — зачисление)';
comment on column core.transaction_detail.amount_amt is 'Сумма транзакции (абсолютное значение)';
comment on column core.transaction_detail.signed_amount_amt is 'Сумма транзакции со знаком: отрицательная для списаний (debit), положительная для зачислений (credit)';
comment on column core.transaction_detail.currency_cd is 'Код валюты транзакции';
comment on column core.transaction_detail.merchant_name is 'Наименование мерчанта / торговой точки (для карточных операций)';
comment on column core.transaction_detail.description_txt is 'Назначение платежа / описание операции';
comment on column core.transaction_detail.channel_cd is 'Канал совершения операции (online, atm, branch, mobile и т.д.)';
comment on column core.transaction_detail.transaction_status is 'Статус транзакции (completed, pending, declined, reversed и т.д.)';
comment on column core.transaction_detail.operation_category is 'Категория операции: merchant_operation (по мерчанту), transfer (перевод), salary (зарплата), other (прочее)';


-- ==================== core.client_account_profile ====================

comment on table core.client_account_profile is 'Профиль клиента и счёта с паспортными данными и адресом проживания. Детальный слой (DDS).';

comment on column core.client_account_profile.account_id is 'Идентификатор счёта';
comment on column core.client_account_profile.account_number is 'Номер банковского счёта';
comment on column core.client_account_profile.client_id is 'Идентификатор клиента-владельца';
comment on column core.client_account_profile.client_full_name is 'Полное ФИО клиента';
comment on column core.client_account_profile.client_status is 'Статус клиента в CRM';
comment on column core.client_account_profile.active_passport is 'Действующий паспорт клиента (серия и номер), активный на текущий момент';
comment on column core.client_account_profile.client_city is 'Город проживания клиента (из активного адреса)';
comment on column core.client_account_profile.address_type is 'Тип адреса (registration — регистрация, residence — фактическое проживание и т.д.)';


-- ==================== core.card_detail ====================

comment on table core.card_detail is 'Детальная информация по банковским картам клиентов с маскированными номерами и расчётом срока годности. Детальный слой (DDS).';

comment on column core.card_detail.card_id is 'Уникальный идентификатор карты';
comment on column core.card_detail.account_id is 'Идентификатор счёта, к которому привязана карта';
comment on column core.card_detail.masked_card_number is 'Маскированный номер карты в формате 6******4 (первые 6 и последние 4 цифры)';
comment on column core.card_detail.card_system is 'Платёжная система карты (Visa, Mastercard, МИР и т.д.)';
comment on column core.card_detail.issue_date is 'Дата выпуска / выдачи карты клиенту';
comment on column core.card_detail.expiry_date is 'Дата окончания срока действия карты';
comment on column core.card_detail.card_status is 'Статус карты в учётной системе (active, blocked, reissued и т.д.)';
comment on column core.card_detail.validity_status is 'Вычисляемый статус валидности: expired (просрочена), valid (активна и не просрочена), invalid (иные статусы)';




--таблица "1c_leasing"
create unlogged table core.leasing_detail as
select
    leasing_id,
    contract_number,
    contract_date,
    lessee_inn,
    lessee_name,
    lessor_inn,
    lessor_name,
    leasing_object_name,
    object_type_cd,
    object_cost_amt,
    advance_payment_amt,
    coalesce(advance_payment_amt, 0) / nullif(object_cost_amt, 0) * 100 as advance_pct,
    leasing_term_months,
    interest_rate,
    monthly_payment_amt,
    total_leasing_cost_amt,
    buyout_cost_amt,
    total_leasing_cost_amt - object_cost_amt as overpayment_amt,
    currency_cd,
    contract_status_cd,
    start_date,
    end_date,
    end_date - start_date as contract_duration_days,
    payment_day,
    collateral_type_cd,
    collateral_value_amt,
    insurance_required_flg,
    insurance_company_name,
    case
        when contract_status_cd = 'closed' then 'completed'
        when end_date < current_date then 'overdue'
        when end_date <= current_date + interval '90 days' then 'expiring_soon'
        else 'normal'
    end as maturity_status,
    created_ts,
    updated_ts
from ext_ods."1C_leasing";

comment on table core.leasing_detail is 'Детальная информация по лизинговым договорам из 1С. Детальный слой (DDS). Преобразования: расчёт процента аванса, переплаты, длительности в днях и статуса погашения.';




comment on table core.corporate_client_detail is 'Детальная информация по корпоратиным клиентам';


COMMENT ON COLUMN core.corporate_client_detail.client_id IS 'ID клиента';
COMMENT ON COLUMN core.corporate_client_detail.inn IS 'Бизнес-ключ: ИНН юридического лица (10 знаков). Основное поле для связывания с другими витринами DWH.';
COMMENT ON COLUMN core.corporate_client_detail.kpp IS 'КПП (Код причины постановки на учет). Может быть NULL для индивидуальных предпринимателей или организаций, не имеющих КПП.';
COMMENT ON COLUMN core.corporate_client_detail.ogrn IS 'ОГРН (Основной государственный регистрационный номер).';
COMMENT ON COLUMN core.corporate_client_detail.company_name IS 'Полное фирменное наименование организации (как в ЕГРЮЛ/учредительных документах на момент выгрузки).';
COMMENT ON COLUMN core.corporate_client_detail.display_name IS 'Наименование клиента';
COMMENT ON COLUMN core.corporate_client_detail.legal_address IS 'Юридический адрес (адрес массовой регистрации или адрес из ЕГРЮЛ).';
COMMENT ON COLUMN core.corporate_client_detail.effective_address IS 'Эффективный адрес (заполненный)';
COMMENT ON COLUMN core.corporate_client_detail.ceo_full_name IS 'ФИО единоличного исполнительного органа (Генеральный директор, Президент и т.д.) на момент выгрузки.';
COMMENT ON COLUMN core.corporate_client_detail.ceo_position IS 'Должность руководителя (сырое текстовое значение из CRM).';
COMMENT ON COLUMN core.corporate_client_detail.phone IS 'Основной контактный телефон компании или приемной.';
COMMENT ON COLUMN core.corporate_client_detail.email IS 'Корпоративный или контактный адрес электронной почты.';
COMMENT ON COLUMN core.corporate_client_detail.industry_cd IS 'Код отрасли экономики клиента (например, ОКВЭД или внутренний справочник CRM). Требует маппинга на общекорпоративный справочник в слое DWH.';
COMMENT ON COLUMN core.corporate_client_detail.company_size_cd IS 'Код размера компании из CRM (например: MICRO, SMALL, MEDIUM, LARGE).';
COMMENT ON COLUMN core.corporate_client_detail.registration_date IS 'Дата государственной регистрации юридического лица.';
COMMENT ON COLUMN core.corporate_client_detail.company_age_days IS 'Возраст компании (сколько лет опрошло с даты основания компании)';
COMMENT ON COLUMN core.corporate_client_detail.status_cd IS 'Код статуса клиента в CRM-системе (например: active, inactive, blocked). Без расшифровки, справочник статусов хранится отдельно.';
COMMENT ON COLUMN core.corporate_client_detail.created_ts IS 'Техническое поле: дата и время создания записи. В зависимости от настройки ETL, это либо время создания в CRM, либо время первой загрузки записи в ODS.';





----------------------------------------------------------
-- DDS-слой (medallion: silver). Протягиваем 5 новых ODS-таблиц из ext_ods в детальные
-- таблицы core.*_detail без сложных преобразований (простой перенос колонок).
-- Запускать в БД dds с ролью, имеющей маппинг на FDW-сервер ods_server.

-- ============================================================
-- 1. crm_client_manager -> core.manager_detail
--    Ключи: client_id -> crm_client; branch_cd -> отделение
-- ============================================================
DROP TABLE IF EXISTS core.manager_detail;
CREATE TABLE core.manager_detail AS
SELECT
    manager_id,
    client_id,
    manager_full_name,
    manager_role,
    branch_cd,
    assignment_date,
    source_system,
    load_dttm
FROM ext_ods.crm_client_manager;

COMMENT ON TABLE core.manager_detail IS
    'Детальная информация о закреплении клиентов за банковскими менеджерами. Детальный слой (DDS).';
COMMENT ON COLUMN core.manager_detail.manager_id IS 'Уникальный идентификатор менеджера';
COMMENT ON COLUMN core.manager_detail.client_id IS 'Уникальный идентификатор клиента, закреплённого за менеджером';
COMMENT ON COLUMN core.manager_detail.manager_full_name IS 'Полное ФИО менеджера';
COMMENT ON COLUMN core.manager_detail.manager_role IS 'Роль менеджера (relationship_manager, premium_manager и т.д.)';
COMMENT ON COLUMN core.manager_detail.branch_cd IS 'Код отделения банка';
COMMENT ON COLUMN core.manager_detail.assignment_date IS 'Дата закрепления клиента за менеджером';
COMMENT ON COLUMN core.manager_detail.source_system IS 'Система-источник данных';
COMMENT ON COLUMN core.manager_detail.load_dttm IS 'Дата-время загрузки данных в хранилище';

-- ============================================================
-- 2. abs_account_balance_history -> core.account_balance_detail
--    Ключи: account_id -> abs_account
-- ============================================================
DROP TABLE IF EXISTS core.account_balance_detail;
CREATE TABLE core.account_balance_detail AS
SELECT
    balance_id,
    account_id,
    balance_date,
    balance_amt,
    available_amt,
    currency_cd,
    source_system,
    load_dttm
FROM ext_ods.abs_account_balance_history;

COMMENT ON TABLE core.account_balance_detail IS
    'Детальная информация по истории остатков банковских счетов. Детальный слой (DDS).';
COMMENT ON COLUMN core.account_balance_detail.balance_id IS 'Уникальный идентификатор записи остатка';
COMMENT ON COLUMN core.account_balance_detail.account_id IS 'Уникальный идентификатор счёта, к которому относится остаток';
COMMENT ON COLUMN core.account_balance_detail.balance_date IS 'Дата, на которую зафиксирован остаток';
COMMENT ON COLUMN core.account_balance_detail.balance_amt IS 'Баланс средств на счёте на дату';
COMMENT ON COLUMN core.account_balance_detail.available_amt IS 'Доступная сумма (с учётом заморозок и лимитов)';
COMMENT ON COLUMN core.account_balance_detail.currency_cd IS 'Код валюты в формате ISO 4217';
COMMENT ON COLUMN core.account_balance_detail.source_system IS 'Система-источник данных';
COMMENT ON COLUMN core.account_balance_detail.load_dttm IS 'Дата-время загрузки данных в хранилище';

-- ============================================================
-- 3. abs_card_payment -> core.card_payment_detail
--    Ключи: card_id -> abs_card; account_id -> abs_account
-- ============================================================
DROP TABLE IF EXISTS core.card_payment_detail;
CREATE TABLE core.card_payment_detail AS
SELECT
    payment_id,
    card_id,
    account_id,
    payment_date,
    payment_amt,
    principal_amt,
    interest_amt,
    debt_amt,
    payment_type_cd,
    source_system,
    load_dttm
FROM ext_ods.abs_card_payment;

COMMENT ON TABLE core.card_payment_detail IS
    'Детальная информация по платежам по банковским картам. Детальный слой (DDS).';
COMMENT ON COLUMN core.card_payment_detail.payment_id IS 'Уникальный идентификатор платежа по карте';
COMMENT ON COLUMN core.card_payment_detail.card_id IS 'Уникальный идентификатор карты';
COMMENT ON COLUMN core.card_payment_detail.account_id IS 'Уникальный идентификатор счёта карты';
COMMENT ON COLUMN core.card_payment_detail.payment_date IS 'Дата совершения платежа';
COMMENT ON COLUMN core.card_payment_detail.payment_amt IS 'Сумма платежа';
COMMENT ON COLUMN core.card_payment_detail.principal_amt IS 'Сумма, направленная на погашение основного долга';
COMMENT ON COLUMN core.card_payment_detail.interest_amt IS 'Сумма, направленная на погашение процентов';
COMMENT ON COLUMN core.card_payment_detail.debt_amt IS 'Остаток задолженности после платежа';
COMMENT ON COLUMN core.card_payment_detail.payment_type_cd IS 'Тип платежа (scheduled, early, final и т.д.)';
COMMENT ON COLUMN core.card_payment_detail.source_system IS 'Система-источник данных';
COMMENT ON COLUMN core.card_payment_detail.load_dttm IS 'Дата-время загрузки данных в хранилище';

-- ============================================================
-- 4. crm_client_contact_log -> core.client_contact_detail
--    Ключи: client_id -> crm_client; manager_id -> crm_client_manager
-- ============================================================
DROP TABLE IF EXISTS core.client_contact_detail;
CREATE TABLE core.client_contact_detail AS
SELECT
    contact_id,
    client_id,
    contact_ts,
    contact_type_cd,
    channel_cd,
    subject_txt,
    result_txt,
    manager_id,
    source_system,
    load_dttm
FROM ext_ods.crm_client_contact_log;

COMMENT ON TABLE core.client_contact_detail IS
    'Детальная информация по журналу контактов (обращений) с клиентами. Детальный слой (DDS).';
COMMENT ON COLUMN core.client_contact_detail.contact_id IS 'Уникальный идентификатор контакта';
COMMENT ON COLUMN core.client_contact_detail.client_id IS 'Уникальный идентификатор клиента';
COMMENT ON COLUMN core.client_contact_detail.contact_ts IS 'Дата-время контакта';
COMMENT ON COLUMN core.client_contact_detail.contact_type_cd IS 'Тип контакта (звонок, письмо, визит и т.д.)';
COMMENT ON COLUMN core.client_contact_detail.channel_cd IS 'Канал контакта (phone, email, office, chat и т.д.)';
COMMENT ON COLUMN core.client_contact_detail.subject_txt IS 'Тема/суть обращения';
COMMENT ON COLUMN core.client_contact_detail.result_txt IS 'Результат контакта';
COMMENT ON COLUMN core.client_contact_detail.manager_id IS 'Уникальный идентификатор менеджера, ведущего контакт';
COMMENT ON COLUMN core.client_contact_detail.source_system IS 'Система-источник данных';
COMMENT ON COLUMN core.client_contact_detail.load_dttm IS 'Дата-время загрузки данных в хранилище';

-- ============================================================
-- 5. abs_collateral -> core.collateral_detail
--    Ключи: credit_id -> abs_corp_credit
-- ============================================================
DROP TABLE IF EXISTS core.collateral_detail;
CREATE TABLE core.collateral_detail AS
SELECT
    collateral_id,
    credit_id,
    collateral_type_cd,
    collateral_name_txt,
    collateral_value_amt,
    appraisal_date,
    insured_flg,
    source_system,
    load_dttm
FROM ext_ods.abs_collateral;

COMMENT ON TABLE core.collateral_detail IS
    'Детальная информация по залоговому обеспечению корпоративных кредитов. Детальный слой (DDS).';
COMMENT ON COLUMN core.collateral_detail.collateral_id IS 'Уникальный идентификатор залога';
COMMENT ON COLUMN core.collateral_detail.credit_id IS 'Уникальный идентификатор кредитного договора, к которому относится залог';
COMMENT ON COLUMN core.collateral_detail.collateral_type_cd IS 'Тип залога (real_estate, equipment, vehicle и т.д.)';
COMMENT ON COLUMN core.collateral_detail.collateral_name_txt IS 'Наименование/описание предмета залога';
COMMENT ON COLUMN core.collateral_detail.collateral_value_amt IS 'Оценочная стоимость предмета залога';
COMMENT ON COLUMN core.collateral_detail.appraisal_date IS 'Дата оценки залога';
COMMENT ON COLUMN core.collateral_detail.insured_flg IS 'Признак наличия страховки предмета залога';
COMMENT ON COLUMN core.collateral_detail.source_system IS 'Система-источник данных';
COMMENT ON COLUMN core.collateral_detail.load_dttm IS 'Дата-время загрузки данных в хранилище';

-- ============================================================================
-- Таблица public.sql_inventory и регистрация SQL-трансформаций
-- Используется генератором Data Catalog (sql_loader.py) для построения lineage.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.sql_inventory (
    target_schema text NOT NULL,
    target_table text NOT NULL,
    query_text text,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (target_schema, target_table)
);

DELETE FROM public.sql_inventory;

INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('calc', 'account_card_contract', $$--dds calc таблица с родителями тоже из dds
create table dds.calc.account_card_contract as
select
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    ad.open_date,
    ad.close_date,
    ad.balance_amt,
    ad.account_status,
    ad.contract_id,
    ad.contract_number,
    ad.contract_type,
    ad.contract_start_date,
    ad.contract_end_date,
    ad.interest_rate,
    ad.contract_status,
    ad.client_id,
    ad.client_full_name,
    cd.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.issue_date,
    cd.expiry_date,
    cd.card_status,
    cd.validity_status
from dds.core.account_detail ad
left join dds.core.card_detail cd
    on cd.account_id = ad.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'account_balance_detail', $$
CREATE TABLE core.account_balance_detail AS
SELECT
    balance_id,
    account_id,
    balance_date,
    balance_amt,
    available_amt,
    currency_cd,
    source_system,
    load_dttm
FROM dds.ext_ods.abs_account_balance_history$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'account_card_contract', $$--dds таблица с родителями тоже из dds
create table dds.core.account_card_contract as
select
    ad.account_id,
    ad.account_number,
    ad.account_type,
    ad.currency_cd,
    ad.open_date,
    ad.close_date,
    ad.balance_amt,
    ad.account_status,
    ad.contract_id,
    ad.contract_number,
    ad.contract_type,
    ad.contract_start_date,
    ad.contract_end_date,
    ad.interest_rate,
    ad.contract_status,
    ad.client_id,
    ad.client_full_name,
    cd.card_id,
    cd.masked_card_number,
    cd.card_system,
    cd.issue_date,
    cd.expiry_date,
    cd.card_status,
    cd.validity_status
from dds.core.account_detail ad
left join dds.core.card_detail cd
    on cd.account_id = ad.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'account_detail', $$create table dds.core.account_detail as
select
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,
    cl.client_id,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,
    current_date - a.open_date as account_age_days,
    uuid_generate_v5(uuid_nil(), 0 :: text) as source_system_id, -- ID системы-источника. Ссылка на dds.core.ref_source_system
	true as is_active, -- Признак актуальности
	false as is_deleted, -- Признак удаления записи в системе-источнике
	'1900-01-01 23:59:59.999' :: timestamp as dwh_start_date, -- Дата начала действия записи
	'9999-12-31 23:59:59.999' :: timestamp as dwh_end_date, -- Дата окончания действия записи
	uuid_generate_v5(uuid_nil(), 1 :: text) as etl_process_id -- ID ETL процесса. Ссылка на справочник ref_etl_process
from dds.ext_ods.abs_account a
join dds.ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join dds.ext_ods.crm_client cl
    on cl.client_id = c.client_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'card_detail', $$-- Детализация по картам: маскируем номер карты по правилу 6*4 и вычисляем срок годности
create table dds.core.card_detail as
select
    card_id,
    account_id,
    -- Маскирование: оставляем первые 6 и последние 4 цифры
    left(card_number, 6) || '******' || right(card_number, 4) as masked_card_number,
    card_system,
    issue_date,
    expiry_date,
    card_status,
    -- Бизнес-логика: определяем, не просрочена ли карта
    case 
        when expiry_date < current_date then 'expired'
        when card_status = 'active' then 'valid'
        else 'invalid'
    end as validity_status
from ext_ods.abs_card$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'card_payment_detail', $$
CREATE TABLE core.card_payment_detail AS
SELECT
    payment_id,
    card_id,
    account_id,
    payment_date,
    payment_amt,
    principal_amt,
    interest_amt,
    debt_amt,
    payment_type_cd,
    source_system,
    load_dttm
FROM dds.ext_ods.abs_card_payment$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'client_account_profile', $$-- Профиль: связывает данные DDS с новыми ODS-справочниками
create table dds.core.client_account_profile as
select
    ad.account_id,
    ad.account_number,
    ad.client_id,
    ad.client_full_name,
    ad.client_status,
    doc.doc_series || ' ' || doc.doc_number as active_passport,
    addr.city as client_city,
    addr.address_type
from core.account_detail ad
left join ext_ods.crm_client_document doc 
    on ad.client_id = doc.client_id 
    and doc.doc_type = 'passport' 
    and doc.is_active = true
left join ext_ods.crm_client_address addr 
    on ad.client_id = addr.client_id 
    and addr.is_active = true$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'client_contact_detail', $$
CREATE TABLE core.client_contact_detail AS
SELECT
    contact_id,
    client_id,
    contact_ts,
    contact_type_cd,
    channel_cd,
    subject_txt,
    result_txt,
    manager_id,
    source_system,
    load_dttm
FROM dds.ext_ods.crm_client_contact_log$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'collateral_detail', $$CREATE TABLE core.collateral_detail AS
SELECT
    collateral_id,
    credit_id,
    collateral_type_cd,
    collateral_name_txt,
    collateral_value_amt,
    appraisal_date,
    insured_flg,
    source_system,
    load_dttm
FROM ext_ods.abs_collateral;$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'corporate_client_detail', $$-- ==================== 3. Создание таблиц для юнионов DDS ====================

-- DDS: юридические лица
create table dds.core.corporate_client_detail as
select
    corporate_client_id as client_id,
    inn,
    kpp,
    ogrn,
    company_name,
    coalesce(short_name, company_name) as display_name,
    legal_address,
    coalesce(actual_address, legal_address) as effective_address,
    ceo_full_name,
    ceo_position,
    phone,
    email,
    industry_cd,
    company_size_cd,
    registration_date,
    current_date - registration_date as company_age_days,
    status_cd,
    created_ts
from ext_ods.crm_corporate_client$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'gereg', $$
CREATE TABLE dds.core.gereg AS
SELECT
    client_id,
    client_external_id,
    first_name,
    last_name,
    middle_name,
    birth_date,
    phone,
    email,
    registration_date,
    status_cd,
    source_system,
    load_dttm,
    uuid_generate_v5(uuid_nil(), 1::text) AS source_system_id,
    true AS is_active,
    false AS is_deleted,
    '1900-01-01 23:59:59.999'::timestamp AS dwh_start_date,
    '9999-12-31 23:59:59.999'::timestamp AS dwh_end_date,
    uuid_generate_v5(uuid_nil(), 1::text) AS etl_process_id
FROM dds.ext_ods.crm_client$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'individual_client_detail', $$-- DDS: физические лица
create table dds.core.individual_client_detail as
select
    individual_client_id as client_id,
    last_name,
    first_name,
    middle_name,
    concat_ws(' ', last_name, first_name, middle_name) as full_name,
    birth_date,
    current_date - birth_date as age_days,
    passport_series || ' ' || passport_number as passport_full,
    passport_issue_date,
    passport_issuer,
    snils,
    inn,
    phone,
    email,
    registration_address,
    coalesce(actual_address, registration_address) as effective_address,
    marital_status_cd,
    employment_type_cd,
    monthly_income_amt,
    case
        when monthly_income_amt >= 200000 then 'high'
        when monthly_income_amt >= 100000 then 'medium'
        else 'low'
    end as income_level_cd,
    status_cd,
    created_ts
from ext_ods.crm_individual_client$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'leasing_detail', $$create unlogged table core.leasing_detail as
select
    leasing_id,
    contract_number,
    contract_date,
    lessee_inn,
    lessee_name,
    lessor_inn,
    lessor_name,
    leasing_object_name,
    object_type_cd,
    object_cost_amt,
    advance_payment_amt,
    coalesce(advance_payment_amt, 0) / nullif(object_cost_amt, 0) * 100 as advance_pct,
    leasing_term_months,
    interest_rate,
    monthly_payment_amt,
    total_leasing_cost_amt,
    buyout_cost_amt,
    total_leasing_cost_amt - object_cost_amt as overpayment_amt,
    currency_cd,
    contract_status_cd,
    start_date,
    end_date,
    end_date - start_date as contract_duration_days,
    payment_day,
    collateral_type_cd,
    collateral_value_amt,
    insurance_required_flg,
    insurance_company_name,
    case
        when contract_status_cd = 'closed' then 'completed'
        when end_date < current_date then 'overdue'
        when end_date <= current_date + interval '90 days' then 'expiring_soon'
        else 'normal'
    end as maturity_status,
    created_ts,
    updated_ts
from ext_ods."1C_leasing"$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'manager_detail', $$CREATE TABLE core.manager_detail AS
SELECT
    manager_id,
    client_id,
    manager_full_name,
    manager_role,
    branch_cd,
    assignment_date,
    source_system,
    load_dttm
FROM dds.ext_ods.crm_client_manager$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'master_account_party', $$--таблица из всех сырых таблиц
create table dds.core.master_account_party as
select
    -- Счёт
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,

    -- Договор
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,

    -- Клиент (общий справочник)
    cl.client_id,
    cl.last_name,
    cl.first_name,
    cl.middle_name,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,

    -- Тип клиента
    case
        when cc.corporate_client_id is not null then 'CORPORATE'
        when ic.individual_client_id is not null then 'INDIVIDUAL'
        else 'UNKNOWN'
    end as party_type,

    -- Юридическое лицо
    cc.inn as corp_inn,
    cc.kpp,
    cc.ogrn,
    cc.company_name,
    cc.short_name as company_short_name,
    cc.legal_address,
    cc.actual_address as company_actual_address,
    cc.ceo_full_name,
    cc.ceo_position,
    cc.industry_cd,
    cc.company_size_cd,
    cc.registration_date as company_registration_date,

    -- Физическое лицо
    ic.passport_series,
    ic.passport_number,
    ic.passport_issue_date,
    ic.snils,
    ic.inn as individual_inn,
    ic.marital_status_cd,
    ic.employment_type_cd,
    ic.monthly_income_amt,

    -- Адрес
    addr.city as client_city,
    addr.address_type,

    -- Документ
    doc.doc_series,
    doc.doc_number,
    doc.doc_type,
    doc.issue_date as doc_issue_date,

    -- Карта
    card.card_id,
    left(card.card_number, 6) || '******' || right(card.card_number, 4) as masked_card_number,
    card.card_system,
    card.issue_date as card_issue_date,
    card.expiry_date as card_expiry_date,
    card.card_status,
    case
        when card.expiry_date < current_date then 'expired'
        when card.card_status = 'active' then 'valid'
        else 'invalid'
    end as card_validity_status,

    -- Транзакции (агрегаты из подзапроса)
    tx.total_trx_count,
    tx.last_trx_date,
    tx.total_debit_amt,
    tx.total_credit_amt,

    -- Расчётные поля
    current_date - a.open_date as account_age_days,
    current_date - coalesce(ic.birth_date, cc.registration_date) as party_age_days

from ext_ods.abs_account a
join ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join ext_ods.crm_client cl
    on cl.client_id = c.client_id
left join ext_ods.crm_corporate_client cc
    on cc.corporate_client_id = cl.client_id
left join ext_ods.crm_individual_client ic
    on ic.individual_client_id = cl.client_id
left join ext_ods.crm_client_address addr
    on addr.client_id = cl.client_id
    and addr.is_active = true
left join ext_ods.crm_client_document doc
    on doc.client_id = cl.client_id
    and doc.is_active = true
left join ext_ods.abs_card card
    on card.account_id = a.account_id
left join (
    select
        account_id,
        count(*) as total_trx_count,
        max(transaction_ts::date) as last_trx_date,
        sum(case when transaction_type = 'debit' then amount_amt else 0 end) as total_debit_amt,
        sum(case when transaction_type = 'credit' then amount_amt else 0 end) as total_credit_amt
    from ext_ods.abs_transaction
    group by account_id
) tx
    on tx.account_id = a.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'master_account_party_2', $$--четное кол-во

--таблица из всех сырых таблиц
create table dds.core.master_account_party_2 as
select
    -- Счёт
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,

    -- Договор
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,

    -- Клиент (общий справочник)
    cl.client_id,
    cl.last_name,
    cl.first_name,
    cl.middle_name,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,

    -- Тип клиента
    case
        when cc.corporate_client_id is not null then 'CORPORATE'
        when ic.individual_client_id is not null then 'INDIVIDUAL'
        else 'UNKNOWN'
    end as party_type,

    -- Юридическое лицо
    cc.inn as corp_inn,
    cc.kpp,
    cc.ogrn,
    cc.company_name,
    cc.short_name as company_short_name,
    cc.legal_address,
    cc.actual_address as company_actual_address,
    cc.ceo_full_name,
    cc.ceo_position,
    cc.industry_cd,
    cc.company_size_cd,
    cc.registration_date as company_registration_date,

    -- Физическое лицо
    ic.passport_series,
    ic.passport_number,
    ic.passport_issue_date,
    ic.snils,
    ic.inn as individual_inn,
    ic.marital_status_cd,
    ic.employment_type_cd,
    ic.monthly_income_amt,

    -- Адрес
    addr.city as client_city,
    addr.address_type,

    -- Документ
    doc.doc_series,
    doc.doc_number,
    doc.doc_type,
    doc.issue_date as doc_issue_date,

--     Карта
--    card.card_id,
--    left(card.card_number, 6) || '******' || right(card.card_number, 4) as masked_card_number,
--    card.card_system,
--    card.issue_date as card_issue_date,
--    card.expiry_date as card_expiry_date,
--    card.card_status,
--    case
--        when card.expiry_date < current_date then 'expired'
--        when card.card_status = 'active' then 'valid'
--        else 'invalid'
--    end as card_validity_status,

    -- Транзакции (агрегаты из подзапроса)
    tx.total_trx_count,
    tx.last_trx_date,
    tx.total_debit_amt,
    tx.total_credit_amt,

    -- Расчётные поля
    current_date - a.open_date as account_age_days,
    current_date - coalesce(ic.birth_date, cc.registration_date) as party_age_days

from ext_ods.abs_account a
join ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join ext_ods.crm_client cl
    on cl.client_id = c.client_id
left join ext_ods.crm_corporate_client cc
    on cc.corporate_client_id = cl.client_id
left join ext_ods.crm_individual_client ic
    on ic.individual_client_id = cl.client_id
left join ext_ods.crm_client_address addr
    on addr.client_id = cl.client_id
    and addr.is_active = true
left join ext_ods.crm_client_document doc
    on doc.client_id = cl.client_id
    and doc.is_active = true
--left join ext_ods.abs_card card
--    on card.account_id = a.account_id
left join (
    select
        account_id,
        count(*) as total_trx_count,
        max(transaction_ts::date) as last_trx_date,
        sum(case when transaction_type = 'debit' then amount_amt else 0 end) as total_debit_amt,
        sum(case when transaction_type = 'credit' then amount_amt else 0 end) as total_credit_amt
    from ext_ods.abs_transaction
    group by account_id
) tx
    on tx.account_id = a.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'test33', $$CREATE TABLE dds.core.test33 AS
SELECT
    credit_id
    ,contract_number
    ,contract_date
    ,borrower_inn
    ,borrower_name
    ,borrower_type_cd
    ,product_cd
    ,product_name
    ,credit_purpose_txt
    ,credit_amount_amt
    ,credit_term_months
    ,payment_type_cd
    ,monthly_payment_amt
    ,collateral_type_cd
    ,collateral_value_amt
FROM dds.ext_ods.abs_corp_credit$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'test44', $$CREATE TABLE dds.core.test44 AS
SELECT
    contract_number,
    contract_date,
    borrower_inn
FROM dds.core.test33$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'transaction_detail', $$create table dds.core.transaction_detail as
select
    t.transaction_id,
    t.account_id,
    a.account_number,
    t.transaction_ts,
    t.transaction_ts::date as transaction_date,
    t.transaction_type,
    t.amount_amt,
    case
        when t.transaction_type = 'debit' then -t.amount_amt
        else t.amount_amt
    end as signed_amount_amt,
    t.currency_cd,
    t.merchant_name,
    t.description_txt,
    t.channel_cd,
    t.transaction_status,
    case
        when t.merchant_name is not null then 'merchant_operation'
        when t.description_txt ilike '%перевод%' then 'transfer'
        when t.description_txt ilike '%зарплат%' then 'salary'
        else 'other'
    end as operation_category,
    uuid_generate_v5(uuid_nil(), 0 :: text) as source_system_id, -- ID системы-источника. Ссылка на dds.core.ref_source_system
	uuid_generate_v5(uuid_nil(), 1 :: text) as etl_process_id -- ID ETL процесса. Ссылка на справочник ref_etl_process
from ext_ods.abs_transaction t
join ext_ods.abs_account a
    on a.account_id = t.account_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('core', 'v_test_account_detail', $$create or replace view dds.core.v_test_account_detail as
select
    a.account_id,
    a.account_number,
    a.account_type,
    a.currency_cd,
    a.open_date,
    a.close_date,
    a.balance_amt,
    a.account_status,
    c.contract_id,
    c.contract_number,
    c.contract_type,
    c.start_date as contract_start_date,
    c.end_date as contract_end_date,
    c.interest_rate,
    c.contract_status,
    cl.client_id,
    concat_ws(' ', cl.last_name, cl.first_name, cl.middle_name) as client_full_name,
    cl.birth_date,
    cl.phone,
    cl.email,
    cl.status_cd as client_status,
    current_date - a.open_date as account_age_days
from ext_ods.abs_account a
join ext_ods.abs_contract c
    on c.contract_id = a.contract_id
join ext_ods.crm_client cl
    on cl.client_id = c.client_id$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('public', 'test_for_exception', $$create table dds.public.test_for_exception as
select * from core.card_detail$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('sandbox_1', 'test1', $$create table dds.sandbox_1.test1 as
select * from dds.core.account_detail$$);
INSERT INTO public.sql_inventory (target_schema, target_table, query_text) VALUES ('sandbox_2', 'test2', $$create table dds.sandbox_2.test2 as
select * from dds.core.transaction_detail$$);

