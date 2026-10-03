'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const geo = require('./geometry');
const cut = require('./cutting');
const leadDiff = require('./leaddiff');
const printSheet = require('./printsheet');
const sheetNest = require('./sheetnest');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'studio.db');

db.init(DB_PATH);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 工具 ----------

function fail(res, code, error, extra = {}) {
  return res.status(code).json({ ok: false, error, ...extra });
}

function loadDesignOr404(req, res) {
  const design = db.getDesign(Number(req.params.designId));
  if (!design) {
    fail(res, 404, '图纸不存在');
    return null;
  }
  return design;
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLORS = ['#4C9AFF', '#FFAB00', '#36B37E', '#FF5630', '#6554C0', '#00B8D9', '#FF8B00', '#8FAB1E'];

function parsePolygon(body) {
  const poly = body.polygon;
  if (!Array.isArray(poly)) return { error: 'polygon 必须是 [[x,y],...] 数组' };
  const pts = [];
  for (const p of poly) {
    if (!Array.isArray(p) || p.length !== 2 ||
      !Number.isInteger(p[0]) || !Number.isInteger(p[1])) {
      return { error: '每个顶点必须是两个整数毫米坐标' };
    }
    pts.push([p[0], p[1]]);
  }
  return { polygon: pts };
}

// 汇总草稿：片、面积、覆盖状态、缺口、铅条清单
function draftSummary(design) {
  const rows = db.listPieces(design.id);
  const pieces = rows.map((r) => ({
    id: r.id,
    pieceNo: r.pieceNo,
    color: r.color,
    polygon: r.polygon,
    area: geo.round2(geo.polygonArea(r.polygon)),
  }));
  const analysis = geo.analyzePlan(
    { width: design.width_mm, height: design.height_mm },
    rows.map((r) => ({ id: r.id, polygon: r.polygon })),
  );
  return {
    id: design.id,
    name: design.name,
    width: design.width_mm,
    height: design.height_mm,
    createdAt: design.created_at,
    updatedAt: design.updated_at,
    pieces,
    coverage: {
      covered: analysis.covered,
      gaps: analysis.gaps,
      overlapping: analysis.overlapping,
      totalPieceArea: analysis.totalPieceArea,
      frameArea: design.width_mm * design.height_mm,
    },
    leadList: buildLeadList(analysis),
  };
}

// 铅条下料清单：内部公共边合并极大共线段；外框四根另列
function buildLeadList(analysis) {
  const { width, height, total } = analysis.frameLead;
  return {
    internal: analysis.leadRuns.runs.map((r, i) => ({
      no: i + 1,
      points: r.points,
      length: r.length,
    })),
    internalCount: analysis.leadRuns.count,
    internalTotal: analysis.leadRuns.total,
    frameBars: [
      { name: '上框', from: [0, 0], to: [width, 0], length: geo.round2(width) },
      { name: '下框', from: [0, height], to: [width, height], length: geo.round2(width) },
      { name: '左框', from: [0, 0], to: [0, height], length: geo.round2(height) },
      { name: '右框', from: [width, 0], to: [width, height], length: geo.round2(height) },
    ],
    frameTotal: geo.round2(total),
    grandTotal: geo.round2(analysis.leadRuns.total + total),
  };
}

// 对一次新增/编辑做全部几何校验；通过返回 null，否则返回 422 响应体
function validateEdit(design, candidatePolygon, ignorePieceId) {
  const frame = { width: design.width_mm, height: design.height_mm };

  const self = geo.validatePolygon(candidatePolygon);
  if (!self.ok) {
    return { error: self.reason, category: 'invalid', at: self.at || null };
  }
  const others = db.listPieces(design.id)
    .filter((r) => r.id !== ignorePieceId)
    .map((r) => ({ id: r.id, polygon: r.polygon }));
  // checkAgainstPieces 内部统一做越界（矩形窗框为凸集，顶点在内则边在内）与重叠校验
  const rel = geo.checkAgainstPieces(candidatePolygon, others, frame);
  if (!rel.ok) {
    return {
      error: rel.reason,
      category: 'overlap',
      at: rel.at ? rel.at.slice() : null,
      pieceId: rel.pieceId || null,
    };
  }
  return null;
}

// ---------- 图纸 ----------

app.get('/api/designs', (req, res) => {
  res.json({ ok: true, designs: db.listDesigns() });
});

app.post('/api/designs', (req, res) => {
  const { name } = req.body || {};
  const width = Number(req.body?.width);
  const height = Number(req.body?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return fail(res, 400, '窗框宽高必须是正整数毫米');
  }
  if (width > 100000 || height > 100000) {
    return fail(res, 400, '窗框尺寸过大（上限 100000 毫米）');
  }
  const design = db.createDesign({
    name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : '未命名图纸',
    width, height,
  });
  res.status(201).json({ ok: true, design });
});

app.get('/api/designs/:designId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, draft: draftSummary(design) });
});

// ---------- 草稿拼片 ----------

app.post('/api/designs/:designId/pieces', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  let color = (req.body.color || '').trim();
  if (!color) color = DEFAULT_COLORS[db.listPieces(design.id).length % DEFAULT_COLORS.length];
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, null);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const piece = db.addPiece(design.id, { color, polygon: parsed.polygon });
  res.status(201).json({ ok: true, piece: withArea(piece), draft: draftSummary(db.getDesign(design.id)) });
});

app.put('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pieceId = Number(req.params.pieceId);
  const existing = db.getPiece(design.id, pieceId);
  if (!existing) return fail(res, 404, '拼片不存在');

  const parsed = parsePolygon(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error);
  const color = (req.body.color || '').trim();
  if (!COLOR_RE.test(color)) return fail(res, 400, '颜色必须是 #RRGGBB 形式');

  const problem = validateEdit(design, parsed.polygon, pieceId);
  if (problem) return res.status(422).json({ ok: false, ...problem });

  const updated = db.updatePiece(design.id, pieceId, { color, polygon: parsed.polygon });
  res.json({ ok: true, piece: withArea(updated), draft: draftSummary(db.getDesign(design.id)) });
});

app.delete('/api/designs/:designId/pieces/:pieceId', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const removed = db.deletePiece(design.id, Number(req.params.pieceId));
  if (!removed) return fail(res, 404, '拼片不存在');
  res.json({ ok: true, draft: draftSummary(db.getDesign(design.id)) });
});

function withArea(piece) {
  return { ...piece, area: geo.round2(geo.polygonArea(piece.polygon)) };
}

// ---------- 发布 ----------

app.get('/api/designs/:designId/publications', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  res.json({ ok: true, publications: db.listPublications(design.id) });
});

app.post('/api/designs/:designId/publish', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const summary = draftSummary(design);
  if (summary.pieces.length === 0) {
    return fail(res, 422, '草稿为空，不能发布');
  }
  if (!summary.coverage.covered) {
    return res.status(422).json({
      ok: false,
      error: '草稿未完整覆盖窗框或存在重叠，不能发布',
      category: 'not_covered',
      gaps: summary.coverage.gaps,
      overlapping: summary.coverage.overlapping,
    });
  }
  const snapshot = {
    name: summary.name,
    width: summary.width,
    height: summary.height,
    pieces: summary.pieces,
    leadList: summary.leadList,
    frameArea: summary.coverage.frameArea,
  };
  const pub = db.publishVersion(design.id, snapshot);
  res.status(201).json({ ok: true, publication: pub });
});

// 核对两个发布版的铅条下料差异（只读，不改快照/计划/库存）。
// 结果以较早版为基准：kept 沿用 / removed 较早版取消 / added 较晚版新增。
// 若两版顺序颠倒，自动按版本号交换。
function buildPublicationDiff(pubA, pubB) {
  const [earlier, later] = pubA.version <= pubB.version ? [pubA, pubB] : [pubB, pubA];
  const r = leadDiff.diffPublications(earlier, later);
  if (!r.ok) return { error: r.error, status: 422 };
  return {
    meta: {
      designId: earlier.designId,
      designName: earlier.snapshot.name,
      earlier: { id: earlier.id, version: earlier.version, publishedAt: earlier.publishedAt },
      later: { id: later.id, version: later.version, publishedAt: later.publishedAt },
      width: later.snapshot.width,
      height: later.snapshot.height,
    },
    diff: r.comparison,
  };
}

// GET：同一图纸 + 两个版本号（最易在浏览器/curl 调用）
//   /api/designs/:designId/publications/diff?fromVersion=1&toVersion=2
app.get('/api/designs/:designId/publications/diff', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const fromVersion = Number(req.query.fromVersion);
  const toVersion = Number(req.query.toVersion);
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) ||
      fromVersion <= 0 || toVersion <= 0) {
    return fail(res, 400, 'fromVersion/toVersion 必须是正整数版本号');
  }
  const pubA = db.getPublicationByVersion(design.id, fromVersion);
  if (!pubA) return fail(res, 404, `发布版 v${fromVersion} 不存在`);
  const pubB = db.getPublicationByVersion(design.id, toVersion);
  if (!pubB) return fail(res, 404, `发布版 v${toVersion} 不存在`);
  const built = buildPublicationDiff(pubA, pubB);
  if (built.error) return fail(res, built.status, built.error);
  res.json({ ok: true, ...built });
});

// POST：两个发布版 id（可跨图纸时明确报错）
//   { publicationIdA: 1, publicationIdB: 2 }
app.post('/api/publications/diff', (req, res) => {
  const body = req.body || {};
  const idA = Number(body.publicationIdA);
  const idB = Number(body.publicationIdB);
  if (!Number.isInteger(idA) || !Number.isInteger(idB) || idA <= 0 || idB <= 0) {
    return fail(res, 400, 'publicationIdA/publicationIdB 必须是发布版的正整数 id');
  }
  const pubA = db.getPublicationById(idA);
  if (!pubA) return fail(res, 404, `发布版 id=${idA} 不存在`);
  const pubB = db.getPublicationById(idB);
  if (!pubB) return fail(res, 404, `发布版 id=${idB} 不存在`);
  if (pubA.designId !== pubB.designId) {
    return fail(res, 400, '两个发布版不属于同一图纸，不能核对铅条', {
      designIdA: pubA.designId,
      designIdB: pubB.designId,
    });
  }
  const built = buildPublicationDiff(pubA, pubB);
  if (built.error) return fail(res, built.status, built.error);
  res.json({ ok: true, ...built });
});

// ---------- 已发布图纸 1:1 分张打印（只读，不改草稿/发布版/计划/库存） ----------

// 由版本号加载发布版，不存在时按调用方要求返回 404
function loadVersionOrReject(res, designId, version) {
  const pub = db.getPublicationByVersion(designId, version);
  if (!pub) {
    fail(res, 404, `发布版 v${version} 不存在`);
    return null;
  }
  return pub;
}

// POST /api/designs/:designId/publications/:version/print/preview
//   body: { paperWidth, paperHeight, margin, overlap }（整数毫米）
//   返回行列总页数、每页覆盖的图纸坐标与拼接标记；非法输入整单拒绝，不输出部分页面。
app.post('/api/designs/:designId/publications/:version/print/preview', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version <= 0) return fail(res, 400, '版本号必须是正整数');
  const pub = loadVersionOrReject(res, design.id, version);
  if (!pub) return;
  const pr = printSheet.parseParams(req.body || {});
  if (!pr.ok) {
    return res.status(pr.status).json({ ok: false, error: pr.error, code: pr.code });
  }
  const built = printSheet.buildLayout(pub.snapshot, pr.params);
  if (!built.ok) {
    return res.status(built.status).json({
      ok: false, error: built.error, code: built.code,
      cols: built.cols, rows: built.rows, totalPages: built.totalPages, maxPages: built.maxPages,
    });
  }
  res.json({
    ok: true,
    preview: {
      designId: design.id,
      designName: pub.snapshot.name,
      version,
      publicationId: pub.id,
      print: printSheet.serializePreview(design.id, version, built.layout),
    },
  });
});

// GET /api/designs/:designId/publications/:version/print/page
//   query: paperWidth,paperHeight,margin,overlap,page（与预览相同的整数毫米参数）
//   返回该页 SVG（image/svg+xml，物理尺寸 mm）。
app.get('/api/designs/:designId/publications/:version/print/page', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version <= 0) return fail(res, 400, '版本号必须是正整数');
  const pub = loadVersionOrReject(res, design.id, version);
  if (!pub) return;
  const q = req.query || {};
  const pr = printSheet.parseParams({
    paperWidth: Number(q.paperWidth), paperHeight: Number(q.paperHeight),
    margin: Number(q.margin), overlap: Number(q.overlap),
  });
  if (!pr.ok) {
    return res.status(pr.status).json({ ok: false, error: pr.error, code: pr.code });
  }
  const built = printSheet.buildLayout(pub.snapshot, pr.params);
  if (!built.ok) {
    return res.status(built.status).json({
      ok: false, error: built.error, code: built.code,
      cols: built.cols, rows: built.rows, totalPages: built.totalPages, maxPages: built.maxPages,
    });
  }
  const pageNo = Number(q.page);
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > built.layout.totalPages) {
    return fail(res, 400, `页码必须是 1–${built.layout.totalPages} 之间的整数`);
  }
  const page = built.layout.pages.find((p) => p.page === pageNo);
  const svg = printSheet.pageSvg(pub, pr.params, page);
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // 文件名仅用 ASCII（图纸名可能含中文/特殊字符）
  res.setHeader('Content-Disposition',
    `inline; filename="design-${design.id}-v${version}-page-${pageNo}of${built.layout.totalPages}.svg"`);
  res.send(svg);
});

app.get('/api/designs/:designId/publications/:version', (req, res) => {
  const design = loadDesignOr404(req, res);
  if (!design) return;
  const pub = db.getPublicationByVersion(design.id, Number(req.params.version));
  if (!pub) return fail(res, 404, '发布版不存在');
  res.json({ ok: true, publication: pub });
});

// ---------- 铅条原材库存 ----------

const MATERIAL_NAME_MAX = 80;

app.get('/api/materials', (req, res) => {
  res.json({ ok: true, materials: db.listMaterials() });
});

app.get('/api/materials/:materialId', (req, res) => {
  const material = db.getMaterial(Number(req.params.materialId));
  if (!material) return fail(res, 404, '原材规格不存在');
  res.json({ ok: true, material });
});

app.post('/api/materials', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return fail(res, 400, '规格名称必填');
  if (name.length > MATERIAL_NAME_MAX) return fail(res, 400, `规格名称不得超过 ${MATERIAL_NAME_MAX} 字`);
  const len = cut.parseLen2(Number(body.length), { name: '原材定尺', positive: true });
  if (!len.ok) return fail(res, 400, len.error);
  const stock = cut.parseNonNegInt(Number(body.stock), { name: '库存根数', max: 1e9 });
  if (!stock.ok) return fail(res, 400, stock.error);
  if (db.getMaterialByName(name)) return fail(res, 409, '同名规格已存在');
  const material = db.createMaterial({ name, lengthH: len.h, stock: stock.n });
  res.status(201).json({ ok: true, material });
});

// 修改规格名/库存根数（定尺不可改）。库存不得小于已预留根数。
app.patch('/api/materials/:materialId', (req, res) => {
  const material = db.getMaterial(Number(req.params.materialId));
  if (!material) return fail(res, 404, '原材规格不存在');
  const body = req.body || {};
  const fields = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail(res, 400, '规格名称必填');
    if (name.length > MATERIAL_NAME_MAX) return fail(res, 400, `规格名称不得超过 ${MATERIAL_NAME_MAX} 字`);
    fields.name = name;
  }
  if (body.stock !== undefined) {
    const stock = cut.parseNonNegInt(Number(body.stock), { name: '库存根数', max: 1e9 });
    if (!stock.ok) return fail(res, 400, stock.error);
    fields.stock = stock.n;
  }
  if (body.length !== undefined) {
    return fail(res, 400, '定尺属于规格身份不可修改；请新建规格');
  }
  if (!('name' in fields) && !('stock' in fields)) {
    return fail(res, 400, '没有可更新字段（name 或 stock）');
  }
  const r = db.updateMaterial(material.id, fields);
  if (r.code === 'name_taken') return fail(res, 409, '同名规格已存在');
  if (r.code === 'stock_below_reserved') {
    return fail(res, 409, `库存不得小于已确认计划预留根数（${r.reserved}）`, { reserved: r.reserved });
  }
  res.json({ ok: true, material: r.material });
});

// ---------- 铅条生产计划 ----------

const PLAN_NAME_MAX = 80;
const COPIES_MAX = 10000;

// 解析并校验排产参数；返回 { error }（HTTP 层据此拒绝，且绝不改库存）或 { pub, material, copies, kerfH }
function resolvePlanInputs(body) {
  const publicationId = Number(body.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return { error: 'publicationId 必须是已发布版本的正整数 id' };
  }
  const pub = db.getPublicationById(publicationId);
  if (!pub) return { error: '发布版不存在', status: 404 };

  const materialId = Number(body.materialId);
  if (!Number.isInteger(materialId) || materialId <= 0) {
    return { error: 'materialId 必须是原材规格的正整数 id' };
  }
  const material = db.getMaterial(materialId);
  if (!material) return { error: '原材规格不存在', status: 404 };
  // 精确定尺（整数厘）取自数据库原始行，不走毫米浮点往返
  const materialRow = db.getMaterialRow(materialId);
  material.lengthH = materialRow.length_h;

  const copiesR = cut.parsePositiveInt(Number(body.copies), { name: '件数', max: COPIES_MAX });
  if (!copiesR.ok) return { error: copiesR.error };

  const kerfR = cut.parseLen2(Number(body.kerf), { name: '每刀损耗', positive: false });
  if (!kerfR.ok) return { error: kerfR.error };

  return { pub, material, copies: copiesR.n, kerfH: kerfR.h };
}

// 依据发布快照 + 参数生成切段方案（长度均换算为毫米输出，不访问/修改库存计数）
function buildPlanLayout({ pub, material, copies, kerfH }) {
  const segs = cut.segmentsFromSnapshot(pub.snapshot);
  if (!segs.ok) return { error: segs.error };
  const result = cut.planCuts({
    segments: segs.segments,
    copies,
    stockLenH: material.lengthH,
    kerfH,
  });
  if (!result.ok) {
    if (result.code === 'segment_too_long') {
      return {
        error: result.error,
        status: 422,
        code: result.code,
        segment: serializeSegmentBrief(result.segment, kerfH),
      };
    }
    return { error: result.error, status: 400, code: result.code };
  }
  return { layout: serializeLayout(result, material) };
}

function serializeSegmentBrief(seg, kerfH) {
  return {
    name: seg.name,
    source: seg.source,
    length: cut.hToMm(seg.lengthH),
    withKerf: cut.hToMm(seg.lengthH + kerfH),
  };
}

function serializeLayout(result, material) {
  const kerfH = result.segmentCount ? result.totalKerfH / result.segmentCount : 0;
  return {
    materialLength: cut.hToMm(material.lengthH),
    kerf: cut.hToMm(kerfH),
    segmentCount: result.segmentCount,
    requiredBars: result.requiredBars,
    totals: {
      segmentCount: result.segmentCount,
      finishedLength: cut.hToMm(result.totalFinishedH),
      kerfTotal: cut.hToMm(result.totalKerfH),
      remainderTotal: cut.hToMm(result.totalRemainderH),
    },
    bars: result.bars.map((b) => ({
      index: b.index,
      usedLength: cut.hToMm(b.usedH),
      remainder: cut.hToMm(b.remainderH),
      cuts: b.cuts.map((c) => ({
        piece: c.piece,
        source: c.source,
        sourceNo: c.sourceNo,
        name: c.name,
        length: cut.hToMm(c.lengthH),
        kerf: cut.hToMm(c.kerfH),
        from: c.from,
        to: c.to,
      })),
    })),
  };
}

// 预览（POST /api/plans/preview）：不落库、不预留
app.post('/api/plans/preview', (req, res) => {
  const body = req.body || {};
  const inp = resolvePlanInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const material = db.getMaterial(inp.material.id); // 取最新 stock/reserved/available
  const shortage = Math.max(0, built.layout.requiredBars - material.available);
  res.json({
    ok: true,
    preview: {
      publicationId: inp.pub.id,
      designId: inp.pub.designId,
      version: inp.pub.version,
      copies: inp.copies,
      kerf: cut.hToMm(inp.kerfH),
      material: materialBrief(material),
      layout: built.layout,
      requiredBars: built.layout.requiredBars,
      availableBars: material.available,
      shortage,
      feasible: shortage === 0,
    },
  });
});

// 建草稿计划
app.post('/api/plans', (req, res) => {
  const body = req.body || {};
  const inp = resolvePlanInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, PLAN_NAME_MAX)
    : `v${inp.pub.version} ×${inp.copies}件 · ${inp.material.name}`;
  const plan = db.createPlan({
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    materialId: inp.material.id,
    materialName: inp.material.name,
    materialLengthH: inp.material.lengthH,
    copies: inp.copies,
    kerfH: inp.kerfH,
    requiredBars: built.layout.requiredBars,
    segmentCount: built.layout.segmentCount,
    layout: built.layout,
  });
  res.status(201).json({ ok: true, plan: serializePlan(plan) });
});

app.get('/api/plans', (req, res) => {
  res.json({ ok: true, plans: db.listPlans().map(serializePlan) });
});

app.get('/api/plans/:planId', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  res.json({ ok: true, plan: serializePlan(plan) });
});

// 修改草稿（重新选版本/件数/原材/刀损并重算切段）
app.put('/api/plans/:planId', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  if (plan.status !== 'draft') {
    return fail(res, 409, `仅草稿计划可修改（当前为 ${statusZh(plan.status)}）`);
  }
  const body = req.body || {};
  // 未传字段沿用旧值
  const merged = {
    publicationId: body.publicationId !== undefined ? Number(body.publicationId) : plan.publicationId,
    materialId: body.materialId !== undefined ? Number(body.materialId) : plan.materialId,
    copies: body.copies !== undefined ? Number(body.copies) : plan.copies,
    kerf: body.kerf !== undefined ? Number(body.kerf) : plan.kerf,
  };
  const inp = resolvePlanInputs(merged);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildPlanLayout(inp);
  if (built.error) {
    return res.status(built.status || 400).json({
      ok: false, error: built.error, code: built.code, segment: built.segment || undefined,
    });
  }
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, PLAN_NAME_MAX)
    : plan.name;
  const r = db.updatePlanDraft(plan.id, {
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    materialId: inp.material.id,
    materialName: inp.material.name,
    materialLengthH: inp.material.lengthH,
    copies: inp.copies,
    kerfH: inp.kerfH,
    requiredBars: built.layout.requiredBars,
    segmentCount: built.layout.segmentCount,
    layout: built.layout,
  });
  if (r.code !== 'ok') return fail(res, 409, '计划状态已变化，请刷新后重试');
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 确认：原子预留库存；重复确认不会重复扣减
app.post('/api/plans/:planId/confirm', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  const r = db.confirmPlan(plan.id);
  if (r.code === 'already_confirmed') {
    return res.status(409).json({ ok: false, error: '计划已确认，无需重复确认（库存未重复预留）', plan: serializePlan(db.getPlan(plan.id)) });
  }
  if (r.code === 'plan_canceled') return fail(res, 409, '计划已取消，不能确认；请新建计划');
  if (r.code === 'material_missing') return fail(res, 409, '原材规格已不存在，无法确认');
  if (r.code === 'material_changed') {
    return fail(res, 409, '原材定尺自计划创建后已变化，请按新规格重建计划');
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      error: `可用原材不足：需用 ${r.required} 根，当前可用 ${r.available} 根，缺口 ${r.shortage} 根，不能确认`,
      code: 'shortage',
      requiredBars: r.required,
      availableBars: r.available,
      shortage: r.shortage,
    });
  }
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 取消：仅释放一次预留；重复取消不重复改库存
app.post('/api/plans/:planId/cancel', (req, res) => {
  const plan = db.getPlan(Number(req.params.planId));
  if (!plan) return fail(res, 404, '生产计划不存在');
  const r = db.cancelPlan(plan.id);
  if (r.code === 'draft_not_reserved') {
    return fail(res, 409, '草稿计划尚未预留库存，无需取消（可直接删除）');
  }
  if (r.code === 'already_canceled') {
    return res.status(409).json({ ok: false, error: '计划已取消，库存此前已释放，未重复变更', plan: serializePlan(db.getPlan(plan.id)) });
  }
  res.json({ ok: true, plan: serializePlan(r.plan) });
});

// 删除草稿/已取消计划（已确认计划须先取消）
app.delete('/api/plans/:planId', (req, res) => {
  const r = db.deletePlan(Number(req.params.planId));
  if (r.code === 'not_found') return fail(res, 404, '生产计划不存在');
  if (r.code === 'confirmed_delete_blocked') {
    return fail(res, 409, '已确认计划不能删除；请先取消以释放库存');
  }
  res.json({ ok: true });
});

function materialBrief(material) {
  return {
    id: material.id,
    name: material.name,
    length: material.length,
    stock: material.stock,
    reserved: material.reserved,
    available: material.available,
  };
}

function statusZh(status) {
  return status === 'draft' ? '草稿' : status === 'confirmed' ? '已确认' : '已取消';
}

// 计划输出：绑定的发布版本与排产方案为快照；同时附带当前库存视图供网页展示
function serializePlan(plan) {
  const material = db.getMaterial(plan.materialId);
  const shortage = Math.max(0, plan.requiredBars - (material ? material.available : 0));
  return {
    id: plan.id,
    name: plan.name,
    status: plan.status,
    statusText: statusZh(plan.status),
    publicationId: plan.publicationId,
    designId: plan.designId,
    version: plan.version,
    copies: plan.copies,
    kerf: plan.kerf,
    requiredBars: plan.requiredBars,
    segmentCount: plan.segmentCount,
    layout: plan.layout,
    material: material
      ? materialBrief(material)
      : { id: plan.materialId, name: plan.materialName, length: plan.materialLength, unavailable: true },
    availableBars: material ? material.available : 0,
    shortage: plan.status === 'draft' ? shortage : 0,
    feasible: plan.status !== 'draft' || shortage === 0,
    snapshotBound: true,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    confirmedAt: plan.confirmedAt,
    canceledAt: plan.canceledAt,
  };
}

// ---------- 彩色玻璃原片库存（每种颜色一种规格） ----------

app.get('/api/glass-sheets', (req, res) => {
  res.json({ ok: true, sheets: db.listGlassSheets() });
});

app.get('/api/glass-sheets/:sheetId', (req, res) => {
  const sheet = db.getGlassSheet(Number(req.params.sheetId));
  if (!sheet) return fail(res, 404, '该颜色原片规格不存在');
  res.json({ ok: true, sheet });
});

app.post('/api/glass-sheets', (req, res) => {
  const pr = sheetNest.parseSheetBody(req.body || {});
  if (!pr.ok) return fail(res, 400, pr.error);
  const { color, width, height, stock } = pr.params;
  if (db.getGlassSheetByColorRow(color)) {
    return fail(res, 409, `颜色 ${color} 的原片规格已登记（一种颜色仅可登记一种规格）`);
  }
  const sheet = db.createGlassSheet({ color, width, height, stock });
  res.status(201).json({ ok: true, sheet });
});

// 仅允许调整库存张数；颜色/宽高属规格身份不可改。库存不得低于已预留。
app.patch('/api/glass-sheets/:sheetId', (req, res) => {
  const sheet = db.getGlassSheet(Number(req.params.sheetId));
  if (!sheet) return fail(res, 404, '该颜色原片规格不存在');
  const body = req.body || {};
  if (body.color !== undefined) return fail(res, 400, '颜色属于规格身份不可修改；请登记新颜色');
  if (body.width !== undefined || body.height !== undefined) {
    return fail(res, 400, '原片宽高属于规格身份不可修改；请登记新规格');
  }
  if (body.stock === undefined) return fail(res, 400, '没有可更新字段（仅支持 stock）');
  const stock = Number(body.stock);
  if (!Number.isInteger(stock) || stock < 0) {
    return fail(res, 400, '库存张数必须是不小于 0 的整数');
  }
  const r = db.updateGlassSheetStock(sheet.id, stock);
  if (r.code === 'stock_below_reserved') {
    return fail(res, 409, `库存不得小于已确认订单预留张数（${r.reserved}）`, { reserved: r.reserved });
  }
  res.json({ ok: true, sheet: r.sheet });
});

// ---------- 裁片订单 ----------

const ORDER_NAME_MAX = 80;

// 解析 { publicationId, copies, gap }；返回 { error,status } 或 { pub, copies, gap }
function resolveNestInputs(body) {
  const publicationId = Number(body.publicationId);
  if (!Number.isInteger(publicationId) || publicationId <= 0) {
    return { error: 'publicationId 必须是已发布版本的正整数 id' };
  }
  const pub = db.getPublicationById(publicationId);
  if (!pub) return { error: '发布版不存在', status: 404 };
  const pr = sheetNest.parseNestingParams(body);
  if (!pr.ok) return { error: pr.error };
  return { pub, copies: pr.params.copies, gap: pr.params.gap };
}

// 取“颜色 -> 规格（宽/高/id）”，排样只用宽高；库存视图由 serialize 补
function sheetSpecMap() {
  const m = new Map();
  for (const s of db.listGlassSheets()) {
    m.set(s.color, { id: s.id, width: s.width, height: s.height, stock: s.stock });
  }
  return m;
}

// 生成排样方案；失败整体返回（不落库、不占库存）
function buildNestLayout(pub, copies, gap) {
  const specs = sheetSpecMap();
  const specByColor = new Map();
  for (const [color, s] of specs) specByColor.set(color, { width: s.width, height: s.height });
  const r = sheetNest.nestBySnapshot(pub.snapshot, specByColor, copies, gap);
  if (!r.ok) {
    return {
      error: r.error, status: r.status || 422, code: r.code,
      color: r.color, pieceNo: r.pieceNo, copy: r.copy,
      pieceWidth: r.pieceWidth, pieceHeight: r.pieceHeight,
      sheetWidth: r.sheetWidth, sheetHeight: r.sheetHeight,
      totalSheets: r.totalSheets, maxSheets: r.maxSheets,
    };
  }
  return { layout: r.layout, specs };
}

// 汇总各色用板数与库存缺口
function colorSummaries(layout, specs) {
  return layout.colors.map((c) => {
    const spec = specs.get(c.color);
    const stock = spec ? spec.stock : 0;
    const sheet = spec ? db.getGlassSheet(spec.id) : null;
    const reserved = sheet ? sheet.reserved : 0;
    const available = sheet ? sheet.available : 0;
    return {
      color: c.color,
      sheetId: spec ? spec.id : null,
      sheetWidth: c.sheetWidth,
      sheetHeight: c.sheetHeight,
      requiredSheets: c.requiredSheets,
      stock,
      reserved,
      available,
      shortage: Math.max(0, c.requiredSheets - available),
    };
  });
}

function nestPreviewPayload({ pub, copies, gap, layout, specs, includeItems = false }) {
  const colors = colorSummaries(layout, specs);
  const totalShortage = colors.reduce((s, c) => s + c.shortage, 0);
  const payload = {
    publicationId: pub.id,
    designId: pub.designId,
    version: pub.version,
    copies,
    gap,
    layout,
    totalSheets: layout.totalSheets,
    maxSheets: layout.maxSheets,
    colors,
    totalShortage,
    feasible: totalShortage === 0,
  };
  if (includeItems) {
    payload.items = colors.map((c) => ({
      sheetId: c.sheetId, color: c.color,
      width: c.sheetWidth, height: c.sheetHeight,
      requiredSheets: c.requiredSheets,
    }));
  }
  return payload;
}

function failNest(res, built) {
  return res.status(built.status || 422).json({
    ok: false,
    error: built.error,
    code: built.code,
    color: built.color,
    pieceNo: built.pieceNo,
    copy: built.copy,
    pieceWidth: built.pieceWidth,
    pieceHeight: built.pieceHeight,
    sheetWidth: built.sheetWidth,
    sheetHeight: built.sheetHeight,
    totalSheets: built.totalSheets,
    maxSheets: built.maxSheets,
  });
}

// 预览（不落库、不占库存）
app.post('/api/cut-orders/preview', (req, res) => {
  const inp = resolveNestInputs(req.body || {});
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildNestLayout(inp.pub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  res.json({
    ok: true,
    preview: nestPreviewPayload({
      pub: inp.pub, copies: inp.copies, gap: inp.gap,
      layout: built.layout, specs: built.specs,
    }),
  });
});

function orderNameFrom(body, pub, copies) {
  return typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, ORDER_NAME_MAX)
    : `玻璃裁片 v${pub.version} ×${copies}件`;
}

// 建草稿订单
app.post('/api/cut-orders', (req, res) => {
  const body = req.body || {};
  const inp = resolveNestInputs(body);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildNestLayout(inp.pub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  const preview = nestPreviewPayload({
    pub: inp.pub, copies: inp.copies, gap: inp.gap,
    layout: built.layout, specs: built.specs, includeItems: true,
  });
  if (preview.items.some((it) => it.sheetId === null)) {
    // 理论上 missing_color 已在排样阶段拦截；双保险
    return fail(res, 422, '缺少对应颜色的原片规格');
  }
  const order = db.createCutOrder({
    name: orderNameFrom(body, inp.pub, inp.copies),
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    copies: inp.copies,
    gap: inp.gap,
    totalSheets: built.layout.totalSheets,
    layout: built.layout,
    items: preview.items,
  });
  res.status(201).json({ ok: true, order: serializeCutOrder(order) });
});

app.get('/api/cut-orders', (req, res) => {
  res.json({ ok: true, orders: db.listCutOrders().map(serializeCutOrder) });
});

app.get('/api/cut-orders/:orderId', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  res.json({ ok: true, order: serializeCutOrder(order) });
});

// 修改草稿（重选版本/件数/间距并重算排样）
app.put('/api/cut-orders/:orderId', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  if (order.status !== 'draft') {
    return fail(res, 409, `仅草稿订单可修改（当前为 ${cutStatusZh(order.status)}）`);
  }
  const body = req.body || {};
  const merged = {
    publicationId: body.publicationId !== undefined ? Number(body.publicationId) : order.publicationId,
    copies: body.copies !== undefined ? Number(body.copies) : order.copies,
    gap: body.gap !== undefined ? Number(body.gap) : order.gap,
  };
  const inp = resolveNestInputs(merged);
  if (inp.error) return fail(res, inp.status || 400, inp.error);
  const built = buildNestLayout(inp.pub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  const preview = nestPreviewPayload({
    pub: inp.pub, copies: inp.copies, gap: inp.gap,
    layout: built.layout, specs: built.specs, includeItems: true,
  });
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, ORDER_NAME_MAX)
    : order.name;
  const r = db.updateCutOrderDraft(order.id, {
    name,
    publicationId: inp.pub.id,
    designId: inp.pub.designId,
    version: inp.pub.version,
    copies: inp.copies,
    gap: inp.gap,
    totalSheets: built.layout.totalSheets,
    layout: built.layout,
    items: preview.items,
  });
  if (r.code !== 'ok') return fail(res, 409, '订单状态已变化，请刷新后重试');
  res.json({ ok: true, order: serializeCutOrder(r.order) });
});

// 确认：原子预留所有颜色所需原片；任一颜色不足整单失败（409）
app.post('/api/cut-orders/:orderId/confirm', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  const r = db.confirmCutOrder(order.id);
  if (r.code === 'already_confirmed') {
    return res.status(409).json({
      ok: false, error: '订单已确认，无需重复确认（库存未重复预留）',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  if (r.code === 'order_canceled') return fail(res, 409, '订单已取消，不能确认；请新建订单');
  if (r.code === 'sheet_missing') return fail(res, 409, `颜色 ${r.color} 的原片规格已不存在，无法确认`);
  if (r.code === 'sheet_changed') {
    return fail(res, 409, `颜色 ${r.color} 的原片规格自订单创建后已变化，请按新规格重建订单`);
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      code: 'shortage',
      error: '部分颜色原片库存不足，整单未确认（未预留任何一张）',
      shortages: r.shortages,
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  res.json({ ok: true, order: serializeCutOrder(r.order) });
});

// 取消：只释放一次；重复取消不重复改库存
app.post('/api/cut-orders/:orderId/cancel', (req, res) => {
  const order = db.getCutOrder(Number(req.params.orderId));
  if (!order) return fail(res, 404, '裁片订单不存在');
  if (order.status === 'replaced') {
    return fail(res, 409, '订单已通过换单替换，不能再取消或修改（请操作换单后的新单）', {
      code: 'replaced_locked', order: serializeCutOrder(order),
    });
  }
  const r = db.cancelCutOrder(order.id);
  if (r.code === 'replaced_locked') {
    return fail(res, 409, '订单已通过换单替换，不能再取消或修改（请操作换单后的新单）');
  }
  if (r.code === 'draft_not_reserved') {
    return fail(res, 409, '草稿订单尚未预留库存，无需取消（可直接删除）');
  }
  if (r.code === 'already_canceled') {
    return res.status(409).json({
      ok: false, error: '订单已取消，库存此前已释放，未重复变更',
      order: serializeCutOrder(db.getCutOrder(order.id)),
    });
  }
  res.json({ ok: true, order: serializeCutOrder(r.order) });
});

app.delete('/api/cut-orders/:orderId', (req, res) => {
  const r = db.deleteCutOrder(Number(req.params.orderId));
  if (r.code === 'not_found') return fail(res, 404, '裁片订单不存在');
  if (r.code === 'confirmed_delete_blocked') {
    return fail(res, 409, '已确认订单不能删除；请先取消以释放库存');
  }
  if (r.code === 'replaced_locked') {
    return fail(res, 409, '已替换订单保留备查，不能删除');
  }
  res.json({ ok: true });
});

function cutStatusZh(status) {
  return status === 'draft' ? '草稿'
    : status === 'confirmed' ? '已确认'
      : status === 'canceled' ? '已取消'
        : status === 'replaced' ? '已替换' : status;
}

// ---------- 裁片订单换单（已确认旧单 → 同图纸另一已发布版本新单） ----------

// 校验换单目标参数：{ oldOrder, targetPublicationId, copies, gap }
// 返回 { error,status,code } 或 { targetPub, copies, gap }
function resolveReplaceInputs(oldOrder, body) {
  const targetPublicationId = Number(body.targetPublicationId);
  if (!Number.isInteger(targetPublicationId) || targetPublicationId <= 0) {
    return { error: 'targetPublicationId 必须是已发布版本的正整数 id' };
  }
  const targetPub = db.getPublicationById(targetPublicationId);
  if (!targetPub) return { error: '目标发布版不存在', status: 404, code: 'publication_not_found' };
  if (targetPub.designId !== oldOrder.designId) {
    return {
      error: '目标发布版与旧单不属于同一图纸，不能换单',
      status: 400, code: 'different_design',
      designIdOld: oldOrder.designId, designIdTarget: targetPub.designId,
    };
  }
  if (targetPublicationId === oldOrder.publicationId) {
    return { error: '目标发布版与旧单相同，无需换单', status: 400, code: 'same_publication' };
  }
  const pr = sheetNest.parseNestingParams(body);
  if (!pr.ok) return { error: pr.error };
  return { targetPub, copies: pr.params.copies, gap: pr.params.gap };
}

// 按颜色合并旧单与新排样的用板数（并集，颜色字典序）
function mergeColorKeys(oldLayout, newLayout) {
  const set = new Set();
  for (const c of oldLayout.colors || []) set.add(c.color);
  for (const c of newLayout.colors || []) set.add(c.color);
  return [...set].sort();
}

// 构造换单预览：按颜色列出旧单用板、新单用板、净增减、计入旧单预留后的可用量、缺口。
// 不占库存、不落库。
function buildReplacePreview({ oldOrder, targetPub, copies, gap, layout, specs }) {
  const oldByColor = new Map((oldOrder.layout.colors || []).map((c) => [c.color, c]));
  const newByColor = new Map(layout.colors.map((c) => [c.color, c]));

  const colors = mergeColorKeys(oldOrder.layout, layout).map((color) => {
    const oldC = oldByColor.get(color);
    const newC = newByColor.get(color);
    const spec = specs.get(color);
    const sheet = spec ? db.getGlassSheet(spec.id) : null;
    const stock = sheet ? sheet.stock : 0;
    const reserved = sheet ? sheet.reserved : 0;
    const oldSheets = oldC ? oldC.requiredSheets : 0;
    const requiredSheets = newC ? newC.requiredSheets : 0;
    const sheetWidth = newC ? newC.sheetWidth : (oldC ? oldC.sheetWidth : (spec ? spec.width : null));
    const sheetHeight = newC ? newC.sheetHeight : (oldC ? oldC.sheetHeight : (spec ? spec.height : null));
    // 换单确认后旧单退出预留：可用 = 当前可用 + 旧单本单预留（按色）
    const oldOrderReserved = (db.listCutOrderItems(oldOrder.id)
      .filter((it) => it.color === color)
      .reduce((s, it) => s + it.requiredSheets, 0));
    const availableAfterRelease = (sheet ? sheet.available : 0) + oldOrderReserved;
    const netChange = requiredSheets - oldSheets;
    return {
      color,
      sheetId: spec ? spec.id : null,
      sheetWidth,
      sheetHeight,
      oldSheets,
      requiredSheets,
      netChange,                 // 正数=新增，负数=减少，0=持平
      stock,
      reserved,                  // 当前已预留（含旧单）
      oldOrderReserved,          // 旧单本单预留张数（确认后释放）
      availableAfterRelease,     // 计入旧单预留后的可用量
      shortage: Math.max(0, requiredSheets - availableAfterRelease),
      inOld: !!oldC,
      inNew: !!newC,
    };
  });

  const totalShortage = colors.reduce((s, c) => s + c.shortage, 0);
  const oldTotal = oldOrder.totalSheets;
  const newTotal = layout.totalSheets;
  return {
    oldOrderId: oldOrder.id,
    oldOrderName: oldOrder.name,
    oldPublicationId: oldOrder.publicationId,
    oldVersion: oldOrder.version,
    targetPublicationId: targetPub.id,
    targetVersion: targetPub.version,
    designId: targetPub.designId,
    oldCopies: oldOrder.copies,
    oldGap: oldOrder.gap,
    copies,
    gap,
    colors,
    oldTotalSheets: oldTotal,
    totalSheets: newTotal,
    maxSheets: layout.maxSheets,
    netSheetChange: newTotal - oldTotal,
    totalShortage,
    feasible: totalShortage === 0,
    layout,
  };
}

// POST /api/cut-orders/:orderId/replacements/preview
//   body: { targetPublicationId, copies, gap }（件数与片间距；不落库、不占库存）
app.post('/api/cut-orders/:orderId/replacements/preview', (req, res) => {
  const oldOrder = db.getCutOrder(Number(req.params.orderId));
  if (!oldOrder) return fail(res, 404, '裁片订单不存在');
  if (oldOrder.status !== 'confirmed') {
    return fail(res, 409, `仅已确认订单可以换单（当前为 ${cutStatusZh(oldOrder.status)}）`, {
      code: 'not_confirmed', status: oldOrder.status,
    });
  }
  const inp = resolveReplaceInputs(oldOrder, req.body || {});
  if (inp.error) {
    return res.status(inp.status || 400).json({ ok: false, error: inp.error, code: inp.code || 'invalid' });
  }
  const built = buildNestLayout(inp.targetPub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  const preview = buildReplacePreview({
    oldOrder, targetPub: inp.targetPub, copies: inp.copies, gap: inp.gap,
    layout: built.layout, specs: built.specs,
  });
  res.json({ ok: true, preview });
});

// POST /api/cut-orders/:orderId/replacements
//   body: { targetPublicationId, copies, gap, name? }
//   同事务：旧单退出预留并标记 replaced；新单创建并确认。
//   任一颜色不足 → 409 + 各色缺口，旧单/库存/订单记录不变。
//   幂等：同旧单同参数重试 → 200 返回原新单；参数不同 → 409 冲突；均不重复预留。
app.post('/api/cut-orders/:orderId/replacements', (req, res) => {
  const oldId = Number(req.params.orderId);
  const oldOrder0 = db.getCutOrder(oldId);
  if (!oldOrder0) return fail(res, 404, '裁片订单不存在');

  // 旧单已被替换：幂等返回原新单 / 参数冲突（均不重复预留）
  if (oldOrder0.status === 'replaced') {
    const rep = db.getReplacementByOldOrder(oldId);
    if (!rep) return fail(res, 409, '订单已被替换，但缺少换单记录，请联系管理员');
    const bodySig = db.replacementSignature({
      newPublicationId: Number(req.body?.targetPublicationId),
      copies: Number(req.body?.copies),
      gap: Number(req.body?.gap),
    });
    if (rep.paramSignature === bodySig) {
      return res.status(200).json({
        ok: true,
        idempotent: true,
        replacement: serializeReplacement(rep),
        oldOrder: serializeCutOrder(db.getCutOrder(rep.oldOrderId)),
        newOrder: serializeCutOrder(db.getCutOrder(rep.newOrderId)),
      });
    }
    return res.status(409).json({
      ok: false,
      code: 'param_conflict',
      error: `旧单 #${oldId} 已按其它参数换到新单 #${rep.newOrderId}（目标 v 不同或件数/间距不同），不能再换`,
      existingReplacement: serializeReplacement(rep),
      newOrder: serializeCutOrder(db.getCutOrder(rep.newOrderId)),
    });
  }
  if (oldOrder0.status !== 'confirmed') {
    return fail(res, 409, `仅已确认订单可以换单（当前为 ${cutStatusZh(oldOrder0.status)}）`, {
      code: 'not_confirmed', status: oldOrder0.status,
    });
  }

  const inp = resolveReplaceInputs(oldOrder0, req.body || {});
  if (inp.error) {
    return res.status(inp.status || 400).json({ ok: false, error: inp.error, code: inp.code || 'invalid' });
  }
  const built = buildNestLayout(inp.targetPub, inp.copies, inp.gap);
  if (built.error) return failNest(res, built);
  const preview = buildReplacePreview({
    oldOrder: oldOrder0, targetPub: inp.targetPub, copies: inp.copies, gap: inp.gap,
    layout: built.layout, specs: built.specs,
  });

  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim()
    ? body.name.trim().slice(0, ORDER_NAME_MAX)
    : `玻璃裁片 v${inp.targetPub.version} ×${inp.copies}件（换自 #${oldId}）`;

  // 新排样实际需要的分色明细（旧单有但新排样不再使用的颜色不入明细）
  const realItems = preview.colors
    .filter((c) => c.requiredSheets > 0)
    .map((c) => ({
      sheetId: c.sheetId, color: c.color,
      width: c.sheetWidth, height: c.sheetHeight,
      requiredSheets: c.requiredSheets,
    }));
  if (realItems.some((it) => it.sheetId === null)) {
    // missing_color 已在排样阶段拦截；双保险
    return failNest(res, { error: '缺少对应颜色的原片规格', status: 422, code: 'missing_color' });
  }

  const r = db.replaceCutOrder(oldId, {
    name,
    publicationId: inp.targetPub.id,
    designId: inp.targetPub.designId,
    version: inp.targetPub.version,
    copies: inp.copies,
    gap: inp.gap,
    totalSheets: built.layout.totalSheets,
    layout: built.layout,
    items: realItems,
    oldPublicationId: oldOrder0.publicationId,
  });

  if (r.code === 'idempotent') {
    return res.status(200).json({
      ok: true,
      idempotent: true,
      replacement: serializeReplacement(r.replacement),
      oldOrder: serializeCutOrder(db.getCutOrder(r.replacement.oldOrderId)),
      newOrder: serializeCutOrder(db.getCutOrder(r.replacement.newOrderId)),
    });
  }
  if (r.code === 'param_conflict') {
    return res.status(409).json({
      ok: false,
      code: 'param_conflict',
      error: `旧单 #${oldId} 已按其它参数换到新单 #${r.replacement.newOrderId}，参数不同不能重复换单`,
      existingReplacement: serializeReplacement(r.replacement),
      newOrder: serializeCutOrder(db.getCutOrder(r.replacement.newOrderId)),
    });
  }
  if (r.code === 'order_canceled') return fail(res, 409, '旧单已取消，不能换单');
  if (r.code === 'draft_not_confirmed') return fail(res, 409, '草稿订单未确认，不能换单；可直接修改草稿');
  if (r.code === 'already_replaced') return fail(res, 409, '订单已替换，不能再换');
  if (r.code === 'sheet_missing') return fail(res, 409, `颜色 ${r.color} 的原片规格已不存在，无法换单`);
  if (r.code === 'sheet_changed') {
    return fail(res, 409, `颜色 ${r.color} 的原片规格与排样时不一致，请重新预览后再换单`);
  }
  if (r.code === 'shortage') {
    return res.status(409).json({
      ok: false,
      code: 'shortage',
      error: '部分颜色计入旧单预留后仍不足，换单未执行（旧单、库存与订单记录均保持原状，未预留任何一张）',
      shortages: r.shortages,
      preview,
    });
  }
  res.status(201).json({
    ok: true,
    replacement: serializeReplacement({
      oldOrderId: oldId,
      newOrderId: r.newOrder.id,
      oldPublicationId: oldOrder0.publicationId,
      newPublicationId: inp.targetPub.id,
      copies: inp.copies,
      gap: inp.gap,
    }),
    oldOrder: serializeCutOrder(r.oldOrder),
    newOrder: serializeCutOrder(r.newOrder),
  });
});

function serializeReplacement(rep) {
  return {
    oldOrderId: rep.oldOrderId,
    newOrderId: rep.newOrderId,
    oldPublicationId: rep.oldPublicationId,
    newPublicationId: rep.newPublicationId,
    copies: rep.copies,
    gap: rep.gap,
    createdAt: rep.createdAt || null,
  };
}

// 订单输出：排样方案为建单时快照；库存视图取当前值（预览缺口仅对草稿有意义）
function serializeCutOrder(order) {
  const specs = sheetSpecMap();
  const colors = colorSummaries(order.layout, specs);
  const totalShortage = order.status === 'draft'
    ? colors.reduce((s, c) => s + c.shortage, 0)
    : 0;
  // 换单关系：replaced 单指向新单；新单回溯旧单
  let replacedBy = null;
  let replacedFrom = null;
  const repOut = db.getReplacementByOldOrder(order.id);
  if (repOut) replacedBy = serializeReplacement(repOut);
  const repIn = db.getReplacementByNewOrder(order.id);
  if (repIn) replacedFrom = serializeReplacement(repIn);
  return {
    id: order.id,
    name: order.name,
    status: order.status,
    statusText: cutStatusZh(order.status),
    publicationId: order.publicationId,
    designId: order.designId,
    version: order.version,
    copies: order.copies,
    gap: order.gap,
    totalSheets: order.totalSheets,
    maxSheets: order.layout.maxSheets || sheetNest.MAX_SHEETS,
    layout: order.layout,
    colors,
    items: db.listCutOrderItems(order.id),
    totalShortage,
    feasible: order.status !== 'draft' || totalShortage === 0,
    snapshotBound: true,
    replacedBy,
    replacedFrom,
    canReplace: order.status === 'confirmed' && !repOut,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    confirmedAt: order.confirmedAt,
    canceledAt: order.canceledAt,
    replacedAt: order.replacedAt,
  };
}

// 前端单页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// 统一错误处理
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) return fail(res, 400, '请求体不是合法 JSON');
  console.error(err);
  fail(res, 500, '服务器内部错误');
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`彩绘玻璃拼片台已启动: http://localhost:${PORT}`);
    console.log(`数据库文件: ${DB_PATH}`);
  });
}

module.exports = app;
