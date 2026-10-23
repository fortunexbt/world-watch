import { translate, type Language } from "./locale";

export default function PublicBanner({
  language,
  onSources,
}: {
  language: Language;
  onSources: () => void;
}) {
  const tr = (text: string) => translate(language, text);
  return (
    <div className="public-banner" role="note">
      <span>
        {tr(
          "Public demo. Live public sources. Some layers and analysis disabled.",
        )}
      </span>
      <button onClick={onSources}>{tr("Sources and credits")}</button>
    </div>
  );
}
