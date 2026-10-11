/* 
MODULE: src/ui/loadingBar.js
ROLE: Управление полосой загрузки (замена спиннера).
      Переводит полосу из indeterminate в детерминированный режим
      и возвращает функцию обновления прогресса (pct, text).
*/

export function initProgressBar(container) {
  const bar = container?.querySelector(".loading-bar");
  const fill = container?.querySelector(".loading-bar__fill");
  const label = container?.querySelector(".loading-bar__label");

  bar?.classList.remove("loading-bar--indeterminate");
  if (fill) fill.style.setProperty("--loading-bar-progress", "0%");
  if (label) label.textContent = "Подготовка данных…";

  return (pct, text) => {
    if (fill && typeof pct === "number") {
      fill.style.setProperty("--loading-bar-progress", `${Math.round(pct)}%`);
    }
    if (label && typeof text === "string") label.textContent = text;
  };
}