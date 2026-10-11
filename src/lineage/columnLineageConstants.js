/*
MODULE: src/lineage/columnLineageConstants.js
ROLE: Общие константы визуализации Column Lineage.

Используются в columnLineage.js, columnLineageEdges.js, columnLineageFocus.js.
*/

// Меняйте это значение (MIN_TRACK_GAP), чтобы увеличить расстояние между вертикальными линиями!
export const MIN_TRACK_GAP = 14;

// Базовый отступ от таблицы до первой линии (используется для динамических gap'ов между слоями)
export const BASE_CHANNEL_WIDTH = 40;

// Расстояния до вертикального изгиба ребра (симметричны справа и слева)
// Желательно, чтобы значения были равны для визуальной симметрии
export const EDGE_BEND_DISTANCE_SOURCE = BASE_CHANNEL_WIDTH; // расстояние от родительской таблицы (справа) до точки изгиба
export const EDGE_BEND_DISTANCE_TARGET = BASE_CHANNEL_WIDTH;  // расстояние от таблицы-потомка (слева) до точки изгиба
