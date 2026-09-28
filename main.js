/* Jev Decision Log —— 五样本决策层（Noul/Choice/Score）
 * 移植自 novel-ai-writing-system 圣女共梦/04-Jev决策层.md：
 *   - 同题独立 5 样本，均值/分布均值过阈值
 *   - 置信度 = 均值 × 分散度惩罚（k = 1 − 极差/2）
 *   - 极差>0.5 或 argmax 不唯一 → divergent，降级一档执行
 *   - 阈值分层：≥0.85 自动 / 0.60-0.85 复核 / <0.60 转备选/人工
 *   - 决议与直觉冲突 → override_of_intuition 标记
 * 日志：vault 内 决策日志.jsonl（逐条）+ 决策日志.md（人读表）。面板给统计与 P3/P9 情绪曲线。
 */
const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, MarkdownView } = require("obsidian");

const VIEW_TYPE = "jev-decision-view";

// P1-P14 决策点清单（v2.2/v2.4 增补并入）
const POINTS = [
  ["P1", "本章主生长点", "章前", "Choice", "选项=台账生长点池+「不用新点，纯收钩」"],
  ["P2", "本章回收哪些钩子", "章前", "Noul", "逐钩判断「该在本章炸吗」"],
  ["P3", "本章情绪浓度档位", "章前", "Score", "0日常/1小失控/2双方破防/3不可逆代价"],
  ["P4", "本章是否需要新地点", "章前", "Noul", "拒绝为新鲜感开新图"],
  ["P5", "章末钩类型", "章前", "Choice", "悬念/转折/倒计时/人物反转/以上都不是"],
  ["P6", "单章目标字数档", "章前", "Choice", "2200~2500/2500~3200/3200+"],
  ["P7", "收割入账", "章后", "Noul", "新配角/地点逐个过「有名有姓有功能」"],
  ["P8", "修订力度", "审稿后", "Choice", "发布/小修/重写"],
  ["P9", "本章追读力", "章后", "Score", "0可弃/1能读/2追更/3连夜追"],
  ["P10", "本批还能直出几章", "章后", "Choice", "0停批复盘/1/2/3+"],
  ["P11", "现在收束是否伤书", "章后", "Noul", "短收风险判断"],
  ["P12", "距健康收束剩余章数", "章后", "Score", "0随时收/1剩3-5章/2剩5-10章/3大幕未开"],
  ["P13", "全书总章数", "P12换算", "Score", "已写+剩余均值=总长估计"],
  ["P14", "对话去标签测试", "审稿后", "Noul", "遮住说话人能否辨人（P14 固定复核项）"],
];

const TIER = [
  [0.85, "🟢 自动执行"],
  [0.60, "🟡 执行＋标记复核（高风险：下一章前复盘）"],
  [-1, "🔴 转备选方案 / 人工裁定（记 2-3 案+理由）"],
];

function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function round2(x) { return Math.round(x * 100) / 100; }

module.exports = class JevDecisionLog extends Plugin {
  async onload() {
    this.settings = Object.assign({}, {
      jsonl: "决策日志.jsonl",
      md: "决策日志.md",
    }, await this.loadData());

    this.addRibbonIcon("scale", "Jev 决策层：新决策", () => new DecisionModal(this).open());
    this.addCommand({ id: "new-decision", name: "新决策（五样本）", callback: () => new DecisionModal(this).open() });
    this.addCommand({ id: "stats-view", name: "打开决策统计面板", callback: () => this.openView() });
    this.addSettingTab(new JevSettingTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new JevView(leaf, this));
  }
  onunload() { this.app.workspace.detachLeavesOfType(VIEW_TYPE); }
  async saveSettings() { await this.saveData(this.settings); }

  currentChapter() {
    const v = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!v || !v.file) return null;
    const m = v.file.basename.match(/(\d+)\s*章?$/);
    return m ? parseInt(m[1]) : null;
  }

  async record(entry) {
    const jsonlFile = this.app.vault.getAbstractFileByPath(this.settings.jsonl);
    const line = JSON.stringify(entry);
    if (jsonlFile) {
      const cur = await this.app.vault.read(jsonlFile);
      await this.app.vault.modify(jsonlFile, cur.replace(/\s*$/, "") + "\n" + line + "\n");
    } else {
      await this.app.vault.create(this.settings.jsonl, line + "\n");
    }
    // 人读表
    let mdFile = this.app.vault.getAbstractFileByPath(this.settings.md);
    if (!mdFile) {
      mdFile = await this.app.vault.create(this.settings.md,
        "# 决策日志\n\n| 章 | 点 | 原语 | 均值 | 置信 | 分歧 | 推翻直觉 | 判定 |\n|---|---|---|---|---|---|---|---|\n");
    }
    const row = `| ${entry.chapter ?? "—"} | ${entry.point} | ${entry.primitive} | ${entry.mean} | ${entry.confidence} | ${entry.divergent ? "⚠️" : ""} | ${entry.override ? "🔄" : ""} | ${entry.verdict.replace(/[^\u4e00-\u9fa5＋]/g, "")} |`;
    const cur = await this.app.vault.read(mdFile);
    await this.app.vault.modify(mdFile, cur.replace(/\s*$/, "\n") + row + "\n");
    new Notice("决策已落盘");
  }

  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    leaf.view.render();
  }

  async parseJsonl() {
    const f = this.app.vault.getAbstractFileByPath(this.settings.jsonl);
    if (!f) return [];
    const cur = await this.app.vault.read(f);
    return cur.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  }
};

// ================= 新决策弹窗 =================
class DecisionModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "⚖ Jev 五样本决策" });

    // 决策点选择
    const rowP = contentEl.createDiv();
    rowP.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:6px;";
    rowP.createEl("label", { text: "决策点", attr: { style: "width:64px; font-weight:600; font-size:12px;" } });
    const selP = rowP.createEl("select");
    for (const [id, name, , prim, desc] of POINTS) {
      selP.createEl("option", { value: id, text: `${id} ${name}（${prim}）` });
    }
    const hint = contentEl.createDiv();
    hint.style.cssText = "font-size:11px; color:var(--text-muted); margin-bottom:8px;";
    const setHint = () => {
      const p = POINTS.find((x) => x[0] === selP.value);
      hint.setText(p ? p[3] + "：" + p[4] : "");
      renderInputs(p ? p[3] : "Noul");
    };
    selP.onchange = setHint;

    // 自定义问题
    const q = this._field(contentEl, "问题（可选）", "如：H15 该在本章炸吗");

    // 样本输入区（按原语渲染）
    let sampleContainer = contentEl.createDiv();
    const renderInputs = (prim) => {
      sampleContainer.empty();
      if (prim === "Choice") {
        sampleContainer.createEl("div", { text: "5 个独立样本各选一个选项（A-E）：", attr: { style: "font-size:12px; font-weight:600; margin-bottom:4px;" } });
        const wrap = sampleContainer.createDiv();
        wrap.style.cssText = "display:flex; gap:6px;";
        for (let i = 1; i <= 5; i++) {
          const s = wrap.createEl("select");
          for (const o of ["A", "B", "C", "D", "E"]) s.createEl("option", { text: o, value: o });
          s.dataset.idx = String(i);
        }
      } else {
        sampleContainer.createEl("div", {
          text: prim === "Score" ? "5 个独立分数（按该决策点的档位刻度，可小数）：" : "5 个独立概率（0-1）：",
          attr: { style: "font-size:12px; font-weight:600; margin-bottom:4px;" },
        });
        const wrap = sampleContainer.createDiv();
        wrap.style.cssText = "display:flex; gap:6px;";
        for (let i = 1; i <= 5; i++) {
          const s = wrap.createEl("input", { type: "text", placeholder: `样本${i}` });
          s.style.width = "64px";
        }
      }
      // 直觉预设
      const rowI = sampleContainer.createDiv();
      rowI.style.cssText = "display:flex; gap:8px; align-items:center; margin-top:8px;";
      rowI.createEl("label", { text: "直觉预设", attr: { style: "width:64px; font-size:12px; font-weight:600;" } });
      const inp = rowI.createEl("input", { type: "text", placeholder: "进决策前你默认的方案（用于 override 标记）" });
      inp.style.flex = "1";
      this._intuition = inp;
    };

    // 备注
    const note = this._field(contentEl, "备注", "侧重考量/理由");

    const computeBtn = contentEl.createEl("button", { text: "五样本集成 → 判定", cls: "mod-cta" });
    computeBtn.style.cssText = "width:100%; margin-top:10px; padding:8px;";
    const result = contentEl.createDiv();
    result.style.cssText = "margin-top:8px;";

    computeBtn.onclick = () => {
      result.empty();
      const p = POINTS.find((x) => x[0] === selP.value);
      const prim = p ? p[3] : "Noul";
      const inputs = [...sampleContainer.querySelectorAll("select, input[type=text]")]
        .filter((el) => el !== this._intuition && el !== q);
      let meanV, conf, divergent, detail, argmaxLabel;

      if (prim === "Choice") {
        const picks = inputs.map((s) => s.value);
        const dist = {};
        for (const v of picks) dist[v] = (dist[v] || 0) + 1;
        const entries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
        const top = entries[0][1];
        const unique = entries.length === 1 || entries[0][1] > entries[1][1];
        argmaxLabel = entries[0][0];
        conf = round2(top / 5 * (unique ? 1 : 1 - 0.5 / 2)); // 分布极差惩罚近似：不唯一打 0.75 折
        divergent = !unique;
        meanV = round2(top / 5);
        detail = `分布 ${JSON.stringify(dist)} · argmax=${argmaxLabel}${divergent ? "（不唯一）" : ""}`;
      } else {
        const vals = inputs.map((s) => parseFloat(s.value)).filter((v) => !isNaN(v));
        if (vals.length < 5) {
          result.createEl("div", { text: "❌ 需要 5 个有效样本值。", attr: { style: "color:var(--text-error);" } });
          return;
        }
        const m = mean(vals);
        const range = Math.max(...vals) - Math.min(...vals);
        meanV = round2(m);
        conf = round2(m * (1 - range / 2)); // 分散度惩罚 k=1−极差/2
        divergent = range > 0.5;
        detail = `样本[${vals.join(", ")}] 极差=${round2(range)}`;
      }

      // 阈值分层
      let verdict = TIER.find(([t]) => conf >= t)[1];
      if (divergent) verdict = "🟠 分歧即信息：降级一档执行 → " + verdict;

      const intuition = (this._intuition && this._intuition.value.trim()) || "";
      const override = intuition && !intuition.includes(String(argmaxLabel ?? "")) && !intuition.includes(String(meanV));
      if (override) verdict += " ｜ 🔄 推翻直觉";

      const box = result.createDiv();
      box.style.cssText = "padding:8px; background:var(--background-secondary); border-radius:6px; font-size:13px; line-height:1.6;";
      box.createEl("div", { text: `均值 ${meanV} ｜ 置信度 ${conf}${divergent ? " ⚠️ 分歧" : ""}`, attr: { style: "font-weight:700;" } });
      box.createEl("div", { text: detail, attr: { style: "color:var(--text-muted); font-size:12px;" } });
      box.createEl("div", { text: verdict });

      const save = result.createEl("button", { text: "落盘到决策日志", cls: "mod-cta" });
      save.style.marginTop = "6px";
      save.onclick = async () => {
        await this.plugin.record({
          ts: new Date().toISOString(),
          chapter: this.plugin.currentChapter(),
          point: selP.value,
          question: q.value.trim(),
          primitive: prim,
          samples: prim === "Choice" ? undefined : inputs.map((s) => parseFloat(s.value)).filter((v) => !isNaN(v)),
          picks: prim === "Choice" ? inputs.map((s) => s.value) : undefined,
          mean: meanV, confidence: conf,
          divergent, override,
          intuition: intuition || undefined,
          verdict, note: note.value.trim() || undefined,
        });
        this.close();
        this.plugin.openView();
      };
    };

    setHint();
  }

  _field(parent, label, ph) {
    const row = parent.createDiv();
    row.style.cssText = "display:flex; gap:8px; align-items:center; margin-bottom:6px;";
    row.createEl("label", { text: label, attr: { style: "width:64px; font-size:12px; font-weight:600;" } });
    const el = row.createEl("input", { type: "text", placeholder: ph });
    el.style.flex = "1";
    return el;
  }
}

// ================= 统计面板 =================
class JevView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Jev 决策统计"; }
  getIcon() { return "scale"; }

  async onOpen() { await this.render(); }
  async render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h4", { text: "⚖ Jev 决策统计" });
    const entries = await this.plugin.parseJsonl();
    const refresh = contentEl.createEl("button", { text: "刷新" });
    refresh.style.marginBottom = "8px";
    refresh.onclick = () => this.render();

    if (!entries.length) {
      contentEl.createEl("div", { text: "还没有决策记录。命令面板 →「新决策（五样本）」。" });
      return;
    }

    const n = entries.length;
    const divRate = entries.filter((e) => e.divergent).length / n;
    const ovrRate = entries.filter((e) => e.override).length / n;
    const conf = mean(entries.map((e) => e.confidence));

    const sum = contentEl.createDiv();
    sum.style.cssText = "padding:8px; background:var(--background-secondary); border-radius:6px; font-size:13px; line-height:1.7; margin-bottom:8px;";
    const addLine = (parts) => {
      const line = sum.createDiv();
      for (const [text, bold] of parts) {
        const span = line.createSpan({ text });
        if (bold) span.style.fontWeight = "700";
      }
    };
    addLine([["记录 ", false], [String(n), true], [" 条 ｜ 均置信度 ", false], [String(round2(conf)), true]]);
    addLine([["分歧率 ", false], [Math.round(divRate * 100) + "%", true], ["（分歧即信息，目标不是 0）", false]]);
    addLine([["推翻直觉率 ", false], [Math.round(ovrRate * 100) + "%", true], ["（Jev 层价值的核心指标）", false]]);

    // 按决策点计数
    const byPoint = {};
    for (const e of entries) byPoint[e.point] = (byPoint[e.point] || 0) + 1;
    contentEl.createEl("div", { text: "各决策点次数", attr: { style: "font-weight:600; margin-bottom:4px; font-size:12px;" } });
    const listEl = contentEl.createDiv();
    for (const [pt, c] of Object.entries(byPoint)) {
      const p = POINTS.find((x) => x[0] === pt);
      const row = listEl.createDiv();
      row.style.cssText = "display:flex; justify-content:space-between; padding:3px 6px; font-size:12px;";
      row.createEl("span", { text: `${pt} ${p ? p[1] : ""}` });
      row.createEl("span", { text: "▮".repeat(Math.min(20, c)) + " " + c, attr: { style: "color:var(--text-muted);" } });
    }

    // P3/P9 情绪曲线（v2.4）
    const curve = entries.filter((e) => (e.point === "P3" || e.point === "P9") && typeof e.mean === "number");
    if (curve.length >= 2) {
      contentEl.createEl("div", { text: "P3/P9 情绪曲线（按记录顺序）", attr: { style: "font-weight:600; margin:10px 0 4px; font-size:12px;" } });
      const chart = contentEl.createDiv();
      chart.style.cssText = "font-family: monospace; font-size:12px; line-height:1.8; padding:6px; background:var(--background-secondary); border-radius:6px;";
      const MAXV = 3, W = 40;
      for (const pt of ["P3", "P9"]) {
        const vals = curve.filter((e) => e.point === pt).map((e) => e.mean);
        if (!vals.length) continue;
        const line = vals.map((v) => {
          const filled = Math.round((v / MAXV) * (W / 2));
          return "▁▂▃▄▅▆▇"[Math.min(7, Math.max(1, Math.ceil(v / MAXV * 7)))] + "·";
        }).join("");
        chart.createEl("div", { text: `${pt}: ${line}  (${vals.map((v) => round2(v)).join("→")})` });
      }
    }
  }
  onClose() { this.contentEl.empty(); }
}

class JevSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("JSONL 日志路径").addText((t) =>
      t.setValue(this.plugin.settings.jsonl).onChange(async (v) => {
        this.plugin.settings.jsonl = v.trim() || "决策日志.jsonl";
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("人读表路径").addText((t) =>
      t.setValue(this.plugin.settings.md).onChange(async (v) => {
        this.plugin.settings.md = v.trim() || "决策日志.md";
        await this.plugin.saveSettings();
      }));
  }
}
