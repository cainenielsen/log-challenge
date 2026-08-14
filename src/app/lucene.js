// A small Lucene/Datadog-style query parser + evaluator.
//
// Supported syntax:
//   free text terms          error timeout
//   quoted phrases           "insufficient funds"
//   field:value               service:payments-service
//   field:"quoted value"      message:"gateway timeout"
//   wildcards                 error_type:*Error   message:charge*
//   negation                  -level:DEBUG   NOT service:auth-service
//   boolean operators         service:payments-service AND level:ERROR
//                              level:ERROR OR level:WARN
//   grouping                  (level:ERROR OR level:WARN) AND service:payments-service
//   numeric comparisons       duration_ms:>1000   http_status:>=500
//   numeric ranges            duration_ms:[500 TO 1500]
//   string/date comparisons   ts:>=2026-08-07T00:00:00.000Z
//   string/date ranges        ts:[2026-08-07T00:00:00.000Z TO 2026-08-08T00:00:00.000Z]
//                             (non-numeric fields compare lexicographically,
//                              which sorts correctly for ISO8601 timestamps)
//
// Terms with no operator between them are implicitly ANDed together
// (this matches Datadog / Kibana query bar behavior, not classic Lucene's
// default OR).

export class ParseError extends Error {}

export const NUMERIC_FIELDS = new Set([
  "http_status", "duration_ms", "user_id", "account_id", "transaction_id",
]);

// Fields searched by bare (unqualified) terms.
export const DEFAULT_TEXT_FIELDS = [
  "message", "service", "error_type", "stack_trace", "http_path", "metadata",
];

// ---------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------
function isSpace(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}
function isBoundary(c) {
  return c === undefined || isSpace(c) || c === "(" || c === ")";
}

function readQuoted(input, i) {
  // input[i] === '"'
  let j = i + 1;
  let out = "";
  while (j < input.length && input[j] !== '"') {
    if (input[j] === "\\" && j + 1 < input.length) {
      out += input[j + 1];
      j += 2;
      continue;
    }
    out += input[j];
    j++;
  }
  if (input[j] !== '"') {
    throw new ParseError("Unterminated quoted string starting at position " + i);
  }
  return { value: out, next: j + 1 };
}

function readBracketRange(input, i) {
  // input[i] === '['
  let j = input.indexOf("]", i);
  if (j === -1) throw new ParseError("Unterminated range starting at position " + i);
  const raw = input.slice(i + 1, j);
  // Bounds are kept as raw strings — evaluation decides whether to compare
  // numerically or lexicographically (e.g. ISO8601 timestamps sort
  // correctly as strings) based on the field.
  const m = raw.match(/^\s*(\*|\S+)\s+TO\s+(\*|\S+)\s*$/);
  if (!m) throw new ParseError('Malformed range "[' + raw + ']" — expected [X TO Y]');
  return { from: m[1] === "*" ? null : m[1], to: m[2] === "*" ? null : m[2], next: j + 1 };
}

function readBareWord(input, i) {
  let j = i;
  while (j < input.length && !isBoundary(input[j])) j++;
  return { value: input.slice(i, j), next: j };
}

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (isSpace(c)) { i++; continue; }
    if (c === "(") { tokens.push({ type: "LPAREN" }); i++; continue; }
    if (c === ")") { tokens.push({ type: "RPAREN" }); i++; continue; }

    let negate = false;
    let start = i;
    if (c === "-" && i + 1 < input.length && !isSpace(input[i + 1])) {
      negate = true;
      i++;
    }

    if (input[i] === '"') {
      const q = readQuoted(input, i);
      tokens.push(termToken(null, q.value, true, false, null, negate));
      i = q.next;
      continue;
    }

    // Read a raw chunk up to ':' / whitespace / paren.
    const wordStart = i;
    while (i < input.length && !isBoundary(input[i]) && input[i] !== ":") i++;
    const word = input.slice(wordStart, i);

    if (input[i] === ":") {
      const field = word;
      i++; // consume ':'
      if (input[i] === '"') {
        const q = readQuoted(input, i);
        tokens.push(termToken(field, q.value, true, false, null, negate));
        i = q.next;
      } else if (input[i] === "[") {
        const r = readBracketRange(input, i);
        tokens.push(termToken(field, null, false, false, { from: r.from, to: r.to }, negate));
        i = r.next;
      } else if (input[i] === ">" || input[i] === "<") {
        let op = input[i];
        i++;
        if (input[i] === "=") { op += "="; i++; }
        const w = readBareWord(input, i);
        i = w.next;
        if (w.value === "") throw new ParseError('Expected a value after "' + op + '" for field "' + field + '"');
        // Kept as a raw string — numeric vs. lexicographic comparison is
        // decided at evaluation time based on the field.
        let from = null, to = null;
        if (op === ">") from = { value: w.value, exclusive: true };
        else if (op === ">=") from = { value: w.value, exclusive: false };
        else if (op === "<") to = { value: w.value, exclusive: true };
        else if (op === "<=") to = { value: w.value, exclusive: false };
        tokens.push(termToken(field, null, false, false, { fromCmp: from, toCmp: to }, negate));
      } else {
        const w = readBareWord(input, i);
        i = w.next;
        if (w.value === "") throw new ParseError('Expected a value after "' + field + ':"');
        tokens.push(termToken(field, w.value, false, w.value.includes("*"), null, negate));
      }
      continue;
    }

    if (word === "") {
      // Lone '-' or stray character; skip it defensively.
      i = wordStart + 1;
      continue;
    }
    if (!negate && word === "AND") { tokens.push({ type: "AND" }); continue; }
    if (!negate && word === "OR") { tokens.push({ type: "OR" }); continue; }
    if (!negate && word === "NOT") { tokens.push({ type: "NOT" }); continue; }
    tokens.push(termToken(null, word, false, word.includes("*"), null, negate));
  }
  return tokens;
}

function termToken(field, value, phrase, wildcard, range, negate) {
  return { type: "TERM", field, value, phrase, wildcard, range, negate };
}

// ---------------------------------------------------------------------
// Parser (recursive descent):
//   expr   := and (OR and)*
//   and    := unary (AND? unary)*      -- implicit AND
//   unary  := NOT? primary
//   primary:= '(' expr ')' | TERM
// ---------------------------------------------------------------------
export function parse(input) {
  const tokens = tokenize(input || "");
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }

  function parseExpr() {
    let left = parseAnd();
    while (peek() && peek().type === "OR") {
      next();
      const right = parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  function startsUnary(tok) {
    return tok && (tok.type === "TERM" || tok.type === "LPAREN" || tok.type === "NOT");
  }

  function parseAnd() {
    let left = parseUnary();
    while (peek() && (peek().type === "AND" || startsUnary(peek()))) {
      if (peek().type === "AND") next();
      const right = parseUnary();
      left = { type: "and", left, right };
    }
    return left;
  }

  function parseUnary() {
    if (peek() && peek().type === "NOT") {
      next();
      return { type: "not", expr: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new ParseError("Unexpected end of query");
    if (tok.type === "LPAREN") {
      next();
      const e = parseExpr();
      if (!peek() || peek().type !== "RPAREN") throw new ParseError("Missing closing parenthesis");
      next();
      return e;
    }
    if (tok.type === "TERM") {
      next();
      const node = {
        type: "term",
        field: tok.field,
        value: tok.value,
        phrase: tok.phrase,
        wildcard: tok.wildcard,
        range: tok.range,
      };
      return tok.negate ? { type: "not", expr: node } : node;
    }
    throw new ParseError('Unexpected token "' + tok.type + '"');
  }

  if (tokens.length === 0) return null; // empty query = match all
  const ast = parseExpr();
  if (pos !== tokens.length) throw new ParseError("Unexpected trailing input near token " + pos);
  return ast;
}

// ---------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------
function wildcardToRegex(value) {
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + escaped + "$", "i");
}

function fieldStr(row, field) {
  const v = row[field];
  if (v === undefined || v === null) return "";
  return String(v);
}

function matchTermAgainstField(row, field, node) {
  const raw = row[field];
  if (node.range) {
    if (raw === undefined || raw === null || raw === "") return false;
    const r = node.range;
    // Numeric fields compare numerically; everything else (notably `ts`,
    // an ISO8601 string) compares lexicographically — which sorts
    // correctly for zero-padded ISO timestamps.
    const numeric = NUMERIC_FIELDS.has(field);
    const val = numeric ? Number(raw) : String(raw);
    if (numeric && Number.isNaN(val)) return false;
    const bound = (b) => (numeric ? Number(b) : b);
    if ("from" in r) {
      if (r.from !== null && val < bound(r.from)) return false;
      if (r.to !== null && val > bound(r.to)) return false;
      return true;
    }
    if (r.fromCmp) {
      const b = bound(r.fromCmp.value);
      if (r.fromCmp.exclusive ? !(val > b) : !(val >= b)) return false;
    }
    if (r.toCmp) {
      const b = bound(r.toCmp.value);
      if (r.toCmp.exclusive ? !(val < b) : !(val <= b)) return false;
    }
    return true;
  }
  const strVal = fieldStr(row, field);
  if (NUMERIC_FIELDS.has(field) && !node.wildcard) {
    if (raw === undefined || raw === null || raw === "") return false;
    return String(raw) === node.value;
  }
  if (node.wildcard) return wildcardToRegex(node.value).test(strVal);
  if (node.phrase) return strVal.toLowerCase().includes(node.value.toLowerCase());
  return strVal.toLowerCase() === node.value.toLowerCase() ||
         strVal.toLowerCase().includes(node.value.toLowerCase());
}

function matchFreeTerm(row, node) {
  for (const f of DEFAULT_TEXT_FIELDS) {
    const strVal = fieldStr(row, f).toLowerCase();
    if (node.wildcard) {
      if (wildcardToRegex(node.value).test(fieldStr(row, f))) return true;
      continue;
    }
    if (strVal.includes(node.value.toLowerCase())) return true;
  }
  return false;
}

export function evaluate(ast, row) {
  if (ast === null) return true;
  switch (ast.type) {
    case "and": return evaluate(ast.left, row) && evaluate(ast.right, row);
    case "or": return evaluate(ast.left, row) || evaluate(ast.right, row);
    case "not": return !evaluate(ast.expr, row);
    case "term":
      if (ast.field) return matchTermAgainstField(row, ast.field, ast);
      return matchFreeTerm(row, ast);
    default:
      throw new ParseError("Unknown AST node type: " + ast.type);
  }
}
