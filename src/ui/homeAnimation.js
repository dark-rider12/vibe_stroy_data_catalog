/* 
MODULE: src/ui/homeAnimation.js
ROLE: Анимация схемы на главном экране (Welcome Screen).
*/

export function initHomeSchemaAnimation() {
  // Ищем контейнер по классу, так как в HTML используется class="schema-placeholder"
  const container = document.querySelector(".schema-placeholder");
  if (!container) return;

  // предотвратить повторную инициализацию, так как это CSS-анимация и DOM
  if (container.dataset.initialized === "true") return;
  container.dataset.initialized = "true";

  container.innerHTML = "";

  const width = 800;
  const height = 400;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "home-schema-svg");

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = `
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feComposite in="SourceGraphic" in2="blur" operator="over" />
      </filter>
  `;
  svg.appendChild(defs);

  const nodes = [
      {
          id: "s1",
          type: "source",
          x: 150,
          y: 80,
          label: "ЦФТ-Банк",
          sub: "Core Banking",
      },
      { id: "s2", type: "source", x: 150, y: 200, label: "1С", sub: "" },
      { id: "s3", type: "source", x: 150, y: 320, label: "Excel файлы", sub: "" },
      {
          id: "dwh",
          type: "dwh",
          x: 400,
          y: 200,
          label: "Data Warehouse",
          sub: "",
      },
      { id: "c1", type: "consumer", x: 650, y: 80, label: "Regulator", sub: "" },
      {
          id: "c2",
          type: "consumer",
          x: 650,
          y: 200,
          label: "HQ Reporting",
          sub: "",
      },
      {
          id: "c3",
          type: "consumer",
          x: 650,
          y: 320,
          label: "Сотрудники",
          sub: "",
      },
  ];

  const connections = [
      { from: "s1", to: "dwh", path: `M 150 80 C 250 80, 300 200, 400 200` },
      { from: "s2", to: "dwh", path: `M 150 200 L 400 200` },
      { from: "s3", to: "dwh", path: `M 150 320 C 250 320, 300 200, 400 200` },
      { from: "dwh", to: "c1", path: `M 400 200 C 500 200, 550 80, 650 80` },
      { from: "dwh", to: "c2", path: `M 400 200 L 650 200` },
      { from: "dwh", to: "c3", path: `M 400 200 C 500 200, 550 320, 650 320` },
  ];

  connections.forEach((conn) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", conn.path);
      path.setAttribute("class", "schema-path");
      svg.appendChild(path);

      for (let i = 0; i < 2; i++) {
          const particle = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "circle",
          );
          particle.setAttribute("r", "4.5");
          const pClass = conn.from.startsWith("s")
              ? "particle-source"
              : "particle-consumer";
          particle.setAttribute("class", `data-particle ${pClass}`);

          const beginTime = i * 1.5;

          const actualBegin = beginTime === 0 ? 0.1 : beginTime;

          particle.setAttribute("visibility", "hidden");
          const setVis = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "set",
          );
          setVis.setAttribute("attributeName", "visibility");
          setVis.setAttribute("to", "visible");
          setVis.setAttribute("begin", actualBegin + "s");
          setVis.setAttribute("fill", "freeze");
          particle.appendChild(setVis);

          const anim = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "animateMotion",
          );
          anim.setAttribute("path", conn.path);
          anim.setAttribute("dur", 3 + Math.random() * 2 + "s");
          anim.setAttribute("repeatCount", "indefinite");
          anim.setAttribute("begin", actualBegin + "s");

          particle.appendChild(anim);
          svg.appendChild(particle);
      }
  });

  nodes.forEach((node) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", `schema-node node-${node.type}`);

      // Skip circular outline for nodes with custom complex icons
      if (
          node.id !== "s1" &&
          node.id !== "c2" &&
          node.id !== "c1" &&
          node.id !== "s2" &&
          node.id !== "s3"
      ) {
          const circle = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "circle",
          );
          circle.setAttribute("cx", node.x);
          circle.setAttribute("cy", node.y);
          circle.setAttribute("r", node.type === "dwh" ? "35" : "25");
          g.appendChild(circle);
      }

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", node.x);
      text.setAttribute("y", node.y + (node.type === "dwh" ? 55 : 45));
      text.textContent = node.label;
      g.appendChild(text);

      if (node.sub) {
          const sub = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "text",
          );
          sub.setAttribute("x", node.x);
          sub.setAttribute("y", node.y + (node.type === "dwh" ? 72 : 60));
          sub.setAttribute("class", "node-label");
          sub.textContent = node.sub;
          g.appendChild(sub);
      }

      if (node.id === "s1") {
          const cft = document.createElementNS("http://www.w3.org/2000/svg", "g");
          cft.innerHTML = `
              <rect x="${node.x - 22}" y="${node.y - 12}" width="44" height="24" fill="#E31E24" rx="2"/>
              <text x="${node.x}" y="${node.y + 6}" fill="white" font-family="Arial, sans-serif" font-weight="900" font-size="14" text-anchor="middle" style="pointer-events:none;">ЦФТ</text>
          `;
          g.appendChild(cft);
      }

      if (node.id === "s2") {
          const onec = document.createElementNS("http://www.w3.org/2000/svg", "g");
          onec.innerHTML = `
              <rect x="${node.x - 22}" y="${node.y - 12}" width="44" height="24" fill="#FFFF00" rx="2"/>
              <g transform="translate(${node.x - 18}, ${node.y - 8}) scale(0.7)">
                  <!-- Red 1C stylized lines -->
                  <path d="M 0 4 L 4 0 L 4 22 M 8 0 L 8 22" stroke="#FF0000" stroke-width="3.5" fill="none" stroke-linecap="butt"/>
                  <path d="M 30 2 C 20 2, 16 8, 16 11 C 16 14, 20 20, 30 20 L 45 20 M 30 6 C 24 6, 22 9, 22 11 C 22 13, 24 16, 30 16 L 45 16" stroke="#FF0000" stroke-width="3.2" fill="none" stroke-linecap="butt"/>
              </g>
          `;
          g.appendChild(onec);
      }

      if (node.id === "s3") {
          const excel = document.createElementNS("http://www.w3.org/2000/svg", "g");
          excel.innerHTML = `
              <rect x="${node.x - 16}" y="${node.y - 18}" width="32" height="36" fill="white" stroke="#217346" stroke-width="1.5" rx="2"/>
              <rect x="${node.x - 10}" y="${node.y - 10}" width="20" height="16" fill="#217346" opacity="0.1"/>
              <path d="M ${node.x - 10} ${node.y - 10} h 20 v 16 h -20 z M ${node.x - 10} ${node.y - 5} h 20 M ${node.x - 10} ${node.y} h 20 M ${node.x - 10} ${node.y + 5} h 20 M ${node.x} ${node.y - 10} v 16" stroke="#217346" stroke-width="0.8" fill="none"/>
              <rect x="${node.x - 22}" y="${node.y + 2}" width="44" height="12" fill="#217346" rx="1.5"/>
              <text x="${node.x}" y="${node.y + 11}" fill="white" font-family="Arial, sans-serif" font-weight="900" font-size="8.5" text-anchor="middle" style="pointer-events:none;">.XLSX</text>
          `;
          g.appendChild(excel);
      }

      if (node.type === "dwh") {
          const cylinder = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "g",
          );
          cylinder.setAttribute("stroke", "var(--accent-blue)");
          cylinder.setAttribute("stroke-width", "2");
          cylinder.setAttribute("fill", "rgba(0, 85, 255, 0.1)");
          cylinder.innerHTML = `
              <ellipse cx="${node.x}" cy="${node.y - 12}" rx="18" ry="6"/>
              <path d="M ${node.x - 18} ${node.y - 12} v 24 a 18 6 0 0 0 36 0 v -24"/>
              <path d="M ${node.x - 18} ${node.y - 4} a 18 6 0 0 0 36 0" opacity="0.5"/>
              <path d="M ${node.x - 18} ${node.y + 4} a 18 6 0 0 0 36 0" opacity="0.5"/>
          `;
          g.appendChild(cylinder);
      }

      if (node.id === "c3") {
          const users = document.createElementNS("http://www.w3.org/2000/svg", "g");
          users.setAttribute("stroke", "#F59E0B");
          users.setAttribute("stroke-width", "1.5");
          users.setAttribute("fill", "rgba(245, 158, 11, 0.1)");
          users.innerHTML = `
              <circle cx="${node.x - 12}" cy="${node.y - 4}" r="7" stroke="#F59E0B" fill="none"/>
              <path d="M ${node.x - 21} ${node.y + 10} a 9 9 0 0 1 18 0" stroke="#F59E0B" fill="none"/>
              <path d="M ${node.x - 15} ${node.y - 2} a 3 3 0 0 0 6 0" stroke-width="1.2" fill="none" stroke="#F59E0B" stroke-linecap="round"/>
              
              <circle cx="${node.x + 12}" cy="${node.y - 4}" r="7" stroke="#F59E0B" fill="none"/>
              <path d="M ${node.x + 3} ${node.y + 10} a 9 9 0 0 1 18 0" stroke="#F59E0B" fill="none"/>
              <path d="M ${node.x + 8} ${node.y - 2} a 3 3 0 0 0 6 0" stroke-width="1.2" fill="none" stroke="#F59E0B" stroke-linecap="round"/>
          `;
          g.appendChild(users);
      }

      if (node.id === "c1") {
          const eagle = document.createElementNS("http://www.w3.org/2000/svg", "g");
          eagle.innerHTML = `
              <!-- Grey Circle Frame -->
              <circle cx="${node.x}" cy="${node.y}" r="22" fill="white" stroke="#888888" stroke-width="1.5"/>
              
              <!-- Grey Eagle Silhouette -->
              <g fill="#888888" stroke="none">
                  <!-- Main Body -->
                  <path d="M ${node.x - 3} ${node.y - 3} L ${node.x + 3} ${node.y - 3} L ${node.x + 5} ${node.y + 8} L ${node.x - 5} ${node.y + 8} Z" />
                  
                  <!-- Left Wing -->
                  <path d="M ${node.x - 3} ${node.y - 3} 
                           C ${node.x - 18} ${node.y - 12}, ${node.x - 20} ${node.y + 5}, ${node.x - 16} ${node.y + 12}
                           L ${node.x - 5} ${node.y + 4} Z" />
                           
                  <!-- Right Wing -->
                  <path d="M ${node.x + 3} ${node.y - 3} 
                           C ${node.x + 18} ${node.y - 12}, ${node.x + 20} ${node.y + 5}, ${node.x + 16} ${node.y + 12}
                           L ${node.x + 5} ${node.y + 4} Z" />
                           
                  <!-- Heads (Double) -->
                  <path d="M ${node.x - 2} ${node.y - 3} L ${node.x - 4} ${node.y - 14} L ${node.x - 9} ${node.y - 14} L ${node.x - 9} ${node.y - 11} L ${node.x - 3} ${node.y - 3}" />
                  <path d="M ${node.x + 2} ${node.y - 3} L ${node.x + 4} ${node.y - 14} L ${node.x + 9} ${node.y - 14} L ${node.x + 9} ${node.y - 11} L ${node.x + 3} ${node.y - 3}" />
                  
                  <!-- Tail -->
                  <path d="M ${node.x - 5} ${node.y + 8} L ${node.x + 5} ${node.y + 8} L ${node.x + 8} ${node.y + 15} L ${node.x - 8} ${node.y + 15} Z" />
              </g>
          `;
          g.appendChild(eagle);
      }

      if (node.id === "c2") {
          const isp = document.createElementNS("http://www.w3.org/2000/svg", "g");
          isp.innerHTML = `
              <rect x="${node.x - 18}" y="${node.y - 18}" width="36" height="36" fill="white" stroke="#ED6B2F" stroke-width="1.5" rx="2"/>
              <line x1="${node.x - 14}" y1="${node.y - 6}" x2="${node.x + 14}" y2="${node.y - 6}" stroke="#F2BA1A" stroke-width="2" stroke-linecap="round"/>
              <path d="M ${node.x - 14} ${node.y + 12} v -10 a 4 4 0 0 1 8 0 v 10" fill="none" stroke="#004A99" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M ${node.x - 4} ${node.y + 12} v -10 a 4 4 0 0 1 8 0 v 10" fill="none" stroke="#008037" stroke-width="2.5" stroke-linecap="round"/>
              <path d="M ${node.x + 6} ${node.y + 12} v -10 a 4 4 0 0 1 8 0 v 10" fill="none" stroke="#ED6B2F" stroke-width="2.5" stroke-linecap="round"/>
          `;
          g.appendChild(isp);
      }

      svg.appendChild(g);
  });

  container.appendChild(svg);
}
