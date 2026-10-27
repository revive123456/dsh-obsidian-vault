/**
 * 轻量 Markdown 渲染器（无第三方依赖，纯 React.createElement），两个出口、
 * 两套块级能力，共同复用行内解析 renderInline（粗斜体/行内代码/链接/图片/双链）：
 *
 * 1) renderNumbered —— 笔记面板预览**实际使用**的渲染器（一行源码 = 一行 + 行号）。
 *    块级支持：引用（逐行、嵌套，不再吞行）、callout（类型/别名/标题，正文里的
 *    列表与标题）、代码围栏（```/~~~、info string、未闭合到文末，行号保留）、
 *    列表（无序/有序/嵌套，按实际缩进，tab=4）、任务列表（只读复选框）、
 *    表格（整块真表格、行号在首列、对齐、\| 转义）、标题分级（#～######）、
 *    分隔线、setext 标题（=== / ---）。frontmatter 由服务端读时剥离，不进入预览。
 * 2) renderMarkdown —— 旧的块渲染器，**当前没有产品调用点**；能力比行号路径旧
 *    （标题降级、无 setext/任务列表等）。保留但不要再往它上面补面板语法，
 *    面板行为一律以 renderNumbered 为准。
 *
 * 未支持（P2，保持原文显示）：数学、mermaid、脚注、删除线/高亮/转义/双反引号、
 * 自动链接、标签、HTML、笔记 transclusion、音频/PDF 嵌入、块引用 ^id、
 * callout 折叠/未知类型/嵌套、aliases 解析。行内强调仍沿用旧解析器（`_` 相邻文本
 * 的边界处理有已知限制），统一留到 P2。
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
   * Obsidian 的图片尺寸语法：`![[a.png|100]]`（宽）/ `![[a.png|100x200]]`（宽x高）。
   * 非纯数字的别名不是尺寸（Obsidian 里当 alt 文本用），返回 null。
   */
  function parseImageSize(alias) {
    const m = /^(\d+)(?:x(\d+))?$/.exec(alias);
    if (!m) return null;
    const size = { width: Number(m[1]) };
    if (m[2] !== undefined) size.height = Number(m[2]);
    return size;
  }

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
  // M7：双链/embed 分开捕获 target（m[1]）、章节（m[2]）、别名（m[3]），
  // 显示时别名优先、其次「target › 章节」，偏移各自映射到源码切片。
  const INLINE_PATTERNS = [
    ["code", /`([^`\n]+)`/],
    ["img", /!\[([^\]]*)\]\(([^)\s]+)\)/],
    ["embed", /!\[\[([^\]|#\n]*)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/],
    ["link", /\[([^\]]+)\]\(([^)\s]+)\)/],
    ["wiki", /\[\[([^\]|#\n]*)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/],
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
   * 双链 / embed 的源码切分（M7）：m 为 INLINE_PATTERNS 的匹配结果，
   * mStart 为 m[0] 在源码里的绝对起点。返回各段的「去掉首尾空白后的文本 + 精确起点」：
   *   target（m[1]）、section（m[2]，`#` 之后）、alias（m[3]，`|` 之后）。
   * has* 记录分隔符是否出现（空 section/alias 也保留语义）。
   */
  function wikilinkParts(m, mStart, embed) {
    const innerStart = mStart + (embed ? 3 : 2); // 跳过 "![[" / "[["
    const targetRaw = m[1];
    const targetLead = targetRaw.length - targetRaw.trimStart().length;
    const target = targetRaw.trim();
    const afterTarget = innerStart + targetRaw.length;
    const secRaw = m[2];
    const section = secRaw === undefined ? "" : secRaw.trim();
    const sectionLead = secRaw === undefined ? 0 : secRaw.length - secRaw.trimStart().length;
    const sectionStart = secRaw === undefined ? -1 : afterTarget + 1 + sectionLead;
    const aliasRaw = m[3];
    const alias = aliasRaw === undefined ? "" : aliasRaw.trim();
    const aliasLead = aliasRaw === undefined ? 0 : aliasRaw.length - aliasRaw.trimStart().length;
    const aliasStart = aliasRaw === undefined
      ? -1
      : afterTarget + (secRaw === undefined ? 0 : 1 + secRaw.length) + 1 + aliasLead;
    return {
      target,
      targetStart: innerStart + targetLead,
      section,
      sectionStart,
      hasSection: secRaw !== undefined,
      alias,
      aliasStart,
      hasAlias: aliasRaw !== undefined,
    };
  }

  /**
   * 双链显示节点（M7，契约 §4.7）：[[A]] → A；[[A|别名]] → 别名；
   * [[A#标题]] → A › 标题（两个源码 span，中间 ` › ` 是非 span 装饰文本）；[[A#^块]] → A › ^块。
   * 可见文本都落在 span.dsh-obs-src 上，` › ` 只是装饰，不包 data-obs-src。
   */
  function wikilinkDisplayNodes(parts, m, mStart, keyBase, handlers) {
    const out = [];
    if (parts.hasAlias && parts.alias !== "") {
      const n = textNode(parts.alias, parts.aliasStart, parts.aliasStart + parts.alias.length, `${keyBase}-a`, handlers);
      if (n) out.push(n);
      return out;
    }
    if (parts.hasSection && parts.section !== "") {
      if (parts.target !== "") {
        const tn = textNode(parts.target, parts.targetStart, parts.targetStart + parts.target.length, `${keyBase}-t`, handlers);
        if (tn) out.push(tn);
        out.push(createElement(Fragment, { key: `${keyBase}-sep` }, " › "));
      }
      const sn = textNode(parts.section, parts.sectionStart, parts.sectionStart + parts.section.length, `${keyBase}-s`, handlers);
      if (sn) out.push(sn);
      return out;
    }
    const n = textNode(parts.target, parts.targetStart, parts.targetStart + parts.target.length, `${keyBase}-t`, handlers);
    if (n) out.push(n);
    // 极端输入（如 [[]]）退化为源码原文，避免出现空按钮
    if (out.length === 0) {
      const raw = textNode(m[0], mStart, mStart + m[0].length, `${keyBase}-raw`, handlers);
      if (raw) out.push(raw);
    }
    return out;
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
        const parts = wikilinkParts(m, cur, true);
        const target = parts.target;
        const alias = parts.alias;
        // 图片 embed → <img src=/obsidian/file?path=...>；其它 → 退回双链按钮（不做笔记内容嵌入）
        if (IMAGE_EXT.has(extOf(target))) {
          const src = resolveSrc(target, handlers);
          const size = parseImageSize(alias);
          nodes.push(src === null
            ? textNode(m[0], cur, cur + m[0].length, `${keyBase}-e${keyIndex++}`, handlers)
            : createElement("img", {
              key: `${keyBase}-e${keyIndex++}`,
              src,
              // Obsidian：`|100` / `|100x200` 是尺寸，其余别名当 alt
              alt: size === null && alias !== "" ? alias : baseOf(target),
              className: "dsh-obs-md-img",
              ...(size === null ? {} : size),
            }));
        } else {
          // M7：非图片 embed 显示目标/别名/章节，不再显示 ![[ ]] 原文
          const key = `${keyBase}-e${keyIndex++}`;
          nodes.push(createElement(
            "button",
            {
              key,
              type: "button",
              className: "dsh-obs-wikilink",
              title: `[[${target}]]`,
              onClick: () => {
                if (handlers.onWikilink) handlers.onWikilink(target);
              },
            },
            wikilinkDisplayNodes(parts, m, cur, key, handlers),
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
        // M7：显示 target / 别名 / target › 章节；title 与 onClick 参数仍是 target（不含 # 章节）
        const parts = wikilinkParts(m, cur, false);
        const target = parts.target;
        const key = `${keyBase}-w${keyIndex++}`;
        nodes.push(createElement(
          "button",
          {
            key,
            type: "button",
            className: "dsh-obs-wikilink",
            title: `[[${target}]]`,
            onClick: () => {
              if (handlers.onWikilink) handlers.onWikilink(target);
            },
          },
          wikilinkDisplayNodes(parts, m, cur, key, handlers),
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

  /**
   * 单元格源码 → 渲染片段：按源码连续切段，`\|` 单独成 {type:"pipe"} 原子
   * （显示 `|`，偏移只覆盖 `|` 那一个字符，不含反斜杠）。
   */
  function buildCellSegments(text, start) {
    const segs = [];
    let buf = "";
    let bufStart = 0;
    let i = 0;
    while (i < text.length) {
      if (text[i] === "\\" && text[i + 1] === "|") {
        if (buf !== "") segs.push({ type: "text", text: buf, start: start + bufStart });
        segs.push({ type: "pipe", start: start + i + 1 });
        buf = "";
        bufStart = i + 2;
        i += 2;
        continue;
      }
      buf += text[i];
      i += 1;
    }
    if (buf !== "") segs.push({ type: "text", text: buf, start: start + bufStart });
    return segs;
  }

  /**
   * 表格行 → [{text, start, segments}]：
   * - 修旧 bug：行首/行尾 `|` 只作分隔，不再多推一个空单元格（`a || b` 中间空列保留）；
   * - `\|` 不切列，显示 `|`，偏移只记 `|`（segments 交给 renderInlineCell 精确记账）；
   * - `[[ ]]` 内的 `|` 不切列；
   * - text/start 保持旧形状，块渲染器继续可用。
   */
  function splitTableRow(line, lineStart) {
    const parts = [];
    let bufStart = 0;
    let j = 0;
    let depth = 0;
    while (j < line.length) {
      const ch = line[j];
      if (ch === "\\" && line[j + 1] === "|") { j += 2; continue; }
      if (ch === "|" && depth === 0) {
        parts.push({ raw: line.slice(bufStart, j), start: lineStart + bufStart });
        j += 1;
        bufStart = j;
        continue;
      }
      if (ch === "[" && line[j + 1] === "[") { depth = 1; j += 2; continue; }
      if (ch === "]" && line[j + 1] === "]" && depth === 1) { depth = 0; j += 2; continue; }
      j += 1;
    }
    parts.push({ raw: line.slice(bufStart), start: lineStart + bufStart });
    if (parts.length > 1 && parts[parts.length - 1].raw.trim() === "") parts.pop();
    if (parts.length > 1 && parts[0].raw.trim() === "") parts.shift();
    return parts.map((p) => {
      const lead = p.raw.length - p.raw.trimStart().length;
      const text = p.raw.trim();
      const start = p.start + lead;
      return { text, start, segments: buildCellSegments(text, start) };
    });
  }

  /** 单元格内容渲染：无 `\|` 时与 renderInline 完全一致。 */
  function renderInlineCell(cell, handlers, keyBase) {
    const segs = cell.segments;
    if (!segs || segs.length === 0) return [];
    if (segs.length === 1 && segs[0].type === "text") {
      return renderInline(segs[0].text, handlers, keyBase, segs[0].start);
    }
    const out = [];
    let si = 0;
    for (const seg of segs) {
      if (seg.type === "pipe") {
        const n = textNode("|", seg.start, seg.start + 1, `${keyBase}-e${si++}`, handlers);
        if (n) out.push(n);
      } else if (seg.text !== "") {
        out.push(...renderInline(seg.text, handlers, `${keyBase}-e${si++}`, seg.start));
      }
    }
    return out;
  }

  /**
   * 表格分隔行 → 每列对齐数组（"left" / "center" / "right" / "none"）；
   * 不是分隔行返回 null。分隔行必须含 `|`，每格只由 `-` 与两侧 `:` 组成。
   */
  function parseTableAlignLine(line) {
    if (!line.includes("|")) return null;
    if (!/^[|\-: \t]+$/.test(line)) return null;
    const cells = splitTableRow(line, 0);
    if (cells.length === 0) return null;
    const aligns = [];
    for (const cell of cells) {
      const t = cell.text;
      if (!/^:?-+:?$/.test(t)) return null;
      if (t.startsWith(":") && t.endsWith(":")) aligns.push("center");
      else if (t.startsWith(":")) aligns.push("left");
      else if (t.endsWith(":")) aligns.push("right");
      else aligns.push("none");
    }
    return aligns;
  }

  // ── Obsidian callout（`> [!type] 标题`）────────────────────────────────────
  // 类型 → 展示名 + 图标（emoji，避免依赖 DSH 主题里未必存在的图标集）；
  // 配色不用内联色值，改由 CSS 加 [data-callout] 选择器统一给出。
  const CALLOUT_INFO = {
    note: { label: "笔记", icon: "📝" },
    abstract: { label: "摘要", icon: "📋" },
    info: { label: "信息", icon: "ℹ️" },
    todo: { label: "待办", icon: "✅" },
    tip: { label: "提示", icon: "💡" },
    success: { label: "成功", icon: "✔️" },
    question: { label: "疑问", icon: "❓" },
    warning: { label: "注意", icon: "⚠️" },
    failure: { label: "失败", icon: "❌" },
    danger: { label: "危险", icon: "⚡" },
    bug: { label: "缺陷", icon: "🐛" },
    example: { label: "示例", icon: "🧪" },
    quote: { label: "引用", icon: "❝" },
  };
  // Obsidian 内置别名 → 规范类型
  const CALLOUT_ALIAS = {
    summary: "abstract", tldr: "abstract",
    hint: "tip", important: "tip",
    check: "success", done: "success",
    help: "question", faq: "question",
    caution: "warning", attention: "warning",
    fail: "failure", missing: "failure",
    error: "danger",
    cite: "quote",
    none: "note",
  };
  // 整个 `[!type]` 标记 + 可选折叠符 + 可选标题：不区分大小写
  const CALLOUT_RE = /^\[!\s*([A-Za-z][\w-]*)\s*\][+-]?(?:[ \t]+([\s\S]*))?$/;

  function calloutCanonical(type) {
    const t = String(type).toLowerCase();
    return CALLOUT_INFO[t] ? t : (CALLOUT_ALIAS[t] ?? "note");
  }
  function calloutSpec(type) {
    const canon = calloutCanonical(type);
    return { canon, ...CALLOUT_INFO[canon] };
  }

  /**
   * 引用块首行 → callout 描述；不是 callout 返回 null。
   * srcStart 为「> 」前缀之后内容的源码起点，用于标题文本的偏移记账。
   * 返回 { spec, title, titleStart }：title 为空串表示没有显式标题；
   * titleStart 是标题在源码里的绝对起点（已按实际前后空白修正，供 renderInline 精确记账）。
   */
  function parseCalloutHeader(header, srcStart) {
    const m = CALLOUT_RE.exec(header);
    if (!m) return null;
    const spec = calloutSpec(m[1]);
    const restRaw = m[2] ?? "";
    const restStart = header.indexOf(m[0]) + m[0].length - restRaw.length;
    const lead = restRaw.length - restRaw.trimStart().length;
    const title = restRaw.trim();
    return {
      spec,
      title,
      titleStart: title === "" ? null : srcStart + restStart + lead,
    };
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
      const firstQuote = /^>\s?/.exec(first);
      const headerContent = firstQuote ? first.slice(firstQuote[0].length) : first;
      const headerStart = lineStarts[0] + (firstQuote ? firstQuote[0].length : 0);
      const callout = parseCalloutHeader(headerContent, headerStart);
      if (callout) {
        // callout 主体：去掉每行 `>` 前缀，正文行内语法照常解析
        const bodyLines = [];
        for (let i = 1; i < lines.length; i++) {
          const l = lines[i];
          if (l === "") continue;
          const q = /^>\s?/.exec(l);
          const prefix = q ? q[0].length : 0;
          const text = l.slice(prefix);
          if (text === "") continue;
          bodyLines.push({
            text,
            start: lineStarts[i] + prefix,
            key: `${keyBase}-cb${i}`,
          });
        }
        const body = [];
        for (let i = 0; i < bodyLines.length; i++) {
          const bl = bodyLines[i];
          body.push(...renderInline(bl.text, handlers, bl.key, bl.start));
          if (i < bodyLines.length - 1) body.push(createElement(Fragment, { key: `${bl.key}-br` }, "\n"));
        }
        // 严格口径（契约 §4.6）：有显式标题时徽标只留图标、标题文本单独显示；
        // 没有显式标题时才回落到「图标 + 类型名」。
        const headChildren = [
          createElement("span", { key: `${keyBase}-ci`, className: "dsh-obs-callout-icon" }, callout.spec.icon),
        ];
        if (callout.title !== "") {
          headChildren.push(createElement("span", { key: `${keyBase}-ct`, className: "dsh-obs-callout-title" },
            renderInline(callout.title, handlers, `${keyBase}-ct`, callout.titleStart)));
        } else {
          headChildren.push(createElement("span", { key: `${keyBase}-ctl`, className: "dsh-obs-callout-title" }, callout.spec.label));
        }
        return createElement(
          "div",
          {
            key: keyBase,
            className: "dsh-obs-callout",
            "data-callout": callout.spec.canon,
          },
          createElement(
            "div",
            { key: `${keyBase}-ch`, className: "dsh-obs-callout-head" },
            ...headChildren,
          ),
          createElement("div", { key: `${keyBase}-cbd`, className: "dsh-obs-callout-body" }, body),
        );
      }
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
        createElement("th", { key: `${keyBase}-th${j}` }, renderInlineCell(cell, handlers, `${keyBase}-th${j}`)));
      thead.props.children = htr;
      const tbody = createElement("tbody", null);
      let trIdx = 0;
      for (let i = 2; i < lines.length; i++) {
        if (!lines[i].includes("|")) continue;
        const tr = createElement("tr", { key: `${keyBase}-tr${trIdx}` });
        tr.props.children = splitTableRow(lines[i], lineStarts[i]).map((cell, j) =>
          createElement("td", { key: `${keyBase}-td${trIdx}-${j}` }, renderInlineCell(cell, handlers, `${keyBase}-td${trIdx}-${j}`)));
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

  // ── 行号路径（renderNumbered）的块级识别 helper（P0：M1 引用 / M2 围栏 / M3 列表 / M4 表格）──

  /** 缩进折算成列数：tab 按 4 空格；不写死每级宽度，层级由调用方按实际缩进比较。 */
  function indentCols(s) {
    let n = 0;
    for (let k = 0; k < s.length; k++) n += s[k] === "\t" ? 4 : 1;
    return n;
  }

  /** 水平线行（列表识别前先排除）：`---` / `***` / `___`，两侧允许空白。 */
  function isHrLine(line) {
    return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  }

  /**
   * 围栏开行：行首 ≤3 空格 + 连续 ≥3 个 ` 或 ~。
   * 返回 { ch, len, lang, langStart }：lang 为 info string 第一个词（无则空串），
   * langStart 为语言词在该行内的偏移；不是开围栏返回 null。
   */
  function matchFenceOpen(line) {
    const m = /^( {0,3})(`{3,}|~{3,})([\s\S]*)$/.exec(line);
    if (!m) return null;
    const marks = m[2];
    const info = m[3];
    // 反引号围栏的 info string 里不能再出现反引号（CommonMark），否则当普通行
    if (marks[0] === "`" && info.includes("`")) return null;
    const infoTrim = info.length - info.trimStart().length;
    const rest = info.slice(infoTrim);
    const lang = rest === "" ? "" : rest.split(/[ \t]+/)[0];
    return { ch: marks[0], len: marks.length, lang, langStart: m[1].length + marks.length + infoTrim };
  }

  /** 围栏闭行：同字符、长度不短于开围栏、行内只有空白。 */
  function isFenceClose(line, ch, minLen) {
    const m = /^( {0,3})(`+|~+)[ \t]*$/.exec(line);
    return !!m && m[2][0] === ch && m[2].length >= minLen;
  }

  /**
   * 引用行前缀：行首 ≤3 空格 + 连续 `>` 标记（标记之间允许一个空格/tab，兼容 `> >`）。
   * 返回 { prefixLen, depth }（depth = 引用标记个数，1 起）；不是引用行返回 null。
   */
  function quotePrefixInfo(line) {
    const m = /^( {0,3}(?:>[ \t]?)+)/.exec(line);
    if (!m) return null;
    const prefix = m[1];
    let depth = 0;
    for (let k = 0; k < prefix.length; k++) if (prefix[k] === ">") depth += 1;
    return { prefixLen: prefix.length, depth };
  }

  // 列表行：缩进 + 无序/有序标记 + 至少一个空白 + 正文（任务标记在正文里再拆）
  const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)([\s\S]*)$/;
  const TASK_RE = /^\[([ xX])\](?:[ \t]+|$)/;
  // 层级 → 无序符号轮换（0/1/2 起再循环）
  const UL_MARKERS = ["•", "◦", "▪"];

  /**
   * 列表行识别（单行）：返回 { indent, ordered, num, body, bodyStart, task }；
   * 不是列表行返回 null。先排除水平线；任务标记 `[ ]`/`[x]` 单独拆出，
   * bodyStart 是行内偏移（相对行首），任务从 `[x] ` 之后算正文。
   */
  function parseListLine(line) {
    if (line.trim() === "" || isHrLine(line)) return null;
    const m = LIST_RE.exec(line);
    if (!m) return null;
    const ordered = /\d/.test(m[2].charAt(0));
    const prefixLen = m[1].length + m[2].length + m[3].length;
    const rawBody = m[4];
    // 任务标记不区分有序/无序（方案 M3：「内容以 ^\[([ xX])\]\s+ 开头时」）
    const tm = TASK_RE.exec(rawBody);
    const task = tm === null
      ? null
      : {
        checked: tm[1].toLowerCase() === "x",
        body: rawBody.slice(tm[0].length),
        bodyStart: prefixLen + tm[0].length,
      };
    return {
      indent: indentCols(m[1]),
      ordered,
      num: ordered ? parseInt(m[2], 10) : null,
      body: task ? task.body : rawBody,
      bodyStart: task ? task.bodyStart : prefixLen,
      task,
    };
  }

  /**
   * M5 标题行：`#{1,6}` + 至少一个空白 + 内容。
   * 返回 { level, content, contentOffset }（contentOffset 相对行首，按实际匹配长度算，
   * `#   多空格` 也对）；不是标题返回 null。行号路径与 callout 正文共用。
   */
  function splitHeadingLine(line) {
    const m = /^(#{1,6})[ \t]+([\s\S]*)$/.exec(line);
    if (!m) return null;
    const content = m[2];
    return { level: m[1].length, content, contentOffset: m[0].length - content.length };
  }

  /**
   * M5 setext 内容行的排除条件：当前行本身已是别的块起始（标题/列表/引用/围栏/hr）时，
   * 下一行的 `===` / `---` 不能把它变成 setext 标题（先 setext 后 hr 的前提）。
   */
  function isBlockStartLine(line) {
    return splitHeadingLine(line) !== null ||
      /^ {0,3}(?:`{3,}|~{3,})/.test(line) ||
      /^ {0,3}>/.test(line) ||
      parseListLine(line) !== null ||
      isHrLine(line);
  }

  /**
   * 行号预览模式（预览态「每行一个行标号」）：
   * 每个源码行渲染为一行 <div class="dsh-obs-md-row">，左侧行号 .dsh-obs-md-ln、
   * 内容 .dsh-obs-md-lc（行内 markdown 保留，且允许自然折行）。行号与源码行一一对应，
   * 不依赖固定宽度/不折行，长行折行也不影响后续行号对齐。选中映射（.dsh-obs-src 偏移）
   * 仍由 renderInline 的 onText 记账保留。
   * 块级语法（P0）：引用逐行（M1）、围栏代码逐行（M2）、列表/任务逐行（M3）、表格整块（M4）。
   * 表格是唯一不按行拆的块：行号放在每个 tr 的首列（.dsh-obs-md-tln），保证 1..N 连续。
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

    // 同一个 callout 的连续行共用一个 groupId → 首尾行加样式类（圆角收尾）
    let groupId = -1;
    let inCallout = false;
    let calloutFirst = true;

    const makeRow = (num, rowClass, lcInner, lcClass, extraProps) =>
      createElement("div", {
        key: `n${keyIdx++}`,
        className: `dsh-obs-md-row${rowClass ? ` ${rowClass}` : ""}`,
        ...(extraProps ?? {}),
      },
        createElement("span", { className: "dsh-obs-md-ln" }, String(num)),
        createElement("span", { className: `dsh-obs-md-lc${lcClass ? ` ${lcClass}` : ""}` }, lcInner),
      );
    // "code code-head" → "dsh-obs-md-code dsh-obs-md-code-head"（块级样式类统一前缀）
    const rowClassOf = (cls) =>
      cls ? cls.split(/\s+/).filter(Boolean).map((c) => `dsh-obs-md-${c}`).join(" ") : "";
    const closeCallout = () => {
      if (!inCallout) return;
      const last = rows[rows.length - 1];
      if (last) last.props.className += " dsh-obs-md-callout-end";
      inCallout = false;
    };
    /**
     * gid === null → 普通行；否则为 callout 的某一行（同一 callout 共用一个 gid）。
     * extraProps 承载契约属性：data-quote-depth / data-code-group / data-list-* 等。
     */
    const pushRow = (num, cls, inner, gid, extraProps) => {
      const rowClass = rowClassOf(cls);
      if (gid === null) {
        closeCallout();
        rows.push(makeRow(num, rowClass, inner, null, extraProps));
        return;
      }
      if (!inCallout || gid !== groupId) { closeCallout(); groupId = gid; inCallout = true; calloutFirst = true; }
      const lcClass = calloutFirst ? "dsh-obs-md-callout-head" : "dsh-obs-md-callout-body";
      calloutFirst = false;
      rows.push(makeRow(num, rowClass, inner, lcClass, { "data-callout-group": String(gid), ...(extraProps ?? {}) }));
    };
    // 块级节点（表格）直接进 rows 序列：先收尾上一个 callout，避免末行样式打错行
    const pushBlock = (node) => { closeCallout(); rows.push(node); };

    // 列表层级栈：按实际缩进比较（tab=4 列），不写死每级宽度；有序编号按层计数
    let listIndentStack = [];
    let listSeq = [];
    let listKindAtDepth = [];
    const resetListState = () => { listIndentStack = []; listSeq = []; listKindAtDepth = []; };
    const listDepthFor = (indent) => {
      if (listIndentStack.length === 0) { listIndentStack.push(indent); return 0; }
      let top = listIndentStack.length - 1;
      while (top > 0 && indent < listIndentStack[top]) top -= 1;
      if (indent > listIndentStack[top]) {
        listIndentStack.length = top + 1;
        listIndentStack.push(indent);
        const depth = top + 1;
        listKindAtDepth[depth] = undefined;
        listSeq[depth] = undefined;
        return depth;
      }
      listIndentStack.length = top + 1;
      if (indent < listIndentStack[top]) listIndentStack[top] = indent;
      return top;
    };
    const listMarkerOf = (info, depth) => {
      if (!info.ordered) {
        listKindAtDepth[depth] = "ul";
        return UL_MARKERS[depth % UL_MARKERS.length];
      }
      if (listKindAtDepth[depth] === "ol" && typeof listSeq[depth] === "number") listSeq[depth] += 1;
      else listSeq[depth] = info.num;
      listKindAtDepth[depth] = "ol";
      return `${listSeq[depth]}.`;
    };
    /**
     * 列表行 → lc 子节点 + data-list-* 属性（普通行与 callout 正文共用，M6 复用 M3）。
     * srcStart 为该行「正文内容」的源码起点（任务行已跳过 [x] 标记）。
     */
    const listRowContent = (info, keyBase, srcStart) => {
      const depth = listDepthFor(info.indent);
      const inner = [createElement("span", { key: `${keyBase}-mk`, className: "dsh-obs-md-list-marker" }, listMarkerOf(info, depth))];
      if (info.task) {
        inner.push(createElement("input", {
          key: `${keyBase}-cb`,
          type: "checkbox",
          className: "dsh-obs-md-task-check",
          disabled: true,
          checked: info.task.checked,
        }));
      }
      inner.push(createElement("span", { key: `${keyBase}-bd`, className: "dsh-obs-md-list-body" },
        renderInline(info.body, handlers, `${keyBase}-bd`, srcStart + info.bodyStart)));
      const props = {
        "data-list-depth": String(depth),
        "data-list-kind": info.task ? "task" : info.ordered ? "ol" : "ul",
      };
      if (info.task) props["data-checked"] = info.task.checked ? "1" : "0";
      return { inner, props };
    };

    while (i < lines.length) {
      const cur = nextLine();

      // ── M2 围栏代码块（``` 与 ~~~ 等价）：整块每行占号，正文不解析行内 ──
      const fence = matchFenceOpen(cur.text);
      if (fence) {
        resetListState();
        const group = `f${cur.start}`;
        const lang = fence.lang;
        const langNode = lang === ""
          ? null
          : textNode(lang, cur.start + fence.langStart, cur.start + fence.langStart + lang.length, `n${keyIdx}lang`, handlers);
        pushRow(cur.num, "code code-head",
          createElement("span", { key: `n${keyIdx}lang`, className: "dsh-obs-md-code-lang" }, langNode),
          null, { "data-code-group": group });
        let closed = false;
        while (i < lines.length) {
          if (isFenceClose(lines[i], fence.ch, fence.len)) {
            const close = nextLine();
            pushRow(close.num, "code code-end", null, null, { "data-code-group": group });
            closed = true;
            break;
          }
          const body = nextLine();
          pushRow(body.num, "code",
            body.text === "" ? null : textNode(body.text, body.start, body.start + body.text.length, `n${keyIdx}body`, handlers),
            null, { "data-code-group": group });
        }
        if (!closed) {
          // 未闭合吃到文末：最后一行加 code-end（只有开围栏行时它同时是 head 和 end）
          const last = rows[rows.length - 1];
          if (last) last.props.className += " dsh-obs-md-code-end";
        }
        continue;
      }

      // ── M1 引用：连续 `>` 行逐行成像（旧实现会吞掉后续行）；首行是 callout 才走分组 ──
      const quote = quotePrefixInfo(cur.text);
      if (quote) {
        const block = [cur];
        while (i < lines.length && quotePrefixInfo(lines[i])) block.push(nextLine());
        resetListState();
        const callout = parseCalloutHeader(
          block[0].text.slice(quote.prefixLen),
          block[0].start + quote.prefixLen,
        );
        if (callout) {
          const gid = `c${block[0].start}`;
          const spec = callout.spec;
          // 严格口径（契约 §4.6，Lead 裁决）：有显式标题时徽标只显示图标、标题文本单独显示；
          // 没有显式标题时才显示「图标 + 类型名」。
          const badgeChildren = [
            createElement("span", { key: "i", className: "dsh-obs-md-callout-ico" }, spec.icon),
          ];
          if (callout.title === "") {
            badgeChildren.push(createElement("span", { key: "l", className: "dsh-obs-md-callout-label" }, spec.label));
          }
          const head = [createElement("span", { key: "badge", className: "dsh-obs-md-callout-badge" }, badgeChildren)];
          if (callout.title !== "") {
            head.push(createElement("span", { key: "t", className: "dsh-obs-md-callout-title" },
              renderInline(callout.title, handlers, `n${keyIdx}ct`, callout.titleStart)));
          }
          pushRow(block[0].num, "quote", head, gid, { "data-callout": spec.canon });
          // 正文块（契约 §4.6）：去掉 `>` 前缀后分类为 列表/任务、标题、空行、段落。
          for (let k = 1; k < block.length; k++) {
            const b = block[k];
            const qi = quotePrefixInfo(b.text);
            const prefixLen = qi ? qi.prefixLen : 0;
            const bodyText = b.text.slice(prefixLen);
            const bodyStart = b.start + prefixLen;
            const keyBase = `n${keyIdx}c${k}`;
            const baseProps = { "data-callout": spec.canon };
            if (bodyText === "") {
              // `>` 空行：行号与分组样式保留，内容为空
              pushRow(b.num, "quote", null, gid, baseProps);
              continue;
            }
            const bodyList = parseListLine(bodyText);
            if (bodyList) {
              const { inner, props } = listRowContent(bodyList, keyBase, bodyStart);
              pushRow(b.num, "quote list", inner, gid, { ...baseProps, ...props });
              continue;
            }
            const bodyHeading = splitHeadingLine(bodyText);
            if (bodyHeading) {
              pushRow(b.num, `quote heading h${bodyHeading.level}`,
                renderInline(bodyHeading.content, handlers, keyBase, bodyStart + bodyHeading.contentOffset), gid,
                { ...baseProps, "data-heading-level": String(bodyHeading.level) });
              continue;
            }
            pushRow(b.num, "quote", renderInline(bodyText, handlers, keyBase, bodyStart), gid, baseProps);
          }
          resetListState();
          continue;
        }
        for (let k = 0; k < block.length; k++) {
          const qi = quotePrefixInfo(block[k].text);
          pushRow(block[k].num, "quote",
            renderInline(block[k].text.slice(qi.prefixLen), handlers, `n${keyIdx}q${k}`, block[k].start + qi.prefixLen),
            null, { "data-quote-depth": String(qi.depth) });
        }
        continue;
      }

      // ── M4 表格：整块 <table>，行号放每行首列（表头/分隔/正文行都占号）──
      const headerCells = cur.text.includes("|") ? splitTableRow(cur.text, cur.start) : null;
      const aligns = headerCells && headerCells.length > 0 && i < lines.length
        ? parseTableAlignLine(lines[i])
        : null;
      if (aligns) {
        resetListState();
        const sep = nextLine();
        const bodyLines = [];
        while (i < lines.length && lines[i].includes("|")) bodyLines.push(nextLine());
        const gid = `t${cur.start}`;
        const colCount = headerCells.length;
        const alignOf = (j) => aligns[j] ?? "none";
        // 表头/正文列数不齐时按表头补齐（多出的截掉）
        const padCells = (cells, line) => {
          const out = cells.slice(0, colCount);
          while (out.length < colCount) out.push({ text: "", start: line.start + line.text.length, segments: [] });
          return out;
        };
        const thead = createElement("thead", null,
          createElement("tr", null,
            createElement("th", { key: `${gid}-th-ln`, className: "dsh-obs-md-tln" }, String(cur.num)),
            ...headerCells.map((cell, j) => createElement(
              "th",
              { key: `${gid}-th${j}`, "data-align": alignOf(j) },
              renderInlineCell(cell, handlers, `${gid}-th${j}`),
            )),
          ));
        const tbodyChildren = [
          createElement("tr", { key: `${gid}-sep`, className: "dsh-obs-md-tsep" },
            createElement("td", { key: `${gid}-sep-ln`, className: "dsh-obs-md-tln" }, String(sep.num)),
            createElement("td", { key: `${gid}-sep-cell`, className: "dsh-obs-md-tsep-cell", colspan: colCount }, null),
          ),
        ];
        for (const bodyLine of bodyLines) {
          const cells = padCells(splitTableRow(bodyLine.text, bodyLine.start), bodyLine);
          tbodyChildren.push(createElement("tr", { key: `${gid}-row${bodyLine.num}`, className: "dsh-obs-md-trow" },
            createElement("td", { key: `${gid}-row${bodyLine.num}-ln`, className: "dsh-obs-md-tln" }, String(bodyLine.num)),
            ...cells.map((cell, j) => createElement(
              "td",
              { key: `${gid}-row${bodyLine.num}-c${j}`, "data-align": alignOf(j) },
              renderInlineCell(cell, handlers, `${gid}-row${bodyLine.num}-c${j}`),
            )),
          ));
        }
        const tbody = createElement("tbody", null, ...tbodyChildren);
        pushBlock(createElement("div", {
          key: `n${keyIdx++}`,
          className: "dsh-obs-md-tablewrap",
          "data-table-group": gid,
        }, createElement("table", { className: "dsh-obs-md-table" }, thead, tbody)));
        continue;
      }

      // ── M3 列表（无序/有序/嵌套）+ 任务列表（只读复选框）──
      const listInfo = parseListLine(cur.text);
      if (listInfo) {
        const { inner, props } = listRowContent(listInfo, `n${keyIdx}`, cur.start);
        pushRow(cur.num, "list", inner, null, props);
        continue;
      }
      resetListState();

      // ── M5 setext：当前行非块起始、下一行是 `=+` / `-{3,}` 下划线 → 当前行 h1/h2；
      //    下划线行 dsh-obs-md-setext-underline 空内容占号（不显示 === / ---）；先 setext 后 hr。──
      const setextUnderline = i < lines.length ? lines[i] : null;
      if (cur.text.trim() !== "" && setextUnderline !== null &&
          /^(?:=+|-{3,})\s*$/.test(setextUnderline) && !isBlockStartLine(cur.text)) {
        const level = setextUnderline.trimStart().startsWith("=") ? 1 : 2;
        pushRow(cur.num, `heading h${level}`,
          renderInline(cur.text, handlers, `n${keyIdx}`, cur.start), null,
          { "data-heading-level": String(level) });
        const underline = nextLine();
        pushRow(underline.num, "setext-underline", null, null);
        continue;
      }

      // ── M5 标题分级（# ~ ######）：内容偏移按实际匹配长度（# 后多空格也对）──
      const headingMatch = splitHeadingLine(cur.text);
      if (headingMatch) {
        pushRow(cur.num, `heading h${headingMatch.level}`,
          renderInline(headingMatch.content, handlers, `n${keyIdx}`, cur.start + headingMatch.contentOffset), null,
          { "data-heading-level": String(headingMatch.level) });
        continue;
      }

      // ── M5 分隔线：行 class dsh-obs-md-hr，lc 里放 hr.dsh-obs-md-hr-line，行号保留 ──
      if (isHrLine(cur.text)) {
        pushRow(cur.num, "hr",
          [createElement("hr", { key: `n${keyIdx}hr`, className: "dsh-obs-md-hr-line" })], null);
        continue;
      }

      // 其余按普通段落行渲染
      pushRow(cur.num, null, renderInline(cur.text, handlers, `n${keyIdx}`, cur.start), null);
    }

    closeCallout();
    return createElement(Fragment, null, rows);
  }

  return { renderMarkdown, renderNumbered };
})();

const { renderMarkdown, renderNumbered } = renderMarkdownModule;
