/**
 * Detect ACTUAL leaked credential VALUES in fetched content — not topic words.
 *
 * The earlier version matched the words "secret"/"password"/"cookie"/"api_key",
 * which false-positived on any page that merely DISCUSSES security (e.g. a
 * security product's marketing page, or any page with a cookie notice). That
 * silently degraded the default summary to raw for ordinary public pages.
 *
 * Value-based detection is strictly better: it catches real leaked secrets
 * (token prefixes, PEM headers, signed URLs) without flagging discussion text.
 * Security-relevant change — reflect in docs/threat-model.md.
 */
import {
  CONTENT_CREDENTIAL_QUERY_KEYS,
  fragmentCredentialReason,
  internalHostReason,
  loopbackOAuthCredentialReason,
  SIGNED_QUERY_KEYS,
  signedUrlReason,
  userinfoCredentialReason,
} from "./sensitive-urls.ts";
import { scanRelativeReferences } from "./relative-reference-scan.ts";

const SENSITIVE_CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/i,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Cloud env-var / config-file secret assignments (the KEY NAME + a value shape,
  // NOT a generic "secret=" word match — that false-positived on pages that merely
  // discuss security). The `AKIA` regex above catches the AWS access-key id; these
  // catch its paired secret, the STS session token, and an Azure service-principal
  // secret when leaked as a `NAME=value` blob in fetched content.
  /\bAWS_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+=]{40}\b/,
  /\bAWS_SESSION_TOKEN\s*=\s*[A-Za-z0-9/+=_-]{50,}\b/,
  /\bAZURE_CLIENT_SECRET\s*=\s*[A-Za-z0-9._~+/=-]{30,}\b/,
];

const SENSITIVE_HEADER_PATTERNS = [
  // HTTP headers are case-insensitive: match any case so a lower/all-caps dump
  // (`authorization: bearer …`, `AUTHORIZATION: BASIC …`) is still caught.
  /authorization:\s*(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /set-cookie:\s*[^=\s;]{1,64}=[^;\s<]{16,}/i,
];

const SIGNED_URL_IN_CONTENT = /https?:\/\/(?:[^\s"'<>)\]\[@\/]+(?::[^\s"'<>)\]\[@\/]*)?@)?\[[^\]\s]{1,79}\](?::\d{1,5})?(?:[\/?#][^\s"'<>]*)?|https?:\/\/[^\s"'<>]{1,512}/gi;

/** Relative-credential scans: (1) KEY-anchored — any ?/#/& + credential-key=value,
 *  any path length, values match a prefix, entity separators normalized;
 *  (2) NETWORK-PATH — //authority (WHATWG separator runs of 2+ mixed /\, or a
 *  special scheme + 0/1 separators cross-scheme) carries a host; boundary = any
 *  legitimate left-adjacent context; terminators stop the capture so references
 *  never fuse; interpretation is 100% Node's parser (IDN/dots/zones/shorthand).
 *  #44 carve-out: generic keys and clean public //hosts never flag. */
const RELATIVE_CREDENTIAL_KEY = /[?#&]([^?&#\s"'<>=]{1,64})=[\t ]*([^\s"'<>&#]{1,512})/g;
const RELATIVE_NETWORK_PATH = /(?:^|[\s"`'(<\[{=;,:!?|>*_~“”‘’«»–—―])[\/\\]{2,}([^\s"'<>`\/?#\\\–\—\―\“\”\‘\’\«\»]{1,2048})/g;
// WHATWG special relative-or-authority: scheme + 0/1 separators = an AUTHORITY
// cross-scheme (http:\\pass@10.0.0.5/x vs an https page), a PATH same-scheme.
const SCHEME_PREFIXED_AUTHORITY = /(?:https?|wss?|ftp|file):[\/\\]?([^\s"'<>`\/?#\\\u2013\u2014\u2015\u201C\u201D\u2018\u2019\u00AB\u00BB]{1,2048})/gi;

const MAX_CONTENT_SCAN = 500_000;

export interface SensitivitySignal {
  sensitive: boolean;
  reason?: string;
}

/** Strip trailing ']' and ')' that are unbalanced — a prose bracket/paren around the URL
 *  ([http://host], (http://host)) has no matching opener in the match; a balanced path delimiter
 *  (a[draft], cb(v2)) stays so the URL parses. O(n): excess computed once, then a backward scan. */
function stripTrailingProseClosers(url: string): string {
  const excessSq = Math.max(0, (url.match(/\]/g) ?? []).length - (url.match(/\[/g) ?? []).length);
  const excessPa = Math.max(0, (url.match(/\)/g) ?? []).length - (url.match(/\(/g) ?? []).length);
  let end = url.length, skipSq = excessSq, skipPa = excessPa;
  while (end > 0) {
    const c = url[end - 1];
    if (c === "]" && skipSq > 0) { skipSq--; end--; continue; }
    if (c === ")" && skipPa > 0) { skipPa--; end--; continue; }
    break;
  }
  return url.slice(0, end);
}

export function detectSensitiveTransformInput(input: {
  content: string;
  sourceUrl?: string;
}): SensitivitySignal {
  const urlReason = input.sourceUrl
    ? signedUrlReason(input.sourceUrl) ?? internalHostReason(input.sourceUrl)
    : undefined;
  if (urlReason) return { sensitive: true, reason: urlReason };

  // A credential VALUE in the source url (e.g. a JWT in the path) is flagged too.
  // The path-token heuristic is gone (#47), so without this a JWT present only in
  // the source url — not echoed in the body — would slip past (codex P2 on #47).
  if (input.sourceUrl) {
    for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
      if (pattern.test(input.sourceUrl)) return { sensitive: true, reason: "source_credential_signal" };
    }
  }

  const content = input.content ?? "";
  for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) return { sensitive: true, reason: "content_credential_signal" };
  }
  for (const pattern of SENSITIVE_HEADER_PATTERNS) {
    if (pattern.test(content)) return { sensitive: true, reason: "content_header_dump" };
  }
  const head = content.length > MAX_CONTENT_SCAN ? content.slice(0, MAX_CONTENT_SCAN) : content;
  // URL-ignored tab/LF/CR (not space) is stripped before all three scans — a
  // line-wrapped reference is one reference to the parser; terminators prevent fusion.
  const unwrapped = head.replace(/[\t\n\r]/g, "");
  for (const match of unwrapped.matchAll(SIGNED_URL_IN_CONTENT)) {
    // allowLoopback: docs-example loopback links exempt; credentials anywhere on the URL checked first; prose trimmed.
    let url = stripTrailingProseClosers(match[0].replace(/[.,;:!?]+$/, ""));
    const reason = signedUrlReason(url, CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? fragmentCredentialReason(url, CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? userinfoCredentialReason(url)
      ?? loopbackOAuthCredentialReason(url)
      ?? internalHostReason(url, true);
    if (reason) return { sensitive: true, reason: `content_embedded_${reason}` };
  }
  const rel = scanRelativeReferences(unwrapped, content.length > MAX_CONTENT_SCAN, input.sourceUrl ?? "");
  if (rel) return { sensitive: true, reason: rel.reason };

  return { sensitive: false };
}

/** Evidence CONCLUSIVE in a SLICED host (a parse of the prefix is a phantom —
 *  never classify phantoms): terminated hosts (closed ] or : port separator)
 *  classify via helpers; unclosed [fd/[fc (ULA) and [fe8-feb (link-local)
 *  brackets are hex-inescapable; everything else defers. Loopback keeps the #127
 *  content exemption. */
function conclusiveEvidence(raw: string): string | undefined {
  if (raw.startsWith("[")) {
    if (raw.includes("]")) {
      const stripped = raw.replace(/\[([^\]]*?)%[^\]]*\]/, "[$1]");
      return internalHostReason(`https://${stripped}`, true) ?? undefined;
    }
    if (/^\[f[cd]/i.test(raw) || /^\[fe[89ab]/i.test(raw)) return "internal_host";
    return undefined;
  }
  const colon = raw.indexOf(":");
  if (colon === -1) return undefined; // unterminated — the host text may extend
  const host = raw.slice(0, colon);
  return internalHostReason(`https://${host}`, true) ?? undefined;
}

/** Redact signed/tokenized param values from a URL before display (INFOLEAK-1). HOST-AGNOSTIC
 *  (substring + URLSearchParams; never `new URL`, which throws on a malformed host + fails open).
 *  Normalizes HTML-escaped separators (&amp;/&#38;/&#x26;) + redacts BOTH the query AND the
 *  fragment (e.g. #access_token=…), so coverage matches signedUrlReason's detection. */
export function redactSignedQueryParams(url: string): string {
  const normalized = url.replace(/&(amp|#38|#x26);/gi, "&");
  const q = normalized.indexOf("?");
  const hash0 = normalized.indexOf("#", q < 0 ? 0 : q);
  let out = normalized;
  if (q >= 0) out = redactParamRange(out, q, hash0 > q ? hash0 : normalized.length);
  if (hash0 >= 0) { // re-find '#' (redacting the query may have shifted it) + redact the fragment
    const hash = out.indexOf("#");
    if (hash >= 0) {
      // Hash-router form: #/cb?access_token=… — parse from the fragment's first '?' (mirrors
      // fragmentCredentialReason). Simple form: #access_token=… — parse the whole fragment.
      const fragQ = out.indexOf("?", hash);
      out = redactParamRange(out, fragQ >= 0 ? fragQ : hash, out.length);
    }
  }
  return out;
}

/** Redact signed-param values in the substring (sepIdx, end) of `s` (the query or fragment body). */
function redactParamRange(s: string, sepIdx: number, end: number): string {
  if (sepIdx < 0 || sepIdx + 1 >= end) return s;
  const params = new URLSearchParams(s.slice(sepIdx + 1, end));
  let redacted = false;
  for (const key of params.keys()) {
    if (SIGNED_QUERY_KEYS.has(key.toLowerCase())) { params.set(key, "[REDACTED]"); redacted = true; }
  }
  return redacted ? s.slice(0, sepIdx + 1) + params.toString() + s.slice(end) : s;
}
