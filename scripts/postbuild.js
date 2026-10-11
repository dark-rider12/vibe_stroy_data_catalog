const fs = require('fs');
const path = require('path');

// 1. Копируем static/main.js -> dist/static/main.js
const srcMain = path.join(__dirname, '..', 'static', 'main.js');
const distDir = path.join(__dirname, '..', 'dist', 'static');
const distMain = path.join(distDir, 'main.js');

if (fs.existsSync(srcMain) && fs.existsSync(distDir)) {
  fs.copyFileSync(srcMain, distMain);
  console.log('✓ Скопирован: static/main.js -> dist/static/main.js');
}

// 1б. Копируем static/style.css -> dist/static/style.css
const srcCss = path.join(__dirname, '..', 'static', 'style.css');
const distCss = path.join(distDir, 'style.css');
if (fs.existsSync(srcCss) && fs.existsSync(distDir)) {
  fs.copyFileSync(srcCss, distCss);
  console.log('✓ Скопирован: static/style.css -> dist/static/style.css');
}

// 2. Обновляем версию кэша (?v=...) в dist/index.html
const distHtml = path.join(__dirname, '..', 'dist', 'index.html');
if (fs.existsSync(distHtml)) {
  let html = fs.readFileSync(distHtml, 'utf8');
  const v = Date.now();
  let updatedHtml = html
    .replace(/(static\/main\.js\?v=)[^"']*/g, '$1' + v)
    .replace(/(static\/style\.css\?v=)[^"']*/g, '$1' + v)
    .replace(/(static\/catalog\.js\?v=)[^"']*/g, '$1' + v);

  // Если версий еще не было (первое применение к старому index.html)
  if (!updatedHtml.includes('static/main.js?v=')) {
    updatedHtml = updatedHtml
      .replace(/src="static\/main\.js"/g, `src="static/main.js?v=${v}"`)
      .replace(/href="static\/style\.css"/g, `href="static/style.css?v=${v}"`)
      .replace(/src="static\/catalog\.js"/g, `src="static/catalog.js?v=${v}"`);
  }

  if (updatedHtml !== html) {
    fs.writeFileSync(distHtml, updatedHtml, 'utf8');
    console.log(`✓ Обновлена версия кэша в dist/index.html: ?v=${v}`);
  }
}
