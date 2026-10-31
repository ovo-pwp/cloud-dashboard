# -*- coding: utf-8 -*-
"""
从金山文档「2026年利润管控系统」多维表格（.dbt）抓取数据，
生成与「多维表格 -> 导出 Excel」完全同结构的 xlsx，放到「应收看板-数据导出」，
后续出图完全复用现有脚本（sync_watch.py / client_report.py），出图逻辑零改动。

对应关系（云端表 -> 本地文件）：
  已开票未回款-每天 (sheet 276)  ->  (已开票未回款-每天)未回款.xlsx
  已发货未开票-每天 (sheet 277)  ->  (已发货未开票-每天)未开票.xlsx
  客户未回款平台   (sheet 196)  ->  (客户未回款平台)未回款.xlsx

用法：
  python kdocs_pull.py              # 抓全部三张表
  python kdocs_pull.py --check      # 只校验凭证是否有效
  python kdocs_pull.py 未回款 未开票  # 只抓指定表

凭证：
  首次使用需把金山文档访问 Token 放到同目录 kdocs_token.txt（一行，纯 Token）。
  获取方式：浏览器打开 https://www.kdocs.cn/latest -> 右上角【主菜单】图标（铃铛右侧的方块图标，
            注意不是点头像）-> 选「龙虾专属入口」-> 点【仅复制 Token】。
  Token 失效时本脚本会明确提示（错误码 400006）。
"""
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

import openpyxl
from openpyxl.styles import Alignment, Font

HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.dirname(HERE)
OUT_DIR = os.path.join(DESKTOP, "应收看板-数据导出")
TOKEN_FILE = os.path.join(HERE, "kdocs_token.txt")
LOG_FILE = os.path.join(HERE, "云端取数日志.log")

MCP_URL = "https://mcp-center.wps.cn/skill_hub/mcp"
FILE_ID = "EQAqLZ4s5rMQDk75Cipi1xYWKC9y4WG6L"      # 2026年利润管控系统.dbt
SKILL_VERSION = "1.4.12"

# ------------------------------------------------------------
# 显式禁用系统代理。
#
# 为什么必须这么做：
#   金山文档 MCP 是公网直连（实测直连 0.26s 通）。但本机环境变量里常有
#   http_proxy/https_proxy（如 http://127.0.0.1:51985），而 urllib **默认自动读取**它们。
#   当脚本被 PM2 托管的后端拉起时（不在任何交互会话里），继承到的那个代理端口
#   早已随会话结束而失效，于是报：
#       <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。>
#   表现就是定时同步整轮失败，看板数据停旧。
#   （2026-09-30 实测踩到：09-29 19:51 关机、09-30 09:04 开机，
#     09-05 那次定时同步因此失败，13 小时无新数据。）
#
# 这里用一个「空 ProxyHandler」的 opener，无论环境变量怎么设都直连，
# 保证脚本在任何调用方式下（手动双击 / PM2 / 计划任务）行为一致。
# ------------------------------------------------------------
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 本机单实例锁（避免同时跑两份抓取）
LOCK_PORT = 51890

# 每张表：云端 sheet_id / 云端字段顺序(=导出列顺序) / 日期列名 / 数值列名 / 输出文件名 / sheet 名
TABLES = {
    "未回款": {
        # 🔴 2026-10-12 使用者要求：数据源改**客户开票明细表 (26)**（以后更新都往新表取）
        #    实测：`已开票未回款≠0` = 199 行 / 6,603,723.85，与旧线**分毫不差**
        #    新表没有账龄列 ⇒ 由 compute_aging() 按「月份差」自算（100% 复现）
        "sheet_id": 26,
        "cols": ["开票方案编号", "开票日期", "分类", "挂账客户", "权限", "业务员",
                 "已开票未回款", "3个月以上未回款", "3个月未回款", "2个月未回款",
                 "1个月未回款", "当月未回款", "备注",
                 # 🔴 2026-10-10 修正：第 13 列原写「追款情况」，但源表(sheet 276)里**没有这个字段**，
                 #    真实字段叫「备注」⇒ 一直取不到 ⇒ 未回款的 follow_up_note 全为 NULL，
                 #    明细页 / 我的业绩 的「备注」列永远显示「—」，源表那 40 行催款备注从未入库。
                 #    ⚠️ 位置必须保持第 13 列：importer.js 对这两张表是**按列位置**读的。
                 # 2026-09-23 新增：云端表加的「地址」列，值是城市名（南宁市/崇左市…）
                 # 必须放**末尾**：importer.js 按列位置读取，插在中间会让后面全部错位
                 "地址",
                 # 2026-10-19 新增「行系」列（工行/中行/建行/农信/邮储…）。
                 # ⚠️ 两条线的列序必须**完全对齐**：未回款 14 列、未开票 13 列，
                 #    importer.js 按列位置读（r[13]=地址、r[14]=行系），哪边少一列就整体错位。
                 #    本表(26)源里**没有「行系」字段** ⇒ 取到为空，作占位列；
                 #    未开票表(123)源里有「行系」但**没有「地址」** ⇒ 同理给「地址」留空占位。
                 #    两边都固定 16 列：…备注 | 地址 | 行系 | 部门
                 # 🆕 2026-10-24 第 16 列「部门」（销售战队）：使用者要求矩阵里
                 #    「一个部门一个对应业务员」两列都显示 ⇒ 业务员保留人名、部门单独一列。
                 #    本表(26)源里没有战队字段 ⇒ 取空，靠 apply_dept_map() 按人名映射填。
                 "行系",
                 "部门"],
        "date_cols": ["开票日期"],
        "num_cols": ["已开票未回款", "3个月以上未回款", "3个月未回款", "2个月未回款",
                     "1个月未回款", "当月未回款"],
        "out_name": "(已开票未回款-每天)未回款.xlsx",
        # 2026-10-24 第 16 列「部门」：本表(26)源里没有战队字段 ⇒ 取空，
        # 由 apply_dept_map() 按人名（客户经理→销售战队）映射后填入。
        # 🔴 2026-10-26 事故：这张表把「业务员」字段**又改回「客户经理」**了，
        #    而当时只给未开票表配了业务员别名、这张没配 ⇒ 整列取空
        #    ⇒ 看板「业务员」全显示「未指定」、部门全「未分类」，
        #    连带财务口径过滤也失效（业务员为空，不含"财务"二字）⇒ 多算了 17 单 386 万。
        #    现在两条线**都配**业务员别名，哪个字段在就用哪个。
        "field_aliases": {"业务员": ["客户经理"], "部门": ["销售战队"], "地址": ["地址辅助", "地区"]},
        "sheet_name": "未回款",
        "filter_positive": "已开票未回款",
        "aging": {
            "date_col": "开票日期",
            "amount_col": "已开票未回款",
            "labels": ["三个月以上未回款", "三个月未回款", "两个月未回款", "一个月未回款", "当月未回款"],
            "cols": ["3个月以上未回款", "3个月未回款", "2个月未回款", "1个月未回款", "当月未回款"],
        },
        # 视图口径：剔除「业务员 = 财务部」（13 条 / 90.40 万，不计入看板）
        # 规则来源：用户 2026-09-18 确认（其余 7 位业务员全要）
        # 视图口径：剔除财务口径的行（不计入看板）
        # 规则来源：用户 2026-09-18 确认「剔除财务部」；
        # 2026-10-24 使用者再次要求「不要财务部」——而源表里这个口径已改名为
        # 「财务平台开票」（15 单 / 326.9 万），原来精确匹配「财务部」直接失效、静默放行。
        # 改成**包含「财务」的模糊匹配**，以后叫「财务XX」也能剔掉。
        "filter_exclude_contains": "业务员",
        "exclude_keywords": ["财务"],
    },
    "未开票": {
        # 🔴 2026-10-12 使用者要求：数据源改**客户对账明细表 (123)**
        "sheet_id": 123,
        "cols": ["合同执行编号", "执行日期", "分类", "挂账客户", "权限", "业务员",
                 "已发货未开票", "3个月以上未开票", "3个月未开票", "2个月未开票",
                 "1个月未开票", "当月未开票", "备注",
                 # 2026-10-19 与未回款表列序对齐（importer.js 按列位置读）：
                 # 本表(123)源里**没有「地址」字段** ⇒ 空占位，保证 r[13]=地址、r[14]=行系 两边一致；
                 # 「行系」本表源里**有**（工行/中行/建行/农信/邮储/其他金融行业-桂林银行/非金融行业-*）。
                 "地址",
                 "行系",
                 # 2026-10-24 第 16 列「部门」= 源表「销售战队」，与未回款表列序对齐
                 "部门"],
        "date_cols": ["执行日期"],
        "num_cols": ["已发货未开票", "3个月以上未开票", "3个月未开票", "2个月未开票",
                     "1个月未开票", "当月未开票"],
        "out_name": "(已发货未开票-每天)未开票.xlsx",
        # 🔴 2026-10-24 口径（使用者当天两次确认，最终版）：
        #   · 「业务员」= 源表「业务员」字段。17:05 源表**新增**了这个字段
        #     （之前只有「客户经理」，所以上午一直取的是客户经理）；
        #     实测 595 行入看板数据里「业务员」100% 有值，且与「客户经理」有 124 行不同
        #     （客户经理是交付/维护人，业务员才是销售）。
        #   · 所以：业务员**优先取「业务员」**，没有值才退回「客户经理」兜底。
        #   · 「部门」= 源表「销售战队」。
        "field_aliases": {"业务员": ["客户经理"], "部门": ["销售战队"], "地址": ["地址辅助", "地区"]},
        # 视图口径（两条规则，2026-10-24 合并）：
        #   ① 财务口径不计入看板（使用者「不要财务部」；源表把「财务部」改名成「财务平台开票」）
        #   ② 「备注」含「无效订单」的剔除（2026-09-22 方案 A；备注列会被改名，用 * 通配）
        # ⚠️ 必须写成列表 —— 写成两个同名 key 时后者会覆盖前者。
        "filter_exclude_contains": [
            {"col": "业务员", "keywords": ["财务"]},
            {"col": "备注*", "keywords": ["无效订单"]},
        ],
        "sheet_name": "未开票",
        "filter_positive": "已发货未开票",
        "aging": {
            "date_col": "执行日期",
            "amount_col": "已发货未开票",
            "labels": ["三个月以上未开票", "三个月未开票", "两个月未开票", "一个月未开票", "当月未开票"],
            "cols": ["3个月以上未开票", "3个月未开票", "2个月未开票", "1个月未开票", "当月未开票"],
        },
        # 视图口径（旧位置，已并入上面的 filter_exclude_contains 列表，这里不要重复配）
        # 规则来源：用户 2026-09-22 选择方案 A（只剔明确的无效单）
        # 注意：「备注」列还有「转移结算说明」9条、「待回款」等跟进中备注 19 条，
        #       按方案 A 一律保留，所以必须用"包含"而非"等于"来匹配。
    },
    "客户平台": {
        "sheet_id": 196,
        "cols": ["下单平台", "订单日期", "公司名称", "客户订单号", "客户名称", "回款状态",
                 "商品名称", "发票状态", "开票点数", "数量", "采购金额", "收货人",
                 "采购单价", "销售单价", "销售金额", "销售金额合计", "导单销售金额", "自检",
                 "差异调整", "报账方案编号", "数据源", "挂账客户", "业务员", "权限",
                 # 🔴 2026-10-10 清理死列：原先这里还有「预计回款平台日期」「备注」两项，
                 #    但源表(sheet 196)里**从来没有这两个字段** ⇒ 导出恒为空列。
                 #    删掉后 27 列 → 25 列。**索引 0-23 完全没动**（桌面周报按索引读
                 #    r[14]=销售金额、r[22]=业务员，都在这之前，不受影响）。
                 # ⚠️ 「备注2」必须留着 —— fetch_records 只请求 cols 里的字段，
                 #    而 filter_blank 要靠它过滤无效单，删了过滤就失效。
                 "备注2"],
        "date_cols": ["订单日期", "预计回款平台日期"],
        "num_cols": ["开票点数", "数量", "采购金额", "采购单价", "销售单价", "销售金额",
                     "销售金额合计", "导单销售金额", "自检", "差异调整"],
        "out_name": "(客户未回款平台)未回款.xlsx",
        "sheet_name": "未回款",
        # 视图口径：只保留「无效单标记列」为空的行。
        #
        # 🔴 2026-10-10 修正（第二次）：**不要写死列名**。
        #    这个列名在金山文档里被反复改过：备注 → 备注3 → 备注2 → 备注3，
        #    每改一次，按名字过滤就**静默失效**，304 行脏数据会被写回看板
        #    （当天因此反复出问题：16:45 用「备注2」过滤成功，18:22 列名变回「备注3」
        #      ⇒ 自动同步又写入 304 行 ⇒ 看板从 191.65 万变回 307.58 万）。
        #    所以这里用通配：运行时找出所有「备注*」列，**任一非空即视为无效单剔除**；
        #    一个都找不到 → 告警且**不覆盖导出文件**（保住上一次的正确数据）。
        "filter_blank": "备注*",
    },
    # ------------------------------------------------------------
    # 客户开票明细表（2026-10-12 新增，使用者要求）
    #   用途：「每天开的票 / 回的款」明细报表。
    #   开票按「开票日期」+「开票金额」；回款按「回款日期」+「回款金额」。
    #   口径（使用者 2026-10-12 确认）：
    #     · 不含「业务员 = 财务部」
    #     · **退票不剔除** —— 明确选择「不剔除」，按原始记录全额算；
    #       所以界面上必须保留「退票状态」列，让人能看出哪些是红冲的。
    #     · 注：全表 98 条挂退票状态（488 万），「已重开」的新票与原票会各算一次。
    # ------------------------------------------------------------
    "客户开票": {
        "sheet_id": 26,
        "cols": ["开票方案编号", "申请日期", "申请类型", "报账方式（渠道）", "报账公司",
                 "挂账客户", "业务员", "开票日期", "开票金额", "开票状态", "退票状态",
                 "发票类型", "回款日期", "回款金额", "已开票未回款", "货物名称",
                 "报账开票方案名称（子合同）", "备注", "预计回款日期"],
        "date_cols": ["申请日期", "开票日期", "回款日期", "预计回款日期"],
        "num_cols": ["开票金额", "回款金额", "已开票未回款"],
        "out_name": "(客户开票明细表)开票回款.xlsx",
        "sheet_name": "客户开票",
        # 视图口径：剔除财务口径的行（不计入看板）
        # 规则来源：用户 2026-09-18 确认「剔除财务部」；
        # 2026-10-24 使用者再次要求「不要财务部」——而源表里这个口径已改名为
        # 「财务平台开票」（15 单 / 326.9 万），原来精确匹配「财务部」直接失效、静默放行。
        # 改成**包含「财务」的模糊匹配**，以后叫「财务XX」也能剔掉。
        "filter_exclude_contains": "业务员",
        "exclude_keywords": ["财务"],
    },
    # ------------------------------------------------------------
    # 客户对账明细表（2026-10-12 新增）
    #   用途：「每日发货·回款明细」的左半边 —— 按**执行日期**看发货/对账金额。
    #   使用者明确要这些金额列（截图 2026-10-12）：
    #     期初欠款 / 实际出库金额 / 线下对账金额 / 平台对账金额 / 龙集采对账 / 已发货未开票
    #   ⚠️ 这张表的「挂账客户」是 OneWayLink 关联列，只回内部 id，
    #      靠 CUSTOMER_LINK_FIELDS 里的「挂账客户」翻译（见 load_customer_map）。
    # ------------------------------------------------------------
    "客户对账": {
        "sheet_id": 123,
        "cols": ["合同执行编号", "执行日期", "项目执行名称", "挂账客户", "业务员",
                 "产品线", "下单状态", "实际出库金额", "线下对账金额", "平台对账金额",
                 "龙集采对账", "期初欠款", "已发货未开票", "开票勾选", "备注"],
        "date_cols": ["执行日期"],
        "num_cols": ["实际出库金额", "线下对账金额", "平台对账金额", "龙集采对账",
                     "期初欠款", "已发货未开票"],
        "out_name": "(客户对账明细表)对账.xlsx",
        "sheet_name": "客户对账",
        # 视图口径：剔除财务口径的行（不计入看板）
        # 规则来源：用户 2026-09-18 确认「剔除财务部」；
        # 2026-10-24 使用者再次要求「不要财务部」——而源表里这个口径已改名为
        # 「财务平台开票」（15 单 / 326.9 万），原来精确匹配「财务部」直接失效、静默放行。
        # 改成**包含「财务」的模糊匹配**，以后叫「财务XX」也能剔掉。
        "filter_exclude_contains": "业务员",
        "exclude_keywords": ["财务"],
    },
}

DATE_FMTS = ("%Y/%m/%d", "%Y-%m-%d", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S",
             "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M")

# 「挂账客户 / 权限」是 OneWayLink 关联列，云端只回关联记录的 **记录 id**（如 Klj / CSX），
# 显示名在同文件的《客户基本信息表》里。抓完主表后按此表把 id 翻译回中文名。
# 见 2026-09-20 排查：未回款/未开票的挂账客户曾是 CSn/CWK 这类编码。
CUSTOMER_SHEET_ID = 28            # 客户基本信息表
CUSTOMER_LINK_FIELDS = ("挂账客户", "权限")

_log_fh = None


def log(msg):
    # 毫秒时间戳（2026-10-21 加）：同步变慢时能直接从日志看出每一步花了多久，
    # 不用再靠「总耗时 - 猜」来定位。格式紧凑，不影响原有可读性。
    line = "[" + datetime.now().strftime("%H:%M:%S.%f")[:-3] + "] " + str(msg)
    print(line)
    if _log_fh:
        try:
            _log_fh.write(line + "\n")
            _log_fh.flush()
        except Exception:
            pass


# ---------------- 值转换 ----------------
_NAME_KEYS = ("nickName", "nickname", "name", "displayText", "display_text", "title",
              "text", "value", "label")


def _pick_name(x):
    """从值对象中优先取『显示名』类字段；实在没有才退回 id。"""
    if not isinstance(x, dict):
        return x
    for k in _NAME_KEYS:
        s = x.get(k)
        if s or s is False:
            return str(s)
    # 无任何显示名，只有内部 id（关联字段可能只回 id）
    return x.get("id")


def flat(v):
    """把云端返回值摊平：数组取内容拼接，联系人取昵称，超链接取地址。

    「挂账客户 / 权限」等关联字段，云端可能以 {id, name} 或仅 {id} 返回：
    - 优先取显示名（固定字符串优先于内部 id）；
    - 纯 id 时保留 id（不丢行），由云端侧补全显示名后即恢复中文。
    """
    if v is None:
        return None
    if isinstance(v, list):
        if not v:
            return None
        parts = []
        for x in v:
            s = _pick_name(x)
            if s is None or s == "":
                continue
            parts.append(str(s))
        return ",".join(parts) if parts else None
    if isinstance(v, dict):
        return _pick_name(v)
    return v


def load_customer_map(mcp):
    """构建《客户基本信息表》的 记录id → {挂账客户名, 权限 nickName} 映射。

    主表的「挂账客户 / 权限」是 OneWayLink 关联列，云端只回关联记录 id，
    这里把 id 翻回中文显示名，保证导出 xlsx 与手动导出的「表格视图」一致。
    拉取失败时返回空 dict（此时保持原样退回 id，不影响主流程）。
    """
    cmap = {}
    try:
        offset, page = "", 0
        while True:
            args = {"file_id": FILE_ID, "sheet_id": CUSTOMER_SHEET_ID, "page_size": 1000}
            if offset:
                args["offset"] = offset
            data = mcp.call("dbsheet.list_records", args)
            detail = data.get("data", {}).get("detail", {})
            for r in detail.get("records", []):
                rid = r.get("id")
                if not rid:
                    continue
                f = r.get("fields", {}) or {}
                cmap[rid] = {
                    "挂账客户": flat(f.get("挂账客户")),
                    "权限": flat(f.get("权限")),
                }
            offset = detail.get("offset")
            page += 1
            if not offset or page > 50:
                break
        log(f"    [关联映射] 客户基本信息表载入 {len(cmap)} 条 id→名称")
    except Exception as e:
        log(f"    [警告] 客户基本信息表拉取失败，关联列将保留 id: {e}")
    return cmap


def resolve_link(v, cmap, field):
    """把关联列的值翻成显示名；翻不到则原样返回。"""
    if v is None:
        return None
    items = v if isinstance(v, list) else [v]
    out = []
    for x in items:
        if x is None:
            continue
        s = str(x)
        hit = cmap.get(s)
        if hit and hit.get(field):
            s = hit[field]
        out.append(s)
    return ",".join(out) if out else None


def to_date(v):
    s = flat(v)
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None
    for fmt in DATE_FMTS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return s


def to_num(v):
    v = flat(v)
    if v is None or v == "":
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").replace("，", "").replace("¥", "").replace("元", "")
    if s in ("", "-", "None"):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


# ---------------- MCP 客户端 ----------------
class KdocsMcp:
    """金山文档 MCP 客户端（Streamable HTTP，JSON-RPC 2.0）。"""

    def __init__(self, token):
        self.token = (token or "").strip()
        self.sid = None
        self._id = 0

    def _post(self, payload):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "X-Request-Source": "workbuddy",
            "X-Skill-Version": SKILL_VERSION,
        }
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if self.sid:
            headers["Mcp-Session-Id"] = self.sid
        req = urllib.request.Request(MCP_URL, data=json.dumps(payload).encode("utf-8"),
                                     method="POST", headers=headers)
        # 用禁用代理的 opener（见文件顶部 _NO_PROXY_OPENER 的说明），
        # 不能用 urllib.request.urlopen —— 那个会自动读取 http_proxy 环境变量
        with _NO_PROXY_OPENER.open(req, timeout=120) as r:
            if not self.sid:
                self.sid = r.headers.get("Mcp-Session-Id") or r.headers.get("mcp-session-id")
            body = r.read().decode("utf-8", "replace")
            # 通知类请求（如 notifications/initialized）服务端回 202 且正文为空，无需解析
            if not body.strip():
                return {}
            return _parse_body(body)

    def connect(self):
        self._id += 1
        self._post({"jsonrpc": "2.0", "id": self._id, "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "kdocs_pull", "version": "1.0"}}})
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def call(self, name, args, retries=3):
        last = None
        for i in range(retries):
            self._id += 1
            try:
                resp = self._post({"jsonrpc": "2.0", "id": self._id, "method": "tools/call",
                                   "params": {"name": name, "arguments": args}})
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = _parse_body(e.read().decode("utf-8", "replace"))
                except Exception:
                    pass
                last = RuntimeError(f"HTTP {e.code} {body}")
                if e.code in (429, 500, 502, 503):
                    time.sleep(2 + 2 * i)
                    continue
                raise last
            except Exception as e:                     # 网络抖动，重试
                last = e
                time.sleep(2 + 2 * i)
                continue
            if "error" in resp:
                raise RuntimeError(str(resp["error"]))
            content = resp.get("result", {}).get("content", [])
            text = content[0].get("text", "") if content else ""
            try:
                data = json.loads(text)
            except Exception:
                data = {}
            code = data.get("code")
            if code == 400006:
                raise AuthError(data.get("message", "凭证失效"))
            if code not in (0, None):
                raise RuntimeError(f"接口返回 code={code} {data.get('message', '')}")
            return data
        raise RuntimeError(f"重试 {retries} 次仍失败: {last}")


class AuthError(Exception):
    pass


def _parse_body(text):
    """兼容纯 JSON 与 SSE(text/event-stream) 两种响应。"""
    text = text.strip()
    if text.startswith("{") or text.startswith("["):
        return json.loads(text)
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            if payload and payload != "[DONE]":
                try:
                    return json.loads(payload)
                except Exception:
                    continue
    raise ValueError("无法解析响应: " + text[:200])


def _cell_text(v):
    """把单元格值转成可比对的纯文本（用于筛选判断）。"""
    if v is None:
        return ""
    if isinstance(v, list):
        parts = []
        for x in v:
            if isinstance(x, dict):
                s = (x.get("text") or x.get("name") or x.get("nickname")
                     or x.get("displayText") or "")
                if s:
                    parts.append(str(s))
            elif x is not None and str(x).strip():
                parts.append(str(x))
        return ",".join(parts).strip()
    return str(v).strip()


def resolve_note_fields(recs, pattern):
    """把 '备注*' 这类通配名解析成源表里真实存在、且**实际有值**的字段名。

    为什么必须这样：源表的标记列名会被改（备注 → 备注3 → 备注2 → 备注3），
    按名字写死就会静默失效 —— 2026-10-10 因此把 304 行脏数据写回看板。

    返回 (存在的字段列表, 其中有值的字段列表)。
    """
    names = set()
    for r in recs:
        names |= set((r.get("fields") or {}).keys())
    if pattern.endswith("*"):
        prefix = pattern[:-1]
        exist = sorted(n for n in names if n.startswith(prefix))
    else:
        exist = [pattern] if pattern in names else []
    withval = [n for n in exist
               if any(_cell_text((r.get("fields") or {}).get(n)) for r in recs)]
    return exist, withval


def compute_aging(recs, aging, base=None):
    """按「月份差」把金额归到账龄档（2026-10-12 新增；新表没有账龄列）。

    规则（对旧线 198/198、545/545 全部复现，一条不差）：
        月份差 = (基准年−单据年)*12 + (基准月−单据月)   ← 按自然月，不看天数
        ≥4 / =3 / =2 / =1 / =0 → 五个档依次
    结果写进 rec['fields'] 的「分类」与 5 个账龄列，write_xlsx 照常输出。
    """
    import datetime as _dt
    base = base or _dt.date.today()
    labels, cols = aging["labels"], aging["cols"]
    dc, ac = aging["date_col"], aging["amount_col"]

    def _d(v):
        t = _cell_text(v)
        if not t:
            return None
        p2 = t.replace("-", "/").split(" ")[0].split("/")
        if len(p2) != 3:
            return None
        try:
            return _dt.date(int(p2[0]), int(p2[1]), int(p2[2]))
        except Exception:
            return None

    for r in recs:
        f = r.setdefault("fields", {})
        d = _d(f.get(dc))
        raw = _cell_text(f.get(ac))
        try:
            amt = float(raw) if raw and not raw.startswith("#") else 0.0
        except Exception:
            amt = 0.0
        if d is None:
            idx = 0 if amt else 4
        else:
            diff = (base.year - d.year) * 12 + (base.month - d.month)
            idx = 0 if diff >= 4 else (1 if diff == 3 else (2 if diff == 2 else (3 if diff == 1 else 4)))
        f["分类"] = labels[idx]
        for i, c in enumerate(cols):
            f[c] = amt if i == idx else 0
    return recs


def apply_view_filter(recs, spec, tag=""):
    """按视图口径过滤记录（对应手册导出前在列头上做的临时筛选）。

    1) filter_blank 指定的列：只保留该列为空的行。
       客户未回款平台表 -> 「备注3」为空（有值 = 无效单，共 34 条，不计入看板）。
    2) filter_exclude 指定的列：剔除该列取值命中 exclude_values 的行。
       已开票未回款-每天 -> 「业务员」!= 财务部（财务部 13 条/90.40万 不计入）。
    3) filter_exclude_contains 指定的列：剔除该列「包含」任一关键词的行（模糊匹配）。
       已发货未开票-每天 -> 「备注」含「无效订单」的行不计入看板。
       用模糊匹配是因为该列还有「转移结算说明」「待回款」等其它备注，
       这些是有效跟进中的单，不能一起剔掉。
    规则 1/2 来自用户 2026-09-18 确认，规则 3 来自 2026-09-22 确认。
    """
    out = recs

    key = spec.get("filter_blank")
    if key:
        if key.endswith("*"):
            # 通配：源表标记列的名字会被改，运行时解析，别写死（见 2026-10-10 事故）
            exist, withval = resolve_note_fields(out, key)
            if not withval:
                # 找不到标记列 ⇒ **宁可不用这次数据**（保住上次正确的导出文件），
                # 也绝不能把未过滤的全量写进去。
                log(f"    [告警] {tag} 通配「{key}」没匹配到任何有值字段"
                    f"（现有备注类字段：{exist or '无'}）⇒ **本次不覆盖导出文件**")
                spec["_filter_failed"] = True
                return out
            kept = [r for r in out
                    if not any(_cell_text((r.get("fields") or {}).get(n)) for n in withval)]
            log(f"    {tag} 剔除「{'/'.join(withval)}」非空的行：{len(out)} -> {len(kept)} 条"
                f"（剔除 {len(out) - len(kept)} 条）")
            out = kept
        else:
            kept = [r for r in out if not _cell_text(r.get("fields", {}).get(key))]
            if len(kept) != len(out):
                log(f"    {tag} 过滤「{key}」为空：{len(out)} -> {len(kept)} 条"
                    f"（剔除 {len(out) - len(kept)} 条）")
            out = kept

    nz_col = spec.get("filter_positive")
    if nz_col:
        def _nz(r):
            v2 = _cell_text((r.get("fields") or {}).get(nz_col))
            if not v2 or v2.startswith("#"):
                return False
            try:
                return float(v2) > 0.005
            except Exception:
                return False
        kept = [r for r in out if _nz(r)]
        log(f"    {tag} 只保留「{nz_col}」为正：{len(out)} -> {len(kept)} 条（剔除 {len(out)-len(kept)} 条）")
        out = kept

    ex_col = spec.get("filter_exclude")
    if ex_col:
        vals = spec.get("exclude_values", [])
        kept = [r for r in out
                if _cell_text(r.get("fields", {}).get(ex_col)) not in vals]
        if len(kept) != len(out):
            log(f"    {tag} 剔除「{ex_col}」={'/'.join(vals)}：{len(out)} -> {len(kept)} 条"
                f"（剔除 {len(out) - len(kept)} 条）")
        out = kept

    # 剔除「包含关键词」的行。
    # 2026-10-24 改：支持**多条规则**（列表）。原先只能配一条 —— 未开票线既要剔「财务」
    # 又要剔「备注含无效订单」，写成两个同名 key 时 Python 会让后者覆盖前者，
    # 财务规则被静默吃掉（本次未开票没有财务数据所以没出事，但这是真隐患）。
    # 写法：字符串（旧，配 exclude_keywords）或 [{"col": "...", "keywords": [...]}, ...]
    cnt_rules = spec.get("filter_exclude_contains")
    if cnt_rules:
        if isinstance(cnt_rules, str):
            cnt_rules = [{"col": cnt_rules, "keywords": spec.get("exclude_keywords", [])}]
        for rule in cnt_rules:
            cnt_col = rule.get("col")
            kws = rule.get("keywords") or []
            if not cnt_col or not kws:
                continue
            if cnt_col.endswith("*"):
                _, check_cols = resolve_note_fields(out, cnt_col)   # 同样不写死列名
            else:
                check_cols = [cnt_col]
            bad = [r for r in out
                   if any(k in " ".join(_cell_text((r.get("fields") or {}).get(n))
                                        for n in check_cols)
                          for k in kws)]
            if bad:
                log(f"    {tag} 剔除「{'/'.join(check_cols) or cnt_col}」含 {'/'.join(kws)}："
                    f"{len(out)} -> {len(out) - len(bad)} 条（剔除 {len(bad)} 条）")
                for r in bad[:8]:
                    log(f"        - " + " | ".join(
                        _cell_text((r.get("fields") or {}).get(n))[:40] for n in check_cols))
            out = [r for r in out if r not in bad]

    return out


def fetch_records(mcp, sheet_id, cols, tag=""):
    """分页拉取整表记录。

    ⚠️ 2026-10-10：**不再用 cols 限制返回字段**（原先传 "fields": cols）。
    源表的列名会被改（同一天里「备注2」就变成了「备注3」），一旦改名，
    请求里写的那个名字就取不到值，而**过滤规则是按列名判断的 ⇒ 静默失效**
    （当天因此把 304 行脏数据写回看板，看板从 191.65 万变回 307.58 万）。
    改成拉全字段：多几个字段的代价可忽略，换来对改名的免疫。
    导出列的顺序仍由 cols 决定（见 write_xlsx），不受影响。
    """
    out, offset, page = [], "", 0
    while True:
        args = {"file_id": FILE_ID, "sheet_id": sheet_id, "page_size": 1000}
        if offset:
            args["offset"] = offset
        data = mcp.call("dbsheet.list_records", args)
        detail = data.get("data", {}).get("detail", {})
        recs = detail.get("records", [])
        out.extend(recs)
        page += 1
        offset = detail.get("offset")
        if not offset:
            break
        if page > 200:
            break
    log(f"    {tag} 拉取 {len(out)} 条记录（{page} 页）")
    return out


# 权威兜底映射（2026-10-24 使用者提供的「销售区域划分」表：每个战队的负责人）。
# 用途：sheet123 里没出现过的业务员（例如只做开票业务的李国俊），统计法映射不到，
#      用这张表兜底。已统计出来的不覆盖（setdefault）。
DEPT_FALLBACK = {
    "大项目部": "大项目部",
    "唐良超": "销售一部",
    "雷小慧": "销售二部",
    "吴青": "销售三部",
    "李国俊": "销售四部",
    "刘晓欣": "销售五部",
    "李总": "李总战队",
    "项目组": "综合拓展战队",
}


# 业务员别名（2026-10-24 使用者确认「综合拓展战队全部归李云云」）。
# 源表里「深圳桂银权益平台」的 23 单（已开票 3 + 已发货 20）业务员填的是「李雅芳」，
# 但实际归属是李云云 ⇒ 取数时就换掉，看板按李云云统计。
# ⚠️ 只影响看板显示；源表原值不动（要查原始记录请回源表）。
SALESMAN_ALIAS = {
    "李雅芳": "李云云",
}


def sanity_check(recs, spec, tag=""):
    """写出前的体检：业务员/部门空值率过高 = 源表字段名又变了，宁可不出数也不出错数。

    返回 False 表示本次不允许覆盖导出文件（调用方会跳过 write_xlsx）。
    """
    n = len(recs)
    if not n:
        return True
    empty_sp = sum(
        1 for r in recs
        if not (flat(field_value(r.get("fields") or {}, spec, "业务员")) or "").strip()
    )
    ratio = empty_sp / n
    if ratio > 0.5:
        log(f"    [严重] {tag} 业务员为空 {empty_sp}/{n}（{ratio:.0%}）"
            f"⇒ 源表字段名八成又改了（现有字段见 _probe-sheet123-fields.py），"
            f"**本次不覆盖导出文件**")
        spec["_filter_failed"] = True
        return False
    if ratio > 0.2:
        log(f"    [告警] {tag} 业务员为空 {empty_sp}/{n}（{ratio:.0%}），请确认源表是否漏填")
    return True


def dump_pay_info(recs, out_path=None):
    """导出每单的回款信息，供看板「当日回款」自动标注用（2026-10-27）。

    为什么需要：看板只能看到「这单从列表里消失了」，无法区分
    「真回款 / 补录旧回款 / 源表删行作废 / 部分回款」。这些信息只有源表有，
    所以取数时顺手导一份 JSON，Node 侧同步时入库，用来生成备注。

    输出：{ doc_no: { payDate, payAmt, unpaid, invoiceAmt } }
    """
    out = {}
    for r in recs:
        f = r.get("fields") or {}
        doc = (flat(f.get("开票方案编号")) or "").strip()
        if not doc:
            continue
        # 同一编号可能多行（按账龄拆），金额累加、日期取第一个非空的
        cur = out.get(doc)
        pd = (flat(f.get("回款日期")) or "").strip()
        if cur is None:
            out[doc] = {
                "payDate": pd,
                "payAmt": to_num(f.get("回款金额")),
                "unpaid": to_num(f.get("已开票未回款")),
                "invoiceAmt": to_num(f.get("开票金额")),
            }
        else:
            cur["payAmt"] += to_num(f.get("回款金额"))
            cur["unpaid"] += to_num(f.get("已开票未回款"))
            cur["invoiceAmt"] += to_num(f.get("开票金额"))
            if not cur["payDate"] and pd:
                cur["payDate"] = pd

    target = out_path or os.path.join(
        r"C:\Users\Administrator\Desktop\cloud-dashboard", "server", ".runtime", "pay-info.json"
    )
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False)
    log(f"    [回款信息] 导出 {len(out)} 单 → {os.path.basename(target)}")
    return target


def materialize_aliases(recs, spec):
    """把 field_aliases 的别名值**写到主字段名下**。

    🔴 2026-10-26 事故：过滤规则（filter_exclude_contains 等）是按**主字段名**读的
    （`f.get("业务员")`），而源表字段叫「客户经理」时 f["业务员"] 是空的 ⇒
    财务口径过滤静默失效，多算了 17 单 386 万。
    在 fetch 之后、过滤之前调用这个，让别名值先落到主字段上，过滤和导出就都能读到。
    """
    n = 0
    aliases = spec.get("field_aliases") or {}
    for r in recs:
        f = r.get("fields")
        if not isinstance(f, dict):
            continue
        for main in aliases:
            if f.get(main) in (None, "", []):
                v = field_value(f, spec, main)
                if v not in (None, "", []):
                    f[main] = v
                    n += 1
    return n


def apply_salesman_alias(recs, spec=None):
    """把「业务员」按 SALESMAN_ALIAS 换名（在部门映射之前执行）。"""
    n = 0
    for r in recs:
        f = r.get("fields")
        if not isinstance(f, dict):
            continue
        cur = (flat(field_value(f, spec or {}, "业务员")) or "").strip()
        new = SALESMAN_ALIAS.get(cur)
        if new:
            f["业务员"] = new
            n += 1
    return n


def build_dept_map(mcp):
    """业务员(人名) → 销售战队(部门)，取**多数派**。

    背景（2026-10-24 使用者要求「回款也按部门」）：
      「已开票未回款」取自客户开票明细表(sheet 26)，那张表 25 个字段里**没有「销售战队」**；
      而客户对账明细表(sheet 123) 同时有「客户经理」(人名) 和「销售战队」(部门)。
      所以用 123 里的对应关系，把 26 里的业务员换成人所在的战队。

    ⚠️ 同一个人会跨多个战队（调岗 / 兼管，实测唐良超有 47 单在销售四部、20 单在大项目部），
       这里按出现次数取多数派 —— **总额绝对不变，但少数单的部门归属是近似值**。
       要 100% 准确，只能在源表 sheet 26 上加「销售战队」字段由业务人员填。
    """
    cnt = {}
    try:
        for r in fetch_records(mcp, 123, [], "部门映射"):
            f = r.get("fields", {}) or {}
            # ⚠️ flat() 对空值返回 None（不是空串），必须 or '' 兜住
            name = (flat(f.get("客户经理")) or "").strip()
            dept = (flat(f.get("销售战队")) or "").strip()
            if not name or not dept:
                continue
            cnt.setdefault(name, {})
            cnt[name][dept] = cnt[name].get(dept, 0) + 1
    except Exception as e:
        log(f"    [警告] 部门映射构建失败（不影响取数，业务员保持原名）：{e}")
        return {}
    # 取每个名字出现最多的那个战队
    m = {n: max(d.items(), key=lambda kv: kv[1])[0] for n, d in cnt.items()}
    # 权威表兜底：只补统计不到的，不覆盖已有结果
    for name, dept in DEPT_FALLBACK.items():
        m.setdefault(name, dept)
    return m


def field_value(fields, spec, name):
    """按 spec 的 field_aliases 取字段值：原名单优先，取不到再试别名。

    ⚠️ 2026-10-24 踩过：apply_dept_map 直接读 f["业务员"]，但未开票表源字段叫「客户经理」，
       别名只在 write_xlsx 里生效 ⇒ 映射阶段读到空，整条线一条都没归到部门（日志「补齐部门 0/2030」）。
       统一走这个函数，避免两处逻辑不一致。
    """
    v = fields.get(name)
    if v is None or v == "" or v == []:
        for alt in (spec.get("field_aliases") or {}).get(name, []):
            v2 = fields.get(alt)
            if v2 is not None and v2 != "" and v2 != []:
                return v2
    return v


def apply_dept_map(recs, dept_map, spec=None):
    """给每条记录定「部门」（销售战队）。

    2026-10-24 使用者给了「销售区域划分」表并要求「按照这个区分 / 数据按部门取」：
      销售一部=唐良超、销售二部=雷小慧、销售三部=吴青、销售四部=李国俊、
      销售五部=刘晓欣、李总战队=李总、综合拓展战队=项目组、大项目部=大项目部。
    ⇒ **表里的人一律强制归到他的战队**，不再看每单源表填的是哪个战队
      （源表里唐良超有 47 单挂在销售四部、20 单在大项目部，按表都要算销售一部）。
    ⇒ 表外的人（李雅芳、蒋超、李云云、农立珍、陈久家、廖总等）仍按源表战队；源表没填才用统计映射补。
    """
    hit = 0
    for r in recs:
        f = r.get("fields")
        if not isinstance(f, dict):
            continue
        raw = (flat(field_value(f, spec or {}, "业务员")) or "").strip()
        # 1) 权威表：强制覆盖
        if raw in DEPT_FALLBACK:
            f["部门"] = DEPT_FALLBACK[raw]
            hit += 1
            continue
        # 2) 表外：源表已有战队就尊重
        if (flat(field_value(f, spec or {}, "部门")) or "").strip():
            hit += 1
            continue
        # 3) 都没有，用统计映射兜底
        dept = dept_map.get(raw)
        if dept:
            f["部门"] = dept
            hit += 1
    return hit


def write_xlsx(records, spec, out_path, cmap=None):
    """按导出列顺序写 xlsx（先写临时文件再原子替换，避免被监听读到半个文件）。

    cmap：客户基本信息表 id→名称 映射；用于把「挂账客户 / 权限」关联 id 翻回中文。
    """
    cols = spec["cols"]
    date_cols = set(spec["date_cols"])
    num_cols = set(spec["num_cols"])
    cmap = cmap or {}

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = spec["sheet_name"]
    ws.append(cols)
    for c in range(1, len(cols) + 1):
        ws.cell(row=1, column=c).font = Font(bold=True)
        ws.cell(row=1, column=c).alignment = Alignment(horizontal="center")

    for rec in records:
        f = rec.get("fields", {}) or {}
        row = []
        for name in cols:
            v = f.get(name)
            # 字段别名兜底（2026-10-24）：源表会改列名（sheet123 的「业务员」→「客户经理」），
            # 按名字取不到就整列变空，且不报错 —— 只能靠这里兼容。
            if v is None or v == "" or v == []:
                for alt in (spec.get("field_aliases") or {}).get(name, []):
                    v2 = f.get(alt)
                    if v2 is not None and v2 != "" and v2 != []:
                        v = v2
                        break
            if name in date_cols:
                row.append(to_date(v))
            elif name in num_cols:
                row.append(to_num(v))
            elif name in CUSTOMER_LINK_FIELDS and cmap:
                # 关联列：先按 记录id 翻成中文名，翻不到再退回 flat 结果
                x = resolve_link(flat(v), cmap, name)
                if x is None:
                    x = flat(v)
                row.append("" if x is None else x)
            else:
                x = flat(v)
                row.append("" if x is None else x)
        ws.append(row)

    tmp = out_path + ".tmp"
    wb.save(tmp)
    os.replace(tmp, out_path)
    return out_path


def load_token():
    """读取凭证：跳过空行和以 # 开头的说明行，取第一行有效内容。"""
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, encoding="utf-8-sig") as f:
                for line in f:
                    line = line.strip().replace("\r", "").replace("\n", "")
                    if line and not line.startswith("#"):
                        return line.replace("Bearer", "").strip()
        except Exception:
            pass
    return ""


def acquire_lock():
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", LOCK_PORT))
        s.listen(1)
    except OSError:
        return None
    return s


def main():
    global _log_fh
    os.makedirs(OUT_DIR, exist_ok=True)
    _log_fh = open(LOG_FILE, "a", encoding="utf-8", buffering=1)

    argv = [a for a in sys.argv[1:]]
    check_only = "--check" in argv
    picked = [a for a in argv if not a.startswith("--")] or list(TABLES.keys())
    bad = [a for a in picked if a not in TABLES]
    if bad:
        log(f"[错误] 不认识的表名: {bad}，可选: {list(TABLES.keys())}")
        return 2

    log("\n" + "=" * 52)
    log("[云端取数] " + datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    token = load_token()
    if not token:
        log("[错误] 未找到凭证。请把金山文档 Token 写入：")
        log("       " + TOKEN_FILE)
        log("       获取方式：浏览器打开 https://www.kdocs.cn/latest")
        log("               -> 右上角头像菜单 -> 「龙虾专属入口」-> 复制 Token")
        return 3

    lock = acquire_lock()
    if lock is None:
        log("[提示] 已有一个取数进程在运行，本进程退出。")
        return 0

    mcp = KdocsMcp(token)
    try:
        mcp.connect()
    except Exception as e:
        log(f"[错误] 无法连接金山文档服务: {e}")
        return 4

    if check_only:
        try:
            fetch_records(mcp, TABLES["未回款"]["sheet_id"], ["业务员"], "凭证校验")
            log("[OK] 凭证有效，可以正常取数。")
            return 0
        except AuthError:
            log("[错误] 凭证已失效（400006）。请重新获取 Token 写入 kdocs_token.txt。")
            return 5
        except Exception as e:
            log(f"[错误] 校验失败: {e}")
            return 4

    ok, fail = [], []
    cmap = load_customer_map(mcp)
    # 未回款表(sheet26)没有「销售战队」字段 ⇒ 用 sheet123 的「人名→战队」映射补上
    # （2026-10-24 使用者要求两条线统一按部门统计）
    dept_map = {}
    # 两条线都要「业务员 → 战队」，因为部门口径统一按使用者的「销售区域划分」表（2026-10-24）
    if "未回款" in picked or "未开票" in picked:
        dept_map = build_dept_map(mcp)
        log(f"    [部门映射] 载入 {len(dept_map)} 个人名→战队")
    for _idx, key in enumerate(picked):
        spec = TABLES[key]
        try:
            recs = fetch_records(mcp, spec["sheet_id"], spec["cols"], key)
            # 先把别名值落到主字段（业务员←客户经理），过滤规则才读得到
            n_mat = materialize_aliases(recs, spec)
            if n_mat:
                log(f"    [字段别名] 落位 {n_mat} 条")
            # 未回款表额外导出回款信息（供看板自动标注：真回款 / 补录 / 源表删行）
            if key == "未回款":
                try:
                    dump_pay_info(recs)
                except Exception as e:
                    log(f"    [警告] 回款信息导出失败（不影响取数）：{e}")
            # 回款线：业务员人名 → 战队（映射不到的原样保留，如「财务平台开票」）
            if key in ("未回款", "未开票") and dept_map:
                # 先按别名换业务员（李雅芳→李云云），再按部门映射
                n_alias = apply_salesman_alias(recs, spec)
                if n_alias:
                    log(f"    [业务员别名] 换名 {n_alias} 条")
                n_hit = apply_dept_map(recs, dept_map, spec)
                log(f"    [部门映射] 补齐部门 {n_hit}/{len(recs)} 条")
            recs = apply_view_filter(recs, spec, key)
            if spec.get("aging"):
                compute_aging(recs, spec["aging"])
            # 过滤规则没法生效（比如标记列又被改名）⇒ 不覆盖导出文件，保住上次正确数据
            if spec.pop("_filter_failed", False):
                log(f"    [跳过] {key}：过滤规则无法生效，本次不覆盖导出文件")
                fail.append(key)
                continue
            if not recs:
                log(f"    [警告] {key} 返回 0 条记录，跳过（不覆盖本地文件）")
                fail.append(key)
                continue
            # 🔴 2026-10-26 事故防护：源表字段名会被改（业务员↔客户经理），
            #    改完取数整列变空 ⇒ 看板「未指定/未分类」、财务过滤失效，还会静默上线。
            #    这里做体检：业务员空值率 >50% 直接拒绝覆盖（保住上一份正确的数据）；
            #    20%~50% 打告警但仍写出（可能确实有少量单没填业务员）。
            if not sanity_check(recs, spec, key):
                fail.append(key)
                continue
            path = write_xlsx(recs, spec, os.path.join(OUT_DIR, spec["out_name"]), cmap)
            log(f"    [已更新] {os.path.basename(path)}  ({len(recs)} 行)")
            ok.append(key)
        except AuthError:
            log("[错误] 凭证已失效（400006）。请重新获取 Token 写入 kdocs_token.txt。")
            return 5
        except Exception as e:
            log(f"    [失败] {key}: {e}")
            fail.append(key)
        # 控制请求频率，避免被限流（2026-10-21 调整）：
        #   · 最后一张表拉完就没必要再等 0.8 秒 —— 本来就什么都还没做，纯浪费；
        #   · 间隔从 0.8 收到 0.5，5 张表能省 2 秒多，仍保留间隔以防金山限流。
        if _idx < len(picked) - 1:
            time.sleep(0.5)

    log(f"[完成] 成功 {len(ok)} 张，失败 {len(fail)} 张" + (f"：{fail}" if fail else ""))
    if ok:
        log("输出目录: " + OUT_DIR)
    return 0 if not fail else 1


if __name__ == "__main__":
    sys.exit(main())
