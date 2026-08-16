// Relative-reference scanning (key-anchored + network-path + scheme-prefixed),
// extracted from safety.ts for the 250-line cap. Runs on the whitespace-
// normalized head; slice discipline and Node-native interpretation as documented
// in docs/threat-model.md §Sensitive-content detection.
import {
  CONTENT_CREDENTIAL_QUERY_KEYS,
  internalHostReason,
  loopbackOAuthCredentialReason,
  userinfoCredentialReason,
} from "./sensitive-urls.ts";


const SCHEME_PREFIXED_AUTHORITY = /(?:https?|wss?|ftp|file):[\/\\]?([^\s"'<>`\/?#\\\u2013\u2014\u2015\u201C\u201D\u2018\u2019\u00AB\u00BB]{1,2048})/gi;
const RELATIVE_CREDENTIAL_KEY = /[?#&]([^?&#\s"'<>=]{1,64})=[\t ]*([^\s"'<>&#]{1,512})/g;
const RELATIVE_NETWORK_PATH = /(?:^|[\s"`'(<\[{=;,:!?|>*_~“”‘’«»–—―])[\/\\]{2,}([^\s"'<>`\/?#\\\–\—\―\“\”\‘\’\«\»]{1,2048})/g;

/** Strip unbalanced trailing prose closers (] and )) — the absolute scanner's
 *  identical helper, kept local to avoid a circular import. */
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

export function scanRelativeReferences(
  unwrapped: string,
  headTruncated: boolean,
  sourceUrl: string,
): { reason: string } | undefined {
  // (1) credential KEY anywhere a relative reference can carry one — anchored
  // on the ?/#/& separator, so the path before it (of ANY length) is irrelevant.
  const normalizedHead = unwrapped.replace(/&(amp|#38|#x26);/gi, "&");
  for (const match of normalizedHead.matchAll(RELATIVE_CREDENTIAL_KEY)) {
    const key = match[1]?.toLowerCase() ?? "";
    if (CONTENT_CREDENTIAL_QUERY_KEYS.has(key)) {
      return { reason: "content_embedded_signed_or_tokenized_url" };
    }
  }
  const sourceScheme = sourceUrl?.slice(0, sourceUrl.indexOf(":")) ?? "";
  for (const match of unwrapped.matchAll(SCHEME_PREFIXED_AUTHORITY)) {
    if (match[0].slice(0, match[0].indexOf(":")).toLowerCase() === sourceScheme) continue;
    const trimmed = stripTrailingProseClosers((match[1] ?? "").replace(/[.,;!?]+$/, ""));
    const url = `https://${trimmed}`.replace(/\[([^\]]*?)%[^\]]*\]/, "[$1]");
    try {
      new URL(url);
    } catch {
      return { reason: "content_embedded_malformed_network_path" };
    }
    const reason = userinfoCredentialReason(url)
      ?? loopbackOAuthCredentialReason(url)
      ?? internalHostReason(url, true);
    if (reason) return { reason: `content_embedded_${reason}` };
  }
  for (const match of unwrapped.matchAll(RELATIVE_NETWORK_PATH)) {
    // Hostname-whitelist capture; NO punctuation trim (trimming ':' would
    // rescue a malformed empty/double-colon port).
    // CAPTURE is terminator-based (the URL grammar's own: whitespace, quotes,
    // angle brackets, backtick, /, ?, #); INTERPRETATION is 100% Node's parser —
    // it normalizes IDN (m\u00fcnchen.internal \u2192 xn--\u2026.internal) and Unicode
    // dot variants natively. A bounded prose trim (NO colon — trimming ':'
    // would rescue a malformed empty/double-colon port) removes sentence
    // punctuation picked up from running text.
    // Node strips URL-ignored tab/LF/CR from hostnames too (\service.\tinternal
    //  -> service.internal) — allow them in the capture, strip before use. The
    // / \ ? # terminators still stop the capture, so adjacent references never fuse.
    const captured = (match[1] ?? "").replace(/[\t\n\r]/g, "");
    const trimmed = stripTrailingProseClosers(captured.replace(/[.,;!?]+$/, ""));
    const atEdge = headTruncated
      && match.index !== undefined
      && match.index + match[0].length === unwrapped.length;
    if (atEdge) {
      // The reference is SLICED by the 500 KB boundary: its completion is
      // unknown and a URL parse of the prefix is a PHANTOM — never classify a
      // phantom. Defer, except evidence CONCLUSIVE inside the slice: a complete
      // user:pass@, or a host TERMINATED by a : port separator / closed ].
      const atSign = captured.lastIndexOf("@");
      if (atSign > 0 && captured.slice(0, atSign).includes(":")) {
        return { reason: "content_embedded_userinfo_credential" };
      }
      const reason = conclusiveEvidence(captured.slice(atSign + 1));
      if (reason) return { reason: `content_embedded_${reason}` };
      continue;
    }
    try {
      // RFC 6874 zones (%25eth0) throw raw but helpers strip them — validate
      // the same normalized form the classifiers see.
      new URL(`https://${trimmed}`.replace(/\[([^\]]*?)%[^\]]*\]/, "[$1]"));
    } catch {
      return { reason: "content_embedded_malformed_network_path" };
    }
    const url = `https://${trimmed}`.replace(/\[([^\]]*?)%[^\]]*\]/, "[$1]");
    const reason = userinfoCredentialReason(url)
      ?? loopbackOAuthCredentialReason(url)
      ?? internalHostReason(url, true);
    if (reason) return { reason: `content_embedded_${reason}` };
  }
  return undefined;
}

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
