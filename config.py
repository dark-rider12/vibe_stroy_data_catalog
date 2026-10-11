"""
MODULE: config.py
ROLE: Управление конфигурацией приложения.
INPUT: config_catalog_gemini.json
OUTPUT: dict с настройками
DATA STRUCTURE: dict
USED BY: generate_catalog.py, db.py, metadata_loader.py
DEPENDENCIES: os, json
"""

import os
import json

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config_catalog_gemini.json")

def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        raise FileNotFoundError(f"Файл конфигурации не найден: {CONFIG_PATH}")
    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)