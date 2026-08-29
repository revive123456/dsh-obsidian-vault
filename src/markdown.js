/**
 * 轻量 Markdown 渲染器（无第三方依赖，纯 React.createElement）：
 * 标题 / 粗斜体 / 行内代码 / 围栏代码块 / 引用 / 列表 / 表格 / 分隔线 /
 * 链接 / [[双链]]（点击回调）/ 图片。所有文本先做 HTML 转义，安全输出 React 节点。
 *
 * 偏移记账（供「选中片段提问」使用）：
 *   当 handlers.onText 为函数时，每个文本片段会被包成 <span className="dsh-obs-src"
 *   data-obs-src="start,end">，其中 start/end 是该片段在源 markdown 字符串中的绝对
 *   偏移，满足 MD.slice(start,end) === 片段内容。宿主可据此把 DOM 选区反查回源码。
 *   未传 onText 时行为与旧版完全一致（纯 React 文本节点，不产生额外元素）。
 * 依赖工厂闭包内的 `React`（require("react")）。
 */
const renderMarkdownModule = (() => {
  const createElement = React.createElement;
  const Fragment = React.Fragment;

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function safeUrl(url) {
    const trimmed = url.trim();
    if (/^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i.test(trimmed)) return trimmed;
    return null;
  }

  // 取扩展名（小写带点，无则返回 ""）
  function extOf(p) {
    const m = /\.([a-z0-9]+)$/i.exec(p);
    return m ? `.${m[1].toLowerCase()}` : "";
  }
  // 取路径最后一段（POSIX）
  function baseOf(p) {
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
  }

  // 图片扩展名白名单（用于 embed 目标判定）
  const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

  /**
   * 把「图片 src / embed 目标」映射为可显示的 URL：
   *   外部 URL、mailto / # / data: / 服务端绝对路径 → 直接可用；
   *   其它（Vault 相对路径，如 attachments/x.png）→ 交给 handlers.assetUrl 转成
   *   `/obsidian/file?path=...`；无 assetUrl 时返回 null（退化为文本，不渲染成图）。
   */
  function resolveSrc(src, handlers) {
    if (typeof src !== "string") return null;
    const t = src.trim();
    if (/^(https?:|mailto:|#|\/|data:)/i.test(t)) return t;
    if (handlers && typeof handlers.assetUrl === "function") return handlers.assetUrl(t);
    return null;
  }

  // ── 行内解析（code > img > embed > link > wikilink > strong > em，取最左匹配）──
  const INLINE_PATTERNS = [
    ["code", /`([^`\n]+)`/],
    ["img", /!\[([^\]]*)\]\(([^)\s]+)\)/],
    ["embed", /!\[\[([^\]\n]+)\]\]/],
    ["link", /\[([^\]]+)\]\(([^)\s]+)\)/],
    ["wiki", /\[\[([^\]|#\n]+)(?:[|#][^\]]*)?\]\]/],
    ["strong", /\*\*([^*\n]+)\*\*|__([^_\n]+)__/],
    ["em", /(^|[^*])\*([^*\n]+)\*(?!\*)|(^|[^_])_([^_\n]+)_(?!_)/],
  ];
  const patternIndex = (name) => INLINE_PATTERNS.findIndex((p) => p[0] === name);

  /** 文本片段 → React 节点；handlers.onText 存在时包成带偏移的 span */
  function textNode(text, start, end, key, handlers) {
    if (text === "") return null;
    if (handlers && typeof handlers.onText === "function") {
      return createElement("span", { key, className: "dsh-obs-src", "data-obs-src": `${start},${end}` }, text);
    }
    return createElement(Fragment, { key }, text);
  }

  /**
   * 行内解析。text 对应源码区间 [srcStart, srcStart + text.length)。
   * 返回节点数组。
   */
  function renderInline(text, handlers, keyBase, srcStart) {
    const nodes = [];
    let cur = srcStart;
    let rest = text;
    let keyIndex = 0;
    const pushText = (s) => {
      const n = textNode(s, cur, cur + s.length, `${keyBase}-t${keyIndex++}`, handlers);
      if (n) nodes.push(n);
      cur += s.length;
    };

    while (rest !== "") {
      const matches = [];
      for (const [name, re] of INLINE_PATTERNS) {
        const m = re.exec(rest);
        if (m) matches.push({ name, m });
      }
      if (matches.length === 0) { pushText(rest); return nodes; }
      matches.sort((a, b) => (a.m.index - b.m.index) || (patternIndex(a.name) - patternIndex(b.name)));
      const { name, m } = matches[0];
      if (m.index > 0) pushText(rest.slice(0, m.index));

      const contentLen = (() => {
        if (name === "code") return m[1].length;
        if (name === "img") return 0;                       // alt 不渲染为可选中文本
        if (name === "embed") return m[0].length;           // 按钮/图占整个 ![[...]] 源码
        if (name === "link" || name === "wiki") return m[1].length;
        if (name === "strong") return (m[1] ?? m[2]).length;
        return (m[2] ?? m[4]).length;                       // em（m[0] 含前缀组）
      })();
      const openLen = (() => {
        if (name === "code") return 1;                      // `
        if (name === "link") return 1;                      // [
        if (name === "wiki") return 2;                      // [[
        if (name === "embed") return 0;                     // 以整段 ![[...]] 作为可选中源码
        if (name === "strong") return 2;                    // ** 或 __
        if (name === "em") return m[0].length - contentLen - 1; // 前缀 + *
        return 0;
      })();
      const bodyStart = cur + openLen;                      // cur 已含 m.index

      if (name === "code") {
        const n = textNode(m[1], bodyStart, bodyStart + m[1].length, `${keyBase}-c${keyIndex++}`, handlers);
        if (n) nodes.push(n);
      } else if (name === "img") {
        const src = resolveSrc(m[2], handlers);
        nodes.push(src === null
          ? textNode(m[0], cur, cur + m[0].length, `${keyBase}-i${keyIndex++}`, handlers)
          : createElement("img", { key: `${keyBase}-i${keyIndex++}`, src, alt: m[1], className: "dsh-obs-md-img" }));
      } else if (name === "embed") {
        const target = m[1].trim();
        // 图片 embed → <img src=/obsidian/file?path=...>；其它 → 退回双链按钮（不做笔记内容嵌入）
        if (IMAGE_EXT.has(extOf(target))) {
          const src = resolveSrc(target, handlers);
          nodes.push(src === null
            ? textNode(m[0], cur, cur + m[0].length, `${keyBase}-e${keyIndex++}`, handlers)
            : createElement("img", { key: `${keyBase}-e${keyIndex++}`, src, alt: baseOf(target), className: "dsh-obs-md-img" }));
        } else {
          nodes.push(createElement(
            "button",
            {
              key: `${keyBase}-e${keyIndex++}`,
              type: "button",
              className: "dsh-obs-wikilink",
              title: `[[${target}]]`,
              onClick: () => {
                if (handlers.onWikilink) handlers.onWikilink(target);
              },
            },
            textNode(m[0], cur, cur + m[0].length, `${keyBase}-e${keyIndex}`, handlers),
          ));
        }
      } else if (name === "link") {
        const href = safeUrl(m[2]);
        if (href === null) {
          nodes.push(textNode(m[0], cur, cur + m[0].length, `${keyBase}-l${keyIndex++}`, handlers));
        } else {
          nodes.push(createElement("a", { key: `${keyBase}-l${keyIndex++}`, href, target: "_blank", rel: "noreferrer" },
            renderInline(m[1], handlers, `${keyBase}-l${keyIndex}`, bodyStart)));
        }
      } else if (name === "wiki") {
        const target = m[1].trim();
        // 按钮文本 = 源码原文 m[0]（含 [[ ]] 与别名/章节），__src 指向整段源码区间，
        // 使「显示文本 === 源码切片」成立，选中括号内任意部分都能精确反查回源码。
        nodes.push(createElement(
          "button",
          {
            key: `${keyBase}-w${keyIndex++}`,
            type: "button",
            className: "dsh-obs-wikilink",
            title: `[[${target}]]`,
            onClick: () => {
              if (handlers.onWikilink) handlers.onWikilink(target);
            },
          },
          textNode(m[0], cur, cur + m[0].length, `${keyBase}-w${keyIndex}`, handlers),
        ));
      } else {
        const body = name === "strong" ? (m[1] ?? m[2]) : (m[2] ?? m[4]);
        nodes.push(createElement(
          name === "strong" ? "strong" : "em",
          { key: `${keyBase}-s${keyIndex++}` },
          renderInline(body, handlers, `${keyBase}-s${keyIndex}`, bodyStart),
        ));
      }
      cur += m[0].length;
      rest = rest.slice(m.index + m[0].length);
    }
    return nodes;
  }

  /** 表格行 → [{text, start}]（跳过 [[ ]] 内的 |，处理首尾 | 与空格） */
  function splitTableRow(line, lineStart) {
    const cells = [];
    let buf = "", bufStart = 0, j = 0, depth = 0;
    const flush = () => {
      const trimmed = buf.trim();
      const lead = buf.length - buf.trimStart().length;
      if (trimmed !== "" || cells.length > 0) cells.push({ text: trimmed, start: lineStart + bufStart + lead });
      buf = ""; bufStart = j + 1;
    };
    while (j < line.length) {
      const ch = line[j];
      if (ch === "|" && depth === 0) { flush(); j++; continue; }
      if (ch === "[" && line[j + 1] === "[") depth = 1;
      else if (ch === "]" && line[j + 1] === "]" && depth === 1) depth = 0;
      buf += ch; j++;
    }
    flush();
    return cells;
  }

  /** 单行块起始判定（供段落换行识别） */
  function isBlockStart(l) {
    return /^(#{1,6})\s+/.test(l) || /^```/.test(l) || /^>\s?/.test(l) ||
      /^\s*(?:[-*+]\s|\d+[.)]\s+)/.test(l) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l);
  }

  /** 解析一个块（block）为 React 节点；blockStart 为该块在源码中的绝对起点。 */
  function renderBlock(block, blockStart, handlers, keyBase) {
    const lines = block.split("\n");
    const lineStarts = [];
    {
      let ps = blockStart;
      for (const l of lines) { lineStarts.push(ps); ps += l.length + 1; }
    }
    const first = lines[0];

    // 围栏代码块：主体整体一个文本节点（含换行，偏移连续）
    const fence = /^```([\w+-]*)\s*$/.exec(first);
    if (fence) {
      const closing = lines.findIndex((l, i) => i > 0 && /^```\s*$/.test(l));
      const bodyLines = closing > 0 ? lines.slice(1, closing) : lines.slice(1);
      const body = bodyLines.join("\n");
      const codeNode = body === ""
        ? createElement("code", null)
        : createElement("code", null, textNode(body, lineStarts[1], lineStarts[1] + body.length, `${keyBase}-pre`, handlers));
      return createElement("pre", { key: keyBase, className: "dsh-obs-code" }, codeNode);
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(first);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      const content = heading[2];
      return createElement(`h${level}`, { key: keyBase },
        renderInline(content, handlers, keyBase, lineStarts[0] + (first.length - content.length)));
    }

    // 分隔线
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(first)) {
      return createElement("hr", { key: keyBase });
    }

    // 引用块（连续 > 行；逐行渲染 + <br> 保证文本节点偏移连续）
    if (lines.every((l) => l === "" || /^>\s?/.test(l))) {
      const inner = [];
      let ki = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l === "") continue;
        const m = /^>\s?/.exec(l);
        const content = l.slice(m ? m[0].length : 0);
        inner.push(...renderInline(content, handlers, `${keyBase}-q${ki}`, lineStarts[i] + (m ? m[0].length : 0)));
        ki++;
        if (i < lines.length - 1 && lines[i + 1] !== "") inner.push(createElement(Fragment, { key: `${keyBase}-qbr${ki}` }, "\n"));
      }
      return createElement("blockquote", { key: keyBase }, inner);
    }

    // 列表（无序/有序）
    if (lines.every((l) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(l) || l === "")) {
      const ordered = /^\s*\d+[.)]\s+/.test(lines.find((l) => l !== "") ?? "");
      const ul = createElement(ordered ? "ol" : "ul", { key: keyBase });
      let li = 0;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l === "") continue;
        const m = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.exec(l);
        ul.props.children = (ul.props.children ?? []).concat(
          createElement("li", { key: `${keyBase}-li${li++}` },
            renderInline(l.slice(m[0].length), handlers, `${keyBase}-li${li}`, lineStarts[i] + m[0].length)));
      }
      return ul;
    }

    // 表格（首行含 | 且第二行是分隔行）
    if (lines.length >= 2 && lines[0].includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[1] ?? "")) {
      const table = createElement("table", { key: keyBase });
      const thead = createElement("thead", null);
      const htr = createElement("tr", null);
      htr.props.children = splitTableRow(lines[0], lineStarts[0]).map((cell, j) =>
        createElement("th", { key: `${keyBase}-th${j}` }, renderInline(cell.text, handlers, `${keyBase}-th${j}`, cell.start)));
      thead.props.children = htr;
      const tbody = createElement("tbody", null);
      let trIdx = 0;
      for (let i = 2; i < lines.length; i++) {
        if (!lines[i].includes("|")) continue;
        const tr = createElement("tr", { key: `${keyBase}-tr${trIdx}` });
        tr.props.children = splitTableRow(lines[i], lineStarts[i]).map((cell, j) =>
          createElement("td", { key: `${keyBase}-td${trIdx}-${j}` }, renderInline(cell.text, handlers, `${keyBase}-td${trIdx}-${j}`, cell.start)));
        tbody.props.children = (tbody.props.children ?? []).concat(tr);
        trIdx++;
      }
      table.props.children = [thead, tbody];
      return table;
    }

    // 段落：逐行渲染（每行一个文本节点 + <br>），保证文本节点偏移连续
    const inner = [];
    let ki = 0;
    const nonEmpty = [];
    for (let i = 0; i < lines.length; i++) if (lines[i] !== "") nonEmpty.push(i);
    for (let idx = 0; idx < nonEmpty.length; idx++) {
      const i = nonEmpty[idx];
      inner.push(...renderInline(lines[i], handlers, `${keyBase}-p${ki}`, lineStarts[i]));
      ki++;
      if (idx < nonEmpty.length - 1) inner.push(createElement(Fragment, { key: `${keyBase}-pbr${ki}` }, "\n"));
    }
    return createElement("p", { key: keyBase }, inner);
  }

  /** 将 markdown 正文渲染为一组块级 React 节点。 */
  function renderMarkdown(markdown, handlers = {}) {
    const normalized = markdown.replace(/\r\n/g, "\n");
    const blocks = normalized.split(/\n\s*\n/).filter((b) => b.trim() !== "");
    if (blocks.length === 0) {
      return createElement("p", { className: "dsh-obs-empty" }, "（空笔记）");
    }
    const nodes = [];
    let pos = 0;
    for (const block of blocks) {
      const idx = normalized.indexOf(block, pos);
      const blockStart = idx >= 0 ? idx : pos;
      nodes.push(renderBlock(block, blockStart, handlers, `b${nodes.length}`));
      pos = blockStart + block.length;
    }
    return createElement(Fragment, null, nodes);
  }

  /**
   * 行号预览模式（预览态「每行一个行标号」）：
   * 每个源码行渲染为一行 <div class="dsh-obs-md-row">，左侧行号 .dsh-obs-md-ln、
   * 内容 .dsh-obs-md-lc（行内 markdown 保留，且允许自然折行）。行号与源码行一一对应，
   * 不依赖固定宽度/不折行，长行折行也不影响后续行号对齐。选中映射（.dsh-obs-src 偏移）
   * 仍由 renderInline 的 onText 记账保留。围栏代码块逐行编号。
   */
  function renderNumbered(markdown, handlers = {}) {
    const normalized = markdown.replace(/\r\n/g, "\n");
    const rows = [];
    const lines = normalized.split("\n");
    let pos = 0;
    let lineNo = 0;
    let i = 0;
    let keyIdx = 0;

    const nextLine = () => {
      const text = lines[i];
      const start = pos;
      lineNo += 1;
      pos += text.length + 1;
      i += 1;
      return { text, start, num: lineNo };
    };
    const makeRow = (num, cls, inner) =>
      createElement("div", { key: `n${keyIdx++}`, className: `dsh-obs-md-row${cls ? ` dsh-obs-md-${cls}` : ""}` },
        createElement("span", { className: "dsh-obs-md-ln" }, String(num)),
        createElement("span", { className: "dsh-obs-md-lc" }, inner),
      );

    while (i < lines.length) {
      const cur = nextLine();

      // 围栏代码块：打开 / 正文 / 关闭 逐行编号（正文不解析行内 markdown）
      if (/^```/.test(cur.text)) {
        rows.push(makeRow(cur.num, "code",
          textNode(cur.text, cur.start, cur.start + cur.text.length, `n${keyIdx}`, handlers)));
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          const b = nextLine();
          rows.push(makeRow(b.num, "code",
            textNode(b.text, b.start, b.start + b.text.length, `n${keyIdx}`, handlers)));
        }
        if (i < lines.length) {
          const c = nextLine();
          rows.push(makeRow(c.num, "code",
            textNode(c.text, c.start, c.start + c.text.length, `n${keyIdx}`, handlers)));
        }
        continue;
      }

      // 标题 / 引用 / 列表 前缀做视觉区分；其余按普通段落行渲染
      let cls = "";
      let content = cur.text;
      let contentStart = cur.start;
      const h = /^(#{1,6})\s+(.*)$/.exec(cur.text);
      const quote = /^>\s?/.exec(cur.text);
      const list = /^(\s*(?:[-*+]\s+|\d+[.)]\s+))(.*)$/.exec(cur.text);
      if (h) { cls = "heading"; content = h[2]; contentStart = cur.start + h[1].length + 1; }
      else if (quote) { cls = "quote"; content = cur.text.slice(quote[0].length); contentStart = cur.start + quote[0].length; }
      else if (list) { cls = "list"; content = list[2]; contentStart = cur.start + list[1].length; }

      rows.push(makeRow(cur.num, cls,
        renderInline(content, handlers, `n${keyIdx}`, contentStart)));
    }

    return createElement(Fragment, null, rows);
  }

  return { renderMarkdown, renderNumbered };
})();

const { renderMarkdown, renderNumbered } = renderMarkdownModule;
