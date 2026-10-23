import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import {
  FEED_ACTIVITIES,
  FEED_AREAS,
  FEED_IMPACTS,
  DEFAULT_FEED,
  feedPath,
  type FeedFilter,
} from "../shared/feeds";
import { translate, type Language } from "./locale";

const IMPACTS: Record<FeedFilter["impact"], string> = {
  any: "Any impact",
  significant: "Significant or higher",
  severe: "Severe or higher",
};

/** Links to the snapshot's static Atom and GeoJSON feed for a chosen area, hazard and impact. */
export default function PublicFeeds({ language }: { language: Language }) {
  const tr = (text: string) => translate(language, text);
  const [filter, setFilter] = useState<FeedFilter>(DEFAULT_FEED);
  const link = (format: "atom" | "geojson") =>
    import.meta.env.BASE_URL + "data/" + feedPath(filter, format);
  return (
    <div className="context-section">
      <h2>{tr("Feeds")}</h2>
      <p>
        {tr(
          "Follow an area in a feed reader or a map tool. Each feed holds up to 100 records, updated with the snapshot. Records from sources that don't permit redistribution are left out.",
        )}
      </p>
      <label htmlFor="feed-area">{tr("Area")}</label>
      <select
        id="feed-area"
        value={filter.bbox.join(",")}
        onChange={(e) =>
          setFilter({
            ...filter,
            bbox: FEED_AREAS.find((a) => a.bbox.join(",") === e.target.value)!.bbox,
          })
        }
      >
        {FEED_AREAS.map((a) => (
          <option key={a.name} value={a.bbox.join(",")}>
            {tr(a.name)}
          </option>
        ))}
      </select>
      <label htmlFor="feed-activity">{tr("Hazard")}</label>
      <select
        id="feed-activity"
        value={filter.activity}
        onChange={(e) =>
          setFilter({ ...filter, activity: e.target.value as FeedFilter["activity"] })
        }
      >
        {FEED_ACTIVITIES.map((a) => (
          <option key={a} value={a}>
            {tr(a === "all" ? "All hazards" : a)}
          </option>
        ))}
      </select>
      <label htmlFor="feed-impact">{tr("Impact")}</label>
      <select
        id="feed-impact"
        value={filter.impact}
        onChange={(e) =>
          setFilter({ ...filter, impact: e.target.value as FeedFilter["impact"] })
        }
      >
        {(Object.keys(FEED_IMPACTS) as FeedFilter["impact"][]).map((i) => (
          <option key={i} value={i}>
            {tr(IMPACTS[i])}
          </option>
        ))}
      </select>
      <p>
        <a href={link("atom")} target="_blank" rel="noreferrer">
          Atom <ArrowUpRight size={14} />
        </a>{" "}
        ·{" "}
        <a href={link("geojson")} target="_blank" rel="noreferrer">
          GeoJSON <ArrowUpRight size={14} />
        </a>
      </p>
    </div>
  );
}
