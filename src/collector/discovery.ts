import type { SourceRecord } from "../shared/contracts.js";
import { fetchSource, checkedURL, type FetchOptions } from "./fetch.js";
import { parseFeed } from "./parsers.js";
/** Controlled verification only: discovery never changes permissions or enables a source. */
export async function inspectCandidate(
  candidate: SourceRecord,
  options: FetchOptions = {},
) {
  const source = checkedURL(candidate.url);
  const docs = new URL(candidate.docs);
  if (
    docs.protocol !== "https:" ||
    !candidate.owner.trim() ||
    !candidate.rights.basis.trim()
  )
    throw Error("missing_identity_or_rights_evidence");
  if (candidate.family !== "rss")
    throw Error("discovery_requires_supported_feed_family");
  const r = await fetchSource(source.href, {}, options);
  const records = parseFeed(candidate, r.text);
  return {
    candidate: {
      ...candidate,
      status: "disabled" as const,
      verified_at: new Date().toISOString(),
      rights: {
        ...candidate.rights,
        ai: false,
        display: false,
        redistribute: false,
      },
    },
    observed: {
      valid_feed: true,
      records: records.length,
      content_type: r.contentType,
      sample_titles: records.slice(0, 3).map((v) => v.title),
    },
    required_review: [
      "Confirm official domain/owner identity using supplied documentation",
      "Review storage, AI, display and redistribution rights separately",
      "Check original language and actual reported-place geography",
      "Choose retention, corrections, rate and budget policy",
      "Enable only after reviewed registry change; discovery never auto-activates",
    ],
  };
}
