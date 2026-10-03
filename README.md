# 彩绘玻璃工作室 · 网页拼片台

为彩绘玻璃工作室设计的网页拼片台：输入矩形窗框的正整数毫米宽高，在画布上以**整数毫米坐标**绘制带**编号与颜色**的简单多边形玻璃片；服务端精确校验每一次编辑，只有**完整覆盖窗框且无空隙**的草稿才能发布；发布时生成**铅条下料清单**（公共边只计一次，外框另列）。历史发布版不可变，随时查阅。

围绕已发布图纸还可**安排铅条生产**：登记铅条原材定尺与库存根数，选择发布版本、件数、原材规格与每刀损耗进行排产；系统按 0.01 mm 精确计算切段方案，确认时**原子预留库存**（并发不超卖），计划永久绑定发布快照。

工作室调整拼片并再次发布后，还可选择**同一图纸的任意两个已发布版本核对铅条下料变化**：按几何位置比较内部公共边与四根外框，区分沿用/取消/新增，部分重叠自动拆分；核对全程**只读**，不影响发布快照、生产计划与库存。

大窗框现场拼接时，可对已发布图纸按**实物 1:1 分张打印**：选择不可变发布版本，输入纸张宽高、四边留白与相邻页重叠宽度（整数毫米），预览按行列编号的总页数、每页覆盖的图纸坐标与拼接标记，并逐页下载物理尺寸为毫米的 SVG；玻璃片轮廓、编号与外框全部取自所选发布快照，跨页轮廓裁切到可打印区域，页内带毫米校准标尺。分张预览与下载全程**只读**。

还可直接从**彩色玻璃原片裁出已发布图纸的拼片**：每种颜色登记一种原片规格（宽高为 1–2000 整数毫米）与库存张数（调整库存不得低于已预留数）；选择发布版本、制作件数与片间最小间距（0–50 整数毫米）后按快照颜色排样，总裁片数最多 60 张；每片只可平移或旋转 90° 的整数倍，不得镜像、越板或与同板其他片轮廓净距不足。预览给出逐张原片的片号、件次、旋转角度、放置坐标与轮廓，以及各色用板数与库存缺口；确认时**原子预留所有颜色**的所需原片，并发不超卖；计划永久绑定发布快照。

已确认的裁片订单在客户改图后还可**换单**：从一张已确认订单换到**同一图纸的另一已发布版本**，重新输入件数与片间距；换单预览按颜色对比旧单与新排样的**用板数、净增减、计入旧单退出预留后的可用量与缺口**（预览不占库存）。确认换单在**同一事务**内让旧单退出预留并确认新单，任一颜色不足则旧单、库存与订单记录**全部保持原状**；成功后旧单标记**已替换**（快照与排样仍可查，但不能再取消/修改/删除），新单为独立的已确认订单；对同一旧单按相同参数重试**返回原新单**，不同参数报冲突，均不重复预留。

## 功能一览

- **窗框建模**：宽、高为正整数毫米（1–100000）。
- **拼片绘制**：画布点击取点（自动吸附已有顶点/窗框角），双击或“闭合多边形”完成；也可直接输入 `x,y` 坐标。每片有独立编号与颜色。
- **编辑校验（拒绝并标出位置，图中红色 ✕ 标记）**：
  - 顶点必须是整数毫米，且在窗框内 —— 越界拒绝；
  - 必须是简单多边形：自交（边交叉/边重叠/非端点相触）、重复顶点、零边、相邻共线均拒绝；
  - 与现有拼片**面积重叠**拒绝（边交叉、顶点穿入、共边同侧重叠、顶点处内角相交）；
  - 允许合法相邻：共边共享、T 接、顶点相接；
  - **允许相邻片边界一侧是整边、另一侧为数段**。
- **覆盖检查与缺口可视化**：未发布前实时分析草稿，缺口区域以红色斜纹多边形标出并给出每块缺口面积；面积重叠以紫色标出。
- **发布**：仅当无缺口、无重叠、面积合计等于窗框面积时可发布，否则返回 422 并附带缺口数据。发布版带递增版本号，快照不可变。
- **发布图纸**：展示每片编号、颜色与面积（mm²），画布上直接标注编号与面积。
- **铅条下料清单**：
  - 内部公共边无论怎样分段都**合并为一根、只计一次**（T 接处直线继续则不断开）；
  - 外框四根（上/下/左/右）另列；
  - 每根长度、分类小计与总长都是**先求和再四舍五入至 0.01 mm**。
- **草稿/发布分离**：后续编辑、删除、改色与清单重算只作用于草稿；历史发布版通过版本下拉框查阅，内容永不变化。
- **两版铅条核对（本轮新增）**：
  - 选择同一图纸的两个已发布版本，分别比较**内部公共边**与**四根外框**（上/下/左/右）；
  - 两版**共线且空间重叠**的部分为**沿用**，仅较早版覆盖为**取消**，仅较晚版覆盖为**新增**，部分重叠在端点处**自动拆分**；
  - 比较前做无向直线归一与同版区间合并：**反向记录、清单顺序变化、T 接处分段变化（一侧整边/另一侧数段）都不产生虚假差异**；
  - 展示每类线段的起点/终点（mm）、长度（mm）与分类合计；各类合计**先求和再四舍五入到 0.01 mm**；
  - 版本不存在、两个发布版不属于同一图纸时**明确报错**；核对为**只读**，发布快照、生产计划、库存均不变化。
- **铅条生产（本轮新增）**：
  - **原材登记**：登记原材规格名、**定尺长度**（正数，精确到 0.01 mm）与**库存根数**（非负整数）；非法输入一律拒绝且不改库存。
  - **排产取段**：只取所选**发布版本**铅条清单中的**内部公共边**与**四根外框**（上/下/左/右），按**件数**逐件展开，每一段都是**不可拼接**的独立切段。
  - **切段规则**：切段按长度**降序**排列，同长按清单顺序；依次放入**第一根能容纳**它的原材（首次适应递减 FFD）。每段占用 `成品长度 + 一刀损耗`，放不下就开新原材；输出逐根切段、每根余料与需用根数。
  - **预览不占库存**：任何非法输入、单段连同刀损超过定尺（整单拒绝）都不会改动库存。
  - **缺口与确认**：需用根数超过可用数时返回**缺口根数且不能确认**；确认在一个 `BEGIN IMMEDIATE` 事务中**原子预留**，多计划并发也**不会超卖**。
  - **幂等与释放**：重复确认不会重复预留；取消只释放一次，重复取消不重复改库存；已确认计划不可删除（须先取消）。
  - **快照绑定**：计划一旦建立即绑定该发布版本，后续草稿改动或再发布新版本**都不影响**其用料。
  - 网页“铅条生产”标签可登记库存、预览、确认/取消计划并查看可用库存。
- **1:1 分张打印（本轮新增）**：
  - 在“分张打印”标签选择图纸与**已发布版本**，输入**纸张宽高、四边留白、相邻页重叠宽度（整数毫米）**生成拼接预览；
  - 玻璃片轮廓/编号/颜色/面积与外框**全部取自所选不可变快照**，草稿改动或再发布均不影响已生成的分页（重新预览才取新版本）；
  - 预览给出**行列编号总页数**（行自下而上对应图纸 y 轴、列自左而右）、**每页覆盖的图纸坐标范围**与四边**拼接标记**（邻页页码、重叠带、红色对位十字及其图纸坐标）；
  - 每页可**单独下载 SVG**，也可一键逐页下载：`width/height` 以 **mm** 标定物理尺寸，图纸内容按 1:1 绘制并**裁剪到可打印区域**，重叠带在相邻两页使用**完全相同的图纸坐标**，页内含**毫米校准标尺**（打印请选“实际大小/100%”）；
  - **校验**：纸张尺寸与重叠必须为正，留白可为零；可打印尺寸非正、重叠不小于任一可打印边长、版本不存在、总页数超过 **200** 时**明确拒绝且不输出部分页面**；
  - 预览与下载均为**只读**，不修改草稿、发布版、生产计划或库存。
- **玻璃裁片（本轮新增）**：
  - **原片登记**：每种颜色登记**一种**原片规格——宽、高为 **1–2000 整数毫米**，库存张数为非负整数；颜色/宽高属规格身份不可修改，仅可调整库存且**不得低于已确认订单预留张数**。
  - **按快照颜色排样**：选择发布版本、**制作件数**（正整数）与**片间最小间距 gap（0–50 整数毫米）**，按发布快照把拼片逐件展开、按颜色分组独立装箱；**相同版本与排样参数的布局逐字节一致**（确定性），不保证全局最少用板。
  - **每片约束**：仅可**整数毫米平移**或旋转 **0°/90°/180°/270°**（不得镜像）；轮廓必须**完全在原片矩形内**（可贴边）；同板片间**不得面积重叠**，且**轮廓最短净距 ≥ gap**（gap=0 允许共边/T 接/顶点接触）；距离判定使用整数坐标的 **BigInt 精确运算**，无浮点误差。
  - **装箱策略**：片按外接矩形面积降序排列，逐片**首次适应**（先试既有原片再开新片），同板采用**左下角**定位并对四个旋转角取最低、最左、角度最小者，最后以真实多边形轮廓精确复核间距与越板。
  - **预览**：给出**逐张原片**的片号、件次、旋转角度、放置坐标 `(x,y)`、外接宽高与放置后轮廓（整数毫米绝对坐标，附 SVG 示意图），以及**各色用板数、库存/已预留/可用/缺口**与总缺口；预览不落库、不占库存。
  - **整单拒绝（不产生部分方案）**：缺少对应颜色原片登记（`missing_color`）、单片任何旋转都无法放入原片（`piece_too_large`）、参数非法、总裁片数超过 **60**（`too_many_sheets`）。
  - **原子预留与并发**：确认在一个 `BEGIN IMMEDIATE` 事务中逐色核对并预留，**任一颜色库存不足则整单失败、不留部分**；多订单并发也**不会超卖**。
  - **幂等与快照**：重复确认不重复预留；取消只释放一次（重复取消返回 409 且不再改库存）；已确认订单不可改、不可删（须先取消）；订单永久绑定发布快照，草稿改动或再发布均不改变已确认方案。
  - **换单（本轮新增）**：仅**已确认**订单可换；选择**同一图纸的另一已发布版本**与新件数/片间距，预览按颜色列出**旧单用板/新排样用板/净增减/计入旧单退出预留后的可用量/缺口**（只读不占库存）；确认在一个 `BEGIN IMMEDIATE` 事务内**旧单退出预留 + 新单创建即确认**，任一颜色不足整体回滚并返回各色缺口；成功后旧单置为**已替换**（保留发布快照与排样，不可再取消/修改/删除），新单是独立已确认订单、可继续取消或再次换单（形成换单链）；同一旧单相同参数重试**幂等返回原新单**、不同参数返回 409 冲突，均不重复预留。
  - 网页“玻璃裁片”标签可登记原片、排样预览、存草稿、确认/取消订单并查看逐张排样示意；已确认订单详情内展开“换单”面板即可查看换单预览并确认换单。

## 技术栈

- Node.js ≥ 20（CommonJS）
- Express 4（Web/API/静态资源）
- better-sqlite3（SQLite，同步事务）
- 原生 HTML/CSS/Canvas + 原生 JS（无前端构建步骤）
- 几何判定全部使用整数坐标的精确整数运算（叉积/射线法），交点以精确分数表示，避免浮点误差

## 快速启动

### 方式一：Docker Compose（推荐，一键启动并初始化数据库）

```bash
docker compose up -d --build
```

首次启动会自动构建镜像、安装依赖，并在容器内对 `/data/studio.db` 执行建表初始化
（`CREATE TABLE IF NOT EXISTS`），无需手动初始化。

浏览器打开：

```
http://localhost:3000
```

停止：

```bash
docker compose down          # 保留数据卷
docker compose down -v       # 同时删除数据库卷
```

### 方式二：本地 Node.js 运行

```bash
npm install
npm start
```

若 better-sqlite3 需要本地编译，请确保具备 Python 3、make、g++（Debian/Ubuntu：
`apt-get install -y python3 make g++`）。

浏览器同样打开 http://localhost:3000 。

运行几何算法测试：

```bash
npm test
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `data/studio.db`（本地）/ `/data/studio.db`（Docker） | SQLite 数据库文件路径；目录不存在会自动创建，首次启动自动建表 |

Compose 中通过命名卷 `studio-data` 持久化 `/data`；改宿主机端口只需修改
`docker-compose.yml` 的端口映射（如 `"8080:3000"`）。

## 网页地址与端口

- 应用首页：`http://localhost:3000/`
- 端口：`3000`（可用 `PORT` 环境变量或 compose 端口映射更改）

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/designs` | 图纸列表 |
| POST | `/api/designs` | 新建图纸 `{name,width,height}`（宽高正整数毫米） |
| GET | `/api/designs/:id` | 草稿完整汇总（片/面积/缺口/铅条清单） |
| POST | `/api/designs/:id/pieces` | 新增拼片 `{color,polygon:[[x,y],...]}` |
| PUT | `/api/designs/:id/pieces/:pieceId` | 编辑拼片（改色/改顶点） |
| DELETE | `/api/designs/:id/pieces/:pieceId` | 删除拼片（仅草稿） |
| POST | `/api/designs/:id/publish` | 发布（未完整覆盖返回 422 + 缺口数据） |
| GET | `/api/designs/:id/publications` | 发布版列表 |
| GET | `/api/designs/:id/publications/:version` | 查阅指定发布版（不可变快照） |
| GET | `/api/designs/:id/publications/diff?fromVersion=1&toVersion=2` | 两版铅条核对（版本号；自动按版本号定较早/较晚，只读） |
| POST | `/api/designs/:id/publications/:version/print/preview` | 1:1 分张打印预览 `{paperWidth,paperHeight,margin,overlap}`（整数毫米，只读） |
| GET | `/api/designs/:id/publications/:version/print/page?paperWidth&paperHeight&margin&overlap&page=n` | 下载指定页 SVG（`image/svg+xml`，物理尺寸 mm，只读） |
| POST | `/api/publications/diff` | 两版铅条核对 `{publicationIdA,publicationIdB}`（非同图纸返回 400） |
| GET | `/api/materials` | 铅条原材规格与库存（含已预留/可用根数） |
| POST | `/api/materials` | 登记原材 `{name,length,stock}`（定尺正数 mm、库存非负整数） |
| GET | `/api/materials/:id` | 单个原材规格 |
| PATCH | `/api/materials/:id` | 改名称/库存根数 `{name?,stock?}`（定尺不可改；库存不得低于已预留） |
| POST | `/api/plans/preview` | 排产预览 `{publicationId,materialId,copies,kerf}`（不落库、不占库存） |
| POST | `/api/plans` | 建草稿计划（同上，可带 `name`） |
| GET | `/api/plans` | 计划列表（含状态/需用/缺口） |
| GET | `/api/plans/:id` | 计划详情（逐根切段、余料、绑定版本） |
| PUT | `/api/plans/:id` | 修改草稿（重选版本/件数/原材/刀损并重算） |
| POST | `/api/plans/:id/confirm` | 确认并原子预留；缺口返回 409 |
| POST | `/api/plans/:id/cancel` | 取消并释放预留（幂等） |
| DELETE | `/api/plans/:id` | 删除草稿/已取消计划（已确认须先取消） |
| GET | `/api/glass-sheets` | 彩色原片规格与库存（含已预留/可用张数） |
| POST | `/api/glass-sheets` | 登记颜色原片 `{color,width,height,stock}`（每色一种，宽高 1–2000 整数 mm） |
| GET | `/api/glass-sheets/:id` | 单个颜色原片规格 |
| PATCH | `/api/glass-sheets/:id` | 调整库存张数 `{stock}`（颜色/宽高不可改；不得低于已预留） |
| POST | `/api/cut-orders/preview` | 裁片排样预览 `{publicationId,copies,gap}`（不落库、不占库存） |
| POST | `/api/cut-orders` | 建草稿裁片订单（同上，可带 `name`） |
| GET | `/api/cut-orders` | 裁片订单列表（含状态/各色用板/缺口） |
| GET | `/api/cut-orders/:id` | 订单详情（逐张原片放置、绑定版本） |
| PUT | `/api/cut-orders/:id` | 修改草稿（重选版本/件数/间距并重算） |
| POST | `/api/cut-orders/:id/confirm` | 确认并原子预留所有颜色；任一色不足返回 409（整单失败） |
| POST | `/api/cut-orders/:id/cancel` | 取消并释放预留（只释放一次，幂等） |
| POST | `/api/cut-orders/:id/replacement/preview` | 换单预览 `{targetPublicationId 或 targetVersion, copies?, gap?}`（只读，不占库存） |
| POST | `/api/cut-orders/:id/replacement` | 确认换单（同事务旧单退出预留+新单确认；相同参数幂等返回原新单，不同参数 409） |
| DELETE | `/api/cut-orders/:id` | 删除草稿/已取消订单（已确认须先取消；已替换不可删） |

校验失败统一返回：

```json
{ "ok": false, "error": "原因", "category": "invalid|out_of_frame|overlap|not_covered",
  "at": [x, y], "gaps": [ { "polygon": [[x,y],...], "area": 1234.5 } ] }
```

## 使用流程

1. 左侧“新建图纸”，输入名称与窗框宽高（正整数毫米）。
2. 选择颜色，在画布上依次点击顶点绘制多边形（可自动吸附），双击完成；或在文本框逐行输入 `x,y` 后点“闭合多边形”。
3. 若被拒绝，画布会用红色 ✕ 标出问题位置，顶部红条说明原因与坐标。
4. 重复绘制直到覆盖状态变为“✓ 完整覆盖，无空隙”；绘制过程中缺口实时以红色斜纹显示。
5. 点击“发布图纸”，得到新版本；切到“已发布图纸”标签，选择版本查阅图纸、面积明细与铅条下料清单。
6. 发布后仍可继续编辑草稿（产生新版本），旧版本内容保持不变。
7. 切到“版本核对”标签：选择图纸与较早/较晚两个发布版 → “核对铅条下料变化”：画布与表格展示沿用（蓝实线）、取消（红虚线）、新增（绿实线）每一段的位置与长度，以及内部公共边、四根外框与总计三类合计。
8. 切到“铅条生产”标签：登记原材定尺与库存根数 → 选发布版本/件数/原材/每刀损耗 → “排产预览”查看逐根切段与余料 → “存为草稿计划” → 库存足够时“确认计划”原子预留；需要退料时“取消计划”释放预留。
9. 切到“分张打印”标签：选图纸与已发布版本 → 输入纸张宽高、四边留白与相邻页重叠（整数毫米）→ “生成拼接预览”查看行列总页数、每页覆盖坐标与拼接标记 → 逐页或一键“逐页下载全部 SVG”，打印时选择“实际大小/100%”，按重叠带与红色对位十字现场拼接。
10. 切到“玻璃裁片”标签：按颜色登记原片宽×高（1–2000 整数 mm）与库存张数 → 选发布版本、制作件数与片间最小间距 → “排样预览”查看逐张原片的片号/件次/旋转/坐标/轮廓与各色用板、库存缺口 → “存为草稿订单” → 库存充足时“确认订单”原子预留所有颜色；需要退料时“取消订单”一次性释放。客户改图并再次发布后，打开**已确认订单**详情、展开底部“⇄ 换单”面板 → 选同一图纸的新版本、件数与片间距 → “换单预览”核对各色旧/新用板、净增减与旧单释放后的可用量 → “确认换单”原子完成（旧单变“已替换”，新单即确认）；相同参数重复提交会返回原新单。

## 玻璃裁片排样规则

- **原片规格**：每种颜色（`#RRGGBB`，大小写归一）只可登记一种规格：宽、高均为 **1–2000 整数毫米**；库存张数为非负整数。颜色与宽高是规格身份不可修改，只可 `PATCH` 调整库存，且**库存不得低于已确认订单的预留张数之和**。
- **排样输入**：`publicationId`（不可变发布版）、`copies` 制作件数（正整数）、`gap` 片间最小间距（**0–50 整数毫米**）。拼片、颜色与轮廓全部取自发布快照；按件数逐件展开（件次 1..N），再按颜色分组独立装箱。
- **每片允许的变换**：整数毫米平移 + 旋转 **0/90/180/270**；**不允许镜像**。放置后轮廓必须完全位于原片矩形 `[0,width]×[0,height]` 内（允许贴边）。
- **同板约束（精确整数判定）**：片间不得有任何面积重叠（边交叉、共线重叠、顶点穿入、包含均拒绝；共边/T 接/顶点接触合法）；轮廓之间的**最短欧氏距离必须 ≥ gap**。距离用整数坐标的 BigInt 平方距离精确比较（点-线段垂足参数用叉积判定，交叉相乘与 gap² 比较），斜边、斜向净距也无浮点误差；gap=0 时等价于“不重叠即可接触”。
- **装箱（确定性，非全局最优）**：片先按外接矩形面积（再按高、宽、片号、件次）降序；逐片首次适应——按板号从早到晚尝试，板内取四个旋转角中**最低 y、同 y 最左 x、角度最小**的左下角可行位置；矩形包围盒快速定位后，再用真实多边形轮廓精确复核重叠与净距。放不下就开新原片。相同发布版本 + 相同 copies/gap 的布局**完全一致**；**不保证全局最少用板**。
- **总裁片数上限 60**：所有颜色用板总数超过 60 时返回 422（`too_many_sheets`，附 `totalSheets/maxSheets`），**不输出任何部分方案**。
- **整单拒绝的其他情形**：快照中某颜色未登记原片（422 `missing_color`）；单片在 0/90/180/270 任一旋转下外接矩形都超出原片（422 `piece_too_large`，附片号/件次/颜色/片外接与原片尺寸）；copies、gap 非法（400）；发布版不存在（404）。
- **库存口径**：`available = stock − 所有已确认订单分色预留之和`。预览与草稿均不占库存；只有确认才预留。
- **确认与并发**：确认使用 SQLite `BEGIN IMMEDIATE` 写事务，在同一事务内逐色读取已预留总量、核对缺口、置为 confirmed；**任一颜色不足即回滚整单**（返回 409 与每色 `shortages`），绝不留下部分预留；多个订单并发确认也不会超卖。
- **取消幂等**：重复确认返回 409 且不重复预留；取消把已确认订单置为 canceled 并一次性释放全部颜色预留，重复取消返回 409 且不再改库存；草稿未预留时取消返回 409（可直接删除）；已确认订单须先取消才能修改或删除。
- **快照绑定**：订单（及逐张布局 JSON）创建时即绑定发布版本；后续草稿增删改、重新发布都不影响已确认/已存订单。

### 玻璃裁片调用示例（curl）

```bash
# 1) 按颜色登记原片：红色 600×400 mm、库存 8 张（颜色大小写自动归一）
curl -s localhost:3000/api/glass-sheets -H 'Content-Type: application/json' \
  -d '{"color":"#FF0000","width":600,"height":400,"stock":8}'
# -> {"ok":true,"sheet":{"id":1,"color":"#ff0000","width":600,"height":400,
#                        "stock":8,"reserved":0,"available":8,...}}

# 2) 查询各色库存（reserved=已确认订单预留，available=还可用于新订单）
curl -s localhost:3000/api/glass-sheets

# 3) 排样预览（不落库、不占库存）：发布版 id=1，制作 3 件，片间净距至少 4 mm
curl -s localhost:3000/api/cut-orders/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"copies":3,"gap":4}'
# -> { ok:true, preview:{ publicationId, version, copies, gap,
#      totalSheets, maxSheets:60,
#      colors:[{color,sheetId,sheetWidth,sheetHeight,requiredSheets,
#               stock,reserved,available,shortage}],
#      totalShortage, feasible,
#      layout:{ copies,gap,totalSheets,
#        colors:[{color,sheetWidth,sheetHeight,requiredSheets,
#          sheets:[{index,width,height,placements:[
#            {pieceNo,copy,color,rotation,x,y,width,height,polygon:[[x,y],...]}]}]}]}}}

# 4) 存为草稿订单
curl -s localhost:3000/api/cut-orders -H 'Content-Type: application/json' \
  -d '{"name":"三联窗裁片","publicationId":1,"copies":3,"gap":4}'

# 5) 确认（各色库存都足够才成功；任一色不足整单失败）
curl -s -X POST localhost:3000/api/cut-orders/1/confirm
# 缺口时：409 {"ok":false,"code":"shortage",
#   "shortages":[{"color":"#ff0000","required":6,"available":4,"shortage":2}], ...}

# 6) 取消（一次性释放全部颜色预留；重复取消 409 且不再次改库存）
curl -s -X POST localhost:3000/api/cut-orders/1/cancel

# 7) 仅调整库存张数（颜色/宽高不可改；低于已预留返回 409）
curl -s -X PATCH localhost:3000/api/glass-sheets/1 \
  -H 'Content-Type: application/json' -d '{"stock":12}'
```

非法与整单拒绝示例（均不产生订单或预留）：

```bash
# 宽高越界 / 库存为负 / gap 越界 / 件数非正
curl -s -X POST localhost:3000/api/glass-sheets -H 'Content-Type: application/json' \
  -d '{"color":"#ff0000","width":2001,"height":400,"stock":1}'            # 400
curl -s -X POST localhost:3000/api/cut-orders/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"copies":1,"gap":51}'                            # 400

# 缺少某颜色的原片登记
# -> 422 {"ok":false,"code":"missing_color","color":"#00ff00", ...}

# 单片任何旋转都放不进原片
# -> 422 {"ok":false,"code":"piece_too_large","color":"#ff0000",
#         "pieceNo":7,"copy":2,"pieceWidth":620,"pieceHeight":410,
#         "sheetWidth":600,"sheetHeight":400}

# 总裁片数超过 60
# -> 422 {"ok":false,"code":"too_many_sheets","totalSheets":61,"maxSheets":60}
```

## 裁片订单换单规则

- **适用对象**：仅 **已确认（confirmed）** 订单可以换单；草稿（请直接修改/删除重建）、已取消、已替换的订单均明确拒绝（409，`order_not_confirmed`/`order_canceled`/`order_replaced`）。
- **目标版本**：换到的必须是**同一图纸的另一已发布版本**——可传 `targetVersion`（该图纸版本号）或 `targetPublicationId`（全局发布版 id）；版本不存在 404（`target_not_found`），不属于同一图纸 400（`different_design`），与旧单当前版本相同 400（`same_version`）。件数、片间距省略时沿用旧单参数，传入则仍按 1–10000 件、0–50 mm 校验。
- **新排样约束不变**：仍按目标发布快照颜色排样，遵守全部几何约束（仅平移/90° 旋转、不镜像、不越板、净距 ≥ gap）与颜色规格；缺色（422 `missing_color`）、单片放不下（422 `piece_too_large`）、总裁片数超 60（422 `too_many_sheets`）都**整单拒绝**。
- **换单预览（只读，不落库、不占库存）**：按颜色列出
  - `oldSheets` 旧单用板数、`requiredSheets` 新排样用板数、`netChange` 净增减；
  - `stock` 库存、`reserved` 当前全部已确认单预留（含旧单自身）；
  - `availableAfter = stock −（reserved − oldSheets）`，即**计入旧单退出预留后的可用量**；
  - `shortage = max(0, requiredSheets − availableAfter)`；另给 `oldTotalSheets/totalSheets/netSheets/totalShortage/feasible` 与新排样逐张布局。仅出现在旧单或新排样其一的颜色也会列出（另一侧按 0 计）。
- **确认（原子事务）**：在一个 `BEGIN IMMEDIATE` 事务内逐色核对——**旧单自身预留视为即将释放、不再占用**，但其他已确认单预留照常；任一颜色 `required > 库存 − 其他已确认预留` 即整单回滚（409 `shortage`，`shortages` 给出每色 `required/available/shortage/oldReserved`），**旧单状态、库存预留、订单记录全部保持原状**。成功则同事务：创建一张 **confirmed** 新单（布局即目标版本快照）、旧单置为 **replaced**（退出预留）、写入换单关联。
- **旧单终态**：`replaced` 旧单的发布快照与逐张排样仍可通过 `GET /api/cut-orders/:id` 查阅（含 `replacedBy.newOrderId`），但不能再取消、修改、删除（均 409 `order_replaced`）。新单为独立 confirmed 订单（含 `replaces.oldOrderId`），可正常取消，也可继续换单形成换单链；其取消不会改变旧单的 `replaced` 终态。
- **幂等与冲突**：对同一旧单以**相同目标版本/件数/片间距**重试确认，直接返回原新单（`idempotent:true`，HTTP 200，不重新排样、不重复预留）；参数不同返回 409 `param_conflict`（附已完成换单的 `current` 参数与 `newOrder`）。多个客户端并发换单由写事务串行化，不会超卖或产生两张新单。
- **网页**：在“玻璃裁片”标签打开一张已确认订单，展开底部 **⇄ 换单** 面板，选择目标版本、件数与片间距后“换单预览”（表格对比旧/新用板、净增减与释放后可用量，并展示新排样逐张示意），库存充足时“确认换单”；订单列表中旧单显示“已替换 · 由 #N 接替”徽章，新单显示“接替 #M”，点击可互相跳转。

### 换单调用示例（curl）

```bash
# 0) 前置：登记原片、确认一张 v1 订单 #7（红/绿各 1 张，共 2 张）
#    改图后发布 v2（右上红片改为蓝色，需红/绿/蓝各 1 张，共 3 张）

# 1) 换单预览（targetVersion 为该图纸版本号；copies/gap 省略则沿用旧单）
curl -s -X POST localhost:3000/api/cut-orders/7/replacement/preview \
  -H 'Content-Type: application/json' \
  -d '{"targetVersion":2,"copies":1,"gap":0}'
# -> { ok:true, preview:{ oldOrderId:7,
#      old:{version:1,totalSheets:2,colors:[{color:"#ff0000",requiredSheets:1}, ...]},
#      target:{publicationId:12,version:2}, copies:1, gap:0,
#      oldTotalSheets:2, totalSheets:3, netSheets:1, totalShortage:0, feasible:true,
#      layout:{...新排样逐张放置...},
#      colors:[
#        {color:"#ff0000",oldSheets:1,requiredSheets:1,netChange:0,
#         stock:3,reserved:1,availableAfter:3,shortage:0},
#        {color:"#00ff00",oldSheets:1,requiredSheets:1,netChange:0, ...},
#        {color:"#0000ff",oldSheets:0,requiredSheets:1,netChange:1,
#         stock:1,reserved:0,availableAfter:1,shortage:0} ] } }
# 也可传全局发布版 id： {"targetPublicationId":12}

# 2) 确认换单（同事务旧单退出预留、新单即确认）
curl -s -X POST localhost:3000/api/cut-orders/7/replacement \
  -H 'Content-Type: application/json' \
  -d '{"targetVersion":2,"copies":1,"gap":0,"name":"改图后新单"}'
# -> 201 { ok:true, idempotent:false,
#      order:{ id:8, status:"confirmed", version:2, totalSheets:3,
#              replaces:{oldOrderId:7,targetPublicationId:12,copies:1,gap:0}, ... },
#      oldOrder:{ id:7, status:"replaced", version:1, replacedAt:"...",
#                 replacedBy:{newOrderId:8,...} } }

# 3) 相同参数重试 → 返回原新单（200, idempotent:true，不重复预留）
curl -s -X POST localhost:3000/api/cut-orders/7/replacement \
  -H 'Content-Type: application/json' -d '{"targetVersion":2}'

# 4) 不同参数重试 → 409 冲突（不产生新单、不重复预留）
# -> 409 {"ok":false,"code":"param_conflict",
#         "requested":{"targetPublicationId":12,"copies":2,"gap":0},
#         "current":{"targetPublicationId":12,"copies":1,"gap":0},
#         "newOrder":{"id":8,...}}

# 5) 旧单终态保护
curl -s -X POST localhost:3000/api/cut-orders/7/cancel     # -> 409 order_replaced
curl -s -X PUT  localhost:3000/api/cut-orders/7 -H 'Content-Type: application/json' -d '{"copies":2}'
#                                                           # -> 409
curl -s -X DELETE localhost:3000/api/cut-orders/7          # -> 409 order_replaced
curl -s localhost:3000/api/cut-orders/7                    # 旧单快照/排样仍可查
```

失败示例（均不改变旧单、库存与订单记录）：

```bash
# 目标版本不存在
curl -s -X POST localhost:3000/api/cut-orders/7/replacement/preview \
  -H 'Content-Type: application/json' -d '{"targetVersion":99}'
# -> 404 {"ok":false,"code":"target_not_found",...}

# 目标版本属于另一张图纸
# -> 400 {"ok":false,"code":"different_design","oldDesignId":3,"targetDesignId":5}

# 新排样出现未登记原片的颜色 / 超过 60 张
# -> 422 {"ok":false,"code":"missing_color","color":"#0000ff"} / {"code":"too_many_sheets",...}

# 计入旧单释放后仍不足（旧单蓝 0、新单需 3，蓝库存为 0）
# -> 409 {"ok":false,"code":"shortage",
#         "shortages":[{"color":"#0000ff","required":3,"available":0,"shortage":3,"oldReserved":0}],
#         "oldOrder":{...仍为 confirmed、version:1...}}
```

## 铅条生产排产规则

- **长度单位**：所有长度（定尺、切段、刀损、余料）内部都以 **0.01 mm 的整数倍**精确运算，接口接受至多两位小数的毫米数；超过精度（如 `6000.005`）直接拒绝。
- **切段来源**：仅来自所选发布版本 `snapshot.leadList` 的 `internal`（内部公共边）与 `frameBars`（四根外框），按 `件数` 逐件复制，段不可拼接、不可跨件合并。
- **装箱**：切段先按长度降序、同长按清单顺序排序，再依次放入第一根剩余容量足够的原材；每段占位 = 成品长度 + 一刀损耗。某段 `成品 + 刀损 > 定尺` 时整单拒绝（返回 422 与该段信息）。
- **库存口径**：`available = stock − 所有已确认计划的 requiredBars 之和`。预览与草稿都不占库存；只有确认才预留。
- **并发**：确认使用 SQLite `BEGIN IMMEDIATE` 写事务，读取库存→核对缺口→置为 confirmed 在同一事务内完成，并发确认最多售出实际库存。

## 两版铅条核对规则

- **比较对象**：同一图纸的两个已发布版本（只读快照）。较早版 / 较晚版按版本号自动确定，`fromVersion` 与 `toVersion` 填反也会归一，不会把“沿用”错算成“取消+新增”。
- **分类口径（纯几何）**：把两版每根铅条放到同一根**无向直线**上，以沿直线的参数区间表示其空间覆盖：
  - 两版区间重叠的原子段 = **沿用（kept）**；
  - 仅较早版覆盖 = **取消（removed）**；仅较晚版覆盖 = **新增（added）**；
  - 部分重叠时以双方端点为界**拆分**为沿用/取消/新增三段。
- **不产生虚假差异的归一**：直线与方向无向归一（端点反向、清单顺序无关）；同一版同一直线上相接的区间先合并，因此 **T 接处“一侧整边、另一侧数段”** 等纯分段变化相互抵消；同一直线上两段不连续时中间空隙保留，不会被错误合并。
- **比较范围**：内部公共边（按几何直线自动分组）与四根外框（上/下/左/右分别核对；外框由窗框固定，同图纸两版通常四框全部沿用）。
- **精度**：直线分组与区间运算在“放大 100 倍”的整数坐标上精确完成（端点均为整数毫米）；段长为欧氏长度，**各类合计先对各段原始长度求和，再四舍五入到 0.01 mm**（斜线段可能出现 3 段各 1.41 mm、合计 4.24 mm 而非 4.23 mm 的情形，属预期）。
- **报错**：版本不存在返回 404；两个发布版不属于同一图纸（含窗框尺寸不一致）返回 400/422；接口不写数据库，**发布快照、生产计划、库存根数都不受影响**。

### 两版核对调用示例（curl）

```bash
# 方式一（GET，版本号）：核对 1 号图纸 v1 → v2
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=1&toVersion=2'
# -> { ok:true, meta:{ earlier:{version:1}, later:{version:2}, width,height },
#      diff:{ internal:{ kept:[{from,to,length}], removed:[...], added:[...], counts, totals },
#              frame:{"上框":{kept,removed,added,counts,totals}, ...}, frameOrder,
#              frameTotals, frameCounts, totals, counts } }

# 填反版本号也会自动归位（earlier 恒为较早版）
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=2&toVersion=1'

# 方式二（POST，发布版 id）
curl -s localhost:3000/api/publications/diff -H 'Content-Type: application/json' \
  -d '{"publicationIdA":1,"publicationIdB":2}'

# 版本不存在
curl -s 'localhost:3000/api/designs/1/publications/diff?fromVersion=1&toVersion=99'
# -> 404 {"ok":false,"error":"发布版 v99 不存在"}

# 两个发布版不属于同一图纸
curl -s localhost:3000/api/publications/diff -H 'Content-Type: application/json' \
  -d '{"publicationIdA":1,"publicationIdB":8}'
# -> 400 {"ok":false,"error":"两个发布版不属于同一图纸，不能核对铅条",
#         "designIdA":1,"designIdB":3}
```

响应中 `diff.totals` 为“内部公共边 + 四根外框”的总合计，`diff.internal.totals`、
`diff.frameTotals` 为分项合计；每个合计都含 `kept/removed/added` 三个长度（mm，
两位小数），`counts` 为对应段数。

## 1:1 分张打印规则

- **输入（全部整数毫米）**：`paperWidth`/`paperHeight` 纸张宽高（必须为正）、`margin` 四边统一留白（可为 0）、`overlap` 相邻页重叠宽度（必须为正）。
- **可打印区域**：`(paperWidth − 2·margin) × (paperHeight − 2·margin)`；非正时整单拒绝（`printable_not_positive`）。重叠必须**严格小于**可打印区域的**每一条**边长，否则拒绝（`overlap_too_large`）。
- **分页步距**：某方向内容长 `L`、可打印长 `p`、重叠 `o`，步距为 `p − o`；页数 `n = L ≤ p ? 1 : ceil((L − o)/(p − o))`，因此任意相邻页重叠不少于 `o`，末页覆盖末端恰好到窗框边。
- **编号**：行自下而上（对应图纸 y 轴正方向）、列自左而右；页码先行内从左到右、再从下到上，`page = (row−1)·cols + col`。
- **拼接标记**：每页四边给出存在相邻页的方向、邻页页码、重叠带范围（相邻两页对同一拼接边算出的范围**完全相同**），长边上沿带长 1/4、1/2、3/4 放置红色对位十字（短边放正中一个），并标注十字的图纸坐标。
- **SVG 内容**：根元素 `width="<paperWidth>mm" height="<paperHeight>mm"`、`viewBox` 同值，打印按 1:1；玻璃片多边形、编号/面积、颜色与外框矩形全部来自发布快照；整页图纸内容套在 `clipPath`（即可打印区域）内，跨页轮廓自然裁切；重叠带在两页以相同图纸坐标重复绘制；页内含 0–100 mm 的**毫米校准标尺**（可打印区域过窄时改竖尺）与“实际大小/100%、勿缩放”提示。
- **页数上限**：`cols × rows > 200` 时返回 422（`too_many_pages`，附 `cols/rows/totalPages`），**不输出任何部分页面**。
- **只读**：两个接口均不写数据库，草稿、发布快照、生产计划、库存都不受影响。

### 分张打印调用示例（curl）

```bash
# 1) 生成拼接预览（A4、四边留白 10mm、相邻页重叠 15mm）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":10,"overlap":15}'
# -> { ok:true, preview:{ designId, version, publicationId,
#      print:{ paper:{width,height}, margin, overlap,
#              printable:{width,height}, content:{width,height},
#              cols, rows, totalPages, pageNumbering,
#              pages:[ { page,row,col,rows,cols,
#                        coverage:{x0,y0,x1,y1,width,height},
#                        seams:[{edge,direction,paperCoord,drawingCoord,neighborPage,
#                                overlap:{x0,y0,x1,y1,width,height},
#                                crosses:[{x,y}]}],
#                        svgUrl } ] } } }

# 2) 下载第 1 页 SVG（参数须与预览一致；返回 image/svg+xml，物理尺寸 mm）
curl -s -G localhost:3000/api/designs/1/publications/1/print/page \
  --data-urlencode 'paperWidth=210' --data-urlencode 'paperHeight=297' \
  --data-urlencode 'margin=10' --data-urlencode 'overlap=15' \
  --data-urlencode 'page=1' -o page-1.svg

# 非法参数：可打印尺寸非正（留白 200 ≥ 半边长）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":200,"overlap":5}'
# -> 400 {"ok":false,"code":"printable_not_positive", ...}

# 非法参数：重叠不小于可打印边长（可打印 190×277）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":10,"overlap":190}'
# -> 400 {"ok":false,"code":"overlap_too_large", ...}

# 页数超过 200（5mm 纸、1mm 留白 → 3×3 可打印，600×400 图纸 = 200×134 页）
curl -s -X POST localhost:3000/api/designs/1/publications/1/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":5,"paperHeight":5,"margin":1,"overlap":1}'
# -> 422 {"ok":false,"code":"too_many_pages","cols":200,"rows":134,"totalPages":26800,"maxPages":200}

# 版本不存在 / 页码越界
curl -s -X POST localhost:3000/api/designs/1/publications/99/print/preview \
  -H 'Content-Type: application/json' \
  -d '{"paperWidth":210,"paperHeight":297,"margin":10,"overlap":15}'
# -> 404 {"ok":false,"error":"发布版 v99 不存在"}
curl -s -G localhost:3000/api/designs/1/publications/1/print/page \
  --data-urlencode 'paperWidth=210' --data-urlencode 'paperHeight=297' \
  --data-urlencode 'margin=10' --data-urlencode 'overlap=15' \
  --data-urlencode 'page=99'
# -> 400 {"ok":false,"error":"页码必须是 1–8 之间的整数"}
```

### HTTP 调用示例（curl）

```bash
# 1) 登记原材：定尺 6000.00 mm、库存 10 根
curl -s localhost:3000/api/materials -H 'Content-Type: application/json' \
  -d '{"name":"6m 通用铅条","length":6000,"stock":10}'
# -> {"ok":true,"material":{"id":1,"name":"6m 通用铅条","length":6000,"stock":10,"reserved":0,"available":10,...}}

# 2) 查可用库存（reserved=已确认计划预留，available=还可用于新计划）
curl -s localhost:3000/api/materials

# 3) 排产预览（publicationId 取自发布接口返回的 id；不落库、不占库存）
curl -s localhost:3000/api/plans/preview -H 'Content-Type: application/json' \
  -d '{"publicationId":1,"materialId":1,"copies":3,"kerf":0.5}'
# -> preview.layout.bars[]：每根原材的 cuts（件次/切段名/成品长/刀损）、remainder 余料；
#    requiredBars 需用根数、availableBars 可用、shortage 缺口、feasible 是否可确认

# 4) 建草稿计划
curl -s localhost:3000/api/plans -H 'Content-Type: application/json' \
  -d '{"name":"三联窗订单","publicationId":1,"materialId":1,"copies":3,"kerf":0.5}'

# 5) 确认（库存足够才成功；缺口返回 409 + shortage）
curl -s -X POST localhost:3000/api/plans/1/confirm
# 6) 取消（释放预留；重复取消返回 409 且不再次改库存）
curl -s -X POST localhost:3000/api/plans/1/cancel
# 7) 查全部计划与可用库存
curl -s localhost:3000/api/plans
curl -s localhost:3000/api/materials
```

非法输入示例（均返回 400，库存不变）：定尺 `0`/负数、库存 `-1`、件数 `0`/`1.5`、刀损 `-0.01`、长度精度超过 0.01 mm。

## 目录结构

```
Dockerfile               容器镜像（含 better-sqlite3 编译环境）
docker-compose.yml       一键启动 + 数据卷持久化
src/
  server.js              Express 入口与 API（图纸/发布/两版核对/原材/生产计划/玻璃裁片/裁片换单）
  db.js                  SQLite 初始化与数据访问（含铅条与玻璃原片的原子预留事务、裁片换单原子事务）
  geometry.js            精确几何校验、覆盖/缺口分析、铅条合并
  leaddiff.js            两版铅条核对（整数直线分组、区间沿用/取消/新增、拆分）
  cutting.js             铅条切段排产（0.01mm 整数运算、FFD、刀损）
  printsheet.js          1:1 分张打印（整数毫米分页、拼接标记、逐页 SVG/毫米标尺）
  sheetnest.js           玻璃裁片排样（整数/BigInt 精确净距、90°旋转、左下角首次适应、60 张上限）
public/
  index.html / style.css / app.js   单页前端（Canvas 编辑器/发布视图/版本核对/分张打印/铅条生产/玻璃裁片）
test/
  geometry.test.js       几何算法测试（node --test）
  leaddiff.test.js       两版核对：反向/顺序/T接归一、部分重叠拆分、斜向合计舍入、非同图纸报错
  cutting.test.js        切段解析与 FFD 排产测试
  printsheet.test.js     分张分页/重叠坐标一致/页数上限/SVG 物理尺寸与裁剪测试
  print.api.test.js      分张打印端到端（预览/逐页 SVG、非法参数整单拒绝、404/422、只读）
  plans.api.test.js      生产计划端到端测试（含并发不超卖、快照绑定）
  diff.api.test.js       两版核对端到端测试（GET/POST、404/400、只读不改变快照/计划/库存）
  sheetnest.test.js      裁片排样算法测试（旋转/越板/精确净距/缺色/上限/件次/确定性）
  cutorders.api.test.js  裁片订单端到端（登记/预览/整单拒绝、多色原子预留、并发不超卖、快照绑定）
  cutreplace.api.test.js 换单端到端（预览只读、原子换单、短缺回滚、幂等/冲突、旧单终态、并发不超卖、换单链）
```
