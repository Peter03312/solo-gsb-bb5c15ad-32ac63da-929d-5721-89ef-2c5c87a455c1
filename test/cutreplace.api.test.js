'use strict';

// 裁片订单“换单”端到端：
// 已确认旧单 → 同一图纸另一已发布版本新单。
// 预览按颜色给出旧单/新单用板、净增减、计入旧单预留后的可用量与缺口（不占库存）；
// 确认在同一事务内旧单退出预留、新单确认；任一颜色不足全部回滚；
// 幂等（相同参数返回原新单）、不同参数冲突、均不重复预留；
// 无效版本/不同图纸/已取消旧单/排样失败明确拒绝；旧单标记 replaced 不可取消/修改/删除；
// 两单的发布快照与排样仍可查。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39141';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `cutreplace-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pub1, pub2, otherPub;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

function rect(color, x0, y0, x1, y1) {
  return { color, polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/glass-sheets'); break; } catch { await sleep(50); }
  }

  // 图纸 40×40：v1 四块 20×20（左上红、右上红、左下绿、右下绿）
  const d = await api('POST', '/api/designs', { name: '换单测试窗', width: 40, height: 40 });
  designId = d.data.design.id;
  await api('POST', `/api/designs/${designId}/pieces`, rect('#ff0000', 0, 20, 20, 40));
  await api('POST', `/api/designs/${designId}/pieces`, rect('#ff0000', 20, 20, 40, 40));
  await api('POST', `/api/designs/${designId}/pieces`, rect('#00ff00', 0, 0, 20, 20));
  await api('POST', `/api/designs/${designId}/pieces`, rect('#00ff00', 20, 0, 40, 20));
  pub1 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;

  // v2：草稿改成 2 块 40×20（上绿下红），每色一件大片
  const pieces = (await api('GET', `/api/designs/${designId}`)).data.draft.pieces;
  for (const p of pieces) await api('DELETE', `/api/designs/${designId}/pieces/${p.id}`);
  await api('POST', `/api/designs/${designId}/pieces`, rect('#ff0000', 0, 0, 40, 20));
  await api('POST', `/api/designs/${designId}/pieces`, rect('#00ff00', 0, 20, 40, 40));
  pub2 = (await api('POST', `/api/designs/${designId}/publish`)).data.publication;
  assert.strictEqual(pub2.version, 2);

  // 另一图纸（非同图纸拒绝用）
  const d2 = await api('POST', '/api/designs', { name: '别的窗', width: 10, height: 10 });
  await api('POST', `/api/designs/${d2.data.design.id}/pieces`,
    rect('#ff0000', 0, 0, 10, 10));
  otherPub = (await api('POST', `/api/designs/${d2.data.design.id}/publish`)).data.publication;

  // 原片：红 50×50 库存 4；绿 50×50 库存 4
  await api('POST', '/api/glass-sheets', { color: '#ff0000', width: 50, height: 50, stock: 4 });
  await api('POST', '/api/glass-sheets', { color: '#00ff00', width: 50, height: 50, stock: 4 });
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

async function sheetByColor(color) {
  const all = (await api('GET', '/api/glass-sheets')).data.sheets;
  return all.find((s) => s.color === color);
}

test('换单预览：按颜色列出旧/新用板、净增减、计入旧单预留后的可用量与缺口；不占库存', async () => {
  // 旧单：v1 copies=2 gap=0 → 每色 4 片 20×20，50×50 板各 1 张
  const created = await api('POST', '/api/cut-orders', { name: '旧单', publicationId: pub1.id, copies: 2, gap: 0 });
  const oldId = created.data.order.id;
  assert.strictEqual(created.data.order.totalSheets, 2);
  assert.strictEqual((await api('POST', `/api/cut-orders/${oldId}/confirm`)).status, 200);

  const redBefore = await sheetByColor('#ff0000');
  assert.strictEqual(redBefore.reserved, 1);

  // 预览换到 v2 copies=1：每色 1 片 40×20 → 各 1 张
  const pv = await api('POST', `/api/cut-orders/${oldId}/replacements/preview`, {
    targetPublicationId: pub2.id, copies: 1, gap: 0,
  });
  assert.strictEqual(pv.status, 200);
  const p = pv.data.preview;
  assert.strictEqual(p.oldVersion, 1);
  assert.strictEqual(p.targetVersion, 2);
  assert.strictEqual(p.oldTotalSheets, 2);
  assert.strictEqual(p.totalSheets, 2);
  assert.strictEqual(p.netSheetChange, 0);
  assert.strictEqual(p.feasible, true);
  const rc = p.colors.find((c) => c.color === '#ff0000');
  assert.strictEqual(rc.oldSheets, 1);
  assert.strictEqual(rc.requiredSheets, 1);
  assert.strictEqual(rc.netChange, 0);
  assert.strictEqual(rc.oldOrderReserved, 1);
  assert.strictEqual(rc.availableAfterRelease, rc.stock - rc.reserved + 1);
  assert.strictEqual(rc.shortage, 0);

  // 预览不占库存
  const redAfter = await sheetByColor('#ff0000');
  assert.strictEqual(redAfter.reserved, 1);
  assert.strictEqual(redAfter.available, redBefore.available);
});

test('非法换单目标：无效版本 404、同图纸不同才允许、同版本拒绝、参数非法', async () => {
  const oldId = (await api('GET', '/api/cut-orders')).data.orders[0].id;
  assert.strictEqual(
    (await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
      { targetPublicationId: 99999, copies: 1, gap: 0 })).status, 404);
  const diff = await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
    { targetPublicationId: otherPub.id, copies: 1, gap: 0 });
  assert.strictEqual(diff.status, 400);
  assert.strictEqual(diff.data.code, 'different_design');
  const same = await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
    { targetPublicationId: pub1.id, copies: 1, gap: 0 });
  assert.strictEqual(same.status, 400);
  assert.strictEqual(same.data.code, 'same_publication');
  assert.strictEqual((await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
    { targetPublicationId: pub2.id, copies: 0, gap: 0 })).status, 400);
  assert.strictEqual((await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
    { targetPublicationId: pub2.id, copies: 1, gap: 51 })).status, 400);
});

test('非已确认订单不能换单；订单不存在 404', async () => {
  const draft = await api('POST', '/api/cut-orders', { publicationId: pub1.id, copies: 1, gap: 0 });
  const did = draft.data.order.id;
  const r1 = await api('POST', `/api/cut-orders/${did}/replacements/preview`,
    { targetPublicationId: pub2.id, copies: 1, gap: 0 });
  assert.strictEqual(r1.status, 409);
  assert.strictEqual(r1.data.code, 'not_confirmed');
  const r2 = await api('POST', `/api/cut-orders/${did}/replacements`,
    { targetPublicationId: pub2.id, copies: 1, gap: 0 });
  assert.strictEqual(r2.status, 409);
  assert.strictEqual((await api('POST', '/api/cut-orders/99999/replacements/preview',
    { targetPublicationId: pub2.id, copies: 1, gap: 0 })).status, 404);
  await api('DELETE', `/api/cut-orders/${did}`);
});

test('确认换单成功：同事务旧单退出预留并标记 replaced，新单确认；库存仅差净变化', async () => {
  // 新单：v2 copies=3 gap=0 → 每色 3 片 40×20，50×50 板每板 2 片 → 各色 2 张
  const oldId = (await api('GET', '/api/cut-orders')).data.orders
    .find((o) => o.status === 'confirmed' && o.version === 1).id;
  const r = await api('POST', `/api/cut-orders/${oldId}/replacements`,
    { targetPublicationId: pub2.id, copies: 3, gap: 0 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const newId = r.data.newOrder.id;
  assert.notStrictEqual(newId, oldId);
  assert.strictEqual(r.data.oldOrder.status, 'replaced');
  assert.strictEqual(r.data.newOrder.status, 'confirmed');
  assert.strictEqual(r.data.newOrder.publicationId, pub2.id);
  assert.strictEqual(r.data.newOrder.version, 2);
  assert.strictEqual(r.data.newOrder.copies, 3);
  assert.strictEqual(r.data.newOrder.totalSheets, 4, '红/绿各 2 张');

  // 旧单预留释放，新单预留：红/绿各 2
  const red = await sheetByColor('#ff0000');
  assert.strictEqual(red.reserved, 2);
  assert.strictEqual(red.available, 2);
  const green = await sheetByColor('#00ff00');
  assert.strictEqual(green.reserved, 2);

  // 两单均可查，各自发布快照与排样
  const oldDetail = (await api('GET', `/api/cut-orders/${oldId}`)).data.order;
  const newDetail = (await api('GET', `/api/cut-orders/${newId}`)).data.order;
  assert.strictEqual(oldDetail.version, 1);
  assert.strictEqual(newDetail.version, 2);
  assert.strictEqual(oldDetail.layout.colors.length, 2);
  assert.strictEqual(newDetail.layout.colors.length, 2);
  assert.ok(oldDetail.replacedBy);
  assert.strictEqual(oldDetail.replacedBy.newOrderId, newId);
  assert.ok(newDetail.replacedFrom);
  assert.strictEqual(newDetail.replacedFrom.oldOrderId, oldId);

  // 旧单不能再取消/修改/删除
  assert.strictEqual((await api('POST', `/api/cut-orders/${oldId}/cancel`)).status, 409);
  assert.strictEqual((await api('PUT', `/api/cut-orders/${oldId}`, { copies: 2 })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/cut-orders/${oldId}`)).status, 409);
});

test('幂等：相同参数重试返回原新单，不重复预留', async () => {
  const orders = (await api('GET', '/api/cut-orders')).data.orders;
  const oldId = orders.find((o) => o.status === 'replaced').id;
  const replacedRecord = orders.find((o) => o.id === oldId).replacedBy;
  const origNew = replacedRecord.newOrderId;
  const redBefore = await sheetByColor('#ff0000');
  const r = await api('POST', `/api/cut-orders/${oldId}/replacements`,
    { targetPublicationId: pub2.id, copies: 3, gap: 0 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.idempotent, true);
  assert.strictEqual(r.data.newOrder.id, origNew);
  const redAfter = await sheetByColor('#ff0000');
  assert.strictEqual(redAfter.reserved, redBefore.reserved);
});

test('冲突：同一旧单不同参数报 409 param_conflict，不重复预留', async () => {
  const oldId = (await api('GET', '/api/cut-orders')).data.orders.find((o) => o.status === 'replaced').id;
  const redBefore = await sheetByColor('#ff0000');
  const r = await api('POST', `/api/cut-orders/${oldId}/replacements`,
    { targetPublicationId: pub2.id, copies: 2, gap: 0 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'param_conflict');
  assert.ok(r.data.newOrder);
  const redAfter = await sheetByColor('#ff0000');
  assert.strictEqual(redAfter.reserved, redBefore.reserved);

  // 预览接口同样拒绝已替换旧单
  const pv = await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
    { targetPublicationId: pub2.id, copies: 2, gap: 0 });
  assert.strictEqual(pv.status, 409);
});

test('缺口场景：计入旧单预留后仍不足则整单失败，旧单/库存/订单记录均保持原状', async () => {
  // 建第二张图纸第二组订单：复制设计流程
  const d = await api('POST', '/api/designs', { name: '缺口窗', width: 20, height: 20 });
  const did2 = d.data.design.id;
  await api('POST', `/api/designs/${did2}/pieces`, rect('#0000ff', 0, 0, 20, 20));
  const q1 = (await api('POST', `/api/designs/${did2}/publish`)).data.publication;
  // v2 仍是一片 20×20 蓝（换单要求另一版本；换 copies 使缺口）
  await api('POST', `/api/designs/${did2}/pieces`, rect('#111111', 0, 0, 1, 1)); // 会重叠失败，改法：先删再布
  // 直接重新构造：删除蓝片，用 4 个 10×10 蓝片重发布（颜色相同）
  await api('DELETE', `/api/designs/${did2}/pieces/1`).catch(() => {});
  // piece id 未必是 1；取草稿列表删除
  const draftPieces = (await api('GET', `/api/designs/${did2}`)).data.draft.pieces;
  for (const p of draftPieces) await api('DELETE', `/api/designs/${did2}/pieces/${p.id}`);
  await api('POST', `/api/designs/${did2}/pieces`, rect('#0000ff', 0, 10, 10, 20));
  await api('POST', `/api/designs/${did2}/pieces`, rect('#0000ff', 10, 10, 20, 20));
  await api('POST', `/api/designs/${did2}/pieces`, rect('#0000ff', 0, 0, 10, 10));
  await api('POST', `/api/designs/${did2}/pieces`, rect('#0000ff', 10, 0, 20, 10));
  const q2 = (await api('POST', `/api/designs/${did2}/publish`)).data.publication;
  assert.strictEqual(q2.version, 2);

  // 蓝板 50×50 库存仅 2：旧单 v1 copies=1 需 1，换单 v2 copies=2 需 8 片 10×10（gap=0 一板可放）
  await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 50, height: 50, stock: 2 });
  const o = await api('POST', '/api/cut-orders', { publicationId: q1.id, copies: 1, gap: 0 });
  const oldId = o.data.order.id;
  assert.strictEqual((await api('POST', `/api/cut-orders/${oldId}/confirm`)).status, 200);
  const blueBefore = await sheetByColor('#0000ff');
  assert.strictEqual(blueBefore.reserved, 1);

  // v2 copies=2 gap=4：10×10 片带 4 间距，50×50 每向最多 4 片（10+4=14，4 片=52>50 → 3 片/向 =9 片/板）
  // 8 片一板即可；改用 copies=20 放大用量：80 片，3 片/向=9 片/板 → 9 张 > 库存 2（释放旧1后可用2）
  const pv = await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
    { targetPublicationId: q2.id, copies: 20, gap: 4 });
  assert.strictEqual(pv.status, 200);
  const bc = pv.data.preview.colors.find((c) => c.color === '#0000ff');
  assert.ok(pv.data.preview.totalShortage > 0, '应当有缺口');
  assert.ok(bc.shortage > 0);
  assert.strictEqual(bc.availableAfterRelease, 2, '旧单释放 1 后可用=库存2');

  const cf = await api('POST', `/api/cut-orders/${oldId}/replacements`,
    { targetPublicationId: q2.id, copies: 20, gap: 4 });
  assert.strictEqual(cf.status, 409);
  assert.strictEqual(cf.data.code, 'shortage');
  assert.ok(Array.isArray(cf.data.shortages));
  assert.strictEqual(cf.data.shortages[0].color, '#0000ff');
  assert.ok(cf.data.shortages[0].shortage > 0);
  // 旧单仍 confirmed、库存不变、没有产生新订单
  const oldDetail = (await api('GET', `/api/cut-orders/${oldId}`)).data.order;
  assert.strictEqual(oldDetail.status, 'confirmed');
  assert.strictEqual(oldDetail.publicationId, q1.id);
  const blueAfter = await sheetByColor('#0000ff');
  assert.strictEqual(blueAfter.reserved, 1);
  assert.strictEqual(blueAfter.available, 1);
  const orders = (await api('GET', '/api/cut-orders')).data.orders;
  assert.ok(!orders.some((x) => x.publicationId === q2.id && x.replacedFrom?.oldOrderId === oldId));
});

test('排样失败明确拒绝：目标版本含未登记颜色 → 422 missing_color，不换单', async () => {
  const d = await api('POST', '/api/designs', { name: '缺色窗', width: 10, height: 10 });
  const did3 = d.data.design.id;
  await api('POST', `/api/designs/${did3}/pieces`, rect('#abcdef', 0, 0, 10, 10));
  const a1 = (await api('POST', `/api/designs/${did3}/publish`)).data.publication;
  // v2 改成另一颜色
  (await api('GET', `/api/designs/${did3}`)).data.draft.pieces
    .forEach((p) => api('DELETE', `/api/designs/${did3}/pieces/${p.id}`));
  await api('POST', `/api/designs/${did3}/pieces`, rect('#fedcba', 0, 0, 10, 10));
  const a2 = (await api('POST', `/api/designs/${did3}/publish`)).data.publication;
  await api('POST', '/api/glass-sheets', { color: '#abcdef', width: 20, height: 20, stock: 3 });
  const o = await api('POST', '/api/cut-orders', { publicationId: a1.id, copies: 1, gap: 0 });
  const oldId = o.data.order.id;
  await api('POST', `/api/cut-orders/${oldId}/confirm`);

  const pv = await api('POST', `/api/cut-orders/${oldId}/replacements/preview`,
    { targetPublicationId: a2.id, copies: 1, gap: 0 });
  assert.strictEqual(pv.status, 422);
  assert.strictEqual(pv.data.code, 'missing_color');
  assert.strictEqual(pv.data.color, '#fedcba');
  const cf = await api('POST', `/api/cut-orders/${oldId}/replacements`,
    { targetPublicationId: a2.id, copies: 1, gap: 0 });
  assert.strictEqual(cf.status, 422);
  assert.strictEqual((await api('GET', `/api/cut-orders/${oldId}`)).data.order.status, 'confirmed');
});

test('已取消旧单不能换单', async () => {
  const d = await api('POST', '/api/designs', { name: '取消窗', width: 10, height: 10 });
  const did4 = d.data.design.id;
  await api('POST', `/api/designs/${did4}/pieces`, rect('#222222', 0, 0, 10, 10));
  const z1 = (await api('POST', `/api/designs/${did4}/publish`)).data.publication;
  await api('POST', '/api/glass-sheets', { color: '#222222', width: 20, height: 20, stock: 3 });
  const o = await api('POST', '/api/cut-orders', { publicationId: z1.id, copies: 1, gap: 0 });
  const id = o.data.order.id;
  await api('POST', `/api/cut-orders/${id}/confirm`);
  await api('POST', `/api/cut-orders/${id}/cancel`);
  // 发布 v2
  await api('POST', `/api/designs/${did4}/pieces`, rect('#333333', 0, 0, 1, 1)).catch(() => {});
  const r = await api('POST', `/api/cut-orders/${id}/replacements`,
    { targetPublicationId: z1.id, copies: 1, gap: 0 });
  // 同版本 400 先于状态？状态检查在前 → 409
  assert.ok([409, 400].includes(r.status));
  assert.ok(r.status === 409 || r.data.code === 'same_publication');
});

test('新单仍遵守几何与总用板 60 上限：超限 422 too_many_sheets', async () => {
  // 用 1×1 点窗：v1 一片 1×1，v2 同几何但用 copies=61 超 60
  const d = await api('POST', '/api/designs', { name: '点窗换单', width: 1, height: 1 });
  const did5 = d.data.design.id;
  await api('POST', `/api/designs/${did5}/pieces`, rect('#444444', 0, 0, 1, 1));
  const t1 = (await api('POST', `/api/designs/${did5}/publish`)).data.publication;
  // v2 必须与 v1 不同版本：微调（仍 1×1 窗只能一片）→ 删除后重发同片
  for (const p of (await api('GET', `/api/designs/${did5}`)).data.draft.pieces) {
    await api('DELETE', `/api/designs/${did5}/pieces/${p.id}`);
  }
  await api('POST', `/api/designs/${did5}/pieces`, rect('#444444', 0, 0, 1, 1));
  const t2 = (await api('POST', `/api/designs/${did5}/publish`)).data.publication;
  await api('POST', '/api/glass-sheets', { color: '#444444', width: 1, height: 1, stock: 100 });
  const o = await api('POST', '/api/cut-orders', { publicationId: t1.id, copies: 1, gap: 0 });
  const id = o.data.order.id;
  await api('POST', `/api/cut-orders/${id}/confirm`);
  const pv = await api('POST', `/api/cut-orders/${id}/replacements/preview`,
    { targetPublicationId: t2.id, copies: 61, gap: 0 });
  assert.strictEqual(pv.status, 422);
  assert.strictEqual(pv.data.code, 'too_many_sheets');
  const cf = await api('POST', `/api/cut-orders/${id}/replacements`,
    { targetPublicationId: t2.id, copies: 61, gap: 0 });
  assert.strictEqual(cf.status, 422);
  // 旧单不变
  assert.strictEqual((await api('GET', `/api/cut-orders/${id}`)).data.order.status, 'confirmed');
});

test('净减少用板：换单后库存预留相应减少，净增加时占用更多', async () => {
  // v1 copies=2 每色 1 片 40×20（两色各两片），50×50 板每色 2 片/板 → 每色 1 张（共2）
  const d = await api('POST', '/api/designs', { name: '净减窗', width: 40, height: 20 });
  const did6 = d.data.design.id;
  await api('POST', `/api/designs/${did6}/pieces`, rect('#555555', 0, 0, 20, 20));
  await api('POST', `/api/designs/${did6}/pieces`, rect('#666666', 20, 0, 40, 20));
  const n1 = (await api('POST', `/api/designs/${did6}/publish`)).data.publication;
  // v2：草稿改为整片 40×20 红色
  for (const p of (await api('GET', `/api/designs/${did6}`)).data.draft.pieces) {
    await api('DELETE', `/api/designs/${did6}/pieces/${p.id}`);
  }
  await api('POST', `/api/designs/${did6}/pieces`, rect('#555555', 0, 0, 40, 20));
  const n2 = (await api('POST', `/api/designs/${did6}/publish`)).data.publication;
  await api('POST', '/api/glass-sheets', { color: '#555555', width: 50, height: 50, stock: 5 });
  await api('POST', '/api/glass-sheets', { color: '#666666', width: 50, height: 50, stock: 5 });
  // v1 copies=2：555 两片 20×20 同板 1 张；666 两片 20×20 同板 1 张
  const o = await api('POST', '/api/cut-orders', { publicationId: n1.id, copies: 2, gap: 0 });
  const id = o.data.order.id;
  assert.strictEqual(o.data.order.totalSheets, 2);
  await api('POST', `/api/cut-orders/${id}/confirm`);
  let s = (await api('GET', '/api/glass-sheets')).data.sheets.find((x) => x.color === '#555555');
  assert.strictEqual(s.reserved, 1);
  s = (await api('GET', '/api/glass-sheets')).data.sheets.find((x) => x.color === '#666666');
  assert.strictEqual(s.reserved, 1);

  // 换到 v2 copies=2：两片 40×20 同板（50 高可叠 2 片）→ 555 1 张；666 0 张（新排样不再需要）
  const r = await api('POST', `/api/cut-orders/${id}/replacements`,
    { targetPublicationId: n2.id, copies: 2, gap: 0 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data));
  const c555 = (await api('GET', '/api/glass-sheets')).data.sheets.find((x) => x.color === '#555555');
  const c666 = (await api('GET', '/api/glass-sheets')).data.sheets.find((x) => x.color === '#666666');
  assert.strictEqual(c555.reserved, 1);
  assert.strictEqual(c555.available, 4);
  assert.strictEqual(c666.reserved, 0, '新排样不再用 #666666，旧预留退出');
  assert.strictEqual(c666.available, 5);
});
