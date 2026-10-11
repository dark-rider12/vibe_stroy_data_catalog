-- ============================================================================
-- 01_init_ods.sql
-- Слой: ODS (Operational Data Store)
-- База данных: ods
-- Схема: core
-- Описание:
--   1. Создание схемы core.
--   2. Создание всех 17 таблиц ODS (сырые данные CRM, ABS, 1C).
--   3. Заполнение тестовыми данными (INSERT INTO core.*).
--   4. Добавление бизнес-комментариев к таблицам и колонкам.
-- ============================================================================

-- Подключение к БД ods (раскомментируйте при выполнении через psql):
-- \c ods

CREATE SCHEMA IF NOT EXISTS core;

-- [CRM] Источник клиентских данных
create table core.crm_client (
    client_id bigint primary key,
    client_external_id text,
    first_name text not null,
    last_name text not null,
    middle_name text,
    birth_date date,
    phone text,
    email text,
    registration_date date,
    status_cd text,
    source_system text,
    load_dttm timestamp default now()
);

create table core.crm_client_address (
    address_id bigint primary key,
    client_id bigint not null,
    address_type text not null,
    country text not null,
    city text not null,
    street text,
    building text,
    is_active boolean default true,
    source_system text,
    load_dttm timestamp default now()
);

create table core.crm_client_document (
    document_id bigint primary key,
    client_id bigint not null,
    doc_type text not null,
    doc_series text,
    doc_number text not null,
    issue_date date,
    issuer_name text,
    is_active boolean default true,
    source_system text,
    load_dttm timestamp default now()
);

-- [ABS] Источник банковских/финансовых данных
create table core.abs_contract (
    contract_id bigint primary key,
    client_id bigint not null,
    contract_number text not null,
    contract_type text not null,
    start_date date not null,
    end_date date,
    interest_rate numeric(5,2),
    contract_status text,
    source_system text,
    load_dttm timestamp default now()
);

create table core.abs_account (
    account_id bigint primary key,
    contract_id bigint not null,
    account_number text not null,
    account_type text not null,
    currency_cd text not null,
    open_date date not null,
    close_date date,
    balance_amt numeric(18,2),
    account_status text,
    source_system text,
    load_dttm timestamp default now()
);

create table core.abs_transaction (
    transaction_id bigint primary key,
    account_id bigint not null,
    transaction_ts timestamp not null,
    transaction_type text not null,
    amount_amt numeric(18,2) not null,
    currency_cd text not null,
    merchant_name text,
    description_txt text,
    channel_cd text,
    transaction_status text,
    source_system text,
    load_dttm timestamp default now()
);


------------------------------------------------------------
-- 2. СЛОЙ ODS (Наполнение данными)
------------------------------------------------------------

insert into core.crm_client values
(1, 'cli_001', 'Иван',  'Петров',    'Сергеевич', '1985-04-12', '+79990000001', 'petrov@example.com',    '2024-01-10', 'active', 'crm'),
(2, 'cli_002', 'Анна',  'Сидорова',  'Игоревна',  '1990-08-21', '+79990000002', 'sidorova@example.com',  '2024-02-15', 'active', 'crm'),
(3, 'cli_003', 'Олег',  'Смирнов',   'Викторович','1978-12-03', '+79990000003', 'smirnov@example.com',   '2024-03-01', 'active', 'crm'),
(4, 'cli_004', 'Мария', 'Кузнецова', 'Андреевна', '1995-06-17', '+79990000004', 'kuznetsova@example.com', '2024-03-20', 'active', 'crm');

insert into core.crm_client_address values
(201, 1, 'registration', 'Россия', 'Москва', 'ул. Тверская', 'д. 15', true, 'crm'),
(202, 2, 'registration', 'Россия', 'Санкт-Петербург', 'Невский пр-т', 'д. 45', true, 'crm'),
(203, 3, 'residential',  'Россия', 'Казань', 'ул. Баумана', 'д. 10', true, 'crm'),
(204, 4, 'registration', 'Россия', 'Новосибирск', 'Красный пр-т', 'д. 100', true, 'crm');

insert into core.crm_client_document values
(301, 1, 'passport', '4510', '123456', '2005-05-15', 'ГУ МВД по г. Москве', true, 'crm'),
(302, 2, 'passport', '4011', '654321', '2010-09-20', 'ГУ МВД по г. Санкт-Петербургу', true, 'crm'),
(303, 3, 'passport', '9214', '112233', '1998-12-10', 'МВД по Республике Татарстан', true, 'crm'),
(304, 4, 'passport', '5015', '998877', '2015-07-22', 'ГУ МВД по Новосибирской обл.', true, 'crm');

insert into core.abs_contract values
(101, 1, 'ctr_1001', 'settlement', '2024-01-10', null, 0.00, 'active', 'core_bank'),
(102, 2, 'ctr_1002', 'deposit',    '2024-02-15', '2025-02-15', 9.50, 'active', 'core_bank'),
(103, 3, 'ctr_1003', 'card',       '2024-03-01', null, 0.00, 'active', 'core_bank'),
(104, 4, 'ctr_1004', 'settlement', '2024-03-20', null, 0.00, 'active', 'core_bank');

insert into core.abs_account values
(10001, 101, '40817810000000000001', 'current', 'RUB', '2024-01-10', null, 125000.50, 'active', 'core_bank'),
(10002, 102, '42301810400000000002', 'deposit', 'RUB', '2024-02-15', null, 300000.00, 'active', 'core_bank'),
(10003, 103, '40817810000000000003', 'card',    'RUB', '2024-03-01', null, 15000.75,  'active', 'card_system'),
(10004, 104, '40702810900000000004', 'current', 'USD', '2024-03-20', null, 8200.00,   'active', 'core_bank');

insert into core.abs_transaction values
(500001, 10001, '2024-06-01 10:15:00', 'credit', 50000.00, 'RUB', null,          'Зачисление зарплаты',     'mobile_app', 'posted', 'payments'),
(500002, 10001, '2024-06-02 18:20:00', 'debit',   1250.00, 'RUB', 'perekrestok', 'Покупка продуктов',       'pos',        'posted', 'payments'),
(500003, 10001, '2024-06-03 20:10:00', 'debit',   4500.00, 'RUB', 'ozon',         'Онлайн-покупка',          'online',     'posted', 'payments'),
(500004, 10002, '2024-06-10 08:30:00', 'credit', 15000.00, 'RUB', null,          'Пополнение вклада',       'branch',     'posted', 'deposits'),
(500005, 10003, '2024-06-05 09:00:00', 'debit',   2999.00, 'RUB', 'yandex_plus', null,                      'online',     'posted', 'card_system'),
(500006, 10003, '2024-06-06 12:40:00', 'credit', 10000.00, 'RUB', null,          'Перевод с другого счета', 'mobile_app', 'posted', 'card_system'),
(500007, 10004, '2024-06-11 14:05:00', 'debit',    250.00, 'USD', 'amazon',       'Online purchase',         'online',     'posted', 'payments'),
(500008, 10004, '2024-06-12 16:00:00', 'credit',   500.00, 'USD', null,          'Incoming transfer',       'swift',      'posted', 'payments');

-- [ABS] Данные по выпущенным банковским картам
create table core.abs_card (
    card_id bigint primary key,
    account_id bigint not null,
    card_number varchar not null,
    card_system varchar (255) not null, -- MIR, Visa, Mastercard
    issue_date date not null,
    expiry_date date not null,
    card_status text not null,
    source_system text,
    load_dttm timestamp default now()
);

-- Вставляем тестовые данные (привязываем к счетам 10001 и 10003 из предыдущих данных)
insert into core.abs_card (
    card_id, account_id, card_number, card_system, issue_date, expiry_date, card_status, source_system
) values
(701, 10001, '2200111122223333', 'MIR',        '2024-01-12', '2029-01-31', 'active',  'core_bank'),
(702, 10003, '5400111122224444', 'Mastercard', '2024-03-05', '2028-03-31', 'active',  'core_bank'),
(703, 10003, '4000111122225555', 'Visa',       '2022-05-10', '2023-12-31', 'blocked', 'core_bank');


-- ==================== 1. Создание таблиц для юниона ODS ====================

create table core.crm_corporate_client (
    corporate_client_id serial primary key,
    inn varchar not null,
    kpp varchar,
    ogrn varchar,
    company_name varchar not null,
    short_name varchar,
    legal_address varchar,
    actual_address varchar,
    ceo_full_name varchar,
    ceo_position varchar,
    phone varchar(20),
    email varchar(100),
    industry_cd varchar,
    company_size_cd varchar,
    registration_date date,
    status_cd varchar not null default 'active',
    created_ts timestamp default current_timestamp
);

create table core.crm_individual_client (
    individual_client_id serial primary key,
    last_name varchar(100) not null,
    first_name varchar(100) not null,
    middle_name varchar(100),
    birth_date date,
    passport_series varchar,
    passport_number varchar,
    passport_issue_date date,
    passport_issuer varchar(255),
    snils varchar,
    inn varchar,
    phone varchar(20),
    email varchar(100),
    registration_address varchar,
    actual_address varchar,
    marital_status_cd varchar,
    employment_type_cd varchar,
    monthly_income_amt decimal(18,2),
    status_cd varchar(20) not null default 'active',
    created_ts timestamp default current_timestamp
);




-- ==================== 2. Заполнение тестовыми данными ====================

insert into core.crm_corporate_client 
    (inn, kpp, ogrn, company_name, short_name, legal_address, actual_address, 
     ceo_full_name, ceo_position, phone, email, industry_cd, company_size_cd, 
     registration_date, status_cd)
values
    ('7707083893', '773601001', '1027700132195', 'ООО "ТехноПром"', 'ТехноПром', 
     'г. Москва, ул. Ленина, д. 1', 'г. Москва, ул. Ленина, д. 1',
     'Иванов Сергей Петрович', 'Генеральный директор', '+74951234567', 'info@technoprom.ru',
     'IT', 'MEDIUM', '2015-03-20', 'active'),
    ('7802345678', '780201001', '1037800123456', 'ПАО "СтройИнвест"', 'СтройИнвест',
     'г. Санкт-Петербург, Невский пр., д. 10', 'г. Санкт-Петербург, Невский пр., д. 10',
     'Петрова Анна Владимировна', 'Генеральный директор', '+78122345678', 'office@stroiinvest.ru',
     'CONSTRUCTION', 'LARGE', '2008-07-15', 'active'),
    ('5401234567', '540201001', '1055400123456', 'ООО "СибТорг"', 'СибТорг',
     'г. Новосибирск, Красный пр., д. 50', 'г. Новосибирск, Красный пр., д. 50',
     'Сидоров Дмитрий Алексеевич', 'Директор', '+73831234567', 'trade@sibtrade.ru',
     'TRADE', 'SMALL', '2019-11-08', 'active'),
    ('7701234567', '770201001', '1077700123456', 'АО "ФинГрупп"', 'ФинГрупп',
     'г. Москва, Пресненская наб., д. 12', 'г. Москва, Пресненская наб., д. 12',
     'Козлова Елена Сергеевна', 'Президент', '+74998765432', 'contact@fingroup.ru',
     'FINANCE', 'LARGE', '2012-01-30', 'active');

insert into core.crm_individual_client 
    (last_name, first_name, middle_name, birth_date, passport_series, passport_number,
     passport_issue_date, passport_issuer, snils, inn, phone, email, 
     registration_address, actual_address, marital_status_cd, employment_type_cd,
     monthly_income_amt, status_cd)
values
    ('Смирнов', 'Алексей', 'Иванович', '1985-04-12', '4515', '123456',
     '2005-06-20', 'ОВД р-на Царицыно г. Москвы', '123-456-789 01', '770123456789',
     '+79161234567', 'smirnov.a@mail.ru', 'г. Москва, ул. Борисовские Пруды, д. 14, кв. 55',
     'г. Москва, ул. Борисовские Пруды, д. 14, кв. 55', 'MARRIED', 'EMPLOYED',
     125000.00, 'active'),
    ('Кузнецова', 'Мария', 'Петровна', '1990-09-25', '4520', '654321',
     '2010-08-15', 'ОВД р-на Марьино г. Москвы', '987-654-321 02', null,
     '+79169876543', 'kuznetsova.m@gmail.com', 'г. Москва, ул. Люблинская, д. 80, кв. 12',
     'г. Москва, ул. Люблинская, д. 80, кв. 12', 'SINGLE', 'EMPLOYED',
     95000.00, 'active'),
    ('Волков', 'Дмитрий', 'Сергеевич', '1978-12-03', '4004', '789012',
     '1999-03-10', 'ОВД Ленинского р-на г. Новосибирска', '456-789-012 03', '540456789012',
     '+79134567890', 'volkov.d@yandex.ru', 'г. Новосибирск, ул. Кирова, д. 25, кв. 78',
     'г. Новосибирск, ул. Кирова, д. 25, кв. 78', 'MARRIED', 'SELF_EMPLOYED',
     210000.00, 'active'),
    ('Попова', 'Ольга', 'Андреевна', '1995-07-18', '4515', '345678',
     '2015-11-22', 'ОВД р-на Царицыно г. Москвы', '789-012-345 04', null,
     '+79155678901', 'popova.o@mail.ru', 'г. Москва, ул. Кантемировская, д. 4, кв. 112',
     'г. Москва, ул. Кантемировская, д. 4, кв. 112', 'SINGLE', 'EMPLOYED',
     78000.00, 'active');
, status_cd)
values
    ('Смирнов', 'Алексей', 'Иванович', '1985-04-12', '4515', '123456',
     '2005-06-20', 'ОВД р-на Царицыно г. Москвы', '123-456-789 01', '770123456789',
     '+79161234567', 'smirnov.a@mail.ru', 'г. Москва, ул. Борисовские Пруды, д. 14, кв. 55',
     'г. Москва, ул. Борисовские Пруды, д. 14, кв. 55', 'MARRIED', 'EMPLOYED',
     125000.00, 'active'),
    ('Кузнецова', 'Мария', 'Петровна', '1990-09-25', '4520', '654321',
     '2010-08-15', 'ОВД р-на Марьино г. Москвы', '987-654-321 02', null,
     '+79169876543', 'kuznetsova.m@gmail.com', 'г. Москва, ул. Люблинская, д. 80, кв. 12',
     'г. Москва, ул. Люблинская, д. 80, кв. 12', 'SINGLE', 'EMPLOYED',
     95000.00, 'active'),
    ('Волков', 'Дмитрий', 'Сергеевич', '1978-12-03', '4004', '789012',
     '1999-03-10', 'ОВД Ленинского р-на г. Новосибирска', '456-789-012 03', '540456789012',
     '+79134567890', 'volkov.d@yandex.ru', 'г. Новосибирск, ул. Кирова, д. 25, кв. 78',
     'г. Новосибирск, ул. Кирова, д. 25, кв. 78', 'MARRIED', 'SELF_EMPLOYED',
     210000.00, 'active'),
    ('Попова', 'Ольга', 'Андреевна', '1995-07-18', '4515', '345678',
     '2015-11-22', 'ОВД р-на Царицыно г. Москвы', '789-012-345 04', null,
     '+79155678901', 'popova.o@mail.ru', 'г. Москва, ул. Кантемировская, д. 4, кв. 112',
     'г. Москва, ул. Кантемировская, д. 4, кв. 112', 'SINGLE', 'EMPLOYED',
     78000.00, 'active');




--комментарии
--CRM: Клиентские данные
--Таблица core.crm_client — Справочник клиентов (источник: CRM)

COMMENT ON TABLE core.crm_client IS 'Справочник клиентов из CRM-системы. Содержит базовые идентификационные и контактные данные физических лиц.';

COMMENT ON COLUMN core.crm_client.client_id IS 'Суррогатный первичный ключ. Уникальный идентификатор клиента в DWH.';
COMMENT ON COLUMN core.crm_client.client_external_id IS 'Внешний идентификатор клиента из системы-источника (CRM). Используется для сопоставления при инкрементальной загрузке.';
COMMENT ON COLUMN core.crm_client.first_name IS 'Имя клиента. Обязательное поле.';
COMMENT ON COLUMN core.crm_client.last_name IS 'Фамилия клиента. Обязательное поле.';
COMMENT ON COLUMN core.crm_client.middle_name IS 'Отчество клиента. Опционально, может быть NULL.';
COMMENT ON COLUMN core.crm_client.birth_date IS 'Дата рождения клиента. Используется для возрастной аналитики и верификации.';
COMMENT ON COLUMN core.crm_client.phone IS 'Контактный телефон в международном формате. Может использоваться для аутентификации.';
COMMENT ON COLUMN core.crm_client.email IS 'Адрес электронной почты. Используется для уведомлений и цифровой коммуникации.';
COMMENT ON COLUMN core.crm_client.registration_date IS 'Дата первичной регистрации клиента в банковской системе.';
COMMENT ON COLUMN core.crm_client.status_cd IS 'Код статуса клиента: active, inactive, blocked, closed. Определяет доступность сервисов.';
COMMENT ON COLUMN core.crm_client.source_system IS 'Код системы-источника (напр., "crm"). Для отслеживания происхождения данных.';
COMMENT ON COLUMN core.crm_client.load_dttm IS 'Техническое поле: дата и время загрузки записи в core. Используется для аудита и инкрементальной выгрузки.';



--Таблица core.crm_client_address — Адреса клиентов
COMMENT ON TABLE core.crm_client_address IS 'Адресная книга клиентов. Поддерживает несколько адресов на клиента с типизацией и историчностью.';

COMMENT ON COLUMN core.crm_client_address.address_id IS 'Суррогатный первичный ключ записи адреса.';
COMMENT ON COLUMN core.crm_client_address.client_id IS 'Внешний ключ на core.crm_client(client_id). Связь с клиентом.';
COMMENT ON COLUMN core.crm_client_address.address_type IS 'Тип адреса: registration (по прописке), residential (фактический), mailing (почтовый) и др.';
COMMENT ON COLUMN core.crm_client_address.country IS 'Страна адреса. Заполняется по классификатору стран (ISO/ОКСМ).';
COMMENT ON COLUMN core.crm_client_address.city IS 'Город/населённый пункт. Обязательное поле для адресов РФ.';
COMMENT ON COLUMN core.crm_client_address.street IS 'Наименование улицы/проспекта/переулка. Опционально.';
COMMENT ON COLUMN core.crm_client_address.building IS 'Номер дома, корпуса, строения. Может включать литеры.';
COMMENT ON COLUMN core.crm_client_address.is_active IS 'Флаг актуальности: true — адрес используется в текущий момент, false — архивная запись.';
COMMENT ON COLUMN core.crm_client_address.source_system IS 'Код системы-источника. Для отслеживания происхождения данных.';
COMMENT ON COLUMN core.crm_client_address.load_dttm IS 'Техническое поле: время загрузки записи в core.';


--Таблица core.crm_client_document — Документы клиентов
COMMENT ON TABLE core.crm_client_document IS 'Регистр документов, удостоверяющих личность и иных юридических документов клиентов.';

COMMENT ON COLUMN core.crm_client_document.document_id IS 'Суррогатный первичный ключ записи документа.';
COMMENT ON COLUMN core.crm_client_document.client_id IS 'Внешний ключ на core.crm_client(client_id). Владелец документа.';
COMMENT ON COLUMN core.crm_client_document.doc_type IS 'Тип документа: passport, driver_license, inn, snils, foreign_passport и др.';
COMMENT ON COLUMN core.crm_client_document.doc_series IS 'Серия документа (для паспортов РФ и аналогов). Опционально.';
COMMENT ON COLUMN core.crm_client_document.doc_number IS 'Номер документа. Обязательное поле, используется для верификации.';
COMMENT ON COLUMN core.crm_client_document.issue_date IS 'Дата выдачи документа. Контролируется на валидность (не в будущем).';
COMMENT ON COLUMN core.crm_client_document.issuer_name IS 'Наименование органа, выдавшего документ (напр., "ГУ МВД по г. Москве").';
COMMENT ON COLUMN core.crm_client_document.is_active IS 'Флаг актуальности документа: true — действующий, false — просрочен/аннулирован.';
COMMENT ON COLUMN core.crm_client_document.source_system IS 'Код системы-источника. Для отслеживания происхождения данных.';
COMMENT ON COLUMN core.crm_client_document.load_dttm IS 'Техническое поле: время загрузки записи в core.';


--ABS: Банковские/финансовые данные (источник: Core Banking)
COMMENT ON TABLE core.abs_contract IS 'Реестр договоров между банком и клиентами. Базовый уровень для учёта продуктов: РКО, вклады, карты, кредиты.';

COMMENT ON COLUMN core.abs_contract.contract_id IS 'Суррогатный первичный ключ договора в DWH.';
COMMENT ON COLUMN core.abs_contract.client_id IS 'Внешний ключ на core.crm_client(client_id). Сторона договора — клиент.';
COMMENT ON COLUMN core.abs_contract.contract_number IS 'Уникальный номер договора в учётной системе банка (ABS).';
COMMENT ON COLUMN core.abs_contract.contract_type IS 'Тип договора: settlement (РКО), deposit (вклад), card (карточный), loan (кредитный), other.';
COMMENT ON COLUMN core.abs_contract.start_date IS 'Дата вступления договора в силу. Обязательное поле.';
COMMENT ON COLUMN core.abs_contract.end_date IS 'Дата окончания действия договора. NULL для бессрочных договоров (напр., РКО).';
COMMENT ON COLUMN core.abs_contract.interest_rate IS 'Процентная ставка по договору в годовых (%). 0.00 для беспроцентных продуктов (расчётные счета).';
COMMENT ON COLUMN core.abs_contract.contract_status IS 'Статус договора: active, closed, suspended, terminated. Определяет операционную доступность.';
COMMENT ON COLUMN core.abs_contract.source_system IS 'Код системы-источника (напр., "core_bank"). Для отслеживания происхождения данных.';
COMMENT ON COLUMN core.abs_contract.load_dttm IS 'Техническое поле: время загрузки записи в core.';

--Таблица core.abs_account — Банковские счета
COMMENT ON TABLE core.abs_account IS 'Реестр банковских счетов. Привязан к договорам. Содержит балансовую информацию и атрибуты учёта.';

COMMENT ON COLUMN core.abs_account.account_id IS 'Суррогатный первичный ключ счёта в DWH.';
COMMENT ON COLUMN core.abs_account.contract_id IS 'Внешний ключ на core.abs_contract(contract_id). Договор-основание для открытия счёта.';
COMMENT ON COLUMN core.abs_account.account_number IS 'Номер счёта в формате ЦБ РФ (20 знаков). Уникален в пределах банка.';
COMMENT ON COLUMN core.abs_account.account_type IS 'Тип счёта: current (расчётный/текущий), deposit (депозитный), card (карточный), loan (кредитный) и др.';
COMMENT ON COLUMN core.abs_account.currency_cd IS 'Код валюты счёта по ОКВ/ISO 4217 (RUB, USD, EUR). Определяет валюту учёта и операций.';
COMMENT ON COLUMN core.abs_account.open_date IS 'Дата открытия счёта. Обязательное поле.';
COMMENT ON COLUMN core.abs_account.close_date IS 'Дата закрытия счёта. NULL для активных счетов.';
COMMENT ON COLUMN core.abs_account.balance_amt IS 'Текущий остаток по счёту на момент последней синхронизации. Точность: 2 знака после запятой.';
COMMENT ON COLUMN core.abs_account.account_status IS 'Статус счёта: active, closed, blocked, frozen. Влияет на возможность проведения операций.';
COMMENT ON COLUMN core.abs_account.source_system IS 'Код системы-источника (напр., "core_bank", "card_system"). Для отслеживания происхождения данных.';
COMMENT ON COLUMN core.abs_account.load_dttm IS 'Техническое поле: время загрузки записи в core.';


--Таблица core.abs_transaction — Транзакции по счетам
COMMENT ON TABLE core.abs_transaction IS 'Журнал операций по банковским счетам. Фактовая таблица для аналитики оборотов, расходов, доходов.';

COMMENT ON COLUMN core.abs_transaction.transaction_id IS 'Суррогатный первичный ключ транзакции в DWH.';
COMMENT ON COLUMN core.abs_transaction.account_id IS 'Внешний ключ на core.abs_account(account_id). Счёт, по которому проведена операция.';
COMMENT ON COLUMN core.abs_transaction.transaction_ts IS 'Дата и время проведения транзакции (таймзона источника). Используется для временной аналитики.';
COMMENT ON COLUMN core.abs_transaction.transaction_type IS 'Тип операции: credit (зачисление, приход), debit (списание, расход). Определяет направление движения средств.';
COMMENT ON COLUMN core.abs_transaction.amount_amt IS 'Сумма операции в валюте счёта. Точность: 2 знака после запятой. Всегда положительное значение.';
COMMENT ON COLUMN core.abs_transaction.currency_cd IS 'Код валюты операции. Должен совпадать с валютой счёта или указывать на конверсионную операцию.';
COMMENT ON COLUMN core.abs_transaction.merchant_name IS 'Наименование контрагента/торговой точки (для карточных и эквайринговых операций). Заполняется не всегда.';
COMMENT ON COLUMN core.abs_transaction.description_txt IS 'Текстовое описание/назначение платежа. Используется для категоризации и поиска.';
COMMENT ON COLUMN core.abs_transaction.channel_cd IS 'Канал инициации операции: mobile_app, online, pos, branch, atm, swift, api и др.';
COMMENT ON COLUMN core.abs_transaction.transaction_status IS 'Статус транзакции: posted (проведена), pending (в обработке), rejected (отклонена), reversed (сторнирована).';
COMMENT ON COLUMN core.abs_transaction.source_system IS 'Код системы-источника (напр., "payments", "card_system"). Для отслеживания происхождения данных.';
COMMENT ON COLUMN core.abs_transaction.load_dttm IS 'Техническое поле: время загрузки записи в core.';

--Таблица core.abs_card — Банковские карты
COMMENT ON TABLE core.abs_card IS 'Реестр выпущенных банковских карт. Привязан к счетам. Содержит атрибуты эмиссии и жизненного цикла карты.';

COMMENT ON COLUMN core.abs_card.card_id IS 'Суррогатный первичный ключ карты в DWH.';
COMMENT ON COLUMN core.abs_card.account_id IS 'Внешний ключ на core.abs_account(account_id). Счёт, к которому привязана карта.';
COMMENT ON COLUMN core.abs_card.card_number IS 'Номер карты. В продакшене должен храниться в маскированном или токенизированном виде в соответствии с ПБ КБР/PCI DSS.';
COMMENT ON COLUMN core.abs_card.card_system IS 'Платёжная система: MIR, Visa, Mastercard, UnionPay и др. Определяет эквайринговую инфраструктуру.';
COMMENT ON COLUMN core.abs_card.issue_date IS 'Дата эмиссии/выпуска карты клиенту.';
COMMENT ON COLUMN core.abs_card.expiry_date IS 'Дата окончания срока действия карты (формат ММ/ГГ). После этой даты карта недействительна.';
COMMENT ON COLUMN core.abs_card.card_status IS 'Статус карты: active, blocked, lost, stolen, expired, cancelled. Управляет доступом к операциям.';
COMMENT ON COLUMN core.abs_card.source_system IS 'Код системы-источника (напр., "core_bank", "card_processor"). Для отслеживания происхождения данных.';
COMMENT ON COLUMN core.abs_card.load_dttm IS 'Техническое поле: время загрузки записи в core.';


--
create table core."1C_leasing" (
    leasing_id serial primary key,
    contract_number varchar(50) not null,
    contract_date date not null,
    lessee_inn varchar(12) not null,
    lessee_name varchar(255) not null,
    lessor_inn varchar(12) not null,
    lessor_name varchar(255) not null,
    leasing_object_name varchar(500) not null,
    object_type_cd varchar(20) not null,
    object_cost_amt decimal(18,2) not null,
    advance_payment_amt decimal(18,2),
    leasing_term_months integer not null,
    interest_rate decimal(5,2) not null,
    monthly_payment_amt decimal(18,2) not null,
    total_leasing_cost_amt decimal(18,2) not null,
    buyout_cost_amt decimal(18,2),
    currency_cd varchar(3) default 'RUB',
    contract_status_cd varchar(20) not null default 'active',
    start_date date not null,
    end_date date,
    payment_day integer not null,
    collateral_type_cd varchar(20),
    collateral_value_amt decimal(18,2),
    insurance_required_flg boolean default false,
    insurance_company_name varchar(255),
    created_ts timestamp default current_timestamp,
    updated_ts timestamp default current_timestamp,
    new_column_for_add varchar
);


-- ==================== 2. Заполнение тестовыми данными ====================

insert into core."1C_leasing" 
    (contract_number, contract_date, lessee_inn, lessee_name, lessor_inn, lessor_name,
     leasing_object_name, object_type_cd, object_cost_amt, advance_payment_amt,
     leasing_term_months, interest_rate, monthly_payment_amt, total_leasing_cost_amt,
     buyout_cost_amt, currency_cd, contract_status_cd, start_date, end_date,
     payment_day, collateral_type_cd, collateral_value_amt, insurance_required_flg,
     insurance_company_name)
values
    ('L-2024-0001', '2024-01-15', '7701234567', 'ООО "ПромТех"', '7709876543', 'АО "ЛизингГрупп"',
     'Гусеничный экскаватор CAT 320', 'MACHINERY', 8500000.00, 1700000.00,
     36, 12.50, 225000.00, 9800000.00, 500000.00, 'RUB', 'active', '2024-02-01', '2027-01-31',
     15, 'pledge', 8500000.00, true, 'АО "СОГАЗ"'),

    ('L-2024-0002', '2024-03-10', '7802345678', 'ООО "СтройПлюс"', '7709876543', 'АО "ЛизингГрупп"',
     'Самосвал КАМАЗ 6520', 'VEHICLE', 4500000.00, 900000.00,
     24, 14.00, 175000.00, 5100000.00, 300000.00, 'RUB', 'active', '2024-04-01', '2026-03-31',
     10, 'pledge', 4500000.00, true, 'ПАО "Ингосстрах"'),

    ('L-2024-0003', '2024-05-20', '5401234567', 'ООО "СибЛогистик"', '5409876543', 'ООО "ВостокЛизинг"',
     'Складской комплекс 2000 м2', 'REAL_ESTATE', 45000000.00, 9000000.00,
     60, 10.50, 750000.00, 54000000.00, 5000000.00, 'RUB', 'active', '2024-06-01', '2029-05-31',
     20, 'mortgage', 45000000.00, true, 'АО "РЕСО-Гарантия"'),

    ('L-2024-0004', '2024-02-05', '7703456789', 'ООО "АгроМаш"', '7709876543', 'АО "ЛизингГрупп"',
     'Трактор John Deere 8R', 'MACHINERY', 12000000.00, 2400000.00,
     48, 11.00, 220000.00, 13200000.00, 800000.00, 'RUB', 'active', '2024-03-01', '2028-02-29',
     5, 'pledge', 12000000.00, true, 'АО "СОГАЗ"'),

    ('L-2023-0056', '2023-08-12', '7704567890', 'ООО "ТрансАвто"', '7709876543', 'АО "ЛизингГрупп"',
     'Тягач Volvo FH 460', 'VEHICLE', 6500000.00, 1300000.00,
     30, 13.50, 195000.00, 7200000.00, 400000.00, 'RUB', 'closed', '2023-09-01', '2026-02-28',
     12, 'pledge', 6500000.00, false, null),

    ('L-2024-0005', '2024-06-01', '7805678901', 'ООО "МедТех"', '7709876543', 'АО "ЛизингГрупп"',
     'МРТ-аппарат Philips Ingenia', 'MEDICAL', 28000000.00, 5600000.00,
     48, 9.80, 490000.00, 31000000.00, 2000000.00, 'RUB', 'active', '2024-07-01', '2028-06-30',
     25, 'pledge', 28000000.00, true, 'ПАО "Ингосстрах"'),

    ('L-2024-0006', '2024-04-18', '9901234567', 'ООО "ИТ-Решения"', '7709876543', 'АО "ЛизингГрупп"',
     'Серверное оборудование Dell EMC', 'IT_EQUIPMENT', 3200000.00, 640000.00,
     18, 15.00, 155000.00, 3600000.00, 100000.00, 'RUB', 'active', '2024-05-01', '2025-10-31',
     8, 'guarantee', null, false, null),

    ('L-2024-0007', '2024-07-10', '7706789012', 'ООО "ФудПак"', '5409876543', 'ООО "ВостокЛизинг"',
     'Линия розлива и упаковки', 'PRODUCTION_LINE', 15000000.00, 3000000.00,
     36, 11.50, 350000.00, 16800000.00, 750000.00, 'RUB', 'active', '2024-08-01', '2027-07-31',
     18, 'pledge', 15000000.00, true, 'АО "РЕСО-Гарантия"');

-- ==================== 4. Комментарии к DDS таблице ====================

comment on table core."1C_leasing" is 'Информация по лизинговым договорам из 1С';

comment on column core."1C_leasing".leasing_id is 'Уникальный идентификатор лизингового договора';
comment on column core."1C_leasing".contract_number is 'Номер лизингового договора';
comment on column core."1C_leasing".contract_date is 'Дата подписания договора';
comment on column core."1C_leasing".lessee_inn is 'ИНН лизингополучателя';
comment on column core."1C_leasing".lessee_name is 'Наименование лизингополучателя';
comment on column core."1C_leasing".lessor_inn is 'ИНН лизингодателя';
comment on column core."1C_leasing".lessor_name is 'Наименование лизингодателя';
comment on column core."1C_leasing".leasing_object_name is 'Наименование лизингового объекта';
comment on column core."1C_leasing".object_type_cd is 'Тип объекта лизинга (MACHINERY, VEHICLE, REAL_ESTATE и т.д.)';
comment on column core."1C_leasing".object_cost_amt is 'Стоимость объекта лизинга';
comment on column core."1C_leasing".advance_payment_amt is 'Сумма авансового платежа';
comment on column core."1C_leasing".leasing_term_months is 'Срок лизинга в месяцах';
comment on column core."1C_leasing".interest_rate is 'Процентная ставка по договору (годовых)';
comment on column core."1C_leasing".monthly_payment_amt is 'Ежемесячный лизинговый платёж';
comment on column core."1C_leasing".total_leasing_cost_amt is 'Общая сумма лизинговых платежей';
comment on column core."1C_leasing".buyout_cost_amt is 'Выкупная стоимость объекта';
comment on column core."1C_leasing".currency_cd is 'Код валюты договора';
comment on column core."1C_leasing".contract_status_cd is 'Статус договора (active, closed, suspended)';
comment on column core."1C_leasing".start_date is 'Дата начала действия договора';
comment on column core."1C_leasing".end_date is 'Дата окончания действия договора';
comment on column core."1C_leasing".payment_day is 'День месяца для платежа';
comment on column core."1C_leasing".collateral_type_cd is 'Тип обеспечения (pledge, mortgage, guarantee)';
comment on column core."1C_leasing".collateral_value_amt is 'Стоимость залогового обеспечения';
comment on column core."1C_leasing".insurance_required_flg is 'Признак обязательности страхования';
comment on column core."1C_leasing".insurance_company_name is 'Наименование страховой компании';
comment on column core."1C_leasing".created_ts is 'Дата создания записи в ODS';
comment on column core."1C_leasing".updated_ts is 'Дата последнего обновления записи в ODS';
COMMENT ON COLUMN core."1C_leasing".new_column_for_add IS 'тестовая колонка';



------------------------------------------------------
-- ==================== Создание таблицы ODS ====================

create table core.abs_corp_credit (
    credit_id serial primary key,
    contract_number varchar(50) not null,
    contract_date date not null,
    borrower_inn varchar(12) not null,
    borrower_name varchar(255) not null,
    borrower_type_cd varchar(20) not null,
    product_cd varchar(20) not null,
    product_name varchar(255) not null,
    credit_purpose_txt text,
    credit_amount_amt decimal(18,2) not null,
    credit_term_months integer not null,
    interest_rate decimal(5,2) not null,
    payment_type_cd varchar(20) not null,
    monthly_payment_amt decimal(18,2),
    collateral_type_cd varchar(20),
    collateral_value_amt decimal(18,2),
    guarantor_name varchar(255),
    guarantor_inn varchar(12),
    currency_cd varchar(3) default 'RUB',
    contract_status_cd varchar(20) not null default 'active',
    disbursement_date date,
    first_payment_date date,
    maturity_date date not null,
    outstanding_debt_amt decimal(18,2),
    overdue_debt_amt decimal(18,2) default 0,
    overdue_days integer default 0,
    penalty_rate decimal(5,2),
    grace_period_months integer default 0,
    early_repayment_flg boolean default true,
    refinancing_flg boolean default false,
    source_contract_number varchar(50),
    credit_manager_name varchar(255),
    branch_cd varchar(10),
    created_ts timestamp default current_timestamp,
    updated_ts timestamp default current_timestamp
);


-- ==================== Заполнение тестовыми данными ====================

insert into core.abs_corp_credit 
    (contract_number, contract_date, borrower_inn, borrower_name, borrower_type_cd,
     product_cd, product_name, credit_purpose_txt, credit_amount_amt, credit_term_months,
     interest_rate, payment_type_cd, monthly_payment_amt, collateral_type_cd,
     collateral_value_amt, guarantor_name, guarantor_inn, currency_cd, contract_status_cd,
     disbursement_date, first_payment_date, maturity_date, outstanding_debt_amt,
     overdue_debt_amt, overdue_days, penalty_rate, grace_period_months,
     early_repayment_flg, refinancing_flg, source_contract_number,
     credit_manager_name, branch_cd)
values
    ('CR-2024-0001', '2024-01-10', '7701234567', 'ООО "ПромТех"', 'CORPORATE',
     'OVERDRAFT', 'Кредитная линия с лимитом задолженности', 
     'Пополнение оборотных средств', 15000000.00, 12,
     18.50, 'ANNUITY', 1375000.00, 'pledge',
     20000000.00, 'Петров А.В.', '7709876543', 'RUB', 'active',
     '2024-01-15', '2024-02-15', '2025-01-15', 8750000.00,
     0, 0, 0.10, 0,
     true, false, null,
     'Иванова С.П.', 'MSK001'),

    ('CR-2024-0002', '2024-03-05', '7802345678', 'ООО "СтройПлюс"', 'CORPORATE',
     'INVESTMENT', 'Инвестиционный кредит', 
     'Приобретение строительной техники', 25000000.00, 36,
     15.00, 'DIFFERENTIATED', 850000.00, 'pledge',
     35000000.00, null, null, 'RUB', 'active',
     '2024-03-20', '2024-04-20', '2027-03-20', 19850000.00,
     0, 0, 0.15, 3,
     true, false, null,
     'Смирнов Д.К.', 'SPB001'),

    ('CR-2024-0003', '2024-02-20', '5401234567', 'ООО "СибЛогистик"', 'CORPORATE',
     'REVOLVING', 'Револьверный кредит', 
     'Финансирование закупок', 8000000.00, 24,
     17.00, 'ANNUITY', 395000.00, 'guarantee',
     null, 'АО "СибГарант"', '5409876543', 'RUB', 'active',
     '2024-03-01', '2024-04-01', '2026-02-28', 6200000.00,
     0, 0, 0.12, 0,
     true, false, null,
     'Козлова Е.М.', 'NSK001'),

    ('CR-2024-0004', '2024-05-15', '7703456789', 'ООО "АгроМаш"', 'CORPORATE',
     'SEASONAL', 'Сезонный кредит', 
     'Закупка семян и удобрений', 12000000.00, 9,
     14.50, 'BULLET', null, 'pledge',
     15000000.00, null, null, 'RUB', 'active',
     '2024-05-20', '2024-11-20', '2025-02-20', 12000000.00,
     0, 0, 0.20, 6,
     true, false, null,
     'Волков П.С.', 'MSK002'),

    ('CR-2023-0089', '2023-06-12', '7704567890', 'ООО "ТрансАвто"', 'CORPORATE',
     'AUTO_LEASING', 'Кредит на приобретение автотранспорта', 
     'Покупка грузовых автомобилей', 18000000.00, 48,
     13.00, 'ANNUITY', 480000.00, 'pledge',
     22000000.00, 'Сидоров М.А.', '7708765432', 'RUB', 'active',
     '2023-06-20', '2023-07-20', '2027-06-20', 14250000.00,
     125000.00, 15, 0.15, 0,
     true, false, null,
     'Петрова А.И.', 'MSK001'),

    ('CR-2024-0005', '2024-04-01', '9901234567', 'ООО "ИТ-Решения"', 'CORPORATE',
     'TECH_CREDIT', 'Кредит на развитие ИТ-инфраструктуры', 
     'Закупка программного обеспечения и серверов', 5000000.00, 18,
     16.00, 'ANNUITY', 305000.00, 'guarantee',
     null, 'АО "ТехГарант"', '9908765432', 'RUB', 'active',
     '2024-04-10', '2024-05-10', '2025-10-10', 4100000.00,
     0, 0, 0.10, 0,
     true, false, null,
     'Новикова Т.В.', 'MSK003'),

    ('CR-2024-0006', '2024-07-01', '7706789012', 'ООО "ФудПак"', 'CORPORATE',
     'EQUIPMENT', 'Кредит на приобретение оборудования', 
     'Модернизация производственной линии', 20000000.00, 30,
     12.50, 'DIFFERENTIATED', 780000.00, 'pledge',
     28000000.00, null, null, 'RUB', 'active',
     '2024-07-15', '2024-08-15', '2027-01-15', 18500000.00,
     0, 0, 0.12, 0,
     true, false, null,
     'Морозов К.Л.', 'SPB002'),

    ('CR-2024-0007', '2024-08-10', '7805678901', 'ООО "МедТех"', 'CORPORATE',
     'MEDICAL_EQUIPMENT', 'Кредит на медицинское оборудование', 
     'Приобретение диагностического оборудования', 15000000.00, 36,
     11.00, 'ANNUITY', 490000.00, 'pledge',
     20000000.00, 'АО "МедГарант"', '7807654321', 'RUB', 'active',
     '2024-08-20', '2024-09-20', '2027-08-20', 15000000.00,
     0, 0, 0.10, 0,
     true, false, null,
     'Соколова И.П.', 'SPB001');



-- ==================== Комментарии к таблице ====================

COMMENT ON TABLE core.abs_corp_credit IS 
'Данные по корпоративному кредитованию. Содержит информацию о кредитных договорах с юридическими лицами, загруженную из АБС (Автоматизированной Банковской Системы). Является источником данных по кредитному портфелю, просрочке и залоговому обеспечению.';

-- ==================== Комментарии к колонкам ====================

-- Идентификаторы и ключи
COMMENT ON COLUMN core.abs_corp_credit.credit_id IS 'Суррогатный первичный ключ (ID записи о кредите в DWH). Генерируется автоматически при загрузке в ODS.';
COMMENT ON COLUMN core.abs_corp_credit.contract_number IS 'Бизнес-ключ: Номер кредитного договора в АБС. Уникальный идентификатор договора на стороне источника.';
COMMENT ON COLUMN core.abs_corp_credit.source_contract_number IS 'Номер исходного кредитного договора. Заполняется, если текущий договор является рефинансированием другого кредита.';

-- Информация о заемщике
COMMENT ON COLUMN core.abs_corp_credit.borrower_inn IS 'ИНН заемщика (юридического лица). Используется для связывания с витриной контрагентов.';
COMMENT ON COLUMN core.abs_corp_credit.borrower_name IS 'Полное наименование заемщика (на момент заключения договора или актуальное на дату выгрузки).';
COMMENT ON COLUMN core.abs_corp_credit.borrower_type_cd IS 'Код типа заемщика (справочник). Например: CORPORATE - крупный корпоративный бизнес, SME - малый и средний бизнес.';

-- Информация о продукте и условиях
COMMENT ON COLUMN core.abs_corp_credit.product_cd IS 'Код кредитного продукта (справочник). Например: OVERDRAFT, INVESTMENT, REVOLVING, SEASONAL.';
COMMENT ON COLUMN core.abs_corp_credit.product_name IS 'Наименование кредитного продукта (расшифровка кода product_cd).';
COMMENT ON COLUMN core.abs_corp_credit.credit_purpose_txt IS 'Цель кредитования (текстовое описание, например: "Пополнение оборотных средств").';
COMMENT ON COLUMN core.abs_corp_credit.credit_amount_amt IS 'Сумма кредита (лимит задолженности) на момент выдачи/открытия линии, в валюте договора.';
COMMENT ON COLUMN core.abs_corp_credit.credit_term_months IS 'Срок кредита в месяцах.';
COMMENT ON COLUMN core.abs_corp_credit.interest_rate IS 'Годовая процентная ставка по кредиту, в % (или долях, согласно учетной политике АБС).';
COMMENT ON COLUMN core.abs_corp_credit.payment_type_cd IS 'Тип графика погашения (справочник). ANNUITY - аннуитетный, DIFFERENTIATED - дифференцированный, BULLET - пулевой (единым платежом в конце срока).';
COMMENT ON COLUMN core.abs_corp_credit.monthly_payment_amt IS 'Плановый ежемесячный платеж. Для аннуитета - фиксированная сумма, для дифференцированного - первый/максимальный платеж.';
COMMENT ON COLUMN core.abs_corp_credit.grace_period_months IS 'Количество месяцев льготного периода (кредитных каникул), когда погашение основного долга не требуется.';
COMMENT ON COLUMN core.abs_corp_credit.early_repayment_flg IS 'Флаг возможности досрочного погашения (true - разрешено без штрафов, false - запрещено или со штрафом).';
COMMENT ON COLUMN core.abs_corp_credit.refinancing_flg IS 'Флаг рефинансирования (true - кредит выдан для погашения другого долга в этом или другом банке).';

-- Обеспечение и поручители
COMMENT ON COLUMN core.abs_corp_credit.collateral_type_cd IS 'Тип обеспечения по кредиту (справочник). pledge - залог имущества, guarantee - гарантия, и т.д.';
COMMENT ON COLUMN core.abs_corp_credit.collateral_value_amt IS 'Оценка стоимости обеспечения (залога) на дату выдачи или последней переоценки, в валюте договора.';
COMMENT ON COLUMN core.abs_corp_credit.guarantor_name IS 'Наименование поручителя или гаранта (если обеспечение включает гарантию).';
COMMENT ON COLUMN core.abs_corp_credit.guarantor_inn IS 'ИНН поручителя или гаранта.';

-- Валюта и статусы
COMMENT ON COLUMN core.abs_corp_credit.currency_cd IS 'Валюта кредита (код ISO 4217, например, RUB, USD, CNY). По умолчанию RUB.';
COMMENT ON COLUMN core.abs_corp_credit.contract_status_cd IS 'Статус договора (справочник). active - действующий, closed - закрытый, overdue - просроченный, и т.д.';

-- Даты
COMMENT ON COLUMN core.abs_corp_credit.contract_date IS 'Дата заключения кредитного договора.';
COMMENT ON COLUMN core.abs_corp_credit.disbursement_date IS 'Дата фактической выдачи кредита (или первого транша по кредитной линии).';
COMMENT ON COLUMN core.abs_corp_credit.first_payment_date IS 'Дата первого платежа по графику.';
COMMENT ON COLUMN core.abs_corp_credit.maturity_date IS 'Дата окончания срока кредита (дата финального погашения).';

-- Текущая задолженность и просрочка
COMMENT ON COLUMN core.abs_corp_credit.outstanding_debt_amt IS 'Остаток основного долга на текущую дату (на дату выгрузки из АБС), в валюте договора.';
COMMENT ON COLUMN core.abs_corp_credit.overdue_debt_amt IS 'Сумма просроченной задолженности по основному долгу на текущую дату, в валюте договора.';
COMMENT ON COLUMN core.abs_corp_credit.overdue_days IS 'Количество дней просрочки (DPD - Days Past Due) на текущую дату.';
COMMENT ON COLUMN core.abs_corp_credit.penalty_rate IS 'Ставка пени/неустойки за просрочку платежей (в долях единицы или % годовых/дневных, зависит от настроек АБС).';

-- Служебная информация и менеджмент
COMMENT ON COLUMN core.abs_corp_credit.credit_manager_name IS 'ФИО кредитного менеджера, закрепленного за данным договором.';
COMMENT ON COLUMN core.abs_corp_credit.branch_cd IS 'Код филиала/подразделения банка, оформившего и обслуживающего кредит.';

-- Технические поля ETL
COMMENT ON COLUMN core.abs_corp_credit.created_ts IS 'Техническое поле: Дата и время первой загрузки записи в слой ODS (время работы ETL-процесса).';
COMMENT ON COLUMN core.abs_corp_credit.updated_ts IS 'Техническое поле: Дата и время последнего обновления записи в слое ODS (время работы ETL-процесса).';



-------------------------------------------------------------------------------





create table core.abs_payment_order (
    id serial primary key,
    payment_order_number varchar(50) not null,
    payment_order_date date not null,
    payer_account_id integer not null,
    payer_inn varchar(12) not null,
    payer_name varchar(255) not null,
    beneficiary_account_id integer not null,
    beneficiary_inn varchar(12) not null,
    beneficiary_name varchar(255) not null,
    payment_purpose_txt text,
    amount_amt decimal(18,2) not null,
    currency_cd varchar(3) default 'RUB',
    vat_rate decimal(5,2),
    vat_amount_amt decimal(18,2),
    priority_cd varchar(10) default 'normal',
    payment_type_cd varchar(20) not null,
    execution_date date,
    status_cd varchar(20) not null default 'draft',
    rejection_reason_txt text,
    source_system_cd varchar(20) not null,
    created_ts timestamp default current_timestamp,
    updated_ts timestamp default current_timestamp
);

insert into core.abs_payment_order 
    (payment_order_number, payment_order_date, payer_account_id, payer_inn, payer_name,
     beneficiary_account_id, beneficiary_inn, beneficiary_name, payment_purpose_txt,
     amount_amt, currency_cd, vat_rate, vat_amount_amt, priority_cd, payment_type_cd,
     execution_date, status_cd, source_system_cd)
values
    ('PO-2024-0001', '2024-01-15', 101, '7701234567', 'ООО "ПромТех"',
     205, '7802345678', 'ООО "СтройПлюс"', 'Оплата по договору № Д-2024-001 за строительные материалы',
     2500000.00, 'RUB', 20.00, 416666.67, 'normal', 'supplier_payment',
     '2024-01-16', 'executed', '1C'),

    ('PO-2024-0002', '2024-01-15', 101, '7701234567', 'ООО "ПромТех"',
     312, '5401234567', 'ООО "СибЛогистик"', 'Оплата транспортных услуг за январь 2024',
     450000.00, 'RUB', 20.00, 75000.00, 'normal', 'service_payment',
     '2024-01-16', 'executed', '1C'),

    ('PO-2024-0003', '2024-01-16', 205, '7802345678', 'ООО "СтройПлюс"',
     156, '7703456789', 'ООО "АгроМаш"', 'Аванс по договору на поставку удобрений',
     1200000.00, 'RUB', null, null, 'high', 'advance_payment',
     '2024-01-16', 'executed', '1C'),

    ('PO-2024-0004', '2024-01-17', 312, '5401234567', 'ООО "СибЛогистик"',
     101, '7701234567', 'ООО "ПромТех"', 'Возврат излишне перечисленных средств',
     50000.00, 'RUB', null, null, 'normal', 'refund',
     '2024-01-18', 'executed', '1C'),

    ('PO-2024-0005', '2024-01-18', 156, '7703456789', 'ООО "АгроМаш"',
     205, '7802345678', 'ООО "СтройПлюс"', 'Оплата аренды складского помещения',
     180000.00, 'RUB', 20.00, 30000.00, 'normal', 'rent_payment',
     '2024-01-19', 'pending', '1C'),

    ('PO-2024-0006', '2024-01-19', 101, '7701234567', 'ООО "ПромТех"',
     478, '9901234567', 'ООО "ИТ-Решения"', 'Оплата лицензий на ПО',
     850000.00, 'RUB', 20.00, 141666.67, 'normal', 'software_license',
     '2024-01-22', 'rejected', '1C'),

    ('PO-2024-0007', '2024-01-20', 478, '9901234567', 'ООО "ИТ-Решения"',
     205, '7802345678', 'ООО "СтройПлюс"', 'Оплата по договору на внедрение CRM',
     3200000.00, 'RUB', null, null, 'high', 'service_payment',
     '2024-01-22', 'executed', '1C'),

    ('PO-2024-0008', '2024-01-20', 205, '7802345678', 'ООО "СтройПлюс"',
     589, '7706789012', 'ООО "ФудПак"', 'Оплата за упаковочные материалы',
     675000.00, 'RUB', 20.00, 112500.00, 'normal', 'supplier_payment',
     '2024-01-22', 'pending', '1C'),

    ('PO-2024-0009', '2024-01-21', 589, '7706789012', 'ООО "ФудПак"',
     156, '7703456789', 'ООО "АгроМаш"', 'Оплата за поставку зерна',
     2100000.00, 'RUB', 10.00, 190909.09, 'high', 'supplier_payment',
     '2024-01-22', 'draft', '1C'),

    ('PO-2024-0010', '2024-01-22', 312, '5401234567', 'ООО "СибЛогистик"',
     478, '9901234567', 'ООО "ИТ-Решения"', 'Оплата за облачные сервисы',
     125000.00, 'RUB', 20.00, 20833.33, 'normal', 'service_payment',
     '2024-01-23', 'executed', '1C');



----------------------------------------


-- ==============================================================================
-- Таблица: core.crm_corporate_client
-- ==============================================================================

COMMENT ON TABLE core.crm_corporate_client IS 
'Слой ODS: Сырые данные о корпоративных клиентах (юридических лицах). Загружается 1 к 1 из CRM-системы без бизнес-трансформаций и нормализации. Содержит базовые регистрационные и контактные данные. Первичный ключ ODS, бизнес-ключом является связка (inn, kpp).';

-- Идентификаторы
COMMENT ON COLUMN core.crm_corporate_client.corporate_client_id IS 'Суррогатный первичный ключ записи в слое ODS (или прямой ID из CRM, в зависимости от логики ETL).';
COMMENT ON COLUMN core.crm_corporate_client.inn IS 'Бизнес-ключ: ИНН юридического лица (10 знаков). Основное поле для связывания с другими витринами DWH.';
COMMENT ON COLUMN core.crm_corporate_client.kpp IS 'КПП (Код причины постановки на учет). Может быть NULL для индивидуальных предпринимателей или организаций, не имеющих КПП.';
COMMENT ON COLUMN core.crm_corporate_client.ogrn IS 'ОГРН (Основной государственный регистрационный номер).';

-- Наименования и адреса
COMMENT ON COLUMN core.crm_corporate_client.company_name IS 'Полное фирменное наименование организации (как в ЕГРЮЛ/учредительных документах на момент выгрузки).';
COMMENT ON COLUMN core.crm_corporate_client.short_name IS 'Сокращенное наименование организации (используется в интерфейсах CRM).';
COMMENT ON COLUMN core.crm_corporate_client.legal_address IS 'Юридический адрес (адрес массовой регистрации или адрес из ЕГРЮЛ).';
COMMENT ON COLUMN core.crm_corporate_client.actual_address IS 'Фактический (почтовый) адрес местонахождения компании. Может отличаться от юридического.';

-- Руководство и контакты
COMMENT ON COLUMN core.crm_corporate_client.ceo_full_name IS 'ФИО единоличного исполнительного органа (Генеральный директор, Президент и т.д.) на момент выгрузки.';
COMMENT ON COLUMN core.crm_corporate_client.ceo_position IS 'Должность руководителя (сырое текстовое значение из CRM).';
COMMENT ON COLUMN core.crm_corporate_client.phone IS 'Основной контактный телефон компании или приемной.';
COMMENT ON COLUMN core.crm_corporate_client.email IS 'Корпоративный или контактный адрес электронной почты.';

-- Классификация (сырые коды из CRM)
COMMENT ON COLUMN core.crm_corporate_client.industry_cd IS 'Код отрасли экономики клиента (например, ОКВЭД или внутренний справочник CRM). Требует маппинга на общекорпоративный справочник в слое DWH.';
COMMENT ON COLUMN core.crm_corporate_client.company_size_cd IS 'Код размера компании из CRM (например: MICRO, SMALL, MEDIUM, LARGE).';

-- Даты и статусы
COMMENT ON COLUMN core.crm_corporate_client.registration_date IS 'Дата государственной регистрации юридического лица.';
COMMENT ON COLUMN core.crm_corporate_client.status_cd IS 'Код статуса клиента в CRM-системе (например: active, inactive, blocked). Без расшифровки, справочник статусов хранится отдельно.';

-- Технические поля
COMMENT ON COLUMN core.crm_corporate_client.created_ts IS 'Техническое поле: дата и время создания записи. В зависимости от настройки ETL, это либо время создания в CRM, либо время первой загрузки записи в ODS.';


-- ==============================================================================
-- Таблица: core.crm_individual_client
-- ==============================================================================

COMMENT ON TABLE core.crm_individual_client IS 
'Слой ODS: Сырые данные о физических лицах (розничных клиентах). Загружается 1 к 1 из CRM-системы без бизнес-трансформаций. Содержит персональные, паспортные данные и базовую финансовую информацию, заявленную клиентом.';

-- Идентификаторы
COMMENT ON COLUMN core.crm_individual_client.individual_client_id IS 'Суррогатный первичный ключ записи в слое ODS (или прямой ID клиента из CRM).';
COMMENT ON COLUMN core.crm_individual_client.inn IS 'ИНН физического лица (12 знаков). Является бизнес-ключом для связывания с другими системами.';
COMMENT ON COLUMN core.crm_individual_client.snils IS 'СНИЛС (Страховой номер индивидуального лицевого счета).';

-- Персональные данные
COMMENT ON COLUMN core.crm_individual_client.last_name IS 'Фамилия клиента (как в паспорте).';
COMMENT ON COLUMN core.crm_individual_client.first_name IS 'Имя клиента (как в паспорте).';
COMMENT ON COLUMN core.crm_individual_client.middle_name IS 'Отчество клиента. Может быть NULL, если отсутствует в паспорте.';
COMMENT ON COLUMN core.crm_individual_client.birth_date IS 'Дата рождения клиента.';

-- Паспортные данные
COMMENT ON COLUMN core.crm_individual_client.passport_series IS 'Серия паспорта (сырое строковое значение из CRM).';
COMMENT ON COLUMN core.crm_individual_client.passport_number IS 'Номер паспорта (сырое строковое значение из CRM).';
COMMENT ON COLUMN core.crm_individual_client.passport_issue_date IS 'Дата выдачи паспорта.';
COMMENT ON COLUMN core.crm_individual_client.passport_issuer IS 'Наименование органа, выдавшего паспорт (текстовое поле, может содержать опечатки, так как загружается 1 к 1 из CRM).';

-- Контакты и адреса
COMMENT ON COLUMN core.crm_individual_client.phone IS 'Контактный номер мобильного или домашнего телефона.';
COMMENT ON COLUMN core.crm_individual_client.email IS 'Адрес электронной почты клиента.';
COMMENT ON COLUMN core.crm_individual_client.registration_address IS 'Адрес постоянной регистрации (прописки) согласно паспорту.';
COMMENT ON COLUMN core.crm_individual_client.actual_address IS 'Адрес фактического проживания. Заполняется со слов клиента или по данным доставки.';

-- Социально-демографические и финансовые данные (сырые значения из CRM)
COMMENT ON COLUMN core.crm_individual_client.marital_status_cd IS 'Код семейного положения из справочника CRM (например: MARRIED, SINGLE, DIVORCED).';
COMMENT ON COLUMN core.crm_individual_client.employment_type_cd IS 'Код типа занятости из справочника CRM (например: EMPLOYED, SELF_EMPLOYED, UNEMPLOYED, RETIREE).';
COMMENT ON COLUMN core.crm_individual_client.monthly_income_amt IS 'Заявленный ежемесячный доход клиента в валюте РФ. Важно: это данные, введенные менеджером или клиентом в CRM, они не обязательно прошли скоринговую или документальную верификацию.';

-- Статусы и технические поля
COMMENT ON COLUMN core.crm_individual_client.status_cd IS 'Код статуса клиента в CRM-системе (например: active, inactive, blocked, blacklisted).';
COMMENT ON COLUMN core.crm_individual_client.created_ts IS 'Техническое поле: дата и время создания записи (время создания в CRM или время первой загрузки в ODS).';






-- ==============================================================================
-- Таблица: core.abs_payment_order
-- ==============================================================================

COMMENT ON TABLE core.abs_payment_order IS 
'Слой ODS: Сырые данные о платежных поручениях (исходящих и входящих). Загружается 1 к 1 из АБС (Автоматизированной Банковской Системы) без агрегации и нормализации. Является основным источником для анализа денежных потоков (Cash Flow), контроля исполненных платежей и сверки с клиентскими системами (например, 1С).';

-- Идентификаторы и ключи
COMMENT ON COLUMN core.abs_payment_order.id IS 'Суррогатный первичный ключ записи в слое ODS.';
COMMENT ON COLUMN core.abs_payment_order.payment_order_number IS 'Бизнес-ключ: Номер платежного поручения в АБС. Уникален в разрезе даты и системы-источника.';
COMMENT ON COLUMN core.abs_payment_order.payment_order_date IS 'Дата составления (регистрации) платежного поручения в системе.';

-- Сторона плательщика (дебет)
COMMENT ON COLUMN core.abs_payment_order.payer_account_id IS 'Внутренний идентификатор счета плательщика в АБС. Используется для связывания со справочником банковских счетов (DWH).';
COMMENT ON COLUMN core.abs_payment_order.payer_inn IS 'ИНН плательщика. Продублирован из справочника клиентов для ускорения фильтров без необходимости JOIN, но может содержать сырые данные.';
COMMENT ON COLUMN core.abs_payment_order.payer_name IS 'Наименование плательщика (сырое текстовое значение из АБС на момент создания платежа).';

-- Сторона получателя (кредит)
COMMENT ON COLUMN core.abs_payment_order.beneficiary_account_id IS 'Внутренний идентификатор счета получателя в АБС. Если получатель внешний, может ссылаться на справочник внешних контрагентов или быть NULL/техническим ID.';
COMMENT ON COLUMN core.abs_payment_order.beneficiary_inn IS 'ИНН получателя средств.';
COMMENT ON COLUMN core.abs_payment_order.beneficiary_name IS 'Наименование получателя (сырое текстовое значение из АБС, может содержать опечатки, введенные операционистом или клиентом).';

-- Детали платежа
COMMENT ON COLUMN core.abs_payment_order.payment_purpose_txt IS 'Назначение платежа. Сырое текстовое поле, может содержать специфические форматы, сокращения или служебные коды источника.';
COMMENT ON COLUMN core.abs_payment_order.amount_amt IS 'Сумма платежа в валюте документа.';
COMMENT ON COLUMN core.abs_payment_order.currency_cd IS 'Код валюты платежа (ISO 4217, по умолчанию RUB).';
COMMENT ON COLUMN core.abs_payment_order.vat_rate IS 'Ставка НДС (в процентах), указанная в платежном поручении (например, 20.00, 10.00). NULL, если операция не облагается НДС.';
COMMENT ON COLUMN core.abs_payment_order.vat_amount_amt IS 'Сумма НДС в валюте платежа, выделенная в назначении платежа или реквизитах.';

-- Классификация и исполнение
COMMENT ON COLUMN core.abs_payment_order.priority_cd IS 'Код очередности платежа согласно справочнику АБС (например: ''normal'' - 5-я очередь, ''high'' - вне очереди или 1-я очередь по ГК РФ).';
COMMENT ON COLUMN core.abs_payment_order.payment_type_cd IS 'Код вида/категории платежа из справочника АБС (например: supplier_payment, service_payment, advance_payment, refund).';
COMMENT ON COLUMN core.abs_payment_order.execution_date IS 'Дата фактического или планового списания/зачисления средств (зависит от бизнес-логики АБС и статуса платежа).';
COMMENT ON COLUMN core.abs_payment_order.status_cd IS 'Код статуса платежного поручения (справочник АБС: draft - черновик, pending - на исполнении, executed - исполнен, rejected - отклонен).';
COMMENT ON COLUMN core.abs_payment_order.rejection_reason_txt IS 'Причина отклонения платежа банком или системой (заполняется только при status_cd = ''rejected''). Сырой текст из АБС.';

-- Технические поля и источник
COMMENT ON COLUMN core.abs_payment_order.source_system_cd IS 'Код системы-источника, инициировавшей создание платежного поручения (например: ''1C'', ''Client-Bank'', ''ABS'', ''Mobile''). Критически важно для анализа каналов поступления и ответственности за ошибки.';
COMMENT ON COLUMN core.abs_payment_order.created_ts IS 'Техническое поле: дата и время первой загрузки записи в слой ODS (время работы ETL-процесса).';
COMMENT ON COLUMN core.abs_payment_order.updated_ts IS 'Техническое поле: дата и время последнего обновления записи в слое ODS (например, при смене статуса с ''pending'' на ''executed'').';






------------------------
--OPENCODE
------------------------
-- Создание 5 новых банковских таблиц в слое ODS + заполнение тестовыми данными.
-- Слой ods: сырые данные из АБС/CRM/1С. Таблицы стыкуются с существующими по ключам.

-- ============================================================
-- 1. crm_client_manager — закрепление клиентов за менеджерами
--    JOIN: client_id -> crm_client(client_id); branch_cd -> abs_corp_credit(branch_cd)
-- ============================================================
DROP TABLE IF EXISTS core.crm_client_manager;
CREATE TABLE core.crm_client_manager (
    manager_id         bigint       NOT NULL,
    client_id          bigint       NOT NULL,
    manager_full_name  text         NOT NULL,
    manager_role       text         NOT NULL,
    branch_cd          text         NOT NULL,
    assignment_date    date         NOT NULL,
    source_system      text         NOT NULL DEFAULT 'crm',
    load_dttm          timestamp    NOT NULL DEFAULT now(),
    PRIMARY KEY (manager_id, client_id)
);

INSERT INTO core.crm_client_manager (manager_id, client_id, manager_full_name, manager_role, branch_cd, assignment_date) VALUES
    (901, 1, 'Иванова Ольга Петровна',   'relationship_manager', 'MSK001', '2024-01-15'),
    (901, 2, 'Иванова Ольга Петровна',   'relationship_manager', 'MSK001', '2024-02-20'),
    (902, 3, 'Соколов Дмитрий Андреевич','relationship_manager', 'SPB001', '2024-03-05'),
    (902, 4, 'Соколов Дмитрий Андреевич','relationship_manager', 'SPB001', '2024-04-10'),
    (903, 1, 'Козлова Мария Сергеевна',  'premium_manager',      'MSK002', '2024-06-01');

-- ============================================================
-- 2. abs_account_balance_history — история остатков по счетам
--    JOIN: account_id -> abs_account(account_id)
-- ============================================================
DROP TABLE IF EXISTS core.abs_account_balance_history;
CREATE TABLE core.abs_account_balance_history (
    balance_id     bigint    NOT NULL,
    account_id     bigint    NOT NULL,
    balance_date   date      NOT NULL,
    balance_amt    numeric(18,2) NOT NULL,
    available_amt  numeric(18,2) NOT NULL,
    currency_cd    text      NOT NULL,
    source_system  text      NOT NULL DEFAULT 'core_bank',
    load_dttm      timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (balance_id)
);

INSERT INTO core.abs_account_balance_history (balance_id, account_id, balance_date, balance_amt, available_amt, currency_cd) VALUES
    (1, 10001, '2024-06-30', 125000.50, 125000.50, 'RUB'),
    (2, 10001, '2024-07-31', 110000.00, 107500.00, 'RUB'),
    (3, 10002, '2024-06-30', 300000.00, 300000.00, 'RUB'),
    (4, 10004, '2024-07-31', 25000.75,  25000.75,  'RUB'),
    (5, 10003, '2024-07-31', 15000.75,  12000.00,  'RUB');

-- ============================================================
-- 3. abs_card_payment — платежи по картам (погашение, задолженность)
--    JOIN: card_id -> abs_card(card_id); account_id -> abs_account(account_id)
-- ============================================================
DROP TABLE IF EXISTS core.abs_card_payment;
CREATE TABLE core.abs_card_payment (
    payment_id        bigint NOT NULL,
    card_id           bigint NOT NULL,
    account_id        bigint NOT NULL,
    payment_date      date   NOT NULL,
    payment_amt       numeric(18,2) NOT NULL,
    principal_amt     numeric(18,2) NOT NULL,
    interest_amt      numeric(18,2) NOT NULL,
    debt_amt          numeric(18,2) NOT NULL,
    payment_type_cd   text   NOT NULL,
    source_system     text   NOT NULL DEFAULT 'card_system',
    load_dttm         timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (payment_id)
);

INSERT INTO core.abs_card_payment (payment_id, card_id, account_id, payment_date, payment_amt, principal_amt, interest_amt, debt_amt, payment_type_cd) VALUES
    (6001, 701, 10001, '2024-06-01', 5000.00,  3000.00,  2000.00,  25000.00,  'scheduled'),
    (6002, 701, 10001, '2024-07-01', 5000.00,  3000.00,  2000.00,  20000.00,  'scheduled'),
    (6003, 702, 10003, '2024-06-10', 10000.00, 8000.00,  2000.00,  40000.00,  'early'),
    (6004, 702, 10003, '2024-07-10', 10000.00, 8000.00,  2000.00,  32000.00,  'scheduled'),
    (6005, 703, 10003, '2024-07-15', 3000.00,  2000.00,  1000.00,  0.00,      'final');

-- ============================================================
-- 4. crm_client_contact_log — журнал обращений/контактов с клиентами
--    JOIN: client_id -> crm_client(client_id); manager_id -> crm_client_manager(manager_id)
-- ============================================================
DROP TABLE IF EXISTS core.crm_client_contact_log;
CREATE TABLE core.crm_client_contact_log (
    contact_id      bigint      NOT NULL,
    client_id       bigint      NOT NULL,
    contact_ts      timestamp   NOT NULL,
    contact_type_cd text        NOT NULL,
    channel_cd      text        NOT NULL,
    subject_txt     text        NOT NULL,
    result_txt      text,
    manager_id      bigint      NOT NULL,
    source_system   text        NOT NULL DEFAULT 'crm',
    load_dttm       timestamp   NOT NULL DEFAULT now(),
    PRIMARY KEY (contact_id)
);

INSERT INTO core.crm_client_contact_log (contact_id, client_id, contact_ts, contact_type_cd, channel_cd, subject_txt, result_txt, manager_id) VALUES
    (8001, 1, '2024-06-10 11:30:00', 'incoming_call', 'phone', 'Запрос по депозитной ставке', 'Проконсультирован', 901),
    (8002, 2, '2024-06-12 15:00:00', 'outgoing_call', 'phone', 'Предложение кредитной карты', 'Согласована встреча', 901),
    (8003, 3, '2024-06-15 09:20:00', 'email',          'email', 'Уведомление о льготном периоде','Отправлено', 902),
    (8004, 4, '2024-06-18 14:45:00', 'branch_visit',   'office','Открытие расчетного счета',   'Договор подписан', 902),
    (8005, 1, '2024-07-02 10:00:00', 'messenger',      'chat',  'Смена номера телефона',       'Данные обновлены', 903);

-- ============================================================
-- 5. abs_collateral — залоговое обеспечение по корпоративным кредитам
--    JOIN: credit_id -> abs_corp_credit(credit_id); branch_cd -> abs_corp_credit(branch_cd)
-- ============================================================
DROP TABLE IF EXISTS core.abs_collateral;
CREATE TABLE core.abs_collateral (
    collateral_id        bigint NOT NULL,
    credit_id            bigint NOT NULL,
    collateral_type_cd   text   NOT NULL,
    collateral_name_txt  text   NOT NULL,
    collateral_value_amt numeric(18,2) NOT NULL,
    appraisal_date       date   NOT NULL,
    insured_flg          boolean NOT NULL DEFAULT false,
    source_system        text   NOT NULL DEFAULT 'core_bank',
    load_dttm            timestamp NOT NULL DEFAULT now(),
    PRIMARY KEY (collateral_id)
);

INSERT INTO core.abs_collateral (collateral_id, credit_id, collateral_type_cd, collateral_name_txt, collateral_value_amt, appraisal_date, insured_flg) VALUES
    (7001, 1, 'real_estate', 'Офисное здание, Москва',         5000000.00, '2024-01-20', true),
    (7002, 2, 'equipment',   'Промышленное оборудование',      3000000.00, '2024-02-15', false),
    (7003, 3, 'vehicle',     'Грузовой автопарк (10 ед.)',     2500000.00, '2024-03-10', true),
    (7004, 4, 'real_estate', 'Производственный цех, МО',       8000000.00, '2024-04-05', true),
    (7005, 5, 'equipment',   'Лизинговая техника под залог',   1500000.00, '2023-12-01', false);
