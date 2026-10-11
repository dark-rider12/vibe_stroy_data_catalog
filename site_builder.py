"""
MODULE: site_builder.py
ROLE: Генерация статического HTML сайта из шаблонов и данных с помощью Jinja2.
"""

import os
import base64
import json
from datetime import datetime
from jinja2 import Environment, FileSystemLoader

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")
DOCS_DIR = os.path.join(BASE_DIR, "docs")

# Схемы, которые скрыты в боковом дереве и не должны появляться в поиске.
# Изменяй только здесь — всё остальное автоматически применится.
HIDDEN_SCHEMAS = {"public"}

def generate_html(catalog_data: dict, output_file: str, source_system_map: dict = None):
    print("Подготовка шаблонов и данных для рендеринга...")

    # Настраиваем Jinja2 окружение
    from jinja2 import BaseLoader, TemplateNotFound
    from jinja2.loaders import split_template_path
    
    class UTF8FileSystemLoader(BaseLoader):
        def __init__(self, searchpath):
            self.searchpath = [searchpath] if isinstance(searchpath, str) else searchpath
        
        def get_source(self, environment, template):
            pieces = split_template_path(template)
            for searchpath in self.searchpath:
                path = os.path.join(searchpath, *pieces)
                if os.path.exists(path):
                    with open(path, 'r', encoding='utf-8') as f:
                        contents = f.read()
                    return contents, path, lambda: False
            raise TemplateNotFound(template)
    
    env = Environment(loader=UTF8FileSystemLoader(TEMPLATES_DIR))

    # Фильтр для назначения цвета системным схемам (не ods/dds/dm)
    # Хеш по имени схемы — стабильный, не зависит от порядка появления
    _SYSTEM_PALETTE_SIZE = 8
    def _schema_system_idx(schema_name: str) -> int:
        h = 0
        for ch in schema_name.lower():
            h = (h * 31 + ord(ch)) % _SYSTEM_PALETTE_SIZE
        return h
    env.filters["schema_system_idx"] = _schema_system_idx
    
    # Загружаем Markdown (пока просто как текст, в будущем можно добавить конвертер)
    welcome_path = os.path.join(DOCS_DIR, "home.md")
    welcome_html = ""
    if os.path.exists(welcome_path):
        with open(welcome_path, "r", encoding="utf-8") as f:
            welcome_html = f.read()

    # Подготавливаем JSON данные
    catalog_json_string = json.dumps(catalog_data, ensure_ascii=False)
    hidden_schemas_json_string = json.dumps(list(HIDDEN_SCHEMAS))

    # Рендерим основной шаблон index.html (без встроенного JSON)
    template = env.get_template("index.html")
    now = datetime.now()
    rendered_html = template.render(
        catalog=catalog_data,
        hidden_schemas=HIDDEN_SCHEMAS,
        hidden_schemas_json=hidden_schemas_json_string,
        welcome_html=welcome_html,
        build_time=now.strftime("%d.%m.%Y %H:%M"),
        build_version=now.strftime("%Y%m%d%H%M%S"),
    )

    # Определяем директорию для выходного файла
    output_dir = os.path.dirname(os.path.abspath(output_file))
    
    # Копируем статические файлы (CSS, JS) в директорию с index.html
    import shutil

    # Записываем catalog.js — данные каталога вынесены из HTML для ускорения парсинга
    static_output_dir = os.path.join(output_dir, "static")
    os.makedirs(static_output_dir, exist_ok=True)
    catalog_js_path = os.path.join(static_output_dir, "catalog.js")
    with open(catalog_js_path, "w", encoding="utf-8") as f:
        f.write(f"window.catalogData = {catalog_json_string};\n")
        f.write(f"window.hiddenSchemas = new Set({hidden_schemas_json_string});\n")
        # Справочник систем-источников (system_id) для фичи генерации хэш-ID в Column Lineage
        if source_system_map:
            source_map_json_string = json.dumps(source_system_map, ensure_ascii=False)
            f.write(f"window.catalogData.source_system_map = {source_map_json_string};\n")
    print(f"  catalog.js записан: {os.path.abspath(catalog_js_path)}")
    
    # Копируем CSS
    css_path = os.path.join(STATIC_DIR, "style.css")
    if os.path.exists(css_path):
        static_output_dir = os.path.join(output_dir, "static")
        os.makedirs(static_output_dir, exist_ok=True)
        shutil.copy2(css_path, os.path.join(static_output_dir, "style.css"))
    
    # Копируем JS
    js_path = os.path.join(STATIC_DIR, "main.js")
    if os.path.exists(js_path):
        static_output_dir = os.path.join(output_dir, "static")
        os.makedirs(static_output_dir, exist_ok=True)
        shutil.copy2(js_path, os.path.join(static_output_dir, "main.js"))
    
    # Копируем логотип в static/
    logo_path = os.path.join(BASE_DIR, "logo.png")
    if os.path.exists(logo_path):
        static_output_dir = os.path.join(output_dir, "static")
        os.makedirs(static_output_dir, exist_ok=True)
        shutil.copy2(logo_path, os.path.join(static_output_dir, "logo.png"))

    print("Генерация финального HTML файла...")
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(rendered_html)
    
    print(f"Готово! Каталог сохранен в: {os.path.abspath(output_file)}")