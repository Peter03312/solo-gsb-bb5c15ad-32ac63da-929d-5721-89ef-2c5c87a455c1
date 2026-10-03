'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db;

function init(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- 一张图纸（窗框固定）；草稿内容在 pieces 表中就地编辑
    CREATE TABLE IF NOT EXISTS designs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      width_mm    INTEGER NOT NULL CHECK (width_mm  > 0),
      height_mm   INTEGER NOT NULL CHECK (height_mm > 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 草稿拼片：编号在一张图纸内递增且永不复用
    CREATE TABLE IF NOT EXISTS pieces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      piece_no    INTEGER NOT NULL,
      color       TEXT    NOT NULL,
      polygon     TEXT    NOT NULL,           -- JSON [[x,y],...] 整数毫米
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, piece_no)
    );

    -- 发布版：不可变快照，版本号在一张图纸内递增
    CREATE TABLE IF NOT EXISTS publications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      design_id   INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL,
      snapshot    TEXT    NOT NULL,           -- 完整快照 JSON
      published_at TEXT   NOT NULL DEFAULT (datetime('now')),
      UNIQUE (design_id, version)
    );

    -- 铅条原材：一种规格（定尺长度）一行，登记库存根数
    CREATE TABLE IF NOT EXISTS lead_materials (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,    -- 规格名（如“6m 通用铅条”）
      length_h    INTEGER NOT NULL CHECK (length_h > 0),   -- 定尺，整数“厘”（0.01mm）
      stock       INTEGER NOT NULL CHECK (stock >= 0),     -- 库存根数（不会为负）
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 铅条生产计划：草稿不预留库存；confirmed 原子预留；canceled 释放。
    -- 绑定发布快照（publication 不可变）；草稿变化/新版本均不影响已确认计划。
    CREATE TABLE IF NOT EXISTS lead_plans (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      status           TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled')),
      publication_id   INTEGER NOT NULL REFERENCES publications(id),
      design_id        INTEGER NOT NULL,
      version          INTEGER NOT NULL,
      material_id      INTEGER NOT NULL REFERENCES lead_materials(id),
      material_name    TEXT    NOT NULL,       -- 快照：确认时的规格名
      material_length_h INTEGER NOT NULL,      -- 快照：建计划时的定尺（厘）
      copies           INTEGER NOT NULL CHECK (copies > 0),
      kerf_h           INTEGER NOT NULL CHECK (kerf_h >= 0),  -- 每刀损耗（厘）
      required_bars    INTEGER NOT NULL CHECK (required_bars > 0),
      segment_count    INTEGER NOT NULL,
      layout           TEXT    NOT NULL,       -- 切段方案 JSON（毫米，排产结果快照）
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at     TEXT,
      canceled_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pieces_design ON pieces(design_id);
    CREATE INDEX IF NOT EXISTS idx_pub_design    ON publications(design_id);
    CREATE INDEX IF NOT EXISTS idx_plans_status  ON lead_plans(status);
    CREATE INDEX IF NOT EXISTS idx_plans_pub     ON lead_plans(publication_id);
    CREATE INDEX IF NOT EXISTS idx_plans_mat     ON lead_plans(material_id);

    -- 彩色玻璃原片：每种颜色一行规格（宽×高，整数毫米 1–2000）+ 库存张数
    CREATE TABLE IF NOT EXISTS glass_sheets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      color       TEXT    NOT NULL UNIQUE,        -- 归一化小写 #rrggbb
      width_mm    INTEGER NOT NULL CHECK (width_mm  BETWEEN 1 AND 2000),
      height_mm   INTEGER NOT NULL CHECK (height_mm BETWEEN 1 AND 2000),
      stock       INTEGER NOT NULL CHECK (stock >= 0),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 裁片订单：草稿不占库存；confirmed 原子预留各色原片；canceled 释放；replaced 换单退出预留。
    -- 绑定发布快照（publication 不可变）；草稿变化/再发布不影响已确认订单。
    -- 换单成功后旧单置为 replaced（退出预留、不可再取消/修改/删除），新单同事务确认。
    CREATE TABLE IF NOT EXISTS cut_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      status        TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled','replaced')),
      publication_id INTEGER NOT NULL REFERENCES publications(id),
      design_id     INTEGER NOT NULL,
      version       INTEGER NOT NULL,
      copies        INTEGER NOT NULL CHECK (copies > 0),
      gap_mm        INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      total_sheets  INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
      layout        TEXT    NOT NULL,             -- 完整排样方案 JSON（含逐张放置坐标/轮廓）
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_at  TEXT,
      canceled_at   TEXT,
      replaced_at   TEXT                           -- 换单退出预留时间（replaced 单专属）
    );

    -- 订单分色明细：确认时按色预留 required_sheets 张（原子）。
    -- sheet_color/width_mm/height_mm 为建单时快照；规格宽高属于身份不可改。
    CREATE TABLE IF NOT EXISTS cut_order_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL REFERENCES cut_orders(id) ON DELETE CASCADE,
      sheet_id        INTEGER NOT NULL REFERENCES glass_sheets(id),
      sheet_color     TEXT    NOT NULL,
      sheet_width_mm  INTEGER NOT NULL,
      sheet_height_mm INTEGER NOT NULL,
      required_sheets INTEGER NOT NULL CHECK (required_sheets > 0)
    );

    CREATE INDEX IF NOT EXISTS idx_cutorders_status ON cut_orders(status);
    CREATE INDEX IF NOT EXISTS idx_cutorders_pub    ON cut_orders(publication_id);
    CREATE INDEX IF NOT EXISTS idx_cutitems_sheet   ON cut_order_items(sheet_id);
    CREATE INDEX IF NOT EXISTS idx_cutitems_order   ON cut_order_items(order_id);

    -- 裁片换单记录：一次“已确认旧单 → 同一图纸另一已发布版本的新单”。
    -- 旧单退出预留置为 replaced，新单在同一事务内创建并确认；同一旧单仅一条记录（幂等键）。
    CREATE TABLE IF NOT EXISTS cut_order_replacements (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      old_order_id      INTEGER NOT NULL UNIQUE REFERENCES cut_orders(id),
      new_order_id      INTEGER NOT NULL UNIQUE REFERENCES cut_orders(id),
      old_publication_id INTEGER NOT NULL,
      new_publication_id INTEGER NOT NULL,
      copies            INTEGER NOT NULL CHECK (copies > 0),
      gap_mm            INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
      -- 幂等参数签名：同一旧单相同新发布版/件数/间距重复确认返回同一新单
      param_signature   TEXT    NOT NULL,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cutrepl_new ON cut_order_replacements(new_order_id);
  `);

  // 旧版数据库迁移：补 replaced 状态与 replaced_at 列（CHECK 约束变更需重建表）。
  migrateCutOrders();
  return db;
}

// 检测并迁移旧 schema 的 cut_orders：新增 replaced 状态与 replaced_at 列。
// SQLite 不能直接改 CHECK，采用 12 步表重建（外键关闭/恢复、数据复制、序列保留）。
function migrateCutOrders() {
  const d = getDb();
  const cols = d.prepare("PRAGMA table_info(cut_orders)").all();
  const statusCheck = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cut_orders'").get();
  const hasReplacedAt = cols.some((c) => c.name === 'replaced_at');
  const allowsReplaced = !!statusCheck && /replaced/.test(statusCheck.sql);
  if (hasReplacedAt && allowsReplaced) return;

  d.pragma('foreign_keys = OFF');
  d.exec('BEGIN');
  try {
    d.exec(`
      CREATE TABLE cut_orders_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        status        TEXT    NOT NULL CHECK (status IN ('draft','confirmed','canceled','replaced')),
        publication_id INTEGER NOT NULL REFERENCES publications(id),
        design_id     INTEGER NOT NULL,
        version       INTEGER NOT NULL,
        copies        INTEGER NOT NULL CHECK (copies > 0),
        gap_mm        INTEGER NOT NULL CHECK (gap_mm BETWEEN 0 AND 50),
        total_sheets  INTEGER NOT NULL CHECK (total_sheets BETWEEN 1 AND 60),
        layout        TEXT    NOT NULL,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        confirmed_at  TEXT,
        canceled_at   TEXT,
        replaced_at   TEXT
      );
    `);
    const colList = cols.map((c) => c.name).join(', ');
    d.exec(`INSERT INTO cut_orders_new (${colList}) SELECT ${colList} FROM cut_orders`);
    d.exec('DROP TABLE cut_orders');
    d.exec('ALTER TABLE cut_orders_new RENAME TO cut_orders');
    d.exec(`
      CREATE INDEX IF NOT EXISTS idx_cutorders_status ON cut_orders(status);
      CREATE INDEX IF NOT EXISTS idx_cutorders_pub    ON cut_orders(publication_id);
    `);
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    d.pragma('foreign_keys = ON');
    throw e;
  }
  d.pragma('foreign_keys = ON');
}

function getDb() {
  if (!db) throw new Error('数据库未初始化');
  return db;
}

// ---------- designs ----------

function createDesign({ name, width, height }) {
  const info = getDb()
    .prepare('INSERT INTO designs (name, width_mm, height_mm) VALUES (?, ?, ?)')
    .run(name, width, height);
  return getDesign(info.lastInsertRowid);
}

function getDesign(id) {
  return getDb().prepare('SELECT * FROM designs WHERE id = ?').get(id);
}

function listDesigns() {
  return getDb().prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM pieces p WHERE p.design_id = d.id) AS piece_count,
      (SELECT MAX(version) FROM publications pu WHERE pu.design_id = d.id) AS latest_version
    FROM designs d ORDER BY d.id
  `).all();
}

// ---------- pieces ----------

function rowToPiece(row) {
  return {
    id: row.id,
    pieceNo: row.piece_no,
    color: row.color,
    polygon: JSON.parse(row.polygon),
    createdAt: row.created_at,
  };
}

function listPieces(designId) {
  return getDb()
    .prepare('SELECT * FROM pieces WHERE design_id = ? ORDER BY piece_no')
    .all(designId)
    .map(rowToPiece);
}

function getPiece(designId, pieceId) {
  const row = getDb()
    .prepare('SELECT * FROM pieces WHERE id = ? AND design_id = ?')
    .get(pieceId, designId);
  return row ? rowToPiece(row) : null;
}

function nextPieceNo(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(piece_no), 0) + 1 AS n FROM pieces WHERE design_id = ?')
    .get(designId);
  return row.n;
}

function addPiece(designId, { color, polygon }) {
  const pieceNo = nextPieceNo(designId);
  const info = getDb()
    .prepare('INSERT INTO pieces (design_id, piece_no, color, polygon) VALUES (?, ?, ?, ?)')
    .run(designId, pieceNo, color, JSON.stringify(polygon));
  touchDesign(designId);
  return getPiece(designId, info.lastInsertRowid);
}

function updatePiece(designId, pieceId, { color, polygon }) {
  const existing = getPiece(designId, pieceId);
  if (!existing) return null;
  getDb().prepare('UPDATE pieces SET color = ?, polygon = ? WHERE id = ? AND design_id = ?')
    .run(color, JSON.stringify(polygon), pieceId, designId);
  touchDesign(designId);
  return getPiece(designId, pieceId);
}

function deletePiece(designId, pieceId) {
  const info = getDb()
    .prepare('DELETE FROM pieces WHERE id = ? AND design_id = ?')
    .run(pieceId, designId);
  if (info.changes) touchDesign(designId);
  return info.changes > 0;
}

function replaceAllPieces(designId, pieces) {
  // 目前未使用；保留以便整单导入
  const tx = getDb().transaction((rows) => {
    getDb().prepare('DELETE FROM pieces WHERE design_id = ?').run(designId);
    for (const pc of rows) addPiece(designId, pc);
  });
  tx(pieces);
}

function touchDesign(designId) {
  getDb().prepare("UPDATE designs SET updated_at = datetime('now') WHERE id = ?").run(designId);
}

// ---------- publications ----------

function publishVersion(designId, snapshot) {
  const next = nextVersion(designId);
  const info = getDb()
    .prepare('INSERT INTO publications (design_id, version, snapshot) VALUES (?, ?, ?)')
    .run(designId, next, JSON.stringify(snapshot));
  return getPublication(designId, info.lastInsertRowid);
}

function nextVersion(designId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publications WHERE design_id = ?')
    .get(designId);
  return row.v;
}

function getPublication(designId, pubId) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE id = ? AND design_id = ?')
    .get(pubId, designId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function getPublicationByVersion(designId, version) {
  const row = getDb()
    .prepare('SELECT * FROM publications WHERE design_id = ? AND version = ?')
    .get(designId, version);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function listPublications(designId) {
  return getDb()
    .prepare('SELECT id, version, published_at FROM publications WHERE design_id = ? ORDER BY version DESC')
    .all(designId)
    .map((r) => ({ id: r.id, version: r.version, publishedAt: r.published_at }));
}

// ---------- 铅条原材 ----------

function rowToMaterial(row) {
  return {
    id: row.id,
    name: row.name,
    length: row.length_h / 100,          // 毫米
    stock: row.stock,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 各规格当前已被已确认计划预留的根数
function reservedMap() {
  const rows = getDb()
    .prepare(`SELECT material_id AS id, COALESCE(SUM(required_bars), 0) AS reserved
              FROM lead_plans WHERE status = 'confirmed' GROUP BY material_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.reserved);
  return m;
}

function listMaterials() {
  const reserved = reservedMap();
  return getDb()
    .prepare('SELECT * FROM lead_materials ORDER BY id')
    .all()
    .map((r) => {
      const m = rowToMaterial(r);
      const used = reserved.get(r.id) || 0;
      m.reserved = used;
      m.available = m.stock - used;
      return m;
    });
}

function getMaterialRow(id) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE id = ?').get(id);
}

function getMaterial(id) {
  const row = getMaterialRow(id);
  if (!row) return null;
  const m = rowToMaterial(row);
  const reserved = getDb()
    .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
    .get(id).n;
  m.reserved = reserved;
  m.available = m.stock - reserved;
  return m;
}

function getMaterialByName(name) {
  return getDb().prepare('SELECT * FROM lead_materials WHERE name = ?').get(name) || null;
}

function createMaterial({ name, lengthH, stock }) {
  const info = getDb()
    .prepare('INSERT INTO lead_materials (name, length_h, stock) VALUES (?, ?, ?)')
    .run(name, lengthH, stock);
  return getMaterial(info.lastInsertRowid);
}

// 仅允许改名称与库存根数（定尺属于规格身份，改定尺请新建规格）。
// 库存校验在事务中完成：不得小于已预留根数，库存永不为负由 CHECK 兜底。
function updateMaterial(id, { name, stock }) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getMaterialRow(id);
    if (!row) return { code: 'not_found' };
    const reserved = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(id).n;
    if (stock !== undefined && stock < reserved) {
      return { code: 'stock_below_reserved', reserved };
    }
    if (name !== undefined) {
      const dup = d.prepare('SELECT id FROM lead_materials WHERE name = ? AND id <> ?').get(name, id);
      if (dup) return { code: 'name_taken' };
      d.prepare("UPDATE lead_materials SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    }
    if (stock !== undefined) {
      d.prepare("UPDATE lead_materials SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(stock, id);
    }
    return { code: 'ok', material: getMaterial(id) };
  });
  return txn.immediate();
}

// ---------- 铅条生产计划 ----------

function getPublicationById(pubId) {
  const row = getDb().prepare('SELECT * FROM publications WHERE id = ?').get(pubId);
  return row ? {
    id: row.id,
    designId: row.design_id,
    version: row.version,
    publishedAt: row.published_at,
    snapshot: JSON.parse(row.snapshot),
  } : null;
}

function createPlan(p) {
  const info = getDb()
    .prepare(`INSERT INTO lead_plans
      (name, status, publication_id, design_id, version, material_id, material_name,
       material_length_h, copies, kerf_h, required_bars, segment_count, layout)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout));
  return getPlan(info.lastInsertRowid);
}

function getPlanRow(id) {
  return getDb().prepare('SELECT * FROM lead_plans WHERE id = ?').get(id);
}

function rowToPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    materialId: row.material_id,
    materialName: row.material_name,
    materialLength: row.material_length_h / 100,
    copies: row.copies,
    kerf: row.kerf_h / 100,
    requiredBars: row.required_bars,
    segmentCount: row.segment_count,
    layout: JSON.parse(row.layout),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    canceledAt: row.canceled_at || null,
  };
}

function getPlan(id) {
  return rowToPlan(getPlanRow(id));
}

function listPlans() {
  return getDb().prepare('SELECT * FROM lead_plans ORDER BY id DESC').all().map(rowToPlan);
}

function updatePlanDraft(id, p) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status !== 'draft') return { code: 'not_draft', status: row.status };
  getDb()
    .prepare(`UPDATE lead_plans SET
       name = ?, publication_id = ?, design_id = ?, version = ?, material_id = ?,
       material_name = ?, material_length_h = ?, copies = ?, kerf_h = ?,
       required_bars = ?, segment_count = ?, layout = ?, updated_at = datetime('now')
     WHERE id = ?`)
    .run(p.name, p.publicationId, p.designId, p.version, p.materialId,
      p.materialName, p.materialLengthH, p.copies, p.kerfH, p.requiredBars,
      p.segmentCount, JSON.stringify(p.layout), id);
  return { code: 'ok', plan: getPlan(id) };
}

// 确认：原子预留库存。BEGIN IMMEDIATE 取写锁，保证多个计划并发确认绝不超卖。
function confirmPlan(id) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getPlanRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'already_confirmed' }; }
    if (row.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'plan_canceled' }; }

    const mat = getMaterialRow(row.material_id);
    if (!mat) { d.exec('ROLLBACK'); return { code: 'material_missing' }; }
    // 规格定尺在建计划后被改动属于不支持的身份变更（当前接口禁止改定尺），双保险
    if (mat.length_h !== row.material_length_h) {
      d.exec('ROLLBACK'); return { code: 'material_changed' };
    }
    const reserved = d
      .prepare("SELECT COALESCE(SUM(required_bars),0) AS n FROM lead_plans WHERE material_id = ? AND status = 'confirmed'")
      .get(row.material_id).n;
    const available = mat.stock - reserved;
    if (row.required_bars > available) {
      d.exec('ROLLBACK');
      return { code: 'shortage', available, required: row.required_bars, shortage: row.required_bars - available };
    }
    d.prepare(`UPDATE lead_plans
      SET status = 'confirmed', material_name = ?, confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'`).run(mat.name, id);
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消：只有已确认计划会释放预留；重复取消不会再次改变库存。
function cancelPlan(id) {
  const d = getDb();
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'draft') return { code: 'draft_not_reserved' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(`UPDATE lead_plans
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', plan: getPlan(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function deletePlan(id) {
  const row = getPlanRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  getDb().prepare('DELETE FROM lead_plans WHERE id = ?').run(id);
  return { code: 'ok' };
}

// ---------- 彩色玻璃原片 ----------

function rowToGlassSheet(row, reserved = 0) {
  return {
    id: row.id,
    color: row.color,
    width: row.width_mm,
    height: row.height_mm,
    stock: row.stock,
    reserved,
    available: row.stock - reserved,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 各颜色已被已确认订单预留的张数
function glassReservedMap() {
  const rows = getDb()
    .prepare(`SELECT i.sheet_id AS id, COALESCE(SUM(i.required_sheets), 0) AS reserved
              FROM cut_order_items i
              JOIN cut_orders o ON o.id = i.order_id
              WHERE o.status = 'confirmed'
              GROUP BY i.sheet_id`)
    .all();
  const m = new Map();
  for (const r of rows) m.set(r.id, r.reserved);
  return m;
}

function listGlassSheets() {
  const reserved = glassReservedMap();
  return getDb().prepare('SELECT * FROM glass_sheets ORDER BY color').all()
    .map((r) => rowToGlassSheet(r, reserved.get(r.id) || 0));
}

// 以颜色键取规格（含库存视图）
function glassSheetMapByColor() {
  const m = new Map();
  for (const s of listGlassSheets()) m.set(s.color, s);
  return m;
}

function getGlassSheetRow(id) {
  return getDb().prepare('SELECT * FROM glass_sheets WHERE id = ?').get(id);
}

function getGlassSheetByColorRow(color) {
  return getDb().prepare('SELECT * FROM glass_sheets WHERE color = ?').get(color);
}

function getGlassSheet(id) {
  const row = getGlassSheetRow(id);
  if (!row) return null;
  const reserved = getDb()
    .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
              FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
              WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(id).n;
  return rowToGlassSheet(row, reserved);
}

function createGlassSheet({ color, width, height, stock }) {
  const info = getDb()
    .prepare('INSERT INTO glass_sheets (color, width_mm, height_mm, stock) VALUES (?, ?, ?, ?)')
    .run(color, width, height, stock);
  return getGlassSheet(info.lastInsertRowid);
}

// 仅允许调整库存张数（颜色/宽高均属规格身份）；库存不得低于已确认订单预留。
function updateGlassSheetStock(id, stock) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getGlassSheetRow(id);
    if (!row) return { code: 'not_found' };
    const reserved = d
      .prepare(`SELECT COALESCE(SUM(i.required_sheets),0) AS n
                FROM cut_order_items i JOIN cut_orders o ON o.id = i.order_id
                WHERE i.sheet_id = ? AND o.status = 'confirmed'`).get(id).n;
    if (stock < reserved) return { code: 'stock_below_reserved', reserved };
    d.prepare("UPDATE glass_sheets SET stock = ?, updated_at = datetime('now') WHERE id = ?").run(stock, id);
    return { code: 'ok', sheet: getGlassSheet(id) };
  });
  return txn.immediate();
}

// ---------- 裁片订单 ----------

function rowToCutOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    publicationId: row.publication_id,
    designId: row.design_id,
    version: row.version,
    copies: row.copies,
    gap: row.gap_mm,
    totalSheets: row.total_sheets,
    layout: JSON.parse(row.layout),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at || null,
    canceledAt: row.canceled_at || null,
    replacedAt: row.replaced_at || null,
  };
}

function getCutOrderRow(id) {
  return getDb().prepare('SELECT * FROM cut_orders WHERE id = ?').get(id);
}

function getCutOrder(id) {
  return rowToCutOrder(getCutOrderRow(id));
}

function listCutOrders() {
  return getDb().prepare('SELECT * FROM cut_orders ORDER BY id DESC').all().map(rowToCutOrder);
}

function listCutOrderItems(orderId) {
  return getDb().prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(orderId)
    .map((r) => ({
      sheetId: r.sheet_id,
      color: r.sheet_color,
      sheetWidth: r.sheet_width_mm,
      sheetHeight: r.sheet_height_mm,
      requiredSheets: r.required_sheets,
    }));
}

// 建草稿订单。items: [{sheetId,color,width,height,requiredSheets}]
function createCutOrder(o) {
  const d = getDb();
  const txn = d.transaction(() => {
    const info = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout)
      VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.name, o.publicationId, o.designId, o.version, o.copies, o.gap,
        o.totalSheets, JSON.stringify(o.layout));
    const id = info.lastInsertRowid;
    const ins = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      ins.run(id, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }
    return id;
  });
  const id = txn();
  return getCutOrder(id);
}

function updateCutOrderDraft(id, o) {
  const d = getDb();
  const txn = d.transaction(() => {
    const row = getCutOrderRow(id);
    if (!row) return { code: 'not_found' };
    if (row.status !== 'draft') return { code: 'not_draft', status: row.status };
    d.prepare(`UPDATE cut_orders SET
       name = ?, publication_id = ?, design_id = ?, version = ?, copies = ?, gap_mm = ?,
       total_sheets = ?, layout = ?, updated_at = datetime('now')
     WHERE id = ?`)
      .run(o.name, o.publicationId, o.designId, o.version, o.copies, o.gap,
        o.totalSheets, JSON.stringify(o.layout), id);
    d.prepare('DELETE FROM cut_order_items WHERE order_id = ?').run(id);
    const ins = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      ins.run(id, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }
    return { code: 'ok', order: getCutOrder(id) };
  });
  return txn();
}

// 确认：在一个 BEGIN IMMEDIATE 事务中逐色核对并原子预留，任一颜色不足则整单失败。
function confirmCutOrder(id) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const row = getCutOrderRow(id);
    if (!row) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (row.status === 'confirmed') { d.exec('ROLLBACK'); return { code: 'already_confirmed' }; }
    if (row.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'order_canceled' }; }

    const items = d.prepare('SELECT * FROM cut_order_items WHERE order_id = ? ORDER BY id').all(id);
    const shortages = [];
    for (const it of items) {
      const sheet = getGlassSheetRow(it.sheet_id);
      if (!sheet) {
        d.exec('ROLLBACK');
        return { code: 'sheet_missing', color: it.sheet_color };
      }
      // 宽高身份双保险
      if (sheet.width_mm !== it.sheet_width_mm || sheet.height_mm !== it.sheet_height_mm) {
        d.exec('ROLLBACK');
        return { code: 'sheet_changed', color: it.sheet_color };
      }
      const reserved = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed'`).get(it.sheet_id).n;
      const available = sheet.stock - reserved;
      if (it.required_sheets > available) {
        shortages.push({
          color: it.sheet_color,
          required: it.required_sheets,
          available,
          shortage: it.required_sheets - available,
        });
      }
    }
    if (shortages.length) {
      d.exec('ROLLBACK');
      return { code: 'shortage', shortages };
    }
    d.prepare(`UPDATE cut_orders
      SET status = 'confirmed', confirmed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'draft'`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// 取消：只有已确认订单释放预留；重复取消不会再次改库存。
// replaced（已替换）单不能取消（其预留已在换单事务中转给新单）。
function cancelCutOrder(id) {
  const d = getDb();
  const row = getCutOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'replaced') return { code: 'replaced_locked' };
  if (row.status === 'draft') return { code: 'draft_not_reserved' };
  if (row.status === 'canceled') return { code: 'already_canceled' };
  d.exec('BEGIN IMMEDIATE');
  try {
    d.prepare(`UPDATE cut_orders
      SET status = 'canceled', canceled_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(id);
    d.exec('COMMIT');
    return { code: 'ok', order: getCutOrder(id) };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function deleteCutOrder(id) {
  const row = getCutOrderRow(id);
  if (!row) return { code: 'not_found' };
  if (row.status === 'confirmed') return { code: 'confirmed_delete_blocked' };
  if (row.status === 'replaced') return { code: 'replaced_locked' };
  getDb().prepare('DELETE FROM cut_orders WHERE id = ?').run(id); // 子表 ON DELETE CASCADE
  return { code: 'ok' };
}

// ---------- 裁片订单换单 ----------

function getReplacementByOldOrder(oldOrderId) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM cut_order_replacements WHERE old_order_id = ?').get(oldOrderId);
  if (!row) return null;
  return {
    id: row.id,
    oldOrderId: row.old_order_id,
    newOrderId: row.new_order_id,
    oldPublicationId: row.old_publication_id,
    newPublicationId: row.new_publication_id,
    copies: row.copies,
    gap: row.gap_mm,
    paramSignature: row.param_signature,
    createdAt: row.created_at,
  };
}

function getReplacementByNewOrder(newOrderId) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM cut_order_replacements WHERE new_order_id = ?').get(newOrderId);
  if (!row) return null;
  return {
    id: row.id,
    oldOrderId: row.old_order_id,
    newOrderId: row.new_order_id,
    oldPublicationId: row.old_publication_id,
    newPublicationId: row.new_publication_id,
    copies: row.copies,
    gap: row.gap_mm,
    paramSignature: row.param_signature,
    createdAt: row.created_at,
  };
}

// 换单参数签名（幂等键的一部分）：新发布版 id + 件数 + 间距
function replacementSignature({ newPublicationId, copies, gap }) {
  return `pub=${newPublicationId};copies=${copies};gap=${gap}`;
}

// 换单：同一 BEGIN IMMEDIATE 事务内让旧单退出预留（replaced），
// 并创建、确认绑定新发布版快照的新单。任一颜色库存不足则整事务回滚，
// 旧单状态、库存、订单记录均保持原状，并返回各色缺口。
//
// 幂等：同一旧单已有换单记录时：
//   - 参数签名相同 → 返回 { code:'idempotent', replacement }（不重复预留）
//   - 参数签名不同 → 返回 { code:'param_conflict', replacement }
function replaceCutOrder(oldId, o) {
  const d = getDb();
  const sig = replacementSignature({
    newPublicationId: o.publicationId,
    copies: o.copies,
    gap: o.gap,
  });
  d.exec('BEGIN IMMEDIATE');
  try {
    const existing = d.prepare('SELECT * FROM cut_order_replacements WHERE old_order_id = ?').get(oldId);
    if (existing) {
      d.exec('ROLLBACK');
      if (existing.param_signature === sig) {
        return { code: 'idempotent', replacement: getReplacementByOldOrder(oldId) };
      }
      return { code: 'param_conflict', replacement: getReplacementByOldOrder(oldId) };
    }

    const oldRow = getCutOrderRow(oldId);
    if (!oldRow) { d.exec('ROLLBACK'); return { code: 'not_found' }; }
    if (oldRow.status === 'replaced') {
      // 理论上有 replacement 记录即上面已返回；双保险
      d.exec('ROLLBACK');
      return { code: 'already_replaced' };
    }
    if (oldRow.status === 'canceled') { d.exec('ROLLBACK'); return { code: 'order_canceled' }; }
    if (oldRow.status === 'draft') { d.exec('ROLLBACK'); return { code: 'draft_not_confirmed' }; }

    const shortages = [];
    for (const it of o.items) {
      const sheet = getGlassSheetRow(it.sheetId);
      if (!sheet) {
        d.exec('ROLLBACK');
        return { code: 'sheet_missing', color: it.color };
      }
      if (sheet.width_mm !== it.width || sheet.height_mm !== it.height) {
        d.exec('ROLLBACK');
        return { code: 'sheet_changed', color: it.color };
      }
      // 当前已确认预留总量；旧单即将退出，其预留（按色）计入新单可用量
      const reservedNow = d
        .prepare(`SELECT COALESCE(SUM(ci.required_sheets),0) AS n
                  FROM cut_order_items ci JOIN cut_orders co ON co.id = ci.order_id
                  WHERE ci.sheet_id = ? AND co.status = 'confirmed'`).get(it.sheetId).n;
      const oldItem = d
        .prepare('SELECT COALESCE(SUM(required_sheets),0) AS n FROM cut_order_items WHERE order_id = ? AND sheet_id = ?')
        .get(oldId, it.sheetId).n;
      const availableAfterRelease = sheet.stock - reservedNow + oldItem;
      if (it.requiredSheets > availableAfterRelease) {
        shortages.push({
          color: it.color,
          required: it.requiredSheets,
          oldUsed: oldItem,
          available: availableAfterRelease,
          shortage: it.requiredSheets - availableAfterRelease,
        });
      }
    }
    if (shortages.length) {
      d.exec('ROLLBACK');
      return { code: 'shortage', shortages };
    }

    // 创建新单（直接置为 confirmed，与旧单退出同一事务）
    const ins = d.prepare(`INSERT INTO cut_orders
      (name, status, publication_id, design_id, version, copies, gap_mm, total_sheets, layout, confirmed_at)
      VALUES (?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
    const info = ins.run(o.name, o.publicationId, o.designId, o.version, o.copies, o.gap,
      o.totalSheets, JSON.stringify(o.layout));
    const newId = info.lastInsertRowid;
    const insItem = d.prepare(`INSERT INTO cut_order_items
      (order_id, sheet_id, sheet_color, sheet_width_mm, sheet_height_mm, required_sheets)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (const it of o.items) {
      insItem.run(newId, it.sheetId, it.color, it.width, it.height, it.requiredSheets);
    }

    // 旧单退出预留
    d.prepare(`UPDATE cut_orders
      SET status = 'replaced', replaced_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND status = 'confirmed'`).run(oldId);

    d.prepare(`INSERT INTO cut_order_replacements
      (old_order_id, new_order_id, old_publication_id, new_publication_id, copies, gap_mm, param_signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(oldId, newId, o.oldPublicationId, o.publicationId, o.copies, o.gap, sig);

    d.exec('COMMIT');
    return {
      code: 'ok',
      replacement: {
        oldOrderId: oldId,
        newOrderId: newId,
        oldPublicationId: o.oldPublicationId,
        newPublicationId: o.publicationId,
        copies: o.copies,
        gap: o.gap,
        paramSignature: sig,
      },
      oldOrder: getCutOrder(oldId),
      newOrder: getCutOrder(newId),
    };
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

module.exports = {
  init, getDb,
  createDesign, getDesign, listDesigns,
  listPieces, getPiece, addPiece, updatePiece, deletePiece, replaceAllPieces,
  publishVersion, getPublication, getPublicationByVersion, getPublicationById, listPublications,
  listMaterials, getMaterial, getMaterialRow, getMaterialByName, createMaterial, updateMaterial,
  createPlan, getPlan, listPlans, updatePlanDraft, confirmPlan, cancelPlan, deletePlan,
  listGlassSheets, glassSheetMapByColor, getGlassSheet, getGlassSheetRow, getGlassSheetByColorRow,
  createGlassSheet, updateGlassSheetStock,
  createCutOrder, getCutOrder, listCutOrders, listCutOrderItems, updateCutOrderDraft,
  confirmCutOrder, cancelCutOrder, deleteCutOrder,
  replaceCutOrder, getReplacementByOldOrder, getReplacementByNewOrder, replacementSignature,
};
