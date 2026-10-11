// Mock DOM для выполнения модулей в Node.js
if (typeof global.document === "undefined") {
  global.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
  };
}
if (typeof global.window === "undefined") {
  global.window = {
    ...global,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
