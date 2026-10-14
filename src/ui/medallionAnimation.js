/* 
MODULE: src/ui/medallionAnimation.js
ROLE: Анимированная схема Медальон-архитектуры (ODS -> DDS -> DM) на главном экране.
Включает зоны слоев, таблицы-карточки и частицы, движущиеся по линиям связей.
*/

// Вспомогательная функция для точного вычисления длины ортогонального пути SVG (M, L, H, V)
function getPathLength(d) {
  const tokens = d.trim().split(/\s+/);
  let curX = 0, curY = 0;
  let total = 0;
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') {
      const x = parseFloat(tokens[i++]);
      const y = parseFloat(tokens[i++]);
      if (cmd === 'L') {
        total += Math.hypot(x - curX, y - curY);
      }
      curX = x; curY = y;
    } else if (cmd === 'H') {
      const x = parseFloat(tokens[i++]);
      total += Math.abs(x - curX);
      curX = x;
    } else if (cmd === 'V') {
      const y = parseFloat(tokens[i++]);
      total += Math.abs(y - curY);
      curY = y;
    }
  }
  return total > 0 ? total : 50;
}

export function initMedallionSchemaAnimation() {
  const container = document.querySelector(".medallion-schema-placeholder");
  if (!container) return;

  if (container.dataset.initialized === "true") return;
  container.dataset.initialized = "true";

  container.innerHTML = "";

  const width = 1120;
  const height = 515;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "medallion-schema-svg");

  // Маркеры и фильтры
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
    <!-- Фильтр свечения частиц -->
    <filter id="medallion-glow-ods" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3.5" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <filter id="medallion-glow-dds" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3.5" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <filter id="medallion-glow-dm" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3.5" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>

    <!-- Стрелка для линий связи -->
    <marker id="med-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="rgba(255, 255, 255, 0.45)" />
    </marker>
  `;
  svg.appendChild(defs);

  // 1. Отрисовка трех зон Medallion (ODS, DDS, DM)
  const zones = [
    {
      id: "zone-ods",
      name: "ods",
      color: "#F97316",
      x: 35,
      y: 38,
      width: 225,
      height: 454
    },
    {
      id: "zone-dds",
      name: "dds",
      color: "#22C55E",
      x: 285,
      y: 38,
      width: 395,
      height: 454
    },
    {
      id: "zone-dm",
      name: "dm",
      color: "#3B82F6",
      x: 705,
      y: 38,
      width: 385,
      height: 454
    }
  ];

  zones.forEach((z) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `med-zone ${z.id}`);

    // Заголовок слоя — ВЫНЕСЕН НАД РАМКОЙ
    const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
    title.setAttribute("x", z.x + z.width / 2);
    title.setAttribute("y", z.y - 12);
    title.setAttribute("text-anchor", "middle");
    title.setAttribute("font-family", "'Inter', -apple-system, sans-serif");
    title.setAttribute("font-size", "22");
    title.setAttribute("font-weight", "800");
    title.setAttribute("letter-spacing", "0.5");
    title.setAttribute("fill", z.color);
    title.textContent = z.name;
    g.appendChild(title);

    // Пунктирный контур
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", z.x);
    rect.setAttribute("y", z.y);
    rect.setAttribute("width", z.width);
    rect.setAttribute("height", z.height);
    rect.setAttribute("rx", "22");
    rect.setAttribute("fill", "rgba(15, 23, 42, 0.4)");
    rect.setAttribute("stroke", z.color);
    rect.setAttribute("stroke-width", "2");
    rect.setAttribute("stroke-dasharray", "6 6");
    rect.setAttribute("opacity", "0.85");
    g.appendChild(rect);

    svg.appendChild(g);
  });

  // 1.1. Рамки прерывистой линией, обозначающие схемы (core и calc)
  const schemaBoxes = [
    // DDS
    {
      id: "schema-dds-core",
      name: "core",
      color: "#22C55E",
      textColor: "#4ADE80",
      x: 290,
      y: 78,
      w: 168,
      h: 388
    },
    {
      id: "schema-dds-calc",
      name: "calc",
      color: "#22C55E",
      textColor: "#4ADE80",
      x: 498,
      y: 78,
      w: 174,
      h: 268
    },
    // DM
    {
      id: "schema-dm-calc",
      name: "calc",
      color: "#3B82F6",
      textColor: "#60A5FA",
      x: 716,
      y: 78,
      w: 170,
      h: 236
    },
    {
      id: "schema-dm-core",
      name: "core",
      color: "#3B82F6",
      textColor: "#60A5FA",
      x: 918,
      y: 78,
      w: 166,
      h: 326
    }
  ];

  schemaBoxes.forEach((sb) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `med-schema-group ${sb.id}`);

    // Заголовок схемы (core / calc) — ВЫНЕСЕН НАД РАМКОЙ
    const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
    title.setAttribute("x", sb.x + sb.w / 2);
    title.setAttribute("y", sb.y - 10);
    title.setAttribute("text-anchor", "middle");
    title.setAttribute("font-family", "'JetBrains Mono', Consolas, monospace");
    title.setAttribute("font-size", "12");
    title.setAttribute("font-weight", "700");
    title.setAttribute("letter-spacing", "0.5");
    title.setAttribute("fill", sb.textColor);
    title.setAttribute("opacity", "0.95");
    title.textContent = sb.name;
    g.appendChild(title);

    // Прерывистый контур рамки схемы
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", sb.x);
    rect.setAttribute("y", sb.y);
    rect.setAttribute("width", sb.w);
    rect.setAttribute("height", sb.h);
    rect.setAttribute("rx", "14");
    rect.setAttribute("fill", "rgba(15, 23, 42, 0.25)");
    rect.setAttribute("stroke", sb.color);
    rect.setAttribute("stroke-width", "1.2");
    rect.setAttribute("stroke-dasharray", "4 4");
    rect.setAttribute("opacity", "0.55");
    g.appendChild(rect);

    svg.appendChild(g);
  });

  // 2. Список таблиц-узлов
  const nodes = [
    // --- ODS ---
    { id: "cust_raw", label: "customers_raw", layer: "ods", x: 60, y: 96, w: 175, h: 32 },
    { id: "tx_raw", label: "transactions_raw", layer: "ods", x: 60, y: 161, w: 175, h: 32 },
    { id: "acc_raw", label: "accounts_raw", layer: "ods", x: 60, y: 261, w: 175, h: 32 },
    { id: "opp_raw", label: "opportunities_raw", layer: "ods", x: 60, y: 341, w: 175, h: 32 },
    { id: "leads_raw", label: "leads_raw", layer: "ods", x: 60, y: 421, w: 175, h: 32 },

    // --- DDS: Cleaned ---
    { id: "cust_clean", label: "customers_cleaned", layer: "dds", x: 306, y: 96, w: 144, h: 32 },
    { id: "tx_clean", label: "transactions_cleaned", layer: "dds", x: 306, y: 161, w: 144, h: 32 },
    { id: "acc_clean", label: "accounts_cleaned", layer: "dds", x: 306, y: 261, w: 144, h: 32 },
    { id: "opp_clean", label: "opportunities_cleaned", layer: "dds", x: 306, y: 341, w: 144, h: 32 },
    { id: "leads_clean", label: "leads_cleaned", layer: "dds", x: 306, y: 421, w: 144, h: 32 },

    // --- DDS: Joined Core ---
    { id: "cust_tx", label: "customer_transactions", layer: "dds", x: 522, y: 128, w: 144, h: 34 },
    { id: "acc_opp", label: "account_opportunities", layer: "dds", x: 522, y: 301, w: 144, h: 34 },

    // --- DM: Marts ---
    { id: "cust_spend", label: "customer_spending", layer: "dm", x: 734, y: 128, w: 146, h: 34 },
    { id: "acc_perf", label: "account_performance", layer: "dm", x: 734, y: 261, w: 146, h: 34 },

    // --- DM: Summary Marts ---
    { id: "biz_summary", label: "business_summary", layer: "dm", x: 938, y: 194, w: 142, h: 36 },
    { id: "sales_pipe", label: "sales_pipeline_summary", layer: "dm", x: 938, y: 351, w: 142, h: 36 }
  ];

  // Цвета карточек по слоям
  const layerStyles = {
    ods: {
      fill: "rgba(249, 115, 22, 0.16)",
      stroke: "#F97316",
      text: "#FFEDD5",
      particleClass: "med-particle-ods"
    },
    dds: {
      fill: "rgba(34, 197, 94, 0.16)",
      stroke: "#22C55E",
      text: "#DCFCE7",
      particleClass: "med-particle-dds"
    },
    dm: {
      fill: "rgba(59, 130, 246, 0.20)",
      stroke: "#3B82F6",
      text: "#DBEAFE",
      particleClass: "med-particle-dm"
    }
  };

  // 3. Линии связей и маршруты движения данных
  const connections = [
    // Входные потоки в ODS слева
    { path: "M 5 112 L 60 112", layer: "ods" },
    { path: "M 5 177 L 60 177", layer: "ods" },
    { path: "M 5 297 H 32 V 277 H 60", layer: "ods" },
    { path: "M 32 297 V 357 H 60", layer: "ods" },
    { path: "M 32 297 V 437 H 60", layer: "ods" },

    // ODS -> DDS Cleaned
    { path: "M 235 112 L 306 112", layer: "ods" },
    { path: "M 235 177 L 306 177", layer: "ods" },
    { path: "M 235 277 L 306 277", layer: "ods" },
    { path: "M 235 357 L 306 357", layer: "ods" },
    { path: "M 235 437 L 306 437", layer: "ods" },

    // DDS Cleaned -> DDS Joined Core (проходят в широком коридоре x=478, стрелка на x=514..522, рамка на x=498 — без пересечений!)
    { path: "M 450 112 H 478 V 145 H 522", layer: "dds" },
    { path: "M 450 177 H 478 V 145 H 522", layer: "dds" },
    { path: "M 450 277 H 478 V 318 H 522", layer: "dds" },
    { path: "M 450 357 H 478 V 318 H 522", layer: "dds" },

    // DDS -> DM
    { path: "M 666 145 L 734 145", layer: "dm" },
    { path: "M 666 318 H 700 V 278 H 734", layer: "dm" },
    { path: "M 666 145 H 692 V 360 H 938", layer: "dm" },
    { path: "M 666 318 H 708 V 369 H 938", layer: "dm" },
    { path: "M 450 437 H 692 V 378 H 938", layer: "dm" },

    // DM Marts -> DM Business Summary
    { path: "M 880 145 H 902 V 204 H 938", layer: "dm" },
    { path: "M 880 278 H 902 V 220 H 938", layer: "dm" }
  ];

  // Константа единой минимальной скорости (пикселей в секунду) для всех огоньков
  const SPEED = 20; // 20 px/s — одинаковая и самая плавная/медленная скорость для всех слоев

  // Отрисовка путей и анимированных огоньков
  connections.forEach((conn, connIndex) => {
    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("d", conn.path);
    pathEl.setAttribute("class", "med-path");
    pathEl.setAttribute("marker-end", "url(#med-arrow)");
    svg.appendChild(pathEl);

    const length = getPathLength(conn.path);
    const dur = length / SPEED; // dur строго пропорционален длине: одинаковая скорость движения для всех частиц!

    // Для коротких путей (< 120px) — 1 частица, для средних — 2, для длинных (> 260px) — 3 частицы
    const numParticles = length > 260 ? 3 : (length > 120 ? 2 : 1);
    const particleColor = layerStyles[conn.layer].particleClass;

    // Мягкий каскадный сдвиг старта между путями
    const phaseOffset = (connIndex * 0.3) % dur;

    for (let i = 0; i < numParticles; i++) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", "4.0");
      circle.setAttribute("class", `med-particle ${particleColor}`);

      const particleOffset = i * (dur / numParticles);
      const beginTime = Number((phaseOffset + particleOffset).toFixed(2));
      const actualBegin = beginTime <= 0.05 ? 0.05 : beginTime;

      circle.setAttribute("visibility", "hidden");
      const setVis = document.createElementNS("http://www.w3.org/2000/svg", "set");
      setVis.setAttribute("attributeName", "visibility");
      setVis.setAttribute("to", "visible");
      setVis.setAttribute("begin", `${actualBegin}s`);
      setVis.setAttribute("fill", "freeze");
      circle.appendChild(setVis);

      // Движение по пути с одинаковой скоростью SPEED (20 px/s)
      const anim = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
      anim.setAttribute("path", conn.path);
      anim.setAttribute("dur", `${dur.toFixed(2)}s`);
      anim.setAttribute("repeatCount", "indefinite");
      anim.setAttribute("begin", `${actualBegin}s`);

      circle.appendChild(anim);
      svg.appendChild(circle);
    }
  });

  // Отрисовка карточек таблиц
  nodes.forEach((node) => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `med-node med-node-${node.layer}`);

    const style = layerStyles[node.layer];

    // Прямоугольник карточки
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", node.x);
    rect.setAttribute("y", node.y);
    rect.setAttribute("width", node.w);
    rect.setAttribute("height", node.h);
    rect.setAttribute("rx", "6");
    rect.setAttribute("fill", style.fill);
    rect.setAttribute("stroke", style.stroke);
    rect.setAttribute("stroke-width", "1.5");
    g.appendChild(rect);

    // Текст названия таблицы
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", node.x + node.w / 2);
    text.setAttribute("y", node.y + node.h / 2 + 4.5);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("font-family", "'JetBrains Mono', Consolas, monospace");
    text.setAttribute("font-size", node.label.length >= 20 ? "10.5" : "11.5");
    text.setAttribute("font-weight", "600");
    text.setAttribute("fill", style.text);
    text.textContent = node.label;
    g.appendChild(text);

    svg.appendChild(g);
  });

  container.appendChild(svg);
}
