/* 
MODULE: src/lineage/tableLineageConstants.js
ROLE: Константы размеров, отступов, алгоритмических параметров и иконок для Table Lineage.
*/

export const BUNDLE_SPACING = 8; // зазор между рёбрами в шлейфе (вертикальный и горизонтальный), px
export const MIN_GAP = 32; // минимальный вертикальный зазор между узлами слоя (Phase 2.2)
export const MIN_GAP_23 = 32; // минимальный зазор для изолированных пар (Phase 2.3)
export const BEND_TOLERANCE = 31; // порог непрямолинейности для изолированных пар (Phase 2.3)
export const MAX_ALIGN_OFFSET = 2 * BUNDLE_SPACING; // максимальный сдвиг узла при выравнивании (±16px)
export const TRANSIT_CLEARANCE = BUNDLE_SPACING; // клиренс чистой полосы транзита (8px)
export const CHANNEL_PADDING = 20; // 2 * 10px безопасной зоны от краев узлов
export const TRACK_STEP = BUNDLE_SPACING; // шаг между треками в зазоре
export const CHANNEL_SPACING = BUNDLE_SPACING; // горизонтальный шаг между вертикалями в канале
export const EDGE_HIT_WIDTH = 16; // ширина области клика (hit area) вокруг ребра, px

export const SUGIYAMA_PASSES = 15; // число проходов forward/backward
export const SIFTING_PASSES = 2; // число проходов sifting
export const SUGIYAMA_GRAVITY_WEIGHT = 1.5; // вес гравитации к якорному родителю (Barycentric Gravity)


export const ICONS = {
  zoomOut: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  zoomIn: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  fit: `<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 15v6h-6M3 9V3h6"/></svg>`,
};
