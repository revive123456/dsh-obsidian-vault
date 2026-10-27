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

  // ── 行内扫描器（P2 M10，方案 D1/D13）────────────────────────────────────
  // 单遍字符扫描 → token 列表 → tokensToNodes 转 React 节点；renderInline 是二者的
  // wrapper（保持旧签名与调用点可用）。每个可见文本 token 带 chunks：
  // [{ text, start, end }]，满足 md.slice(start,end) === text 且区间连续；
  // 不可见定界符（强调/删除线/高亮/链接符号/注释/硬换行标记）不产 chunk。
  //
  // token 类型：
  //   text / escape / code：纯文本可见（escape 只映射被转义字符；code 映射去定界符内容）
  //   strong / em / strike / highlight：容器，定界符不可见
  //   wikilink（双链/非图片 embed）、embedImage（图片嵌入）
  //   link / img / autolink / bareUrl / tag / comment / hardbreak
  //   footnoteRef / math / inlineHtml：M12/M16/M17 的 hook，先按原文显示并保留精确 span

  // CommonMark 可转义字符集 = ASCII 标点（反斜杠只转义这些）
  const ASCII_PUNCT = /^[!-\/:-@[-`{-~]$/;
  const isPunctChar = (ch) => ch !== undefined && ch !== "" && ASCII_PUNCT.test(ch);
  const isSpaceChar = (ch) => ch === undefined || ch === "" || /\s/.test(ch);
  // 强调 flanking 的「标点」按 CommonMark：Unicode 标点/符号（中文全角标点也算，
  // 否则 `**90%**，` 这种中文标点后的 closer 会被误判成不能收）
  const FLANK_PUNCT = /^[\p{P}\p{S}]$/u;
  const isFlankPunctChar = (ch) => ch !== undefined && ch !== "" && FLANK_PUNCT.test(ch);
  // P2 M10：inlineHtml 只是 hook（M17 接入 sanitizer）。先只识别 M17 白名单里的行内标签，
  // 其余标签（如 <script>）按普通文本处理——既保住「HTML 绝不成为元素」的既有安全断言，
  // M17 接入时再把完整识别与 sanitizer 交出去。
  const INLINE_HTML_TAG_RE = /^<\/?(?:b|strong|i|em|u|s|del|mark|code|kbd|br|sup|sub|span|small|abbr)\b[^<>]*>/i;

  /** 文本片段 → React 节点；handlers.onText 存在时包成带偏移的 span */
  function textNode(text, start, end, key, handlers) {
    if (text === "") return null;
    if (handlers && typeof handlers.onText === "function") {
      return createElement("span", { key, className: "dsh-obs-src", "data-obs-src": `${start},${end}` }, text);
    }
    return createElement(Fragment, { key }, text);
  }

  /** chunks → 文本节点数组：一个源码连续段一个 span，保证每个 span 切片严格相等 */
  function chunksToNodes(chunks, keyBase, handlers) {
    const nodes = [];
    for (let k = 0; k < chunks.length; k += 1) {
      const c = chunks[k];
      const n = textNode(c.text, c.start, c.end, `${keyBase}-c${k}`, handlers);
      if (n) nodes.push(n);
    }
    return nodes;
  }

  /**
   * 强调配对（CommonMark 简化实现）：左右 flanking 决定能否开/闭，规则 3 处理
   * 「可开可闭」的定界符；按文档序找最近的可用 opener，成对后剩余字符继续参与配对。
   * return 值里未配对的定界符由 resolveEmphasis 收尾转回普通文本。
   */
  function emphasisRuleOfThree(open, close) {
    if (!(open.canClose || close.canOpen)) return true;
    if ((open.len + close.len) % 3 !== 0) return true;
    return open.len % 3 === 0 && close.len % 3 === 0;
  }

  /**
   * 把一段文本扫描成 token 列表。
   * @param {string} text 解析文本（表格单元格传「解表格层转义后」的逻辑文本）
   * @param {number} srcStart 普通路径：text 在源码里的绝对起点
   * @param {number[]=} srcStarts 表格单元格路径：每个字符对应的源码绝对偏移
   * @param {Set<number>=} srcSeparate 表格单元格路径：必须单独成 span 的字符下标（解出的 `|`）
   */
  function parseInlineTokens(text, srcStart, srcStarts, srcSeparate) {
    const absAt = srcStarts ? (k) => srcStarts[k] : (k) => srcStart + k;

    // 逻辑区间 [from,to) → 按源码连续性切成 chunk（转义/单元格解转义处会断开）
    function chunksFor(from, to) {
      const chunks = [];
      let runStart = from;
      for (let k = from + 1; k <= to; k += 1) {
        const broken = k === to || absAt(k) !== absAt(k - 1) + 1 ||
          (srcSeparate !== undefined && (srcSeparate.has(k) || srcSeparate.has(k - 1)));
        if (!broken) continue;
        chunks.push({ text: text.slice(runStart, k), start: absAt(runStart), end: absAt(k - 1) + 1 });
        runStart = k;
      }
      return chunks;
    }

    // 区间 [from,to) 逐字符解码转义（\| 这类），得到「显示字符 + 源码绝对偏移」的单元
    function unitsFor(from, to) {
      const units = [];
      for (let k = from; k < to; k += 1) {
        if (text[k] === "\\" && k + 1 < to && isPunctChar(text[k + 1])) {
          units.push({ ch: text[k + 1], start: absAt(k + 1), end: absAt(k + 1) + 1 });
          k += 1;
        } else {
          units.push({ ch: text[k], start: absAt(k), end: absAt(k) + 1 });
        }
      }
      return units;
    }
    function trimUnits(units) {
      let a = 0;
      let b = units.length;
      while (a < b && isSpaceChar(units[a].ch)) a += 1;
      while (b > a && isSpaceChar(units[b - 1].ch)) b -= 1;
      return units.slice(a, b);
    }
    function unitsText(units) {
      let s = "";
      for (const u of units) s += u.ch;
      return s;
    }
    function unitsChunks(units) {
      const chunks = [];
      let runText = "";
      let runStart = 0;
      let runEnd = 0;
      for (const u of units) {
        if (runText === "") {
          runText = u.ch;
          runStart = u.start;
          runEnd = u.end;
          continue;
        }
        if (u.start === runEnd) {
          runText += u.ch;
          runEnd = u.end;
          continue;
        }
        chunks.push({ text: runText, start: runStart, end: runEnd });
        runText = u.ch;
        runStart = u.start;
        runEnd = u.end;
      }
      if (runText !== "") chunks.push({ text: runText, start: runStart, end: runEnd });
      return chunks;
    }

    // 强调 flanking（CommonMark）：before/after 为定界符 run 两侧的字符
    function flankingAt(start, end, rangeFrom, rangeTo) {
      const before = start > rangeFrom ? text[start - 1] : "";
      const after = end < rangeTo ? text[end] : "";
      const beforeWs = isSpaceChar(before);
      const afterWs = isSpaceChar(after);
      const beforePunct = !beforeWs && isFlankPunctChar(before);
      const afterPunct = !afterWs && isFlankPunctChar(after);
      return {
        beforeWs,
        afterWs,
        beforePunct,
        afterPunct,
        left: !afterWs && (!afterPunct || beforeWs || beforePunct),
        right: !beforeWs && (!beforePunct || afterWs || afterPunct),
      };
    }

    // ── 各类行内结构的单点匹配（返回 { token, end } 或 null）──────────────
    function matchCodeSpan(start, to) {
      let n = 1;
      while (start + n < to && text[start + n] === "`") n += 1;
      let j = start + n;
      while (j + n <= to) {
        const idx = text.indexOf("`", j);
        if (idx < 0 || idx + n > to) return null;
        let m = 1;
        while (idx + m < to && text[idx + m] === "`") m += 1;
        if (m === n) {
          // CommonMark：内容首尾各一个空格时去掉（全空白除外）
          let from = start + n;
          let end = idx;
          if (end > from && text[from] === " " && text[end - 1] === " " && text.slice(from, end).trim() !== "") {
            from += 1;
            end -= 1;
          }
          return { end: idx + n, token: { type: "code", chunks: chunksFor(from, end) } };
        }
        j = idx + m;
      }
      return null;
    }

    function findWikiClose(from, to) {
      let j = from;
      while (j + 1 < to) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "]" && text[j + 1] === "]") return j;
        j += 1;
      }
      return -1;
    }

    /** 双链/embed 显示节点：别名优先，其次 target › 章节，最后 target（M7 口径） */
    function wikilinkDisplay(targetUnits, sectionUnits, aliasUnits, hasSection, hasAlias, rawChunks) {
      const out = [];
      if (hasAlias && unitsText(aliasUnits) !== "") {
        out.push({ kind: "chunks", chunks: unitsChunks(aliasUnits) });
        return out;
      }
      if (hasSection && unitsText(sectionUnits) !== "") {
        if (unitsText(targetUnits) !== "") {
          out.push({ kind: "chunks", chunks: unitsChunks(targetUnits) });
          out.push({ kind: "sep" });
        }
        out.push({ kind: "chunks", chunks: unitsChunks(sectionUnits) });
        return out;
      }
      out.push({ kind: "chunks", chunks: unitsChunks(targetUnits) });
      // 极端输入（如 [[]]）退化为源码原文，避免空按钮
      const visible = out.some((part) => part.kind === "sep" || part.chunks.length > 0);
      if (!visible) return [{ kind: "chunks", chunks: rawChunks }];
      return out;
    }

    function matchWikilink(start, to, embed) {
      const innerFrom = start + (embed ? 3 : 2);
      const close = findWikiClose(innerFrom, to);
      if (close < 0) return null;
      const end = close + 2;
      const units = unitsFor(innerFrom, close);
      let pipeAt = -1;
      for (let k = 0; k < units.length; k += 1) {
        if (units[k].ch === "|") {
          pipeAt = k;
          break;
        }
      }
      const sectionLimit = pipeAt >= 0 ? pipeAt : units.length;
      let hashAt = -1;
      for (let k = 0; k < sectionLimit; k += 1) {
        if (units[k].ch === "#") {
          hashAt = k;
          break;
        }
      }
      const targetUnits = trimUnits(units.slice(0, hashAt >= 0 ? hashAt : sectionLimit));
      const sectionUnits = hashAt >= 0 ? trimUnits(units.slice(hashAt + 1, sectionLimit)) : [];
      const aliasUnits = pipeAt >= 0 ? trimUnits(units.slice(pipeAt + 1)) : [];
      const target = unitsText(targetUnits);
      const alias = unitsText(aliasUnits);
      const rawChunks = chunksFor(start, end);
      if (embed && IMAGE_EXT.has(extOf(target))) {
        const size = parseImageSize(alias);
        return {
          end,
          token: {
            type: "embedImage",
            srcRaw: target,
            alt: size === null && alias !== "" ? alias : baseOf(target),
            ...(size === null ? {} : size),
            fallback: rawChunks,
          },
        };
      }
      const display = wikilinkDisplay(targetUnits, sectionUnits, aliasUnits, hashAt >= 0, pipeAt >= 0, rawChunks);
      return {
        end,
        token: {
          type: "wikilink",
          target,
          section: unitsText(sectionUnits), // M13：onClick 第二参 anchor（无 section 时为空串）
          title: `[[${target}]]`,
          display,
          fallback: rawChunks,
        },
      };
    }

    function matchInlineImage(start, to) {
      const closeBracket = text.indexOf("]", start + 2);
      if (closeBracket < 0 || closeBracket + 1 >= to || text[closeBracket + 1] !== "(") return null;
      const closeParen = text.indexOf(")", closeBracket + 2);
      if (closeParen < 0 || closeParen >= to) return null;
      const urlRaw = text.slice(closeBracket + 2, closeParen);
      if (urlRaw === "" || /\s/.test(urlRaw)) return null;
      return {
        end: closeParen + 1,
        token: {
          type: "img",
          alt: text.slice(start + 2, closeBracket),
          srcRaw: urlRaw,
          fallback: chunksFor(start, closeParen + 1),
        },
      };
    }

    function matchInlineLink(start, to) {
      const closeBracket = text.indexOf("]", start + 1);
      if (closeBracket < 0 || closeBracket === start + 1 || closeBracket + 1 >= to) return null;
      if (text[closeBracket + 1] !== "(") return null;
      const closeParen = text.indexOf(")", closeBracket + 2);
      if (closeParen < 0 || closeParen >= to) return null;
      const hrefRaw = text.slice(closeBracket + 2, closeParen);
      if (hrefRaw === "" || /\s/.test(hrefRaw)) return null;
      return {
        end: closeParen + 1,
        token: {
          type: "link",
          hrefRaw,
          children: scanRange(start + 1, closeBracket),
          fallback: chunksFor(start, closeParen + 1),
        },
      };
    }

    // 脚注引用 token（M10 只解析，M12 接入渲染）。字段约定（P2 契约 §12）：
    //   label                   `^` 之后的标签文本（如 "1" / "长注"）
    //   start / end             label 在源码里的绝对区间
    //   rawStart / rawEnd       整个 `[^label]` 在源码里的绝对区间
    //   chunks                  当前默认显示（原文）用的分块，M12 可忽略
    function matchFootnoteRef(start, to) {
      const close = text.indexOf("]", start + 2);
      if (close < 0 || close >= to) return null;
      const label = text.slice(start + 2, close);
      if (label === "" || /\s/.test(label)) return null;
      return {
        end: close + 1,
        token: {
          type: "footnoteRef",
          label,
          start: absAt(start + 2),
          end: absAt(close - 1) + 1,
          rawStart: absAt(start),
          rawEnd: absAt(close) + 1,
          chunks: chunksFor(start, close + 1),
        },
      };
    }

    function matchAutolink(start, to) {
      const m = /^<([A-Za-z][A-Za-z0-9+.\-]*:[^<>\s]*)>/.exec(text.slice(start, to));
      if (!m) return null;
      const href = m[1];
      if (safeUrl(href) === null) return null;
      // mailto 的显示文本去掉 mailto:（与真机 Obsidian 一致）
      const prefix = /^mailto:/i.test(href) ? 7 : 0;
      const from = start + 1 + prefix;
      const contentEnd = start + 1 + href.length;
      return {
        end: start + m[0].length,
        token: { type: "autolink", href, chunks: from < contentEnd ? chunksFor(from, contentEnd) : [] },
      };
    }

    // 行内 HTML token（M10 hook，M17 接入 sanitizer）：raw 为标签原文，
    // start/end 为源码绝对区间；当前默认按原文显示（未知/非白名单标签同样原文）。
    function matchInlineHtml(start, to) {
      const m = INLINE_HTML_TAG_RE.exec(text.slice(start, to));
      if (!m) return null;
      const end = start + m[0].length;
      return {
        end,
        token: {
          type: "inlineHtml",
          raw: text.slice(start, end),
          start: absAt(start),
          end: absAt(end - 1) + 1,
          chunks: chunksFor(start, end),
        },
      };
    }

    function matchTag(start, to, rangeFrom) {
      // 词中 # 不是标签（abc#tag）；行首/空白/标点后的 # 才认
      if (start > rangeFrom && !isSpaceChar(text[start - 1]) && !isPunctChar(text[start - 1])) return null;
      const m = /^#([\p{L}\p{N}_/-]+)/u.exec(text.slice(start, to));
      if (!m || !/[^\d]/.test(m[1])) return null; // 纯数字不是标签（真机 Obsidian 同）
      const end = start + 1 + m[1].length;
      return { end, token: { type: "tag", chunks: chunksFor(start, end) } };
    }

    // 行内数学 token（M10 hook，M16 接入 KaTeX）：raw 为含 `$` 的源码原文，
    // start/end 为整段源码绝对区间；当前默认按原文显示并保留精确 src span。
    function matchMath(start, to) {
      let j = start + 1;
      while (j < to) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "$") {
          if (j === start + 1) return null;
          return {
            end: j + 1,
            token: {
              type: "mathInline",
              raw: text.slice(start, j + 1),
              start: absAt(start),
              end: absAt(j) + 1,
              chunks: chunksFor(start, j + 1),
            },
          };
        }
        j += 1;
      }
      return null;
    }

    /** 裸 URL 尾随标点剥离：`,.，。`（契约 §3.7）+ 括号配平 */
    function trimBareUrl(rawUrl) {
      let url = rawUrl;
      let changed = true;
      while (changed && url.length > 1) {
        changed = false;
        const last = url[url.length - 1];
        if (",.，。;:!?".includes(last)) {
          url = url.slice(0, -1);
          changed = true;
          continue;
        }
        const open = { ")": "(", "]": "[", "}": "{" }[last];
        if (open !== undefined) {
          const opens = url.split(open).length - 1;
          const closes = url.split(last).length - 1;
          if (closes > opens) {
            url = url.slice(0, -1);
            changed = true;
          }
        }
      }
      return url;
    }

    function matchBareUrl(start, to) {
      const m = /^https?:\/\/[^\s<>"']+/i.exec(text.slice(start, to));
      if (!m) return null;
      const href = trimBareUrl(m[0]);
      if (href === "" || /^https?:\/\/$/i.test(href)) return null;
      return { end: start + href.length, token: { type: "bareUrl", href, chunks: chunksFor(start, start + href.length) } };
    }

    function matchEmphasisDelim(start, to, rangeFrom) {
      const ch = text[start];
      let n = 1;
      while (start + n < to && text[start + n] === ch) n += 1;
      const f = flankingAt(start, start + n, rangeFrom, to);
      let canOpen;
      let canClose;
      if (ch === "_") {
        // `_` 保持 CommonMark 严格规则：词中下划线不算强调（修 P1 吞字符缺陷）
        canOpen = f.left && (!f.right || f.beforePunct);
        canClose = f.right && (!f.left || f.afterPunct);
      } else {
        // `*` 的收尾放宽为「前一个字符非空白即可」：真机 Obsidian 对中文标点后的
        // `**…）**是` 这类写法照常渲染 strong，严格 CommonMark 会漏成原文（真实笔记踩到）。
        canOpen = f.left;
        canClose = !f.beforeWs;
      }
      return {
        end: start + n,
        token: { type: "delim", kind: "emph", ch, len: n, canOpen, canClose, from: start, to: start + n },
      };
    }

    function matchPairDelim(start, to, rangeFrom, kind, ch) {
      const f = flankingAt(start, start + 2, rangeFrom, to);
      return {
        end: start + 2,
        token: { type: "delim", kind, ch, len: 2, canOpen: f.left, canClose: f.right, from: start, to: start + 2 },
      };
    }

    // ── 强调/删除线/高亮配对 ────────────────────────────────────────────────
    function resolveEmphasis(tokens) {
      let changed = true;
      while (changed) {
        changed = false;
        for (let ci = 0; ci < tokens.length; ci += 1) {
          const close = tokens[ci];
          if (!close || close.type !== "delim" || !close.canClose) continue;
          let openIndex = -1;
          for (let k = ci - 1; k >= 0; k -= 1) {
            const open = tokens[k];
            if (!open || open.type !== "delim" || !open.canOpen || open.kind !== close.kind) continue;
            if (close.kind === "emph") {
              if (open.ch !== close.ch) continue;
              if (!emphasisRuleOfThree(open, close)) continue;
            }
            openIndex = k;
            break;
          }
          if (openIndex < 0) continue;
          const open = tokens[openIndex];
          const between = tokens.slice(openIndex + 1, ci);
          if (between.length === 0) continue;
          const use = close.kind === "emph" ? (open.len >= 2 && close.len >= 2 ? 2 : 1) : 2;
          const type = close.kind === "strike" ? "strike" : close.kind === "highlight" ? "highlight" : use === 2 ? "strong" : "em";
          const next = tokens.slice(0, openIndex);
          if (open.len > use) next.push({ ...open, len: open.len - use, to: open.to - use });
          next.push({ type, children: between });
          if (close.len > use) next.push({ ...close, from: close.from + use, len: close.len - use });
          next.push(...tokens.slice(ci + 1));
          tokens = next;
          changed = true;
          break;
        }
      }
      const out = [];
      for (const tok of tokens) {
        if (tok.type === "delim") {
          out.push({ type: "text", chunks: chunksFor(tok.from, tok.to) });
        } else if (tok.children !== undefined) {
          out.push({ ...tok, children: resolveEmphasis(tok.children) });
        } else {
          out.push(tok);
        }
      }
      return out;
    }

    /**
     * 扫一个区间并配对强调，返回 token 列表。link 文本等内嵌内容用递归调用，
     * 所以强调不会跨过链接边界配对（与 CommonMark 的 token 化口径一致）。
     */
    function scanRange(from, to) {
      const raw = [];
      let i = from;
      let textMark = from;
      const flushText = (upto) => {
        if (upto > textMark) raw.push({ type: "text", chunks: chunksFor(textMark, upto) });
      };
      const emit = (token, end) => {
        flushText(i);
        raw.push(token);
        textMark = end;
        i = end;
      };

      while (i < to) {
        const ch = text[i];
        let token = null;
        let end = i + 1;

        if (ch === "\\" && i + 1 < to && isPunctChar(text[i + 1])) {
          // 转义：显示 X，span 只映射 X（反斜杠不产 span）
          const pos = absAt(i + 1);
          token = { type: "escape", chunks: [{ text: text[i + 1], start: pos, end: pos + 1 }] };
          end = i + 2;
        } else if (ch === "`") {
          const r = matchCodeSpan(i, to);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "%" && i + 1 < to && text[i + 1] === "%") {
          // 同行注释 %%…%% 完全隐藏；未闭合按普通文本（与真机 Obsidian 一致）
          const close = text.indexOf("%%", i + 2);
          if (close >= 0 && close + 2 <= to) {
            token = { type: "comment" };
            end = close + 2;
          }
        } else if (ch === "!" && i + 2 < to && text[i + 1] === "[" && text[i + 2] === "[") {
          const r = matchWikilink(i, to, true);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "!" && i + 1 < to && text[i + 1] === "[") {
          const r = matchInlineImage(i, to);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "[" && i + 1 < to && text[i + 1] === "[") {
          const r = matchWikilink(i, to, false);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "[" && i + 1 < to && text[i + 1] === "^") {
          const r = matchFootnoteRef(i, to);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "[") {
          const r = matchInlineLink(i, to);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "<") {
          const r = matchAutolink(i, to) || matchInlineHtml(i, to);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "#") {
          const r = matchTag(i, to, from);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "$") {
          const r = matchMath(i, to);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "h" || ch === "H") {
          const r = matchBareUrl(i, to);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "*" || ch === "_") {
          const r = matchEmphasisDelim(i, to, from);
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "~" && i + 1 < to && text[i + 1] === "~") {
          const r = matchPairDelim(i, to, from, "strike", "~");
          if (r) {
            token = r.token;
            end = r.end;
          }
        } else if (ch === "=" && i + 1 < to && text[i + 1] === "=") {
          const r = matchPairDelim(i, to, from, "highlight", "=");
          if (r) {
            token = r.token;
            end = r.end;
          }
        }

        if (token !== null) {
          emit(token, end);
          continue;
        }
        i += 1;
      }
      flushText(to);
      return resolveEmphasis(raw);
    }

    // 行尾硬换行：两个及以上空格 或 未转义的反斜杠（标记本身不产 span，生成 <br>）
    let scanTo = text.length;
    let hardbreak = false;
    if (text.length > 0) {
      const spaces = / +$/.exec(text);
      if (spaces !== null && spaces[0].length >= 2) {
        scanTo -= spaces[0].length;
        hardbreak = true;
      } else if (text[text.length - 1] === "\\") {
        let bs = 0;
        for (let k = text.length - 1; k >= 0 && text[k] === "\\"; k -= 1) bs += 1;
        if (bs % 2 === 1) {
          scanTo -= 1;
          hardbreak = true;
        }
      }
    }

    const tokens = scanRange(0, scanTo);
    if (hardbreak) tokens.push({ type: "hardbreak" });
    return tokens;
  }

  /** token 列表 → React 节点（可见文本与源码偏移已在 token 的 chunks 里算好） */
  function tokensToNodes(tokens, keyBase, handlers) {
    const nodes = [];
    let ki = 0;
    for (const tok of tokens) {
      const key = `${keyBase}-j${ki++}`;
      switch (tok.type) {
        case "text":
        case "escape":
        case "code":
          nodes.push(...chunksToNodes(tok.chunks, key, handlers));
          break;
        // M12 接入点：脚注引用应渲染生成的上标 [N]（无 src span、可点击），
        // 点击滚动到定义行；缺定义时 title 提示。当前 M10 默认按原文显示并保留 src span。
        // token 字段：label / start,end（label 源码区间）/ rawStart,rawEnd（整段区间）。
        case "footnoteRef":
          nodes.push(...chunksToNodes(tok.chunks, key, handlers));
          break;
        // M16 接入点：行内数学由 KaTeX 渲染；加载前/失败降级原文+精确 span。
        // token 字段：raw / start,end。
        case "mathInline":
          nodes.push(...chunksToNodes(tok.chunks, key, handlers));
          break;
        // M17 接入点：行内 HTML 交给 sanitizer.parseHtmlToReact(tok.raw, React, {...})；
        // 返回 null 降级原文、返回 [] 丢弃（契约 §10）。当前 M10 默认按原文显示。
        case "inlineHtml":
          nodes.push(...chunksToNodes(tok.chunks, key, handlers));
          break;
        case "tag":
          nodes.push(createElement("span", { key, className: "dsh-obs-md-tag" },
            chunksToNodes(tok.chunks, `${key}-t`, handlers)));
          break;
        case "strong":
          nodes.push(createElement("strong", { key }, tokensToNodes(tok.children, key, handlers)));
          break;
        case "em":
          nodes.push(createElement("em", { key }, tokensToNodes(tok.children, key, handlers)));
          break;
        case "strike":
          nodes.push(createElement("span", { key, className: "dsh-obs-md-strike" },
            tokensToNodes(tok.children, key, handlers)));
          break;
        case "highlight":
          nodes.push(createElement("span", { key, className: "dsh-obs-md-highlight" },
            tokensToNodes(tok.children, key, handlers)));
          break;
        case "link": {
          const href = safeUrl(tok.hrefRaw);
          if (href === null) nodes.push(...chunksToNodes(tok.fallback, key, handlers));
          else nodes.push(createElement("a", { key, href, target: "_blank", rel: "noreferrer" },
            tokensToNodes(tok.children, key, handlers)));
          break;
        }
        case "img": {
          const src = resolveSrc(tok.srcRaw, handlers);
          if (src === null) nodes.push(...chunksToNodes(tok.fallback, key, handlers));
          else nodes.push(createElement("img", { key, src, alt: tok.alt, className: "dsh-obs-md-img" }));
          break;
        }
        case "embedImage": {
          const src = resolveSrc(tok.srcRaw, handlers);
          if (src === null) {
            nodes.push(...chunksToNodes(tok.fallback, key, handlers));
          } else {
            nodes.push(createElement("img", {
              key,
              src,
              alt: tok.alt,
              className: "dsh-obs-md-img",
              ...(tok.width === undefined ? {} : { width: tok.width }),
              ...(tok.height === undefined ? {} : { height: tok.height }),
            }));
          }
          break;
        }
        case "autolink":
        case "bareUrl":
          nodes.push(createElement("a", {
            key,
            className: "dsh-obs-md-autolink",
            href: tok.href,
            target: "_blank",
            rel: "noreferrer",
          }, chunksToNodes(tok.chunks, key, handlers)));
          break;
        case "wikilink": {
          const display = [];
          let di = 0;
          for (const part of tok.display) {
            if (part.kind === "sep") display.push(createElement(Fragment, { key: `${key}-sep${di++}` }, " › "));
            else display.push(...chunksToNodes(part.chunks, `${key}-d${di++}`, handlers));
          }
          nodes.push(createElement("button", {
            key,
            type: "button",
            className: "dsh-obs-wikilink",
            title: tok.title,
            onClick: () => {
              // M13：第二参 anchor = 章节文本（trim/反转义后），无 section 传 undefined
              if (handlers.onWikilink) handlers.onWikilink(tok.target, tok.section === "" ? undefined : tok.section);
            },
          }, display));
          break;
        }
        case "comment":
          break;
        case "hardbreak":
          nodes.push(createElement("br", { key }));
          break;
        default:
          break;
      }
    }
    return nodes;
  }

  /**
   * 行内渲染入口（保持旧签名）：text 对应源码区间 [srcStart, +length)；
   * srcStarts/srcSeparate 供表格单元格「先解转义再解析」路径使用。
   */
  function renderInline(text, handlers, keyBase, srcStart, srcStarts, srcSeparate) {
    return tokensToNodes(parseInlineTokens(text, srcStart, srcStarts, srcSeparate), keyBase, handlers);
  }

  /**
   * 表格单元格「先解转义再解析」（P2 M14，口径以真机 Oracle 为准）：
   * 单元格里的 `\|` 是表格层的转义（等价于别名分隔符），解析前还原成 `|`；
   * 同时记下还原后每个字符的源码绝对偏移，以及「解出来的 `|` 必须单独成 span」
   * 的下标集合（偏移只映射 `|` 本身、不含反斜杠），供偏移记账继续精确回查。
   * 其它行内转义（如 `\*`）不在这里处理，留给 renderInline 的 escape 分支。
   */
  function decodeTableCellEscapes(text, start) {
    let out = "";
    const starts = [];
    const separate = new Set();
    for (let k = 0; k < text.length; k++) {
      if (text[k] === "\\" && text[k + 1] === "|") {
        separate.add(out.length);
        out += "|";
        starts.push(start + k + 1); // 只映射 `|`，反斜杠不产 span
        k += 1;
        continue;
      }
      out += text[k];
      starts.push(start + k);
    }
    return { text: out, starts, separate };
  }

  /**
   * 表格行 → [{text, start}]：
   * - 修旧 bug：行首/行尾 `|` 只作分隔，不再多推一个空单元格（`a || b` 中间空列保留）；
   * - `\|` 不切列（转义解码交给 renderInlineCell）；
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
      return { text, start };
    });
  }

  /** 单元格内容渲染：先解表格层转义（`\|`），再走行内解析（偏移按还原后的字符映射）。 */
  function renderInlineCell(cell, handlers, keyBase) {
    const decoded = decodeTableCellEscapes(cell.text, cell.start);
    return renderInline(decoded.text, handlers, keyBase, cell.start, decoded.starts, decoded.separate);
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

  /**
   * 水平线行（列表识别前先排除）：`---` / `***` / `___`，以及 P2 M14 补的带空格写法
   * `* * *` / `- - -` / `_ _ _`（符号之间可有空格/tab，两侧允许空白；真机 Oracle 确认为 hr）。
   */
  function isHrLine(line) {
    return /^\s*(?:[-*_][ \t]*){3,}$/.test(line);
  }

  /** 缩进代码行（P2 M14）：行首 ≥4 空格或 1 个 tab；空行不算。 */
  function isIndentedCodeLine(line) {
    if (line === "") return false;
    if (line[0] === "\t") return true;
    return /^ {4,}/.test(line);
  }

  /** 缩进代码行 → 去掉一层缩进后的内容（4 空格或 1 tab），返回行内偏移 + 文本。 */
  function indentedCodeInfo(line) {
    const offset = line[0] === "\t" ? 1 : 4;
    return { offset, text: line.slice(offset) };
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

  /**
   * 块注释开定界行（P2 M10 补丁，真机 Oracle 口径）：
   * 行首可有 ≤3 个空格（引用行先去掉 `>` 前缀，offset 指向前缀之后），出现 `%%`，
   * 且同一行后面没有第二个 `%%`（有则是行内注释对，交给行内 scanner）→ 块注释开始。
   * 返回 { contentStart }（`%%` 在该行内的偏移）；不是开定界行返回 null。
   * 行首 >3 空格或 tab 不识别（缩进代码/段落续行优先，Oracle 同）。
   */
  function matchBlockCommentStart(line, offset) {
    let k = offset;
    let spaces = 0;
    while (k < line.length && line[k] === " ") {
      k += 1;
      spaces += 1;
    }
    if (spaces > 3) return null;
    if (line[k] !== "%" || line[k + 1] !== "%") return null;
    if (line.indexOf("%%", k + 2) >= 0) return null;
    return { contentStart: k };
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
        createElement("span", { className: "dsh-obs-md-ln", "data-line-no": String(num) }, String(num)),
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
      // P2 M14：缩进代码块只在「块起始」（文首或空行之后）开启；段落/列表的续行不在此列，
      // 避免把 `\t- tab 项` 这类列表续行当代码（真机 Oracle：段落下一行的缩进仍是段落文本）。
      const atBlockStart = i === 0 || lines[i - 1] === "";
      const cur = nextLine();

      // ── P2 M10 补丁：块注释（行首 `%%` 开始）整段隐藏，但每行照常占号、不产 span。
      //    Oracle 口径：行首（≤3 空格）`%%` 且本行无第二个 `%%` → 进入块注释；
      //    隐藏到后续行第一个 `%%`（该 `%%` 之后的同行文本可见，如 `%% 结束` → 可见「 结束」）；
      //    到文末仍未闭合 → 隐藏到文末。行中/跨行 inline `%%` 仍走行内 scanner 口径。──
      if (matchBlockCommentStart(cur.text, 0) !== null) {
        pushRow(cur.num, "comment", null, null, { "data-comment-block": "1" });
        while (i < lines.length) {
          const closeAt = lines[i].indexOf("%%");
          const b = nextLine();
          if (closeAt < 0) {
            pushRow(b.num, "comment", null, null, { "data-comment-block": "1" });
            continue;
          }
          // 闭合行：`%%` 之前隐藏，之后同行文本可见
          const rest = b.text.slice(closeAt + 2);
          if (rest.trim() === "") {
            pushRow(b.num, "comment", null, null, { "data-comment-block": "1" });
          } else {
            pushRow(b.num, null, renderInline(rest, handlers, `n${keyIdx}`, b.start + closeAt + 2), null);
          }
          break;
        }
        continue;
      }

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
          // P2 M10 补丁：正文里的块注释（`> %%` 开始）整段隐藏，行号与分组照常。
          let commentMode = false;
          for (let k = 1; k < block.length; k++) {
            const b = block[k];
            const qi = quotePrefixInfo(b.text);
            const prefixLen = qi ? qi.prefixLen : 0;
            const bodyText = b.text.slice(prefixLen);
            const bodyStart = b.start + prefixLen;
            const keyBase = `n${keyIdx}c${k}`;
            const baseProps = { "data-callout": spec.canon };
            if (commentMode) {
              const closeAt = bodyText.indexOf("%%");
              if (closeAt < 0) {
                pushRow(b.num, "quote comment", null, gid, { ...baseProps, "data-comment-block": "1" });
                continue;
              }
              commentMode = false;
              const rest = bodyText.slice(closeAt + 2);
              if (rest.trim() === "") {
                pushRow(b.num, "quote comment", null, gid, { ...baseProps, "data-comment-block": "1" });
              } else {
                pushRow(b.num, "quote", renderInline(rest, handlers, keyBase, bodyStart + closeAt + 2), gid, baseProps);
              }
              continue;
            }
            if (matchBlockCommentStart(bodyText, 0) !== null) {
              pushRow(b.num, "quote comment", null, gid, { ...baseProps, "data-comment-block": "1" });
              commentMode = true;
              continue;
            }
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
        // P2 M10 补丁：引用行里的块注释（`> %%` 开始）同样整段隐藏，行号照常
        let quoteCommentMode = false;
        for (let k = 0; k < block.length; k++) {
          const qi = quotePrefixInfo(block[k].text);
          const bodyText = block[k].text.slice(qi.prefixLen);
          const bodyStart = block[k].start + qi.prefixLen;
          const quoteProps = { "data-quote-depth": String(qi.depth) };
          if (quoteCommentMode) {
            const closeAt = bodyText.indexOf("%%");
            if (closeAt < 0) {
              pushRow(block[k].num, "quote comment", null, null, { ...quoteProps, "data-comment-block": "1" });
              continue;
            }
            quoteCommentMode = false;
            const rest = bodyText.slice(closeAt + 2);
            if (rest.trim() === "") {
              pushRow(block[k].num, "quote comment", null, null, { ...quoteProps, "data-comment-block": "1" });
            } else {
              pushRow(block[k].num, "quote", renderInline(rest, handlers, `n${keyIdx}q${k}`, bodyStart + closeAt + 2), null, quoteProps);
            }
            continue;
          }
          if (matchBlockCommentStart(bodyText, 0) !== null) {
            pushRow(block[k].num, "quote comment", null, null, { ...quoteProps, "data-comment-block": "1" });
            quoteCommentMode = true;
            continue;
          }
          pushRow(block[k].num, "quote",
            renderInline(bodyText, handlers, `n${keyIdx}q${k}`, bodyStart),
            null, quoteProps);
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
          while (out.length < colCount) out.push({ text: "", start: line.start + line.text.length });
          return out;
        };
        const thead = createElement("thead", null,
          createElement("tr", null,
            createElement("th", { key: `${gid}-th-ln`, className: "dsh-obs-md-tln", "data-line-no": String(cur.num) }, String(cur.num)),
            ...headerCells.map((cell, j) => createElement(
              "th",
              { key: `${gid}-th${j}`, "data-align": alignOf(j) },
              renderInlineCell(cell, handlers, `${gid}-th${j}`),
            )),
          ));
        const tbodyChildren = [
          createElement("tr", { key: `${gid}-sep`, className: "dsh-obs-md-tsep" },
            createElement("td", { key: `${gid}-sep-ln`, className: "dsh-obs-md-tln", "data-line-no": String(sep.num) }, String(sep.num)),
            createElement("td", { key: `${gid}-sep-cell`, className: "dsh-obs-md-tsep-cell", colspan: colCount }, null),
          ),
        ];
        for (const bodyLine of bodyLines) {
          const cells = padCells(splitTableRow(bodyLine.text, bodyLine.start), bodyLine);
          tbodyChildren.push(createElement("tr", { key: `${gid}-row${bodyLine.num}`, className: "dsh-obs-md-trow" },
            createElement("td", { key: `${gid}-row${bodyLine.num}-ln`, className: "dsh-obs-md-tln", "data-line-no": String(bodyLine.num) }, String(bodyLine.num)),
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

      // ── P2 M14 缩进代码块（行首 ≥4 空格或 1 tab）：只在块起始开启（围栏/引用/表格/列表先判）；
      //    连续缩进行逐行占号，显示去一层缩进（4 空格或 1 tab）后的内容，偏移从内容首字符算；
      //    遇空行/非缩进行结束。复用围栏代码的行样式与 data-code-group。──
      if (atBlockStart && isIndentedCodeLine(cur.text)) {
        const group = `i${cur.start}`;
        const codeLines = [];
        let line = cur;
        for (;;) {
          const info = indentedCodeInfo(line.text);
          codeLines.push({ num: line.num, start: line.start + info.offset, text: info.text });
          if (i >= lines.length || !isIndentedCodeLine(lines[i])) break;
          line = nextLine();
        }
        for (let k = 0; k < codeLines.length; k++) {
          const cl = codeLines[k];
          pushRow(cl.num, k === 0 ? "code code-head" : "code",
            cl.text === "" ? null : textNode(cl.text, cl.start, cl.start + cl.text.length, `n${keyIdx}ic${k}`, handlers),
            null, { "data-code-group": group });
        }
        // 末行加 code-end（单行块首行同时是 head + end）
        const lastCodeRow = rows[rows.length - 1];
        if (lastCodeRow) lastCodeRow.props.className += " dsh-obs-md-code-end";
        continue;
      }

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
