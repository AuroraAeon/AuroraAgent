#!/usr/bin/env python3
"""LongCat-2.5-Preview 纯色识别测试 — 学术图表（nature-figure 技能流程）
契约: 核心结论 = 均匀纯色图像触发系统性颜色误判（彩色 0/33 全错，对照 3/3 正确），
缺陷定位于均匀图像颜色感知而非上传/解码链路。archetype: image plate + quant。backend: Python。"""
import glob
import json
import os

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.patches import Rectangle
from matplotlib.colors import LinearSegmentedColormap

_PINGFANG = "/System/Library/AssetsV2/com_apple_MobileAsset_Font8/86ba2c91f017a3749571a82f2c6d890ac7ffb2fb.asset/AssetData/PingFang.ttc"
if os.path.exists(_PINGFANG):
    fm.fontManager.addfont(_PINGFANG)

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["PingFang SC", "Heiti SC", "Arial Unicode MS", "DejaVu Sans"],
    "svg.fonttype": "none",
    "pdf.fonttype": 42,
    "font.size": 7,
    "axes.spines.right": False,
    "axes.spines.top": False,
    "axes.linewidth": 0.8,
    "legend.frameon": False,
})

from audit_panel_alignment import require_matplotlib_panel_alignment

# 自定位路径：图表输出到 ../figures，轮次原始数据取本目录 round*.json（随 App Bundle 一起搬移）
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "figures"))
ROUND_GLOB = os.path.join(HERE, "round*.json")
os.makedirs(OUT, exist_ok=True)

C_CHROM, C_ACHRO, C_CTRL = "#B64342", "#767676", "#42949E"
C_OK, C_BAD, C_PART = "#2E9E44", "#E53935", "#B26A00"
C_INK = "#272727"
CMAP_CNT = LinearSegmentedColormap.from_list("cnt", ["#FFFFFF", "#9DB8D9", "#0F4D92"])

ALIASES = {
    "红": ["红", "赤"], "绿": ["绿"], "蓝": ["蓝"], "黄": ["黄"], "紫": ["紫"],
    "橙": ["橙"], "青": ["青", "蓝绿"], "粉": ["粉"], "黑": ["黑"], "白": ["白"],
    "灰": ["灰"], "棕": ["棕", "褐"], "红@64": ["红", "赤"], "深蓝": ["蓝"], "红底白圆": ["红"],
}
PRED_ORDER = ["黑色", "白色", "浅粉色", "品红色", "红色"]

rounds = [json.load(open(p)) for p in sorted(glob.glob(ROUND_GLOB))]
NR = len(rounds)
base = rounds[0]["cases"]
names = [c["name"] for c in base]
rgb_of = {c["name"]: c["rgb"] for c in base}
size_of = {c["name"]: c["size"] for c in base}
ctrl_of = {c["name"]: bool(c["control"]) for c in base}
ans_of = {n: [next(cc["answer"] for cc in r["cases"] if cc["name"] == n) for r in rounds] for n in names}

def is_ok(name, ans):
    norm = ans.lower().replace(" ", "")
    return any(a in norm for a in ALIASES[name])

def cls_of(name):
    if ctrl_of[name]:
        return "control"
    r, g, b = rgb_of[name]
    return "achromatic" if r == g == b else "chromatic"

CLS_COLOR = {"chromatic": C_CHROM, "achromatic": C_ACHRO, "control": C_CTRL}
CLS_LABEL = {"chromatic": "彩色纯色", "achromatic": "消色纯色", "control": "对照（红底白圆）"}

order = ([n for n in names if cls_of(n) == "chromatic"]
         + [n for n in names if cls_of(n) == "achromatic"]
         + [n for n in names if cls_of(n) == "control"])
k_of = {n: sum(is_ok(n, a) for a in ans_of[n]) for n in names}
maj_of = {n: max(set(ans_of[n]), key=ans_of[n].count) for n in names}

M = np.zeros((len(PRED_ORDER), len(order)), dtype=int)
for j, n in enumerate(order):
    for a in ans_of[n]:
        M[PRED_ORDER.index(a), j] += 1

def panel_label(ax, label):
    from matplotlib.transforms import ScaledTranslation
    off = ScaledTranslation(-4 / 72, 3 / 72, ax.figure.dpi_scale_trans)
    ax.text(0, 1, label, transform=ax.transAxes + off, fontsize=8, fontweight="bold",
            color="black", ha="left", va="bottom")

def save_all(fig, stem):
    require_matplotlib_panel_alignment(
        fig, json_out=f"{OUT}/{stem}.alignment.json",
        overlay_svg=f"{OUT}/{stem}.alignment.svg",
        tolerance_pt=1.5, gutter_tolerance_pt=1.5,
        require_panel_labels=True, strict=True)
    fig.savefig(f"{OUT}/{stem}.svg", bbox_inches="tight")
    fig.savefig(f"{OUT}/{stem}.pdf", bbox_inches="tight")
    fig.savefig(f"{OUT}/{stem}.png", dpi=300, bbox_inches="tight")
    plt.close(fig)
    print("exported", stem)

def build_plate(sw=256, gut=18, cap=136, cols=5):
    rows = (len(order) + cols - 1) // cols
    W = cols * sw + (cols + 1) * gut
    H = rows * (sw + cap) + (rows + 1) * gut
    img = np.full((H, W, 3), 255, dtype=np.uint8)
    boxes = []
    for idx, n in enumerate(order):
        r, c = divmod(idx, cols)
        x0, y0 = gut + c * (sw + gut), gut + r * (sw + cap + gut)
        if ctrl_of[n]:
            yy, xx = np.mgrid[0:sw, 0:sw]
            mask = (xx - sw / 2) ** 2 + (yy - sw / 2) ** 2 < (sw * 0.3) ** 2
            block = np.tile(np.array(rgb_of[n], dtype=np.uint8), (sw, sw, 1))
            block[mask] = [245, 245, 245]
            img[y0:y0 + sw, x0:x0 + sw] = block
        else:
            s = size_of[n]
            cell = np.tile(np.array(rgb_of[n], dtype=np.uint8), (s, s, 1))
            if s != sw:
                cell = np.kron(cell, np.ones((sw // s, sw // s, 1), dtype=np.uint8))
            img[y0:y0 + sw, x0:x0 + sw] = cell
        boxes.append((x0, y0))
    return img, boxes, W, H

def fig1():
    fig = plt.figure(figsize=(183 / 25.4, 118 / 25.4))
    gs = fig.add_gridspec(2, 2, left=0.015, right=0.985, top=0.895, bottom=0.085,
                          wspace=0.16, hspace=0.46)
    fig.text(0.015, 0.972, "LongCat-2.5-Preview 对均匀纯色图像的颜色误判",
             fontsize=7.5, fontweight="bold", color=C_INK, ha="left", va="top")
    fig.text(0.985, 0.972, f"3 轮 × 15 刺激 = {NR * len(order)} 次请求",
             fontsize=6, color="#767676", ha="right", va="top")

    ax_a = fig.add_subplot(gs[:, 0])
    img, boxes, W, H = build_plate()
    ax_a.imshow(img, origin="upper", interpolation="nearest")
    ax_a.set_xlim(0, W)
    ax_a.set_ylim(H, 0)
    ax_a.set_aspect("equal", adjustable="datalim")
    ax_a.axis("off")
    for (x0, y0), n in zip(boxes, order):
        ax_a.add_patch(Rectangle((x0 + 2, y0 + 2), 252, 252, fill=False,
                                 ec=CLS_COLOR[cls_of(n)], lw=1.2))
        cx = x0 + 128
        ax_a.text(cx, y0 + 278, n, ha="center", va="top", fontsize=6.5,
                  fontweight="bold", color=C_INK)
        ax_a.text(cx, y0 + 320, f"答 {maj_of[n]}", ha="center", va="top",
                  fontsize=5.5, color=C_INK)
        kc = C_OK if k_of[n] == NR else (C_BAD if k_of[n] == 0 else C_PART)
        ax_a.text(cx, y0 + 356, f"{k_of[n]}/{NR} 轮正确", ha="center", va="top",
                  fontsize=5.5, fontweight="bold", color=kc)
    panel_label(ax_a, "a")

    ax_b = fig.add_subplot(gs[0, 1])
    ax_b.imshow(M, cmap=CMAP_CNT, vmin=0, vmax=NR, aspect="auto",
                extent=[-0.5, len(order) - 0.5, len(PRED_ORDER) - 0.5, -0.5])
    for i in range(len(PRED_ORDER) + 1):
        ax_b.axhline(i - 0.5, color="white", lw=0.7)
    for j in range(len(order) + 1):
        ax_b.axvline(j - 0.5, color="white", lw=0.7)
    for i in range(len(PRED_ORDER)):
        for j in range(len(order)):
            if M[i, j] > 0:
                lum = 0.299 + 0.7 * (M[i, j] / NR)
                ax_b.text(j, i, str(M[i, j]), ha="center", va="center", fontsize=5.5,
                          color="white" if lum < 0.55 else C_INK)
    ax_b.add_patch(Rectangle((len(order) - 1.5, -0.5), 1, len(PRED_ORDER), fill=False,
                             ec=C_CTRL, lw=1.6))
    ax_b.set_xticks(range(len(order)))
    ax_b.set_xticklabels(order, rotation=90, fontsize=5.5, ha="center",
                         rotation_mode="anchor")
    for tick, n in zip(ax_b.get_xticklabels(), order):
        tick.set_color(CLS_COLOR[cls_of(n)])
    ax_b.set_yticks(range(len(PRED_ORDER)))
    ax_b.set_yticklabels(PRED_ORDER, fontsize=5.5)
    ax_b.set_xlabel("刺激图像（标签颜色 = 类别）", fontsize=5.5, color="#767676")
    ax_b.set_ylabel("模型回答", fontsize=5.5, color="#767676")
    ax_b.set_title("回答分布：彩色刺激的回答坍塌为消色", fontsize=6, color=C_INK, pad=3)
    panel_label(ax_b, "b")

    ax_c = fig.add_subplot(gs[1, 1])
    classes = ["chromatic", "achromatic", "control"]
    stats = []
    for cl in classes:
        members = [n for n in order if cls_of(n) == cl]
        per_round = [sum(is_ok(n, ans_of[n][ri]) for n in members) / len(members) for ri in range(NR)]
        agg = sum(k_of[n] for n in members) / (len(members) * NR)
        stats.append((cl, members, per_round, agg))
    for xi, (cl, members, per_round, agg) in enumerate(stats):
        for ri, v in enumerate(per_round):
            ax_c.scatter(xi + (ri - (NR - 1) / 2) * 0.09, v, s=12, color=CLS_COLOR[cl],
                         alpha=0.45, zorder=3, linewidths=0)
        ax_c.scatter([xi], [agg], s=46, color=CLS_COLOR[cl], zorder=4, linewidths=0)
        ktot = sum(k_of[n] for n in members)
        ntot = len(members) * NR
        ax_c.annotate(f"{ktot}/{ntot}（{agg * 100:.0f}%）", (xi, agg),
                      textcoords="offset points", xytext=(11, -2), ha="left",
                      fontsize=5.5, fontweight="bold", color=CLS_COLOR[cl])
    ax_c.set_xlim(-0.55, 2.55)
    ax_c.set_ylim(-0.08, 1.28)
    ax_c.set_xticks(range(3))
    ax_c.set_xticklabels([f"{CLS_LABEL[cl]}\n{len(stats[i][1])} 刺激 × {NR} 轮"
                          for i, cl in enumerate(classes)], fontsize=5.5)
    for tick, cl in zip(ax_c.get_xticklabels(), classes):
        tick.set_color(CLS_COLOR[cl])
    ax_c.set_ylabel("答对比例", fontsize=5.5, color="#767676")
    ax_c.set_yticks([0, 0.5, 1.0])
    ax_c.set_yticklabels(["0", "50%", "100%"], fontsize=5.5)
    ax_c.scatter([], [], s=12, color="#767676", alpha=0.45, linewidths=0, label="单轮")
    ax_c.scatter([], [], s=46, color="#767676", linewidths=0, label=f"{NR} 轮合计")
    ax_c.legend(loc="upper left", fontsize=5.5, handletextpad=0.3, borderaxespad=0.2,
                labelcolor="#767676")
    ax_c.set_title("按刺激类别汇总：仅消色与对照可识别", fontsize=6, color=C_INK, pad=3)
    panel_label(ax_c, "c")

    fig.text(0.015, 0.012,
             "计数 = 3 轮中该回答出现次数（temperature = 0）；刺激为本地生成纯色 PNG（256 px，"
             "“红@64”为 64 px 最近邻放大显示）；对照 = 红底白圆。源数据：color-summary-3rounds.csv。",
             fontsize=5, color="#767676", ha="left", va="bottom")
    save_all(fig, "fig1-solid-color-misidentification")

def fig2():
    fig = plt.figure(figsize=(183 / 25.4, 108 / 25.4))
    gs = fig.add_gridspec(1, 2, left=0.015, right=0.985, top=0.855, bottom=0.135,
                          wspace=0.20)
    fig.text(0.015, 0.982, "误判的确定性与回答坍塌：三轮重复高度一致",
             fontsize=7.5, fontweight="bold", color=C_INK, ha="left", va="top")

    ax_d = fig.add_subplot(gs[0, 0])
    for j, n in enumerate(order):
        for ri in range(NR):
            a = ans_of[n][ri]
            ok = is_ok(n, a)
            ax_d.add_patch(Rectangle((ri - 0.5, j - 0.5), 1, 1,
                                     facecolor="#DDF3DE" if ok else "#F6CFCB",
                                     edgecolor="white", lw=0.7))
            ax_d.text(ri, j, a, ha="center", va="center", fontsize=5.5,
                      color="#1B5E20" if ok else "#8C1D18")
        same = len(set(ans_of[n])) == 1
        ax_d.text(NR + 0.25, j, "同" if same else "异", ha="center", va="center",
                  fontsize=5.5, color="#767676")
    ax_d.set_xlim(-0.5, NR + 0.9)
    ax_d.set_ylim(len(order) - 0.5, -0.5)
    ax_d.set_xticks([ri + 0.0 for ri in range(NR)] + [NR + 0.25])
    ax_d.set_xticklabels([f"第 {ri + 1} 轮" for ri in range(NR)] + ["3 轮一致"], fontsize=5.5)
    ax_d.xaxis.set_ticks_position("top")
    ax_d.set_yticks(range(len(order)))
    ax_d.set_yticklabels(order, fontsize=5.5)
    for tick, n in zip(ax_d.get_yticklabels(), order):
        tick.set_color(CLS_COLOR[cls_of(n)])
    for s in ax_d.spines.values():
        s.set_visible(False)
    ax_d.tick_params(length=0)
    n_same = sum(len(set(ans_of[n])) == 1 for n in order)
    ax_d.set_title(f"逐轮原始回答（{NR * len(order)} 次）", fontsize=6, color=C_INK, pad=11)
    panel_label(ax_d, "d")

    ax_e = fig.add_subplot(gs[0, 1])
    fam = [(p, sum(M[PRED_ORDER.index(p)])) for p in PRED_ORDER]
    fam.sort(key=lambda t: t[1])
    labels = [t[0] for t in fam]
    vals = [t[1] for t in fam]
    fam_color = {"黑色": C_ACHRO, "白色": C_ACHRO, "浅粉色": C_ACHRO, "品红色": C_ACHRO, "红色": C_CTRL}
    ypos = np.arange(len(labels))
    ax_e.barh(ypos, vals, height=0.62, color=[fam_color[l] for l in labels],
              edgecolor="white", linewidth=0.5)
    for y, v in zip(ypos, vals):
        ax_e.text(v + 0.4, y, f"{v}", va="center", fontsize=5.5, color=C_INK)
    ax_e.set_yticks(ypos)
    ax_e.set_yticklabels(labels, fontsize=5.5)
    ax_e.set_xlim(0, 31)
    ax_e.set_xticks([0, 10, 20, 30])
    ax_e.tick_params(axis="x", labelsize=5.5)
    ax_e.set_xlabel("回答次数（共 45 次）", fontsize=5.5, color="#767676")
    achro_total = sum(v for l, v in fam if l in {"黑色", "白色", "浅粉色"})
    ax_e.set_title(f"全部回答的分布：{achro_total}/45 为黑/白/浅粉等消色词", fontsize=6,
                   color=C_INK, pad=3)
    panel_label(ax_e, "e")

    fig.text(0.015, 0.012,
             f"每刺激 3 次独立请求（temperature = 0）；绿底 = 答对，红底 = 答错；"
             f"{n_same}/{len(order)} 个刺激三轮回答完全一致。"
             "Fisher 精确检验（单侧）：对照 vs 彩色纯色 p ≈ 0.00014；消色 vs 彩色纯色 p ≈ 0.00015。"
             "45 次回答中 40 次为黑/白/浅粉等消色词，42 次不是该刺激的正确颜色。"
             "源数据：color-raw-3rounds.csv。",
             fontsize=5, color="#767676", ha="left", va="bottom")
    save_all(fig, "fig2-determinism-and-collapse")

fig1()
fig2()
print("done")
