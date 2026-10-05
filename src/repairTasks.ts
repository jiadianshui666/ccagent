export type RepairTaskFile = {
  path: string;
  content: string;
};

export type RepairTask = {
  name: string;
  files: RepairTaskFile[];
  verifyCommand?: string;
};

export const DEFAULT_REPAIR_VERIFY_COMMAND = "npm test";

function file(path: string, content: string): RepairTaskFile {
  return { path, content };
}

function task(name: string, files: RepairTaskFile[], verifyCommand?: string): RepairTask {
  return { name, files, verifyCommand };
}

export const REPAIR_TASKS: RepairTask[] = [
  task("order-service", [
    file(
      "src/domain/shipping.js",
      [
        "const FREE_SHIPPING_THRESHOLD_CENTS = 5000;",
        "",
        "function calculateShippingCents(order) {",
        "  return 0;",
        "}",
        "",
        "module.exports = { FREE_SHIPPING_THRESHOLD_CENTS, calculateShippingCents };",
        "",
      ].join("\n"),
    ),
    file(
      "src/domain/tax.js",
      [
        "function calculateTaxCents(subtotalCents, taxRate) {",
        "  return Math.round(subtotalCents * taxRate);",
        "}",
        "",
        "module.exports = { calculateTaxCents };",
        "",
      ].join("\n"),
    ),
    file(
      "src/domain/orders.js",
      [
        "const { calculateShippingCents } = require('./shipping');",
        "const { calculateTaxCents } = require('./tax');",
        "",
        "function summarizeOrder(order, config) {",
        "  const subtotalCents = order.items.reduce((sum, item) => sum + item.unitCents, 0);",
        "  const shippingCents = calculateShippingCents(order);",
        "  const taxCents = calculateTaxCents(subtotalCents, config.taxRate);",
        "",
        "  return {",
        "    id: order.id,",
        "    subtotalCents,",
        "    shippingCents,",
        "    taxCents,",
        "    grandTotalCents: subtotalCents + taxCents,",
        "  };",
        "}",
        "",
        "module.exports = { summarizeOrder };",
        "",
      ].join("\n"),
    ),
    file(
      "src/infra/config.js",
      [
        "module.exports = {",
        "  taxRate: 0.08,",
        "  shippingCents: 799,",
        "};",
        "",
      ].join("\n"),
    ),
    file(
      "src/index.js",
      [
        "const config = require('./infra/config');",
        "const { summarizeOrder } = require('./domain/orders');",
        "",
        "module.exports = { config, summarizeOrder };",
        "",
      ].join("\n"),
    ),
    file(
      "tests/order-summary.test.js",
      [
        "const assert = require('node:assert/strict');",
        "const { config, summarizeOrder } = require('../src');",
        "",
        "const summary = summarizeOrder({",
        "  id: 'provider_repair_1',",
        "  items: [",
        "    { sku: 'desk', unitCents: 3200, quantity: 1 },",
        "    { sku: 'lamp', unitCents: 1200, quantity: 2 },",
        "  ],",
        "}, config);",
        "",
        "assert.deepEqual(summary, {",
        "  id: 'provider_repair_1',",
        "  subtotalCents: 5600,",
        "  shippingCents: 0,",
        "  taxCents: 448,",
        "  grandTotalCents: 6048,",
        "});",
        "console.log('provider repair order summary ok');",
        "",
      ].join("\n"),
    ),
    file(
      "package.json",
      `${JSON.stringify({ scripts: { test: "node tests/order-summary.test.js" } }, null, 2)}\n`,
    ),
  ]),
  task("truncate-boundary", [
    file(
      "src/truncate.js",
      [
        "function truncate(value, maxLength) {",
        "  if (value.length >= maxLength) {",
        "    return value.slice(0, maxLength - 3) + '...';",
        "  }",
        "  return value;",
        "}",
        "",
        "module.exports = { truncate };",
        "",
      ].join("\n"),
    ),
    file(
      "tests/truncate.test.js",
      [
        "const assert = require('node:assert/strict');",
        "const { truncate } = require('../src/truncate');",
        "",
        "assert.equal(truncate('hello', 5), 'hello');",
        "assert.equal(truncate('hello world', 8), 'hello...');",
        "assert.equal(truncate('hi', 10), 'hi');",
        "console.log('truncate ok');",
        "",
      ].join("\n"),
    ),
    file(
      "package.json",
      `${JSON.stringify({ scripts: { test: "node tests/truncate.test.js" } }, null, 2)}\n`,
    ),
  ]),
  task("date-pad", [
    file(
      "src/format.js",
      [
        "function pad2(n) {",
        "  return n <= 10 ? '0' + n : String(n);",
        "}",
        "",
        "function formatDate(year, month, day) {",
        "  return `${year}-${pad2(month)}-${pad2(day)}`;",
        "}",
        "",
        "module.exports = { pad2, formatDate };",
        "",
      ].join("\n"),
    ),
    file(
      "tests/format.test.js",
      [
        "const assert = require('node:assert/strict');",
        "const { formatDate } = require('../src/format');",
        "",
        "assert.equal(formatDate(2026, 10, 5), '2026-10-05');",
        "assert.equal(formatDate(2026, 1, 15), '2026-01-15');",
        "console.log('date format ok');",
        "",
      ].join("\n"),
    ),
    file(
      "package.json",
      `${JSON.stringify({ scripts: { test: "node tests/format.test.js" } }, null, 2)}\n`,
    ),
  ]),
];

export function listRepairTaskNames(): string[] {
  return REPAIR_TASKS.map((task) => task.name);
}

export function findRepairTask(name: string): RepairTask | undefined {
  return REPAIR_TASKS.find((task) => task.name === name);
}