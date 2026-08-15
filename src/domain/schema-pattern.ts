// Caller-supplied JSON-Schema `pattern` policy — the single source of truth
// shared by the INPUT boundary (schema-allowlist.ts, pre-fetch) and the value
// validator (infrastructure/llm, post-fetch). Lives in domain so the
// application layer's input boundary can import it without reaching into
// infrastructure (DDD-lite layering).
//
// A pattern is untrusted INPUT twice over: it compiles to a RegExp captatum
// executes, and a catastrophic shape stalls the synchronous event loop (the
// 8 KiB value cap bounds input LENGTH, not match TIME). The checks below are
// the fast pre-filter; the value validator additionally bounds EXECUTION time
// (bounded-pattern.ts) because the heuristic is approximate by design.

export const MAX_PATTERN_LENGTH = 128;

export type PatternCompileResult =
  | { valid: true; value: RegExp }
  | { valid: false; unsupported: boolean; message: string; value: RegExp };

export function toRegExp(pattern: string, path: string): PatternCompileResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, unsupported: true, message: `${path} schema pattern is too long (>${MAX_PATTERN_LENGTH} chars)`, value: /$./ };
  }
  if (isLikelyCatastrophicPattern(pattern)) {
    return { valid: false, unsupported: true, message: `${path} schema pattern may cause catastrophic backtracking`, value: /$./ };
  }
  try {
    return { valid: true, value: new RegExp(pattern) };
  } catch {
    return { valid: false, unsupported: false, message: `${path} schema pattern is invalid`, value: /$./ };
  }
}

/** Reject the classic ReDoS shapes (TRANSFORM-2/REDOS-5): a quantified group that
 *  itself contains a quantifier — (a+)+, (a*)*, (a?)+ — AND a quantified group
 *  with a duplicate alternative — (a|a)+ — where both branches match the same
 *  input so the quantifier backtracks exponentially. Heuristic; the value
 *  validator's time-bounded execution is the bulletproof backstop (executed
 *  2026-08-15: length-differing semantically-overlapping branches such as
 *  (\s|\x20)+ pass this check and still backtrack exponentially in V8 —
 *  9.2 s on a 28-char value — which is why the boundary check alone is not
 *  enough). Returns true (unsafe) on either construct.
 */
function isLikelyCatastrophicPattern(pattern: string): boolean {
  // Per open group: q = contains a quantifier (incl. a quantified child); u = contains
  // overlapping alternation or an unsafe child. Danger propagates to enclosing groups so
  // wrapper patterns like ((a|a))+ and ((a+))+ are caught at the outer quantifier.
  /** Whether a quantifier STARTING at src[idx] is VARIABLE-width (+, *, ?, {n,},
   *  {n,m} with n<m). A FIXED {n} repeats an exact count: every iteration has the
   *  same width, so there is no split ambiguity and no nested-quantifier blowup
   *  (^([A-Z]{2})+$ and ^([0-9]{4}-)+$ are linear — codex P2 r8). A { that does
   *  not form a valid bound is a LITERAL in JS, not a quantifier at all. */
  const variableQuantifierAt = (src: string, idx: number): boolean => {
    const ch = src[idx];
    if (ch === undefined) return false;
    if (ch === "*" || ch === "+" || ch === "?") return true;
    if (ch !== "{") return false;
    const bound = /^\{(\d+)(,)?(\d*)\}/.exec(src.slice(idx));
    return bound !== null && bound[2] === ",";
  };
  const stack: { q: boolean; u: boolean; alts: string[]; cur: string }[] = [];
  let escaped = false;
  // Character-class state: inside [...] every glyph is a LITERAL — a *, +, ?, or
  // { in a class must not mark the enclosing group as quantified (codex P2 r7:
  // ^([a-z+])+$ is linear but was rejected as catastrophic, locking out common
  // allowlist-style patterns). JS semantics: the FIRST ] closes the class.
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (escaped) { escaped = false; if (stack.length > 0) stack[stack.length - 1].cur += ch; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (inClass) {
      if (ch === "]") inClass = false;
      else if (stack.length > 0) stack[stack.length - 1].cur += ch;
      continue;
    }
    if (ch === "[") { inClass = true; if (stack.length > 0) stack[stack.length - 1].cur += ch; continue; }
    if (ch === "(") { stack.push({ q: false, u: false, alts: [], cur: "" }); continue; }
    if (ch === "|") { if (stack.length > 0) { const g = stack[stack.length - 1]; g.alts.push(g.cur); g.cur = ""; } continue; }
    if (ch === ")" && stack.length > 0) {
      const g = stack.pop()!;
      g.alts.push(g.cur);
      const groupQuantified = variableQuantifierAt(pattern, index + 1);
      const danger = g.q || g.u || hasOverlappingAlternation(g.alts);
      if (groupQuantified && danger) return true;
      if (stack.length > 0) {
        const parent = stack[stack.length - 1];
        if (g.q || groupQuantified) parent.q = true;
        if (g.u || hasOverlappingAlternation(g.alts)) parent.u = true;
      }
      continue;
    }
    if (variableQuantifierAt(pattern, index) && stack.length > 0) { stack[stack.length - 1].q = true; continue; }
    if (stack.length > 0) stack[stack.length - 1].cur += ch;
  }
  return false;
}

/** Overlapping alternation in a quantified group: a duplicate alternative
 * ((a|a)+) OR two alternatives where one is a string-prefix of the other
 * ((a|aa)+, (a|ab)+, (\d+|\d)+) — distinct branches that can both match the same
 * input, so the quantifier backtracks catastrophically. Disjoint prefixes like
 * (a|b)+ are safe. Approximate on alternatives containing nested groups/escapes
 * (the raw branch text is compared), which is conservative — fail-closed. */
function hasOverlappingAlternation(alts: string[]): boolean {
  const compact = alts.filter((a) => a.length > 0);
  if (compact.length !== new Set(compact).size) return true; // exact duplicate
  for (let i = 0; i < compact.length; i += 1) {
    for (let j = i + 1; j < compact.length; j += 1) {
      const a = compact[i];
      const b = compact[j];
      if (a.startsWith(b) || b.startsWith(a)) return true; // prefix overlap
    }
  }
  return false;
}
