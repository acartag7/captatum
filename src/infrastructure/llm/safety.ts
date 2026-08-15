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

/** Bounded URL-literal scan for embedded signed/internal URLs in content. Two alternations:
 *  (1) an OPTIONAL userinfo (user:pass@) then a bracketed IPv6 host, optional port, and a
 *  path/query/fragment that MUST start with '/', '?', or '#' — so prose immediately after the
 *  literal ('.', ',', '!', a markdown ']') is never absorbed, while a real path/query/fragment
 *  (incl. a credential fragment) is captured. The userinfo is '@'-anchored so it can't absorb
 *  non-userinfo prose. (2) a normal URL that excludes ']' (so a prose bracket around it stops
 *  cleanly) but ALLOWS '[' — a literal '[' in a path before a credential query (e.g.
 *  https://files.example/a[draft?access_token=…) must not truncate the match. The IPv6 alternation
 *  owns '[' at the host position, so allowing it in a normal path is safe. Bounded vs ReDoS. */
const SIGNED_URL_IN_CONTENT = /https?:\/\/(?:[^\s"'<>)\]\[@\/]+(?::[^\s"'<>)\]\[@\/]*)?@)?\[[^\]\s]{1,79}\](?::\d{1,5})?(?:[\/?#][^\s"'<>]*)?|https?:\/\/[^\s"'<>]{1,512}/gi;

/** Relative credential references — the absolute-only scanner's blind spot
 *  (executed 2026-08-15: `/cb#access_token=…` egressed where the absolute
 *  spelling flagged). Two linear scans over the 500 KB head:
 *  (1) KEY-ANCHORED — any ?/#/& followed by credential-key=value, wherever the
 *      reference starts, of any path length (a path cap is a bypass waiting for
 *      a longer URL). Values match a prefix; = inside a value cannot hide the
 *      next &-separated pair; entity separators normalized first.
 *  (2) NETWORK-PATH — `//authority` carries a host, so host checks apply. The
 *      boundary is any legitimate left-adjacent context (whitespace, quotes,
 *      backticks, brackets/parens/braces/angles, pipes, emphasis, blockquote,
 *      = ; , : ! ?, Unicode quotes/dashes — swept as a class); the AUTHORITY is
 *      captured from a hostname-legality whitelist (alnum . - : @ [ ] %), so any
 *      other character terminates it — typographic tails and following prose can
 *      never reach the classifier (Node would punycode them into non-private).
 *  The #44 carve-out holds: only the credential key set flags, and a clean
 *  public //host stays unflagged. */
const RELATIVE_CREDENTIAL_KEY = /[?#&]([^?&#\s"'<>=]{1,64})=([^\s"'<>&#]{1,512})/g;
const RELATIVE_NETWORK_PATH = /(?:^|[\s"`'(<\[{=;,:!?|>*_~\u201C\u201D\u2018\u2019\u00AB\u00BB\u2013\u2014\u2015])\/\/([A-Za-z0-9.\-:@\[\]%]{1,2048})/g;

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
  // A public page that merely LINKS a cloud-presigned / OAuth / signed URL or an internal host
  // must not egress to a hosted LLM. Bounded scan (ReDoS/DoS hygiene). Only real credential keys
  // are matched (CONTENT_CREDENTIAL_QUERY_KEYS) — not the generic ad/CDN keys (`token`/`key`/
  // `auth`/`expires`) that caused the #44 news-page false-positive regression. The credential
  // patterns above already scanned the FULL content.
  const head = content.length > MAX_CONTENT_SCAN ? content.slice(0, MAX_CONTENT_SCAN) : content;
  // URL-ignored ASCII whitespace (tab/LF/CR, NOT space): Node's parser strips
  // these, so a line-wrapped URL (?access_\ntoken=…) exposes the full key to
  // the browser while a whitespace-delimited scan sees a truncated one. The
  // absolute and key scans run stripped; the network-path scan keeps the RAW
  // head — stripping newlines there would fuse adjacent references.
  const unwrapped = head.replace(/[\t\n\r]/g, "");
  for (const match of unwrapped.matchAll(SIGNED_URL_IN_CONTENT)) {
    // allowLoopback: a public page that LINKS http://localhost:PORT (a docs/setup example — resolves
    // to the READER's machine, not a leaked endpoint) is not flagged. RFC1918 / 169.254.169.254 /
    // .corp / .internal are. A credential ANYWHERE on the URL — query key, fragment key (HTML-escaped
    // &amp; normalized), userinfo (user:pass@), or an OAuth code/refresh_token on a loopback redirect
    // — is checked BEFORE the exemption. Trim trailing prose punctuation a normal URL picked up
    // (no ']' — the IPv6 close + the path's [/?#] boundary keep brackets out of the match).
    // Prose-trim trailing punctuation, then strip trailing ']'s that are UNBALANCED (a prose
    // bracket like [http://host]) — a balanced ']' (in a path like a[draft]) stays so the URL
    // parses and the query/fragment after it is scanned. Bounded string slices, no parse loop.
    // Prose-trim trailing punctuation, then strip trailing ']' / ')' that are UNBALANCED (a prose
    // bracket/paren around the URL has no matching opener in the match; a balanced path delimiter
    // like a[draft] or cb(v2) stays so the URL parses + a query/fragment after it is scanned).
    let url = stripTrailingProseClosers(match[0].replace(/[.,;:!?]+$/, ""));
    const reason = signedUrlReason(url, CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? fragmentCredentialReason(url, CONTENT_CREDENTIAL_QUERY_KEYS)
      ?? userinfoCredentialReason(url)
      ?? loopbackOAuthCredentialReason(url)
      ?? internalHostReason(url, true);
    if (reason) return { sensitive: true, reason: `content_embedded_${reason}` };
  }
  // (1) credential KEY anywhere a relative reference can carry one — anchored
  // on the ?/#/& separator, so the path before it (of ANY length) is irrelevant.
  const normalizedHead = unwrapped.replace(/&(amp|#38|#x26);/gi, "&");
  for (const match of normalizedHead.matchAll(RELATIVE_CREDENTIAL_KEY)) {
    const key = match[1]?.toLowerCase() ?? "";
    if (CONTENT_CREDENTIAL_QUERY_KEYS.has(key)) {
      return { sensitive: true, reason: "content_embedded_signed_or_tokenized_url" };
    }
  }
  // (2) network-path references: a host is present, so host-class checks apply.
  // FAIL CLOSED on an unparseable authority (codex P1 r5): an invalid port or
  // malformed host makes every URL-based helper throw-and-swallow, and a
  // reference like //user:pass@10.0.0.5:99999/file — an exposed password aimed
  // at a private host — must not egress because the parser gave up.
  const headTruncated = content.length > MAX_CONTENT_SCAN;
  for (const match of head.matchAll(RELATIVE_NETWORK_PATH)) {
    // NO trailing-punctuation trim: the hostname whitelist already excludes
    // non-hostname characters, `.` is stripped by internalHostReason itself, and
    // trimming `:` would rescue a malformed empty/double-colon port (codex P2).
    const authority = match[1] ?? "";
    const url = `https://${authority}`;
    try {
      // RFC 6874 zone identifiers (%25eth0) throw in a raw parse but the helpers
      // strip them — validate the same normalized form the classifiers see.
      new URL(url.replace(/\[([^\]]*?)%[^\]]*\]/, "[$1]"));
    } catch {
      // An authority sliced by the 500 KB head boundary is NOT malformed: the
      // complete reference (e.g. //[2606:4700::1111]/docs continuing past the
      // cap) may be a clean public host, and rejecting the artificial prefix
      // would degrade large public pages on byte alignment alone (codex P2) —
      // same accepted-cap residual as a presigned URL past the cap. Only a
      // malformed authority fully inside the head fails closed.
      // EXACTLY at the cap (a match ending at head.length - 1 keeps its
      // terminator inside the head — complete, fails closed); only a match whose
      // last char IS the head's last char is genuinely sliced.
      const atHeadEdge = headTruncated
        && match.index !== undefined
        && match.index + match[0].length === head.length;
      if (atHeadEdge) {
        // A COMPLETE user:pass@ before the slice point is conclusive — never
        // defer an exposed password away because the host was sliced (codex P1).
        const atSign = authority.lastIndexOf("@");
        if (atSign > 0 && authority.slice(0, atSign).includes(":")) {
          return { sensitive: true, reason: "content_embedded_userinfo_credential" };
        }
        continue;
      }
      return { sensitive: true, reason: "content_embedded_malformed_network_path" };
    }
    const reason = userinfoCredentialReason(url)
      ?? loopbackOAuthCredentialReason(url)
      ?? internalHostReason(url, true);
    if (reason) return { sensitive: true, reason: `content_embedded_${reason}` };
  }
  return { sensitive: false };
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
