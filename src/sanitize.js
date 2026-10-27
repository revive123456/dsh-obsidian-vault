/**
 * HTML / SVG 白名单 sanitizer（P2 M17；零依赖，浏览器与 Node 共用，函数式）。
 *
 * 职责边界（信任模型）：
 *   - 输入是 Markdown 行内 HTML / mermaid 渲染出的 SVG **源码字符串**，一律视为不可信；
 *   - 输出是「只用 React.createElement 重建」的节点树：**绝不**使用
 *     dangerouslySetInnerHTML，也绝不把原始 HTML 字符串塞进 React；
 *   - 文本一律走 React 文本节点（React 会转义），元素/属性只按白名单重建；
 *   - 未知标签不注入元素（HTML 侧降级为纯文本、SVG 侧整段丢弃）。
 *
 * 公共 API（模块末尾解构出同名顶层函数，build 时与 markdown.js/client.js 拼在同一
 * factory 闭包内；本文件不 import 任何东西，Node 测试里用 jsdom 的 DOMParser 注入）：
 *
 *   parseHtmlToReact(html, React, options?) -> React 节点数组 | null
 *     行内 HTML v1 白名单重建。options：
 *       inline?: boolean         v1 只有行内白名单；传 false 行为不变（预留 block 评审）
 *       DOMParser?: Function     解析器构造器；默认 globalThis.DOMParser，缺失时返回 null
 *       textHandler?: (text, localStart) => React 节点
 *                                可见文本的源码偏移回调，见下
 *       keyPrefix?: string       生成本次输出节点 key 的前缀（默认 "h"）；同一父节点
 *                                里拼多个行内 HTML 片段时调用方要传不同前缀
 *                                （如 "h" + token.start），否则 React key 会撞
 *     返回 React 节点数组（元素都带 key，可直接展开进 children）：
 *       null = 「无法安全解析」（DOMParser 缺失/解析异常/入参非法），调用方降级原文文本；
 *       []   = 「内容全部被安全策略丢弃」（例如整段只有 <script>），调用方不要回退原文。
 *
 *   sanitizeSvgToReact(svgString, React, options?) -> React 元素 | null
 *     给 mermaid（M20）复用。options：DOMParser、idPrefix、allowStyleAttributes、
 *     keyPrefix、maxNodes、maxDepth。返回根 <svg> React 元素（**不带 key**，由调用方
 *     决定放置位置、需要时自己包 key）或 null（解析失败/无 <svg> 根 → 调用方降级）
 *     idPrefix：所有 id 与 url(#...)/href="#..." 引用统一加前缀，防跨图/跨页面 id 冲突
 *     与 DOM clobbering；默认每次调用生成唯一前缀。
 *     allowStyleAttributes：默认 false（style 属性丢弃）；M20 可打开，仍按 SVG 表现属性
 *     白名单逐条清洗（外部 url()/expression/!important 等丢弃）。
 *
 *   sanitizeUrl(raw) -> string | null
 *     D9 的 URL 协议白名单：仅 http/https/mailto/#；其余（javascript:、data: 等）返回 null。
 *     当前行内白名单标签没有 href/src（见下），该函数预留给后续 block HTML / 媒体评审复用。
 *
 * 行内 HTML v1 白名单（D9，与 P2 契约 §3.8 一致）：
 *   允许标签：b strong i em u s del mark code kbd br sup sub span small abbr
 *   允许属性：仅 title（class/id/style/href/src 等一律忽略；React 文本子节点负责转义）
 *   未知标签：不产元素，保留其可见文本内容（例如 <details> 只显示「展开 内文」）
 *   禁止标签：script style iframe object embed link meta base title form input button
 *             select option optgroup textarea svg math template noscript audio video
 *             canvas source track frame frameset applet param plaintext xmp 等，
 *             整棵子树丢弃（代码/嵌入/可交互内容，Obsidian 里本也不显示脚本内容）。
 *   另外：注释（<!-- -->）、DOCTYPE、CDATA 等非元素节点一律不产节点。
 *
 * 文本偏移回调（textHandler）契约：
 *   - localStart 是该文本在**传入 html 字符串**内的起始偏移；调用方加上行内 HTML
 *     token 的源码基准，即可得到 markdown 源串里的绝对偏移；
 *   - 仅当 html.slice(localStart, localStart + text.length) === text 时才会调用
 *     （即「原文与可见文本逐字相等」）。实体解码（&amp; → &）、CRLF 归一化等
 *     会让可见文本与源码切片不相等，这类文本按「生成文本」处理、**不调用**
 *     textHandler（否则会破坏契约 §5 的 md.slice===文本 不变量）；
 *   - 返回值包在 React.Fragment（带 key）里放回树中；返回 null/undefined 时按普通
 *     文本节点渲染；回调抛异常时同样降级为普通文本。
 *
 * 浏览器 / Node 双端：
 *   - 浏览器用原生 DOMParser；Node 测试（test/sanitize.mjs）用 jsdom 的 DOMParser 注入；
 *   - 本文件不 import 任何包，DOMParser 只能是参数/全局；
 *   - 真实浏览器行为由 verifier 在 GUI 侧抽查（方法写在 test/sanitize.mjs 头部注释）。
 *
 * 已知边界（v1，写进汇报与 README 已知差异）：
 *   - 只有行内 HTML；多行/block HTML（如独占一行的 <details>）由 Markdown 层原文降级；
 *   - 行内 HTML 不渲染 <a>/<img>（不在白名单内），只保留其文本；
 *   - SVG 丢弃 <style>（不开放内联 CSS），颜色需由调用方 CSS/属性继承兜底；
 *     style 属性默认丢弃，M20 需要时可显式打开 allowStyleAttributes（仍按属性白名单清洗）。
 */
const sanitizeModule = (() => {
  "use strict";

  // ── HTML 白名单（P2 契约 §3.8）────────────────────────────────────────────
  const INLINE_ALLOWED_TAGS = new Set([
    "b", "strong", "i", "em", "u", "s", "del", "mark", "code", "kbd",
    "br", "sup", "sub", "span", "small", "abbr",
  ]);
  // 允许属性：仅 title（URL 类属性不在 v1 白名单，见 D9）
  const INLINE_ALLOWED_ATTRS = ["title"];
  const INLINE_URL_ATTRS = new Set(["href", "src"]);

  // 禁止标签：整棵子树丢弃（代码执行/嵌入/可交互/表单 clobbering/数学/矢量图开关）
  const INLINE_FORBIDDEN_TAGS = new Set([
    "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
    "param", "link", "meta", "base", "basefont", "title", "head", "body", "html",
    "template", "noscript", "noembed", "noframes", "plaintext", "xmp",
    "svg", "math", "form", "input", "button", "select", "option", "optgroup",
    "textarea", "audio", "video", "source", "track", "canvas", "keygen", "isindex",
  ]);

  // 扫描源码文本段时，这些标签按 HTML 的 raw text / RCDATA 处理（内部不再当标签解析）
  const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "noembed", "noframes"]);

  const HTML_MAX_INPUT = 1000000;
  const HTML_MAX_NODES = 5000;
  const HTML_MAX_DEPTH = 100;
  const HTML_DEFAULT_KEY_PREFIX = "h";

  // ── SVG 白名单（M20 复用；不含 script/foreignObject/动画/图像/滤镜）────────
  // key = 小写 localName，value = React 认识的规范标签名（createElement 用）
  const SVG_TAGS = new Map([
    ["svg", "svg"],
    ["g", "g"],
    ["defs", "defs"],
    ["symbol", "symbol"],
    ["marker", "marker"],
    ["clippath", "clipPath"],
    ["mask", "mask"],
    ["pattern", "pattern"],
    ["lineargradient", "linearGradient"],
    ["radialgradient", "radialGradient"],
    ["stop", "stop"],
    ["path", "path"],
    ["rect", "rect"],
    ["circle", "circle"],
    ["ellipse", "ellipse"],
    ["line", "line"],
    ["polyline", "polyline"],
    ["polygon", "polygon"],
    ["text", "text"],
    ["tspan", "tspan"],
    ["textpath", "textPath"],
    ["title", "title"],
    ["desc", "desc"],
    ["use", "use"],
  ]);
  // key = 小写 DOM 属性名（浏览器/DOMParser 对 SVG 属性名会做大小写调整）
  const SVG_ATTRS = new Set([
    "id", "class", "role", "xmlns", "xmlns:xlink", "version",
    "viewbox", "preserveaspectratio", "width", "height",
    "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
    "d", "points", "dx", "dy", "rotate", "transform", "pathlength", "textlength", "lengthadjust",
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
    "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
    "stroke-dashoffset", "opacity", "color", "display", "visibility", "paint-order",
    "shape-rendering", "vector-effect", "color-interpolation",
    "clip-path", "clip-rule", "mask", "filter",
    "marker-start", "marker-mid", "marker-end",
    "markerwidth", "markerheight", "markerunits", "refx", "refy", "orient",
    "offset", "stop-color", "stop-opacity",
    "gradientunits", "gradienttransform", "spreadmethod",
    "patternunits", "patterncontentunits", "patterntransform", "clippathunits",
    "font-family", "font-size", "font-weight", "font-style", "font-variant",
    "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline",
    "alignment-baseline", "text-decoration",
    "href", "xlink:href",
    "style", // 是否真正保留由 allowStyleAttributes 决定
  ]);
  // SVG 属性名（小写）→ React prop 名：只列不能由「连字符转驼峰」推导的
  const SVG_ATTR_PROP = {
    class: "className",
    role: "role",
    viewbox: "viewBox",
    preserveaspectratio: "preserveAspectRatio",
    markerwidth: "markerWidth",
    markerheight: "markerHeight",
    markerunits: "markerUnits",
    refx: "refX",
    refy: "refY",
    gradientunits: "gradientUnits",
    gradienttransform: "gradientTransform",
    spreadmethod: "spreadMethod",
    patternunits: "patternUnits",
    patterncontentunits: "patternContentUnits",
    patterntransform: "patternTransform",
    clippathunits: "clipPathUnits",
    pathlength: "pathLength",
    textlength: "textLength",
    lengthadjust: "lengthAdjust",
    "xlink:href": "xlinkHref",
    "xmlns:xlink": "xmlnsXlink",
    "stop-color": "stopColor",
    "stop-opacity": "stopOpacity",
    "fill-opacity": "fillOpacity",
    "fill-rule": "fillRule",
  };
  // 取值可能是 url(#id) 引用的属性：只放行「本图内部 id」，其它 url()/协议一律丢属性
  const SVG_URL_ATTRS = new Set([
    "fill", "stroke", "filter", "clip-path", "mask",
    "marker-start", "marker-mid", "marker-end",
  ]);
  // allowStyleAttributes 打开时，style 只保留这些 SVG 表现属性
  const SVG_STYLE_PROPS = new Set([
    "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
    "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
    "stroke-dashoffset", "opacity", "color", "display", "visibility",
    "font-family", "font-size", "font-weight", "font-style", "text-anchor",
    "dominant-baseline", "letter-spacing", "stop-color", "stop-opacity",
    "paint-order", "shape-rendering", "vector-effect",
  ]);
  const SVG_MAX_INPUT = 2000000;
  const SVG_MAX_NODES = 30000;
  const SVG_MAX_DEPTH = 200;
  // 每次调用生成唯一 id 前缀，避免多个 mermaid 图之间、以及与宿主页面之间的 id 冲突
  // （id 同名会让 url(#x)/use href 引用到别的元素，也是 DOM clobbering 的入口）
  let svgIdSeq = 0;

  // 节点类型常量
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  // ── 小工具 ────────────────────────────────────────────────────────────────
  function isAsciiAlphaCode(code) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }

  /** 该位置的 '<' 看起来是标签/注释/声明的开头（否则当普通文本字符） */
  function looksLikeMarkupStart(html, i) {
    const code = html.charCodeAt(i + 1);
    return isAsciiAlphaCode(code) || code === 47 /* / */ || code === 33 /* ! */ || code === 63 /* ? */;
  }

  /** 从 start（'<' 位置）找到标签结束 '>'，属性值里的引号内 '>' 不算；找不到返回 -1 */
  function findTagEnd(html, start) {
    let quote = "";
    for (let i = start + 1; i < html.length; i += 1) {
      const ch = html[i];
      if (quote !== "") {
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === ">") return i + 1;
    }
    return -1;
  }

  /**
   * 扫出 html 源串里「可见文本段」的原始区间（文本偏移回调用）。
   * 只做区间切分，不做 HTML 解析（结构以 DOMParser 为准）；与 HTML 分词器保持同一
   * 口径：标签/注释/声明跳过，raw text 元素（script/style/...）内部整段跳过，
   * 不像标签开头的 '<' 按正文算。返回 null 表示扫描器与解析器口径可能不一致
   * （畸形未闭合标签），此时调用方关闭偏移映射而不是冒险映射错位。
   */
  function scanTextRuns(html) {
    const runs = [];
    const len = html.length;
    let i = 0;
    let lower = null;
    while (i < len) {
      if (html[i] === "<" && looksLikeMarkupStart(html, i)) {
        if (html.startsWith("<!--", i)) {
          const commentEnd = html.indexOf("-->", i + 4);
          i = commentEnd === -1 ? len : commentEnd + 3;
          continue;
        }
        const tagEnd = findTagEnd(html, i);
        if (tagEnd === -1) return null;
        const tag = html.slice(i, tagEnd);
        const match = /^<([a-zA-Z][^\s/>]*)/.exec(tag);
        i = tagEnd;
        if (match) {
          const name = match[1].toLowerCase();
          if (name === "plaintext") {
            i = len;
            break;
          }
          if (RAW_TEXT_TAGS.has(name)) {
            if (lower === null) lower = html.toLowerCase();
            const closeIdx = lower.indexOf("</" + name, i);
            if (closeIdx === -1) {
              i = len;
              break;
            }
            const closeEnd = findTagEnd(html, closeIdx);
            if (closeEnd === -1) return null;
            i = closeEnd;
          }
        }
        continue;
      }
      // 文本段：一直扫到下一个「像标记开头」的 '<'
      const start = i;
      let j = i;
      while (j < len) {
        const lt = html.indexOf("<", j);
        if (lt === -1) {
          j = len;
          break;
        }
        if (looksLikeMarkupStart(html, lt)) {
          j = lt;
          break;
        }
        j = lt + 1;
      }
      if (j > start) runs.push({ start: start, end: j, raw: html.slice(start, j) });
      i = j;
    }
    return runs;
  }

  /**
   * 把一段无标签的原始文本按 HTML 实体解码（&amp;/&lt;/&#x41;/&copy; ...），
   * 用于和 DOMParser 产出的文本节点对齐。复用解析出来的 document 里的 detached
   * div；入参是没有标签的文本段（不含「'<' + 字母」），innerHTML 只会产生文本节点，
   * 不会建元素、不会发请求。childNodes 形状异常时返回 null（宁可不映射也不映射错）。
   */
  function decodeRunText(raw, host) {
    if (raw.indexOf("&") === -1 && raw.indexOf("\r") === -1 && raw.indexOf("\u0000") === -1) return raw;
    host.innerHTML = raw;
    if (host.childNodes.length !== 1 || host.childNodes[0].nodeType !== TEXT_NODE) return null;
    return host.childNodes[0].data;
  }

  /**
   * D9 URL 协议白名单：http/https/mailto/#。先去掉控制字符再判断，
   * 防 `java\tscript:` / 前导换行这类浏览器会忽略控制字符的绕过。
   */
  function sanitizeUrl(raw) {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const probe = trimmed.replace(/[\u0000-\u001f\u007f]/g, "");
    if (!/^(?:https?:|mailto:|#)/i.test(probe)) return null;
    // 白名单已不可能放行这些协议；这里显式再挡一次，防以后有人放宽正则
    if (/^(?:javascript|data|vbscript|file):/i.test(probe)) return null;
    return trimmed;
  }

  function cleanAttrText(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  }

  function nextKey(ctx) {
    const key = ctx.keyPrefix + ctx.keyIndex;
    ctx.keyIndex += 1;
    return key;
  }

  function createEl(ctx, tag, props, children) {
    if (children.length === 0) return ctx.createElement(tag, props);
    return ctx.createElement(tag, props, children);
  }

  // ── HTML → React ──────────────────────────────────────────────────────────
  function parseHtmlToReact(html, React, options) {
    const opts = options || {};
    if (typeof html !== "string" || html === "") return null;
    if (html.length > HTML_MAX_INPUT) return null;
    if (!React || typeof React.createElement !== "function") return null;
    const ParserCtor = opts.DOMParser === undefined ? globalThis.DOMParser : opts.DOMParser;
    if (typeof ParserCtor !== "function") return null;

    let doc;
    try {
      doc = new ParserCtor().parseFromString(html, "text/html");
    } catch (err) {
      return null;
    }
    if (!doc || !doc.body) return null;

    const textHandler = typeof opts.textHandler === "function" ? opts.textHandler : null;
    const keyPrefix =
      typeof opts.keyPrefix === "string" && opts.keyPrefix !== "" ? opts.keyPrefix : HTML_DEFAULT_KEY_PREFIX;
    const ctx = {
      createElement: React.createElement,
      Fragment: React.Fragment,
      textHandler: textHandler,
      keyPrefix: keyPrefix,
      keyIndex: 0,
      nodeCount: 0,
      maxNodes: typeof opts.maxNodes === "number" && opts.maxNodes > 0 ? opts.maxNodes : HTML_MAX_NODES,
      maxDepth: typeof opts.maxDepth === "number" && opts.maxDepth > 0 ? opts.maxDepth : HTML_MAX_DEPTH,
      doc: doc,
      decodeHost: null,
      runs: null,
      runIndex: 0,
    };
    if (textHandler !== null) {
      const runs = scanTextRuns(html);
      ctx.runs = runs === null ? [] : runs;
    }

    try {
      return renderHtmlChildren(doc.body, ctx, 0);
    } catch (err) {
      // 安全模块一律 fail-closed：意外异常 → 调用方降级原文文本
      return null;
    }
  }

  function renderHtmlChildren(parent, ctx, depth) {
    const out = [];
    if (depth > ctx.maxDepth) return out;
    const children = parent.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      if (ctx.nodeCount >= ctx.maxNodes) break;
      const node = children[i];
      if (node.nodeType === TEXT_NODE) {
        const textNode = renderHtmlText(node.data, ctx);
        if (textNode !== null) out.push(textNode);
        continue;
      }
      if (node.nodeType !== ELEMENT_NODE) continue; // 注释/DOCTYPE/CDATA 一律丢弃
      const rendered = renderHtmlElement(node, ctx, depth);
      if (rendered === null) continue;
      if (Array.isArray(rendered)) {
        for (let k = 0; k < rendered.length; k += 1) out.push(rendered[k]);
      } else {
        out.push(rendered);
      }
    }
    return out;
  }

  function renderHtmlText(text, ctx) {
    ctx.nodeCount += 1;
    if (text === "" || text === null || text === undefined) return null;
    if (ctx.textHandler === null) return text;
    // 按源码顺序消费文本段：实体解码后的文本也消费，但只在原文切片与可见文本
    // 逐字相等时才回调节点，保证 md.slice(start,end) === 文本 永远成立
    const runs = ctx.runs;
    let matched = null;
    while (ctx.runIndex < runs.length) {
      const run = runs[ctx.runIndex];
      ctx.runIndex += 1;
      let decoded = run.decoded;
      if (decoded === undefined) {
        if (ctx.decodeHost === null) ctx.decodeHost = ctx.doc.createElement("div");
        decoded = decodeRunText(run.raw, ctx.decodeHost);
        run.decoded = decoded;
      }
      if (decoded === text) {
        matched = run;
        break;
      }
    }
    if (matched === null || matched.raw !== text) return text;
    let produced = null;
    try {
      produced = ctx.textHandler(text, matched.start);
    } catch (err) {
      produced = null;
    }
    if (produced === null || produced === undefined) return text;
    ctx.nodeCount += 1;
    if (typeof ctx.Fragment === "undefined" || ctx.Fragment === null) return produced;
    return ctx.createElement(ctx.Fragment, { key: nextKey(ctx) }, produced);
  }

  function renderHtmlElement(el, ctx, depth) {
    const tag = String(el.localName || "").toLowerCase();
    if (tag === "") return null;
    if (INLINE_ALLOWED_TAGS.has(tag)) {
      ctx.nodeCount += 1;
      const props = { key: nextKey(ctx) };
      for (let i = 0; i < INLINE_ALLOWED_ATTRS.length; i += 1) {
        const name = INLINE_ALLOWED_ATTRS[i];
        const value = el.getAttribute(name);
        if (value === null) continue;
        if (INLINE_URL_ATTRS.has(name)) {
          const safe = sanitizeUrl(value);
          if (safe !== null) props[name] = safe;
          continue;
        }
        props[name] = cleanAttrText(value);
      }
      if (tag === "br") return createEl(ctx, tag, props, []);
      return createEl(ctx, tag, props, renderHtmlChildren(el, ctx, depth + 1));
    }
    if (INLINE_FORBIDDEN_TAGS.has(tag)) return null;
    // 未知标签：不注入元素，只把子内容按纯文本降级（契约：未知标签绝不注入元素）
    return renderHtmlChildren(el, ctx, depth + 1);
  }

  // ── SVG → React（mermaid 用）──────────────────────────────────────────────
  function normalizeSvgIdPrefix(prefix) {
    if (typeof prefix === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)) return prefix;
    svgIdSeq += 1;
    return "dsh-obs-svg-" + svgIdSeq + "-";
  }

  function svgPropName(lowerName) {
    if (Object.prototype.hasOwnProperty.call(SVG_ATTR_PROP, lowerName)) return SVG_ATTR_PROP[lowerName];
    return lowerName.replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
  }

  /** id 只放行安全字符，并统一加前缀（防跨图/跨页面 id 冲突与 DOM clobbering） */
  function makeSvgId(value, ctx) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(raw)) return null;
    const id = ctx.idPrefix + raw;
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)) return null;
    return id;
  }

  /** href/xlink:href：只允许本图内部 #id 引用；其它（javascript:/data:/外部 URL）丢属性 */
  function makeSvgHref(value, ctx) {
    const raw = typeof value === "string" ? value.trim() : "";
    const match = /^#([A-Za-z_][A-Za-z0-9_.:-]{0,63})$/.exec(raw);
    if (!match) return null;
    return "#" + ctx.idPrefix + match[1];
  }

  /** fill/stroke/filter/clip-path 等：只放行「none/颜色/本图内部 url(#id)」 */
  function sanitizeSvgPaint(value, ctx) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text === "") return null;
    const refRe = /url\s*\(\s*(['"]?)#([A-Za-z_][A-Za-z0-9_.:-]{0,63})\1\s*\)/gi;
    const rest = text.replace(refRe, "");
    if (/url\s*\(/i.test(rest)) return null; // 还有非内部引用（外链/不规范写法）
    if (/javascript:|vbscript:|data:|https?:|mailto:/i.test(rest)) return null;
    if (/[\u0000-\u001f\u007f]/.test(text)) return null;
    return text.replace(refRe, (m, quote, id) => "url(#" + ctx.idPrefix + id + ")");
  }

  /**
   * style 属性（可选打开）：逐条声明按属性白名单过滤。
   * 返回 React 需要的样式对象（属性名转驼峰），无可用声明时返回 null；
   * React 的 style 只接受对象，传字符串会在浏览器里报错，因此这里必须转对象。
   */
  function sanitizeSvgStyle(value, ctx) {
    const declarations = String(value).split(";");
    const style = {};
    let kept = 0;
    for (let i = 0; i < declarations.length; i += 1) {
      const decl = declarations[i];
      const colon = decl.indexOf(":");
      if (colon <= 0) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      let val = decl.slice(colon + 1).trim();
      if (!SVG_STYLE_PROPS.has(prop)) continue;
      if (val === "" || val.length > 200) continue;
      if (/javascript:|vbscript:|expression\s*\(|@import|behavior\s*:|-moz-binding/i.test(val)) continue;
      if (/[<>\\]/.test(val)) continue;
      // React 的 style 对象不支持 !important：只去掉值末尾的 !important 再保留声明
      val = val.replace(/\s*!important\s*$/i, "");
      if (/!important/i.test(val) || val === "") continue;
      if (/url\s*\(/i.test(val)) {
        const safe = sanitizeSvgPaint(val, ctx);
        if (safe === null) continue;
        val = safe;
      }
      const propName = prop.replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
      if (Object.prototype.hasOwnProperty.call(style, propName)) continue;
      style[propName] = val;
      kept += 1;
    }
    return kept === 0 ? null : style;
  }

  function svgPropsOf(el, ctx) {
    const props = { key: nextKey(ctx) };
    const attrs = el.attributes;
    for (let i = 0; i < attrs.length; i += 1) {
      const attr = attrs[i];
      const lowerName = attr.name.toLowerCase();
      if (!SVG_ATTRS.has(lowerName)) continue;
      if (lowerName === "style") {
        if (ctx.allowStyleAttributes !== true) continue;
        const style = sanitizeSvgStyle(attr.value, ctx);
        if (style !== null) props.style = style;
        continue;
      }
      if (lowerName === "id") {
        const id = makeSvgId(attr.value, ctx);
        if (id !== null) props.id = id;
        continue;
      }
      if (lowerName === "class") {
        const cls = String(attr.value);
        if (cls.length <= 200 && /^[A-Za-z_][A-Za-z0-9_ -]*$/.test(cls)) props.className = cls;
        continue;
      }
      if (lowerName === "href" || lowerName === "xlink:href") {
        const href = makeSvgHref(attr.value, ctx);
        if (href !== null) props[svgPropName(lowerName)] = href;
        continue;
      }
      if (SVG_URL_ATTRS.has(lowerName)) {
        const safe = sanitizeSvgPaint(attr.value, ctx);
        if (safe !== null) props[svgPropName(lowerName)] = safe;
        continue;
      }
      props[svgPropName(lowerName)] = cleanAttrText(attr.value);
    }
    return props;
  }

  function renderSvgElement(el, ctx, depth, isRoot) {
    if (el === null || el === undefined || el.nodeType !== ELEMENT_NODE) return null;
    if (depth > ctx.maxDepth) return null;
    if (ctx.nodeCount >= ctx.maxNodes) return null;
    const tag = SVG_TAGS.get(String(el.localName || "").toLowerCase());
    if (tag === undefined) return null; // 未知/危险 SVG 标签：整棵子树丢弃
    ctx.nodeCount += 1;
    const props = svgPropsOf(el, ctx);
    if (isRoot === true) delete props.key; // 根节点由调用方决定放置位置/key
    const children = [];
    const childNodes = el.childNodes;
    for (let i = 0; i < childNodes.length; i += 1) {
      const child = childNodes[i];
      if (child.nodeType === TEXT_NODE) {
        if (child.data !== "" && child.data !== null) children.push(String(child.data));
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue; // 注释等丢弃
      const rendered = renderSvgElement(child, ctx, depth + 1, false);
      if (rendered !== null) children.push(rendered);
    }
    return createEl(ctx, tag, props, children);
  }

  function sanitizeSvgToReact(svg, React, options) {
    const opts = options || {};
    if (typeof svg !== "string" || svg === "") return null;
    if (svg.length > SVG_MAX_INPUT) return null;
    if (!React || typeof React.createElement !== "function") return null;
    const ParserCtor = opts.DOMParser === undefined ? globalThis.DOMParser : opts.DOMParser;
    if (typeof ParserCtor !== "function") return null;

    let doc;
    try {
      doc = new ParserCtor().parseFromString(svg, "text/html");
    } catch (err) {
      return null;
    }
    if (!doc || !doc.body) return null;
    const roots = doc.body.getElementsByTagName("svg");
    if (!roots || roots.length === 0) return null;
    const root = roots[0];
    const ctx = {
      createElement: React.createElement,
      keyPrefix: typeof opts.keyPrefix === "string" && opts.keyPrefix !== "" ? opts.keyPrefix : "svg",
      keyIndex: 0,
      nodeCount: 0,
      maxNodes: typeof opts.maxNodes === "number" && opts.maxNodes > 0 ? opts.maxNodes : SVG_MAX_NODES,
      maxDepth: typeof opts.maxDepth === "number" && opts.maxDepth > 0 ? opts.maxDepth : SVG_MAX_DEPTH,
      idPrefix: normalizeSvgIdPrefix(opts.idPrefix),
      allowStyleAttributes: opts.allowStyleAttributes === true,
    };
    try {
      return renderSvgElement(root, ctx, 0, true);
    } catch (err) {
      return null;
    }
  }

  return {
    parseHtmlToReact: parseHtmlToReact,
    sanitizeSvgToReact: sanitizeSvgToReact,
    sanitizeUrl: sanitizeUrl,
  };
})();

const { parseHtmlToReact, sanitizeSvgToReact, sanitizeUrl } = sanitizeModule;
