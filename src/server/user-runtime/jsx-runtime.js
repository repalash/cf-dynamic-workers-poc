// Minimal JSX-to-HTML-string runtime for server-side TSX in dynamic workers.
// Produces plain HTML strings that Hono's c.html() can serve directly.
// Supports: intrinsic elements, function components, fragments, children,
// attributes, void elements, arrays, and HTML escaping.
//
// Injected as "hono/jsx/jsx-runtime" and "hono/jsx/jsx-dev-runtime" virtual
// modules by spawnDynamic.

var VOID = new Set([
  "area","base","br","col","embed","hr","img","input",
  "link","meta","param","source","track","wbr"
]);

var ESC_RE = /[&<>"']/g;
var ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };

function esc(s) {
  return String(s).replace(ESC_RE, function(c) { return ESC_MAP[c]; });
}

function escAttr(s) {
  return String(s).replace(ESC_RE, function(c) { return ESC_MAP[c]; });
}

function renderChildren(children) {
  if (children == null || children === false || children === true) return "";
  if (typeof children === "number") return String(children);
  // String objects from nested jsx() calls — already rendered HTML, don't escape
  if (children instanceof String || (typeof children === "object" && children.isEscaped)) {
    return children.toString();
  }
  if (typeof children === "string") return esc(children);
  if (Array.isArray(children)) return children.map(renderChildren).join("");
  if (typeof children === "object" && children.__html != null) return children.__html;
  return esc(String(children));
}

function jsx(tag, props) {
  if (tag === Fragment) {
    return { __html: renderChildren(props ? props.children : null) };
  }

  if (typeof tag === "function") {
    var result = tag(props || {});
    if (result == null) return { __html: "" };
    if (typeof result === "object" && result.__html != null) return result;
    if (typeof result === "string") return { __html: esc(result) };
    return { __html: String(result) };
  }

  // Intrinsic HTML element
  var html = "<" + tag;
  if (props) {
    for (var key in props) {
      if (key === "children" || key === "key" || key === "ref") continue;
      var val = props[key];
      if (val == null || val === false) continue;
      if (val === true) {
        html += " " + key;
      } else if (key === "dangerouslySetInnerHTML") {
        // handled below with children
      } else if (key === "style" && typeof val === "object") {
        var css = "";
        for (var sk in val) {
          var prop = sk.replace(/[A-Z]/g, function(c) { return "-" + c.toLowerCase(); });
          css += prop + ":" + val[sk] + ";";
        }
        html += ' style="' + escAttr(css) + '"';
      } else if (key === "className") {
        html += ' class="' + escAttr(val) + '"';
      } else {
        html += " " + key + '="' + escAttr(val) + '"';
      }
    }
  }

  if (VOID.has(tag)) {
    return { __html: html + "/>" };
  }

  html += ">";

  if (props && props.dangerouslySetInnerHTML) {
    html += props.dangerouslySetInnerHTML.__html || "";
  } else if (props && props.children != null) {
    html += renderChildren(props.children);
  }

  html += "</" + tag + ">";
  return { __html: html };
}

function Fragment(props) {
  return { __html: renderChildren(props ? props.children : null) };
}

// c.html() expects a string, so we override toString
function jsxWrapper(tag, props) {
  var result = jsx(tag, props);
  // Return a string-like object that c.html() can use
  var s = new String(result.__html);
  s.isEscaped = true; // Hono's HtmlEscapedString marker — prevents double-escaping
  return s;
}

export { jsxWrapper as jsx, jsxWrapper as jsxs, Fragment };
