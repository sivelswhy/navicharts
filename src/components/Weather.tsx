import { ageOf, decodeMetar, useIvaoAtis, useMetars, type IvaoAtis, type Metar } from '../lib/metar.ts';

export const CATEGORY_LABEL: Record<string, string> = {
  VFR: 'VFR',
  MVFR: 'VFR marginal',
  IFR: 'IFR',
  LIFR: 'IFR bas',
};

/** Météo d'un aérodrome : METAR brut et décodé, puis ATIS IVAO si un contrôleur le diffuse */
export function AirportWeather({ icao, role, metar, atis }: { icao: string; role: string; metar: Metar | undefined; atis: IvaoAtis | null }) {
  return (
    <article className="weather">
      <header className="weather-head">
        <span className="weather-role">{role}</span>
        <strong>{icao}</strong>
        {metar?.category && (
          <span className={`flight-category ${metar.category.toLowerCase()}`} title="Catégorie de vol (NOAA)">
            {CATEGORY_LABEL[metar.category] ?? metar.category}
          </span>
        )}
        {metar && <span className="weather-age">{ageOf(metar.observed)}</span>}
      </header>
      {metar ? (
        <>
          <p className="metar-raw">{metar.raw}</p>
          <dl className="metar-decoded">
            {decodeMetar(metar.raw).map((line) => (
              <div key={line.label}>
                <dt>{line.label}</dt>
                <dd>{line.value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="placeholder">Pas de METAR disponible pour cet aérodrome.</p>
      )}
      {atis && (
        <div className="atis">
          <div className="atis-head">
            <span className="atis-letter" title="Information ATIS">
              {atis.letter}
            </span>
            ATIS IVAO · {atis.callsign} · {atis.frequency.toFixed(3)}
          </div>
          {atis.lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
    </article>
  );
}

/** Terminal d'un vol : l'ATIS est chargé ici */
function TerminalWeather({ icao, role, metar }: { icao: string; role: string; metar: Metar | undefined }) {
  const atis = useIvaoAtis(icao);
  return <AirportWeather icao={icao} role={role} metar={metar} atis={atis} />;
}

export function WeatherSection({ departure, arrival }: { departure: string | null; arrival: string | null }) {
  const metars = useMetars([departure ?? '', arrival ?? '']);
  if (!departure && !arrival) return null;
  return (
    <section className="weather-section">
      <h3 className="list-heading">Météo</h3>
      {departure && <TerminalWeather icao={departure} role="Départ" metar={metars[departure]} />}
      {arrival && arrival !== departure && <TerminalWeather icao={arrival} role="Arrivée" metar={metars[arrival]} />}
      <p className="footnote">METAR : NOAA (aviationweather.gov). ATIS : réseau IVAO, quand un contrôleur de l’aérodrome est en ligne.</p>
    </section>
  );
}
