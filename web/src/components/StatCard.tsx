export function StatCard(props: {
  title: string;
  value: number | null;
  unit: string;
  loading?: boolean;
  format?: (value: number) => string;
  subtitle?: string | null;
}) {
  const valueText = props.value == null ? "—" : props.format ? props.format(props.value) : String(props.value);
  return (
    <section className="card">
      <div className="card__header">
        <div className="card__title">{props.title}</div>
        {props.loading ? <div className="pill">loading</div> : null}
      </div>
      <div className="stat">
        <div className="stat__value">{valueText}</div>
        <div className="stat__unit">{props.unit}</div>
      </div>
      {props.subtitle ? <div className="card__subtitle">{props.subtitle}</div> : null}
    </section>
  );
}
