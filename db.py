"""
MODULE: db.py
ROLE: Инициализация подключений к базе данных PostgreSQL.
INPUT: dict конфигурации, имя БД
OUTPUT: объект подключения psycopg2
DATA STRUCTURE: psycopg2.connection
USED BY: metadata_loader.py, sql_loader.py
DEPENDENCIES: psycopg2
"""

import psycopg2

def get_connection(config: dict, db_name: str):
    return psycopg2.connect(
        host=config["db_host"],
        port=config["db_port"],
        user=config["db_user"],
        password=config["db_password"],
        dbname=db_name
    )